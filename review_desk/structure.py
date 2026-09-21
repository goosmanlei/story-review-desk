"""Versioned story structure on the shared object, revision, dependency and comment ledger."""
import json
import uuid
from pathlib import Path

from .store import Conflict, canonical, digest, now

SELECTION_ID = "story-direction-selection"
STRUCTURE_ID = "story-structure"
REQUIRED_SECTIONS = ("theme", "characters", "relationships", "spaces", "storylines", "timeline")


def object_record(store, object_id):
    row = store.db.execute("SELECT * FROM objects WHERE id=?", (object_id,)).fetchone()
    return dict(row) if row else None


def revision_record(store, revision_id):
    row = store.db.execute("SELECT * FROM revisions WHERE id=?", (revision_id,)).fetchone()
    if not row:
        return None
    result = dict(row)
    result["payload"] = json.loads(result["payload"])
    return result


def object_revisions(store, object_id):
    return [revision_record(store, row[0]) for row in store.db.execute(
        "SELECT id FROM revisions WHERE object_id=? ORDER BY version", (object_id,))]


def select_direction(store, source_id, expected_version):
    source = store.source(source_id)
    if not source or source.get("group") != "expansion-directions":
        raise ValueError("select an expansion direction source")
    source_object = object_record(store, source_id)
    source_revision = source_object["current_revision"]
    payload = {"source_id": source_id, "source_revision": source_revision,
               "source_hash": digest(canonical(source).encode()), "selected_at": now()}
    return store.put_object(SELECTION_ID, "GUIDANCE", payload, expected_version,
                            [{"revision_id": source_revision, "role": "SELECTED_DIRECTION"}])


def _validate_document(store, value):
    if not isinstance(value, dict):
        raise ValueError("structure document must be an object")
    selection_revision = value.get("direction_selection_revision")
    selection = revision_record(store, selection_revision)
    if not selection or selection["object_id"] != SELECTION_ID:
        raise ValueError("unknown direction selection revision")
    title, sections = value.get("title"), value.get("sections")
    if not isinstance(title, str) or not title.strip() or not isinstance(sections, list):
        raise ValueError("structure needs title and sections")
    section_ids = [s.get("id") for s in sections if isinstance(s, dict)]
    if len(section_ids) != len(sections) or tuple(section_ids) != REQUIRED_SECTIONS:
        raise ValueError("sections must be theme, characters, relationships, spaces, storylines, timeline in order")
    block_ids, visual_ids = {"heading-" + section_id for section_id in REQUIRED_SECTIONS}, set()
    for section in sections:
        if not isinstance(section.get("title"), str) or not section["title"].strip():
            raise ValueError("section title required")
        blocks = section.get("blocks")
        if not isinstance(blocks, list) or not blocks:
            raise ValueError("each section needs blocks")
        for block in blocks:
            if not isinstance(block, dict) or not isinstance(block.get("id"), str) or not block["id"] or block["id"] in block_ids or not isinstance(block.get("text"), str) or not block["text"].strip():
                raise ValueError("invalid or duplicate text block")
            block_ids.add(block["id"])
        for visual in section.get("visuals", []):
            if not isinstance(visual, dict) or visual.get("kind") not in ("image", "diagram") or not isinstance(visual.get("id"), str) or not visual["id"] or visual["id"] in visual_ids:
                raise ValueError("invalid or duplicate visual")
            name = visual.get("file")
            if not isinstance(name, str) or not name or name != Path(name).name or name.startswith(".") or Path(name).suffix.lower() not in (".png", ".jpg", ".webp", ".svg"):
                raise ValueError("unsafe visual asset name")
            if not (store.db_path.parent.parent / "export" / "assets" / name).is_file():
                raise ValueError("missing visual asset: " + name)
            if not all(isinstance(visual.get(field), str) and visual[field].strip() for field in ("title", "alt", "description")):
                raise ValueError("visual needs title, alt and description")
            visual_ids.add(visual["id"])
    parent = value.get("parent_revision")
    current = object_record(store, STRUCTURE_ID)
    if (current and parent != current["current_revision"]) or (not current and parent is not None):
        raise Conflict("parent revision must be the current structure revision")
    responses = value.get("responses", [])
    if not isinstance(responses, list):
        raise ValueError("responses must be a list")
    seen = set()
    for response in responses:
        if not isinstance(response, dict) or response.get("comment_id") in seen or not isinstance(response.get("explanation"), str) or not response["explanation"].strip():
            raise ValueError("invalid comment response")
        comment = store.comment(response.get("comment_id"))
        if not comment or comment["target_object_id"] != STRUCTURE_ID or comment["target_revision_id"] != parent:
            raise ValueError("response must reference a comment on the parent revision")
        seen.add(comment["id"])
    return value


