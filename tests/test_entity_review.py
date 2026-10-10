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


    def change(self, oid, fn):
        row = p.record(self.store, oid); payload = copy.deepcopy(row['payload']); fn(payload)
        self.put({'object_id':oid, 'kind':row['kind'], 'expected_version':row['version'], 'payload':payload})

    def test_current_content_needs_no_workflow_and_query_is_read_only(self):
        self.setup_full()
        before = self.store.revisions()
        snapshot = er.snapshot(self.store, 'songbook')
        self.assertNotIn('status',snapshot); self.assertNotIn('can_accept',snapshot)
        self.assertEqual(len(snapshot['states']), 2)
        self.assertEqual(before, self.store.revisions())
        self.assertFalse(p.current_records(self.store, {'REPRESENTATION', 'JUDGMENT'}))
        self.change('songbook', lambda value: value['facts'].append('新的身份事实'))
        self.put(self.full('new-form'))
        current = er.snapshot(self.store, 'songbook')
        self.assertEqual(current['entity']['id'], self.ref('songbook')['revision_id'])
        self.assertEqual(len(current['states']), 3)
        self.assertNotEqual(snapshot['content_key'], current['content_key'])

    def test_switchable_originals_keep_exact_historical_state_names_outside_acceptance_scope(self):
        from review_desk import generation, ui_projection
        self.setup_full(); self.media(); self.associate(states=('full', 'wet'))
        original = self.ref('voice')
        old_states = [p.record(self.store, key) for key in ('full', 'wet')]
        for key in ('full', 'wet'):
            self.change(key, lambda payload: payload.update(title='当前新名称'))
        before = self.store.revisions()
        snapshot = generation.snapshot(self.store, 'songbook')
        titles = {item['revision_id']: item['title'] for item in snapshot['reference_titles']}
        for row in old_states:
            self.assertEqual(titles[row['id']], row['payload']['title'])
            self.assertNotIn({'object_id': row['object_id'], 'revision_id': row['id']}, snapshot['scope']['states'])
        detail = ui_projection.card(self.store, original['object_id'], original['revision_id'])
        names = detail['entity_review']['reference_titles']
        self.assertTrue(all(any(r['revision_id'] == row['id'] and r['title'] == row['payload']['title'] for r in names) for row in old_states))
        self.assertEqual(before, self.store.revisions())

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
        self.assertEqual(len(mapped['comment_targets']), len({r['revision_id'] for r in mapped['comment_targets']}))
        self.assertTrue(all(self.ref(oid) in mapped['comment_targets'] for oid in ('songbook','full','wet','voice')))


    def test_state_revision_update_does_not_transfer_media_or_acceptance(self):
        self.setup_full(); self.media(); self.associate()
        before = er.snapshot(self.store, 'songbook')
        original = before['media'][0]
        self.change('full', lambda value: value['dimensions'].update(condition='完整形态修订'))
        current = er.snapshot(self.store, 'songbook')
        self.assertTrue(all(item['state'] is None for item in current['media']))
        self.assertEqual(current['media'][0]['record']['id'], original['record']['id'])
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






if __name__ == '__main__': unittest.main()
