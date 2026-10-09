import json
import mimetypes
import re
import hashlib
import time
import queue
import threading
import os
import shutil
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit

from .favicon import current as current_favicon, choices as favicon_choices, upload as upload_favicon
from .approach import read_document, media_file
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
    request_queue_size = 32

    def __init__(self, address, instance_root, config):
        super().__init__(address, ReviewHandler)
        self.root = Path(instance_root).resolve()
        self.config = config
        from .deployment import settings
        self.deployment = settings()
        self._local = threading.local()
        self._local.store = Store(self.root / ".runtime" / "review.sqlite3")
        # Keep the reviewed deployment's rollback journal. Its bundled SQLite
        # has no verified WAL-reset fix; do not enable WAL merely for threads.
        # Existing WAL instances need an explicit stopped/backup migration.
        if self.store.db.execute('PRAGMA journal_mode').fetchone()[0] != 'delete':
            self._local.store.close()
            super().server_close()
            raise ValueError('bounded HTTP deployment requires reviewed SQLite DELETE mode; stop connections and back up before changing journal mode')
        from .read_cache import attach, source_version
        self.cache_version = source_version()
        attach(self.store, version=self.cache_version)
        from .web_assets import WebAssets
        self.web_assets = WebAssets(self.deployment)
        self._requests = queue.Queue(maxsize=8)
        self._upload_lock = threading.Lock()
        self._upload_reserved = 0
        self._workers = [threading.Thread(target=self._work, name=f'review-worker-{i}') for i in range(4)]
        for worker in self._workers:
            worker.start()

    @property
    def store(self):
        if not hasattr(self._local, 'store'):
            from .read_cache import attach
            self._local.store = Store.open_existing(self.root / '.runtime/review.sqlite3')
            attach(self._local.store, initialize_schema=False, version=self.cache_version)
        stat = self._local.store.db_path.stat()
        if (stat.st_dev, stat.st_ino) != self._local.store.file_identity:
            raise OSError('database replaced while serving; restart after restoration')
        return self._local.store

    @contextmanager
    def upload_budget(self, size):
        reserve = int(os.environ.get('REVIEW_UPLOAD_RESERVE_BYTES', '0'))
        if not reserve:
            yield
            return
        with self._upload_lock:
            if shutil.disk_usage(self.root).free < reserve + size + self._upload_reserved:
                raise ValueError('上传空间不足，请保留服务器运行空间')
            self._upload_reserved += size
        try:
            yield
        finally:
            with self._upload_lock:
                self._upload_reserved -= size

    def process_request(self, request, address):
        # Four active connections and eight queued sockets; no per-request
        # thread growth or unbounded executor submission queue.
        self._requests.put((request, address))

    def _work(self):
        try:
            while True:
                item = self._requests.get()
                if item is None:
                    return
                request, address = item
                try:
                    self.finish_request(request, address)
                except Exception:
                    self.handle_error(request, address)
                finally:
                    self.shutdown_request(request)
        finally:
            if hasattr(self._local, 'store'):
                self._local.store.close()

    def get_request(self):
        request, address = super().get_request()
        # Idle browser preconnections cannot retain a worker indefinitely.
        request.settimeout(2)
        return request, address

    def server_close(self):
        for _ in getattr(self, '_workers', []):
            self._requests.put(None)
        for worker in getattr(self, '_workers', []):
            worker.join()
        if hasattr(getattr(self, '_local', None), 'store'):
            self._local.store.close()
        super().server_close()


