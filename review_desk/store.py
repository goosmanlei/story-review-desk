import hashlib
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from .configuration import SCHEMA_VERSION, defaults, migrate, validate
from .framework import DOMAINS


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(data):
    return hashlib.sha256(data).hexdigest()


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Conflict(ValueError):
    pass


class Store:
    @classmethod
    def open_readonly(cls, db_path):
        """Inspect an existing instance without initialization or migrations."""
        self = cls.__new__(cls)
        self.db_path = Path(db_path)
        self.db = sqlite3.connect(self.db_path.resolve().as_uri()+'?mode=ro', uri=True)
        stat = self.db_path.stat()
        self.file_identity = (stat.st_dev, stat.st_ino)
        self._material_functions()
        from .material_storage import row_factory
        self.db.row_factory = row_factory(self)
        return self

    @classmethod
    def open_existing(cls, db_path):
        """A worker connection after the owner has initialized the schema."""
        self = cls.__new__(cls)
        self.db_path = Path(db_path)
        self.db = sqlite3.connect(self.db_path.resolve().as_uri()+'?mode=rw', uri=True)
        stat = self.db_path.stat()
        self.file_identity = (stat.st_dev, stat.st_ino)
        self.db.execute('PRAGMA foreign_keys=ON')
        self.db.execute('PRAGMA secure_delete=ON')
        self._material_functions()
        from .material_storage import row_factory
        self.db.row_factory = row_factory(self)
        return self

    def _material_functions(self):
        from .material_storage import hydrate
        from .version_consolidation import valid_identity
        self.db.create_function('material_sha256', 1, lambda text: digest(text.encode()), deterministic=True)
        self.db.create_function('material_revision_sha256', 3, lambda oid, version, payload: digest(canonical({'object_id': oid, 'version': version, 'payload': json.loads(hydrate(self, payload))}).encode()))
        self.db.create_function('material_model_migrating', 0, lambda: int(getattr(self, '_material_migrating', False)))
        self.db.create_function('material_revision_valid', 4, lambda oid, version, payload, rid: int(valid_identity(self, oid, version, json.loads(hydrate(self, payload)), rid)))

    def __init__(self, db_path):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(self.db_path))
        stat = self.db_path.stat() if str(self.db_path) != ':memory:' else None
        self.file_identity = (stat.st_dev, stat.st_ino) if stat else None
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.execute("PRAGMA secure_delete=ON")
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS sources (
          id TEXT PRIMARY KEY, document TEXT NOT NULL, revision TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS comments (
          id TEXT PRIMARY KEY, source_id TEXT REFERENCES sources(id),
          target_object_id TEXT NOT NULL REFERENCES objects(id),
          target_revision_id TEXT NOT NULL REFERENCES revisions(id),
          anchor TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL,
          version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS comment_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT, comment_id TEXT NOT NULL REFERENCES comments(id),
          action TEXT NOT NULL, body TEXT NOT NULL, at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS objects (
          id TEXT PRIMARY KEY, kind TEXT NOT NULL, current_revision TEXT NOT NULL,
          version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS revisions (
          id TEXT PRIMARY KEY, object_id TEXT NOT NULL REFERENCES objects(id),
          version INTEGER NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL,
          UNIQUE(object_id,version)
        );
        CREATE TABLE IF NOT EXISTS dependencies (
          from_revision TEXT NOT NULL REFERENCES revisions(id),
          to_revision TEXT NOT NULL REFERENCES revisions(id), role TEXT NOT NULL,
          PRIMARY KEY(from_revision,to_revision,role)
        );
        CREATE TABLE IF NOT EXISTS configurations (
          scope TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, version INTEGER NOT NULL,
          body TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS configuration_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL,
          version INTEGER NOT NULL, body TEXT NOT NULL, at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS material_rounds (
          material_id TEXT NOT NULL REFERENCES objects(id), number INTEGER NOT NULL,
          state TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(material_id,number)
        );
        CREATE TABLE IF NOT EXISTS material_members (
          material_id TEXT NOT NULL, number INTEGER NOT NULL,
          revision_id TEXT NOT NULL REFERENCES revisions(id), role TEXT NOT NULL, evidence TEXT NOT NULL,
          PRIMARY KEY(material_id,number,revision_id),
          FOREIGN KEY(material_id,number) REFERENCES material_rounds(material_id,number)
        );
        CREATE TABLE IF NOT EXISTS material_feedback (
          comment_id TEXT PRIMARY KEY REFERENCES comments(id), material_id TEXT NOT NULL, number INTEGER NOT NULL,
          FOREIGN KEY(material_id,number) REFERENCES material_rounds(material_id,number)
        );
        CREATE TABLE IF NOT EXISTS material_comment_scopes (
          comment_id TEXT NOT NULL REFERENCES comments(id), material_id TEXT NOT NULL, number INTEGER NOT NULL,
          PRIMARY KEY(comment_id,material_id),
          FOREIGN KEY(material_id,number) REFERENCES material_rounds(material_id,number)
        );
        """)
        self.db.execute('CREATE INDEX IF NOT EXISTS material_members_revision ON material_members(revision_id)')
        from .material_plans import SCHEMA
        self.db.executescript(SCHEMA)
        from .material_storage import SCHEMA as CONTENT_SCHEMA, row_factory, upgrade_identity_triggers
        self._material_functions()
        try:
            upgrade_identity_triggers(self.db)
            self.db.executescript(CONTENT_SCHEMA)
            self.db.row_factory = row_factory(self)
            # Existing V1 instance databases are upgraded without rewriting source text.
            for row in self.db.execute("SELECT id,revision FROM sources ORDER BY id").fetchall():
                if not self.db.execute("SELECT 1 FROM objects WHERE id=?", (row["id"],)).fetchone():
                    self._insert_object(row["id"], "SOURCE", {"source_revision": row["revision"]})
            if "target_object_id" not in {row["name"] for row in self.db.execute("PRAGMA table_info(comments)")}:
                self._migrate_comments()
            from .business_codes import initialize
            initialize(self)
            from .relation_explanations import initialize as initialize_relationship_policy
            initialize_relationship_policy(self)
            from .state_cleanup import initialize as initialize_state_cleanup
            initialize_state_cleanup(self)
            from .version_consolidation import initialize as initialize_consolidation
            initialize_consolidation(self)
        except BaseException:
            self.db.rollback()
            try:
                from .material_storage import cleanup_legacy_triggers
                cleanup_legacy_triggers(self.db)
                self.db.commit()
            except BaseException:
                self.db.rollback()
            self.db.close()
            raise

    def _migrate_comments(self):
        """Add exact object/revision anchors while preserving old source comments/events."""
        self.db.commit()
        self.db.execute("PRAGMA foreign_keys=OFF")
        try:
            with self.db:
                self.db.execute("""CREATE TABLE comments_v2 (
                  id TEXT PRIMARY KEY, source_id TEXT REFERENCES sources(id),
                  target_object_id TEXT NOT NULL REFERENCES objects(id),
                  target_revision_id TEXT NOT NULL REFERENCES revisions(id),
                  anchor TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL,
                  version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                )""")
                self.db.execute("""INSERT INTO comments_v2
                  SELECT c.id,c.source_id,c.source_id,o.current_revision,c.anchor,c.body,c.status,c.version,c.created_at,c.updated_at
                  FROM comments c JOIN objects o ON o.id=c.source_id""")
                if self.db.execute("SELECT COUNT(*) FROM comments_v2").fetchone()[0] != self.db.execute("SELECT COUNT(*) FROM comments").fetchone()[0]:
                    raise ValueError("comment migration lost target objects")
                self.db.execute("DROP TABLE comments")
                self.db.execute("ALTER TABLE comments_v2 RENAME TO comments")
        finally:
            self.db.execute("PRAGMA foreign_keys=ON")
        if self.db.execute("PRAGMA foreign_key_check").fetchone():
            raise ValueError("comment migration foreign key failure")

    def _insert_object(self, object_id, kind, payload):
        stamp = now()
        revision_id = digest(canonical({"object_id": object_id, "version": 1, "payload": payload}).encode())
        with self.db:
            self.db.execute("INSERT INTO objects VALUES (?,?,?,?,?,?)", (object_id, kind, revision_id, 1, stamp, stamp))
            self.db.execute("INSERT INTO revisions VALUES (?,?,?,?,?)", (revision_id, object_id, 1, canonical(payload), stamp))
            if self.db.execute("SELECT 1 FROM sqlite_master WHERE name='business_codes'").fetchone():
                from .business_codes import allocate
                allocate(self, object_id, kind, payload)
        return revision_id

    def objects(self):
        return [dict(row) for row in self.db.execute("SELECT * FROM objects ORDER BY id")]

    def revisions(self):
        return [dict(row) for row in self.db.execute("SELECT * FROM revisions ORDER BY object_id,version")]

    def dependencies(self):
        return [dict(row) for row in self.db.execute("SELECT * FROM dependencies ORDER BY from_revision,to_revision,role")]

    def put_object(self, object_id, kind, payload, expected_version=0, dependencies=()):
        return self.put_objects([{"object_id": object_id, "kind": kind, "payload": payload,
                                  "expected_version": expected_version, "dependencies": dependencies}])[0]

    def put_objects(self, records):
        """Publish a complete set atomically, including optimistic version checks."""
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            return [self._put_object(**record) for record in records]

    def _put_object(self, object_id, kind, payload, expected_version=0, dependencies=()):
        from .methods import guard_write as guard_method
        guard_method(self, object_id, kind, payload, expected_version)
        from .version_consolidation import guard_write as guard_consolidation
        guard_consolidation(self, object_id, payload)
        from .state_cleanup import guard_write
        guard_write(self, object_id, payload)
        kinds = {item for domain in DOMAINS.values() for item in domain["kinds"]}
        if kind == "SOURCE" or kind not in kinds or not isinstance(object_id, str) or not object_id or not isinstance(payload, dict):
            raise ValueError("invalid object kind, id or payload; SOURCE uses put_source")
        current = self.db.execute("SELECT * FROM objects WHERE id=?", (object_id,)).fetchone()
        version = current["version"] if current else 0
        if type(expected_version) is not int or expected_version != version or (current and current["kind"] != kind):
            raise Conflict("object version or kind changed")
        if kind == 'REQUIREMENT' and payload.get('generation'):
            from .method_media import verify, administrative
            payload, administrative_ref = administrative(self, object_id, payload, current)
            if administrative_ref:
                dependencies = [d for d in dependencies if not d['role'].startswith('payload.method_adjustment.')] + [administrative_ref]
            verify(self, object_id, payload)
        if kind == "CALL":
            from .generation import validate_call
            validate_call(self, object_id, payload)
        new_version = version + 1
        from .version_consolidation import new_identity
        revision_id = new_identity(self, object_id, new_version, payload)
        refs = []
        for ref in dependencies:
            if not isinstance(ref, dict) or not isinstance(ref.get("role"), str) or not ref["role"]:
                raise ValueError("invalid dependency")
            target = self.db.execute("SELECT id FROM revisions WHERE id=?", (ref.get("revision_id"),)).fetchone()
            if not target:
                raise ValueError("unknown dependency revision")
            refs.append((revision_id, target["id"], ref["role"]))
        stamp = now()
        if current:
            self.db.execute("UPDATE objects SET current_revision=?,version=?,updated_at=? WHERE id=?", (revision_id, new_version, stamp, object_id))
        else:
            self.db.execute("INSERT INTO objects VALUES (?,?,?,?,?,?)", (object_id, kind, revision_id, new_version, stamp, stamp))
        self.db.execute("INSERT INTO revisions VALUES (?,?,?,?,?)", (revision_id, object_id, new_version, self._encode_material(payload), stamp))
        self.db.executemany("INSERT INTO dependencies VALUES (?,?,?)", refs)
        if kind == 'RELATION' and payload.get('relation_type') == 'entity':
            from .relation_explanations import supersede
            supersede(self, object_id, current['current_revision'] if current else None)
        from .business_codes import allocate, allocate_candidates
        allocate(self, object_id, kind, payload)
        if kind in ("REQUIREMENT", "CALL", "ASSET"):
            from .material_plans import register
            from .production import record
            row=record(self, revision_id=revision_id)
            from .material_model import refresh_identity
            refresh_identity(self,row)
            register(self, row)
            allocate_candidates(self, revision_id)
        return {"id": object_id, "kind": kind, "revision": revision_id, "version": new_version}

    def _encode_material(self, payload):
        from .material_storage import encode
        return encode(self, payload)

    def configuration(self, scope):
        if scope not in ("SYSTEM", "PROJECT"):
            raise ValueError("unknown configuration scope")
        row = self.db.execute("SELECT * FROM configurations WHERE scope=?", (scope,)).fetchone()
        if not row:
            return {"scope": scope, "schema_version": SCHEMA_VERSION, "version": 0, "body": defaults(scope), "updated_at": None}
        result = dict(row)
        result["body"] = migrate(scope, result["schema_version"], json.loads(result["body"]))
        return result

    def configurations(self):
        return {scope: self.configuration(scope) for scope in ("SYSTEM", "PROJECT")}

    def set_configuration(self, scope, updates, expected_version):
        with self.db:
            self.db.execute('BEGIN IMMEDIATE')
            current = self.configuration(scope)
            if type(expected_version) is not int or expected_version != current["version"]:
                raise Conflict("configuration version changed; refresh before saving")
            if not isinstance(updates, dict):
                raise ValueError("configuration updates must be an object")
            body = validate(scope, {**current["body"], **updates})
            if scope == "SYSTEM" and body["site_favicon"]:
                from .favicon import asset
                asset(self.db_path.parent.parent, body["site_favicon"])
            version, stamp = expected_version + 1, now()
            self.db.execute("INSERT INTO configurations VALUES (?,?,?,?,?) ON CONFLICT(scope) DO UPDATE SET schema_version=excluded.schema_version,version=excluded.version,body=excluded.body,updated_at=excluded.updated_at", (scope, SCHEMA_VERSION, version, canonical(body), stamp))
            self.db.execute("INSERT INTO configuration_events(scope,version,body,at) VALUES (?,?,?,?)", (scope, version, canonical(body), stamp))
            return self.configuration(scope)

    def configuration_events(self):
        return [dict(row) for row in self.db.execute("SELECT * FROM configuration_events ORDER BY id")]

    def close(self):
        if getattr(self, 'read_cache', None):
            self.read_cache.close()
        self.db.close()

    def source(self, source_id):
        row = self.db.execute("SELECT * FROM sources WHERE id=?", (source_id,)).fetchone()
        return json.loads(row["document"]) if row else None

    def sources(self, metadata=False):
        if metadata:
            return [dict(row) for row in self.db.execute("SELECT id,json_extract(document,'$.title') AS title FROM sources ORDER BY id")]
        return [json.loads(row[0]) for row in self.db.execute("SELECT document FROM sources ORDER BY id")]

    def put_source(self, document):
        required = ("id", "title", "version_type", "origin", "source_url", "collected_at", "blocks", "notes", "assets")
        if not isinstance(document, dict) or any(not document.get(k) for k in required if k != "assets"):
            raise ValueError("source requires id, title, version_type, origin, source_url, collected_at, blocks, notes")
        if not isinstance(document["blocks"], list) or not document["blocks"]:
            raise ValueError("blocks must be non-empty")
        block_ids = [b.get("id") for b in document["blocks"]]
        if len(set(block_ids)) != len(block_ids) or any(not b.get("text") for b in document["blocks"]):
            raise ValueError("block ids must be unique and text non-empty")
        if not isinstance(document.get("assets"), list):
            raise ValueError("assets must be a list")
        if document.get("group") not in (None, "folk-tales", "expansion-directions", "story-refinements"):
            raise ValueError("unknown source group")
        if "order" in document and (type(document["order"]) is not int or document["order"] < 0):
            raise ValueError("source order must be a non-negative integer")
        def public_link(value):
            return isinstance(value, str) and urlsplit(value).scheme == "https" and bool(urlsplit(value).netloc)
        if not public_link(document["source_url"]):
            raise ValueError("source URL must be HTTPS")
        media = document.get("media")
        if media is not None:
            if not isinstance(media, dict) or media.get("kind") not in ("audio", "video") or not isinstance(media.get("label"), str) or not isinstance(media.get("note"), str):
                raise ValueError("invalid media metadata")
            filename = media.get("file")
            if filename is not None and (not isinstance(filename, str) or not filename or filename.startswith(".") or filename != Path(filename).name or Path(filename).suffix.lower() not in ({".mp3", ".m4a", ".ogg"} if media["kind"] == "audio" else {".mp4", ".webm"})):
                raise ValueError("invalid local media file")
            if filename is None and not public_link(media.get("url")):
                raise ValueError("media needs a local file or HTTPS URL")
            if media.get("url") is not None and not public_link(media["url"]):
                raise ValueError("invalid media URL")
        references = document.get("references", [])
        if not isinstance(references, list) or any(not isinstance(ref, dict) or not isinstance(ref.get("label"), str)
                                                   or not public_link(ref.get("url")) for ref in references):
            raise ValueError("invalid source references")
        revision = digest(canonical(document).encode())
        existing = self.db.execute("SELECT revision FROM sources WHERE id=?", (document["id"],)).fetchone()
        if existing and existing[0] != revision:
            raise Conflict("source already exists with another revision; immutable source ids")
        with self.db:
            self.db.execute("INSERT OR IGNORE INTO sources VALUES (?,?,?)", (document["id"], canonical(document), revision))
        if not self.db.execute("SELECT 1 FROM objects WHERE id=?", (document["id"],)).fetchone():
            self._insert_object(document["id"], "SOURCE", {"source_revision": revision})
        return revision

    def remove_sources(self, source_ids):
        """Permanently remove explicitly named source records and their exclusive audit data."""
        ids = tuple(source_ids)
        if not ids or len(set(ids)) != len(ids) or any(not isinstance(value, str) or not value for value in ids):
            raise ValueError("provide distinct, non-empty source ids")
        present = {row[0] for row in self.db.execute("SELECT id FROM sources")}
        if set(ids) - present:
            raise ValueError("unknown source ids: " + ", ".join(sorted(set(ids) - present)))
        marks = ",".join("?" for _ in ids)
        external = self.db.execute(f"""SELECT d.from_revision,d.to_revision FROM dependencies d
            JOIN revisions target ON target.id=d.to_revision
            JOIN revisions origin ON origin.id=d.from_revision
            WHERE target.object_id IN ({marks}) AND origin.object_id NOT IN ({marks})""", ids + ids).fetchall()
        if external:
            raise Conflict("source revisions are referenced by surviving objects")
        with self.db:
            self.db.execute(f"DELETE FROM comment_events WHERE comment_id IN (SELECT id FROM comments WHERE target_object_id IN ({marks}))", ids)
            self.db.execute(f"DELETE FROM comments WHERE target_object_id IN ({marks})", ids)
            self.db.execute(f"""DELETE FROM dependencies WHERE from_revision IN
                (SELECT id FROM revisions WHERE object_id IN ({marks})) OR to_revision IN
                (SELECT id FROM revisions WHERE object_id IN ({marks}))""", ids + ids)
            self.db.execute(f"DELETE FROM revisions WHERE object_id IN ({marks})", ids)
            self.db.execute(f"DELETE FROM objects WHERE id IN ({marks})", ids)
            self.db.execute(f"DELETE FROM sources WHERE id IN ({marks})", ids)
        return {"removed": list(ids), "remaining": len(self.sources())}

    def replace_source_metadata(self, source_id, updates):
        """Instance migration: replace metadata only, retaining the exact text blocks."""
        allowed = {"assets", "edition", "notes", "origin", "source_url", "text_heading", "title", "version_type"}
        if not isinstance(updates, dict) or not updates or set(updates) - allowed:
            raise ValueError("only source metadata may be replaced")
        original = self.source(source_id)
        if original is None:
            raise ValueError("unknown source")
        if self.db.execute("SELECT 1 FROM comments WHERE target_object_id=?", (source_id,)).fetchone():
            raise Conflict("cannot replace metadata of a commented source")
        if self.db.execute("""SELECT 1 FROM dependencies d JOIN revisions r
            ON r.id=d.to_revision OR r.id=d.from_revision WHERE r.object_id=?""", (source_id,)).fetchone():
            raise Conflict("cannot replace metadata of a source with dependencies")
        obj = self.db.execute("SELECT * FROM objects WHERE id=?", (source_id,)).fetchone()
        revisions = self.db.execute("SELECT * FROM revisions WHERE object_id=?", (source_id,)).fetchall()
        if obj["version"] != 1 or len(revisions) != 1:
            raise Conflict("metadata replacement requires a single source revision")
        document = {**original, **updates}
        probe = Store(":memory:")
        try:
            new_source_revision = probe.put_source(document)
        finally:
            probe.close()
        new_object_revision = digest(canonical({"object_id": source_id, "version": 1, "payload": {"source_revision": new_source_revision}}).encode())
        with self.db:
            self.db.execute("UPDATE sources SET document=?,revision=? WHERE id=?", (canonical(document), new_source_revision, source_id))
            self.db.execute("DELETE FROM revisions WHERE object_id=?", (source_id,))
            self.db.execute("UPDATE objects SET current_revision=?,updated_at=? WHERE id=?", (new_object_revision, now(), source_id))
            self.db.execute("INSERT INTO revisions VALUES (?,?,?,?,?)", (new_object_revision, source_id, 1, canonical({"source_revision": new_source_revision}), now()))
        return new_source_revision

    def replace_source_content(self, document, expected_revision):
        """Explicitly replace one unreferenced refinement in place, never comments.

        This is deliberately not the normal immutable import operation. The
        compare/check/replace sequence holds one SQLite write transaction.
        """
        if not isinstance(document, dict) or document.get("group") != "story-refinements":
            raise ValueError("content replacement is limited to story refinements")
        if not isinstance(expected_revision, str) or len(expected_revision) != 64:
            raise ValueError("expected source revision is required")
        probe = Store(":memory:")
        try:
            revision = probe.put_source(document)
        finally:
            probe.close()
        source_id = document["id"]
        payload = {"source_revision": revision}
        object_revision = digest(canonical({"object_id": source_id, "version": 1, "payload": payload}).encode())
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            row = self.db.execute("SELECT * FROM sources WHERE id=?", (source_id,)).fetchone()
            if not row:
                raise ValueError("refinement does not exist")
            original = json.loads(row["document"])
            if original.get("group") != "story-refinements" or original.get("order") != document.get("order"):
                raise ValueError("replacement must preserve refinement identity and menu order")
            if row["revision"] == revision:
                return {"id": source_id, "revision": revision, "changed": False}
            if row["revision"] != expected_revision:
                raise Conflict("source changed after authoring began")
            if self.db.execute("SELECT 1 FROM comments WHERE target_object_id=? OR source_id=?", (source_id, source_id)).fetchone():
                raise Conflict("cannot replace a commented refinement")
            if self.db.execute("""SELECT 1 FROM dependencies d JOIN revisions r
                ON r.id=d.from_revision OR r.id=d.to_revision WHERE r.object_id=?""", (source_id,)).fetchone():
                raise Conflict("cannot replace a refinement with dependencies")
            obj = self.db.execute("SELECT * FROM objects WHERE id=?", (source_id,)).fetchone()
            revisions = self.db.execute("SELECT * FROM revisions WHERE object_id=?", (source_id,)).fetchall()
            if not obj or obj["kind"] != "SOURCE" or obj["version"] != 1 or len(revisions) != 1 or revisions[0]["id"] != obj["current_revision"]:
                raise Conflict("replacement requires a single SOURCE revision")
            stamp = now()
            self.db.execute("UPDATE sources SET document=?,revision=? WHERE id=?", (canonical(document), revision, source_id))
            self.db.execute("DELETE FROM revisions WHERE object_id=?", (source_id,))
            self.db.execute("INSERT INTO revisions VALUES (?,?,?,?,?)", (object_revision, source_id, 1, canonical(payload), stamp))
            self.db.execute("UPDATE objects SET current_revision=?,updated_at=? WHERE id=?", (object_revision, stamp, source_id))
        return {"id": source_id, "revision": revision, "changed": True}

    def comments(self, source_id=None, target_object_id=None, target_revision_id=None):
        if target_revision_id:
            rows = self.db.execute("SELECT * FROM comments WHERE target_object_id=? AND target_revision_id=? ORDER BY created_at,id", (target_object_id, target_revision_id))
        elif target_object_id:
            rows = self.db.execute("SELECT * FROM comments WHERE target_object_id=? ORDER BY created_at,id", (target_object_id,))
        elif source_id:
            rows = self.db.execute("SELECT * FROM comments WHERE source_id=? ORDER BY created_at,id", (source_id,))
        else:
            rows = self.db.execute("SELECT * FROM comments ORDER BY source_id,created_at,id")
        return [self._comment(row) for row in rows]

    def _comment(self, row):
        value = dict(row)
        value["anchor"] = json.loads(value["anchor"])
        scopes = [dict(v) for v in self.db.execute('SELECT material_id,number FROM material_comment_scopes WHERE comment_id=? ORDER BY material_id', (value['id'],))]
        if scopes:value['material_scopes'] = scopes
        plans = [dict(v) for v in self.db.execute('SELECT material_id,number FROM material_plan_comments WHERE comment_id=? ORDER BY material_id', (value['id'],))]
        if plans:value['material_plan_scopes'] = plans
        return value

    def comment(self, comment_id):
        row = self.db.execute("SELECT * FROM comments WHERE id=?", (comment_id,)).fetchone()
        return self._comment(row) if row else None

    def validate_anchor(self, source_id, anchor):
        source = self.source(source_id)
        if not source:
            raise ValueError("unknown source")
        self._validate_blocks(source["blocks"], anchor)
        return source

    @staticmethod
    def _validate_blocks(blocks, anchor):
        if not isinstance(blocks, list) or not blocks or not isinstance(anchor, dict):
            raise ValueError("invalid text blocks or anchor")
        if "segments" in anchor:
            segments = anchor["segments"]
            if not isinstance(segments, list) or len(segments) < 2:
                raise ValueError("invalid text anchor segments")
            ids = [b["id"] for b in blocks]
            occupied = {}
            for part in segments:
                if not isinstance(part, dict) or set(part) != {"block_id", "end_block_id", "start", "end", "quote"}:
                    raise ValueError("invalid text anchor segment")
                Store._validate_blocks(blocks, part)
                first, last = ids.index(part["block_id"]), ids.index(part["end_block_id"])
                for index in range(first, last + 1):
                    start = part["start"] if index == first else 0
                    end = part["end"] if index == last else len(blocks[index]["text"])
                    ranges = occupied.setdefault(index, [])
                    if any(start < old_end and old_start < end for old_start, old_end in ranges):
                        raise ValueError("overlapping text anchor segments")
                    ranges.append((start, end))
            expected = {"block_id": segments[0]["block_id"], "start": segments[0]["start"],
                        "end_block_id": segments[-1]["end_block_id"], "end": segments[-1]["end"],
                        "quote": "\n".join(part["quote"] for part in segments)}
            if any(type(anchor.get(key)) is not type(value) or anchor.get(key) != value for key, value in expected.items()):
                raise Conflict("segmented anchor differs from exact passages")
            return blocks
        ids = [b["id"] for b in blocks]
        try:
            start_index = ids.index(anchor["block_id"])
            end_index = ids.index(anchor["end_block_id"])
            start, end = anchor["start"], anchor["end"]
        except (KeyError, ValueError, TypeError):
            raise ValueError("invalid anchor")
        if not all(type(x) is int for x in (start, end)) or start_index > end_index:
            raise ValueError("invalid anchor range")
        first, last = blocks[start_index]["text"], blocks[end_index]["text"]
        if start < 0 or end < 0 or start > len(first) or end > len(last):
            raise ValueError("anchor out of bounds")
        if start_index == end_index and start >= end:
            raise ValueError("empty anchor")
        pieces = [b["text"] for b in blocks[start_index:end_index + 1]]
        pieces[0] = pieces[0][start:]
        pieces[-1] = pieces[-1][:end] if len(pieces) > 1 else first[start:end]
        quote = "\n".join(pieces)
        if not quote.strip() or quote != anchor.get("quote"):
            raise Conflict("anchor quote differs from target revision")
        return blocks

    def validate_target(self, object_id, revision_id, anchor, *, _source_cache=None):
        obj = self.db.execute("SELECT * FROM objects WHERE id=?", (object_id,)).fetchone()
        revision = self.db.execute("SELECT * FROM revisions WHERE id=?", (revision_id,)).fetchone()
        if not obj or not revision or revision["object_id"] != object_id:
            raise ValueError("unknown object or mismatched revision")
        payload = json.loads(revision["payload"])
        if obj["kind"] == "DELETED_STATE":raise Conflict("此准确状态目标已清理；保留既有评论，不新增正文锚点")
        if obj["kind"] == "SOURCE":
            if _source_cache is not None and object_id in _source_cache:
                source, source_revision = _source_cache[object_id]
            else:
                source = self.source(object_id)
                source_revision = digest(canonical(source).encode())
                if _source_cache is not None:
                    _source_cache[object_id] = source, source_revision
            if payload.get("source_revision") != source_revision:
                raise Conflict("source revision differs from anchored object revision")
            blocks, visuals = source["blocks"], source.get("assets", [])
        elif obj["kind"] == "STORY" and object_id == "story-structure":
            blocks = [block for section in payload["sections"] for block in ([{"id": "heading-" + section["id"], "text": section["title"]}] + section["blocks"])]
            visuals = [visual for section in payload["sections"] for visual in section.get("visuals", [])]
            source = None
        else:
            blocks, visuals, source = payload.get("blocks"), [], None
            if str(payload.get("format", "")).startswith("production-"):
                from .review_text import production_text_blocks
                blocks = production_text_blocks(payload)
                visuals = [c for c in payload.get("components", []) if c.get("mime", "").startswith("image/")]
        if blocks is None and isinstance(payload.get("body"), str):
            blocks = [{"id": "body", "text": payload["body"]}]
        if not isinstance(anchor, dict):
            raise ValueError("invalid anchor")
        kind = anchor.get("type", "text")
        if kind == "text":
            self._validate_blocks(blocks, anchor)
        elif kind == "global":
            production = str(payload.get("format", "")).startswith("production-")
            if not (production or obj["kind"] == "STORY" and object_id == "story-structure") or set(anchor) != {"type"}:
                raise ValueError("invalid global anchor")
        elif kind == "time":
            from .production_media import validate_component
            from .production import validate_selection, FORMATS
            if payload.get("format") not in FORMATS:
                raise ValueError("time comments require a production media revision")
            component = next((c for c in payload.get("components", []) if c["id"] == anchor.get("component_id")), None)
            if not component or component["file"] != anchor.get("asset_file"):
                raise Conflict("time comment differs from exact component")
            validate_component(self.db_path.parent.parent, component, inspect=False)
            validate_selection(component, {"range": anchor})
        elif kind in ("visual", "region"):
            visual = next((v for v in visuals if v.get("id", v.get("file")) == anchor.get("visual_id")), None)
            if not visual or anchor.get("asset_file") != visual.get("file"):
                raise Conflict("visual asset reference differs from target revision")
            if not (self.db_path.parent.parent / "export" / "assets" / visual["file"]).is_file():
                raise Conflict("referenced visual asset is missing")
            if str(payload.get("format", "")).startswith("production-"):
                from .production_media import validate_component
                validate_component(self.db_path.parent.parent, visual, inspect=False)
            if kind == "region":
                points = anchor.get("points")
                if not isinstance(points, list) or not 3 <= len(points) <= 260 or any(
                    not isinstance(point, dict) or any(type(point.get(axis)) not in (int, float) or not 0 <= point[axis] <= 1 for axis in ("x", "y")) for point in points
                ):
                    raise ValueError("invalid normalized region")
                area = abs(sum(points[i]["x"] * points[(i + 1) % len(points)]["y"] - points[(i + 1) % len(points)]["x"] * points[i]["y"] for i in range(len(points)))) / 2
                if area < 0.00001:
                    raise ValueError("empty visual region")
        else:
            raise ValueError("unknown anchor type")
        return {"object": dict(obj), "revision": dict(revision), "blocks": blocks, "visuals": visuals, "source": source}

    def anchor_state(self, object_id, revision_id, anchor, *, _source_cache=None):
        if self.db.execute("SELECT 1 FROM relation_explanation_redactions WHERE revision_id=?",(revision_id,)).fetchone():
            return {"valid":False,"reason":"旧关系说明已清理；评论及原文引用保留，不能定位或替换为最新说明。"}
        try:
            self.validate_target(object_id, revision_id, anchor, _source_cache=_source_cache)
            return {"valid": True}
        except (ValueError, Conflict, KeyError, TypeError) as exc:
            return {"valid": False, "reason": str(exc)}

    def comment_anchor_states(self, comments):
        # Only immutable source content is shared within this response. Each
        # exact revision, anchor and media original is still validated; nothing
        # is retained on the store or reused by subsequent reads or writes.
        source_cache = {}
        return [{**comment, "anchor_state": self.anchor_state(
            comment["target_object_id"], comment["target_revision_id"],
            comment["anchor"], _source_cache=source_cache)} for comment in comments]

    def create_comment(self, value):
        import uuid
        source_id, anchor, body = value.get("source_id"), value.get("anchor"), str(value.get("body", "")).strip()
        if not body:
            raise ValueError("empty comment")
        object_id = value.get("target_object_id") or source_id
        obj = self.db.execute("SELECT * FROM objects WHERE id=?", (object_id,)).fetchone()
        if not obj:
            raise ValueError("unknown target object")
        revision_id = value.get("target_revision_id") or obj["current_revision"]
        target = self.validate_target(object_id, revision_id, anchor)
        if target["source"]:
            if source_id and source_id != object_id:
                raise ValueError("source_id must match SOURCE target")
            source_id = object_id
        elif source_id is not None:
            raise ValueError("source_id is only valid for SOURCE targets")
        comment_id = value.get("id") or str(uuid.uuid4())
        def matches(existing):
            context=value.get('material_context')
            if context is not None:
                if not isinstance(context,dict):return False
                key='material_plan_scopes' if context.get('model')=='plan-v1' else 'material_scopes'
                if not any(scope['material_id']==context.get('material_id') and scope['number']==context.get('number') for scope in existing.get(key,[])):
                    return False
            return existing['target_object_id']==object_id and existing['target_revision_id']==revision_id and existing['anchor']==anchor and existing['body']==body
        existing = self.comment(comment_id)
        if existing:
            if matches(existing):
                return existing
            raise Conflict("comment id already used")
        stamp = now()
        with self.db:
            self.db.execute('BEGIN IMMEDIATE')
            existing = self.comment(comment_id)
            if existing:
                if matches(existing):
                    return existing
                raise Conflict('comment id already used')
            self.db.execute("INSERT INTO comments VALUES (?,?,?,?,?,?,?,?,?,?)", (comment_id, source_id, object_id, revision_id, canonical(anchor), body, "OPEN", 1, stamp, stamp))
            from .business_codes import allocate_comments
            allocate_comments(self)
            self.db.execute("INSERT INTO comment_events(comment_id,action,body,at) VALUES (?,?,?,?)", (comment_id, "CREATE", body, stamp))
            context = value.get('material_context')
            if isinstance(context, dict) and context.get('model') == 'plan-v1':
                from .material_plans import comment_scope
                comment_scope(self, self.comment(comment_id), context)
            else:
                from .material_versions import comment_scope
                comment_scope(self, self.comment(comment_id), context, value.get('material_revision'))
            # Revision intent remains readable in old clients; comments never
            # create a plan version or modify generation inputs.
            return self.comment(comment_id)

    def change_comment(self, comment_id, action, expected_version, body=None):
        with self.db:
            self.db.execute('BEGIN IMMEDIATE')
            current = self.comment(comment_id)
            if not current:
                raise ValueError("unknown comment")
            if type(expected_version) is not int or current["version"] != expected_version:
                raise Conflict("comment version changed; refresh before editing")
            if action == "EDIT":
                if current["status"] != "OPEN":
                    raise Conflict("closed comment cannot be edited")
                body = str(body or "").strip()
                if not body:
                    raise ValueError("empty comment")
                # Historical comments remain editable even if an external asset was lost.
                status = "OPEN"
            elif action == "CLOSE" and current["status"] == "OPEN":
                body, status = current["body"], "CLOSED"
            elif action == "REOPEN" and current["status"] == "CLOSED":
                body, status = current["body"], "OPEN"
            else:
                raise Conflict("action does not match current status")
            stamp = now()
            self.db.execute("UPDATE comments SET body=?,status=?,version=version+1,updated_at=? WHERE id=?", (body, status, stamp, comment_id))
            self.db.execute("INSERT INTO comment_events(comment_id,action,body,at) VALUES (?,?,?,?)", (comment_id, action, body, stamp))
            return self.comment(comment_id)

    def events(self):
        return [dict(row) for row in self.db.execute("SELECT * FROM comment_events ORDER BY id")]

    def context(self):
        results = []
        for comment in self.comments():
            state = self.anchor_state(comment["target_object_id"], comment["target_revision_id"], comment["anchor"])
            if not state["valid"]:
                results.append({**comment, "anchor_state": state})
                continue
            target = self.validate_target(comment["target_object_id"], comment["target_revision_id"], comment["anchor"])
            source, blocks = target["source"], target["blocks"]
            index = next((i for i, b in enumerate(blocks or []) if b["id"] == comment["anchor"].get("block_id")), None)
            results.append({**comment, "object_kind": target["object"]["kind"],
                            "source_title": source["title"] if source else None,
                            "source_url": source["source_url"] if source else None,
                            "source_revision": digest(canonical(source).encode()) if source else None,
                            "block_text": blocks[index]["text"] if index is not None else None,
                            "visual": next((v for v in target["visuals"] if v.get("id", v.get("file")) == comment["anchor"].get("visual_id")), None),
                            "anchor_state": state})
        return results
