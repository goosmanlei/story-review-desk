"""Shared production operations for HTTP, CLI and the three workspaces.

This module stores reviewed production data. It never calls a model, extracts a
particular story or decides whether the user's creative work is accepted.
"""
import copy
import json
import math
from pathlib import Path
import re
import shutil

from .store import Conflict, canonical
from .production_media import validate_component
from . import production_states as full_states


KINDS = {"INPUT_LOCK": "input-lock", "ENTITY": "entity", "STATE": "state",
         "REPRESENTATION": "representation", "PREPARATION": "preparation",
         "SHOT_DESIGN": "shot-design", "REQUIREMENT": "requirement", "ASSET": "asset",
         "CALL": "call", "JUDGMENT": "judgment", "RELATION": "relation",
         "ASSEMBLY": "assembly", "DELIVERABLE": "deliverable"}
FORMATS = {"production-" + v + "-v1": k for k, v in KINDS.items()}
ID = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$")
USAGES = ("generation_input", "post_audio", "editorial")
CHANGE_KINDS = {"ENTITY", "STATE", "REPRESENTATION", "INPUT_LOCK", "EPISODE", "STORY",
                "PREPARATION", "SHOT_DESIGN", "REQUIREMENT", "RELATION"}


def root_of(store):
    return store.db_path.parent.parent


def record_view(row):
    value = {**dict(row), "payload": json.loads(row["payload"])}
    if value['payload'].get('generation'):
        # Use the exact server projection for numeric JSON (1.0 / exponents),
        # whose browser serialization can otherwise change comment offsets.
        value['review_parameter_text'] = json.dumps(value['payload']['generation'].get('parameters', {}), ensure_ascii=False, sort_keys=True, indent=2)
    if value["kind"] == "CALL":
        value["review_call_parameter_text"] = json.dumps({k:v for k,v in value['payload'].get('parameters', {}).items() if not (k=='prompt' and v==value['payload'].get('prompt'))}, ensure_ascii=False, sort_keys=True, indent=2)
    return value


def record(store, object_id=None, revision_id=None):
    if revision_id:
        row = store.db.execute("""SELECT r.*,o.kind,o.current_revision FROM revisions r
            JOIN objects o ON o.id=r.object_id WHERE r.id=?""", (revision_id,)).fetchone()
        if row and object_id and row["object_id"] != object_id:
            raise ValueError("revision belongs to another object")
    else:
        row = store.db.execute("""SELECT r.*,o.kind,o.current_revision FROM objects o
            JOIN revisions r ON r.id=o.current_revision WHERE o.id=?""", (object_id,)).fetchone()
    if not row:
        raise KeyError("unknown production object or revision")
    value = record_view(row)
    memberships = store.db.execute('SELECT material_id,number FROM material_members WHERE revision_id=? ORDER BY number DESC,material_id', (value['id'],)).fetchall()
    value['material_round_numbers'] = {v['material_id']: v['number'] for v in reversed(memberships)}
    return value


def ref_record(store, ref, kinds=None):
    if not isinstance(ref, dict) or not isinstance(ref.get("object_id"), str) or not isinstance(ref.get("revision_id"), str):
        raise ValueError("an exact object/revision reference is required")
    value = record(store, ref["object_id"], ref["revision_id"])
    if kinds and value["kind"] not in kinds:
        raise ValueError("incorrect reference kind: " + value["kind"])
    return value


def references(value, path="payload"):
    if isinstance(value, dict):
        if "object_id" in value and "revision_id" in value:
            yield path, value
        for key, child in value.items():
            yield from references(child, path + "." + key)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from references(child, path + "." + str(index))


def source_check(store, ref):
    source = ref_record(store, ref)
    payload = source["payload"]
    if source["kind"] == "SOURCE":
        payload = store.source(source["object_id"])
    blocks = payload.get("blocks", [])
    if payload.get("sections"):
        blocks = [b for section in payload["sections"] for b in section.get("blocks", [])]
    block_map = {b["id"]: b["text"] for b in blocks}
    scene = None
    if "scene_id" in ref:
        scene = next((s for s in payload.get("scenes", []) if s["id"] == ref["scene_id"]), None)
        if scene is None:
            raise ValueError("source scene is absent from exact revision")
    if "block_ids" in ref:
        ids = ref["block_ids"]
        if not isinstance(ids, list) or not ids or len(ids) != len(set(ids)) or any(b not in block_map for b in ids):
            raise ValueError("source blocks are absent or duplicated")
        if scene and not set(ids) <= set(scene["block_ids"]):
            raise ValueError("source blocks belong to a different scene")
        if "quote" in ref and (not ref["quote"] or ref["quote"] not in "\n".join(block_map[b] for b in ids)):
            raise ValueError("source quote differs from exact blocks")
    elif "quote" in ref:
        raise ValueError("a source quote requires block_ids")
    return source


