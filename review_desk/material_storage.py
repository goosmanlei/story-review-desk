"""Content-addressed material fields, with lossless legacy JSON hydration.

Only definition fields leave the revision envelope; identity, scope and indexed
relationship fields remain ordinary JSON. SQLite rows hydrate payload columns at
our Store boundary, so all consumers (including comments) see exact old records.
"""
import base64
import json
import sqlite3
import zlib
from .store import canonical, digest

FIELDS = {'blocks', 'purpose', 'specification', 'generation', 'method', 'model',
          'prompt', 'parameters', 'inputs', 'randomization', 'output', 'checks',
          'receipt', 'samples', 'sources', 'sample_policy', 'plan_source_sha256', 'preparation_task'}
KINDS = {'production-requirement-v1', 'production-call-v1'}
MARKER = '_material_fields'
TABLES = ('material_content', 'material_definitions', 'material_aliases',
          'material_definition_versions', 'material_archive_files', 'material_model_migrations')
SCHEMA = '''
CREATE TABLE IF NOT EXISTS material_content (
 id TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS material_definitions (
 id TEXT PRIMARY KEY REFERENCES material_content(id));
CREATE TABLE IF NOT EXISTS material_aliases (
 alias_id TEXT PRIMARY KEY REFERENCES objects(id), material_id TEXT NOT NULL REFERENCES objects(id),
 evidence TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS material_aliases_identity ON material_aliases(material_id);
CREATE TABLE IF NOT EXISTS material_definition_versions (
 material_id TEXT NOT NULL, number INTEGER NOT NULL,
 definition_id TEXT NOT NULL REFERENCES material_definitions(id),
 provenance TEXT NOT NULL, gaps TEXT NOT NULL,
 PRIMARY KEY(material_id,number),
 FOREIGN KEY(material_id,number) REFERENCES material_plan_versions(material_id,number) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS material_archive_files (
 path TEXT PRIMARY KEY, container TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS material_model_migrations (
 id TEXT PRIMARY KEY, document TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS material_content_immutable BEFORE UPDATE ON material_content
WHEN NEW.id!=OLD.id OR NEW.body!=OLD.body
BEGIN SELECT RAISE(ABORT,'material content is immutable'); END;
CREATE TRIGGER IF NOT EXISTS material_content_checksum BEFORE INSERT ON material_content
WHEN material_sha256(NEW.body)!=NEW.id
BEGIN SELECT RAISE(ABORT,'material content checksum mismatch'); END;
CREATE TRIGGER IF NOT EXISTS material_frozen_version_update BEFORE UPDATE ON material_plan_versions
WHEN OLD.frozen=1 AND (NEW.frozen!=1 OR NEW.fingerprint!=OLD.fingerprint) AND material_model_migrating()=0
BEGIN SELECT RAISE(ABORT,'frozen material version is immutable'); END;
CREATE TRIGGER IF NOT EXISTS material_frozen_definition_update BEFORE UPDATE ON material_definition_versions
WHEN (NEW.definition_id!=OLD.definition_id OR NEW.provenance!=OLD.provenance OR NEW.gaps!=OLD.gaps)
 AND EXISTS(SELECT 1 FROM material_plan_versions WHERE material_id=OLD.material_id AND number=OLD.number AND frozen=1)
 AND material_model_migrating()=0
BEGIN SELECT RAISE(ABORT,'frozen material definition is immutable'); END;
CREATE TRIGGER IF NOT EXISTS material_revision_insert BEFORE INSERT ON revisions
WHEN json_extract(NEW.payload,'$.format') IN ('production-requirement-v1','production-call-v1') AND material_model_migrating()=0 AND material_revision_valid(NEW.object_id,NEW.version,NEW.payload,NEW.id)=0
BEGIN SELECT RAISE(ABORT,'material revision logical checksum mismatch'); END;
CREATE TRIGGER IF NOT EXISTS material_revision_update BEFORE UPDATE OF payload ON revisions
WHEN json_extract(NEW.payload,'$.format') IN ('production-requirement-v1','production-call-v1') AND material_model_migrating()=0 AND material_revision_valid(NEW.object_id,NEW.version,NEW.payload,NEW.id)=0
BEGIN SELECT RAISE(ABORT,'material revision logical checksum mismatch'); END;

'''


TRIGGERS=('material_content_immutable','material_content_checksum','material_revision_insert',
          'material_revision_update','material_frozen_version_update','material_frozen_definition_update')


def upgrade_identity_triggers(db):
    for name in ('material_revision_insert','material_revision_update'):
        row=db.execute("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?",(name,)).fetchone()
        if row and 'material_revision_valid' not in row[0]:db.execute('DROP TRIGGER '+name)


def enable_constraints(db):
    upgrade_identity_triggers(db)
    statement=''
    for line in SCHEMA[SCHEMA.index('CREATE TRIGGER'):].splitlines(keepends=True):
        statement+=line
        if sqlite3.complete_statement(statement):db.execute(statement);statement=''


