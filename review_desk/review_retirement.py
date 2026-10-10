"""Exact, one-time retirement of approval objects into ordinary comment history.

The instance classifies prose. This module validates the complete inventory and
applies the delta atomically. Receipts contain identities/hashes, never retired
payloads; existing calls and original comment rows remain byte-for-byte intact.
"""
import json

from .store import Conflict, canonical, digest, now
from . import production as p, version_consolidation as vc

FORMAT = 'comment-led-review-retirement-v1'
KINDS = {'JUDGMENT', 'REPRESENTATION'}


def inventory(store):
    return [{'revision_id': r['id'], 'object_id': r['object_id'], 'kind': r['kind'],
             'old_number': r['version'], 'sha256': digest(r['payload'].encode())}
            for r in store.db.execute("SELECT r.*,o.kind FROM revisions r JOIN objects o ON o.id=r.object_id "
                                      "WHERE o.kind IN ('JUDGMENT','REPRESENTATION') ORDER BY r.id")]


def plan(store, dispositions, updates=()):
    rows = inventory(store)
    if set(dispositions) != {r['revision_id'] for r in rows}:
        raise ValueError('必须逐条分类全部送审包装与决定的历史修订')
    document = {'format': FORMAT, 'revisions': rows,
                'dispositions': dispositions, 'updates': list(updates)}
    validate_plan(document)
    document['id'] = digest(canonical(document).encode())
    return document


def validate_plan(document):
    for revision in document['revisions']:
        item = document['dispositions'][revision['revision_id']]
        if item.get('action') not in ('delete', 'import', 'reuse') or not item.get('reason'):
            raise ValueError('退役记录须有明确去向或删除理由')
        if item['action'] != 'delete':
            source = item.get('source', {})
            if not all(source.get(k) for k in ('author', 'occurred_at', 'statement_kind', 'scope')):
                raise ValueError('历史意见须保留原主体、原发生时间、表述归属及范围')
            if source['statement_kind'] not in ('verbatim', 'reported', 'ai_check'):
                raise ValueError('历史意见主体类型无效')
            if not item.get('comment_id'):
                raise ValueError('历史意见须有稳定评论身份')
            if item['action'] == 'import' and not item.get('body', '').strip():
                raise ValueError('不能导入空意见')