def source_excerpt(store, ref):
    """Read the exact cited text without following the object's current head."""
    source = source_check(store, ref)
    payload = source['payload']
    if source['kind'] == 'SOURCE':
        row = store.db.execute('SELECT revision,document FROM sources WHERE id=?', (source['object_id'],)).fetchone()
        if not row or row['revision'] != payload.get('source_revision'):
            raise ValueError('historical source text is unavailable; refusing current-text substitution')
        payload = json.loads(row['document'])
    blocks = payload.get('blocks', [])
    if payload.get('sections'):
        blocks = [b for section in payload['sections'] for b in section.get('blocks', [])]
    scene = next((s for s in payload.get('scenes', []) if s['id'] == ref.get('scene_id')), None)
    ids = ref.get('block_ids') or (scene or {}).get('block_ids')
    if ids:
        blocks = [b for b in blocks if b['id'] in ids]
    return {'reference': ref, 'kind': source['kind'], 'title': payload.get('title', source['object_id']),
            'scene': scene, 'blocks': blocks, 'is_current': source['id'] == source['current_revision']}


def _text(value, label):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(label + " must be nonempty text")


def _number(value, label, positive=False):
    if type(value) not in (int, float) or not math.isfinite(value) or value < 0 or positive and value == 0:
        raise ValueError("invalid " + label)


def _list(payload, key):
    if not isinstance(payload.get(key), list):
        raise ValueError(key + " must be a list")
    return payload[key]


def _refs(store, payload, key, kinds):
    return [ref_record(store, r, kinds) for r in _list(payload, key)]


def _components(store, payload, inspect=True):
    values = _list(payload, "components")
    if not values or any(not isinstance(c, dict) for c in values):
        raise ValueError("components must be nonempty component objects")
    if len({c.get("id") for c in values}) != len(values) or not any(c.get("role") == "original" for c in values):
        raise ValueError("components need distinct ids and an original")
    for component in values:
        validate_component(root_of(store), component, inspect=inspect)


def component_for(store, ref, component_id):
    asset = ref_record(store, ref, {"ASSET"})
    component = next((c for c in asset["payload"]["components"] if c["id"] == component_id), None)
    if component is None:
        raise ValueError("component is absent from exact asset revision")
    return asset, component


def validate_selection(component, selection):
    if selection.get("range") is not None:
        interval = selection["range"]
        if not isinstance(interval, dict):
            raise ValueError("invalid media time range")
        start, end = interval.get("start_seconds"), interval.get("end_seconds")
        _number(start, "range start")
        _number(end, "range end", True)
        if not start < end <= component.get("duration_seconds", 0):
            raise ValueError("media time range exceeds component duration")
    if selection.get("crop") is not None:
        crop = selection["crop"]
        if not isinstance(crop, dict) or not component["mime"].startswith(("image/", "video/")):
            raise ValueError("crop requires visual media")
        for key in ("x", "y", "width", "height"):
            _number(crop.get(key), "crop " + key, key in ("width", "height"))
        if crop["x"] + crop["width"] > 1 or crop["y"] + crop["height"] > 1:
            raise ValueError("crop exceeds normalized image bounds")


def _lineage(store, payload):
    lineage = payload.get("lineage", {})
    if not isinstance(lineage, dict):
        raise ValueError("invalid image lineage")
    if "i2i_depth" not in lineage:
        return
    depth = lineage["i2i_depth"]
    if type(depth) is not int or not 0 <= depth <= 2:
        raise ValueError("I2I depth must be between zero and two")
    parents = lineage.get("references", [])
    if not isinstance(parents, list):
        raise ValueError("invalid lineage references")
    parent_depths = []
    for parent in parents:
        asset = ref_record(store, parent, {"ASSET"})
        d = asset["payload"].get("lineage", {}).get("i2i_depth")
        if type(d) is not int:
            raise ValueError("image ancestry is unknown; return to a traceable master")
        parent_depths.append(d)
    if depth != (max(parent_depths) + 1 if parent_depths else 0):
        raise ValueError("I2I depth differs from deepest generation input")
    if payload.get("format") == "production-call-v1":
        actual_images = set()
        for _, ref in references(payload.get("inputs", [])):
            value = ref_record(store, ref)
            if value["kind"] == "ASSET" and value["payload"].get("media_type") == "image":
                actual_images.add((value["object_id"], value["id"]))
        declared_images = {(r["object_id"], r["revision_id"]) for r in parents}
        if len(declared_images) != len(parents) or actual_images != declared_images:
            raise ValueError("image lineage must include every actual image input exactly once")


