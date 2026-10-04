import copy
import hashlib
import json
import shutil
import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
import test_generation as fixtures
from review_desk import production as p, generation as g, material_versions as mv
from review_desk.store import Store, Conflict
from review_desk.bundle import export, restore


class MaterialVersionsTest(unittest.TestCase):
    def setUp(self):
        from legacy_material_fixture import install
        install(self)
        fixtures.GenerationTest.setUp(self)
    tearDown=fixtures.GenerationTest.tearDown
    spec=fixtures.GenerationTest.spec
    put=fixtures.GenerationTest.put
    ref=fixtures.GenerationTest.ref
    entity=fixtures.GenerationTest.entity
    full=fixtures.GenerationTest.full
    need=fixtures.GenerationTest.need
    media=fixtures.GenerationTest.media
    change=fixtures.GenerationTest.change
    setup_plans=fixtures.GenerationTest.setup_plans
    decide=fixtures.GenerationTest.decide

    def generate(self, name='call1', asset='generated'):
        if not g.accepted(self.store,'songbook'):self.decide()
        manifest=g.package(self.store,'need-full-overall')
        self.put(self.spec(name,'CALL',method='generation',tool='test',status='submitted',inputs=[],outputs=[],
                           generation_requirement=manifest['requirement'],generation_acceptances=manifest['acceptances'],
                           **{k:manifest[k] for k in ('model','parameters','prompt')}))
        if not self.store.db.execute("SELECT 1 FROM objects WHERE id='voice'").fetchone():self.media()
        component=p.record(self.store,'voice')['payload']['components'][0]
        old=self.store.db.execute('SELECT version FROM objects WHERE id=?',(asset,)).fetchone()
        result=self.spec(asset,'ASSET',media_type='audio',subjects=[],states=[],components=[component],production=self.ref(name),lineage={})
        result['expected_version']=old[0] if old else 0
        self.put(result)
        self.change(name,status='completed',outputs=[self.ref(asset)])

    def comment(self, number=None, target='generated', cid=None):
        value={'target_object_id':target,'target_revision_id':self.ref(target)['revision_id'],
               'anchor':{'type':'global'},'body':'隔离修订意见'}
        if cid:value['id']=cid
        if number:value['material_revision']={'material_id':'need-full-overall','expected_round':number}
        return self.store.create_comment(value)

    def test_round_lifecycle_metadata_and_exact_history(self):
        self.setup_plans();need1=self.ref('need-full-overall');self.change('need-full-overall',purpose='补充用途')
        self.assertEqual(len(mv.snapshot(self.store,'need-full-overall')),1)
        self.generate();asset1=self.ref('generated');call1=copy.deepcopy(p.record(self.store,'generated')['payload']['production'])
        self.comment();self.assertEqual(len(mv.snapshot(self.store,'need-full-overall')),1)
        first=self.comment(1,cid='feedback1');self.comment(2,cid='feedback2')
        self.assertEqual(len(mv.snapshot(self.store,'need-full-overall')),2)
        rounds=mv.snapshot(self.store,'need-full-overall');self.assertEqual(rounds[0]['results'],[])
        self.store.change_comment(first['id'],'CLOSE',1);self.store.change_comment(first['id'],'REOPEN',2)
        self.assertEqual(len(mv.snapshot(self.store,'need-full-overall')),2)
        self.change('generated',verification={'file_inspected':True})
        self.assertFalse(mv.snapshot(self.store,'need-full-overall')[0]['results'])
        self.change('need-full-overall',generation={**p.record(self.store,'need-full-overall')['payload']['generation'],'prompt':'下一轮完整提示词'})
        self.generate('call2')
        rounds=mv.snapshot(self.store,'need-full-overall');self.assertEqual(rounds[0]['results'][0]['payload']['production']['object_id'],'call2')
        self.assertEqual(rounds[1]['results'][0]['payload']['production'],call1)
        self.assertEqual(p.record(self.store,revision_id=asset1['revision_id'])['payload']['production'],call1)
        self.assertIn(need1['revision_id'],[r['id'] for r in rounds[1]['members']])

    def test_stale_feedback_rolls_back_comment_and_event_and_retry_is_idempotent(self):
        self.setup_plans();self.generate();self.comment(1,cid='one');before=mv.fingerprint(self.store)
        with self.assertRaises(Conflict):self.comment(1,cid='stale')
        self.assertEqual(mv.fingerprint(self.store),before);self.assertIsNone(self.store.comment('stale'))
        value={'id':'one','target_object_id':'generated','target_revision_id':self.ref('generated')['revision_id'],
               'anchor':{'type':'global'},'body':'隔离修订意见','material_revision':{'material_id':'need-full-overall','expected_round':1}}
        self.store.create_comment(value);self.assertEqual(mv.fingerprint(self.store),before)

    def test_failed_batch_and_validate_only_do_not_create_round_members(self):
        self.setup_plans();before=mv.dump(self.store);row=p.record(self.store,'need-full-overall')
        update={'object_id':row['object_id'],'kind':row['kind'],'expected_version':row['version'],'payload':copy.deepcopy(row['payload'])};update['payload']['purpose']='新说明'
        document={'format':'production-import-v1','records':[update]};p.import_records(self.store,document,validate_only=True)
        self.assertEqual(mv.dump(self.store),before);document['records'].append(self.spec('bad','CALL',status='invalid'))
        with self.assertRaises(ValueError):p.import_records(self.store,document)
        self.assertEqual(mv.dump(self.store),before)

    def test_concurrent_first_feedback_creates_one_round_without_orphans(self):
        self.setup_plans();self.generate();barrier=Barrier(2);ref=self.ref('generated')
        def submit(cid):
            store=Store(self.root/'.runtime/review.sqlite3')
            try:
                barrier.wait()
                try:
                    store.create_comment({'id':cid,'target_object_id':'generated','target_revision_id':ref['revision_id'],
                        'anchor':{'type':'global'},'body':'并发修订','material_revision':{'material_id':'need-full-overall','expected_round':1}})
                    return 'created'
                except Conflict:return 'conflict'
            finally:store.close()
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(submit,['concurrent1','concurrent2']))
        self.assertEqual(sorted(results),['conflict','created'])
        self.assertEqual(len(mv.snapshot(self.store,'need-full-overall')),2)
        self.assertEqual(len(self.store.comments()),1);self.assertEqual(len(self.store.events()),1)

    def test_comments_on_carried_plan_remain_scoped_to_selected_round(self):
        self.setup_plans();self.generate();target=self.ref('need-full-overall')
        def add(cid,number):
            return self.store.create_comment({'id':cid,'target_object_id':target['object_id'],'target_revision_id':target['revision_id'],
                'anchor':{'type':'global'},'body':cid,'material_context':{'material_id':target['object_id'],'number':number}})
        first=add('oldplan',1);self.comment(1);second=add('newplan',2)
        self.assertEqual(first['material_scopes'],[{'material_id':target['object_id'],'number':1}])
        self.assertEqual(second['material_scopes'],[{'material_id':target['object_id'],'number':2}])
        before=mv.fingerprint(self.store)
        with self.assertRaises(Conflict):add('wrong',3)
        self.assertEqual(before,mv.fingerprint(self.store))

    def test_invalid_round_recovery_rolls_back_all_destination_rows(self):
        self.setup_plans();export(self.store,self.root/'export')
        dest=self.root/'invalid-recovery';shutil.copytree(self.root/'export',dest/'export')
        path=dest/'export/objects.json';value=json.loads(path.read_text());value['material_members'][0]['role']='result';path.write_text(json.dumps(value))
        manifest=dest/'export/manifest.json';value=json.loads(manifest.read_text());value['files']['objects.json']=hashlib.sha256(path.read_bytes()).hexdigest();manifest.write_text(json.dumps(value))
        recovered=Store(dest/'.runtime/review.sqlite3')
        try:
            with self.assertRaises(ValueError):restore(recovered,dest/'export')
            self.assertEqual(recovered.objects(),[]);self.assertEqual(recovered.comments(),[])
            self.assertFalse(mv.dump(recovered)['material_rounds'])
        finally:recovered.close()

    def test_workspace_keeps_entity_revision_options_separate_from_rounds(self):
        self.setup_plans();self.media();fixtures.GenerationTest.associate(self)
        view=g.snapshot(self.store,'songbook')
        self.assertIn('id',view['versions']['songbook'][0])
        self.assertEqual(view['material_versions']['need-full-overall'][0]['number'],1)
        self.assertEqual(view['material_versions']['voice'][0]['number'],1)

    def test_asset_entry_keeps_each_round_candidate_actual_call_context(self):
        self.setup_plans();self.generate()
        first=self.ref('generated')['revision_id']
        self.change('need-full-overall',generation={
            **p.record(self.store,'need-full-overall')['payload']['generation'],
            'prompt':'第二次实际调用的不同提示词'})
        self.generate('call2','another-candidate')
        second=self.ref('another-candidate')['revision_id']
        self.comment(1)
        self.generate('call3','next-round-candidate')
        third=self.ref('next-round-candidate')['revision_id']
        expected={first:'call1',second:'call2',third:'call3'}
        for entry in ('generated','another-candidate','next-round-candidate','need-full-overall'):
            view=p.snapshot(self.store,object_id=entry)
            rounds=view['material_versions']['need-full-overall']
            self.assertEqual([r['number'] for r in rounds],[2,1])
            for round in rounds:
                for candidate in round['results']:
                    context=view['review_contexts'][candidate['id']]
                    self.assertEqual(context['call']['object_id'],expected[candidate['id']])
                    original=p.ref_record(self.store,candidate['payload']['production'])
                    self.assertEqual(context['call']['id'],original['id'])
                    self.assertEqual(context['call']['payload']['prompt'],original['payload']['prompt'])
            self.assertNotEqual(view['review_contexts'][first]['call']['payload']['prompt'],
                                view['review_contexts'][second]['call']['payload']['prompt'])

    def test_delayed_first_submission_uses_active_round_and_input_history_is_frozen(self):
        self.setup_plans();self.decide();manifest=g.package(self.store,'need-full-overall')
        self.put(self.spec('delayed','CALL',method='generation',tool='test',status='planned',inputs=[],outputs=[],
            generation_requirement=manifest['requirement'],generation_acceptances=manifest['acceptances'],
            **{k:manifest[k] for k in ('model','parameters','prompt')}))
        self.generate();self.comment(1);self.change('delayed',status='submitted')
        current=p.record(self.store,'delayed')
        self.assertEqual({m['number'] for m in mv.memberships(self.store,current['id'])},{2})
        before=mv.fingerprint(self.store)
        with self.assertRaises(Conflict):self.change('delayed',prompt='rewrite real input')
        self.assertEqual(before,mv.fingerprint(self.store))

    def test_shared_result_reads_original_round_and_comments_on_other_entity_without_expanding_acceptance(self):
        self.setup_plans();self.generate()
        self.put(self.entity('other'))
        form=self.full('other-full');form['payload']['entity']=self.ref('other');self.put(form)
        self.change('generated',states=[self.ref('full'),self.ref('other-full')],state_coverage=[
            {'state':self.ref(s),'role':'overall','component_id':'original','detail':'共享声音'} for s in ('full','other-full')])
        original=self.ref('generated');comment=self.comment(1)
        view=g.snapshot(self.store,'other');rounds=view['material_versions']['need-full-overall']
        self.assertEqual([r['number'] for r in rounds],[2,1]);self.assertEqual(rounds[0]['results'],[])
        self.assertEqual(rounds[1]['results'][0]['id'],original['revision_id'])
        self.assertEqual(view['scope']['requirements'],[])
        self.assertIn(comment['target_revision_id'],[r['revision_id'] for r in view['comment_targets']])
        self.assertEqual(view['materialContexts'][original['revision_id']]['call']['object_id'],'call1')

    def test_migration_guard_idempotence_and_export_recovery(self):
        self.setup_plans();self.generate();self.comment(1,cid='revision');export(self.store,self.root/'export')
        dest=self.root/'restored';shutil.copytree(self.root/'export',dest/'export');recovered=Store(dest/'.runtime/review.sqlite3')
        try:
            restore(recovered,dest/'export');self.assertEqual(mv.dump(self.store),mv.dump(recovered));export(recovered,dest/'export')
            self.assertEqual((dest/'export/objects.json').read_bytes(),(self.root/'export/objects.json').read_bytes())
            self.assertEqual(recovered.comments(),self.store.comments());self.assertEqual(recovered.events(),self.store.events())
        finally:recovered.close()
        with self.store.db:
            self.store.db.execute('DELETE FROM material_comment_scopes')
            self.store.db.execute('DELETE FROM material_feedback');self.store.db.execute('DELETE FROM material_members');self.store.db.execute('DELETE FROM material_rounds')
        row=p.record(self.store,'need-full-overall');document={'format':'material-round-migration-v1','expected_fingerprint':mv.fingerprint(self.store),
                  'members':[{'material_id':row['object_id'],'number':1,'revision_id':row['id'],'evidence':'checked legacy plan'}]}
        mv.migrate(self.store,document,True);self.assertFalse(mv.dump(self.store)['material_rounds']);self.comment();before=mv.dump(self.store)
        with self.assertRaises(Conflict):mv.migrate(self.store,document)
        self.assertEqual(mv.dump(self.store),before);document['expected_fingerprint']=mv.fingerprint(self.store);mv.migrate(self.store,document)
        self.assertTrue(mv.migrate(self.store,document)['already_applied'])


if __name__=='__main__':unittest.main()
