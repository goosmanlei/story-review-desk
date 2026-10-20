"""Immutable, append-only material associations and exact timeline comments.

Association versions describe an existing film; they never claim the renderer
used materials registered later. The saved project and media remain untouched.
"""
import copy
import json
from fractions import Fraction

from .store import Conflict, canonical, digest
from . import editing as edit

KIND = 'EDIT_ASSOCIATION'
FORMAT = 'edit-association-v1'


def checksum(value):
    return digest(canonical(value).encode())


def ref(row):
    return {'object_id': row['object_id'], 'revision_id': row['id']}


def element_key(item):
    return (item['track_key'], item['element_type'], item['element_id'])


def elements(project):
    """Type-qualified identities avoid collisions with subtitle/title group IDs."""
    tracks = [{'key': 'track:'+t['id'], 'title': t.get('title') or t['id']} for t in project['tracks']]
    result = []
    for clip in project['clips']:
        unit = edit.fps(project) if clip['kind'] == 'video' else project['spec']['sample_rate']
        start = Fraction(clip['timeline_start'], 1) / unit * edit.fps(project)
        end = Fraction(clip['timeline_start']+edit.duration(clip, project), 1) / unit * edit.fps(project)
        result.append({'track_key': 'track:'+clip['track_id'], 'element_type': 'clip',
                       'element_id': clip['id'], 'title': clip.get('title') or clip['id'],
                       'start_frame': float(start), 'end_frame': float(end),
                       'element_digest': checksum(clip), 'source_id': clip['source_id']})
    for group, kind in (('subtitles', 'subtitle'), ('titles', 'title')):
        for item in project.get(group, []):
            key = 'text:subtitles' if kind == 'subtitle' else 'text:nameplates' if item.get('style') == 'nameplate' else 'text:titles'
            if not any(t['key'] == key for t in tracks):
                tracks.append({'key': key, 'title': {'text:subtitles':'字幕', 'text:nameplates':'人名条', 'text:titles':'片头与片尾'}[key]})
            result.append({'track_key': key, 'element_type': kind, 'element_id': item['id'],
                           'title': item['text'], 'start_frame': item['start_frame'], 'end_frame': item['end_frame'],
                           'element_digest': checksum(item)})
    return [t for t in tracks if any(e['track_key'] == t['key'] for e in result)], result


def material_origin(store, asset, candidate_id):
    from .production import record
    targets = [r[0] for r in store.db.execute('SELECT material_id FROM production_candidate_targets WHERE candidate_id=?', (candidate_id,))]
    scopes = []
    if len(targets) == 1:
        scopes.append(record(store, targets[0])['payload'].get('scope'))
    if not any(scopes):
        scopes = [c['state'] for c in asset['payload'].get('state_coverage', [])] or asset['payload'].get('subjects', [])
    scopes = list({s['object_id']:s for s in scopes if s}.values())
    if len(scopes) != 1:
        raise ValueError('原素材制作出处缺失或不唯一：'+asset['object_id'])
    for scope in scopes:
        if not scope:
            continue
        origin = record(store, scope['object_id'], scope['revision_id'])
        if origin['kind'] in ('ENTITY', 'STATE', 'AV_SHOT') and not origin.get('unavailable'):
            return {**ref(origin), 'kind': origin['kind']}, targets[0] if len(targets) == 1 else asset['object_id']
    raise ValueError('原素材缺少唯一实体、状态或镜头出处：'+asset['object_id'])


def binding(store, source, entry_id=None):
    from .production import record
    asset = record(store, source['asset']['object_id'], source['asset']['revision_id'])
    cid = source['candidate_id']
    candidate = store.db.execute('SELECT * FROM production_candidates WHERE id=?', (cid,)).fetchone()
    if not candidate or candidate['asset_object_id'] != asset['object_id']:
        raise ValueError('素材候选身份不匹配')
    component = next((c for c in asset['payload']['components'] if c['id'] == source['component']['id']), None)
    if component != source['component']:
        raise Conflict('准确素材原件不匹配')
    origin, mid = material_origin(store, asset, cid)
    value = {'asset': ref(asset), 'candidate_id': cid, 'component': copy.deepcopy(component),
             'origin': origin, 'material_id': mid}
    if entry_id is not None:
        value['entry_id'] = entry_id
    # Keep actual, immutable submission evidence, not a mutable requirement rid.
    submission = store.db.execute('SELECT snapshot,snapshot_sha256 FROM production_submissions WHERE operation_id=?', (candidate['operation_id'],)).fetchone()
    if submission:
        value['submission_sha256'] = submission['snapshot_sha256']
    return value


