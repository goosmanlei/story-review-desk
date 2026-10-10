"""One versioned business relationship per unordered pair of stable objects.

The registry owns identity only. Text lives in ordinary immutable revisions;
execution choices live in each generation input. Legacy aliases are read-only
historical records, never another current relationship.
"""
import copy
import json
import re

from . import production as p
from .store import Conflict, canonical, digest

CONTRACT = 'unified-relations-v1'
TABLES = ('business_relations', 'business_relation_aliases', 'business_relation_runs')
SCHEMA = '''
CREATE TABLE IF NOT EXISTS business_relations (
 object_id TEXT PRIMARY KEY REFERENCES objects(id),
 endpoint_a TEXT NOT NULL REFERENCES objects(id),
 endpoint_b TEXT NOT NULL REFERENCES objects(id),
 CHECK(endpoint_a < endpoint_b), UNIQUE(endpoint_a,endpoint_b));
CREATE TABLE IF NOT EXISTS business_relation_aliases (
 alias_id TEXT PRIMARY KEY REFERENCES objects(id),
 relation_id TEXT NOT NULL REFERENCES business_relations(object_id));
CREATE TABLE IF NOT EXISTS business_relation_runs (
 id TEXT PRIMARY KEY, receipt TEXT NOT NULL);
'''
ENDPOINT_KINDS = {'ENTITY', 'STATE', 'REQUIREMENT', 'ASSET', 'AV_SHOT',
                  'AV_SCENE', 'AV_EPISODE', 'REPRESENTATION', 'INPUT_LOCK', 'STORY', 'EPISODE'}
CHOICES = ('semantics', 'necessity', 'group', 'route', 'condition')


def available(store):
    return bool(store.db.execute("SELECT 1 FROM sqlite_master WHERE name='business_relations'").fetchone())


def enabled(store):
    return available(store) and bool(store.db.execute('SELECT 1 FROM business_relations LIMIT 1').fetchone())


def is_business(row):
    return row['kind'] == 'RELATION' and row['payload'].get('relation_type') == 'business'


def is_legacy(kind, payload):
    return kind == 'MATERIAL_RELATION' or kind == 'RELATION' and payload.get('relation_type') in ('entity', 'applicability')


def pair(endpoints):
    if not isinstance(endpoints, list) or len(endpoints) != 2 or any(not isinstance(e, str) or not p.ID.fullmatch(e) for e in endpoints):
        raise ValueError('关系需要两个稳定对象身份')
    if endpoints[0] == endpoints[1]:
        raise ValueError('关系的两个端点不能是同一对象')
    return tuple(sorted(endpoints))


def identity(endpoints):
    return 'relation-' + digest(canonical(pair(endpoints)).encode())[:32]


def normalize(payload):
    value = copy.deepcopy(payload)
    ordered = list(pair(value.get('endpoints')))
    if value['endpoints'] != ordered:
        value['direction'] = {'forward': 'reverse', 'reverse': 'forward'}.get(value.get('direction'), value.get('direction'))
    value['endpoints'] = ordered
    return value


def validate(store, object_id, payload, *, check_current=True):
    endpoints = pair(payload.get('endpoints'))
    if object_id != identity(list(endpoints)) or payload['endpoints'] != list(endpoints):
        raise ValueError('关系身份和端点顺序必须由同一对稳定对象确定')
    allowed = {'format', 'relation_type', 'title', 'blocks', 'endpoints', 'direction',
               'summary', 'sources', 'contexts', 'status'}
    if set(payload) - allowed:
        raise ValueError('关系只保存一份连贯内容；执行选择与类型字段须留在具体方案')
    for endpoint in endpoints:
        row = store.db.execute('SELECT kind FROM objects WHERE id=?', (endpoint,)).fetchone()
        if not row or row['kind'] not in ENDPOINT_KINDS:
            raise ValueError('关系端点不存在或不是可关联的业务对象：' + endpoint)
    if payload.get('direction') not in ('related', 'forward', 'reverse'):
        raise ValueError('关系方向须为 related/forward/reverse')
    if payload.get('status', 'active') not in ('active', 'withdrawn'):
        raise ValueError('关系状态无效')
    p._text(payload.get('summary'), '关系摘要')
    for key in ('sources', 'contexts'):
        for reference in p._list(payload, key):
            p.source_check(store, reference)
    if check_current and available(store):
        other = store.db.execute('SELECT object_id FROM business_relations WHERE endpoint_a=? AND endpoint_b=?', endpoints).fetchone()
        if other and other['object_id'] != object_id:
            raise Conflict('同一对对象已有关系：' + other['object_id'])


