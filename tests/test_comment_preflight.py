"""Real comment preflight regression with private text originals and cloud doubles.

Run from desk: PYTHONPATH=.:tests python3 PATH -v.
COMMENT_PREFLIGHT_EXPECT_FAILURE=1 reproduces the older HEAD's two cold-read failures.
No real network, credentials, formal SQLite, or service is used.
"""
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path.cwd()))
sys.path.insert(0, str(Path.cwd() / 'tests'))
import test_editing_review as fixtures
from review_desk import editing as edit, editing_review as review
from review_desk import production_media as media, resources
from review_desk.store import canonical, Conflict, Store

BASELINE = os.environ.get('COMMENT_PREFLIGHT_EXPECT_FAILURE') == '1'
RESULTS = {}


class CommentPreflightFollowup(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixtures.TimelineReviewTest.setUpClass()

    @classmethod
    def tearDownClass(cls):
        fixtures.TimelineReviewTest.tearDownClass()

    def setUp(self):
        self.f = fixtures.TimelineReviewTest('test_legal_unnamed_tracks_and_half_open_ranges')
        self.f.setUp()
        self.store, self.root = self.f.store, self.f.root
        self.requests, self.bodies, self.data = [], [], {}

    def tearDown(self):
        self.f.tearDown()

    def prepare(self, *, associated=False, offline=True):
        project = copy.deepcopy(self.f.project)
        project['subtitles'] = [{'id': 's1', 'start_frame': 4, 'end_frame': 40, 'text': '真实字层字幕'}]
        source = media.ingest(self.root, io.BytesIO(canonical(project).encode()), 'project.json')
        source['id'] = 'project'
        original = {**self.f.payload, 'project': project, 'components': [self.f.payload['components'][0], source]}
        rid = self.store._insert_object('text-source-film', 'EPISODE_FILM', original)
        entries = [{**e, 'entry_id': 'entry-' + e['element_id'], 'uses': []}
                   for e in review.elements(project)[1] if e['element_type'] == 'subtitle']
        document = {'format': 'episode-text-layer-v1',
                    'output': {'object_id': 'text-source-film', 'revision_id': rid},
                    'snapshot': original['snapshot'], 'project_digest': review.checksum(project),
                    'spec': project['spec'], 'source_component': source,
                    'entries': entries, 'origin': self.f.origin}
        self.text_component = media.ingest(self.root, io.BytesIO(canonical(document).encode()), 'text-layer.json')
        asset_id = self.store._insert_object('text-asset', 'ASSET', {
            'format': 'production-asset-v1', 'title': '字层', 'media_type': 'project',
            'components': [self.text_component], 'text_layer': document,
            'subjects': [{k:v for k,v in self.f.origin.items() if k != 'kind'}]})
        with self.store.db:
            self.store.db.execute('INSERT INTO production_submissions VALUES (?,?,?,?,?)',
                ('text-operation', '{}', review.checksum({}), 'test', '2026-01-01'))
            self.store.db.execute('INSERT INTO production_candidates VALUES (?,?,?,?)',
                ('text-candidate', 'text-operation', 'text-asset', '2026-01-01'))
        bound = review.binding(self.store, {'asset': {'object_id':'text-asset', 'revision_id':asset_id},
            'candidate_id':'text-candidate', 'component':self.text_component}, entry_id='entry-s1')
        if associated:
            self.output = edit.read(self.store, 'text-source-film', rid)
            projected = review.review(self.store, 'text-source-film', rid)
            for element in projected['elements']:
                if element['element_type'] == 'subtitle':
                    element.pop('unavailable', None)
                    element['binding'] = bound
            value = {'format':review.FORMAT, 'title':'准确字层关联', 'output':review.ref(self.output),
                     'version':1, 'previous':None, 'elements':projected['elements']}
            value['digest'] = review.checksum(value)
            self.association = review.append_association(self.store, value)
        else:
            final_project = copy.deepcopy(project)
            final_project['subtitles'][0]['material_ref'] = bound
            payload = {**original, 'project':final_project}
            final_rid = self.store._insert_object('text-final-film', 'EPISODE_FILM', payload)
            self.output = edit.read(self.store, 'text-final-film', final_rid)
        self.projection = review.review(self.store, self.output['object_id'], self.output['id'])
        self.assertFalse(any(e.get('unavailable') for e in self.projection['elements']), self.projection)
        selection = review.selection_elements(self.projection['elements'], ['text:subtitles'], 4, 40)
        self.anchor = {'type':'time', 'component_id':'clean', 'asset_file':self.f.payload['components'][0]['file'],
            'start_seconds':4/24, 'end_seconds':40/24,
            'edit_selection':{'snapshot':self.output['payload']['snapshot'],
                'association':self.projection['association'], 'start_frame':4, 'end_frame':40,
                'tracks':['text:subtitles'], 'track_titles':['字幕'], 'elements':selection}}
        self.request = {'id':'private-range-comment', 'target_object_id':self.output['object_id'],
                        'target_revision_id':self.output['id'], 'anchor':self.anchor, 'body':'保留准确字层范围'}

        # Switch this already-built fixture to a cold, exact-version OSS catalog.
        config = dict(format=resources.FORMAT, provider='oss', instance_id='preflight-case',
            project='preflight-case', bucket='preflight-case-bucket', region='cn-hongkong', cache_bytes=8*1024*1024)
        (self.root/'config').mkdir(exist_ok=True)
        (self.root/'config/instance.json').write_text(json.dumps({'id':'preflight-case'}))
        (self.root/'config/resource-storage.json').write_text(json.dumps(config))
        bundle = self.root/'resource-bundle'; bundle.mkdir()
        self.entries = {}
        for path in (self.root/'export/assets').iterdir():
            data = path.read_bytes(); sha = hashlib.sha256(data).hexdigest()
            spec = dict(sha256=sha, verified_sha256=sha, bytes=len(data), key='preflight-case/originals/'+sha,
                        version_id='private-version-'+sha[:12], mime=media.MIMES[path.suffix])
            self.entries['export/assets/'+path.name] = spec
            self.data[spec['key']] = data
            (bundle/sha).write_bytes(data)
        (self.root/'config/resource-catalog.json').write_text(json.dumps({**config, 'entries':self.entries}))
        self.text_spec = self.entries['export/assets/'+self.text_component['file']]
        # Keep real materialize/_remote_hash/SHA/lease behavior; fake only SDK request/client transport.
        for replacement in (
            patch.dict(os.environ, {'REVIEW_RESOURCES_OFFLINE':'1' if offline else '0'}),
            patch.dict(sys.modules, {'alibabacloud_oss_v2':SimpleNamespace(GetObjectRequest=lambda **kw:SimpleNamespace(**kw))}),
            patch.object(resources, 'client', return_value=SimpleNamespace(get_object=self.get_object)),
        ):
            replacement.start()
            self.addCleanup(replacement.stop)

    def get_object(self, request):
        self.assertFalse(self.store.db.in_transaction, 'network download occurred under the write transaction')
        spec = next(s for s in self.entries.values() if s['key'] == request.key)
        self.assertEqual(request.version_id, spec['version_id'])
        self.assertEqual(request.bucket, 'preflight-case-bucket')
        self.requests.append(request)
        class Body:
            def __init__(body, data):body.data=data;body.closed=False
            def iter_bytes(body, chunk_size):yield body.data[:7];yield body.data[7:]
            def close(body):body.closed=True
        body = Body(self.data[request.key]); self.bodies.append(body)
        return SimpleNamespace(body=body, content_type=spec['mime'])

    def assert_clean(self, expected_comments=0):
        self.assertEqual(len(self.store.comments()), expected_comments)
        self.assertFalse(self.store.db.in_transaction)
        self.assertIsNone(resources._leases.get())
        self.assertIsNone(media._physical_hashes.get())
        directory = resources._cache_dir(self.root)
        self.assertFalse(list(directory.glob('*.part')))
        self.assertFalse(list(directory.glob('*.reserve')))

    def cold_creation(self, offline):
        self.prepare(offline=offline)
        phases = []
        original = review.validate_new_anchor
        def observe(*args, **kwargs):
            phases.append(self.store.db.in_transaction)
            return original(*args, **kwargs)
        with patch.object(review, 'validate_new_anchor', side_effect=observe):
            if BASELINE:
                with self.assertRaisesRegex(ValueError, 'resource was not preflighted before the database transaction'):
                    self.store.create_comment(self.request)
                self.assertEqual(phases, [True])
                self.assert_clean()
            else:
                value = self.store.create_comment(self.request)
                self.assertEqual(value['anchor'], self.anchor)
                self.assertEqual(phases, [False, True])
                self.assert_clean(1)
        text_downloads = sum(r.key == self.text_spec['key'] for r in self.requests)
        self.assertEqual(text_downloads, 0 if offline or BASELINE else 1)
        self.assertTrue(all(body.closed for body in self.bodies))
        RESULTS['offline' if offline else 'mock_cloud'] = {'validation_in_transaction':phases,
            'text_downloads':text_downloads, 'all_cloud_bodies_closed':all(b.closed for b in self.bodies),
            'comments':len(self.store.comments()), 'scope_cleanup':True,
            'reproduced_existing_failure':BASELINE}

    def test_cold_offline_text_range_preflight(self):
        self.cold_creation(True)

    def test_cold_mock_cloud_text_range_preflight(self):
        self.cold_creation(False)

    @unittest.skipIf(BASELINE, 'post-fix safety validation')
    def test_missing_offline_text_is_rejected_before_begin(self):
        self.prepare()
        (self.root/'resource-bundle'/self.text_spec['sha256']).unlink()
        trace=[];self.store.db.set_trace_callback(trace.append)
        try:
            with self.assertRaisesRegex(FileNotFoundError, 'exact offline resource is unavailable'):
                self.store.create_comment(self.request)
        finally:self.store.db.set_trace_callback(None)
        self.assertFalse(any(q.upper().startswith('BEGIN') for q in trace), trace)
        self.assert_clean()
        RESULTS['missing_original']={'rejected_before_begin':True,'comments':0}

    @unittest.skipIf(BASELINE, 'post-fix safety validation')
    def test_text_original_changed_after_preflight_rolls_back(self):
        self.prepare()
        original = review.validate_new_anchor
        phases=[]
        def mutate(*args, **kwargs):
            phases.append(self.store.db.in_transaction)
            value=original(*args, **kwargs)
            if not self.store.db.in_transaction:
                path=media.asset_path(self.root, self.text_component['file'])
                path.write_bytes(b'X'*path.stat().st_size)
            return value
        with patch.object(review, 'validate_new_anchor', side_effect=mutate):
            with self.assertRaisesRegex(ValueError, 'leased resource was changed'):
                self.store.create_comment(self.request)
        self.assertEqual(phases,[False,True])
        self.assert_clean()
        RESULTS['changed_original']={'transaction_rejected':True,'comments':0,'scope_cleanup':True}

    def next_association(self, store):
        value=copy.deepcopy(self.association['payload'])
        value.update(version=2, previous=review.ref(self.association), title='关联确认第二版')
        value.pop('digest');value['digest']=review.checksum(value)
        return review.append_association(store,value)

    @unittest.skipIf(BASELINE, 'post-fix safety validation')
    def test_new_association_after_preflight_rejects_stale_selection(self):
        self.prepare(associated=True)
        other=Store.open_existing(self.store.db_path)
        try:
            original=review.validate_new_anchor;phases=[]
            def mutate(*args,**kwargs):
                phases.append(self.store.db.in_transaction)
                value=original(*args,**kwargs)
                if not self.store.db.in_transaction:self.next_association(other)
                return value
            with patch.object(review,'validate_new_anchor',side_effect=mutate):
                with self.assertRaisesRegex(Conflict,'素材关联已更新'):
                    self.store.create_comment(self.request)
            self.assertEqual(phases,[False,True])
            self.assertEqual(len(review.associations(self.store,self.output)),2)
            self.assert_clean()
        finally:other.close()
        RESULTS['concurrent_association']={'other_connection_committed':True,'transaction_rejected':True,'comments':0}

    @unittest.skipIf(BASELINE, 'post-fix safety validation')
    def test_saved_comment_replay_survives_new_association(self):
        self.prepare(associated=True)
        first=self.store.create_comment(self.request)
        self.next_association(self.store)
        with patch.object(review,'validate_new_anchor',side_effect=AssertionError('saved comment must return before new-anchor validation')):
            replay=self.store.create_comment(self.request)
        self.assertEqual(replay,first)
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM comment_events').fetchone()[0],1)
        self.assert_clean(1)
        RESULTS['saved_replay']={'same_comment':True,'comment_events':1,'new_anchor_check_skipped':True}


if __name__ == '__main__':
    run=unittest.main(exit=False)
    target=os.environ.get('COMMENT_PREFLIGHT_RESULT_PATH')
    if target and run.result.wasSuccessful():Path(target).write_text(json.dumps(RESULTS,ensure_ascii=False,indent=2)+'\n')
    raise SystemExit(0 if run.result.wasSuccessful() else 1)
