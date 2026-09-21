import json
import tempfile
import unittest
from pathlib import Path

from review_desk.bundle import export, restore
from review_desk.store import Conflict, Store
from review_desk.structure import (
    confirm_structure, import_structure, review_context, script_input,
    select_direction, snapshot,
)
from review_desk.polish import build_context


def direction(id, title):
    return {"id": id, "title": title, "version_type": "原创扩写方向", "origin": "隔离验收示例",
            "source_url": "https://example.org/illustrative", "collected_at": "2026-09-22",
            "blocks": [{"id": "summary", "text": "李寄主动应募，村人面对旧规矩。"}],
            "notes": "仅作测试", "assets": [], "group": "expansion-directions"}


def document(selection, parent=None, responses=None, second=False):
    sections = []
    names = [("theme", "主题"), ("characters", "人物塑造"), ("relationships", "人物关系"),
             ("spaces", "空间关系"), ("storylines", "故事线"), ("timeline", "时间线")]
    for key, title in names:
        section = {"id": key, "title": title, "blocks": [{"id": key + "-one", "text": title + "：李寄主动判断。"},
                                                        {"id": key + "-two", "text": ("调整后，村人先帮助准备。" if second else "村人尚未行动。")}]}
        if key == "relationships":
            section["visuals"] = [{"id": "relation-graph", "kind": "diagram", "title": "人物关系图", "file": "relation.svg",
                                   "alt": "李寄与村人的关系", "description": "箭头表示帮助与阻力，与正文一致。"}]
        sections.append(section)
    return {"title": "李寄斩蛇 · 验收示例", "sections": sections,
            "direction_selection_revision": selection, "parent_revision": parent,
            "responses": responses or [], "illustrative": True}


class StructureTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.assets = self.root / "export" / "assets"
        self.assets.mkdir(parents=True)
        self.assets.joinpath("relation.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 80"><text x="10" y="30">李寄 → 村人</text></svg>')
        self.store = Store(self.root / ".runtime" / "review.sqlite3")
        self.store.put_source(direction("direction-a", "方向 A"))
        self.store.put_source(direction("direction-b", "方向 B"))

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def test_review_revision_and_script_handoff(self):
        selected = select_direction(self.store, "direction-a", 0)
        first = import_structure(self.store, document(selected["revision"]), 0)
        blocks = document(selected["revision"])["sections"][0]["blocks"]
        text_anchor = {"type": "text", "block_id": blocks[0]["id"], "end_block_id": blocks[1]["id"],
                       "start": 0, "end": len(blocks[1]["text"]),
                       "quote": blocks[0]["text"] + "\n" + blocks[1]["text"]}
        text = self.store.create_comment({"target_object_id": "story-structure", "target_revision_id": first["revision"],
                                          "anchor": text_anchor, "body": "请给村人具体行动"})
        region = self.store.create_comment({"target_object_id": "story-structure", "target_revision_id": first["revision"],
                                            "anchor": {"type": "region", "visual_id": "relation-graph", "asset_file": "relation.svg",
                                                       "points": [{"x": .1, "y": .2}, {"x": .8, "y": .2}, {"x": .8, "y": .8}, {"x": .1, "y": .8}]},
                                            "body": "关系图也要体现行动"})
        preview = build_context(self.store, None, region["anchor"], "请调整图中关系", "story-structure", first["revision"])
        self.assertEqual(preview["context"]["visual"]["id"], "relation-graph")
        self.assertEqual(len(preview["context"]["region_points"]), 4)
        overall = self.store.create_comment({"target_object_id": "story-structure", "target_revision_id": first["revision"],
                                             "anchor": {"type": "global"}, "body": "整体节奏清楚"})
        self.store.change_comment(overall["id"], "EDIT", 1, "整体节奏请更清楚")
        self.store.change_comment(overall["id"], "CLOSE", 2)
        self.store.change_comment(overall["id"], "REOPEN", 3)
        self.assertEqual(len(self.store.events()), 6)
        context = review_context(self.store)
        self.assertEqual(len(context["reviews"]), 3)
        self.assertEqual(next(item for item in context["reviews"] if item["comment"]["id"] == region["id"])["comment"]["anchor"]["visual_id"], "relation-graph")
        self.assertEqual(context["reviews"][0]["direction_source"]["id"], "direction-a")
        second = import_structure(self.store, document(selected["revision"], first["revision"],
                                                       [{"comment_id": text["id"], "explanation": "把村人协助准备写入正文及关系图"}], True), 1)
        self.assertNotEqual(first["revision"], second["revision"])
        self.assertEqual(self.store.comment(text["id"])["status"], "OPEN")
        self.assertEqual(self.store.comment(text["id"])["target_revision_id"], first["revision"])
        self.assertEqual(len(snapshot(self.store)["revisions"]), 2)
        confirmed = confirm_structure(self.store, second["revision"], "隔离测试者", "仅验证交接")
        handoff = script_input(self.store)
        self.assertEqual(handoff["structure"]["id"], second["revision"])
        self.assertEqual(len(handoff["pending_at_confirmation"]), 3)
        self.assertFalse(handoff["requires_re_review"])
        self.assertEqual(confirmed["kind"], "JUDGMENT")
        self.store.create_comment({"target_object_id": "story-structure", "target_revision_id": second["revision"],
                                   "anchor": {"type": "global"}, "body": "确认后新提出的整体问题"})
        self.assertTrue(script_input(self.store)["requires_re_review"])
        self.assertEqual(len(script_input(self.store)["post_confirmation_pending"]), 1)
        changed = select_direction(self.store, "direction-b", 1)
        self.assertTrue(snapshot(self.store)["direction_changed"])
        self.assertEqual(snapshot(self.store)["selection_history"][0]["payload"]["source_id"], "direction-a")
        self.assertEqual(snapshot(self.store)["revisions"][-1]["payload"]["direction_selection_revision"], selected["revision"])
        self.assertTrue(script_input(self.store)["requires_re_review"])
        with self.assertRaises(Conflict):
            import_structure(self.store, document(selected["revision"], second["revision"]), 2)
        self.assertEqual(changed["version"], 2)
        manifest = export(self.store, self.root / "export")
        self.assertIn("assets/relation.svg", manifest["files"])
        restored_root = self.root / "restored"
        restored_export = restored_root / "export"
        restored_export.mkdir(parents=True)
        for path in (self.root / "export").rglob("*"):
            if path.is_file():
                destination = restored_export / path.relative_to(self.root / "export")
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(path.read_bytes())
        restored = Store(restored_root / ".runtime" / "review.sqlite3")
        try:
            restore(restored, restored_export)
            self.assertEqual(len(restored.comments()), 4)
            self.assertEqual(len(restored.events()), 7)
            self.assertEqual(script_input(restored)["structure"]["id"], second["revision"])
            self.assertEqual(export(restored, restored_export)["files"], manifest["files"])
        finally:
            restored.close()

    def test_invalid_anchors_and_direction_change(self):
        selected = select_direction(self.store, "direction-a", 0)
        first = import_structure(self.store, document(selected["revision"]), 0)
        with self.assertRaises((ValueError, Conflict)):
            self.store.create_comment({"target_object_id": "story-structure", "target_revision_id": first["revision"],
                                       "anchor": {"type": "visual", "visual_id": "relation-graph", "asset_file": "wrong.svg"}, "body": "错误资产"})
        with self.assertRaises(ValueError):
            self.store.create_comment({"target_object_id": "story-structure", "target_revision_id": first["revision"],
                                       "anchor": {"type": "region", "visual_id": "relation-graph", "asset_file": "relation.svg",
                                                  "points": [{"x": .2, "y": .2}, {"x": .2, "y": .2}, {"x": .2, "y": .2}]}, "body": "空区域"})
        with self.assertRaises(Conflict):
            confirm_structure(self.store, "wrong", "测试")

    def test_source_image_and_explicit_broken_reference(self):
        source = direction("image-source", "图文资料")
        source.pop("group")
        source["assets"] = [{"file": "relation.svg", "title": "参考图", "alt": "人物关系", "note": "隔离样本", "source_url": "https://example.org/image"}]
        self.store.put_source(source)
        comment = self.store.create_comment({"source_id": "image-source", "anchor": {"type": "visual", "visual_id": "relation.svg", "asset_file": "relation.svg"}, "body": "核对整图"})
        self.assertTrue(self.store.anchor_state(comment["target_object_id"], comment["target_revision_id"], comment["anchor"])["valid"])
        preview = build_context(self.store, "image-source", comment["anchor"], "请核对整图")
        self.assertEqual(preview["context"]["visual"]["file"], "relation.svg")
        self.assets.joinpath("relation.svg").unlink()
        state = self.store.anchor_state(comment["target_object_id"], comment["target_revision_id"], comment["anchor"])
        self.assertFalse(state["valid"])
        self.assertIn("missing", state["reason"])
        self.assertEqual(self.store.comment(comment["id"])["body"], "核对整图")
