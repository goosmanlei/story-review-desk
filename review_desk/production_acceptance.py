"""Explicit acceptance of an exact design or plan; never a generation call."""
from . import production as p
from .store import Conflict, digest

MODEL = 'production-content-v1'
KINDS = {'MATERIAL_RELATION', 'REQUIREMENT'}


def ref(row):
    return {'object_id': row['object_id'], 'revision_id': row['id']}


def decision_id(target):
    return 'production-acceptance-' + digest(target['object_id'].encode())[:32]


def scope(store, target):
    from .audiovisual import children
    result, seen, todo = [], set(), [target]
    while todo:
        row = todo.pop(0)
        if row['id'] in seen:
            continue
        seen.add(row['id']); result.append(ref(row)); todo.extend(children(store, row))
    return result


def snapshot(store, object_id, revision_id=None):
    target = p.record(store, object_id, revision_id)
    if target['kind'] not in KINDS:
        raise ValueError('此对象不使用制作内容采纳')
    exact = scope(store, target)
    # A group decision covers exact descendants. Later decisions on a child
    # override that child only. Persisted sequence numbers survive export and
    # restore; second-resolution timestamps cannot order quick UI actions.
    keys = {r['revision_id'] for r in exact}
    decisions = sorted((r for r in p.current_records(store, {'JUDGMENT'})
                        if r['payload'].get('acceptance_model') == MODEL),
                       key=lambda r: r['payload']['decision_sequence'])
    effective, decision = {}, None
    for row in decisions:
        covered = keys.intersection(r['revision_id'] for r in row['payload']['acceptance_scope'])
        if covered:
            decision = row
            effective.update({key: row for key in covered})
    accepted = all(key in effective and effective[key]['payload']['verdict'] == 'accepted' for key in keys)
    approvals = {r['id']: r for r in effective.values() if r['payload']['verdict'] == 'accepted'}
    history = [p.record(store, revision_id=r[0]) for r in store.db.execute("""
        SELECT r.id FROM revisions r JOIN objects o ON o.id=r.object_id
        WHERE o.kind='JUDGMENT' AND json_extract(r.payload,'$.acceptance_model')=?
        AND EXISTS (SELECT 1 FROM json_each(r.payload,'$.acceptance_scope') s
                    WHERE json_extract(s.value,'$.object_id')=?)
        ORDER BY json_extract(r.payload,'$.decision_sequence') DESC""", (MODEL, target['object_id']))]
    from .review_decisions import scope_records
    for row in history:
        row['scope_records'] = scope_records(store, row['payload']['acceptance_scope'])
    from .business_relations import archived_ids
    return {'target': ref(target), 'scope': exact, 'scope_records': scope_records(store, exact),
            'decision': decision, 'history': history,
            'accepted': accepted, 'acceptances': [ref(r) for r in approvals.values()],
            'partial': bool(approvals) and not accepted,
            'can_change': target['id'] == target['current_revision'] and object_id not in archived_ids(store)}


def validate(store, object_id, value, check_current=True):
    target = p.ref_record(store, value.get('target'), KINDS | ({'AV_EPISODE','AV_SCENE','AV_SHOT'} if not check_current else set()))
    if object_id != decision_id(target) or value.get('verdict') not in ('accepted', 'revoked'):
        raise ValueError('制作采纳身份或动作无效')
    if value.get('acceptance_scope') != scope(store, target):
        raise ValueError('采纳范围必须是本版设计的准确子项')
    previous = p.ref_record(store, value['previous_decision'], {'JUDGMENT'}) if value.get('previous_decision') else None
    if previous and (previous['payload'].get('acceptance_model') != MODEL or not
                     {r['revision_id'] for r in value['acceptance_scope']}.intersection(
                         r['revision_id'] for r in previous['payload']['acceptance_scope'])):
        raise ValueError('上一采纳记录不涉及此准确范围')
    sequence = value.get('decision_sequence')
    if type(sequence) is not int or sequence < 1 or (previous and sequence <= previous['payload']['decision_sequence']):
        raise ValueError('制作采纳顺序无效')
    if check_current:
        current = snapshot(store, target['object_id'], target['id'])
        if not current['can_change']:
            raise Conflict('当前设计已有新版本，请重新核对')
        if (ref(current['decision']) if current['decision'] else None) != value.get('previous_decision'):
            raise Conflict('采纳记录已变化，请重新读取')
        if value['verdict'] == 'revoked' and not (current['accepted'] or current['partial']):
            raise Conflict('没有可取消的准确采纳')
        if sequence != next_sequence(store):
            raise Conflict('采纳记录已变化，请重新读取')


def next_sequence(store):
    return 1 + max((r['payload']['decision_sequence'] for r in p.current_records(store, {'JUDGMENT'})
                    if r['payload'].get('acceptance_model') == MODEL), default=0)


def decide(store, request):
    if request.get('action') not in ('accept', 'revoke'):
        raise ValueError('请选择采纳或取消采纳')
    current = snapshot(store, request['object_id'], request['expected_revision'])
    previous = current['decision']
    if (ref(previous) if previous else None) != request.get('expected_decision'):
        raise Conflict('采纳记录已变化，请重新读取')
    if not current['can_change']:
        raise Conflict('设计已变化，请重新读取')
    verdict = 'accepted' if request['action'] == 'accept' else 'revoked'
    if (verdict == 'accepted') == current['accepted']:
        raise Conflict('采纳状态已经变化，请重新读取')
    target = p.ref_record(store, current['target'])
    reason = request.get('reason') or ('采纳此准确制作内容；实际生成与素材采用分别决定。' if verdict == 'accepted' else '取消此准确制作内容的采纳。')
    payload = {'format': 'production-judgment-v1', 'title': target['payload']['title']+' · 采纳',
               'blocks': [{'id': 'decision', 'text': reason}], 'target': current['target'],
               'actor': request.get('actor'), 'reason': reason, 'verdict': verdict,
               'acceptance_model': MODEL, 'acceptance_scope': current['scope'],
               'decision_sequence': next_sequence(store),
               'previous_decision': ref(previous) if previous else None}
    try:
        own_version = p.record(store, decision_id(target))['version']
    except KeyError:
        own_version = 0
    p.import_records(store, {'format': 'production-import-v1', 'records': [
        {'object_id': decision_id(target), 'kind': 'JUDGMENT', 'payload': payload,
         'expected_version': own_version}]})
    return snapshot(store, target['object_id'], target['id'])
