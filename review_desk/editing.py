"""Episode editing contracts shared by HTTP, CLI, worker and recovery.

Business records live in the normal object ledger. Queue/lease/progress data
live in a separate runtime database and are never part of a public export.
"""
import copy
import json
import math
import re
import subprocess
from fractions import Fraction
from pathlib import Path

from .store import Conflict, canonical, digest, now
from .production_media import asset_path, physical_file_hash, validate_component

KINDS = {'EPISODE_EDIT', 'EDIT_SNAPSHOT', 'EPISODE_FILM', 'EDIT_ASSOCIATION'}
FORMATS = {'EPISODE_EDIT': 'episode-edit-v1', 'EDIT_SNAPSHOT': 'edit-snapshot-v1',
           'EPISODE_FILM': 'episode-film-v1', 'EDIT_ASSOCIATION': 'edit-association-v1'}
ENGINE = 'episode-render-v1'
ID = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,159}$')


def integer(value, label, minimum=0, maximum=1000000000):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(label + ' must be an integer in range')
    return value


def number(value, label, low, high):
    if type(value) not in (int, float) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError(label + ' is out of range')
    return value


def identifier(value):
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise ValueError('invalid editing identifier')
    return value


def read(store, oid, revision=None):
    row = store.db.execute('SELECT r.*,o.kind FROM revisions r JOIN objects o ON o.id=r.object_id '
                           'WHERE r.object_id=? AND r.id=COALESCE(?,o.current_revision)', (oid, revision)).fetchone()
    if not row or row['kind'] not in KINDS:
        raise ValueError('editing record or exact revision not found')
    result = dict(row)
    result['payload'] = json.loads(result['payload'])
    return result


def records(store, kind):
    return [read(store, r[0]) for r in store.db.execute('SELECT id FROM objects WHERE kind=? ORDER BY created_at,id', (kind,))]


def fps(project):
    value = project['spec']['fps']
    return Fraction(value['num'], value['den'])


def rounded(value):
    return math.floor(value+Fraction(1,2))


def duration(clip, project):
    source = next(s for s in project['sources'] if s['id'] == clip['source_id'])
    if clip['kind'] == 'video':
        rate = Fraction(source['video']['fps'])
        return rounded(Fraction(clip['source_out']-clip['source_in'], 1) / rate * fps(project))
    return rounded(Fraction(clip['source_out']-clip['source_in'], source['audio']['sample_rate']) * project['spec']['sample_rate'])


def probe_source(path):
    proc = subprocess.run(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(path)],
                          capture_output=True, timeout=60, check=True)
    info = json.loads(proc.stdout)
    value = {}
    for kind in ('video', 'audio'):
        s = next((s for s in info['streams'] if s['codec_type'] == kind), None)
        if s is None:
            continue
        seconds = Fraction(s.get('duration') or info['format']['duration'])
        item = {'stream_index': s['index'], 'codec': s['codec_name'], 'time_base': s['time_base'],
                'start_time': s.get('start_time', '0'), 'duration': str(seconds)}
        if kind == 'video':
            rate = Fraction(s['r_frame_rate'])
            item.update(fps=str(rate), frames=int(s.get('nb_frames') or math.floor(seconds*rate)),
                        width=s['width'], height=s['height'], avg_frame_rate=s['avg_frame_rate'])
        else:
            item.update(sample_rate=int(s['sample_rate']), channels=s['channels'],
                        samples=math.floor(seconds*int(s['sample_rate'])))
        value[kind] = item
    return value


def verify_source(store, root, source, inspect=False, check_files=True):
    from .production import record
    identifier(source['id'])
    asset = record(store, source['asset']['object_id'], source['asset']['revision_id'])
    candidate = store.db.execute('SELECT asset_object_id FROM production_candidates WHERE id=?', (source['candidate_id'],)).fetchone()
    if asset['kind'] != 'ASSET' or not candidate or candidate[0] != asset['object_id']:
        raise ValueError('source must identify an exact original candidate')
    component = next((c for c in asset['payload']['components'] if c['id'] == source['component']['id']), None)
    if component != source['component']:
        raise Conflict('source component changed or differs from candidate')
    if not check_files:return
    verify_source_media(root,source,inspect)


