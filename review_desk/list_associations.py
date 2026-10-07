"""Exact list associations; never expand a parent into its child locations."""
import re
from . import production as p, production_breakdown as b
from . import list_reading as light


def entity_locations(store, entities, rows):
    result = {e['object_id']: [] for e in entities}
    cache = {}

    def owners(reference):
        row = light.ref_record(store, reference)
        if row.get('unavailable'):
            return [row['owner_object_id']] if row.get('owner_object_id') else []
        if row['kind'] == 'ENTITY':
            return [row['object_id']]
        if row['kind'] == 'STATE':
            return [row['payload']['entity']['object_id']]
        return []

    def add(eids, loc, evidence):
        if not loc.get('episode') and not loc.get('scene'):
            return
        for eid in set(eids):
            if eid in result:
                result[eid].append({**loc, 'evidence': evidence})

    for row in rows:
        value = row['payload']
        if row['kind'] in ('ENTITY', 'STATE'):
            eids = [row['object_id']] if row['kind'] == 'ENTITY' else [value['entity']['object_id']]
            for source in value.get('sources', []):
                target = light.ref_record(store, source)
                if target['kind'] == 'EPISODE':
                    add(eids, {'episode': target['object_id'], 'scene': source.get('scene_id')},
                        {'record': b.ref(row), 'source': source, 'kind': 'source'})
        elif row['kind'] in ('PREPARATION', 'SHOT_DESIGN'):
            eids = [eid for ref in value.get('entities', []) for eid in owners(ref)]
            eids += [eid for ref in value.get('states', []) for eid in owners(ref)]
            for occurrence in value.get('occurrences', []):
                eids += owners(occurrence['entity'])
                eids += [eid for ref in occurrence.get('states', []) for eid in owners(ref)]
            add(eids, b.location(store, b.ref(row), cache), {'record': b.ref(row), 'kind': 'scene_shot'})
        elif row['kind'] == 'RELATION' and value.get('relation_type') in ('occurrence', 'applicability'):
            subject = light.ref_record(store, value['subject'])
            if subject['kind'] in ('ENTITY', 'STATE'):
                add(owners(value['subject']), b.location(store, value['scope'], cache),
                    {'record': b.ref(row), 'subject': value['subject'], 'scope': value['scope'], 'kind': value['relation_type']})
    # Keep distinct evidence, but each entity is still one list identity.
    return result


def material_uses(store, entries):
    """Add explicit planned inputs, original call inputs and adoptions at scope."""
    from .material_storage import canonical_id
    by_id = {item['canonical_material_id']: item for item in entries}
    candidate_owners = {}
    for row in store.db.execute("SELECT DISTINCT m.material_id,r.object_id FROM material_plan_members m JOIN revisions r ON r.id=m.revision_id WHERE m.role='result'"):
        candidate_owners.setdefault(row['object_id'], set()).add(canonical_id(store, row['material_id']))
    cache = {}

    def add(reference, scope, evidence):
        target = light.ref_record(store, reference)
        if target['kind'] not in ('ASSET', 'REQUIREMENT'):
            return
        mid = canonical_id(store, target['object_id'])
        mids = {mid} if mid in by_id else candidate_owners.get(target['object_id'], set())
        for identity in mids:
            item = by_id.get(identity)
            if item:
                item['locations'].append({**b.location(store, scope, cache), 'relation': evidence['kind'], 'evidence': evidence})

    for need in light.rows(store, 'REQUIREMENT'):
        scope = need['payload'].get('scope')
        if not scope:
            continue
        for value in ([] if need['payload'].get('status')=='withdrawn' else need['payload'].get('generation', {}).get('inputs', [])):
            add(value['reference'], scope, {'kind': 'planned_input', 'record': b.ref(need), 'input': value})
        for row in store.db.execute("SELECT DISTINCT r.id FROM material_plan_members m JOIN revisions r ON r.id=m.revision_id WHERE m.material_id=? AND m.role='call'", (need['object_id'],)):
            call = light.record(store, revision_id=row[0])
            exact_need = call['payload'].get('generation_requirement')
            exact_scope = light.ref_record(store, exact_need)['payload'].get('scope') if exact_need else scope
            if exact_scope:
                for value in call['payload'].get('inputs', []):
                    add(value.get('reference', value), exact_scope, {'kind': 'actual_input', 'record': b.ref(call), 'input': value})
    for link in b.rows(store, 'RELATION'):
        value = link['payload']
        if value.get('relation_type') == 'adoption':
            add(value['asset'], value['scope'], {'kind': 'adoption', 'record': b.ref(link)})
        elif value.get('relation_type') == 'applicability':
            add(value['subject'], value['scope'], {'kind': 'applicable', 'record': b.ref(link)})
    return entries


def material_groups(store, entries, episode=None, scene=None):
    episode_numbers = {r['object_id']: r['payload'].get('number') for r in light.rows(store, 'EPISODE')}
    groups = {}
    for item in entries:
        locations = item['locations']
        keys = set()
        for loc in locations:
            ep, sc = loc.get('episode'), loc.get('scene')
            if episode and ep != episode or scene and sc != scene:
                continue
            level = 'scene' if sc else 'episode' if ep else 'story' if loc.get('kind') in ('INPUT_LOCK', 'STORY') else None
            if level:
                keys.add((level, ep, sc))
        if not keys and not episode and not scene:
            keys.add(('unassigned', None, None))
        # An unlocated entity/state attachment does not imply global ownership.
        for level, ep, sc in keys:
            key = '|'.join((level, ep or '', sc or ''))
            group = groups.setdefault(key, {'key': key, 'level': level, 'episode': ep, 'scene': sc,
                                            'episode_number': episode_numbers.get(ep), 'material_ids': []})
            group['material_ids'].append(item['canonical_material_id'])
    def order(group):
        level = group['level']
        digits = re.findall(r'\d+', group['scene'] or '')
        return (0 if level in ('scene', 'episode') else 1 if level == 'story' else 2,
                group['episode_number'] or 0, group['episode'] or '', 0 if level == 'episode' else 1,
                tuple(map(int, digits)), group['scene'] or '')
    return sorted(groups.values(), key=order)
