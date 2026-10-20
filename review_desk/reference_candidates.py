"""Small read-only candidate summaries, without plans, calls or history trees."""
from . import production as p
from .material_storage import canonical_id
from .production_media import asset_path


def summaries(store, material_id, media_type=None):
    mid = canonical_id(store, material_id)
    p.record(store, mid)  # Unknown material is an error, never an empty list.
    rows = store.db.execute('''SELECT c.asset_object_id,c.id,t.number
        FROM production_candidate_targets t JOIN production_candidates c ON c.id=t.candidate_id
        WHERE t.material_id=? ORDER BY t.number''', (mid,)).fetchall()
    candidates = []
    for asset_id, candidate_id, number in rows:
        row = p.record(store, asset_id)
        originals = []
        for component in row['payload'].get('components', []):
            if component['role'] != 'original':
                continue
            issue = None
            if media_type and row['payload']['media_type'] != media_type:
                issue = '此候选与输入媒体类型不兼容'
            availability = 'unknown'
            try:
                from . import resources
                root = p.root_of(store)
                if resources.settings(root):
                    spec = resources.descriptor(root, 'export/assets/' + component['file'])
                    if (spec['sha256'], spec['bytes'], spec['mime']) != (component['sha256'], component['bytes'], component['mime']):
                        issue = issue or '原件目录与准确候选不一致'
                else:
                    path = asset_path(root, component['file'])
                    from .material_archives import logical_size
                    if not path.is_file() or logical_size(path) != component['bytes']:
                        issue = issue or '原件文件不可用'
                    else:
                        availability = 'local_metadata'
            except (ValueError, OSError):
                issue = issue or '原件文件不可用'
            originals.append({**component, 'issue': issue, 'availability': 'unavailable' if issue else availability})
        candidates.append({'candidate': {'object_id': row['object_id'], 'revision_id': row['id']},
                           'candidate_id': candidate_id, 'number': number,
                           'media_type': row['payload']['media_type'], 'originals': originals,
                           'issue': None if originals else '此候选没有生产原件'})
    return {'material_id': mid, 'candidates': candidates}