def verify_source_media(root,source,inspect=True):
    component=source['component']
    validate_component(root, component, inspect=False)
    path = asset_path(root, component['file'])
    if not path.is_file() or path.stat().st_size != component['bytes'] or physical_file_hash(path) != component['sha256']:
        raise ValueError('source original missing or checksum changed: '+source['id'])
    if inspect and probe_source(path) != {k: source[k] for k in ('video', 'audio') if k in source}:
        raise ValueError('source stream specification differs: '+source['id'])


def verify_payload_media(root,kind,payload):
    if kind=='EDIT_ASSOCIATION':
        for item in payload['elements']:
            validate_component(root,item['binding']['component'],inspect=False)
        return
    project=payload if kind=='EPISODE_EDIT' else payload['project']
    for source in project['sources']:verify_source_media(root,source)
    if kind=='EPISODE_FILM':validate_deliverables(root,project,payload['components'],True)


def validate_project(store, root, p, inspect=False, check_files=True):
    if not isinstance(p, dict) or p.get('format') != FORMATS['EPISODE_EDIT']:
        raise ValueError('unsupported editable episode format')
    if not isinstance(p.get('title'), str) or not 1 <= len(p['title']) <= 200:
        raise ValueError('episode title is required')
    from .production import record
    ep = record(store, p['episode']['object_id'], p['episode']['revision_id'])
    if ep['kind'] != 'AV_EPISODE':
        raise ValueError('editing project must refer to an episode')
    if p.get('method_execution'):
        from . import methods
        method=methods.read(store,**p['method_execution'])
        if (method['payload'].get('format')!=methods.FORMATS['execution']
                or method['payload'].get('work_type')!='episode-editing'
                or method['payload'].get('target')!=p['episode']['object_id']):
            raise ValueError('editing method must identify this episode execution')
    spec = p['spec']
    integer(spec['width'], 'width', 16, 3840); integer(spec['height'], 'height', 16, 2160)
    if spec['width'] % 2 or spec['height'] % 2:
        raise ValueError('H.264 dimensions must be even')
    integer(spec['fps']['num'], 'fps numerator', 1, 120000)
    integer(spec['fps']['den'], 'fps denominator', 1, 10000)
    if not 1 <= fps(p) <= 60 or spec['sample_rate'] != 48000:
        raise ValueError('unsupported project timing')
    integer(spec['duration_frames'], 'duration', 1, int(fps(p)*3600))
    sources = p['sources']; clips = p['clips']; tracks = p['tracks']
    if not isinstance(sources, list) or len(sources) > 500 or not isinstance(clips, list) or len(clips) > 2000:
        raise ValueError('invalid source or clip collection')
    if not isinstance(tracks, list) or not 1 <= len(tracks) <= 32:
        raise ValueError('invalid tracks')
    source_map = {identifier(s['id']): s for s in sources}
    track_map = {identifier(t['id']): t for t in tracks}
    if len(source_map) != len(sources) or len(track_map) != len(tracks):
        raise ValueError('duplicate source or track')
    for track in tracks:
        if track['kind'] not in ('video', 'audio'):
            raise ValueError('unknown track kind')
    for source in sources:
        verify_source(store, root, source, inspect, check_files)
    ids = set(); intervals = []
    for clip in clips:
        if identifier(clip['id']) in ids:
            raise ValueError('duplicate clip id')
        ids.add(clip['id'])
        source = source_map.get(clip['source_id']); track = track_map.get(clip['track_id']); kind = clip['kind']
        if not source or not track or kind not in ('video','audio') or track['kind'] != kind or kind not in source:
            raise ValueError('clip source or track does not provide its stream')
        total = source[kind]['frames' if kind == 'video' else 'samples']
        integer(clip['source_in'], 'source in', 0, total-1)
        integer(clip['source_out'], 'source out', clip['source_in']+1, total)
        integer(clip['timeline_start'], 'timeline start')
        length = duration(clip, p)
        if length < 1:
            raise ValueError('clip rounds to zero duration')
        limit = spec['duration_frames'] if kind == 'video' else rounded(Fraction(spec['duration_frames'],1)/fps(p)*spec['sample_rate'])
        if clip['timeline_start']+length > limit:
            raise ValueError('clip exceeds project duration')
        for key in ('fade_in','fade_out'):
            integer(clip.get(key,0), key, 0, length)
        if clip.get('fade_in',0)+clip.get('fade_out',0)>length:
            raise ValueError('clip fades overlap')
        if kind == 'video':
            crop=clip.get('crop')
            if crop is not None:
                integer(crop['x'],'crop x',0,source['video']['width']-2)
                integer(crop['y'],'crop y',0,source['video']['height']-2)
                integer(crop['width'],'crop width',2,source['video']['width']-crop['x'])
                integer(crop['height'],'crop height',2,source['video']['height']-crop['y'])
                if any(crop[k]%2 for k in ('x','y','width','height')):raise ValueError('crop must align to chroma pixels')
            masks=clip.get('source_caption_masks',[])
            if not isinstance(masks,list) or len(masks)>8:raise ValueError('invalid caption masks')
            for mask in masks:
                integer(mask['x'],'caption x',1,source['video']['width']-3)
                integer(mask['y'],'caption y',1,source['video']['height']-3)
                integer(mask['width'],'caption width',1,source['video']['width']-mask['x']-2)
                integer(mask['height'],'caption height',1,source['video']['height']-mask['y']-2)
                integer(mask['start_frame'],'caption start',0,total-1)
                integer(mask['end_frame'],'caption end',mask['start_frame']+1,total)
            for key, default, low, high in (('brightness',0,-0.3,0.3),('contrast',1,0.5,1.5),('saturation',1,0,2)):
                number(clip.get(key, default), key, low, high)
            intervals.append((clip['timeline_start'],clip['timeline_start']+length,clip))
        else:
            number(clip.get('gain_db',0),'gain',-60,12)
    # The first edition supports one picture lane, with explicit dissolve overlap.
    intervals.sort(key=lambda x:(x[0],x[1]))
    end=0
    for start,stop,clip in intervals:
        overlap=integer(clip.get('dissolve_in',0),'dissolve',0,min(stop-start,120))
        if start != end-overlap or overlap and (start<0 or overlap>=stop-start):
            raise ValueError('picture lane has an unexplained gap or overlap')
        end=stop
    if end != spec['duration_frames']:
        raise ValueError('picture must cover the complete episode; no placeholder gaps')
    for group in ('subtitles','titles'):
        entries=p.get(group,[])
        if not isinstance(entries,list) or len(entries)>5000:
            raise ValueError('invalid text entries')
        text_ids=set()
        for item in entries:
            if identifier(item['id']) in text_ids: raise ValueError('duplicate text entry')
            text_ids.add(item['id'])
            integer(item['start_frame'], 'text start',0,spec['duration_frames']-1)
            integer(item['end_frame'],'text end',item['start_frame']+1,spec['duration_frames'])
            if not isinstance(item['text'],str) or not item['text'].strip() or len(item['text'])>600:
                raise ValueError('invalid text')
            if 'style' in item and (group!='titles' or item['style'] not in ('title','credit','nameplate')):
                raise ValueError('invalid title style')
            if item.get('style')=='nameplate':
                lines=item['text'].split('\n')
                if not 1<=len(lines)<=2 or any(not line.strip() for line in lines) or len(lines[0])>12 or (len(lines)==2 and len(lines[1])>24):
                    raise ValueError('nameplate needs a name up to 12 characters and an optional detail up to 24 characters')
                if item.get('position','lower-left') not in ('lower-left','lower-right','upper-left','upper-right'):
                    raise ValueError('invalid nameplate position')
            elif 'position' in item:
                raise ValueError('only nameplates have a position')
            if item.get('material_ref'):
                from .editing_review import verify_binding, text_layer_document
                bound=item['material_ref']
                asset=verify_binding(store,bound)
                doc=text_layer_document(store,asset,bound['component'])
                entry=next((e for e in doc['entries'] if e['entry_id']==bound.get('entry_id')),None)
                if not entry or entry['title']!=item['text'] or entry['element_type']!=('subtitle' if group=='subtitles' else 'title'):
                    raise Conflict('字层引用不是此文字的真实素材条目')
    for mark in p.get('markers',[]):
        identifier(mark['id']);integer(mark['frame'],'scene marker',0,spec['duration_frames']-1)
    return p