def validate_payload(store, object_id, kind, payload, inspect=True, check_current=True):
    if kind not in KINDS or not isinstance(payload, dict) or payload.get("format") != "production-" + KINDS[kind] + "-v1":
        raise ValueError("unsupported production format/kind")
    _text(payload.get("title"), "title")
    blocks = _list(payload, "blocks")
    if not blocks or any(not isinstance(b, dict) or not b.get("id") or not isinstance(b.get("text"), str) or not b["text"].strip() for b in blocks):
        raise ValueError("reviewable text blocks are required")
    if len({b["id"] for b in blocks}) != len(blocks):
        raise ValueError("duplicate reviewable block id")
    for _, ref in references(payload):
        source_check(store, ref)
    p = payload
    if kind == "INPUT_LOCK":
        ref_record(store, p.get("screenplay"), {"STORY"})
        episodes = _refs(store, p, "episodes", {"EPISODE"})
        if not episodes or len({e["object_id"] for e in episodes}) != len(episodes):
            raise ValueError("input lock needs distinct episodes")
        for key in ("actor", "statement", "scope"):
            _text(p.get("approval", {}).get(key), "approval." + key)
        if not isinstance(p.get("specification"), dict):
            raise ValueError("production specification required")
    elif kind == "ENTITY":
        if p.get("entity_type") not in ("character", "space", "prop", "song"):
            raise ValueError("invalid entity type")
        for key in ("aliases", "facts", "choices", "unknowns", "sources"):
            _list(p, key)
        names = [p["title"], *p["aliases"]]
        if any(not isinstance(n, str) or not n.strip() for n in names) or len(set(names)) != len(names):
            raise ValueError("invalid or duplicate entity aliases")
        for other in current_records(store, {"ENTITY"}) if check_current else []:
            op = other["payload"]
            if other["object_id"] != object_id and op["entity_type"] == p["entity_type"] and set(names) & {op["title"], *op["aliases"]}:
                raise Conflict("entity identity/alias already assigned: " + other["object_id"])
    elif kind == "STATE":
        ref_record(store, p.get("entity"), {"ENTITY"})
        if not isinstance(p.get("dimensions"), dict) or not p["dimensions"]:
            raise ValueError("state dimensions are required")
        for key in ("sources", "facts", "choices", "unknowns"):
            _list(p, key)
        full_states.validate_state(store, p)
        for previous in p.get("previous_states", []):
            parent = ref_record(store, previous, {"STATE"})
            if parent["payload"]["entity"]["object_id"] != p["entity"]["object_id"]:
                raise ValueError("state transition crosses identities")
    elif kind == "REPRESENTATION":
        _refs(store, p, "entities", {"ENTITY"})
        _refs(store, p, "states", {"STATE"})
        for key in ("sources", "choices", "unknowns"):
            _list(p, key)
        if 'review_model' in p:
            from . import entity_review
            if p['review_model'] != entity_review.MODEL:
                raise ValueError('unsupported entity review model')
            entity_review.validate(store, object_id, p, check_current)
    elif kind == "PREPARATION":
        episode = ref_record(store, p.get("source"), {"EPISODE"})
        scene = next((s for s in episode["payload"].get("scenes", []) if s["id"] == p["source"].get("scene_id")), None)
        if not scene or set(p["source"].get("block_ids", [])) != set(scene["block_ids"]) or p.get("checked") is not True:
            raise ValueError("scene preparation must cover the complete scene")
        seen = set()
        for occurrence in _list(p, "occurrences"):
            entity = ref_record(store, occurrence.get("entity"), {"ENTITY"})
            if entity["object_id"] in seen or occurrence.get("mode") not in ("visual", "voice", "visual_voice", "mention"):
                raise ValueError("invalid or repeated scene occurrence")
            seen.add(entity["object_id"])
            for state in _refs(store, occurrence, "states", {"STATE"}):
                if state["payload"]["entity"]["object_id"] != entity["object_id"]:
                    raise ValueError("occurrence state belongs to another entity")
            evidence = _list(occurrence, "evidence")
            if not evidence or any(r.get("revision_id") != episode["id"] or r.get("scene_id") != scene["id"] or not r.get("block_ids") for r in evidence):
                raise ValueError("occurrence evidence must locate this scene")
        full_states.validate_usage(store, kind, p)
    elif kind == "SHOT_DESIGN":
        ref_record(store, p.get("episode"), {"EPISODE"})
        if p.get("source", {}).get("revision_id") != p["episode"]["revision_id"] or p.get("scene_id") != p["source"].get("scene_id"):
            raise ValueError("shot episode/scene/source differ")
        for key in ("purpose", "framing", "spatial", "action_start", "action_end", "continuity"):
            _text(p.get(key), key)
        for key in ("number", "duration_frames", "fps"):
            if type(p.get(key)) is not int or p[key] <= 0:
                raise ValueError("positive integer required: " + key)
        _list(p, "sound")
        _refs(store, p, "entities", {"ENTITY"})
        _refs(store, p, "states", {"STATE"})
        full_states.validate_usage(store, kind, p)
    elif kind == "REQUIREMENT":
        ref_record(store, p.get("scope"))
        for key in ("slot", "purpose", "media_type"):
            _text(p.get(key), key)
        if type(p.get("required")) is not bool or p.get("usage") not in USAGES:
            raise ValueError("invalid requirement required/usage")
        if p.get('status') == 'withdrawn':
            if p['required']:
                raise ValueError('withdrawn requirement cannot remain required')
            _text(p.get('withdrawal_reason'), 'withdrawal reason')
        if p["media_type"] not in ("image", "audio", "video", "project", "document"):
            raise ValueError("invalid required media type")
        _refs(store, p, "entities", {"ENTITY"})
        _refs(store, p, "states", {"STATE"})
        if not isinstance(p.get('specification'), dict):
            raise ValueError('requirement specification must be an object')
        for key, value in p['specification'].items():
            if key.startswith('minimum_'):
                _number(value, key)
        if 'native_4k' in p['specification'] and type(p['specification']['native_4k']) is not bool:
            raise ValueError('native_4k specification must be boolean')
        full_states.validate_reference_requirement(store, p)
        from .generation import validate_plan
        validate_plan(store, object_id, p)
        if check_current and store.db.execute("""SELECT 1 FROM objects o JOIN revisions r ON r.id=o.current_revision
                WHERE o.kind='REQUIREMENT' AND o.id!=? AND json_extract(r.payload,'$.format')='production-requirement-v1'
                AND json_extract(r.payload,'$.scope.object_id')=? AND json_extract(r.payload,'$.slot')=?""",
                (object_id, p['scope']['object_id'], p['slot'])).fetchone():
            raise Conflict('scope/slot already has a requirement; revise that object explicitly')
    elif kind in ("ASSET", "DELIVERABLE"):
        _components(store, p, inspect)
        if kind == "ASSET":
            if p.get("media_type") not in ("image", "audio", "video", "project", "document"):
                raise ValueError("invalid asset media type")
            expected = {"image": "image/", "audio": "audio/", "video": "video/",
                        "project": "application/", "document": ("application/", "text/")}[p["media_type"]]
            if any(not c["mime"].startswith(expected) for c in p["components"] if c["role"] == "original"):
                raise ValueError("original component does not match the asset media type")
            _refs(store, p, "subjects", {"ENTITY", "REPRESENTATION", "SHOT_DESIGN", "INPUT_LOCK"})
            _refs(store, p, "states", {"STATE"})
            full_states.validate_asset_coverage(store, p)
            for candidate in p.get('candidate_requirements', []):
                need = ref_record(store, candidate, {'REQUIREMENT'})
                if need['payload']['media_type'] != p['media_type'] or not any(c['state'] == need['payload']['scope'] for c in p.get('state_coverage', [])):
                    raise ValueError('candidate requirement needs exact state and media coverage')
            call = ref_record(store, p.get("production"), {"CALL"})
            if call["payload"].get("status") not in ("submitted", "completed"):
                raise ValueError("an asset needs a real production record")
            _lineage(store, p)
            if p.get("media_type") == "image" and "i2i_depth" not in p.get("lineage", {}):
                raise ValueError("an image asset requires a traceable image lineage")
            if p.get("media_type") == "image" and call["payload"].get("lineage") != p.get("lineage"):
                raise ValueError("asset lineage differs from actual production input")
        else:
            ref_record(store, p.get("assembly"), {"ASSEMBLY"})
            _list(p, "dependencies")
            if not isinstance(p.get("verification"), dict):
                raise ValueError("deliverable verification record required")
    elif kind == "CALL":
        if p.get("status") not in ("planned", "submitted", "completed", "failed", "unknown"):
            raise ValueError("invalid production call status")
        for key in ("method", "tool"):
            _text(p.get(key), key)
        for key in ("inputs", "outputs"):
            _list(p, key)
        if p["status"] == "completed" and not p["outputs"]:
            raise ValueError("completed production requires actual output references")
        for output in _refs(store, p, 'outputs', {'ASSET'}):
            if output['payload']['production']['object_id'] != object_id:
                raise ValueError('output asset belongs to another production call')
        for input_ref in p['inputs']:
            value = ref_record(store, input_ref)
            if input_ref.get('component_id'):
                component_for(store, input_ref, input_ref['component_id'])
        _lineage(store, p)
        if check_current:
            from .generation import validate_call
            validate_call(store, object_id, p)
    elif kind == "JUDGMENT":
        target = ref_record(store, p.get("target"))
        from . import entity_review
        if p.get('acceptance_model') == 'entity-generation-v1':
            from .generation import validate_decision
            validate_decision(store, object_id, p, check_current)
        elif 'acceptance_model' in p:
            entity_review.validate_current_acceptance(store, p, check_current)
        if p.get('verdict') == 'accepted' and entity_review.submission(target):
            entity_review.validate_acceptance(store, target, check_current)
        if p.get("verdict") not in ("pending", "passed", "changes_requested", "rejected", "accepted", "impact_resolved", "revoked"):
            raise ValueError("invalid review verdict")
        if p.get("verdict") == "revoked" and p.get("acceptance_model") != "entity-generation-v1":
            raise ValueError("revocation requires a generation acceptance")
        for key in ("actor", "reason"):
            _text(p.get(key), key)
        if p.get("change"):
            change = p["change"]
            old, new = ref_record(store, change.get("old")), ref_record(store, change.get("new"))
            if old["object_id"] != new["object_id"] or old["id"] == new["id"] or change.get("action") not in ("needs_review", "keep", "rework", "replace"):
                raise ValueError("invalid upstream change decision")
            if change.get("scope") not in (None, "target", "state_title_only"):
                raise ValueError("invalid change decision scope")
            if change.get("scope") == "state_title_only":
                before = {k: v for k, v in old["payload"].items() if k != "title"}
                after = {k: v for k, v in new["payload"].items() if k != "title"}
                if (old["kind"] != "STATE" or new["version"] <= old["version"] or
                        before != after or old["payload"]["title"] == new["payload"]["title"] or
                        p["target"]["revision_id"] != new["id"] or
                        change["action"] != "keep" or p["verdict"] != "impact_resolved"):
                    raise ValueError("state title review requires only a title change and the exact new state target")
    elif kind == "RELATION" and p.get("relation_type") == "entity":
        from .entity_relations import validate
        validate(store, p)
    elif kind == "RELATION":
        if p.get("relation_type") != "adoption" or p.get("usage") not in USAGES:
            raise ValueError("only explicit production adoption is supported")
        ref_record(store, p.get("scope"))
        _text(p.get("slot"), "slot")
        _text(p.get("reason"), "reason")
        _, component = component_for(store, p.get("asset"), p.get("component_id"))
        validate_selection(component, p)
        for other in current_records(store, {"RELATION"}) if check_current else []:
            op = other["payload"]
            if op.get("relation_type") == "adoption" and other["object_id"] != object_id and op["scope"]["object_id"] == p["scope"]["object_id"] and op["slot"] == p["slot"]:
                raise Conflict("scope/slot already has an adoption; revise that object explicitly")
    elif kind == "ASSEMBLY":
        for key in ("fps", "width", "height", "duration_frames"):
            if type(p.get(key)) is not int or p[key] <= 0:
                raise ValueError("positive integer required: " + key)
        visual_intervals = []
        for item in _list(p, "items"):
            _text(item.get("track"), "track")
            for key in ("start_frame", "duration_frames"):
                if type(item.get(key)) is not int or item[key] < (1 if key == "duration_frames" else 0):
                    raise ValueError("invalid timeline frames")
            if item["start_frame"] + item["duration_frames"] > p["duration_frames"]:
                raise ValueError("timeline item exceeds assembly")
            _, component = component_for(store, item.get("asset"), item.get("component_id"))
            shot = ref_record(store, item.get("shot"), {"SHOT_DESIGN"})
            if shot["payload"]["fps"] != p["fps"]:
                raise ValueError("shot and assembly frame rates differ")
            if component["mime"].startswith(("image/", "video/")):
                visual_intervals.append((item["start_frame"], item["start_frame"] + item["duration_frames"]))
            if "duration_seconds" in component:
                validate_selection(component, {"range": {"start_seconds": item.get("in_seconds"), "end_seconds": item.get("out_seconds")}})
                if abs(item["out_seconds"] - item["in_seconds"] - item["duration_frames"] / p["fps"]) > 1 / p["fps"]:
                    raise ValueError("timeline clip duration differs from selected media")
        covered = 0
        for start, end in sorted(visual_intervals):
            if start > covered:
                raise ValueError("assembly visual coverage has a gap")
            covered = max(covered, end)
        if covered != p["duration_frames"]:
            raise ValueError("assembly needs visual coverage through its final frame")


