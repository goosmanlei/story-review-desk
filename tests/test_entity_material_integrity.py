import copy
import json
import shutil
import unittest
import test_material_relationships as fixtures
from review_desk import business_codes as codes, relation_explanations as explanations, production as p, generation as g
from review_desk.bundle import export, restore
from review_desk.store import Store, Conflict
from review_desk.production_breakdown import index


class EntityMaterialIntegrityTest(unittest.TestCase):
    for name in ('setUp','tearDown','spec','put','ref','entity','full','need','media','associate','adopt','change','setup_plans','relationship'):
        locals()[name] = getattr(fixtures.MaterialRelationshipsTest, name)

    def history(self):
        self.setup_plans();self.put(self.relationship())
        old=p.record(self.store,'belongs');text=old['payload']['blocks'][0]['text']
        comment=self.store.create_comment({'target_object_id':old['object_id'],'target_revision_id':old['id'],
            'anchor':{'type':'text','block_id':'notes','end_block_id':'notes','start':0,'end':len(text),'quote':text},'body':'用户原意见保留'})
        self.change('belongs',label='保管歌本',blocks=[{'id':'notes','text':'新的说明'}])
        return old, comment

    def recovered(self):
        export(self.store,self.root/'export');dest=self.root/'restored';shutil.copytree(self.root/'export',dest/'export')
        result=Store(dest/'.runtime/review.sqlite3');restore(result,dest/'export');self.addCleanup(result.close);return result

    def test_codes_preserve_exact_scopes_and_survive_restore_and_append(self):
        self.setup_plans();before=g.snapshot(self.store,'songbook');view=codes.annotate(self.store,before)
        self.assertEqual(view['scope'],before['scope'])
        self.assertRegex(view['entity']['business_code'],r'^EN\d{3}$')
        self.assertRegex(view['states'][0]['business_code'],r'^ST\d{3}$')
        saved=codes.dump(self.store);restored=self.recovered();self.assertEqual(codes.dump(restored),saved)
        self.put(self.entity('later'));self.assertEqual(len(codes.dump(self.store)),len(saved)+1)
        after={r['object_id']:r for r in codes.dump(self.store)}
        for row in saved:self.assertEqual(after[row['object_id']],row)
        self.assertGreater(after['later']['number'],max(r['number'] for r in saved if r['prefix']=='EN'))
        self.assertEqual(codes.annotate(self.store,{'scope':before['scope']})['scope'],before['scope'])

    def test_cleanup_preview_is_atomic_idempotent_and_preserves_comment_quotes_and_facts(self):
        old,comment=self.history();approved=explanations.plan(self.store);before=p.record(self.store,revision_id=old['id']);comments=self.store.comments()
        dependencies=list(self.store.db.execute('SELECT * FROM dependencies'))
        explanations.apply(self.store,approved,validate_only=True);self.assertEqual(p.record(self.store,revision_id=old['id']),before)
        self.assertEqual(explanations.apply(self.store,approved)['removed_explanations'],1)
        cleaned=p.record(self.store,revision_id=old['id']);self.assertEqual(explanations.facts(cleaned['payload']),explanations.facts(old['payload']))
        self.assertTrue(cleaned['payload']['explanation_removed']);self.assertNotIn('使用歌本',json.dumps(cleaned['payload'],ensure_ascii=False))
        self.assertEqual(self.store.comments(),comments);self.assertEqual(list(self.store.db.execute('SELECT * FROM dependencies')),dependencies)
        self.assertFalse(self.store.anchor_state('belongs',old['id'],comment['anchor'])['valid'])
        self.assertEqual(explanations.apply(self.store,approved)['removed_explanations'],0)
        restored=self.recovered();self.assertEqual(restored.comments(),comments)
        self.assertEqual(p.record(restored,revision_id=old['id'])['payload'],cleaned['payload'])
        self.assertFalse(restored.anchor_state('belongs',old['id'],comment['anchor'])['valid'])
        self.assertEqual(codes.dump(restored),codes.dump(self.store))

    def test_relation_exact_route_is_available_without_adding_it_to_entity_list(self):
        old,_=self.history();explanations.apply(self.store,explanations.plan(self.store))
        self.assertNotIn('belongs',[r['object_id'] for r in index(self.store,'settings')['records']])
        focused=index(self.store,'settings','belongs')
        self.assertIn('belongs',[r['object_id'] for r in focused['records']])
        self.assertTrue(p.record(self.store,'belongs',old['id'])['payload']['explanation_removed'])
        with self.assertRaises(KeyError):index(self.store,'settings','missing-exact-target')

    def test_candidate_and_comment_numbers_survive_metadata_edits_and_restore(self):
        self.setup_plans();self.media();self.associate()
        candidate_rows=lambda s:[dict(r) for r in s.db.execute('SELECT * FROM business_candidates ORDER BY 1,2,4')]
        saved=candidate_rows(self.store);self.assertTrue(saved)
        asset=codes.annotate(self.store,p.record(self.store,'voice'))
        self.assertTrue(asset['candidate_codes'])
        self.assertRegex(asset['candidate_codes'][0]['code'],r'^M\d{3} / MV\d{3} / MC\d{3}$')
        self.change('voice',blocks=[{'id':'notes','text':'更新结果的自检说明'}])
        self.assertEqual(candidate_rows(self.store),saved)
        comment=self.store.create_comment({'target_object_id':'full','target_revision_id':self.ref('full')['revision_id'],
                                          'anchor':{'type':'global'},'body':'保留评论编号'})
        code=codes.annotate(self.store,comment)['business_code']
        self.store.change_comment(comment['id'],'EDIT',comment['version'],'修改意见')
        self.assertEqual(codes.annotate(self.store,self.store.comment(comment['id']))['business_code'],code)
        restored=self.recovered()
        self.assertEqual(candidate_rows(restored),saved)
        self.assertEqual(codes.annotate(restored,restored.comment(comment['id']))['business_code'],code)

    def test_head_or_comment_conflict_stops_without_partial_removal(self):
        old,_=self.history();approved=explanations.plan(self.store)
        self.store.create_comment({'target_object_id':'belongs','target_revision_id':old['id'],'anchor':{'type':'global'},'body':'新评论'})
        before=self.store.revisions()
        with self.assertRaises(Conflict):explanations.apply(self.store,approved)
        self.assertEqual(self.store.revisions(),before);self.assertEqual(explanations.dump(self.store),[])
        approved=explanations.plan(self.store);self.change('belongs',label='更新关系')
        before=self.store.revisions()
        with self.assertRaises(Conflict):explanations.apply(self.store,approved)
        self.assertEqual(self.store.revisions(),before);self.assertEqual(explanations.dump(self.store),[])

    def test_future_writes_keep_only_latest_explanation_and_export_rejects_tampered_facts(self):
        old,_=self.history();explanations.apply(self.store,explanations.plan(self.store));previous=p.record(self.store,'belongs')
        self.change('belongs',label='最新关系说明')
        self.assertEqual(len(explanations.dump(self.store)),2)
        self.assertEqual(p.record(self.store,'belongs')['payload']['label'],'最新关系说明')
        for rid in (old['id'],previous['id']):self.assertTrue(p.record(self.store,revision_id=rid)['payload']['explanation_removed'])
        self.recovered()
        attestation=explanations.dump(self.store)[0];row=dict(self.store.db.execute('SELECT * FROM revisions WHERE id=?',(attestation['revision_id'],)).fetchone())
        value=json.loads(row['payload']);value['direction']='mutual';row['payload']=json.dumps(value)
        with self.assertRaisesRegex(ValueError,'redaction'):explanations.verify_row(row,attestation)

    def test_retained_state_and_shared_media_context_does_not_expand_acceptance(self):
        self.setup_plans();before=g.snapshot(self.store,'songbook')['scope']
        legacy=self.spec('legacy','STATE',entity=self.ref('songbook'),production_description='旧碎片状态',dimensions={'appearance':'旧碎片'},sources=[],facts=[],choices=[],unknowns=[])
        self.put(legacy)
        view=g.snapshot(self.store,'songbook')
        self.assertIn('legacy',[r['object_id'] for r in view['retained_states']])
        self.assertEqual(view['scope'],before)


if __name__=='__main__':unittest.main()
