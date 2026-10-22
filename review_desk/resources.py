"""Version-pinned project resources, verified local cache, and private OSS access.

The catalog contains durable identities, never credentials or signed URLs. OSS
is optional for old complete local bundles; a configured cloud instance fails
closed for unregistered paths instead of falling back to stale local originals.
"""
from contextlib import contextmanager, nullcontext
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
_settings_cache = {}
_settings_guard = threading.Lock()
_verified = {}
_verified_guard = threading.Lock()
_cancel = ContextVar('resource_cancel', default=None)
_read_options = ContextVar('resource_read_options', default={})
_statistics = ContextVar('resource_read_statistics', default=None)


def read_policy():
    policy = _read_options.get().get('policy', os.environ.get('REVIEW_RESOURCE_READ_POLICY', 'local-first'))
    if policy not in ('local-first', 'local-only', 'remote'):
        raise ValueError('invalid resource read policy')
    return policy


def require_network():
    if offline_mode() or read_policy() == 'local-only' or _read_options.get().get('medium_only'):
        raise ValueError('cloud access is disabled by the resource read policy')


@contextmanager
def read_scope(policy=None, *, sources=None, medium_only=False):
    """Control reads without changing upload/offline-candidate semantics."""
    options = dict(_read_options.get())
    if read_policy() == 'local-only' and policy not in (None, 'local-only'):
        raise ValueError('local-only resource scope cannot enable cloud access')
    if policy is not None:
        options['policy'] = policy
    if sources is not None:
        options['sources'] = list(sources)
    options['medium_only'] = medium_only or options.get('medium_only', False)
    token = _read_options.set(options)
    try:
        read_policy()
        yield
    finally:
        _read_options.reset(token)


@contextmanager
def read_statistics():
    counts = dict(oss_gets=0, oss_bytes=0, cache_hits=0, source_copies=0, source_hits=0,
                  local_bytes=0, fetched_objects=0, remote_verifications=0)
    token = _statistics.set(counts)
    try:
        yield counts
    finally:
        _statistics.reset(token)


def _count(**values):
    counts = _statistics.get()
    if counts is not None:
        for key, value in values.items():
            counts[key] += value


def set_local_sources(root, sources, *, append=False):
    """Register bounded, explicitly selected instance roots; never scan worktrees."""
    config = settings(root)
    registry = contained(root, '.runtime/resources/local-sources.json')
    previous = json.loads(registry.read_text()) if append and registry.is_file() else {'format': 'local-resource-sources-v1', 'sources': []}
    if previous.get('format') != 'local-resource-sources-v1' or not isinstance(previous.get('sources'), list):
        raise ValueError('invalid local resource source registry')
    selected = list(previous['sources'])
    inherited = []
    for source in sources:
        source = Path(source).resolve(strict=True)
        # Carry a parent instance's explicitly registered recovery sources into
        # a new task. This is a bounded registry read, not filesystem discovery.
        inherited.extend(_source_roots(source, config))
    for source in inherited:
        other = settings(source)
        if not other or any(other[k] != config[k] for k in ('project', 'bucket', 'region', 'instance_id')):
            raise ValueError('local resource source belongs to another instance')
        relative = os.path.relpath(source, Path(root).resolve())
        if relative not in selected and source != Path(root).resolve():
            selected.append(relative)
    if len(selected) > 16:
        raise ValueError('too many local resource sources')
    atomic_json(registry,
                {'format': 'local-resource-sources-v1', 'sources': selected})


def _source_roots(root, config):
    root = Path(root).resolve()
    yield root
    if offline_mode() or _read_options.get().get('medium_only'):
        return
    sources = _read_options.get().get('sources')
    if sources is None:
        path = contained(root, '.runtime/resources/local-sources.json')
        value = json.loads(path.read_text()) if path.is_file() else {'format': 'local-resource-sources-v1', 'sources': []}
        if value.get('format') != 'local-resource-sources-v1':
            raise ValueError('invalid local resource source registry')
        sources = value['sources']
    if not isinstance(sources, list) or len(sources) > 16:
        raise ValueError('invalid local resource source registry')
    seen = {root}
    for name in sources:
        source = (root / name).resolve()
        if source in seen or not source.is_dir():
            continue
        seen.add(source)
        other = settings(source)
        if not other or any(other[k] != config[k] for k in ('project', 'bucket', 'region', 'instance_id')):
            raise ValueError('local resource source belongs to another instance')
        yield source


