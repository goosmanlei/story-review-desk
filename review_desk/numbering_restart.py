"""Explicit production numbering epoch; no automatic renumbering or aliases.

The caller supplies authorization and coordinates the stopped-service window.
Facts live in the existing immutable operation ledger and complete bundle.
"""
import json

from . import production as p, production_current as current
from .store import Conflict, canonical

FORMAT = 'production-numbering-restart-v1'
PREFIXES = ('AE', 'AS', 'ASH', 'EN', 'ST', 'M')
KINDS = dict(AE='AV_EPISODE', AS='AV_SCENE', ASH='AV_SHOT', EN='ENTITY', ST='STATE')


def facts(store):
    token = (store.db.execute('PRAGMA data_version').fetchone()[0], store.db.total_changes)
    cached = getattr(store, '_numbering_facts', None)
    if cached and cached[0] == token:
        return cached[1]
    values = [json.loads(r[0]) for r in store.db.execute(
        "SELECT result FROM production_current_operations WHERE json_extract(result,'$.format')=? ORDER BY id", (FORMAT,))]
    store._numbering_facts = (token, values)
    return values


def epoch(db):
    if not db.execute("SELECT 1 FROM sqlite_master WHERE name='production_current_operations'").fetchone():
        return []
    return [r[0] for r in db.execute(
        "SELECT id FROM production_current_operations WHERE json_extract(result,'$.format')=? ORDER BY id", (FORMAT,))]


def guard_epoch(db, expected):
    if epoch(db) != expected:
        raise Conflict('制作编号迁移基线已变化；同步最新主干，从最新正式数据按稳定对象身份重新准备增量包')


def historical(store, oid):
    for fact in facts(store):
        row = next((r for r in fact['history'] if r['object_id'] == oid), None)
        if row:
            return row
    return None


def suppressed(store, oid):
    # Retired/deleted/alias identities retain exact historical facts, but do not
    # acquire a second current number when an old bundle is read or initialized.
    return any(oid in fact['excluded_ids'] for fact in facts(store))


def _selection(store):
    from .audiovisual import children
    from .semantic_consolidation import is_retired
    from .business_codes import dump
    codes = {r['object_id']: r for r in dump(store)}
    ordered = {prefix: [] for prefix in PREFIXES}
    episodes = sorted(p.current_records(store, {'AV_EPISODE'}), key=lambda r: r['payload']['number'])
    numbers = [r['payload']['number'] for r in episodes]
    if len(numbers) != len(set(numbers)) or not episodes:
        raise ValueError('numbering requires an unambiguous current production tree')
    for episode in episodes:
        ordered['AE'].append(episode['object_id'])
        for scene in children(store, episode):
            ordered['AS'].append(scene['object_id'])
            ordered['ASH'].extend(shot['object_id'] for shot in children(store, scene))
    for prefix in ('AE', 'AS', 'ASH'):
        values = ordered[prefix]
        if len(values) != len(set(values)) or set(values) != {r['object_id'] for r in p.current_records(store, {KINDS[prefix]})}:
            raise ValueError('current tree has duplicate or unbound production objects: '+prefix)
    aliases = dict(store.db.execute("SELECT alias_id,COALESCE(json_extract(evidence,'$.canonical_material_id'),material_id) FROM material_aliases"))
    bound_candidates = {r[0] for r in store.db.execute('''SELECT c.asset_object_id FROM production_candidates c
        JOIN production_candidate_targets t ON t.candidate_id=c.id WHERE t.material_id!=c.asset_object_id''')}
    for row in p.current_records(store, {'ENTITY', 'STATE', 'REQUIREMENT', 'ASSET'}):
        oid, body = row['object_id'], row['payload']
        if row['kind'] == 'ASSET' and oid in bound_candidates:
            continue
        if is_retired(body) or body.get('status') == 'withdrawn' or body.get('current_plan_for') or (oid in aliases and aliases[oid] != oid):
            continue
        prefix = {'ENTITY': 'EN', 'STATE': 'ST', 'REQUIREMENT': 'M', 'ASSET': 'M'}[row['kind']]
        ordered[prefix].append(oid)
    for prefix, ids in ordered.items():
        if any(oid not in codes or codes[oid]['prefix'] != prefix for oid in ids):
            raise ValueError('active identity lacks its original allocation: '+prefix)
        if prefix in ('EN', 'ST', 'M'):
            ids.sort(key=lambda oid: codes[oid]['number'])
    mapping = [{**codes[oid], 'old_number': codes[oid]['number'], 'number': n}
               for prefix in PREFIXES for n, oid in enumerate(ordered[prefix], 1)]
    active = {row['object_id'] for row in mapping}
    history = [r for r in codes.values() if r['prefix'] in PREFIXES]
    return mapping, sorted(history, key=lambda r: (r['prefix'], r['number'])), sorted(r['object_id'] for r in history if r['object_id'] not in active)


