"""Explicit semantic decisions, atomic current rewiring, and small retirement receipts.

This module never decides that two things mean the same thing. The caller supplies
reviewed decisions. Submitted calls, input snapshots and original opinions are
not rewritten when today's production requirements are consolidated.
"""
import copy
import hashlib
import json

from . import production as p, production_current as current, business_relations as relations
from .store import Conflict, canonical

FORMAT = 'production-semantic-consolidation-v1'
RETIRED = 'production-retirement-v1'


def is_retired(payload):
    return payload.get('format') == RETIRED


def decisions(store):
    values = {}
    if not current.enabled(store):
        return values
    for raw in store.db.execute('SELECT result FROM production_current_operations'):
        receipt = json.loads(raw[0])
        if receipt.get('format') == FORMAT:
            values.update(receipt.get('mapping', {}))
    return values


def resolve(store, oid):
    cache = getattr(store, '_production_reads', None)
    if cache is not None:
        if 'semantic_mapping' not in cache:
            cache['semantic_mapping'] = decisions(store)
        mapping = cache['semantic_mapping']
    else:
        mapping = decisions(store)
    seen = set()
    while oid in mapping:
        if oid in seen:
            raise ValueError('cyclic semantic identity')
        seen.add(oid)
        oid = mapping[oid]
    return oid


def validate_retirement(store, oid, kind, payload):
    if not is_retired(payload) or payload.get('status') != 'withdrawn':
        raise ValueError('invalid retirement receipt')
    receipt = store.db.execute('SELECT result FROM production_current_operations WHERE id=?',
                               (payload.get('operation_id'),)).fetchone()
    value = json.loads(receipt[0]) if receipt else {}
    if (value.get('format') != FORMAT or
            value.get('retired', {}).get(oid) != current.checksum(payload) or
            payload.get('original_kind') != kind or not payload.get('reason')):
        raise ValueError('retirement has no matching exact consolidation receipt: '+oid)


def _rewrite(value, mapping, relation_mapping, exact_assets=frozenset()):
    if isinstance(value, list):
        return [_rewrite(v, mapping, relation_mapping, exact_assets) for v in value]
    if not isinstance(value, dict):
        return value
    # Method activation/execution evidence is frozen, not a current consumer.
    result = {k: copy.deepcopy(v) if k in ('method_basis', '_method_binding', 'method_adjustment',
              'initial_plan_source') else _rewrite(v, mapping, relation_mapping, exact_assets) for k, v in value.items()}
    oid = value.get('object_id')
    if oid and 'revision_id' in value and oid not in exact_assets:
        target = mapping.get(oid, relation_mapping.get(oid, oid))
        if target is not None and target != oid:
            result.update(object_id=target, revision_id=current.address(target))
    if result.get('material_id') in mapping:
        result['material_id'] = mapping[result['material_id']]
    selection = result.get('material_selection')
    if isinstance(selection, dict) and selection.get('material_id') in mapping:
        selection['material_id'] = mapping[selection['material_id']]
    return result


def _rows(store):
    return {raw['id']: p.record(store, raw['id']) for raw in store.db.execute(
        'SELECT id FROM objects WHERE kind IN ('+','.join('?' for _ in current.RECORD_KINDS)+')',
        sorted(current.RECORD_KINDS))}


def _file_hash(path):
    if path.is_symlink() or not path.is_file():
        raise Conflict('original file missing or symlink: '+str(path))
    from .production_media import file_hash
    return file_hash(path)


