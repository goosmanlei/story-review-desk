import json
import unittest

import test_audiovisual as fixtures
from review_desk import numbering_restart as numbering, business_codes, production as p
from review_desk.candidate_reset import fingerprint
from review_desk.store import Conflict


class NumberingRestartTest(unittest.TestCase):
    setUp = fixtures.AudiovisualTest.setUp
    tearDown = fixtures.AudiovisualTest.tearDown
    spec = fixtures.AudiovisualTest.spec
    put = fixtures.AudiovisualTest.put
    ref = fixtures.AudiovisualTest.ref
    setup_story = fixtures.AudiovisualTest.setup_story
    shot = fixtures.AudiovisualTest.shot
    composition = fixtures.AudiovisualTest.composition
    need = fixtures.AudiovisualTest.need

    def prepared(self):
        self.composition()
        self.put(self.need('need'))
        with self.store.db:
            self.store.db.execute("UPDATE business_codes SET number=number+100 WHERE prefix IN ('AE','AS','ASH','EN','ST','M')")
            self.store.db.execute("INSERT INTO business_codes VALUES ('deleted-old-shot','ASH',1)")
        return numbering.prepare(self.store, 'explicit-fixture-only')

    def test_exact_migration_preserves_bodies_and_historical_collision(self):
        plan = self.prepared()
        old = fingerprint(self.store)
        numbering.apply(self.store, plan)
        new = fingerprint(self.store)
        for table in old.keys()-{'business_codes', 'production_current_operations'}:
            self.assertEqual(old[table], new[table], table)
        self.assertEqual(numbering.historical(self.store, 'deleted-old-shot')['number'], 1)
        current = {r['object_id']: business_codes.code(r) for r in business_codes.visible_codes(self.store)}
        self.assertEqual(current['av-shot'], 'ASH001')
        self.assertNotIn('deleted-old-shot', current)
        self.assertTrue(numbering.apply(self.store, plan)['already_applied'])
        with self.assertRaises(Conflict):
            numbering.prepare(self.store, 'another-authorization')

    def test_stale_plan_and_interruption_are_atomic(self):
        plan = self.prepared()
        before = fingerprint(self.store)
        for fault in ('after-delete', 'before-commit'):
            with self.assertRaises(RuntimeError):
                numbering.apply(self.store, plan, fault=fault)
            self.assertEqual(before, fingerprint(self.store))
        with self.store.db:
            self.store.db.execute("INSERT INTO business_codes VALUES ('concurrent-allocation','EN',999)")
        changed = fingerprint(self.store)
        with self.assertRaisesRegex(Conflict, '过期'):
            numbering.apply(self.store, plan)
        self.assertEqual(changed, fingerprint(self.store))

    def test_append_delete_and_initialization_never_reuse_or_renumber(self):
        plan = self.prepared()
        numbering.apply(self.store, plan)
        with self.store.db:
            business_codes.allocate_number(self.store, 'new-shot', 'ASH')
            # Ordinary deletion retains its allocation; no counter reuse.
            business_codes.allocate_number(self.store, 'next-shot', 'ASH')
            business_codes.allocate_number(self.store, 'deleted-old-shot', 'ASH')
        rows = {r['object_id']: r['number'] for r in business_codes.dump(self.store)}
        self.assertEqual(rows['new-shot'], 2)
        self.assertEqual(rows['next-shot'], 3)
        self.assertNotIn('deleted-old-shot', rows)
        business_codes.initialize(self.store)
        self.assertEqual(rows, {r['object_id']: r['number'] for r in business_codes.dump(self.store)})

    def test_candidate_uses_one_material_number_and_preserves_submission(self):
        import io
        import wave
        from review_desk.production_media import ingest
        self.composition()
        self.put(self.spec('need', 'REQUIREMENT', scope=self.ref('av-shot'), slot='sound', required=False,
                           purpose='隔离候选编号', media_type='audio', usage='review_reference', entities=[], states=[], specification={}))
        self.put(self.spec('call', 'CALL', method='recording', tool='fixture', status='submitted', inputs=[], outputs=[]))
        raw = io.BytesIO()
        with wave.open(raw, 'wb') as wav:
            wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(48000); wav.writeframes(b'\0\0'*480)
        raw.seek(0)
        component = ingest(self.root, raw, 'fixture.wav')
        self.put(self.spec('asset', 'ASSET', media_type='audio', subjects=[], states=[], components=[component],
                           production=self.ref('call'), lineage={}, candidate_requirements=[self.ref('need')]))
        submission = list(self.store.db.execute('SELECT * FROM production_submissions'))
        targets = list(self.store.db.execute('SELECT * FROM production_candidate_targets'))
        plan = numbering.prepare(self.store, 'explicit-candidate-fixture')
        self.assertEqual(plan['counts']['M'], 1)
        numbering.apply(self.store, plan)
        record = business_codes.annotate(self.store, p.record(self.store, 'asset'))
        self.assertEqual(record['candidate_codes'][0]['code'], 'M001 / MC001')
        self.assertEqual(submission, list(self.store.db.execute('SELECT * FROM production_submissions')))
        self.assertEqual(targets, list(self.store.db.execute('SELECT * FROM production_candidate_targets')))
        self.put(self.spec('call-two', 'CALL', method='recording', tool='fixture', status='submitted', inputs=[], outputs=[]))
        self.put(self.spec('asset-two', 'ASSET', media_type='audio', subjects=[], states=[], components=[component],
                           production=self.ref('call-two'), lineage={}, candidate_requirements=[self.ref('need')]))
        self.assertFalse(self.store.db.execute("SELECT 1 FROM business_codes WHERE object_id='asset-two'").fetchone())
        self.assertEqual(business_codes.annotate(self.store, p.record(self.store, 'asset-two'))['candidate_codes'][0]['code'], 'M001 / MC002')


if __name__ == '__main__':
    unittest.main()
