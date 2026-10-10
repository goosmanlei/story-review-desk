"""Exact segmented text opinions, persistence and historical compatibility."""
import copy
import tempfile
import unittest
from pathlib import Path

from review_desk.bundle import export, restore
from review_desk.polish import build_context
from review_desk.store import Conflict, Store
from test_methods import seed
from test_review import SOURCE


def combined(parts):
    return dict(type='text', block_id=parts[0]['block_id'], start=parts[0]['start'],
                end_block_id=parts[-1]['end_block_id'], end=parts[-1]['end'],
                quote='\n'.join(p['quote'] for p in parts), segments=parts)


class ComposedSelectionTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.store = Store(self.root / '.runtime/review.sqlite3')
        self.addCleanup(self.store.close)
        self.blocks = [{'id': 'a', 'text': '甲𪎊乙。\n隐藏字\n后段。'},
                       {'id': 'gap', 'text': '未选拆镜'}, {'id': 'b', 'text': '米铺😀空间。'}]
        self.store.put_source({**SOURCE, 'assets': [], 'blocks': self.blocks})
        self.parts = [self.part('a', 0, 4), self.part('b', 0, 6)]

    def part(self, block, start, end):
        text = next(b['text'] for b in self.blocks if b['id'] == block)
        return dict(block_id=block, end_block_id=block, start=start, end=end, quote=text[start:end])

    def test_one_opinion_lifecycle_export_restore_and_exact_unicode(self):
        anchor = combined(self.parts)
        comment = self.store.create_comment(dict(source_id='fixture', anchor=anchor, body='两个片段一起讨论', id='segmented'))
        self.assertEqual(comment['anchor'], anchor)
        self.store.change_comment('segmented', 'CLOSE', 1)
        self.store.change_comment('segmented', 'REOPEN', 2)
        self.assertEqual(len(self.store.comments()), 1)
        export(self.store, self.root / 'export')
        restored = Store(self.root / 'restored/.runtime/review.sqlite3')
        self.addCleanup(restored.close)
        restore(restored, self.root / 'export')
        self.assertEqual(restored.comments(), self.store.comments())
        self.assertEqual(restored.events(), self.store.events())
        self.assertTrue(restored.context()[0]['anchor_state']['valid'])

    def test_reordered_and_same_block_omissions_are_valid(self):
        for parts in [list(reversed(self.parts)), [self.part('a', 0, 4), self.part('a', 9, 12)]]:
            self.store.validate_anchor('fixture', combined(parts))

    def test_no_envelope_gap_bad_quote_overlap_nested_range_or_invalid_unicode(self):
        anchor = combined(self.parts)
        bad = []
        for field, value in [('quote', '甲𪎊乙。\n未选拆镜\n米铺😀空间。'), ('start', True), ('end', 2)]:
            bad.append({**anchor, field: value})
        wrong = copy.deepcopy(anchor); wrong['segments'][1]['quote'] = '米铺\ud83d'; bad.append(wrong)
        bad.append(combined([self.part('a', 0, 4), self.part('a', 1, 3)]))
        bad.append({**anchor, 'segments': [anchor, self.parts[1]]})
        bad.append({**anchor, 'segments': []})
        for value in bad:
            with self.subTest(value=value), self.assertRaises((ValueError, Conflict)):
                self.store.validate_anchor('fixture', value)

    def test_historical_contiguous_opinion_and_object_revision_protection(self):
        old = self.store.put_object('document', 'STORY', {'blocks': self.blocks})
        old_ref = old['revision']
        anchor = {'type': 'text', 'block_id': 'a', 'end_block_id': 'b', 'start': 0, 'end': 6,
                  'quote': '\n'.join(b['text'] for b in self.blocks)}
        self.store.create_comment(dict(target_object_id='document', target_revision_id=old_ref, anchor=anchor, body='原连续评论'))
        new = self.store.put_object('document', 'STORY', {'blocks': [{'id': 'changed', 'text': '新稿'}]}, 1)
        self.assertTrue(self.store.anchor_state('document', old_ref, anchor)['valid'])
        self.store.put_object('other', 'STORY', {'blocks': self.blocks})
        for obj, rev in [('other', old_ref), ('document', new['revision'])]:
            with self.assertRaises((ValueError, Conflict)):
                self.store.validate_target(obj, rev, combined(self.parts))

    def test_polish_required_quote_preserves_all_passages_and_the_single_intent(self):
        seed(self.store)
        context = build_context(self.store, 'fixture', combined(self.parts), '一起讨论这两段的措辞')['context']
        self.assertEqual(context['selected_quote'], '甲𪎊乙。\n米铺😀空间。')
        self.assertEqual(context['anchor'], {k: v for k, v in combined(self.parts).items() if k != 'quote'})


if __name__ == '__main__':
    unittest.main()
