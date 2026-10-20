"""Exact, one-off erasure plans; ordinary candidate history remains immutable.

The caller owns authorization, the stopped-service window and physical copies.
This module never downloads originals or exposes a destructive web action.
"""
import base64
import hashlib
import json
from pathlib import Path

from . import production as p, production_current as current
from .store import Conflict, canonical

FORMAT = 'generated-candidates-reset-v1'
NOTICE = '本轮已删除；原件不可用，保留原文字意见与真实调用事实。'


def receipts(store):
    if not current.enabled(store):
        return []
    if getattr(store, '_production_reads', None) is None:
        with p.read_scope(store):
            return receipts(store)
    scope = getattr(store, '_production_reads', None)
    if scope is not None and 'candidate_reset_receipts' in scope:
        return scope['candidate_reset_receipts']
    # Tokens and receipts are read from the same transaction. A rollback returns
    # to the old token; other processes and new receipts invalidate immediately.
    journal = store.db.execute("SELECT 1 FROM sqlite_master WHERE name='read_generations'").fetchone()
    from .read_cache import token
    generation = token(store, {'production_current_operations'}) if journal else None
    cached = getattr(store, '_reset_receipts', None)
    if generation is not None and cached and cached[0] == generation:
        result = cached[1]
    else:
        result = [json.loads(r[0]) for r in store.db.execute(
            "SELECT result FROM production_current_operations WHERE json_extract(result,'$.format') IN (?,?)", (FORMAT, 'full-production-reset-v1'))]
        if generation is not None:
            files = {name: spec for receipt in result for name, spec in receipt['erased_files'].items()}
            store._reset_receipts = (generation, result, files)
    if scope is not None:
        scope['candidate_reset_receipts'] = result
    return result


def erased_files(store):
    values = receipts(store)
    cached = getattr(store, '_reset_receipts', None)
    if cached and cached[1] is values:
        return cached[2]
    result = {}
    for receipt in values:
        result.update(receipt['erased_files'])
    return result


def erased_component(store, component):
    value = erased_files(store).get(component.get('file'))
    return bool(value and value['sha256'] == component.get('sha256'))


def deleted_input(store, value):
    """A deletion receipt is a preparation gap, never a selected input."""
    if value.get('selection_state') != 'unselected':
        return False
    ref = value.get('deleted_reference', {})
    return any(ref.get('object_id') in receipt['assets'] for receipt in receipts(store))


def was_candidate_for(store, asset_id, material_id):
    return any([asset_id, material_id] in receipt.get('candidate_memberships', []) for receipt in receipts(store))


