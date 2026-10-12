import copy
import unittest

import test_production_current as fixtures
from review_desk import production as p, semantic_consolidation as semantic
from review_desk import production_current_methods as provenance
from review_desk import production_current as current, production_operations as operations
from review_desk.store import Conflict


class StateOwnershipTest(unittest.TestCase):
    for name in ('setUp', 'tearDown', 'spec', 'put', 'ref', 'entity', 'full',
                 'need', 'setup_plans', 'media', 'migrate'):
        locals()[name] = getattr(fixtures.CurrentProductionTest, name)
    for name in ('author', 'submit', 'result'):
        locals()[name] = getattr(fixtures.CurrentProductionTest, name)

    def extra_pair(self, state='new-form'):
        form = self.full(state, production_description='同一歌本有独立折页声音形态。')
        need = self.spec('need-'+state, 'REQUIREMENT',
                         scope={'object_id': state, 'revision_id': '@'+state},
                         slot='overall', required=True, purpose='独立折页演法音频参考',
                         media_type='audio', usage='post_audio',
                         entities=[self.ref('songbook')],
                         states=[{'object_id': state, 'revision_id': '@'+state}],
                         specification={'reference_role': 'overall'})
        return form, need

    def test_empty_state_is_rejected_even_with_shared_usage(self):
        self.migrate()
        before = self.store.objects()
        form, _ = self.extra_pair()
        with self.assertRaisesRegex(ValueError, '使用范围不算拥有权'):
            self.put(form)
        self.assertEqual(self.store.objects(), before)
        need = p.record(self.store, 'need-full-overall')
        body = copy.deepcopy(need['payload'])
        body.update(scope=self.ref('songbook'))
        body['specification'].pop('reference_role')
        # It still declares and uses full, but no longer owns full's work.
        with self.assertRaisesRegex(ValueError, 'full'):
            self.put({'object_id': need['object_id'], 'kind': 'REQUIREMENT',
                      'expected_version': need['version'], 'payload': body})
        self.assertEqual(p.record(self.store, need['object_id']), need)

    def test_state_and_audio_need_can_arrive_in_one_batch_with_multiple_needs(self):
        self.migrate()
        form, need = self.extra_pair()
        self.put(form, need)
        detail = self.need(state='new-form', slot='fold-detail', required=False)
        self.put(detail)
        self.assertEqual(p.record(self.store, 'new-form')['kind'], 'STATE')
        # Entities and shots are not forced to manufacture a baseline state.
        self.put(self.entity('no-state'))
        self.assertFalse(any(r['kind'] == 'STATE' and
                             r['payload'].get('entity', {}).get('object_id') == 'no-state'
                             for r in p.current_records(self.store)))

    def test_last_need_withdrawal_rolls_back_and_atomic_handoff_succeeds(self):
        self.migrate()
        need = p.record(self.store, 'need-wet-overall')
        body = copy.deepcopy(need['payload'])
        body.update(status='withdrawn', required=False, withdrawal_reason='职责由实体方案承接')
        with self.assertRaisesRegex(ValueError, 'wet'):
            self.put({'object_id': need['object_id'], 'kind': 'REQUIREMENT',
                      'expected_version': need['version'], 'payload': body})
        self.assertEqual(p.record(self.store, need['object_id']), need)
        body = copy.deepcopy(need['payload'])
        body.update(scope=self.ref('songbook'), states=[])
        body['specification'].pop('reference_role')
        plan = semantic.prepare(self.store, {
            'retire': [{'source': 'wet', 'reason': '湿痕由实际实体方案承接，不再独立准备'}],
            'updates': [{'object_id': need['object_id'], 'payload': body,
                         'reason': '同笔迁移消费者和唯一出处'}]})
        semantic.apply(self.store, plan)
        self.assertEqual(p.record(self.store, 'wet')['payload']['status'], 'withdrawn')
        self.assertTrue(semantic.apply(self.store, plan)['already_applied'])

    def test_stale_batch_rolls_back_new_state_and_need(self):
        self.migrate()
        old = p.record(self.store, 'need-full-overall')
        changed = copy.deepcopy(old['payload'])
        changed['purpose'] += ' 当前已补充演法。'
        self.put({'object_id': old['object_id'], 'kind': 'REQUIREMENT',
                  'expected_version': old['version'], 'payload': changed})
        form, need = self.extra_pair()
        with self.assertRaises(Conflict):
            self.put(form, need, {'object_id': old['object_id'], 'kind': 'REQUIREMENT',
                                 'expected_version': old['version'], 'payload': old['payload']})
        with self.assertRaises(KeyError):
            p.record(self.store, 'new-form')

    def test_current_name_edit_is_atomic_and_history_is_not_renamed(self):
        self.migrate()
        row = p.record(self.store, 'need-full-overall')
        body = copy.deepcopy(row['payload'])
        body['title'] = '歌本 · 折页音频参考'
        with self.assertRaisesRegex(ValueError, '标题与生成输出名称'):
            self.put({'object_id': row['object_id'], 'kind': 'REQUIREMENT',
                      'expected_version': row['version'], 'payload': body})
        invalid = semantic.prepare(self.store, {'updates': [{'object_id': row['object_id'],
                                    'payload': body, 'reason': 'same transaction boundary'}]})
        with self.assertRaisesRegex(ValueError, '标题与生成输出名称'):
            semantic.apply(self.store, invalid)
        self.assertEqual(p.record(self.store, row['object_id']), row)
        body['generation']['output']['name'] = body['title']
        before = list(self.store.db.execute('SELECT snapshot FROM production_submissions'))
        self.put({'object_id': row['object_id'], 'kind': 'REQUIREMENT',
                  'expected_version': row['version'], 'payload': body})
        self.assertEqual(list(self.store.db.execute('SELECT snapshot FROM production_submissions')), before)

    def test_semantic_receipt_proves_current_edit_without_rewriting_authored_history(self):
        self.migrate()
        row = p.record(self.store, 'need-full-overall')
        body = copy.deepcopy(row['payload'])
        body['title'] = '歌本 · 整体形态参考'
        body['generation']['output']['name'] = body['title']
        original_basis = copy.deepcopy(body.get('method_basis'))
        plan = semantic.prepare(self.store, {'updates': [{'object_id': row['object_id'],
                  'payload': body, 'reason': '实际抽取回读后统一制作职责名'}]})
        receipt = semantic.apply(self.store, plan)
        saved = p.record(self.store, row['object_id'])
        self.assertEqual(receipt['content_sha256'][row['object_id']], saved['content_sha256'])
        self.assertEqual(receipt['before_sha256'][row['object_id']], row['content_sha256'])
        evidence = provenance.verify(self.store, row['object_id'], saved['payload'])
        self.assertEqual(evidence['semantic_operation'], plan['id'])
        self.assertEqual(evidence['original_media_plan_basis'], original_basis)
        # A later unsaved edit cannot borrow the receipt for these bytes.
        altered = copy.deepcopy(saved['payload'])
        altered['generation']['prompt'] += ' changed after review'
        self.assertNotEqual(provenance.verify(self.store, row['object_id'], altered), evidence)

    def test_old_candidate_copy_uses_current_name_and_keeps_snapshot(self):
        self.migrate(True)
        old = self.author('original authored plan', 'old')
        self.submit('before-rename')
        candidate = self.result('before-rename')
        snapshots = [r[0] for r in self.store.db.execute('SELECT snapshot FROM production_submissions ORDER BY operation_id')]
        row = p.record(self.store, old['object_id'])
        payload = copy.deepcopy(row['payload'])
        payload['title'] = '歌本 · 整体形态参考'
        payload['generation']['output']['name'] = payload['title']
        semantic.apply(self.store, semantic.prepare(self.store, {'updates': [
            {'object_id': row['object_id'], 'payload': payload, 'reason': '已审职责名'}]}))
        head = p.record(self.store, row['object_id'])
        operations.reuse(self.store, {'id': 'reuse-renamed', 'requirement_id': row['object_id'],
                         'expected_content': current.marker(head), 'candidate_id': candidate['candidate_id']})
        reused = p.record(self.store, row['object_id'])['payload']
        self.assertEqual(reused['generation']['output']['name'], reused['title'])
        self.assertEqual(reused['generation']['prompt'], 'original authored plan')
        self.assertEqual([r[0] for r in self.store.db.execute('SELECT snapshot FROM production_submissions ORDER BY operation_id')], snapshots)


if __name__ == '__main__':
    unittest.main()
