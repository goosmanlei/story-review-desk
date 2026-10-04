"""Complete material definitions and explicit, evidence-backed shared identity."""
import copy
import json
from .store import canonical, digest, Conflict
from . import material_storage as storage

ASSOCIATION_KEYS={'format','title','scope','states','generation','status','change','planned_shots','preparation_task','plan_source_sha256'}


def requirement_fields(payload):
    return {k:copy.deepcopy(v) for k,v in payload.items() if k not in ASSOCIATION_KEYS}


def ref(row):
    return {'object_id':row['object_id'],'revision_id':row['id']}


def reuse_source(store,row):
    from . import production as p
    generation=row['payload'].get('generation',{})
    if generation.get('method')!='reuse':return None
    inputs=generation.get('inputs',[])
    if len(inputs)!=1:return None
    source=p.ref_record(store,inputs[0]['reference'])
    if source['kind']!='REQUIREMENT':return None
    same=requirement_fields(row['payload'])==requirement_fields(source['payload'])
    same_output=generation.get('output')==source['payload'].get('generation',{}).get('output')
    if not same or not same_output:return None
    return source


def definition(store,row):
    from . import production as p, material_plans as mp
    need=row if row['kind']=='REQUIREMENT' else None
    call=row if row['kind']=='CALL' else None
    gaps=[];evidence={}
    if call and store:
        exact=call['payload'].get('generation_requirement') or call['payload'].get('prepared_plan')
        if exact:
            need=p.ref_record(store,exact,{'REQUIREMENT'})
            evidence['requirement_binding']={'field':'generation_requirement' if call['payload'].get('generation_requirement') else 'prepared_plan','record':ref(call)}
            seen=set()
            while need['payload'].get('generation',{}).get('method')=='reuse':
                if need['id'] in seen:raise ValueError('cyclic reuse requirement')
                seen.add(need['id']);source=reuse_source(store,need)
                if not source:
                    gaps.append('prepared_reuse_does_not_prove_identical_requirements');break
                evidence.setdefault('reuse_chain',[]).append({'record':ref(need),'field':'generation.inputs[0].reference','target':ref(source)})
                need=source
    if need is None:gaps.append('historical_requirement_definition_missing')
    generation=mp.scheme(row['payload'],row['kind'])
    output=copy.deepcopy(need['payload'].get('generation',{}).get('output')) if need else None
    if output is None:gaps.append('historical_output_definition_missing')
    if call and need:
        original=mp.scheme(need['payload'],'REQUIREMENT')
        if original!=generation:gaps.append('actual_generation_differs_from_referenced_plan')
    if not mp.known(row):gaps.append('generation_definition_incomplete')
    content={'format':'material-definition-v1','requirements':requirement_fields(need['payload']) if need else None,
             'checks':copy.deepcopy(output.get('review_criteria',[])) if isinstance(output,dict) else None,
             'output':output,'generation':generation}
    provenance={'requirements':{'record':ref(need),'fields':sorted(requirement_fields(need['payload']))} if need else None,
                'checks':{'record':ref(need),'field':'generation.output.review_criteria'} if need and output else None,
                'output':{'record':ref(need),'field':'generation.output'} if need and output else None,
                'generation':{'record':ref(row),'field':'generation' if row['kind']=='REQUIREMENT' else '$'},**evidence}
    return content,provenance,gaps


def signature(row,store=None):
    content,_,_=definition(store,row)
    from .material_plans import known
    identity={'definition':content,'incomplete_call':row['object_id']} if row['kind']=='CALL' and not known(row) else content
    return digest(canonical(identity).encode())


def bind_definition(store,mid,number,row):
    content,provenance,gaps=definition(store,row)
    key=storage.intern(store,content)
    store.db.execute('INSERT OR IGNORE INTO material_definitions VALUES (?)',(key,))
    old=store.db.execute('SELECT * FROM material_definition_versions WHERE material_id=? AND number=?',(mid,number)).fetchone()
    frozen=store.db.execute('SELECT frozen FROM material_plan_versions WHERE material_id=? AND number=?',(mid,number)).fetchone()
    if old and frozen and frozen[0]:
        if old['definition_id']!=key:raise Conflict('a submitted material version has an immutable complete definition')
        return key
    store.db.execute('INSERT INTO material_definition_versions VALUES (?,?,?,?,?) ON CONFLICT(material_id,number) DO UPDATE SET definition_id=excluded.definition_id,provenance=excluded.provenance,gaps=excluded.gaps',
                     (mid,number,key,canonical(provenance),canonical(gaps)))
    return key


