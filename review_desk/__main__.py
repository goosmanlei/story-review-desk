import argparse
import json
from pathlib import Path

from .bundle import export, restore
from .screenplay import import_screenplay, snapshot as screenplay_snapshot, review_context as screenplay_review
from .server import ReviewServer
from .store import Store
from .structure import import_structure, snapshot, review_context, script_input
from . import production, entity_review, generation
from .production_media import ingest


def main():
    parser = argparse.ArgumentParser(prog="python3 -m review_desk")
    parser.add_argument("--instance", required=True, type=Path, help="story repository root")
    subs = parser.add_subparsers(dest="command", required=True)
    serve = subs.add_parser("serve")
    serve.add_argument("--port", type=int, default=8765)
    serve.add_argument("--host", default="127.0.0.1")
    source = subs.add_parser("import-sources")
    source.add_argument("file", type=Path)
    replace = subs.add_parser("replace-source-content", help="atomically replace one unreferenced refinement in place")
    replace.add_argument("file", type=Path, help="complete source document JSON object")
    replace.add_argument("--expected-revision", required=True)
    remove = subs.add_parser("remove-sources")
    remove.add_argument("ids", nargs="+", help="exact source ids to remove with their exclusive comments and revisions")
    subs.add_parser("export")
    subs.add_parser("restore")
    subs.add_parser("comments")
    subs.add_parser("structure-get")
    subs.add_parser("structure-review")
    subs.add_parser("script-input")
    subs.add_parser("screenplay-get")
    subs.add_parser("screenplay-review")
    screenplay_import = subs.add_parser("screenplay-import")
    screenplay_import.add_argument("file", type=Path, help="complete immutable screenplay edition")
    structure_import = subs.add_parser("structure-import")
    structure_import.add_argument("file", type=Path, help="complete structure JSON document")
    structure_import.add_argument("--expected-version", type=int, required=True)
    subs.add_parser("config-get")
    config_set = subs.add_parser("config-set")
    config_set.add_argument("scope", choices=("SYSTEM", "PROJECT"))
    config_set.add_argument("file", type=Path, help="JSON object containing configuration field updates")
    config_set.add_argument("--expected-version", type=int, required=True)
    subs.add_parser("objects")
    production_get = subs.add_parser("production-get")
    production_get.add_argument("--kind", choices=production.KINDS)
    production_get.add_argument("--object", dest="object_id")
    production_get.add_argument("--revision", dest="revision_id")
    entity_get = subs.add_parser('production-entity-review')
    entity_get.add_argument('entity_id')
    entity_get.add_argument('--revision', dest='revision_id')
    production_source = subs.add_parser('production-source')
    production_source.add_argument('object_id')
    production_source.add_argument('revision_id')
    production_source.add_argument('--scene')
    production_source.add_argument('--block', action='append')
    for command in ("production-import", "production-adopt", "production-judge", "production-file", "production-entity-decide"):
        sub = subs.add_parser(command)
        sub.add_argument("file", type=Path)
        if command == "production-import":
            sub.add_argument("--validate-only", action="store_true")
    for command in ('production-breakdown','production-materials','production-context','production-summary'):
        q=subs.add_parser(command)
        for flag in ('episode','scene','media','status','search','object-id','revision-id'):q.add_argument('--'+flag)
        if command=='production-materials':q.add_argument('--offset',type=int,default=0)
    model_export=subs.add_parser('material-model-map')
    model_export.add_argument('--output',required=True,type=Path)
    model_export.add_argument('--archive-list',type=Path)
    for command in ('material-model-migrate','material-model-rollback'):
        model_command=subs.add_parser(command)
        model_command.add_argument('file',type=Path)
        model_command.add_argument('--validate-only',action='store_true')
        if command=='material-model-migrate':model_command.add_argument('--defer-archives',action='store_true')
    subs.add_parser('material-model-verify')
    plan_export = subs.add_parser('material-plan-map')
    plan_export.add_argument('--output', required=True, type=Path)
    plan_migration = subs.add_parser('material-plan-migrate')
    plan_migration.add_argument('file', type=Path)
    plan_migration.add_argument('--validate-only', action='store_true')
    migration = subs.add_parser('material-round-migrate')
    migration.add_argument('file', type=Path)
    migration.add_argument('--validate-only', action='store_true')
    impact = subs.add_parser("production-impact")
    impact.add_argument("revision_id")
    for command in ("production-ready", "production-package", "production-generation-ready", "production-generation-package"):
        sub = subs.add_parser(command)
        sub.add_argument("scope")
        if command in ("production-package", "production-generation-package"):
            sub.add_argument("--output", required=True, type=Path)
    subs.add_parser("check")
    args = parser.parse_args()
    root = args.instance.resolve()
    config = json.loads((root / "config" / "instance.json").read_text())
    if args.command == "serve":
        server = ReviewServer((args.host, args.port), root, config)
        print(f"{config['title']}: http://{args.host}:{args.port}/", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()
        return
    store = Store(root / ".runtime" / "review.sqlite3")
    try:
        if args.command == "import-sources":
            data = json.loads(args.file.read_text())
            for document in data:
                store.put_source(document)
            result = {"imported": len(data), "total": len(store.sources())}
        elif args.command == "replace-source-content":
            result = store.replace_source_content(json.loads(args.file.read_text()), args.expected_revision)
        elif args.command == "remove-sources":
            result = store.remove_sources(args.ids)
        elif args.command == "export":
            result = export(store, root / "export")
        elif args.command == "restore":
            result = restore(store, root / "export")
        elif args.command == "comments":
            result = store.context()
        elif args.command == "structure-get":
            result = snapshot(store)
        elif args.command == "structure-review":
            result = review_context(store)
        elif args.command == "screenplay-get":
            result = screenplay_snapshot(store)
        elif args.command == "screenplay-review":
            result = screenplay_review(store)
        elif args.command == "screenplay-import":
            result = import_screenplay(store, json.loads(args.file.read_text()))
        elif args.command == "script-input":
            result = script_input(store)
        elif args.command == "structure-import":
            result = import_structure(store, json.loads(args.file.read_text()), args.expected_version)
        elif args.command == "config-get":
            result = store.configurations()
        elif args.command == "config-set":
            result = store.set_configuration(args.scope, json.loads(args.file.read_text()), args.expected_version)
        elif args.command == "objects":
            result = {"objects": store.objects(), "revisions": store.revisions(), "dependencies": store.dependencies()}
        elif args.command in ('production-breakdown','production-materials','production-context','production-summary'):
            from . import production_breakdown as bd
            with production.read_scope(store):
                if args.command=='production-breakdown':result=bd.catalog(store,args.episode)
                elif args.command=='production-materials':result=bd.materials(store,args.episode,args.scene,args.media,args.search or '',args.status,max(0,args.offset))
                elif args.command=='production-context':result=bd.context(store,args.object_id,args.revision_id)
                else:result=bd.summary(store,args.object_id,args.revision_id)
        elif args.command == 'material-model-map':
            from .material_model import migration_plan
            result=migration_plan(store,archive_paths=json.loads(args.archive_list.read_text()) if args.archive_list else [])
            args.output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
            result={'output':str(args.output),'id':result['id'],**result['counts']}
        elif args.command in ('material-model-migrate','material-model-rollback'):
            from .material_model import migrate, rollback, load_migration
            document=load_migration(args.file)
            result=(rollback(store,document,args.validate_only) if args.command.endswith('rollback') else migrate(store,document,args.validate_only,apply_archives=not args.defer_archives))
        elif args.command == 'material-model-verify':
            from .material_model import verify
            result=verify(store)
        elif args.command == 'material-plan-map':
            from .material_plans import migration_plan
            result = migration_plan(store)
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n')
            result = {'output': str(args.output), 'gaps': len(result['gaps'])}
        elif args.command == 'material-plan-migrate':
            from .material_plans import migrate
            result = migrate(store, json.loads(args.file.read_text()), args.validate_only)
        elif args.command == "production-get":
            result = production.snapshot(store, args.kind, args.object_id, args.revision_id)
        elif args.command == 'production-entity-review':
            result = entity_review.snapshot(store, args.entity_id, args.revision_id)
        elif args.command == 'production-source':
            ref = {'object_id': args.object_id, 'revision_id': args.revision_id}
            if args.scene:
                ref['scene_id'] = args.scene
            if args.block:
                ref['block_ids'] = args.block
            result = production.source_excerpt(store, ref)
        elif args.command == 'material-round-migrate':
            from .material_versions import migrate
            result = migrate(store, json.loads(args.file.read_text()), args.validate_only)
        elif args.command == "production-import":
            from .material_archives import read_json
            result = production.import_records(store, read_json(args.file), args.validate_only)
        elif args.command == "production-adopt":
            result = production.adopt(store, json.loads(args.file.read_text()))
        elif args.command == "production-judge":
            result = production.judge(store, json.loads(args.file.read_text()))
        elif args.command == "production-entity-decide":
            result = generation.decide(store, json.loads(args.file.read_text()))
        elif args.command == "production-generation-ready":
            result = generation.readiness(store, args.scope)
        elif args.command == "production-generation-package":
            result = generation.write_package(store, args.scope, args.output)
        elif args.command == "production-file":
            with args.file.open("rb") as stream:
                result = ingest(root, stream, args.file.name)
        elif args.command == "production-impact":
            result = production.impact(store, args.revision_id)
        elif args.command == "production-ready":
            result = production.readiness(store, args.scope)
        elif args.command == "production-package":
            result = production.write_package(store, args.scope, args.output)
        else:
            result = {"instance": config["id"], "sources": len(store.sources()), "comments": len(store.comments()), "events": len(store.events()),
                      "objects": len(store.objects()), "configurations": store.configurations()}
        print(json.dumps(result, ensure_ascii=False, indent=2))
    finally:
        store.close()


if __name__ == "__main__":
    main()
