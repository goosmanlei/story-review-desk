import argparse
import json
from pathlib import Path

from .bundle import export, restore
from .server import ReviewServer
from .store import Store


def main():
    parser = argparse.ArgumentParser(prog="python3 -m review_desk")
    parser.add_argument("--instance", required=True, type=Path, help="story repository root")
    subs = parser.add_subparsers(dest="command", required=True)
    serve = subs.add_parser("serve")
    serve.add_argument("--port", type=int, default=8765)
    source = subs.add_parser("import-sources")
    source.add_argument("file", type=Path)
    subs.add_parser("export")
    subs.add_parser("restore")
    subs.add_parser("comments")
    subs.add_parser("check")
    args = parser.parse_args()
    root = args.instance.resolve()
    config = json.loads((root / "config" / "instance.json").read_text())
    if args.command == "serve":
        server = ReviewServer(("127.0.0.1", args.port), root, config)
        print(f"{config['title']}: http://127.0.0.1:{args.port}/", flush=True)
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
        elif args.command == "export":
            result = export(store, root / "export")
        elif args.command == "restore":
            result = restore(store, root / "export")
        elif args.command == "comments":
            result = store.context()
        else:
            result = {"instance": config["id"], "sources": len(store.sources()), "comments": len(store.comments()), "events": len(store.events())}
        print(json.dumps(result, ensure_ascii=False, indent=2))
    finally:
        store.close()


if __name__ == "__main__":
    main()
