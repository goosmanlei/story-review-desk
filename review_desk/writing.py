"""Local, serial authoring checkpoints. No model calls and no review-desk writes."""

import copy
import json
import re
import sqlite3
from pathlib import Path

from .store import Conflict, canonical, digest, now


def checksum(value):
    return digest(canonical(value).encode())


class WritingStore:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(path))
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS checkpoints(
          revision TEXT PRIMARY KEY, parent TEXT, payload TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS steps(
          id TEXT PRIMARY KEY, base_revision TEXT NOT NULL REFERENCES checkpoints(revision),
          spec TEXT NOT NULL, status TEXT NOT NULL, candidate TEXT, candidate_hash TEXT,
          read_hash TEXT, review TEXT, result_revision TEXT REFERENCES checkpoints(revision));
        CREATE TABLE IF NOT EXISTS events(
          seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, action TEXT NOT NULL, payload TEXT NOT NULL);
        """)

    def close(self):
        self.db.close()

    def _get(self, key):
        row = self.db.execute("SELECT value FROM metadata WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else None

    def _set(self, key, value):
        self.db.execute("INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, canonical(value)))

    def _event(self, action, value):
        self.db.execute("INSERT INTO events(at,action,payload) VALUES (?,?,?)", (now(), action, canonical(value)))

    def _checkpoint(self, state, parent, reason):
        revision = checksum({"parent": parent, "state": state, "reason": reason})
        self.db.execute("INSERT INTO checkpoints VALUES (?,?,?,?)", (revision, parent, canonical(state), now()))
        self._set("head", revision)
        self._event("CHECKPOINT", {"revision": revision, "parent": parent, "reason": reason})
        return revision

    def init(self, seed):
        source = seed.get("source")
        if not isinstance(source, dict) or source.get("group") != "story-refinements" or not seed.get("constraints"):
            raise ValueError("seed requires refinement source and explicit constraints")
        if seed.get("source_revision") != checksum(source):
            raise ValueError("source baseline checksum mismatch")
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            if self._get("seed") is not None:
                if self._get("seed") != seed:
                    raise Conflict("writing run already initialized with another seed")
                return self.status()
            self._set("seed", seed)
            state = {"phase": "DRAFTING", "fragments": [], "notes": seed.get("notes", {})}
            self._checkpoint(state, None, "INIT")
        return self.status()

    def current(self):
        head = self._get("head")
        if not head:
            raise ValueError("initialize writing run first")
        row = self.db.execute("SELECT payload FROM checkpoints WHERE revision=?", (head,)).fetchone()
        return head, json.loads(row[0])

    def status(self):
        head, state = self.current()
        chapters = list(dict.fromkeys(f["chapter_id"] for f in state["fragments"]))
        return {"revision": head, "phase": state["phase"], "fragments": len(state["fragments"]),
                "chapters": len(chapters), "characters": sum(len(f["text"]) for f in state["fragments"]),
                "active": [dict(r) for r in self.db.execute("SELECT id,status,base_revision FROM steps WHERE status IN ('PENDING','CANDIDATE_SAVED')")],
                "steps": self.db.execute("SELECT count(*) FROM steps").fetchone()[0]}

    def context(self, fragment_ids=(), full=False):
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            head, state = self.current()
            selected = set(fragment_ids) | {f["id"] for f in state["fragments"][-2:]}
            if set(fragment_ids) - {f["id"] for f in state["fragments"]}:
                raise ValueError("unknown context fragment")
            self._set("context_seen", head)
            if full:
                self._set("full_read", head)
            self._event("CONTEXT_READ", {"revision": head, "full": full, "fragment_ids": [f["id"] for f in state["fragments"] if full or f["id"] in selected]})
            return {"revision": head, "phase": state["phase"], "constraints": self._get("seed")["constraints"],
                    "notes": state["notes"], "index": [{k: f[k] for k in ("id", "chapter_id", "chapter_title")} for f in state["fragments"]],
                    "fragments": [f for f in state["fragments"] if full or f["id"] in selected]}

    def _step(self, step_id):
        row = self.db.execute("SELECT * FROM steps WHERE id=?", (step_id,)).fetchone()
        if not row:
            raise ValueError("unknown step")
        return dict(row)

    def begin(self, spec):
        required = ("step_id", "base_revision", "action", "targets", "purpose")
        if any(not spec.get(k) for k in required if k != "targets") or not isinstance(spec.get("targets"), list):
            raise ValueError("step requires id, base, action, targets and purpose")
        if not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", spec["step_id"]):
            raise ValueError("invalid step id")
        action, targets = spec["action"], spec["targets"]
        if len(set(targets)) != len(targets) or any(not isinstance(i, str) or not i for i in targets):
            raise ValueError("invalid target ids")
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            existing = self.db.execute("SELECT * FROM steps WHERE id=?", (spec["step_id"],)).fetchone()
            if existing:
                if json.loads(existing["spec"]) != spec:
                    raise Conflict("step id reused with different inputs")
                return dict(existing)
            head, state = self.current()
            if spec["base_revision"] != head or self._get("context_seen") != head:
                raise Conflict("read current checkpoint before beginning a step")
            if state["phase"] not in ("DRAFTING", "REVISING"):
                raise Conflict("phase does not permit authoring")
            if self.db.execute("SELECT 1 FROM steps WHERE status IN ('PENDING','CANDIDATE_SAVED')").fetchone():
                raise Conflict("finish or reject the active step first")
            ids = {f["id"] for f in state["fragments"]}
            if action == "WRITE":
                if state["phase"] != "DRAFTING" or len(targets) != 1 or targets[0] in ids:
                    raise ValueError("WRITE creates exactly one new fragment during DRAFTING")
                if not spec.get("chapter_id") or not spec.get("chapter_title"):
                    raise ValueError("WRITE requires chapter id and title")
                if any(i.get("status") == "OPEN" and i.get("blocking") for i in state["notes"].get("issues", {}).values()):
                    raise Conflict("resolve blocking issues before continuing")
                chapters = [f["chapter_id"] for f in state["fragments"]]
                if spec["chapter_id"] in chapters and spec["chapter_id"] != chapters[-1]:
                    raise ValueError("cannot append to an earlier chapter; use REVISE")
                if any(f["chapter_id"] == spec["chapter_id"] and f["chapter_title"] != spec["chapter_title"] for f in state["fragments"]):
                    raise ValueError("chapter title mismatch")
            elif action == "REVISE":
                if not targets or set(targets) - ids:
                    raise ValueError("REVISE requires existing target fragments")
            elif action == "REFLECT":
                if targets:
                    raise ValueError("REFLECT cannot alter prose")
            else:
                raise ValueError("unknown authoring action")
            self.db.execute("INSERT INTO steps(id,base_revision,spec,status) VALUES (?,?,?,'PENDING')", (spec["step_id"], head, canonical(spec)))
            self._event("BEGIN", spec)
        return {"step_id": spec["step_id"], "status": "PENDING"}

    def save_candidate(self, step_id, value):
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            step = self._step(step_id)
            if step["candidate"]:
                if json.loads(step["candidate"]) != value:
                    raise Conflict("saved candidates are immutable; reject and start another step")
                return {"step_id": step_id, "candidate_hash": step["candidate_hash"], "status": step["status"]}
            if step["status"] != "PENDING" or step["base_revision"] != self._get("head"):
                raise Conflict("step is not pending on current checkpoint")
            spec = json.loads(step["spec"])
            if spec["action"] == "REFLECT":
                if set(value) != {"reflection"} or not isinstance(value["reflection"], str) or not value["reflection"].strip():
                    raise ValueError("REFLECT requires a nonempty reflection and no prose")
            else:
                if set(value) != {"fragments"} or not isinstance(value["fragments"], list):
                    raise ValueError("candidate contains only scoped fragments")
                if [f.get("id") for f in value["fragments"]] != spec["targets"]:
                    raise ValueError("candidate must match exact ordered scope")
                for f in value["fragments"]:
                    if set(f) != {"id", "text"} or not isinstance(f["text"], str) or not 1 <= len(f["text"].strip()) <= 2200:
                        raise ValueError("each fragment requires 1-2200 characters of prose")
                    if re.search(r"^#{1,6}\s", f["text"], re.M):
                        raise ValueError("chapter headings are metadata, not fragment prose")
            value_hash = checksum(value)
            self.db.execute("UPDATE steps SET candidate=?,candidate_hash=?,status='CANDIDATE_SAVED' WHERE id=?", (canonical(value), value_hash, step_id))
            self._event("CANDIDATE_SAVED", {"step_id": step_id, "hash": value_hash})
        return {"step_id": step_id, "candidate_hash": value_hash, "status": "CANDIDATE_SAVED"}

    def read_candidate(self, step_id):
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            step = self._step(step_id)
            if not step["candidate"]:
                raise ValueError("candidate has not been saved")
            head, state = self.current()
            spec = json.loads(step["spec"])
            self.db.execute("UPDATE steps SET read_hash=? WHERE id=?", (step["candidate_hash"], step_id))
            self._event("CANDIDATE_READ", {"step_id": step_id, "hash": step["candidate_hash"], "current_revision": head})
            return {"spec": spec, "candidate": json.loads(step["candidate"]), "notes": state["notes"],
                    "prior_targets": [f for f in state["fragments"] if f["id"] in spec["targets"]]}

    @staticmethod
    def _merge_notes(notes, updates, fragment_ids):
        if not isinstance(updates, dict):
            raise ValueError("notes updates must be an object")
        for key, value in updates.items():
            if isinstance(value, dict) and isinstance(notes.get(key, {}), dict):
                notes.setdefault(key, {}).update(value)
            else:
                notes[key] = value
        for group in ("facts", "threads", "issues"):
            if not isinstance(notes.get(group, {}), dict):
                raise ValueError("fact, thread and issue indexes must be objects")
            for record in notes.get(group, {}).values():
                if not isinstance(record, dict) or not isinstance(record.get("fragment_ids", []), list) or set(record.get("fragment_ids", [])) - fragment_ids:
                    raise ValueError("note references nonexistent prose")

    def accept(self, step_id, review):
        if not isinstance(review, dict) or not review.get("observations") or not isinstance(review.get("updates"), dict):
            raise ValueError("acceptance requires observations and notes updates")
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            step = self._step(step_id)
            if step["status"] == "ACCEPTED":
                if json.loads(step["review"]) != review:
                    raise Conflict("accepted step has another review")
                return {"revision": step["result_revision"], "status": "ACCEPTED"}
            head, state = self.current()
            if step["status"] != "CANDIDATE_SAVED" or step["base_revision"] != head or step["read_hash"] != step["candidate_hash"]:
                raise Conflict("candidate must be saved and reread on its current base")
            spec, candidate = json.loads(step["spec"]), json.loads(step["candidate"])
            if spec["action"] == "WRITE":
                state["fragments"].append({**candidate["fragments"][0], "chapter_id": spec["chapter_id"], "chapter_title": spec["chapter_title"]})
            elif spec["action"] == "REVISE":
                replacements = {f["id"]: f["text"] for f in candidate["fragments"]}
                if not set(spec["targets"]) <= set(review.get("rechecked_fragment_ids", [])):
                    raise ValueError("revision must account for every changed fragment")
                if not review.get("dependency_review"):
                    raise ValueError("revision requires downstream dependency review")
                for f in state["fragments"]:
                    if f["id"] in replacements:
                        f["text"] = replacements[f["id"]]
            self._merge_notes(state["notes"], review["updates"], {f["id"] for f in state["fragments"]})
            revision = self._checkpoint(state, head, step_id)
            self.db.execute("UPDATE steps SET status='ACCEPTED',review=?,result_revision=? WHERE id=?", (canonical(review), revision, step_id))
        return {"revision": revision, "status": "ACCEPTED"}

    def reject(self, step_id, reason):
        if not reason.strip():
            raise ValueError("rejection needs a reason")
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            step = self._step(step_id)
            if step["status"] == "REJECTED":
                return {"status": "REJECTED"}
            if step["status"] == "ACCEPTED":
                raise Conflict("accepted steps are immutable")
            self.db.execute("UPDATE steps SET status='REJECTED',review=? WHERE id=?", (canonical({"reason": reason}), step_id))
            self._event("REJECTED", {"step_id": step_id, "reason": reason})
        return {"status": "REJECTED"}

    def stage(self, value):
        transitions = {"DRAFTING": "FULL_DRAFT", "FULL_DRAFT": "REVISING", "REVISING": "READY_TO_PUBLISH"}
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            head, state = self.current()
            if value.get("base_revision") != head or value.get("phase") != transitions.get(state["phase"]):
                raise Conflict("invalid phase transition or stale base")
            if not state["fragments"] or not value.get("review") or self.status()["active"]:
                raise ValueError("phase transition needs prose, review and no active step")
            if value["phase"] == "READY_TO_PUBLISH":
                if self._get("full_read") != head:
                    raise Conflict("read full manuscript at current revision before readiness")
                required = {"complete", "causality", "continuity", "language", "clean_copy"}
                if any(value.get("checks", {}).get(k) is not True for k in required):
                    raise ValueError("all final checks must pass")
                if set(value.get("checked_fragment_ids", [])) != {f["id"] for f in state["fragments"]}:
                    raise ValueError("final review must cover all fragments")
                if any(i.get("status") == "OPEN" and i.get("blocking") for i in state["notes"].get("issues", {}).values()):
                    raise Conflict("blocking issues remain")
            state["phase"] = value["phase"]
            state["phase_review"] = value
            self._checkpoint(state, head, "PHASE:" + value["phase"])
        return self.status()

    def bundle(self):
        head, state = self.current()
        if state["phase"] not in ("READY_TO_PUBLISH", "PUBLISHED"):
            raise Conflict("manuscript is not ready for publication")
        seed = self._get("seed")
        document = copy.deepcopy(seed["source"])
        chapters = {}
        for f in state["fragments"]:
            chapters.setdefault(f["chapter_id"], {"title": f["chapter_title"], "texts": []})["texts"].append(f["text"].strip())
        document["blocks"] = [{"id": "novel-" + cid, "text": chapter["title"] + "\n\n" + "\n\n".join(chapter["texts"])} for cid, chapter in chapters.items()]
        book_title = seed.get("book_title", document["title"])
        document.update(version_type="本项目原创·完本小说", text_heading=book_title + " · 小说全文",
                        edition="小说完本稿", notes="基于原故事精修逐片段创作并完成全稿修订的小说。正文为完整干净稿，供审阅。")
        markdown = "# " + book_title + "\n\n" + "\n\n".join("## " + b["text"] for b in document["blocks"]) + "\n"
        return {"writing_revision": head, "expected_source_revision": seed["source_revision"], "document": document, "document_sha256": checksum(document), "markdown": markdown}

    def published(self, formal_db):
        package = self.bundle()
        connection = sqlite3.connect(Path(formal_db).resolve().as_uri() + "?mode=ro", uri=True)
        try:
            row = connection.execute("SELECT revision,document FROM sources WHERE id=?", (package["document"]["id"],)).fetchone()
        finally:
            connection.close()
        if not row or row[0] != package["document_sha256"] or checksum(json.loads(row[1])) != row[0]:
            raise Conflict("formal source does not match frozen publication")
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            head, state = self.current()
            if state["phase"] == "PUBLISHED":
                return self.status()
            if head != package["writing_revision"]:
                raise Conflict("manuscript changed during publication verification")
            state["phase"] = "PUBLISHED"
            state["publication"] = {"ready_revision": head, "source_revision": row[0], "source_id": package["document"]["id"]}
            self._checkpoint(state, head, "PUBLISHED")
        return self.status()


def add_parser(subs):
    parser = subs.add_parser("writing", help="local serial authoring; never invokes a model")
    parser.add_argument("--run", default="default", help="local run name (default: default)")
    commands = parser.add_subparsers(dest="writing_action", required=True)
    for name in ("init", "begin", "stage"):
        commands.add_parser(name).add_argument("file", type=Path)
    context = commands.add_parser("context")
    context.add_argument("--full", action="store_true")
    context.add_argument("--fragments", nargs="*", default=[])
    for name in ("save-candidate", "accept"):
        sub = commands.add_parser(name)
        sub.add_argument("step_id")
        sub.add_argument("file", type=Path)
    commands.add_parser("read-candidate").add_argument("step_id")
    reject = commands.add_parser("reject")
    reject.add_argument("step_id")
    reject.add_argument("reason")
    commands.add_parser("status")
    commands.add_parser("bundle")
    commands.add_parser("published")


def run_cli(root, args):
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", args.run):
        raise ValueError("invalid writing run name")
    folder = root / ".runtime" / "novel-writing" / args.run
    store = WritingStore(folder / "work.sqlite3")
    try:
        action = args.writing_action
        value = json.loads(args.file.read_text()) if hasattr(args, "file") else None
        if action == "init" and "source_id" in value:
            # Pin formal input in one read-only snapshot; do not initialize or
            # write the formal Store merely to start private authoring.
            connection = sqlite3.connect((root / ".runtime" / "review.sqlite3").resolve().as_uri() + "?mode=ro", uri=True)
            connection.row_factory = sqlite3.Row
            try:
                connection.execute("BEGIN")
                row = connection.execute("SELECT document,revision FROM sources WHERE id=?", (value["source_id"],)).fetchone()
                if not row:
                    raise ValueError("unknown formal source")
                value = {**value, "source": json.loads(row["document"]), "source_revision": row["revision"]}
                value["formal_baseline"] = {
                    "sources": {r["id"]: r["revision"] for r in connection.execute("SELECT id,revision FROM sources")},
                    "comments": [dict(r) for r in connection.execute("SELECT * FROM comments ORDER BY id")],
                    "events": [dict(r) for r in connection.execute("SELECT * FROM comment_events ORDER BY id")],
                }
            finally:
                connection.close()
        if action in ("init", "begin", "stage"):
            return getattr(store, action)(value)
        if action == "context":
            return store.context(args.fragments, args.full)
        if action == "save-candidate":
            return store.save_candidate(args.step_id, value)
        if action == "read-candidate":
            return store.read_candidate(args.step_id)
        if action == "accept":
            return store.accept(args.step_id, value)
        if action == "reject":
            return store.reject(args.step_id, args.reason)
        if action == "published":
            return store.published(root / ".runtime" / "review.sqlite3")
        if action == "bundle":
            package = store.bundle()
            (folder / "publication.json").write_text(json.dumps(package["document"], ensure_ascii=False, indent=2) + "\n")
            (folder / "clean.md").write_text(package["markdown"])
            return {k: v for k, v in package.items() if k not in ("document", "markdown")} | {"folder": str(folder)}
        return store.status()
    finally:
        store.close()
