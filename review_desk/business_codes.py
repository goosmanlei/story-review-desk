"""Human-readable identifiers, allocated independently of display ordering.

The persisted mapping supplements exact object/revision identities. It never
renumbers existing entries; export includes both allocations and tombstones.
"""
import json

SCHEMA = '''CREATE TABLE IF NOT EXISTS business_codes (
 object_id TEXT PRIMARY KEY, prefix TEXT NOT NULL, number INTEGER NOT NULL,
 UNIQUE(prefix,number));
CREATE TABLE IF NOT EXISTS business_candidates (
 material_id TEXT NOT NULL, version INTEGER NOT NULL, candidate_id TEXT NOT NULL,
 number INTEGER NOT NULL, PRIMARY KEY(material_id,version,candidate_id),
 UNIQUE(material_id,version,number));
CREATE TABLE IF NOT EXISTS business_comments (comment_id TEXT PRIMARY KEY,number INTEGER NOT NULL UNIQUE);'''

TYPES = (
    ('集', 'E', 'E02', '每份剧本版本内；沿用正文集号'),
    ('场', 'S', 'S003', '每份剧本版本内；沿用正文场号'),
    ('镜', 'SH', 'E02 / SH004', '每集的准确镜头设计内；沿用镜号'),
    ('实体', 'EN', 'EN001', '本实例内'),
    ('实体状态', 'ST', 'ST001', '本实例内；历史保留状态也有独立编号'),
    ('素材', 'M', 'M001', '本实例内；准确共享身份共用编号，旧身份可追溯'),
    ('素材版本', 'MV', 'M001 / MV002', '同一准确素材身份内；沿用方案版本号'),
    ('素材候选', 'MC', 'M001 / MV002 / MC001', '同一素材版本内；按实际结果登记顺序分配'),
    ('资料', 'D', 'D001', '本实例内，每份可独立访问的资料'),
    ('剧本与故事结构', 'B', 'B001', '本实例内，每个故事或剧本对象'),
    ('实体关系', 'RL', 'RL001', '本实例内；不计素材采用及后台依赖边'),
    ('制作设定审阅对象', 'RV', 'RV001', '本实例内；保留旧审阅对象身份'),
    ('评论', 'C', 'C001', '本实例内；原文圈选、修订和评论身份不变'),
    ('审阅决定', 'DC', 'DC001', '本实例内，每个可访问的决定对象'),
    ('组合', 'A', 'A001', '本实例内，每个组合对象'),
    ('交付物', 'O', 'O001', '本实例内，每个交付物对象'),
)
PREFIXES = dict(ENTITY='EN', STATE='ST', REQUIREMENT='M', ASSET='M',
                SOURCE='D', STORY='B', REPRESENTATION='RV', JUDGMENT='DC',
                ASSEMBLY='A', DELIVERABLE='O')


def allocate(store, object_id, kind, payload):
    prefix = 'RL' if kind == 'RELATION' and payload.get('relation_type') == 'entity' else PREFIXES.get(kind)
    if not prefix or store.db.execute('SELECT 1 FROM business_codes WHERE object_id=?', (object_id,)).fetchone():
        return
    number = store.db.execute('SELECT coalesce(max(number),0)+1 FROM business_codes WHERE prefix=?', (prefix,)).fetchone()[0]
    store.db.execute('INSERT INTO business_codes VALUES (?,?,?)', (object_id, prefix, number))


def initialize(store):
    store.db.executescript(SCHEMA)
    with store.db:
        for row in store.db.execute('SELECT o.id,o.kind,r.payload FROM objects o JOIN revisions r ON r.id=o.current_revision ORDER BY o.created_at,o.id').fetchall():
            allocate(store, row['id'], row['kind'], json.loads(row['payload']))
        allocate_candidates(store)
        allocate_comments(store)


def allocate_comments(store):
    for row in store.db.execute("SELECT id FROM comments ORDER BY created_at,id").fetchall():
        if not store.db.execute("SELECT 1 FROM business_comments WHERE comment_id=?",(row[0],)).fetchone():
            number=store.db.execute("SELECT coalesce(max(number),0)+1 FROM business_comments").fetchone()[0]
            store.db.execute("INSERT INTO business_comments VALUES (?,?)",(row[0],number))


def allocate_candidates(store, revision_id=None):
    query = '''SELECT m.material_id,m.number,c.candidate_id,min(r.created_at) AS stamp
        FROM material_plan_members m JOIN material_candidate_members c ON c.revision_id=m.revision_id
        JOIN revisions r ON r.id=m.revision_id WHERE m.role='result' '''
    params = ()
    if revision_id:
        query += 'AND m.revision_id=? '
        params = (revision_id,)
    query += 'GROUP BY m.material_id,m.number,c.candidate_id ORDER BY stamp,c.candidate_id'
    for row in store.db.execute(query, params).fetchall():
        key = (row['material_id'],row['number'],row['candidate_id'])
        if store.db.execute('SELECT 1 FROM business_candidates WHERE material_id=? AND version=? AND candidate_id=?',key).fetchone():
            continue
        number = store.db.execute('SELECT coalesce(max(number),0)+1 FROM business_candidates WHERE material_id=? AND version=?', key[:2]).fetchone()[0]
        store.db.execute('INSERT INTO business_candidates VALUES (?,?,?,?)', (*key,number))


def dump(store):
    return [dict(row) for row in store.db.execute('SELECT * FROM business_codes ORDER BY prefix,number')]


