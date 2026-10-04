"""Archived schema-4 writer for historical-reader/migration fixtures only.

Current HTTP/CLI never invokes this writer. New plan semantics are exercised
without these patches in test_material_plans and the HTTP retry tests.
"""
from unittest.mock import patch
from review_desk.store import Store, now, canonical, Conflict
from review_desk import material_versions as legacy

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
        self.db.execute('BEGIN IMMEDIATE')
        existing = self.comment(comment_id)
        if existing:
            if existing['target_object_id'] == object_id and existing['target_revision_id'] == revision_id and existing['anchor'] == anchor and existing['body'] == body:
                return existing
            raise Conflict('comment id already used')
        self.db.execute("INSERT INTO comments VALUES (?,?,?,?,?,?,?,?,?,?)", (comment_id, source_id, object_id, revision_id, canonical(anchor), body, "OPEN", 1, stamp, stamp))
        self.db.execute("INSERT INTO comment_events(comment_id,action,body,at) VALUES (?,?,?,?)", (comment_id, "CREATE", body, stamp))
        from review_desk.material_versions import feedback, comment_scope
        comment_scope(self, self.comment(comment_id), value.get('material_context'), value.get('material_revision'))
        feedback(self, self.comment(comment_id), value.get('material_revision'))
    return self.comment(comment_id)

def install(test):
    for target,replacement in [('review_desk.material_plans.register',legacy.register),
        ('review_desk.material_plans.snapshot',legacy.snapshot),
        ('review_desk.material_plans.for_record',legacy.for_record),
        ('review_desk.store.Store.create_comment',create_comment)]:
        guard=patch(target,replacement);guard.start();test.addCleanup(guard.stop)
