import json
import shutil
import tempfile
from contextlib import contextmanager
from pathlib import Path

from .store import Store, canonical, digest
from .production_media import file_hash


def _bytes(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode()


def _safe_asset(name):
    if not name or name != Path(name).name or name.startswith("."):
        raise ValueError("unsafe asset name")
    return name


@contextmanager
def _staged_files(target, files):
    """Stage metadata, then allow publication with rollback on caught failures.

    Keep this context outside a SQLite transaction when publishing restore
    metadata: a database commit failure then restores the previous files too.
    This is not a crash-atomic transaction across the filesystem and SQLite.
    """
    if not files:
        yield lambda: None
        return
    target.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='.bundle-', dir=target))
    changed = []
    keep_recovery = False
    try:
        (stage / 'new').mkdir()
        (stage / 'previous').mkdir()
        for name, data in files.items():
            destination = target / name
            if destination.is_symlink() or (destination.exists() and not destination.is_file()):
                raise ValueError('bundle metadata destination is not a regular file: ' + name)
            (stage / 'new' / name).write_bytes(data)
            if destination.exists():
                shutil.copyfile(destination, stage / 'previous' / name)

        def publish():
            for name in files:
                changed.append(name)
                (stage / 'new' / name).replace(target / name)

        yield publish
    except BaseException:
        failures = []
        for name in reversed(changed):
            try:
                previous = stage / 'previous' / name
                if previous.exists():
                    previous.replace(target / name)
                else:
                    (target / name).unlink(missing_ok=True)
            except OSError as exc:
                failures.append(str(exc))
        if failures:
            keep_recovery = True
            raise RuntimeError('bundle rollback failed; recovery metadata retained at ' + str(stage) + ': ' + '; '.join(failures))
        raise
    finally:
        if not keep_recovery:
            shutil.rmtree(stage, ignore_errors=True)


def export(store, export_dir):
    target = Path(export_dir)
    target.mkdir(parents=True, exist_ok=True)
    store.db.execute('SAVEPOINT export_snapshot')
    try:
        materials = store.sources()
        comments = {"comments": store.comments(), "events": store.events()}
        framework = {"objects": store.objects(), "revisions": store.revisions(), "dependencies": store.dependencies()}
        from .material_versions import dump
        framework.update(dump(store))
        configurations = {"records": [dict(row) for row in store.db.execute("SELECT * FROM configurations ORDER BY scope")],
                          "events": store.configuration_events()}
        icon = store.configuration("SYSTEM")["body"]["site_favicon"]
    finally:
        store.db.execute('RELEASE SAVEPOINT export_snapshot')
    asset_names = {_safe_asset(name) for source in materials for name in
                   [*(asset["file"] for asset in source["assets"]), *([source["media"]["file"]] if (source.get("media") or {}).get("file") else [])]}
    for revision in framework["revisions"]:
        payload = json.loads(revision["payload"])
        if revision["object_id"] == "story-structure":
            asset_names.update(_safe_asset(visual["file"]) for section in payload["sections"] for visual in section.get("visuals", []))
        if str(payload.get("format", "")).startswith("production-"):
            from .production import FORMATS, validate_payload
            if payload["format"] not in FORMATS:
                raise ValueError("unsupported production export format")
            # Alias uniqueness is a head-only constraint, so individual historic
            # entities are not rechecked against current aliases during export.
            from .production_media import validate_component
            for component in payload.get("components", []):
                validate_component(target.parent, component, inspect=False)
                asset_names.add(component["file"])
    from .favicon import asset as favicon_asset
    if icon:
        favicon_asset(target.parent, icon)
        asset_names.add(icon)
    asset_names = sorted(asset_names)
    for name in asset_names:
        if not (target / "assets" / name).is_file():
            raise ValueError("missing asset: " + name)
    material_bytes, comment_bytes = _bytes(materials), _bytes(comments)
    framework_bytes, configuration_bytes = _bytes(framework), _bytes(configurations)
    files = {"materials.json": material_bytes, "comments.json": comment_bytes,
             "objects.json": framework_bytes, "configurations.json": configuration_bytes}
    layout = target.parent / 'config/entity-relationship-layout.json'
    if layout.exists():
        value = json.loads(layout.read_text())
        if not isinstance(value, dict) or value.get('format') != 'entity-relationship-layout-v1':
            raise ValueError('unsupported relationship layout')
        files['entity-relationship-layout.json'] = _bytes(value)
    hashes = {name: digest(data) for name, data in files.items()}
    for name in asset_names:
        hashes["assets/" + name] = file_hash(target / "assets" / name)
    manifest = {"schema_version": 4, "sources": len(materials), "comments": len(comments["comments"]),
                "events": len(comments["events"]), "objects": len(framework["objects"]),
                "revisions": len(framework["revisions"]), "configurations": len(configurations["records"]), "files": hashes}
    # All validation and hashing precede writes. Publish the manifest last;
    # a caught staging/replacement failure leaves the previous bundle intact.
    files['manifest.json'] = _bytes(manifest)
    with _staged_files(target, files) as publish:
        publish()
    return manifest


