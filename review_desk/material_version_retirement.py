"""One-way removal of material-version storage; receipts contain counts/hashes only."""
import hashlib
import sqlite3

from .store import canonical, Conflict

RETIRED_TABLES = (
    'material_feedback', 'material_comment_scopes', 'material_members', 'material_rounds',
    'material_plan_comments', 'material_candidate_members', 'material_plan_members',
    'material_definition_versions', 'material_definitions', 'material_plan_versions',
    'business_candidates', 'consolidation_versions', 'consolidation_definitions',
    'consolidation_signatures', 'material_model_migrations',
)
CHANGED_TABLES = {'production_legacy_links', 'consolidation_revisions', 'consolidation_missing',
                  'business_codes', 'material_content', 'read_generations'} | set(RETIRED_TABLES)


def inventory(store):
    """Hash physical rows without retaining a second copy of retired data."""
    result = {}
    cursor = store.db.cursor()
    cursor.row_factory = sqlite3.Row
    for table, in store.db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"):
        hashes = []
        for row in cursor.execute('SELECT * FROM "'+table+'"'):
            hashes.append(hashlib.sha256(canonical(dict(row)).encode()).digest())
        result[table] = {'rows': len(hashes), 'sha256': hashlib.sha256(b''.join(sorted(hashes))).hexdigest()}
    return result


def validate_absent(store):
    names = {r[0] for r in store.db.execute("SELECT name FROM sqlite_master UNION SELECT name FROM sqlite_temp_master")}
    if names & set(RETIRED_TABLES):
        raise ValueError('retired material storage is present: '+str(sorted(names & set(RETIRED_TABLES))))
    if store.db.execute("SELECT 1 FROM production_legacy_links WHERE kind='REQUIREMENT' LIMIT 1").fetchone():
        raise ValueError('retired material draft links are present')
    if store.db.execute("SELECT 1 FROM consolidation_revisions WHERE kind='REQUIREMENT' LIMIT 1").fetchone():
        raise ValueError('retired material draft identities are present')
    if store.db.execute("SELECT 1 FROM business_codes WHERE prefix='MV' LIMIT 1").fetchone():
        raise ValueError('retired material numbering is present')


def apply(store, *, expected=None, fault=None):
    from .production_current import enabled
    from .version_consolidation import collect_content
    if not enabled(store) or store.db.in_transaction:
        raise Conflict('material cleanup requires an idle current-model connection')
    before = inventory(store)
    if expected is not None and before != expected:
        raise Conflict('database changed after cleanup inventory')
    store.db.execute('PRAGMA secure_delete=ON')
    store.db.execute('BEGIN IMMEDIATE')
    try:
        if inventory(store) != before:
            raise Conflict('database changed before the cleanup transaction')
        retired = {r[0] for r in store.db.execute("SELECT revision_id FROM production_legacy_links WHERE kind='REQUIREMENT' UNION SELECT revision_id FROM consolidation_revisions WHERE kind='REQUIREMENT'")}
        store.db.execute('CREATE TEMP TABLE retired_material_ids (id TEXT PRIMARY KEY)')
        store.db.executemany('INSERT INTO retired_material_ids VALUES (?)', ((v,) for v in retired))
        store.db.execute('DELETE FROM consolidation_missing WHERE revision_id IN (SELECT id FROM retired_material_ids) OR target_revision IN (SELECT id FROM retired_material_ids)')
        store.db.execute("DELETE FROM production_legacy_links WHERE kind='REQUIREMENT'")
        store.db.execute("DELETE FROM consolidation_revisions WHERE kind='REQUIREMENT'")
        store.db.execute("DELETE FROM business_codes WHERE prefix='MV'")
        store.db.execute('DROP TABLE retired_material_ids')
        for name in ('material_frozen_definition_update', 'material_frozen_version_update'):
            store.db.execute('DROP TRIGGER IF EXISTS '+name)
        for table in RETIRED_TABLES:
            store.db.execute('DROP VIEW IF EXISTS temp.'+table)
            store.db.execute('DROP TABLE IF EXISTS main.'+table)
        content = collect_content(store)
        if fault == 'before-commit':
            raise RuntimeError('injected cleanup interruption')
        validate_absent(store)
        if store.db.execute('PRAGMA foreign_key_check').fetchone():
            raise ValueError('cleanup broke a foreign key')
        after = inventory(store)
        preserved = set(before)-CHANGED_TABLES
        if any(after.get(t) != before[t] for t in preserved):
            raise ValueError('cleanup changed unrelated business data')
        store.db.commit()
    except BaseException:
        store.db.rollback()
        raise
    # Complete the physical deletion too, including free pages and WAL remnants.
    if store.db.execute('PRAGMA journal_mode').fetchone()[0] == 'wal':
        store.db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
    store.db.execute('VACUUM')
    if store.db.execute('PRAGMA journal_mode').fetchone()[0] == 'wal':
        store.db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
    if store.db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
        raise ValueError('database integrity failed after physical cleanup')
    return {'format': 'material-version-removal-v1', 'before': before, 'after': after,
            'preserved_tables': sorted(preserved), 'removed_draft_links': len(retired),
            'content': content, 'secure_delete': True,
            'freelist_pages': store.db.execute('PRAGMA freelist_count').fetchone()[0],
            'vacuum': True, 'backup_created': False}