def verify_binding(store, value, *, live=False):
    from .production import record
    candidate = store.db.execute('SELECT * FROM production_candidates WHERE id=?', (value['candidate_id'],)).fetchone()
    if not candidate or candidate['asset_object_id'] != value['asset']['object_id']:
        raise ValueError('关联的准确候选不存在或串绑')
    asset = record(store, **value['asset'])
    component = next((c for c in asset['payload'].get('components', []) if c['id'] == value['component']['id']), None)
    if component != value['component']:
        raise Conflict('关联原件与候选不一致')
    from .production_current import submission
    saved = submission(store, candidate['operation_id'])
    if saved['snapshot_sha256'] != value.get('submission_sha256'):
        raise Conflict('关联的制作提交依据不一致')
    needs = saved['snapshot'].get('requirements', [])
    if needs:
        origins = [(n['object_id'],n['payload'].get('scope')) for n in needs]
        if (value['material_id'],{k:value['origin'][k] for k in ('object_id','revision_id')}) not in origins:
            raise Conflict('关联出处与不可变制作提交不一致')
    if value['origin']['kind'] not in ('ENTITY', 'STATE', 'AV_SHOT'):
        raise ValueError('非法制作出处')
    owner=record(store,value['origin']['object_id'],value['origin']['revision_id'])
    if owner['kind']!=value['origin']['kind']:
        raise Conflict('制作出处类型与准确对象不一致')
    if value.get('entry_id'):
        doc=text_layer_document(store,asset,component)
        if doc['origin']!=value['origin'] or value['material_id']!=asset['object_id'] or not any(e['entry_id']==value['entry_id'] for e in doc['entries']):
            raise Conflict('字层出处、素材或条目与原件不一致')
    if live:
        origin, mid = material_origin(store, asset, value['candidate_id'])
        if (origin['object_id'], origin['kind'], mid) != (value['origin']['object_id'], value['origin']['kind'], value['material_id']):
            raise Conflict('原素材制作归属已变化；保留原身份，未打开其他对象')
    return asset


def text_layer_document(store, asset, component):
    """Read the actual content-addressed text original, including its lineage."""
    from .production_media import asset_path, validate_component, _file_identity
    root = getattr(store, '_production_root', None) or store.db_path.parent.parent
    path = asset_path(root, component['file'])
    physical = _file_identity(path)
    scope = getattr(store, '_production_reads', None)
    cache = scope.setdefault('text_layer_documents', {}) if scope is not None else None
    key = (asset['object_id'], asset['id'], canonical(component), physical)
    if cache is not None and key in cache:
        return cache[key]
    validate_component(root, component, inspect=False)
    if path.stat().st_size > 8*1024*1024:
        raise ValueError('字层工程原件过大')
    value = json.loads(path.read_text(encoding='utf-8'))
    recorded=asset['payload'].get('text_layers',{}).get(component['id'],asset['payload'].get('text_layer') if component['id']=='original' else None)
    if value != recorded or value.get('format') != 'episode-text-layer-v1':
        raise Conflict('字层正文与真实工程原件不匹配')
    output = edit.read(store, value['output']['object_id'], value['output']['revision_id'])
    project_check = _text_project(store, output)
    if value.get('snapshot') != output['payload']['snapshot'] or value.get('project_digest') != project_check['digest']:
        raise Conflict('字层派生谱系与冻结工程不一致')
    if value.get('spec')!=output['payload']['project']['spec']:
        raise Conflict('字层帧率或规格与冻结工程不一致')
    source = next(c for c in output['payload']['components'] if c['id'] == 'project')
    if value.get('source_component') != source:
        raise Conflict('字层派生原件不一致')
    from .production import record
    expected, source_origins, missing_sources, pictures = (project_check[k] for k in ('expected','origins','missing','pictures'))
    ids = set()
    for entry in value['entries']:
        if entry['entry_id'] in ids or element_key(entry) not in expected:
            raise ValueError('字层条目身份重复或不存在')
        ids.add(entry['entry_id'])
        if any(entry.get(k) != v for k,v in expected[element_key(entry)].items()):
            raise Conflict('字层原件条目与原工程不一致')
        intersecting=[e for e in pictures if e['start_frame']<entry['end_frame'] and e['end_frame']>entry['start_frame']]
        missing=[missing_sources[e['source_id']] for e in intersecting if e['source_id'] in missing_sources]
        if missing:
            raise ValueError('字层使用镜头的准确来源不可用：'+', '.join(dict.fromkeys(missing)))
        if all(e['source_id'] in source_origins for e in intersecting):
            uses={canonical(source_origins[e['source_id']]) for e in intersecting}
            if len(entry.get('uses',[]))!=len(uses) or {canonical(u) for u in entry['uses']}!=uses:
                raise Conflict('字层使用镜头与冻结工程不一致')
        for identity in entry.get('identity_sources',[]):
            if record(store,**identity)['kind']!='ENTITY':
                raise Conflict('人名条身份来源不是真实人物实体')
    if _file_identity(path) != physical:
        raise Conflict('字层原件在读取时发生变化，请重试')
    if cache is not None:
        cache[key] = value
    return value


