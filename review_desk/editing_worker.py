"""Single-instance, restartable FFmpeg worker. No FFmpeg under a DB transaction."""
import ctypes
import fcntl
import json
import os
import shutil
import signal
import sqlite3
import subprocess
import sys
import time
from contextlib import contextmanager
from fractions import Fraction
from pathlib import Path

from .store import Store, Conflict, canonical, digest, now
from . import editing as edit
from .production_media import asset_path, physical_file_hash, ingest


def queue(root):
    directory=Path(root)/'.runtime';directory.mkdir(parents=True,exist_ok=True)
    db=sqlite3.connect(directory/'edit-render.sqlite3',timeout=5)
    db.row_factory=sqlite3.Row
    db.executescript('''
    CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,snapshot_id TEXT NOT NULL,snapshot_revision TEXT NOT NULL,
      status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,cancel INTEGER NOT NULL DEFAULT 0,
      progress REAL NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS requests(task_id TEXT,request_id TEXT,fingerprint TEXT,
      PRIMARY KEY(task_id,request_id));
    ''')
    return db


def result(store,root,job_id):
    edit.identifier(job_id)
    film_id='episode-film-'+job_id
    if store.db.execute('SELECT 1 FROM objects WHERE id=?',(film_id,)).fetchone():
        return {'id':job_id,'status':'succeeded','progress':1,'output':edit.read(store,film_id)}
    db=queue(root)
    try:
        row=db.execute('SELECT * FROM jobs WHERE id=?',(job_id,)).fetchone()
        if not row:raise ValueError('render request not found in this instance')
        return {k:row[k] for k in ('id','status','attempts','progress','error','updated_at')}
    finally:db.close()


def enqueue(store,root,snapshot,task_id,request_id,prepare=None):
    fingerprint=snapshot['payload']['fingerprint'];db=queue(root)
    try:
        with db:
            db.execute('BEGIN IMMEDIATE')
            old=db.execute('SELECT fingerprint FROM requests WHERE task_id=? AND request_id=?',(task_id,request_id)).fetchone()
            if old and old[0]!=fingerprint:raise Conflict('render request id already belongs to another snapshot')
            if prepare:snapshot=prepare()
            db.execute('INSERT OR IGNORE INTO requests VALUES (?,?,?)',(task_id,request_id,fingerprint))
            db.execute('INSERT OR IGNORE INTO jobs(id,snapshot_id,snapshot_revision,status,updated_at) VALUES (?,?,?,?,?)',
                       (fingerprint,snapshot['object_id'],snapshot['id'],'queued',now()))
    finally:db.close()
    return result(store,root,fingerprint)


def change_job(store,root,job_id,action):
    current=result(store,root,job_id)
    if current['status']=='succeeded':return current
    db=queue(root)
    try:
        with db:
            row=db.execute('SELECT * FROM jobs WHERE id=?',(job_id,)).fetchone()
            if action=='cancel':
                db.execute("UPDATE jobs SET cancel=1,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,updated_at=? WHERE id=?",(now(),job_id))
            elif action=='retry':
                if row['status'] not in ('failed','interrupted','cancelled') or row['attempts']>=3:
                    raise ValueError('only failed/cancelled/interrupted renders can retry, at most three attempts per snapshot')
                db.execute("UPDATE jobs SET status='queued',cancel=0,error='',progress=0,updated_at=? WHERE id=?",(now(),job_id))
            else:raise ValueError('unknown render action')
    finally:db.close()
    return result(store,root,job_id)


def child_setup(expected_parent):
    # Linux guarantees that a SIGKILLed worker does not leave its FFmpeg alive.
    # Normal termination additionally reaps the complete process group below.
    if sys.platform.startswith('linux'):
        if os.getppid()!=expected_parent:os._exit(125)
        ctypes.CDLL(None).prctl(1,signal.SIGTERM)
        if os.getppid()!=expected_parent:os._exit(125)


class Cancelled(Exception):pass


