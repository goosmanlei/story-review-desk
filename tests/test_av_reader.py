"""Exact scene-selection reads in the current model; no production data writes."""
import copy
from unittest.mock import patch
import unittest
import test_production_current as fixtures
from audiovisual_fixture import composition
from review_desk import production as p, ui_projection, entity_contract, production_current_migration as migration
from review_desk.production_breakdown import material_comment_targets_many


class AvReaderTest(unittest.TestCase):
    for name in ("setUp","tearDown","spec","put","ref","entity","full","need","setup_plans","media"):
        locals()[name] = getattr(fixtures.CurrentProductionTest, name)
    # Reuse only fixture helpers, not the parent's unrelated test methods.
    def setup_reader(self):
        self.setup_plans(); composition(self)
        for oid, slot in [('camera','camera-main'), ('reverse','camera-reverse'), ('video','video')]:
            item=self.need('wet');item['object_id']=oid
            item['payload'].update(scope=self.ref('shot'),slot=slot,title=oid,usage='editorial',specification={})
            item['payload']['generation']=copy.deepcopy(p.record(self.store,'need-full-overall')['payload']['generation'])
            self.put(item)
        migration.apply(self.store,migration.plan(self.store))

    def test_reader_prepares_only_selection_keeps_all_direct_needs_and_exact_inputs(self):
        self.setup_reader()
        with p.read_scope(self.store), patch('review_desk.ui_projection.material_entries',side_effect=AssertionError('whole library')):
            data=ui_projection.scene(self.store,'scene',view='reader',material_id='reverse')
        item=data['shots'][0];workspace=item['entity_workspace']
        self.assertNotIn('context',item)
        self.assertEqual({n['object_id'] for n in workspace['requirements']},{'camera','reverse','video'})
        selected=next(n for n in workspace['requirements'] if n['object_id']=='reverse')
        self.assertEqual(selected['payload']['generation']['prompt'],p.record(self.store,'reverse')['payload']['generation']['prompt'])
        self.assertEqual(set(workspace['deferred_materials']),{'camera','video'})
        self.assertTrue(all('generation' not in n['payload'] for n in workspace['requirements'] if n['object_id']!='reverse'))
        with p.read_scope(self.store):
            result=entity_contract.shot_workspace(self.store,'shot',deferred=True,material_id='video')
        self.assertNotIn('video',result['deferred_materials'])
        with self.assertRaises(ValueError):entity_contract.shot_workspace(self.store,'shot',deferred=True,material_id='need-full-overall')
        with self.assertRaises(ValueError):entity_contract.shot_workspace(self.store,'shot',deferred=True,material_id='video',candidate_revision='missing')

    def test_directory_includes_current_plans_and_exact_external_candidates_without_upstream(self):
        self.setup_reader()
        self.put(self.spec('camera-result','ASSET',media_type='audio',subjects=[self.ref('songbook')],states=[],
            external_source={'kind':'external','description':'disposable test tone'},components=[self.media()],lineage={},candidate_requirements=[self.ref('camera')],state_coverage=[]))
        shot=p.record(self.store,'shot');expected={p.record(self.store,oid)['id'] for oid in ('camera','reverse','video','camera-result')}
        with p.read_scope(self.store):
            result=material_comment_targets_many(self.store,[shot])[shot['id']]
        self.assertEqual({r['id'] for r in result},expected)
        self.assertNotIn(p.record(self.store,'need-full-overall')['id'],expected)

    def test_summary_does_not_expand_unselected_submission_during_transport_decoration(self):
        self.setup_reader()
        self.put(self.spec('camera-result','ASSET',media_type='audio',subjects=[self.ref('songbook')],states=[],
            external_source={'kind':'external','description':'disposable test tone'},components=[self.media()],lineage={},
            candidate_requirements=[self.ref('camera')],state_coverage=[]))
        from review_desk.business_codes import annotate
        with p.read_scope(self.store):
            data=entity_contract.shot_workspace(self.store,'shot',deferred=True,material_id='video')
            with patch('review_desk.production_current.submission',side_effect=AssertionError('unselected snapshot')):
                decorated=annotate(self.store,data)
        candidate=decorated['material_versions']['camera'][0]['results'][0]
        self.assertNotIn('submission',candidate)
        self.assertEqual(candidate['candidate_number'],1)
        self.assertTrue(candidate['deferred_detail'])

    def test_disconnect_stops_before_other_shot_details_are_assembled(self):
        self.setup_reader()
        with p.read_scope(self.store):
            self.store._production_reads['cancel_check']=lambda: (_ for _ in ()).throw(p.ReadCancelled())
            with patch('review_desk.entity_contract.shot_workspace') as reader:
                with self.assertRaises(p.ReadCancelled):ui_projection.scene(self.store,'scene',view='reader')
                reader.assert_not_called()

    def test_shared_camera_keeps_lazy_reader_after_semantic_merge(self):
        self.setup_reader()
        from audiovisual_fixture import shot
        from review_desk import semantic_consolidation as sem
        self.put(shot(self, 'other-shot'))
        item=self.need('wet');item['object_id']='other-camera'
        item['payload'].update(scope=self.ref('other-shot'),slot='camera-main',title='same camera',
                              usage='editorial',specification={})
        self.put(item)
        sem.apply(self.store,sem.prepare(self.store,{'merges':[{
            'source':'other-camera','target':'camera','reason':'Reviewed same camera across adjacent shots'}]}))
        other={'object_id':'other-shot','id':self.ref('other-shot')['revision_id']}
        with p.read_scope(self.store), patch('review_desk.entity_contract.p.record',side_effect=AssertionError('full record')):
            needs=entity_contract.direct_materials(self.store,other,metadata=True)
        self.assertEqual([n['object_id'] for n in needs],['camera'])
        with p.read_scope(self.store):
            data=entity_contract.shot_workspace(self.store,'other-shot',deferred=True,material_id='camera')
            targets=material_comment_targets_many(self.store,[p.record(self.store,'other-shot')])[other['id']]
        self.assertEqual(data['requirements'][0]['object_id'],'camera')
        self.assertIn('prompt',data['requirements'][0]['payload']['generation'])
        self.assertEqual({row['object_id'] for row in targets},{'camera'})
