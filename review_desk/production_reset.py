"""Explicit full-production erasure; ordinary history rules stay enabled.

Plans contain identities, hashes and accounting facts, never old production text.
The caller coordinates the stopped service, authorized scope and local copies.
"""
import collections
import json

from . import candidate_reset, production as p, production_current as current
from .store import Conflict, canonical, digest

FORMAT = 'full-production-reset-v1'
DELETED = 'DELETED_PRODUCTION'
KINDS = current.CURRENT_KINDS | {'ASSET', 'DELETED_STATE'}
NOTICE = '本轮制作已删除；保留原文字意见与真实核账事实，后续从故事输入重新制作。'
CONTENT_KEYS = {'prompt', 'lyrics', 'text', 'blocks', 'inputs', 'input', 'outputs',
                'references', 'reference', 'referenced_image_paths', 'sources',
                'files', 'file', 'source_file', 'output_hint', 'subtitle',
                'audio', 'video', 'image', 'data', 'content', 'parts', 'bytes_base64'}
RECEIPT_KEYS = {'id', 'request_id', 'log_id', 'interaction_id', 'attempt_id', 'endpoint',
                'provider_call_id', 'response_artifact_id', 'status', 'submitted_at',
                'created_at', 'finished_at', 'model', 'provider_model', 'tool',
                'tool_surface_model', 'underlying_model_id', 'billing_usage', 'usage',
                'estimated_cost_usd', 'max_cost_usd', 'price_checked', 'quota_id',
                'remaining_before_seconds', 'remaining_after_seconds', 'reserved_seconds',
                'original_duration', 'duration', 'bytes', 'sha256', 'input_sha256',
                'request_file_sha256', 'spec_sha256', 'width', 'height', 'codec',
                'requested_format', 'format', 'sample_rate'}


def technical(value):
    if isinstance(value, dict):
        return {k: technical(v) for k, v in value.items() if k not in CONTENT_KEYS
                and not any(s in k.lower() for s in ('base64', 'download_url', 'audio_url', 'image_url', 'video_url'))}
    if isinstance(value, list):
        return [technical(v) for v in value]
    if isinstance(value, str) and (candidate_reset.media_bytes(value) is not None
                                   or value.startswith(('data:', 'http://', 'https://'))):
        return {'payload_deleted': True, 'sha256': current.checksum(value)}
    return value


def accounting(payload):
    result = {k: technical(payload[k]) for k in ('format', 'title', 'tool', 'model', 'method', 'status', 'usage', 'parameters') if k in payload}
    result['receipt'] = {k: v if k == 'endpoint' else technical(v) for k, v in payload.get('receipt', {}).items() if k in RECEIPT_KEYS}
    result.update(production_content_deleted=True, replay_disabled=True,
                  evidence_notice='回执已定向剥离制作正文、Prompt、对象与输入快照和媒体；并非原始完整请求。')
    return result


def receipts(store):
    if not current.enabled(store):
        return []
    version = store.db.execute('PRAGMA data_version').fetchone()[0]
    cached = getattr(store, '_production_reset_cache', None)
    if cached and cached[0] == version:
        return cached[1]
    values = [json.loads(r[0]) for r in store.db.execute(
        "SELECT result FROM production_current_operations WHERE json_extract(result,'$.format')=?", (FORMAT,))]
    store._production_reset_cache = (version, values,
        {oid for value in values for oid in value.get('deleted_identities', value['deleted_objects'])})
    return values


def deleted_record(store, oid=None, rid=None):
    for receipt in receipts(store):
        target = receipt['deleted_revisions'].get(rid) if rid else oid
        if target in receipt['deleted_objects']:
            if oid and target != oid:
                raise ValueError('deleted revision belongs to another object')
            return target
    return None


def guard_write(store, oid, payload):
    if getattr(store, '_production_erasing', False):
        return
    receipts(store)
    erased = getattr(store, '_production_reset_cache', (None, None, set()))[2]
    if not erased:
        return
    def identities(value):
        if isinstance(value, dict):
            for k, v in value.items():
                if k in ('object_id', 'material_id', 'entity_id', 'target_object_id') and isinstance(v, str):
                    yield v
                yield from identities(v)
        elif isinstance(value, list):
            for item in value:
                yield from identities(item)
    if oid in erased or erased.intersection(identities(payload)):
        raise Conflict('本轮已物理清空的制作身份不能由旧包、迟到请求或下载恢复重新登记')