def projection(store,mid,number):
    from . import production as p
    row=store.db.execute('SELECT * FROM material_definition_versions WHERE material_id=? AND number=?',(mid,number)).fetchone()
    if not row:return {}
    provenance=json.loads(row['provenance']);gaps=json.loads(row['gaps'])
    sources={}
    for field in ('requirements','generation'):
        source=provenance.get(field)
        if source:sources[field]=p.ref_record(store,source['record'])
    return {'canonical_material_id':storage.canonical_id(store,mid),'definition_id':row['definition_id'],
            'definition':storage.expand(store,row['definition_id']),'definition_provenance':provenance,
            'definition_gaps':gaps,'definition_records':{'requirement':sources.get('requirements'),
                'call':sources.get('generation') if sources.get('generation',{}).get('kind')=='CALL' else None},
            'alias_version':{'material_id':mid,'number':number}}


def prove_aliases(store):
    from . import production as p
    result=[];heads={r['object_id']:r for r in p.current_records(store,{'REQUIREMENT'})}
    for row in heads.values():
        source=reuse_source(store,row)
        if not source:continue
        chain=[];seen={row['object_id']}
        while source:
            if source['object_id'] in seen:raise ValueError('cyclic material reuse')
            seen.add(source['object_id']);chain.append(ref(source))
            if source['object_id'] not in heads or heads[source['object_id']]['id']!=source['id']:
                # An old target remains exact reuse, but a changed current need
                # is a distinct current identity until explicitly reviewed.
                source=None;break
            further=reuse_source(store,source)
            if further:source=further
            else:break
        if source:
            result.append({'alias_id':row['object_id'],'material_id':source['object_id'],
                'evidence':canonical({'kind':'explicit_same_requirement_reuse','alias_revision':ref(row),
                    'target_chain':chain,'compared_fields':sorted(requirement_fields(row['payload'])),
                    'output_equal':True,'association_differences':['title','scope','states']})})
    return sorted(result,key=lambda r:r['alias_id'])


