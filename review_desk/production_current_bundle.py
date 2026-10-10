"""Schema 13: complete recovery of current production without retired trees."""
import json
import tempfile
from pathlib import Path

from . import production_current as current
from .store import Store, canonical, digest


def table_names(store):
    return {r[0] for r in store.db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}


def required_assets(store):
    from .version_consolidation import file_references
    names = {a['file'] for source in store.sources() for a in source['assets']}
    names.update(source['media']['file'] for source in store.sources() if (source.get('media') or {}).get('file'))
    for row in store.revisions():
        payload = json.loads(row['payload'])
        if payload.get('private') is True:
            continue
        names.update(file_references(payload))
        names.update(c['file'] for c in payload.get('components', []))
        if row['object_id'] == 'story-structure':
            names.update(v['file'] for section in payload['sections'] for v in section.get('visuals', []))
    for row in store.db.execute('SELECT snapshot FROM production_submissions'):
        names.update(file_references(json.loads(row[0])))
    icon = store.configuration('SYSTEM')['body']['site_favicon']
    if icon:
        names.add(icon)
    return names


def install(store):
    """Prepare an empty database inside the caller's transaction."""
    from .production_current_migration import statements
    for trigger in ('material_frozen_definition_update', 'material_frozen_version_update'):
        store.db.execute('DROP TRIGGER IF EXISTS '+trigger)
    for table in current.LEGACY_TABLES:
        store.db.execute('DROP TABLE IF EXISTS '+table)
    store.db.execute('DROP TABLE business_relation_aliases')
    store.db.execute('CREATE TABLE business_relation_aliases (alias_id TEXT PRIMARY KEY,relation_id TEXT NOT NULL REFERENCES business_relations(object_id))')
    statements(store.db, current.SCHEMA)


def export(store, directory):
    from .bundle import _bytes, _staged_files, _write_content, _safe_asset, physical_file_hash
    from .production import references
    from .version_consolidation import file_references
    from .material_storage import physical_revisions
    from .business_codes import allocate_comments
    target = Path(directory)
    target.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.current-export-', dir=target) as temporary:
        content_file = Path(temporary)/'material-content.json'
        store.db.execute('SAVEPOINT current_export')
        try:
            allocate_comments(store)
            validate(store)
            excluded = {'sources', 'comments', 'comment_events', 'configurations', 'configuration_events', 'read_generations', 'material_content'}
            framework = {table: [dict(r) for r in store.db.execute('SELECT * FROM '+table+' ORDER BY 1')]
                         for table in sorted(table_names(store)-excluded)}
            framework['revisions'] = physical_revisions(store)
            # Public recovery never publishes local private creative steps.
            private = {r['object_id'] for r in store.revisions()
                       if json.loads(r['payload']).get('private') is True}
            private_rids = {r['id'] for r in framework['revisions'] if r['object_id'] in private}
            if any(d['to_revision'] in private_rids and d['from_revision'] not in private_rids for d in framework['dependencies']):
                raise ValueError('public content depends on private method inputs')
            framework['objects'] = [r for r in framework['objects'] if r['id'] not in private]
            framework['revisions'] = [r for r in framework['revisions'] if r['object_id'] not in private]
            framework['dependencies'] = [r for r in framework['dependencies'] if r['from_revision'] not in private_rids]
            materials = store.sources()
            comments = {'comments': store.comments(), 'events': store.events()}
            configurations = {'records': [dict(r) for r in store.db.execute('SELECT * FROM configurations ORDER BY scope')],
                              'events': store.configuration_events()}
            names = required_assets(store)
            _write_content(store, content_file)
        finally:
            store.db.execute('RELEASE SAVEPOINT current_export')
        files = {'materials.json': _bytes(materials), 'comments.json': _bytes(comments),
                 'objects.json': _bytes(framework), 'configurations.json': _bytes(configurations),
                 'material-content.json': content_file}
        layout = target.parent/'config/entity-relationship-layout.json'
        if layout.exists():
            value = json.loads(layout.read_text())
            if value.get('format') != 'entity-relationship-layout-v1':
                raise ValueError('unsupported relationship layout')
            files['entity-relationship-layout.json'] = _bytes(value)
        hashes = {name: physical_file_hash(data) if isinstance(data, Path) else digest(data) for name, data in files.items()}
        for name in sorted(names):
            hashes['assets/'+_safe_asset(name)] = physical_file_hash(target/'assets'/name)
        manifest = {'schema_version': 13, 'production_model': current.CONTRACT,
                    'sources': len(materials), 'comments': len(comments['comments']), 'events': len(comments['events']),
                    'objects': len(framework['objects']), 'revisions': len(framework['revisions']),
                    'configurations': len(configurations['records']), 'files': hashes}
        files['manifest.json'] = _bytes(manifest)
        with _staged_files(target, files) as publish:
            publish()
        return manifest


