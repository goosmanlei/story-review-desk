"""Generic in-place content publishing, independent of any authoring workflow."""

import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from review_desk.bundle import export, restore
from review_desk.store import Conflict, Store, canonical, digest


SOURCE = {
    "id": "refinement-test", "title": "故事精修一", "version_type": "原创",
    "origin": "test", "source_url": "https://example.org/source", "collected_at": "2026-09-23",
    "notes": "原稿", "assets": [], "blocks": [{"id": "old", "text": "原有正文"}],
    "group": "story-refinements", "order": 1,
}


class SourceReplacementTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.store = Store(self.root / "formal.sqlite3")
        self.original_revision = self.store.put_source(SOURCE)
        self.document = {**SOURCE, "blocks": [{"id": "body", "text": "完整修订后的正文"}]}

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def test_in_place_identity_idempotency_and_export_restore(self):
        result = self.store.replace_source_content(self.document, self.original_revision)
        self.assertTrue(result["changed"])
        self.assertEqual(result["revision"], digest(canonical(self.document).encode()))
        before = (self.store.sources(), self.store.objects(), self.store.revisions())
        self.assertFalse(self.store.replace_source_content(self.document, self.original_revision)["changed"])
        self.assertEqual(before, (self.store.sources(), self.store.objects(), self.store.revisions()))
        self.assertEqual([s["id"] for s in self.store.sources()], [SOURCE["id"]])
        self.assertEqual(len(self.store.revisions()), 1)
        manifest = export(self.store, self.root / "export")
        recovered = Store(self.root / "recovered.sqlite3")
        try:
            restore(recovered, self.root / "export")
            self.assertEqual(recovered.sources(), self.store.sources())
            self.assertEqual(export(recovered, self.root / "export-again"), manifest)
        finally:
            recovered.close()

    def test_unrelated_comments_untouched_and_normal_import_immutable(self):
        other = {**SOURCE, "id": "other", "group": "folk-tales"}
        self.store.put_source(other)
        self.store.create_comment({"source_id": "other", "body": "保留评论", "anchor": {
            "block_id": "old", "end_block_id": "old", "start": 0, "end": 2, "quote": "原有"}})
        before = (self.store.source("other"), self.store.comments(), self.store.events())
        with self.assertRaises(Conflict):
            self.store.put_source(self.document)
        self.store.replace_source_content(self.document, self.original_revision)
        self.assertEqual(before, (self.store.source("other"), self.store.comments(), self.store.events()))

    def test_new_comments_and_stale_revision_reject(self):
        with self.assertRaises(Conflict):
            self.store.replace_source_content(self.document, "0" * 64)
        self.store.create_comment({"source_id": SOURCE["id"], "body": "刚新增的评论", "anchor": {
            "block_id": "old", "end_block_id": "old", "start": 0, "end": 2, "quote": "原有"}})
        before = (self.store.comments(), self.store.events())
        with self.assertRaises(Conflict):
            self.store.replace_source_content(self.document, self.original_revision)
        self.assertEqual(self.store.source(SOURCE["id"]), SOURCE)
        self.assertEqual(before, (self.store.comments(), self.store.events()))

    def test_incoming_and_outgoing_dependencies_reject(self):
        source_revision = self.store.objects()[0]["current_revision"]
        other = self.store.put_object("dependent", "STORY", {"body": "关联内容"})["revision"]
        for origin, target in ((other, source_revision), (source_revision, other)):
            with self.subTest(origin=origin):
                with self.store.db:
                    self.store.db.execute("INSERT INTO dependencies VALUES (?,?,?)", (origin, target, "basis"))
                with self.assertRaises(Conflict):
                    self.store.replace_source_content(self.document, self.original_revision)
                self.assertEqual(self.store.source(SOURCE["id"]), SOURCE)
                with self.store.db:
                    self.store.db.execute("DELETE FROM dependencies WHERE from_revision=? AND to_revision=?", (origin, target))

    def test_replacement_failure_rolls_back_all_rows(self):
        before = (self.store.sources(), self.store.objects(), self.store.revisions())
        self.store.db.execute("CREATE TRIGGER fail_update BEFORE UPDATE ON objects BEGIN SELECT RAISE(ABORT,'injected failure'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.store.replace_source_content(self.document, self.original_revision)
        self.assertEqual(before, (self.store.sources(), self.store.objects(), self.store.revisions()))

    def test_single_revision_refinement_and_identity_guards(self):
        ordinary = {**SOURCE, "id": "folk", "group": "folk-tales"}
        ordinary_revision = self.store.put_source(ordinary)
        for doc, revision in (({**ordinary, "notes": "改"}, ordinary_revision),
                              ({**self.document, "order": 2}, self.original_revision),
                              ({**self.document, "id": "missing"}, self.original_revision)):
            with self.subTest(id=doc["id"], order=doc["order"]), self.assertRaises(ValueError):
                self.store.replace_source_content(doc, revision)
        # Construct a multiple-revision fixture; normal source imports cannot do so.
        with self.store.db:
            self.store.db.execute("INSERT INTO revisions VALUES (?,?,?,?,?)", ("another-revision", SOURCE["id"], 2, "{}", "test"))
        with self.assertRaises(Conflict):
            self.store.replace_source_content(self.document, self.original_revision)
        self.assertEqual(self.store.source(SOURCE["id"]), SOURCE)

    def test_cli_keeps_publisher_but_has_no_authoring_commands(self):
        result = subprocess.run([sys.executable, "-m", "review_desk", "--help"],
                                cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("replace-source-content", result.stdout)
        self.assertNotIn("writing", result.stdout)


if __name__ == "__main__":
    unittest.main()
