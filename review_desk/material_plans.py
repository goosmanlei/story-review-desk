"""Plan versions index immutable production records; legacy rounds stay intact.

A candidate identity comes from a real call and its original files. Index rows
never rewrite calls, source revisions, comment anchors or adoption references.
"""
import copy
import json
from .store import canonical, digest, Conflict
from . import production as p

TABLES = ('material_plan_versions', 'material_plan_members', 'material_candidate_members', 'material_plan_comments')
SCHEMA = '''
CREATE INDEX IF NOT EXISTS production_scope_revision ON revisions(json_extract(payload,'$.scope.revision_id'),object_id,version);
CREATE INDEX IF NOT EXISTS production_episode ON revisions(json_extract(payload,'$.episode.object_id'));
CREATE TABLE IF NOT EXISTS material_plan_versions (
 material_id TEXT NOT NULL REFERENCES objects(id), number INTEGER NOT NULL,
 fingerprint TEXT NOT NULL, frozen INTEGER NOT NULL, evidence TEXT NOT NULL,
 PRIMARY KEY(material_id,number));
CREATE TABLE IF NOT EXISTS material_plan_members (
 material_id TEXT NOT NULL, number INTEGER NOT NULL, revision_id TEXT NOT NULL REFERENCES revisions(id),
 role TEXT NOT NULL, PRIMARY KEY(material_id,revision_id),
 FOREIGN KEY(material_id,number) REFERENCES material_plan_versions(material_id,number));
CREATE INDEX IF NOT EXISTS material_plan_members_revision ON material_plan_members(revision_id);
CREATE TABLE IF NOT EXISTS material_candidate_members (
 candidate_id TEXT NOT NULL, revision_id TEXT NOT NULL REFERENCES revisions(id),
 PRIMARY KEY(candidate_id,revision_id));
CREATE TABLE IF NOT EXISTS material_plan_comments (
 comment_id TEXT NOT NULL REFERENCES comments(id), material_id TEXT NOT NULL, number INTEGER NOT NULL,
 PRIMARY KEY(comment_id,material_id),
 FOREIGN KEY(material_id,number) REFERENCES material_plan_versions(material_id,number));
'''


def dump(store):
    return {t: [dict(r) for r in store.db.execute('SELECT * FROM '+t+' ORDER BY 1,2')] for t in TABLES}


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
        inputs.append({**ref, **{k: item[k] for k in ('component_id', 'range', 'crop') if k in item}})
    return {'method': 'generate' if value.get('method') == 'generation' else value.get('method'), 'model': value.get('model'),
            'parameters': params, 'prompt': value.get('prompt'), 'inputs': inputs,
            'randomization': strategy}


def identity(payload):
    originals = sorted({c['sha256'] for c in payload.get('components', []) if c['role'] == 'original'})
    if not originals or payload.get('placeholder'):
        return None
    return 'candidate-'+digest(canonical({'call': payload.get('production', {}).get('object_id'), 'originals': originals}).encode())


def known(row):
    value = row['payload'].get('generation', {}) if row['kind'] == 'REQUIREMENT' else row['payload']
    method = value.get('method')
    return bool(method and value.get('model') and not any(word in str(value['model']).lower() for word in ('unknown','未知','待选','未提供')) and isinstance(value.get('parameters'),dict) and value.get('prompt'))


def legacy_signature(row):
    # Incomplete historical calls never become falsely identical plans.
    return digest(canonical(scheme(row['payload'], row['kind'])).encode()) if known(row) else 'unknown:'+row['object_id']


def signature(row, store=None):
    from .material_model import signature as complete_signature
    return complete_signature(row, store)


def memberships(store, revision_id):
    return [dict(v) for v in store.db.execute('SELECT * FROM material_plan_members WHERE revision_id=? ORDER BY material_id,number', (revision_id,))]


def bind(store, mid, number, row):
    role = {'REQUIREMENT': 'plan', 'CALL': 'call', 'ASSET': 'result'}[row['kind']]
    old = store.db.execute('SELECT number FROM material_plan_members WHERE material_id=? AND revision_id=?', (mid, row['id'])).fetchone()
    if old and old[0] != number:
        raise Conflict('exact revision already belongs to another plan version')
    store.db.execute('INSERT OR IGNORE INTO material_plan_members VALUES (?,?,?,?)', (mid, number, row['id'], role))
    if role == 'result':
        cid = identity(row['payload'])
        if cid:
            store.db.execute('INSERT OR IGNORE INTO material_candidate_members VALUES (?,?)', (cid, row['id']))


