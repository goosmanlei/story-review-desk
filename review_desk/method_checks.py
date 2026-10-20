"""Scoped review facts inside immutable method artifacts, not a status ledger.

Fingerprints answer whether the reviewed inputs still apply. They never answer
whether a picture, performance or sound is good.
"""
import copy
from fractions import Fraction

from . import methods, production
from .store import Conflict

FORMAT = 'method-checks-v1'


def pointer(value, path):
    methods.require(isinstance(path, str) and path.startswith('/'), '检查字段须为 JSON Pointer')
    for part in path[1:].split('/'):
        key = part.replace('~1', '/').replace('~0', '~')
        if isinstance(value, list):
            methods.require(key == '0' or (key.isascii() and key.isdecimal()
                                          and not key.startswith('0')), '数组检查字段须为非负规范索引')
            value = value[int(key)]
        else:
            value = value[key]
    return copy.deepcopy(value)


def join_value(project, selector):
    from . import editing
    picture = sorted((c for c in project['clips'] if c['kind'] == 'video'),
                     key=lambda c: (c['timeline_start'], c['id']))
    pair = next(((left, right) for left, right in zip(picture, picture[1:])
                 if (left['id'], right['id']) == (selector['left'], selector['right'])), None)
    methods.require(pair is not None, '原相邻片段已改序或移除；按当前顺序重查接缝')
    left, right = pair
    handles = selector.get('handles', 24)
    methods.require(type(handles) is int and 1 <= handles <= 2400, '检查上下文须为 1–2400 个工程帧')
    rate = editing.fps(project)
    low = Fraction(min(left['timeline_start'] + editing.duration(left, project),
                       right['timeline_start']) - handles, 1) / rate
    high = Fraction(max(left['timeline_start'] + editing.duration(left, project),
                        right['timeline_start']) + handles, 1) / rate
    audio = [c for c in project['clips'] if c['kind'] == 'audio'
             and Fraction(c['timeline_start'], project['spec']['sample_rate']) < high
             and Fraction(c['timeline_start'] + editing.duration(c, project),
                          project['spec']['sample_rate']) > low]
    clips = [left, right] + sorted(audio, key=lambda c: c['id'])
    source_ids = {c['source_id'] for c in clips}
    track_ids = {c['track_id'] for c in clips}
    # Local inputs can support pre-mix observations. Final sound also depends on
    # whole-program loudness normalization, including distant audio edits.
    audio_scope = selector.get('audio_scope', 'mix')
    methods.require(audio_scope in ('local', 'mix'), '声音依据范围须为 local 或 mix')
    value = {'scope': {'kind': 'edit-join', 'handles': handles, 'audio_scope': audio_scope},
            'spec': {k: project['spec'][k] for k in ('fps', 'sample_rate', 'width', 'height')},
            'clips': clips,
            'sources': sorted((s for s in project['sources'] if s['id'] in source_ids), key=lambda s: s['id']),
            'tracks': sorted((t for t in project['tracks'] if t['id'] in track_ids), key=lambda t: t['id'])}
    if audio_scope == 'mix':
        all_audio = sorted((c for c in project['clips'] if c['kind'] == 'audio'), key=lambda c: c['id'])
        all_sources = {c['source_id'] for c in all_audio}
        all_tracks = {c['track_id'] for c in all_audio}
        value['mix_inputs'] = {
            'duration_frames': project['spec']['duration_frames'],
            'clips': all_audio,
            'sources': sorted((s for s in project['sources'] if s['id'] in all_sources), key=lambda s: s['id']),
            'tracks': sorted((t for t in project['tracks'] if t['id'] in all_tracks), key=lambda t: t['id'])}
    return value


def selected(store, selector, *, current):
    methods.require(selector.get('kind') in ('record', 'edit-join'), '未知检查依据类型')
    methods.require(selector.get('mode', 'current') in ('current', 'exact'), '依据模式须为 current 或 exact')
    ref = selector['reference']
    methods.require(set(ref) == {'object_id', 'revision_id'} and all(ref.values()), '检查依据须有准确对象和修订')
    row = production.record(store, ref['object_id'],
                            None if current and selector.get('mode', 'current') == 'current' else ref['revision_id'])
    if row.get('current_content'):
        # Current production revision IDs are addresses, not immutable drafts.
        methods.require(selector.get('mode', 'current') == 'current',
                        '当前制作正文不能用 exact 冒充历史稿；原观察保存在冻结方法产物中')
        if not current:
            from .production_current import marker
            methods.require(isinstance(selector.get('content_guard'), dict),
                            '当前制作依据须由 capture 固定正文标记')
            if selector['content_guard'] != marker(row):
                raise Conflict('当前制作正文已变化；回读准确内容后建立新检查步骤')
    if selector['kind'] == 'edit-join':
        methods.require(row['kind'] == 'EPISODE_EDIT', '接缝依据须指向可编辑工程')
        value = join_value(row['payload'], selector)
    else:
        paths = selector.get('paths')
        methods.require(isinstance(paths, list) and 0 < len(paths) <= 100
                        and len(set(paths)) == len(paths), '须声明本次所查字段，不能用空选择表示已检查')
        value = {path: pointer(row['payload'], path) for path in paths}
    return value