def migration_plan(store, system_head=None, archive_paths=()):
    """Prepare a reviewable delta against exact relevant heads, never a DB copy."""
    from . import production as p, material_plans as mp, material_archives as archives
    store.db.execute('SAVEPOINT material_model_plan')
    try:
        before=storage.dump(store)
        raw_rows=storage.physical_revisions(store)
        objects={o['id']:o for o in store.objects()}
        affected={r['object_id'] for r in raw_rows if objects[r['object_id']]['kind'] in ('REQUIREMENT','CALL','ASSET')}
        expected_heads={oid:objects[oid]['current_revision'] for oid in sorted(affected)}
        baseline_versions=mp.dump(store)
        proven_aliases=prove_aliases(store)
        previous_aliases={r["alias_id"]:r for r in before["material_aliases"]}
        aliases=[row for row in proven_aliases if row["alias_id"] not in previous_aliases]
        if any(previous_aliases[row["alias_id"]]["material_id"]!=row["material_id"] for row in proven_aliases if row["alias_id"] in previous_aliases):raise Conflict("existing shared identity differs from exact reuse evidence")
        changes=[]
        for raw in raw_rows:
            logical=storage.hydrate(store,raw['payload'])
            payload=json.loads(logical)
            if payload.get('format') not in storage.KINDS:continue
            encoded=storage.encode(store,payload,logical)
            if encoded!=raw['payload']:
                changes.append({'revision_id':raw['id'],'before_sha256':digest(raw['payload'].encode()),
                    'logical_sha256':digest(logical.encode()),'payload':encoded})
        bindings=[];versions=[];gaps=[]
        for version in baseline_versions['material_plan_versions']:
            members=[p.record(store,revision_id=m['revision_id']) for m in baseline_versions['material_plan_members']
                     if m['material_id']==version['material_id'] and m['number']==version['number']]
            calls=sorted([r for r in members if r['kind']=='CALL'],key=lambda r:(r['created_at'],r['object_id'],r['version']))
            plans=sorted([r for r in members if r['kind']=='REQUIREMENT'],key=lambda r:r['version'])
            candidates=calls or plans[-1:]
            if not candidates:raise ValueError('material version has no definition source')
            source=candidates[0]
            content,provenance,missing=definition(store,source)
            key=storage.intern(store,content)
            store.db.execute('INSERT OR IGNORE INTO material_definitions VALUES (?)',(key,))
            binding={'material_id':version['material_id'],'number':version['number'],'definition_id':key,
                     'provenance':canonical(provenance),'gaps':canonical(missing)}
            bindings.append(binding)
            versions.append({'before':version,'after':{**version,'fingerprint':signature(source,store)}})
            if missing:gaps.append({'material_id':version['material_id'],'number':version['number'],'evidence':missing,'source':ref(source)})
        archived=[];root=p.root_of(store)
        files={c['file'] for r in store.revisions() for c in json.loads(r['payload']).get('components',[])
               if c.get('role')=='metadata' and c.get('mime')=='application/json'}
        paths=sorted({*[str(__import__('pathlib').Path('export/assets')/name) for name in files],*archive_paths})
        for relative in paths:
            part=__import__('pathlib').Path(relative)
            if part.is_absolute() or '..' in part.parts:raise ValueError('unsafe archive path')
            path=root/part
            name=part.name
            if path.is_symlink() or not path.is_file():raise ValueError('archive must be a real managed file: '+name)
            if archives.reference(path):continue
            raw=path.read_bytes();container=archives.encode(store,raw);archive_cache={}
            if archives.decode(container,lambda k:storage.expand(store,k,cache=archive_cache))!=raw:raise ValueError('archive lost original bytes')
            archived.append({'file':name,'path':relative,'before_sha256':digest(raw),'container':container})
        after=storage.dump(store)
        additions={table:[r for r in after[table] if r not in before[table]] for table in ('material_content','material_definitions')}
        alias_mapping={v['alias_id']:v['material_id'] for v in proven_aliases}
        mapped=[]
        for binding in bindings:
            mid=binding['material_id'];canonical_mid=alias_mapping.get(mid,mid)
            numbers=[v['number'] for v in bindings if v['material_id']==canonical_mid and v['definition_id']==binding['definition_id']]
            mapped.append({'old_material_id':mid,'old_number':binding['number'],'material_id':canonical_mid,
                           'number':numbers[0] if numbers else None,'definition_id':binding['definition_id'],
                           'historical_alias_version_retained':not bool(numbers)})
        body={'format':'material-model-migration-v1','system_head':system_head,'expected_heads':expected_heads,
              'before_indices':baseline_versions,'before_model_indices':{t:before[t] for t in storage.TABLES[2:]},
              'revisions':changes,'content':additions,'aliases':aliases,'definitions':bindings,'versions':versions,
              'archives':archived,'version_mapping':mapped,'gaps':gaps,
              'counts':{'requirements_before':sum(o['kind']=='REQUIREMENT' for o in objects.values()),
                        'merged_aliases':len(proven_aliases),'requirements_after':sum(o['kind']=='REQUIREMENT' for o in objects.values())-len(proven_aliases),
                        'revisions_compacted':len(changes),'archives_compacted':len(archived)}}
        body['id']=digest(canonical(body).encode())
        return body
    finally:
        store.db.execute('ROLLBACK TO material_model_plan');store.db.execute('RELEASE material_model_plan')


