"""Real media through the public complete-export/empty-restore boundary."""
import copy
import json
import shutil
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

import test_production_current as fixtures
from audiovisual_fixture import composition
from review_desk import editing as edit, editing_worker as worker, production as production
from review_desk import production_current_bundle as current_bundle
from review_desk.bundle import export, restore
from review_desk.production_media import ingest,physical_file_hash
from review_desk.store import Store,canonical,digest
from review_desk.version_consolidation import new_identity


class EditingRecoveryTest(unittest.TestCase):
    for name in ('tearDown','spec','put','ref','entity','full','need','setup_plans','media','migrate'):
        locals()[name]=getattr(fixtures.CurrentProductionTest,name)

    def setUp(self):
        fixtures.CurrentProductionTest.setUp(self)
        self.migrate();composition(self)
        path=self.root/'source.mp4'
        subprocess.run(['ffmpeg','-v','error','-y','-f','lavfi','-i','testsrc2=s=320x180:r=24:d=2',
                        '-f','lavfi','-i','sine=f=440:r=32000:d=2','-c:v','libx264','-c:a','aac','-shortest',str(path)],check=True)
        with path.open('rb') as f:component=ingest(self.root,f,'source.mp4')
        self.put(self.spec('cut-source','ASSET',media_type='video',subjects=[self.ref('shot')],states=[],components=[component],
                           external_source={'kind':'upload','description':'isolated generated test pattern'}))
        asset=production.record(self.store,'cut-source')
        source={'id':'source','asset':self.ref('cut-source'),'candidate_id':asset['candidate_id'],'component':component,
                **edit.probe_source(path)}
        self.project={'format':'episode-edit-v1','title':'隔离编辑恢复测试','episode':self.ref('av-episode'),
            'spec':{'width':320,'height':180,'fps':{'num':24,'den':1},'sample_rate':48000,'duration_frames':60},'sources':[source],
            'tracks':[{'id':'picture','kind':'video'},{'id':'sound','kind':'audio'}],
            'clips':[{'id':'v1','track_id':'picture','kind':'video','source_id':'source','source_in':0,'source_out':36,'timeline_start':0,'fade_in':4},
                     {'id':'v2','track_id':'picture','kind':'video','source_id':'source','source_in':12,'source_out':48,'timeline_start':24,'dissolve_in':12,
                      'crop':{'x':0,'y':0,'width':160,'height':90},'brightness':.03,'saturation':.9,'fade_out':4},
                     {'id':'a1','track_id':'sound','kind':'audio','source_id':'source','source_in':0,'source_out':64000,'timeline_start':0,'gain_db':-6,'fade_out':12000},
                     {'id':'a2','track_id':'sound','kind':'audio','source_id':'source','source_in':32000,'source_out':64000,'timeline_start':72000,'gain_db':-12,'fade_in':12000}],
            'subtitles':[{'id':'words','start_frame':20,'end_frame':42,'text':'跨镜字幕 · 两份米'}],
            'titles':[{'id':'credit','start_frame':44,'end_frame':60,'text':'隔离测试','style':'credit'}],'markers':[{'id':'scene','frame':0,'title':'测试场'}]}

    def test_real_dissolve_mix_export_restore_edit_render_and_forged_movie(self):
        filters=subprocess.check_output(['ffmpeg','-hide_banner','-filters'],stderr=subprocess.DEVNULL).decode()
        if ' subtitles ' not in filters:self.skipTest('deployment FFmpeg/libass required')
        project=edit.save(self.store,self.root,self.project,0)
        job=edit.submit(self.store,self.root,project['object_id'],1,'recovery-test','first')
        worker.work(self.root,once=True);result=worker.result(self.store,self.root,job['id'])
        self.assertEqual(result['status'],'succeeded',result)
        output=result['output'];clean=next(c for c in output['payload']['components'] if c['id']=='clean')
        comment=self.store.create_comment({'id':'exact-output-comment','target_object_id':output['object_id'],'target_revision_id':output['id'],
            'anchor':{'type':'time','component_id':'clean','asset_file':clean['file'],'start_seconds':.8,'end_seconds':1.7},'body':'跨转场的准确意见'})
        original=edit.probe_source
        def probe(path):
            self.assertFalse(self.store.db.in_transaction,'export probes must precede its transaction')
            return original(path)
        with patch.object(edit,'probe_source',probe):export(self.store,self.root/'export')
        bundle=self.root/'export';manifest=json.loads((bundle/'manifest.json').read_text())
        self.assertEqual(manifest['schema_version'],15)
        framework=json.loads((bundle/'objects.json').read_text())
        self.assertNotIn('jobs',framework);self.assertNotIn('requests',framework)
        recovered=Store(self.root/'restored/.runtime/review.sqlite3');self.addCleanup(recovered.close)
        restore(recovered,bundle)
        self.assertEqual(edit.read(recovered,project['object_id'])['payload'],self.project)
        self.assertEqual(recovered.comment(comment['id']),comment)
        p2=copy.deepcopy(self.project);p2['clips'][2]['gain_db']=-9
        saved=edit.save(recovered,recovered.db_path.parent.parent,p2,1)
        job2=edit.submit(recovered,recovered.db_path.parent.parent,saved['object_id'],saved['version'],'recovery-test','restored-edit')
        worker.work(recovered.db_path.parent.parent,once=True)
        again=worker.result(recovered,recovered.db_path.parent.parent,job2['id'])
        self.assertEqual(again['status'],'succeeded',again)
        self.assertNotEqual(again['output']['id'],output['id'])
        self.assertEqual(recovered.comment(comment['id'])['target_revision_id'],output['id'])
        # A self-consistent bundle hash must not launder a wrong movie. Change
        # payload/revision/dependencies/comment references and manifest together.
        wrong=copy.deepcopy(output['payload']);bad=copy.deepcopy(self.project['sources'][0]['component']);bad['id']='clean'
        wrong['components']=[bad if c['id']=='clean' else c for c in wrong['components']]
        old_id=output['id'];new_id=new_identity(self.store,output['object_id'],1,wrong)
        for r in framework['revisions']:
            if r['id']==old_id:r.update(id=new_id,payload=canonical(wrong))
        def replace(value):
            if isinstance(value,dict):return {k:replace(v) for k,v in value.items()}
            if isinstance(value,list):return [replace(v) for v in value]
            return new_id if value==old_id else value
        framework=replace(framework)
        (bundle/'objects.json').write_text(canonical(framework))
        comments=replace(json.loads((bundle/'comments.json').read_text()))
        # Preserve a valid exact time anchor so media validation is decisive.
        for c in comments['comments']:c['anchor']['asset_file']=bad['file']
        (bundle/'comments.json').write_text(canonical(comments))
        for name in ('objects.json','comments.json'):manifest['files'][name]=physical_file_hash(bundle/name)
        (bundle/'manifest.json').write_text(canonical(manifest))
        empty=Store(self.root/'rejected/.runtime/review.sqlite3');self.addCleanup(empty.close)
        with self.assertRaisesRegex(ValueError,'film audio must be stereo 48 kHz|film frame count or duration differs'):
            restore(empty,bundle)
        self.assertEqual(empty.objects(),[]);self.assertEqual(empty.comments(),[])
        self.assertFalse((empty.db_path.parent.parent/'export/assets').exists())


if __name__=='__main__':unittest.main()