def dependencies(project):
    refs=[{'revision_id':project['episode']['revision_id'],'role':'edit.episode'}]
    refs.extend({'revision_id':s['asset']['revision_id'],'role':'edit.source.'+s['id']} for s in project['sources'])
    for group in ('subtitles','titles'):
        refs.extend({'revision_id':e['material_ref']['asset']['revision_id'],'role':'edit.text.'+group+'.'+e['id']} for e in project.get(group,[]) if e.get('material_ref'))
    if project.get('method_execution'):
        refs.append({'revision_id':project['method_execution']['revision_id'],'role':'edit.method'})
    return refs


def source_map(project):
    return {'format':'episode-source-map-v1','spec':project['spec'],'sources':project['sources'],
            'clips':project['clips'],'markers':project.get('markers',[])}


def subtitles_srt(project):
    def stamp(frame):
        ms=rounded(Fraction(frame,1)/fps(project)*1000)
        return f'{ms//3600000:02}:{ms//60000%60:02}:{ms//1000%60:02},{ms%1000:03}'
    return '\n\n'.join(f"{i+1}\n{stamp(t['start_frame'])} --> {stamp(t['end_frame'])}\n{t['text']}"
                       for i,t in enumerate(project.get('subtitles',[])))+'\n'


def validate_deliverables(root,project,components,inspect):
    """A valid checksum alone cannot make an arbitrary asset a film deliverable."""
    expected={'subtitled':'.mp4','clean':'.mp4','mix':'.wav','project':'.json','subtitles':'.srt','source-map':'.json'}
    spec=project['spec'];seconds=Fraction(spec['duration_frames'],1)/fps(project)
    for c in components:
        path=validate_component(root,c,inspect=inspect)
        if path.suffix!=expected[c['id']]:raise ValueError('incorrect deliverable type: '+c['id'])
        if c['id'] in ('project','source-map','subtitles'):
            if path.stat().st_size>8*1024*1024:raise ValueError('editing text deliverable is too large')
            text=path.read_text(encoding='utf-8')
            if c['id']=='subtitles':same=text==subtitles_srt(project)
            else:same=json.loads(text)==(project if c['id']=='project' else source_map(project))
            if not same:raise ValueError('deliverable differs from frozen project: '+c['id'])
        elif inspect:
            actual=probe_source(path);a=actual.get('audio',{})
            if a.get('sample_rate')!=48000 or a.get('channels')!=2:
                raise ValueError('film audio must be stereo 48 kHz')
            if abs(Fraction(a.get('start_time','0')))>Fraction(1,1000):raise ValueError('film audio must start at zero')
            if abs(Fraction(a['duration'])-seconds)>Fraction(1,20):raise ValueError('film audio duration differs')
            if c['id']=='mix':
                if a.get('codec')!='pcm_s24le' or 'video' in actual:raise ValueError('mix must be 24-bit PCM WAV')
                if abs(a['samples']-rounded(seconds*48000))>1:raise ValueError('mix sample count differs')
            else:
                v=actual.get('video',{})
                if a.get('codec')!='aac' or v.get('codec')!='h264':raise ValueError('film must be H.264/AAC')
                if abs(Fraction(v.get('start_time','0')))>Fraction(1,1000):raise ValueError('film picture must start at zero')
                if (v.get('width'),v.get('height'))!=(spec['width'],spec['height']) or Fraction(v.get('fps','0'))!=fps(project):
                    raise ValueError('film dimensions or frame rate differ')
                if v.get('frames')!=spec['duration_frames'] or abs(Fraction(v['duration'])-seconds)>Fraction(1,1000):
                    raise ValueError('film frame count or duration differs')