class Runner:
    def __init__(self,root,db,job_id,directory,stop):
        self.root=root;self.db=db;self.id=job_id;self.directory=directory;self.stop=stop;self.count=0

    def check(self):
        row=self.db.execute('SELECT cancel FROM jobs WHERE id=?',(self.id,)).fetchone()
        if self.stop[0] or not row or row[0]:raise Cancelled('render cancelled or worker stopped')

    def progress(self,value):
        with self.db:self.db.execute('UPDATE jobs SET progress=?,updated_at=? WHERE id=?',(value,now(),self.id))

    def run(self,args):
        self.check();self.count+=1
        log=self.directory/('command-%04d.log'%self.count)
        with log.open('wb') as output:
            parent=os.getpid()
            proc=subprocess.Popen(args,stdout=output,stderr=subprocess.STDOUT,cwd=self.directory,
                                  start_new_session=True,preexec_fn=lambda:child_setup(parent))
            identity=self.directory/'process.json'
            identity.write_text(canonical({'pid':proc.pid,'job':self.id,'command':args,'started_at':now()}))
            started=time.monotonic()
            try:
                while proc.poll() is None:
                    self.check()
                    if time.monotonic()-started>7200:raise RuntimeError('render command exceeded two-hour limit')
                    time.sleep(.2)
                if proc.returncode:
                    raise RuntimeError('FFmpeg failed: '+log.read_text(errors='replace')[-1600:])
            finally:
                if proc.poll() is None:
                    os.killpg(proc.pid,signal.SIGTERM)
                    try:proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(proc.pid,signal.SIGKILL);proc.wait()
                identity.unlink(missing_ok=True)
        return log

    def ffmpeg(self,*args):
        return self.run(['ffmpeg','-hide_banner','-nostdin','-y','-threads','2','-filter_threads','2','-filter_complex_threads','2',*map(str,args)])


def ass_time(frame,rate):
    # ASS has centisecond resolution. Floor each edge so the first video PTS
    # at/after it is the requested frame, rather than accidentally one later.
    cs=int(Fraction(frame,1)/rate*100)
    return f'{cs//360000}:{cs//6000%60:02}:{cs//100%60:02}.{cs%100:02}'


def subtitle_file(project,path,include_dialogue):
    s=project['spec'];rate=edit.fps(project)
    text='[Script Info]\nScriptType: v4.00+\nPlayResX: %s\nPlayResY: %s\nWrapStyle: 0\nScaledBorderAndShadow: yes\n'%(s['width'],s['height'])
    text+='[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\n'
    text+='Style: Dialogue,Noto Sans CJK SC,34,&H00F7F5EC,&H00F7F5EC,&H00151916,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,70,70,32,1\n'
    text+='Style: Title,Noto Serif CJK SC,46,&H00F7F5EC,&H00F7F5EC,&H00151916,&H80000000,0,0,0,0,100,100,1,0,1,1.5,0,8,65,65,45,1\n'
    text+='Style: Credit,Noto Sans CJK SC,22,&H00F7F5EC,&H00F7F5EC,&H00151916,&H80000000,0,0,0,0,100,100,0,0,1,1.5,0,9,65,65,45,1\n'
    text+='Style: Nameplate,Noto Serif CJK SC,32,&H00EAF1F4,&H00EAF1F4,&H00151916,&H80000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1\n'
    text+='Style: NameplateDetail,Noto Sans CJK SC,20,&H00EAF1F4,&H00EAF1F4,&H00151916,&H80000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1\n'
    text+='[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n'
    for group in ('titles','subtitles'):
        if group=='subtitles' and not include_dialogue:continue
        for item in project.get(group,[]):
            value=item['text'].replace('\\','＼').replace('{','｛').replace('}','｝').replace('\r','').replace('\n',r'\N')
            if group=='titles' and item.get('style')=='nameplate':
                # A separate graphics lane remains in both dialogue variants.
                lines=value.split(r'\N');scale=min(s['height']/720,s['width']/1280)
                width=round(max(240,len(lines[0])*32+40,len(lines[1])*20+40 if len(lines)>1 else 0)*scale)
                height=round((100 if len(lines)>1 else 64)*scale);margin=round(64*scale)
                position=item.get('position','lower-left')
                x=margin if position.endswith('left') else s['width']-margin-width
                y=round(92*scale) if position.startswith('upper') else s['height']-round(220*scale)
                start,end=ass_time(item['start_frame'],rate),ass_time(item['end_frame'],rate)
                fade=min(160,int(float(Fraction(item['end_frame']-item['start_frame'],1)/rate)*1000/3))
                prefix=f'Dialogue: 2,{start},{end},Nameplate,,0,0,0,,'
                for w,color,alpha in ((width,'2D352B','28'),(max(1,round(3*scale)),'86B7D3','00')):
                    text+=prefix+f'{{\\an7\\pos(0,0)\\p1\\1c&H{color}&\\1a&H{alpha}&\\fad({fade},{fade})}}m {x} {y} l {x+w} {y} {x+w} {y+height} {x} {y+height}{{\\p0}}\n'
                for i,line in enumerate(lines):
                    style='NameplateDetail' if i else 'Nameplate';size=round((20 if i else 32)*scale,2)
                    text+=f'Dialogue: 3,{start},{end},{style},,0,0,0,,{{\\an7\\pos({x+round(18*scale)},{y+round((54 if i else 10)*scale)})\\fs{size}\\fad({fade},{fade})}}{line}\n'
                continue
            style=('Credit' if item.get('style')=='credit' else 'Title') if group=='titles' else 'Dialogue'
            text+=f"Dialogue: {1 if group=='titles' else 0},{ass_time(item['start_frame'],rate)},{ass_time(item['end_frame'],rate)},{style},,0,0,0,,{value}\n"
    path.write_text(text)


