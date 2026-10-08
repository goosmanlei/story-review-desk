import copy
import unittest
import test_production as fixtures
from audiovisual_fixture import composition
from review_desk import production as p, production_breakdown as bd

class BreakdownTest(unittest.TestCase):
    setUp=fixtures.ProductionTest.setUp
    tearDown=fixtures.ProductionTest.tearDown
    for name in ('spec','put','ref','entity','requirement','media','adoption'):
        locals()[name]=getattr(fixtures.ProductionTest,name)

    def scene_shot(self):
        composition(self)

    def test_scene_requires_design_text_and_preserves_exact_children(self):
        self.scene_shot();old=p.record(self.store,'scene');payload=copy.deepcopy(old['payload']);payload['blocks']=[]
        with self.assertRaises(ValueError):
            self.put({'object_id':'scene','kind':'AV_SCENE','expected_version':1,'payload':payload})
        payload['blocks']=[{'id':'purpose','text':'新版场意图'}]
        self.put({'object_id':'scene','kind':'AV_SCENE','expected_version':1,'payload':payload})
        self.assertEqual(p.record(self.store,'scene')['payload']['shots'],old['payload']['shots'])
        self.assertEqual(p.record(self.store,revision_id=old['id'])['payload'],old['payload'])

    def test_exact_historical_context_survives_a_new_shot(self):
        self.scene_shot();old=self.ref('shot');self.put(self.requirement(scope='shot'))
        self.media();self.put(self.adoption(scope='shot'))
        shot=p.record(self.store,'shot')
        self.put({'object_id':'shot','kind':'AV_SHOT','expected_version':1,'payload':{**shot['payload'],'framing':'新版特写'}})
        before=bd.context(self.store,'shot',old['revision_id']);after=bd.context(self.store,'shot')
        self.assertEqual(len(before['requirements']),1);self.assertEqual(len(before['adoptions']),1)
        self.assertEqual(after['requirements'],[]);self.assertEqual(after['adoptions'],[])
        self.assertEqual(before['ancestors'][1],self.ref('scene'))
        self.assertEqual(bd.catalog(self.store)['shots'][0]['id'],old['revision_id'])

    def test_applicability_is_neither_occurrence_nor_actual_input(self):
        self.scene_shot();self.put(self.entity());self.put(self.requirement())
        self.put(self.spec('shared','RELATION',relation_type='applicability',scope=self.ref('shot'),subject=self.ref('dialogue'),basis='production_choice',reason='shared demand'))
        context=bd.context(self.store,'shot')
        self.assertEqual([r['object_id'] for r in context['requirements']],['dialogue'])
        self.assertFalse(context['entities']);self.assertFalse(context['adoptions'])
        self.assertEqual(bd.materials(self.store,episode='episode',scene='scene')['total'],1)
        self.assertFalse(bd.materials(self.store,episode='other')['items'])
        summary=bd.summary(self.store,'scene')
        self.assertEqual(summary['descendant_positions'],[self.ref('shot')]);self.assertEqual(summary['direct_requirements'],[])

    def test_historical_chain_does_not_follow_current_input_lock(self):
        self.scene_shot();old_lock=self.ref('lock');old=self.ref('scene')
        before=bd.context(self.store,'scene')['ancestors']
        self.store.put_object('other-episode','EPISODE',{'title':'later','blocks':[],'scenes':[]})
        lock=p.record(self.store,'lock')
        self.put({'object_id':'lock','kind':'INPUT_LOCK','expected_version':1,'payload':{**lock['payload'],'episodes':[self.ref('other-episode')]}})
        self.assertEqual(bd.context(self.store,'scene',old['revision_id'])['ancestors'],before)
        self.assertIn(old_lock,before)
        scene=p.record(self.store,'scene')
        with self.assertRaises(ValueError):
            self.put({'object_id':'scene','kind':'AV_SCENE','expected_version':1,'payload':{**scene['payload'],'input_lock':self.ref('lock')}})

    def test_occurrence_does_not_imply_material_use_and_source_validation_is_atomic(self):
        self.scene_shot();self.put(self.entity())
        self.put(self.spec('occ','RELATION',relation_type='occurrence',scope=self.ref('shot'),subject=self.ref('songbook'),mode='mention',basis='source_fact',reason='spoken only',sources=[self.source]))
        context=bd.context(self.store,'shot')
        self.assertEqual(context['entities'][0]['object_id'],'songbook')
        self.assertEqual(context['occurrences'][0]['mode'],'mention')
        self.assertEqual(bd.summary(self.store,'scene')['derived_entities'],[self.ref('songbook')])
        shot=p.record(self.store,'shot');payload=copy.deepcopy(shot['payload']);payload['sources'][0]['block_ids']=['absent']
        with self.assertRaises(ValueError):self.put({'object_id':'shot','kind':'AV_SHOT','expected_version':1,'payload':payload})
        self.assertEqual(p.record(self.store,'shot')['id'],shot['id'])

if __name__=='__main__':unittest.main()
