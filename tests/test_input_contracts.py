import unittest
from review_desk.input_contracts import label_inputs, check, check_declared


class InputContractsTest(unittest.TestCase):
    def media(self, kind):return {'component':{'mime':kind+'/fixture'},'asset':{'object_id':kind,'revision_id':'exact'},'range':{'start_seconds':1,'end_seconds':3}}

    def test_multi_image_order_natural_language_and_no_magic_alias(self):
        inputs=label_inputs([self.media('image'),self.media('image')])
        self.assertEqual([v['label'] for v in inputs],['图片1','图片2'])
        self.assertTrue(check('gpt-image-2-5-sunburst','沿用图片1人物，图片2背景',inputs)['verified'])
        self.assertFalse(check('gpt-image-2-5-sunburst','沿用图片1人物',inputs)['verified'])

    def test_mixed_seedance_labels_and_missing_or_phantom_reference(self):
        inputs=label_inputs([self.media('image'),self.media('audio'),self.media('image'),self.media('video')])
        self.assertEqual([v['input_index'] for v in inputs],[1,2,3,4]);self.assertEqual([v['label'] for v in inputs],['图片1','音频1','图片2','视频1'])
        self.assertTrue(check('Seedance 2.0','@图片1角色，@图片2背景，@音频1音色，@视频1动作',inputs)['verified'])
        self.assertFalse(check('Seedance 2.0','@图片1角色，@音频2声音',inputs)['verified'])
        self.assertEqual(inputs[1]['range'],{'start_seconds':1,'end_seconds':3})

    def test_seed_audio_order_limits_unknown_model_and_text_only(self):
        inputs=label_inputs([self.media('audio'),self.media('audio')])
        self.assertTrue(check('seed-audio-1.0','@音频1与@音频2',inputs)['verified'])
        self.assertFalse(check('seed-audio-1.0','@音频10与@音频2',inputs)['verified'])
        self.assertFalse(check('UNKNOWN','@音频1与@音频2',inputs)['verified'])
        self.assertTrue(check('unknown','仅文字',[])['verified'])

    def test_pending_plan_checks_size_type_and_phantom_slots_without_media(self):
        self.assertFalse(check_declared('seedance2.0_fast_vision','@图片1 @音频1',['image','audio']))
        self.assertTrue(check_declared('seedance2.0_fast_vision','字'*5001,[]))
        self.assertTrue(check_declared('Seedance_2.5','字'*15001,[]))
        self.assertTrue(check_declared('Seedance_2.5','@图片1',[]))
        self.assertTrue(check_declared('seedance2.0_fast_vision',' '.join('@图片'+str(i) for i in range(1,11)),['image']*10))
        self.assertTrue(check_declared('seedance2.0_fast_vision','只有文字',['audio']))
        self.assertTrue(check_declared('Seedance_2.5','文档',['document']))


if __name__=='__main__':unittest.main()