def version(store, mid, row, freeze=False):
    fp = signature(row,store)
    if row['kind']=='REQUIREMENT':
        previous=store.db.execute("SELECT m.number,r.id FROM material_plan_members m JOIN revisions r ON r.id=m.revision_id WHERE m.material_id=? AND m.role='plan' AND r.version<? ORDER BY r.version DESC LIMIT 1",(mid,row['version'])).fetchone()
        if previous and signature(p.record(store,revision_id=previous['id']),store)==fp:
            # An executed version stores resolved exact media, while its draft
            # may name future needs. Editing a title/association cannot create a
            # version merely because these two representations differ.
            bind(store,mid,previous['number'],row)
            return previous['number']
    existing = store.db.execute('SELECT * FROM material_plan_versions WHERE material_id=? AND fingerprint=? ORDER BY number DESC LIMIT 1', (mid, fp)).fetchone()
    last = store.db.execute('SELECT * FROM material_plan_versions WHERE material_id=? ORDER BY number DESC LIMIT 1', (mid,)).fetchone()
    evidence = 'exact-plan' if known(row) else ('unconfigured-plan' if row['kind']=='REQUIREMENT' else 'historical-scheme-incomplete')
    if existing:
        n = existing['number']
    elif last and not last['frozen']:
        n = last['number']
        store.db.execute('UPDATE material_plan_versions SET fingerprint=?,evidence=? WHERE material_id=? AND number=?', (fp, evidence, mid, n))
    else:
        n = last['number'] + 1 if last else 1
        store.db.execute('INSERT INTO material_plan_versions VALUES (?,?,?,?,?)', (mid, n, fp, 0, evidence))
    bind(store, mid, n, row)
    from .material_model import bind_definition
    bind_definition(store,mid,n,row)
    if freeze:
        store.db.execute('UPDATE material_plan_versions SET frozen=1 WHERE material_id=? AND number=?', (mid, n))
    return n


def call_version(store, mid, row):
    previous = store.db.execute("SELECT m.number FROM material_plan_members m JOIN revisions r ON r.id=m.revision_id WHERE m.material_id=? AND r.object_id=? AND m.role='call' ORDER BY r.version LIMIT 1", (mid, row['object_id'])).fetchone()
    if previous:
        prior=store.db.execute('SELECT fingerprint FROM material_plan_versions WHERE material_id=? AND number=?',(mid,previous[0])).fetchone()
        if prior[0]!=signature(row,store) and prior[0]!=legacy_signature(row):
            n=version(store,mid,row,freeze=True)
            store.db.execute("UPDATE material_plan_versions SET evidence='historical-call-scheme-conflict' WHERE material_id=? AND number=?",(mid,n))
            return n
        bind(store, mid, previous[0], row)
        return previous[0]
    return version(store, mid, row, freeze=row['payload']['status'] != 'planned')


def register(store, row):
    value = row['payload']
    if row['kind'] == 'REQUIREMENT':
        if memberships(store, row['id']):
            return
        version(store, row['object_id'], row)
    elif row['kind'] == 'CALL':
        if value['status'] == 'planned':
            return
        mid = (value.get('generation_requirement') or value.get('prepared_plan') or {}).get('object_id')
        if mid:
            call_version(store, mid, row)
        for member in store.db.execute("SELECT DISTINCT m.material_id FROM material_plan_members m JOIN revisions r ON r.id=m.revision_id WHERE r.object_id=?", (row['object_id'],)).fetchall():
            call_version(store, member[0], row)
    elif row['kind'] == 'ASSET' and identity(value):
        call = p.ref_record(store, value['production'], {'CALL'})
        targets = {v['object_id'] for v in value.get('candidate_requirements', [])}
        if call['payload'].get('generation_requirement'):
            targets.add(call['payload']['generation_requirement']['object_id'])
        # Another result from the same call may serve a different need. Only
        # explicit result associations or the submitted requirement establish
        # ownership; never spread the call's accumulated memberships sideways.
        if not targets:
            targets = {row['object_id']}
        for mid in sorted(targets):
            n = call_version(store, mid, call)
            bind(store, mid, n, row)


def belongs(store,revision_id,mid,number):
    if any(v['material_id']==mid and v['number']==number for v in memberships(store,revision_id)):
        return True
    row=store.db.execute('SELECT provenance FROM material_definition_versions WHERE material_id=? AND number=?',(mid,number)).fetchone()
    if not row:return False
    provenance=json.loads(row[0])
    return any(isinstance(v,dict) and v.get('record',{}).get('revision_id')==revision_id
               for key,v in provenance.items() if key in ('requirements','checks','output','generation'))


