import copy
import io
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from pathlib import Path

from review_desk.store import Store,Conflict,canonical
from review_desk import editing as edit
from review_desk import editing_worker as worker
from review_desk.production_media import ingest
from review_desk.production_current import checksum


class EditingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.media=tempfile.TemporaryDirectory();cls.original=Path(cls.media.name)/'source.mp4'
        subprocess.run(['ffmpeg','-v','error','-y','-f','lavfi','-i','testsrc2=s=320x180:r=24:d=2',
                        '-f','lavfi','-i','sine=f=440:r=32000:d=2','-c:v','libx264','-c:a','aac','-shortest',str(cls.original)],check=True)

    @classmethod
    def tearDownClass(cls):cls.media.cleanup()

    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.store=Store(self.root/'.runtime/review.sqlite3')
        s=self.store
        episode=s._insert_object('test-episode','AV_EPISODE',{'title':'测试集','format':'production-av-episode-v1'})
        with self.original.open('rb') as f:component=ingest(self.root,f,'source.mp4')
        asset=s._insert_object('test-asset','ASSET',{'format':'production-asset-v1','title':'测试原件','components':[component]})
        with s.db:
            s.db.execute('INSERT INTO production_submissions VALUES (?,?,?,?,?)',('test-operation','{}',checksum({}),'test','2026-01-01'))
            s.db.execute('INSERT INTO production_candidates VALUES (?,?,?,?)',('test-candidate','test-operation','test-asset','2026-01-01'))
        source={'id':'source','asset':{'object_id':'test-asset','revision_id':asset},'candidate_id':'test-candidate','component':component,**edit.probe_source(self.root/'export/assets'/component['file'])}
        self.project={'format':'episode-edit-v1','title':'两份米 · 测试','episode':{'object_id':'test-episode','revision_id':episode},
            'spec':{'width':320,'height':180,'fps':{'num':24,'den':1},'sample_rate':48000,'duration_frames':48},
            'sources':[source],'tracks':[{'id':'picture','kind':'video','title':'画面'},{'id':'sound','kind':'audio','title':'原片混合音轨'}],
            'clips':[{'id':'v1','track_id':'picture','kind':'video','source_id':'source','source_in':0,'source_out':48,'timeline_start':0},
                     {'id':'a1','track_id':'sound','kind':'audio','source_id':'source','source_in':0,'source_out':64000,'timeline_start':0}],
            'subtitles':[{'id':'s1','start_frame':4,'end_frame':40,'text':'一道险滩水急'}],
            'titles':[{'id':'t1','start_frame':0,'end_frame':48,'text':'两份米'}],'markers':[{'id':'scene','frame':0,'title':'米铺'}]}

    def tearDown(self):self.store.close();self.temp.cleanup()

    def save(self,p=None,version=0):return edit.save(self.store,self.root,p or self.project,version)

    def test_version_and_snapshot_are_exact(self):
        first=self.save();same=self.save(version=1);self.assertEqual(first['id'],same['id'])
        job=edit.submit(self.store,self.root,first['object_id'],1,'test','one')
        duplicate=edit.submit(self.store,self.root,first['object_id'],1,'test','one');self.assertEqual(job['id'],duplicate['id'])
        changed=copy.deepcopy(self.project);changed['clips'][1]['gain_db']=-3
        second=self.save(changed,1);self.assertEqual(second['version'],2)
        self.assertEqual(edit.read(self.store,first['object_id'],first['id'])['payload'],self.project)
        with self.assertRaises(Conflict):self.save(changed,1)
        with self.assertRaises(Conflict):edit.submit(self.store,self.root,first['object_id'],2,'test','one')
        self.assertEqual(len(edit.records(self.store,'EDIT_SNAPSHOT')),1)
        snap=edit.records(self.store,'EDIT_SNAPSHOT')[0]
        with self.assertRaisesRegex(ValueError,'snapshot render engine'):
            edit.validate_record(self.store,snap['object_id'],'EDIT_SNAPSHOT',{**snap['payload'],'engine':'unknown'},check_files=False)
        with self.assertRaises(Conflict):self.store.put_object(snap['object_id'],'EDIT_SNAPSHOT',snap['payload'],1,edit.expected_dependencies('EDIT_SNAPSHOT',snap['payload']))

    def test_submit_rechecks_project_after_slow_probe(self):
        saved=self.save();original=edit.validate_project;changed=[False]
        def validate(*args,**kwargs):
            if not changed[0]:
                changed[0]=True;p=copy.deepcopy(self.project);p['title']='new head';self.save(p,1)
            return original(*args,**kwargs)
        with patch.object(edit,'validate_project',validate):
            with self.assertRaises(Conflict):edit.submit(self.store,self.root,saved['object_id'],1,'test','racing')
        self.assertEqual(edit.records(self.store,'EDIT_SNAPSHOT'),[])

    def test_rejects_bad_inputs_without_writes(self):
        for mutate in [lambda p:p['clips'][0].update(source_out=49),lambda p:p['clips'][0].update(timeline_start=1),
                       lambda p:p['sources'][0].update(candidate_id='missing'),lambda p:p['sources'][0]['video'].update(fps='25'),
                       lambda p:p['clips'][1].update(source_out=999999),lambda p:p['clips'][0].update(source_in=.5),
                       lambda p:p['clips'][0].update(crop={'x':2,'y':0,'width':320,'height':180})]:
            p=copy.deepcopy(self.project);mutate(p)
            with self.assertRaises((ValueError,KeyError)):self.save(p)
            self.assertEqual(edit.records(self.store,'EPISODE_EDIT'),[])
        path=self.root/'export/assets'/self.project['sources'][0]['component']['file']
        path.write_bytes(path.read_bytes()[:-1]+b'x')
        with self.assertRaises(ValueError):self.save()
        self.assertEqual(edit.records(self.store,'EPISODE_EDIT'),[])

    def test_content_mapping_after_split_and_delete(self):
        p=copy.deepcopy(self.project);p['clips'][0]['source_out']=24
        p['clips'].append({**p['clips'][0],'id':'v2','lineage_id':'v1','source_in':24,'source_out':48,'timeline_start':24})
        self.assertEqual(edit.compare(self.project,p,30),{'mapped':True,'frame':30,'reason':''})
        p['clips'].pop();self.assertFalse(edit.compare(self.project,p,30)['mapped'])

    def test_cancel_and_explicit_retry(self):
        first=self.save();job=edit.submit(self.store,self.root,first['object_id'],1,'test','cancel')
        self.assertEqual(worker.change_job(self.store,self.root,job['id'],'cancel')['status'],'cancelled')
        self.assertEqual(worker.change_job(self.store,self.root,job['id'],'retry')['status'],'queued')
        db=worker.queue(self.root)
        with db:db.execute("UPDATE jobs SET status='running'")
        db.close();worker.work(self.root,once=True)
        self.assertEqual(worker.result(self.store,self.root,job['id'])['status'],'interrupted')

    @unittest.skipUnless(sys.platform.startswith('linux'),'Linux deployment process lifecycle')
    def test_real_worker_kill_cancel_singleton_and_continue(self):
        p=copy.deepcopy(self.project);p['spec']['duration_frames']=480
        p['clips']=[{**p['clips'][0],'id':'v'+str(i),'timeline_start':48*i} for i in range(10)]+[p['clips'][1]]
        saved=self.save(p);job=edit.submit(self.store,self.root,saved['object_id'],1,'fault-test','kill')
        command=[sys.executable,'-c','import sys;from review_desk.editing_worker import work;work(sys.argv[1],once=True)',str(self.root)]
        def start():
            proc=subprocess.Popen(command,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
            def close():
                if proc.poll() is None:proc.terminate();proc.wait(timeout=10)
                proc.stderr.close()
            self.addCleanup(close)
            return proc
        def running(proc):
            deadline=time.monotonic()+20
            while time.monotonic()<deadline:
                paths=list((self.root/'.runtime/edit-renders'/job['id']).glob('attempt-*/process.json'))
                for path in paths:
                    try:
                        value=json.loads(path.read_text());os.kill(value['pid'],0)
                        return value
                    except (FileNotFoundError,ProcessLookupError,json.JSONDecodeError):pass
                if proc.poll() is not None:self.fail('worker ended before live FFmpeg: '+proc.stderr.read().decode())
                time.sleep(.05)
            self.fail('worker never started an owned FFmpeg')
        proc=start();child=running(proc)
        duplicate=subprocess.run(command,capture_output=True,timeout=10)
        self.assertNotEqual(duplicate.returncode,0);self.assertIn(b'already has a render worker',duplicate.stderr)
        # Business reads and writes remain available while rendering.
        self.assertEqual(edit.read(self.store,saved['object_id'])['version'],1)
        self.store.put_object('during-render','NOTE',{'title':'并行写入','blocks':[{'id':'note','text':'render remains asynchronous'}]},0)
        proc.kill();proc.wait(timeout=10)
        deadline=time.monotonic()+10
        while time.monotonic()<deadline:
            stat=Path('/proc')/str(child['pid'])/'stat'
            if not stat.exists() or stat.read_text().split()[2]=='Z':break
            time.sleep(.05)
        else:self.fail('worker death left its FFmpeg running')
        worker.work(self.root,once=True)
        self.assertEqual(worker.result(self.store,self.root,job['id'])['status'],'interrupted')
        self.assertEqual(edit.records(self.store,'EPISODE_FILM'),[])
        worker.change_job(self.store,self.root,job['id'],'retry');proc2=start();running(proc2)
        worker.change_job(self.store,self.root,job['id'],'cancel');proc2.wait(timeout=20)
        self.assertEqual(worker.result(self.store,self.root,job['id'])['status'],'cancelled')
        self.assertEqual(edit.records(self.store,'EPISODE_FILM'),[])
        if ' subtitles ' in subprocess.check_output(['ffmpeg','-hide_banner','-filters'],stderr=subprocess.DEVNULL).decode():
            revised=copy.deepcopy(self.project);revised['title']='中断后继续编辑'
            saved=self.save(revised,1);next_job=edit.submit(self.store,self.root,saved['object_id'],2,'fault-test','new-cut')
            worker.work(self.root,once=True)
            self.assertEqual(worker.result(self.store,self.root,next_job['id'])['status'],'succeeded')

    def test_actual_render_chinese_subtitles_and_range_comment(self):
        filters=subprocess.check_output(['ffmpeg','-hide_banner','-filters'],stderr=subprocess.DEVNULL).decode()
        if ' subtitles ' not in filters:self.skipTest('requires deployment FFmpeg with libass')
        first=self.save();job=edit.submit(self.store,self.root,first['object_id'],1,'test','render')
        worker.work(self.root,once=True);result=worker.result(self.store,self.root,job['id'])
        self.assertEqual(result['status'],'succeeded',result)
        output=result['output'];c=next(c for c in output['payload']['components'] if c['id']=='subtitled')
        self.assertEqual((c['width'],c['height']), (320,180))
        edit.validate_record(self.store,output['object_id'],'EPISODE_FILM',output['payload'],inspect=True)
        # Valid hashes, filenames and self-consistent metadata are insufficient:
        # restore/import must reject swapped or unrelated deliverables too.
        for ident in ('project','source-map','subtitles','mix','subtitled'):
            bad=copy.deepcopy(output['payload'])
            if ident in ('project','source-map','subtitles'):
                body=b'wrong text\n' if ident=='subtitles' else b'{}\n'
                forged=ingest(self.root,io.BytesIO(body),'wrong'+('.srt' if ident=='subtitles' else '.json'))
            else:forged=copy.deepcopy(self.project['sources'][0]['component'])
            forged['id']=ident;bad['components']=[forged if x['id']==ident else x for x in bad['components']]
            with self.assertRaises(ValueError):edit.validate_record(self.store,output['object_id'],'EPISODE_FILM',bad,inspect=True)
        comment=self.store.create_comment({'id':'render-comment','target_object_id':output['object_id'],'target_revision_id':output['id'],
            'anchor':{'type':'time','component_id':'subtitled','asset_file':c['file'],'start_seconds':.25,'end_seconds':.75},'body':'检查唱词'})
        self.assertEqual(comment['target_revision_id'],output['id'])
        again=edit.submit(self.store,self.root,first['object_id'],1,'test','render')
        self.assertEqual(again['output']['id'],output['id']);self.assertEqual(len(edit.records(self.store,'EPISODE_FILM')),1)

    def test_subtitle_edges_hit_requested_frames(self):
        if ' subtitles ' not in subprocess.check_output(['ffmpeg','-hide_banner','-filters'],stderr=subprocess.DEVNULL).decode():
            self.skipTest('requires deployment libass')
        p=copy.deepcopy(self.project);p['titles']=[]
        p['subtitles']=[{'id':'words','start_frame':3,'end_frame':6,'text':'两份米'}]
        ass=self.root/'frame-edges.ass';worker.subtitle_file(p,ass,True)
        raw=subprocess.check_output(['ffmpeg','-v','error','-f','lavfi','-i','color=c=black:s=320x180:r=24:d=1',
            '-vf','subtitles='+str(ass),'-frames:v','8','-pix_fmt','gray','-f','rawvideo','-'])
        lit=[sum(v>150 for v in raw[i*320*180:(i+1)*320*180]) for i in range(8)]
        self.assertEqual([i for i,count in enumerate(lit) if count>0],[3,4,5],lit)


if __name__=='__main__':unittest.main()
