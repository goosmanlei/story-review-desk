import copy
import base64
import io
import json
from pathlib import Path
import shutil
import tempfile
import unittest
import wave

from review_desk import production as p
from review_desk.bundle import export, restore
from review_desk.production_media import ingest
from review_desk.store import Conflict, Store


class ProductionTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.store = Store(self.root / '.runtime/review.sqlite3')
        self.episode = self.store.put_object('episode', 'EPISODE', {
            'title': '正式分集', 'blocks': [{'id': 'a', 'text': '女孩拿起完好的歌本。'}, {'id': 'b', 'text': '歌本被水浸坏。'}],
            'scenes': [{'id': 'scene', 'block_ids': ['a', 'b']}]})
        self.source = {'object_id': 'episode', 'revision_id': self.episode['revision'], 'scene_id': 'scene', 'block_ids': ['a']}

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def spec(self, oid, kind, **fields):
        return {'object_id': oid, 'kind': kind, 'expected_version': 0, 'payload': {
            'format': 'production-' + p.KINDS[kind] + '-v1', 'title': oid,
            'blocks': [{'id': 'notes', 'text': oid + '的说明'}], **fields}}

    def put(self, *records, validate=False):
        return p.import_records(self.store, {'format': 'production-import-v1', 'records': list(records)}, validate)['records']

    def ref(self, oid):
        r = p.record(self.store, oid)
        return {'object_id': oid, 'revision_id': r['id']}

    def entity(self, oid='songbook'):
        return self.spec(oid, 'ENTITY', entity_type='prop', subtype='hand_prop', aliases=[], facts=['歌本完好'], choices=[], unknowns=[], sources=[self.source])

    def media(self, oid='voice'):
        if not any(r['object_id'] == 'recording' for r in p.current_records(self.store)):
            self.put(self.spec('recording', 'CALL', method='recording', tool='external-recorder', status='submitted', inputs=[], outputs=[]))
        buf = io.BytesIO()
        with wave.open(buf, 'wb') as wav:
            wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(48000); wav.writeframes(b'\0\0' * 48000)
        buf.seek(0)
        component = ingest(self.root, buf, 'voice.wav')
        record = self.spec(oid, 'ASSET', media_type='audio', subjects=[], states=[], components=[component], production=self.ref('recording'), lineage={})
        self.put(record)
        return component

    def requirement(self, oid='dialogue', scope='songbook'):
        return self.spec(oid, 'REQUIREMENT', scope=self.ref(scope), slot='dialogue', required=True, purpose='后期对白',
                         media_type='audio', usage='post_audio', entities=[], states=[], specification={})

    def adoption(self, oid='use', scope='songbook'):
        return self.spec(oid, 'RELATION', relation_type='adoption', scope=self.ref(scope), slot='dialogue',
                         asset=self.ref('voice'), component_id='original', usage='post_audio', reason='人工选择',
                         range={'start_seconds': 0.1, 'end_seconds': 0.9})

    def test_atomic_validation_aliases_exact_sources_and_state_coexistence(self):
        entity = self.entity()
        dry = self.put(entity, validate=True)
        self.assertEqual(len(p.current_records(self.store)), 0)
        first = self.put(entity)[0]
        self.assertEqual(dry[0]['revision'], first['revision'])
        states = [self.spec(name, 'STATE', entity=self.ref('songbook'), dimensions={'condition': name},
                            sources=[self.source], facts=[], choices=[], unknowns=[]) for name in ('dry', 'wet')]
        self.put(*states)
        self.assertEqual(len(p.current_records(self.store, {'STATE'})), 2)
        other = self.entity('other'); other['payload']['aliases'] = ['songbook']
        with self.assertRaises(Conflict): self.put(other)
        invalid = self.entity('wrong'); invalid['payload']['sources'][0]['quote'] = '不是原文'
        before = self.store.objects()
        with self.assertRaises(ValueError): self.put(self.entity('first-in-batch'), invalid)
        self.assertEqual(self.store.objects(), before)

    def test_batch_refs_and_concurrent_writers(self):
        first = self.entity()
        state = self.spec('wet', 'STATE', entity={'object_id': 'songbook', 'revision_id': '@songbook'},
                          dimensions={'condition': 'wet'}, sources=[self.source], facts=[], choices=[], unknowns=[])
        self.put(first, state)
        self.assertEqual(p.record(self.store, 'wet')['payload']['entity'], self.ref('songbook'))
        second = Store(self.store.db_path)
        try:
            first['expected_version'] = 1; first['payload']['facts'] = ['更新']
            self.put(first)
            with self.assertRaises(Conflict): p.import_records(second, {'format': 'production-import-v1', 'records': [first]})
        finally: second.close()

    def test_passed_is_not_adopted_and_new_candidate_does_not_replace(self):
        self.put(self.entity()); self.media(); self.put(self.requirement())
        self.put(self.spec('review', 'JUDGMENT', target=self.ref('voice'), verdict='passed', actor='审阅者', reason='可用'))
        self.assertFalse(p.readiness(self.store, 'songbook')['inputs_ready'])
        use = self.adoption(); self.put(use)
        selected = p.record(self.store, 'use')['payload']['asset']
        voice = p.record(self.store, 'voice')
        self.put({'object_id': 'voice', 'kind': 'ASSET', 'expected_version': 1, 'payload': {**voice['payload'], 'title': '新候选'}})
        self.assertEqual(p.record(self.store, 'use')['payload']['asset'], selected)
        self.assertTrue(p.readiness(self.store, 'songbook')['inputs_ready'])
        use['expected_version'] = 1; use['payload']['asset'] = self.ref('voice'); self.put(use)
        self.assertEqual(len(p.snapshot(self.store, object_id='use')['history']), 2)
        self.assertNotEqual(p.record(self.store, 'use')['payload']['asset'], selected)

    def test_one_asset_multiple_scopes_and_change_requires_review(self):
        self.put(self.entity(), self.entity('other')); self.media()
        self.put(self.requirement(), self.requirement('other-dialogue','other'), self.adoption(), self.adoption('other-use','other'))
        self.assertTrue(p.readiness(self.store, 'other')['inputs_ready'])
        old = self.ref('songbook')
        changed = self.entity(); changed['expected_version'] = 1; changed['payload']['facts'].append('上游新要求'); self.put(changed)
        self.assertFalse(p.readiness(self.store, 'songbook')['inputs_ready'])
        self.assertTrue(p.readiness(self.store, 'other')['inputs_ready'])
        self.assertEqual({r['object_id'] for r in p.impact(self.store, old['revision_id'])['affected']}, {'dialogue','use'})

    def test_time_comments_exact_components_ranges_and_restore(self):
        self.put(self.entity()); component = self.media(); self.put(self.requirement(), self.adoption())
        ref = self.ref('voice')
        comment = {'target_object_id': ref['object_id'], 'target_revision_id': ref['revision_id'], 'body': '此处发音',
                   'anchor': {'type':'time','component_id':'original','asset_file':component['file'],'start_seconds':0.1,'end_seconds':0.3}}
        self.store.create_comment(comment)
        wrong = copy.deepcopy(comment); wrong['anchor']['end_seconds'] = 2
        with self.assertRaises(ValueError): self.store.create_comment(wrong)
        wrong['anchor']['end_seconds'] = float('nan')
        with self.assertRaises(ValueError): self.store.create_comment(wrong)
        export(self.store, self.root / 'export')
        target = self.root / 'empty'
        shutil.copytree(self.root / 'export', target / 'export')
        restored = Store(target / '.runtime/review.sqlite3')
        try:
            restore(restored, target / 'export')
            self.assertEqual(p.snapshot(restored), p.snapshot(self.store))
            self.assertEqual(restored.comments(), self.store.comments())
            self.assertTrue(p.readiness(restored,'songbook')['inputs_ready'])
            p.write_package(restored, 'songbook', target / 'input-package')
            self.assertTrue((target / 'input-package/assets' / component['file']).is_file())
        finally: restored.close()

    def test_file_tampering_and_unknown_image_ancestry_are_rejected(self):
        self.put(self.entity()); component = self.media()
        (self.root/'export/assets'/component['file']).write_bytes(b'broken')
        with self.assertRaises(ValueError): self.put(self.spec('broken', 'ASSET', media_type='audio', subjects=[], states=[], components=[component], production=self.ref('recording'), lineage={}))
        call = self.spec('render', 'CALL', method='generation', tool='external', status='planned', inputs=[], outputs=[], lineage={'i2i_depth':3,'references':[]})
        with self.assertRaises(ValueError): self.put(call)
        call['payload']['lineage']={'i2i_depth':1,'references':[self.ref('voice')]}
        with self.assertRaises(ValueError): self.put(call)

    def image(self):
        raw = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVcQAAAAASUVORK5CYII=')
        component = ingest(self.root, io.BytesIO(raw), 'still.png')
        lineage = {'i2i_depth': 0, 'references': []}
        self.put(self.spec('draw', 'CALL', method='generation', tool='test-renderer', status='submitted',
                           inputs=[], outputs=[], lineage=lineage))
        self.put(self.spec('still', 'ASSET', media_type='image', subjects=[], states=[], components=[component],
                           production=self.ref('draw'), lineage=lineage))
        return component

    def test_actual_image_inputs_cannot_be_omitted_to_reset_lineage(self):
        self.image()
        call = self.spec('derive', 'CALL', method='generation', tool='test-renderer', status='submitted',
                         inputs=[self.ref('still')], outputs=[], lineage={'i2i_depth':0,'references':[]})
        with self.assertRaisesRegex(ValueError, 'every actual image input'): self.put(call)
        call['payload']['lineage'] = {'i2i_depth':1,'references':[self.ref('still')]}
        self.put(call)

    def test_optional_slots_and_wrong_original_type_are_not_ready(self):
        self.put(self.entity()); component = self.media()
        optional = self.requirement(); optional['payload']['required'] = False
        self.put(optional)
        self.assertFalse(p.readiness(self.store, 'songbook')['inputs_ready'])
        wrong = self.spec('wrong-type','ASSET',media_type='image',subjects=[],states=[],components=[component],
                          production=self.ref('recording'),lineage={})
        with self.assertRaisesRegex(ValueError, 'media type'): self.put(wrong)

    def test_assembly_rejects_uncovered_frames(self):
        self.image()
        self.put(self.spec('shot','SHOT_DESIGN',episode=self.ref('episode'),source=self.source,scene_id='scene',
                           number=1,purpose='验收',framing='全景',spatial='门外',action_start='静止',action_end='静止',
                           continuity='独立',duration_frames=24,fps=24,sound=[],entities=[],states=[]))
        assembly = self.spec('timeline','ASSEMBLY',fps=24,width=1920,height=1080,duration_frames=24,items=[{
            'track':'picture','start_frame':1,'duration_frames':23,'asset':self.ref('still'),
            'component_id':'original','shot':self.ref('shot')}])
        with self.assertRaisesRegex(ValueError, 'gap'): self.put(assembly)
        assembly['payload']['items'][0].update(start_frame=0,duration_frames=24)
        self.put(assembly)

    def test_native_resolution_needs_actual_pixels_and_provenance(self):
        self.put(self.entity()); self.image()
        need=self.requirement(); need['payload'].update(media_type='image',usage='generation_input',
            specification={'minimum_long_edge':3840,'native_4k':True})
        use=self.spec('use','RELATION',relation_type='adoption',scope=self.ref('songbook'),slot='dialogue',
                      asset=self.ref('still'),component_id='original',usage='generation_input',reason='技术测试')
        self.put(need,use)
        result=p.readiness(self.store,'songbook')
        self.assertFalse(result['inputs_ready'])
        self.assertIn('below_minimum_long_edge',result['requirements'][0]['issues'])
        self.assertIn('native_4k_not_verified',result['requirements'][0]['issues'])
        current=p.record(self.store,'still')
        payload=copy.deepcopy(current['payload']); payload['verification']={'native_4k_passed':True}
        self.put({'object_id':'still','kind':'ASSET','expected_version':current['version'],'payload':payload})
        use['expected_version']=1; use['payload']['asset']=self.ref('still'); self.put(use)
        result=p.readiness(self.store,'songbook')
        self.assertIn('below_minimum_long_edge',result['requirements'][0]['issues'])
        self.assertFalse(result['inputs_ready'])

    def test_revision_history_is_retained_without_false_change_alarm(self):
        first=self.store.put_object('structure','STORY',{'title':'第一稿','blocks':[]})
        second=self.store.put_object('structure','STORY',{'title':'定稿','blocks':[]},expected_version=1,
            dependencies=[{'revision_id':first['revision'],'role':'REVISES'}])
        entity=self.entity(); entity['payload']['sources'].append({'object_id':'structure','revision_id':second['revision']})
        self.put(entity); revision=self.ref('songbook')['revision_id']
        self.assertIn(first['revision'],p.dependency_closure(self.store,revision))
        self.assertEqual(p.stale_inputs(self.store,revision),[])
        self.assertEqual(p.impact(self.store,first['revision'])['affected'],[])
        self.store.put_object('structure','STORY',{'title':'实质修订','blocks':[]},expected_version=2,
            dependencies=[{'revision_id':second['revision'],'role':'REVISES'}])
        self.assertEqual([r['used_revision'] for r in p.stale_inputs(self.store,revision)],[second['revision']])

    def test_source_excerpt_preserves_historical_text_and_anchor(self):
        newer=copy.deepcopy(p.record(self.store,'episode')['payload'])
        newer['blocks'][0]['text']='女孩改为拿起木斗。'
        self.store.put_object('episode','EPISODE',newer,expected_version=1)
        excerpt=p.source_excerpt(self.store,self.source)
        self.assertFalse(excerpt['is_current'])
        self.assertEqual(excerpt['blocks'],[{'id':'a','text':'女孩拿起完好的歌本。'}])
        wrong={**self.source,'block_ids':['missing']}
        with self.assertRaises(ValueError):p.source_excerpt(self.store,wrong)

    def test_reviewed_state_rename_keeps_exact_inputs_and_expires_on_later_change(self):
        self.put(self.entity(), self.entity('other'))
        self.put(self.spec('wet', 'STATE', entity=self.ref('songbook'), dimensions={'condition':'wet'},
                           sources=[self.source], facts=['浸湿'], choices=[], unknowns=[]))
        old = self.ref('wet')
        for oid, scope in [('first', 'songbook'), ('second', 'other')]:
            need = self.requirement(oid, scope)
            need['payload']['states'] = [old]
            self.put(need)
        inputs = {oid:p.record(self.store, oid) for oid in ('first', 'second')}
        payload = copy.deepcopy(p.record(self.store, 'wet')['payload'])
        payload['title'] = '歌本·浸湿'
        self.put({'object_id':'wet', 'kind':'STATE', 'expected_version':1, 'payload':payload})
        for rec in inputs.values():
            self.assertEqual(len(p.stale_inputs(self.store, rec['id'])), 1)
        self.put(self.spec('naming-review', 'JUDGMENT', target=self.ref('wet'), verdict='impact_resolved',
                           actor='命名复核者', reason='核对正文、维度和全部引用，仅标题改名',
                           change={'old':old, 'new':self.ref('wet'), 'action':'keep', 'scope':'state_title_only'}))
        for oid, rec in inputs.items():
            self.assertEqual(p.record(self.store, oid), rec)
            self.assertEqual(p.stale_inputs(self.store, rec['id']), [])
        self.assertEqual(p.record(self.store, revision_id=old['revision_id'])['payload']['title'], 'wet')
        self.assertTrue(p.impact(self.store, old['revision_id'])['affected'])
        payload['facts'].append('书页撕裂')
        self.put({'object_id':'wet', 'kind':'STATE', 'expected_version':2, 'payload':payload})
        for rec in inputs.values():
            self.assertEqual(len(p.stale_inputs(self.store, rec['id'])), 1)

    def test_state_rename_review_cannot_exempt_content_changes_or_wrong_target(self):
        self.put(self.entity())
        self.put(self.spec('wet', 'STATE', entity=self.ref('songbook'), dimensions={'condition':'wet'},
                           sources=[self.source], facts=[], choices=[], unknowns=[]))
        old = self.ref('wet')
        payload = copy.deepcopy(p.record(self.store, 'wet')['payload'])
        payload.update(title='歌本·浸湿', facts=['正文发生修改'])
        self.put({'object_id':'wet', 'kind':'STATE', 'expected_version':1, 'payload':payload})
        review = self.spec('naming-review', 'JUDGMENT', target=self.ref('wet'), verdict='impact_resolved',
                           actor='复核者', reason='尝试命名复核',
                           change={'old':old, 'new':self.ref('wet'), 'action':'keep', 'scope':'state_title_only'})
        with self.assertRaisesRegex(ValueError, 'only a title change'):
            self.put(review)
        prior = self.ref('wet'); payload['title'] = '歌本·湿润'
        self.put({'object_id':'wet', 'kind':'STATE', 'expected_version':2, 'payload':payload})
        review['payload']['change'].update(old=prior, new=self.ref('wet'))
        with self.assertRaisesRegex(ValueError, 'exact new state target'):
            self.put(review)

    def test_selected_asset_must_cover_required_identity_and_state(self):
        self.put(self.entity()); self.image()
        self.put(self.spec('wet','STATE',entity=self.ref('songbook'),dimensions={'condition':'wet'},sources=[self.source],facts=[],choices=[],unknowns=[]))
        need=self.requirement();need['payload'].update(media_type='image',usage='generation_input',entities=[self.ref('songbook')],states=[self.ref('wet')])
        use=self.spec('use','RELATION',relation_type='adoption',scope=self.ref('songbook'),slot='dialogue',asset=self.ref('still'),component_id='original',usage='generation_input',reason='测试准确状态')
        self.put(need,use)
        issues=p.readiness(self.store,'songbook')['requirements'][0]['issues']
        self.assertIn('missing_entity_reference',issues);self.assertIn('missing_state_reference',issues)
        current=p.record(self.store,'still');payload=copy.deepcopy(current['payload'])
        payload['subjects']=[self.ref('songbook')];payload['states']=[self.ref('wet')]
        self.put({'object_id':'still','kind':'ASSET','expected_version':current['version'],'payload':payload})
        use['expected_version']=1;use['payload']['asset']=self.ref('still');self.put(use)
        self.assertTrue(p.readiness(self.store,'songbook')['inputs_ready'])
        duplicate=copy.deepcopy(need);duplicate['object_id']='duplicate-slot'
        with self.assertRaises(Conflict):self.put(duplicate)

    def test_completed_call_cannot_claim_an_unrelated_output(self):
        self.media()
        wrong=self.spec('other-call','CALL',method='recording',tool='external',status='completed',inputs=[],outputs=[self.ref('voice')])
        with self.assertRaisesRegex(ValueError,'another production call'):self.put(wrong)


if __name__ == '__main__':
    unittest.main()
