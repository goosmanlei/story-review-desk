import tempfile
import unittest
from pathlib import Path

from review_desk import material_version_retirement as retirement
from review_desk.store import Store, Conflict
from review_desk.bundle import export, restore


class RemovalTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.store = Store(self.root / '.runtime/review.sqlite3')
        self.addCleanup(self.store.close)
        self.store.put_object('story', 'STORY', {'title': '保留故事', 'blocks': []})

    def old_indexes(self):
        with self.store.db:
            self.store.db.execute('CREATE TABLE material_plan_versions (id TEXT PRIMARY KEY, content TEXT)')
            self.store.db.execute("INSERT INTO material_plan_versions VALUES ('old','DISCARDED-MATERIAL-DRAFT')")
            self.store.db.execute("INSERT INTO production_legacy_links VALUES ('old','need','REQUIREMENT',NULL,NULL,NULL,'removed','hash')")
            self.store.db.execute("INSERT INTO consolidation_revisions VALUES ('old','need','REQUIREMENT',2,NULL,'hash',NULL,'prior')")
            self.store.db.execute("INSERT INTO consolidation_missing VALUES ('old','input','entity','earlier')")
            self.store.db.execute('CREATE TABLE IF NOT EXISTS read_generations (name TEXT PRIMARY KEY, token TEXT NOT NULL)')
            self.store.db.execute("INSERT OR REPLACE INTO read_generations VALUES ('material_plan_versions',?)", ('a'*32,))

    def test_physical_removal_preserves_other_rows_and_is_repeatable(self):
        self.old_indexes()
        before = retirement.inventory(self.store)
        receipt = retirement.apply(self.store, expected=before)
        retirement.validate_absent(self.store)
        self.assertEqual(receipt['removed_draft_links'], 1)
        self.assertEqual(receipt['freelist_pages'], 0)
        self.assertFalse(receipt['backup_created'])
        self.assertFalse(self.store.db.execute("SELECT 1 FROM read_generations WHERE name='material_plan_versions'").fetchone())
        self.assertNotIn(b'DISCARDED-MATERIAL-DRAFT', self.store.db_path.read_bytes())
        for table in receipt['preserved_tables']:
            self.assertEqual(receipt['after'][table], before[table])
        self.assertEqual(retirement.apply(self.store)['removed_draft_links'], 0)

    def test_interruption_rolls_back_and_changed_inventory_is_rejected(self):
        self.old_indexes()
        before = retirement.inventory(self.store)
        with self.assertRaisesRegex(RuntimeError, 'interruption'):
            retirement.apply(self.store, fault='before-commit')
        self.assertEqual(retirement.inventory(self.store), before)
        self.store.put_object('another', 'STORY', {'title': '并行新增', 'blocks': []})
        with self.assertRaisesRegex(Conflict, 'changed'):
            retirement.apply(self.store, expected=before)
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM material_plan_versions').fetchone()[0], 1)

    def test_fresh_store_and_public_recovery_never_create_removed_storage(self):
        retirement.validate_absent(self.store)
        manifest = export(self.store, self.root / 'export')
        self.assertEqual(manifest['schema_version'], 15)
        restored = Store(self.root / 'restored/.runtime/review.sqlite3')
        self.addCleanup(restored.close)
        restore(restored, self.root / 'export')
        retirement.validate_absent(restored)
        self.assertEqual(export(restored, self.root / 'second-export'), manifest)

    def test_export_rejects_unpurged_data(self):
        self.old_indexes()
        with self.assertRaisesRegex(ValueError, 'retired material storage'):
            export(self.store, self.root / 'export')