def restore(store, export_dir):
    target = Path(export_dir)
    manifest = json.loads((target / "manifest.json").read_text())
    schema = manifest.get("schema_version")
    if schema not in (1, 2, 3, 4):
        raise ValueError("unsupported export schema")
    required = {'materials.json', 'comments.json'}
    if schema >= 2:
        required.update(('objects.json', 'configurations.json'))
    if not isinstance(manifest.get('files'), dict) or not required <= manifest['files'].keys():
        raise ValueError('required core file missing from export manifest')
    for name, expected in manifest["files"].items():
        path = target / name
        if name.startswith("assets/"):
            _safe_asset(name[7:])
        elif name not in (("materials.json", "comments.json") if schema == 1 else ("materials.json", "comments.json", "objects.json", "configurations.json", "entity-relationship-layout.json")):
            raise ValueError("unexpected export file")
        if path.is_symlink() or file_hash(path) != expected:
            raise ValueError("export checksum mismatch: " + name)
    materials = json.loads((target / "materials.json").read_text())
    comments = json.loads((target / "comments.json").read_text())
    framework = json.loads((target / "objects.json").read_text()) if schema >= 2 else None
    if schema >= 4:
        from .material_versions import TABLES
        if any(name not in framework for name in TABLES):
            raise ValueError('material round tables missing from schema 4 export')
    configurations = json.loads((target / "configurations.json").read_text()) if schema >= 2 else None
    if len(materials) != manifest["sources"] or len(comments["comments"]) != manifest["comments"] or len(comments["events"]) != manifest["events"]:
        raise ValueError("export count mismatch")
    if store.sources() or store.comments() or store.objects() or any(c["version"] for c in store.configurations().values()):
        raise ValueError("restore requires an empty instance")
    layout_files = {}
    if 'entity-relationship-layout.json' in manifest['files']:
        layout_value = json.loads((target / 'entity-relationship-layout.json').read_text())
        if not isinstance(layout_value, dict) or layout_value.get('format') != 'entity-relationship-layout-v1':
            raise ValueError('unsupported relationship layout')
        layout_files['entity-relationship-layout.json'] = _bytes(layout_value)
    # Validate in a separate in-memory store before any destination write.
    test = Store(":memory:")
    try:
        for source in materials:
            test.put_source(source)
            for asset in source["assets"]:
                _safe_asset(asset["file"])
                if "assets/" + asset["file"] not in manifest["files"]:
                    raise ValueError("unmanifested referenced asset")
            if (source.get("media") or {}).get("file") and "assets/" + _safe_asset(source["media"]["file"]) not in manifest["files"]:
                raise ValueError("unmanifested local media")
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
                if revision["object_id"] == "story-structure":
                    for section in payload["sections"]:
                        for visual in section.get("visuals", []):
                            if "assets/" + _safe_asset(visual["file"]) not in manifest["files"]:
                                raise ValueError("unmanifested structure visual")
                if str(payload.get("format", "")).startswith("production-"):
                    from .production import FORMATS, references
                    from .production_media import validate_component
                    if payload["format"] not in FORMATS or FORMATS[payload["format"]] != objects[revision["object_id"]]["kind"]:
                        raise ValueError("unsupported restored production format/kind")
                    for _, ref in references(payload):
                        if ref["revision_id"] not in revisions or revisions[ref["revision_id"]]["object_id"] != ref["object_id"]:
                            raise ValueError("invalid restored production reference")
                    for component in payload.get("components", []):
                        if "assets/" + component["file"] not in manifest["files"]:
                            raise ValueError("unmanifested production component")
                        validate_component(target.parent, component)
            for dependency in framework["dependencies"]:
                if dependency["from_revision"] not in revisions or dependency["to_revision"] not in revisions:
                    raise ValueError("invalid dependency")
            for record in configurations["records"]:
                body = migrate(record["scope"], record["schema_version"], json.loads(record["body"]))
                if record["scope"] == "SYSTEM" and body["site_favicon"]:
                    from .favicon import asset as favicon_asset
                    name = body["site_favicon"]
                    if "assets/" + name not in manifest["files"]:
                        raise ValueError("unmanifested favicon")
                    favicon_asset(target.parent, name)
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
            else:
                if comment.get("source_id") is not None:
                    raise ValueError("non-source comment has source_id")
            if comment["status"] not in ("OPEN", "CLOSED") or type(comment["version"]) is not int or comment["version"] < 1:
                raise ValueError("invalid comment status/version")
            restored_comments.append({**comment, "target_object_id": object_id, "target_revision_id": revision_id})
        config = store.db_path.parent.parent / 'config'
        with _staged_files(config, layout_files) as publish, store.db:
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
            if schema >= 2:
                from .production import FORMATS, validate_payload, references, current_records
                for revision in framework["revisions"]:
                    payload = json.loads(revision["payload"])
                    if payload.get("format") in FORMATS:
                        validate_payload(store, revision["object_id"], objects[revision["object_id"]]["kind"], payload, inspect=False, check_current=False)
                        expected_deps = {(ref["revision_id"], role) for role, ref in references(payload)}
                        actual_deps = {(d["to_revision"], d["role"]) for d in framework["dependencies"] if d["from_revision"] == revision["id"]}
                        if expected_deps != actual_deps:
                            raise ValueError("restored production dependencies differ from payload")
                for current in current_records(store, {"ENTITY", "RELATION", "REQUIREMENT"}):
                    validate_payload(store, current["object_id"], current["kind"], current["payload"], inspect=False)
            for c in restored_comments:
                store.validate_target(c["target_object_id"], c["target_revision_id"], c["anchor"])
                store.db.execute("INSERT INTO comments VALUES (?,?,?,?,?,?,?,?,?,?)", (c["id"], c.get("source_id"), c["target_object_id"], c["target_revision_id"], canonical(c["anchor"]), c["body"], c["status"], c["version"], c["created_at"], c["updated_at"]))
            for e in comments["events"]:
                store.db.execute("INSERT INTO comment_events VALUES (?,?,?,?,?)", (e["id"], e["comment_id"], e["action"], e["body"], e["at"]))
            if schema >= 4:
                from .material_versions import restore as restore_rounds
                restore_rounds(store, framework)
            if schema >= 2:
                for record in configurations["records"]:
                    store.db.execute("INSERT INTO configurations VALUES (?,?,?,?,?)", (record["scope"], record["schema_version"], record["version"], record["body"], record["updated_at"]))
                for event in configurations["events"]:
                    store.db.execute("INSERT INTO configuration_events VALUES (?,?,?,?,?)", (event["id"], event["scope"], event["version"], event["body"], event["at"]))
            publish()
    except BaseException:
        # A busy COMMIT can leave the transaction open on older sqlite3
        # bindings. Do not leave rows pending for a later unrelated commit.
        store.db.rollback()
        raise
    finally:
        test.close()
    return manifest
