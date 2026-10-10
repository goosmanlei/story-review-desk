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
from review_desk.approach import validate_diagram


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

    def test_cycle_layout_is_explicit_and_rejects_unsupported_content(self):
        value = {"schema_version": 2, "tabs": [
            {"id": name, "label": name, "title": name, "lead": "lead", "sections": []}
            for name in ('vision', 'story', 'materials')]}
        tab = value['tabs'][0]
        tab['layout'] = {'type': 'cycle', 'return_label': '继续实践'}
        tab['sections'] = [{'id': name, 'title': name, 'blocks': [{'type': 'paragraph', 'text': '说明'}]} for name in ('practice', 'delivery')]
        self.path.write_text(json.dumps(value))
        self.assertEqual(self.get('/api/production-approach'), value)
        for change in ('unknown', 'empty-label', 'one-node', 'media'):
            invalid = copy.deepcopy(value)
            target = invalid['tabs'][0]
            if change == 'unknown': target['layout']['type'] = 'arbitrary'
            if change == 'empty-label': target['layout']['return_label'] = ' '
            if change == 'one-node': target['sections'].pop()
            if change == 'media': target['sections'][0]['blocks'][0]['type'] = 'code'
            self.path.write_text(json.dumps(invalid))
            with self.assertRaises(HTTPError) as caught:
                self.get('/api/production-approach')
            self.assertEqual(caught.exception.code, 503)

    def test_optional_document_and_no_ledger(self):
        self.assertIsNone(self.get("/api/production-approach"))
        self.assertEqual(self.get("/api/sources"), [])
        workspaces = self.get("/api/framework")["workspaces"]
        self.assertIn("production.approach", [item["id"] for item in workspaces])
        self.assertNotIn("current", [item["id"] for item in workspaces])

    def test_supported_collaboration_rejects_ambiguous_nodes_and_recovers(self):
        diagram = {'type': 'supported-collaboration',
                   'roles': [{'title': '作者', 'icon': 'human'}, {'title': '助手', 'icon': 'ai'}],
                   'outcome': '共同作品', 'support': '共同基础', 'description': '双方在共同基础上持续协作。',
                   'foundation': {'title': '平台', 'pillars': [
                       {'title': '共同结构', 'icon': 'model'}, {'title': '共同流程', 'icon': 'process'}]}}
        value = {'schema_version': 2, 'tabs': [
            {'id': name, 'label': name, 'title': name, 'lead': '', 'sections': []}
            for name in ('concept', 'story', 'materials')]}
        value['tabs'][0].update(layout={'type': 'diagram', 'anchors': {'old': 'shared'}},
                                sections=[{'id': 'shared', 'title': '协作', 'blocks': [], 'diagram': diagram}])
        self.path.write_text(json.dumps(value))
        self.assertEqual(self.get('/api/production-approach'), value)
        for change in ('missing-role', 'duplicate-role', 'unknown-icon', 'missing-pillar', 'duplicate-pillar', 'empty-description', 'markup'):
            invalid = copy.deepcopy(value)
            target = invalid['tabs'][0]['sections'][0]['diagram']
            if change == 'missing-role': target['roles'].pop()
            if change == 'duplicate-role': target['roles'][1]['icon'] = 'human'
            if change == 'unknown-icon': target['roles'][0]['icon'] = '<svg onload=alert(1)>'
            if change == 'missing-pillar': target['foundation']['pillars'].pop()
            if change == 'duplicate-pillar': target['foundation']['pillars'][1]['icon'] = 'model'
            if change == 'empty-description': target['description'] = ' '
            if change == 'markup': target['foundation']['html'] = '<script>bad()</script>'
            self.path.write_text(json.dumps(invalid))
            with self.subTest(change=change), self.assertRaises(HTTPError) as caught:
                self.get('/api/production-approach')
            self.assertEqual(caught.exception.code, 503)
        self.path.write_text(json.dumps(value))
        self.assertEqual(self.get('/api/production-approach'), value)
        self.assertEqual(self.get('/api/comments'), [])

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

    def test_schema_two_preserves_instance_order_and_legacy_routes(self):
        value = {"schema_version": 2, "tabs": [
            {"id": name, "label": name, "title": name, "lead": "", "sections": []}
            for name in ("introduction", "materials", "story", "another-method")
        ]}
        self.path.write_text(json.dumps(value))
        self.assertEqual(self.get("/api/production-approach"), value)
        for broken in (
            {**value, "schema_version": 1},
            {**value, "tabs": value["tabs"][:2]},
            {**value, "tabs": []},
        ):
            self.path.write_text(json.dumps(broken))
            with self.assertRaises(HTTPError):
                self.get("/api/production-approach")

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

    def test_heading_targets_cannot_collide_or_escape_the_method_page(self):
        value = {'schema_version': 2, 'tabs': [{'id': name, 'label': name, 'title': name, 'lead': '', 'sections': []}
                                             for name in ('story', 'materials', 'filmcraft')]}
        heading = {'type': 'heading', 'level': 3, 'text': '来源', 'id': 'source-sp01'}
        section = {'id': 'sources', 'title': '来源', 'blocks': [heading]}
        value['tabs'][2]['sections'] = [section]
        self.path.write_text(json.dumps(value))
        self.assertEqual(self.get('/api/production-approach'), value)
        for id in ('sources', '../other', '', 'has space'):
            heading['id'] = id; self.path.write_text(json.dumps(value))
            with self.assertRaises(HTTPError): self.get('/api/production-approach')
        heading['id'] = 'source-sp01'
        section['blocks'].append(copy.deepcopy(heading)); self.path.write_text(json.dumps(value))
        with self.assertRaises(HTTPError): self.get('/api/production-approach')

    def test_diagrams_are_passive_local_shapes(self):
        validate_diagram(b'<svg xmlns="http://www.w3.org/2000/svg"><defs><marker id="arrow"/></defs><path d="M0 0L10 10" marker-end="url(#arrow)"/><text>diagram</text></svg>')
        for raw in (
            b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
            b'<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
            b'<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.org/track"/></svg>',
            b'<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(https://example.org/track)"/></svg>',
            b'<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg"/>',
            b'<svg xmlns="http://www.w3.org/2000/svg"><foreignObject/></svg>',
            b'<svg xmlns="http://www.w3.org/2000/svg"><style>text{fill:red}</style></svg>',
            b'<?xml-stylesheet type="text/css" href="https://example.org/style.css"?><svg xmlns="http://www.w3.org/2000/svg"/>',
            '<!DOCTYPE svg [<!ENTITY x "expanded">]><svg xmlns="http://www.w3.org/2000/svg"><text>&x;</text></svg>'.encode('utf-16'),
            b'<svg xmlns="http://www.w3.org/2000/svg" xml:base="//example.org/paint.svg"><rect fill="url(#paint)"/></svg>',
            b'<svg xmlns="http://www.w3.org/2000/svg"><g xmlns=""><text>wrong namespace</text></g></svg>',
            b'<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:red"/></svg>',
            b'<svg',
        ):
            with self.subTest(raw=raw), self.assertRaises(ValueError): validate_diagram(raw)


if __name__ == "__main__":
    unittest.main()