def migrate(store,document,validate_only=False,system_head=None,apply_archives=True):
    from contextlib import ExitStack
    from . import production as p,material_plans as mp,material_archives as archives
    from .bundle import _staged_files,_bytes
    if document.get('format')!='material-model-migration-v1':raise ValueError('unsupported material model migration')
    if document.get('id')!=digest(canonical({k:v for k,v in document.items() if k!='id'}).encode()):raise ValueError('migration document checksum mismatch')
    if system_head and document.get('system_head')!=system_head:raise Conflict('system head differs from reviewed migration')
    store.db.execute('PRAGMA secure_delete=ON')
    with ExitStack() as files:
        store.db.execute('BEGIN IMMEDIATE')
        store._material_migrating=True
        try:
            prior=store.db.execute('SELECT document FROM material_model_migrations WHERE id=?',(document['id'],)).fetchone()
            if prior:
                verify(store)
                store.db.rollback();return {'already_applied':True,'id':document['id']}
            for oid,head in document['expected_heads'].items():
                actual=store.db.execute('SELECT current_revision FROM objects WHERE id=?',(oid,)).fetchone()
                if not actual or actual[0]!=head:raise Conflict('relevant material head changed: '+oid)
            # Indexed material edits conflict; unrelated objects/comments are retained.
            current=mp.dump(store);mids=set(document['expected_heads'])
            touched_revisions={r['revision_id'] for r in document['before_indices']['material_plan_members'] if r['material_id'] in mids}
            for table,expected in document['before_indices'].items():
                if table=='material_plan_comments':continue  # comments are never rewritten
                def touched(row):
                    return row.get('material_id') in mids or table=='material_candidate_members' and row['revision_id'] in touched_revisions
                if [r for r in current[table] if touched(r)]!=[r for r in expected if touched(r)]:
                    raise Conflict('material version membership changed: '+table)
            for table,expected in document['before_model_indices'].items():
                if table=='material_model_migrations':continue
                actual=[dict(r) for r in store.db.execute('SELECT * FROM '+table+' ORDER BY 1,2')]
                if [r for r in actual if r.get('material_id') in mids or r.get('alias_id') in mids]!=[r for r in expected if r.get('material_id') in mids or r.get('alias_id') in mids]:raise Conflict('material model mapping changed: '+table)
            for row in document['content']['material_content']:
                if digest(row['body'].encode())!=row['id']:raise ValueError('invalid content delta')
                store.db.execute('INSERT OR IGNORE INTO material_content VALUES (?,?)',(row['id'],row['body']))
            for row in document['content']['material_definitions']:
                storage.expand(store,row['id']);store.db.execute('INSERT OR IGNORE INTO material_definitions VALUES (?)',(row['id'],))
            for row in document['revisions']:
                raw=store.db.execute('SELECT payload AS stored_payload FROM revisions WHERE id=?',(row['revision_id'],)).fetchone()
                if not raw or digest(raw[0].encode())!=row['before_sha256']:raise Conflict('historical payload changed: '+row['revision_id'])
                hydrated=storage.hydrate(store,row['payload'])
                if digest(hydrated.encode())!=row['logical_sha256']:raise ValueError('historical payload cannot be restored')
                store.db.execute('UPDATE revisions SET payload=? WHERE id=?',(row['payload'],row['revision_id']))
            for alias in document['aliases']:
                store.db.execute('INSERT INTO material_aliases VALUES (?,?,?)',(alias['alias_id'],alias['material_id'],alias['evidence']))
            for row in document['definitions']:
                store.db.execute('INSERT INTO material_definition_versions VALUES (?,?,?,?,?) ON CONFLICT(material_id,number) DO UPDATE SET definition_id=excluded.definition_id,provenance=excluded.provenance,gaps=excluded.gaps',tuple(row[k] for k in ('material_id','number','definition_id','provenance','gaps')))
            for version in document['versions']:
                row=version['after'];store.db.execute('UPDATE material_plan_versions SET fingerprint=? WHERE material_id=? AND number=?',(row['fingerprint'],row['material_id'],row['number']))
            archive_files={}
            for row in document['archives']:
                relative=row.get('path','export/assets/'+row['file'])
                part=__import__('pathlib').Path(relative)
                if part.is_absolute() or '..' in part.parts:raise ValueError('unsafe archive path')
                path=p.root_of(store)/part
                if p.root_of(store).resolve() not in path.resolve().parents:raise ValueError('archive path leaves instance')
                if path.is_symlink() or digest(path.read_bytes())!=row['before_sha256']:raise Conflict('managed archive changed: '+row['file'])
                data=archives.decode(row['container'],lambda key:storage.expand(store,key))
                if digest(data)!=row['before_sha256']:raise ValueError('archive original hash differs')
                archive_files[relative]=_bytes(row['container'])
                prior_archive=store.db.execute('SELECT container FROM material_archive_files WHERE path=?',(relative,)).fetchone()
                if prior_archive and prior_archive[0]!=canonical(row['container']):raise Conflict('archive catalog changed: '+relative)
                store.db.execute('INSERT OR IGNORE INTO material_archive_files VALUES (?,?)',(relative,canonical(row['container'])))
            mp.validate(store)
            verify(store)
            if validate_only:
                store.db.rollback()
                return {'already_applied':False,'validated_only':True,'id':document['id'],**document['counts']}
            publish_archives=files.enter_context(_staged_files(p.root_of(store),archive_files if apply_archives else {}))
            graph={'format':'material-content-v1','material_content':storage.dump(store)['material_content']}
            publish_graph=files.enter_context(_staged_files(p.root_of(store)/'export',{'material-content.json':_bytes(graph)} if apply_archives else {}))
            store.db.execute('INSERT INTO material_model_migrations VALUES (?,?)',(document['id'],canonical({'format':document['format'],'counts':document['counts'],'system_head':document.get('system_head')})))
            publish_graph();publish_archives();store.db.commit()
            return {'already_applied':False,'validated_only':False,'id':document['id'],**document['counts']}
        except BaseException:
            store.db.rollback();raise
        finally:
            store._material_migrating=False