def guard_write(store, object_id, kind, payload):
    if not available(store):
        return
    if store.db.execute('SELECT 1 FROM business_relation_aliases WHERE alias_id=?', (object_id,)).fetchone():
        raise Conflict('旧关系身份只供准确历史读取；请修订统一关系')
    if enabled(store) and is_legacy(kind, payload):
        raise ValueError('旧业务关系写入契约已退役，请使用统一关系')
    if kind == 'RELATION' and payload.get('relation_type') == 'business':
        validate(store, object_id, payload)


def register(store, object_id, payload):
    endpoints = pair(payload['endpoints'])
    store.db.execute('INSERT OR IGNORE INTO business_relations VALUES (?,?,?)', (object_id, *endpoints))
    row = store.db.execute('SELECT endpoint_a,endpoint_b FROM business_relations WHERE object_id=?', (object_id,)).fetchone()
    if not row or tuple(row) != endpoints:
        raise Conflict('已存在关系的稳定端点不能更换')


def archived_ids(store):
    return {r[0] for r in store.db.execute('SELECT alias_id FROM business_relation_aliases')} if available(store) else set()


def current(store, endpoint=None):
    if not available(store):
        return []
    sql = ('SELECT r.*,o.kind,o.current_revision FROM business_relations b JOIN objects o ON o.id=b.object_id '
           'JOIN revisions r ON r.id=o.current_revision')
    args = ()
    if endpoint:
        sql += ' WHERE b.endpoint_a=? OR b.endpoint_b=?'
        args = (endpoint, endpoint)
    return [p.record_view(r) for r in store.db.execute(sql + ' ORDER BY o.id', args)]


def lookup(store, endpoints):
    if not available(store):
        return None
    row = store.db.execute('SELECT object_id FROM business_relations WHERE endpoint_a=? AND endpoint_b=?', pair(endpoints)).fetchone()
    return p.record(store, row[0]) if row else None


def material_bindings(store):
    """Read suitability for navigation; this never selects/uploads an input."""
    for row in current(store):
        value = row['payload']
        if value.get('status') == 'withdrawn':
            continue
        for endpoint in value['endpoints']:
            target = p.record(store, endpoint)
            if target['kind'] not in ('REQUIREMENT', 'ASSET'):
                continue
            for context in value.get('contexts', []):
                yield row, {'object_id': endpoint, 'revision_id': target['id']}, context


def scope_links(store, reference):
    result = []
    for row in current(store, reference['object_id']):
        if row['payload'].get('status') == 'withdrawn' or reference not in row['payload']['contexts']:
            continue
        other = next(e for e in row['payload']['endpoints'] if e != reference['object_id'])
        result.append((row, p.record(store, other)))
    return result


def code(store, row, codes=None):
    if not is_business(row):
        return None
    if codes is None:
        from .business_codes import code as render, visible_codes
        codes = {r['object_id']: render(r) for r in visible_codes(store)}
    a, b = row['payload']['endpoints']
    connector = {'related': '-', 'forward': '->', 'reverse': '<-'}[row['payload']['direction']]
    return 'R-' + codes.get(a, a) + connector + codes.get(b, b)


def resolve_code(store, value):
    match = re.fullmatch(r'R-([A-Z]+\d+)(->|<-|-)([A-Z]+\d+)', value)
    if not match:
        raise ValueError('关系编号格式无效')
    from .business_codes import code as render, visible_codes
    codes = {render(r): r['object_id'] for r in visible_codes(store)}
    if match[1] not in codes or match[3] not in codes:
        raise ValueError('关系编号端点不存在')
    row = lookup(store, [codes[match[1]], codes[match[3]]])
    if row is None:
        raise KeyError('该对象对尚无关系')
    return row


def exact_input_relation(store, requirement_id, item):
    """Read only the relation pinned by this exact plan, never today's text."""
    if not item.get('relation'):
        return None
    row = p.ref_record(store, item['relation'])
    if not is_business(row):
        return row  # Frozen input compatibility, including redacted text.
    target = p.ref_record(store, item['reference'])
    upstream = item.get('material_selection', {}).get('material_id') or target['object_id']
    from .material_storage import canonical_id
    possible = {target['object_id'], upstream, canonical_id(store, upstream)}
    ends = set(row['payload']['endpoints'])
    if requirement_id not in ends or not (ends - {requirement_id}) & possible:
        raise ValueError('准确关系不属于本方案与此参考对象对')
    return row


def input_rules(store, requirement_id, item):
    row = exact_input_relation(store, requirement_id, item)
    if row is None or not is_business(row):
        return None
    # A related graph edge can be an explicitly chosen directed input here.
    if not all(key in item for key in ('semantics', 'necessity')):
        raise ValueError('统一关系输入须显式保存本方案的语义和必要性')
    return {key: item[key] for key in CHOICES if key in item}


