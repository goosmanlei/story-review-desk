import copy
import json
from pathlib import Path
import shutil
import subprocess
import sys
import unittest

import test_complete_states as fixtures
from review_desk import entity_review as er, production as p
from review_desk.bundle import export, restore
from review_desk.store import Conflict, Store


class EntityReviewTest(unittest.TestCase):
    setUp = fixtures.CompleteStatesTest.setUp
    tearDown = fixtures.CompleteStatesTest.tearDown
    spec = fixtures.CompleteStatesTest.spec
    put = fixtures.CompleteStatesTest.put
    ref = fixtures.CompleteStatesTest.ref
    entity = fixtures.CompleteStatesTest.entity
    media = fixtures.CompleteStatesTest.media
    full = fixtures.CompleteStatesTest.full
    setup_full = fixtures.CompleteStatesTest.setup_full
    associate = fixtures.CompleteStatesTest.associate

    def review(self, media=None):
        old = next((r for r in p.current_records(self.store) if r['object_id'] == 'submission'), None)
        row = self.spec('submission', 'REPRESENTATION', review_model=er.MODEL,
                        entities=[self.ref('songbook')], states=[self.ref(s) for s in ('full', 'wet')],
                        media=media or [], sources=[], choices=[], unknowns=[])
        row['expected_version'] = old['version'] if old else 0
        return row

    def accept(self, target=None, oid='accept'):
        return self.spec(oid, 'JUDGMENT', target=target or self.ref('submission'), verdict='accepted', actor='测试用户', reason='仅技术测试：认可送审整体')

    def test_explicit_media_exact_ranges_candidates_and_acceptance_are_independent(self):
        self.setup_full(); self.media(); self.associate(states=('full', 'wet'), range={'start_seconds': .1, 'end_seconds': .9})
        selection = {'id':'voice-full', 'state': self.ref('full'), 'asset': self.ref('voice'), 'component_id':'original', 'role':'overall', 'label':'整体现状', 'range':{'start_seconds':.1,'end_seconds':.9}}
        wrong = copy.deepcopy(selection); wrong['range']['end_seconds'] = .8
        with self.assertRaisesRegex(ValueError, 'exact state coverage'): self.put(self.review([wrong]))
        self.put(self.review([selection, {**selection, 'id':'voice-wet', 'state':self.ref('wet')}]))
        first = er.snapshot(self.store, 'songbook')
        self.assertEqual(len(first['media']), 2)
        self.assertEqual(len(first['comment_targets']), 5)  # entity, two states, shared asset, submission
        self.assertEqual(first['status'], 'pending')
        self.put(self.accept())
        accepted_ref = self.ref('submission')
        asset = p.record(self.store, 'voice'); payload = copy.deepcopy(asset['payload']); payload['blocks'][0]['text'] = '新候选，未送审'
        self.put({'object_id':'voice', 'kind':'ASSET', 'expected_version':asset['version'], 'payload':payload})
        latest = er.snapshot(self.store, 'songbook')
        self.assertEqual(latest['status'], 'accepted')
        self.assertEqual(latest['media'][0]['record']['id'], selection['asset']['revision_id'])
        self.assertEqual(p.current_records(self.store, {'RELATION'}), [])
        self.store.create_comment({'target_object_id':'full','target_revision_id':self.ref('full')['revision_id'], 'anchor':{'type':'global'}, 'body':'认可后意见不撤销认可'})
        self.assertEqual(er.snapshot(self.store, 'songbook')['status'], 'accepted')
        self.put(self.review([{**selection, 'asset':self.ref('voice')}]))
        updated = er.snapshot(self.store, 'songbook')
        self.assertEqual(updated['status'], 'pending')
        self.assertEqual(updated['previous_accepted']['submission']['id'], accepted_ref['revision_id'])
        self.assertEqual(updated['previous_accepted']['media'][0]['record']['id'], selection['asset']['revision_id'])

    def test_complete_membership_exact_versions_and_atomic_stale_acceptance(self):
        self.setup_full()
        omitted = self.review(); omitted['payload']['states'].pop()
        with self.assertRaises(Conflict): self.put(omitted)
        duplicate = self.review(); duplicate['payload']['states'].append(self.ref('full'))
        with self.assertRaises(ValueError): self.put(duplicate)
        self.put(self.review()); old = self.ref('submission')
        self.put(self.full('new-form'))
        before = self.store.objects()
        with self.assertRaises(Conflict): self.put(self.entity('first-in-batch'), self.accept())
        self.assertEqual(before, self.store.objects())
        self.assertEqual(er.snapshot(self.store, 'songbook')['status'], 'outdated')
        new = self.review(); new['payload']['states'].append(self.ref('new-form')); self.put(new)
        with self.assertRaises(Conflict): self.put(self.accept(old))
        self.put(self.accept())
        form = self.full(); form['expected_version'] = 1; form['payload']['dimensions']['condition'] = '变化后'
        self.put(form)
        self.assertEqual(er.snapshot(self.store, 'songbook')['status'], 'outdated')
        with self.assertRaises(Conflict): self.put(self.accept(oid='stale'))
        self.assertEqual(len(p.current_records(self.store, {'JUDGMENT'})), 1)

    def test_identity_changes_foreign_states_duplicate_submission_and_read_only_query(self):
        self.setup_full(); self.put(self.entity('other'))
        foreign = self.full('other-form'); foreign['payload']['entity'] = self.ref('other'); self.put(foreign)
        bad = self.review(); bad['payload']['states'].append(self.ref('other-form'))
        with self.assertRaises(ValueError): self.put(bad)
        self.put(self.review())
        duplicate = self.review(); duplicate['object_id'] = 'another'; duplicate['expected_version'] = 0
        with self.assertRaises(Conflict): self.put(duplicate)
        entity = self.entity(); entity['expected_version'] = 1; entity['payload']['facts'].append('新身份事实'); self.put(entity)
        before = self.store.revisions()
        snapshot = er.snapshot(self.store, 'songbook')
        self.assertEqual(snapshot['status'], 'outdated')
        self.assertNotEqual(snapshot['entity']['id'], self.ref('songbook')['revision_id'])
        self.assertEqual(before, self.store.revisions())
        with self.assertRaises(Conflict): self.put(self.accept())

    def test_bundle_restores_historical_acceptance_and_cli_reads_same_aggregate(self):
        self.setup_full(); self.put(self.review(), self.accept({'object_id':'submission','revision_id':'@submission'}))
        old = self.ref('submission')
        form = self.full(); form['expected_version'] = 1; form['payload']['dimensions']['condition'] = '另一个版本'; self.put(form)
        self.put(self.review())
        before = er.snapshot(self.store, 'songbook')
        export(self.store, self.root / 'export')
        recovered = self.root / 'recovered'; shutil.copytree(self.root / 'export', recovered / 'export')
        other = Store(recovered / '.runtime/review.sqlite3')
        try:
            restore(other, recovered / 'export')
            self.assertEqual(er.snapshot(other, 'songbook'), before)
            self.assertIsNotNone(er.snapshot(other, 'songbook', old['revision_id'])['accepted'])
        finally: other.close()
        (self.root / 'config').mkdir(); (self.root / 'config/instance.json').write_text(json.dumps({'id':'test','title':'test'}))
        result = subprocess.run([sys.executable, '-m', 'review_desk', '--instance', str(self.root), 'production-entity-review', 'songbook'], check=True, capture_output=True, text=True)
        self.assertEqual(json.loads(result.stdout), before)


if __name__ == '__main__': unittest.main()
