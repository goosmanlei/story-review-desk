"""Local comment and response excerpts through in-place production edits."""
import copy
import json
from . import production as p, production_current as current
from .store import Conflict, canonical, digest


def retain(store, item):
    comment = store.comment(item['comment_id'])
    refs = [('original', item['original']), ('response', item['response'])]
    refs += [('evidence:'+str(i), ref) for i,ref in enumerate(item['evidence'])]
    for locator, ref in refs:
        try:
            row = p.ref_record(store, ref)
        except (KeyError, ValueError):
            continue
        if row['kind'] not in current.RECORD_KINDS:
            continue
        anchor = comment['anchor'] if locator == 'original' else ref.get('anchor')
        context = comment.get('original_context') if locator == 'original' else None
        excerpt = {'title': context['excerpt']['title'] if context else row['payload'].get('title'),
                   'anchor': copy.deepcopy(anchor)}
        store.db.execute('INSERT INTO production_response_excerpts VALUES (?,?,?,?,?,?)',
                         (item['id'], locator, row['object_id'], context['original_revision_id'] if context else row['id'],
                          context['content_sha256'] if context else current.checksum(row['payload']), canonical(excerpt)))


def read(store, item, locator, ref):
    row = store.db.execute('SELECT * FROM production_response_excerpts WHERE evidence_id=? AND locator=?', (item.get('id'), locator)).fetchone()
    if not row:
        return None
    excerpt = json.loads(row['excerpt'])
    head = store.db.execute('SELECT * FROM production_current_records WHERE object_id=?', (row['object_id'],)).fetchone()
    same = bool(head and head['payload_sha256'] == row['content_sha256'])
    result = {**ref, 'title': excerpt['title'], 'version': None, 'production_excerpt': excerpt,
              'content_sha256': row['content_sha256'], 'matches_current': same,
              'current_reference': {'object_id': row['object_id'], 'revision_id': head['revision_id']} if head else None}
    if ref.get('anchor'):
        result['anchor_state'] = {'valid': same, 'reason': '' if same else '当前正文后来已修改；这里保留当时整改摘录。'}
    return result


def import_current(store, documents, validate_only=False):
    from .comment_review import FORMAT, exact_revision
    from .structure import STRUCTURE_ID
    added = 0
    seen = set()
    store.db.execute('BEGIN IMMEDIATE')
    try:
        for source in documents:
            item = copy.deepcopy(source)
            oid = item.get('id')
            if item.get('format') != FORMAT or not isinstance(oid,str) or not oid.startswith('comment-handling-') or oid in seen:
                raise ValueError('作者处理依据身份无效')
            seen.add(oid)
            comment = store.comment(item['comment_id'])
            if not comment:
                raise ValueError('原意见不存在')
            expected = {'object_id': comment['target_object_id'], 'revision_id': comment['target_revision_id'],
                        'anchor_sha256': digest(canonical(comment['anchor']).encode())}
            if item['original'] != expected:
                raise ValueError('原意见身份或摘录不匹配')
            old = store.db.execute('SELECT current_revision FROM objects WHERE id=?', (oid,)).fetchone()
            if old:
                if p.record(store,oid)['payload'] != item:
                    raise Conflict('既有回应不能改写；请添加后续实际处理记录')
                continue
            if not all(isinstance(item.get(k),str) and item[k].strip() for k in ('decision','explanation')):
                raise ValueError('须说明实际处理及原因')
            provenance = item.get('provenance',{})
            if not provenance.get('file') or len(provenance.get('sha256',''))!=64:
                raise ValueError('须给出实际处理文件及摘要')
            reply = exact_revision(store,item['response']['object_id'],item['response']['revision_id'])
            if reply['kind'] in current.RECORD_KINDS:
                current.guard(store,reply['object_id'],item.get('expected_response_content'))
            if not comment.get('original_context'):
                store.validate_target(comment['target_object_id'],comment['target_revision_id'],comment['anchor'])
            if reply['object_id'] == STRUCTURE_ID:
                responses = [r for r in reply['payload'].get('responses',[]) if r['comment_id'] == comment['id']]
                if len(responses) != 1 or item['explanation'] != responses[0]['explanation']:
                    raise ValueError('补充定位不得改写既有结构回应')
            if not item.get('evidence'):
                raise ValueError('须保留实际修改的局部前后片段')
            for ref in item['evidence']:
                exact_revision(store,ref['object_id'],ref['revision_id'])
                store.validate_target(ref['object_id'],ref['revision_id'],ref['anchor'])
                if not ref.get('label'):
                    raise ValueError('整改片段需要用途说明')
            deps = {item['response']['revision_id'], *[r['revision_id'] for r in item['evidence']]}
            store._put_object(oid,'GUIDANCE',item,0,[{'revision_id':r,'role':'COMMENT_REVIEW_EVIDENCE'} for r in sorted(deps)])
            retain(store,item)
            added += 1
        if validate_only: store.db.rollback()
        else: store.db.commit()
    except BaseException:
        store.db.rollback()
        raise
    return {'validated':len(documents),'added':0 if validate_only else added,'existing':len(documents)-added}