def prepare(store, choices):
    """Prepare a reviewable exact plan, without applying or deciding semantics."""
    if not current.enabled(store):
        raise ValueError('current production migration required')
    rows = _rows(store)
    exact_assets = {oid for oid,row in rows.items() if row['kind'] in ('ASSET','CALL')}
    mapping, reasons = {}, {}
    for choice in choices.get('merges', []):
        source, target = choice['source'], choice['target']
        if not choice.get('reason') or source == target or source in mapping:
            raise ValueError('merge requires distinct identities and one reviewed reason')
        if target not in rows or rows[target]['kind'] != 'REQUIREMENT' or is_retired(rows[target]['payload']):
            raise ValueError('merge target must be a live existing requirement')
        if source in rows:
            old = rows[source]
            if old['kind'] != 'REQUIREMENT' or old['payload'].get('media_type') != rows[target]['payload']['media_type']:
                raise ValueError('only same-media requirements can merge')
        elif not store.db.execute('SELECT 1 FROM production_candidate_targets WHERE material_id=?', (source,)).fetchone():
            raise ValueError('missing legacy material identity: '+source)
        mapping[source], reasons[source] = target, choice['reason']
    if set(mapping) & set(mapping.values()):
        raise ValueError('flatten reviewed merge decisions before preparing')
    retired = dict(reasons)
    for choice in choices.get('retire', []):
        oid = choice['source']
        if oid not in rows or rows[oid]['kind'] != 'REQUIREMENT' or not choice.get('reason') or oid in retired:
            raise ValueError('invalid requirement retirement decision')
        retired[oid] = choice['reason']
    candidate_retirements = {}
    for choice in choices.get('retire_candidates', []):
        oid = choice['source']
        if oid not in rows or rows[oid]['kind'] != 'ASSET' or not choice.get('reason') or oid in retired:
            raise ValueError('invalid reviewed candidate retirement')
        if choice.get('remove_files') and store.db.execute('SELECT 1 FROM comments WHERE target_object_id=?', (oid,)).fetchone():
            raise Conflict('original opinions still need these exact candidate files: '+oid)
        if choice.get('remove_files') and any(ref['object_id']==oid for row in rows.values() if row['kind']=='CALL'
                                              for _,ref in p.references(row['payload'].get('inputs', []))):
            raise Conflict('a real call used this exact candidate; retain its originals: '+oid)
        if choice.get('remove_files') and any(ref['object_id']==oid for row in rows.values() if row['kind']=='ASSET'
                                              for _,ref in p.references(row['payload'].get('lineage', {}))):
            raise Conflict('exact candidate lineage still needs these originals: '+oid)
        if choice.get('remove_files') and any(ref['object_id']==oid for raw in store.db.execute('SELECT snapshot FROM production_submissions')
                                              for _,ref in p.references(json.loads(raw[0]))):
            raise Conflict('a frozen submission still needs these originals: '+oid)
        retired[oid] = choice['reason']
        candidate_retirements[oid] = bool(choice.get('remove_files'))
    patches = {}
    for patch in choices.get('updates', []):
        oid = patch['object_id']
        if oid not in rows or rows[oid]['kind'] not in current.CURRENT_KINDS or oid in retired:
            raise ValueError('update must address retained current production')
        patches[oid] = copy.deepcopy(patch['payload'])
    # Several previous materials can be aliases of an ASSET-backed current plan.
    alias_changes = {}
    for raw in store.db.execute('SELECT * FROM material_aliases'):
        alias = dict(raw)
        old_mid = json.loads(alias['evidence']).get('canonical_material_id', alias['material_id'])
        if old_mid in mapping or alias['alias_id'] in mapping:
            target = mapping.get(alias['alias_id'], mapping.get(old_mid))
            if old_mid != target:
                mapping[old_mid] = target
            alias_changes[alias['alias_id']] = {'alias_id': alias['alias_id'], 'material_id': target,
                'evidence': canonical({'kind': 'semantic-consolidation', 'canonical_material_id': target})}
            if alias['alias_id'] in rows and rows[alias['alias_id']]['kind'] == 'REQUIREMENT':
                mapping[alias['alias_id']] = target
                retired[alias['alias_id']] = reasons.get(old_mid, reasons.get(alias['alias_id'], '同一已审定素材需求'))
    for source, target in mapping.items():
        if source in rows:
            alias_changes[source] = {'alias_id': source, 'material_id': target,
                'evidence': canonical({'kind': 'semantic-consolidation', 'canonical_material_id': target})}
    # Preserve source membership as shared applicability, not another need.
    shared_scopes = []
    for source, target in mapping.items():
        if source not in rows or rows[source]['kind'] != 'REQUIREMENT':
            continue
        old = rows[source]['payload']
        payload = patches.setdefault(target, copy.deepcopy(rows[target]['payload']))
        for field in ('states', 'entities'):
            values = payload.setdefault(field, [])
            for ref in old.get(field, []):
                if ref not in values:
                    values.append(copy.deepcopy(ref))
        scope = old.get('scope', {})
        if scope.get('object_id') in rows and rows[scope['object_id']]['kind'] == 'STATE':
            if scope not in payload['states']:
                payload['states'].append(copy.deepcopy(scope))
        elif scope.get('object_id') in rows and rows[scope['object_id']]['kind'] == 'ASSET':
            asset = rows[scope['object_id']]['payload']
            for coverage in asset.get('state_coverage', []):
                if coverage['state'] not in payload['states']:
                    payload['states'].append(copy.deepcopy(coverage['state']))
            for subject in asset.get('subjects', []):
                if subject['object_id'] in rows and rows[subject['object_id']]['kind'] == 'ENTITY' and subject not in payload['entities']:
                    payload['entities'].append(copy.deepcopy(subject))
        if scope.get('object_id') in rows and rows[scope['object_id']]['kind'] == 'AV_SHOT' and scope != payload.get('scope'):
            shared_scopes.append((target, scope, reasons.get(source, '已审定共用同一素材需求')))
    relation_mapping, relation_groups = {}, {}
    for oid, row in rows.items():
        value = patches.get(oid, row['payload'])
        if not relations.is_business(row) or value.get('status') == 'withdrawn':
            continue
        if any(e in retired and (e not in mapping or e in exact_assets) for e in value['endpoints']):
            relation_mapping[oid] = None
            retired[oid] = '当前素材用途已撤回，原关系仅保留准确回查。'
            continue
        endpoints = [mapping.get(e, e) if e not in exact_assets else e for e in value['endpoints']]
        if endpoints != row['payload']['endpoints']:
            if endpoints[0] == endpoints[1]:
                relation_mapping[oid] = None
                retired[oid] = '两个端点已归并为同一素材，原自指关系不再需要。'
                continue
            target = relations.identity(endpoints)
            relation_mapping[oid] = target
            retired[oid] = next((v['reason'] for v in choices.get('updates', [])
                                if v['object_id'] == oid and v.get('reason')),
                               '素材归并后关系由同一对当前对象承接。')
            updated = _rewrite(value, mapping, {}, exact_assets)
            updated['endpoints'] = endpoints
            relation_groups.setdefault(target, []).append(relations.normalize(updated))
    for target, scope, reason in shared_scopes:
        endpoints = [target, scope['object_id']]
        oid = relations.identity(endpoints)
        value = {'format':'production-relation-v1', 'relation_type':'business', 'title':'共用素材',
                 'endpoints':endpoints, 'direction':'related', 'summary':reason,
                 'sources':[], 'contexts':[scope], 'blocks':[{'id':'summary','text':reason}]}
        relation_groups.setdefault(oid, []).append(relations.normalize(value))
    for target, group in relation_groups.items():
        if target in rows and target not in retired:
            group.insert(0, patches.get(target, rows[target]['payload']))
        direction = {v['direction'] for v in group} - {'related'}
        if len(direction) > 1:
            raise Conflict('review opposite relationship directions before merging: '+target)
        value = copy.deepcopy(group[0])
        value['direction'] = next(iter(direction), 'related')
        for field in ('sources', 'contexts'):
            value[field] = list({canonical(ref): ref for v in group for ref in v.get(field, [])}.values())
        value['summary'] = '；'.join(dict.fromkeys(v['summary'] for v in group))
        value['blocks'] = [{'id': 'summary', 'text': value['summary']}]
        patches[target] = value
    # Later reviewed payloads may have been drafted before an earlier batch.
    # Rebind their current references through every committed decision, while
    # keeping exact asset/call evidence untouched.
    rewrite_mapping = {**decisions(store), **mapping}
    for source in rewrite_mapping:
        target, seen = rewrite_mapping[source], {source}
        while target in rewrite_mapping:
            if target in seen: raise ValueError('cyclic semantic identity')
            seen.add(target); target = rewrite_mapping[target]
        rewrite_mapping[source] = target
    for oid, row in rows.items():
        if row['kind'] not in current.CURRENT_KINDS or oid in retired or is_retired(row['payload']):
            continue
        value = patches.get(oid, row['payload'])
        updated = _rewrite(value, rewrite_mapping, relation_mapping, exact_assets)
        if row['kind'] == 'RELATION':
            for field in ('sources','contexts'):
                if field in updated:
                    updated[field] = [ref for ref in updated[field] if ref['object_id'] not in retired]
        # A collapsed dependency may only disappear from the requirement that
        # was itself retired. Never silently drop a live self-input.
        if row['kind'] == 'REQUIREMENT':
            for item in updated.get('generation', {}).get('inputs', []):
                if item.get('reference', {}).get('object_id') == oid:
                    raise Conflict('retained plan still depends on itself; review its generation plan: '+oid)
        if updated != row['payload']:
            patches[oid] = updated
    for oid in retired:
        patches.pop(oid, None)
    for payload in patches.values():
        if payload.get('relation_type') == 'business':
            for field in ('sources','contexts'):
                payload[field] = [ref for ref in payload.get(field, []) if ref['object_id'] not in retired]
    targets = [dict(r) for r in store.db.execute('SELECT * FROM production_candidate_targets ORDER BY material_id,number')]
    retired_cids = {r['id'] for r in store.db.execute('SELECT * FROM production_candidates')
                   if r['asset_object_id'] in candidate_retirements}
    new_targets, numbered, seen = [], {}, set()
    # Stable existing candidate numbers first; newly combined candidates append.
    for row in sorted(targets, key=lambda r: (r['material_id'] in mapping, r['material_id'], r['number'])):
        if row['candidate_id'] in retired_cids or row['material_id'] in retired and row['material_id'] not in mapping:
            continue
        mid = mapping.get(row['material_id'], row['material_id'])
        key = (row['candidate_id'], mid)
        if key in seen:
            continue
        seen.add(key)
        number = row['number'] if mid == row['material_id'] else numbered.get(mid, 0)+1
        numbered[mid] = max(numbered.get(mid, 0), number)
        new_targets.append({**row, 'material_id': mid, 'number': number})
    affected = set(patches) | (set(retired) & rows.keys())
    guards = {oid: current.marker(rows[oid]) for oid in affected if oid in rows}
    media = {}
    candidate_ids = {r['candidate_id'] for r in targets if r['material_id'] in mapping}
    for raw in store.db.execute('SELECT * FROM production_candidates'):
        if raw['id'] not in candidate_ids | retired_cids:
            continue
        asset = p.record(store, raw['asset_object_id'])
        guards[asset['object_id']] = current.marker(asset)
        for component in asset['payload'].get('components', []):
            media[component['file']] = component['sha256']
    # A retired candidate can lose its no-longer-needed originals in a later
    # reviewed cleanup. It no longer has a candidate registry row by then.
    for oid in candidate_retirements:
        for component in rows[oid]['payload'].get('components', []):
            media[component['file']] = component['sha256']
    value = {'format': FORMAT, 'mapping': mapping, 'reasons': retired, 'patches': patches,
             'guards': guards, 'media': media, 'candidate_targets_before': targets,
             'candidate_targets_after': sorted(new_targets, key=lambda r: (r['material_id'], r['number'])),
             'aliases': list(alias_changes.values()), 'relations': relation_mapping,
             'retire_candidates': candidate_retirements,
             'retired_candidate_ids': sorted(retired_cids),
             'relations_before': [dict(r) for r in store.db.execute('SELECT * FROM business_relations ORDER BY object_id')],
             'aliases_before': [dict(r) for r in store.db.execute('SELECT * FROM material_aliases ORDER BY alias_id')]}
    return {**value, 'id': current.checksum(value)}


