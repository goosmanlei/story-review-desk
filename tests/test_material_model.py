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
    generate=fixtures.PlanVersionsTest.generate

    def test_expand_repeated_children_are_independent_at_every_returned_position(self):
        shared={'parts':[{'labels':['original']}]}
        value={'left':shared,'right':shared,'rows':[shared,{'nested':shared}]}
        key=storage.intern(self.store,value);self.store.db.commit()
        for options in ({},{'cache':{}}):
            with self.subTest(explicit_cache=bool(options)),p.read_scope(self.store):
                first=storage.expand(self.store,key,**options)
                second=storage.expand(self.store,key,**options)
                positions=[first['left'],first['right'],first['rows'][0],first['rows'][1]['nested']]
                self.assertEqual(len({id(item) for item in positions}),4)
                self.assertEqual(len({id(item['parts'][0]['labels']) for item in positions}),4)
                positions[0]['parts'][0]['labels'].append('local edit')
                positions[1]['parts'].append({'labels':['another edit']})
                self.assertEqual(positions[2],shared);self.assertEqual(positions[3],shared)
                self.assertEqual(second,value)
                self.assertEqual(storage.expand(self.store,key,**options),value)
            self.assertFalse(hasattr(self.store,'_production_reads'))

    def test_expand_recipe_and_inline_values_return_independent_mutable_trees(self):
        import base64,zlib
        def node(value):
            body=canonical(value);key=digest(body.encode())
            self.store.db.execute('INSERT OR IGNORE INTO material_content VALUES (?,?)',(key,body))
            return key
        token={'content':'token','encoding':'text','edits':[[0,0,'x']]}
        pieces=[token,token]
        cases=[(storage.intern_recipe(self.store,pieces),pieces),
               (node({'archive_recipe':pieces}),pieces),
               (node({'archive_recipe_zlib':base64.b64encode(zlib.compress(canonical(pieces).encode())).decode()}),pieces),
               (node({'value':pieces}),pieces)]
        self.store.db.commit()
        for key,expected in cases:
            with self.subTest(key=key):
                cache={};first=storage.expand(self.store,key,cache=cache)
                self.assertEqual(first,expected)
                self.assertIsNot(first[0],first[1])
                self.assertIsNot(first[0]['edits'],first[1]['edits'])
                first[0]['edits'][0].append('local edit')
                self.assertEqual(first[1],token)
                self.assertEqual(storage.expand(self.store,key,cache=cache),expected)

    def test_expand_failed_parent_is_not_cached_and_preserves_callers_visiting_set(self):
        def node(value):
            body=canonical(value);key=digest(body.encode())
            self.store.db.execute('INSERT OR IGNORE INTO material_content VALUES (?,?)',(key,body))
            return key
        leaf=storage.intern(self.store,{'value':['valid child']})
        failures=[(node({'array':[leaf,'f'*64]}),'missing or corrupt material content'),
                  (node({'object':[['same',leaf],['same',leaf]]}),'duplicate material object key'),
                  (node({'unsupported':leaf}),'invalid material content node')]
        self.store.db.commit()
        for key,message in failures:
            with self.subTest(key=key):
                cache={};visiting={'caller-parent'}
                for _ in range(2):
                    with self.assertRaisesRegex(ValueError,message):storage.expand(self.store,key,visiting,cache)
                    self.assertNotIn(key,cache)
                    self.assertEqual(visiting,{'caller-parent'})
                self.assertEqual(storage.expand(self.store,leaf,visiting,cache),{'value':['valid child']})
                self.assertEqual(visiting,{'caller-parent'})
        visiting={leaf}
        with self.assertRaisesRegex(ValueError,'cyclic material content reference'):
            storage.expand(self.store,leaf,visiting,{})
        self.assertEqual(visiting,{leaf})

    def test_read_scope_reuses_hydrated_text_with_independent_record_projections(self):
        from unittest.mock import patch
        self.setup_plans()
        original=p.record(self.store,'need-full-overall')
        raw=self.store.db.execute('SELECT payload AS stored_payload FROM revisions WHERE id=?',(original['id'],)).fetchone()[0]
        def read():
            return self.store.db.execute("SELECT ? AS payload,'REQUIREMENT' AS kind",(raw,)).fetchone()
        with patch.object(storage,'hydrate',wraps=storage.hydrate) as hydrated:
            with p.read_scope(self.store):
                first=p.record_view(read());second=p.record_view(read())
                self.assertEqual(hydrated.call_count,1)
                self.assertEqual(first['payload'],original['payload'])
                first['payload']['generation']['prompt']='temporary projection annotation'
                self.assertEqual(second['payload'],original['payload'])
                self.assertEqual(p.record_view(read())['payload'],original['payload'])
            self.assertFalse(hasattr(self.store,'_production_reads'))
            self.assertFalse(self.store.db.in_transaction)
            with p.read_scope(self.store):read()
            self.assertEqual(hydrated.call_count,2)
            read();read()
            self.assertEqual(hydrated.call_count,4)

    def test_read_scope_keeps_envelopes_original_layouts_and_custom_resolvers_distinct(self):
        self.setup_plans()
        payload=p.record(self.store,'need-full-overall')['payload']
        renamed={**payload,'title':'different title'}
        relocated={**payload,'scope':{'object_id':'different-scope','revision_id':'different-revision'}}
        layout=json.dumps(payload,ensure_ascii=True,indent=3)+'\r\n'
        examples=[(storage.encode(self.store,value),canonical(value)) for value in (payload,renamed,relocated)]
        examples.append((storage.encode(self.store,payload,layout),layout))
        self.store.db.commit()
        fields={key:value for key,value in payload.items() if key in storage.FIELDS}
        with p.read_scope(self.store):
            for raw,expected in [*examples,*reversed(examples)]:
                self.assertEqual(self.store.db.execute('SELECT ? AS payload',(raw,)).fetchone()[0],expected)
            # A direct custom resolver must not inherit the row factory's memo.
            resolved=storage.hydrate(self.store,examples[0][0],resolve=lambda key:{**fields,'purpose':'custom resolution'})
            self.assertEqual(json.loads(resolved)['purpose'],'custom resolution')
            self.assertEqual(self.store.db.execute('SELECT ? AS payload',(examples[0][0],)).fetchone()[0],examples[0][1])

    def test_failed_hydration_is_not_cached_and_scope_cleanup_allows_retry(self):
        from unittest.mock import patch
        self.setup_plans()
        payload=p.record(self.store,'need-full-overall')['payload']
        raw=storage.encode(self.store,payload);key=json.loads(raw)[storage.MARKER]
        correct=self.store.db.execute('SELECT body FROM material_content WHERE id=?',(key,)).fetchone()[0]
        # Inject physical corruption only in this disposable fixture database.
        with self.store.db:
            self.store.db.execute('DROP TRIGGER material_content_immutable')
            self.store.db.execute('UPDATE material_content SET body=? WHERE id=?',('{"value":"corrupt"}',key))
        missing=canonical({'format':'production-requirement-v1',storage.MARKER:'f'*64})
        for invalid in (missing,raw):
            with self.subTest(raw=invalid[:80]):
                with patch.object(storage,'hydrate',wraps=storage.hydrate) as hydrated:
                    with self.assertRaisesRegex(ValueError,'missing or corrupt material content'):
                        with p.read_scope(self.store):
                            with self.assertRaisesRegex(ValueError,'missing or corrupt material content'):
                                self.store.db.execute('SELECT ? AS payload',(invalid,)).fetchone()
                            self.store.db.execute('SELECT ? AS payload',(invalid,)).fetchone()
                    self.assertEqual(hydrated.call_count,2)
                self.assertFalse(hasattr(self.store,'_production_reads'))
                self.assertFalse(self.store.db.in_transaction)
        with self.store.db:self.store.db.execute('UPDATE material_content SET body=? WHERE id=?',(correct,key))
        with p.read_scope(self.store):
            self.assertEqual(json.loads(self.store.db.execute('SELECT ? AS payload',(raw,)).fetchone()[0]),payload)

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
        with self.store.db:self.store.db.execute('UPDATE revisions SET payload=? WHERE id=?',(encoded,row['id']))
        export(self.store,self.root/'export')
        dest=self.root/'layout-restore';shutil.copytree(self.root/'export',dest/'export')
        other=Store(dest/'.runtime/review.sqlite3')
        try:
            restore(other,dest/'export')
            self.assertEqual(p.record(other,revision_id=row['id'])['id'],row['id'])
            self.assertEqual(other.db.execute('SELECT payload FROM revisions WHERE id=?',(row['id'],)).fetchone()[0],raw)
            self.assertEqual(storage.physical_revisions(other),storage.physical_revisions(self.store))
            model.verify(other)
        finally:other.close()

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
            active=archives._ACTIVE_READER.get()
            if active is not None and active[0] is other and not locked:
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

    def test_export_archive_readers_release_graph_without_waiting_for_gc(self):
        import gc,tracemalloc
        root=self.root/'empty-archive-instance';(root/'export/assets').mkdir(parents=True)
        raw=b'{"prompt":"small"}';container=archives.encode(self.store,raw)
        rows=[dict(row) for row in self.store.db.execute('SELECT * FROM material_content')]
        # An unrelated graph makes retention visible without a large fixture.
        for i in range(3000):
            body=canonical({'value':str(i)+':'+'x'*200})
            rows.append({'id':digest(body.encode()),'body':body})
        (root/'export/material-content.json').write_text(canonical({'format':'material-content-v1','material_content':rows}))
        path=root/'export/assets/small.json';path.write_text(canonical(container))
        del rows
        gc.collect();enabled=gc.isenabled();gc.disable();tracemalloc.start()
        try:
            before=tracemalloc.get_traced_memory()[0]
            for _ in range(12):self.assertEqual(archives.read_bytes(path),raw)
            retained=tracemalloc.get_traced_memory()[0]-before
            self.assertLess(retained,2*1024*1024,'closed recursive readers retained export graphs')
        finally:
            tracemalloc.stop()
            if enabled:gc.enable()
            gc.collect()
