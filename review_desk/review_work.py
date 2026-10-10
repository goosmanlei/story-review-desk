"""Exact work being read; a projection, never an acceptance scope."""
from . import production as p


def context(store, object_id=None, revision_id=None, scene_id=None):
    if not object_id:
        return None
    if not revision_id:
        raise ValueError('当前作品需要准确版本')
    row = p.record(store, object_id, revision_id)
    positions, sources = [], []
    if row['kind'] == 'EPISODE':
        scene = next((s for s in row['payload']['scenes'] if s['id'] == scene_id), None)
        if not scene:
            raise ValueError('当前故事场不属于此准确版本')
        source = dict(object_id=object_id, revision_id=revision_id, scene_id=scene_id)
        sources.append(source)
        from .audiovisual import related
        positions = [item['record'] for item in related(store, source)['items']
                     if item['record']['kind'] in ('AV_SCENE', 'AV_SHOT')]
        title = scene.get('heading') or scene.get('title') or scene.get('location') or scene_id
    elif row['kind'] in ('AV_SCENE', 'AV_SHOT', 'AV_EPISODE'):
        if row['kind'] == 'AV_EPISODE':
            children = [p.ref_record(store, ref) for ref in row['payload']['scenes']]
            if scene_id:
                children = [r for r in children if r['object_id'] == scene_id]
                if len(children) != 1:
                    raise ValueError('当前视听场不属于此准确集版本')
            positions = children
        else:
            positions = [row]
        for selected in list(positions):
            if selected['kind'] == 'AV_SCENE':
                positions.extend(p.ref_record(store, ref) for ref in selected['payload']['shots'])
        for selected in positions:
            sources.extend(selected['payload'].get('sources', []))
        title = positions[0]['payload']['title'] if scene_id else row['payload']['title']
    else:
        raise ValueError('当前工作须为准确故事场或视听设计')
    return dict(reference=dict(object_id=object_id, revision_id=revision_id,
                               **({'scene_id': scene_id} if scene_id else {})),
                title=title, positions=[dict(object_id=r['object_id'], revision_id=r['id']) for r in positions],
                sources=[dict(object_id=s['object_id'], revision_id=s['revision_id'],
                              **({'scene_id': s['scene_id']} if s.get('scene_id') else {})) for s in sources])
