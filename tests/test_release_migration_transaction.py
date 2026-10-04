"""Observe real SQLite transactions in an isolated model fixture, never the live store."""
import unittest
import test_material_model as fixtures
from review_desk import material_model as model


class ReleaseMigrationTransactionTest(unittest.TestCase):
    def test_deferred_release_delta_is_one_transaction_and_repeat_is_read_only(self):
        fixture = fixtures.MaterialModelTest()
        fixture.setUp()
        self.addCleanup(fixture.tearDown)
        fixture.setup_plans()
        fixture.generate()
        archive = fixture.root / 'production/requests/original.json'
        archive.parent.mkdir(parents=True)
        original = b'{ "prompt":"fixture raw original", "n":1.00 }\r\n'
        archive.write_bytes(original)
        plan = model.migration_plan(fixture.store, archive_paths=['production/requests/original.json'])
        logical = fixture.store.revisions()
        statements = []
        fixture.store.db.set_trace_callback(statements.append)
        result = model.migrate(fixture.store, plan, apply_archives=False)
        self.assertFalse(result['already_applied'])
        self.assertEqual([s for s in statements if s in ('BEGIN IMMEDIATE', 'COMMIT', 'ROLLBACK')], ['BEGIN IMMEDIATE', 'COMMIT'])
        self.assertEqual(archive.read_bytes(), original)
        self.assertEqual(fixture.store.revisions(), logical)
        physical = list(fixture.store.db.execute('SELECT id,payload FROM revisions ORDER BY id'))
        statements.clear()
        self.assertTrue(model.migrate(fixture.store, plan, apply_archives=False)['already_applied'])
        self.assertEqual([s for s in statements if s in ('BEGIN IMMEDIATE', 'COMMIT', 'ROLLBACK')], ['BEGIN IMMEDIATE', 'ROLLBACK'])
        self.assertFalse(any(s.startswith(('INSERT ', 'UPDATE ', 'DELETE ')) for s in statements))
        self.assertEqual(list(fixture.store.db.execute('SELECT id,payload FROM revisions ORDER BY id')), physical)
        self.assertEqual(archive.read_bytes(), original)
        fixture.store.db.set_trace_callback(None)


if __name__ == '__main__':
    unittest.main()