def current_records(store, kinds=None):
    result = []
    for row in store.db.execute("SELECT r.*,o.kind,o.current_revision FROM objects o JOIN revisions r ON r.id=o.current_revision ORDER BY o.id"):
        if row["kind"] in KINDS and (not kinds or row["kind"] in kinds):
            p = json.loads(row["payload"])
            if p.get("format") in FORMATS:
                value=record_view(row)
                if value['kind']=='ASSET':
                    member=store.db.execute('SELECT MAX(r.number) FROM material_rounds r WHERE r.material_id IN (SELECT material_id FROM material_members WHERE revision_id=?)',(value['id'],)).fetchone()
                    value['material_version']=member[0]
                result.append(value)
    return result


def import_records(store, document, validate_only=False):
    return _import_records(store, document, validate_only)


def restore_records(store, batches):
    """Replay exact historical records into an empty production collection only.

    Ordinary HTTP/CLI imports always validate current membership. Recovery
    validates historical references, like bundle.restore, without mistaking
    later state or asset revisions for the inputs of an earlier acceptance.
    """
    if current_records(store):
        raise Conflict('production recovery requires an empty production collection')
    for batch in batches:
        _import_records(store, batch, check_current=False)


def _import_records(store, document, validate_only=False, *, check_current=True):
    if not isinstance(document, dict) or document.get("format") != "production-import-v1" or not isinstance(document.get("records"), list) or not (document["records"] or document.get("remove_unreferenced_requirements")):
        raise ValueError("nonempty production-import-v1 records are required")
    results, resolved = [], {}
    store.db.execute("BEGIN IMMEDIATE")
    try:
        guards = document.get('expected_heads', {})
        if not isinstance(guards, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k,v in guards.items()):
            raise ValueError('expected_heads must map object ids to exact revision ids')
        for object_id, revision_id in guards.items():
            current = store.db.execute('SELECT current_revision FROM objects WHERE id=?', (object_id,)).fetchone()
            if not current or current['current_revision'] != revision_id:
                raise Conflict('production planning input changed: ' + object_id)
        removed = remove_unreferenced_requirements(store, document.get("remove_unreferenced_requirements", []))
        for source in document["records"]:
            if not isinstance(source, dict) or not ID.fullmatch(str(source.get("object_id", ""))):
                raise ValueError("invalid production object id")
            object_id, kind = source["object_id"], source.get("kind")
            if object_id in resolved:
                raise ValueError("an object may occur only once per batch")
            p = copy.deepcopy(source.get("payload"))
            for _, ref in references(p):
                if isinstance(ref["revision_id"], str) and ref["revision_id"].startswith("@"):
                    alias = ref["revision_id"][1:]
                    if alias != ref["object_id"] or alias not in resolved:
                        raise ValueError("batch reference must target an earlier object")
                    ref["revision_id"] = resolved[alias]
            validate_payload(store, object_id, kind, p, check_current=check_current)
            dependencies = [{"revision_id": ref["revision_id"], "role": path} for path, ref in references(p)]
            result = store._put_object(object_id, kind, p, source.get("expected_version"), dependencies)
            results.append(result)
            resolved[object_id] = result["revision"]
            if check_current:
                from .material_versions import register
                register(store, record(store, revision_id=result['revision']))
        if validate_only:
            store.db.rollback()
        else:
            store.db.commit()
    except BaseException:
        store.db.rollback()
        raise
    return {"validated_only": validate_only, "records": results, "removed": removed}


