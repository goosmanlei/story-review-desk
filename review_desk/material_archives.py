"""Lossless reference containers for managed JSON request/receipt files.

A container is never served as the historic file. Its checksum describes its own
bytes; legacy consumers receive reconstructed bytes checked against the old SHA.
"""
import difflib
import base64
import zlib
import json
import re
from pathlib import Path
from contextlib import contextmanager
from contextvars import ContextVar
from .store import canonical,digest
from . import material_storage as storage

FORMAT='material-archive-reference-v1'
TOKEN=re.compile(r'"(?:[^"\\]|\\.)*"|[^\"]+',re.S)


_ACTIVE_READER=ContextVar('material_archive_reader',default=None)


@contextmanager
def read_scope(store, root=None):
    """Use the caller's transaction for this instance's immutable content."""
    root=Path(root).resolve() if root is not None else store.db_path.parent.parent.resolve()
    cache={};token=_ACTIVE_READER.set((store,cache,root))
    try:yield
    finally:
        cache.clear()
        _ACTIVE_READER.reset(token)


def encode(store,data):
    text=data.decode('utf-8')
    json.loads(text)  # metadata JSON only; never process real media
    pieces=[]
    for match in TOKEN.finditer(text):
        token=match.group(0)
        if token.startswith('"'):
            value=json.loads(token)
            raw_forms=[json.dumps(value,ensure_ascii=False),json.dumps(value,ensure_ascii=True)]
            if token in raw_forms:index=raw_forms.index(token)
            else:index=min(range(2),key=lambda i:len(token)+len(raw_forms[i])-2*sum(b.size for b in difflib.SequenceMatcher(None,raw_forms[i],token,autojunk=False).get_matching_blocks()))
            base=raw_forms[index]
            nested=None
            if value.lstrip().startswith(('{','[')):
                try:
                    if isinstance(json.loads(value),(dict,list)):nested=encode(store,value.encode('utf-8'))
                except ValueError:pass
            part={'archive':nested} if nested else {'content':storage.intern(store,value)}
            part['encoding']='json-ascii' if index else 'json-utf8'
            if base!=token:
                part['edits']=[[i1,i2,token[j1:j2]] for tag,i1,i2,j1,j2 in difflib.SequenceMatcher(None,base,token,autojunk=False).get_opcodes() if tag!='equal']
        else:
            part={'content':storage.intern(store,token),'encoding':'text'}
        pieces.append(part)
    if ''.join(m.group(0) for m in TOKEN.finditer(text))!=text:raise ValueError('archive tokenization lost bytes')
    return {'format':FORMAT,'sha256':digest(data),'bytes':len(data),'recipe':storage.intern_recipe(store,pieces)}


def decode(document,resolve):
    if document.get('format')!=FORMAT:raise ValueError('unsupported archive reference')
    parts=[]
    for item in document.get('pieces',[]) if 'pieces' in document else resolve(document['recipe']):
        value=decode(item['archive'],resolve).decode('utf-8') if 'archive' in item else resolve(item['content'])
        if not isinstance(value,str):raise ValueError('archive token is not text')
        encoding=item['encoding']
        if encoding=='text':text=value
        elif encoding in ('json-ascii','json-utf8'):text=json.dumps(value,ensure_ascii=encoding=='json-ascii')
        else:raise ValueError('unsupported archive encoding')
        previous=len(text)+1
        for start,end,replacement in reversed(item.get('edits',[])):
            if type(start)is not int or type(end)is not int or not 0<=start<=end<previous:raise ValueError('invalid archive edit')
            text=text[:start]+replacement+text[end:];previous=start
        parts.append(text)
    raw=''.join(parts).encode('utf-8')
    if len(raw)!=document['bytes'] or digest(raw)!=document['sha256']:raise ValueError('archive reconstruction checksum mismatch')
    return raw


