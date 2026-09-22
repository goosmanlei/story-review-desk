import json
import io
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from review_desk.bundle import export, restore
from review_desk.store import Conflict, Store
from review_desk.polish import build_context, suggest
from review_desk.configuration import catalog, migrate


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

    def test_remove_sources_cleans_exclusive_records_and_rejects_external_dependency(self):
        second = {**SOURCE, "id": "keep", "assets": [], "blocks": [{"id": "body", "text": "保留正文"}], "group": "folk-tales", "order": 1}
        self.store.put_source(second)
        self.store.create_comment({"source_id": "fixture", "anchor": {"block_id": "a", "end_block_id": "a", "start": 0, "end": 2, "quote": "甲乙"}, "body": "删除此评论"})
        target_revision = next(obj["current_revision"] for obj in self.store.objects() if obj["id"] == "fixture")
        self.store.put_object("related", "STORY", {"body": "相关"}, dependencies=[{"revision_id": target_revision, "role": "依据"}])
        with self.assertRaises(Conflict):
            self.store.remove_sources(["fixture"])
        self.assertEqual(len(self.store.comments()), 1)
        with self.store.db:
            self.store.db.execute("DELETE FROM dependencies WHERE to_revision=?", (target_revision,))
        self.assertEqual(self.store.remove_sources(["fixture"])["remaining"], 1)
        self.assertEqual([source["id"] for source in self.store.sources()], ["keep"])
        self.assertEqual(self.store.comments(), [])
        self.assertEqual(self.store.events(), [])
        self.assertEqual([obj["id"] for obj in self.store.objects()], ["keep", "related"])
        self.assertEqual(self.store.db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_story_refinement_group_is_supported(self):
        refinement = {
            **SOURCE,
            "id": "refinement-v1",
            "title": "故事精修第一版",
            "group": "story-refinements",
            "order": 1,
        }
        self.store.put_source(refinement)
        self.assertEqual(self.store.source("refinement-v1")["group"], "story-refinements")

    def test_replace_source_metadata_preserves_text_and_restore(self):
        old = self.store.objects()[0]["current_revision"]
        self.store.replace_source_metadata("fixture", {"assets": [], "notes": "更新元数据"})
        self.assertEqual(self.store.source("fixture")["blocks"], SOURCE["blocks"])
        self.assertEqual(self.store.source("fixture")["assets"], [])
        self.assertNotEqual(self.store.objects()[0]["current_revision"], old)
        self.assertEqual(len(self.store.revisions()), 1)
        manifest = export(self.store, self.root / "export")
        recovered = Store(self.root / "clean.sqlite3")
        try:
            restore(recovered, self.root / "export")
            self.assertEqual(recovered.sources(), self.store.sources())
            self.assertEqual(manifest["sources"], 1)
        finally:
            recovered.close()

    def test_local_media_is_hashed_and_required_on_restore(self):
        source = {**SOURCE, "id": "recording", "assets": [], "media": {"kind": "audio", "file": "recording.mp3", "label": "播讲", "note": "测试文件"}}
        self.store.put_source(source)
        asset = self.root / "export" / "assets" / "figure.svg"
        asset.parent.mkdir(parents=True)
        asset.write_text("<svg/>")
        (asset.parent / "recording.mp3").write_bytes(b"test media bytes")
        manifest = export(self.store, self.root / "export")
        self.assertIn("assets/recording.mp3", manifest["files"])
        (asset.parent / "recording.mp3").unlink()
        empty = Store(self.root / "empty.sqlite3")
        try:
            with self.assertRaises(FileNotFoundError):
                restore(empty, self.root / "export")
            self.assertEqual(empty.sources(), [])
        finally:
            empty.close()

    def test_export_restore_and_integrity(self):
        asset = self.root / "export" / "assets" / "figure.svg"
        asset.parent.mkdir(parents=True)
        asset.write_text("<svg/>")
        anchor = {"block_id": "a", "end_block_id": "a", "start": 1, "end": 3, "quote": "乙𪎊"}
        self.store.create_comment({"id": "one", "source_id": "fixture", "anchor": anchor, "body": "保留"})
        self.store.set_configuration("PROJECT", {"story_background": "李寄一则，见已收录原文。", "creative_background": "漫剧故事采编阶段。"}, 0)
        source_revision = self.store.objects()[0]["current_revision"]
        outline = self.store.put_object("outline-1", "STORY", {"title": "待写", "body": "甲乙丙"}, 0, [{"revision_id": source_revision, "role": "依据"}])
        object_anchor = {"block_id": "body", "end_block_id": "body", "start": 1, "end": 3, "quote": "乙丙"}
        self.store.create_comment({"id": "object-one", "target_object_id": "outline-1", "target_revision_id": outline["revision"], "anchor": object_anchor, "body": "核对故事稿"})
        self.store.put_object("outline-1", "STORY", {"title": "第二版", "body": "甲丁戊"}, 1, [{"revision_id": source_revision, "role": "依据"}])
        self.assertEqual(next(c for c in self.store.context() if c["id"] == "object-one")["block_text"], "甲乙丙")
        manifest = export(self.store, self.root / "export")
        self.assertEqual((manifest["sources"], manifest["comments"], manifest["events"], manifest["schema_version"]), (1, 2, 2, 3))
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
        with self.assertRaisesRegex(ValueError, "unknown configuration fields"):
            self.store.set_configuration("SYSTEM", {"enabled_workspaces": ["current", "story.sources", "project.configuration"]}, 0)
        self.assertNotIn("enabled_workspaces", catalog()["scopes"]["SYSTEM"])
        self.assertNotIn("enabled_workspaces", self.store.configuration("SYSTEM")["body"])
        self.assertNotIn("enabled_workspaces", migrate("SYSTEM", 2, {"ai_polish_model": "gpt-5.6-sol", "ai_polish_effort": "medium", "enabled_workspaces": ["project.configuration"]}))
        self.assertEqual(migrate("SYSTEM", 2, {"enabled_workspaces": ["project.configuration"]})["ai_polish_api_key_env"], "OPENAI_API_KEY")
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
        self.assertNotIn("reasoning", payload)
        self.assertEqual(migrate("SYSTEM", 1, {"ai_polish_model": "gpt-4.1-mini"})["ai_polish_effort"], "off")
        self.store.set_configuration("SYSTEM", {"ai_polish_model": "gpt-5.6-luna", "ai_polish_effort": "high"}, 0)
        preview = build_context(self.store, "fixture", anchor, "请核对字词")
        self.assertEqual((preview["model"], preview["reasoning_effort"]), ("gpt-5.6-luna", "high"))
        with patch.dict("os.environ", {"OPENAI_API_KEY": "test-local-key"}), patch("review_desk.polish.urlopen", return_value=io.BytesIO(json.dumps(response).encode())) as remote:
            suggest(preview)
        payload = json.loads(remote.call_args.args[0].data)
        self.assertEqual(payload["reasoning"], {"effort": "high"})
        self.assertEqual(payload["max_output_tokens"], 2048)
        with self.assertRaisesRegex(ValueError, "unsupported"):
            self.store.set_configuration("SYSTEM", {"ai_polish_model": "gpt-4.1-mini", "ai_polish_effort": "high"}, 1)

    def test_api_key_environment_name_not_secret(self):
        with self.assertRaisesRegex(ValueError, "environment variable name"):
            self.store.set_configuration("SYSTEM", {"ai_polish_api_key_env": "BAD-NAME"}, 0)
        self.store.set_configuration("SYSTEM", {"ai_polish_api_key_env": "STORY_POLISH_API_KEY"}, 0)
        anchor = {"block_id": "a", "end_block_id": "a", "start": 1, "end": 3, "quote": "乙𪎊"}
        preview = build_context(self.store, "fixture", anchor, "核对")
        self.assertEqual(preview["api_key_env_name"], "STORY_POLISH_API_KEY")
        response = {"output": [{"content": [{"type": "output_text", "text": "建议"}]}]}
        with patch.dict("os.environ", {"STORY_POLISH_API_KEY": "custom-secret"}), patch("review_desk.polish.urlopen", return_value=io.BytesIO(json.dumps(response).encode())) as remote:
            suggest(preview)
        self.assertEqual(remote.call_args.args[0].headers["Authorization"], "Bearer custom-secret")
        self.assertNotIn("custom-secret", json.dumps(self.store.configurations()))
        self.assertNotIn("custom-secret", json.dumps(self.store.configuration_events()))

    def test_external_performance_source(self):
        source = {**SOURCE, "id": "performance", "assets": [],
                  "media": {"kind": "video", "url": "https://example.org/watch", "label": "观看", "note": "第三方"},
                  "references": [{"label": "旁证", "url": "https://example.org/report"}]}
        self.store.put_source(source)
        self.assertEqual(self.store.source("performance")["media"]["kind"], "video")
        with self.assertRaisesRegex(ValueError, "media needs a local file or HTTPS URL"):
            self.store.put_source({**source, "id": "bad", "media": {**source["media"], "url": "javascript:alert(1)"}})

    def test_legacy_comment_migration(self):
        old_path = self.root / "legacy.sqlite3"
        old = sqlite3.connect(old_path)
        old.executescript("""CREATE TABLE sources(id TEXT PRIMARY KEY,document TEXT NOT NULL,revision TEXT NOT NULL);
        CREATE TABLE comments(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES sources(id),anchor TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE TABLE comment_events(id INTEGER PRIMARY KEY AUTOINCREMENT,comment_id TEXT NOT NULL REFERENCES comments(id),action TEXT NOT NULL,body TEXT NOT NULL,at TEXT NOT NULL);""")
        from review_desk.store import canonical, digest
        old.execute("INSERT INTO sources VALUES (?,?,?)", (SOURCE["id"], canonical(SOURCE), digest(canonical(SOURCE).encode())))
        anchor = {"block_id": "a", "end_block_id": "a", "start": 1, "end": 3, "quote": "乙𪎊"}
        old.execute("INSERT INTO comments VALUES (?,?,?,?,?,?,?,?)", ("legacy", SOURCE["id"], canonical(anchor), "核对", "OPEN", 1, "2026-09-21", "2026-09-21"))
        old.execute("INSERT INTO comment_events(comment_id,action,body,at) VALUES (?,?,?,?)", ("legacy", "CREATE", "核对", "2026-09-21"))
        old.commit()
        old.close()
        upgraded = Store(old_path)
        try:
            comment = upgraded.comment("legacy")
            self.assertEqual(comment["target_object_id"], SOURCE["id"])
            self.assertEqual(len(upgraded.events()), 1)
            self.assertEqual(upgraded.context()[0]["block_text"], SOURCE["blocks"][0]["text"])
            self.assertEqual(upgraded.db.execute("PRAGMA foreign_key_check").fetchall(), [])
        finally:
            upgraded.close()


if __name__ == "__main__":
    unittest.main()
