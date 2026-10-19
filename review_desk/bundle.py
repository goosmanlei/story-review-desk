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
            if isinstance(data, Path):
                shutil.copyfile(data, stage / 'new' / name)
            else:
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


def _write_content(store, path):
    """Keep the existing canonical export bytes, with one content row in memory."""
    encoder=json.JSONEncoder(ensure_ascii=False,sort_keys=True,indent=2)
    with path.open('w',encoding='utf-8',newline='\n') as output:
        output.write('{\n  "format": "material-content-v1",\n  "material_content": [')
        count=0
        for row in store.db.execute('SELECT id,body FROM material_content ORDER BY id'):
            output.write(',\n    ' if count else '\n    ')
            for chunk in encoder.iterencode(dict(row)):
                output.write(chunk.replace('\n','\n    '))
            count+=1
        output.write('\n  ]\n}\n' if count else ']\n}\n')


def export(store, export_dir):
    from .resources import settings
    if settings(store.db_path.parent.parent):
        from .resource_bundle import export as export_resources
        return export_resources(store, export_dir)
    from .production_current import enabled
    if enabled(store):
        from .production_current_bundle import export as export_current
        return export_current(store, export_dir)
    if store.db.execute("SELECT 1 FROM objects WHERE kind IN ('JUDGMENT','REPRESENTATION') LIMIT 1").fetchone():
        raise ValueError('历史审批须先按准确迁移包退役，再生成有效完整导出')
    target=Path(export_dir);target.mkdir(parents=True,exist_ok=True)
    # The largest table must not coexist as rows, JSON text and encoded bytes.
    # Stage from disk while retaining the same manifest and rollback semantics.
    with tempfile.TemporaryDirectory(prefix='.content-export-',dir=target) as temp:
        return _export(store,target,Path(temp)/'material-content.json')


def _export(store, export_dir, content_file):
    from .production_current_bundle import export as export_current
    return export_current(store, export_dir)


def restore(store, export_dir):
    manifest = json.loads((Path(export_dir)/'manifest.json').read_text())
    if manifest.get('schema_version') == 16:
        from .resource_bundle import restore as restore_resources
        return restore_resources(store, export_dir)
    from .production_current_bundle import restore as restore_current
    return restore_current(store, export_dir)
