import hashlib
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path


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
          id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id),
          anchor TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL,
          version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS comment_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT, comment_id TEXT NOT NULL REFERENCES comments(id),
          action TEXT NOT NULL, body TEXT NOT NULL, at TEXT NOT NULL
        );
        """)

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
        revision = digest(canonical(document).encode())
        existing = self.db.execute("SELECT revision FROM sources WHERE id=?", (document["id"],)).fetchone()
        if existing and existing[0] != revision:
            raise Conflict("source already exists with another revision; immutable source ids")
        with self.db:
            self.db.execute("INSERT OR IGNORE INTO sources VALUES (?,?,?)", (document["id"], canonical(document), revision))
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
        blocks = source["blocks"]
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
            raise Conflict("anchor quote differs from current source")
        return source

    def create_comment(self, value):
        import uuid
        source_id, anchor, body = value.get("source_id"), value.get("anchor"), str(value.get("body", "")).strip()
        if not body:
            raise ValueError("empty comment")
        self.validate_anchor(source_id, anchor)
        comment_id = value.get("id") or str(uuid.uuid4())
        existing = self.comment(comment_id)
        if existing:
            if existing["source_id"] == source_id and existing["anchor"] == anchor and existing["body"] == body:
                return existing
            raise Conflict("comment id already used")
        stamp = now()
        with self.db:
            self.db.execute("INSERT INTO comments VALUES (?,?,?,?,?,?,?,?)", (comment_id, source_id, canonical(anchor), body, "OPEN", 1, stamp, stamp))
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
            self.validate_anchor(current["source_id"], current["anchor"])
            status = "OPEN"
        elif action == "CLOSE" and current["status"] == "OPEN":
            body, status = current["body"], "CLOSED"
        elif action == "REOPEN" and current["status"] == "CLOSED":
            self.validate_anchor(current["source_id"], current["anchor"])
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
            source = self.source(comment["source_id"])
            blocks = source["blocks"]
            index = next(i for i, b in enumerate(blocks) if b["id"] == comment["anchor"]["block_id"])
            results.append({**comment, "source_title": source["title"], "source_url": source["source_url"],
                            "source_revision": digest(canonical(source).encode()), "block_text": blocks[index]["text"]})
        return results