def capture(store, selector):
    """Freeze the exact text/selected timeline alongside its integrity hash."""
    selector = copy.deepcopy(selector)
    ref = selector['reference']
    row = production.record(store, ref['object_id'], ref['revision_id'])
    if row.get('current_content'):
        from .production_current import marker
        selector['content_guard'] = marker(row)
    value = selected(store, selector, current=False)
    return {'selector': selector, 'value': value, 'sha256': methods.checksum(value)}


def validate(value):
    methods.require(isinstance(value, dict) and value.get('format') == FORMAT, '检查覆盖格式无效')
    coverage = value.get('coverage')
    items = value.get('items')
    methods.require(isinstance(coverage, list) and 0 < len(coverage) <= 2000
                    and all(isinstance(x, str) and x for x in coverage)
                    and len(set(coverage)) == len(coverage), '覆盖范围须列出不重复的检查标识')
    methods.require(isinstance(items, list) and len(items) <= len(coverage), '检查结果列表无效')
    seen = set()
    for item in items:
        cid = item.get('id')
        methods.require(cid in coverage and cid not in seen, '检查结果重复或超出已声明范围')
        seen.add(cid)
        methods.require(item.get('level') in ('plan', 'source', 'edit'), '须区分计划、实际原件与成片检查')
        methods.require(item.get('verdict') in ('consistent', 'issue', 'blocked', 'intentional'), '检查结论无效')
        for key in ('observation', 'observer', 'modality'):
            methods.text(item.get(key), key, 20000)
        basis = item.get('basis')
        methods.require(isinstance(basis, list) and len(basis) <= 100, '检查须列准确依据')
        methods.require(bool(basis) or item['verdict'] == 'blocked', '有结论的检查不能缺准确依据')
        missing = item.get('missing', [])
        methods.require(isinstance(missing, list) and all(isinstance(x, str) and x for x in missing), '缺项须说明可补齐的输入')
        methods.require(not missing or item['verdict'] == 'blocked', '关键输入缺失时不能宣称已验证')
        if item['verdict'] in ('blocked', 'issue'):
            methods.text(item.get('next_action'), '继续处理要求')
        if item['verdict'] == 'blocked':
            methods.require(bool(missing), '阻断须指出关键缺项')
        for entry in basis:
            methods.require(entry.get('sha256') == methods.checksum(entry.get('value')),
                            '冻结检查内容与摘要不符')
            methods.require(isinstance(entry.get('selector'), dict), '检查依据选择无效')
    return value


def inspect(store, value):
    validate(value)
    by_id = {item['id']: item for item in value['items']}
    result = []
    for cid in value['coverage']:
        item = by_id.get(cid)
        if item is None:
            result.append({'id': cid, 'state': 'unreviewed', 'needs': ['提交该范围的实际检查结果']})
            continue
        changes = []
        for entry in item['basis']:
            try:
                actual = selected(store, entry['selector'], current=True)
                if methods.checksum(actual) != entry['sha256']:
                    changes.append({'selector': entry['selector'], 'reason': '所查内容已变化'})
            except (KeyError, ValueError, TypeError, IndexError) as exc:
                changes.append({'selector': entry['selector'], 'reason': str(exc)})
        result.append({'id': cid, 'state': 'stale' if changes else ('blocked' if item.get('missing') else 'current'),
                       'level': item['level'], 'verdict': item['verdict'],
                       'changes': changes, 'needs': item.get('missing', []),
                       'next_action': item.get('next_action', '')})
    return {'coverage': result, 'counts': {state: sum(r['state'] == state for r in result)
                                         for state in ('current', 'stale', 'blocked', 'unreviewed')}}


def guard_new(store, value):
    """Called inside the normal object-write transaction, before freezing."""
    validate(value)
    for item in value['items']:
        for entry in item['basis']:
            methods.require(methods.checksum(selected(store, entry['selector'], current=False))
                            == entry['sha256'], '冻结检查内容不属于所声明的准确修订')
    outcome = inspect(store, value)
    changed = [r['id'] for r in outcome['coverage'] if r['state'] == 'stale']
    if changed:
        raise Conflict('检查依据已变化；保留原检查并取得新步骤：' + '、'.join(changed))


def query(store, object_id):
    """Find reviews that use an object; history remains explicit and immutable."""
    methods.text(object_id, '要回查的对象')
    rows = store.db.execute(
        "SELECT r.object_id,r.id FROM revisions r "
        "WHERE json_extract(r.payload,'$.format')=? "
        "AND json_extract(r.payload,'$.output.checks.format')=? AND ("
        "json_extract(r.payload,'$.target')=? OR EXISTS ("
        "SELECT 1 FROM json_each(r.payload,'$.output.checks.items') item, "
        "json_each(item.value,'$.basis') basis "
        "WHERE json_extract(basis.value,'$.selector.reference.object_id')=?))",
        (methods.FORMATS['artifact'], FORMAT, object_id, object_id))
    result = []
    for raw in rows:
        row = methods.read(store, raw['object_id'], raw['id'])
        result.append({'artifact': methods.reference(row), 'target': row['payload']['target'],
                       'execution': row['payload']['execution'], 'stage': row['payload']['stage'],
                       **inspect(store, row['payload']['output']['checks'])})
    return {'object_id': object_id, 'reviews': result}