def srt(project):
    return edit.subtitles_srt(project)


def render(runner,project):
    from .resources import lease_scope
    with lease_scope():
        return _render(runner,project)


def _render(runner,project):
    r=runner;p=project;s=p['spec'];rate=edit.fps(p);seconds=float(Fraction(s['duration_frames'],1)/rate)
    sources={x['id']:x for x in p['sources']};directory=r.directory
    video=sorted((c for c in p['clips'] if c['kind']=='video'),key=lambda c:c['timeline_start'])
    paths=[]
    for i,c in enumerate(video):
        source=sources[c['source_id']];v=source['video'];out=directory/f'picture-{i:04}.mkv'
        filters=[f"delogo=x={m['x']}:y={m['y']}:w={m['width']}:h={m['height']}:enable='between(n,{m['start_frame']},{m['end_frame']-1})'" for m in c.get('source_caption_masks',[])]
        if c.get('crop'):
            crop=c['crop'];filters.append(f"crop={crop['width']}:{crop['height']}:{crop['x']}:{crop['y']}")
        filters += [f"trim=start_frame={c['source_in']}:end_frame={c['source_out']}",'setpts=PTS-STARTPTS',
                 f'fps={rate}',f"scale={s['width']}:{s['height']}:force_original_aspect_ratio=decrease",
                 f"pad={s['width']}:{s['height']}:(ow-iw)/2:(oh-ih)/2",'setsar=1','format=yuv420p',
                 f"eq=brightness={c.get('brightness',0)}:contrast={c.get('contrast',1)}:saturation={c.get('saturation',1)}"]
        for key,label in (('fade_in','in'),('fade_out','out')):
            n=c.get(key,0)
            if n:filters.append(f'fade=t={label}:st={0 if label=="in" else float(Fraction(edit.duration(c,p)-n,1)/rate)}:d={float(Fraction(n,1)/rate)}')
        r.ffmpeg('-i',asset_path(r.root,source['component']['file']),'-map',f"0:{v['stream_index']}",'-vf',','.join(filters),
                 '-frames:v',edit.duration(c,p),'-an','-c:v','ffv1','-level','3',out)
        paths.append(out);r.progress(.02+.4*(i+1)/len(video))
    picture=directory/'picture.mkv'
    if not any(c.get('dissolve_in') for c in video):
        (directory/'concat.txt').write_text(''.join(f"file '{p.name}'\n" for p in paths))
        r.ffmpeg('-f','concat','-safe','1','-i',directory/'concat.txt','-c','copy',picture)
    else:
        combined=paths[0];end=edit.duration(video[0],p)
        for i,(c,path) in enumerate(zip(video[1:],paths[1:]),1):
            dest=directory/f'joined-{i:04}.mkv';overlap=c.get('dissolve_in',0)
            graph='[0:v]settb=AVTB[a];[1:v]settb=AVTB[b];[a][b]'
            graph+=f'xfade=transition=fade:duration={float(Fraction(overlap,1)/rate)}:offset={float(Fraction(end-overlap,1)/rate)}[v]' if overlap else 'concat=n=2:v=1:a=0[v]'
            r.ffmpeg('-i',combined,'-i',path,'-filter_complex',graph,'-map','[v]','-an','-c:v','ffv1',dest)
            if combined.name.startswith('joined-'):combined.unlink()
            combined=dest;end+=edit.duration(c,p)-overlap
        combined.replace(picture)
    audio=[c for c in p['clips'] if c['kind']=='audio'];mix=None
    # At most eight audio decoders per command. Intermediate sums use float PCM.
    for group_start in range(0,max(1,len(audio)),8):
        group=audio[group_start:group_start+8];args=[];filters=[];labels=[]
        if mix:args+=['-i',str(mix)];labels.append('[0:a]')
        offset=len(labels)
        for index,c in enumerate(group,offset):
            source=sources[c['source_id']];info=source['audio'];args+=['-i',str(asset_path(r.root,source['component']['file']))]
            label=f'a{index}';length=edit.duration(c,p)
            chain=f"[{index}:{info['stream_index']}]atrim=start_sample={c['source_in']}:end_sample={c['source_out']},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=flt:channel_layouts=stereo,volume={c.get('gain_db',0)}dB"
            for key,direction in (('fade_in','in'),('fade_out','out')):
                n=c.get(key,0)
                if n:chain+=f',afade=t={direction}:ss={0 if direction=="in" else length-n}:ns={n}'
            chain+=f",adelay={c['timeline_start']}S:all=1[{label}]";filters.append(chain);labels.append(f'[{label}]')
        if not labels:
            args=['-f','lavfi','-i',f'anullsrc=r=48000:cl=stereo:d={seconds}'];labels=['[0:a]']
        filters.append(''.join(labels)+f'amix=inputs={len(labels)}:duration=longest:normalize=0,apad,atrim=duration={seconds}[mix]')
        dest=directory/f'mix-{group_start:04}.wav'
        r.ffmpeg(*args,'-filter_complex',';'.join(filters),'-map','[mix]','-c:a','pcm_f32le',dest)
        if mix:mix.unlink()
        mix=dest;r.progress(.44+.2*min(1,(group_start+8)/max(1,len(audio))))
    log=r.ffmpeg('-i',mix,'-af','loudnorm=I=-18:TP=-1.5:LRA=11:print_format=json','-f','null','-')
    raw=log.read_text();measure=json.loads(raw[raw.rfind('{'):raw.rfind('}')+1])
    if measure['input_i']=='-inf':normal='anull'
    else:normal='loudnorm=I=-18:TP=-1.5:LRA=11:linear=true:'+':'.join(k+'='+measure[v] for k,v in (
        ('measured_I','input_i'),('measured_TP','input_tp'),('measured_LRA','input_lra'),('measured_thresh','input_thresh'),('offset','target_offset')))
    master=directory/'mix.wav';r.ffmpeg('-i',mix,'-af',normal,'-ar','48000','-ac','2','-c:a','pcm_s24le',master)
    files={'mix':master}
    for index,(name,dialogue) in enumerate((('clean',False),('subtitled',True))):
        ass=directory/(name+'.ass');subtitle_file(p,ass,dialogue)
        out=directory/(name+'.mp4')
        r.ffmpeg('-i',picture,'-i',master,'-map','0:v:0','-map','1:a:0','-vf',f"subtitles={ass.name}",
                 '-c:v','libx264','-preset','medium','-crf','18','-pix_fmt','yuv420p','-r',rate,
                 '-c:a','aac','-b:a','192k','-ar','48000','-t',seconds,'-movflags','+faststart',out)
        r.ffmpeg('-v','error','-i',out,'-f','null','-')
        probe=edit.probe_source(out)
        if probe['video']['width']!=s['width'] or probe['video']['height']!=s['height'] or Fraction(probe['video']['fps'])!=rate or abs(probe['video']['frames']-s['duration_frames'])>1:
            raise ValueError('rendered picture does not match project specification')
        files[name]=out;r.progress(.7+.12*(index+1))
    (directory/'project.json').write_text(json.dumps(p,ensure_ascii=False,indent=2)+'\n')
    (directory/'subtitles.srt').write_text(srt(p))
    mapping=edit.source_map(p)
    (directory/'source-map.json').write_text(json.dumps(mapping,ensure_ascii=False,indent=2)+'\n')
    files.update(project=directory/'project.json',subtitles=directory/'subtitles.srt',**{'source-map':directory/'source-map.json'})
    return files,measure