def validate_record(store, oid, kind, payload, inspect=False, check_files=True):
    root=getattr(store,'_production_root',None) or store.db_path.parent.parent
    if payload.get('format') != FORMATS[kind]: raise ValueError('editing format differs from kind')
    if kind=='EDIT_ASSOCIATION':
        from .editing_review import validate_association
        validate_association(store,oid,payload)
    elif kind=='EPISODE_EDIT':
        validate_project(store,root,payload,inspect,check_files)
        if oid!='edit-'+payload['episode']['object_id']: raise ValueError('one project per episode is required')
    elif kind=='EDIT_SNAPSHOT':
        project=payload['project']
        if payload.get('engine')!=ENGINE:raise ValueError('unsupported snapshot render engine')
        validate_project(store,root,project,inspect,check_files)
        saved=read(store,payload['project_ref']['object_id'],payload['project_ref']['revision_id'])
        if saved['payload']!=project: raise ValueError('snapshot differs from its exact saved project')
        fingerprint=digest(canonical({'engine':ENGINE,'project_revision':saved['id'],'project':project}).encode())
        if payload['fingerprint']!=fingerprint or oid!='edit-snapshot-'+fingerprint:
            raise ValueError('snapshot fingerprint differs')
    else:
        snapshot=read(store,payload['snapshot']['object_id'],payload['snapshot']['revision_id'])
        if snapshot['kind']!='EDIT_SNAPSHOT' or oid!='episode-film-'+snapshot['payload']['fingerprint']:
            raise ValueError('film does not identify exact snapshot')
        if payload['project']!=snapshot['payload']['project'] or payload['engine']!=ENGINE:
            raise ValueError('film project differs from rendered snapshot')
        components=payload['components']
        if {c['id'] for c in components}!={'subtitled','clean','mix','project','subtitles','source-map'} or len(components)!=6:
            raise ValueError('incomplete episode deliverables')
        if check_files:
            validate_deliverables(root,payload['project'],components,inspect)