def prepare(store, authorization):
    from .candidate_reset import fingerprint
    if not authorization or not isinstance(authorization, str) or not current.enabled(store):
        raise ValueError('explicit authorization and current production required')
    if epoch(store.db):
        raise Conflict('本轮编号迁移已完成；只能重试原清单，日常操作不得再次重编')
    with p.read_scope(store):
        mapping, history, excluded = _selection(store)
        plan = {'format': FORMAT, 'authorization': authorization,
                'baseline': fingerprint(store), 'mapping': mapping,
                'history': history, 'excluded_ids': excluded,
                'counts': {prefix: sum(r['prefix'] == prefix for r in mapping) for prefix in PREFIXES}}
        plan['id'] = current.checksum(plan)
        return plan


def validate(store):
    saved = facts(store)
    if len(saved) > 1:
        raise ValueError('multiple competing production numbering migrations')
    for fact in saved:
        if fact.get('id') != current.checksum({k: v for k, v in fact.items() if k != 'id'}):
            raise ValueError('numbering migration fact checksum differs')
        mapped = {r['object_id']: r for r in fact['mapping']}
        for prefix in PREFIXES:
            rows = [r for r in fact['mapping'] if r['prefix'] == prefix]
            if [r['number'] for r in rows] != list(range(1, len(rows)+1)):
                raise ValueError('numbering migration is not initially continuous')
        actual = {r['object_id']: dict(r) for r in store.db.execute('SELECT * FROM business_codes')}
        for oid, row in mapped.items():
            if actual.get(oid) != {k: row[k] for k in ('object_id', 'prefix', 'number')}:
                raise ValueError('migrated identity changed number: '+oid)
        if any(oid in actual for oid in fact['excluded_ids']):
            raise ValueError('historical allocation reentered current numbering')
        history = {r['object_id']: r for r in fact['history']}
        if len(history) != len(fact['history']) or not set(mapped) <= history.keys():
            raise ValueError('numbering history is incomplete')
        for oid, row in mapped.items():
            if history[oid] != {'object_id': oid, 'prefix': row['prefix'], 'number': row['old_number']}:
                raise ValueError('numbering history differs from original allocation')
        if set(fact['excluded_ids']) != history.keys()-mapped.keys():
            raise ValueError('numbering exclusions differ')
        if fact['counts'] != {prefix: sum(r['prefix'] == prefix for r in mapped.values()) for prefix in PREFIXES}:
            raise ValueError('numbering counts differ')


def apply(store, plan, fault=None):
    if plan.get('format') != FORMAT or plan.get('id') != current.checksum({k: v for k, v in plan.items() if k != 'id'}):
        raise ValueError('invalid numbering migration manifest')
    prior = store.db.execute('SELECT request_sha256,result FROM production_current_operations WHERE id=?', (plan['id'],)).fetchone()
    if prior:
        if prior[0] != current.checksum(plan) or json.loads(prior[1]) != plan:
            raise Conflict('numbering migration identity changed')
        validate(store)
        return {'id': plan['id'], 'counts': plan['counts'], 'already_applied': True}
    if store.db.in_transaction:
        raise Conflict('numbering migration must own its transaction')
    store.db.execute('BEGIN IMMEDIATE')
    try:
        # Recompute all identities, tree order and protected rows inside the
        # transaction, rather than trusting an editable mapping file.
        if prepare(store, plan['authorization']) != plan:
            raise Conflict('编号迁移基线已过期；从最新正式数据重新准备清单')
        store.db.execute('DELETE FROM business_codes WHERE prefix IN (?,?,?,?,?,?)', PREFIXES)
        if fault == 'after-delete':
            raise RuntimeError('injected numbering interruption')
        store.db.executemany('INSERT INTO business_codes VALUES (?,?,?)',
                            ((r['object_id'], r['prefix'], r['number']) for r in plan['mapping']))
        store.db.execute('INSERT INTO production_current_operations VALUES (?,?,?)',
                         (plan['id'], current.checksum(plan), canonical(plan)))
        validate(store)
        if fault == 'before-commit':
            raise RuntimeError('injected numbering interruption')
        store.db.commit()
    except BaseException:
        store.db.rollback()
        raise
    return {'id': plan['id'], 'counts': plan['counts'], 'already_applied': False}