def _text_project(store, output):
    """Validate lineage once per exact output in this read transaction."""
    scope = getattr(store, '_production_reads', None)
    cache = scope.setdefault('text_layer_projects', {}) if scope is not None else None
    key = (output['object_id'], output['id'])
    if cache is not None and key in cache:
        return cache[key]
    from .production import record
    from .production_current import submission
    project = output['payload']['project']
    items = elements(project)[1]
    source_origins, missing_sources = {}, {}
    for source in project['sources']:
        candidate = store.db.execute('SELECT operation_id,asset_object_id FROM production_candidates WHERE id=?', (source['candidate_id'],)).fetchone()
        if not candidate or candidate[1] != source['asset']['object_id']:
            missing_sources[source['id']] = source['asset']['object_id']
            continue
        saved = submission(store, candidate[0])['snapshot']
        scopes = {canonical(n['payload']['scope']):n['payload']['scope'] for n in saved.get('requirements', []) if n['payload'].get('scope')}
        if len(scopes) == 1:
            origin = next(iter(scopes.values()))
            source_origins[source['id']] = {**origin, 'kind':record(store, **origin)['kind']}
    video_tracks = {'track:'+t['id'] for t in project['tracks'] if t['kind']=='video'}
    result = {'digest':checksum(project), 'expected':{element_key(e):e for e in items if e['element_type']!='clip'},
              'origins':source_origins, 'missing':missing_sources, 'pictures':[e for e in items if e['track_key'] in video_tracks]}
    if cache is not None:
        cache[key] = result
    return result


def association_dependencies(payload):
    refs = [{'revision_id': payload['output']['revision_id'], 'role': 'edit.output'}]
    if payload.get('previous'):
        refs.append({'revision_id': payload['previous']['revision_id'], 'role': 'edit.previous-association'})
    for i, item in enumerate(payload['elements']):
        refs.append({'revision_id': item['binding']['asset']['revision_id'], 'role': 'edit.material.'+str(i)})
    return refs


