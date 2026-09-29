"""Complete screenplay editions and episodes on the existing revision ledger.

An edition is immutable after publication. A revision creates a new edition ID;
its independent EPISODE objects retain all old comments and exact dependencies.
No structure acceptance or project-stage transition is implied by publication.
"""
import re
from copy import deepcopy

from .store import Conflict, canonical, digest
from .structure import object_record, revision_record

FORMAT = "screenplay-edition-v1"
EPISODE_FORMAT = "screenplay-episode-v1"


def _text(value, field):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(field + " must be nonempty text")
    return value


def _id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,100}", value):
        raise ValueError("invalid screenplay ID")
    return value


def _revision_id(object_id, payload):
    return digest(canonical({"object_id": object_id, "version": 1, "payload": payload}).encode())


def validate_document(store, document):
    if not isinstance(document, dict) or document.get("format") != FORMAT:
        raise ValueError("expected screenplay-edition-v1 document")
    value = deepcopy(document)
    _id(value.get("id")); _text(value.get("title"), "title")
    _text(value.get("notes"), "notes")
    if value.get("review_status") != "pending" or value.get("duration_kind") != "estimate":
        raise ValueError("new screenplay must be pending review with estimated durations")
    basis = value.get("basis")
    if not isinstance(basis, dict):
        raise ValueError("exact story and structure basis required")
    for key, kind in (("story", "SOURCE"), ("structure", "STORY")):
        ref = basis.get(key)
        if not isinstance(ref, dict):
            raise ValueError("missing " + key + " basis")
        _id(ref.get("object_id")); _text(ref.get("revision_id"), key + " revision ID")
        obj = object_record(store, ref["object_id"]); revision = revision_record(store, ref["revision_id"])
        if not obj or obj["kind"] != kind or not revision or revision["object_id"] != obj["id"]:
            raise ValueError("unknown or mismatched " + key + " basis")
        if key == "structure" and obj["id"] != "story-structure":
            raise ValueError("basis must reference story-structure")
    episodes = value.get("episodes")
    if not isinstance(episodes, list) or not episodes:
        raise ValueError("complete episode list required")
    seen = set()
    for number, episode in enumerate(episodes, 1):
        if not isinstance(episode, dict) or episode.get("number") != number or type(episode.get("number")) is not int:
            raise ValueError("episodes must be numbered consecutively from one")
        _id(episode.get("id")); _text(episode.get("title"), "episode title")
        if episode["id"] in seen or not episode["id"].startswith(value["id"] + "-"):
            raise ValueError("episode IDs must be unique and scoped to the edition")
        seen.add(episode["id"])
        blocks, scenes = episode.get("blocks"), episode.get("scenes")
        if not isinstance(blocks, list) or not blocks or not isinstance(scenes, list) or not scenes:
            raise ValueError("each episode needs blocks and scenes")
        block_ids = []
        for block in blocks:
            if not isinstance(block, dict):
                raise ValueError("invalid text block")
            block_ids.append(_id(block.get("id"))); _text(block.get("text"), "block text")
        if len(set(block_ids)) != len(block_ids):
            raise ValueError("duplicate block ID")
        covered, scene_ids, total = [], set(), 0
        for scene in scenes:
            if not isinstance(scene, dict):
                raise ValueError("invalid scene")
            sid = _id(scene.get("id"))
            if sid in scene_ids:
                raise ValueError("duplicate scene ID")
            scene_ids.add(sid)
            for field in ("heading", "location", "time"):
                _text(scene.get(field), field)
            seconds = scene.get("estimated_seconds")
            if type(seconds) is not int or seconds <= 0:
                raise ValueError("positive scene duration required")
            ids = scene.get("block_ids")
            if not isinstance(ids, list) or not ids or any(not isinstance(i, str) for i in ids):
                raise ValueError("scene block IDs required")
            covered.extend(ids); total += seconds
        if covered != block_ids:
            raise ValueError("scenes must cover every text block once in reading order")
        if type(episode.get("estimated_seconds")) is not int or episode["estimated_seconds"] != total:
            raise ValueError("episode duration must equal scene durations")
    return value


def import_screenplay(store, document):
    value = validate_document(store, document)
    basis_deps = [{"revision_id": value["basis"][key]["revision_id"], "role": role}
                  for key, role in (("story", "STORY_BASIS"), ("structure", "STRUCTURE_BASIS"))]
    records, refs = [], []
    for episode in value["episodes"]:
        payload = {**episode, "format": EPISODE_FORMAT, "screenplay_id": value["id"],
                   "basis": value["basis"], "duration_kind": "estimate", "review_status": "pending"}
        refs.append({"object_id": episode["id"], "revision_id": _revision_id(episode["id"], payload),
                     "number": episode["number"], "title": episode["title"]})
        records.append({"object_id": episode["id"], "kind": "EPISODE", "payload": payload,
                        "dependencies": basis_deps})
    payload = {**value, "episodes": refs}
    records.append({"object_id": value["id"], "kind": "STORY", "payload": payload,
                    "dependencies": basis_deps + [{"revision_id": ref["revision_id"], "role": "EPISODE"} for ref in refs]})
    current = object_record(store, value["id"])
    expected_revision = _revision_id(value["id"], payload)
    if current:
        if current["kind"] != "STORY" or current["current_revision"] != expected_revision:
            raise Conflict("published screenplay is immutable; use a new edition ID")
        return {"id": value["id"], "revision": expected_revision, "episodes": refs, "unchanged": True}
    result = store.put_objects(records)
    return {**result[-1], "episodes": refs, "unchanged": False}


def snapshot(store):
    versions = []
    for obj in store.objects():
        if obj["kind"] != "STORY" or obj["id"] == "story-structure":
            continue
        revision = revision_record(store, obj["current_revision"])
        payload = revision["payload"]
        if payload.get("format") != FORMAT:
            continue
        episodes = [revision_record(store, ref["revision_id"]) for ref in payload["episodes"]]
        versions.append({**revision, "episodes": episodes})
    versions.sort(key=lambda v: (v["created_at"], v["object_id"]))
    return {"versions": versions}


def review_context(store):
    versions = snapshot(store)["versions"]
    ids = {e["object_id"] for v in versions for e in v["episodes"]}
    return {"snapshot": {"versions": versions},
            "comments": [c for c in store.context() if c["target_object_id"] in ids]}
