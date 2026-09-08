import path from 'node:path';
import {canonicalJson,sha256} from './instance-runtime/bytes.mjs';
import {requireSource} from './instance-source-proof.mjs';

const hash = value => sha256(canonicalJson(value));
const check = (value,message) => requireSource(value,'SOURCE_REGISTERED_CANDIDATE_BINDING',message);
const one = (rows,predicate,message) => {const matches=rows.filter(predicate);check(matches.length===1,message);return matches[0];};
const json = bytes => JSON.parse(Buffer.from(bytes).toString('utf8'));
const safePath = value => typeof value==='string' && value && !path.posix.isAbsolute(value) && !value.includes('\\') && !value.includes('\0') && path.posix.normalize(value)===value && !value.split('/').includes('..');
const source = (documents,alias) => {const doc=one(documents,row=>row.aliases?.includes(alias),`Missing or ambiguous pinned source: ${alias}`);check(doc.revisionId&&!doc.deleted&&sha256(doc.bytes)===doc.sha256,`Pinned source bytes differ: ${alias}`);return doc;};
const pin = (doc,alias) => ({path:alias,revisionId:doc.revisionId,sha256:doc.sha256});
const outputBinding = row => Object.fromEntries(['id','familyId','targetPath','legacyVersionId'].map(key=>[key,row[key]??null]));
const historicalOutput = event => {
  const label=event.versionId.split('@').at(-1);
  return {id:event.expectedOutputId,familyId:event.familyId,label,targetPath:event.path,plannedVersionLabel:label,legacyVersionId:event.versionId,expectationState:'REALIZED',sourceRef:`ASSET_VERSION_EVENT:${event.eventId}`,promptRef:null,model:null,assetRole:null,provenance:{class:'REGISTERED_MATERIAL_CANDIDATE_HISTORY',eventId:event.eventId,sha256:event.sha256},realizedVersionId:event.versionId,scopeRole:'HISTORICAL',activityRole:'HISTORICAL_EVIDENCE',countsTowardCurrent:false,executionDefinitionRef:null};
};
function historicalExpectationProof({requirements,events,model,activeMedia,pinnedMediaHashes,compiler}) {
  const targets=new Map();
  for(const r of requirements.filter(r=>r.planned_family_id&&r.planned_output_path)) {
    check(!targets.has(r.planned_family_id)||targets.get(r.planned_family_id)===r.planned_output_path,'Ambiguous current planned output');
    targets.set(r.planned_family_id,r.planned_output_path);
  }
  const candidates=events.filter(e=>e.eventKind==='asset-version'&&e.schemaVersion==='1.1'&&targets.has(e.familyId)&&e.path!==targets.get(e.familyId));
  if(!candidates.length)return null;
  const records=[];
  for(const event of candidates) {
    check(safePath(event.path)&&event.path.startsWith('production/generated/')&&event.versionId===`${event.familyId}@${event.path.match(/_(V[0-9]{3})\.[^.]+$/)?.[1]}`&&event.expectedOutputId===`EXPECTED_OUTPUT:${event.versionId}`,'Historical candidate output identity differs');
    check(event.plannedVersionId===event.versionId&&event.realizationRelation==='REALIZES'&&event.realizes?.relationType==='REALIZES'&&event.realizes?.expectedOutputId===event.expectedOutputId&&event.realizes?.assetVersionId===event.versionId,'Historical candidate realization differs');
    check(event.outputState==='PRESENT'&&event.historyRole==='CANDIDATE'&&event.lifecycleState==='REVIEW_PENDING'&&event.reviewDecision==='PENDING'&&event.registrationState==='CANDIDATE_REGISTERED_EXPECTED_OUTPUT_REALIZED'&&event.adoptionPerformed===false,'Historical candidate is not an immutable registration');
    const family=one(model.assetFamilies||[],r=>r.id===event.familyId,'Historical family is missing or ambiguous');
    const current=one(model.expectedOutputs||[],r=>r.familyId===family.id&&r.targetPath===targets.get(family.id),'Historical family has no exact current planned output');
    check(family.expectedOutputRefs?.includes(current.id),'Current planned output is not owned by the historical family');
    const output=historicalOutput(event),base=(model.assetVersions||[]).filter(v=>v.id===event.versionId),prior=(model.expectedOutputs||[]).filter(o=>o.id===event.expectedOutputId);
    check(base.length<=1&&prior.length<=1&&(base.length===1||prior.length===1),'Historical output has no published version or prior exact historical expectation');
    if(base.length)check(base[0].familyId===family.id&&base[0].path===event.path&&base[0].sha256===event.sha256&&family.versionRefs?.includes(event.versionId),'Historical published version differs from the immutable event');
    if(prior.length)check(hash(prior[0])===hash(output)&&family.expectedOutputRefs?.includes(output.id),'Historical published expectation differs from its original event');
    const media=one(activeMedia,r=>r.mediaId===family.id&&r.versionId===event.versionId,'Historical candidate media registration is missing or ambiguous');
    const imported=media.metadata?.legacyVersion;
    const registrationBound=media.metadata?.registrationEventId===event.eventId||!media.metadata?.registrationEventId&&imported&&Object.entries(event).every(([key,value])=>canonicalJson(imported[key])===canonicalJson(value));
    check(media.metadata?.authorityDomain==='FORMAL'&&registrationBound&&media.availability==='PRESENT'&&media.sha256===event.sha256&&media.byteSize===event.byteSize&&pinnedMediaHashes[event.path]===event.sha256&&/^[a-f0-9]{64}$/.test(event.sha256||'')&&Number.isSafeInteger(event.byteSize)&&event.byteSize>0,'Historical candidate is not exact active formal bytes');
    check(/^[a-f0-9]{64}$/.test(event.idempotencyKeyHash||''),'Historical event filename is invalid');
    records.push({familyId:family.id,versionId:event.versionId,expectedOutputId:event.expectedOutputId,path:event.path,sha256:event.sha256,byteSize:event.byteSize,eventId:event.eventId,eventProof:[{eventId:event.eventId,path:`${compiler.eventDirectory}/asset-version-${event.idempotencyKeyHash}.json`,sha256:hash(event)}],baseVersionHash:base.length?hash(base[0]):null,expectedOutput:output});
  }
  check(new Set(records.map(r=>r.expectedOutputId)).size===records.length&&new Set(records.map(r=>r.path)).size===records.length,'Historical candidate output is duplicated');
  // Native source preservation owns these families. Do not infer ownership
  // from an ID prefix or include their independently authored output slots.
  const nativeFamilies=new Set([...(model.materialProductionPlans||[]).map(p=>p.familyId),...(model.workItems||[]).filter(w=>(model.shotProductionPlans||[]).some(p=>p.workItemIds?.includes(w.id))).map(w=>w.outputAssetRef)]);
  const historyIds=new Set(records.map(r=>r.expectedOutputId));
  const currentOutputs=(model.expectedOutputs||[]).filter(o=>!nativeFamilies.has(o.familyId)&&!historyIds.has(o.id)).map(outputBinding).sort((a,b)=>a.id.localeCompare(b.id));
  check(new Set(currentOutputs.map(r=>r.id)).size===currentOutputs.length,'Published ExpectedOutput identity is duplicated');
  return {currentOutputs,records:records.sort((a,b)=>a.versionId.localeCompare(b.versionId))};
}

