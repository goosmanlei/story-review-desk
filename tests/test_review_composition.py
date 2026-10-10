import copy
import hashlib
import unittest

from review_desk.review_composition import attach, composition
from review_desk.review_text import production_text_blocks


class ReviewCompositionTest(unittest.TestCase):
    def setUp(self):
        self.row = dict(id='exact', object_id='character', payload={
            'blocks': [{'id': 'identity', 'text': '准备。她看见🐍，停步。'}]})
        block = production_text_blocks(self.row['payload'])[0]
        self.spec = {'format': 'exact-review-composition-v1', 'entries': {'exact': {
            'object_id': 'character', 'requires': ['exact-companion'],
            'sources': {block['id']: {'sha256': hashlib.sha256(block['text'].encode()).hexdigest(),
                                     'disposition': 'display', 'reason': '动作保留准确区间'}},
            'sections': [{'label': '动作', 'parts': [{'block_id': block['id'], 'start': 3, 'end': 11}]}]}}}

    def test_unicode_original_offsets_and_companions_are_preserved(self):
        result = composition(self.row, self.spec)
        self.assertEqual(result['sections'][0]['parts'][0],
                         dict(block_id='identity', start=3, end=11, text='她看见🐍，停步。'))
        self.assertEqual(result['requires'], ['exact-companion'])

    def test_changed_original_and_unaccounted_block_fail_closed(self):
        for mutation in ('text', 'new-block'):
            row = copy.deepcopy(self.row)
            if mutation == 'text':
                row['payload']['blocks'][0]['text'] += '新句'
            else:
                row['payload']['blocks'].append({'id': 'extra', 'text': '不可丢失的新决定'})
            before = copy.deepcopy(row['payload'])
            attach({'record': row}, self.spec)
            self.assertNotIn('review_composition', row)
            self.assertIn('review_composition_error', row)
            self.assertEqual(row['payload'], before)

    def test_invalid_owner_range_or_disposition_cannot_show_partial_arrangement(self):
        for change in ('owner', 'range', 'disposition'):
            spec = copy.deepcopy(self.spec)
            entry = spec['entries']['exact']
            if change == 'owner':
                entry['object_id'] = 'other'
            elif change == 'range':
                entry['sections'][0]['parts'][0]['end'] = 999
            else:
                entry['sources']['identity']['disposition'] = 'represented'
            with self.assertRaises(ValueError):
                composition(self.row, spec)

    def test_other_revision_never_inherits_arrangement(self):
        row = {**self.row, 'id': 'new-revision'}
        self.assertIsNone(composition(row, self.spec))