def verify(store):
    from .production import read_scope
    with read_scope(store):return _verify(store)


def _verify(store):
    from . import production as p
    for revision in store.revisions():
        payload=json.loads(revision['payload'])
        if digest(canonical({'object_id':revision['object_id'],'version':revision['version'],'payload':payload}).encode())!=revision['id']:
            raise ValueError('hydrated revision identity changed: '+revision['id'])
    for alias in store.db.execute('SELECT * FROM material_aliases'):
        if alias['alias_id']==alias['material_id']:raise ValueError('self material alias')
        row=p.record(store,alias['alias_id']);source=reuse_source(store,row);seen={row['object_id']}
        if not source:raise ValueError('material alias lacks exact identical reuse evidence')
        while source:
            if source['object_id'] in seen:raise ValueError('cyclic material alias evidence')
            seen.add(source['object_id']);further=reuse_source(store,source)
            if further:source=further
            else:break
        if source['object_id']!=alias['material_id']:raise ValueError('material alias points outside its explicit reuse chain')
        current=p.record(store,alias['material_id'])
        if requirement_fields(row['payload'])!=requirement_fields(current['payload']) or row['payload'].get('generation',{}).get('output')!=current['payload'].get('generation',{}).get('output'):
            raise ValueError('material alias current requirements differ')
    versions={(r[0],r[1]) for r in store.db.execute('SELECT material_id,number FROM material_plan_versions')}
    bindings={(r[0],r[1]) for r in store.db.execute('SELECT material_id,number FROM material_definition_versions')}
    if versions!=bindings:raise ValueError('material versions are missing complete definition bindings')
    for binding in store.db.execute('SELECT * FROM material_definition_versions'):
        provenance=json.loads(binding['provenance'])
        source=p.ref_record(store,provenance['generation']['record'])
        content,expected,gaps=definition(store,source)
        if storage.content_id(content)!=binding['definition_id'] or expected!=provenance or gaps!=json.loads(binding['gaps']):
            raise ValueError('material complete definition differs from exact provenance')
        actual=storage.expand(store,binding['definition_id'])
        if actual!=content:raise ValueError('material definition content differs from key')
        if not store.db.execute('SELECT 1 FROM material_plan_members WHERE material_id=? AND number=? AND revision_id=?',(binding['material_id'],binding['number'],source['id'])).fetchone():
            raise ValueError('material definition source is outside its version')
        version=store.db.execute('SELECT fingerprint FROM material_plan_versions WHERE material_id=? AND number=?',(binding['material_id'],binding['number'])).fetchone()
        if not version or version[0]!=signature(source,store):raise ValueError('material version fingerprint differs from full definition')
    from . import material_archives as archives
    from pathlib import Path
    for row in store.db.execute('SELECT * FROM material_archive_files'):
        part=Path(row['path'])
        if part.is_absolute() or '..' in part.parts or len(part.parts)<2 or part.parts[0] not in ('production','export'):raise ValueError('unsafe archive catalog path')
        archives.decode(json.loads(row['container']),lambda key:storage.expand(store,key))
    if store.db.execute('PRAGMA foreign_key_check').fetchone():raise ValueError('material model foreign key failure')
    return {'revision_count':store.db.execute('SELECT COUNT(*) FROM revisions').fetchone()[0],
            'content_nodes':store.db.execute('SELECT COUNT(*) FROM material_content').fetchone()[0],
            'definitions':store.db.execute('SELECT COUNT(*) FROM material_definitions').fetchone()[0],
            'aliases':store.db.execute('SELECT COUNT(*) FROM material_aliases').fetchone()[0]}


