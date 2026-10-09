"""Synthetic contract fixtures only: no provider, account or generated media."""
import copy
import unittest
from review_desk import input_contracts as ic, video_modes as vm, material_plans as mp


class VideoModesTest(unittest.TestCase):
    def contract(self, model='Seedance_2.5', mode='reference', kinds=('image', 'audio'), **changes):
        parameters={'duration':20 if model=='Seedance_2.5' else 12,'resolution':'720p','aspect_ratio':'16:9','task_type':'reference'}
        execution={'channel':'pippit-tool-cli','mode':mode,'start_constraint':'reference'}
        if mode=='first_last_frame':
            parameters.pop('task_type');parameters.update(generate_type=1,aspect_ratio='adaptive')
            execution['start_constraint']='fixed'
        parameters.update(changes)
        roles = ['first_frame','last_frame'] if mode=='first_last_frame' else ['reference_'+kind for kind in kinds]
        inputs=ic.label_inputs([{'role':roles[i] if i<len(roles) else 'reference_'+kind,
            'component':{'mime':kind+'/synthetic','duration_seconds':4},
            'asset':{'object_id':'synthetic-'+str(i),'revision_id':'fixture'}} for i,kind in enumerate(kinds)])
        prompt=' '.join('@'+v['label'] for v in inputs)
        return ic.check(model,prompt,inputs,parameters=parameters,execution=execution)

    def test_reference_models_and_long_audio_contract_only(self):
        for model in ('Seedance_2.5','seedance2.0_fast_vision'):
            value=self.contract(model)
            self.assertTrue(value['verified'],value)
            self.assertIn('不证明账号',value['mode_check']['scope'])
        self.assertFalse(self.contract('seedance2.0_fast_vision',duration=20)['verified'])
        self.assertFalse(self.contract('seedance2.0_fast_vision',kinds=('audio',))['verified'])
        self.assertFalse(self.contract(draft=True)['verified'])
        self.assertFalse(self.contract(model='unknown-model',kinds=())['verified'])

    def test_original_in_memory_negative_is_incompatible(self):
        # Exact reviewed negative: 2.5 / 20 s / 720p / 16:9 / type 1 /
        # one image + four seconds of audio. It was never a real user call.
        value=self.contract(mode='first_last_frame',aspect_ratio='16:9')
        self.assertEqual(value['mode_check']['status'],'incompatible')
        self.assertFalse(value['verified'])
        self.assertTrue(any('两张图' in v for v in value['issues']))
        self.assertTrue(any('adaptive' in v for v in value['issues']))
        self.assertTrue(any('audio' in v for v in value['issues']))

    def test_fixed_endpoints_and_no_rule_transfer_to_20(self):
        self.assertTrue(self.contract(mode='first_last_frame',kinds=('image','image'))['verified'])
        value=self.contract('seedance2.0_fast_vision',mode='first_last_frame',kinds=('image','image'))
        self.assertFalse(value['verified'])
        self.assertEqual(value['mode_check']['status'],'unknown')
        value=self.contract('seedance2.0_fast_vision',mode='first_last_frame',kinds=('image','image','audio'),aspect_ratio='16:9')
        self.assertEqual(value['mode_check']['status'],'unknown')
        self.assertFalse(any('禁止独立' in v or '仅支持画幅' in v for v in value['issues']))

    def test_unknown_or_contradictory_mode_cannot_look_verified(self):
        params={'duration':12,'resolution':'720p','aspect_ratio':'16:9','task_type':'reference'}
        for execution in (None,{'channel':'another','mode':'reference','start_constraint':'reference'},
                          {'channel':'pippit-tool-cli','mode':'future','start_constraint':'none'}):
            self.assertFalse(ic.check('Seedance_2.5','text',[],parameters=params,execution=execution)['verified'])
        value=vm.check('Seedance_2.5',params,{'channel':'pippit-tool-cli','mode':'reference','start_constraint':'fixed'},[])
        self.assertEqual(value['status'],'incompatible')
        execution={'channel':'pippit-tool-cli','mode':'first_last_frame','start_constraint':'fixed'}
        value=vm.check('Seedance_2.5',{**params,'task_type':'auto','generate_type':1,'aspect_ratio':'adaptive'},execution,
                       [{'media_type':'image','role':'last_frame'},{'media_type':'image','role':'first_frame'}])
        self.assertEqual(value['status'],'incompatible')

    def test_execution_and_roles_are_part_of_definition_without_migrating_legacy(self):
        plan={'method':'generate','model':'x','parameters':{},'prompt':'x','inputs':[]}
        original=mp.scheme({'generation':plan},'REQUIREMENT')
        self.assertNotIn('execution',original)
        new=copy.deepcopy(plan);new['execution']={'channel':'pippit-tool-cli','mode':'reference','start_constraint':'reference'}
        self.assertNotEqual(original,mp.scheme({'generation':new},'REQUIREMENT'))
        new['inputs']=[{'reference':{'object_id':'x','revision_id':'y'},'role':'reference_image'}]
        changed=copy.deepcopy(new);changed['inputs'][0]['role']='first_frame'
        self.assertNotEqual(mp.scheme({'generation':new},'REQUIREMENT'),mp.scheme({'generation':changed},'REQUIREMENT'))


if __name__=='__main__':unittest.main()