def import_structure(store, document, expected_version):
    value = _validate_document(store, document)
    selection_revision = value["direction_selection_revision"]
    current_selection = object_record(store, SELECTION_ID)
    if not current_selection or current_selection["current_revision"] != selection_revision:
        raise Conflict("direction changed; review it and import against the current selection")
    parent = value.get("parent_revision")
    deps = [{"revision_id": selection_revision, "role": "DIRECTION_BASIS"}]
    if parent:
        deps.append({"revision_id": parent, "role": "REVISES"})
    for response in value.get("responses", []):
        comment = store.comment(response["comment_id"])
        deps.append({"revision_id": comment["target_revision_id"], "role": "RESPONDS_TO_COMMENT:" + comment["id"]})
    return store.put_object(STRUCTURE_ID, "STORY", value, expected_version, deps)


def confirm_structure(store, revision_id, reviewer, note=""):
    current = object_record(store, STRUCTURE_ID)
    if not current or current["current_revision"] != revision_id:
        raise Conflict("only the current structure revision can be confirmed")
    revision = revision_record(store, revision_id)
    selection = object_record(store, SELECTION_ID)
    if not selection or selection["current_revision"] != revision["payload"]["direction_selection_revision"]:
        raise Conflict("direction selection changed; re-review before confirming")
    if not isinstance(reviewer, str) or not reviewer.strip():
        raise ValueError("reviewer name required")
    pending = [c for c in store.comments() if c["target_object_id"] == STRUCTURE_ID and c["status"] == "OPEN"]
    record_id = "structure-confirmation-" + str(uuid.uuid4())
    payload = {"structure_revision": revision_id, "direction_selection_revision": selection["current_revision"],
               "reviewer": reviewer.strip(), "note": str(note or "").strip(), "confirmed_at": now(),
               "pending_comment_ids": [c["id"] for c in pending], "pending_comments": pending}
    return store.put_object(record_id, "JUDGMENT", payload, 0,
                            [{"revision_id": revision_id, "role": "CONFIRMS_STRUCTURE"},
                             {"revision_id": selection["current_revision"], "role": "CONFIRMS_DIRECTION_BASIS"}])


def snapshot(store):
    selection = object_record(store, SELECTION_ID)
    selected = revision_record(store, selection["current_revision"]) if selection else None
    structure = object_record(store, STRUCTURE_ID)
    revisions = object_revisions(store, STRUCTURE_ID)
    source = store.source(selected["payload"]["source_id"]) if selected else None
    confirmations = [revision_record(store, row[0]) for row in store.db.execute(
        "SELECT current_revision FROM objects WHERE kind='JUDGMENT' AND id LIKE 'structure-confirmation-%' ORDER BY created_at")]
    active = revisions[-1] if revisions else None
    stale = bool(active and selected and active["payload"]["direction_selection_revision"] != selected["id"])
    return {"selection": selected, "selection_history": object_revisions(store, SELECTION_ID),
            "direction_source": source, "revisions": revisions,
            "current_revision": structure["current_revision"] if structure else None,
            "direction_changed": stale, "confirmations": confirmations}


def script_input(store):
    data = snapshot(store)
    if not data["confirmations"]:
        raise ValueError("no confirmed structure version")
    confirmation = data["confirmations"][-1]
    revision_id = confirmation["payload"]["structure_revision"]
    revision = revision_record(store, revision_id)
    selection = revision_record(store, confirmation["payload"]["direction_selection_revision"])
    source = store.source(selection["payload"]["source_id"])
    pending = confirmation["payload"].get("pending_comments") or [store.comment(cid) for cid in confirmation["payload"]["pending_comment_ids"]]
    frozen = {comment["id"]: comment for comment in pending}
    post_confirmation = [comment for comment in store.comments() if comment["target_object_id"] == STRUCTURE_ID and comment["status"] == "OPEN" and
                         (comment["id"] not in frozen or comment["body"] != frozen[comment["id"]]["body"])]
    return {"confirmation": confirmation, "structure": revision, "direction_selection": selection,
            "direction_source": source, "pending_at_confirmation": pending,
            "post_confirmation_pending": post_confirmation,
            "requires_re_review": data["current_revision"] != revision_id or data["direction_changed"] or bool(post_confirmation)}


def review_context(store):
    data = snapshot(store)
    result = []
    project = store.configuration("PROJECT")["body"]
    for comment in store.comments():
        if comment["target_object_id"] != STRUCTURE_ID:
            continue
        revision = revision_record(store, comment["target_revision_id"])
        selection = revision_record(store, revision["payload"]["direction_selection_revision"])
        source = store.source(selection["payload"]["source_id"])
        result.append({"comment": comment, "structure_revision": revision,
                       "direction_selection": selection, "direction_source": source,
                       "creative_background": project, "anchor_state": store.anchor_state(comment["target_object_id"], comment["target_revision_id"], comment["anchor"])})
    return {"snapshot": data, "reviews": result}