def validate_association(store, oid, payload, *, live=False):
    output = edit.read(store, payload['output']['object_id'], payload['output']['revision_id'])
    if output['kind'] != 'EPISODE_FILM' or payload.get('format') != FORMAT:
        raise ValueError('关联必须固定准确成片')
    edit.integer(payload['version'], 'association version', 1)
    body = {k:v for k,v in payload.items() if k != 'digest'}
    if checksum(body) != payload['digest'] or oid != 'edit-association-'+payload['digest']:
        raise Conflict('追加关联摘要不一致')
    previous = payload.get('previous')
    if previous:
        prior = edit.read(store, previous['object_id'], previous['revision_id'])
        if prior['kind'] != KIND or prior['payload']['output'] != payload['output'] or prior['payload']['version']+1 != payload['version']:
            raise Conflict('追加关联版本不连续')
    elif payload['version'] != 1:
        raise ValueError('首次关联版本须为1')
    _, expected = elements(output['payload']['project'])
    mapping = {element_key(e):e for e in payload['elements']}
    if len(mapping) != len(payload['elements']) or set(mapping) != {element_key(e) for e in expected}:
        raise ValueError('关联须完整覆盖准确工程所有元素且不得重复')
    for item in expected:
        supplied = mapping[element_key(item)]
        if any(supplied.get(k) != v for k,v in item.items()):
            raise Conflict('关联元素身份、内容或时间与冻结工程不匹配')
        bound = supplied['binding']
        asset = verify_binding(store, bound, live=live)
        if item['element_type'] == 'clip':
            source = next(s for s in output['payload']['project']['sources'] if s['id'] == item['source_id'])
            if any(bound[k] != source[k] for k in ('asset', 'candidate_id', 'component')):
                raise Conflict('片段素材与冻结来源不一致')
        else:
            layer = text_layer_document(store, asset, bound['component'])
            entry = next((e for e in layer.get('entries', []) if e['entry_id'] == bound.get('entry_id')), None)
            if not entry or any(entry[k] != item[k] for k in ('element_type','element_id','title','start_frame','end_frame','element_digest')):
                raise Conflict('字层条目与成片文字、时间不一致')
            if layer.get('output') != payload['output'] or layer.get('origin') != bound['origin']:
                raise Conflict('字层制作出处或派生工程不一致')
            if live:
                from .production import record
                for identity in entry.get('identity_sources',[]):
                    if record(store,**identity)['payload']['title']!=entry['title'].split('\n')[0]:
                        raise Conflict('人名条姓名与登记时人物身份不一致')
    return payload


def associations(store, output):
    rows = [r for r in edit.records(store, KIND) if r['payload']['output'] == ref(output)]
    return sorted(rows, key=lambda r:r['payload']['version'])


def validate_chains(store):
    groups={}
    for row in edit.records(store,KIND):
        output=row['payload']['output']
        groups.setdefault((output['object_id'],output['revision_id']),[]).append(row)
    for rows in groups.values():
        previous=None
        for version,row in enumerate(sorted(rows,key=lambda r:r['payload']['version']),1):
            if row['payload']['version']!=version or row['payload'].get('previous')!=previous:
                raise Conflict('素材关联版本存在缺口、分叉或重复')
            previous=ref(row)


def append_association(store, payload):
    oid = 'edit-association-'+payload['digest']
    existing = store.db.execute('SELECT id FROM objects WHERE id=?', (oid,)).fetchone()
    if existing:
        saved = edit.read(store, oid)
        if saved['payload'] != payload:
            raise Conflict('关联身份已占用')
        return saved
    validate_association(store, oid, payload, live=True)
    output = edit.read(store, payload['output']['object_id'], payload['output']['revision_id'])
    previous = associations(store, output)
    if payload.get('previous') != (ref(previous[-1]) if previous else None):
        raise Conflict('关联已前进，请按最新关联追加')
    store.put_object(oid, KIND, payload, 0, association_dependencies(payload))
    return edit.read(store, oid)


def guard_append(store, oid, payload):
    """Called inside the write transaction; concurrent appends cannot fork."""
    validate_association(store, oid, payload, live=True)
    output = edit.read(store, payload['output']['object_id'], payload['output']['revision_id'])
    versions = associations(store, output)
    if payload.get('previous') != (ref(versions[-1]) if versions else None):
        raise Conflict('关联已前进，请按最新关联追加')


def review(store, output_id, revision_id, association=None):
    from .production import check_read
    output = edit.read(store, output_id, revision_id)
    if output['kind'] != 'EPISODE_FILM':
        raise ValueError('仅可审阅准确成片')
    versions = associations(store, output)
    selected = edit.read(store, association['object_id'], association['revision_id']) if association else (versions[-1] if versions else None)
    if selected and (selected['kind'] != KIND or selected['payload']['output'] != ref(output)):
        raise Conflict('素材关联不属于此成片版本')
    tracks, items = elements(output['payload']['project'])
    if selected:
        items = copy.deepcopy(selected['payload']['elements'])
    else:
        sources = {s['id']:s for s in output['payload']['project']['sources']}
        for item in items:
            check_read(store)
            try:
                if item['element_type'] != 'clip':
                    group='subtitles' if item['element_type']=='subtitle' else 'titles'
                    original=next(e for e in output['payload']['project'][group] if e['id']==item['element_id'])
                    if not original.get('material_ref'):
                        raise ValueError('此历史字层尚未登记准确素材：'+item['element_id'])
                    item['binding']=copy.deepcopy(original['material_ref'])
                else:
                    item['binding'] = binding(store, sources[item['source_id']])
            except (ValueError, KeyError, Conflict, OSError) as error:
                item['unavailable'] = str(error)
    for item in items:
        check_read(store)
        if item.get('binding'):
            try:
                verify_binding(store, item['binding'], live=True)
            except (ValueError, KeyError, Conflict, OSError) as error:
                item['unavailable'] = str(error)
    return {'output':ref(output), 'snapshot':output['payload']['snapshot'],
            'association':({**ref(selected), 'version':selected['payload']['version'], 'digest':selected['payload']['digest']} if selected else None),
            'tracks':tracks, 'elements':items}


