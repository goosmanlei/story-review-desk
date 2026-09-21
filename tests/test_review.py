import json
import tempfile
import unittest
from pathlib import Path

from review_desk.bundle import export, restore
from review_desk.store import Conflict, Store


SOURCE = {
    "id": "fixture", "title": "Fixture", "version_type": "original", "origin": "test",
    "source_url": "https://example.org/test", "collected_at": "2026-09-21", "notes": "test",
    "assets": [{"file": "figure.svg", "title": "chart", "source_url": "https://example.org/test"}],
    "blocks": [{"id": "a", "text": "甲乙𪎊丁"}, {"id": "b", "text": "戊己庚辛"}],
}


class ReviewTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.store = Store(self.root / "review.sqlite3")
        self.store.put_source(SOURCE)

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def test_anchor_comment_lifecycle(self):
        anchor = {"block_id": "a", "end_block_id": "b", "start": 1, "end": 2, "quote": "乙𪎊丁\n戊己"}
        comment = self.store.create_comment({"id": "one", "source_id": "fixture", "anchor": anchor, "body": "核对"})
        self.assertEqual(comment["version"], 1)
        self.assertEqual(self.store.create_comment({"id": "one", "source_id": "fixture", "anchor": anchor, "body": "核对"})["version"], 1)
        with self.assertRaises(Conflict):
            self.store.create_comment({"id": "two", "source_id": "fixture", "anchor": {**anchor, "quote": "错"}, "body": "核对"})
        comment = self.store.change_comment("one", "EDIT", 1, "重新核对")
        self.assertEqual(comment["version"], 2)
        with self.assertRaises(Conflict):
            self.store.change_comment("one", "CLOSE", 1)
        self.assertEqual(self.store.change_comment("one", "CLOSE", 2)["status"], "CLOSED")
        with self.assertRaises(Conflict):
            self.store.change_comment("one", "EDIT", 3, "不允许")
        self.assertEqual(self.store.change_comment("one", "REOPEN", 3)["status"], "OPEN")
        self.assertEqual(len(self.store.events()), 4)
        self.assertEqual(self.store.context()[0]["block_text"], "甲乙𪎊丁")

    def test_export_restore_and_integrity(self):
        asset = self.root / "export" / "assets" / "figure.svg"
        asset.parent.mkdir(parents=True)
        asset.write_text("<svg/>")
        anchor = {"block_id": "a", "end_block_id": "a", "start": 1, "end": 3, "quote": "乙𪎊"}
        self.store.create_comment({"id": "one", "source_id": "fixture", "anchor": anchor, "body": "保留"})
        manifest = export(self.store, self.root / "export")
        self.assertEqual((manifest["sources"], manifest["comments"], manifest["events"]), (1, 1, 1))
        recovered = Store(self.root / "clean.sqlite3")
        try:
            restore(recovered, self.root / "export")
            self.assertEqual(recovered.sources(), self.store.sources())
            self.assertEqual(recovered.comments(), self.store.comments())
            self.assertEqual(recovered.events(), self.store.events())
        finally:
            recovered.close()
        asset.write_text("tampered")
        empty = Store(self.root / "empty.sqlite3")
        try:
            with self.assertRaisesRegex(ValueError, "checksum"):
                restore(empty, self.root / "export")
            self.assertEqual(empty.sources(), [])
        finally:
            empty.close()


if __name__ == "__main__":
    unittest.main()
