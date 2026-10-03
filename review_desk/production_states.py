"""Complete entity snapshots and explicit asset coverage; no story-specific logic."""

MODEL = "complete-v1"
DIMENSIONS = {
    "character": ("appearance", "clothing", "injury", "health", "fatigue", "voice", "attachments"),
    "space": ("layout", "dressing", "time_light"),
    "prop": ("structure", "condition", "contents", "placement"),
    "song": ("lyrics_scope", "rendition", "performers"),
}


def exact(ref):
    return ref["object_id"], ref["revision_id"]


def complete(record):
    return record["kind"] == "STATE" and record["payload"].get("state_model") == MODEL


def validate_state(store, p):
    from .production import ref_record, _text
    if "state_model" not in p:  # Historical imports remain readable and restorable.
        return
    if p["state_model"] != MODEL:
        raise ValueError("unsupported state model")
    entity = ref_record(store, p["entity"], {"ENTITY"})
    for name in DIMENSIONS[entity["payload"]["entity_type"]]:
        _text(p["dimensions"].get(name), "complete state dimension: " + name)
    if p.get("reference_media") not in ("image", "audio", "none"):
        raise ValueError("complete state requires reference_media")
    if p.get("reference_mode", "material") not in ("material", "description"):
        raise ValueError("unsupported state reference mode")
    if p.get("reference_mode") == "description":
        _text(p.get("production_description"), "description-only state needs production description")
        if p["reference_media"] == "none":
            raise ValueError("description mode describes presentation, not a mention")
    if not p["sources"]:
        raise ValueError("complete state requires exact source evidence")


def usage_issues(store, entities, states, transitions, source, allow_none=False):
    """Check each identity's ordered full forms and in-scene transition evidence."""
    from .production import ref_record, source_check
    issues, grouped = [], {e["object_id"]: [] for e in entities}
    for ref in states:
        state = ref_record(store, ref, {"STATE"})
        owner = state["payload"]["entity"]["object_id"]
        if owner not in grouped:
            issues.append({"code": "state_owner_mismatch", "entity": owner, "state": ref})
            continue
        if grouped[owner] and exact(ref) == exact(grouped[owner][-1]):
            issues.append({"code": "redundant_consecutive_state", "entity": owner, "state": ref})
        grouped[owner].append(ref)
        if not complete(state):
            issues.append({"code": "legacy_partial_state", "entity": owner, "state": ref})
        elif state["payload"].get("reference_media") == "none" and not allow_none:
            issues.append({"code": "mention_state_used_for_presentation", "entity": owner, "state": ref})
    expected = []
    for owner, values in grouped.items():
        if not values:
            issues.append({"code": "missing_complete_state", "entity": owner})
        expected.extend((exact(a), exact(b)) for a, b in zip(values, values[1:]))
    actual = []
    for transition in transitions:
        if not isinstance(transition, dict) or not isinstance(transition.get("action"), str) or not transition["action"].strip():
            issues.append({"code": "invalid_state_transition"})
            continue
        try:
            a, b = transition["from"], transition["to"]
            before, after = ref_record(store, a, {"STATE"}), ref_record(store, b, {"STATE"})
            if before["payload"]["entity"]["object_id"] != after["payload"]["entity"]["object_id"]:
                raise ValueError("transition crosses entities")
            evidence = transition["source"]
            source_check(store, evidence)
            if (exact(evidence) != exact(source) or evidence.get("scene_id") != source.get("scene_id") or
                    not evidence.get("block_ids") or not set(evidence["block_ids"]) <= set(source.get("block_ids", []))):
                raise ValueError("transition is outside its exact scene/shot source")
            actual.append((exact(a), exact(b)))
        except (KeyError, ValueError, TypeError):
            issues.append({"code": "invalid_state_transition"})
    # Interleaving different entities is allowed; each identity's sequence is exact.
    # Compare each owner's order while permitting interleaved changes of others.
    owners = {exact(ref): owner for owner, values in grouped.items() for ref in values}
    if any([pair for pair in expected if owners.get(pair[0]) == owner] !=
           [pair for pair in actual if owners.get(pair[0]) == owner] for owner in grouped) or len(expected) != len(actual):
        issues.append({"code": "missing_or_unmatched_state_transition"})
    return issues


def validate_usage(store, kind, p):
    if "state_model" not in p:
        return
    if p["state_model"] != MODEL:
        raise ValueError("unsupported state model")
    if kind == "PREPARATION":
        groups = [([o["entity"]], o["states"], o.get("transitions", []), o["mode"] == "mention") for o in p["occurrences"]]
    else:
        groups = [(p["entities"], p["states"], p.get("state_transitions", []), False)]
    for entities, states, transitions, mention in groups:
        if not isinstance(transitions, list):
            raise ValueError("state transitions must be a list")
        issues = usage_issues(store, entities, states, transitions, p["source"], mention)
        if issues:
            raise ValueError("complete state coverage: " + ", ".join(i["code"] for i in issues))


