"""Remove superseded explanation text while preserving exact relation facts.

Redaction is an explicit, guarded exception to immutable explanation payloads.
The original revision ID remains a historical locator, not a claim that a new
explanation is the old text. No full original explanation is retained here.
"""
import json
from .store import canonical, digest, Conflict

SCHEMA = '''
CREATE TABLE IF NOT EXISTS relation_explanation_policy (id INTEGER PRIMARY KEY CHECK(id=1), latest_only INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS relation_explanation_redactions (
 revision_id TEXT PRIMARY KEY REFERENCES revisions(id), object_id TEXT NOT NULL,
 payload_sha256 TEXT NOT NULL, facts_sha256 TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS relation_redacted_comments (
 comment_id TEXT PRIMARY KEY, object_id TEXT NOT NULL, revision_id TEXT NOT NULL,
 anchor_sha256 TEXT NOT NULL);
'''
NOTICE = '此准确修订的旧关系说明已清理；端点、方向、类型和剧情依据仍保留。'
TEXT_FIELDS = {'title','label','blocks'}


def initialize(store):
    store.db.executescript(SCHEMA)
    store.db.commit()


def facts(payload):
    return {k:v for k,v in payload.items() if k not in TEXT_FIELDS | {'explanation_removed'}}


def cleaned(payload):
    return {**facts(payload), 'title':'历史关系事实（旧说明已清理）', 'label':'旧说明已清理',
            'blocks':[{'id':'explanation-removed','text':NOTICE}], 'explanation_removed':True}


def redact(store, revision_id):
    row=store.db.execute('SELECT r.*,o.kind,o.current_revision FROM revisions r JOIN objects o ON o.id=r.object_id WHERE r.id=?',(revision_id,)).fetchone()
    if not row or row['kind']!='RELATION' or row['current_revision']==revision_id:
        raise ValueError('only superseded entity relationship explanations may be removed')
    original=json.loads(row['payload'])
    if original.get('relation_type')!='entity':
        raise ValueError('not an entity relationship')
    if store.db.execute('SELECT 1 FROM relation_explanation_redactions WHERE revision_id=?',(revision_id,)).fetchone():
        verify_row(dict(row),dict(store.db.execute('SELECT * FROM relation_explanation_redactions WHERE revision_id=?',(revision_id,)).fetchone()))
        return False
    expected=digest(canonical({'object_id':row['object_id'],'version':row['version'],'payload':original}).encode())
    if expected!=revision_id:
        raise ValueError('original relationship revision checksum differs')
    after=canonical(cleaned(original))
    for comment in store.db.execute('SELECT * FROM comments WHERE target_revision_id=?',(revision_id,)).fetchall():
        store.db.execute('INSERT INTO relation_redacted_comments VALUES (?,?,?,?)',
                         (comment['id'],row['object_id'],revision_id,digest(comment['anchor'].encode())))
    store.db.execute('UPDATE revisions SET payload=? WHERE id=?',(after,revision_id))
    store.db.execute('INSERT INTO relation_explanation_redactions VALUES (?,?,?,?)',
                     (revision_id,row['object_id'],digest(after.encode()),digest(canonical(facts(original)).encode())))
    return True


def verify_row(row, attestation):
    payload=json.loads(row['payload'])
    if (row['id']!=attestation['revision_id'] or row['object_id']!=attestation['object_id']
            or payload.get('format')!='production-relation-v1' or payload.get('relation_type')!='entity'
            or payload!=cleaned(payload) or digest(canonical(payload).encode())!=attestation['payload_sha256']
            or digest(canonical(facts(payload)).encode())!=attestation['facts_sha256']):
        raise ValueError('invalid relationship explanation redaction')


def dump(store):
    return [dict(r) for r in store.db.execute('SELECT * FROM relation_explanation_redactions ORDER BY object_id,revision_id')]


def retained_comment(store, comment):
    row=store.db.execute('SELECT * FROM relation_redacted_comments WHERE comment_id=?',(comment['id'],)).fetchone()
    return bool(row and comment['target_object_id']==row['object_id'] and comment['target_revision_id']==row['revision_id']
                and digest(canonical(comment['anchor']).encode())==row['anchor_sha256'])


def plan(store):
    rows=list(store.db.execute("SELECT r.*,o.current_revision,o.kind FROM revisions r JOIN objects o ON o.id=r.object_id WHERE o.kind='RELATION' AND json_extract(r.payload,'$.relation_type')='entity' ORDER BY r.object_id,r.version"))
    heads={r['object_id']:r['current_revision'] for r in rows}
    old=[r for r in rows if r['id']!=r['current_revision'] and not json.loads(r['payload']).get('explanation_removed')]
    ids={r['id'] for r in old}
    comments=[c for c in store.comments() if c['target_revision_id'] in ids]
    return {'format':'relation-explanation-cleanup-v1','heads':heads,
            'revisions':[{'object_id':r['object_id'],'revision_id':r['id'],'version':r['version'],
                          'payload_sha256':digest(r['payload'].encode())} for r in old],
            'comments':comments}


def apply(store, approved, validate_only=False):
    if approved.get('format')!='relation-explanation-cleanup-v1':
        raise ValueError('unsupported relationship cleanup')
    store.db.commit()
    try:
        store.db.execute('BEGIN IMMEDIATE')
        actual=plan(store)
        if actual!=approved:
            # An identical fully applied package is safe to replay. Verify all
            # attestations and current heads; concurrent head changes still stop.
            already={r['revision_id'] for r in dump(store)}
            if actual['heads']!=approved['heads'] or actual['revisions'] or not {r['revision_id'] for r in approved['revisions']}<=already:
                raise Conflict('relationship history or comments changed; prepare and review a fresh cleanup')
            for row in dump(store):
                revision=dict(store.db.execute('SELECT * FROM revisions WHERE id=?',(row['revision_id'],)).fetchone())
                verify_row(revision,row)
            count=0
        else:
            count=sum(redact(store,r['revision_id']) for r in approved['revisions'])
        store.db.execute('INSERT OR REPLACE INTO relation_explanation_policy VALUES (1,1)')
        if store.db.execute('PRAGMA foreign_key_check').fetchone():
            raise ValueError('relationship cleanup foreign key failure')
        if validate_only:store.db.rollback()
        else:store.db.commit()
    except BaseException:
        store.db.rollback()
        raise
    return {'removed_explanations':count,'facts_and_revision_locators_preserved':True,'validate_only':validate_only}


def supersede(store, object_id, previous):
    enabled=store.db.execute('SELECT latest_only FROM relation_explanation_policy WHERE id=1').fetchone()
    if previous and enabled and enabled[0]:
        redact(store,previous)
