"""Synthetic files and receipts only: no provider requests or creative results."""
import base64
import copy
import io
import json
import shutil
import unittest

import test_generation as fixtures
import test_production_breakdown as breakdown
from review_desk import production as p, generation as g, material_plans as mp, shot_references as sr
from review_desk import production_acceptance as acceptance
from review_desk.production_media import ingest
from review_desk.store import Store, Conflict
from review_desk.bundle import export, restore


class VideoPreparationTest(unittest.TestCase):
    setUp = fixtures.GenerationTest.setUp
    tearDown = fixtures.GenerationTest.tearDown
    for name in ('spec', 'put', 'ref', 'change'):
        locals()[name] = getattr(fixtures.GenerationTest, name)
    scene_shot = breakdown.BreakdownTest.scene_shot

    def prepare(self):
        self.scene_shot()
        raw = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVcQAAAAASUVORK5CYII=')
        component = ingest(self.root, io.BytesIO(raw), 'synthetic-one-pixel.png')
        self.put(self.spec('synthetic-origin', 'CALL', method='recording', tool='synthetic-fixture-only', status='submitted', inputs=[], outputs=[], lineage={'i2i_depth':0,'references':[]}))
        for name in ('start', 'end'):
            self.put(self.spec(name, 'REQUIREMENT', scope=self.ref('shot'), slot=name, media_type='image', required=True,
                               purpose='合成夹具，不是作品素材', usage='generation_input', entities=[], states=[], specification={}))
            self.put(self.spec(name+'-file', 'ASSET', media_type='image', subjects=[], states=[], components=[component],
                               production=self.ref('synthetic-origin'), lineage={'i2i_depth': 0, 'references': []}, candidate_requirements=[self.ref(name)]))
        self.execution = {'channel': 'pippit-tool-cli', 'mode': 'first_last_frame', 'start_constraint': 'fixed'}
        plan = {'format':g.PLAN, 'method':'generate', 'model':'Seedance_2.5', 'execution':self.execution,
                'parameters':{'duration':20, 'resolution':'720p', 'aspect_ratio':'adaptive', 'generate_type':1},
                'prompt':'@图片1 固定起点；@图片2 固定终点。仅测试参数及文件闭环。',
                'inputs':[{'reference':self.ref(name), 'selection_state':'unselected', 'role':role, 'use':'合成角色'}
                          for name, role in (('start','first_frame'),('end','last_frame'))],
                'output':{'name':'合成视频方案', 'description':'绝不请求提供方', 'review_criteria':['仅契约测试']}, 'blockers':[]}
        self.put(self.spec('video', 'REQUIREMENT', scope=self.ref('shot'), slot='video', media_type='video', required=True,
                           purpose='合成闭环', usage='editorial', entities=[], states=[], specification={}, generation=plan))

    def select(self, index, operation):
        row = p.record(self.store, 'video'); version = mp.snapshot(self.store,'video')[0]
        definition = version.get('definition_records',{}).get('call') or row
        item = sr.inputs_for(self.store, definition)[index]
        name = ('start', 'end')[index]
        return sr.select(self.store, {'id':operation, 'requirement_id':'video', 'expected_revision':row['id'], 'plan_number':mp.snapshot(self.store,'video')[0]['number'],
                         'index':index, 'input_key':sr.input_key(item), 'material_id':name, 'number':1,
                         'candidate':self.ref(name+'-file'), 'component_id':'original'})

    def approve(self):
        for name in ('video',):
            current = acceptance.snapshot(self.store, name)
            if not current['accepted']:
                acceptance.decide(self.store, {'object_id':name, 'expected_revision':current['target']['revision_id'],
                    'expected_decision':acceptance.ref(current['decision']) if current['decision'] else None,
                    'action':'accept', 'actor':'合成夹具测试'})

    def test_selection_package_exact_registration_history_and_restore(self):
        self.prepare(); self.approve()
        self.assertFalse(g.readiness(self.store, 'video')['ready'])
        self.select(0, 'select-start'); self.select(1, 'select-end')
        self.assertEqual(p.record(self.store,'video')['payload']['generation']['execution'], self.execution)
        self.assertFalse(g.readiness(self.store, 'video')['ready']) # edits require fresh content acceptance
        self.approve()
        path = self.root/'prepared'
        g.write_package(self.store, 'video', path)
        package = json.loads((path/'manifest.json').read_text())
        self.assertTrue(package['input_contract']['verified'])
        self.assertEqual(package['execution'], self.execution)
        self.assertEqual([i['role'] for i in package['inputs']], ['first_frame', 'last_frame'])
        self.assertEqual([i['plan_input_index'] for i in package['inputs']], [1, 2])
        for i in package['inputs']:
            self.assertTrue((path/i['path']).is_file())
            self.assertEqual(i['material_selection']['candidate_revision_id'], i['asset']['revision_id'])
        call = self.spec('synthetic-call', 'CALL', method='generation', status='submitted', tool='pippit-tool-cli',
            generation_requirement=package['requirement'], generation_acceptances=package['acceptances'], outputs=[],
            inputs=[{**i['asset'], 'component_id':i['component']['id'], 'role':i['role']} for i in package['inputs']],
            **{k:package[k] for k in ('model','parameters','prompt','execution')})
        for field, value in [('tool','another-channel'), ('execution',{**self.execution,'mode':'reference'}),
                             ('parameters',{**package['parameters'],'aspect_ratio':'16:9'}),
                             ('inputs',list(reversed(call['payload']['inputs'])))]:
            bad=copy.deepcopy(call); bad['payload'][field]=value
            with self.assertRaises(Conflict):self.put(bad)
        self.put(call)
        original = copy.deepcopy(p.record(self.store,'synthetic-call')['payload'])
        self.select(0, 'select-after-submission')
        self.assertEqual(mp.snapshot(self.store,'video')[0]['number'], 2)
        self.assertEqual(p.record(self.store,'video')['payload']['generation']['execution'], self.execution)
        self.assertEqual(p.record(self.store,'synthetic-call')['payload'], original)
        self.change('synthetic-call', status='failed') # known local fixture, no real request was made
        with self.assertRaises(Conflict):self.change('synthetic-call', execution={**self.execution,'mode':'reference'})
        export(self.store, self.root/'export')
        recovered_root=self.root/'recovered'; shutil.copytree(self.root/'export', recovered_root/'export')
        recovered=Store(recovered_root/'.runtime/review.sqlite3')
        try:
            restore(recovered,recovered_root/'export')
            self.assertEqual(mp.dump(recovered),mp.dump(self.store))
            self.assertEqual(p.record(recovered,'synthetic-call')['payload'],p.record(self.store,'synthetic-call')['payload'])
        finally:recovered.close()