def validate_asset_coverage(store, p):
    from .production import ref_record, validate_selection, _text
    if "state_coverage" not in p:
        return
    if not isinstance(p["state_coverage"], list):
        raise ValueError("state_coverage must be a list")
    seen = set()
    for coverage in p["state_coverage"]:
        if not isinstance(coverage, dict):
            raise ValueError("invalid state coverage")
        state = ref_record(store, coverage.get("state"), {"STATE"})
        if not complete(state) or exact(coverage["state"]) not in {exact(r) for r in p["states"]}:
            raise ValueError("asset coverage requires a declared exact complete state")
        if coverage.get("role") not in ("overall", "detail"):
            raise ValueError("invalid state reference role")
        _text(coverage.get("detail"), "state reference detail")
        component = next((c for c in p["components"] if c["id"] == coverage.get("component_id")), None)
        if component is None:
            raise ValueError("state reference component is absent")
        validate_selection(component, coverage)
        if coverage["role"] == "overall" and not component["mime"].startswith(state["payload"]["reference_media"] + "/"):
            raise ValueError("overall reference differs from state reference media")
        key = (exact(coverage["state"]), coverage["role"], coverage["component_id"], coverage["detail"])
        if key in seen:
            raise ValueError("duplicate state coverage")
        seen.add(key)


def validate_reference_requirement(store, p):
    from .production import ref_record
    role = p["specification"].get("reference_role")
    scope = ref_record(store, p["scope"])
    if role is None and not complete(scope):
        return
    if role not in ("overall", "detail") or not complete(scope):
        raise ValueError("state reference requirements need a complete state scope and role")
    if (p["states"] != [p["scope"]] or len(p["entities"]) != 1 or
            p["entities"][0]["object_id"] != scope["payload"]["entity"]["object_id"]):
        raise ValueError("state reference requirement must bind its exact state and owner")
    if role == "overall" and (p["slot"] != "overall" or (p["required"] is not True and p.get('status') != 'withdrawn') or
            p["media_type"] != scope["payload"]["reference_media"]):
        raise ValueError("overall state reference must be the required overall slot with matching media")
    if role == "detail" and p["slot"] == "overall":
        raise ValueError("detail cannot replace the overall slot")


def selection_bounds(component, selection, key):
    if key == "range":
        value = selection.get(key) or {"start_seconds": 0, "end_seconds": component.get("duration_seconds", 0)}
        return value["start_seconds"], value["end_seconds"]
    value = selection.get(key) or {"x": 0, "y": 0, "width": 1, "height": 1}
    return value["x"], value["y"], value["x"] + value["width"], value["y"] + value["height"]


def covers(asset, component, adoption, state, role=None):
    for coverage in asset["payload"].get("state_coverage", []):
        if (exact(coverage["state"]) != exact(state) or coverage["component_id"] != component["id"] or
                role and coverage["role"] != role):
            continue
        valid = True
        for key in ("range", "crop"):
            selected, declared = selection_bounds(component, adoption, key), selection_bounds(component, coverage, key)
            if role == "overall":
                valid &= selected == declared
            elif key == "range":
                valid &= declared[0] <= selected[0] < selected[1] <= declared[1] or selected == declared
            else:
                valid &= declared[0] <= selected[0] < selected[2] <= declared[2] and declared[1] <= selected[1] < selected[3] <= declared[3]
        if valid:
            return True
    return False


def scope_coverage(store, subjects, heads):
    """Return exact forms and errors; callers add their required reference slots."""
    from .production import ref_record
    used, issues, checked = {}, [], 0
    for subject in subjects:
        p = subject["payload"]
        if p.get('status') == 'withdrawn':
            continue
        if subject["kind"] == "STATE":
            groups = []
            if complete(subject) and p["reference_media"] != "none" and p.get("reference_mode") != "description":
                used[(subject["object_id"], subject["id"])] = {"object_id": subject["object_id"], "revision_id": subject["id"]}
        elif subject["kind"] == "PREPARATION":
            groups = [([o["entity"]], o["states"], o.get("transitions", [])) for o in p["occurrences"] if o["mode"] != "mention"]
        elif subject["kind"] == "SHOT_DESIGN":
            groups = [(p["entities"], p["states"], p.get("state_transitions", []))]
        else:
            groups = []
        for entities, states, transitions in groups:
            checked += len(entities)
            for issue in usage_issues(store, entities, states, transitions, p["source"]):
                issues.append({"scope": {"object_id": subject["object_id"], "revision_id": subject["id"]}, **issue})
            for ref in states:
                state = ref_record(store, ref, {"STATE"})
                if complete(state) and state["payload"]["reference_media"] != "none" and state["payload"].get("reference_mode") != "description":
                    used[exact(ref)] = ref
    for key, ref in used.items():
        matches = [r for r in heads if r["kind"] == "REQUIREMENT" and r['payload'].get('status') != 'withdrawn' and exact(r["payload"]["scope"]) == key and
                   r["payload"]["slot"] == "overall" and r["payload"]["required"] is True and
                   r["payload"]["specification"].get("reference_role") == "overall"]
        if not matches:
            issues.append({"code": "missing_overall_reference_requirement", "state": ref})
    return {"checked_count": checked, "states": list(used.values()), "issues": issues}
