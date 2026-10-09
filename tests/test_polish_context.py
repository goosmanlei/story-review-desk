"""Purpose/budget contracts only. No real model evaluation or network calls."""
import unittest
from unittest.mock import patch
from review_desk.polish import build_context, suggest
from review_desk.store import Store, canonical
from test_review import SOURCE


class FocusedContextTest(unittest.TestCase):
    def setUp(self):
        self.store = Store(':memory:')
        self.addCleanup(self.store.close)
        self.store.put_source(SOURCE)
        self.anchor = {'type': 'text', 'block_id': 'a', 'end_block_id': 'a',
                       'start': 1, 'end': 3, 'quote': '乙𪎊'}
        for num in ('一', '二', '三'):
            self.store.put_source({**SOURCE, 'id': 'novel-' + num,
                'title': '故事精修' + num + '：《故事》', 'group': 'story-refinements'})

    def test_plain_opinion_is_grounded_only_in_the_exact_target(self):
        self.store.set_configuration('PROJECT', {'current_stage': 'MATERIAL_PREPARATION',
            'story_background': '已选其他方向；过时制作进度', 'creative_background': '当前新设定'}, 0)
        result = build_context(self.store, SOURCE['id'], self.anchor, '请把疑问说得温和些')
        ctx = result['context']
        self.assertEqual([d['id'] for d in ctx['source_documents']], [SOURCE['id']])
        self.assertEqual(ctx['creative_stage']['id'], 'STORY_COMPILATION')
        self.assertNotIn('project_background', ctx)
        self.assertNotIn('过时制作进度', canonical(ctx))
        self.assertEqual(ctx['selected_quote'], '乙𪎊')

    def test_comparison_requires_a_named_version_and_carries_its_boundary(self):
        ctx = build_context(self.store, 'novel-一', self.anchor, '对比故事精修二，请把意见说清楚')['context']
        self.assertEqual([d['id'] for d in ctx['source_documents']], ['novel-一', 'novel-二'])
        self.assertEqual(ctx['source_documents'][1]['role'], 'comparison')
        self.assertIn('不定义当前对象事实', ctx['source_documents'][1]['purpose'])
        unknown = build_context(self.store, 'novel-一', self.anchor, '对比旧稿，请把意见说清楚')['context']
        self.assertEqual(len(unknown['source_documents']), 1)
        self.assertIn('不能用最新稿猜测', unknown['notices'][0])

    def test_serialized_total_counts_identity_metadata_and_escaped_text(self):
        for limit in (1000, 12000):
            before = self.store.configuration('SYSTEM')
            self.store.set_configuration('SYSTEM', {'ai_context_max_chars': limit}, before['version'])
            result = build_context(self.store, SOURCE['id'], self.anchor, '语气疑问')
            self.assertEqual(result['budget']['used'], len(canonical(result['context'])))
            self.assertLessEqual(result['budget']['used'], limit)
        before = self.store.configuration('SYSTEM')
        with self.assertRaises(ValueError):
            self.store.set_configuration('SYSTEM', {'ai_context_max_chars': 999}, before['version'])

    def test_late_long_selection_is_never_replaced_with_the_document_opening(self):
        text = '开头无关内容。' * 3000 + '准确圈选𪎊😀。' + '结尾无关内容。' * 3000
        self.store.put_source({**SOURCE, 'id': 'long', 'blocks': [{'id': 'a', 'text': text}]})
        pos = text.index('准确圈选')
        anchor = {**self.anchor, 'start': pos, 'end': pos + 8, 'quote': text[pos:pos + 8]}
        for limit in (1000, 12000):
            old = self.store.configuration('SYSTEM')
            self.store.set_configuration('SYSTEM', {'ai_context_max_chars': limit}, old['version'])
            result = build_context(self.store, 'long', anchor, '请把语气疑问表达得温和些')
            ctx = result['context']; doc = ctx['source_documents'][0]
            self.assertEqual(ctx['selected_quote'], anchor['quote'])
            self.assertEqual(ctx['anchor']['start'], pos)
            self.assertEqual(doc['text'], text[doc['start']:doc['end']])
            if doc['text']:
                self.assertIn(anchor['quote'], doc['text'])
            self.assertLessEqual(result['budget']['used'], limit)
        old = self.store.configuration('SYSTEM')
        self.store.set_configuration('SYSTEM', {'ai_context_max_chars': 1000}, old['version'])
        with self.assertRaisesRegex(ValueError, '完整圈选.*未截断圈选'):
            build_context(self.store, 'long', {**anchor, 'start': 0, 'end': 2000, 'quote': text[:2000]}, '意见')

    def test_source_metadata_and_requested_background_cannot_escape_the_budget(self):
        self.store.put_source({**SOURCE, 'id': 'large-metadata', 'origin': '长出处' * 10000})
        with self.assertRaisesRegex(ValueError, '准确目标及来源信息无法容纳'):
            build_context(self.store, 'large-metadata', self.anchor, '意见')
        self.store.set_configuration('PROJECT', {'creative_background': '背景' * 3999}, 0)
        old = self.store.configuration('SYSTEM')
        self.store.set_configuration('SYSTEM', {'ai_context_max_chars': 1000}, old['version'])
        try:
            result = build_context(self.store, SOURCE['id'], self.anchor, '请结合创作背景表达疑问')
            self.assertLessEqual(result['budget']['used'], 1000)
            self.assertNotIn('project_background', result['context'])
        except ValueError as error:
            self.assertIn('总上限', str(error))

    def test_exact_preview_is_the_model_input_and_configuration_change_invalidates_it(self):
        result = build_context(self.store, SOURCE['id'], self.anchor, '语气疑问')
        response = {'output': [{'content': [{'type': 'output_text', 'text': '[MOCK] only'}]}]}
        class Response:
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def read(self):
                import json
                return json.dumps(response).encode()
        with patch('review_desk.polish.os.environ', {'OPENAI_API_KEY': 'FAKE_LOCAL_ONLY'}), patch('review_desk.polish.urlopen', return_value=Response()) as remote:
            suggest(result)
        import json
        request = json.loads(remote.call_args.args[0].data)
        self.assertEqual(request['input'], canonical(result['context']))
        self.store.set_configuration('PROJECT', {'style': 'changed'}, 0)
        changed = build_context(self.store, SOURCE['id'], self.anchor, '语气疑问')
        self.assertNotEqual(changed['context_sha256'], result['context_sha256'])
