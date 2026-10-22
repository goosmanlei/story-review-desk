"""Schema 16 recovery: versioned SQLite snapshot and a small resource catalog.

The snapshot is disk backed throughout. A restore verifies its entire closure
before writing the empty destination. Schemas 14/15 remain in their old reader.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile

from . import resources as r
from .store import Store


def database_identity(path):
    """Stable business-table identity, independent of SQLite page layout."""
    db = sqlite3.connect(Path(path).resolve().as_uri()+'?mode=ro', uri=True)
    try:
        db.execute('BEGIN')
        result = {}
        tables = sorted(row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'read_generations'"))
        for table in tables:
            digest, count = hashlib.sha256(), 0
            for row in db.execute('SELECT * FROM "'+table.replace('"','""')+'" ORDER BY 1'):
                digest.update(json.dumps(row,ensure_ascii=False,separators=(',',':')).encode())
                digest.update(b'\n'); count += 1
            result[table] = {'rows': count, 'sha256': digest.hexdigest()}
        return result
    finally:
        db.close()


def closure(store, root):
    """Validate external identities while preserving embedded historic prose."""
    from .production_current_bundle import required_assets
    for name in required_assets(store):
        r.descriptor(root, 'export/assets/'+name)
    for row in store.db.execute("SELECT json_extract(payload,'$.components') FROM revisions WHERE json_type(payload,'$.components')='array'"):
        for component in json.loads(row[0]):
            actual = r.descriptor(root, 'export/assets/' + component['file'])
            if any(actual[k] != component[k] for k in ('sha256', 'bytes', 'mime')):
                raise ValueError('resource recovery identity differs from its exact business component')
    for row in store.db.execute('SELECT media FROM method_file_versions WHERE media IS NOT NULL'):
        spec = json.loads(row[0])
        if not spec:
            continue
        actual = r.descriptor(root, spec['path'])
        if any(actual[k] != spec[k] for k in ('sha256','bytes','mime')):
            raise ValueError('method file recovery identity differs from its exact version')


def verify_catalog(root, catalog, *, full=True, mode=None):
    """Check every descriptor/content; remote mode explicitly audits each version."""
    config = r.settings(root)
    mode = mode or r.read_policy()
    if mode not in ('local-first', 'local-only', 'remote'):
        raise ValueError('invalid resource verification mode')
    if any(catalog.get(k) != config[k] for k in ('format','project','bucket','region')):
        raise ValueError('recovery catalog belongs to another project')
    seen, selected_objects = {}, []
    for name, spec in catalog['entries'].items():
        r.safe_path(name)
        for selected in [spec,*spec.get('variants',{}).values()]:
            r.validate_descriptor(config, selected)
            identity = r.storage_identity(selected)[:3]
            if selected.get('source') == 'offline-candidate':
                identity = ('offline-candidate', selected['sha256'])
            content=(selected['sha256'],selected['bytes'],selected['mime'])
            if identity in seen and seen[identity]!=content:
                raise ValueError('one cloud version has conflicting resource descriptors')
            if identity not in seen:
                selected_objects.append((name, selected))
            seen[identity]=content
    # Detect contradictory descriptors before performing any I/O.
    if full:
        with r.read_scope(mode):
            for name, selected in selected_objects:
                if mode == 'remote':
                    r.verify_remote(root, selected, relative=name)
                else:
                    r.verify_content(root, name, selected)
    return len(seen)


def export(store, directory):
    from .production_current_bundle import validate
    from .production_media import physical_hash_scope
    from .bundle import _staged_files
    root=store.db_path.parent.parent; target=Path(directory)
    target.mkdir(parents=True,exist_ok=True)
    config=r.settings(root)
    if not config:
        raise ValueError('cloud recovery requires project resource configuration')
    if store.db.in_transaction:
        raise ValueError('commit business writes before cloud export')
    if store.db.execute("SELECT 1 FROM revisions WHERE json_extract(payload,'$.private')=1 LIMIT 1").fetchone():
        raise ValueError('private creative records must be excluded before public recovery export')
    # SQLite backup takes a consistent read snapshot without materializing giant
    # objects.json strings or holding a business write transaction during I/O.
    with tempfile.TemporaryDirectory(prefix='resource-export-',dir=root/'.runtime') as folder:
        snapshot=Path(folder)/'database.sqlite3'
        destination=sqlite3.connect(snapshot)
        try:
            store.db.backup(destination,pages=256)
        finally:
            destination.close()
        check=Store.open_readonly(snapshot)
        check.db_path=root/'.runtime/review.sqlite3'
        try:
            if check.db.execute("SELECT 1 FROM revisions WHERE json_extract(payload,'$.private')=1 LIMIT 1").fetchone():
                raise ValueError('private creative records are present in the consistent snapshot')
            closure(check,root)
            with physical_hash_scope():
                validate(check)
        finally:
            check.close()
        category='snapshots/'+os.environ.get('REVIEW_RESOURCE_INSTANCE','local')
        spec=r.upload(root,snapshot,category=category)
        catalog_path=Path(folder)/'resource-catalog.json'
        r.freeze_catalog(root,catalog_path)
        verify_catalog(root, json.loads(catalog_path.read_text()))
        manifest={'schema_version':16,'format':'versioned-resource-recovery-v1',
                  'instance_id':config['instance_id'],'project':config['project'],
                  'snapshot':spec,'database':database_identity(snapshot),
                  'files':{'resource-catalog.json':r.hash_file(catalog_path)}}
        files={'resource-catalog.json':catalog_path}
        layout=root/'config/entity-relationship-layout.json'
        if layout.is_file():
            files['entity-relationship-layout.json']=layout
            manifest['files']['entity-relationship-layout.json']=r.hash_file(layout)
        files['manifest.json']=(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n').encode()
        with _staged_files(target,files) as publish:
            publish()
        return manifest


def restore(store, directory):
    from .production_current_bundle import validate
    from .production_media import physical_hash_scope
    from .bundle import _staged_files
    target=Path(directory);root=store.db_path.parent.parent
    manifest=json.loads((target/'manifest.json').read_text())
    config=r.settings(root)
    if (manifest.get('schema_version')!=16 or manifest.get('format')!='versioned-resource-recovery-v1'
            or manifest.get('instance_id')!=config['instance_id'] or manifest.get('project')!=config['project']):
        raise ValueError('invalid versioned recovery identity')
    if store.objects() or store.sources() or store.comments() or any(c['version'] for c in store.configurations().values()):
        raise ValueError('restore requires an empty instance')
    initial = database_identity(store.db_path)
    if set(manifest['files']) not in ({'resource-catalog.json'},{'resource-catalog.json','entity-relationship-layout.json'}):
        raise ValueError('unsupported versioned recovery metadata')
    for name,digest in manifest['files'].items():
        if r.hash_file(r.contained(target,name))!=digest:
            raise ValueError('recovery metadata checksum mismatch: '+name)
    catalog=json.loads((target/'resource-catalog.json').read_text())
    # Install metadata with rollback; verify the cloud/offline closure before
    # touching the destination DB. This may take time but holds no SQLite lock.
    files={'config/resource-catalog.json':target/'resource-catalog.json'}
    if 'entity-relationship-layout.json' in manifest['files']:
        files['config/entity-relationship-layout.json']=target/'entity-relationship-layout.json'
    with _staged_files(root,files) as publish:
        publish()
        verify_catalog(root,catalog)
        with physical_hash_scope():
            if r.read_policy() == 'remote':
                r.verify_remote(root, manifest['snapshot'], relative='database.sqlite3')
            snapshot=r.materialize(root,'database.sqlite3',spec=manifest['snapshot'])
            if database_identity(snapshot)!=manifest['database']:
                raise ValueError('recovery database tables differ from the snapshot manifest')
            check=Store.open_readonly(snapshot)
            check.db_path=root/'.runtime/review.sqlite3'
            try:
                if check.db.execute('PRAGMA quick_check').fetchone()[0]!='ok':
                    raise ValueError('recovery database integrity failed')
                closure(check,root)
                validate(check)
                _install_snapshot(store, snapshot, initial)
            finally:
                check.close()
    from .production_current import read_adapters
    read_adapters(store)
    return manifest


def _install_snapshot(store, snapshot, initial):
    """Copy a validated disk DB under one write lock, rejecting arriving data.

    SQLite backup cannot share a destination BEGIN IMMEDIATE. ATTACH and INSERT
    SELECT instead keep the empty-target recheck and replacement atomic, with
    bounded SQLite buffers and no cloud reads inside the write transaction.
    """
    db=store.db
    if db.in_transaction:
        raise ValueError('restore cannot replace an active write transaction')
    db.execute('ATTACH DATABASE ? AS recovery', (snapshot.resolve().as_uri()+'?mode=ro',))
    foreign_keys=db.execute('PRAGMA foreign_keys').fetchone()[0]
    db.execute('PRAGMA foreign_keys=OFF')
    def quoted(name):
        return '"'+name.replace('"','""')+'"'
    try:
        db.execute('BEGIN IMMEDIATE')
        if (any(db.execute('SELECT 1 FROM '+name+' LIMIT 1').fetchone() for name in ('objects','sources','comments'))
                or db.execute('SELECT 1 FROM configurations WHERE version != 0 LIMIT 1').fetchone()):
            raise ValueError('restore destination is no longer empty; no data was replaced')
        if database_identity(store.db_path) != initial:
            raise ValueError('restore destination changed during preflight; no data was replaced')
        schema=list(db.execute("SELECT type,name,sql FROM recovery.sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END,name"))
        existing=list(db.execute("SELECT type,name FROM main.sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'trigger' THEN 0 WHEN 'view' THEN 1 WHEN 'index' THEN 2 ELSE 3 END"))
        for kind,name in existing:
            db.execute('DROP '+kind.upper()+' IF EXISTS main.'+quoted(name))
        for kind,name,sql in schema:
            if kind=='table':
                db.execute(sql)
                db.execute('INSERT INTO main.'+quoted(name)+' SELECT * FROM recovery.'+quoted(name))
        if db.execute("SELECT 1 FROM recovery.sqlite_master WHERE name='sqlite_sequence'").fetchone():
            db.execute('DELETE FROM main.sqlite_sequence')
            db.execute('INSERT INTO main.sqlite_sequence SELECT * FROM recovery.sqlite_sequence')
        for kind,name,sql in schema:
            if kind!='table':
                db.execute(sql)
        if db.execute('PRAGMA main.foreign_key_check').fetchone():
            raise ValueError('restored database has broken foreign keys')
        db.commit()
    except BaseException:
        db.rollback()
        raise
    finally:
        db.execute('PRAGMA foreign_keys='+str(foreign_keys))
        db.execute('DETACH DATABASE recovery')


# Explicit application metadata, never a recursive config-folder archive.
INSTANCE_FILES = ('config/instance.json', 'config/resource-storage.json',
    'config/entity-relationship-layout.json', 'content/production-approach.json',
    'content/data-model.json', 'content/skill-flow.json', 'content/managed-methods.json',
    'content/managed-media-method.json', 'content/managed-method-registry.json',
    'content/episode-editing-method.json', 'content/screenplay-summaries.json',
    'content/creative-system-review-registry.json', 'content/creative-system-review-method.json')


def copy_instance_metadata(root, destination):
    credential=os.environ.get('REVIEW_OSS_CREDENTIALS_FILE')
    credential=Path(credential).resolve() if credential else None
    for name in INSTANCE_FILES:
        source=r.contained(root,name)
        if not source.is_file():
            continue
        if source.resolve()==credential:
            raise ValueError('runtime credentials cannot be packaged as instance metadata')
        if source.stat().st_size>16*1024**2:
            raise ValueError('instance metadata exceeds the declared text-file bound')
        value=json.loads(source.read_text())
        def credentials(item):
            if isinstance(item,dict):
                return any(k.lower() in ('access_key_id','access_key_secret','secret_access_key','security_token') or credentials(v) for k,v in item.items())
            return isinstance(item,list) and any(credentials(v) for v in item)
        if credentials(value):
            raise ValueError('credentials are forbidden in recovery metadata')
        out=r.contained(destination,name);out.parent.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(source,out)


def offline_bundle(root, destination):
    """Make independent, verified media outside Git; never package credentials."""
    root=Path(root);destination=Path(destination)
    if destination.exists():
        raise ValueError('offline destination exists; verify/resume it explicitly')
    if destination.resolve().is_relative_to(root.resolve()):
        raise ValueError('offline recovery medium must be outside the source instance')
    resolved = destination.resolve()
    if any((parent / '.git').exists() for parent in (resolved, *resolved.parents)):
        raise ValueError('offline recovery medium must be outside every Git repository')
    destination.mkdir(parents=True)
    for name in ('config','content','export'):
        (destination/name).mkdir()
    copy_instance_metadata(root,destination)
    manifest=json.loads((root/'export/manifest.json').read_text())
    if manifest['schema_version']!=16:
        raise ValueError('offline cloud bundle requires schema 16')
    for name in ('manifest.json',*manifest['files']):
        shutil.copyfile(root/'export'/name,destination/'export'/name)
    catalog=json.loads((root/'export/resource-catalog.json').read_text())
    for name, digest in manifest['files'].items():
        if r.hash_file(r.contained(root/'export', name)) != digest:
            raise ValueError('offline recovery metadata checksum mismatch: ' + name)
    verify_catalog(root, catalog, full=False)
    r.validate_descriptor(r.settings(root), manifest['snapshot'])
    specs=[('database.sqlite3',manifest['snapshot'])]
    specs += [(name,s) for name,x in catalog['entries'].items() for s in [x,*x.get('variants',{}).values()]]
    media=destination/'resource-bundle';media.mkdir()
    for name,spec in specs:
        out=media/spec['sha256']
        if out.exists():
            continue
        with r.lease_scope():
            source=r.materialize(root,name,spec=spec)
            shutil.copyfile(source,out)
        if out.stat().st_size!=spec['bytes'] or r.hash_file(out)!=spec['sha256']:
            raise ValueError('offline copy verification failed')
    receipt={'format':'offline-resource-medium-v1','snapshot_sha256':manifest['snapshot']['sha256'],
             'objects':len(list(media.iterdir())),'bytes':sum(p.stat().st_size for p in media.iterdir()),
             'manifest_sha256':r.hash_file(destination/'export/manifest.json')}
    r.atomic_json(destination/'offline-medium.json',receipt)
    return receipt
