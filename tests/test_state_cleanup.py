import copy
import json
import shutil
import unittest
import test_complete_states as fixtures
from review_desk.store import Store, Conflict, canonical, digest
from review_desk import production as p, state_cleanup as c, bundle


class StateCleanupTest(unittest.TestCase):
    setUp=fixtures.CompleteStatesTest.setUp
    tearDown=fixtures.CompleteStatesTest.tearDown
    spec=fixtures.CompleteStatesTest.spec
    put=fixtures.CompleteStatesTest.put
    ref=fixtures.CompleteStatesTest.ref
    entity=fixtures.CompleteStatesTest.entity
    full=fixtures.CompleteStatesTest.full
    need=fixtures.CompleteStatesTest.need

    def setup_history(self):
        self.put(self.entity());self.put(self.full())
        old=self.full('old');self.put(old)
        self.old=self.ref('old')
        self.store.create_comment({'target_object_id':'old','target_revision_id':self.old['revision_id'],
            'anchor':{'type':'text','block_id':old['payload']['blocks'][0]['id'],'end_block_id':old['payload']['blocks'][0]['id'],'start':0,'end':2,'quote':old['payload']['blocks'][0]['text'][:2]},'body':'保留原引文'})
        self.put(self.need('old'))
        retired=copy.deepcopy(old);retired['expected_version']=1;retired['payload']['status']='withdrawn';self.put(retired)
        self.approved=c.plan(self.store)

    def test_physical_retirement_exact_link_and_preservation(self):
        self.setup_history();comments=self.store.comments();current=self.ref('full')
        result=c.apply(self.store,self.approved)
        self.assertEqual(result['removed_state_objects'],1)
        raw=self.store.db.execute('SELECT payload FROM revisions WHERE id=?',(self.old['revision_id'],)).fetchone()[0]
        self.assertNotIn('blocks',json.loads(raw));self.assertNotIn('dimensions',json.loads(raw))
        self.assertEqual(self.store.db.execute('SELECT kind FROM objects WHERE id=?',('old',)).fetchone()[0],'DELETED_STATE')
        self.assertEqual(self.store.comments(),comments);self.assertEqual(self.ref('full'),current)
        self.assertTrue(p.ref_record(self.store,self.old)['cleaned_target'])
        self.assertEqual(c.apply(self.store,self.approved)['removed_state_objects'],0)
        self.assertFalse(self.store.db.execute('PRAGMA foreign_key_check').fetchall())

    def test_conflict_has_no_partial_write_and_future_import_is_rejected(self):
        self.setup_history();bad=copy.deepcopy(self.approved);bad['revisions'][0]['payload_sha256']='changed'
        before=self.store.revisions()
        with self.assertRaises(Conflict):c.apply(self.store,bad)
        self.assertEqual(self.store.revisions(),before)
        c.apply(self.store,self.approved)
        with self.assertRaises(Conflict):self.store.put_object('old','STATE',self.full('old')['payload'],1)
        with self.assertRaises(Conflict):self.put(self.need('old','new'))

    def test_export_restore_export_and_comments_without_resurrection(self):
        self.setup_history();c.apply(self.store,self.approved);bundle.export(self.store,self.root/'export')
        other=self.root/'recovered';other.mkdir();shutil.copytree(self.root/'export',other/'export')
        restored=Store(other/'.runtime/review.sqlite3')
        try:
            bundle.restore(restored,other/'export');bundle.export(restored,other/'export')
            for name in ('objects.json','comments.json','manifest.json'):
                self.assertEqual((self.root/'export'/name).read_bytes(),(other/'export'/name).read_bytes(),name)
            self.assertTrue(p.ref_record(restored,self.old)['cleaned_target'])
        finally:restored.close()

    def test_archive_input_conflict_rolls_back_entire_batch(self):
        self.setup_history();before=self.store.revisions()
        delta={'remove':[{'id':'missing','body_sha256':'changed'}],'insert':[],'archives':[]}
        with self.assertRaises(Conflict):c.apply(self.store,self.approved,archive_delta=delta)
        self.assertEqual(before,self.store.revisions())
        self.assertEqual(c.dump(self.store)['state_cleanup_receipts'],[])
        body=canonical({'text':'sanitized archive'});delta={'remove':[],'insert':[{'id':digest(body.encode()),'body':body}],'archives':[]}
        c.apply(self.store,self.approved,archive_delta=delta)
        self.assertEqual(c.apply(self.store,self.approved,archive_delta=delta)['removed_state_objects'],0)

    def test_instance_policy_rejects_old_export_into_empty_recovery(self):
        self.setup_history();bundle.export(self.store,self.root/'export')
        destination=self.root/'old-recovery';(destination/'config').mkdir(parents=True)
        (destination/'config/instance.json').write_text(json.dumps({'state_cleanup_policy':{'format':'state-cleanup-policy-v1','object_ids':['old']}}))
        s=Store(destination/'.runtime/review.sqlite3')
        try:
            with self.assertRaisesRegex(Conflict,'pre-cleanup export'):bundle.restore(s,self.root/'export')
            self.assertFalse(s.objects())
            with self.assertRaises(Conflict):s.put_object('old','STATE',self.full('old')['payload'])
        finally:s.close()