def guard_operation(store, operation_id):
    if any(operation_id in receipt.get('deleted_operations', []) for receipt in receipts(store)):
        raise Conflict('旧制作请求已清空；不能重放、下载恢复或再次注册，核账事实请从原调用读取')


def prepare(store):
    media = candidate_reset.prepare(store)
    deleted, revisions, calls = {}, {}, {}
    for obj in store.objects():
        if obj['kind'] in KINDS:
            deleted[obj['id']] = {'kind': obj['kind'], 'sha256': current.checksum(p.record(store, obj['id'])['payload'])}
            for row in store.db.execute('SELECT id FROM revisions WHERE object_id=?', (obj['id'],)):
                revisions[row[0]] = obj['id']
        elif obj['kind'] == 'CALL':
            calls[obj['id']] = accounting(p.record(store, obj['id'])['payload'])
    for row in store.db.execute('SELECT revision_id,object_id FROM production_legacy_links'):
        if row[1] in deleted:
            revisions[row[0]] = row[1]
    files = dict(media['erased_files'])
    for oid in media['assets']:
        body = p.record(store, oid)['payload']
        for comp in body.get('components', []) + body.get('former_components', []):
            name = comp.get('file', comp.get('former_file'))
            if name:
                files[name] = {'sha256': comp['sha256'], 'bytes': comp['bytes'], 'kind': 'production-component'}
    if set(files) & set(media['protected_files']):
        raise Conflict('production reset overlaps protected source or method files')
    from .production_media import physical_file_hash
    from .bundle import _safe_asset
    for name, item in files.items():
        path = p.root_of(store)/'export/assets'/_safe_asset(name)
        if path.is_symlink():
            raise Conflict('reset refuses a symlink component')
        if path.exists():
            item['physical_sha256'] = physical_file_hash(path)
    legacy_kinds = KINDS | {'JUDGMENT', 'REPRESENTATION', 'REVIEW', 'DECISION', 'SHOT', 'SCENE', 'ASSEMBLY', 'DELIVERABLE', 'MATERIAL_RELATION'}
    legacy_ids = {r[0] for r in store.db.execute('SELECT DISTINCT object_id FROM consolidation_revisions WHERE kind IN ('+','.join('?' for _ in legacy_kinds)+')', sorted(legacy_kinds))}
    plan = {'format': FORMAT, 'baseline': media['baseline'], 'deleted_objects': deleted,
            'deleted_revisions': revisions, 'calls': calls, 'erased_files': files,
            'assets': media['assets'], 'protected_files': media['protected_files'], 'evidence_replacements': {},
            'deleted_operations': [r[0] for r in store.db.execute('SELECT operation_id FROM production_submissions ORDER BY 1')],
            'deleted_identities': sorted(set(deleted) | legacy_ids),
            'counts': dict(collections.Counter(v['kind'] for v in deleted.values()))}
    plan['id'] = current.checksum(plan)
    return plan


