import copy
import unittest
from unittest.mock import patch
from current_material_fixture import MaterialFixture
from review_desk import production as p, production_current as current, shot_references as sr
from review_desk.reference_candidates import summaries
from review_desk.store import Conflict

class ReferenceCandidatesTest(MaterialFixture, unittest.TestCase):
    def prepare(self):
        self.setup_plans();self.generate();self.generate('call2','second')
        plan=copy.deepcopy(p.record(self.store,'need-wet-overall')['payload']['generation'])
        plan['inputs']=[{'reference':self.ref('need-full-overall'),'use':'voice source'}]
        self.change('need-wet-overall',generation=plan)
    def request(self,candidate='generated',operation='select',**kw):
        row=p.record(self.store,'need-wet-overall');value=row['payload']['generation']['inputs'][0]
        return dict(id=operation,requirement_id=row['object_id'],expected_content=current.marker(row),index=0,input_key=sr.input_key(value),material_id='need-full-overall',candidate=self.ref(candidate),component_id='original',**kw)
    def test_summary_is_small_ordered_read_only_and_distinguishes_incompatibility(self):
        self.prepare();before=current.dump(self.store)
        data=summaries(self.store,'need-full-overall','audio')
        self.assertEqual([c['number'] for c in data['candidates']],[1,2]);self.assertEqual(len(data['candidates'][0]['originals']),1)
        self.assertNotIn('payload',data['candidates'][0]);self.assertEqual(current.dump(self.store),before)
        self.assertIn('不兼容',summaries(self.store,'need-full-overall','image')['candidates'][0]['originals'][0]['issue'])
        self.assertEqual(summaries(self.store,'need-wet-overall')['candidates'],[])
        with self.assertRaises(KeyError):summaries(self.store,'absent')
    def test_missing_file_is_not_zero_candidates(self):
        self.prepare();component=p.record(self.store,'generated')['payload']['components'][0]
        (self.root/'export/assets'/component['file']).unlink()
        values=summaries(self.store,'need-full-overall')['candidates'];self.assertEqual(len(values),2);self.assertIn('不可用',values[0]['originals'][0]['issue'])
    def test_card_repeat_preserves_bounds_and_change_drops_them(self):
        self.prepare();sr.select(self.store,self.request(range={'start_seconds':0.1,'end_seconds':0.8}))
        before=p.record(self.store,'need-wet-overall');sr.select(self.store,self.request(operation='repeat',preserve_bounds=True))
        self.assertEqual(p.record(self.store,'need-wet-overall'),before)
        sr.select(self.store,self.request('second','change',preserve_bounds=True));after=p.record(self.store,'need-wet-overall')
        self.assertNotIn('range',after['payload']['generation']['inputs'][0]);self.assertEqual(after['payload']['generation']['prompt'],before['payload']['generation']['prompt'])
    def test_same_operation_replay_after_response_loss_is_idempotent(self):
        self.prepare();r=self.request();first=sr.select(self.store,r);saved=p.record(self.store,'need-wet-overall')
        second=sr.select(self.store,r);self.assertTrue(second['already_applied']);self.assertEqual(p.record(self.store,'need-wet-overall'),saved)
        stale={**r,'id':'other'}
        with self.assertRaises(Conflict):sr.select(self.store,stale)
    def test_preview_and_multiple_originals_are_exposed_without_automatic_choice(self):
        self.prepare();row=p.record(self.store,'generated');components=row['payload']['components']
        fake=[components[0],{**components[0],'id':'other-original'},{**components[0],'id':'preview','role':'preview'}]
        actual=p.record
        def record(store,*args,**kwargs):
            value=actual(store,*args,**kwargs)
            if value['object_id']=='generated':value=copy.deepcopy(value);value['payload']['components']=fake
            return value
        with patch.object(p,'record',record):
            values=summaries(self.store,'need-full-overall')['candidates'];self.assertEqual([c['id'] for c in values[0]['originals']],['original','other-original'])
        self.assertEqual(p.record(self.store,'need-wet-overall')['payload']['generation']['inputs'][0]['reference'],self.ref('need-full-overall'))

    def test_workspace_receipt_matches_current_entity_reader(self):
        from review_desk.entity_contract import entity_workspace
        self.prepare();result=sr.select(self.store,self.request())
        reader=entity_workspace(self.store,'songbook',deferred=True,load_selected=False)
        self.assertEqual(result['workspace_marker']['source_signature'],reader['source_signature'])
        self.assertEqual(result['workspace_marker']['owner_id'],'songbook')

    def test_http_summary_and_conflict_reload_are_read_only(self):
        import json, threading, urllib.request
        from review_desk.server import ReviewServer
        self.prepare();before=current.dump(self.store)
        server=ReviewServer(('127.0.0.1',0),self.root,{'title':'Reference picker test'})
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            base='http://127.0.0.1:'+str(server.server_address[1])
            data=json.load(urllib.request.urlopen(base+'/api/production/reference-candidates?material_id=need-full-overall&media_type=audio'))
            self.assertEqual([c['number'] for c in data['candidates']],[1,2])
            reload=json.load(urllib.request.urlopen(base+'/api/production/shot-reference?requirement_id=need-wet-overall'))
            self.assertEqual(reload['edit_token'],current.marker(p.record(self.store,'need-wet-overall'))['edit_token'])
            self.assertEqual(reload['workspace_marker']['owner_id'],'songbook')
            self.assertEqual(current.dump(self.store),before)
        finally:
            server.shutdown();server.server_close();thread.join()

    def test_clear_bounds_replay_and_reselection_preserve_other_inputs_and_history(self):
        self.prepare()
        row=p.record(self.store,'need-wet-overall')
        plan=copy.deepcopy(row['payload']['generation']);plan['inputs'].append(copy.deepcopy(plan['inputs'][0]))
        plan['inputs'][0].update(use='identity',role='voice',necessity='required')
        self.change('need-wet-overall',generation=plan)
        history=p.record(self.store,'generated');upstream=p.record(self.store,'need-full-overall')
        sr.select(self.store,self.request(range={'start_seconds':0.1,'end_seconds':0.8}))
        other=copy.deepcopy(p.record(self.store,'need-wet-overall')['payload']['generation']['inputs'][1])
        clear={**self.request(operation='clear'),'candidate':None};clear.pop('component_id')
        sr.select(self.store,clear);after=p.record(self.store,'need-wet-overall')
        value=after['payload']['generation']['inputs'][0]
        self.assertEqual(value['selection_state'],'unselected');self.assertEqual(value['use'],'identity');self.assertEqual(value['role'],'voice')
        for key in ('component_id','range','crop','sha256','material_selection'):self.assertNotIn(key,value)
        self.assertEqual(after['payload']['generation']['inputs'][1],other)
        self.assertTrue(sr.select(self.store,clear)['already_applied']);self.assertEqual(p.record(self.store,'need-wet-overall'),after)
        sr.select(self.store,self.request(operation='again',preserve_bounds=True))
        self.assertNotIn('range',p.record(self.store,'need-wet-overall')['payload']['generation']['inputs'][0])
        self.assertEqual(p.record(self.store,'generated'),history);self.assertEqual(p.record(self.store,'need-full-overall'),upstream)

    def test_clear_original_endpoint_relation_requires_exact_candidate_membership(self):
        from review_desk import business_relations as br
        self.prepare();self.store.db.executescript(br.SCHEMA)
        endpoints=sorted(['generated','need-wet-overall']);edge=br.identity(endpoints)
        self.put(self.spec(edge,'RELATION',relation_type='business',endpoints=endpoints,direction='forward',summary='原件提供声音身份',sources=[],contexts=[]))
        plan=copy.deepcopy(p.record(self.store,'need-wet-overall')['payload']['generation'])
        plan['inputs'][0]={'reference':self.ref('generated'),'component_id':'original','range':{'start_seconds':0.1,'end_seconds':0.8},'relation':self.ref(edge),'semantics':'reuse','necessity':'required','use':'保留身份关系'}
        self.change('need-wet-overall',generation=plan);relation=p.record(self.store,edge)
        clear={**self.request(operation='clear-original-edge'),'candidate':None};clear.pop('component_id');sr.select(self.store,clear)
        value=p.record(self.store,'need-wet-overall')['payload']['generation']['inputs'][0]
        self.assertEqual(value['relation'],self.ref(edge));self.assertEqual(value['selection_state'],'unselected');self.assertNotIn('range',value)
        sr.select(self.store,self.request('second','select-after-clear',preserve_bounds=True))
        self.assertEqual(p.record(self.store,edge),relation)
        unrelated={**value,'reference':self.ref('need-wet-overall')}
        with self.assertRaisesRegex(ValueError,'对象对'):br.exact_input_relation(self.store,'need-wet-overall',unrelated)
