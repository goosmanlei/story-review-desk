import copy
import json
import shutil
import unittest
from pathlib import Path
import test_material_plans as fixtures
from review_desk import material_model as model, material_storage as storage, material_archives as archives, material_plans as plans
from review_desk import production as p
from review_desk.store import Store,Conflict,canonical,digest
from review_desk.bundle import export,restore


class MaterialModelTest(unittest.TestCase):
    setUp=fixtures.PlanVersionsTest.setUp
    tearDown=fixtures.PlanVersionsTest.tearDown
    spec=fixtures.PlanVersionsTest.spec
    put=fixtures.PlanVersionsTest.put
    ref=fixtures.PlanVersionsTest.ref
    entity=fixtures.PlanVersionsTest.entity
    full=fixtures.PlanVersionsTest.full
    need=fixtures.PlanVersionsTest.need
    media=fixtures.PlanVersionsTest.media
    change=fixtures.PlanVersionsTest.change
    setup_plans=fixtures.PlanVersionsTest.setup_plans
    decide=fixtures.PlanVersionsTest.decide
    generate=fixtures.PlanVersionsTest.generate

    def test_migration_defer_archive_and_rollback_preserve_unrelated_comment(self):
        self.setup_plans();self.generate()
        target=self.root/'production/requests/original.json';target.parent.mkdir(parents=True)
        raw=b'{\r\n "prompt": "\\u4f60\\u597D", "n": 1.00, "x":1,"x":2 }\n'
        target.write_bytes(raw)
        before=self.store.revisions();before_index=plans.dump(self.store)
        plan=model.migration_plan(self.store,archive_paths=['production/requests/original.json'])
        self.assertEqual(model.migrate(self.store,plan,True)['validated_only'],True)
        self.assertEqual(target.read_bytes(),raw)
        model.migrate(self.store,plan,apply_archives=False)
        self.assertEqual(target.read_bytes(),raw)
        self.assertEqual(self.store.revisions(),before)
        self.assertTrue(model.migrate(self.store,plan)['already_applied'])
        comment=self.store.create_comment({'target_object_id':'songbook','target_revision_id':self.ref('songbook')['revision_id'],
            'anchor':{'type':'global'},'body':'unrelated concurrent comment'})
        model.rollback(self.store,plan)
        self.assertEqual(plans.dump(self.store),before_index)
        self.assertEqual(self.store.revisions(),before)
        self.assertIsNotNone(self.store.comment(comment['id']))
        self.assertTrue(model.rollback(self.store,plan)['already_rolled_back'])

    def test_conflict_preserves_all_tables_and_files(self):
        self.setup_plans();self.generate()
        plan=model.migration_plan(self.store)
        self.change('need-full-overall',purpose='different complete requirement')
        before=self.store.revisions();content=storage.dump(self.store)
        with self.assertRaises(Conflict):model.migrate(self.store,plan)
        self.assertEqual(self.store.revisions(),before);self.assertEqual(storage.dump(self.store),content)

    def test_original_json_layout_and_checksum_survive_physical_encoding(self):
        self.setup_plans()
        row=p.record(self.store,'need-full-overall')
        raw=json.dumps(row['payload'],ensure_ascii=True,indent=3)+'\r\n'
        encoded=storage.encode(self.store,row['payload'],raw)
        self.assertEqual(storage.hydrate(self.store,encoded),raw)
        self.assertNotIn(row['payload']['generation']['prompt'],encoded)

    def test_archive_container_reads_from_live_db_before_export_graph(self):
        self.setup_plans()
        target=self.root/'production/requests/input.json';target.parent.mkdir(parents=True)
        raw=b'{ "prompt": "same prompt", "number":1e+00 }\n';target.write_bytes(raw)
        plan=model.migration_plan(self.store,archive_paths=['production/requests/input.json'])
        model.migrate(self.store,plan)
        (self.root/'config').mkdir(exist_ok=True);(self.root/'config/instance.json').write_text('{}')
        (self.root/'export/material-content.json').unlink()
        self.assertEqual(archives.read_bytes(target),raw)
        self.assertEqual(archives.read_json(target)['number'],1)
        model.rollback(self.store,plan);self.assertEqual(target.read_bytes(),raw)

    def test_package_has_only_content_keys_and_load_checks_graph(self):
        self.setup_plans();plan=model.migration_plan(self.store)
        path=self.root/'production/ui-material-model/migration.json'
        graph=self.root/'export/material-content.json'
        model.write_migration_package(self.store,plan,path,graph)
        saved=json.loads(path.read_text())
        self.assertTrue(all(set(row)=={'id'} for row in saved['migration']['content']['material_content']))
        self.assertEqual(model.load_migration(path),plan)
        graph.write_text(graph.read_text()+' ')
        with self.assertRaises(ValueError):model.load_migration(path)

    def test_schema6_missing_definition_rolls_back_empty_restore(self):
        self.setup_plans();self.generate();export(self.store,self.root/'export')
        path=self.root/'export/objects.json';bundle=json.loads(path.read_text());bundle['material_definition_versions']=[]
        path.write_text(json.dumps(bundle));manifest=self.root/'export/manifest.json';data=json.loads(manifest.read_text());data['files']['objects.json']=digest(path.read_bytes());manifest.write_text(json.dumps(data))
        dest=self.root/'restored';shutil.copytree(self.root/'export',dest/'export')
        other=Store(dest/'.runtime/review.sqlite3')
        try:
            with self.assertRaisesRegex(ValueError,'missing complete'):restore(other,dest/'export')
            self.assertEqual(other.objects(),[])
        finally:other.close()

    def test_nested_json_archive_and_catalog_survive_empty_restore(self):
        self.setup_plans();self.generate()
        prompt=p.record(self.store,'need-full-overall')['payload']['generation']['prompt']
        inner=json.dumps({'prompt':prompt,'number':1.0},ensure_ascii=True,indent=2)
        raw=json.dumps({'payload':inner,'copies':[inner,inner]},ensure_ascii=False,indent=3).encode()+b'\r\n'
        path=self.root/'production/requests/nested.json';path.parent.mkdir(parents=True);path.write_bytes(raw)
        doc=model.migration_plan(self.store,archive_paths=['production/requests/nested.json']);model.migrate(self.store,doc)
        self.assertEqual(archives.read_bytes(path),raw)
        self.assertNotIn(prompt,path.read_text())
        leaves=[json.loads(r['body']).get('value') for r in self.store.db.execute('SELECT body FROM material_content')]
        self.assertEqual(leaves.count(prompt),1)
        self.assertNotIn(inner,leaves)
        export(self.store,self.root/'export')
        dest=self.root/'empty';shutil.copytree(self.root/'export',dest/'export');other=Store(dest/'.runtime/review.sqlite3')
        try:
            restore(other,dest/'export')
            self.assertEqual(archives.read_bytes(dest/'production/requests/nested.json'),raw)
            self.assertEqual(storage.dump(other),storage.dump(self.store))
        finally:other.close()

    def test_raw_legacy_rollback_removes_only_feature_triggers(self):
        # A legacy baseline has no reference-encoded revisions or definition rows.
        doc=model.migration_plan(self.store)
        with self.store.db:self.store.db.execute('CREATE TRIGGER unrelated_audit AFTER INSERT ON objects BEGIN SELECT 1; END')
        model.migrate(self.store,doc,apply_archives=False)
        model.rollback(self.store,doc)
        import sqlite3
        raw=sqlite3.connect(self.store.db_path)
        try:
            names={r[0] for r in raw.execute("SELECT name FROM sqlite_master WHERE type='trigger'")}
            self.assertIn('unrelated_audit',names);self.assertFalse(names&set(storage.TRIGGERS))
            # No application UDF is registered on this old-writer connection.
            with raw:raw.execute("INSERT INTO objects VALUES ('old-writer','ENTITY','old-revision',1,'then','then')");raw.execute("INSERT INTO revisions VALUES ('old-revision','old-writer',1,'{}','then')")
        finally:raw.close()

    def test_constructor_failure_cleans_feature_triggers_before_old_runtime(self):
        from unittest.mock import patch
        import sqlite3
        target=self.root/'constructor-failure/review.sqlite3'
        with patch('review_desk.material_storage.row_factory',side_effect=RuntimeError('injected codec startup failure')):
            with self.assertRaisesRegex(RuntimeError,'injected'):Store(target)
        raw=sqlite3.connect(target)
        try:
            names={r[0] for r in raw.execute("SELECT name FROM sqlite_master WHERE type='trigger'")}
            self.assertFalse(names&set(storage.TRIGGERS))
            with raw:raw.execute("INSERT INTO objects VALUES ('old-writer','ENTITY','old-revision',1,'then','then')");raw.execute("INSERT INTO revisions VALUES ('old-revision','old-writer',1,'{}','then')")
        finally:raw.close()

    def test_legacy_recovery_refuses_concurrent_encoded_material_without_partial_inverse(self):
        doc=model.migration_plan(self.store);model.migrate(self.store,doc,apply_archives=False)
        self.setup_plans()
        before=self.store.revisions();indices=plans.dump(self.store);content=storage.dump(self.store)
        with self.assertRaisesRegex(ValueError,'referenced material revisions'):
            model.rollback(self.store,doc,require_legacy=True)
        self.assertEqual(self.store.revisions(),before)
        self.assertEqual(plans.dump(self.store),indices)
        self.assertEqual(storage.dump(self.store),content)

    def test_large_schema6_restore_reads_metadata_on_own_spilled_transaction(self):
        import sqlite3
        from unittest.mock import patch
        self.setup_plans();self.generate()
        raw=json.dumps({'prompt':'archive-lock-regression-'*8192},ensure_ascii=False).encode()
        name=digest(raw)+'.json';path=self.root/'export/assets'/name;path.write_bytes(raw)
        asset=p.record(self.store,'generated')['payload']
        self.change('generated',components=[*asset['components'],{'id':'request','role':'metadata',
            'file':name,'sha256':digest(raw),'bytes':len(raw),'mime':'application/json'}])
        export(self.store,self.root/'export')
        dest=self.root/'spill-restore';shutil.copytree(self.root/'export',dest/'export')
        other=Store(dest/'.runtime/review.sqlite3');other.db.execute('PRAGMA cache_size=1')
        other.db.execute('PRAGMA cache_spill=2')
        resolver=archives.resolver;locked=[]
        def observe(path):
            if archives._ACTIVE_READER.get() is not None and not locked:
                second=sqlite3.connect(other.db_path,timeout=0)
                try:
                    with self.assertRaisesRegex(sqlite3.OperationalError,'locked'):
                        second.execute('SELECT count(*) FROM material_content').fetchone()
                    locked.append(True)
                finally:second.close()
            return resolver(path)
        try:
            with patch.object(archives,'resolver',side_effect=observe):restore(other,dest/'export')
            self.assertEqual(locked,[True])
            self.assertEqual(archives.read_bytes(dest/'export/assets'/name),raw)
            self.assertEqual(other.revisions(),self.store.revisions())
            self.assertIsNone(archives._ACTIVE_READER.get())
        finally:other.close()