def save(store, root, p, expected_version):
    oid='edit-'+p['episode']['object_id']
    old=store.db.execute('SELECT current_revision,version FROM objects WHERE id=?',(oid,)).fetchone()
    if old and old['version']!=expected_version: raise Conflict('工程已被其他编辑更新；保留草稿并重新读取')
    if old and read(store,oid)['payload']==p:return read(store,oid)
    store.put_object(oid,'EPISODE_EDIT',p,expected_version,dependencies(p))
    return read(store,oid)


def submit(store, root, project_id, expected_version, task_id, request_id):
    identifier(task_id);identifier(request_id)
    project=read(store,project_id)
    if project['version']!=expected_version: raise Conflict('工程已变化，不能渲染旧草稿')
    validate_project(store,root,project['payload'],inspect=True)
    fingerprint=digest(canonical({'engine':ENGINE,'project_revision':project['id'],'project':project['payload']}).encode())
    oid='edit-snapshot-'+fingerprint
    payload={'format':FORMATS['EDIT_SNAPSHOT'],'title':project['payload']['title'],
             'project_ref':{'object_id':project_id,'revision_id':project['id']},'project':project['payload'],
             'engine':ENGINE,'fingerprint':fingerprint,'task_id':task_id,'request_id':request_id}
    # Expensive file validation precedes the runtime->business lock order.
    validate_record(store,oid,'EDIT_SNAPSHOT',payload,inspect=True)
    def prepare():
        with store.db:
            store.db.execute('BEGIN IMMEDIATE')
            head=store.db.execute('SELECT current_revision FROM objects WHERE id=?',(project_id,)).fetchone()
            if not head or head[0]!=project['id']:raise Conflict('工程已变化，不能渲染旧草稿')
            if not store.db.execute('SELECT 1 FROM objects WHERE id=?',(oid,)).fetchone():
                store._put_object(oid,'EDIT_SNAPSHOT',payload,0,[{'revision_id':project['id'],'role':'edit.project'}]+dependencies(project['payload']))
        return read(store,oid)
    from .editing_worker import enqueue
    return enqueue(store,root,{'payload':payload},task_id,request_id,prepare)