def rollback(store,document,validate_only=False):
    """Undo only this exact delta; preserve unrelated subsequent business rows."""
    from contextlib import ExitStack
    from . import production as p,material_archives as archives
    from .bundle import _staged_files
    if document.get('format')!='material-model-migration-v1' or document.get('id')!=digest(canonical({k:v for k,v in document.items() if k!='id'}).encode()):
        raise ValueError('invalid rollback document')
    with ExitStack() as files:
        store.db.execute('BEGIN IMMEDIATE')
        store._material_migrating=True
        try:
            if not store.db.execute('SELECT 1 FROM material_model_migrations WHERE id=?',(document['id'],)).fetchone():
                store.db.rollback();return {'already_rolled_back':True,'id':document['id']}
            for oid,head in document['expected_heads'].items():
                current=store.db.execute('SELECT current_revision FROM objects WHERE id=?',(oid,)).fetchone()
                if not current or current[0]!=head:raise Conflict('material changed after migration: '+oid)
            for version in document['versions']:
                expected=version['after'];actual=store.db.execute('SELECT * FROM material_plan_versions WHERE material_id=? AND number=?',(expected['material_id'],expected['number'])).fetchone()
                if not actual or dict(actual)!=expected:raise Conflict('material version changed after migration')
            original_files={}
            for row in document['archives']:
                relative=row.get('path','export/assets/'+row['file'])
                part=__import__('pathlib').Path(relative)
                if part.is_absolute() or '..' in part.parts:raise ValueError('unsafe archive path')
                path=p.root_of(store)/part
                if p.root_of(store).resolve() not in path.resolve().parents:raise ValueError('archive path leaves instance')
                current=archives.reference(path)
                if current is None and digest(path.read_bytes())==row['before_sha256']:continue
                if current!=row['container']:raise Conflict('archive container changed after migration')
                original_files[relative]=archives.decode(row['container'],lambda key:storage.expand(store,key))
            for row in document['revisions']:
                raw=store.db.execute('SELECT payload AS stored_payload FROM revisions WHERE id=?',(row['revision_id'],)).fetchone()
                if not raw or raw[0]!=row['payload']:raise Conflict('revision representation changed after migration')
                restored=storage.hydrate(store,raw[0])
                if digest(restored.encode())!=row['before_sha256']:raise ValueError('rollback cannot recreate original payload bytes')
                store.db.execute('UPDATE revisions SET payload=? WHERE id=?',(restored,row['revision_id']))
            for version in document['versions']:
                old=version['before'];store.db.execute('UPDATE material_plan_versions SET fingerprint=? WHERE material_id=? AND number=?',(old['fingerprint'],old['material_id'],old['number']))
            for row in document['aliases']:
                current=store.db.execute('SELECT * FROM material_aliases WHERE alias_id=?',(row['alias_id'],)).fetchone()
                if not current or dict(current)!=row:raise Conflict('alias mapping changed after migration')
                store.db.execute('DELETE FROM material_aliases WHERE alias_id=?',(row['alias_id'],))
            for row in document['definitions']:
                current=store.db.execute('SELECT * FROM material_definition_versions WHERE material_id=? AND number=?',(row['material_id'],row['number'])).fetchone()
                if not current or dict(current)!=row:raise Conflict('complete definition changed after migration')
                store.db.execute('DELETE FROM material_definition_versions WHERE material_id=? AND number=?',(row['material_id'],row['number']))
            for row in document['archives']:
                relative=row.get('path','export/assets/'+row['file'])
                current=store.db.execute('SELECT container FROM material_archive_files WHERE path=?',(relative,)).fetchone()
                if not current or current[0]!=canonical(row['container']):raise Conflict('archive catalog changed after migration')
                store.db.execute('DELETE FROM material_archive_files WHERE path=?',(relative,))
            for row in document['before_model_indices'].get('material_archive_files',[]):
                store.db.execute('INSERT OR IGNORE INTO material_archive_files VALUES (?,?)',(row['path'],row['container']))
            for row in document['before_model_indices']['material_definition_versions']:
                store.db.execute('INSERT INTO material_definition_versions VALUES (?,?,?,?,?)',tuple(row[k] for k in ('material_id','number','definition_id','provenance','gaps')))
            store.db.execute('DELETE FROM material_model_migrations WHERE id=?',(document['id'],))
            if validate_only:
                store.db.rollback();return {'already_rolled_back':False,'validated_only':True,'id':document['id']}
            publish=files.enter_context(_staged_files(p.root_of(store),original_files))
            publish();store.db.commit()
            return {'already_rolled_back':False,'validated_only':False,'id':document['id']}
        except BaseException:
            store.db.rollback();raise
        finally:
            store._material_migrating=False