/** Read-only compatibility proof for event-backed outputs of existing declared
 * families. This never supplies missing authoring, adopts a version or permits
 * a model call. All inputs come from the same capture/active-media read scope. */
export function registeredMaterialCandidateProof({documents,events,activeMedia,pinnedMediaHashes,baseRelease,compiler}) {
  const registryAlias='production/00_control/registries/material_requirements.json';
  const registryRows=documents.filter(row=>row.aliases?.includes(registryAlias));
  if(!registryRows.length)return null;
  const registryDoc=source(documents,registryAlias),registry=json(registryDoc.bytes);
  if(registry.schema_version!=='1.1')return null;
  const requirements=registry.requirements||[];
  const planned=new Set(requirements.filter(r=>r.planned_family_id&&r.planned_output_path).map(r=>r.planned_family_id));
  const declared=new Set(requirements.flatMap(r=>Array.isArray(r.asset_family_refs)?r.asset_family_refs:[]));
  const selected=events.filter(e=>e.eventKind==='asset-version'&&e.schemaVersion==='1.1'&&declared.has(e.familyId)&&!planned.has(e.familyId));
  const hasHistory=events.some(e=>e.eventKind==='asset-version'&&e.schemaVersion==='1.1'&&requirements.some(r=>r.planned_family_id===e.familyId&&r.planned_output_path&&r.planned_output_path!==e.path));
  if(!selected.length&&!hasHistory)return null;
  check(baseRelease?.releaseId&&baseRelease.snapshotBytes&&baseRelease.recipesBytes,'Published release is required');
  const snapshot=json(baseRelease.snapshotBytes),recipes=json(baseRelease.recipesBytes),model=snapshot.productionModel;
  check(model&&snapshot.snapshotId===recipes.snapshotId,'Published snapshot/recipes differ');
  const builderDoc=source(documents,compiler.snapshotBuilderPath);
  const cleanupAlias=path.posix.join(path.posix.dirname(compiler.snapshotBuilderPath),'asset_cleanup_contract.py');
  const cleanupDoc=source(documents,cleanupAlias);
  check(builderDoc.metadata?.sourceRole==='INSTANCE_EXTENSION'&&cleanupDoc.metadata?.sourceRole==='INSTANCE_EXTENSION','Candidate compatibility requires approved compiler extensions');
  const historicalExpectations=historicalExpectationProof({requirements,events,model,activeMedia,pinnedMediaHashes,compiler});
  const records=[];const identities=new Set(),paths=new Set();
  for(const event of selected){
    check(!identities.has(event.versionId)&&!paths.has(event.path),'Duplicate candidate version/path');identities.add(event.versionId);paths.add(event.path);
    check(safePath(event.path)&&event.path.startsWith('production/generated/')&&/_[V][0-9]{3}\.[^.]+$/.test(event.path),'Candidate output path is invalid');
    const version=event.path.match(/_(V[0-9]{3})\.[^.]+$/)[1];
    check(event.versionId===`${event.familyId}@${version}`&&event.expectedOutputId===`EXPECTED_OUTPUT:${event.versionId}`&&event.plannedVersionId===event.versionId&&event.realizationRelation==='REALIZES'&&event.realizes?.relationType==='REALIZES'&&event.realizes?.expectedOutputId===event.expectedOutputId&&event.realizes?.assetVersionId===event.versionId,'Candidate ExpectedOutput realization differs');
    check(event.outputState==='PRESENT'&&event.historyRole==='CANDIDATE'&&event.lifecycleState==='REVIEW_PENDING'&&event.reviewDecision==='PENDING'&&event.registrationState==='CANDIDATE_REGISTERED_EXPECTED_OUTPUT_REALIZED'&&event.adoptionPerformed===false,'Candidate is not an immutable pending registration');
    check(/^[a-f0-9]{64}$/.test(event.sha256||'')&&Number.isSafeInteger(event.byteSize)&&event.byteSize>0&&Array.isArray(event.inputBindings)&&hash(event.inputBindings)===event.inputBindingsHash,'Candidate bytes/input closure is invalid');
    const family=one(model.assetFamilies||[],r=>r.id===event.familyId,'Candidate family is not unique in published model');
    const output=one(model.expectedOutputs||[],r=>r.id===event.expectedOutputId,'Candidate has no exact published ExpectedOutput');
    check(output.familyId===family.id&&output.targetPath===event.path&&family.expectedOutputRefs?.includes(output.id)&&!(model.assetVersions||[]).some(v=>v.id===event.versionId),'Event candidate must remain outside immutable base versions');
    const definition=one(recipes.executionDefinitions||[],r=>r.id===event.executionDefinitionId&&r.definitionHash===event.executionDefinitionHash,'Candidate definition is not the frozen published definition');
    // This legacy bridge covers the original, text-only material calls. Native
    // source-owned calls have a separate exact ordered-input proof above it.
    check(Array.isArray(definition.upload?.items)&&definition.upload.items.length===0&&event.inputBindings.length===0,'Legacy compatibility requires a frozen zero-reference call');
    check(definition.currentRevisionId===event.promptRevisionId&&event.callPackageHash===definition.definitionHash&&definition.output?.assetFamilyRef===family.id&&definition.output?.expectedOutputRef===output.id&&definition.output?.path===event.path,'Candidate definition output closure differs');
    check(requirements.some(r=>(r.asset_family_refs||[]).includes(family.id)&&r.requirement_id===definition.materialRequirementRef),'Definition is not bound to the declared material requirement');
    const promptDoc=source(documents,definition.source?.path);
    check(typeof definition.rawSourceBlock==='string'&&sha256(definition.rawSourceBlock)===definition.source.blockSha256&&Buffer.from(promptDoc.bytes).toString('utf8').includes(definition.rawSourceBlock),'Published prompt block differs');
    const request=events.filter(e=>e.eventKind==='execution-request'&&e.executionRequestId===event.executionRequestId).sort((a,b)=>a.eventSequence-b.eventSequence);
    check(request.length===2&&request[0].action==='AUTHORIZE'&&request[1].action==='CLAIM'&&request.every(r=>r.authorized===true&&r.familyId===family.id&&r.workItemId===definition.workItemRef&&Array.isArray(r.inputBindings)&&r.inputBindings.length===0),'Exact authorized/claimed request is missing or changed');
    const runs=events.filter(e=>e.eventKind==='run'&&e.runId===event.runId).sort((a,b)=>a.eventSequence-b.eventSequence);
    check([['PLANNED','SUBMITTED','SUCCEEDED'],['PLANNED','SUBMITTED','RUNNING','SUCCEEDED']].some(states=>canonicalJson(runs.map(r=>r.state))===canonicalJson(states)),'Run is missing, unresolved or is not an exact successful first attempt');
    const chain=[...request,...runs,event];
    check(chain.every((r,i)=>Number.isSafeInteger(r.eventSequence)&&r.eventSequence>0&&(!i||r.eventSequence>chain[i-1].eventSequence)&&r.snapshotId===event.snapshotId&&r.executionRequestId===event.executionRequestId&&r.executionDefinitionId===event.executionDefinitionId&&r.executionDefinitionHash===event.executionDefinitionHash&&r.promptRevisionId===event.promptRevisionId&&r.callPackageHash===event.callPackageHash&&r.inputBindingsHash===event.inputBindingsHash),'Request/Run/candidate lineage differs');
    const media=one(activeMedia,r=>r.mediaId===family.id&&r.versionId===event.versionId,'Candidate media registration is missing or ambiguous');
    check(media.metadata?.authorityDomain==='FORMAL'&&media.metadata?.registrationEventId===event.eventId&&media.availability==='PRESENT'&&media.sha256===event.sha256&&media.byteSize===event.byteSize&&pinnedMediaHashes[event.path]===event.sha256,'Candidate is not exact active formal bytes');
    const eventProof=chain.map(r=>{check(/^[a-f0-9]{64}$/.test(r.idempotencyKeyHash||''),'Invalid event filename identity');return {eventId:r.eventId,path:`${compiler.eventDirectory}/${r.eventKind}-${r.idempotencyKeyHash}.json`,sha256:hash(r)};});
    check(new Set(eventProof.map(e=>e.eventId)).size===eventProof.length,'Duplicate event identities in candidate chain');
    records.push({familyId:family.id,versionId:event.versionId,expectedOutputId:output.id,path:event.path,sha256:event.sha256,byteSize:event.byteSize,eventId:event.eventId,eventProof,definitionHash:hash(definition),expectedOutputHash:hash(output),promptSource:pin(promptDoc,definition.source.path)});
  }
  records.sort((a,b)=>a.versionId.localeCompare(b.versionId));
  const proof={schemaVersion:'REGISTERED_MATERIAL_CANDIDATE_COMPATIBILITY_V1',releaseId:baseRelease.releaseId,snapshotPath:compiler.snapshotPath,snapshotSha256:sha256(baseRelease.snapshotBytes),recipesSha256:sha256(baseRelease.recipesBytes),registry:pin(registryDoc,registryAlias),builder:pin(builderDoc,compiler.snapshotBuilderPath),cleanup:pin(cleanupDoc,cleanupAlias),records,...(historicalExpectations?{historicalExpectations}:{})};
  return {...proof,proofSha256:hash(proof)};
}