def comment_scope(store, comment, context):
    if not isinstance(context, dict) or set(context) != {'material_id', 'number', 'model'} or context['model'] != 'plan-v1':
        raise ValueError('plan comment context requires material_id, number and model=plan-v1')
    if not belongs(store,comment['target_revision_id'],context['material_id'],context['number']):
        raise Conflict('评论不属于所阅读的素材方案版本')
    store.db.execute('INSERT INTO material_plan_comments VALUES (?,?,?)', (comment['id'], context['material_id'], context['number']))


def snapshot(store, mid):
    result = []
    for v in store.db.execute('SELECT * FROM material_plan_versions WHERE material_id=? ORDER BY number DESC', (mid,)):
        rows = [p.record(store, revision_id=r[0]) for r in store.db.execute('SELECT revision_id FROM material_plan_members WHERE material_id=? AND number=? ORDER BY revision_id', (mid, v['number']))]
        plans = sorted([r for r in rows if r['kind'] == 'REQUIREMENT' and (not v['frozen'] or (signature(r,store)==v['fingerprint'] or legacy_signature(r)==v['fingerprint']))], key=lambda r: r['version'])
        for plan in plans:
            plan['review_input_records'] = [p.ref_record(store, item['reference']) for item in plan['payload'].get('generation', {}).get('inputs', [])]
        candidates = {}
        for row in sorted(rows, key=lambda r: (r['object_id'], r['version'])):
            if row['kind'] == 'ASSET' and identity(row['payload']):
                row['candidate_id'] = identity(row['payload'])
                candidates[row['candidate_id']] = row
        from .material_model import projection
        result.append({**dict(v), **projection(store,mid,v['number']), 'model': 'plan-v1', 'state': 'produced' if candidates else 'preparing',
                       'plan': plans[-1] if plans else None, 'scheme': next((scheme(r['payload'],r['kind']) for r in rows if r['kind'] in ('CALL','REQUIREMENT') and (signature(r,store)==v['fingerprint'] or legacy_signature(r)==v['fingerprint'])), None), 'results': list(candidates.values()), 'members': rows, 'feedback': []})
    return result


def for_record(store, row):
    ids = {r['material_id'] for r in memberships(store, row['id'])}
    if row['kind'] == 'REQUIREMENT':
        ids.add(row['object_id'])
    return {mid: value for mid in sorted(ids) if (value := snapshot(store, mid))}


def migration_plan(store):
    """Build on a caller-owned backup. The returned map can be reviewed and replayed."""
    before = dump(store)
    store.db.execute('SAVEPOINT plan_migration')
    try:
        rows = [p.record(store, revision_id=r[0]) for r in store.db.execute("SELECT r.id FROM revisions r JOIN objects o ON o.id=r.object_id WHERE o.kind IN ('REQUIREMENT','CALL','ASSET') ORDER BY r.created_at,CASE o.kind WHEN 'REQUIREMENT' THEN 0 WHEN 'CALL' THEN 1 ELSE 2 END,r.object_id,r.version")]
        # Actual calls/results establish frozen historical versions first. Old
        # requirement revisions remain readable; no latest plan fills a gap.
        for row in rows:
            if row['kind'] != 'REQUIREMENT':
                register(store, row)
        # An ASSET may identify only the submitted revision. Attach later real
        # completion/status receipts to the same call identity after producers
        # have established their exact material memberships.
        for row in rows:
            if row['kind'] == 'CALL':
                register(store,row)
        for row in rows:
            if row['kind'] == 'REQUIREMENT':
                register(store, row)
        after = dump(store)
        additions = {t: [r for r in after[t] if r not in before[t]] for t in TABLES}
        if any(r not in after[t] for t in TABLES for r in before[t]):
            raise Conflict('migration would rewrite an existing plan index')
        gaps = [v for v in after['material_plan_versions'] if v['evidence'] in ('historical-scheme-incomplete','historical-call-scheme-conflict')]
        old = [dict(r) for r in store.db.execute('SELECT * FROM material_members ORDER BY material_id,number,revision_id')]
        mapping = [{**v, 'plan_versions': memberships(store, v['revision_id']),
                    'candidates': [r[0] for r in store.db.execute('SELECT candidate_id FROM material_candidate_members WHERE revision_id=?', (v['revision_id'],))]} for v in old]
        gaps.extend({'revision_id':v['revision_id'],'material_id':v['material_id'],'evidence':'no-demonstrable-plan-membership'} for v in mapping if not v['plan_versions'])
        comments=[{'comment_id':c['id'],'target_object_id':c['target_object_id'],'target_revision_id':c['target_revision_id'],
                   'legacy_scopes':c.get('material_scopes',[]),'plan_versions':memberships(store,c['target_revision_id']),
                   'retained_anchor':c['anchor']}
                  for c in store.comments() if c.get('material_scopes') or memberships(store,c['target_revision_id'])]
        return {'format': 'material-plan-migration-v1', 'before': before, 'additions': additions,
                'required_revisions': sorted({v['revision_id'] for v in after['material_plan_members']}),
                'mapping': mapping, 'comment_mapping':comments, 'gaps': gaps}
    finally:
        store.db.execute('ROLLBACK TO plan_migration')
        store.db.execute('RELEASE plan_migration')


