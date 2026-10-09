"""准确选段与全文的只读契约；夹具不是作品版本。"""
import copy
from pathlib import Path
import tempfile
import unittest
from review_desk import production as p
from review_desk.store import Store


class SourceExcerptContextTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.tmp.name) / 'review.sqlite3')
        self.payload = {'title': '准确场夹具', 'blocks': [
            {'id': bid, 'text': bid + '原文'} for bid in ['d', 'a', 'c', 'b', 'e']],
            'scenes': [{'id': 's', 'block_ids': ['a', 'b', 'c', 'd', 'e']}]}
        self.revision = self.store.put_object('ep', 'EPISODE', self.payload)['revision']
        self.ref = {'object_id': 'ep', 'revision_id': self.revision, 'scene_id': 's', 'block_ids': ['d', 'b']}

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def test_excerpt_follows_scene_order_and_marks_only_real_gaps(self):
        before = copy.deepcopy(self.ref)
        detail = p.source_excerpt(self.store, self.ref)
        self.assertEqual([b['id'] for b in detail['blocks']], ['b', 'd'])
        self.assertEqual(detail['scene_context'], {'block_count': 5, 'omissions': [
            {'before_block_id': 'b', 'count': 1}, {'before_block_id': 'd', 'count': 1},
            {'before_block_id': None, 'count': 1}]})
        self.assertEqual(self.ref, before)

    def test_full_scene_keeps_old_revision_and_original_citation(self):
        current = copy.deepcopy(self.payload)
        current['blocks'][0]['text'] = '新版改词'
        self.store.put_object('ep', 'EPISODE', current, expected_version=1)
        detail = p.source_excerpt(self.store, self.ref, full_scene=True)
        self.assertFalse(detail['is_current'])
        self.assertEqual([b['id'] for b in detail['blocks']], ['a', 'b', 'c', 'd', 'e'])
        self.assertEqual(detail['blocks'][3]['text'], 'd原文')
        self.assertEqual(detail['highlight_block_ids'], ['d', 'b'])
        self.assertEqual(detail['reference'], self.ref)
        self.assertEqual(detail['scene_context']['omissions'], [])

    def test_complete_and_contiguous_citations_have_no_false_internal_gap(self):
        for ids, expected in [(['a', 'b', 'c', 'd', 'e'], []),
                (['b', 'c'], [{'before_block_id': 'b', 'count': 1}, {'before_block_id': None, 'count': 2}])]:
            detail = p.source_excerpt(self.store, {**self.ref, 'block_ids': ids})
            self.assertEqual(detail['scene_context']['omissions'], expected)

    def test_block_only_reference_resolves_only_unique_exact_scene(self):
        ref = {k: v for k, v in self.ref.items() if k != 'scene_id'}
        self.assertEqual(p.source_excerpt(self.store, ref, True)['scene']['id'], 's')
        ambiguous = copy.deepcopy(self.payload)
        ambiguous['scenes'].append({'id': 'other', 'block_ids': ['b', 'd']})
        revision = self.store.put_object('ep', 'EPISODE', ambiguous, expected_version=1)['revision']
        ambiguous_ref = {**ref, 'revision_id': revision}
        detail = p.source_excerpt(self.store, ambiguous_ref)
        self.assertIsNone(detail['scene'])
        self.assertIsNone(detail['scene_context'])
        self.assertIn('唯一准确场', detail['context_unavailable_reason'])
        with self.assertRaisesRegex(ValueError, 'exact scene'):
            p.source_excerpt(self.store, ambiguous_ref, True)
        # An older unique scene stays resolvable despite the new ambiguity.
        self.assertEqual(p.source_excerpt(self.store, ref, True)['scene']['id'], 's')

    def test_invalid_or_incomplete_scene_refuses_substitution(self):
        for ref in [{**self.ref, 'scene_id': 'absent'}, {**self.ref, 'block_ids': ['absent']}]:
            with self.assertRaises(ValueError):
                p.source_excerpt(self.store, ref, True)
        broken = copy.deepcopy(self.payload)
        broken['blocks'] = [b for b in broken['blocks'] if b['id'] != 'e']
        revision = self.store.put_object('ep', 'EPISODE', broken, expected_version=1)['revision']
        with self.assertRaisesRegex(ValueError, 'incomplete'):
            p.source_excerpt(self.store, {**self.ref, 'revision_id': revision}, True)

    def test_historical_source_document_is_not_replaced_by_current_text(self):
        source = {'id': 'doc', 'title': '资料', 'version_type': 'original', 'origin': 'fixture',
                  'source_url': 'https://example.test/doc', 'collected_at': '2026-10-09', 'notes': '测试夹具', 'blocks': [{'id': 'x', 'text': '旧文'}], 'assets': []}
        self.store.put_source(source)
        revision = p.record(self.store, 'doc')['id']
        # The existing source replacement boundary cannot lend newer text.
        self.store.db.execute("UPDATE sources SET revision=revision+1 WHERE id='doc'")
        with self.assertRaisesRegex(ValueError, 'historical source text is unavailable'):
            p.source_excerpt(self.store, {'object_id': 'doc', 'revision_id': revision, 'block_ids': ['x']})