def remove_unreferenced_requirements(store, removals):
    """Explicit import-only deletion. Refuse comments and all retained history uses."""
    if not isinstance(removals, list):
        raise ValueError('removals must be a list of exact requirement references')
    ids = set()
    for ref in removals:
        row = ref_record(store, ref, {'REQUIREMENT'})
        if row['id'] != row['current_revision'] or row['object_id'] in ids:
            raise Conflict('requirement removal head changed or duplicated')
        ids.add(row['object_id'])
    if not ids:
        return []
    revisions = {r['id']: r['object_id'] for r in store.db.execute('SELECT id,object_id FROM revisions')}
    for row in store.db.execute('SELECT target_object_id FROM comments'):
        if row[0] in ids:
            raise Conflict('cannot remove a requirement with comments')
    for row in store.db.execute('SELECT from_revision,to_revision FROM dependencies'):
        if revisions[row[1]] in ids and revisions[row[0]] not in ids:
            raise Conflict('cannot remove a requirement referenced by retained history')
    for oid in sorted(ids):
        store.db.execute('DELETE FROM dependencies WHERE from_revision IN (SELECT id FROM revisions WHERE object_id=?)', (oid,))
    for oid in sorted(ids):
        if store.db.execute('SELECT 1 FROM material_feedback WHERE material_id=?', (oid,)).fetchone():
            raise Conflict('cannot remove a material with revision feedback')
        store.db.execute('DELETE FROM material_members WHERE material_id=?', (oid,))
        store.db.execute('DELETE FROM material_rounds WHERE material_id=?', (oid,))
        store.db.execute('DELETE FROM revisions WHERE object_id=?', (oid,))
        store.db.execute('DELETE FROM objects WHERE id=?', (oid,))
    return sorted(ids)