def input_context(store, requirement_id, item):
    row = exact_input_relation(store, requirement_id, item)
    if row is None:
        return None
    if is_business(row):
        return {'record': row, 'summary': row['payload']['summary'], 'code': code(store, row)}
    # Historical explanations are available only from that exact old revision.
    value = row['payload']
    summary = value.get('purpose') if row['kind'] == 'MATERIAL_RELATION' else value.get('label')
    if not summary or value.get('explanation_policy') == 'executable-only-v1' or value.get('explanation_removed'):
        return None
    return {'record': row, 'summary': summary, 'historical': True}


def dump(store):
    return {table: [dict(r) for r in store.db.execute('SELECT * FROM ' + table + ' ORDER BY 1')] for table in TABLES}


def restore(store, framework):
    for table in TABLES:
        for row in framework.get(table, []):
            keys = list(row)
            store.db.execute('INSERT INTO ' + table + '(' + ','.join(keys) + ') VALUES (' + ','.join('?' for _ in keys) + ')', tuple(row[k] for k in keys))
    indexed = {r['object_id']: (r['endpoint_a'], r['endpoint_b']) for r in store.db.execute('SELECT * FROM business_relations')}
    actual = {}
    for raw in store.db.execute("SELECT r.*,o.kind,o.current_revision FROM objects o JOIN revisions r ON r.id=o.current_revision WHERE o.kind='RELATION'"):
        row = p.record_view(raw)
        if is_business(row):
            actual[row['object_id']] = pair(row['payload']['endpoints'])
    if indexed != actual:
        raise ValueError('统一关系索引与准确对象不一致')
    for row in current(store):
        validate(store, row['object_id'], row['payload'], check_current=False)
    for alias, target in store.db.execute('SELECT alias_id,relation_id FROM business_relation_aliases'):
        row = p.record(store, alias)
        if not is_legacy(row['kind'], row['payload']) or identity(legacy_endpoints(row)) != target:
            raise ValueError('统一关系别名与原对象对不一致')
    if enabled(store):
        archived = archived_ids(store)
        for raw in store.db.execute('SELECT o.id,o.kind,r.payload FROM objects o JOIN revisions r ON r.id=o.current_revision'):
            if is_legacy(raw['kind'], json.loads(raw['payload'])) and raw['id'] not in archived:
                raise ValueError('统一关系恢复不能复活旧可写模型')


def legacy_endpoints(row):
    value = row['payload']
    if row['kind'] == 'MATERIAL_RELATION':
        return [value['upstream']['object_id'], value['downstream_id']]
    if value.get('relation_type') == 'entity':
        return [e['object_id'] for e in value['entities']]
    if value.get('relation_type') == 'applicability':
        return [value['subject']['object_id'], value['scope']['object_id']]
    raise ValueError('不是待统一的旧业务关系')


def apply_migration(store, plan, *, transaction=True):
    """An exact, additive cutover. Never rewrite old revisions or comments."""
    if plan.get('format') != 'unified-relations-migration-v1':
        raise ValueError('统一关系迁移格式无效')
    checksum = digest(canonical(plan).encode())
    if transaction:
        store.db.execute('BEGIN IMMEDIATE')
    elif not store.db.in_transaction:
        raise ValueError('关系迁移需要所属事务')
    try:
        previous = store.db.execute('SELECT receipt FROM business_relation_runs WHERE id=?', (checksum,)).fetchone()
        if previous:
            result = {**json.loads(previous[0]), 'already_applied': True}
        else:
            if enabled(store):
                raise Conflict('已有其他统一关系迁移，不能重放旧基线')
            existing = {r['object_id']: r for r in p.current_records(store, {'MATERIAL_RELATION', 'RELATION'}) if is_legacy(r['kind'], r['payload'])}
            expected = plan.get('expected_heads', {})
            if set(expected) != set(existing) or any(expected[oid] != row['id'] for oid, row in existing.items()):
                raise Conflict('当前关系清单或准确修订已变化，须重新核对迁移')
            aliases = plan.get('aliases', {})
            if set(aliases) != set(existing):
                raise ValueError('迁移必须覆盖所有旧关系身份')
            for oid, target in aliases.items():
                if target != identity(legacy_endpoints(existing[oid])):
                    raise ValueError('旧关系别名与稳定端点不一致')
            records = plan.get('records', [])
            if {r['object_id'] for r in records} != set(aliases.values()) or len(records) != len(set(aliases.values())):
                raise ValueError('每对端点必须且只能交付一条统一关系')
            p._import_records(store, {'format': 'production-import-v1', 'records': records}, transaction=False)
            store.db.executemany('INSERT INTO business_relation_aliases VALUES (?,?)', sorted(aliases.items()))
            result = {'id': checksum, 'contract': CONTRACT, 'legacy_objects': len(existing),
                      'current_relations': len(records), 'merged_duplicates': len(existing) - len(records),
                      'preserved_history': True}
            store.db.execute('INSERT INTO business_relation_runs VALUES (?,?)', (checksum, canonical(result)))
        if transaction:
            store.db.commit()
        return result
    except BaseException:
        if transaction:
            store.db.rollback()
        raise
