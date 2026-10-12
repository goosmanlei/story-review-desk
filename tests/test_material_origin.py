import copy
import unittest

import test_production_current as fixtures
from review_desk import production as p, production_current as current, generation
from review_desk import material_origin, material_reference, navigation_search, semantic_consolidation as semantic
from review_desk.store import Conflict


class MaterialOriginTest(unittest.TestCase):
    for name in ('setUp','tearDown','spec','put','ref','entity','full','need','setup_plans','media','migrate'):
        locals()[name] = getattr(fixtures.CurrentProductionTest, name)

    def test_usage_does_not_add_an_owner_and_baseline_is_optional(self):
        self.migrate()
        # Moving an overall use to the entity cannot orphan a state. This
        # genuinely separate detail remains owned by the full form.
        detail = self.need(slot='voice-detail', required=False)
        self.put(detail)
        row = p.record(self.store, 'need-full-overall')
        body = copy.deepcopy(row['payload'])
        body.update(scope=self.ref('songbook'), states=[self.ref('full'), self.ref('wet')])
        body['specification'].pop('reference_role', None)
        self.put({'object_id':row['object_id'], 'kind':'REQUIREMENT', 'expected_version':row['version'], 'payload':body})
        self.assertEqual(material_origin.validate(self.store,body)['object_id'], 'songbook')
        rows=p.current_records(self.store)
        self.assertEqual([r['object_id'] for r in generation.requirements_for(rows,[p.record(self.store,'wet')])], ['need-wet-overall'])
        bad=copy.deepcopy(body);bad['scope']=self.ref('voice')
        with self.assertRaises(ValueError): material_origin.validate(self.store,bad)
        bad=copy.deepcopy(body);bad['entities']=[]
        with self.assertRaises(ValueError): material_origin.validate(self.store,bad)
        from review_desk.production_states import usage_issues
        self.assertEqual(usage_issues(self.store,[self.ref('songbook')],[],[],[]), [])

    def test_exact_original_resolves_to_one_candidate_and_search_home(self):
        self.migrate()
        value={**self.ref('voice'),'component_id':'original','range':{'start_seconds':.1,'end_seconds':.8}}
        result=current.input_slot(self.store,value,0)
        self.assertEqual(result['reference_contract'], material_reference.CONTRACT)
        self.assertEqual(result['disposition'], 'current')
        self.assertEqual(result['candidate_number'],1)
        self.assertEqual(result['value']['range'],value['range'])
        old_code=material_reference.code(self.store,'voice')
        self.assertIn(old_code,material_reference.candidate_codes(self.store,result['material_id']))
        self.assertTrue(navigation_search.matches(old_code,[navigation_search.normalize(c) for c in material_reference.candidate_codes(self.store,result['material_id'])]))
        broken=copy.deepcopy(value);broken['range']['end_seconds']=99
        self.assertTrue(current.input_slot(self.store,broken,0)['issues'])

    def test_state_body_removal_requires_handoff_and_is_atomic(self):
        self.migrate()
        # State-owned demand remains an actual consumer until explicitly moved.
        choices={'retire':[{'source':'wet','reason':'仅为镜头动作条件，已转交准确方案。'}]}
        plan=semantic.prepare(self.store,choices)
        before=p.record(self.store,'wet')
        with self.assertRaises((Conflict, ValueError)): semantic.apply(self.store,plan)
        self.assertEqual(p.record(self.store,'wet'),before)
        need=p.record(self.store,'need-wet-overall');body=copy.deepcopy(need['payload'])
        body.update(scope=self.ref('songbook'),states=[])
        body['specification'].pop('reference_role',None)
        body['generation']['prompt']+=' 本镜纸页湿卷，翻页后保持湿痕。'
        choices['updates']=[{'object_id':need['object_id'],'payload':body,'reason':'将湿痕承接到准确制作指令。'}]
        plan=semantic.prepare(self.store,choices)
        for fault in ('after-rewrite','before-commit'):
            with self.assertRaises(RuntimeError): semantic.apply(self.store,plan,fault=fault)
            self.assertEqual(p.record(self.store,'wet'),before)
        semantic.apply(self.store,plan)
        self.assertTrue(semantic.apply(self.store,plan)['already_applied'])
        retired=p.record(self.store,'wet')['payload']
        self.assertEqual(retired['format'],semantic.RETIRED)
        self.assertNotIn('dimensions',retired)
        self.assertNotIn('sources',retired)
