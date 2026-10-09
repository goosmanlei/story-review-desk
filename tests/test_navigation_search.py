import unittest
from unittest.mock import patch
from review_desk import navigation_search as search


class NavigationSearchTest(unittest.TestCase):
    def test_normalized_identity_and_chinese_content(self):
        terms = [search.normalize(v) for v in ['M2624', '周家米铺', '阿蘅翻过两页']]
        for query in ('m2624', 'Ｍ２６２４', '周家米铺', '阿蘅翻过两页', ''):
            self.assertTrue(search.matches(query, terms), query)
        self.assertFalse(search.matches('M262', terms))

    def test_fields_exclude_internal_json_and_generation_prompts(self):
        payload = {'title':'歌本', 'aliases':['唱本'], 'action_end':'阿蘅翻过两页',
                   'generation':{'prompt':'secret-generation-text'}, 'scope':{'object_id':'opaque-id'}}
        terms = search.fields(payload)
        self.assertTrue(search.matches('唱本', terms))
        self.assertFalse(search.matches('opaque-id', terms))
        self.assertFalse(search.matches('secret-generation-text', terms))

    def test_material_search_follows_exact_direct_owner_only(self):
        item = {'object_id':'need', 'id':'need-old', 'canonical_material_id':'need'}
        row = {'payload':{'title':'镜头视频', 'scope':{'object_id':'shot','revision_id':'shot-old'},
                          'generation':{'inputs':[{'object_id':'unrelated'}]}}}
        owner = {'object_id':'shot','kind':'AV_SHOT','payload':{'action_start':'阿蘅翻过两页','purpose':'检查歌本'}}
        with patch.object(search.light, 'record', return_value=row), patch.object(search.light, 'ref_record', return_value=owner) as resolve:
            terms=search.material_fields(None,item,{'need':'M9999','shot':'ASH005','unrelated':'M1111'})
        resolve.assert_called_once_with(None, row['payload']['scope'])
        self.assertTrue(search.matches('ash005',terms));self.assertTrue(search.matches('阿蘅翻过两页',terms))
        self.assertFalse(search.matches('M1111',terms));self.assertFalse(search.matches('shot-old',terms))

    def test_state_explanation_is_not_a_source_shot_action(self):
        item={'object_id':'need','id':'need-old','canonical_material_id':'need'}
        row={'payload':{'title':'道具整体参考','scope':{'object_id':'state','revision_id':'state-old'}}}
        owner={'object_id':'state','kind':'STATE','payload':{'title':'挑柴扁担','production_description':'背景中阿蘅翻过两页'}}
        with patch.object(search.light,'record',return_value=row),patch.object(search.light,'ref_record',return_value=owner):
            terms=search.material_fields(None,item,{'state':'ST999'})
        self.assertTrue(search.matches('挑柴扁担',terms));self.assertTrue(search.matches('ST999',terms))
        self.assertFalse(search.matches('阿蘅翻过两页',terms))

    def test_entity_search_includes_own_aliases_and_states(self):
        entities=[{'object_id':'ferry','payload':{'title':'渡口','aliases':['旧渡头']}}]
        states=[{'object_id':'ferry-state','payload':{'title':'闭门渡口','entity':{'object_id':'ferry'}}},
                {'object_id':'other-state','payload':{'title':'别处','entity':{'object_id':'other'}}}]
        terms=search.entity_fields(entities,states,{'ferry':'EN070','ferry-state':'ST167','other-state':'ST888'})['ferry']
        for query in ('en070','旧渡头','ST167','闭门渡口'):self.assertTrue(search.matches(query,terms))
        self.assertFalse(search.matches('ST888',terms))
