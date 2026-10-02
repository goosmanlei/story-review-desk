import copy
import json
import shutil
import unittest
import test_generation as fixtures
from review_desk import production as p, generation as g, entity_review as er
from review_desk.store import Conflict, Store
from review_desk.bundle import export, restore


class RequirementCleanupTest(unittest.TestCase):
    setUp=fixtures.GenerationTest.setUp
    tearDown=fixtures.GenerationTest.tearDown
    spec=fixtures.GenerationTest.spec
    put=fixtures.GenerationTest.put
    ref=fixtures.GenerationTest.ref
    entity=fixtures.GenerationTest.entity
    full=fixtures.GenerationTest.full
    need=fixtures.GenerationTest.need
    change=fixtures.GenerationTest.change
    setup_plans=fixtures.GenerationTest.setup_plans
    decide=fixtures.GenerationTest.decide

    def remove(self,oid,**kw):
        return p.import_records(self.store,{'format':'production-import-v1','records':[],
             'remove_unreferenced_requirements':[self.ref(oid)]},**kw)

    def test_delete_history_dry_run_and_comment_guard(self):
        self.setup_plans();oid='need-full-overall';old=p.record(self.store,oid)
        self.change(oid,title='v2');self.remove(oid,validate_only=True)
        self.assertEqual(p.record(self.store,oid)['version'],2)
        self.store.create_comment({'target_object_id':oid,'target_revision_id':old['id'],'anchor':{'type':'global'},'body':'历史意见'})
        with self.assertRaises(Conflict):self.remove(oid)
        self.assertEqual(p.record(self.store,oid)['version'],2)

    def test_history_dependencies_and_atomic_rollback(self):
        self.setup_plans();self.decide()
        with self.assertRaises(Conflict):self.remove('need-full-overall')
        self.assertTrue(g.accepted(self.store,'songbook'))
        with self.assertRaises(ValueError):self.remove('songbook')

    def test_successful_removal_and_invalid_update_rolls_back(self):
        self.setup_plans();ref=self.ref('need-full-overall')
        bad={'object_id':'broken','kind':'STATE','expected_version':0,'payload':{}}
        with self.assertRaises(ValueError):p.import_records(self.store,{'format':'production-import-v1','records':[bad],'remove_unreferenced_requirements':[ref]})
        self.assertEqual(p.record(self.store,'need-full-overall')['id'],ref['revision_id'])
        self.remove('need-full-overall')
        self.assertFalse(self.store.db.execute('SELECT 1 FROM revisions WHERE object_id=?',('need-full-overall',)).fetchone())
        self.assertFalse(self.store.db.execute('PRAGMA foreign_key_check').fetchall())

    def test_description_state_still_checks_real_presentation(self):
        self.setup_plans();self.remove('need-full-overall')
        self.change('full',reference_mode='description')
        self.assertFalse(p.readiness(self.store,'full')['state_coverage']['issues'])
        self.assertTrue(er.snapshot(self.store,'songbook')['preparation']['complete'])
        with self.assertRaises(ValueError):self.change('full',reference_media='none')
        with self.assertRaises(ValueError):self.change('full',production_description='')

    def test_layout_round_trip_does_not_change_acceptance(self):
        self.setup_plans();self.decide();scope=g.current_scope(self.store,'songbook')
        config=self.root/'config';config.mkdir(exist_ok=True)
        value={'format':'entity-relationship-layout-v1','entities':{'songbook':{'primary':[],'order':[]}}}
        (config/'entity-relationship-layout.json').write_text(json.dumps(value))
        self.assertEqual(scope,g.current_scope(self.store,'songbook'));self.assertTrue(g.accepted(self.store,'songbook'))
        export(self.store,self.root/'export');dest=self.root/'restored';shutil.copytree(self.root/'export',dest/'export')
        recovered=Store(dest/'.runtime/review.sqlite3')
        try:
            restore(recovered,dest/'export')
            self.assertEqual(json.loads((dest/'config/entity-relationship-layout.json').read_text()),value)
        finally:recovered.close()