// Audited syntax contracts, not project/family IDs. Unknown compiler behavior
// must receive a new reviewed adapter contract instead of a broad fallback.
export const registeredCandidateSupport = String.raw`
def prepare_registered_material_candidates(root, tree, proof, document_pins, media_pins, native_proof=None, compiler_paths=None):
    import ast, copy, hashlib, importlib, json
    if not proof and not native_proof:
        return (lambda value: value), (lambda module: None), (lambda: None)
    def require(ok, message):
        if not ok:
            raise ValueError('REGISTERED_MATERIAL_CANDIDATE: ' + message)
    def digest(value):
        return hashlib.sha256(value).hexdigest()
    def canonical(value):
        return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()
    for value,schema in [(proof,'REGISTERED_MATERIAL_CANDIDATE_COMPATIBILITY_V1'),(native_proof,'NATIVE_MATERIAL_CANDIDATE_PROOF_V1')]:
        if value:
            require(value.get('schemaVersion')==schema and (value.get('records') or value.get('historicalExpectations',{}).get('records')), 'unknown or empty proof contract')
            require(digest(canonical({k:v for k,v in value.items() if k!='proofSha256'}))==value['proofSha256'], 'proof hash differs')
    paths=compiler_paths or {'builder':proof['builder']['path'],'snapshot':proof['snapshotPath']}
    cleanup_alias=(Path(paths['builder']).parent/'asset_cleanup_contract.py').as_posix()
    source_rows=([proof['registry'],proof['builder'],proof['cleanup'],*[r['promptSource'] for r in proof['records']]] if proof else [])
    if native_proof:
        source_rows += [source for row in native_proof['records'] for source in row['sourceProof']]
    source_rows += [{'path':alias,'sha256':document_pins.get(alias)} for alias in [paths['builder'],cleanup_alias]]
    for item in source_rows:
        require(item.get('sha256') and document_pins.get(item['path'])==item['sha256'] and digest((root/item['path']).read_bytes())==item['sha256'], 'pinned source bytes differ')
    eligible={};native_events={}
    historical=(proof or {}).get('historicalExpectations')
    historical_rows=historical['records'] if historical else []
    for row in (proof['records'] if proof else []) + (native_proof['records'] if native_proof else []) + historical_rows:
        require(media_pins.get(row['path'])==row['sha256'], 'media pin differs')
        content=(root/row['path']).read_bytes()
        require(digest(content)==row['sha256'] and len(content)==row['byteSize'], 'candidate bytes differ')
        for event in row['eventProof']:
            require(digest((root/event['path']).read_bytes())==event['sha256'], 'frozen event bytes differ')
    for row in proof['records'] if proof else []:
        require(row['path'] not in eligible, 'duplicate legacy output path')
        eligible[row['path']]=row
    for row in native_proof['records'] if native_proof else []:
        require(row['eventPath'] not in native_events and row['path'] not in eligible, 'duplicate native event or legacy output')
        require(digest((root/row['eventPath']).read_bytes())==row['eventSha256'], 'native event bytes differ')
        native_events[row['eventPath']]=row
    cleanup_path=root/cleanup_alias
    cleanup_tree=ast.parse(cleanup_path.read_text(encoding='utf8'))
    candidates=[n for n in cleanup_tree.body if isinstance(n,ast.FunctionDef) and n.name=='registered_material_candidate_paths']
    require(len(candidates)==1, 'candidate validator missing or ambiguous')
    validator=candidates[0]
    validator_sha=digest(ast.dump(validator,include_attributes=False).encode())
    require(validator_sha=='75d9f19278ac4eb5080e414f372abd2048c5a18a5dde1b708c927e86f431ec25', 'unrecognized original candidate validator AST')
    constructor=None;constructor_sha=None;constructor_guard=[]
    count_guard=None;count_guard_sha=None;declared_counts=None;count_report=None
    migration_assignment=None;migration_sha=None;restored={}
    if historical:
        mains=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='main']
        require(len(mains)==1, 'historical expectation count requires the exact compiler main')
        guards=[n for n in mains[0].body if isinstance(n,ast.If) and isinstance(n.test,ast.Compare) and isinstance(n.test.left,ast.Name) and n.test.left.id=='retained_projection_counts']
        require(len(guards)==1, 'historical expectation count guard is missing or ambiguous')
        count_guard=guards[0]
        count_guard_sha=digest(ast.dump(count_guard,include_attributes=False).encode())
        require(count_guard_sha=='12661ef0d0db6e93a8152e07c8860f15fce26e94a0a6cb4f82b6c1f7419e7e65', 'unrecognized original retained-count guard AST')
        declared_counts=ast.literal_eval(count_guard.test.comparators[0])
        migrations=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='prepare_character_card_template_v003_plan']
        require(len(migrations)<=1, 'historical candidate restoration is ambiguous')
        if migrations:
            migration_sha=digest(ast.dump(migrations[0],include_attributes=False).encode())
            require(migration_sha=='3543ea98e19d9fb80c35155cec0b22798c7475f70073a667e5d9923d0fbac23c', 'unrecognized original historical candidate restoration AST')
            assignments=[n for n in migrations[0].body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='reconstructed_obsolete_expected_ids' for t in n.targets)]
            require(len(assignments)==1, 'historical candidate reconstruction assignment missing')
            migration_assignment=assignments[0]
    def reconstructed_history(model,family_id,obsolete,original):
        require(migration_assignment is not None and migration_sha is not None, 'historical restoration requires an audited source transformation')
        rows={r['expectedOutputId']:r for r in historical_rows if r['familyId']==family_id}
        require(set(original)<=set(obsolete) and set(rows)==set(obsolete) and len(obsolete)==len(rows), 'historical restoration exceeds the exact event closure')
        require(all(row.get('baseVersionHash') for row in rows.values()), 'historical restoration has no preexisting published base versions')
        require(not any(v['id'] in {r['versionId'] for r in rows.values()} for v in model.get('assetVersions',[])), 'historical base versions already reconstructed')
        for row in rows.values():
            require(row['versionId'] not in restored, 'historical base version restoration repeated')
            restored[row['versionId']]=row
        return list(obsolete)
    def verify_expected_outputs(counts,model,final=False):
        nonlocal count_report
        expected_counts={**declared_counts,'assetVersions':declared_counts['assetVersions']+(len(restored) if final else 0)}
        require(set(counts)==set(expected_counts) and all(counts[k]==v for k,v in expected_counts.items() if k!='expectedOutputs'), 'retained family/version count changed')
        rows=model.get('expectedOutputs',[])
        require(counts['expectedOutputs']==len(rows), 'reported ExpectedOutput count differs from actual rows')
        by_id={r['id']:r for r in rows}
        require(len(by_id)==len(rows), 'compiled ExpectedOutput identity is duplicated')
        remaining=[r for r in historical_rows if not final or r['versionId'] not in restored]
        historical_ids={r['expectedOutputId'] for r in remaining}
        for row in remaining:
            actual=by_id.get(row['expectedOutputId']) or {}
            changed=sorted(k for k in set(actual)|set(row['expectedOutput']) if k not in actual or k not in row['expectedOutput'] or actual[k]!=row['expectedOutput'][k])
            require(actual==row['expectedOutput'], 'historical ExpectedOutput metadata differs from its exact original event: '+','.join(changed))
        current=[{k:r.get(k) for k in ['id','familyId','targetPath','legacyVersionId']} for r in rows if r['id'] not in historical_ids]
        expected={r['id']:r for r in historical['currentOutputs']}
        require({r['id']:r for r in current}==expected, 'current ExpectedOutput identity/family/path closure changed')
        if final:
            for row in restored.values():
                versions=[v for v in model.get('assetVersions',[]) if v['id']==row['versionId']]
                require(len(versions)==1 and digest(canonical(versions[0]))==row['baseVersionHash'], 'restored historical base version differs from the exact published version')
            count_report={**count_report,'finalCounts':counts,'historicalRestorationAstSha256':migration_sha,'preexistingBaseVersionIdsRetained':sorted(restored)}
        else:
            count_report={'guardAstSha256':count_guard_sha,'declaredCounts':declared_counts,'verifiedCounts':counts,'currentExpectedOutputIds':sorted(expected),'historicalExpectedOutputIds':sorted(historical_ids),'unprovedOutputsAccepted':0}
        return True
    if eligible:
        production=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='build_production_model']
        require(len(production)==1, 'production constructor missing or ambiguous')
        constructors=[n for n in production[0].body if isinstance(n,ast.FunctionDef) and n.name=='add_family']
        require(len(constructors)==1, 'family constructor missing or ambiguous')
        constructor=constructors[0]
        constructor_sha=digest(ast.dump(constructor,include_attributes=False).encode())
        require(constructor_sha=='1eb3dfe37498e17bbbb2bdf57b3829d89aa7bec9eec25763ace5e05f797d3f88', 'unrecognized original family constructor AST')
        constructor_guard=ast.parse("""candidate = __instance_registered_candidate_outputs.get(path)
if candidate is not None:
    version_id = explicit_version_id or f"{family_id}@{version_label(path)}"
    if candidate['familyId'] != family_id or candidate['versionId'] != version_id or candidate['expectedOutputId'] != f"EXPECTED_OUTPUT:{version_id}":
        raise ValueError('REGISTERED_MATERIAL_CANDIDATE: source family/output differs')
    preserve_expected_output = True
""").body
        assignments=[i for i,n in enumerate(validator.body) if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='planned_by_family' for t in n.targets)]
        require(len(assignments)==1, 'exact validator membership assignment missing')
        validator.body[assignments[0]+1:assignments[0]+1]=ast.parse("""for requirement in material_registry.get('requirements', []):
    if isinstance(requirement, dict):
        for family_id in requirement.get('asset_family_refs', []):
            if family_id in __instance_registered_candidate_families:
                planned_by_family.setdefault(family_id, requirement)
""").body
    delegated=set()
    def delegate_native(event_path):
        relative=event_path.resolve().relative_to(root.resolve()).as_posix()
        row=native_events.get(relative)
        if row is None:
            return False
        require(digest(event_path.read_bytes())==row['eventSha256'], 'native event changed during delegation')
        delegated.add(relative)
        return True
    if native_events:
        loops=[n for n in validator.body if isinstance(n,ast.For) and isinstance(n.target,ast.Name) and n.target.id=='event_path']
        require(len(loops)==1, 'exact event reader loop missing')
        # Native plans are separately validated by the host. Keep original event
        # files untouched and leave their family/EO projection to native sources.
        loops[0].body[0:0]=ast.parse("if __instance_delegate_native_candidate(event_path):\n    continue").body
    cleanup=importlib.import_module('asset_cleanup_contract')
    require(Path(cleanup.__file__).resolve()==cleanup_path.resolve(), 'unexpected candidate validator module')
    namespace=cleanup.__dict__
    namespace['__instance_registered_candidate_families']={r['familyId'] for r in eligible.values()}
    namespace['__instance_delegate_native_candidate']=delegate_native
    executable=ast.Module(body=[ast.ImportFrom(module='__future__',names=[ast.alias(name='annotations')],level=0),validator],type_ignores=[])
    exec(compile(ast.fix_missing_locations(executable),str(cleanup_path),'exec'),namespace)
    original=namespace['registered_material_candidate_paths'];observed=set()
    def verified_candidates(*args,**kwargs):
        result=original(*args,**kwargs)
        for row in list(eligible.values())+historical_rows:
            output=row['path']
            value=result.get(output)
            require(value and all(value.get(k)==row[k] for k in ['familyId','versionId','expectedOutputId','sha256','byteSize','eventId']), 'candidate validator result differs')
            observed.add(output)
        return result
    namespace['registered_material_candidate_paths']=verified_candidates
    def transform(value):
        if constructor is not None:
            # Other adapters first validate the unmodified full production AST.
            constructor.body[0:0]=copy.deepcopy(constructor_guard)
        if count_guard is not None:
            count_guard.test=ast.parse('not __instance_verify_retained_expectations(retained_projection_counts, production_model)',mode='eval').body
        if migration_assignment is not None:
            migration_assignment.value=ast.Call(func=ast.Name(id='__instance_reconstructed_history',ctx=ast.Load()),args=[ast.Name(id=name,ctx=ast.Load()) for name in ['production_model','family_id','obsolete_expected_ids']]+[migration_assignment.value],keywords=[])
        return ast.fix_missing_locations(value)
    def install(module):
        module.__instance_registered_candidate_outputs=eligible
        module.__instance_verify_retained_expectations=verify_expected_outputs
        module.__instance_reconstructed_history=reconstructed_history
    def finish():
        require(observed==set(eligible)|{r['path'] for r in historical_rows}, 'legacy candidate closure was not consumed')
        require(not historical or count_report is not None, 'historical expectation closure was not checked')
        require(delegated==set(native_events), 'native candidate closure was not delegated')
        for item in source_rows:
            require(digest((root/item['path']).read_bytes())==item['sha256'], 'compiler rewrote pinned source bytes')
        model=json.loads((root/paths['snapshot']).read_text(encoding='utf8'))['productionModel']
        for row in eligible.values():
            require(not any(v['id']==row['versionId'] for v in model['assetVersions']), 'event candidate leaked into immutable base versions')
        for row in native_events.values():
            versions=[v for v in model['assetVersions'] if v['id']==row['versionId']]
            require(not versions or len(versions)==1 and row.get('baseVersionHash') and digest(canonical(versions[0]))==row['baseVersionHash'], 'native event candidate leaked into or changed immutable base versions')
        if historical:
            verify_expected_outputs({k:len(model.get(k,[])) for k in declared_counts},model,final=True)
        for row in eligible.values():
            families=[f for f in model['assetFamilies'] if f['id']==row['familyId']]
            outputs=[o for o in model['expectedOutputs'] if o['id']==row['expectedOutputId']]
            require(len(families)==1 and families[0].get('currentVersionId')!=row['versionId'], 'candidate became current without event projection')
            require(len(outputs)==1 and outputs[0]['familyId']==row['familyId'] and outputs[0]['targetPath']==row['path'], 'ExpectedOutput identity was lost')
        report={}
        if proof:
            report={'schemaVersion':proof['schemaVersion'],'proofSha256':proof['proofSha256'],'releaseId':proof['releaseId'],'candidateValidatorAstSha256':validator_sha,'familyConstructorAstSha256':constructor_sha,'candidateVersionIds':sorted(r['versionId'] for r in eligible.values()),'sourceBytesPreserved':True,'baseCandidateVersionsCreated':0}
            if count_report:
                report['historicalExpectations']=count_report
        if native_proof:
            report['nativeCandidateDelegation']={'schemaVersion':native_proof['schemaVersion'],'proofSha256':native_proof['proofSha256'],'releaseId':native_proof['releaseId'],'candidateValidatorAstSha256':validator_sha,'eventIds':sorted(r['eventId'] for r in native_events.values()),'originalEventFilesPreserved':True,'baseCandidateVersionsCreated':0}
        return report
    return transform,install,finish
`;
