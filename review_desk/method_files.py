"""Independent immutable file history, with exact legacy package membership.

Paths belong to one method/resource. A rename is a new identity; no heuristic
ever redirects an old link. Consecutive equal bytes share a version, while a
return to earlier bytes after a change gets a new version.
"""
import difflib
import json

from .store import canonical, digest

FORMATS = ('managed-method-skill-v1', 'managed-method-resource-v1')
TABLES = ('method_file_versions', 'method_file_packages', 'method_file_members')
SCHEMA = (
    '''CREATE TABLE IF NOT EXISTS method_file_versions (
      id TEXT PRIMARY KEY, object_id TEXT NOT NULL REFERENCES objects(id),
      path TEXT NOT NULL, version INTEGER NOT NULL, kind TEXT NOT NULL,
      sha256 TEXT NOT NULL, content TEXT, media TEXT, created_at TEXT NOT NULL,
      UNIQUE(object_id,path,version))''',
    '''CREATE TABLE IF NOT EXISTS method_file_packages (
      revision_id TEXT PRIMARY KEY REFERENCES revisions(id),
      object_id TEXT NOT NULL REFERENCES objects(id), version INTEGER NOT NULL,
      UNIQUE(object_id,version))''',
    '''CREATE TABLE IF NOT EXISTS method_file_members (
      package_revision TEXT NOT NULL REFERENCES method_file_packages(revision_id),
      path TEXT NOT NULL, file_revision TEXT NOT NULL REFERENCES method_file_versions(id),
      PRIMARY KEY(package_revision,path))''',
)


def installed(store):
    return bool(store.db.execute("SELECT 1 FROM sqlite_master WHERE name='method_file_packages'").fetchone())


def install(store):
    for sql in SCHEMA:
        store.db.execute(sql)


def file_id(object_id, path):
    return digest(canonical([object_id, path]).encode())


def entries(payload):
    result = {path: {'kind': 'text', 'sha256': digest(body.encode()), 'content': body, 'media': None}
              for path, body in payload['files'].items()}
    for links in payload.get('media', {}).values():
        for spec in links.values():
            path = spec['path']
            item = {'kind': 'media', 'sha256': spec['sha256'], 'content': None, 'media': canonical(spec)}
            if path in result and result[path] != item:
                raise ValueError('同一准确文件路径对应不同原件：' + path)
            result[path] = item
    return result


def replay(rows):
    """Yield canonical rows from the immutable source ledger, one owner at a time."""
    owner, previous, counters = None, {}, {}
    for row in rows:
        if row['object_id'] != owner:
            owner, previous, counters = row['object_id'], {}, {}
        payload = json.loads(row['payload']) if isinstance(row['payload'], str) else row['payload']
        members, changes = {}, []
        for path, item in entries(payload).items():
            before = previous.get(path)
            if before and (before['sha256'], before['kind']) == (item['sha256'], item['kind']):
                version = before
            else:
                number = counters.get(path, 0) + 1
                counters[path] = number
                identity = {'file_id': file_id(owner, path), 'version': number,
                            'kind': item['kind'], 'sha256': item['sha256']}
                version = {'id': digest(canonical(identity).encode()), 'object_id': owner,
                           'path': path, 'version': number, **item, 'created_at': row['created_at']}
                changes.append(version)
            members[path] = version
        yield ({'revision_id': row['id'], 'object_id': owner, 'version': row['version']}, changes,
               [{'package_revision': row['id'], 'path': path, 'file_revision': v['id']} for path, v in members.items()])
        previous = members


def source_rows(store, object_id=None):
    return store.db.execute("SELECT r.* FROM revisions r WHERE json_extract(payload,'$.format') IN (?,?)" +
                            (' AND object_id=?' if object_id else '') + ' ORDER BY object_id,version',
                            (*FORMATS, object_id) if object_id else FORMATS)


def insert(store, table, value):
    store.db.execute('INSERT INTO ' + table + ' (' + ','.join(value) + ') VALUES (' +
                     ','.join('?' for _ in value) + ')', tuple(value.values()))


def sync(store, object_id=None):
    """Called inside the owning write transaction, including restoration."""
    install(store)
    added = {name: 0 for name in TABLES}
    for package, versions, members in replay(source_rows(store, object_id)):
        if store.db.execute('SELECT 1 FROM method_file_packages WHERE revision_id=?', (package['revision_id'],)).fetchone():
            continue
        for version in versions:
            if not store.db.execute('SELECT 1 FROM method_file_versions WHERE id=?', (version['id'],)).fetchone():
                insert(store, TABLES[0], version); added[TABLES[0]] += 1
        insert(store, TABLES[1], package); added[TABLES[1]] += 1
        for member in members:
            insert(store, TABLES[2], member); added[TABLES[2]] += 1
    return added


def migrate(store):
    with store.db:
        store.db.execute('BEGIN IMMEDIATE')
        added = sync(store)
        validate(store)
    if store.db.execute("SELECT 1 FROM sqlite_master WHERE name='read_generations'").fetchone():
        from .read_cache import initialize
        initialize(store)
    return {'format': 'method-file-history-v1', 'added': added,
            'totals': {table: store.db.execute('SELECT count(*) FROM '+table).fetchone()[0] for table in TABLES}}


