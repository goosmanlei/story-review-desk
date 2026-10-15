"""Current material plans and real candidates; materials have no version axis."""
import copy
from .store import canonical, digest

def randomization(value):
    declared = value.get('randomization')
    seed = value.get('parameters', {}).get('seed')
    if declared is None:
        # An explicit seed in a submitted plan is a fixed strategy, never a
        # server-returned seed guessed from receipt metadata.
        if seed is not None and (type(seed) is not int or seed<0):raise ValueError('explicit seed must be a nonnegative integer')
        return {'mode': 'fixed', 'seed': seed} if seed is not None else {'mode': 'random'}
    if not isinstance(declared, dict) or declared.get('mode') not in ('random', 'fixed'):
        raise ValueError('randomization needs random or fixed mode')
    if declared['mode'] == 'fixed':
        if type(declared.get('seed')) is not int or declared['seed'] < 0:
            raise ValueError('fixed randomization needs a nonnegative integer seed')
        if seed is not None and seed != declared['seed']:
            raise ValueError('parameter seed and fixed strategy differ')
    elif 'seed' in declared:
        raise ValueError('actual random seed belongs to the call, not the plan strategy')
    if set(declared) - ({'mode', 'seed'} if declared['mode'] == 'fixed' else {'mode'}):
        raise ValueError('unknown randomization fields')
    return declared

def scheme(payload, kind):
    value = payload.get('generation', {}) if kind == 'REQUIREMENT' else payload
    params = copy.deepcopy(value.get('parameters', {}))
    strategy = randomization(value)
    if strategy['mode'] == 'random':
        params.pop('seed', None)
    inputs = []
    for item in value.get('inputs', []):
        ref = item.get('reference', item)
        # Keep exact nonmedia inputs too: they may actually condition a call.
        inputs.append({**ref, **{k: item[k] for k in ('component_id', 'range', 'crop', 'selection_state', 'role') if k in item}})
    return {'method': 'generate' if value.get('method') == 'generation' else value.get('method'), 'model': value.get('model'),
            'parameters': params, 'prompt': value.get('prompt'), 'inputs': inputs,
            'randomization': strategy, **({'execution':copy.deepcopy(value['execution'])} if 'execution' in value else {})}

def identity(payload):
    if payload.get('media_deleted'):
        return None
    if payload.get('candidate_identity'):
        return payload['candidate_identity']
    originals = sorted({c['sha256'] for c in payload.get('components', []) if c['role'] == 'original'})
    if not originals or payload.get('placeholder'):
        return None
    return 'candidate-'+digest(canonical({'call': payload.get('production', {}).get('object_id'), 'originals': originals}).encode())

def for_record(store, row):
    ids = {r['material_id'] for r in memberships(store, row['id'])}
    if row['kind'] == 'REQUIREMENT':
        from .material_storage import canonical_id
        ids.add(canonical_id(store, row['object_id']))
    return {mid: value for mid in sorted(ids) if (value := snapshot(store, mid))}


def memberships(store, revision_id):
    return [dict(v) for v in store.db.execute('SELECT * FROM material_memberships WHERE revision_id=? ORDER BY material_id', (revision_id,))]


def card_counts(store, material_ids=None):
    rows = {r['material_id']: r['n'] for r in store.db.execute('SELECT material_id,count(*) n FROM production_candidate_targets GROUP BY material_id')}
    ids = material_ids if material_ids is not None else rows
    aliases = dict(store.db.execute("SELECT alias_id,COALESCE(json_extract(evidence,'$.canonical_material_id'),material_id) FROM material_aliases"))
    return {mid: {'current_content': True, 'candidate_count': rows.get(aliases.get(mid,mid), 0)} for mid in ids}


def snapshot(store, mid):
    from .production_current import material_snapshot
    return material_snapshot(store, mid)