def apply(store, document, *, fault=None, transaction=True):
    identity = document.get('id')
    if document.get('format') != FORMAT or identity != digest(canonical({k:v for k,v in document.items() if k != 'id'}).encode()):
        raise ValueError('审批退役包摘要不匹配')
    validate_plan(document)
    old = store.db.execute('SELECT receipt FROM consolidation_runs WHERE id=?', (identity,)).fetchone()
    if old:
        if inventory(store):
            raise Conflict('已退役的审批对象再次出现')
        return {**json.loads(old[0]), 'already_applied': True}
    if transaction:
        store.db.commit()
        store.db.execute('BEGIN IMMEDIATE')
    elif not store.db.in_transaction:
        raise ValueError('审批退役需要所属事务')
    try:
        if inventory(store) != document['revisions']:
            raise Conflict('审批历史已变化；未应用旧迁移包')
        retired = {r['revision_id'] for r in document['revisions']}
        object_ids = {r['object_id'] for r in document['revisions']}
        for oid in object_ids:
            if store.db.execute('SELECT 1 FROM comments WHERE target_object_id=?', (oid,)).fetchone():
                raise Conflict('送审对象仍有独有评论，须先明确原意见的内容归属')
        # All source additions happen in this transaction. Existing comment text,
        # author-time evidence, anchor, open/closed state and version are untouched.
        imported = reused = 0
        dispositions = []
        for revision in document['revisions']:
            rid = revision['revision_id']; item = document['dispositions'][rid]
            result = {**revision, 'action': item['action'], 'reason': item['reason']}
            if item['action'] != 'delete':
                cid = item['comment_id']; current = store.comment(cid)
                if item['action'] == 'reuse':
                    expected = item['expected_comment']
                    if not current or any(current.get(k) != v for k,v in expected.items()):
                        raise Conflict('待复用的原评论已变化：'+cid)
                    reused += 1
                else:
                    if current:
                        raise Conflict('历史导入的评论身份已被占用：'+cid)
                    target = item['target']; anchor = item['anchor']
                    store.validate_target(target['object_id'], target['revision_id'], anchor)
                    at = item['source']['occurred_at']
                    store.db.execute('INSERT INTO comments VALUES (?,?,?,?,?,?,?,?,?,?)',
                        (cid, None, target['object_id'], target['revision_id'], canonical(anchor),
                         item['body'], 'OPEN', 1, at, at))
                    from .material_versions import comment_scope
                    comment_scope(store, store.comment(cid))
                    imported += 1
                source = {**item['source'], 'format': 'historical-comment-source-v1',
                          'source_object': revision['object_id'], 'source_revision': rid,
                          'source_sha256': revision['sha256'], 'migration_id': identity}
                store.db.execute('INSERT INTO comment_events(comment_id,action,body,at) VALUES (?,?,?,?)',
                                 (cid, 'HISTORY_IMPORT', canonical(source), now()))
                result['comment_id'] = cid
            dispositions.append(result)
        # Detach only redundant approval links. All prose, original references
        # and historical revisions remain exact, including previously retired
        # non-approval links that ordinary new writes correctly cannot add.
        for update in document['updates']:
            row = p.record(store, update['object_id'])
            if row['id'] != update['expected_revision']:
                raise Conflict('需要移除旧审批引用的当前内容已变化')
            body = row['payload']
            for path in update['remove_paths']:
                keys = path.split('.')
                if keys.pop(0) != 'payload' or not keys:
                    raise ValueError('只能删除明确的审批引用字段')
                parent = body
                for key in keys[:-1]:
                    parent = parent[int(key)] if isinstance(parent, list) else parent[key]
                value = parent[keys[-1]]
                if not isinstance(value, dict) or value.get('revision_id') not in retired or value.get('object_id') not in object_ids:
                    raise ValueError('不能移除范围外内容')
                del parent[keys[-1]]
            version = row['version'] + 1
            rid = vc.new_identity(store, row['object_id'], version, body)
            stamp = now(); raw = canonical(body)
            store.db.execute('INSERT INTO revisions VALUES (?,?,?,?,?)', (rid,row['object_id'],version,raw,stamp))
            store.db.execute('UPDATE objects SET current_revision=?,version=?,updated_at=? WHERE id=?', (rid,version,stamp,row['object_id']))
            store.db.execute('INSERT INTO consolidation_revisions VALUES (?,?,?,?,?,?,?,?)',
                (rid,row['object_id'],row['kind'],version,version,digest(raw.encode()),vc.row_hash(row['object_id'],version,body),identity))
            for path,ref in p.references(body, include_unavailable=True):
                if vc.deleted(store, ref['revision_id']):
                    store.db.execute('INSERT INTO consolidation_missing VALUES (?,?,?,?)', (rid,path,ref['object_id'],ref['revision_id']))
                else:
                    store.db.execute('INSERT INTO dependencies VALUES (?,?,?)', (rid,ref['revision_id'],path))
        kept = missing = 0
        for row in store.db.execute('SELECT r.*,o.kind FROM revisions r JOIN objects o ON o.id=r.object_id').fetchall():
            if row['id'] in retired:
                continue
            body = json.loads(row['payload'])
            refs = [(path,ref) for path,ref in p.references(body, include_unavailable=True) if ref['revision_id'] in retired]
            if not refs:
                continue
            kept += 1
            store.db.execute('INSERT OR IGNORE INTO consolidation_revisions VALUES (?,?,?,?,?,?,?,?)',
                (row['id'],row['object_id'],row['kind'],row['version'],row['version'],
                 digest(row['payload'].encode()),vc.row_hash(row['object_id'],row['version'],body),identity))
            for path,ref in refs:
                store.db.execute('INSERT OR IGNORE INTO consolidation_missing VALUES (?,?,?,?)',
                                 (row['id'],path,ref['object_id'],ref['revision_id']))
                missing += 1
        for revision in document['revisions']:
            rid = revision['revision_id']
            for table, column in [('dependencies','from_revision'),('dependencies','to_revision'),
                                  ('state_cleanup_preserved','revision_id'),('relation_explanation_redactions','revision_id')]:
                store.db.execute('DELETE FROM '+table+' WHERE '+column+'=?', (rid,))
            store.db.execute('INSERT INTO consolidation_revisions VALUES (?,?,?,?,?,?,?,?) '
                'ON CONFLICT(revision_id) DO UPDATE SET new_number=NULL,after_sha256=NULL,plan_id=excluded.plan_id',
                (rid,revision['object_id'],revision['kind'],revision['old_number'],None,revision['sha256'],None,identity))
            store.db.execute('DELETE FROM revisions WHERE id=?', (rid,))
        for oid in sorted(object_ids):
            store.db.execute('INSERT OR IGNORE INTO consolidation_objects VALUES (?,?)', (oid,identity))
            store.db.execute('DELETE FROM objects WHERE id=?', (oid,))
        removed_codes = store.db.execute("DELETE FROM business_codes WHERE prefix IN ('RV','DC')").rowcount
        from .business_codes import allocate_comments
        allocate_comments(store)
        if fault == 'before_commit':
            raise RuntimeError('injected retirement failure before commit')
        if store.db.execute('PRAGMA foreign_key_check').fetchone():
            raise ValueError('退役迁移产生无效引用')
        receipt = {'format': FORMAT, 'id': identity, 'deleted_objects': len(object_ids),
                   'deleted_revisions': len(retired), 'deleted_codes': removed_codes,
                   'imported_comments': imported, 'reused_comments': reused,
                   'preserved_referencing_revisions': kept, 'retired_reference_paths': missing,
                   'dispositions': dispositions}
        store.db.execute('INSERT INTO consolidation_runs VALUES (?,?,?)', (identity, identity, canonical(receipt)))
        if transaction:
            store.db.commit()
        return receipt
    except BaseException:
        if transaction:
            store.db.rollback()
        raise