def validate(store):
    if not installed(store):
        return  # Pre-migration packages remain readable by the legacy API.
    expected_counts = dict.fromkeys(TABLES, 0)
    for package, versions, members in replay(source_rows(store)):
        for table, values, key in ((TABLES[0], versions, 'id'), (TABLES[1], [package], 'revision_id'),
                                   (TABLES[2], members, None)):
            for value in values:
                where = key+'=?' if key else 'package_revision=? AND path=?'
                args = (value[key],) if key else (value['package_revision'], value['path'])
                row = store.db.execute('SELECT * FROM '+table+' WHERE '+where, args).fetchone()
                if not row or dict(row) != value:
                    raise ValueError('文件历史与准确整包映射不符：'+package['object_id'])
                expected_counts[table] += 1
    for table, count in expected_counts.items():
        if store.db.execute('SELECT count(*) FROM '+table).fetchone()[0] != count:
            raise ValueError('文件历史含有多余或缺失记录：'+table)


def require_history(store):
    if not installed(store):
        raise ValueError('文件历史尚未迁移；请完成准确历史迁移后重试')


def metadata(row):
    return {**{k: row[k] for k in ('id', 'version', 'kind', 'sha256', 'created_at')},
            'file_id': file_id(row['object_id'], row['path'])}


def manifest(store, package_revision):
    require_history(store)
    if not store.db.execute('SELECT 1 FROM method_file_packages WHERE revision_id=?', (package_revision,)).fetchone():
        raise ValueError('准确整包的文件组合缺失；请恢复原包')
    return {r['path']: metadata(r) for r in store.db.execute(
        'SELECT v.* FROM method_file_members m JOIN method_file_versions v ON v.id=m.file_revision WHERE m.package_revision=? ORDER BY m.path', (package_revision,))}


def execution_manifest(store, package):
    from .methods import read
    resources = []
    for resource in package['resources']:
        selected = {resource['file'], *resource.get('files', {})}
        record = read(store, **{k: resource['reference'][k] for k in ('object_id', 'revision_id')})
        media = record['payload'].get('media', {})
        selected.update(spec['path'] for file in tuple(selected) for spec in media.get(file, {}).values())
        resources.append({**resource['reference'], 'files': {
            name: spec for name, spec in manifest(store, resource['reference']['revision_id']).items() if name in selected}})
    return {'method': manifest(store, package['method']['revision_id']), 'resources': resources}


def reading_order(record, source_outlines=None):
    """Use the document's own outline and links; keep exact file identities."""
    import re
    import posixpath
    from urllib.parse import unquote, urlsplit
    files = record['payload']['files']
    paths = list(entries(record['payload']))
    entry = next((p for name in ('SKILL.md', 'README.md', 'handbook.md')
                  for p in paths if posixpath.basename(p) == name), None)
    ordered = [entry] if entry else []
    if not entry:
        # Older projections contain only chapter files. Recover their order
        # from an available complete copy of the SAME source bytes, never from
        # a newer document with different contents or an inferred filename order.
        sources = record['payload'].get('source', {}).get('files', {})
        for identity, body in (source_outlines or {}).items():
            for section in re.findall(r'<!--\s*section:([\w-]+)\s*-->', body):
                ordered.extend(path for path in paths if path not in ordered and
                    (sources.get(path, {}).get('path'), sources.get(path, {}).get('sha256')) == identity and
                    sources.get(path, {}).get('section') == section)
    if entry:
        body = files[entry]
        # A split handbook keeps section identifiers from its complete text.
        for section in re.findall(r'<!--\s*section:([\w-]+)\s*-->', body):
            path = posixpath.join(posixpath.dirname(entry), section+'.md')
            if path in files and path not in ordered:
                ordered.append(path)
        for link in re.findall(r'\[[^\]]*\]\(([^\s)]+)', body):
            url = urlsplit(link)
            if url.scheme or url.netloc:
                continue
            path = posixpath.normpath(posixpath.join(posixpath.dirname(entry), unquote(url.path)))
            if path in files and path not in ordered:
                ordered.append(path)
    ordered += [p for p in sorted(paths) if p not in ordered]
    labels = {}
    counts = {}
    for path in ordered:
        name = posixpath.basename(path)
        category = '正文' if path == entry else '模板' if 'templates/' in path else '图示' if path.lower().endswith(('.svg','.png','.jpg','.webp')) else '媒体' if path.lower().endswith(('.mp4','.mov','.webm','.mp3','.wav','.m4a')) else '资料' if not path.endswith('.md') else '参考资料'
        text = files.get(path, '')
        heading = re.search(r'^#{1,6}\s+(.+?)\s*#*\s*$', text, re.M) if path.endswith('.md') else None
        title = heading.group(1).strip() if heading else name
        existing = re.match(r'^(\d{2})[-_. ]', name)
        counts[category] = counts.get(category, 0)+1
        number = existing.group(1) if existing else str(counts[category]).zfill(2)
        if category == '正文':
            label = '阅读入口 · '+title
        else:
            title = re.sub(r'^\d{1,2}[.、：:·\s-]+', '', title)
            label = ('' if category == '参考资料' else category+' ')+number+' · '+title
        labels[path] = {'reading_label': label, 'reading_group': category}
    groups = ('正文', '参考资料', '模板', '图示', '媒体', '资料')
    return sorted(ordered, key=lambda path: groups.index(labels[path]['reading_group'])), labels


