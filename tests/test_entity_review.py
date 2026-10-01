import copy
import json
import shutil
import subprocess
import sys
import unittest

import test_complete_states as fixtures
from review_desk import entity_review as er, production as p
from review_desk.bundle import export, restore
from review_desk.store import Conflict, Store
from review_desk.review_text import production_text_blocks


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

    def accept(self, scope=None, oid='accept'):
        scope = scope or er.snapshot(self.store, 'songbook')['scope']
        return self.spec(oid, 'JUDGMENT', target=scope['entity'], verdict='accepted', actor='测试用户',
                         reason='仅技术测试：采纳当前版本', acceptance_model=er.ACCEPTANCE_MODEL, acceptance_scope=scope)

    def change(self, oid, fn):
        row = p.record(self.store, oid); payload = copy.deepcopy(row['payload']); fn(payload)
        self.put({'object_id':oid, 'kind':row['kind'], 'expected_version':row['version'], 'payload':payload})

    def test_current_content_needs_no_workflow_and_query_is_read_only(self):
        self.setup_full()
        before = self.store.revisions()
        snapshot = er.snapshot(self.store, 'songbook')
        self.assertEqual(snapshot['status'], 'unaccepted'); self.assertTrue(snapshot['can_accept'])
        self.assertEqual(len(snapshot['states']), 2)
        self.assertEqual(before, self.store.revisions())
        self.assertFalse(p.current_records(self.store, {'REPRESENTATION', 'JUDGMENT'}))
        self.change('songbook', lambda value: value['facts'].append('新的身份事实'))
        self.put(self.full('new-form'))
        current = er.snapshot(self.store, 'songbook')
        self.assertEqual(current['entity']['id'], self.ref('songbook')['revision_id'])
        self.assertEqual(len(current['states']), 3)
        self.assertNotEqual(snapshot['content_key'], current['content_key'])

    def test_note_comments_bind_exact_entity_and_state_fields_and_survive_restore(self):
        self.setup_full()
        saved = []
        for oid in ('songbook', 'full'):
            self.change(oid, lambda value: value.update(unknowns=['颜色尚待确认。', '补充🧵纹理与材质。']))
            revision = self.ref(oid)['revision_id']
            notes = [b for b in production_text_blocks(p.record(self.store, oid)['payload']) if b.get('field') == 'unknowns']
            anchor = {'type':'text', 'block_id':notes[0]['id'], 'end_block_id':notes[1]['id'],
                      'start':0, 'end':4, 'quote':'颜色尚待确认。\n补充🧵纹'}
            comment = self.store.create_comment({'target_object_id':oid, 'target_revision_id':revision,
                                                  'anchor':anchor, 'body':'仅技术验证：提供待确认信息'})
            with self.assertRaises(Conflict):
                self.store.validate_target(oid, revision, {**anchor, 'quote':'错误引用'})
            self.change(oid, lambda value: value.update(unknowns=['改为新的待确认事项。']))
            self.assertTrue(self.store.anchor_state(oid, revision, anchor)['valid'])
            self.assertFalse(self.store.anchor_state(oid, self.ref(oid)['revision_id'], anchor)['valid'])
            saved.append(comment)
        destination = self.root / 'restored'
        export(self.store, self.root/'export')
        shutil.copytree(self.root/'export', destination/'export')
        recovered = Store(destination/'.runtime/review.sqlite3')
        try:
            restore(recovered, destination/'export')
            for comment in saved:
                self.assertEqual(recovered.comment(comment['id']), comment)
                self.assertTrue(recovered.anchor_state(comment['target_object_id'], comment['target_revision_id'], comment['anchor'])['valid'])
        finally:
            recovered.close()

    def test_note_projection_preserves_original_blocks_and_avoids_id_collisions(self):
        payload = {'blocks':[{'id':'@review/unknowns/1', 'text':'已有正文🧵'}],
                   'facts':['已有正文🧵','事实'], 'choices':['事实','选择'],
                   'unknowns':['', '未知', '未知', None]}
        original = copy.deepcopy(payload)
        result = production_text_blocks(payload)
        self.assertEqual(result, [payload['blocks'][0],
            {'id':'@@review/facts/1','text':'事实','field':'facts','index':1},
            {'id':'@@review/choices/1','text':'选择','field':'choices','index':1},
            {'id':'@@review/unknowns/1','text':'未知','field':'unknowns','index':1}])
        self.assertEqual(payload, original)

    def test_related_candidates_visible_without_inventing_state_coverage(self):
        self.setup_full(); self.media(); self.media('project-audio')
        self.change('voice', lambda value: value.update(subjects=[self.ref('songbook')]))
        current = er.snapshot(self.store, 'songbook')
        self.assertEqual(len(current['media']), 1)
        self.assertEqual(current['media'][0]['role'], 'related')
        self.assertIsNone(current['media'][0]['state'])
        self.assertFalse(p.record(self.store, 'voice')['payload'].get('state_coverage'))
        self.assertNotIn('project-audio', str(current['scope']))
        self.associate(states=('full', 'wet'), range={'start_seconds':.1, 'end_seconds':.9})
        mapped = er.snapshot(self.store, 'songbook')
        self.assertEqual(len(mapped['media']), 2)
        self.assertEqual(mapped['media'][0]['range'], {'start_seconds':.1, 'end_seconds':.9})
        self.assertEqual(len(mapped['comment_targets']), 4)  # two forms share one asset

    def test_acceptance_allows_comments_and_new_candidate_does_not_inherit_it(self):
        self.setup_full(); self.media(); self.associate(states=('full', 'wet'))
        before = er.snapshot(self.store, 'songbook'); self.put(self.accept(before['scope']))
        self.store.create_comment({'target_object_id':'full','target_revision_id':self.ref('full')['revision_id'], 'anchor':{'type':'global'}, 'body':'采纳后仍可补充意见'})
        self.assertEqual(er.snapshot(self.store, 'songbook')['status'], 'accepted')
        self.assertFalse(p.current_records(self.store, {'RELATION'}))
        self.change('voice', lambda value: value['blocks'][0].update(text='新的素材版本'))
        latest = er.snapshot(self.store, 'songbook')
        self.assertEqual(latest['status'], 'unaccepted')
        self.assertNotEqual(latest['media'][0]['record']['id'], before['media'][0]['record']['id'])
        self.assertEqual(latest['previous_accepted']['media'][0]['record']['id'], before['media'][0]['record']['id'])
        historical = er.snapshot(self.store, 'songbook', self.ref('accept')['revision_id'])
        self.assertTrue(historical['historical']); self.assertFalse(historical['can_accept'])
        self.assertEqual(historical['scope'], before['scope'])

    def test_state_revision_update_does_not_transfer_media_or_acceptance(self):
        self.setup_full(); self.media(); self.associate(); self.put(self.accept())
        before = er.snapshot(self.store, 'songbook')
        original = before['media'][0]
        self.change('full', lambda value: value['dimensions'].update(condition='完整形态修订'))
        current = er.snapshot(self.store, 'songbook')
        self.assertEqual(current['status'], 'unaccepted')
        self.assertTrue(all(item['state'] is None for item in current['media']))
        self.assertEqual(current['media'][0]['record']['id'], original['record']['id'])
        self.assertEqual(current['previous_accepted']['media'][0]['state'], original['state'])
        self.associate()
        checked = er.snapshot(self.store, 'songbook')
        self.assertEqual(checked['media'][0]['state'], self.ref('full'))
        self.assertNotEqual(checked['media'][0]['asset'], original['asset'])

    def test_unmapped_component_stays_separate_from_explicit_state_coverage(self):
        self.setup_full(); self.media(); self.associate()
        def add_component(value):
            component = copy.deepcopy(value['components'][0]); component['id'] = 'alternate'
            value['components'].append(component)
        self.change('voice', add_component)
        current = er.snapshot(self.store, 'songbook')
        mapped = [item for item in current['media'] if item['state']]
        unmapped = [item for item in current['media'] if not item['state']]
        self.assertEqual([(item['state'], item['component_id']) for item in mapped], [(self.ref('full'), 'original')])
        self.assertEqual([item['component_id'] for item in unmapped], ['alternate'])
        self.assertEqual(len({item['record']['id'] for item in current['media']}), 1)

    def test_stale_collection_identity_media_and_forgery_reject_atomically(self):
        self.setup_full(); initial = er.snapshot(self.store, 'songbook')['scope']
        self.put(self.full('new-form')); before = self.store.objects()
        with self.assertRaises(Conflict): self.put(self.entity('rollback'), self.accept(initial))
        self.assertEqual(self.store.objects(), before)
        stale = er.snapshot(self.store, 'songbook')['scope']
        self.change('full', lambda value: value['dimensions'].update(condition='修订'))
        with self.assertRaises(Conflict): self.put(self.accept(stale))
        stale = er.snapshot(self.store, 'songbook')['scope']
        self.change('songbook', lambda value: value['facts'].append('身份变更'))
        with self.assertRaises(Conflict): self.put(self.accept(stale))
        stale = er.snapshot(self.store, 'songbook')['scope']
        self.media(); self.change('voice', lambda value: value.update(subjects=[self.ref('songbook')]))
        with self.assertRaises(Conflict): self.put(self.accept(stale))
        invalid = er.snapshot(self.store, 'songbook')['scope']; invalid['media'][0]['role'] = 'overall'
        with self.assertRaises(ValueError): self.put(self.accept(invalid))
        self.put(self.accept())
        self.assertEqual(len(p.current_records(self.store, {'JUDGMENT'})), 1)

    def test_legacy_records_and_historical_comments_do_not_gate_current_content(self):
        self.setup_full(); self.media(); self.associate()
        legacy = self.spec('old-review', 'REPRESENTATION', review_model=er.MODEL, entities=[self.ref('songbook')],
                           states=[self.ref('full'), self.ref('wet')], media=[], sources=[], choices=[], unknowns=[])
        self.put(legacy)
        original = [self.ref(oid) for oid in ('old-review', 'full', 'voice')]
        for reference in original:
            self.store.create_comment({'target_object_id':reference['object_id'], 'target_revision_id':reference['revision_id'], 'anchor':{'type':'global'}, 'body':'保留的原版意见'})
        self.change('full', lambda value: value['dimensions'].update(condition='修订'))
        self.change('voice', lambda value: value.update(states=[], state_coverage=[]))
        current = er.snapshot(self.store, 'songbook')
        self.assertTrue(current['can_accept']); self.assertEqual(current['media'], [])
        self.assertTrue(all(r in current['comment_targets'] for r in original))
        self.assertNotIn('submission', current)
        self.assertEqual(len(current['states']), 2)

    def test_production_recovery_is_empty_only_and_preserves_old_acceptance(self):
        self.setup_full(); self.put(self.accept()); accepted = self.ref('accept')
        self.change('full', lambda value: value['dimensions'].update(condition='后来修订'))
        with self.assertRaisesRegex(Conflict, 'empty production'):
            p.restore_records(self.store, [])
        # Recovery can encounter the latest state before the old acceptance.
        ordered = ['songbook', 'full', 'wet', 'accept']
        batches = []
        for oid in ordered:
            for row in self.store.revisions():
                if row['object_id'] == oid:
                    batches.append({'format':'production-import-v1', 'records':[{'object_id':oid,
                        'kind':p.record(self.store, oid)['kind'], 'expected_version':row['version'] - 1,
                        'payload':json.loads(row['payload'])}]})
        other = Store(self.root / 'replay/.runtime/review.sqlite3')
        try:
            original = next(row for row in self.store.revisions() if row['id'] == self.episode['revision'])
            other.put_object('episode', 'EPISODE', json.loads(original['payload']))
            p.restore_records(other, batches)
            self.assertEqual(er.snapshot(other, 'songbook')['status'], 'unaccepted')
            self.assertEqual(er.snapshot(other, 'songbook', accepted['revision_id'])['accepted']['id'], accepted['revision_id'])
        finally: other.close()

    def test_bundle_restores_historical_acceptance_and_cli_reads_same_aggregate(self):
        self.setup_full(); self.media(); self.associate(); self.put(self.accept())
        old = self.ref('accept')
        self.change('full', lambda value: value['dimensions'].update(condition='另一个版本'))
        self.put(self.full('later')); self.put(self.accept(oid='accept-two'))
        self.change('songbook', lambda value: value['facts'].append('再次修订'))
        self.assertIsNone(er.snapshot(self.store, 'songbook', old['revision_id'])['previous_accepted'])
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