def restore(store, rows, candidates=(), comments=()):
    if not isinstance(rows, list):
        raise ValueError('invalid business code allocations')
    for row in rows:
        if not isinstance(row.get('object_id'),str) or not row['object_id']:raise ValueError('invalid numbered identity')
        existing=store.db.execute('SELECT kind,current_revision FROM objects WHERE id=?',(row['object_id'],)).fetchone()
        if existing:
            payload=json.loads(store.db.execute('SELECT payload FROM revisions WHERE id=?',(existing['current_revision'],)).fetchone()[0]);expected='RL' if existing['kind']=='RELATION' and payload.get('relation_type')=='entity' else PREFIXES.get(existing['kind'])
            if row.get('prefix')!=expected:raise ValueError('number prefix differs from object kind')
        if set(row) != {'object_id', 'prefix', 'number'} or row['prefix'] not in {v[1] for v in TYPES} or type(row['number']) is not int or row['number'] < 1:
            raise ValueError('invalid business code allocation')
        store.db.execute('INSERT INTO business_codes VALUES (?,?,?)', (row['object_id'], row['prefix'], row['number']))
    for row in comments:
        if set(row)!={'comment_id','number'} or not isinstance(row['comment_id'],str) or type(row['number']) is not int or row['number']<1:raise ValueError('invalid comment code')
        store.db.execute('INSERT INTO business_comments VALUES (?,?)',(row['comment_id'],row['number']))
    for row in candidates:
        if set(row) != {'material_id','version','candidate_id','number'} or any(type(row[k]) is not int or row[k]<1 for k in ('version','number')):
            raise ValueError('invalid candidate number allocation')
        store.db.execute('INSERT INTO business_candidates VALUES (?,?,?,?)',tuple(row[k] for k in ('material_id','version','candidate_id','number')))
    # Old bundles allocate once, in original registration order. New ones keep
    # deleted allocations too, so future imports cannot reuse visible numbers.
    for obj in store.objects():
        raw = store.db.execute('SELECT payload FROM revisions WHERE id=?', (obj['current_revision'],)).fetchone()
        allocate(store, obj['id'], obj['kind'], json.loads(raw[0]))
    allocate_candidates(store)


def catalog():
    return {'types': [dict(type=t, prefix=p, example=e, scope=s) for t,p,e,s in TYPES],
            'allocation': '新增对象按首次登记次序递增，已分配编号永久保留。编号不替换稳定身份或准确修订。',
            'excluded': '后台调用、依赖边、事件、配置表和输入锁不增加界面编号。'}


def annotate(store, value):
    codes = {r['object_id']:r['prefix']+str(r['number']).zfill(3) for r in dump(store)}
    aliases = {r['alias_id']:r['material_id'] for r in store.db.execute('SELECT alias_id,material_id FROM material_aliases')}
    candidates = {(r['material_id'],r['version'],r['candidate_id']):r['number'] for r in store.db.execute('SELECT * FROM business_candidates')}
    comment_codes={r['comment_id']:'C'+str(r['number']).zfill(3) for r in store.db.execute('SELECT * FROM business_comments')}
    scenes = {}
    def scene_for(scope):
        rid = scope.get('revision_id') if isinstance(scope,dict) else None
        if rid not in scenes:
            row = store.db.execute('SELECT o.kind,r.object_id,r.payload FROM revisions r JOIN objects o ON o.id=r.object_id WHERE r.id=?',(rid,)).fetchone() if rid else None
            scene = json.loads(row['payload']).get('source',{}).get('scene_id') if row and row['kind']=='PREPARATION' and row['object_id']==scope.get('object_id') else None
            scenes[rid] = scene
        return scenes[rid]
    def walk(v):
        if isinstance(v, list):
            return [walk(i) for i in v]
        if not isinstance(v, dict):
            return v
        result = {k:walk(i) for k,i in v.items()}
        if v.get('id') in comment_codes and 'anchor' in v and 'body' in v:result['business_code']=comment_codes[v['id']]
        oid = v.get('object_id') or v.get('id')
        if isinstance(oid,str) and oid in codes and ('payload' in v or 'title' in v):
            result['business_code'] = codes[oid]
            if oid in aliases:
                result['material_code'] = codes.get(aliases[oid],codes[oid])
            if v.get('kind') == 'REQUIREMENT' and 'payload' in v:
                scene = scene_for(v['payload'].get('scope'))
                if scene:result['business_scene_id'] = scene
            if v.get('kind') == 'ASSET' and 'payload' in v:
                from .material_plans import identity
                cid = identity(v['payload'])
                result['candidate_codes'] = [
                    {'material_id':mid,'version':version,'number':number,
                     'code':codes.get(aliases.get(mid,mid),mid)+' / MV'+str(version).zfill(3)+' / MC'+str(number).zfill(3)}
                    for (mid,version,candidate),number in candidates.items() if candidate == cid]
        if 'material_id' in v and type(v.get('number')) is int and 'results' in v:
            result['business_code'] = codes.get(aliases.get(v['material_id'],v['material_id']),v['material_id'])+' / MV'+str(v['number']).zfill(3)
            from .material_plans import identity
            for row in result['results']:
                number=candidates.get((v['material_id'],v['number'],identity(row['payload'])))
                if number is not None:
                    row['candidate_number'] = number
                    row['candidate_code'] = result['business_code']+' / MC'+str(number).zfill(3)
            result['results'].sort(key=lambda row: row.get('candidate_number',0))
        return result
    return walk(value)


def display_dump(store):
    rows=dump(store);mapping={r['object_id']:r['prefix']+str(r['number']).zfill(3) for r in rows}
    aliases={r['alias_id']:r['material_id'] for r in store.db.execute('SELECT * FROM material_aliases')}
    return [{**r,'display_code':mapping.get(aliases.get(r['object_id'],r['object_id']))} for r in rows]