def adopt(store, value):
    return import_records(store, {"format": "production-import-v1", "records": [{**value, "kind": "RELATION"}]})


def judge(store, value):
    return import_records(store, {"format": "production-import-v1", "records": [{**value, "kind": "JUDGMENT"}]})


def snapshot(store, kind=None, object_id=None, revision_id=None):
    if kind and kind not in KINDS:
        raise ValueError("unknown production kind")
    if object_id or revision_id:
        selected = record(store, object_id, revision_id)
        if selected["payload"].get("format") not in FORMATS:
            raise ValueError("not a production object")
        history = [record(store, revision_id=r[0]) for r in store.db.execute("SELECT id FROM revisions WHERE object_id=? ORDER BY version DESC", (selected["object_id"],))]
        uses = [dict(r) for r in store.db.execute("""SELECT d.role,r.id AS revision_id,r.object_id,o.kind,
            r.id=o.current_revision AS is_current FROM dependencies d JOIN revisions r ON r.id=d.from_revision
            JOIN objects o ON o.id=r.object_id WHERE d.to_revision=? ORDER BY r.object_id,r.version""", (selected["id"],))]
        if selected['kind']=='REQUIREMENT':
            selected['review_input_records'] = [ref_record(store, v['reference']) for v in selected['payload'].get('generation', {}).get('inputs', [])]
        elif selected['kind']=='CALL':
            selected['review_input_records'] = [ref_record(store, v.get('reference', v)) for v in selected['payload'].get('inputs', [])]
        result = {"record": selected, "history": history, "uses": uses}
        if selected["kind"] == "ASSET":
            from .material_review import context
            result["review_context"] = context(store, selected)
            result["review_contexts"] = {r["id"]: context(store, r) for r in history}
        from .material_versions import for_record
        result['material_versions'] = for_record(store, selected) if selected['kind'] in ('REQUIREMENT', 'ASSET') else {}
        return result
    return {"records": current_records(store, {kind} if kind else None)}


