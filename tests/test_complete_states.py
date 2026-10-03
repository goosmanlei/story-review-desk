import copy
import unittest

import test_production as fixtures
from review_desk import production as p
from review_desk.store import Conflict


class CompleteStatesTest(unittest.TestCase):
    setUp = fixtures.ProductionTest.setUp
    tearDown = fixtures.ProductionTest.tearDown
    spec = fixtures.ProductionTest.spec
    put = fixtures.ProductionTest.put
    ref = fixtures.ProductionTest.ref
    entity = fixtures.ProductionTest.entity
    media = fixtures.ProductionTest.media

    def full(self, oid='full', **changes):
        return self.spec(oid, 'STATE', entity=self.ref('songbook'), state_model='complete-v1',
                         dimensions={'structure':'歌本整体', 'condition':oid, 'contents':'纸页与歌词', 'placement':'桌面'},
                         reference_media='audio', sources=[self.source], facts=[], choices=[], unknowns=[], **changes)

    def setup_full(self):
        self.put(self.entity())
        self.put(self.full(), self.full('wet'))

    def shot(self, states=None, transitions=None):
        return self.spec('shot', 'SHOT_DESIGN', state_model='complete-v1', episode={'object_id':'episode','revision_id':self.episode['revision']},
                         scene_id='scene', source={**self.source,'block_ids':['a','b']}, number=1, purpose='看清形态变化', framing='近景',
                         spatial='桌面', action_start='完好', action_end='湿', continuity='同一本', duration_frames=24, fps=24,
                         sound=[], entities=[self.ref('songbook')], states=states or [self.ref('full')], state_transitions=transitions or [])

    def need(self, state='full', slot='overall', required=True):
        return self.spec('need-'+state+'-'+slot, 'REQUIREMENT', scope=self.ref(state), slot=slot, required=required,
                         purpose=slot, media_type='audio', usage='post_audio', entities=[self.ref('songbook')], states=[self.ref(state)],
                         specification={'reference_role':'overall' if slot=='overall' else 'detail'})

    def associate(self, role='overall', states=('full',), **bounds):
        asset = p.record(self.store, 'voice')
        payload = copy.deepcopy(asset['payload'])
        payload['states'] = [self.ref(s) for s in states]
        payload['state_coverage'] = [{'state':self.ref(s),'role':role,'component_id':'original','detail':'核对后的覆盖',**bounds} for s in states]
        self.put({'object_id':'voice','kind':'ASSET','expected_version':asset['version'],'payload':payload})

    def adopt(self, state='full', slot='overall', **bounds):
        oid='use-'+state+'-'+slot
        old=next((r for r in p.current_records(self.store) if r['object_id']==oid), None)
        row=self.spec(oid,'RELATION',relation_type='adoption',scope=self.ref(state),slot=slot,
                      asset=self.ref('voice'),component_id='original',usage='post_audio',reason='测试明确选择',**bounds)
        row['expected_version']=old['version'] if old else 0
        self.put(row)

    def test_missing_wrong_owner_legacy_and_transition_block_export(self):
        self.setup_full()
        shot=self.shot();shot['payload']['states']=[]
        with self.assertRaisesRegex(ValueError,'missing_complete_state'):self.put(shot)
        self.put(self.entity('other'))
        wrong=self.full('other-full');wrong['payload']['entity']=self.ref('other');self.put(wrong)
        with self.assertRaisesRegex(ValueError,'state_owner_mismatch'):self.put(self.shot([self.ref('other-full')]))
        legacy=self.full('legacy');del legacy['payload']['state_model'];self.put(legacy)
        with self.assertRaisesRegex(ValueError,'legacy_partial_state'):self.put(self.shot([self.ref('legacy')]))
        transition={'from':self.ref('full'),'to':self.ref('wet'),'action':'被浸湿','source':{**self.source,'block_ids':['b']}}
        with self.assertRaisesRegex(ValueError,'state_transition'):self.put(self.shot([self.ref('full'),self.ref('wet')]))
        self.put(self.shot([self.ref('full'),self.ref('wet')],[transition]))
        result=p.readiness(self.store,'shot')
        self.assertEqual({i['code'] for i in result['state_coverage']['issues']},{'missing_overall_reference_requirement'})
        with self.assertRaises(Conflict):p.package_manifest(self.store,'shot')
        # Closed -> open -> closed reuses a form instead of creating another identity.
        backwards={**transition,'from':self.ref('wet'),'to':self.ref('full')}
        row=self.shot([self.ref('full'),self.ref('wet'),self.ref('full')],[transition,backwards]);row['expected_version']=1;self.put(row)

    def test_detail_cannot_replace_overall_and_passed_does_not_adopt(self):
        self.setup_full();self.media();self.put(self.need(),self.shot());self.associate('detail')
        self.put(self.spec('review','JUDGMENT',target=self.ref('voice'),verdict='passed',actor='测试',reason='仅技术测试'))
        self.assertFalse(p.readiness(self.store,'shot')['inputs_ready'])
        self.adopt()
        self.assertIn('missing_exact_state_coverage',p.readiness(self.store,'full')['requirements'][0]['issues'])
        old_use=p.record(self.store,'use-full-overall')['payload']
        self.associate('overall')
        self.assertEqual(p.record(self.store,'use-full-overall')['payload'],old_use)
        self.assertFalse(p.readiness(self.store,'shot')['inputs_ready'])
        self.adopt()
        self.assertTrue(p.readiness(self.store,'shot')['inputs_ready'])
        package=p.package_manifest(self.store,'shot')
        self.assertIn(self.ref('voice')['revision_id'],{r['id'] for r in package['revisions']})

    def test_one_asset_many_states_optional_details_exact_ranges_and_versions(self):
        self.setup_full();self.media();self.associate(states=('full','wet'),range={'start_seconds':0.1,'end_seconds':0.9})
        self.put(self.need(),self.need('wet'),self.need(slot='voice-detail',required=False))
        self.adopt(range={'start_seconds':0.2,'end_seconds':0.8})
        self.assertFalse(p.readiness(self.store,'full')['inputs_ready'])
        for state in ('full','wet'):self.adopt(state,range={'start_seconds':0.1,'end_seconds':0.9})
        self.assertTrue(p.readiness(self.store,'full')['inputs_ready'])
        self.assertTrue(p.readiness(self.store,'wet')['inputs_ready'])
        old=self.ref('full');new=self.full();new['expected_version']=1;new['payload']['dimensions']['condition']='另一次实质变化';self.put(new)
        self.assertEqual(p.record(self.store,'use-full-overall')['payload']['scope'],old)
        self.assertFalse(p.readiness(self.store,'full')['inputs_ready'])
        self.assertEqual(p.readiness(self.store,'wet')['state_coverage']['issues'],[])
        # Even declaring another exact state revision in the asset's loose states
        # list cannot substitute for coverage of that same revision.
        row=self.need();row['expected_version']=1;self.put(row);self.adopt(range={'start_seconds':0.1,'end_seconds':0.9})
        self.assertIn('missing_exact_state_coverage',p.readiness(self.store,'full')['requirements'][0]['issues'])

    def test_invalid_asset_mapping_and_atomic_concurrent_import(self):
        self.setup_full();self.media()
        asset=p.record(self.store,'voice');before=self.store.objects()
        payload=copy.deepcopy(asset['payload']);payload['state_coverage']=[{'state':self.ref('full'),'role':'overall','component_id':'original','detail':'未声明 states'}]
        row={'object_id':'voice','kind':'ASSET','expected_version':asset['version'],'payload':payload}
        with self.assertRaises(ValueError):self.put(self.need(),row)
        self.assertEqual(before,self.store.objects())
        self.associate();row['payload']=p.record(self.store,'voice')['payload']
        with self.assertRaises(Conflict):self.put(self.need(),row)
        self.assertFalse(any(r['object_id']=='need-full-overall' for r in p.current_records(self.store)))

    def test_complete_dimensions_and_required_overall_contract(self):
        self.setup_full()
        wrong=self.full('missing-dimension');del wrong['payload']['dimensions']['contents']
        with self.assertRaisesRegex(ValueError,'complete state dimension'):self.put(wrong)
        for field,value in [('slot','detail'),('required',False),('media_type','image')]:
            row=self.need();row['payload'][field]=value
            with self.assertRaisesRegex(ValueError,'overall'):self.put(row)
        legacy=self.full('legacy');del legacy['payload']['state_model'];self.put(legacy)
        legacy_shot=self.shot([self.ref('legacy')]);del legacy_shot['payload']['state_model'];self.put(legacy_shot)
        self.assertIn('legacy_partial_state',{i['code'] for i in p.readiness(self.store,'shot')['state_coverage']['issues']})

    def test_guarded_import_detects_changed_read_dependencies(self):
        self.setup_full()
        guards={'songbook':self.ref('songbook')['revision_id']}
        changed=self.entity();changed['expected_version']=1;changed['payload']['facts'].append('并发编辑');self.put(changed)
        before=self.store.objects()
        with self.assertRaises(Conflict):
            p.import_records(self.store,{'format':'production-import-v1','expected_heads':guards,'records':[self.need()]})
        self.assertEqual(before,self.store.objects())

    def test_withdrawn_overall_retains_exact_scope_without_requiring_new_media(self):
        self.setup_full();self.put(self.need())
        old=self.ref('need-full-overall');need=p.record(self.store,'need-full-overall')
        payload=copy.deepcopy(need['payload']);payload.update(required=False,status='withdrawn',withdrawal_reason='重复形态归并，历史保留')
        self.put({'object_id':need['object_id'],'kind':'REQUIREMENT','expected_version':need['version'],'payload':payload})
        self.assertTrue(p.ref_record(self.store,old)['payload']['required'])
        self.assertEqual(p.record(self.store,need['object_id'])['payload']['scope'],self.ref('full'))
        state=p.record(self.store,'full');payload=copy.deepcopy(state['payload']);payload.update(status='withdrawn',withdrawal_reason='由其他完整状态表达')
        self.put({'object_id':'full','kind':'STATE','expected_version':state['version'],'payload':payload})
        self.assertEqual(p.readiness(self.store,'full')['state_coverage']['issues'],[])


if __name__=='__main__':unittest.main()