def media_bytes(value):
    """Recognize bytes by their signature, never by a field name alone."""
    if not isinstance(value, str) or len(value) < 32:
        return None
    raw = value.split(',', 1)[-1] if value.startswith('data:') and ';base64,' in value[:160] else value
    if len(raw) < 32 or not raw[:20].isascii():
        return None
    try:
        head = base64.b64decode(raw[:min(len(raw), 64) // 4 * 4], validate=True)
    except (ValueError, TypeError):
        return None
    if not (head.startswith((b'\x89PNG', b'\xff\xd8\xff', b'RIFF', b'ID3', b'OggS', b'fLaC', b'PK\x03\x04'))
            or head[4:8] == b'ftyp' or head[:2] in (b'\xff\xfb', b'\xff\xf3', b'\xff\xf2')):
        return None
    try:
        return base64.b64decode(raw, validate=True)
    except (ValueError, TypeError):
        return None


def redact(value, removed=None, path='$'):
    """Keep accounting/text, replace embedded media with honest erasure facts."""
    removed = [] if removed is None else removed
    if isinstance(value, dict):
        return {k: redact(v, removed, path+'.'+k) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v, removed, path+'['+str(i)+']') for i, v in enumerate(value)]
    data = media_bytes(value)
    if data is not None:
        fact = {'media_deleted': True, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}
        removed.append({'path': path, **fact})
        return fact
    return value


def fingerprint(store):
    """Include all persistent rows, including comments; no stale full reset."""
    tables = sorted(r[0] for r in store.db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='read_generations'"))
    result = {}
    for table in tables:
        h = hashlib.sha256()
        for row in store.db.execute('SELECT * FROM "'+table+'" ORDER BY 1'):
            h.update(canonical(dict(row)).encode()); h.update(b'\n')
        result[table] = h.hexdigest()
    return result


def prepare(store):
    from .resources import require_local_cleanup
    require_local_cleanup(p.root_of(store))
    if not current.enabled(store):
        raise ValueError('current production contract required')
    from .material_archives import read_bytes
    root = p.root_of(store)
    assets, files, evidence, available_evidence = {}, {}, {}, set()
    for obj in store.objects():
        if obj['kind'] != 'ASSET':
            continue
        row = p.record(store, obj['id']); body = row['payload']
        assets[obj['id']] = current.checksum(body)
        for comp in body.get('components', []) + body.get('former_components', []):
            name = comp.get('file', comp.get('former_file'))
            if not name:
                raise ValueError('component lacks original identity')
            from .bundle import _safe_asset
            path = root/'export/assets'/_safe_asset(name)
            if comp['role'] in ('original', 'preview', 'thumbnail', 'proxy'):
                files[name] = {'sha256': comp['sha256'], 'bytes': comp['bytes'], 'kind': 'media'}
            elif path.exists():
                available_evidence.add(name)
                data = read_bytes(path)
                removed = []
                if path.suffix == '.json':
                    clean = redact(json.loads(data), removed)
                if removed:
                    wrapper = {'format': 'redacted-generation-evidence-v1', 'original_sha256': hashlib.sha256(data).hexdigest(),
                               'original_bytes': len(data), 'removed_media': removed, 'content': clean}
                    raw = (json.dumps(wrapper, ensure_ascii=False, indent=2)+'\n').encode()
                    new_name = hashlib.sha256(raw).hexdigest()+'.json'
                    evidence[name] = {'file': new_name, 'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw),
                                      'content': wrapper}
                    files[name] = {'sha256': comp['sha256'], 'bytes': len(data), 'kind': 'redacted-evidence'}
    # Explicit source protection wins over a location or filename heuristic.
    protected = set()
    from .version_consolidation import file_references
    for source in store.sources():
        protected.update(file_references(source))
        protected.update(a['file'] for a in source.get('assets', []))
    kinds = {obj['id']: obj['kind'] for obj in store.objects()}
    for row in store.revisions():
        if kinds[row['object_id']] not in current.RECORD_KINDS:
            protected.update(file_references(json.loads(row['payload'])))
        if row['object_id'] == 'story-structure':
            protected.update(v['file'] for section in json.loads(row['payload'])['sections'] for v in section.get('visuals', []))
    if protected & files.keys():
        raise Conflict('candidate erasure overlaps protected story/method originals: '+str(sorted(protected & files.keys())))
    value = {'format': FORMAT, 'baseline': fingerprint(store), 'assets': assets,
             'erased_files': files, 'evidence_replacements': evidence, 'protected_files': sorted(protected),
             'available_evidence': sorted(available_evidence)}
    value['candidate_memberships'] = [[r[0], r[1]] for r in store.db.execute(
        'SELECT c.asset_object_id,t.material_id FROM production_candidates c JOIN production_candidate_targets t ON t.candidate_id=c.id ORDER BY 1,2')]
    value['id'] = current.checksum(value)
    return value


def cleanup(store, plan, stop_after=None):
    """Resume the same committed manifest; deleted bytes have no rollback."""
    from .resources import require_local_cleanup
    require_local_cleanup(p.root_of(store))
    known = erased_files(store)
    if not set(plan['erased_files']) <= known.keys():
        raise Conflict('commit exact reference conversion before deleting bytes')
    from .bundle import _safe_asset
    from .material_archives import read_bytes
    root = p.root_of(store); removed = []; absent = []
    for item in plan['evidence_replacements'].values():
        path = root/'export/assets'/_safe_asset(item['file'])
        raw = (json.dumps(item['content'], ensure_ascii=False, indent=2)+'\n').encode()
        if hashlib.sha256(raw).hexdigest() != item['sha256']:
            raise Conflict('redacted evidence content changed')
        if path.exists() and path.read_bytes() != raw:
            raise Conflict('redacted evidence destination changed')
        path.write_bytes(raw)
    for name, expected in sorted(plan['erased_files'].items()):
        path = root/'export/assets'/_safe_asset(name)
        if path.is_symlink():
            raise Conflict('erasure refuses symlink')
        if not path.exists():
            absent.append(name); continue
        # Archive references have logical checksums; verify before unlinking.
        from .production_media import physical_file_hash
        actual = physical_file_hash(path) if expected.get('physical_sha256') else hashlib.sha256(read_bytes(path)).hexdigest()
        if actual != expected.get('physical_sha256', expected['sha256']):
            raise Conflict('erasure bytes changed: '+name)
        path.unlink(); removed.append(name)
        if stop_after and len(removed) >= stop_after:
            raise RuntimeError('injected physical cleanup interruption')
    # Sweep only after replacement files exist and old references are removed.
    from .version_consolidation import collect_content
    with store.db:
        result = collect_content(store)
    return {'removed': removed, 'already_absent': absent, 'content_cleanup': result}
