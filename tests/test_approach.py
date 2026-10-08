import json
import copy
import queue
import tempfile
import threading
import unittest
import hashlib
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import urlopen, Request

from review_desk.server import ReviewServer


class ApproachTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "content").mkdir()
        self.path = self.root / "content" / "production-approach.json"
        ready = queue.Queue()

        def serve():
            with ReviewServer(("127.0.0.1", 0), self.root, {"id": "test", "title": "Test"}) as server:
                ready.put(server)
                server.serve_forever(poll_interval=0.01)

        self.thread = threading.Thread(target=serve)
        self.thread.start()
        self.server = ready.get(timeout=5)
        self.base = "http://127.0.0.1:" + str(self.server.server_port)

    def tearDown(self):
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.tmp.cleanup()

    def get(self, path):
        with urlopen(self.base + path) as response:
            return json.load(response)

    def test_optional_document_and_no_ledger(self):
        self.assertIsNone(self.get("/api/production-approach"))
        self.assertEqual(self.get("/api/sources"), [])
        workspaces = self.get("/api/framework")["workspaces"]
        self.assertIn("production.approach", [item["id"] for item in workspaces])
        self.assertNotIn("current", [item["id"] for item in workspaces])

    def test_instance_document_round_trip_and_reload(self):
        value = {"schema_version": 1, "tabs": [
            {"id": id, "label": label, "title": "独立实例", "lead": "<b>原样文本</b>", "sections": []}
            for id, label in [("story", "故事创作"), ("materials", "生产制作")]
        ]}
        self.path.write_text(json.dumps(value))
        self.assertEqual(self.get("/api/production-approach"), value)
        value["tabs"][0]["title"] = "修改后"
        self.path.write_text(json.dumps(value))
        self.assertEqual(self.get("/api/production-approach"), value)
        self.assertEqual(self.get("/api/comments"), [])

    def test_invalid_document_is_reported_without_breaking_other_pages(self):
        for value in ["{", '{"schema_version":99,"tabs":[]}', '{"schema_version":1,"tabs":[null]}']:
            self.path.write_text(value)
            with self.assertRaises(HTTPError) as caught:
                self.get("/api/production-approach")
            self.assertEqual(caught.exception.code, 503)
            self.assertEqual(self.get("/api/sources"), [])

    def test_rich_method_document_round_trip_and_invalid_blocks(self):
        value = {"schema_version": 2, "tabs": [
            {"id": name, "label": name, "title": "方法", "lead": "说明", "sections": []}
            for name in ("story", "materials", "another-method")
        ]}
        section = {"id": "chapter-A", "title": "章节", "blocks": [
            {"type": "paragraph", "text": "`引用`和[文档](https://example.org)"},
            {"type": "heading", "level": 3, "text": "小节"},
            {"type": "list", "ordered": True, "items": ["先做", "再做"]},
            {"type": "code", "language": "text", "text": "首行\n  缩进 <原样>\n末行"},
            {"type": "table", "columns": ["条件", "选择"], "rows": [["一", "二"]]},
        ]}
        value["tabs"][2]["sections"] = [section]
        self.path.write_text(json.dumps(value))
        self.assertEqual(self.get("/api/production-approach"), value)
        for invalid in [
            {"type": "media", "url": "https://example.org/private.mp4"},
            {"type": "list", "ordered": True, "items": "silently iterated string"},
            {"type": "heading", "level": True, "text": "x"},
            {"type": "code", "text": []},
            {"type": "table", "columns": ["one", "two"], "rows": [["missing"]]},
        ]:
            broken = copy.deepcopy(value)
            broken["tabs"][2]["sections"][0]["blocks"] = [invalid]
            self.path.write_text(json.dumps(broken))
            with self.assertRaises(HTTPError) as caught:
                self.get("/api/production-approach")
            self.assertEqual(caught.exception.code, 503)
            self.assertEqual(self.get("/api/comments"), [])
        for mutate in [
            lambda v: v["tabs"].append(v["tabs"][2]),
            lambda v: v["tabs"][2].update(id="../invalid"),
            lambda v: v["tabs"][2]["sections"][0].update(paragraphs=["two competing bodies"]),
        ]:
            broken = copy.deepcopy(value); mutate(broken)
            self.path.write_text(json.dumps(broken))
            with self.assertRaises(HTTPError):
                self.get("/api/production-approach")

    def test_method_media_is_local_declared_exact_and_supports_ranges(self):
        folder = self.root / 'content/production-approach-assets'; folder.mkdir()
        data = b'original offline fixture bytes; no source media'
        (folder / 'demo.mp4').write_bytes(data)
        (folder / 'unlisted.mp4').write_bytes(data)
        block = {'type': 'media', 'kind': 'video', 'file': 'demo.mp4', 'caption': 'Original demo',
                 'sha256': hashlib.sha256(data).hexdigest(), 'width': 1280, 'height': 720}
        value = {'schema_version': 2, 'tabs': [{'id': name, 'label': name, 'title': name, 'lead': '', 'sections': []}
                                             for name in ('story', 'materials', 'method')]}
        value['tabs'][2]['sections'] = [{'id': 'demo', 'title': 'Demo', 'blocks': [block]}]
        self.path.write_text(json.dumps(value))
        with urlopen(Request(self.base + '/approach-media/demo.mp4', headers={'Range': 'bytes=4-10'})) as response:
            self.assertEqual(response.status, 206)
            self.assertEqual(response.headers['Content-Type'], 'video/mp4')
            self.assertEqual(response.read(), data[4:11])
        for name in ('unlisted.mp4', '../production-approach.json', 'https://private.invalid/a.mp4'):
            with self.assertRaises(HTTPError): urlopen(self.base + '/approach-media/' + name)
        (folder / 'demo.mp4').write_bytes(b'changed bytes')
        with self.assertRaises(HTTPError) as caught: urlopen(self.base + '/approach-media/demo.mp4')
        self.assertEqual(caught.exception.code, 503)
        (folder / 'demo.mp4').unlink(); (folder / 'demo.mp4').symlink_to(folder / 'unlisted.mp4')
        with self.assertRaises(HTTPError): urlopen(self.base + '/approach-media/demo.mp4')
        for mutation in ({'file': '../secret.mp4'}, {'file': 'https://private.invalid/a.mp4'}, {'kind': 'audio'}, {'sha256': 'wrong'}, {'url': 'https://private.invalid/a.mp4'}, {'width': 0}, {'height': True}, {'height': 32769}):
            broken = copy.deepcopy(value); broken['tabs'][2]['sections'][0]['blocks'][0].update(mutation)
            self.path.write_text(json.dumps(broken))
            with self.assertRaises(HTTPError): self.get('/api/production-approach')


if __name__ == "__main__":
    unittest.main()
