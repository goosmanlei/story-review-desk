"""Readable identifiers over exact identities and immutable screenplay editions.

Episode/scene numbers are scoped to one complete screenplay edition. Other
allocations stay instance-wide; historical allocations remain recoverable.
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
    ('集', 'E', 'E02', '同一剧本版本内；按该版本完整集序编号'),
    ('场', 'S', 'S003', '同一剧本版本内；按完整集场顺序连续编号，不在每集重新起号'),
    ('镜', 'SH', 'SH034', '本实例内；不随切集、切场或显示顺序重置'),
    ('实体', 'EN', 'EN001', '本实例内'),
    ('实体状态', 'ST', 'ST001', '本实例内；历史保留状态也有独立编号'),
    ('素材', 'M', 'M001', '本实例内；准确共享身份共用编号，旧身份可追溯'),
    ('素材版本', 'MV', 'M001 / MV002', '同一准确素材身份内；沿用方案版本号'),
    ('素材候选', 'MC', 'M001 / MV002 / MC001', '同一素材版本内；按实际结果登记顺序分配'),
    ('实体关系', 'RL', 'RL001', '本实例内；不计素材采用及后台依赖边'),
    ('制作设定审阅对象', 'RV', 'RV001', '本实例内；保留旧审阅对象身份'),
    ('评论', 'C', 'C001', '本实例内；原文圈选、修订和评论身份不变'),
    ('审阅决定', 'DC', 'DC001', '本实例内，每个可访问的决定对象'),
)
PREFIXES = dict(ENTITY='EN', STATE='ST', REQUIREMENT='M', ASSET='M',
                EPISODE='E', SHOT_DESIGN='SH', REPRESENTATION='RV', JUDGMENT='DC')
LEGACY_PREFIXES = {'SOURCE': 'D', 'STORY': 'B'}


def code(row):
    return row['prefix'] + str(row['number']).zfill(2 if row['prefix'] == 'E' else 3)


def scene_identity(episode_id, scene_id):
    # Scenes are embedded in an exact episode rather than standalone objects.
    return 'scene:' + episode_id + ':' + scene_id


def allocate_number(store, object_id, prefix):
    if not prefix or store.db.execute('SELECT 1 FROM business_codes WHERE object_id=?', (object_id,)).fetchone():
        return
    number = store.db.execute('SELECT coalesce(max(number),0)+1 FROM business_codes WHERE prefix=?', (prefix,)).fetchone()[0]
    store.db.execute('INSERT INTO business_codes VALUES (?,?,?)', (object_id, prefix, number))


def allocate(store, object_id, kind, payload):
    if kind == 'EPISODE':
        return  # E/S come from the complete immutable edition, not this ledger.
    prefix = 'RL' if kind == 'RELATION' and payload.get('relation_type') == 'entity' else PREFIXES.get(kind)
    allocate_number(store, object_id, prefix)


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
            payload=json.loads(store.db.execute('SELECT payload FROM revisions WHERE id=?',(existing['current_revision'],)).fetchone()[0]);expected='RL' if existing['kind']=='RELATION' and payload.get('relation_type')=='entity' else 'ST' if existing['kind']=='DELETED_STATE' else PREFIXES.get(existing['kind'])
            if row.get('prefix') not in {expected, LEGACY_PREFIXES.get(existing['kind'])}:raise ValueError('number prefix differs from object kind')
        if set(row) != {'object_id', 'prefix', 'number'} or row['prefix'] not in {v[1] for v in TYPES} | {'D','B'} or type(row['number']) is not int or row['number'] < 1:
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
            'allocation': '集、场按准确剧本版本的完整顺序编号，场号跨集连续；切换版本各自从一开始。其他对象按首次登记次序递增，已分配编号保留。编号不替换稳定身份或准确修订。',
            'excluded': '资料、剧本与故事结构不使用简写编号。后台调用、依赖边、事件、配置表和输入锁也不增加编号。V/C 是当前素材内的局部版本／候选序号，须连同素材身份理解。'}


def edition_codes(store):
    """Derive stable E/S from published editions, never from filtered UI rows.

    The screenplay retains exact episode revisions; following current episode
    heads would misnumber historical scenes after a later edit. Unbound episode
    objects have no edition code until a complete screenplay references them.
    """
    result={}
    editions=store.db.execute("""SELECT r.object_id,r.id,r.payload FROM revisions r
        JOIN objects o ON o.id=r.object_id WHERE o.kind='STORY'
        AND json_extract(r.payload,'$.format')='screenplay-edition-v1'
        ORDER BY r.created_at,r.object_id,r.version""")
    for edition in editions:
        scene_number=0
        for number,reference in enumerate(json.loads(edition['payload'])['episodes'],1):
            row=store.db.execute("SELECT r.payload FROM revisions r JOIN objects o ON o.id=r.object_id WHERE r.id=? AND r.object_id=? AND o.kind='EPISODE'",
                                 (reference['revision_id'],reference['object_id'])).fetchone()
            if row is None:raise ValueError('screenplay numbering requires exact episode revision')
            episode=json.loads(row['payload'])
            if episode.get('screenplay_id',edition['object_id'])!=edition['object_id']:
                raise ValueError('episode numbering scope differs from screenplay')
            entries=[(reference['object_id'],'E',number)]
            for scene in episode.get('scenes',[]):
                scene_number+=1
                entries.append((scene_identity(reference['object_id'],scene['id']),'S',scene_number))
            for oid,prefix,value in entries:
                entry={'object_id':oid,'prefix':prefix,'number':value,
                       'screenplay_id':edition['object_id'],'screenplay_revision_id':edition['id'],
                       'episode_revision_id':reference['revision_id']}
                if oid in result and result[oid]!=entry:
                    raise ValueError('ambiguous screenplay numbering scope')
                result[oid]=entry
    return list(result.values())


def visible_codes(store):
    from .read_cache import read_json
    return read_json(store, 'visible-business-codes-v1',
                     lambda: [r for r in dump(store) if r['prefix'] not in ('D','B','E','S')]+edition_codes(store))


def annotate(store, value, *, share_records=False):
    from .material_storage import _clone_json_tree
    codes = {r['object_id']:code(r) for r in visible_codes(store)}
    aliases = {r['alias_id']:r['material_id'] for r in store.db.execute('SELECT alias_id,material_id FROM material_aliases')}
    candidates = {(r['material_id'],r['version'],r['candidate_id']):r['number'] for r in store.db.execute('SELECT * FROM business_candidates')}
    comment_codes={r['comment_id']:'C'+str(r['number']).zfill(3) for r in store.db.execute('SELECT * FROM business_comments')}
    scenes = {}
    records = {}
    def scene_for(scope):
        rid = scope.get('revision_id') if isinstance(scope,dict) else None
        if rid not in scenes:
            row = store.db.execute('SELECT o.kind,r.object_id,r.payload FROM revisions r JOIN objects o ON o.id=r.object_id WHERE r.id=?',(rid,)).fetchone() if rid else None
            source = json.loads(row['payload']).get('source',{}) if row and row['kind']=='PREPARATION' and row['object_id']==scope.get('object_id') else {}
            scenes[rid] = source
        return scenes[rid]
    def walk(v):
        if isinstance(v, list):
            return [walk(i) for i in v]
        if not isinstance(v, dict):
            return v
        record_key = (v.get('id'), v.get('object_id')) if 'payload' in v and isinstance(v.get('id'), str) else None
        if record_key:
            for original, annotated in records.get(record_key, []):
                if original == v:
                    return dict(annotated) if share_records else _clone_json_tree(annotated)
        result = {k:walk(i) for k,i in v.items()}
        if v.get('id') in comment_codes and 'anchor' in v and 'body' in v:result['business_code']=comment_codes[v['id']]
        oid = v.get('object_id') or v.get('id')
        if isinstance(oid,str) and oid in codes and ('payload' in v or 'title' in v):
            result['business_code'] = codes[oid]
            if oid in aliases:
                result['material_code'] = codes.get(aliases[oid],codes[oid])
            if v.get('kind') == 'REQUIREMENT' and 'payload' in v:
                scene = scene_for(v['payload'].get('scope'))
                if scene:
                    result['business_scene_id'] = scene['scene_id']
                    result['business_scene_code'] = codes.get(scene_identity(scene['object_id'], scene['scene_id']), '')
            if v.get('kind') == 'ASSET' and 'payload' in v:
                from .material_plans import identity
                cid = identity(v['payload'])
                result['candidate_codes'] = [
                    {'material_id':mid,'version':version,'number':number,
                     'code':codes.get(aliases.get(mid,mid),mid)+' / MV'+str(version).zfill(3)+' / MC'+str(number).zfill(3)}
                    for (mid,version,candidate),number in candidates.items() if candidate == cid]
        source = v.get('payload', {}).get('source', {})
        if v.get('kind') == 'PREPARATION' and source.get('scene_id'):
            result['business_code'] = codes.get(scene_identity(source['object_id'], source['scene_id']), '')
        if isinstance(oid, str) and codes.get(oid, '').startswith('E') and codes[oid][1:].isdigit():
            target = result.get('payload', result)
            for scene in target.get('scenes', []):
                scene['business_code'] = codes.get(scene_identity(oid, scene['id']), '')
        if v.get('reference', {}).get('object_id') and isinstance(result.get('scene'), dict):
            sid = result['scene'].get('id')
            if isinstance(sid, str):result['scene']['business_code'] = codes.get(scene_identity(v['reference']['object_id'], sid), '')
        if 'material_id' in v and type(v.get('number')) is int and 'results' in v:
            result['business_code'] = codes.get(aliases.get(v['material_id'],v['material_id']),v['material_id'])+' / MV'+str(v['number']).zfill(3)
            from .material_plans import identity
            for row in result['results']:
                number=candidates.get((v['material_id'],v['number'],identity(row['payload'])))
                if number is not None:
                    row['candidate_number'] = number
                    row['candidate_code'] = result['business_code']+' / MC'+str(number).zfill(3)
            result['results'].sort(key=lambda row: row.get('candidate_number',0))
        if record_key:
            # Version/candidate decoration below can mutate a returned record.
            # Keep a private template and give every occurrence its own tree.
            records.setdefault(record_key, []).append((v, dict(result) if share_records else _clone_json_tree(result)))
        return result
    return walk(value)


def display_dump(store):
    rows=visible_codes(store);mapping={r['object_id']:code(r) for r in rows}
    aliases={r['alias_id']:r['material_id'] for r in store.db.execute('SELECT * FROM material_aliases')}
    result = [{**r,'display_code':mapping.get(aliases.get(r['object_id'],r['object_id']))} for r in rows]
    by_id = {r['object_id']:r for r in result}
    for row in store.db.execute("SELECT o.id,o.kind,r.payload FROM objects o JOIN revisions r ON r.id=o.current_revision WHERE o.kind IN ('PREPARATION','SHOT_DESIGN')"):
        value = json.loads(row['payload'])
        if row['kind'] == 'PREPARATION':
            source = value['source']; scene_code = mapping.get(scene_identity(source['object_id'], source['scene_id']))
            if scene_code:result.append({'object_id':row['id'], 'display_code':scene_code})
        elif row['id'] in by_id:
            episode = store.db.execute('SELECT payload FROM revisions WHERE id=?', (value['episode']['revision_id'],)).fetchone()
            if episode:
                episode_number = json.loads(episode[0]).get('number')
                if episode_number is not None:
                    by_id[row['id']]['legacy_position'] = 'E'+str(episode_number)+'-'+str(value['number'])
                by_id[row['id']]['episode_code'] = mapping.get(value['episode']['object_id'], '')
    return result
