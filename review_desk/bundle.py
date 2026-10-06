import json
import shutil
import tempfile
from contextlib import contextmanager
from pathlib import Path

from .store import Store, canonical, digest
from .production_media import file_hash, physical_file_hash


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
            if Path(name).is_absolute() or '..' in Path(name).parts:raise ValueError('unsafe staged metadata path')
            destination = target / name
            if destination.is_symlink() or (destination.exists() and not destination.is_file()):
                raise ValueError('bundle metadata destination is not a regular file: ' + name)
            (stage / 'new' / name).parent.mkdir(parents=True,exist_ok=True)
            (stage / 'previous' / name).parent.mkdir(parents=True,exist_ok=True)
            (stage / 'new' / name).write_bytes(data)
            if destination.exists():
                shutil.copyfile(destination, stage / 'previous' / name)

        def publish():
            for name in files:
                (target/name).parent.mkdir(parents=True,exist_ok=True)
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
    archive_files={}
    store.db.execute('SAVEPOINT export_snapshot')
    try:
        from .business_codes import allocate_comments
        allocate_comments(store)
        materials = store.sources()
        comments = {"comments": store.comments(), "events": store.events()}
        framework = {"objects": store.objects(), "revisions": store.revisions(), "dependencies": store.dependencies()}
        from . import business_codes
        from .relation_explanations import dump as dump_redactions
        from .state_cleanup import dump as dump_state_cleanup
        framework.update(dump_state_cleanup(store))
        framework["relation_redacted_comments"] = [dict(row) for row in store.db.execute("SELECT * FROM relation_redacted_comments ORDER BY comment_id")]
        framework["relation_explanation_redactions"] = dump_redactions(store)
        framework["relation_explanation_latest_only"] = bool(store.db.execute("SELECT latest_only FROM relation_explanation_policy WHERE id=1 AND latest_only=1").fetchone())
        framework["business_comments"] = [dict(row) for row in store.db.execute("SELECT * FROM business_comments ORDER BY number")]
        framework["business_codes"] = business_codes.dump(store)
        framework["business_candidates"] = [dict(row) for row in store.db.execute("SELECT * FROM business_candidates ORDER BY material_id,version,number")]
        from .material_versions import dump
        framework.update(dump(store))
        from .material_plans import dump as dump_plans
        framework.update(dump_plans(store))
        from . import material_storage, material_archives
        complete_model=not store.db.execute('SELECT 1 FROM material_plan_versions p LEFT JOIN material_definition_versions d ON d.material_id=p.material_id AND d.number=p.number WHERE d.definition_id IS NULL LIMIT 1').fetchone()
        # New registered metadata uses the same lossless physical representation
        # at publication. Real image/audio/video originals are never rewritten.
        for revision in framework['revisions'] if complete_model else []:
            for component in json.loads(revision['payload']).get('components',[]):
                if component.get('role')!='metadata' or component.get('mime')!='application/json':continue
                name=component['file'];path=target/'assets'/name
                if path.is_file() and not material_archives.reference(path) and name not in archive_files:
                    raw=path.read_bytes()
                    if digest(raw)!=component['sha256'] or len(raw)!=component['bytes']:raise ValueError('metadata original differs before compaction')
                    container=material_archives.encode(store,raw)
                    archive_files[name]=_bytes(container)
                    store.db.execute('INSERT INTO material_archive_files VALUES (?,?) ON CONFLICT(path) DO UPDATE SET container=excluded.container',('export/assets/'+name,canonical(container)))
        material_data=material_storage.dump(store)
        physical_revisions=material_storage.physical_revisions(store)
        if complete_model:framework.update({k:v for k,v in material_data.items() if k!="material_content"})
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
    if complete_model:framework["revisions"]=physical_revisions
    framework_bytes, configuration_bytes = _bytes(framework), _bytes(configurations)
    files = {"materials.json": material_bytes, "comments.json": comment_bytes,
             "objects.json": framework_bytes, "configurations.json": configuration_bytes}
    if complete_model:files["material-content.json"]=_bytes({"format":"material-content-v1","material_content":material_data["material_content"]})
    layout = target.parent / 'config/entity-relationship-layout.json'
    if layout.exists():
        value = json.loads(layout.read_text())
        if not isinstance(value, dict) or value.get('format') != 'entity-relationship-layout-v1':
            raise ValueError('unsupported relationship layout')
        files['entity-relationship-layout.json'] = _bytes(value)
    hashes = {name: digest(data) for name, data in files.items()}
    for name in asset_names:
        hashes["assets/" + name] = digest(archive_files[name]) if name in archive_files else physical_file_hash(target / "assets" / name)
    manifest = {"schema_version": 7 if complete_model else 5, "sources": len(materials), "comments": len(comments["comments"]),
                "events": len(comments["events"]), "objects": len(framework["objects"]),
                "revisions": len(framework["revisions"]), "configurations": len(configurations["records"]), "files": hashes}
    # All validation and hashing precede writes. Publish the manifest last;
    # a caught staging/replacement failure leaves the previous bundle intact.
    files['manifest.json'] = _bytes(manifest)
    files={**{'assets/'+name:data for name,data in archive_files.items()},**files}
    with _staged_files(target, files) as publish:
        publish()
    return manifest