def selection_elements(items, tracks, start, end):
    return [{k:e[k] for k in ('track_key','element_type','element_id','element_digest','binding') if k in e}
            for e in items if e['track_key'] in tracks and e['start_frame'] < end and e['end_frame'] > start]


def validate_new_anchor(store, output_id, revision_id, anchor):
    chosen=anchor.get('edit_selection')
    if not chosen:return
    output=edit.read(store,output_id,revision_id)
    versions=associations(store,output)
    latest=versions[-1] if versions else None
    expected={**ref(latest),'version':latest['payload']['version'],'digest':latest['payload']['digest']} if latest else None
    if chosen.get('association')!=expected:
        raise Conflict('素材关联已更新；草稿仍保留，请核对准确版本后再提交')
    for element in chosen['elements']:
        if element.get('binding'):verify_binding(store,element['binding'],live=True)


def validate_anchor(store, output_id, revision_id, payload, anchor):
    chosen = anchor.get('edit_selection')
    if chosen is None:
        return  # Legacy mixed-output time range: never invent track selection.
    if payload.get('format') != 'episode-film-v1' or anchor.get('type') != 'time':
        raise ValueError('轨道选段只能绑定准确成片时间评论')
    project = payload['project']
    a = edit.integer(chosen['start_frame'], 'selection start', 0, project['spec']['duration_frames']-1)
    b = edit.integer(chosen['end_frame'], 'selection end', a+1, project['spec']['duration_frames'])
    if chosen.get('snapshot') != payload['snapshot']:
        raise Conflict('选段快照与成片不匹配')
    rate = float(edit.fps(project))
    if abs(anchor['start_seconds']-a/rate)>1e-8 or abs(anchor['end_seconds']-b/rate)>1e-8:
        raise Conflict('帧范围与时间范围不一致')
    tracks, items = elements(project)
    if chosen.get('association'):
        associated = chosen['association']
        record = edit.read(store, associated['object_id'], associated['revision_id'])
        if record['kind'] != KIND or record['payload']['output'] != {'object_id':output_id,'revision_id':revision_id} or any(associated.get(k) != record['payload'][k] for k in ('digest','version')):
            raise Conflict('选段素材关联版本不匹配')
        items = record['payload']['elements']
    else:
        # With no persisted association the exact frozen sources still anchor
        # legacy audio/video, but cannot invent historical text material refs.
        sources={s['id']:s for s in project['sources']}
        supplied={element_key(e):e for e in chosen['elements']}
        for item in items:
            if item['element_type']=='clip' and element_key(item) in supplied:
                value=supplied[element_key(item)].get('binding')
                if value:
                    source=sources[item['source_id']]
                    if any(value[k]!=source[k] for k in ('asset','candidate_id','component')):
                        raise Conflict('旧选段准确素材与冻结来源不一致')
                    verify_binding(store,value)
                    item['binding']=value
            else:
                if item['element_type']!='clip':
                    group='subtitles' if item['element_type']=='subtitle' else 'titles'
                    original=next(e for e in project[group] if e['id']==item['element_id'])
                    if original.get('material_ref'):item['binding']=original['material_ref']
    keys = chosen['tracks']
    expected_keys = [t['key'] for t in tracks if t['key'] in keys]
    if not isinstance(keys, list) or not keys or keys != expected_keys:
        raise ValueError('选段轨道不存在、重复或顺序不一致')
    expected = selection_elements(items, keys, a, b)
    if not expected or chosen['elements'] != expected:
        raise Conflict('选段相交元素或素材身份不一致')
    if chosen.get('track_titles') != [t['title'] for t in tracks if t['key'] in keys]:
        raise Conflict('选段轨道名称不匹配')
