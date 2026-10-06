"""Guarded retirement of independent states; exact identities become receipts.

The revision index remains an identity carrier for real historical references.
It contains no former state text, dimensions, sources or transition body.
"""
import json
from .store import canonical, digest, Conflict

NOTICE = '此准确状态目标已清理；原引用来源保留，未替换为其他状态。'
SCHEMA = '''
CREATE TABLE IF NOT EXISTS state_cleanup_receipts (
 revision_id TEXT PRIMARY KEY REFERENCES revisions(id), object_id TEXT NOT NULL,
 entity_ref TEXT NOT NULL, original_sha256 TEXT NOT NULL, receipt_sha256 TEXT NOT NULL,
 reason TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS state_cleanup_preserved (
 revision_id TEXT PRIMARY KEY REFERENCES revisions(id), payload_sha256 TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS state_cleanup_comments (
 comment_id TEXT PRIMARY KEY, object_id TEXT NOT NULL, revision_id TEXT NOT NULL,
 anchor_sha256 TEXT NOT NULL);
'''

def initialize(store):
    store.db.executescript(SCHEMA)
    store.db.commit()

def dump(store):
    return {key:[dict(r) for r in store.db.execute('SELECT * FROM '+key+' ORDER BY 1')]
            for key in ('state_cleanup_receipts','state_cleanup_preserved','state_cleanup_comments')}

def receipt_payload(r):
    return {'format':'state-cleanup-receipt-v1','object_id':r['object_id'],
            'revision_id':r['revision_id'],'entity':json.loads(r['entity_ref']),
            'original_sha256':r['original_sha256'],'reason':r['reason']}

def verify_row(row,r):
    if row['id']!=r['revision_id'] or row['object_id']!=r['object_id'] or json.loads(row['payload'])!=receipt_payload(r) or digest(row['payload'].encode())!=r['receipt_sha256']:
        raise ValueError('state deletion receipt mismatch')

def view(row):
    p=row['payload']
    # Read-only compatibility for historical references, never a new full state.
    return {**row,'kind':'STATE','cleaned_target':True,'payload':{
        'format':'production-state-v1','title':NOTICE,'blocks':[{'id':'cleaned-target','text':NOTICE}],
        'entity':p['entity'],'status':'withdrawn','sources':[], 'facts':[], 'choices':[],
        'unknowns':[],'dimensions':{},'cleanup_reason':p['reason']}}

def policy_ids(store):
    path=store.db_path.parent.parent/'config/instance.json'
    value=json.loads(path.read_text()).get('state_cleanup_policy',{}) if path.exists() else {}
    if not value:return set()
    if value.get('format')!='state-cleanup-policy-v1' or not isinstance(value.get('object_ids'),list) or any(not isinstance(v,str) or not v for v in value['object_ids']):
        raise ValueError('invalid instance state cleanup policy')
    return set(value['object_ids'])

def guard_restore(store,framework):
    required=policy_ids(store)
    if not required:return
    objects={r['id']:r['kind'] for r in (framework or {}).get('objects',[])}
    receipts={r['object_id'] for r in (framework or {}).get('state_cleanup_receipts',[])}
    if not required<=receipts or any(objects.get(oid)!='DELETED_STATE' for oid in required):
        raise Conflict('pre-cleanup export is not a valid recovery source for this instance')

def retired(store,object_id):
    return object_id in policy_ids(store) or bool(store.db.execute('SELECT 1 FROM state_cleanup_receipts WHERE object_id=?',(object_id,)).fetchone())

def guard_write(store,object_id,payload):
    from .production import references
    if retired(store,object_id) or any(retired(store,r['object_id']) for _,r in references(payload)):
        raise Conflict('state target has been physically cleaned; new writes cannot restore or reference it')

def preserved(store,object_id,payload):
    return bool(store.db.execute('''SELECT 1 FROM state_cleanup_preserved p JOIN revisions r ON r.id=p.revision_id
        WHERE r.object_id=? AND p.payload_sha256=?''',(object_id,digest(canonical(payload).encode()))).fetchone())

def retained_comment(store,c):
    r=store.db.execute('SELECT * FROM state_cleanup_comments WHERE comment_id=?',(c['id'],)).fetchone()
    return bool(r and c['target_object_id']==r['object_id'] and c['target_revision_id']==r['revision_id'] and digest(canonical(c['anchor']).encode())==r['anchor_sha256'])