def apply(store, plan, *, fault=None):
    if plan.get('format') != FORMAT or plan.get('id') != current.checksum({k:v for k,v in plan.items() if k != 'id'}):
        raise ValueError('invalid exact semantic consolidation plan')
    prior = store.db.execute('SELECT request_sha256,result FROM production_current_operations WHERE id=?', (plan['id'],)).fetchone()
    if prior:
        if prior[0] != current.checksum(plan):
            raise Conflict('operation identity reused for another plan')
        return {**json.loads(prior[1]), 'already_applied': True}
    if store.db.in_transaction:
        raise Conflict('consolidation must own its transaction')
    store.db.execute('BEGIN IMMEDIATE')
    store._semantic_consolidating = True
    try:
        for oid, guard in plan['guards'].items():
            current.guard(store, oid, guard)
        for table, key, order in (('production_candidate_targets','candidate_targets_before','material_id,number'),
                                 ('business_relations','relations_before','object_id'), ('material_aliases','aliases_before','alias_id')):
            if [dict(r) for r in store.db.execute('SELECT * FROM '+table+' ORDER BY '+order)] != plan[key]:
                raise Conflict('semantic consolidation baseline changed: '+table)
        for name, sha in plan['media'].items():
            if _file_hash(p.root_of(store)/'export/assets'/name) != sha:
                raise Conflict('original file checksum changed: '+name)
        rows = _rows(store)
        patches = copy.deepcopy(plan['patches'])
        for oid, reason in plan['reasons'].items():
            if oid not in rows:
                continue
            row = rows[oid]
            payload = {'format': RETIRED, 'title': row['payload']['title'], 'status': 'withdrawn',
                       'original_kind': row['kind'], 'original_content_sha256': current.checksum(row['payload']),
                       'operation_id': plan['id'], 'reason': reason, 'blocks': [{'id':'retirement','text':reason}]}
            if is_retired(row['payload']):
                payload['original_content_sha256'] = row['payload']['original_content_sha256']
            target = plan['mapping'].get(oid, plan['relations'].get(oid))
            if target:
                payload['merged_into'] = {'object_id':target,'revision_id':current.address(target)}
            if row['kind'] == 'REQUIREMENT':
                payload['media_type'] = row['payload']['media_type']
            if row['kind'] == 'ASSET':
                original = row['payload']
                for key in ('production','external_source','media_type','candidate_identity'):
                    if key in original: payload[key] = copy.deepcopy(original[key])
                if plan.get('retire_candidates', {}).get(oid):
                    payload['former_components'] = [{('former_file' if k=='file' else k):v for k,v in c.items()}
                                                     for c in original['components']]
                else:
                    payload['components'] = copy.deepcopy(original['components'])
            patches[oid] = payload
        receipt = {'format': FORMAT, 'id': plan['id'], 'mapping': plan['mapping'],
                   'relations':plan['relations'],
                   'retired': {oid:current.checksum(v) for oid,v in patches.items() if is_retired(v)},
                   'retired_candidates': plan.get('retired_candidate_ids', []),
                   'changed_objects': sorted(patches), 'already_applied': False}
        store.db.execute('INSERT INTO production_current_operations VALUES (?,?,?)',
                         (plan['id'], current.checksum(plan), canonical(receipt)))
        for comment in store.comments():
            if comment['target_object_id'] in patches and not store.db.execute('SELECT 1 FROM production_comment_quotes WHERE comment_id=?', (comment['id'],)).fetchone():
                current.remember_comment(store, comment)
        # Old relationship IDs remain explicit receipts; only current pairs live
        # in the unique registry. Frozen references keep their exact old IDs.
        store.db.execute('PRAGMA defer_foreign_keys=ON')
        for source, target in plan['relations'].items():
            if target:
                store.db.execute('UPDATE business_relation_aliases SET relation_id=? WHERE relation_id=?', (target, source))
            else:
                store.db.execute('DELETE FROM business_relation_aliases WHERE relation_id=?', (source,))
            store.db.execute('DELETE FROM business_relations WHERE object_id=?', (source,))
        # Bodies first; validation runs after all new relation identities exist.
        for oid, payload in sorted(patches.items(), key=lambda pair: pair[0] in rows):
            obj = store.db.execute('SELECT * FROM objects WHERE id=?', (oid,)).fetchone()
            kind = obj['kind'] if obj else 'RELATION'
            refs = [{**ref,'role':role} for role,ref in p.references(payload)]
            current.write_record(store, oid, kind, payload, dict(obj) if obj else None, refs)
        for alias in plan['aliases']:
            store.db.execute('INSERT OR REPLACE INTO material_aliases VALUES (?,?,?)', tuple(alias[k] for k in ('alias_id','material_id','evidence')))
        store.db.execute('DELETE FROM production_candidate_targets')
        store.db.executemany('INSERT INTO production_candidate_targets VALUES (?,?,?)',
                             [tuple(r[k] for k in ('candidate_id','material_id','number')) for r in plan['candidate_targets_after']])
        for cid in plan.get('retired_candidate_ids', []):
            store.db.execute('DELETE FROM production_candidates WHERE id=?', (cid,))
        if fault == 'after-rewrite':
            raise RuntimeError('injected semantic consolidation interruption')
        invalid = []
        for oid, payload in patches.items():
            try:
                p.validate_payload(store, oid, rows[oid]['kind'] if oid in rows else 'RELATION', payload, inspect=False, check_current=False)
            except (ValueError, KeyError) as exc:
                invalid.append(oid+': '+str(exc))
        if invalid:
            raise ValueError('invalid reviewed content ('+str(len(invalid))+'):\n'+'\n'.join(invalid))
        validate(store)
        from .production_current_bundle import required_assets
        required = required_assets(store)
        if store.db.execute('PRAGMA foreign_key_check').fetchone():
            raise ValueError('consolidation left a foreign key error')
        if fault == 'before-commit':
            raise RuntimeError('injected semantic consolidation interruption')
        store.db.commit()
        return receipt
    except BaseException:
        store.db.rollback()
        raise
    finally:
        store._semantic_consolidating = False


