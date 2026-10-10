"""Read author evidence against the original comments and immutable story revisions.

No comment status is stored here. Supplemental evidence uses ordinary GUIDANCE
objects, while historical structure responses remain in their original payloads.
"""
import json

from .store import Conflict, canonical, digest
from .structure import revision_record, object_revisions, STRUCTURE_ID
from .production import KINDS

FORMAT = 'comment-handling-v1'


def exact_revision(store, object_id, revision_id):
    revision = revision_record(store, revision_id)
    obj = store.db.execute('SELECT kind FROM objects WHERE id=?', (object_id,)).fetchone()
    if not revision or revision['object_id'] != object_id or not obj or (
            obj['kind'] not in {'SOURCE', 'EPISODE', *KINDS} and object_id != STRUCTURE_ID):
        raise ValueError('准确内容修订不存在或不匹配；未替换为最新稿')
    if obj['kind'] == 'SOURCE':
        source = store.source(object_id)
        if not source or revision['payload'].get('source_revision') != digest(canonical(source).encode()):
            raise ValueError('这份准确资料正文已不可用；未替换为当前正文')
        revision = {**revision, 'payload': source}
    return {**revision, 'kind': obj['kind'],
            'title': revision['payload'].get('title', object_id)}


def reference(store, value):
    record = exact_revision(store, value.get('object_id'), value.get('revision_id'))
    return {**value, 'title': record['title'], 'version': record['version'], 'kind': record['kind']}


def readable_reference(store, value):
    try:
        return reference(store, value)
    except ValueError as exc:
        return {**value, 'title': '准确稿件已不可用', 'version': None, 'kind': None, 'unavailable': str(exc)}


def import_evidence(store, documents, validate_only=False):
    if not isinstance(documents, list) or not documents:
        raise ValueError('需要完整的作者处理依据列表')
    records, seen = [], set()
    for item in documents:
        if not isinstance(item, dict) or item.get('format') != FORMAT:
            raise ValueError('invalid author evidence format')
        identity = item.get('id')
        if not isinstance(identity, str) or not identity.startswith('comment-handling-') or identity in seen:
            raise ValueError('invalid or duplicate evidence identity')
        seen.add(identity)
        comment = store.comment(item.get('comment_id'))
        original = item.get('original', {})
        if not comment or original != {
                'object_id': comment['target_object_id'], 'revision_id': comment['target_revision_id'],
                'anchor_sha256': digest(canonical(comment['anchor']).encode())}:
            raise ValueError('作者处理与原评论的准确修订或圈选不匹配')
        store.validate_target(comment['target_object_id'], comment['target_revision_id'], comment['anchor'])
        response = item.get('response', {})
        reply = exact_revision(store, response.get('object_id'), response.get('revision_id'))
        if reply['object_id'] == STRUCTURE_ID:
            matches = [r for r in reply['payload'].get('responses', []) if r['comment_id'] == comment['id']]
            if len(matches) != 1 or item.get('explanation', matches[0]['explanation']) != matches[0]['explanation']:
                raise ValueError('补充定位不得改写既有结构回应')
        elif not all(isinstance(item.get(k), str) and item[k].strip() for k in ('decision', 'explanation')):
            raise ValueError('作者处理须保存实际处理方式和理由')
        provenance = item.get('provenance', {})
        if not isinstance(provenance.get('file'), str) or not isinstance(provenance.get('sha256'), str) or len(provenance['sha256']) != 64:
            raise ValueError('author evidence provenance required')
        evidence = item.get('evidence', [])
        if not isinstance(evidence, list) or not evidence:
            raise ValueError('准确改动依据 required')
        refs = {original['revision_id'], response['revision_id']}
        for ref in evidence:
            reference(store, ref)
            store.validate_target(ref['object_id'], ref['revision_id'], ref.get('anchor'))
            if not isinstance(ref.get('label'), str) or not ref['label'].strip():
                raise ValueError('evidence label required')
            refs.add(ref['revision_id'])
        existing = store.db.execute('SELECT * FROM objects WHERE id=?', (identity,)).fetchone()
        if existing:
            old = revision_record(store, existing['current_revision'])
            if existing['kind'] != 'GUIDANCE' or old['payload'] != item:
                raise Conflict('已登记依据不同；不能覆盖原作者处理')
            continue
        records.append({'object_id': identity, 'kind': 'GUIDANCE', 'payload': item,
                        'expected_version': 0, 'dependencies': [
                            {'revision_id': ref, 'role': 'COMMENT_REVIEW_EVIDENCE'} for ref in sorted(refs)]})
    if not validate_only and records:
        store.put_objects(records)
    return {'validated': len(documents), 'added': 0 if validate_only else len(records),
            'existing': len(documents) - len(records)}


