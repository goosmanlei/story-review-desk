import copy
import json
import unittest

from test_production_current import CurrentProductionTest
from review_desk import semantic_consolidation as merge, production as p, production_current as current
from review_desk.bundle import export, restore
from review_desk.store import Store, Conflict


class SemanticConsolidationTest(unittest.TestCase):
    for name in ('setUp','tearDown','spec','put','ref','entity','full','need','setup_plans','media','migrate'):
        locals()[name] = getattr(CurrentProductionTest, name)

    def choices(self):
        return {'merges':[{'source':'need-wet-overall','target':'need-full-overall',
                           'reason':'隔离夹具：已审定为同一翻页声需求，两个状态共用。'}]}

    def test_atomic_replay_stale_content_and_recovery(self):
        self.migrate()
        old = p.record(self.store, 'need-wet-overall')
        comment = self.store.create_comment({'target_object_id':old['object_id'], 'target_revision_id':old['id'],
            'expected_edit_token':old['edit_token'], 'anchor':{'type':'global'}, 'body':'旧需求原意见'})
        plan = merge.prepare(self.store, self.choices())
        with self.assertRaisesRegex(RuntimeError, 'interruption'):
            merge.apply(self.store, plan, fault='after-rewrite')
        self.assertEqual(p.record(self.store, old['object_id'])['payload'], old['payload'])
        self.assertFalse(self.store.db.execute('SELECT 1 FROM production_current_operations WHERE id=?', (plan['id'],)).fetchone())
        result = merge.apply(self.store, plan)
        self.assertTrue(merge.apply(self.store, plan)['already_applied'])
        retired = p.record(self.store, old['object_id'])
        self.assertTrue(merge.is_retired(retired['payload']))
        self.assertNotIn('generation', retired['payload'])
        self.assertEqual(self.store.comment(comment['id'])['target_object_id'], old['object_id'])
        self.assertFalse(self.store.comment(comment['id'])['original_context']['matches_current'])
        self.assertEqual(merge.resolve(self.store, old['object_id']), 'need-full-overall')
        self.assertEqual(result['retired'][old['object_id']], current.checksum(retired['payload']))
        export(self.store, self.root/'export')
        recovered = Store(self.root/'restore/.runtime/review.sqlite3')
        try:
            restore(recovered, self.root/'export')
            merge.validate(recovered)
            self.assertTrue(merge.is_retired(p.record(recovered,old['object_id'])['payload']))
            self.assertEqual(recovered.comment(comment['id'])['body'], '旧需求原意见')
        finally:
            recovered.close()

    def test_rejects_changed_payload_and_changed_original(self):
        self.migrate()
        plan = merge.prepare(self.store, self.choices())
        row = p.record(self.store,'need-full-overall')
        payload = copy.deepcopy(row['payload']);payload['purpose'] += ' concurrent'
        self.put({'object_id':row['object_id'],'kind':'REQUIREMENT','expected_version':row['version'],'payload':payload})
        with self.assertRaises(Conflict):merge.apply(self.store, plan)
        plan = merge.prepare(self.store, self.choices())
        # Explicit original guards are checked even when no candidate is moved.
        path = self.root/'export/assets'/self.component['file']
        plan['media'][self.component['file']] = self.component['sha256']
        plan['id'] = current.checksum({k:v for k,v in plan.items() if k!='id'})
        original = path.read_bytes();path.write_bytes(original+b'changed')
        with self.assertRaisesRegex(Conflict,'checksum'):merge.apply(self.store,plan)
        self.assertFalse(merge.is_retired(p.record(self.store,'need-wet-overall')['payload']))
        path.write_bytes(original)

    def test_retired_candidate_preserves_call_and_cannot_resurrect(self):
        self.migrate()
        asset = p.record(self.store, 'voice')
        operation = asset['payload']['production']['object_id']
        call = copy.deepcopy(p.record(self.store, operation)['payload'])
        backs = [r['object_id'] for r in p.current_records(self.store, {'REQUIREMENT'})
                 if r['payload'].get('current_plan_for', {}).get('object_id')=='voice']
        choices = {'retire':[{'source':oid,'reason':'没有当前制作用途'} for oid in backs],
                   'retire_candidates':[{'source':'voice','reason':'仅保留原制作回查','remove_files':False}]}
        result = merge.apply(self.store, merge.prepare(self.store, choices))
        self.assertEqual(p.record(self.store, operation)['payload'], call)
        self.assertEqual(p.record(self.store, 'voice')['payload']['components'], asset['payload']['components'])
        self.assertFalse(self.store.db.execute("SELECT 1 FROM production_candidates WHERE asset_object_id='voice'").fetchone())
        from review_desk.ui_projection import material_entries
        self.assertFalse(any(v['object_id']=='voice' for v in material_entries(self.store)))
        row = p.record(self.store,'voice')
        with self.assertRaises(Conflict):
            self.put({'object_id':'voice','kind':'ASSET','expected_version':row['version'],'payload':asset['payload']})
        export(self.store,self.root/'export')
        recovered = Store(self.root/'candidate-restore/.runtime/review.sqlite3')
        try:
            restore(recovered,self.root/'export')
            self.assertFalse(recovered.db.execute("SELECT 1 FROM production_candidates WHERE asset_object_id='voice'").fetchone())
            self.assertEqual(p.record(recovered,operation)['payload'],call)
        finally:recovered.close()

    def test_cleanup_is_exact_replayable_and_retirement_card_keeps_old_code(self):
        self.migrate()
        asset = p.record(self.store, 'voice')
        original = copy.deepcopy(asset['payload'])
        choices = {'retire_candidates':[{'source':'voice','reason':'无后续输入的过期试样','remove_files':True}]}
        initial = copy.deepcopy(choices)
        initial['retire_candidates'][0]['remove_files'] = False
        merge.apply(self.store,merge.prepare(self.store,initial))
        plan = merge.prepare(self.store,choices)
        self.assertEqual(plan['media'][self.component['file']],self.component['sha256'])
        result = merge.apply(self.store, plan)
        receipt = p.record(self.store,'voice')['payload']
        self.assertEqual(receipt['original_content_sha256'],current.checksum(original))
        self.assertNotIn('components', receipt)
        self.assertEqual(receipt['former_components'][0]['sha256'], original['components'][0]['sha256'])
        removed = merge.cleanup_files(self.store,result['id'])
        self.assertIn(self.component['file'], removed['removed'])
        self.assertIn(self.component['file'], merge.cleanup_files(self.store,result['id'])['already_absent'])
        from review_desk.ui_projection import card
        detail=card(self.store,'voice')['detail']
        self.assertTrue(detail['retired'])
        self.assertIsNone(card(self.store,'voice')['entity_review'])

    def test_reuse_has_no_generation_model_or_prompt(self):
        self.migrate()
        need=p.record(self.store,'need-full-overall')
        payload=copy.deepcopy(need['payload'])
        payload['generation']={'format':'generation-plan-v1','method':'reuse','parameters':{},
            'inputs':[{'reference':self.ref('voice'),'component_id':self.component['id'],'use':'核对既有原件'}],
            'output':{'name':'复用原件','description':'使用同一准确音频','review_criteria':['回听准确原件']},'blockers':[]}
        p.validate_payload(self.store,need['object_id'],'REQUIREMENT',payload,inspect=False,check_current=False)

    def test_retired_exact_candidate_is_not_rebound_through_its_material_alias(self):
        self.migrate()
        from review_desk import business_relations as relations
        from review_desk.store import canonical
        endpoints = sorted(['voice','need-full-overall'])
        relation_id = relations.identity(endpoints)
        payload = {'format':'production-relation-v1','title':'旧候选关系','relation_type':'business',
            'endpoints':endpoints,'direction':'related','summary':'候选可供比较',
            'sources':[],'contexts':[],'blocks':[{'id':'summary','text':'候选可供比较'}]}
        self.put({'object_id':relation_id,'kind':'RELATION','expected_version':0,'payload':payload})
        with self.store.db:
            self.store.db.execute('INSERT OR REPLACE INTO material_aliases VALUES (?,?,?)',
                ('need-wet-overall','voice',canonical({'canonical_material_id':'voice'})))
        choices = self.choices()
        choices['retire_candidates'] = [{'source':'voice','reason':'审阅后退出当前候选','remove_files':False}]
        plan = merge.prepare(self.store,choices)
        self.assertEqual(plan['mapping']['voice'],'need-full-overall')
        self.assertIsNone(plan['relations'][relation_id])
        merge.apply(self.store,plan)
        self.assertTrue(merge.is_retired(p.record(self.store,relation_id)['payload']))
        self.assertFalse(relations.current(self.store,'voice'))

    def test_reviewed_reference_change_creates_correct_pair_and_keeps_old_comment(self):
        self.migrate()
        from review_desk import business_relations as relations
        old_id = relations.identity(['voice', 'need-wet-overall'])
        original = relations.normalize({'format':'production-relation-v1','title':'原参考',
            'relation_type':'business','endpoints':['voice','need-wet-overall'],
            'direction':'related','summary':'原适用范围','sources':[],'contexts':[],
            'blocks':[{'id':'summary','text':'原适用范围'}]})
        self.put({'object_id':old_id,'kind':'RELATION','expected_version':0,'payload':original})
        old = p.record(self.store, old_id)
        comment = self.store.create_comment({'target_object_id':old_id,'target_revision_id':old['id'],
            'expected_edit_token':old['edit_token'],'anchor':{'type':'global'},'body':'原参考的意见'})
        proposed = copy.deepcopy(original)
        proposed.update(endpoints=['voice','need-full-overall'],summary='完整参考才符合此用途',
                        blocks=[{'id':'summary','text':'完整参考才符合此用途'}])
        plan = merge.prepare(self.store, {'updates':[{'object_id':old_id,'payload':proposed,
                              'reason':'已审阅当前用途改用完整参考'}]})
        new_id = relations.identity(proposed['endpoints'])
        self.assertEqual(plan['relations'][old_id], new_id)
        with self.assertRaisesRegex(RuntimeError, 'interruption'):
            merge.apply(self.store, plan, fault='after-rewrite')
        self.assertEqual(p.record(self.store, old_id)['payload'],original)
        self.assertIsNone(relations.lookup(self.store,proposed['endpoints']))
        merge.apply(self.store, plan)
        self.assertTrue(merge.apply(self.store,plan)['already_applied'])
        self.assertEqual(relations.lookup(self.store,proposed['endpoints'])['object_id'],new_id)
        self.assertIsNone(relations.lookup(self.store,original['endpoints']))
        retired = p.record(self.store,old_id)['payload']
        self.assertEqual(retired['merged_into']['object_id'],new_id)
        self.assertEqual(retired['reason'],'已审阅当前用途改用完整参考')
        self.assertEqual(self.store.comment(comment['id'])['target_object_id'],old_id)
        self.assertFalse(self.store.comment(comment['id'])['original_context']['matches_current'])
        merge.validate(self.store)

    def test_publication_alias_requires_complete_reviewed_chain(self):
        before = {'alias_id':'legacy-reference', 'relation_id':'original-pair'}
        receipts = [{'format':merge.FORMAT, 'relations':{'original-pair':'merged-pair'}},
                    {'format':merge.FORMAT, 'relations':{'merged-pair':'reviewed-pair'}}]
        allowed = lambda after: merge.allows_publication_change(
            'business_relation_aliases', before, after, receipts)
        self.assertTrue(allowed({**before, 'relation_id':'reviewed-pair'}))
        self.assertFalse(allowed({**before, 'relation_id':'merged-pair'}))
        self.assertFalse(allowed({**before, 'relation_id':'unreviewed-pair'}))
        self.assertFalse(allowed({'alias_id':'different-history', 'relation_id':'reviewed-pair'}))
        self.assertFalse(allowed(None))
        receipts.append({'format':merge.FORMAT, 'relations':{'reviewed-pair':None}})
        self.assertTrue(allowed(None))
        self.assertFalse(allowed({**before, 'relation_id':'reviewed-pair'}))
        receipts[-1]['relations']['reviewed-pair'] = 'original-pair'
        self.assertFalse(allowed(None))
        self.assertFalse(allowed({**before, 'relation_id':'original-pair'}))


if __name__ == '__main__':unittest.main()
