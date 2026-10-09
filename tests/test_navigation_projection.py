import unittest
from review_desk import ui_projection as ui, production as p, business_codes
import test_audiovisual as fixtures


class NavigationProjectionTest(unittest.TestCase):
    setUp=fixtures.AudiovisualTest.setUp
    tearDown=fixtures.AudiovisualTest.tearDown
    spec=fixtures.AudiovisualTest.spec
    put=fixtures.AudiovisualTest.put
    ref=fixtures.AudiovisualTest.ref
    setup_story=fixtures.AudiovisualTest.setup_story
    shot=fixtures.AudiovisualTest.shot
    composition=fixtures.AudiovisualTest.composition
    need=fixtures.AudiovisualTest.need

    def test_direct_shot_code_and_action_respect_filter_intersection(self):
        self.composition();self.put(self.need('front'),self.need('side'))
        shot=p.record(self.store,'av-shot')
        code=business_codes.code(next(r for r in business_codes.visible_codes(self.store) if r['object_id']=='av-shot'))
        for query in (code.lower(),shot['payload']['action_start']):
            result=ui.material_list(self.store,search=query,grouped=True,compact=True)
            self.assertEqual({i['object_id'] for i in result['items']},{'front','side'})
            self.assertEqual(ui.material_list(self.store,search=query,media='audio',grouped=True)['total'],0)
            self.assertEqual(ui.material_list(self.store,search=query,episode='episode',scene='second',grouped=True)['total'],2)
            self.assertEqual(ui.material_list(self.store,search=query,scene='absent',grouped=True)['total'],0)

    def test_exact_historical_card_has_full_design_and_only_its_materials(self):
        self.composition();old=self.ref('av-shot');self.put(self.need('front'))
        new=self.shot();new['expected_version']=1;new['payload']['framing']='新版特写';self.put(new)
        result=ui.card(self.store,'av-shot',old['revision_id'])['position_review']
        self.assertEqual(result['record']['id'],old['revision_id'])
        self.assertEqual(len(result['shots']),1)
        item=result['shots'][0]
        self.assertEqual(item['record']['payload']['framing'],'中景，人物双手与歌本同框')
        self.assertEqual({i['object_id'] for i in item['context']['materials']},{'front'})
        with self.assertRaisesRegex(KeyError,'unknown production object or revision'):ui.card(self.store,'av-shot','unavailable-revision')
        with self.assertRaisesRegex(KeyError,'unknown production object or revision'):ui.card(self.store,'unavailable-object')