def catalog(store, root, episode_id=None, *, summary=False):
    from .production import record
    episodes=[record(store,r[0]) for r in store.db.execute("SELECT id FROM objects WHERE kind='AV_EPISODE'")]
    episodes.sort(key=lambda r:(r['payload'].get('number',999),r['object_id']))
    if summary:
        outputs = [dict(row) for row in store.db.execute('''SELECT r.id,r.object_id,r.version,r.created_at,
            o.kind,o.current_revision,json_extract(r.payload,'$.title') AS title,
            json_extract(r.payload,'$.project.episode') AS episode
            FROM objects o JOIN revisions r ON r.id=o.current_revision
            WHERE o.kind='EPISODE_FILM' ORDER BY r.created_at,r.object_id''')]
        for row in outputs:
            row['payload'] = {'title': row.pop('title'), 'project': {'episode': json.loads(row.pop('episode'))}}
            row['summary'] = True
        return {'episodes': [{'id': r['object_id'], 'revision_id': r['id'], 'title': r['payload']['title'],
                              'number': r['payload'].get('number')} for r in episodes],
                'outputs': [r for r in outputs if not episode_id or r['payload']['project']['episode']['object_id'] == episode_id]}
    projects=records(store,'EPISODE_EDIT');films=records(store,'EPISODE_FILM')
    jobs=[]
    if (Path(root)/'.runtime/edit-render.sqlite3').exists():
        from .editing_worker import queue,result
        db=queue(root)
        try:
            for row in db.execute('SELECT id,snapshot_id,snapshot_revision FROM jobs ORDER BY updated_at DESC LIMIT 50'):
                snap=read(store,row['snapshot_id'],row['snapshot_revision'])
                episode=snap['payload']['project']['episode']['object_id']
                if not episode_id or episode_id==episode:jobs.append({**result(store,root,row['id']),'episode_id':episode})
        finally:db.close()
    return {'episodes':[{'id':r['object_id'],'revision_id':r['id'],'title':r['payload']['title'],'number':r['payload'].get('number')} for r in episodes],
            'projects':[p for p in projects if not episode_id or p['payload']['episode']['object_id']==episode_id],
            'outputs':[f for f in films if not episode_id or f['payload']['project']['episode']['object_id']==episode_id],'jobs':jobs}


def expected_dependencies(kind,payload):
    if kind=='EDIT_ASSOCIATION':
        from .editing_review import association_dependencies
        return association_dependencies(payload)
    if kind=='EPISODE_EDIT':return dependencies(payload)
    if kind=='EDIT_SNAPSHOT':return [{'revision_id':payload['project_ref']['revision_id'],'role':'edit.project'}]+dependencies(payload['project'])
    return [{'revision_id':payload['snapshot']['revision_id'],'role':'edit.snapshot'}]