class ReviewHandler(BaseHTTPRequestHandler):
    def parse_request(self):
        if not super().parse_request():
            return False
        prefix = self.server.deployment['base_path']
        parsed = urlsplit(self.path)
        if prefix:
            if parsed.path == prefix and self.command == 'GET':
                self.send_response(308)
                self.send_header('Location', prefix + '/' + ('?' + parsed.query if parsed.query else ''))
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Content-Length', '0')
                self.end_headers()
                return False
            if not parsed.path.startswith(prefix + '/'):
                self.send_error(404)
                return False
            self.path = self.path[len(prefix):]
        publication = self.server.deployment['publication_id']
        supplied = self.headers.get('X-Review-Publication')
        if publication and urlsplit(self.path).path.startswith('/api/') and (
                supplied is not None and supplied != publication or
                self.command not in ('GET', 'HEAD', 'OPTIONS') and supplied != publication):
            self._json({'error': '体验版本已更新，请刷新页面后重新操作',
                        'publication_changed': True}, 409)
            return False
        return True

    cache_paths = frozenset(('/api/production/index', '/api/production/breakdown',
        '/api/production/card', '/api/production/scene', '/api/production/materials',
        '/api/sources', '/api/screenplays', '/api/business-codes'))

    def _representation(self):
        from .json_transport import MEDIA_TYPE
        graph = MEDIA_TYPE in self.headers.get('Accept', '') and urlsplit(self.path).path in self.cache_paths
        compressed = bool(re.search(r'(?:^|,)\s*gzip\s*(?:,|$)', self.headers.get('Accept-Encoding', '')))
        return graph, compressed

    def _json(self, value, status=200):
        from .business_codes import annotate
        if self.command == 'GET' and status == 200 and urlsplit(self.path).path not in ('/api/production/package', '/api/instance', '/api/framework', '/api/configurations', '/api/production-approach'):
            value = annotate(self.server.store, value, share_records=True)
        from .json_transport import encode
        graph, compressed = self._representation()
        data = encode(value, graph=graph, compressed=compressed)
        saved = getattr(self, '_response_cache', None)
        if status == 200 and saved and saved[1] == self.server.store.db.total_changes:
            self.server.store.read_cache.put(saved[0], data)
        return self._json_bytes(data, status)

    def _json_bytes(self, data, status=200):
        from .json_transport import MEDIA_TYPE
        graph, compressed = self._representation()
        self.send_response(status)
        self.send_header("Content-Type", (MEDIA_TYPE if graph else "application/json")+"; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header('Vary', 'Accept, Accept-Encoding')
        self.send_header('X-Review-Cache', getattr(self, '_cache_state', 'bypass'))
        if compressed:
            self.send_header('Content-Encoding', 'gzip')
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def _file(self, path, mime):
        if not path.is_file():
            return self._json({"error": "not found"}, 404)
        from .material_archives import reference, read_bytes
        import io
        reconstructed = read_bytes(path) if reference(path) else None
        if path == Path(__file__).parent / 'static' / 'index.html':
            reconstructed = self.server.web_assets.index
        with (io.BytesIO(reconstructed) if reconstructed is not None else path.open("rb")) as stream:
            return self._file_stream(stream, path, mime, reconstructed)

    def _file_stream(self, stream, path, mime, reconstructed):
        import os
        size = len(reconstructed) if reconstructed is not None else os.fstat(stream.fileno()).st_size
        media = urlsplit(self.path).path.startswith('/api/production/files/') and mime.startswith(('image/', 'audio/', 'video/'))
        etag = None
        if media:
            # Revalidate original bytes, never key historic media by a mutable
            # filename alone. Hash and serve the same open file, bounded in RAM.
            digest = hashlib.sha256()
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(chunk)
            stream.seek(0)
            if path.stem != digest.hexdigest():
                raise ValueError('original media checksum differs from its identity')
            etag = '"'+digest.hexdigest()+'"'
            if self.headers.get('If-None-Match') == etag:
                self.send_response(304)
                self.send_header('ETag', etag)
                self.send_header('Cache-Control', 'private, no-cache')
                self.end_headers()
                return
        start, end = 0, size - 1
        partial = self.headers.get("Range")
        if partial and self.headers.get('If-Range') and self.headers['If-Range'] != etag:
            partial = None
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
        self.send_header("Cache-Control", "private, no-cache" if media else "no-store")
        if etag:
            self.send_header('ETag', etag)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        stream.seek(start)
        remaining = end - start + 1
        while remaining > 0:
            chunk = stream.read(min(1024 * 1024, remaining))
            if not chunk:
                break
            self.wfile.write(chunk)
            remaining -= len(chunk)

    def _input(self, maximum=20_000_000):
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > maximum:
            raise ValueError("request too large")
        return json.loads(self.rfile.read(length))

    def do_GET(self):
        request_path = urlsplit(self.path).path
        if not request_path.startswith('/api/') or request_path.startswith('/api/production/files/'):
            return self._get()
        cache = getattr(self.server.store, 'read_cache', None)
        if not cache or urlsplit(self.path).path not in self.cache_paths:
            with production.read_scope(self.server.store):
                return self._get()
        from .read_cache import token
        store = self.server.store
        layout = self.server.root / 'config/entity-relationship-layout.json'
        layout_key = hashlib.sha256(layout.read_bytes()).hexdigest() if layout.is_file() else None
        parsed = urlsplit(self.path)
        request_key = [parsed.path, sorted(parse_qs(parsed.query).items())]
        deadline = time.monotonic()+15
        while True:
            generation = token(store)
            key = cache.key(generation, ['http', request_key, self._representation(), layout_key])
            data = cache.get(key)
            if data is not None:
                self._cache_state = 'hit'
                return self._json_bytes(data)
            with cache.lease(key) as owned:
                if owned or time.monotonic() >= deadline:
                    data = cache.get(key)
                    if data is not None:
                        self._cache_state = 'hit'
                        return self._json_bytes(data)
                    with production.read_scope(store):
                        # A writer may commit between the first token read and
                        # opening this snapshot. Never publish under its old key.
                        if store._production_reads['generation'] != generation:
                            continue
                        self._response_cache = (key, store.db.total_changes)
                        self._cache_state = 'miss'
                        try:
                            return self._get()
                        finally:
                            self._response_cache = None
            time.sleep(.005)

    def _get(self):
        parsed = urlsplit(self.path)
        path, query = parsed.path, parse_qs(parsed.query)
        if self.server.web_assets.serve(self, path):
            return
        store = self.server.store
        if path == '/api/business-codes':
            from .business_codes import catalog, display_dump
            return self._json({**catalog(), 'objects':display_dump(store)})
        if path == '/api/methods':
            from .methods import catalog
            return self._json(catalog(store))
        if path == '/api/methods/resolve':
            try:
                from .methods import resolve
                return self._json(resolve(store, query.get('work_type', [''])[0], json.loads(query.get('conditions', ['{}'])[0])))
            except (ValueError, KeyError, TypeError) as exc:
                return self._json({'error': str(exc)}, 400)
        if path == '/api/methods/record':
            try:
                from .methods import read
                return self._json(read(store, query.get('object_id', [None])[0], query.get('revision_id', [None])[0]))
            except (ValueError, KeyError, TypeError) as exc:
                return self._json({'error': str(exc)}, 400)
        if path == "/api/production" or path.startswith("/api/production/"):
            try:
                param = lambda name: query.get(name, [None])[0]
                if path == "/api/production/material-model-verify":
                    from .material_model import verify
                    return self._json(verify(store))
                if path == "/api/production/summary":
                    from .production_breakdown import summary
                    with production.read_scope(store):
                        return self._json(summary(store,param('object_id'),param('revision_id')))
                if path == '/api/production/judgments':
                    from .review_decisions import snapshot as judgment_snapshot
                    with production.read_scope(store):
                        return self._json(judgment_snapshot(store, param('object_id'), param('revision_id')))
                if path == '/api/production/acceptance':
                    from .production_acceptance import snapshot as acceptance_snapshot
                    with production.read_scope(store):
                        return self._json(acceptance_snapshot(store, param('object_id'), param('revision_id')))
                if path == '/api/production/story-related':
                    from .audiovisual import related
                    reference = {'object_id': param('object_id'), 'revision_id': param('revision_id')}
                    if param('scene_id'):
                        reference['scene_id'] = param('scene_id')
                    with production.read_scope(store):
                        return self._json(related(store, reference))
                if path == '/api/production/material-relations':
                    from .material_relations import review_context
                    with production.read_scope(store):
                        return self._json(review_context(store, param('material_id'), param('revision_id')))
                if path == "/api/production/breakdown":
                    from .production_breakdown import catalog
                    with production.read_scope(store):
                        return self._json(catalog(store, param("episode"), param("object_id"), param("revision_id"),param('view'),param('episode_revision')))
                if path == '/api/production/index':
                    from .production_breakdown import index
                    with production.read_scope(store):
                        return self._json(index(store,param('view'),param('object_id')))
                if path in ('/api/production/card','/api/production/scene'):
                    from . import ui_projection
                    with production.read_scope(store):
                        reader=ui_projection.card if path.endswith('/card') else ui_projection.scene
                        options={'shot_revision':param('shot_revision'),'view':param('view'),'episode':param('episode'),'episode_revision':param('episode_revision')} if path.endswith('/scene') else {'entity_id':param('entity_id')}
                        return self._json(reader(store,param('object_id'),param('revision_id'),**options))
                if path == "/api/production/context":
                    from .production_breakdown import context
                    with production.read_scope(store):
                        return self._json(context(store, param("object_id"), param("revision_id")))
                if path == "/api/production/materials":
                    from .ui_projection import material_list as materials
                    with production.read_scope(store):
                        return self._json(materials(store, param("episode"), param("scene"), param("media"), param("search") or "", param("status"), max(0,int(param("offset") or 0)), focus=param("focus"), grouped=param("grouped")=="1", compact=param("compact")=="1"))
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
                    return self._json(production.source_excerpt(store, ref, full_scene=param("full_scene")=="1"))
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
            return self._json({"id": self.server.config["id"], "title": self.server.config["title"],
                               **({"deployment": self.server.deployment} if self.server.deployment["base_path"] or self.server.deployment["publication_id"] else {})})
        if path == "/api/production-approach":
            try:
                return self._json(read_document(self.server.root))
            except (ValueError, OSError):
                return self._json({"error": "实例制作方法文档格式错误或无法读取"}, 503)
        if path.startswith('/approach-media/'):
            try:
                media, mime = media_file(self.server.root, path[len('/approach-media/'):])
                return self._file(media, mime)
            except FileNotFoundError:
                return self._json({'error': 'method media not found'}, 404)
            except (ValueError, OSError):
                return self._json({'error': 'method media unavailable or changed'}, 503)
        if path == "/api/sources":
            sources = store.sources(metadata=query.get('metadata')==['1'])
            if query.get("with_revision") == ["1"]:
                revisions = dict(store.db.execute("SELECT id,current_revision FROM objects WHERE kind='SOURCE'"))
                sources = [{**source, "target_revision_id": revisions[source["id"]]} for source in sources]
            return self._json(sources)
        if path == "/api/framework":
            return self._json(framework_catalog())
        if path == "/api/configurations":
            try:
                values = store.configurations()
                icon_error = None
                try:
                    _, _, icon = current_favicon(self.server.root, values["SYSTEM"]["body"])
                except (ValueError, OSError) as exc:
                    # An unavailable appearance asset must not hide the settings
                    # needed to repair it. The saved configuration stays intact.
                    icon_error = str(exc)
                    _, _, icon = current_favicon(self.server.root, {})
                return self._json({"catalog": configuration_catalog(), "values": values, "favicon": icon,
                                   "favicon_error": icon_error, **({"favicon_assets": favicon_choices(self.server.root)} if query.get('summary')!=['1'] else {})})
            except (ValueError, OSError) as exc:
                return self._json({"error": str(exc)}, 503)
        if path == "/api/comments":
            comments = store.comments(query.get("source_id", [None])[0], query.get("target_object_id", [None])[0], query.get("target_revision_id", [None])[0])
            return self._json(store.comment_anchor_states(comments))
        if path == "/api/comments/context":
            return self._json(store.context())
        if path in ('/api/comment-review', '/api/comment-review/content'):
            from . import comment_review
            try:
                operation = comment_review.content if path.endswith('/content') else comment_review.snapshot
                return self._json(operation(store, query.get('object_id', [None])[0],
                                            query.get('revision_id', [None])[0]))
            except (ValueError, Conflict) as exc:
                return self._json({'error': str(exc)}, 404)
        if path == "/api/screenplays":
            return self._json(screenplay_snapshot(store,metadata=query.get('metadata')==['1']))
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
        if path in ("/comment-review.js", "/comment-review.css", "/desk-theme.css", "/management-cards.js", "/navigation.js", "/navigation.css", "/unified-cards.js", "/unified-review.css", "/production-breakdown.js", "/material-review.js", "/entity-relations.js", "/review-ui.js", "/review-ui.css", "/entity-review.js", "/production.js", "/production.css", "/app.js", "/approach.js", "/approach.css", "/screenplay.js", "/screenplay.css", "/structure.js", "/style.css", "/polish.css", "/workspace.css", "/structure.css"):
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
        if self.path in ('/api/methods/save', '/api/methods/prepare', '/api/methods/artifact', '/api/methods/media-prepare'):
            try:
                from . import methods
                from .method_media import prepare as media_prepare
                operation = {'save': methods.save, 'prepare': methods.prepare, 'artifact': methods.artifact, 'media-prepare': media_prepare}[self.path.rsplit('/', 1)[1]]
                return self._json(operation(self.server.store, self._input(2_000_000)), 201)
            except Conflict as exc:
                return self._json({'error': str(exc)}, 409)
            except (ValueError, KeyError, TypeError) as exc:
                return self._json({'error': str(exc)}, 400)
        if self.path in ("/api/production/material-route", "/api/production/acceptance", "/api/production/shot-reference", "/api/production/import", "/api/production/adopt", "/api/production/judgment", "/api/production/entity-decision"):
            try:
                value = self._input(20_000_000)
                if self.path.endswith('material-route'):
                    from .material_relations import choose_route
                    result=choose_route(self.server.store, value)
                elif self.path.endswith('acceptance'):
                    from .production_acceptance import decide
                    result=decide(self.server.store,value)
                elif self.path.endswith('shot-reference'):
                    from .shot_references import select
                    result=select(self.server.store,value)
                elif self.path.endswith("import"):
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
                return self._json(suggest(preview, self.server.store))
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
                with self.server.upload_budget(size):
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
