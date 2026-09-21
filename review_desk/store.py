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
    def __init__(self, db_path):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(self.db_path))
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys=ON")
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
        """)
        # Existing V1 instance databases are upgraded without rewriting source text.
        for row in self.db.execute("SELECT id,revision FROM sources ORDER BY id").fetchall():
            if not self.db.execute("SELECT 1 FROM objects WHERE id=?", (row["id"],)).fetchone():
                self._insert_object(row["id"], "SOURCE", {"source_revision": row["revision"]})
        if "target_object_id" not in {row["name"] for row in self.db.execute("PRAGMA table_info(comments)")}:
            self._migrate_comments()

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
        return revision_id

    def objects(self):
        return [dict(row) for row in self.db.execute("SELECT * FROM objects ORDER BY id")]

    def revisions(self):
        return [dict(row) for row in self.db.execute("SELECT * FROM revisions ORDER BY object_id,version")]

    def dependencies(self):
        return [dict(row) for row in self.db.execute("SELECT * FROM dependencies ORDER BY from_revision,to_revision,role")]

    def put_object(self, object_id, kind, payload, expected_version=0, dependencies=()):
        kinds = {item for domain in DOMAINS.values() for item in domain["kinds"]}
        if kind == "SOURCE" or kind not in kinds or not isinstance(object_id, str) or not object_id or not isinstance(payload, dict):
            raise ValueError("invalid object kind, id or payload; SOURCE uses put_source")
        current = self.db.execute("SELECT * FROM objects WHERE id=?", (object_id,)).fetchone()
        version = current["version"] if current else 0
        if type(expected_version) is not int or expected_version != version or (current and current["kind"] != kind):
            raise Conflict("object version or kind changed")
        new_version = version + 1
        revision_id = digest(canonical({"object_id": object_id, "version": new_version, "payload": payload}).encode())
        refs = []
        for ref in dependencies:
            if not isinstance(ref, dict) or not isinstance(ref.get("role"), str) or not ref["role"]:
                raise ValueError("invalid dependency")
            target = self.db.execute("SELECT id FROM revisions WHERE id=?", (ref.get("revision_id"),)).fetchone()
            if not target:
                raise ValueError("unknown dependency revision")
            refs.append((revision_id, target["id"], ref["role"]))
        stamp = now()
        with self.db:
            if current:
                self.db.execute("UPDATE objects SET current_revision=?,version=?,updated_at=? WHERE id=?", (revision_id, new_version, stamp, object_id))
            else:
                self.db.execute("INSERT INTO objects VALUES (?,?,?,?,?,?)", (object_id, kind, revision_id, new_version, stamp, stamp))
            self.db.execute("INSERT INTO revisions VALUES (?,?,?,?,?)", (revision_id, object_id, new_version, canonical(payload), stamp))
            self.db.executemany("INSERT INTO dependencies VALUES (?,?,?)", refs)
        return {"id": object_id, "kind": kind, "revision": revision_id, "version": new_version}

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
        current = self.configuration(scope)
        if type(expected_version) is not int or expected_version != current["version"]:
            raise Conflict("configuration version changed; refresh before saving")
        if not isinstance(updates, dict):
            raise ValueError("configuration updates must be an object")
        body = validate(scope, {**current["body"], **updates})
        version, stamp = expected_version + 1, now()
        with self.db:
            self.db.execute("INSERT INTO configurations VALUES (?,?,?,?,?) ON CONFLICT(scope) DO UPDATE SET schema_version=excluded.schema_version,version=excluded.version,body=excluded.body,updated_at=excluded.updated_at", (scope, SCHEMA_VERSION, version, canonical(body), stamp))
            self.db.execute("INSERT INTO configuration_events(scope,version,body,at) VALUES (?,?,?,?)", (scope, version, canonical(body), stamp))
        return self.configuration(scope)

    def configuration_events(self):
        return [dict(row) for row in self.db.execute("SELECT * FROM configuration_events ORDER BY id")]

    def close(self):
        self.db.close()

    def source(self, source_id):
        row = self.db.execute("SELECT * FROM sources WHERE id=?", (source_id,)).fetchone()
        return json.loads(row["document"]) if row else None

    def sources(self):
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
        def public_link(value):
            return isinstance(value, str) and urlsplit(value).scheme == "https" and bool(urlsplit(value).netloc)
        if not public_link(document["source_url"]):
            raise ValueError("source URL must be HTTPS")
        media = document.get("media")
        if media is not None and (not isinstance(media, dict) or media.get("kind") not in ("audio", "video")
                                  or not public_link(media.get("url")) or not isinstance(media.get("label"), str)
                                  or not isinstance(media.get("note"), str)):
            raise ValueError("invalid external media")
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

    def comments(self, source_id=None):
        if source_id:
            rows = self.db.execute("SELECT * FROM comments WHERE source_id=? ORDER BY created_at,id", (source_id,))
        else:
            rows = self.db.execute("SELECT * FROM comments ORDER BY source_id,created_at,id")
        return [self._comment(row) for row in rows]

    @staticmethod
    def _comment(row):
        value = dict(row)
        value["anchor"] = json.loads(value["anchor"])
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

    def validate_target(self, object_id, revision_id, anchor):
        obj = self.db.execute("SELECT * FROM objects WHERE id=?", (object_id,)).fetchone()
        revision = self.db.execute("SELECT * FROM revisions WHERE id=?", (revision_id,)).fetchone()
        if not obj or not revision or revision["object_id"] != object_id:
            raise ValueError("unknown object or mismatched revision")
        payload = json.loads(revision["payload"])
        if obj["kind"] == "SOURCE":
            source = self.validate_anchor(object_id, anchor)
            if payload.get("source_revision") != digest(canonical(source).encode()):
                raise Conflict("source revision differs from anchored object revision")
            return {"object": dict(obj), "revision": dict(revision), "blocks": source["blocks"], "source": source}
        blocks = payload.get("blocks")
        if blocks is None and isinstance(payload.get("body"), str):
            blocks = [{"id": "body", "text": payload["body"]}]
        self._validate_blocks(blocks, anchor)
        return {"object": dict(obj), "revision": dict(revision), "blocks": blocks, "source": None}

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
        existing = self.comment(comment_id)
        if existing:
            if existing["target_object_id"] == object_id and existing["target_revision_id"] == revision_id and existing["anchor"] == anchor and existing["body"] == body:
                return existing
            raise Conflict("comment id already used")
        stamp = now()
        with self.db:
            self.db.execute("INSERT INTO comments VALUES (?,?,?,?,?,?,?,?,?,?)", (comment_id, source_id, object_id, revision_id, canonical(anchor), body, "OPEN", 1, stamp, stamp))
            self.db.execute("INSERT INTO comment_events(comment_id,action,body,at) VALUES (?,?,?,?)", (comment_id, "CREATE", body, stamp))
        return self.comment(comment_id)

    def change_comment(self, comment_id, action, expected_version, body=None):
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
            self.validate_target(current["target_object_id"], current["target_revision_id"], current["anchor"])
            status = "OPEN"
        elif action == "CLOSE" and current["status"] == "OPEN":
            body, status = current["body"], "CLOSED"
        elif action == "REOPEN" and current["status"] == "CLOSED":
            self.validate_target(current["target_object_id"], current["target_revision_id"], current["anchor"])
            body, status = current["body"], "OPEN"
        else:
            raise Conflict("action does not match current status")
        stamp = now()
        with self.db:
            self.db.execute("UPDATE comments SET body=?,status=?,version=version+1,updated_at=? WHERE id=?", (body, status, stamp, comment_id))
            self.db.execute("INSERT INTO comment_events(comment_id,action,body,at) VALUES (?,?,?,?)", (comment_id, action, body, stamp))
        return self.comment(comment_id)

    def events(self):
        return [dict(row) for row in self.db.execute("SELECT * FROM comment_events ORDER BY id")]

    def context(self):
        results = []
        for comment in self.comments():
            target = self.validate_target(comment["target_object_id"], comment["target_revision_id"], comment["anchor"])
            source, blocks = target["source"], target["blocks"]
            index = next(i for i, b in enumerate(blocks) if b["id"] == comment["anchor"]["block_id"])
            results.append({**comment, "object_kind": target["object"]["kind"],
                            "source_title": source["title"] if source else None,
                            "source_url": source["source_url"] if source else None,
                            "source_revision": digest(canonical(source).encode()) if source else None,
                            "block_text": blocks[index]["text"]})
        return results
