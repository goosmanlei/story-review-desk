"""Exact transaction failure/retry and isolated/formal result comparison."""
import unittest
import test_audiovisual as fixtures
from review_desk import production_cutover as cut, version_consolidation as vc
from review_desk.store import Conflict


class CutoverTest(unittest.TestCase):
    setUp=fixtures.AudiovisualTest.setUp
    tearDown=fixtures.AudiovisualTest.tearDown
    spec=fixtures.AudiovisualTest.spec
    put=fixtures.AudiovisualTest.put
    ref=fixtures.AudiovisualTest.ref
    setup_story=fixtures.AudiovisualTest.setup_story
    shot=fixtures.AudiovisualTest.shot
    composition=fixtures.AudiovisualTest.composition
    need=fixtures.AudiovisualTest.need

    def package(self):
        self.composition();self.put(self.need('old'))
        records=[self.need('new')]
        return cut.plan(self.store,['old'],records,[]),records

    def test_readonly_plan_faults_commit_interruption_and_retry(self):
        plan,records=self.package();before=vc.fingerprint(self.store)
        self.assertEqual(cut.plan(self.store,['old'],records,[]),plan)
        self.assertEqual(vc.fingerprint(self.store),before)
        for point in ('after_delete','after_import','before_commit'):
            with self.assertRaises(RuntimeError):cut.apply(self.store,plan,records,fault=point)
            self.assertEqual(vc.fingerprint(self.store),before)
        with self.assertRaises(RuntimeError):cut.apply(self.store,plan,records,fault='after_commit')
        after=vc.fingerprint(self.store)
        self.assertTrue(cut.apply(self.store,plan,records)['already_applied'])
        self.assertEqual(vc.fingerprint(self.store),after)

    def test_baseline_drift_refuses_entire_transaction(self):
        plan,records=self.package()
        with self.store.db:self.store.db.execute("UPDATE objects SET updated_at='drift' WHERE id='episode'")
        before=vc.fingerprint(self.store)
        with self.assertRaises(Conflict):cut.apply(self.store,plan,records)
        self.assertEqual(before,vc.fingerprint(self.store))

    def test_old_shot_identity_and_number_are_physically_removed(self):
        self.setup_story()
        self.store.put_object('legacy-shot','STORY',{'title':'retired fixture'})
        with self.store.db:
            # Simulate persisted pre-cutover rows without reviving an old API.
            self.store.db.execute("UPDATE objects SET kind='SHOT_DESIGN' WHERE id='legacy-shot'")
            self.store.db.execute("INSERT INTO business_codes VALUES ('legacy-shot','SH',297)")
        records=[self.shot()]
        plan=cut.plan(self.store,['legacy-shot'],records,[])
        before=vc.fingerprint(self.store)
        with self.assertRaises(RuntimeError):cut.apply(self.store,plan,records,fault='after_delete')
        self.assertEqual(before,vc.fingerprint(self.store))
        result=cut.apply(self.store,plan,records)
        self.assertEqual(result['retired_shot_number_allocations'],1)
        self.assertFalse(self.store.db.execute("SELECT 1 FROM objects WHERE id='legacy-shot'").fetchone())
        self.assertFalse(self.store.db.execute("SELECT 1 FROM business_codes WHERE prefix='SH'").fetchone())
        self.assertEqual(tuple(self.store.db.execute("SELECT prefix,number FROM business_codes WHERE object_id='av-shot'").fetchone()),('ASH',1))

    def test_result_comparison_ignores_only_new_creation_times(self):
        plan,records=self.package();cut.apply(self.store,plan,records)
        result=cut.result_fingerprint(self.store,plan)
        with self.store.db:
            self.store.db.execute("UPDATE objects SET created_at='later',updated_at='later' WHERE id='new'")
            self.store.db.execute("UPDATE revisions SET created_at='later' WHERE object_id='new'")
            self.store.db.execute("UPDATE material_rounds SET created_at='later' WHERE material_id='new'")
        self.assertEqual(result,cut.result_fingerprint(self.store,plan))
        with self.store.db:self.store.db.execute("UPDATE objects SET updated_at='later' WHERE id='episode'")
        self.assertNotEqual(result,cut.result_fingerprint(self.store,plan))

if __name__=='__main__':unittest.main()