def evidence_records(store):
    rows = store.db.execute("SELECT r.payload FROM objects o JOIN revisions r ON r.id=o.current_revision "
                            "WHERE o.kind='GUIDANCE' AND json_extract(r.payload,'$.format')=?", (FORMAT,))
    return [json.loads(row[0]) for row in rows]


def snapshot(store, object_id, revision_id):
    current = exact_revision(store, object_id, revision_id)
    supplements = evidence_records(store)
    responses, relevant = {}, set()
    if object_id == STRUCTURE_ID:
        revisions = {r['id']: r for r in object_revisions(store, STRUCTURE_ID)}
        ancestors, cursor = set(), revision_id
        while cursor and cursor not in ancestors:
            if cursor not in revisions:
                raise ValueError('结构版本链不完整；未推测历史关系')
            ancestors.add(cursor)
            cursor = revisions[cursor]['payload'].get('parent_revision')
        for rid in ancestors:
            for response in revisions[rid]['payload'].get('responses', []):
                responses.setdefault(response['comment_id'], []).append({
                    'response': {'object_id': STRUCTURE_ID, 'revision_id': rid},
                    'explanation': response['explanation'], 'evidence': []})
        relevant.update(c['id'] for c in store.comments(target_object_id=object_id)
                        if c['target_revision_id'] in ancestors and c['target_revision_id'] != revision_id)
    for item in supplements:
        in_context = any(ref['object_id'] == object_id and ref['revision_id'] == revision_id
                         for ref in [item['original'], item['response'], *item['evidence']])
        if not in_context and item['comment_id'] not in relevant:
            continue
        relevant.add(item['comment_id'])
        entries = responses.setdefault(item['comment_id'], [])
        entry = next((r for r in entries if r['response'] == item['response']), None)
        if entry:
            entry.update({k: v for k, v in item.items() if k != 'explanation'})
        else:
            entries.append(item)
    reviews = []
    for cid in relevant:
        comment = store.comment(cid)
        if not comment:
            continue
        replies = []
        for response in responses.get(cid, []):
            refs = [{**readable_reference(store, ref), 'anchor_state': store.anchor_state(
                ref['object_id'], ref['revision_id'], ref['anchor'])} for ref in response.get('evidence', [])]
            replies.append({**response, 'response': readable_reference(store, response['response']), 'evidence': refs})
        replies.sort(key=lambda r: (r['response']['version'] or 0, r['response']['revision_id']))
        comment = store.comment_anchor_states([comment])[0]
        original = readable_reference(store, {'object_id': comment['target_object_id'],
                                     'revision_id': comment['target_revision_id']})
        reviews.append({'comment': comment, 'original': original, 'responses': replies,
                        'current_evidence': [ref for reply in replies for ref in reply['evidence']
                                             if ref['object_id'] == object_id and ref['revision_id'] == revision_id]})
    reviews.sort(key=lambda row: (row['comment']['created_at'], row['comment']['id']))
    return {'context': reference(store, {'object_id': object_id, 'revision_id': current['id']}),
            'reviews': reviews}


def content(store, object_id, revision_id):
    record = exact_revision(store, object_id, revision_id)
    if record['kind'] in KINDS:
        from .review_text import production_text_blocks
        record['review_blocks'] = production_text_blocks(record['payload'])
    return {'record': record}
