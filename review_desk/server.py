import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit

from .configuration import catalog as configuration_catalog
from .framework import catalog as framework_catalog
from .polish import build_context, suggest
from .store import Conflict, Store
from .structure import select_direction, snapshot, confirm_structure, review_context, script_input


class ReviewServer(HTTPServer):
    def __init__(self, address, instance_root, config):
        super().__init__(address, ReviewHandler)
        self.root = Path(instance_root).resolve()
        self.config = config
        self.store = Store(self.root / ".runtime" / "review.sqlite3")

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
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def _input(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length > 1_000_000:
            raise ValueError("request too large")
        return json.loads(self.rfile.read(length))

    def do_GET(self):
        parsed = urlsplit(self.path)
        path, query = parsed.path, parse_qs(parsed.query)
        store = self.server.store
        if path == "/api/instance":
            return self._json({"id": self.server.config["id"], "title": self.server.config["title"]})
        if path == "/api/sources":
            return self._json(store.sources())
        if path == "/api/framework":
            return self._json(framework_catalog())
        if path == "/api/configurations":
            return self._json({"catalog": configuration_catalog(), "values": store.configurations()})
        if path == "/api/comments":
            comments = store.comments(query.get("source_id", [None])[0], query.get("target_object_id", [None])[0], query.get("target_revision_id", [None])[0])
            return self._json([{**comment, "anchor_state": store.anchor_state(comment["target_object_id"], comment["target_revision_id"], comment["anchor"])} for comment in comments])
        if path == "/api/comments/context":
            return self._json(store.context())
        if path == "/api/story-structure":
            return self._json(snapshot(store))
        if path == "/api/story-structure/review-context":
            return self._json(review_context(store))
        if path == "/api/story-structure/script-input":
            try:
                return self._json(script_input(store))
            except ValueError as exc:
                return self._json({"error": str(exc)}, 404)
        if path == "/":
            return self._file(Path(__file__).parent / "static" / "index.html", "text/html; charset=utf-8")
        if path in ("/app.js", "/structure.js", "/style.css", "/polish.css", "/workspace.css", "/structure.css"):
            return self._file(Path(__file__).parent / "static" / path[1:], "text/javascript; charset=utf-8" if path.endswith(".js") else "text/css; charset=utf-8")
        if path.startswith("/assets/") and path[8:] == Path(path[8:]).name and not path[8:].startswith("."):
            asset = self.server.root / "export" / "assets" / path[8:]
            mime = {".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".mp4": "video/mp4", ".webm": "video/webm"}.get(asset.suffix.lower(), "application/octet-stream")
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