@contextmanager
def _local_source(root, relative, spec, target):
    """Hold a source cache's shared lock until its verified bytes are copied."""
    corrupt = False
    for source in _source_roots(root, settings(root)):
        candidates = [(contained(source, 'resource-bundle/' + spec['sha256']), False)]
        if not offline_mode() and not _read_options.get().get('medium_only'):
            # Explicit source instances may retain original files. Their own
            # catalog must name this content; a same-name old file is no fallback.
            try:
                original = descriptor(source, relative)
            except FileNotFoundError:
                original = None
            if original and content_identity(original) == content_identity(spec):
                path = contained(source, relative)
                # Git may hold a small resource-reference document at this
                # logical path. It is metadata, not a damaged original.
                if path.is_file() and path.stat().st_size == spec['bytes']:
                    candidates.append((path, False))
            cache = contained(source, '.runtime/resource-cache')
            candidates += [(contained(cache, p.name), True) for p in sorted(cache.glob(spec['sha256'] + '*'))
                           if re.fullmatch(spec['sha256'] + r'(?:\.[a-zA-Z0-9]+)?', p.name)
                           and p.suffix not in ('.lock', '.part', '.reserve')]
        for path, cached in candidates:
            if path == target or not path.is_file():
                continue
            lock = None
            try:
                if cached:
                    lock = contained(path.parent, path.name + '.lock').open('a')
                    try:
                        fcntl.flock(lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
                    except BlockingIOError:
                        continue
                if not verified_file(path, spec):
                    corrupt = True
                    continue
                yield path
                return
            finally:
                if lock is not None:
                    lock.close()
    if offline_mode() or read_policy() == 'local-only' or _read_options.get().get('medium_only'):
        message = 'exact local resource ' + ('is corrupt: ' if corrupt else 'is unavailable: ') + relative + ' sha256=' + spec['sha256']
        if corrupt:
            raise ValueError(message)
        raise FileNotFoundError(message)
    yield None


def _check_cancel():
    check = _cancel.get()
    if check is not None:
        check()


def verify_stream(stream, sha, size=None):
    """Reuse only bytes already hashed on this exact open-file identity."""
    before = os.fstat(stream.fileno())
    identity = (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
    if size is not None and before.st_size != size:
        raise ValueError('original media size differs from its identity')
    key = (identity, sha)
    with _verified_guard:
        known = key in _verified
    if not known:
        digest = hashlib.sha256()
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            _check_cancel()
            digest.update(block)
        stream.seek(0)
        after = os.fstat(stream.fileno())
        if identity != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise ValueError('original media changed while verifying')
        if digest.hexdigest() != sha:
            raise ValueError('original media checksum differs from its identity')
        with _verified_guard:
            while len(_verified) >= 1024:
                _verified.pop(next(iter(_verified)))
            _verified[key] = True


def verified_file(path, spec):
    if not path.is_file() or path.stat().st_size != spec['bytes']:
        return False
    try:
        with path.open('rb') as stream:
            verify_stream(stream, spec['sha256'], spec['bytes'])
        return True
    except ValueError:
        return False


def file_identity(path):
    """An atomic replacement and an in-place edit both invalidate reuse."""
    stat = path.stat()
    return (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)


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
    instance_path = contained(root, 'config/instance.json')
    key = (str(path), file_identity(path), str(instance_path), file_identity(instance_path))
    with _settings_guard:
        if key in _settings_cache:
            return dict(_settings_cache[key])
    value = json.loads(path.read_text())
    instance = json.loads(instance_path.read_text())
    if (value.get('format') != FORMAT or value.get('provider') != 'oss' or
            value.get('instance_id') != instance.get('id') or
            not re.fullmatch(r'[a-z0-9][a-z0-9-]{1,62}', value.get('project', '')) or
            not re.fullmatch(r'[a-z0-9][a-z0-9-]{1,61}[a-z0-9]', value.get('bucket', '')) or
            not re.fullmatch(r'[a-z0-9-]+', value.get('region', ''))):
        raise ValueError('invalid project resource configuration')
    if key[1] != file_identity(path) or key[3] != file_identity(instance_path):
        raise ValueError('resource configuration changed while reading; retry')
    with _settings_guard:
        if len(_settings_cache) >= 16:
            _settings_cache.clear()
        _settings_cache[key] = value
    return dict(value)


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
    identity = tuple((str(p), file_identity(p)) if p.exists() else (str(p), None) for p in paths)
    key = (str(Path(root).resolve()), identity, allow_offline, config['project'], config['bucket'], config['region'])
    with _catalog_guard:
        actual = tuple((str(p), file_identity(p)) if p.exists() else (str(p), None) for p in paths)
        if actual != identity:
            raise ValueError('resource catalog changed while reading; retry')
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
    actual = tuple((str(p), file_identity(p)) if p.exists() else (str(p), None) for p in paths)
    if actual != identity:
        raise ValueError('resource catalog changed while reading; retry')
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
    require_network()
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
    require_network()
    validate_descriptor(config, {**spec, 'verified_sha256': spec['sha256']}, allow_offline=False)
    import alibabacloud_oss_v2 as oss
    h, size = hashlib.sha256(), 0
    try:
        _count(oss_gets=1)
        response = connection.get_object(oss.GetObjectRequest(bucket=config['bucket'], key=spec['key'], version_id=spec['version_id']))
    except Exception as error:
        raise ValueError('exact cloud resource unavailable (status ' + str(service_status(error)) + ')') from None
    try:
        if (response.content_type or '').split(';',1)[0].lower() != spec['mime'].lower():
            raise ValueError('cloud resource MIME differs from the exact descriptor')
        for block in response.body.iter_bytes(chunk_size=1024 * 1024):
            _count(oss_bytes=len(block))
            _check_cancel()
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


def verify_remote(root, spec, *, relative='verified'):
    """Always GET the exact cloud version; retain newly verified cache bytes."""
    require_network()
    config=settings(root)
    validate_descriptor(config,spec,allow_offline=False)
    materialize(root, relative, spec=spec, _remote=True)
    return {'verification': 'full-remote-sha256', 'verified_at': int(time.time()),
            'bucket': config['bucket'], **{k: spec[k] for k in ('key', 'version_id', 'sha256', 'bytes', 'mime')}}


def verify_content(root, relative, spec):
    """Hash an allowed source in place; full audits need no per-task mirror."""
    validate_descriptor(settings(root), spec)
    with _local_source(root, relative, spec, None) as path:
        if path is None:
            with lease_scope():
                materialize(root, relative, spec=spec)
        else:
            hit = 'cache_hits' if path.parent == contained(root, '.runtime/resource-cache') else 'source_hits'
            _count(**{hit: 1, 'local_bytes': spec['bytes']})


@contextmanager
def lease_scope(check=None):
    if _leases.get() is not None:
        yield
        return
    locks = {}
    token = _leases.set(locks)
    cancellation = _cancel.set(check)
    try:
        yield
    finally:
        for lock, identity in locks.values():
            lock.close()
        _leases.reset(token)
        _cancel.reset(cancellation)


def _cache_dir(root):
    directory = contained(root, '.runtime/resource-cache')
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def _trim(root, incoming, maximum):
    directory = _cache_dir(root)
    # Capacity covers completed bytes plus full reservations, not just partial
    # bytes received so far. An object's EX lock proves its reservation is live.
    reserved, outstanding, active_parts = 0, 0, set()
    for reservation in directory.glob('*.reserve'):
        contained(directory, reservation.name)
        value = json.loads(reservation.read_text())
        name = safe_path(value['target'])
        if '/' in name or reservation.name != name + '.reserve' or type(value['bytes']) is not int or value['bytes'] < 1:
            raise ValueError('invalid resource cache reservation')
        with contained(directory, name + '.lock').open('a') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                reserved += value['bytes']
                active_parts.add(name + '.part')
                part = contained(directory, name + '.part')
                outstanding += max(0, value['bytes'] - (part.stat().st_size if part.exists() else 0))
                continue
            contained(directory, name + '.part').unlink(missing_ok=True)
            reservation.unlink()
    # These names were used by the previous serialized downloader only.
    for path in directory.iterdir():
        if re.fullmatch(r'(?:tmp[a-z0-9_]{8}|\.download-[a-z0-9_]{8})\.part',path.name) and path.is_file() and not path.is_symlink():
            path.unlink()
    files = sorted((p for p in directory.iterdir() if p.is_file() and not p.name.endswith(('.lock', '.reserve')) and p.name not in active_parts), key=lambda p: p.stat().st_atime_ns)
    total = reserved + sum(p.stat().st_size for p in files)
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
    return outstanding


def _lock(stream, mode):
    deadline = time.monotonic() + 120
    while True:
        _check_cancel()
        try:
            fcntl.flock(stream, mode | fcntl.LOCK_NB)
            return
        except BlockingIOError:
            if time.monotonic() >= deadline:
                raise ValueError('resource cache is busy; retry after the active operation')
            time.sleep(.05)


def materialize(root, relative, *, spec=None, administrative=False, _remote=False, _client=None):
    config = settings(root)
    if config is None:
        return contained(root, relative)
    spec = descriptor(root, relative) if spec is None else spec
    validate_descriptor(config, spec)
    # An independent medium must prove its own completeness even with a warm
    # cache. Offline candidates likewise require their durable original.
    medium_only = offline_mode() or _read_options.get().get('medium_only')
    if spec.get('source') == 'offline-candidate' or medium_only:
        media = contained(root, 'resource-bundle/' + spec['sha256'])
        if not media.is_file():
            raise FileNotFoundError('exact local resource is unavailable: ' + relative + ' sha256=' + spec['sha256'])
        if not verified_file(media, spec):
            kind = 'offline candidate' if spec.get('source') == 'offline-candidate' else 'local resource'
            raise ValueError('durable ' + kind + ' is corrupt: ' + relative + ' sha256=' + spec['sha256'])
    if _remote:
        require_network()
        validate_descriptor(config, spec, allow_offline=False)
    directory = _cache_dir(root)
    suffix = Path(relative).suffix
    target = contained(directory, spec['sha256'] + suffix)
    held = _leases.get()
    if held is not None and str(target) in held:
        if file_identity(target) != held[str(target)][1]:
            raise ValueError('leased resource was changed')
        if _remote:
            with _transfers:
                _remote_hash(_client or client(config, administrative=administrative), config, spec)
            _count(remote_verifications=1)
        else:
            _count(cache_hits=1, local_bytes=spec['bytes'])
        return target
    if _frozen.get():
        raise ValueError('resource was not preflighted before the database transaction')
    lock = contained(directory, target.name + '.lock').open('a')
    try:
        # Hits acquire SH directly: A/B render inputs can be acquired in either
        # order without two readers waiting forever for each other's EX lock.
        _lock(lock, fcntl.LOCK_SH)
        valid = verified_file(target, spec)
        if not valid:
            fcntl.flock(lock, fcntl.LOCK_UN)
            _lock(lock, fcntl.LOCK_EX)
            # Another downloader may have completed while we changed locks.
            valid = verified_file(target, spec)
        if valid:
            if _remote:
                with _transfers:
                    _remote_hash(_client or client(config, administrative=administrative), config, spec)
                _count(remote_verifications=1)
            else:
                _count(cache_hits=1, local_bytes=spec['bytes'])
        if not valid:
            target.unlink(missing_ok=True)
            maximum = config.get('cache_bytes', 16 * 1024 ** 3)
            temporary = contained(directory, target.name + '.part')
            reservation = contained(directory, target.name + '.reserve')
            while not _transfers.acquire(timeout=.05):
                _check_cancel()
            try:
                with (nullcontext(None) if _remote else _local_source(root, relative, spec, target)) as media:
                    with (directory / '.capacity.lock').open('a') as capacity:
                        _lock(capacity, fcntl.LOCK_EX)
                        # We own this object's EX lock, so its older reservation
                        # can only be an interrupted transfer from a dead owner.
                        temporary.unlink(missing_ok=True)
                        reservation.unlink(missing_ok=True)
                        outstanding = _trim(root, spec['bytes'], maximum)
                        import shutil
                        if shutil.disk_usage(directory).free < outstanding + spec['bytes'] + 64 * 1024 ** 2:
                            raise ValueError('resource cache needs disk headroom')
                        atomic_json(reservation, {'target': target.name, 'bytes': spec['bytes']})
                    try:
                        with temporary.open('wb') as out:
                            if _remote:
                                _remote_hash(_client or client(config, administrative=administrative), config, spec, out)
                                _count(fetched_objects=1, remote_verifications=1)
                            elif media is not None:
                                with media.open('rb') as source:
                                    for block in iter(lambda: source.read(1024 * 1024), b''):
                                        _check_cancel()
                                        out.write(block)
                                _count(source_copies=1, local_bytes=spec['bytes'])
                            else:
                                _remote_hash(client(config, administrative=administrative), config, spec, out)
                                _count(fetched_objects=1)
                            out.flush()
                            os.fsync(out.fileno())
                        if not verified_file(temporary, spec):
                            raise ValueError('resource cache verification failed')
                        with (directory / '.capacity.lock').open('a') as capacity:
                            _lock(capacity, fcntl.LOCK_EX)
                            os.replace(temporary, target)
                            reservation.unlink()
                    finally:
                        with (directory / '.capacity.lock').open('a') as capacity:
                            # Cleanup must finish even when the caller cancelled.
                            fcntl.flock(capacity, fcntl.LOCK_EX)
                            temporary.unlink(missing_ok=True)
                            reservation.unlink(missing_ok=True)
            finally:
                _transfers.release()
        fcntl.flock(lock, fcntl.LOCK_SH)
        if held is not None:
            old = held.get(str(target))
            if old:
                old[0].close()
            held[str(target)] = (lock, file_identity(target))
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
    # Release the upload slot before the cache installer acquires a transfer
    # slot. Three simultaneous uploads must not wait on their own semaphore.
    spec['verified_sha256'] = digest
    materialize(root, 'uploaded' + source.suffix, spec=spec, _remote=True, _client=connection)
    after = source.stat()
    if (after.st_ino, after.st_size, after.st_mtime_ns) != (before.st_ino, before.st_size, before.st_mtime_ns):
        raise ValueError('source changed during upload')
    spec['verified_at'] = int(time.time())
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