def validate(store):
    """Current consumers cannot resurrect a retired need; history stays exact."""
    rows = _rows(store)
    retired = {oid for oid, r in rows.items() if is_retired(r['payload'])}
    for row in rows.values():
        if is_retired(row['payload']):
            validate_retirement(store, row['object_id'], row['kind'], row['payload'])
            continue
        if row['kind'] not in current.CURRENT_KINDS or row['payload'].get('status') == 'withdrawn':
            continue
        for path, ref in p.references(row['payload']):
            if any(field in path for field in ('method_basis','method_adjustment','_method_binding','initial_plan_source')):
                continue
            if ref['object_id'] in retired:
                raise Conflict('current consumer still references a retired object: '+row['object_id']+' '+path)
    if any(r['material_id'] in retired for r in store.db.execute('SELECT material_id FROM production_candidate_targets')):
        raise Conflict('retired need remains a current candidate target')
    for relation in relations.current(store):
        if relation['payload'].get('status')!='withdrawn' and any(oid in retired for oid in relation['payload']['endpoints']):
            raise Conflict('retired object remains a current relationship endpoint: '+relation['object_id'])


def cleanup_files(store, operation_id):
    """Idempotent post-commit deletion; never remove a retained exact input."""
    raw = store.db.execute('SELECT result FROM production_current_operations WHERE id=?', (operation_id,)).fetchone()
    receipt = json.loads(raw[0]) if raw else {}
    if receipt.get('format') != FORMAT: raise ValueError('committed consolidation required')
    from .production_current_bundle import required_assets
    required = required_assets(store)
    if store.db.in_transaction:
        raise Conflict('file cleanup must own its transaction')
    removed, absent, retained, archives = [], [], [], {}
    store.db.execute('BEGIN IMMEDIATE')
    try:
        # Files are resumable side effects of an already committed retirement.
        # A rollback may leave an eligible file absent; the next call completes
        # index cleanup without ever deleting a newly required shared original.
        required = required_assets(store)
        files = {}
        for oid in receipt['retired']:
            value = p.record(store, oid)['payload']
            for component in value.get('former_components', []):
                name = component['former_file']
                if name in required: retained.append(name); continue
                files[name] = component['sha256']
        request = {'format':FORMAT, 'cleanup_of':operation_id, 'files':files}
        cleanup_id = current.checksum(request)
        prior = store.db.execute('SELECT result FROM production_current_operations WHERE id=?',(cleanup_id,)).fetchone()
        for name, sha in files.items():
            from .bundle import _safe_asset
            path = p.root_of(store)/'export/assets'/_safe_asset(name)
            if not path.exists(): absent.append(name)
            else:
                if _file_hash(path) != sha: raise Conflict('retired file changed: '+name)
                path.unlink(); removed.append(name)
            row = store.db.execute('SELECT * FROM material_archive_files WHERE path=?',('export/assets/'+name,)).fetchone()
            if row: archives[row['path']] = current.checksum(dict(row))
        if prior:
            cleanup = json.loads(prior[0])
        else:
            nodes = {r[0] for r in store.db.execute('SELECT id FROM material_content')}
            store.db.executemany('DELETE FROM material_archive_files WHERE path=?',((name,) for name in archives))
            from .version_consolidation import collect_content
            gc = collect_content(store)
            remaining = {r[0] for r in store.db.execute('SELECT id FROM material_content')}
            cleanup = {'format':FORMAT,'id':cleanup_id,'cleanup_of':operation_id,
                'removed_archive_files':archives,'removed_content_nodes':sorted(nodes-remaining),
                'content_cleanup':gc,'retired':{},'mapping':{},'relations':{},'changed_objects':[]}
            store.db.execute('INSERT INTO production_current_operations VALUES (?,?,?)',
                             (cleanup_id,current.checksum(request),canonical(cleanup)))
        if store.db.execute('PRAGMA foreign_key_check').fetchone():
            raise Conflict('file index cleanup left a foreign key error')
        store.db.commit()
        return {'removed':removed,'already_absent':absent,'retained_shared_files':retained,
                'cleanup_id':cleanup_id,'content_cleanup':cleanup.get('content_cleanup',{})}
    except BaseException:
        store.db.rollback();raise


