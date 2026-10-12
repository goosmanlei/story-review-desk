"""One authored production category; media_type describes the physical output.

Never infer a category from names, scopes, model prompts, or file extensions.
Older frozen submissions/executions remain readable with their original fields.
"""
CATEGORIES = {
    'character-image': ('image', '角色图像', 'image', 'image-plan'),
    'scene-image': ('image', '场景图像', 'image', 'image-plan'),
    'prop-image': ('image', '道具图像', 'image', 'image-plan'),
    'shot-image': ('image', '镜头画面', 'image', 'image-plan'),
    'voice': ('audio', '人物音色', 'audio', 'voice-plan'),
    'scene-sound': ('audio', '场景音', 'audio', 'scene-sound-plan'),
    'song': ('audio', '演唱', 'audio', 'song-plan'),
    'video': ('video', '视频', 'video', 'video-plan'),
    'text-layer': ('text-layer', '字层', 'project', 'text-layer'),
}
GROUPS = {'image': '图像', 'audio': '声音', 'video': '视频', 'text-layer': '字层'}


def catalog():
    return [{'key': group, 'label': label, 'categories': [
        {'key': key, 'label': spec[1]} for key, spec in CATEGORIES.items() if spec[0] == group]}
        for group, label in GROUPS.items()]


def enabled(store):
    # The exact current binding is also the cutover; no second classification
    # table or independent activation switch can drift from the author entry.
    row = store.db.execute("SELECT r.payload FROM objects o JOIN revisions r ON r.id=o.current_revision "
                           "WHERE o.id='method.binding.media-plan'").fetchone()
    if not row:
        return False
    import json
    return any('material_category' in rule.get('when', {}) for rule in json.loads(row[0]).get('rules', []))


def validate(payload, *, required=False):
    category = payload.get('material_category')
    if category is None and not required:
        return None  # Old input only; never manufacture a new category.
    if not isinstance(category, str) or category not in CATEGORIES:
        raise ValueError('素材分类缺失或非法；请按独立交付职责明确一个具体分类')
    expected = CATEGORIES[category][2]
    if payload.get('media_type') != expected:
        raise ValueError('素材分类与物理媒体不兼容：' + CATEGORIES[category][1])
    if 'audio_type' in payload or 'material_group' in payload:
        raise ValueError('只保存 material_category；声音子类和大类由该分类取得')
    return category


def conditions(store, payload, supplied=None, *, frozen=False):
    supplied = supplied or {}
    if not isinstance(supplied, dict):
        raise ValueError('方法选择条件应为对象')
    category = validate(payload, required=not frozen and enabled(store))
    fixed = {'media_type': payload['media_type']}
    if category:
        fixed['material_category'] = category
        # Accept the old caller's matching audio hint at this input boundary
        # only. Do not store it or let it select another method.
        if 'audio_type' in supplied and supplied['audio_type'] != category:
            raise ValueError('调用条件不能改变素材分类；请先明确修订素材并重新准备')
    if any(key in supplied and supplied[key] != value for key, value in fixed.items()):
        raise ValueError('调用条件不能改变素材分类或物理媒体类型')
    if category and 'material_group' in supplied:
        raise ValueError('素材大类由具体分类确定，不能另传选择条件')
    return {**{k: v for k, v in supplied.items() if not category or k != 'audio_type'}, **fixed}


def package(store, payload, supplied=None):
    from . import methods
    selected = conditions(store, payload, supplied)
    result = methods.resolve(store, 'media-plan', selected)
    category = payload.get('material_category')
    if category:
        expected = 'method.skill.' + CATEGORIES[category][3]
        if result['method']['object_id'] != expected:
            raise ValueError('素材分类的方法绑定不匹配：' + CATEGORIES[category][1])
        if CATEGORIES[category][0] == 'image':
            path = 'references/' + category + '.md'
            if not result['files'].get(path, '').strip():
                raise ValueError('图像分类缺少专项文件：' + path)
    return result


def matches(category, selected):
    return not selected or category == selected or (
        category in CATEGORIES and CATEGORIES[category][0] == selected)


def validate_tree(store):
    """Require a complete cutover before export, restore or publication.

    Individual authoring writes can proceed during an isolated migration; each
    written requirement is already checked by production.validate_payload.
    Untouched legacy rows must never make a partial cutover deliverable.
    """
    if not enabled(store):
        return
    # A zero-count category still needs its real authoring method at delivery.
    for key, spec in CATEGORIES.items():
        package(store, {'material_category': key, 'media_type': spec[2]})
    from . import production as p
    for row in p.current_records(store, {'REQUIREMENT'}):
        if row['payload'].get('status') != 'withdrawn':
            validate(row['payload'], required=True)