def directory(store, object_id, revision_id=None):
    from .methods import read
    require_history(store)
    record = read(store, object_id, revision_id)
    selected = manifest(store, record['revision_id'])
    paths = [r[0] for r in store.db.execute('SELECT DISTINCT path FROM method_file_versions WHERE object_id=? ORDER BY path', (object_id,))]
    outlines = {}
    sources = record['payload'].get('source', {}).get('files', {})
    wanted = {(item.get('path'), item.get('sha256')) for item in sources.values() if item.get('section')}
    if wanted and not any(path.rsplit('/', 1)[-1] in ('SKILL.md', 'README.md', 'handbook.md')
                          for path in record['payload']['files']):
        for row in store.db.execute('SELECT payload FROM revisions WHERE object_id=? ORDER BY version DESC', (object_id,)):
            payload = json.loads(row[0])
            for path, source in payload.get('source', {}).get('files', {}).items():
                identity = (source.get('path'), source.get('sha256'))
                body = payload.get('files', {}).get(path)
                if identity in wanted and identity not in outlines and not source.get('section') and isinstance(body, str):
                    if digest(body.encode()) == identity[1]:
                        outlines[identity] = body
            if set(outlines) == wanted:
                break
    ordered, labels = reading_order(record, outlines)
    ordered += [p for p in paths if p not in ordered]
    return {'record': record, 'files': [{'path': path, **labels.get(path, {}), 'selected': selected.get(path),
        'versions': [metadata(r) for r in store.db.execute('SELECT * FROM method_file_versions WHERE object_id=? AND path=? ORDER BY version DESC', (object_id, path))]}
        for path in ordered]}


def document(store, object_id, path, *, revision_id=None, version=None):
    from .methods import read
    from .method_document import project
    require_history(store)
    if revision_id:
        record = read(store, object_id, revision_id)
        member = manifest(store, revision_id).get(path)
        if not member:
            raise ValueError('此准确整包没有该文件（可能已删除或改名）；可从文件历史回查，未替换为最新版')
        if version is not None and member['version'] != version:
            raise ValueError('指定文件版本与准确整包不匹配')
        row = store.db.execute('SELECT * FROM method_file_versions WHERE id=?', (member['id'],)).fetchone()
    else:
        row = store.db.execute('SELECT * FROM method_file_versions WHERE object_id=? AND path=?'+
            (' AND version=?' if version is not None else '')+' ORDER BY version DESC LIMIT 1',
            (object_id, path, version) if version is not None else (object_id, path)).fetchone()
        if not row:
            raise ValueError('准确文件版本不存在；未替换为最新版')
        package = store.db.execute('SELECT p.revision_id FROM method_file_members m JOIN method_file_packages p ON p.revision_id=m.package_revision WHERE m.file_revision=? ORDER BY p.version DESC LIMIT 1', (row['id'],)).fetchone()
        record = read(store, object_id, package[0])
    if row['kind'] == 'text' and digest(record['payload']['files'][path].encode()) != row['sha256']:
        raise ValueError('文件历史原字节校验失败')
    versions = [metadata(r) for r in store.db.execute('SELECT * FROM method_file_versions WHERE object_id=? AND path=? ORDER BY version DESC', (object_id, path))]
    current = read(store, object_id)
    return {'record': record, 'file': path, 'file_version': metadata(row), 'versions': versions,
            'present': path in manifest(store, current['revision_id']), 'content': row['content'],
            'media': json.loads(row['media']) if row['media'] else None,
            'blocks': project(record['payload'], path) if row['kind'] == 'text' else []}


def compare(store, object_id, path, left, right):
    a = document(store, object_id, path, version=left)
    b = document(store, object_id, path, version=right)
    result = {'left': a, 'right': b, 'equal': a['file_version']['sha256'] == b['file_version']['sha256'], 'changes': []}
    if a['content'] is not None and b['content'] is not None and not path.lower().endswith('.svg'):
        lines_a, lines_b = a['content'].splitlines(keepends=True), b['content'].splitlines(keepends=True)
        # Full context; SequenceMatcher's autojunk would hide repeated code/Chinese lines.
        for tag, i, j, k, n in difflib.SequenceMatcher(None, lines_a, lines_b, autojunk=False).get_opcodes():
            result['changes'].append({'type': tag, 'left_start': i+1, 'right_start': k+1,
                                      'left': lines_a[i:j], 'right': lines_b[k:n]})
    return result