def allows_publication_change(table, before, after, receipts):
    """Only reviewed membership changes can relax immutable evidence rules."""
    mapping, relations_map, retired_candidates, retired_objects = {}, {}, set(), set()
    archives, content_nodes = {}, set()
    for receipt in receipts:
        if receipt.get('format') != FORMAT: continue
        mapping.update(receipt.get('mapping', {}))
        relations_map.update(receipt.get('relations', {}))
        retired_candidates.update(receipt.get('retired_candidates', []))
        retired_objects.update(receipt.get('retired', {}))
        archives.update(receipt.get('removed_archive_files', {}))
        content_nodes.update(receipt.get('removed_content_nodes', []))
    if table == 'material_archive_files':
        return bool(before and after is None and archives.get(before['path'])==current.checksum(before))
    if table == 'material_content':
        return bool(before and after is None and before['id'] in content_nodes and hashlib.sha256(before['body'].encode()).hexdigest()==before['id'])
    if table == 'production_candidates':
        return bool(before and after is None and before['id'] in retired_candidates)
    if table == 'production_candidate_targets':
        row = before or after
        if after is None:
            return row['candidate_id'] in retired_candidates or row['material_id'] in mapping or row['material_id'] in retired_objects
        return (before is None and row['material_id'] in set(mapping.values()))
    if table == 'business_relations':
        return bool(before and after is None and before['object_id'] in relations_map)
    if table == 'business_relation_aliases':
        return bool(before and before['relation_id'] in relations_map and
                    (after is None and relations_map[before['relation_id']] is None or
                     after and after['alias_id']==before['alias_id'] and after['relation_id']==relations_map[before['relation_id']]))
    return False
