import json
import mimetypes
import re
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit

from .favicon import current as current_favicon, choices as favicon_choices, upload as upload_favicon
from .approach import read_document
from .configuration import catalog as configuration_catalog
from .framework import catalog as framework_catalog
from .polish import build_context, suggest
from .screenplay import snapshot as screenplay_snapshot, review_context as screenplay_review, import_screenplay
from .screenplay_summaries import read_summaries
from .store import Conflict, Store
from .structure import select_direction, snapshot, confirm_structure, review_context, script_input
from . import production, entity_review, generation
from .production_media import asset_path, ingest


class ReviewServer(HTTPServer):
    def __init__(self, address, instance_root, config):
        super().__init__(address, ReviewHandler)
        self.root = Path(instance_root).resolve()
        self.config = config
        self.store = Store(self.root / ".runtime" / "review.sqlite3")

    def get_request(self):
        request, address = super().get_request()
        # Browsers can preconnect without sending an HTTP request. Keep such
        # idle sockets from blocking the single thread that owns the SQLite store.
        request.settimeout(2)
        return request, address

    def server_close(self):
        self.store.close()
        super().server_close()


class ReviewHandler(BaseHTTPRequestHandler):
    def _json(self, value, status=200):
        data = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def _file(self, path, mime):
        if not path.is_file():
            return self._json({"error": "not found"}, 404)
        size, start, end = path.stat().st_size, 0, path.stat().st_size - 1
        partial = self.headers.get("Range")
        if partial:
            match = re.fullmatch(r"bytes=(\d*)-(\d*)", partial)
            if not match or not any(match.groups()):
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
            left, right = match.groups()
            start = int(left) if left else max(0, size - int(right))
            end = min(int(right), size - 1) if left and right else size - 1
            if start > end or start >= size:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
        self.send_response(206 if partial else 200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(max(0, end - start + 1)))
        self.send_header("Accept-Ranges", "bytes")
        if partial:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        with path.open("rb") as stream:
            stream.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                chunk = stream.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def _input(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > 20_000_000:
            raise ValueError("request too large")
        return json.loads(self.rfile.read(length))

    def do_GET(self):
        parsed = urlsplit(self.path)
        path, query = parsed.path, parse_qs(parsed.query)
        store = self.server.store
        if path == "/api/production" or path.startswith("/api/production/"):
            try:
                param = lambda name: query.get(name, [None])[0]
                if path == "/api/production":
                    return self._json(production.snapshot(store, param("kind"), param("object_id"), param("revision_id")))
                if path == "/api/production/impact":
                    return self._json(production.impact(store, param("revision_id")))
                if path == '/api/production/entity-review':
                    return self._json(entity_review.snapshot(store, param('entity_id'), param('revision_id')))
                if path == "/api/production/generation-ready":
                    return self._json(generation.readiness(store, param("requirement_id")))
                if path == "/api/production/generation-package":
                    return self._json(generation.package(store, param("requirement_id")))
                if path == "/api/production/source":
                    ref = {"object_id": param("object_id"), "revision_id": param("revision_id")}
                    if param('scene_id'):
                        ref['scene_id'] = param('scene_id')
                    if param('block_ids'):
                        ref['block_ids'] = param('block_ids').split(',')
                    return self._json(production.source_excerpt(store, ref))
                if path == "/api/production/readiness":
                    return self._json(production.readiness(store, param("scope")))
                if path == "/api/production/package":
                    return self._json(production.package_manifest(store, param("scope")))
                if path.startswith("/api/production/files/"):
                    media = asset_path(self.server.root, path.removeprefix("/api/production/files/"))
                    return self._file(media, mimetypes.guess_type(media.name)[0] or "application/octet-stream")
            except Conflict as exc:
                return self._json({"error": str(exc)}, 409)
            except KeyError:
                return self._json({"error": "production record not found"}, 404)
            except (ValueError, TypeError, OSError) as exc:
                return self._json({"error": str(exc)}, 400)
        if path == "/api/instance":
            return self._json({"id": self.server.config["id"], "title": self.server.config["title"]})
        if path == "/api/production-approach":
            try:
                return self._json(read_document(self.server.root))
            except (ValueError, OSError):
                return self._json({"error": "实例制作方法文档格式错误或无法读取"}, 503)
        if path == "/api/sources":
            sources = store.sources()
            if query.get("with_revision") == ["1"]:
                revisions = {obj["id"]: obj["current_revision"] for obj in store.objects() if obj["kind"] == "SOURCE"}
                sources = [{**source, "target_revision_id": revisions[source["id"]]} for source in sources]
            return self._json(sources)
        if path == "/api/framework":
            return self._json(framework_catalog())
        if path == "/api/configurations":
            try:
                _, _, icon = current_favicon(self.server.root, store.configuration("SYSTEM")["body"])
                return self._json({"catalog": configuration_catalog(), "values": store.configurations(), "favicon": icon, "favicon_assets": favicon_choices(self.server.root)})
            except (ValueError, OSError) as exc:
                return self._json({"error": str(exc)}, 503)
        if path == "/api/comments":
            comments = store.comments(query.get("source_id", [None])[0], query.get("target_object_id", [None])[0], query.get("target_revision_id", [None])[0])
            return self._json([{**comment, "anchor_state": store.anchor_state(comment["target_object_id"], comment["target_revision_id"], comment["anchor"])} for comment in comments])
        if path == "/api/comments/context":
            return self._json(store.context())
        if path == "/api/screenplays":
            return self._json(screenplay_snapshot(store))
        if path == "/api/screenplay-summaries":
            try:
                return self._json(read_summaries(self.server.root))
            except ValueError:
                return self._json({"error": "剧本分集摘要格式错误或无法读取"}, 503)
        if path == "/api/screenplays/review-context":
            return self._json(screenplay_review(store))
        if path == "/api/story-structure":
            return self._json(snapshot(store))
        if path == "/api/story-structure/review-context":
            return self._json(review_context(store))
        if path == "/api/story-structure/script-input":
            try:
                return self._json(script_input(store))
            except ValueError as exc:
                return self._json({"error": str(exc)}, 404)
        if path == "/default-favicon.svg":
            return self._file(Path(__file__).parent / "static" / "favicon.svg", "image/svg+xml")
        if path == "/favicon.ico":
            try:
                icon_path, _, icon = current_favicon(self.server.root, store.configuration("SYSTEM")["body"])
                return self._file(icon_path, icon["mime"])
            except (ValueError, OSError) as exc:
                return self._json({"error": str(exc)}, 503)
        if path == "/":
            return self._file(Path(__file__).parent / "static" / "index.html", "text/html; charset=utf-8")
        if path in ("/review-ui.js", "/review-ui.css", "/entity-review.js", "/production.js", "/production.css", "/app.js", "/approach.js", "/approach.css", "/screenplay.js", "/screenplay.css", "/structure.js", "/style.css", "/polish.css", "/workspace.css", "/structure.css"):
            return self._file(Path(__file__).parent / "static" / path[1:], "text/javascript; charset=utf-8" if path.endswith(".js") else "text/css; charset=utf-8")
        if path.startswith("/assets/") and path[8:] == Path(path[8:]).name and not path[8:].startswith("."):
            asset = self.server.root / "export" / "assets" / path[8:]
            mime = {".ico": "image/x-icon", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".mp4": "video/mp4", ".webm": "video/webm"}.get(asset.suffix.lower(), "application/octet-stream")
            return self._file(asset, mime)
        return self._json({"error": "not found"}, 404)

    def _write(self, action, comment_id=None):
        try:
            value = self._input()
            if action == "CREATE":
                result = self.server.store.create_comment(value)
            else:
                result = self.server.store.change_comment(comment_id, value.get("action"), value.get("expected_version"), value.get("body"))
            return self._json(result, 201 if action == "CREATE" else 200)
        except Conflict as exc:
            return self._json({"error": str(exc)}, 409)
        except (ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
            return self._json({"error": str(exc)}, 400)

    def do_POST(self):
        if self.path in ("/api/production/import", "/api/production/adopt", "/api/production/judgment", "/api/production/entity-decision"):
            try:
                value = self._input()
                if self.path.endswith("import"):
                    result = production.import_records(self.server.store, value, value.get("validate_only") is True)
                elif self.path.endswith("entity-decision"):
                    result = generation.decide(self.server.store, value)
                elif self.path.endswith("adopt"):
                    result = production.adopt(self.server.store, value)
                else:
                    result = production.judge(self.server.store, value)
                return self._json(result, 201)
            except Conflict as exc:
                return self._json({"error": str(exc)}, 409)
            except (KeyError, ValueError, TypeError, OSError) as exc:
                return self._json({"error": str(exc)}, 400)
        if self.path == "/api/favicon":
            try:
                value = self._input()
                name = upload_favicon(self.server.root, value.get("name"), value.get("data"))
                return self._json({"file": name}, 201)
            except (ValueError, KeyError, TypeError, OSError) as exc:
                return self._json({"error": str(exc)}, 400)
        if self.path == "/api/screenplays":
            try:
                return self._json(import_screenplay(self.server.store, self._input()), 201)
            except Conflict as exc:
                return self._json({"error": str(exc)}, 409)
            except (ValueError, KeyError, TypeError) as exc:
                return self._json({"error": str(exc)}, 400)
        if self.path in ("/api/story-structure/select-direction", "/api/story-structure/confirm"):
            try:
                value = self._input()
                if self.path.endswith("select-direction"):
                    result = select_direction(self.server.store, value.get("source_id"), value.get("expected_version"))
                else:
                    result = confirm_structure(self.server.store, value.get("revision_id"), value.get("reviewer"), value.get("note", ""))
                return self._json(result, 201)
            except Conflict as exc:
                return self._json({"error": str(exc)}, 409)
            except (ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
                return self._json({"error": str(exc)}, 400)
        if self.path == "/api/comments":
            return self._write("CREATE")
        if self.path in ("/api/comments/polish", "/api/comments/polish-context"):
            try:
                value = self._input()
                preview = build_context(self.server.store, value.get("source_id"), value.get("anchor"), value.get("body"), value.get("target_object_id"), value.get("target_revision_id"))
                if self.path.endswith("polish-context"):
                    return self._json(preview)
                if value.get("expected_context_sha256") != preview["context_sha256"]:
                    raise Conflict("AI 参考上下文已变化；请重新预览")
                return self._json(suggest(preview))
            except Conflict as exc:
                return self._json({"error": str(exc)}, 409)
            except RuntimeError as exc:
                return self._json({"error": str(exc)}, 503)
            except (ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
                return self._json({"error": str(exc)}, 400)
            except (HTTPError, URLError, TimeoutError):
                return self._json({"error": "AI 润色请求失败；草稿未修改，请稍后重试"}, 502)
        return self._json({"error": "not found"}, 404)

    def do_PUT(self):
        if self.path.startswith("/api/production/files/"):
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 8 * 1024 ** 3:
                    raise ValueError("media upload requires Content-Length between 1 byte and 8 GiB")
                result = ingest(self.server.root, self.rfile, self.path.rsplit("/", 1)[1], size)
                return self._json(result, 201)
            except (ValueError, TypeError, OSError) as exc:
                return self._json({"error": str(exc)}, 400)
        return self._json({"error": "not found"}, 404)

    def do_PATCH(self):
        if self.path in ("/api/configurations/SYSTEM", "/api/configurations/PROJECT"):
            try:
                value = self._input()
                return self._json(self.server.store.set_configuration(self.path.rsplit("/", 1)[1], value.get("updates"), value.get("expected_version")))
            except Conflict as exc:
                return self._json({"error": str(exc)}, 409)
            except (ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
                return self._json({"error": str(exc)}, 400)
        if self.path.startswith("/api/comments/") and self.path[14:]:
            return self._write("CHANGE", self.path[14:])
        return self._json({"error": "not found"}, 404)
