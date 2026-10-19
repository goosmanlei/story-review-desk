"""Version-pinned project resources, verified local cache, and private OSS access.

The catalog contains durable identities, never credentials or signed URLs. OSS
is optional for old complete local bundles; a configured cloud instance fails
closed for unregistered paths instead of falling back to stale local originals.
"""
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import timedelta
import fcntl
import hashlib
import json
import mimetypes
import os
from pathlib import Path, PurePosixPath
import re
import tempfile
import threading
import time
from urllib.parse import quote

FORMAT = 'project-resources-v1'
_leases = ContextVar('resource_leases', default=None)
_transfers = threading.BoundedSemaphore(3)
_catalog_cache = {}
_catalog_guard = threading.Lock()
_signed_cache = {}
_signed_guard = threading.Lock()
_frozen = ContextVar('resource_preflight_frozen', default=False)


def service_status(error):
    for _ in range(8):
        if hasattr(error, 'status_code'):
            return error.status_code
        error = error.unwrap() if hasattr(error, 'unwrap') else None
        if error is None:
            break
    return None


@contextmanager
def frozen_scope():
    token = _frozen.set(True)
    try:
        yield
    finally:
        _frozen.reset(token)


def safe_path(value):
    if (not isinstance(value, str) or not value or '\\' in value or
            str(PurePosixPath(value)) != value or PurePosixPath(value).is_absolute() or
            any(x in ('..', '.') for x in PurePosixPath(value).parts)):
        raise ValueError('unsafe resource path')
    return value


def contained(root, relative):
    current = Path(root).resolve()
    for part in PurePosixPath(safe_path(relative)).parts:
        current /= part
        if current.is_symlink():
            raise ValueError('resource path cannot contain a symlink')
    return current


