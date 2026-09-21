import json
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from review_desk.bundle import export, restore
from review_desk.store import Conflict, Store
from review_desk.polish import build_context, suggest


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
        self.store.set_configuration("PROJECT", {"story_background": "李寄一则，见已收录原文。", "creative_background": "漫剧故事采编阶段。"}, 0)
        source_revision = self.store.objects()[0]["current_revision"]
        self.store.put_object("outline-1", "STORY", {"title": "待写"}, 0, [{"revision_id": source_revision, "role": "依据"}])
        manifest = export(self.store, self.root / "export")
        self.assertEqual((manifest["sources"], manifest["comments"], manifest["events"]), (1, 1, 1))
        recovered = Store(self.root / "clean.sqlite3")
        try:
            restore(recovered, self.root / "export")
            self.assertEqual(recovered.sources(), self.store.sources())
            self.assertEqual(recovered.comments(), self.store.comments())
            self.assertEqual(recovered.events(), self.store.events())
            self.assertEqual(recovered.objects(), self.store.objects())
            self.assertEqual(recovered.revisions(), self.store.revisions())
            self.assertEqual(recovered.dependencies(), self.store.dependencies())
            self.assertEqual(recovered.configurations(), self.store.configurations())
            second = self.root / "second"
            (second / "assets").mkdir(parents=True)
            (second / "assets" / "figure.svg").write_bytes(asset.read_bytes())
            self.assertEqual(export(recovered, second), manifest)
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

    def test_configuration_and_ai_context(self):
        configured = self.store.set_configuration("PROJECT", {"story_background": "来自收录资料的故事背景", "creative_background": "首阶段只做故事采编", "target_medium": "漫剧"}, 0)
        self.assertEqual(configured["version"], 1)
        with self.assertRaises(Conflict):
            self.store.set_configuration("PROJECT", {"style": "待定"}, 0)
        with self.assertRaises(ValueError):
            self.store.set_configuration("SYSTEM", {"enabled_workspaces": ["invalid"]}, 0)
        anchor = {"block_id": "a", "end_block_id": "a", "start": 1, "end": 3, "quote": "乙𪎊"}
        preview = build_context(self.store, "fixture", anchor, "请核对字词")
        context = preview["context"]
        self.assertEqual(context["creative_stage"]["id"], "STORY_COMPILATION")
        self.assertEqual(context["story_background"], "来自收录资料的故事背景")
        self.assertEqual(context["creative_background"], "首阶段只做故事采编")
        self.assertEqual(context["neighbor_blocks"][0]["text"], SOURCE["blocks"][0]["text"])
        self.assertIn("甲乙𪎊丁", context["source_documents"][0]["text"])
        self.assertEqual(len(preview["context_sha256"]), 64)
        response = {"output": [{"content": [{"type": "output_text", "text": "建议核对字词"}]}]}
        with patch.dict("os.environ", {"OPENAI_API_KEY": "test-local-key"}), patch("review_desk.polish.urlopen", return_value=io.BytesIO(json.dumps(response).encode())) as remote:
            result = suggest(preview)
        payload = json.loads(remote.call_args.args[0].data)
        self.assertEqual(result["suggestion"], "建议核对字词")
        self.assertFalse(payload["store"])
        self.assertEqual(json.loads(payload["input"])["creative_background"], "首阶段只做故事采编")
        self.assertEqual(json.loads(payload["input"])["source_documents"][0]["source_url"], SOURCE["source_url"])


if __name__ == "__main__":
    unittest.main()
