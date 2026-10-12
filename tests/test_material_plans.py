import copy
import unittest
from current_material_fixture import MaterialFixture
from review_desk import material_plans as mp, production as p


class CurrentMaterialCardsTest(MaterialFixture, unittest.TestCase):
    def test_current_plan_changes_keep_one_card_and_exact_submitted_candidate(self):
        self.setup_plans(); self.generate(); self.generate('call2','other')
        cards=mp.snapshot(self.store,'need-full-overall')
        self.assertEqual(len(cards),1)
        self.assertEqual(len(cards[0]['results']),2)
        first=cards[0]['results'][0]
        before=copy.deepcopy(first['candidate_context']['submission']) if first.get('candidate_context') else None
        need=p.record(self.store,'need-full-overall')
        self.change('need-full-overall',generation={**need['payload']['generation'],'prompt':'Current rewrite'})
        cards=mp.snapshot(self.store,'need-full-overall')
        self.assertEqual(len(cards),1)
        self.assertEqual(cards[0]['plan']['payload']['generation']['prompt'],'Current rewrite')
        self.assertEqual(len(cards[0]['results']),2)
        from review_desk.production_current import candidate_context
        self.assertNotEqual(candidate_context(self.store, first)['call']['payload']['prompt'],'Current rewrite')

    def test_random_strategy_and_exact_reference_signatures(self):
        plan={'generation':{'method':'generate','model':'x','parameters':{},'prompt':'p','inputs':[], 'randomization':{'mode':'random'}}}
        base=mp.scheme(plan,'REQUIREMENT')
        call={**plan['generation'],'parameters':{'seed':123},'actual_seed':123}
        self.assertEqual(base,mp.scheme(call,'CALL'))
        call['parameters']['seed']=456;self.assertEqual(base,mp.scheme(call,'CALL'))
        call['randomization']={'mode':'fixed','seed':456};self.assertNotEqual(base,mp.scheme(call,'CALL'))
        for key,val in [('model','other'),('prompt','other'),('parameters',{'resolution':'720p'}),('inputs',[{'reference':{'object_id':'a','revision_id':'r'},'component_id':'one','crop':{'x':0}}])]:
            altered=copy.deepcopy(plan);altered['generation'][key]=val
            self.assertNotEqual(base,mp.scheme(altered,'REQUIREMENT'))
