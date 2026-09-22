import sqlite3
import tempfile
import unittest
from pathlib import Path

from review_desk.bundle import export, restore
from review_desk.store import Conflict, Store
from review_desk.writing import WritingStore, checksum


SOURCE = {
    "id": "refinement-test", "title": "故事精修一", "version_type": "原创",
    "origin": "test", "source_url": "https://example.org/source", "collected_at": "2026-09-23",
    "notes": "原梗概", "assets": [], "blocks": [{"id": "old", "text": "原有梗概"}],
    "group": "story-refinements", "order": 1,
}


class WritingTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.path = self.root / "working" / "work.sqlite3"
        self.work = WritingStore(self.path)
        self.seed = {"source": SOURCE, "source_revision": checksum(SOURCE), "constraints": ["逐片段写作"],
                     "book_title": "测试小说", "notes": {"outlook": "初步构想", "facts": {}, "issues": {}}}
        self.work.init(self.seed)
        self.formal = Store(self.root / "formal.sqlite3")
        self.formal.put_source(SOURCE)

    def tearDown(self):
        self.work.close()
        self.formal.close()
        self.tmp.cleanup()

    def begin(self, step="s1", action="WRITE", targets=None):
        context = self.work.context()
        spec = {"step_id": step, "base_revision": context["revision"], "action": action,
                "targets": targets if targets is not None else [step], "purpose": "test",
                "chapter_id": "c01", "chapter_title": "第一章 灯"}
        self.work.begin(spec)
        return spec

    def write(self, step="s1", text="她把灯放在门边。"):
        self.begin(step)
        self.work.save_candidate(step, {"fragments": [{"id": step, "text": text}]})
        self.work.read_candidate(step)
        return self.work.accept(step, {"observations": "动作成立", "updates": {"next": "继续"}})

    def ready(self):
        self.write()
        for phase in ("FULL_DRAFT", "REVISING", "READY_TO_PUBLISH"):
            head = self.work.context(full=True)["revision"]
            self.work.stage({"phase": phase, "base_revision": head, "review": "全稿检查通过",
                             "checked_fragment_ids": ["s1"],
                             "checks": {k: True for k in ("complete", "causality", "continuity", "language", "clean_copy")}})
        return self.work.bundle()

    def test_serial_scope_and_reread_are_required(self):
        spec = self.begin()
        with self.assertRaises(Conflict):
            self.work.begin({**spec, "step_id": "s2", "targets": ["s2"]})
        with self.assertRaises(ValueError):
            self.work.save_candidate("s1", {"fragments": [{"id": "s1", "text": "甲"}, {"id": "s2", "text": "乙"}]})
        with self.assertRaises(ValueError):
            self.work.save_candidate("s1", {"fragments": [{"id": "s1", "text": "字" * 2201}]})
        self.work.save_candidate("s1", {"fragments": [{"id": "s1", "text": "甲"}]})
        with self.assertRaises(Conflict):
            self.work.accept("s1", {"observations": "未重读", "updates": {}})
        self.assertEqual(self.work.status()["fragments"], 0)

    def test_candidate_resume_and_acceptance_idempotency(self):
        self.begin()
        candidate = {"fragments": [{"id": "s1", "text": "甲"}]}
        saved = self.work.save_candidate("s1", candidate)
        self.work.close()
        self.work = WritingStore(self.path)
        self.assertEqual(saved, self.work.save_candidate("s1", candidate))
        with self.assertRaises(Conflict):
            self.work.save_candidate("s1", {"fragments": [{"id": "s1", "text": "乙"}]})
        self.work.read_candidate("s1")
        review = {"observations": "读过保存结果", "updates": {}}
        result = self.work.accept("s1", review)
        self.work.close()
        self.work = WritingStore(self.path)
        self.assertEqual(result, self.work.accept("s1", review))
        self.assertEqual(self.work.status()["fragments"], 1)
        self.assertEqual(self.work.context()["fragments"][0]["text"], "甲")

    def test_old_context_and_bad_notes_cannot_overwrite(self):
        old = self.work.context()["revision"]
        self.write()
        with self.assertRaises(Conflict):
            self.work.begin({"step_id": "s2", "base_revision": old, "action": "WRITE", "targets": ["s2"], "purpose": "stale"})
        self.begin("s2")
        self.work.save_candidate("s2", {"fragments": [{"id": "s2", "text": "乙"}]})
        self.work.read_candidate("s2")
        current = self.work.current()
        with self.assertRaises(ValueError):
            self.work.accept("s2", {"observations": "无效引用", "updates": {"facts": {"bad": {"text": "不存在", "fragment_ids": ["missing"]}}}})
        self.assertEqual(current, self.work.current())
        self.assertEqual(self.work.status()["active"][0]["status"], "CANDIDATE_SAVED")

    def test_real_revision_updates_prose_and_fact_together(self):
        self.write(text="她没有见过祭册。")
        self.begin("r1", "REVISE", ["s1"])
        self.work.save_candidate("r1", {"fragments": [{"id": "s1", "text": "她见过祭册上的名字。"}]})
        self.work.read_candidate("r1")
        review = {"observations": "更改知情范围", "updates": {"facts": {"knowledge": {"text": "已见祭册", "fragment_ids": ["s1"]}}},
                  "rechecked_fragment_ids": ["s1"], "dependency_review": "尚无后文；下一步须据此续写"}
        self.work.accept("r1", review)
        context = self.work.context()
        self.assertIn("见过祭册", context["fragments"][0]["text"])
        self.assertEqual(context["notes"]["facts"]["knowledge"]["text"], "已见祭册")
        self.assertEqual(self.formal.source(SOURCE["id"]), SOURCE)

    def test_blocker_prevents_forward_writing_not_reflection(self):
        self.begin("think", "REFLECT", [])
        self.work.save_candidate("think", {"reflection": "动机冲突，应先修"})
        self.work.read_candidate("think")
        self.work.accept("think", {"observations": "阻止照提纲强推", "updates": {"issues": {"causality": {"status": "OPEN", "blocking": True}}}})
        with self.assertRaises(Conflict):
            self.begin()
        self.begin("think2", "REFLECT", [])
        self.work.reject("think2", "保留后重新判断")
        self.assertFalse(self.work.status()["active"])

    def test_no_bundle_before_complete_checks_and_publish_recovery(self):
        with self.assertRaises(Conflict):
            self.work.bundle()
        package = self.ready()
        self.assertEqual(self.formal.source(SOURCE["id"]), SOURCE)
        self.work.close()
        self.work = WritingStore(self.path)
        self.assertEqual(package, self.work.bundle())
        with self.assertRaises(Conflict):
            self.work.published(self.formal.db_path)
        self.formal.replace_source_content(package["document"], package["expected_source_revision"])
        # Publication succeeded, author checkpoint did not yet record it.
        self.work.close()
        self.work = WritingStore(self.path)
        self.assertEqual(self.work.published(self.formal.db_path)["phase"], "PUBLISHED")
        self.assertEqual(self.work.published(self.formal.db_path)["phase"], "PUBLISHED")

    def test_in_place_identity_idempotency_and_export_restore(self):
        package = self.ready()
        first = self.formal.replace_source_content(package["document"], package["expected_source_revision"])
        self.assertTrue(first["changed"])
        self.assertFalse(self.formal.replace_source_content(package["document"], package["expected_source_revision"])["changed"])
        self.assertEqual([s["id"] for s in self.formal.sources()], [SOURCE["id"]])
        self.assertEqual(len(self.formal.revisions()), 1)
        manifest = export(self.formal, self.root / "export")
        recovered = Store(self.root / "recovered.sqlite3")
        try:
            restore(recovered, self.root / "export")
            self.assertEqual(recovered.sources(), self.formal.sources())
            self.assertEqual(export(recovered, self.root / "export-again"), manifest)
        finally:
            recovered.close()

    def test_bundle_uses_seed_title_without_story_specific_metadata(self):
        package = self.ready()
        self.assertEqual(package["document"]["text_heading"], "测试小说 · 小说全文")
        self.assertEqual(package["document"]["edition"], "小说完本稿")
        self.assertTrue(package["markdown"].startswith("# 测试小说\n"))
        self.assertNotIn("把灯带回家", str(package))

    def test_source_comments_dependencies_and_stale_hash_reject(self):
        doc = {**SOURCE, "blocks": [{"id": "novel", "text": "完整小说"}]}
        with self.assertRaises(Conflict):
            self.formal.replace_source_content(doc, "0" * 64)
        revision = self.formal.objects()[0]["current_revision"]
        self.formal.put_object("dependent", "STORY", {"body": "引用"}, dependencies=[{"revision_id": revision, "role": "basis"}])
        with self.assertRaises(Conflict):
            self.formal.replace_source_content(doc, checksum(SOURCE))
        with self.formal.db:
            self.formal.db.execute("DELETE FROM dependencies")
        self.formal.create_comment({"source_id": SOURCE["id"], "anchor": {"block_id": "old", "end_block_id": "old", "start": 0, "end": 2, "quote": "原有"}, "body": "刚新增的评论"})
        with self.assertRaises(Conflict):
            self.formal.replace_source_content(doc, checksum(SOURCE))
        self.assertEqual(self.formal.source(SOURCE["id"]), SOURCE)
        self.assertEqual(len(self.formal.comments()), 1)

    def test_replacement_failure_rolls_back_all_rows(self):
        doc = {**SOURCE, "blocks": [{"id": "novel", "text": "完整小说"}]}
        before = (self.formal.sources(), self.formal.objects(), self.formal.revisions())
        self.formal.db.execute("CREATE TRIGGER fail_update BEFORE UPDATE ON objects BEGIN SELECT RAISE(ABORT,'injected failure'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.formal.replace_source_content(doc, checksum(SOURCE))
        self.assertEqual(before, (self.formal.sources(), self.formal.objects(), self.formal.revisions()))

    def test_single_revision_and_refinement_only_guard(self):
        ordinary = {**SOURCE, "id": "folk", "group": "folk-tales"}
        self.formal.put_source(ordinary)
        with self.assertRaises(ValueError):
            self.formal.replace_source_content({**ordinary, "notes": "改"}, checksum(ordinary))
        with self.assertRaises(ValueError):
            self.formal.replace_source_content({**SOURCE, "order": 2}, checksum(SOURCE))


if __name__ == "__main__":
    unittest.main()