def insert_rows(store, table, rows):
    columns = [r['name'] for r in store.db.execute('PRAGMA table_info('+table+')')]
    if not columns:
        raise ValueError('unsupported current recovery table: '+table)
    for row in rows:
        if set(row) != set(columns):
            raise ValueError('current recovery columns differ: '+table)
        store.db.execute('INSERT INTO '+table+' VALUES ('+','.join('?' for _ in columns)+')',
                         tuple(row[c] for c in columns))


def populate(store, framework, materials, comments, configurations, content):
    from .material_storage import restore_content
    store.db.execute('BEGIN IMMEDIATE')
    store.db.execute('PRAGMA defer_foreign_keys=ON')
    store._material_migrating = True
    try:
        install(store)
        if 'generation_publications' in framework:
            store.db.execute('CREATE TABLE IF NOT EXISTS generation_publications (id TEXT PRIMARY KEY, receipt TEXT NOT NULL)')
        allowed = table_names(store)-{'sources', 'comments', 'comment_events', 'configurations', 'configuration_events', 'read_generations', 'material_content'}
        if set(framework) != allowed:
            raise ValueError('current recovery tables missing or unsupported: '+str(set(framework)^allowed))
        restore_content(store, {'material_content': content})
        for table in ('objects', 'revisions', *sorted(allowed-{'objects', 'revisions', 'production_current_policy', 'production_current_records'}),
                      'production_current_records', 'production_current_policy'):
            insert_rows(store, table, framework[table])
        for source in materials:
            store.db.execute('INSERT INTO sources VALUES (?,?,?)', (source['id'], canonical(source), digest(canonical(source).encode())))
        fields = [r['name'] for r in store.db.execute('PRAGMA table_info(comments)')]
        insert_rows(store, 'comments', [{k: canonical(c[k]) if k == 'anchor' else c[k] for k in fields} for c in comments['comments']])
        insert_rows(store, 'comment_events', comments['events'])
        insert_rows(store, 'configurations', configurations['records'])
        insert_rows(store, 'configuration_events', configurations['events'])
        current.read_adapters(store)
    finally:
        store._material_migrating = False


def validate(store):
    from . import methods, production as p, version_consolidation as consolidation
    from .production_media import validate_component
    if not current.enabled(store) or store.db.execute('SELECT contract FROM production_current_policy').fetchone()[0] != current.CONTRACT:
        raise ValueError('missing current production contract')
    if table_names(store) & set(current.LEGACY_TABLES):
        raise ValueError('retired production tables cannot be recovered')
    if store.db.execute("SELECT 1 FROM objects WHERE kind IN ('MATERIAL_RELATION','JUDGMENT','REPRESENTATION')").fetchone():
        raise ValueError('retired business objects cannot be recovered')
    if store.db.execute('PRAGMA foreign_key_check').fetchone():
        raise ValueError('current recovery foreign key mismatch')
    for obj in store.objects():
        rows = list(store.db.execute('SELECT * FROM revisions WHERE object_id=?', (obj['id'],)))
        heads = [r for r in rows if r['id'] == obj['current_revision'] and r['version'] == obj['version']]
        if len(heads) != 1 or obj['kind'] in current.RECORD_KINDS and len(rows) != 1:
            raise ValueError('invalid current object or retained production draft')
        for row in rows:
            payload = json.loads(row['payload'])
            if not consolidation.valid_identity(store, obj['id'], row['version'], payload, row['id']):
                raise ValueError('recovery content checksum mismatch: '+obj['id'])
            if obj['kind'] == 'SOURCE' and payload['source_revision'] != current.checksum(store.source(obj['id'])):
                raise ValueError('source recovery fingerprint mismatch')
            if obj['kind'] in current.RECORD_KINDS:
                baseline = store.db.execute('SELECT payload_sha256 FROM production_current_baselines WHERE object_id=?', (obj['id'],)).fetchone()
                # Approved migration preserves authentic historical gaps. Every
                # subsequent current write still goes through full validation.
                if not baseline or baseline[0] != current.checksum(payload):
                    p.validate_payload(store, obj['id'], obj['kind'], payload, inspect=False, check_current=False)
                expected = {(ref['revision_id'], role) for role,ref in p.references(payload)
                            if store.db.execute('SELECT 1 FROM revisions WHERE id=?', (ref['revision_id'],)).fetchone()}
                actual = {(d['to_revision'], d['role']) for d in store.db.execute('SELECT * FROM dependencies WHERE from_revision=?', (row['id'],))}
                if actual != expected:
                    raise ValueError('current dependency evidence differs: '+obj['id'])
            if payload.get('format') in methods.FORMATS.values():
                item = methods.read(store, revision_id=row['id'])
                methods.validate(store, payload)
                methods.verify_dependencies(store, item)
                if payload['format'] == methods.FORMATS['execution']:
                    methods.verify_execution(store, methods.reference(item), {k:payload[k] for k in ('work_type','run_id','step_id','target')}, payload['inputs'])
                if payload['format'] == methods.FORMATS['artifact']:
                    if methods.checksum(payload['output']) != payload['output_sha256']:
                        raise ValueError('method result checksum mismatch')
            for component in payload.get('components', []):
                validate_component(p.root_of(store), component, inspect=False)
    for row in store.db.execute('SELECT * FROM production_submissions'):
        saved = current.submission(store, row['operation_id'])
        snapshot = saved['snapshot']
        if snapshot.get('operation_id') != row['operation_id']:
            raise ValueError('submission identity mismatch')
        for need in snapshot.get('requirements', []):
            if current.checksum(need['payload']) != need['content_sha256']:
                raise ValueError('submitted requirement checksum mismatch')
        for value in snapshot.get('input_contents', []):
            if value.get('component'):
                validate_component(p.root_of(store), value['component'], inspect=False)
        for value in snapshot.get('basis_contents', []):
            if current.checksum(value['content']) != value['content_sha256']:
                raise ValueError('submitted production basis checksum mismatch')
    for candidate in store.db.execute('SELECT * FROM production_candidates'):
        asset = p.record(store, candidate['asset_object_id'])
        if candidate['id'] != 'candidate-'+digest(canonical({'operation': candidate['operation_id']}).encode()):
            raise ValueError('candidate identity mismatch')
        if not any(c.get('role') == 'original' for c in asset['payload'].get('components', [])):
            raise ValueError('empty candidate cannot be restored')
        actual = asset['payload'].get('production', {}).get('object_id') or 'source:'+asset['object_id']
        if actual != candidate['operation_id']:
            raise ValueError('candidate operation mismatch')
    for comment in store.comments():
        context = comment.get('original_context')
        if context:
            if context['excerpt']['anchor'] != comment['anchor']:
                raise ValueError('original comment excerpt mismatch')
        else:
            from .state_cleanup import retained_comment
            from .relation_explanations import retained_comment as relation_comment
            if not retained_comment(store, comment) and not relation_comment(store, comment):
                store.validate_target(comment['target_object_id'], comment['target_revision_id'], comment['anchor'])