def restore(store, data, validate_after=True):
    for t in TABLES:
        for row in data[t]:
            cols = [v[1] for v in store.db.execute('PRAGMA table_info('+t+')')]
            if set(row) != set(cols):
                raise ValueError('invalid plan index columns: '+t)
            store.db.execute('INSERT INTO '+t+' ('+','.join(cols)+') VALUES ('+','.join('?' for _ in cols)+')', tuple(row[c] for c in cols))
    if validate_after:validate(store)


def validate(store):
    for v in store.db.execute('SELECT * FROM material_plan_versions'):
        if type(v['number']) is not int or v['number'] < 1 or v['frozen'] not in (0, 1) or p.record(store, v['material_id'])['kind'] not in ('REQUIREMENT', 'ASSET'):
            raise ValueError('invalid plan version')
        rows = [p.record(store, revision_id=r[0]) for r in store.db.execute('SELECT revision_id FROM material_plan_members WHERE material_id=? AND number=?', (v['material_id'], v['number']))]
        matching = [r for r in rows if r['kind'] in ('CALL', 'REQUIREMENT') and (signature(r,store) == v['fingerprint'] or legacy_signature(r) == v['fingerprint'])]
        if not matching:
            raise ValueError('plan fingerprint lacks exact source evidence')
        for row in rows:
            if row['kind'] == 'CALL' and signature(row,store) != v['fingerprint'] and legacy_signature(row) != v['fingerprint']:
                raise ValueError('different executed schemes share a version')
            if row['kind'] == 'REQUIREMENT' and row['object_id'] != v['material_id']:
                raise ValueError('plan revision belongs to a different material')
    for member in store.db.execute('SELECT * FROM material_plan_members'):
        row=p.record(store,revision_id=member['revision_id'])
        if member['role']!={'REQUIREMENT':'plan','CALL':'call','ASSET':'result'}.get(row['kind']):
            raise ValueError('plan member role differs from exact record kind')
        if member['role']=='result':
            producer=p.ref_record(store,row['payload']['production'],{'CALL'})
            if not any(m['material_id']==member['material_id'] and m['number']==member['number'] for m in memberships(store,producer['id'])):
                raise ValueError('candidate producer belongs to another plan version')
    for v in store.db.execute('SELECT * FROM material_candidate_members'):
        row = p.record(store, revision_id=v['revision_id'])
        if row['kind'] != 'ASSET' or identity(row['payload']) != v['candidate_id']:
            raise ValueError('candidate index differs from actual originals')
    for v in store.db.execute('SELECT * FROM material_plan_comments'):
        c = store.comment(v['comment_id'])
        if not belongs(store,c['target_revision_id'],v['material_id'],v['number']):
            raise ValueError('plan comment scope differs from exact anchor')


def migrate(store, document, validate_only=False):
    if document.get('format') != 'material-plan-migration-v1':
        raise ValueError('unsupported plan migration')
    store.db.execute('BEGIN IMMEDIATE')
    try:
        current = dump(store)
        additions = document['additions']
        if all(r in current[t] for t in TABLES for r in additions[t]):
            store.db.rollback()
            return {'already_applied': True}
        # Preserve unrelated concurrent records/comments. Changes to indexed
        # materials conflict; immutable source IDs are still verified below.
        mids = {r['material_id'] for r in additions['material_plan_versions']}
        for t in TABLES:
            expected = [r for r in document['before'][t] if r.get('material_id') in mids]
            actual = [r for r in current[t] if r.get('material_id') in mids]
            if expected != actual:
                raise Conflict('material plan index changed; prepare a new migration')
        for rid in document['required_revisions']:
            p.record(store, revision_id=rid)
        restore(store, additions)
        if validate_only:
            store.db.rollback()
        else:
            store.db.commit()
        return {'already_applied': False, 'validated_only': validate_only,
                'versions': len(additions['material_plan_versions']), 'gaps': len(document['gaps'])}
    except BaseException:
        store.db.rollback()
        raise