def reference(path):
    path=Path(path)
    if path.suffix.lower()!='.json':return None
    with path.open('rb') as stream:head=stream.read(160)
    if FORMAT.encode() not in head:return None
    value=json.loads(path.read_bytes())
    return value if value.get('format')==FORMAT else None


def instance_root(path):
    path=Path(path).resolve()
    for parent in path.parents:
        if any((parent/name).is_file() for name in ('config/instance.json','.runtime/review.sqlite3','export/material-content.json')):return parent
        if parent.name=='export' and (parent/'material-content.json').is_file():return parent.parent
    raise ValueError('archive is outside a known instance')


def resolver(path):
    """Read live immutable content first; exported graphs support empty recovery."""
    import sqlite3
    root=instance_root(path)
    database=root/'.runtime/review.sqlite3'
    active=_ACTIVE_READER.get()
    if active is not None and active[2]==root:
        store,cache,_=active
        def scoped_get(key):return storage.expand(store,key,cache=cache)
        # Cache only this file's token graph, not every archive in a restore.
        scoped_get.close=cache.clear
        scoped_get.clear=cache.clear
        return scoped_get
    connection=None;export_connection=None;export_directory=None;cache={}
    if database.is_file():
        connection=sqlite3.connect(database.as_uri()+'?mode=ro',uri=True)
        if not connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='material_content'").fetchone():
            connection.close();connection=None
    content_file=root/'export/material-content.json'
    def get(key,visiting=None):
        nonlocal export_connection,export_directory
        if key in cache:return cache[key]
        found=connection.execute('SELECT body FROM material_content WHERE id=?',(key,)).fetchone() if connection else None
        body=found[0] if found else None
        if body is None:
            if export_connection is None:
                if not content_file.is_file():raise ValueError('archive content graph is missing')
                import tempfile
                from .material_content_stream import rows
                export_directory=tempfile.TemporaryDirectory(prefix='review-material-read-')
                export_connection=sqlite3.connect(Path(export_directory.name)/'content.sqlite3')
                export_connection.execute('PRAGMA cache_size=-2048')
                export_connection.execute('CREATE TABLE content(id TEXT PRIMARY KEY,body TEXT NOT NULL)')
                with export_connection:
                    export_connection.executemany('INSERT INTO content VALUES (?,?)',((r['id'],r['body']) for r in rows(content_file)))
            found=export_connection.execute('SELECT body FROM content WHERE id=?',(key,)).fetchone()
            body=found[0] if found else None
        if body is None or digest(body.encode())!=key:raise ValueError('missing archive content')
        visiting=set() if visiting is None else visiting
        if key in visiting:raise ValueError('cyclic archive content')
        visiting.add(key);node=json.loads(body)
        if set(node)=={'value'}:value=node['value']
        elif set(node)=={'array'}:value=[get(v,visiting) for v in node['array']]
        elif set(node)=={'object'}:value={k:get(v,visiting) for k,v in node['object']}
        elif set(node)=={'archive_recipe'}:value=node['archive_recipe']
        elif set(node)=={'archive_recipe_zlib'}:
            packed=json.loads(zlib.decompress(base64.b64decode(node['archive_recipe_zlib'],validate=True)))
            value=[packed['tokens'][i] for i in packed['order']] if isinstance(packed,dict) else packed
        else:raise ValueError('invalid archive content node')
        visiting.remove(key);cache[key]=value
        return value
    def close():
        nonlocal connection,export_connection,export_directory
        if connection is not None:connection.close();connection=None
        if export_connection is not None:export_connection.close();export_connection=None
        if export_directory is not None:export_directory.cleanup();export_directory=None
        cache.clear()
    get.close=close
    get.clear=cache.clear
    return get


def read_bytes(path):
    doc=reference(path)
    if not doc:return Path(path).read_bytes()
    resolve=resolver(path)
    try:return decode(doc,resolve)
    finally:resolve.close()


def read_json(path):
    return json.loads(read_bytes(path))


def logical_size(path):
    doc=reference(path)
    return doc['bytes'] if doc else Path(path).stat().st_size
