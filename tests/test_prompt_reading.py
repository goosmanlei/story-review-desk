import copy
import hashlib
import unittest

from review_desk.prompt_reading import attach, reading
from review_desk.review_text import production_text_blocks


class PromptReadingTest(unittest.TestCase):
    def setUp(self):
        self.prompt = '技术前言\n动作：看她一眼🐍，接回歌本。\n1. 阿蘅：几天？\n技术后文'
        self.row = {'id': 'old-revision', 'object_id': 'video', 'payload': {
            'scope': {'object_id': 'shot', 'revision_id': 'old-shot'},
            'generation': {'prompt': self.prompt}}}
        start = self.prompt.index('看她')
        self.entry = {'object_id': 'video', 'scope': self.row['payload']['scope'],
                      'field': 'generation.prompt',
                      'sha256': hashlib.sha256(self.prompt.encode()).hexdigest(),
                      'parts': [{'start': start, 'end': self.prompt.index('\n', start), 'role': 'action'}]}
        self.spec = {'format': 'exact-prompt-reading-v1', 'entries': {'old-revision': self.entry}}

    def test_excerpt_and_comment_range_are_the_original_unicode_prompt(self):
        before = copy.deepcopy(self.row['payload'])
        result = reading(self.row, self.spec)
        block = next(b for b in production_text_blocks(self.row['payload']) if b['field'] == result['field'])
        self.assertEqual(result['block_id'], block['id'])
        part = result['parts'][0]
        self.assertEqual(part['text'], '看她一眼🐍，接回歌本。')
        self.assertEqual(block['text'][part['start']:part['end']], part['text'])
        self.assertEqual(self.row['payload'], before)
        self.assertNotIn('text', self.entry['parts'][0])

    def test_new_head_cannot_receive_an_old_reading(self):
        self.assertIsNone(reading({**self.row, 'id': 'new-head'}, self.spec))
        snapshot = {'record': copy.deepcopy(self.row), 'current': {**self.row, 'id': 'new-head'}}
        attach(snapshot, self.spec)
        self.assertIn('review_reading', snapshot['record'])
        self.assertNotIn('review_reading', snapshot['current'])

    def test_wrong_text_owner_or_scope_fails_without_replacing_the_prompt(self):
        for mutation in ('text', 'owner', 'scope'):
            row = copy.deepcopy(self.row)
            if mutation == 'text': row['payload']['generation']['prompt'] += '改动'
            elif mutation == 'owner': row['object_id'] = 'another'
            else: row['payload']['scope']['revision_id'] = 'new-shot'
            before = copy.deepcopy(row['payload'])
            with self.assertRaises(ValueError): reading(row, self.spec)
            attach(row, self.spec)
            self.assertIn('review_reading_error', row)
            self.assertNotIn('review_reading', row)
            self.assertEqual(row['payload'], before)

    def test_invalid_or_overlapping_ranges_never_hide_full_text(self):
        for parts in ([], [{'start': -1, 'end': 2, 'role': 'action'}],
                      [{'start': 1, 'end': 2, 'role': 'invented'}],
                      [{'start': 1, 'end': 9, 'role': 'action'}, {'start': 8, 'end': 12, 'role': 'voice'}],
                      [{'start': True, 'end': 2, 'role': 'action'}]):
            spec = copy.deepcopy(self.spec)
            spec['entries']['old-revision']['parts'] = parts
            with self.assertRaises(ValueError): reading(self.row, spec)

    def test_actual_call_is_mapped_only_by_its_own_revision_and_text(self):
        row = {'id': 'call-revision', 'object_id': 'call', 'payload': {
            'format': 'production-call-v1', 'prompt': self.prompt}}
        entry = {**self.entry, 'object_id': 'call', 'scope': None, 'field': 'call.prompt'}
        spec = {'format': 'exact-prompt-reading-v1', 'entries': {row['id']: entry}}
        self.assertEqual(reading(row, spec)['field'], 'call.prompt')
        self.assertIsNone(reading(row, self.spec))