def dependency_closure(store, revision_id, include_history=True):
    found, todo = {}, [revision_id]
    while todo:
        current = todo.pop()
        if current in found:
            continue
        found[current] = record(store, revision_id=current)
        todo.extend(r['to_revision'] for r in store.db.execute("SELECT to_revision,role FROM dependencies WHERE from_revision=?", (current,))
                    if include_history or r['role'] != 'REVISES')
    return found


def impact(store, revision_id):
    source = record(store, revision_id=revision_id)
    visited, todo, affected = set(), [revision_id], []
    while todo:
        current = todo.pop()
        if current in visited:
            continue
        visited.add(current)
        for row in store.db.execute("""SELECT r.*,o.kind,o.current_revision,d.role FROM dependencies d
                JOIN revisions r ON r.id=d.from_revision JOIN objects o ON o.id=r.object_id
                WHERE d.to_revision=? AND d.role!='REVISES'""", (current,)):
            todo.append(row["id"])
            if row["id"] == row["current_revision"]:
                affected.append({"object_id": row["object_id"], "revision_id": row["id"], "kind": row["kind"],
                                 "title": json.loads(row["payload"]).get("title", row["object_id"]), "role": row["role"]})
    judgments = [r for r in current_records(store, {"JUDGMENT"})
                 if r["payload"].get("change", {}).get("old", {}).get("revision_id") == revision_id]
    return {"source": source, "changed": source["id"] != source["current_revision"],
            "affected": list({(r["revision_id"], r["role"]): r for r in affected}.values()), "decisions": judgments}


def stale_inputs(store, target_revision, judgments=None):
    values = dependency_closure(store, target_revision, include_history=False)
    judgments = judgments if judgments is not None else current_records(store, {"JUDGMENT"})
    stale = []
    for value in values.values():
        if value["kind"] not in CHANGE_KINDS or value["id"] == value["current_revision"]:
            continue
        kept = any((j["payload"]["target"]["revision_id"] == target_revision or
                    j["payload"].get("change", {}).get("scope") == "state_title_only") and
                   j["payload"].get("change", {}).get("old", {}).get("revision_id") == value["id"] and
                   j["payload"].get("change", {}).get("new", {}).get("revision_id") == value["current_revision"] and
                   j["payload"].get("change", {}).get("action") == "keep" for j in judgments)
        if not kept:
            stale.append({"object_id": value["object_id"], "used_revision": value["id"],
                          "current_revision": value["current_revision"], "action": "needs_review"})
    return stale


def asset_coverage(store, asset):
    """Only explicit depicted subjects/states count, not all provenance ancestors."""
    entities = set()
    states = list(asset['payload']['states'])
    for ref in asset['payload']['subjects']:
        subject = ref_record(store, ref)
        if subject['kind'] == 'ENTITY':
            entities.add(subject['object_id'])
        elif subject['kind'] in ('REPRESENTATION', 'SHOT_DESIGN'):
            entities.update(r['object_id'] for r in subject['payload']['entities'])
            states.extend(subject['payload']['states'])
    for ref in states:
        entities.add(ref_record(store, ref, {'STATE'})['payload']['entity']['object_id'])
    return entities, {r['object_id'] for r in states}


