import copy
import shutil
import unittest
from unittest.mock import patch

import test_shot_references as fixtures
from review_desk import production as p, material_plans as mp, reference_paths as rp, shot_references as sr, generation as g
from review_desk.bundle import export,restore
from review_desk.store import Store


class ReferencePathsTest(unittest.TestCase):
    for name in ('setUp', 'tearDown', 'spec', 'put', 'ref', 'entity', 'full', 'need', 'media', 'change',
                 'setup_plans', 'decide', 'generate', 'scene_shot', 'prepare', 'request'):
        locals()[name] = getattr(fixtures.ShotReferenceTest, name)

    def annotate(self, path=None):
        row = self.prepare()
        payload = copy.deepcopy(row['payload'])
        payload['generation'].update(prompt='甲😀阿蘅与阿蘅', reference_links=[{
            'key': 'speaker', 'label': '阿蘅', 'purpose': '准确声线',
            'path': path or [0], 'material_id': 'need-full-overall'}],
            prompt_links=[{'start': 2, 'end': 4, 'quote': '阿蘅', 'reference_key': 'speaker'},
                          {'start': 5, 'end': 7, 'quote': '阿蘅', 'reference_key': 'speaker'}])
        return row, payload

    def test_repeated_unicode_names_bind_exact_material_and_do_not_change_model_prompt(self):
        row, payload = self.annotate()
        self.put({'object_id': 'video', 'kind': 'REQUIREMENT', 'expected_version': row['version'], 'payload': payload})
        current = p.record(self.store, 'video')
        projected = rp.project(self.store, current)
        self.assertEqual(projected[0]['canonical_material_id'], 'need-full-overall')
        self.assertEqual(projected[0]['selection_owner'], self.ref('video'))
        self.assertTrue(projected[0]['direct'])
        self.assertEqual(current['payload']['generation']['prompt'], '甲😀阿蘅与阿蘅')

    def test_restore_validates_selected_reference_with_its_exact_memberships(self):
        row,payload=self.annotate()
        self.put({'object_id':'video','kind':'REQUIREMENT','expected_version':row['version'],'payload':payload})
        sr.select(self.store,self.request())
        expected=rp.project(self.store,p.record(self.store,'video'))
        self.assertEqual(expected[0]['candidate_number'],1)
        export(self.store,self.root/'export')
        destination=self.root/'reference-restore';shutil.copytree(self.root/'export',destination/'export')
        other=Store(destination/'.runtime/review.sqlite3')
        try:
            restore(other,destination/'export')
            self.assertEqual(rp.project(other,p.record(other,'video')),expected)
            self.assertEqual(mp.dump(other),mp.dump(self.store))
        finally:other.close()

    def test_invalid_path_identity_or_span_is_rejected_before_revision_write(self):
        row, payload = self.annotate()
        corruptions = [
            lambda g: g['reference_links'][0].update(path=[9]),
            lambda g: g['reference_links'][0].update(material_id='video'),
            lambda g: g['prompt_links'][1].update(start=3),
            lambda g: g['prompt_links'][1].update(end=700),
            lambda g: g['prompt_links'][0].update(quote='别名'),
            lambda g: g['prompt_links'][0].update(reference_key='unbound'),
            lambda g: g['prompt_links'].append('invalid'),
        ]
        for corrupt in corruptions:
            bad = copy.deepcopy(payload)
            corrupt(bad['generation'])
            with self.assertRaises(ValueError):
                self.put({'object_id': 'video', 'kind': 'REQUIREMENT', 'expected_version': row['version'], 'payload': bad})
            self.assertEqual(p.record(self.store, 'video')['id'], row['id'])

    def test_indirect_owner_is_exact_upstream_and_local_write_is_rejected(self):
        row, payload = self.annotate()
        composite = copy.deepcopy(row['payload'])
        composite['slot'] = 'composite'
        composite['generation']['inputs'] = [copy.deepcopy(self.inputs[0])]
        self.put({'object_id': 'composite', 'kind': 'REQUIREMENT', 'expected_version': 0, 'payload': composite})
        payload['generation']['inputs'][0] = {'reference': self.ref('composite'), 'use': '组合素材'}
        payload['generation']['reference_links'][0]['path'] = [0, 0]
        self.put({'object_id': 'video', 'kind': 'REQUIREMENT', 'expected_version': row['version'], 'payload': payload})
        current = p.record(self.store, 'video')
        before = mp.dump(self.store)
        link = rp.project(self.store, current)[0]
        self.assertFalse(link['direct'])
        self.assertEqual(link['selection_owner'], self.ref('composite'))
        with self.assertRaisesRegex(ValueError, '间接参考'):
            sr.select(self.store, {**self.request(), 'path': [0, 0]})
        self.assertEqual(mp.dump(self.store), before)

    def test_unselected_version_still_reports_totals_and_independent_candidate(self):
        self.prepare(True)
        value = {**self.inputs[0], 'material_selection': {'material_id': 'need-full-overall',
                 'number': None, 'candidate_revision_id': self.ref('generated')['revision_id']}}
        selected = sr.slot(self.store, value, 0)
        self.assertIsNone(selected['number'])
        self.assertEqual(selected['candidate_number'], 1)
        self.assertEqual(selected['candidate_count'], 2)
        self.assertEqual(selected['version_count'], 1)
        self.assertTrue(selected['issues'])

    def test_new_reference_does_not_choose_latest_and_version_only_save_is_local(self):
        row = self.prepare()
        payload = copy.deepcopy(row['payload'])
        payload['generation']['inputs'][0]['selection_state'] = 'unselected'
        self.put({'object_id':'video','kind':'REQUIREMENT','expected_version':row['version'],'payload':payload})
        current = p.record(self.store,'video')
        selected = sr.slot(self.store,current['payload']['generation']['inputs'][0],0)
        self.assertIsNone(selected['number']);self.assertIsNone(selected['candidate_number'])
        self.assertEqual(selected['candidate_count'],2)
        before_other = copy.deepcopy(current['payload']['generation']['inputs'][1])
        request = {**self.request(), 'candidate':None}
        request.pop('component_id')
        result = sr.select(self.store,request)
        self.assertEqual(result['slots'][0]['number'],1)
        self.assertIsNone(result['slots'][0]['candidate_number'])
        self.assertEqual(result['slots'][0]['issues'],['尚未选定候选'])
        current = p.record(self.store,'video')
        self.assertEqual(current['payload']['generation']['inputs'][1],before_other)
        self.assertNotIn('selection_state',current['payload']['generation']['inputs'][0])
        self.assertTrue(sr.select(self.store,request)['already_applied'])
        final = sr.select(self.store,self.request(operation='choose-candidate'))
        self.assertEqual(final['slots'][0]['candidate_number'],1)
        self.assertEqual(final['slots'][0]['issues'],[])

    def test_historical_call_uses_its_exact_prompt_annotations_after_new_draft(self):
        row, payload = self.annotate()
        self.put({'object_id':'video','kind':'REQUIREMENT','expected_version':row['version'],'payload':payload})
        sr.select(self.store,self.request())
        plan = p.record(self.store,'video')['payload']['generation']
        exact = self.ref('video')
        call = self.spec('historic-call','CALL',method='generation',tool='historical fixture',status='unknown',
                         prepared_plan=exact,inputs=[{**v['reference'],**{k:v[k] for k in ('component_id','range','crop') if k in v}} for v in plan['inputs']],
                         outputs=[],**{k:plan[k] for k in ('model','parameters','prompt')})
        with patch.object(g,'validate_call'):
            self.put(call)
        historical = p.record(self.store,'historic-call')
        self.change('video',generation={**plan,'prompt':'后续新稿','prompt_links':[]})
        self.assertEqual(rp.annotations(self.store,historical)['prompt_links'],plan['prompt_links'])
        shown = rp.project(self.store,historical)[0]
        self.assertEqual(shown['record']['id'],self.ref('generated')['revision_id'])
        self.assertEqual(shown['selection_owner'],self.ref('historic-call'))
        different = copy.deepcopy(historical);different['payload']['prompt']='外部实际改动的 Prompt'
        self.assertFalse(rp.project(self.store,different))


if __name__ == '__main__':
    unittest.main()
