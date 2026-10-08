"""Independent audiovisual editions over exact, unchanged story evidence.

Composition points down to immutable children. Material ownership points to an
exact design, independently of composition; revising a plan does not rewrite a
shot or pretend that an earlier call used the new plan.
"""
from . import production as p

KINDS = {'AV_EPISODE', 'AV_SCENE', 'AV_SHOT'}
CHILDREN = {'AV_EPISODE': ('scenes', 'AV_SCENE'), 'AV_SCENE': ('shots', 'AV_SHOT')}


def ref(row):
    return {'object_id': row['object_id'], 'revision_id': row['id']}


def source_keys(payload):
    return {(r['revision_id'], r['scene_id'], b)
            for r in payload.get('sources', []) for b in r.get('block_ids', [])}


def validate(store, kind, payload):
    lock = p.ref_record(store, payload.get('input_lock'), {'INPUT_LOCK'})
    allowed = {r['revision_id'] for r in lock['payload']['episodes']}
    sources = p._list(payload, 'sources')
    if not sources:
        raise ValueError('视听设计需要准确故事依据')
    for source in sources:
        episode = p.source_check(store, source)
        if episode['kind'] != 'EPISODE' or episode['id'] not in allowed:
            raise ValueError('视听故事依据不属于准确制作输入')
        if not source.get('scene_id') or not source.get('block_ids'):
            raise ValueError('视听故事依据须定位故事场和实际正文范围')
    if len({s['revision_id'] for s in sources}) != 1:
        raise ValueError('视听集沿用故事集边界，不跨故事集编排')
    for field in ('purpose', 'continuity'):
        p._text(payload.get(field), field)
    if kind in CHILDREN:
        field, child_kind = CHILDREN[kind]
        children = p._refs(store, payload, field, {child_kind})
        if not children or len({r['object_id'] for r in children}) != len(children):
            raise ValueError('编排需要不重复的准确子项')
        for child in children:
            if child['payload']['input_lock'] != payload['input_lock']:
                raise ValueError('编排子项的制作依据不同')
            if not source_keys(child['payload']) <= source_keys(payload):
                raise ValueError('子项故事范围超出本版编排依据')
        for field in ('structure', 'rhythm'):
            p._text(payload.get(field), field)
    if kind == 'AV_EPISODE':
        episode = p.ref_record(store, payload.get('story_episode'), {'EPISODE'})
        if {s['revision_id'] for s in sources} != {episode['id']}:
            raise ValueError('视听集与故事集依据不一致')
        if type(payload.get('number')) is not int or payload['number'] < 1:
            raise ValueError('视听集序号须为正整数')
    if kind == 'AV_SHOT':
        for field in ('framing', 'spatial', 'axis', 'movement', 'action_start',
                      'action_end', 'performance', 'lighting', 'color', 'editing'):
            p._text(payload.get(field), field)
        for field in ('duration_frames', 'fps'):
            if type(payload.get(field)) is not int or payload[field] <= 0:
                raise ValueError('镜头时长和帧率须为正整数')
        sound = p._list(payload, 'sound')
        if not sound or any(not (isinstance(v, str) and v.strip() or isinstance(v, dict) and
                                  any(isinstance(v.get(k), str) and v[k].strip() for k in ('text', 'description'))) for v in sound):
            raise ValueError('镜头须说明对白、环境、动作、音乐或有意静默')
        entities = p._refs(store, payload, 'entities', {'ENTITY'})
        states = p._refs(store, payload, 'states', {'STATE'})
        if any(s['payload']['entity']['object_id'] not in {e['object_id'] for e in entities} for s in states):
            raise ValueError('镜头实体状态缺少对应实体')
        p.full_states.validate_usage(store, kind, payload)
        context = payload.get('continuity_context', [])
        if not isinstance(context, list):
            raise ValueError('连续性背景必须为准确状态列表')
        for item in context:
            p.ref_record(store, item, {'STATE'})


def children(store, row):
    spec = CHILDREN.get(row['kind'])
    return [p.ref_record(store, r, {spec[1]}) for r in row['payload'][spec[0]]] if spec else []


