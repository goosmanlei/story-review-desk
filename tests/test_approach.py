import json
import queue
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import urlopen

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


if __name__ == "__main__":
    unittest.main()