def hash_file(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='.' + path.name + '-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as target:
            json.dump(value, target, ensure_ascii=False, sort_keys=True, indent=2)
            target.write('\n')
            target.flush()
            os.fsync(target.fileno())
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def settings(root):
    path = contained(root, 'config/resource-storage.json')
    if not path.is_file():
        return None
    value = json.loads(path.read_text())
    instance = json.loads(contained(root, 'config/instance.json').read_text())
    if (value.get('format') != FORMAT or value.get('provider') != 'oss' or
            value.get('instance_id') != instance.get('id') or
            not re.fullmatch(r'[a-z0-9][a-z0-9-]{1,62}', value.get('project', '')) or
            not re.fullmatch(r'[a-z0-9][a-z0-9-]{1,61}[a-z0-9]', value.get('bucket', '')) or
            not re.fullmatch(r'[a-z0-9-]+', value.get('region', ''))):
        raise ValueError('invalid project resource configuration')
    return value


def offline_mode():
    return os.environ.get('REVIEW_RESOURCES_OFFLINE') == '1'


def require_local_cleanup(root):
    if settings(root):
        raise ValueError('legacy physical cleanup cannot delete cloud resources; use a separately reviewed project cloud cleanup')


def content_identity(spec):
    return tuple(spec.get(k) for k in ('sha256', 'bytes', 'mime'))


def storage_identity(spec):
    return (spec.get('source', 'oss'), spec.get('key'), spec.get('version_id'), *content_identity(spec))


def _promoted(before, after):
    return (before.get('source') == 'offline-candidate' and after.get('source', 'oss') == 'oss'
            and content_identity(before) == content_identity(after)
            and set(before.get('variants', {})) == set(after.get('variants', {}))
            and all(content_identity(value) == content_identity(after['variants'][name])
                    for name, value in before.get('variants', {}).items()))


def _catalog(root, config, *, allow_offline=None):
    allow_offline = offline_mode() if allow_offline is None else allow_offline
    paths = [contained(root, 'config/resource-catalog.json'), contained(root, '.runtime/resources/catalog.json')]
    identity = tuple((str(p), p.stat().st_mtime_ns, p.stat().st_size) if p.exists() else (str(p), None) for p in paths)
    key = (str(Path(root).resolve()), identity, allow_offline)
    with _catalog_guard:
        if key in _catalog_cache:
            return _catalog_cache[key]
    entries = {}
    for path in paths:
        if not path.is_file():
            continue
        value = json.loads(path.read_text())
        if any(value.get(k) != config.get(k) for k in ('project', 'bucket', 'region')) or value.get('format') != FORMAT:
            raise ValueError('resource catalog belongs to another project')
        for relative, spec in value['entries'].items():
            safe_path(relative)
            if (relative in entries and storage_identity(entries[relative]) != storage_identity(spec)
                    and not _promoted(entries[relative], spec)):
                raise ValueError('resource catalog conflicts with its published version')
            entries[relative] = spec
    for spec in entries.values():
        for selected in (spec, *spec.get('variants', {}).values()):
            validate_descriptor(config, selected, allow_offline=allow_offline)
    with _catalog_guard:
        if len(_catalog_cache) >= 8:
            _catalog_cache.clear()
        _catalog_cache[key] = entries
    return entries


def descriptor(root, relative, variant=None):
    config = settings(root)
    if config is None:
        return None
    spec = _catalog(root, config).get(safe_path(relative))
    if spec is None:
        raise FileNotFoundError('resource is not registered: ' + relative)
    if variant:
        if variant not in ('small', 'large', 'poster', 'waveform'):
            raise ValueError('invalid display variant')
        spec = spec.get('variants', {}).get(variant)
        if spec is None:
            raise FileNotFoundError('display derivative is not registered')
    validate_descriptor(config, spec)
    return spec


def validate_descriptor(config, spec, *, allow_offline=None):
    if (not re.fullmatch(r'[0-9a-f]{64}', spec.get('sha256', '')) or
            type(spec.get('bytes')) is not int or spec['bytes'] < 1 or
            not isinstance(spec.get('mime'), str) or not re.fullmatch(r'[\w.+-]+/[\w.+-]+', spec['mime']) or
            spec.get('verified_sha256') != spec['sha256']):
        raise ValueError('resource lacks a verified exact content identity')
    if spec.get('source') == 'offline-candidate':
        allowed = offline_mode() if allow_offline is None else allow_offline
        if (not allowed or 'key' in spec or 'version_id' in spec or
                spec.get('verification') != 'full-local-sha256' or
                spec.get('category') not in ('originals', 'derivatives', 'snapshots/local', 'snapshots/vps')):
            raise ValueError('offline candidate requires explicit offline mode and local-only identity')
        return
    key = safe_path(spec.get('key'))
    if (spec.get('source', 'oss') != 'oss' or not key.startswith(config['project'] + '/') or
            not isinstance(spec.get('version_id'), str) or not spec['version_id'] or
            spec['version_id'] == 'null'):
        raise ValueError('resource lacks a verified exact cloud version')


def _credentials(config, *, administrative=False):
    if offline_mode():
        raise ValueError('cloud access is disabled for this offline instance')
    import alibabacloud_oss_v2 as oss
    # Runtime never reads the account-level CLI credentials. This opt-in exists
    # only for the explicit migration/admin CLI, on the user's own workstation.
    if administrative:
        document = json.loads((Path.home() / '.aliyun/config.json').read_text())
        selected = next(p for p in document['profiles'] if p['name'] == document['current'])
        if selected.get('mode') != 'AK' or selected.get('region_id') != config['region']:
            raise ValueError('expected the existing AK profile in the configured region')
        key, secret = selected['access_key_id'], selected['access_key_secret']
    else:
        filename = os.environ.get('REVIEW_OSS_CREDENTIALS_FILE')
        if filename:
            path = Path(filename)
            if path.is_symlink() or path.stat().st_mode & 0o077:
                raise ValueError('runtime credentials must be a private regular file')
            value = json.loads(path.read_text())
            if value.get('project') != config['project']:
                raise ValueError('runtime credentials belong to another project')
            instance = os.environ.get('REVIEW_RESOURCE_INSTANCE', 'local')
            if instance not in ('local', 'vps') or value.get('instance') != instance:
                raise ValueError('runtime credentials belong to another instance')
            key, secret = value['access_key_id'], value['access_key_secret']
        else:
            key, secret = os.environ.get('REVIEW_OSS_ACCESS_KEY_ID'), os.environ.get('REVIEW_OSS_ACCESS_KEY_SECRET')
            if not key or not secret:
                raise ValueError('project OSS runtime credentials are unavailable')
    credentials = oss.credentials.StaticCredentialsProvider(key, secret)
    identity = hashlib.sha256(json.dumps([key, secret], separators=(',', ':')).encode()).hexdigest()
    return credentials, identity


def _connection(config, credentials):
    import alibabacloud_oss_v2 as oss
    return oss.Client(oss.Config(region=config['region'], credentials_provider=credentials,
                                retry_max_attempts=1, connect_timeout=15, readwrite_timeout=60))


def client(config, *, administrative=False):
    credentials, _ = _credentials(config, administrative=administrative)
    return _connection(config, credentials)


def _remote_hash(connection, config, spec, destination=None):
    if offline_mode():
        raise ValueError('cloud access is disabled for this offline instance')
    validate_descriptor(config, {**spec, 'verified_sha256': spec['sha256']}, allow_offline=False)
    import alibabacloud_oss_v2 as oss
    h, size = hashlib.sha256(), 0
    try:
        response = connection.get_object(oss.GetObjectRequest(bucket=config['bucket'], key=spec['key'], version_id=spec['version_id']))
    except Exception as error:
        raise ValueError('exact cloud resource unavailable (status ' + str(service_status(error)) + ')') from None
    try:
        if (response.content_type or '').split(';',1)[0].lower() != spec['mime'].lower():
            raise ValueError('cloud resource MIME differs from the exact descriptor')
        for block in response.body.iter_bytes(chunk_size=1024 * 1024):
            size += len(block)
            if size > spec['bytes']:
                raise ValueError('cloud resource exceeds declared size')
            h.update(block)
            if destination is not None:
                destination.write(block)
    finally:
        response.body.close()
    if size != spec['bytes'] or h.hexdigest() != spec['sha256']:
        raise ValueError('cloud resource full-byte verification failed')
    return response


def verify_remote(root, spec):
    """Verify one explicit cloud version, independently of the content cache."""
    config=settings(root)
    validate_descriptor(config,spec,allow_offline=False)
    with _transfers:
        _remote_hash(client(config),config,spec)


@contextmanager
def lease_scope():
    if _leases.get() is not None:
        yield
        return
    locks = {}
    token = _leases.set(locks)
    try:
        yield
    finally:
        for lock, identity in locks.values():
            lock.close()
        _leases.reset(token)


def _cache_dir(root):
    directory = contained(root, '.runtime/resource-cache')
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def _trim(root, incoming, maximum):
    directory = _cache_dir(root)
    # Called only with .capacity.lock held. All resolver downloads hold that
    # same lock for their complete lifetime, so these exact temp names are
    # interrupted writes, not another active download.
    for path in directory.iterdir():
        if re.fullmatch(r'(?:tmp[a-z0-9_]{8}|\.download-[a-z0-9_]{8})\.part',path.name) and path.is_file() and not path.is_symlink():
            path.unlink()
    files = sorted((p for p in directory.iterdir() if p.is_file() and not p.name.endswith('.lock')), key=lambda p: p.stat().st_atime_ns)
    total = sum(p.stat().st_size for p in files)
    for path in files:
        if total + incoming <= maximum:
            break
        if path.name.endswith('.part'):
            continue  # unknown leftovers count against capacity, never delete
        with (directory / (path.name + '.lock')).open('a') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                continue
            size = path.stat().st_size
            path.unlink()
            total -= size
    if total + incoming > maximum:
        raise ValueError('resource cache capacity is leased; release inputs before retrying')


def _lock(stream, mode):
    deadline = time.monotonic() + 120
    while True:
        try:
            fcntl.flock(stream, mode | fcntl.LOCK_NB)
            return
        except BlockingIOError:
            if time.monotonic() >= deadline:
                raise ValueError('resource cache is busy; retry after the active operation')
            time.sleep(.05)


def materialize(root, relative, *, spec=None, administrative=False):
    config = settings(root)
    if config is None:
        return contained(root, relative)
    spec = descriptor(root, relative) if spec is None else spec
    validate_descriptor(config, spec)
    if spec.get('source') == 'offline-candidate':
        media = contained(root, 'resource-bundle/' + spec['sha256'])
        if not media.is_file() or media.stat().st_size != spec['bytes'] or hash_file(media) != spec['sha256']:
            raise ValueError('durable offline candidate is missing or corrupt')
    directory = _cache_dir(root)
    suffix = Path(relative).suffix
    target = contained(directory, spec['sha256'] + suffix)
    held = _leases.get()
    if held is not None and str(target) in held:
        stat = target.stat()
        if (stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns) != held[str(target)][1]:
            raise ValueError('leased resource was changed')
        return target
    if _frozen.get():
        raise ValueError('resource was not preflighted before the database transaction')
    lock = contained(directory, target.name + '.lock').open('a')
    try:
        # Hits acquire SH directly: A/B render inputs can be acquired in either
        # order without two readers waiting forever for each other's EX lock.
        _lock(lock, fcntl.LOCK_SH)
        valid = target.is_file() and target.stat().st_size == spec['bytes'] and hash_file(target) == spec['sha256']
        if not valid:
            fcntl.flock(lock, fcntl.LOCK_UN)
            _lock(lock, fcntl.LOCK_EX)
            # Another downloader may have completed while we changed locks.
            valid = target.is_file() and target.stat().st_size == spec['bytes'] and hash_file(target) == spec['sha256']
        if not valid:
            target.unlink(missing_ok=True)
            offline = offline_mode()
            media = contained(root, 'resource-bundle/' + spec['sha256'])
            if offline and not media.is_file():
                raise FileNotFoundError('exact offline resource is unavailable')
            maximum = config.get('cache_bytes', 16 * 1024 ** 3)
            with (directory / '.capacity.lock').open('a') as capacity:
                fcntl.flock(capacity, fcntl.LOCK_EX)
                _trim(root, spec['bytes'], maximum)
                fd, temporary = tempfile.mkstemp(prefix='.download-',suffix='.part', dir=directory)
                try:
                    with os.fdopen(fd, 'wb') as out, _transfers:
                        if offline:
                            import shutil
                            with media.open('rb') as source:
                                shutil.copyfileobj(source, out, 1024 * 1024)
                        else:
                            _remote_hash(client(config, administrative=administrative), config, spec, out)
                        out.flush()
                        os.fsync(out.fileno())
                    if Path(temporary).stat().st_size != spec['bytes'] or hash_file(temporary) != spec['sha256']:
                        raise ValueError('resource cache verification failed')
                    os.replace(temporary, target)
                finally:
                    Path(temporary).unlink(missing_ok=True)
        fcntl.flock(lock, fcntl.LOCK_SH)
        if held is not None:
            old = held.get(str(target))
            if old:
                old[0].close()
            stat = target.stat()
            held[str(target)] = (lock, (stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns))
            lock = None
        return target
    finally:
        if lock is not None:
            lock.close()


def download_name(relative, requested=None):
    name = requested or Path(relative).name
    if (not isinstance(name,str) or not 1 <= len(name) <= 200 or name != Path(name).name
            or any(ord(char) < 32 or char in ('\\','/') for char in name)):
        raise ValueError('invalid original download filename')
    return name


def signed_url(root, relative, *, variant=None, download=False, filename=None, method='GET', refresh=False):
    import alibabacloud_oss_v2 as oss
    config = settings(root)
    spec = descriptor(root, relative, variant)
    validate_descriptor(config, spec, allow_offline=False)
    if method not in ('GET', 'HEAD'):
        raise ValueError('unsupported resource read method')
    args = dict(bucket=config['bucket'], key=spec['key'], version_id=spec['version_id'])
    if method == 'GET' and download:
        args['response_content_disposition'] = "attachment; filename*=UTF-8''" + quote(download_name(relative,filename))
    request = oss.GetObjectRequest(**args) if method == 'GET' else oss.HeadObjectRequest(**args)
    # Revalidate ownership and credentials even on a warm hit. Stable short-lived
    # URLs let the browser reuse exact object bytes; signatures never go to disk.
    credentials, identity = _credentials(config)
    key = (str(Path(root).resolve()), config['project'], config['bucket'], config['region'],
           os.environ.get('REVIEW_RESOURCE_INSTANCE', 'local'), identity,
           storage_identity(spec), method, args.get('response_content_disposition'))
    with _signed_guard:
        now = time.monotonic()
        cached = _signed_cache.get(key)
        if not refresh and cached and now < cached[0]:
            return cached[1]
        url = _connection(config, credentials).presign(request, expires=timedelta(seconds=900)).url
        _signed_cache.pop(key, None)
        while len(_signed_cache) >= 512:
            _signed_cache.pop(next(iter(_signed_cache)))
        _signed_cache[key] = (now + 300, url)
        return url


def remote_etag(root, spec):
    import alibabacloud_oss_v2 as oss
    config=settings(root);validate_descriptor(config,spec,allow_offline=False)
    try:
        result=client(config).head_object(oss.HeadObjectRequest(bucket=config['bucket'],key=spec['key'],version_id=spec['version_id']))
    except Exception as error:
        raise ValueError('exact cloud resource unavailable (status '+str(service_status(error))+')') from None
    if result.content_length!=spec['bytes']:
        raise ValueError('cloud resource size differs from its verified version')
    return '"'+result.etag.strip('"')+'"'


def upload(root, source, *, category='originals', administrative=False, expected_sha=None, mime=None):
    """Idempotently put and fully read back; an uncertain PUT is queried first."""
    import alibabacloud_oss_v2 as oss
    config = settings(root)
    if not config:
        raise ValueError('resource storage is not configured')
    if category not in ('originals', 'derivatives', 'snapshots/local', 'snapshots/vps') and not re.fullmatch(r'tests/[a-z0-9-]+', category):
        raise ValueError('unsupported resource category')
    source = Path(source)
    before = source.stat()
    digest = hash_file(source)
    if expected_sha and digest != expected_sha:
        raise ValueError('source checksum differs from expected original')
    if mime is None:
        from .production_media import MIMES
        mime = MIMES.get(source.suffix.lower()) or mimetypes.guess_type(source.name)[0] or 'application/octet-stream'
    spec = {'sha256': digest, 'bytes': before.st_size,
            'mime': mime,
            'key': config['project'] + '/' + category + '/' + digest[:2] + '/' + digest}
    namespace=config.get('test_namespace')
    if namespace:
        instance=os.environ.get('REVIEW_RESOURCE_INSTANCE','local')
        if instance not in ('local','vps') or not re.fullmatch(r'task-[a-z0-9-]+',namespace):
            raise ValueError('invalid isolated resource namespace')
        spec['key']=config['project']+'/tests/'+instance+'/'+namespace+'/'+category+'/'+digest[:2]+'/'+digest
    if not spec['bytes'] or spec['bytes'] > 8 * 1024 ** 3:
        raise ValueError('resource exceeds the 8 GiB upload bound')
    if offline_mode():
        return _save_offline(root, source, spec, category, before)
    connection = client(config, administrative=administrative)
    def existing():
        try:
            return connection.head_object(oss.HeadObjectRequest(bucket=config['bucket'], key=spec['key']))
        except Exception as exc:
            if service_status(exc) == 404:
                return None
            raise ValueError('cloud resource lookup denied or unavailable') from None
    with _transfers:
        head = existing()
        # A previous object version with generic metadata is retained, while a
        # corrected version receives the verified local bytes and explicit MIME.
        if head is None or (head.content_type or '').split(';',1)[0].lower()!=spec['mime'].lower():
            try:
                if spec['bytes']>128*1024**2:
                    result=_multipart(root,connection,config,spec,source)
                else:
                    with source.open('rb') as body:
                        result = connection.put_object(oss.PutObjectRequest(bucket=config['bucket'], key=spec['key'],
                            body=body, content_length=spec['bytes'], content_type=spec['mime'],
                            cache_control='private, max-age=86400, immutable',
                            metadata={'sha256': digest}))
                version = result.version_id
            except Exception:
                # No second PUT until the same content-addressed key is queried.
                head = existing()
                if head is None:
                    raise ValueError('upload result unknown; query this exact key before retrying') from None
                version = head.version_id
        else:
            version = head.version_id
        if not version or version == 'null':
            raise ValueError('bucket must preserve explicit object versions')
        spec['version_id'] = version
        response = _remote_hash(connection, config, spec)
        after = source.stat()
        if (after.st_ino, after.st_size, after.st_mtime_ns) != (before.st_ino, before.st_size, before.st_mtime_ns):
            raise ValueError('source changed during upload')
        spec.update(verified_sha256=digest, verified_at=int(time.time()))
        return spec


def _save_offline(root, source, spec, category, before):
    """Keep new originals durably outside Git, independently of evictable cache."""
    root = Path(root).resolve()
    if any((parent / '.git').exists() for parent in (root, *root.parents)):
        raise ValueError('offline candidate instance must be outside every Git repository')
    if category not in ('originals', 'derivatives', 'snapshots/local', 'snapshots/vps'):
        raise ValueError('unsupported offline candidate category')
    directory = contained(root, 'resource-bundle')
    directory.mkdir(parents=True, exist_ok=True)
    target = contained(directory, spec['sha256'])
    with (directory / (spec['sha256'] + '.lock')).open('a') as lock:
        _lock(lock, fcntl.LOCK_EX)
        if target.exists() and (target.stat().st_size != spec['bytes'] or hash_file(target) != spec['sha256']):
            raise ValueError('existing durable offline candidate is corrupt')
        if not target.exists():
            fd, temporary = tempfile.mkstemp(prefix='.candidate-', suffix='.part', dir=directory)
            try:
                digest, size = hashlib.sha256(), 0
                with os.fdopen(fd, 'wb') as out, source.open('rb') as incoming:
                    for block in iter(lambda: incoming.read(1024 * 1024), b''):
                        size += len(block)
                        if size > spec['bytes']:
                            raise ValueError('offline source exceeds declared size')
                        digest.update(block); out.write(block)
                    out.flush(); os.fsync(out.fileno())
                if size != spec['bytes'] or digest.hexdigest() != spec['sha256']:
                    raise ValueError('offline source checksum changed')
                os.replace(temporary, target)
            finally:
                Path(temporary).unlink(missing_ok=True)
        after = source.stat()
        if ((before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) !=
                (after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)):
            raise ValueError('offline source changed during publication')
    return {k: spec[k] for k in ('sha256', 'bytes', 'mime')} | {
        'source': 'offline-candidate', 'category': category, 'verification': 'full-local-sha256',
        'verified_sha256': spec['sha256'], 'verified_at': int(time.time())}


def _multipart(root, connection, config, spec, source):
    """One 32 MiB part in memory, durable upload ID, exact resume reconciliation."""
    import alibabacloud_oss_v2 as oss
    directory=contained(root,'.runtime/resources/uploads');directory.mkdir(parents=True,exist_ok=True)
    identifier=hashlib.sha256(spec['key'].encode()).hexdigest()
    path=directory/(identifier+'.json')
    with (directory/(identifier+'.lock')).open('a') as lock:
        _lock(lock,fcntl.LOCK_EX)
        if path.exists():
            checkpoint=json.loads(path.read_text())
            if any(checkpoint.get(k)!=spec[k] for k in ('key','sha256','bytes','mime')):
                raise ValueError('multipart checkpoint identity differs')
            if not checkpoint.get('upload_id'):
                raise ValueError('multipart initiation result unknown; reconcile this exact key before retrying')
        else:
            checkpoint={k:spec[k] for k in ('key','sha256','bytes','mime')}
            atomic_json(path,checkpoint)
            result=connection.initiate_multipart_upload(oss.InitiateMultipartUploadRequest(
                bucket=config['bucket'],key=spec['key'],content_type=spec['mime'],
                cache_control='private, max-age=86400, immutable',metadata={'sha256':spec['sha256']}))
            checkpoint['upload_id']=result.upload_id
            atomic_json(path,checkpoint)
        args={'bucket':config['bucket'],'key':spec['key'],'upload_id':checkpoint['upload_id']}
        # At most 256 parts for the existing 8 GiB application limit.
        listed=connection.list_parts(oss.ListPartsRequest(**args,max_parts=1000))
        parts={p.part_number:p for p in (listed.parts or [])}
        completed=[]
        before=source.stat();stream_hash=hashlib.sha256();total=0
        with source.open('rb') as stream:
            number=0
            while block:=stream.read(32*1024**2):
                total+=len(block)
                if total>spec['bytes']:
                    raise ValueError('multipart source exceeds its declared size')
                stream_hash.update(block)
                number+=1;expected=hashlib.md5(block).hexdigest().upper()
                part=parts.get(number)
                if part is not None and (part.size!=len(block) or part.etag.strip('"').upper()!=expected):
                    raise ValueError('multipart cloud part differs from exact original')
                if part is None:
                    part=connection.upload_part(oss.UploadPartRequest(**args,part_number=number,body=block,content_length=len(block)))
                if part.etag.strip('"').upper()!=expected:
                    raise ValueError('multipart transport checksum failed')
                completed.append(oss.UploadPart(part_number=number,etag=part.etag))
        after=source.stat()
        if (total!=spec['bytes'] or stream_hash.hexdigest()!=spec['sha256'] or
                (before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns) !=
                (after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns)):
            raise ValueError('multipart source changed; upload was not completed')
        result=connection.complete_multipart_upload(oss.CompleteMultipartUploadRequest(**args,
            complete_multipart_upload=oss.CompleteMultipartUpload(parts=completed)))
        checkpoint['completed_version_id']=result.version_id
        atomic_json(path,checkpoint)
        return result


def register(root, relative, spec):
    config = settings(root)
    validate_descriptor(config, spec)
    for selected in spec.get('variants', {}).values():
        validate_descriptor(config, selected)
    safe_path(relative)
    directory = contained(root, '.runtime/resources')
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / 'catalog.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        path = directory / 'catalog.json'
        value = json.loads(path.read_text()) if path.exists() else {k: config[k] for k in ('format', 'project', 'bucket', 'region')}
        current = _catalog(root, config).get(relative)
        if current and storage_identity(current) != storage_identity(spec):
            # A concurrent identical upload may create a retained duplicate OSS
            # version. Keep the first verified exact catalog identity.
            if current.get('source') == 'offline-candidate' and spec.get('source', 'oss') == 'oss':
                raise ValueError('use explicit resource promotion for offline candidates')
            if content_identity(current) == content_identity(spec):
                return current
            raise ValueError('cannot replace an immutable resource path')
        value.setdefault('entries', {})[relative] = spec
        atomic_json(path, value)
        return spec


def promote(root):
    """Upload every local candidate, then atomically expose the complete cloud catalog."""
    if offline_mode():
        raise ValueError('enable network explicitly before promoting offline candidates')
    config = settings(root)
    original = _catalog(root, config, allow_offline=True)
    entries = {}
    uploaded = {}
    def selected(spec):
        if spec.get('source') != 'offline-candidate':
            validate_descriptor(config, spec, allow_offline=False)
            return dict(spec)
        identity = (spec['category'], *content_identity(spec))
        if identity not in uploaded:
            source = contained(root, 'resource-bundle/' + spec['sha256'])
            if (not source.is_file() or source.stat().st_size != spec['bytes']
                    or hash_file(source) != spec['sha256']):
                raise ValueError('offline candidate checksum differs from its declared content identity')
            cloud = upload(root, source, category=spec['category'], expected_sha=spec['sha256'], mime=spec['mime'])
            if content_identity(cloud) != content_identity(spec):
                raise ValueError('promoted resource differs from its exact offline identity')
            uploaded[identity] = cloud
        result = {k: v for k, v in spec.items() if k not in ('source', 'category', 'verification', 'variants')}
        result.update(uploaded[identity])
        return result
    for name, spec in original.items():
        result = selected(spec)
        if 'variants' in spec:
            result['variants'] = {key: selected(value) for key, value in spec['variants'].items()}
        entries[name] = result
    directory = contained(root, '.runtime/resources')
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / 'catalog.lock').open('a') as lock:
        _lock(lock, fcntl.LOCK_EX)
        if _catalog(root, config, allow_offline=True) != original:
            raise ValueError('candidate catalog changed during promotion; no catalog was replaced')
        value = {k: config[k] for k in ('format', 'project', 'bucket', 'region')}
        value['entries'] = entries
        atomic_json(directory / 'catalog.json', value)
    return {'promoted_objects': len(uploaded), 'entries': len(entries)}


def freeze_catalog(root, destination):
    config = settings(root)
    value = {k: config[k] for k in ('format', 'project', 'bucket', 'region')}
    value['entries'] = _catalog(root, config)
    atomic_json(destination, value)
    return value


def publish_file(root, relative, source, *, expected_sha=None, mime=None):
    """Upload an inspected candidate and derivatives before exposing its identity."""
    from .media_previews import prepare
    spec = upload(root, source, expected_sha=expected_sha, mime=mime)
    variants = (('small','large') if spec['mime'].startswith('image/') else
                ('poster',) if spec['mime'].startswith('video/') else
                ('waveform',) if spec['mime'].startswith('audio/') else ())
    spec['variants'] = {}
    for variant in variants:
        path, preview = prepare(root, source, spec['sha256'], variant, spec['mime'])
        derivative = ({k:v for k,v in spec.items() if k != 'variants'} if preview['sha256'] == spec['sha256'] else
                      upload(root, path, category='derivatives', expected_sha=preview['sha256'], mime=preview['mime']))
        derivative.update({k:v for k,v in preview.items() if k not in ('sha256','bytes')})
        spec['variants'][variant] = derivative
    return register(root, relative, spec)