def cleanup_legacy_triggers(db):
    """Only a fully raw, unapplied database can be returned to an older writer."""
    if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='material_model_migrations'").fetchone() and db.execute('SELECT 1 FROM material_model_migrations LIMIT 1').fetchone():
        raise ValueError('applied material migration requires exact rollback before legacy runtime')
    if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='revisions'").fetchone() and db.execute("SELECT 1 FROM revisions WHERE json_type(payload,'$._material_fields') IS NOT NULL LIMIT 1").fetchone():
        raise ValueError('referenced material revisions cannot be read by legacy runtime')
    removed=[]
    for name in TRIGGERS:
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?",(name,)).fetchone():
            db.execute('DROP TRIGGER '+name);removed.append(name)
    return removed


def intern(store, value):
    """Merkle JSON: equal leaf text and equal subtrees occupy one physical row."""
    if isinstance(value, dict):
        packed = {'object': [[key, intern(store, item)] for key, item in sorted(value.items())]}
    elif isinstance(value, list):
        packed = {'array': [intern(store, item) for item in value]}
    else:
        packed = {'value': value}
    body = canonical(packed)
    key = digest(body.encode())
    store.db.execute('INSERT OR IGNORE INTO material_content VALUES (?,?)', (key, body))
    return key


def intern_recipe(store,pieces):
    # A recipe contains only references and lexical edits, never definition text.
    tokens=[];indices={};order=[]
    for part in pieces:
        value=canonical(part)
        if value not in indices:indices[value]=len(tokens);tokens.append(part)
        order.append(indices[value])
    packed=base64.b64encode(zlib.compress(canonical({'tokens':tokens,'order':order}).encode('utf-8'),9)).decode('ascii')
    body=canonical({'archive_recipe_zlib':packed});key=digest(body.encode())
    store.db.execute('INSERT OR IGNORE INTO material_content VALUES (?,?)',(key,body))
    return key


def expand(store, key, visiting=None, cache=None):
    if cache is None:
        scope=getattr(store,'_production_reads',None)
        cache=scope.setdefault('material_content',{}) if scope is not None else {}
    return _clone_json_tree(_expand_cached(store,key,visiting,cache))


def _clone_json_tree(value):
    # Copy each occurrence, not each identity. deepcopy's memo would preserve
    # aliases when two positions use the same cached child node.
    if isinstance(value,dict):return {key:_clone_json_tree(item) for key,item in value.items()}
    if isinstance(value,list):return [_clone_json_tree(item) for item in value]
    return value


def _expand_cached(store,key,visiting,cache):
    # Internal nodes are shared only while constructing immutable-by-contract
    # content. Never expose or mutate them; expand returns an independent tree.
    if key in cache:return cache[key]
    visiting = set() if visiting is None else visiting
    if key in visiting:
        raise ValueError('cyclic material content reference')
    row = store.db.execute('SELECT body FROM material_content WHERE id=?', (key,)).fetchone()
    if row is None or digest(row[0].encode()) != key:
        raise ValueError('missing or corrupt material content: ' + str(key))
    value = json.loads(row[0]); visiting.add(key)
    try:
        if set(value) == {'object'}:
            pairs=value['object']
            if len({p[0] for p in pairs})!=len(pairs):raise ValueError('duplicate material object key')
            result={k: _expand_cached(store, v, visiting, cache) for k, v in pairs}
            cache[key]=result
            return result
        if set(value) == {'array'}:
            result=[_expand_cached(store, v, visiting, cache) for v in value['array']]
            cache[key]=result
            return result
        if set(value) == {'archive_recipe_zlib'}:
            packed=json.loads(zlib.decompress(base64.b64decode(value['archive_recipe_zlib'],validate=True)))
            result=[packed['tokens'][i] for i in packed['order']] if isinstance(packed,dict) else packed
            cache[key]=result
            return result
        if set(value) == {'archive_recipe'}:
            cache[key]=value['archive_recipe']
            return value['archive_recipe']
        if set(value) == {'value'}:
            cache[key]=value['value']
            return value['value']
        raise ValueError('invalid material content node')
    finally:
        visiting.remove(key)


def encode(store, payload, raw=None):
    if payload.get('format') not in KINDS:
        return canonical(payload)
    if MARKER in payload:
        raise ValueError('material storage marker is reserved')
    fields = {k: v for k, v in payload.items() if k in FIELDS}
    encoded={**{k: v for k, v in payload.items() if k not in FIELDS}, MARKER: intern(store, fields)}
    if raw is not None and raw!=canonical(payload):
        from .material_archives import encode as encode_archive
        encoded['_material_raw']=intern(store,encode_archive(store,raw.encode('utf-8')))
    return canonical(encoded)


