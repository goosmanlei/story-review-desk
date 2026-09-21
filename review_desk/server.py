import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, urlopen

from .store import Conflict, Store


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
        if path == "/api/comments":
            return self._json(store.comments(query.get("source_id", [None])[0]))
        if path == "/api/comments/context":
            return self._json(store.context())
        if path == "/":
            return self._file(Path(__file__).parent / "static" / "index.html", "text/html; charset=utf-8")
        if path in ("/app.js", "/style.css", "/polish.css"):
            return self._file(Path(__file__).parent / "static" / path[1:], "text/javascript; charset=utf-8" if path.endswith(".js") else "text/css; charset=utf-8")
        if path.startswith("/assets/") and path[8:] == Path(path[8:]).name and not path[8:].startswith("."):
            asset = self.server.root / "export" / "assets" / path[8:]
            mime = {".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".mp3": "audio/mpeg"}.get(asset.suffix.lower(), "application/octet-stream")
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
        if self.path == "/api/comments":
            return self._write("CREATE")
        if self.path == "/api/comments/polish":
            try:
                value = self._input()
                self.server.store.validate_anchor(value.get("source_id"), value.get("anchor"))
                draft = str(value.get("body", "")).strip()
                if not draft or len(draft) > 2000:
                    raise ValueError("comment draft must be 1-2000 characters")
                key = os.environ.get("OPENAI_API_KEY")
                if not key:
                    return self._json({"error": "AI 润色未配置：本机需设置 OPENAI_API_KEY"}, 503)
                payload = {
                    "model": os.environ.get("REVIEW_POLISH_MODEL", "gpt-4.1-mini"),
                    "store": False,
                    "max_output_tokens": 180,
                    "instructions": "你是中文资料审阅意见的措辞助手。只润色用户已有的评论，不新增史实、判断或任务，不改变原意。只输出一段建议正文，不加标题。",
                    "input": f"原文圈选：{value['anchor']['quote']}\n原评论草稿：{draft}"
                }
                request = Request("https://api.openai.com/v1/responses", data=json.dumps(payload, ensure_ascii=False).encode(),
                                  headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"}, method="POST")
                with urlopen(request, timeout=30) as response:
                    result = json.load(response)
                suggestion = "".join(part.get("text", "") for item in result.get("output", [])
                                     for part in item.get("content", []) if part.get("type") == "output_text").strip()
                if not suggestion:
                    raise ValueError("AI 润色未返回文本")
                return self._json({"suggestion": suggestion, "saved": False})
            except (ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
                return self._json({"error": str(exc)}, 400)
            except (HTTPError, URLError, TimeoutError):
                return self._json({"error": "AI 润色请求失败；草稿未修改，请稍后重试"}, 502)
        return self._json({"error": "not found"}, 404)

    def do_PATCH(self):
        if self.path.startswith("/api/comments/") and self.path[14:]:
            return self._write("CHANGE", self.path[14:])
        return self._json({"error": "not found"}, 404)