def refresh_identity(store,row):
    """Current state-specific edits split identity; exact old links stay intact."""
    from . import production as p
    if row['kind']!='REQUIREMENT':return
    affected={row['object_id'],*[r[0] for r in store.db.execute('SELECT alias_id FROM material_aliases WHERE material_id=?',(row['object_id'],))]}
    for oid in affected:
        current=p.record(store,oid);source=reuse_source(store,current);chain=[];seen={oid}
        while source:
            if source['object_id'] in seen:raise ValueError('cyclic material reuse identity')
            seen.add(source['object_id']);chain.append(ref(source))
            next_source=reuse_source(store,source)
            if next_source:source=next_source
            else:break
        if source:
            head=p.record(store,source['object_id'])
            if requirement_fields(current['payload'])!=requirement_fields(head['payload']) or current['payload'].get('generation',{}).get('output')!=head['payload'].get('generation',{}).get('output'):
                source=None
        if source:
            evidence={'kind':'explicit_same_requirement_reuse','alias_revision':ref(current),'target_chain':chain,
                      'compared_fields':sorted(requirement_fields(current['payload'])),'output_equal':True,
                      'association_differences':['title','scope','states']}
            store.db.execute('INSERT INTO material_aliases VALUES (?,?,?) ON CONFLICT(alias_id) DO UPDATE SET material_id=excluded.material_id,evidence=excluded.evidence',
                             (oid,source['object_id'],canonical(evidence)))
        else:
            store.db.execute('DELETE FROM material_aliases WHERE alias_id=?',(oid,))


def write_migration_package(store,document,path,content_path=None):
    """Persist one content graph; the reviewed delta carries only graph keys."""
    from pathlib import Path
    import os
    from .bundle import _bytes
    path=Path(path)
    content_path=Path(content_path) if content_path else path.parent/'material-content.json'
    nodes={row['id']:row for row in storage.dump(store)['material_content']}
    nodes.update({row['id']:row for row in document['content']['material_content']})
    graph=_bytes({'format':'material-content-v1','material_content':[nodes[k] for k in sorted(nodes)]})
    packed=copy.deepcopy(document)
    packed['content']['material_content']=[{'id':row['id']} for row in packed['content']['material_content']]
    envelope={'format':'material-model-package-v1','migration':packed,
              'content_source':os.path.relpath(content_path,path.parent),
              'content_sha256':digest(graph),'migration_id':document['id']}
    path.parent.mkdir(parents=True,exist_ok=True);content_path.parent.mkdir(parents=True,exist_ok=True)
    content_path.write_bytes(graph);path.write_bytes(_bytes(envelope))
    return {'migration':str(path),'content':str(content_path),'id':document['id'],'content_sha256':digest(graph)}


def load_migration(path,content_path=None):
    from pathlib import Path
    path=Path(path);value=json.loads(path.read_text())
    if value.get('format')=='material-model-migration-v1':return value
    if value.get('format')!='material-model-package-v1':raise ValueError('unsupported material migration package')
    source=Path(content_path) if content_path else path.parent/value['content_source']
    if source.is_symlink():raise ValueError('migration content graph cannot be a symlink')
    raw=source.read_bytes()
    if digest(raw)!=value['content_sha256']:raise ValueError('migration content graph changed')
    graph=json.loads(raw)
    if graph.get('format')!='material-content-v1':raise ValueError('invalid migration content graph')
    nodes={r['id']:r for r in graph['material_content']}
    document=value['migration']
    document['content']['material_content']=[nodes[row['id']] for row in document['content']['material_content']]
    if value['migration_id']!=document.get('id') or digest(canonical({k:v for k,v in document.items() if k!='id'}).encode())!=document['id']:
        raise ValueError('migration package differs from reviewed delta')
    return document
