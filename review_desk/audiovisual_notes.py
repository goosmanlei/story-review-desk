"""One editable working note per episode/scene, separate from exact composition."""
from .store import Conflict, digest, now

SCHEMA = '''
CREATE TABLE IF NOT EXISTS audiovisual_notes (
 object_id TEXT PRIMARY KEY REFERENCES objects(id),
 body TEXT NOT NULL, updated_at TEXT NOT NULL);
'''


def get(store, object_id):
    row = store.db.execute('SELECT * FROM audiovisual_notes WHERE object_id=?', (object_id,)).fetchone()
    body = row['body'] if row else ''
    return {'object_id': object_id, 'body': body, 'etag': digest(body.encode()),
            'updated_at': row['updated_at'] if row else None}


def save(store, request):
    from .production import record
    target = record(store, request['object_id'])
    if target['kind'] not in {'AV_EPISODE', 'AV_SCENE'}:
        raise ValueError('工作稿只属于视听集或场')
    body = request.get('body')
    if not isinstance(body, str) or len(body) > 30000:
        raise ValueError('工作稿须为不超过 30000 字的正文')
    with store.db:
        store.db.execute('BEGIN IMMEDIATE')
        current = get(store, target['object_id'])
        if request.get('expected_etag') != current['etag']:
            raise Conflict('工作稿已变化，请重新读取后合并修改')
        store.db.execute('INSERT INTO audiovisual_notes VALUES (?,?,?) ON CONFLICT(object_id) '
                         'DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at',
                         (target['object_id'], body, now()))
    return get(store, target['object_id'])


def dump(store):
    return [dict(row) for row in store.db.execute('SELECT * FROM audiovisual_notes ORDER BY object_id')]


def restore(store, rows):
    from .production import record
    seen = set()
    for row in rows:
        if row['object_id'] in seen or record(store, row['object_id'])['kind'] not in {'AV_EPISODE', 'AV_SCENE'}:
            raise ValueError('工作稿对象重复或归属无效')
        if not isinstance(row['body'], str) or len(row['body']) > 30000:
            raise ValueError('工作稿正文无效')
        seen.add(row['object_id'])
        store.db.execute('INSERT INTO audiovisual_notes VALUES (?,?,?)',
                         (row['object_id'], row['body'], row['updated_at']))