def restore(store, export_dir):
    target = Path(export_dir)
    manifest = json.loads((target / "manifest.json").read_text())
    schema = manifest.get("schema_version")
    if schema not in (1, 2, 3, 4, 5, 6, 7):
        raise ValueError("unsupported export schema")
    required = {'materials.json', 'comments.json'}
    if schema >= 2:
        required.update(('objects.json', 'configurations.json'))
    if schema >= 6:required.add("material-content.json")
    if not isinstance(manifest.get('files'), dict) or not required <= manifest['files'].keys():
        raise ValueError('required core file missing from export manifest')
    for name, expected in manifest["files"].items():
        path = target / name
        if name.startswith("assets/"):
            _safe_asset(name[7:])
        elif name not in (("materials.json", "comments.json") if schema == 1 else ("materials.json", "comments.json", "objects.json", "configurations.json", "entity-relationship-layout.json", "material-content.json")):
            raise ValueError("unexpected export file")
        if path.is_symlink() or physical_file_hash(path) != expected:
            raise ValueError("export checksum mismatch: " + name)
    materials = json.loads((target / "materials.json").read_text())
    comments = json.loads((target / "comments.json").read_text())
    framework = json.loads((target / "objects.json").read_text()) if schema >= 2 else None
    from .state_cleanup import guard_restore
    guard_restore(store, framework)
    if schema >= 4:
        from .material_versions import TABLES
        if any(name not in framework for name in TABLES):
            raise ValueError('material round tables missing from schema 4 export')
    if schema >= 5:
        from .material_plans import TABLES as PLAN_TABLES
        if any(name not in framework for name in PLAN_TABLES):
            raise ValueError('material plan tables missing from schema 5 export')
    if schema >= 7 and not {'business_codes','business_candidates','business_comments','relation_explanation_redactions','relation_redacted_comments','relation_explanation_latest_only'} <= set(framework):
        raise ValueError('numbering and explanation policy missing from schema 7 export')
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
        from . import material_storage
        if schema >= 6:
            content=json.loads((target/"material-content.json").read_text())
            if content.get("format")!="material-content-v1":raise ValueError("invalid material content format")
            framework["material_content"]=content["material_content"]
            if any(name not in framework for name in material_storage.TABLES):raise ValueError("material model tables missing")
            material_storage.restore_content(test,framework)
            physical_revisions=framework["revisions"]
            physical_by_id={row["id"]:row["payload"] for row in physical_revisions}
            framework["revisions"]=[{**row,"payload":material_storage.hydrate(test,row["payload"])} for row in physical_revisions]
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
            redactions={r["revision_id"]:r for r in framework.get("relation_explanation_redactions",[])}
            if len(redactions)!=len(framework.get("relation_explanation_redactions",[])) or not set(redactions)<=revisions.keys():raise ValueError("invalid redaction locators")
            cleaned_states={r["revision_id"]:r for r in framework.get("state_cleanup_receipts",[])}
            if len(cleaned_states)!=len(framework.get("state_cleanup_receipts",[])) or not set(cleaned_states)<=revisions.keys():raise ValueError("invalid state cleanup identities")
            for revision in revisions.values():
                if revision["object_id"] not in objects:
                    raise ValueError("orphan revision")
                payload = json.loads(revision["payload"])
                if digest(canonical({"object_id": revision["object_id"], "version": revision["version"], "payload": payload}).encode()) != revision["id"]:
                    if revision["id"] in cleaned_states:
                        from .state_cleanup import verify_row
                        if objects[revision["object_id"]]["kind"]!="DELETED_STATE":raise ValueError("invalid cleaned state kind")
                        verify_row(revision,cleaned_states[revision["id"]]);continue
                    if revision["id"] not in redactions:raise ValueError("revision checksum mismatch")
                    from .relation_explanations import verify_row
                    if objects[revision["object_id"]]["current_revision"]==revision["id"]:raise ValueError("current explanation cannot be redacted")
                    verify_row(revision,redactions[revision["id"]])
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
        archive_files={r['path']:_bytes(json.loads(r['container'])) for r in framework['material_archive_files']} if schema>=6 else {}
        # A large restore can spill pages and hold an exclusive rollback-journal
        # lock. Archive verification must read the same uncommitted content on
        # this connection, not open a second reader of the destination database.
        from .material_archives import read_scope as archive_read_scope
        with archive_read_scope(store), _staged_files(config, layout_files) as publish, _staged_files(store.db_path.parent.parent,archive_files) as publish_archives, store.db:
            if schema >= 6:material_storage.restore_content(store,framework)
            for source in materials:
                store.db.execute("INSERT INTO sources VALUES (?,?,?)", (source["id"], canonical(source), digest(canonical(source).encode())))
            if schema >= 2:
                for obj in framework["objects"]:
                    store.db.execute("INSERT INTO objects VALUES (?,?,?,?,?,?)", (obj["id"], obj["kind"], obj["current_revision"], obj["version"], obj["created_at"], obj["updated_at"]))
                for revision in framework["revisions"]:
                    store.db.execute("INSERT INTO revisions VALUES (?,?,?,?,?)", (revision["id"], revision["object_id"], revision["version"], physical_by_id[revision["id"]] if schema >= 6 else revision["payload"], revision["created_at"]))
                for dep in framework["dependencies"]:
                    store.db.execute("INSERT INTO dependencies VALUES (?,?,?)", (dep["from_revision"], dep["to_revision"], dep["role"]))
            else:
                from .store import now
                for obj in test.objects():
                    stamp = now()
                    store.db.execute("INSERT INTO objects VALUES (?,?,?,?,?,?)", (obj["id"], obj["kind"], obj["current_revision"], obj["version"], stamp, stamp))
                for revision in test.revisions():
                    store.db.execute("INSERT INTO revisions VALUES (?,?,?,?,?)", (revision["id"], revision["object_id"], revision["version"], revision["payload"], now()))
            from .state_cleanup import receipt_payload
            for table,keys in (("state_cleanup_receipts",("revision_id","object_id","entity_ref","original_sha256","receipt_sha256","reason")),("state_cleanup_preserved",("revision_id","payload_sha256")),("state_cleanup_comments",("comment_id","object_id","revision_id","anchor_sha256"))):
                for row in framework.get(table,[]) if framework else []:
                    store.db.execute("INSERT INTO "+table+" VALUES ("+",".join("?" for k in keys)+")",tuple(row[k] for k in keys))
            if schema >= 2:
                from .production import FORMATS, validate_payload, references, current_records
                dependencies_by_revision={}
                for dependency in framework['dependencies']:
                    dependencies_by_revision.setdefault(dependency['from_revision'],set()).add((dependency['to_revision'],dependency['role']))
                for revision in framework["revisions"]:
                    payload = json.loads(revision["payload"])
                    if payload.get("format") in FORMATS:
                        validate_payload(store, revision["object_id"], objects[revision["object_id"]]["kind"], payload, inspect=False, check_current=False)
                        expected_deps = {(ref["revision_id"], role) for role, ref in references(payload)}
                        actual_deps = dependencies_by_revision.get(revision['id'],set())
                        if expected_deps != actual_deps:
                            raise ValueError("restored production dependencies differ from payload")
                from .production import read_scope
                with read_scope(store):
                    for current in current_records(store, {"ENTITY", "RELATION", "REQUIREMENT"}):
                        validate_payload(store, current["object_id"], current["kind"], current["payload"], inspect=False)
            for redaction in framework.get("relation_explanation_redactions",[]) if framework else []:
                store.db.execute("INSERT INTO relation_explanation_redactions VALUES (?,?,?,?)",tuple(redaction[k] for k in ("revision_id","object_id","payload_sha256","facts_sha256")))
            for comment_locator in framework.get("relation_redacted_comments",[]) if framework else []:
                store.db.execute("INSERT INTO relation_redacted_comments VALUES (?,?,?,?)",tuple(comment_locator[k] for k in ("comment_id","object_id","revision_id","anchor_sha256")))
            if framework and framework.get("relation_explanation_latest_only"):
                store.db.execute("INSERT OR REPLACE INTO relation_explanation_policy VALUES (1,1)")
            from .business_codes import restore as restore_codes
            restore_codes(store,framework.get("business_codes",[]) if framework else [],framework.get("business_candidates",[]) if framework else [],framework.get("business_comments",[]) if framework else [])
            for c in restored_comments:
                from .relation_explanations import retained_comment
                from .state_cleanup import retained_comment as state_retained_comment
                if not retained_comment(store,c) and not state_retained_comment(store,c):store.validate_target(c["target_object_id"], c["target_revision_id"], c["anchor"])
                store.db.execute("INSERT INTO comments VALUES (?,?,?,?,?,?,?,?,?,?)", (c["id"], c.get("source_id"), c["target_object_id"], c["target_revision_id"], canonical(c["anchor"]), c["body"], c["status"], c["version"], c["created_at"], c["updated_at"]))
            for e in comments["events"]:
                store.db.execute("INSERT INTO comment_events VALUES (?,?,?,?,?)", (e["id"], e["comment_id"], e["action"], e["body"], e["at"]))
            from .business_codes import allocate_comments
            allocate_comments(store)
            if schema >= 4:
                from .material_versions import restore as restore_rounds
                restore_rounds(store, framework)
            if schema >= 5:
                from .material_plans import restore as restore_plans
                restore_plans(store, framework,validate_after=schema<6)
            if schema >= 6:
                material_storage.restore_indices(store,framework)
                from .material_plans import validate as validate_plans
                validate_plans(store)
                from .material_model import verify
                verify(store)
            if schema >= 2:
                for record in configurations["records"]:
                    store.db.execute("INSERT INTO configurations VALUES (?,?,?,?,?)", (record["scope"], record["schema_version"], record["version"], record["body"], record["updated_at"]))
                for event in configurations["events"]:
                    store.db.execute("INSERT INTO configuration_events VALUES (?,?,?,?,?)", (event["id"], event["scope"], event["version"], event["body"], event["at"]))
            publish_archives()
            publish()
    except BaseException:
        # A busy COMMIT can leave the transaction open on older sqlite3
        # bindings. Do not leave rows pending for a later unrelated commit.
        store.db.rollback()
        raise
    finally:
        test.close()
    return manifest