def readiness(store, scope):
    subject = record(store, scope)
    heads = current_records(store)
    scope_ids = {scope}
    # Aggregate only the locked episode revisions, never newer script heads.
    episode_refs = subject['payload'].get('episodes', []) if subject['kind'] == 'INPUT_LOCK' else []
    if subject['kind'] == 'EPISODE':
        episode_refs = [{'object_id': scope, 'revision_id': subject['id']}]
    episode_keys = {(r['object_id'], r['revision_id']) for r in episode_refs}
    scene = subject["payload"].get("source", {}).get("scene_id") if subject["kind"] == "PREPARATION" else None
    for item in heads:
        if item['kind'] not in ('PREPARATION', 'SHOT_DESIGN'):
            continue
        ep = item['payload'].get('episode') or item['payload']['source']
        in_episode = (ep['object_id'], ep['revision_id']) in episode_keys
        in_scene = item['kind'] == 'SHOT_DESIGN' and scene and item['payload']['scene_id'] == scene and ep['revision_id'] == subject['payload']['source']['revision_id']
        if in_episode or in_scene:
            scope_ids.add(item['object_id'])
    coverage = full_states.scope_coverage(store, [r for r in heads if r['object_id'] in scope_ids], heads)
    state_keys = {full_states.exact(r) for r in coverage['states']}
    requirements = [r for r in heads if r["kind"] == "REQUIREMENT" and r['payload'].get('status') != 'withdrawn' and
                    (r["payload"]["scope"]["object_id"] in scope_ids or full_states.exact(r['payload']['scope']) in state_keys)]
    uses = {(r["payload"]["scope"]["object_id"], r["payload"]["slot"]): r for r in heads if r["kind"] == "RELATION" and r["payload"].get("relation_type") == "adoption"}
    judgments = [r for r in heads if r["kind"] == "JUDGMENT"]
    rows = []
    for requirement in requirements:
        p = requirement["payload"]
        adoption = uses.get((p["scope"]["object_id"], p["slot"]))
        issues = []
        pending_changes = []
        asset = None
        if not adoption:
            issues.append("missing_adoption")
        else:
            ap = adoption["payload"]
            try:
                asset, component = component_for(store, ap["asset"], ap["component_id"])
                validate_component(root_of(store), component, inspect=False)
                validate_selection(component, ap)
                if ap["scope"] != p["scope"]:
                    issues.append("scope_revision_changed")
                if ap["usage"] != p["usage"] or asset["payload"]["media_type"] != p["media_type"]:
                    issues.append("incompatible_media_or_usage")
                if asset["payload"].get("placeholder"):
                    issues.append("placeholder_is_not_ready")
                entities, states = asset_coverage(store, asset)
                if not {r['object_id'] for r in p['entities']} <= entities:
                    issues.append('missing_entity_reference')
                if not {r['object_id'] for r in p['states']} <= states:
                    issues.append('missing_state_reference')
                for state_ref in p['states']:
                    if full_states.complete(ref_record(store, state_ref, {'STATE'})) and not full_states.covers(
                            asset, component, ap, state_ref, p.get('specification', {}).get('reference_role')):
                        issues.append('missing_exact_state_coverage')
                        break
                spec = p.get("specification", {})
                for key in ("width", "height", "sample_rate", "channels"):
                    if spec.get("minimum_" + key, 0) > component.get(key, 0):
                        issues.append("below_minimum_" + key)
                if spec.get("minimum_long_edge", 0) > max(component.get("width", 0), component.get("height", 0)):
                    issues.append("below_minimum_long_edge")
                if spec.get("native_4k") and (component.get("role") != "original" or
                        asset["payload"].get("verification", {}).get("native_4k_passed") is not True):
                    issues.append("native_4k_not_verified")
                adoption_changes = stale_inputs(store, adoption["id"], judgments)
                if adoption_changes:
                    issues.append("upstream_needs_review")
                    pending_changes.extend({'target': {'object_id': adoption['object_id'], 'revision_id': adoption['id']}, **change} for change in adoption_changes)
            except (ValueError, KeyError, OSError) as exc:
                issues.append(str(exc))
        requirement_changes = stale_inputs(store, requirement["id"], judgments)
        if requirement_changes:
            issues.append("requirement_needs_review")
            pending_changes.extend({'target': {'object_id': requirement['object_id'], 'revision_id': requirement['id']}, **change} for change in requirement_changes)
        reviews = [r for r in judgments if asset and r["payload"]["target"]["revision_id"] == asset["id"]]
        rows.append({"requirement": requirement, "adoption": adoption, "asset": asset, "issues": issues, "reviews": reviews, 'pending_changes': pending_changes})
    return {"scope": subject, "requirements": rows, "state_coverage": coverage,
            "required_count": sum(r["requirement"]["payload"]["required"] for r in rows),
            "missing_count": sum(r["requirement"]["payload"]["required"] and bool(r["issues"]) for r in rows),
            "inputs_ready": not coverage['issues'] and any(r["requirement"]["payload"]["required"] for r in rows) and
                            all(not r["issues"] for r in rows if r["requirement"]["payload"]["required"]),
            "creative_acceptance": [r for r in judgments if r["payload"]["target"]["revision_id"] == subject["id"] and r["payload"]["verdict"] == "accepted"]}


def package_manifest(store, scope):
    ready = readiness(store, scope)
    if not ready["inputs_ready"]:
        raise Conflict("required production inputs are incomplete or need review")
    revisions = dependency_closure(store, ready["scope"]["id"])
    for row in ready["requirements"]:
        for key in ("requirement", "adoption"):
            if row[key]:
                revisions.update(dependency_closure(store, row[key]["id"]))
    files = {}
    for value in revisions.values():
        if value["payload"].get("format") in FORMATS:
            for component in value["payload"].get("components", []):
                validate_component(root_of(store), component, inspect=False)
                files[component["file"]] = component
    return {"format": "production-package-v1", "scope": {"object_id": scope, "revision_id": ready["scope"]["id"]},
            "readiness": ready, "revisions": list(revisions.values()), "files": files,
            "note": "All paths below assets/ are relative to this package. Generation inputs and post_audio remain separate in each requirement."}


def write_package(store, scope, output):
    manifest = package_manifest(store, scope)
    target = Path(output)
    if target.exists() and (not target.is_dir() or any(target.iterdir())):
        raise ValueError("package output must be an empty directory")
    target.mkdir(parents=True, exist_ok=True)
    (target / "assets").mkdir(exist_ok=True)
    for component in manifest["files"].values():
        path = validate_component(root_of(store), component, inspect=False)
        shutil.copyfile(path, target / "assets" / component["file"])
    (target / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    return {"output": str(target), "scope": manifest["scope"], "files": len(manifest["files"])}
