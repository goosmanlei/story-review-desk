"""One read-only identity for a current candidate or an exact historical input.

History is read from frozen submissions and explicit evidence receipts. A name
or a shared entity never establishes membership in a current demand.
"""
import json

CONTRACT = 'material-exact-reference-v1'
EVIDENCE = 'material-reference-evidence-v1'


def receipts(store):
    return [json.loads(r[0]) for r in store.db.execute('''SELECT result FROM production_current_operations
        WHERE json_extract(result,'$.format')=?''', (EVIDENCE,))]


def recovered_record(store, ref):
    """Read a proven original without reviving its deleted production tree."""
    item = evidence(store, ref)
    if not item.get('component'):
        return None
    return {'object_id':ref['object_id'], 'id':ref['revision_id'], 'kind':'ASSET',
            'submission_only':True, 'recovered_original':True,
            'payload':{'title':item['title'], 'media_type':item['media_type'],
                       'components':[item['component']]}}


def validate_evidence(store):
    from . import production as p, production_current as current
    from .production_media import validate_component
    seen = set()
    for receipt in receipts(store):
        if receipt['id'] != current.checksum({k:v for k,v in receipt.items() if k != 'id'}):
            raise ValueError('historical reference evidence checksum differs')
        for item in receipt['references']:
            key = item['object_id'], item['revision_id']
            if key in seen:
                raise ValueError('ambiguous historical reference evidence')
            seen.add(key)
            if item.get('component'):
                proof = item['source_proof']
                deleted = store.db.execute('SELECT before_sha256 FROM consolidation_revisions WHERE revision_id=? AND object_id=? AND new_number IS NULL', key[::-1]).fetchone()
                if not deleted or deleted[0] != proof['original_content_sha256'] or not proof.get('commit'):
                    raise ValueError('restored original lacks its exact deletion evidence')
                validate_component(p.root_of(store), item['component'], inspect=False)


def code(store, oid):
    row = store.db.execute('SELECT prefix,number FROM business_codes WHERE object_id=?', (oid,)).fetchone()
    return row[0]+str(row[1]).zfill(3) if row else None


def evidence(store, ref):
    cache = getattr(store, '_production_reads', None)
    key = 'material_reference_evidence'
    if cache is None or key not in cache:
        values = {}
        for receipt in receipts(store):
            for item in receipt.get('references', []):
                values[(item['object_id'], item['revision_id'])] = item
        if cache is not None: cache[key] = values
    else:
        values = cache[key]
    return values.get((ref['object_id'], ref['revision_id']), {})


def describe(store, result):
    from . import production as p, production_current as current
    ref = result['value'].get('reference', result['value'])
    row = result.get('record')
    result.update(reference_contract=CONTRACT, original_reference=ref,
                  original_code=code(store, ref['object_id']))
    known = evidence(store, ref)
    payload = row['payload'] if row else {}
    result['title'] = known.get('title') or (payload.get('title') if not row or not row.get('unavailable') else None)
    if result.get('material_id'):
        need = p.record(store, result['canonical_material_id'])
        result.update(disposition='current', title=need['payload']['title'],
                      origin=need['payload'].get('scope'))
    else:
        result['disposition'] = 'missing' if not row or row.get('unavailable') or not payload.get('components') else 'historical'
        result['historical_requirements'] = []
        operation = payload.get('production', {}).get('object_id')
        if operation:
            try:
                saved = current.submission(store, operation)['snapshot']
                for need in saved.get('requirements', []):
                    body = need['payload']
                    result['historical_requirements'].append({
                        'object_id':need['object_id'], 'revision_id':need['revision_id'],
                        'code':code(store, need['object_id']), 'title':body.get('title'),
                        'scope':body.get('scope')})
                # Even without a saved demand the actual work may be known.
                result['subjects'] = [dict(reference=v, title=p.ref_record(store,v)['payload'].get('title'),
                                            code=code(store,v['object_id']))
                                      for v in saved.get('request', {}).get('subjects', [])]
            except (KeyError, ValueError):
                pass
        result['retirement_reason'] = payload.get('reason')
        for key in ('historical_requirements','subjects','reason','title','media_type','source_range','source_proof'):
            if key in known: result[key] = known[key]
        if result['disposition'] == 'historical':
            result['reason'] = result.get('reason') or ('原件为历史输入保留，已退出当前制作候选。' if result['historical_requirements']
                                    else '原件可回查；当时未保存准确素材需求，不能据此认定当前制作出处。')
        else:
            result['reason'] = result.get('reason') or '此准确修订的原件组成不可用；保留原引用，不替换为当前相似素材。'
    result['title'] = result.get('title') or result['original_code'] or '未记录名称的准确历史输入'
    result['label'] = ' · '.join(str(v) for v in (result.get('material_code') if result['disposition']=='current' else result['original_code'],
                      result['title'], '候选 '+str(result['candidate_number']) if result.get('candidate_number') else None) if v)
    return result


def candidate_codes(store, material_id):
    """Search old original numbers through proven unique candidate membership."""
    return [code(store, row[0]) for row in store.db.execute('''SELECT c.asset_object_id
        FROM production_candidate_targets t JOIN production_candidates c ON c.id=t.candidate_id
        WHERE t.material_id=? AND (SELECT count(*) FROM production_candidate_targets x WHERE x.candidate_id=c.id)=1''', (material_id,))]