@contextmanager
def write_window(root):
    # Same coordination primitive as HTTP; a publisher takes an exclusive lock.
    with (Path(root)/'.runtime/http-write.lock').open('a+b') as lock:
        fcntl.flock(lock.fileno(),fcntl.LOCK_SH)
        try:yield
        finally:fcntl.flock(lock.fileno(),fcntl.LOCK_UN)


def work(root,once=False):
    root=Path(root).resolve();runtime=root/'.runtime';runtime.mkdir(parents=True,exist_ok=True)
    lock=(runtime/'edit-worker.lock').open('a+b')
    try:fcntl.flock(lock.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:raise RuntimeError('this instance already has a render worker')
    stop=[False]
    def halt(*_):stop[0]=True
    for sig in (signal.SIGTERM,signal.SIGINT):signal.signal(sig,halt)
    db=queue(root)
    try:
        # Worker death terminates FFmpeg (PDEATHSIG). Do not silently retry work.
        with db:db.execute("UPDATE jobs SET status='interrupted',error='worker stopped before result registration',updated_at=? WHERE status='running'",(now(),))
        while not stop[0]:
            row=db.execute("SELECT * FROM jobs WHERE status='queued' AND cancel=0 ORDER BY updated_at,id LIMIT 1").fetchone()
            if not row:
                if once:break
                time.sleep(.5);continue
            store=Store.open_existing(runtime/'review.sqlite3');directory=None
            try:
                existing='episode-film-'+row['id']
                if store.db.execute('SELECT 1 FROM objects WHERE id=?',(existing,)).fetchone():
                    with db:db.execute("UPDATE jobs SET status='succeeded',progress=1,updated_at=? WHERE id=?",(now(),row['id']))
                    continue
                with db:db.execute("UPDATE jobs SET status='running',attempts=attempts+1,error='',updated_at=? WHERE id=?",(now(),row['id']))
                snapshot=edit.read(store,row['snapshot_id'],row['snapshot_revision'])
                edit.validate_record(store,snapshot['object_id'],'EDIT_SNAPSHOT',snapshot['payload'],inspect=True)
                directory=runtime/'edit-renders'/row['id']/('attempt-'+str(row['attempts']+1))
                directory.mkdir(parents=True,exist_ok=False)
                runner=Runner(root,db,row['id'],directory,stop)
                files,loudness=render(runner,snapshot['payload']['project']);runner.check()
                components=[]
                for name,path in files.items():
                    with path.open('rb') as stream:c=ingest(root,stream,path.name,path.stat().st_size)
                    c.update(id=name,role='original');components.append(c)
                payload={'format':edit.FORMATS['EPISODE_FILM'],'title':snapshot['payload']['title'],
                         'snapshot':{'object_id':snapshot['object_id'],'revision_id':snapshot['id']},
                         'project':snapshot['payload']['project'],'engine':edit.ENGINE,'components':components,
                         'audio_note':'48 kHz PCM derived mix; source encodings remain recorded.',
                         'source_mix_loudness':loudness}
                edit.validate_record(store,existing,'EPISODE_FILM',payload,inspect=True);runner.check()
                with write_window(root):
                    # Linearize cancellation with registration. Media was checked above;
                    # only structural validation runs in these short transactions.
                    with db:
                        db.execute('BEGIN IMMEDIATE');runner.check()
                        with store.db:
                            store.db.execute('BEGIN IMMEDIATE')
                            store._put_object(existing,'EPISODE_FILM',payload,0,[{'revision_id':snapshot['id'],'role':'edit.snapshot'}])
                        db.execute("UPDATE jobs SET status='succeeded',progress=1,updated_at=? WHERE id=?",(now(),row['id']))
                # Keep compact receipts; remove only this successful attempt's scratch files.
                (directory/'receipt.json').write_text(canonical({'output':existing,'components':components,'loudness':loudness}))
                for path in directory.iterdir():
                    if path.name!='receipt.json' and path.is_file():path.unlink()
            except Exception as exc:
                status='cancelled' if isinstance(exc,Cancelled) else 'failed'
                with db:db.execute('UPDATE jobs SET status=?,error=?,updated_at=? WHERE id=?',(status,str(exc)[-2000:],now(),row['id']))
            finally:store.db.close()
            if once:break
    finally:db.close();lock.close()
