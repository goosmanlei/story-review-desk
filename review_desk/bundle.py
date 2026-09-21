import json
from pathlib import Path

from .store import Store, canonical, digest


def _bytes(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode()


def _safe_asset(name):
    if not name or name != Path(name).name or name.startswith("."):
        raise ValueError("unsafe asset name")
    return name


def export(store, export_dir):
    target = Path(export_dir)
    target.mkdir(parents=True, exist_ok=True)
    materials = store.sources()
    comments = {"comments": store.comments(), "events": store.events()}
    asset_names = sorted({_safe_asset(asset["file"]) for source in materials for asset in source["assets"]})
    for name in asset_names:
        if not (target / "assets" / name).is_file():
            raise ValueError("missing asset: " + name)
    material_bytes, comment_bytes = _bytes(materials), _bytes(comments)
    (target / "materials.json").write_bytes(material_bytes)
    (target / "comments.json").write_bytes(comment_bytes)
    hashes = {"materials.json": digest(material_bytes), "comments.json": digest(comment_bytes)}
    for name in asset_names:
        hashes["assets/" + name] = digest((target / "assets" / name).read_bytes())
    manifest = {"schema_version": 1, "sources": len(materials), "comments": len(comments["comments"]),
                "events": len(comments["events"]), "files": hashes}
    (target / "manifest.json").write_bytes(_bytes(manifest))
    return manifest


def restore(store, export_dir):
    target = Path(export_dir)
    manifest = json.loads((target / "manifest.json").read_text())
    if manifest.get("schema_version") != 1:
        raise ValueError("unsupported export schema")
    for name, expected in manifest["files"].items():
        path = target / name
        if name.startswith("assets/"):
            _safe_asset(name[7:])
        elif name not in ("materials.json", "comments.json"):
            raise ValueError("unexpected export file")
        if digest(path.read_bytes()) != expected:
            raise ValueError("export checksum mismatch: " + name)
    materials = json.loads((target / "materials.json").read_text())
    comments = json.loads((target / "comments.json").read_text())
    if len(materials) != manifest["sources"] or len(comments["comments"]) != manifest["comments"] or len(comments["events"]) != manifest["events"]:
        raise ValueError("export count mismatch")
    if store.sources() or store.comments():
        raise ValueError("restore requires an empty instance")
    # Validate in a separate in-memory store before any destination write.
    test = Store(":memory:")
    try:
        for source in materials:
            test.put_source(source)
            for asset in source["assets"]:
                _safe_asset(asset["file"])
                if "assets/" + asset["file"] not in manifest["files"]:
                    raise ValueError("unmanifested referenced asset")
        for comment in comments["comments"]:
            test.validate_anchor(comment["source_id"], comment["anchor"])
            if comment["status"] not in ("OPEN", "CLOSED") or comment["version"] < 1:
                raise ValueError("invalid comment status/version")
        comment_ids = {c["id"] for c in comments["comments"]}
        if len(comment_ids) != len(comments["comments"]):
            raise ValueError("duplicate comment id")
        if any(e["comment_id"] not in comment_ids for e in comments["events"]):
            raise ValueError("event with missing comment")
        with store.db:
            for source in materials:
                store.db.execute("INSERT INTO sources VALUES (?,?,?)", (source["id"], canonical(source), digest(canonical(source).encode())))
            for c in comments["comments"]:
                store.db.execute("INSERT INTO comments VALUES (?,?,?,?,?,?,?,?)", (c["id"], c["source_id"], canonical(c["anchor"]), c["body"], c["status"], c["version"], c["created_at"], c["updated_at"]))
            for e in comments["events"]:
                store.db.execute("INSERT INTO comment_events VALUES (?,?,?,?,?)", (e["id"], e["comment_id"], e["action"], e["body"], e["at"]))
    finally:
        test.close()
    return manifest
