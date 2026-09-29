import json
import queue
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import urlopen

from review_desk.server import ReviewServer


class ScreenplaySummariesTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / "content").mkdir()
        self.path = self.root / "content" / "screenplay-summaries.json"
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
        self.temp.cleanup()

    def get(self, path):
        with urlopen(self.base + path) as response:
            return json.load(response)

    def test_optional_revision_bound_summaries_reload_without_ledger_changes(self):
        self.assertEqual(self.get("/api/screenplay-summaries"), {"schema_version": 1, "episodes": []})
        value = {"schema_version": 1, "episodes": [
            {"object_id": "script-one-e1", "revision_id": "revision-one", "summary": "本集故事摘要。"}
        ]}
        self.path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
        self.assertEqual(self.get("/api/screenplay-summaries"), value)
        value["episodes"][0]["summary"] = "修订后的阅读摘要。"
        self.path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
        self.assertEqual(self.get("/api/screenplay-summaries"), value)
        self.assertEqual(self.get("/api/screenplays"), {"versions": []})
        self.assertEqual(self.get("/api/comments"), [])

    def test_invalid_or_duplicate_summaries_do_not_break_script_api(self):
        bad = ["{", '{"schema_version":2,"episodes":[]}',
               '{"schema_version":1,"episodes":[{"object_id":"a","revision_id":"b","summary":" "}]}',
               '{"schema_version":1,"episodes":[{"object_id":"a","revision_id":"b","summary":"一"},{"object_id":"a","revision_id":"b","summary":"二"}]}']
        for text in bad:
            self.path.write_text(text, encoding="utf-8")
            with self.assertRaises(HTTPError) as caught:
                self.get("/api/screenplay-summaries")
            self.assertEqual(caught.exception.code, 503)
            self.assertEqual(self.get("/api/screenplays"), {"versions": []})


if __name__ == "__main__":
    unittest.main()