def restore(store, directory):
    from .bundle import _safe_asset, physical_file_hash, _staged_files
    from .material_content_stream import rows as content_rows
    from .material_archives import read_scope
    target = Path(directory)
    manifest = json.loads((target/'manifest.json').read_text())
    core = {'materials.json', 'comments.json', 'objects.json', 'configurations.json', 'material-content.json'}
    if manifest.get('schema_version') != 13 or manifest.get('production_model') != current.CONTRACT or not core <= manifest.get('files', {}).keys():
        raise ValueError('invalid current production recovery manifest')
    for name, sha in manifest['files'].items():
        if name.startswith('assets/'):
            _safe_asset(name[7:])
        elif name not in core | {'entity-relationship-layout.json'}:
            raise ValueError('unsupported current recovery file')
        if (target/name).is_symlink() or physical_file_hash(target/name) != sha:
            raise ValueError('current recovery file checksum mismatch: '+name)
    framework, materials, comments, configurations = [json.loads((target/name).read_text()) for name in
                                                       ('objects.json','materials.json','comments.json','configurations.json')]
    counts = dict(sources=len(materials), comments=len(comments['comments']), events=len(comments['events']),
                  objects=len(framework['objects']), revisions=len(framework['revisions']), configurations=len(configurations['records']))
    if any(manifest[k] != v for k, v in counts.items()):
        raise ValueError('current recovery count mismatch')
    if store.sources() or store.objects() or store.comments() or any(c['version'] for c in store.configurations().values()):
        raise ValueError('restore requires an empty instance')
    # Verify against files from the immutable input bundle before touching the
    # destination. The database stays disk-backed, and content streams once.
    with tempfile.TemporaryDirectory(prefix='current-restore-check-') as temp:
        test = Store(Path(temp)/'.runtime/review.sqlite3')
        try:
            populate(test, framework, materials, comments, configurations, content_rows(target/'material-content.json'))
            if not {'assets/'+_safe_asset(name) for name in required_assets(test)} <= manifest['files'].keys():
                raise ValueError('current recovery manifest omits referenced originals')
            test.instance_root = target.parent
            with read_scope(test, root=target.parent):
                # Production root follows db_path; bind only during validation.
                previous = test.db_path
                test.db_path = target.parent/'.runtime/review.sqlite3'
                try:
                    validate(test)
                finally:
                    test.db_path = previous
        finally:
            test.db.rollback()
            test.close()
    root = store.db_path.parent.parent
    files = {'export/'+name: target/name for name in manifest['files'] if name.startswith('assets/')}
    if 'entity-relationship-layout.json' in manifest['files']:
        files['config/entity-relationship-layout.json'] = target/'entity-relationship-layout.json'
    try:
        with _staged_files(root, files) as publish:
            populate(store, framework, materials, comments, configurations, content_rows(target/'material-content.json'))
            if store.db.execute('PRAGMA foreign_key_check').fetchone():
                raise ValueError('restored current database has invalid references')
            publish()
            store.db.commit()
    except BaseException:
        store.db.rollback()
        raise
    return manifest
