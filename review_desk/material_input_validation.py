"""Deterministic checks for current execution inputs, separate from readiness.

Unselected demands are preparation gaps. Exact historical originals remain
terminals only when their identity, component, bytes and range are valid.
"""
from contextlib import contextmanager
from . import production as p


def issues(store, need):
    from .material_relations import active_inputs
    from .material_storage import canonical_id
    from .production_current import input_slot
    errors, finished, path = [], set(), []
    # Iterative traversal also handles a long valid chain without recursion.
    stack = [(need, False)]
    root_id = canonical_id(store, need['object_id'])
    while stack:
        row, leaving = stack.pop()
        mid = canonical_id(store, row['object_id'])
        if leaving:
            path.pop()
            finished.add(mid)
            continue
        if mid in path:
            errors.append('所选执行路线存在循环：' + ' → '.join([*path, mid]))
            continue
        if mid in finished:
            continue
        if row.get('unavailable') or row['payload'].get('status') == 'withdrawn':
            errors.append('当前输入目标已退役或撤回：' + mid)
            continue
        path.append(mid)
        stack.append((row, True))
        try:
            selected, _ = active_inputs(store, row['payload'].get('generation') or {}, row['object_id'])
        except (KeyError, ValueError) as exc:
            errors.append(mid + '：' + str(exc))
            continue
        children = []
        for index, value in selected:
            from .candidate_reset import deleted_input
            if deleted_input(store, value):
                continue
            label = mid + ' 参考 ' + str(index + 1) + '：'
            try:
                target = p.ref_record(store, value['reference'], {'REQUIREMENT', 'ASSET'})
                if target['kind'] == 'REQUIREMENT':
                    # The proposed root must replace its old current payload
                    # during write validation, including alias references.
                    children.append(need if canonical_id(store, target['object_id']) == root_id else target)
                else:
                    slot = input_slot(store, value, index)
                    failures = slot['issues'][:]
                    if value.get('selection_state') == 'unselected':
                        if slot.get('canonical_material_id') != mid:
                            failures.append('未选原件只能保留本素材准确候选出处')
                        elif failures == ['尚未选定候选']:
                            failures = []  # A preparation gap, never executable.
                    if slot.get('disposition') == 'missing':
                        failures.append(slot.get('reason') or '准确原件不可用')
                    errors.extend(label + failure for failure in failures)
            except (KeyError, ValueError, OSError) as exc:
                errors.append(label + str(exc))
        stack.extend((target, False) for target in reversed(children))
    return list(dict.fromkeys(errors))


def validate_write(store, object_id, payload):
    from .production_current import enabled
    if not enabled(store) or payload.get('format') != 'production-requirement-v1':
        return
    pending = getattr(store, '_material_input_validation_batch', None)
    if pending is not None:
        pending[object_id] = payload
        return
    # Writes may occur inside a caller's read scope. Its cached records cannot
    # decide correctness after mutations; keep that scope for its caller only.
    old_reads = getattr(store, '_production_reads', None)
    if old_reads is not None:
        del store._production_reads
    try:
        with p.read_scope(store):
            row = p.record(store, object_id)
            failures = issues(store, row) if payload.get('status') != 'withdrawn' else []
            # Also reject withdrawing an upstream still used by a current plan.
            if payload.get('status') == 'withdrawn':
                for raw in store.db.execute('''SELECT DISTINCT r.object_id FROM dependencies d
                    JOIN revisions r ON r.id=d.from_revision JOIN objects o ON o.id=r.object_id
                    WHERE d.to_revision=? AND o.kind='REQUIREMENT' ''', (row['id'],)):
                    consumer = p.record(store, raw[0])
                    if consumer['payload'].get('status') != 'withdrawn':
                        failures.extend(issues(store, consumer))
            if failures:
                raise ValueError('；'.join(dict.fromkeys(failures)))
    finally:
        if old_reads is not None:
            store._production_reads = old_reads


@contextmanager
def batch(store):
    """Check the final atomic batch, rather than a transient intermediate graph."""
    if hasattr(store, '_material_input_validation_batch'):
        yield
        return
    pending = store._material_input_validation_batch = {}
    try:
        yield
    except BaseException:
        del store._material_input_validation_batch
        raise
    else:
        del store._material_input_validation_batch
        for object_id, payload in pending.items():
            validate_write(store, object_id, payload)


def validate_pending(store):
    pending = getattr(store, '_material_input_validation_batch', None)
    if pending is None:
        return
    del store._material_input_validation_batch
    try:
        for object_id, payload in pending.items():
            validate_write(store, object_id, payload)
        pending.clear()
    finally:
        store._material_input_validation_batch = pending


def validate_tree(store):
    from .material_storage import canonical_id
    with p.read_scope(store):
        for row in p.current_records(store, {'REQUIREMENT'}):
            if row['payload'].get('status') == 'withdrawn' or row['payload'].get('format') != 'production-requirement-v1':
                continue
            if canonical_id(store, row['object_id']) != row['object_id']:
                continue
            failures = issues(store, row)
            if failures:
                raise ValueError('；'.join(failures))
