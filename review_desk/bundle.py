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
    framework = {"objects": store.objects(), "revisions": store.revisions(), "dependencies": store.dependencies()}
    configurations = {"records": [dict(row) for row in store.db.execute("SELECT * FROM configurations ORDER BY scope")],
                      "events": store.configuration_events()}
    asset_names = sorted({_safe_asset(asset["file"]) for source in materials for asset in source["assets"]})
    for name in asset_names:
        if not (target / "assets" / name).is_file():
            raise ValueError("missing asset: " + name)
    material_bytes, comment_bytes = _bytes(materials), _bytes(comments)
    framework_bytes, configuration_bytes = _bytes(framework), _bytes(configurations)
    (target / "materials.json").write_bytes(material_bytes)
    (target / "comments.json").write_bytes(comment_bytes)
    (target / "objects.json").write_bytes(framework_bytes)
    (target / "configurations.json").write_bytes(configuration_bytes)
    hashes = {"materials.json": digest(material_bytes), "comments.json": digest(comment_bytes),
              "objects.json": digest(framework_bytes), "configurations.json": digest(configuration_bytes)}
    for name in asset_names:
        hashes["assets/" + name] = digest((target / "assets" / name).read_bytes())
    manifest = {"schema_version": 3, "sources": len(materials), "comments": len(comments["comments"]),
                "events": len(comments["events"]), "objects": len(framework["objects"]),
                "revisions": len(framework["revisions"]), "configurations": len(configurations["records"]), "files": hashes}
    (target / "manifest.json").write_bytes(_bytes(manifest))
    return manifest


