"""Isolated browser regression fixture: PYTHONPATH=. python3 tests/selection_server.py.

Open http://127.0.0.1:8776/selection-tests in a browser. No production data or AI
credentials are loaded. The temporary instance is removed when the server stops.
"""
import argparse
import tempfile
from pathlib import Path

from review_desk.server import ReviewHandler, ReviewServer
from review_desk.structure import import_structure, select_direction


class SelectionHandler(ReviewHandler):
    def do_GET(self):
        if self.path == "/selection-tests":
            return self._file(Path(__file__).with_name("selection.html"), "text/html; charset=utf-8")
        super().do_GET()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8776)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="review-selection-") as root:
        with ReviewServer(("127.0.0.1", args.port), root, {"id": "selection-test", "title": "文本圈选隔离验收"}) as server:
            server.RequestHandlerClass = SelectionHandler
            source = {"id": "fixture", "title": "拖选测试正文", "version_type": "测试",
                      "origin": "隔离浏览器夹具", "source_url": "https://example.org/test",
                      "collected_at": "2026-09-26", "notes": "用于验证文本圈选，不属于真实故事。",
                      "assets": [], "blocks": [{"id": "a", "text": "甲乙𪎊丁，鼠标拖选这一段文字。"},
                                                {"id": "b", "text": "第二段正文，支持跨段与反向选中。"},
                                                {"id": "long", "text": "长段落的每一行都可以圈选并评论。\n" * 60 + "定位目标𪎊：应该滚到这里。"}]}
            server.store.put_source(source)
            server.store.put_source({**source, "id": "direction", "title": "结构测试方向", "group": "expansion-directions"})
            selection = select_direction(server.store, "direction", 0)
            sections = [{"id": key, "title": title, "blocks": source["blocks"] if key == "theme" else [{"id": key + "-text", "text": title + "的测试正文。"}]}
                        for key, title in [("theme", "主题"), ("characters", "人物"), ("relationships", "关系"),
                                           ("spaces", "空间"), ("storylines", "故事线"), ("timeline", "时间线")]]
            structure = import_structure(server.store, {"title": "测试结构", "sections": sections,
                                           "direction_selection_revision": selection["revision"], "responses": []}, 0)
            server.store.create_comment({"source_id": "fixture", "anchor": {"block_id": "a", "end_block_id": "a", "start": 1, "end": 4, "quote": "乙𪎊丁"}, "body": "测试已有高亮"})
            long_text = source["blocks"][-1]["text"]
            quote = "定位目标𪎊：应该滚到这里。"
            anchor = {"type": "text", "block_id": "long", "end_block_id": "long", "start": long_text.index(quote), "end": len(long_text), "quote": quote}
            server.store.create_comment({"source_id": "fixture", "anchor": anchor, "body": "长正文定位测试"})
            server.store.create_comment({"target_object_id": "story-structure", "target_revision_id": structure["revision"], "anchor": anchor, "body": "长结构定位测试"})
            print(f"Browser tests: http://127.0.0.1:{args.port}/selection-tests", flush=True)
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                pass


if __name__ == "__main__":
    main()