def apply(store, plan, fault=None):
    if plan.get('format') != FORMAT or plan.get('id') != current.checksum({k: v for k, v in plan.items() if k != 'id'}):
        raise ValueError('invalid full-production reset manifest')
    prior = store.db.execute('SELECT request_sha256,result FROM production_current_operations WHERE id=?', (plan['id'],)).fetchone()
    if prior:
        if prior[0] != current.checksum(plan):
            raise Conflict('reset identity changed')
        return {**json.loads(prior[1]), 'already_applied': True}
    if store.db.in_transaction:
        raise Conflict('reset must own its transaction')
    from .resources import require_local_cleanup
    require_local_cleanup(p.root_of(store))
    store.db.execute('PRAGMA secure_delete=ON')
    store.db.execute('BEGIN IMMEDIATE')
    store.db.execute('PRAGMA defer_foreign_keys=ON')
    store._production_erasing = True
    store._material_migrating = True
    try:
        if candidate_reset.fingerprint(store) != plan['baseline']:
            raise Conflict('production reset baseline changed; prepare from current data')
        for comment in store.comments():
            if comment['target_object_id'] in plan['deleted_objects'] and not store.db.execute(
                    'SELECT 1 FROM production_comment_quotes WHERE comment_id=?', (comment['id'],)).fetchone():
                current.remember_comment(store, comment)
        # These tables contain the deleted production tree, replayable snapshots
        # or obsolete caches. Codes and original comments are deliberately kept.
        for table in ('business_relation_aliases', 'business_relations', 'business_relation_runs',
                      'material_aliases', 'production_candidate_targets', 'production_candidates',
                      'production_submissions', 'production_current_operations', 'audiovisual_notes',
                      'audiovisual_cleanup_receipts', 'audiovisual_cleanup_runs',
                      'relation_explanation_redactions', 'relation_redacted_comments',
                      'state_cleanup_preserved', 'state_cleanup_receipts', 'state_cleanup_comments',
                      'production_response_excerpts'):
            store.db.execute('DELETE FROM '+table)
        old_rids = set(plan['deleted_revisions'])
        store.db.execute('CREATE TEMP TABLE erasing_revisions (id TEXT PRIMARY KEY)')
        store.db.executemany('INSERT INTO erasing_revisions VALUES (?)', ((rid,) for rid in old_rids))
        store.db.execute('DELETE FROM dependencies WHERE from_revision IN (SELECT id FROM erasing_revisions) OR to_revision IN (SELECT id FROM erasing_revisions)')
        for oid, info in plan['deleted_objects'].items():
            obj = dict(store.db.execute('SELECT * FROM objects WHERE id=?', (oid,)).fetchone())
            body = {'format': 'production-retirement-v1', 'status': 'withdrawn', 'object_id': oid,
                    'original_kind': info['kind'], 'original_content_sha256': info['sha256'],
                    'reason': NOTICE, 'media_deleted': True, 'production_deleted': True}
            rid = digest(canonical({'object_id': oid, 'version': obj['version'], 'payload': body}).encode())
            store.db.execute('DELETE FROM production_current_records WHERE object_id=?', (oid,))
            store.db.execute('DELETE FROM production_current_baselines WHERE object_id=?', (oid,))
            store.db.execute('DELETE FROM revisions WHERE object_id=?', (oid,))
            store.db.execute('UPDATE objects SET kind=?,current_revision=? WHERE id=?', (DELETED, rid, oid))
            store.db.execute('INSERT INTO revisions VALUES (?,?,?,?,?)', (rid, oid, obj['version'], canonical(body), obj['updated_at']))
            store.db.execute('UPDATE comments SET target_revision_id=? WHERE target_object_id=?', (rid, oid))
        store.db.execute('DROP TABLE erasing_revisions')
        store.db.execute('DELETE FROM production_legacy_links')
        for oid, body in plan['calls'].items():
            row = store.db.execute('SELECT current_revision FROM objects WHERE id=?', (oid,)).fetchone()
            store.db.execute('DELETE FROM dependencies WHERE from_revision=?', (row[0],))
            store.db.execute('UPDATE revisions SET payload=? WHERE id=?', (canonical(body), row[0]))
            store.db.execute('UPDATE production_current_records SET payload_sha256=? WHERE object_id=?', (current.checksum(body), oid))
            store.db.execute('INSERT OR REPLACE INTO production_current_baselines VALUES (?,?,?)', (oid, current.checksum(body), current.checksum(body)))
        # Historical operation receipts may have complete before/after objects.
        for table in ('generation_publications', 'consolidation_runs'):
            for row in list(store.db.execute('SELECT id,receipt FROM '+table)):
                raw = json.loads(row[1]); clean = {'id': row[0], 'original_receipt_sha256': current.checksum(raw), 'production_content_deleted': True, 'replay_disabled': True}
                store.db.execute('UPDATE '+table+' SET receipt=? WHERE id=?', (canonical(clean), row[0]))
        receipt = {k: v for k, v in plan.items() if k not in ('baseline', 'calls', 'protected_files')}
        receipt['notice'] = NOTICE
        store.db.execute('INSERT INTO production_current_operations VALUES (?,?,?)', (plan['id'], current.checksum(plan), canonical(receipt)))
        # Archive containers are old generated request metadata, not accounting
        # authority. Remove only components identified by the plan.
        store.db.executemany('DELETE FROM material_archive_files WHERE path=?', (('export/assets/'+n,) for n in plan['erased_files']))
        from .version_consolidation import collect_content
        receipt['content_cleanup'] = collect_content(store)
        if fault == 'before-commit':
            raise RuntimeError('injected full reset interruption')
        if store.db.execute('PRAGMA foreign_key_check').fetchone():
            raise ValueError('production reset left dangling foreign keys')
        store.db.commit()
    except BaseException:
        store.db.rollback()
        raise
    finally:
        store._production_erasing = False
        store._material_migrating = False
        if hasattr(store, '_production_reset_cache'):
            del store._production_reset_cache
    if store.db.execute('PRAGMA journal_mode').fetchone()[0] == 'wal':
        store.db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
    store.db.execute('VACUUM')
    return receipt