def restore(store, export_dir):
    target = Path(export_dir)
    manifest = json.loads((target / "manifest.json").read_text())
    schema = manifest.get("schema_version")
    if schema not in (1, 2, 3):
        raise ValueError("unsupported export schema")
    for name, expected in manifest["files"].items():
        path = target / name
        if name.startswith("assets/"):
            _safe_asset(name[7:])
        elif name not in (("materials.json", "comments.json") if schema == 1 else ("materials.json", "comments.json", "objects.json", "configurations.json")):
            raise ValueError("unexpected export file")
        if digest(path.read_bytes()) != expected:
            raise ValueError("export checksum mismatch: " + name)
    materials = json.loads((target / "materials.json").read_text())
    comments = json.loads((target / "comments.json").read_text())
    framework = json.loads((target / "objects.json").read_text()) if schema >= 2 else None
    configurations = json.loads((target / "configurations.json").read_text()) if schema >= 2 else None
    if len(materials) != manifest["sources"] or len(comments["comments"]) != manifest["comments"] or len(comments["events"]) != manifest["events"]:
        raise ValueError("export count mismatch")
    if store.sources() or store.comments() or store.objects() or any(c["version"] for c in store.configurations().values()):
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
        comment_ids = {c["id"] for c in comments["comments"]}
        if len(comment_ids) != len(comments["comments"]):
            raise ValueError("duplicate comment id")
        if any(e["comment_id"] not in comment_ids for e in comments["events"]):
            raise ValueError("event with missing comment")
        if schema >= 2:
            from .configuration import migrate
            if len(framework["objects"]) != manifest["objects"] or len(framework["revisions"]) != manifest["revisions"] or len(configurations["records"]) != manifest["configurations"]:
                raise ValueError("framework export count mismatch")
            objects = {o["id"]: o for o in framework["objects"]}
            revisions = {r["id"]: r for r in framework["revisions"]}
            if len(objects) != len(framework["objects"]) or len(revisions) != len(framework["revisions"]):
                raise ValueError("duplicate object or revision")
            for source in materials:
                obj = objects.get(source["id"])
                if not obj or obj["kind"] != "SOURCE":
                    raise ValueError("source object missing")
            for obj in objects.values():
                if obj["current_revision"] not in revisions or revisions[obj["current_revision"]]["object_id"] != obj["id"]:
                    raise ValueError("invalid current revision")
            for revision in revisions.values():
                if revision["object_id"] not in objects:
                    raise ValueError("orphan revision")
                payload = json.loads(revision["payload"])
                if digest(canonical({"object_id": revision["object_id"], "version": revision["version"], "payload": payload}).encode()) != revision["id"]:
                    raise ValueError("revision checksum mismatch")
                if objects[revision["object_id"]]["kind"] == "SOURCE" and payload.get("source_revision") != digest(canonical(test.source(revision["object_id"])).encode()):
                    raise ValueError("source revision mismatch")
            for dependency in framework["dependencies"]:
                if dependency["from_revision"] not in revisions or dependency["to_revision"] not in revisions:
                    raise ValueError("invalid dependency")
            for record in configurations["records"]:
                migrate(record["scope"], record["schema_version"], json.loads(record["body"]))
            if any(event["scope"] not in ("SYSTEM", "PROJECT") for event in configurations["events"]):
                raise ValueError("invalid configuration event")
        else:
            objects = {o["id"]: o for o in test.objects()}
            revisions = {r["id"]: r for r in test.revisions()}
        restored_comments = []
        for comment in comments["comments"]:
            object_id = comment.get("target_object_id") or comment.get("source_id")
            obj = objects.get(object_id)
            if not obj:
                raise ValueError("comment with unknown target object")
            revision_id = comment.get("target_revision_id") or obj["current_revision"]
            revision = revisions.get(revision_id)
            if not revision or revision["object_id"] != object_id:
                raise ValueError("comment with mismatched target revision")
            if obj["kind"] == "SOURCE":
                if comment.get("source_id") != object_id:
                    raise ValueError("source comment target mismatch")
                test.validate_anchor(object_id, comment["anchor"])
            else:
                if comment.get("source_id") is not None:
                    raise ValueError("non-source comment has source_id")
                payload = json.loads(revision["payload"])
                blocks = payload.get("blocks")
                if blocks is None and isinstance(payload.get("body"), str):
                    blocks = [{"id": "body", "text": payload["body"]}]
                Store._validate_blocks(blocks, comment["anchor"])
            if comment["status"] not in ("OPEN", "CLOSED") or type(comment["version"]) is not int or comment["version"] < 1:
                raise ValueError("invalid comment status/version")
            restored_comments.append({**comment, "target_object_id": object_id, "target_revision_id": revision_id})
        with store.db:
            for source in materials:
                store.db.execute("INSERT INTO sources VALUES (?,?,?)", (source["id"], canonical(source), digest(canonical(source).encode())))
            if schema >= 2:
                for obj in framework["objects"]:
                    store.db.execute("INSERT INTO objects VALUES (?,?,?,?,?,?)", (obj["id"], obj["kind"], obj["current_revision"], obj["version"], obj["created_at"], obj["updated_at"]))
                for revision in framework["revisions"]:
                    store.db.execute("INSERT INTO revisions VALUES (?,?,?,?,?)", (revision["id"], revision["object_id"], revision["version"], revision["payload"], revision["created_at"]))
                for dep in framework["dependencies"]:
                    store.db.execute("INSERT INTO dependencies VALUES (?,?,?)", (dep["from_revision"], dep["to_revision"], dep["role"]))
            else:
                from .store import now
                for obj in test.objects():
                    stamp = now()
                    store.db.execute("INSERT INTO objects VALUES (?,?,?,?,?,?)", (obj["id"], obj["kind"], obj["current_revision"], obj["version"], stamp, stamp))
                for revision in test.revisions():
                    store.db.execute("INSERT INTO revisions VALUES (?,?,?,?,?)", (revision["id"], revision["object_id"], revision["version"], revision["payload"], now()))
            for c in restored_comments:
                store.db.execute("INSERT INTO comments VALUES (?,?,?,?,?,?,?,?,?,?)", (c["id"], c.get("source_id"), c["target_object_id"], c["target_revision_id"], canonical(c["anchor"]), c["body"], c["status"], c["version"], c["created_at"], c["updated_at"]))
            for e in comments["events"]:
                store.db.execute("INSERT INTO comment_events VALUES (?,?,?,?,?)", (e["id"], e["comment_id"], e["action"], e["body"], e["at"]))
            if schema >= 2:
                for record in configurations["records"]:
                    store.db.execute("INSERT INTO configurations VALUES (?,?,?,?,?)", (record["scope"], record["schema_version"], record["version"], record["body"], record["updated_at"]))
                for event in configurations["events"]:
                    store.db.execute("INSERT INTO configuration_events VALUES (?,?,?,?,?)", (event["id"], event["scope"], event["version"], event["body"], event["at"]))
    finally:
        test.close()
    return manifest
