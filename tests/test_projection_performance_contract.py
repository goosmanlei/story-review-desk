"""Independent projection probes. Run from desk: PYTHONPATH=.:tests python3 PATH -v.

Every fixture owns a TemporaryDirectory. No formal instance or cloud is used.
"""
import copy
import io
import json
from pathlib import Path
import subprocess
import sys
import types
import unittest
from unittest.mock import patch

import test_reference_candidates as candidate_fixture
import test_editing_review as review_fixture
from review_desk import production as p, read_cache, shot_references as sr
from review_desk import resources, reference_candidates, editing_review as review
from review_desk import production_media as media
from review_desk.entity_contract import entity_workspace, _entity_workspace, direct_materials_many
from review_desk.editing_api import dispatch
from review_desk.store import canonical, Conflict



class WorkspaceProbe(unittest.TestCase):
    def setUp(self):
        self.f = candidate_fixture.ReferenceCandidatesTest('test_workspace_receipt_matches_current_entity_reader')
        self.f.setUp()
        self.f.prepare()

    def tearDown(self):
        self.f.tearDown()

    def test_deleted_selected_original_is_rechecked_and_selection_rejects(self):
        f = self.f
        sr.select(f.store, f.request())
        read_cache.attach(f.store)

        def issues(cached=True):
            with p.read_scope(f.store):
                value = (entity_workspace if cached else _entity_workspace)(
                    f.store, 'songbook', deferred=True, material_id='need-wet-overall')
                need = next(n for n in value['requirements'] if n['object_id'] == 'need-wet-overall')
                return need['review_shot_slots'][0]['issues']

        self.assertEqual(issues(), [])
        component = p.record(f.store, 'generated')['payload']['components'][0]
        media.asset_path(f.root, component['file']).unlink()
        actual = issues()
        self.assertTrue(actual)
        self.assertEqual(actual, issues(False))
        before = copy.deepcopy(p.record(f.store, 'need-wet-overall'))
        with self.assertRaises((ValueError, OSError)):
            sr.select(f.store, f.request(candidate='second', operation='missing-original-selection'))
        self.assertEqual(p.record(f.store, 'need-wet-overall'), before)

    def test_cloud_candidate_summary_never_materializes_originals(self):
        f = self.f
        component = p.record(f.store, 'generated')['payload']['components'][0]
        with patch.object(resources, 'settings', return_value={'provider': 'oss'}), \
             patch.object(resources, 'descriptor', return_value=component), \
             patch.object(resources, 'materialize', side_effect=AssertionError('downloaded original')) as downloads, \
             patch.object(reference_candidates, 'asset_path', side_effect=AssertionError('opened original')) as opens:
            value = reference_candidates.summaries(f.store, 'need-full-overall')
        self.assertEqual(len(value['candidates']), 2)
        self.assertEqual([o['availability'] for c in value['candidates'] for o in c['originals']], ['unknown', 'unknown'])
        self.assertEqual((downloads.call_count, opens.call_count), (0, 0))



class TextAndCatalogProbe(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        review_fixture.TimelineReviewTest.setUpClass()

    @classmethod
    def tearDownClass(cls):
        review_fixture.TimelineReviewTest.tearDownClass()

    def setUp(self):
        self.f = review_fixture.TimelineReviewTest('test_legal_unnamed_tracks_and_half_open_ranges')
        self.f.setUp()

    def tearDown(self):
        self.f.tearDown()

    def test_catalog_summary_get_and_legacy_contract(self):
        f = self.f
        legacy = dispatch(f.store, f.root, 'catalog', {})
        summary = dispatch(f.store, f.root, 'catalog', {'summary': '1'})
        self.assertEqual(summary['episodes'], legacy['episodes'])
        refs = lambda value: [(r['object_id'], r['id']) for r in value['outputs']]
        self.assertEqual(refs(summary), refs(legacy))
        self.assertEqual(set(legacy), {'episodes', 'projects', 'outputs', 'jobs'})
        selected = summary['outputs'][0]
        full = dispatch(f.store, f.root, 'get', {'object_id': selected['object_id'], 'revision_id': selected['id']})
        self.assertEqual(full, legacy['outputs'][0])
        self.assertTrue(selected['summary'])
        self.assertEqual(set(selected['payload']), {'title', 'project'})
        self.assertFalse(f.store.db.in_transaction)
        self.assertFalse(hasattr(f.store, '_production_reads'))

    def test_text_cache_preserves_each_entry_live_owner_and_physical_identity(self):
        f = self.f
        project = copy.deepcopy(f.project)
        project['subtitles'] = [{'id': 's1', 'start_frame': 4, 'end_frame': 20, 'text': '第一条'},
                                {'id': 's2', 'start_frame': 20, 'end_frame': 40, 'text': '第二条'}]
        source = media.ingest(f.root, io.BytesIO(canonical(project).encode()), 'project.json')
        source['id'] = 'project'
        payload = {**f.payload, 'project': project, 'components': [source]}
        rid = f.store._insert_object('text-film', 'EPISODE_FILM', payload)
        entries = [{**e, 'entry_id': 'entry-' + e['element_id'], 'uses': []}
                   for e in review.elements(project)[1] if e['element_type'] == 'subtitle']
        document = {'format': 'episode-text-layer-v1', 'output': {'object_id': 'text-film', 'revision_id': rid},
                    'snapshot': payload['snapshot'], 'project_digest': review.checksum(project),
                    'spec': project['spec'], 'source_component': source, 'entries': entries, 'origin': f.origin}
        component = media.ingest(f.root, io.BytesIO(canonical(document).encode()), 'text-layer.json')
        asset_id = f.store._insert_object('text-asset', 'ASSET', {
            'format': 'production-asset-v1', 'title': '字层', 'media_type': 'project',
            'components': [component], 'text_layer': document,
            'subjects': [{k: v for k, v in f.origin.items() if k != 'kind'}]})
        with f.store.db:
            f.store.db.execute('INSERT INTO production_submissions VALUES (?,?,?,?,?)',
                               ('text-op', '{}', review.checksum({}), 'test', '2026-01-01'))
            f.store.db.execute('INSERT INTO production_candidates VALUES (?,?,?,?)',
                               ('text-candidate', 'text-op', 'text-asset', '2026-01-01'))
        bound = {'asset': {'object_id': 'text-asset', 'revision_id': asset_id}, 'candidate_id': 'text-candidate',
                 'component': component, 'origin': f.origin, 'material_id': 'text-asset',
                 'submission_sha256': review.checksum({}), 'entry_id': 'entry-s1'}
        with p.read_scope(f.store), patch.object(media, 'validate_component', wraps=media.validate_component) as validation:
            review.verify_binding(f.store, bound, live=True)
            review.verify_binding(f.store, {**bound, 'entry_id': 'entry-s2'}, live=True)
            self.assertEqual(validation.call_count, 1)
            with self.assertRaises(Conflict):
                review.verify_binding(f.store, {**bound, 'entry_id': 'foreign-entry'}, live=True)
            with patch.object(review, 'material_origin', return_value=(
                    {'object_id': 'moved', 'revision_id': 'moved-rid', 'kind': 'AV_SHOT'}, 'text-asset')):
                with self.assertRaises(Conflict):
                    review.verify_binding(f.store, bound, live=True)
            media.asset_path(f.root, component['file']).write_bytes(b'x' * component['bytes'])
            with self.assertRaises(ValueError):
                review.verify_binding(f.store, bound, live=True)


if __name__ == '__main__':
    unittest.main()
