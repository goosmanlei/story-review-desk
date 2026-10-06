import copy
import json
import shutil
import unittest
import threading
import urllib.request
import urllib.error
from unittest.mock import patch
from pathlib import Path
import test_material_plans as fixtures
import test_production_breakdown as breakdown
from review_desk import production as p, generation as g, material_plans as mp, shot_references as sr
from review_desk.store import Conflict, Store
from review_desk.bundle import export, restore


class ShotReferenceTest(unittest.TestCase):
    setUp=fixtures.PlanVersionsTest.setUp
    tearDown=fixtures.PlanVersionsTest.tearDown
    for name in ('spec','put','ref','entity','full','need','media','change','setup_plans','decide','generate'):
        locals()[name]=getattr(fixtures.PlanVersionsTest,name)
    scene_shot=breakdown.BreakdownTest.scene_shot

    def prepare(self, complete=False):
        self.setup_plans();self.generate();self.generate('call2','second');self.scene_shot()
        upstream=p.record(self.store,'need-full-overall')
        self.inputs=[{'reference':self.ref('generated'),'component_id':p.record(self.store,'generated')['payload']['components'][0]['id'],'range':{'start_seconds':.1,'end_seconds':.8},'use':'第一声源'},
                     {'reference':self.ref('need-full-overall'),'use':'同材第二用途'}]
        if not complete:self.inputs[0]={'reference':self.ref('need-full-overall'),'use':'第一声源'}
        plan=copy.deepcopy(upstream['payload']['generation']);plan['inputs']=self.inputs
        self.put(self.spec('video','REQUIREMENT',scope=self.ref('shot'),slot='video',required=True,purpose='本镜视频',media_type='video',usage='editorial',entities=[],states=[],specification={},generation=plan))
        return p.record(self.store,'video')

    def request(self, index=0, candidate='generated', operation='select-one'):
        row=p.record(self.store,'video');round=mp.snapshot(self.store,'video')[0]
        value=row['payload']['generation']['inputs'][index]
        if round.get('definition_records',{}).get('call'):value=sr.inputs_for(self.store,round['definition_records']['call'])[index]
        return {'id':operation,'requirement_id':'video','expected_revision':row['id'],'plan_number':round['number'],'index':index,'input_key':sr.input_key(value),'material_id':'need-full-overall','number':1,'candidate':self.ref(candidate),'component_id':p.record(self.store,candidate)['payload']['components'][0]['id']}

    def approve(self):
        self.put(self.spec('approve-video','JUDGMENT',target=self.ref('video'),verdict='accepted',actor='technical fixture',reason='test only'))

    def test_draft_save_is_atomic_per_slot_idempotent_and_keeps_other_inputs(self):
        old=self.prepare();request=self.request();result=sr.select(self.store,request)
        new=p.record(self.store,'video');self.assertEqual(result['number'],1)
        self.assertEqual(old['payload']['generation']['inputs'][1],new['payload']['generation']['inputs'][1])
        self.assertEqual(new['payload']['generation']['inputs'][0]['reference'],self.ref('generated'))
        self.assertTrue(sr.select(self.store,request)['already_applied']);self.assertEqual(p.record(self.store,'video')['id'],new['id'])
        changed={**request,'candidate':self.ref('second')}
        with self.assertRaises(Conflict):sr.select(self.store,changed)
        self.assertEqual(p.record(self.store,'video')['id'],new['id'])
        with self.assertRaises(Conflict):sr.select(self.store,{**changed,'id':'conflicting'})
        self.assertEqual(p.record(self.store,'video')['id'],new['id'])

    def test_exact_candidate_version_component_and_ranges_are_required(self):
        self.prepare(True);valid=p.record(self.store,'video')['payload']['generation']['inputs'][0]
        self.assertFalse(sr.slot(self.store,valid,0)['issues'])
        for edits in ({'component_id':'absent'},{'material_selection':{'material_id':'need-full-overall','number':99,'candidate_revision_id':valid['reference']['revision_id']}},{'reference':{'object_id':'absent','revision_id':'absent'}},{'range':{'start_seconds':0,'end_seconds':99}}):
            self.assertTrue(sr.slot(self.store,{**valid,**edits},0)['issues'])
        path=self.root/'export/assets'/p.record(self.store,'generated')['payload']['components'][0]['file'];path.unlink()
        self.assertTrue(sr.slot(self.store,valid,0)['issues'])
        before=p.record(self.store,'video')['id']
        with self.assertRaises(Conflict):sr.select(self.store,self.request())
        self.assertEqual(p.record(self.store,'video')['id'],before)

    def test_readiness_package_and_new_call_share_guard_without_generating(self):
        self.prepare();self.approve()
        self.assertFalse(g.readiness(self.store,'video')['ready'])
        with self.assertRaises(Conflict):g.package(self.store,'video')
        plan=p.record(self.store,'video')['payload']['generation']
        for status in ('submitted','completed','failed','unknown'):
            with self.assertRaises((Conflict,ValueError)):self.put(self.spec('rejected-'+status,'CALL',method='generation',tool='fixture',status=status,inputs=[],outputs=[],generation_requirement=self.ref('video'),generation_acceptances=[],**{k:plan[k] for k in ('model','parameters','prompt')}))
        sr.select(self.store,self.request());sr.select(self.store,self.request(index=1,operation='second-slot'))
        self.assertFalse(g.readiness(self.store,'video')['ready']) # changed plan needs approval
        self.change('approve-video',target=self.ref('video'))
        self.assertTrue(g.readiness(self.store,'video')['ready']);self.assertEqual(len(g.package(self.store,'video')['inputs']),2)

    def test_submitted_failed_unknown_are_locked_and_change_creates_new_plan(self):
        for status in ('submitted','failed','unknown'):
            with self.subTest(status=status):
                if status!='submitted':self.tearDown();self.setUp()
                self.prepare(True);sr.select(self.store,self.request(index=1));self.approve()
                old=p.record(self.store,'video');plan=old['payload']['generation']
                # Fixture model does not have a paid provider contract. Store
                # an existing immutable execution to exercise revision handling.
                call=self.spec('video-call','CALL',method='generation',tool='fixture',status=status,inputs=[{**v['reference'],**{k:v[k] for k in ('component_id','range','crop') if k in v}} for v in plan['inputs']],outputs=[],prepared_plan=self.ref('video'),**{k:plan[k] for k in ('model','parameters','prompt')})
                with patch.object(g,'validate_call'):
                    self.put(call) # seed an execution already present before this guard
                before=copy.deepcopy(p.record(self.store,'video-call'))
                result=sr.select(self.store,self.request(candidate='second',operation='replace'))
                self.assertEqual(result['number'],2);self.assertEqual(p.record(self.store,'video-call')['payload'],before['payload'])
                self.assertEqual(p.record(self.store,revision_id=old['id'])['payload'],old['payload'])
                self.assertEqual(p.record(self.store,'video')['payload']['generation']['inputs'][0]['range'],{'start_seconds':.1,'end_seconds':.8})
                self.assertEqual(sr.slots(self.store,sr.inputs_for(self.store,before))[1]['number'],1)

    def test_another_connection_conflicts_without_partial_changes(self):
        self.prepare();stale=self.request(operation='stale-writer');winner=self.request(operation='winner')
        second=Store(self.root/'.runtime/review.sqlite3')
        try:
            sr.select(self.store,winner);before=mp.dump(self.store)
            with self.assertRaises(Conflict):sr.select(second,stale)
            self.assertEqual(mp.dump(second),before)
            self.assertEqual(p.record(second,'video')['id'],p.record(self.store,'video')['id'])
        finally:second.close()

    def test_missing_version_keeps_identity_for_explicit_repair_and_bypass_is_rejected(self):
        self.prepare();value=self.inputs[0]
        missing={**value,'material_selection':{'material_id':'need-full-overall','number':None}}
        checked=sr.slot(self.store,missing,0)
        self.assertEqual(checked['material_id'],'need-full-overall');self.assertIsNone(checked['number']);self.assertTrue(checked['issues'])
        request=self.request();row=p.record(self.store,'video');plan=row['payload']['generation']
        with self.assertRaises(Conflict):self.put(self.spec('bypass','CALL',method='generation',tool='fixture',status='submitted',inputs=[],outputs=[],prepared_plan=self.ref('video'),**{k:plan[k] for k in ('model','parameters','prompt')}))
        with self.assertRaises(ValueError):sr.select(self.store,{**request,'material_id':'generated'})
        self.assertEqual(p.record(self.store,'video')['id'],row['id'])

    def test_same_exact_input_on_locked_plan_still_creates_a_new_version(self):
        self.prepare(True);sr.select(self.store,self.request(index=1));old=p.record(self.store,'video');plan=old['payload']['generation']
        call=self.spec('video-call','CALL',method='generation',tool='historical fixture',status='unknown',inputs=[{**v['reference'],**{k:v[k] for k in ('component_id','range','crop') if k in v}} for v in plan['inputs']],outputs=[],prepared_plan=self.ref('video'),**{k:plan[k] for k in ('model','parameters','prompt')})
        with patch.object(g,'validate_call'):self.put(call)
        result=sr.select(self.store,self.request(operation='same-on-locked'));self.assertEqual(result['number'],2)
        self.assertEqual(mp.snapshot(self.store,'video')[0]['definition_records']['requirement']['id'],result['revision_id'])

    def test_draft_same_signature_selection_metadata_uses_latest_exact_record(self):
        self.prepare();row=p.record(self.store,'video');payload=copy.deepcopy(row['payload']);payload['generation']['inputs'][0]['material_selection']={'material_id':'need-full-overall','number':None}
        self.put({'object_id':'video','kind':'REQUIREMENT','expected_version':row['version'],'payload':payload})
        shown=mp.snapshot(self.store,'video')[0]['definition_records']['requirement'];self.assertEqual(shown['id'],p.record(self.store,'video')['id'])
        self.assertIsNone(sr.slots(self.store,shown['payload']['generation']['inputs'])[0]['number'])

    def test_http_endpoints_reject_incomplete_inputs_and_replay_selection_once(self):
        from review_desk.server import ReviewServer
        self.prepare();self.approve();server=ReviewServer(('127.0.0.1',0),self.root,{'id':'fixture','title':'fixture'});base='http://127.0.0.1:'+str(server.server_port)
        def request(path,body=None):
            results=[]
            def client():
                req=urllib.request.Request(base+path,data=json.dumps(body).encode() if body else None,headers={'Content-Type':'application/json'})
                opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
                try:
                    with opener.open(req,timeout=3) as r:results.append((r.status,json.load(r)))
                except urllib.error.HTTPError as r:results.append((r.code,json.load(r)))
            thread=threading.Thread(target=client);thread.start();server.handle_request();thread.join();return results[0]
        try:
            code,data=request('/api/production/generation-package?requirement_id=video');self.assertEqual(code,409);self.assertIn('参考',data['error'])
            selected=self.request();code,data=request('/api/production/shot-reference',selected);self.assertEqual(code,201);self.assertFalse(data['already_applied'])
            code,again=request('/api/production/shot-reference',selected);self.assertEqual(code,201);self.assertTrue(again['already_applied']);self.assertEqual(data['revision_id'],again['revision_id'])
            code,_=request('/api/production/shot-reference',{**selected,'id':'stale-http'});self.assertEqual(code,409)
            plan=p.record(self.store,'video')['payload']['generation'];bad=self.spec('bypass-http','CALL',method='generation',tool='fixture',status='submitted',inputs=[],outputs=[],prepared_plan=self.ref('video'),**{k:plan[k] for k in ('model','parameters','prompt')})
            code,_=request('/api/production/import',{'format':'production-import-v1','records':[bad]});self.assertEqual(code,409)
        finally:server.server_close()

    def test_export_restore_keeps_selection_receipt_and_exact_history(self):
        self.prepare();req=self.request();sr.select(self.store,req);before=mp.dump(self.store)
        export(self.store,self.root/'export');dest=self.root/'recovered';shutil.copytree(self.root/'export',dest/'export')
        restored=Store(dest/'.runtime/review.sqlite3')
        try:
            restore(restored,dest/'export');self.assertEqual(mp.dump(restored),before)
            self.assertTrue(sr.select(restored,req)['already_applied'])
            self.assertEqual(p.record(restored,'video')['payload'],p.record(self.store,'video')['payload'])
        finally:restored.close()