def parents(store, row, *, current_only=True):
    parent_kind = {'AV_SHOT': 'AV_SCENE', 'AV_SCENE': 'AV_EPISODE'}.get(row['kind'])
    if not parent_kind:
        return []
    field = CHILDREN[parent_kind][0]
    query = '''SELECT DISTINCT r.*,o.kind,o.current_revision FROM revisions r
        JOIN objects o ON o.id=r.object_id, json_each(r.payload,?) child
        WHERE o.kind=? AND json_extract(child.value,'$.revision_id')=?'''
    if current_only:
        query += ' AND r.id=o.current_revision'
    return [p.record_view(r) for r in store.db.execute(query+' ORDER BY r.version DESC,r.object_id',
                                                       ('$.'+field, parent_kind, row['id']))]


def path(store, row):
    """Return an evidenced composition, never substitute a different child."""
    result = [row]
    while result[-1]['kind'] != 'AV_EPISODE':
        choices = parents(store, result[-1]) or parents(store, result[-1], current_only=False)
        if not choices:
            break
        result.append(choices[0])
    return list(reversed(result))


def catalog(store, episode=None, object_id=None, revision_id=None, view=None):
    editions = sorted(p.current_records(store, {'AV_EPISODE'}), key=lambda r: r['payload']['number'])
    target = p.record(store, object_id, revision_id) if object_id else None
    if target and target['kind'] not in KINDS:
        raise ValueError('该旧制作对象已退出视听编排；不能替换成新设计')
    route = path(store, target) if target else []
    selected = next((r for r in route if r['kind'] == 'AV_EPISODE'), None)
    if not selected:
        selected = next((r for r in editions if r['object_id'] == episode), None) if episode else next(iter(editions), None)
    if episode and not selected:
        raise KeyError('视听集不存在')
    if not selected:
        return {'episodes': [], 'scenes': [], 'shots': [], 'design': None, 'lock': None}
    scenes = children(store, selected)
    shots = [child for scene in scenes for child in children(store, scene)]
    if target and target['id'] not in {r['id'] for r in [selected, *scenes, *shots]}:
        raise ValueError('准确设计未编入这版视听集')
    def comment_targets(edition):
        from .production_breakdown import material_comment_targets
        values = [edition, *children(store, edition)]
        values.extend(s for scene in children(store, edition) for s in children(store, scene))
        targets = {r['id']: ref(r) for r in values}
        for row in values:
            for material in material_comment_targets(store, row['id']):
                targets[material['id']] = ref(material)
        return list(targets.values())
    return {'episodes': [{'object_id': r['object_id'], 'id': r['id'],
                         'number': r['payload']['number'], 'title': r['payload']['title'],
                         'comment_targets': comment_targets(r),
                         'version': r['version'], 'scenes': [{'id': c['object_id'], 'title': c['payload']['title']} for c in children(store, r)]} for r in editions],
            'episode': selected['object_id'], 'design': selected,
            'versions': [{'id': r['id'], 'version': r['version']} for r in store.db.execute(
                'SELECT id,version FROM revisions WHERE object_id=? ORDER BY version DESC', (selected['object_id'],))],
            'scenes': scenes, 'shots': shots, 'target': ref(target) if target else None,
            'lock': p.ref_record(store, selected['payload']['input_lock'])}


def locations(store, row):
    result = []
    if row['kind'] in KINDS:
        paths = [path(store, row)]
    else:
        paths = [path(store, r) for r in p.current_records(store, {'AV_SHOT'})
                 if any(v['object_id'] == row['object_id'] for v in
                        r['payload'].get('entities', []) + r['payload'].get('states', []))]
    for chain in paths:
        result.append({'kind': 'audiovisual', 'path': [
            {**ref(r), 'kind': r['kind'], 'title': r['payload']['title']} for r in chain]})
    return result


def related(store, reference):
    """Evidence and occurrence are distinct; neither implies media use."""
    p.source_check(store, reference)
    result = []
    for row in p.current_records(store, {'ENTITY', 'STATE', 'RELATION', 'REQUIREMENT', *KINDS}):
        matches = []
        for source in row['payload'].get('sources', []):
            if source.get('revision_id') != reference['revision_id']:
                continue
            if reference.get('scene_id') and source.get('scene_id') != reference['scene_id']:
                continue
            if reference.get('block_ids') and not set(reference['block_ids']) & set(source.get('block_ids', [])):
                continue
            matches.append(source)
        if matches:
            result.append({'record': row, 'sources': matches, 'connection': '故事依据'})
    return {'reference': reference, 'items': result}