def hydrate(store, raw, resolve=None):
    if not isinstance(raw,str) or '"'+MARKER+'"' not in raw:
        return raw
    value=json.loads(raw)
    if MARKER not in value:return raw
    key=value.pop(MARKER)
    raw=value.pop('_material_raw',None)
    resolve=resolve or (lambda key:expand(store,key))
    fields=resolve(key)
    if set(fields)&set(value):raise ValueError('overlapping material content fields')
    result={**value,**fields}
    if raw:
        from .material_archives import decode
        original=decode(resolve(raw),resolve).decode('utf-8')
        if json.loads(original)!=result:raise ValueError('raw material layout differs from definition')
        return original
    return canonical(result)


def row_factory(store):
    def factory(cursor, row):
        names=[column[0] for column in cursor.description]
        if 'payload' in names:
            index=names.index('payload')
            raw=row[index]
            if isinstance(raw,str) and '"'+MARKER+'"' in raw:
                scope=getattr(store,'_production_reads',None)
                cache=scope.setdefault('hydrated_payloads',{}) if scope is not None else None
                if cache is not None and raw in cache:
                    hydrated=cache[raw]
                else:
                    hydrated=hydrate(store,raw)
                    if cache is not None:cache[raw]=hydrated
                # Share immutable text only. Each record projection still parses
                # its own payload; the complete raw envelope distinguishes both
                # historical associations and preserved original JSON layouts.
                values=list(row);values[index]=hydrated;row=tuple(values)
        return sqlite3.Row(cursor,row)
    return factory


def physical_revisions(store):
    return [{**{k:v for k,v in dict(row).items() if k!='stored_payload'},'payload':row['stored_payload']} for row in
            store.db.execute('SELECT id,object_id,version,payload AS stored_payload,created_at FROM revisions ORDER BY object_id,version')]


def dump(store, *, include_content=True):
    return {name:[dict(row) for row in store.db.execute('SELECT * FROM '+name+' ORDER BY 1')]
            for name in TABLES if include_content or name!='material_content'}


def restore_content(store, data):
    for row in data.get('material_content',[]):
        if set(row)!={'id','body'} or digest(row['body'].encode())!=row['id']:
            raise ValueError('material content checksum mismatch')
        store.db.execute('INSERT INTO material_content VALUES (?,?)',(row['id'],row['body']))
    for row in data.get('material_definitions',[]):
        expand(store,row['id'])
        store.db.execute('INSERT INTO material_definitions VALUES (?)',(row['id'],))


def restore_indices(store,data):
    for table in TABLES[2:]:
        columns=[r['name'] for r in store.db.execute('PRAGMA table_info('+table+')')]
        for row in data.get(table,[]):
            if set(row)!=set(columns):raise ValueError('invalid material model columns')
            store.db.execute('INSERT INTO '+table+' VALUES ('+','.join('?' for _ in columns)+')',tuple(row[c] for c in columns))


def canonical_id(store, material_id):
    scope=getattr(store,'_production_reads',None)
    if scope is not None:
        if 'material_alias_ids' not in scope:
            scope['material_alias_ids']=dict(store.db.execute('SELECT alias_id,material_id FROM material_aliases'))
        return scope['material_alias_ids'].get(material_id,material_id)
    row=store.db.execute('SELECT material_id FROM material_aliases WHERE alias_id=?',(material_id,)).fetchone()
    return row[0] if row else material_id


def identity(store, material_id):
    from . import list_reading
    mid=canonical_id(store,material_id)
    rows=list(store.db.execute('SELECT * FROM material_aliases WHERE material_id=? ORDER BY alias_id',(mid,)))
    aliases=sorted({mid,*[r['alias_id'] for r in rows]})
    evidence={r['alias_id']:json.loads(r['evidence']) for r in rows}
    associations=[]
    for alias in aliases:
        record=list_reading.record(store,alias)
        if record['kind']=='REQUIREMENT':
            associations.append({'requirement':{'object_id':alias,'revision_id':record['id']},
                'title':record['payload']['title'],'scope':record['payload']['scope'],
                'states':record['payload'].get('states',[]),'evidence':evidence.get(alias,{'kind':'original_requirement'}),
                'source_requirements':[v['reference'] for v in record['payload'].get('generation',{}).get('inputs',[]) if record['payload'].get('generation',{}).get('method')=='reuse'],
                'versions':[dict(v) for v in store.db.execute('SELECT material_id,number FROM material_plan_members WHERE revision_id=? ORDER BY material_id,number',(record['id'],))]})
    return {'id':mid,'aliases':aliases,'associations':associations}


def content_id(value):
    """Compute a Merkle key without populating the content store."""
    if isinstance(value,dict):node={'object':[[k,content_id(v)] for k,v in sorted(value.items())]}
    elif isinstance(value,list):node={'array':[content_id(v) for v in value]}
    else:node={'value':value}
    return digest(canonical(node).encode())