def plan(store):
    from . import generation,production as p
    rows=p.current_records(store)
    entities=[r for r in rows if r['kind']=='ENTITY']
    active={r['revision_id'] for e in entities for r in generation.current_scope(store,e['object_id'],rows)['states']}
    targets=[r for r in rows if r['kind']=='STATE' and r['id'] not in active]
    ids={r['object_id'] for r in targets}
    revisions=[r for r in store.revisions() if r['object_id'] in ids]
    rids={r['id'] for r in revisions}
    affected={d['from_revision'] for d in store.dependencies() if d['to_revision'] in rids}-rids
    all_revisions={r['id']:r for r in store.revisions()}
    return {'format':'state-cleanup-v1','entity_heads':{e['object_id']:e['id'] for e in entities},
        'states':[{'object_id':r['object_id'],'current_revision':r['id'],'entity':r['payload']['entity'],
                   'reason':'当前实体完整状态范围外的历史保留独立状态'} for r in targets],
        'revisions':[{'object_id':r['object_id'],'revision_id':r['id'],'version':r['version'],
                      'payload_sha256':digest(r['payload'].encode()),'entity':json.loads(r['payload'])['entity']} for r in revisions],
        'preserved':[{'revision_id':rid,'payload_sha256':digest(all_revisions[rid]['payload'].encode())} for rid in sorted(affected)],
        'comments':[{'comment_id':c['id'],'object_id':c['target_object_id'],'revision_id':c['target_revision_id'],
                     'anchor_sha256':digest(canonical(c['anchor']).encode())} for c in store.comments() if c['target_revision_id'] in rids]}

def archive_update(store,delta,write=False,after=False):
    """Validate every content/archive input before the same cleanup transaction."""
    if not delta:return
    for row in delta['remove']:
        actual=store.db.execute('SELECT body FROM material_content WHERE id=?',(row['id'],)).fetchone()
        if (after and actual) or (not after and (not actual or digest(actual[0].encode())!=row['body_sha256'])):
            raise Conflict('state cleanup content input changed')
    for row in delta['insert']:
        actual=store.db.execute('SELECT body FROM material_content WHERE id=?',(row['id'],)).fetchone()
        if (after and (not actual or actual[0]!=row['body'])) or (not after and actual):
            raise Conflict('state cleanup new content differs')
        if digest(row['body'].encode())!=row['id']:raise ValueError('invalid cleanup content hash')
    for row in delta['archives']:
        actual=store.db.execute('SELECT container FROM material_archive_files WHERE path=?',(row['path'],)).fetchone()
        expected=row['after'] if after else row['before']
        if not actual or actual[0]!=expected:raise Conflict('state cleanup archive input changed')
    if write and not after:
        store.db.executemany('DELETE FROM material_content WHERE id=?',((r['id'],) for r in delta['remove']))
        store.db.executemany('INSERT INTO material_content VALUES (?,?)',((r['id'],r['body']) for r in delta['insert']))
        store.db.executemany('UPDATE material_archive_files SET container=? WHERE path=?',((r['after'],r['path']) for r in delta['archives']))

def apply(store,approved,validate_only=False,archive_delta=None):
    if approved.get('format')!='state-cleanup-v1':raise ValueError('unsupported state cleanup')
    store.db.commit()
    try:
        store.db.execute('BEGIN IMMEDIATE')
        actual=plan(store)
        receipts={r['revision_id']:r for r in dump(store)['state_cleanup_receipts']}
        if actual!=approved:
            if actual['states'] or actual['entity_heads']!=approved['entity_heads'] or not {r['revision_id'] for r in approved['revisions']}<=receipts.keys():
                raise Conflict('state cleanup inputs changed; no partial cleanup performed')
            for r in receipts.values():verify_row(dict(store.db.execute('SELECT * FROM revisions WHERE id=?',(r['revision_id'],)).fetchone()),r)
            archive_update(store,archive_delta,after=True)
            count=0
        else:
            archive_update(store,archive_delta)
            reason={r['object_id']:r['reason'] for r in approved['states']}
            for original in approved['revisions']:
                r={'revision_id':original['revision_id'],'object_id':original['object_id'],
                   'entity_ref':canonical(original['entity']),'original_sha256':original['payload_sha256'],
                   'reason':reason[original['object_id']]}
                body=canonical(receipt_payload(r));r['receipt_sha256']=digest(body.encode())
                store.db.execute('UPDATE revisions SET payload=? WHERE id=?',(body,r['revision_id']))
                store.db.execute('INSERT INTO state_cleanup_receipts VALUES (?,?,?,?,?,?)',tuple(r[k] for k in ('revision_id','object_id','entity_ref','original_sha256','receipt_sha256','reason')))
            for r in approved['states']:
                store.db.execute("UPDATE objects SET kind='DELETED_STATE' WHERE id=?",(r['object_id'],))
                store.db.execute('DELETE FROM dependencies WHERE from_revision IN (SELECT id FROM revisions WHERE object_id=?)',(r['object_id'],))
            for r in approved['preserved']:store.db.execute('INSERT INTO state_cleanup_preserved VALUES (?,?)',(r['revision_id'],r['payload_sha256']))
            for r in approved['comments']:store.db.execute('INSERT INTO state_cleanup_comments VALUES (?,?,?,?)',tuple(r[k] for k in ('comment_id','object_id','revision_id','anchor_sha256')))
            count=len(approved['states'])
        if count:archive_update(store,archive_delta,write=True)
        if store.db.execute('PRAGMA foreign_key_check').fetchone():raise ValueError('state cleanup foreign key failure')
        if validate_only:store.db.rollback()
        else:store.db.commit()
    except BaseException:
        store.db.rollback();raise
    return {'removed_state_objects':count,'removed_state_bodies':len(approved['revisions']) if count else 0,
            'identity_receipts':len(approved['revisions']),'validate_only':validate_only}
