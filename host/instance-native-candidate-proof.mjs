import {resolveImageTechnicalSpec} from './instance-runtime/image-technical-spec.mjs';
import path from 'node:path';
import {canonicalJson,sha256} from './instance-runtime/bytes.mjs';
import {inspectExecutionDefinitionHash} from './instance-runtime/execution-definition-hash.mjs';
import {preserveMaterialProductionProjection} from './instance-runtime/material-production-preservation.mjs';
import {preserveShotProductionProjection,preserveShotRecipeProjection} from './instance-runtime/shot-production-preservation.mjs';
import {shotProductionInputConsumptionReasons} from './instance-runtime/shot-production-stage-policy.mjs';

const hash=value=>sha256(canonicalJson(value));
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const check=(value,message)=>{if(!value)throw Object.assign(new Error(message),{code:'SOURCE_NATIVE_CANDIDATE_BINDING'});};
const one=(rows,predicate,label)=>{const selected=(rows||[]).filter(predicate);check(selected.length===1,label+' must be exact and unique');return selected[0];};
const safe=value=>typeof value==='string'&&value&&!path.posix.isAbsolute(value)&&!/[\\\u0000-\u001f%?#]/.test(value)&&path.posix.normalize(value)===value&&!value.split('/').some(p=>!p||p==='.'||p==='..');
const json=bytes=>JSON.parse(Buffer.from(bytes).toString('utf8'));
const nativeMarker=e=>/^media\/_review_pending\/(material-production|shot-production)\//.test(e.path||'')||/^(MP|SP)-(AF|EO|CALL)-/.test(e.familyId||'')||/^(MP|SP)-(EO|CALL)-/.test(e.expectedOutputId||'')||/^(MP|SP)-CALL-/.test(e.executionDefinitionId||'');
const formal=m=>m&&m.availability==='PRESENT'&&['FORMAL','IMPORTED_EVIDENCE'].includes(m.metadata?.authorityDomain)&&[undefined,'PUBLIC'].includes(m.metadata?.visibility)&&m.metadata?.private!==true&&m.metadata?.sourceRole!=='ORIGINAL_SOURCE';

function sources(rows,documents){return rows.map(row=>{const doc=one(documents,d=>d.revisionId===row.sourceRevisionId,'Native immutable source');check(!doc.deleted&&safe(row.sourcePath)&&doc.aliases?.includes(row.sourcePath)&&hex(doc.sha256)&&doc.sha256===row.sourceSha256&&sha256(doc.bytes)===doc.sha256,'Native source revision/path/bytes differ');return{path:row.sourcePath,revisionId:doc.revisionId,sha256:doc.sha256};});}
function eventPin(event,compiler){check(event.eventId&&hex(event.idempotencyKeyHash)&&safe(compiler.eventDirectory),'Event filename identity is invalid');return{eventId:event.eventId,path:compiler.eventDirectory+'/'+event.eventKind+'-'+event.idempotencyKeyHash+'.json',sha256:hash(event)};}
// A published adopted row and its original candidate event are two immutable
// witnesses of one version. Duplicates within either authority remain invalid.
function versionEvidence(model,events,versionId,label){
 const base=(model.assetVersions||[]).filter(v=>v.id===versionId),candidates=events.filter(e=>e.eventKind==='asset-version'&&e.versionId===versionId);
 check(base.length<=1&&candidates.length<=1&&base.length+candidates.length>0,label+' must have one version identity');
 const v=candidates[0]||base[0];
 if(base[0]&&candidates[0])check(['familyId','path','sha256'].every(k=>base[0][k]===v[k]),label+' base and candidate identity/path/SHA differ');
 return {...v,versionId};
}
function inputProof(input,definition,{events,model,activeMedia,pinnedMediaHashes}){
 const expected=(definition.upload?.items||[]).map((b,i)=>({order:b.order??i+1,path:b.path,assetFamilyRef:b.assetFamilyRef,assetVersionRef:b.assetVersionRef,sha256:b.sha256}));
 check(Array.isArray(input)&&same(input,expected),'Candidate inputs differ from the frozen ordered upload list');
 for(const b of input){
  const consumerWork=[...(model.workItems||[]),...(model.materialWorkItems||[])].find(w=>w.id===definition.workItemRef);
  check(!shotProductionInputConsumptionReasons(model,consumerWork,b).length,'Native input is not approved for this production use');
  check(Number.isSafeInteger(b.order)&&b.order>0&&safe(b.path)&&b.assetFamilyRef&&b.assetVersionRef&&hex(b.sha256),'Native input binding is incomplete');
  const v=versionEvidence(model,events,b.assetVersionRef,'Native input version');check(v.familyId===b.assetFamilyRef&&v.path===b.path&&v.sha256===b.sha256,'Native input identity/path/SHA differs');
  const media=one(activeMedia,m=>m.mediaId===b.assetFamilyRef&&m.versionId===b.assetVersionRef,'Native input media');check(formal(media)&&media.sha256===b.sha256&&pinnedMediaHashes[b.path]===b.sha256,'Native input has no exact active formal byte pin');
 }
}
function executionProof(event,definition,work,{events,compiler}){
 const ordered=rows=>rows.sort((a,b)=>a.eventSequence-b.eventSequence);
 const requests=ordered(events.filter(e=>e.eventKind==='execution-request'&&e.executionRequestId===event.executionRequestId));
 check(requests.length===2&&requests[0].action==='AUTHORIZE'&&requests[1].action==='CLAIM'&&requests.every(r=>r.authorized===true&&r.maxOutputs===1&&r.familyId===event.familyId&&r.workItemId===work.id&&same(r.inputBindings,event.inputBindings)),'Native request lacks exact authorization and claim');
 const runs=ordered(events.filter(e=>e.eventKind==='run'&&e.runId===event.runId));
 check(runs.length>=2&&runs.at(-1).state==='SUCCEEDED'&&runs.filter(r=>r.state==='SUBMITTED').length===1&&runs.every(r=>['PLANNED','SUBMITTED','RUNNING','RESULT_UNKNOWN','SUCCEEDED'].includes(r.state)),'Native Run is unresolved or not successful');
 const states=runs.map(r=>r.state),submitted=states.indexOf('SUBMITTED');
 check(submitted<=1&&(submitted===0||states[0]==='PLANNED')&&states.filter(s=>s==='SUCCEEDED').length===1&&states.slice(submitted+1,-1).every(s=>['RUNNING','RESULT_UNKNOWN'].includes(s)),'Native Run transition order differs');
 if(states.includes('RESULT_UNKNOWN')){const r=runs.at(-1),p=r.reconciliationEvidence;check(p?.requestId===event.executionRequestId&&p.providerConclusion==='SUCCEEDED'&&typeof p.logId==='string'&&p.logId&&Number.isFinite(Date.parse(p.providerStatusCheckedAt)),'Unknown native result lacks explicit successful reconciliation');}
 const chain=ordered([...requests,...runs,event]);
 check(new Set(chain.map(e=>e.eventId)).size===chain.length&&new Set(chain.map(e=>e.eventKind+'-'+e.idempotencyKeyHash)).size===chain.length,'Native chain contains duplicate event identities');
 // An unrelated publication may occur while the same frozen call is running.
 // Each event retains its own snapshot; the immutable call and inputs must agree.
 const fields=['executionRequestId','executionDefinitionId','executionDefinitionHash','promptRevisionId','callPackageHash','inputBindingsHash'];
 check(chain.at(-1)===event&&requests[1].eventSequence<runs[submitted].eventSequence&&chain.every((r,i)=>typeof r.snapshotId==='string'&&r.snapshotId&&Number.isSafeInteger(r.eventSequence)&&r.eventSequence>0&&(!i||r.eventSequence>chain[i-1].eventSequence)&&fields.every(k=>r[k]===event[k])),'Native request/Run/candidate event closure differs');
 check(event.executionDefinitionHash===definition.definitionHash&&event.callPackageHash===definition.definitionHash&&event.promptRevisionId===definition.currentRevisionId,'Native event does not bind the frozen definition');
 return chain.map(e=>eventPin(e,compiler));
}

/** Pure, read-only bridge. The caller supplies same-capture pinned file SHAs;
 * this proof never adopts media, rewrites events or invents legacy identities. */
export function nativeMaterialCandidateProof({documents,events,activeMedia,pinnedMediaHashes,baseRelease,compiler}){
 const candidates=events.filter(e=>e.eventKind==='asset-version');if(!candidates.length)return null;
 let snapshot,recipes;try{snapshot=json(baseRelease?.snapshotBytes);recipes=json(baseRelease?.recipesBytes);}catch{check(!candidates.some(nativeMarker),'Native proof requires a readable published snapshot/recipe pair');return null;}
 const model=snapshot.productionModel||{};
 const mpPlans=model.materialProductionPlans||[],spPlans=model.shotProductionPlans||[];
 const nativeFamilies=new Set([...mpPlans.map(p=>p.familyId),...(model.workItems||[]).filter(w=>spPlans.some(p=>p.workItemIds?.includes(w.id))).map(w=>w.outputAssetRef)]);
 const selected=candidates.filter(e=>nativeFamilies.has(e.familyId)||nativeMarker(e));
 if(!selected.length)return null;
 check(snapshot.productionModel&&snapshot.snapshotId===recipes.snapshotId&&baseRelease.releaseId,'Native proof requires one published snapshot/recipe pair');
 try{
  if(selected.some(e=>mpPlans.some(p=>p.familyId===e.familyId)))preserveMaterialProductionProjection({snapshot,recipes,baseSnapshot:snapshot,baseRecipes:recipes,documents});
  if(selected.some(e=>!mpPlans.some(p=>p.familyId===e.familyId))){preserveShotProductionProjection({snapshot,baseSnapshot:snapshot,documents});preserveShotRecipeProjection({snapshot,recipes,baseSnapshot:snapshot,baseRecipes:recipes,documents});}
 }catch(error){check(false,'Native immutable source closure failed: '+error.message);}
 const seen=new Set(),paths=new Set(),records=[];
 for(const event of selected){
  check(!seen.has(event.versionId)&&!paths.has(event.path),'Native candidate version/path is duplicated');seen.add(event.versionId);paths.add(event.path);
  const family=one(model.assetFamilies,f=>f.id===event.familyId,'Native family'),output=one(model.expectedOutputs,o=>o.id===event.expectedOutputId,'Native ExpectedOutput'),definition=one(recipes.executionDefinitions,d=>d.id===event.executionDefinitionId,'Native definition');
  check(inspectExecutionDefinitionHash(definition).valid&&definition.executorKind==='MODEL_CALL','Unknown native executor/definition hash');
  const technical=resolveImageTechnicalSpec(model,{familyId:family.id,expectedOutputId:output.id,definition});
  if(technical)check(event.imageTechnicalSpecHash===technical.technicalSpecHash&&event.imageTechnicalFacts?.schemaVersion==='IMAGE_TECHNICAL_FACTS_V1'&&event.imageTechnicalFacts.sha256===event.sha256&&event.imageTechnicalFacts.byteSize===event.byteSize,'Typed native image lacks exact server technical facts');
  const mp=mpPlans.filter(p=>p.familyId===family.id);check(mp.length<=1,'Native material family has ambiguous plans');
  let work,sourceRows,productionKind;
  if(mp.length){
   const plan=mp[0];productionKind='MP';work=one(model.materialWorkItems,w=>w.id===plan.workItemId,'Native material work');
   const successors=(model.materialProductionRecipeRevisions||[]).filter(r=>r.materialProductionPlanId===plan.id);
   check(definition.materialProductionPlanId===plan.id&&(plan.definitionId===definition.id||successors.some(r=>r.definitionId===definition.id)),'Unknown native material definition');sourceRows=[plan,...successors,...successors.flatMap(row=>Object.values(row.domainSources||{}).map(ref=>({sourcePath:ref.path,sourceRevisionId:ref.revisionId,sourceSha256:ref.sha256})))];sourceRows=[...new Map(sourceRows.map(row=>[row.sourceRevisionId,row])).values()];
  }else{
   productionKind='SP';work=one(model.workItems,w=>w.outputAssetRef===family.id,'Native shot work');
   const plan=one(spPlans,p=>p.id===work.shotProductionPlanId&&p.workItemIds.includes(work.id),'Native shot owner plan');
   const revision=one(model.shotProductionRecipeRevisions,r=>r.id===definition.id&&r.workItemId===work.id,'Native shot definition source');sourceRows=[plan,revision];
  }
  check(work.outputAssetRef===family.id&&definition.workItemRef===work.id&&family.expectedOutputRefs?.includes(output.id)&&output.familyId===family.id&&definition.output?.assetFamilyRef===family.id&&definition.output?.expectedOutputRef===output.id&&definition.output?.path===output.targetPath&&output.targetPath===event.path,'Native family/work/ExpectedOutput/definition differ');
  const prefix='media/_review_pending/'+(productionKind==='MP'?'material-production':'shot-production')+'/'+family.id+'/';
  check(safe(event.path)&&event.path.startsWith(prefix)&&event.path===prefix+output.plannedVersionLabel+({IMAGE:'.png',AUDIO:'.wav',VIDEO:'.mp4'}[family.kind]||'')&&/^V\d{3,}$/.test(output.plannedVersionLabel||'')&&event.versionId===family.id+'@'+output.plannedVersionLabel,'Native output version/path is not its exact published slot');
  check(event.schemaVersion==='1.1'&&event.realizationRelation==='REALIZES'&&same(event.realizes,{relationType:'REALIZES',expectedOutputId:output.id,assetVersionId:event.versionId})&&event.plannedVersionId===(output.legacyVersionId||output.id),'Native realization relation differs');
  check(event.outputState==='PRESENT'&&event.historyRole==='CANDIDATE'&&event.lifecycleState==='REVIEW_PENDING'&&event.reviewDecision==='PENDING'&&event.registrationState==='CANDIDATE_REGISTERED_EXPECTED_OUTPUT_REALIZED'&&event.adoptionPerformed===false,'Native event cannot fabricate adoption');
  const baseVersions=(model.assetVersions||[]).filter(v=>v.id===event.versionId);check(baseVersions.length<=1,'Native base version is duplicated');const baseVersion=baseVersions[0]||null;
  if(baseVersion)check(['familyId','path','sha256'].every(k=>baseVersion[k]===event[k]),'Native base version differs from its original candidate');
  check(hex(event.sha256)&&Number.isSafeInteger(event.byteSize)&&event.byteSize>0&&Array.isArray(event.inputBindings)&&hash(event.inputBindings)===event.inputBindingsHash,'Native candidate byte/input hash is invalid');
  check(event.actualPrompt&&hash(event.actualPrompt)===event.actualPromptHash&&hash(definition.prompt)===event.recipePromptHash&&event.promptChangedFromCallPackage===(event.actualPromptHash!==event.recipePromptHash)&&event.promptSyncRequired===event.promptChangedFromCallPackage,'Native actual/frozen prompt audit hashes differ');
  inputProof(event.inputBindings,definition,{events,model,activeMedia,pinnedMediaHashes});
  const parentId=definition.parentVersionId||null;check((event.parentVersionId||null)===parentId,'Native candidate parent differs from definition');
  if(parentId){const parent=versionEvidence(model,events,parentId,'Native parent version');check(parent.familyId===family.id&&hex(parent.sha256)&&event.parentVersionSha256===parent.sha256&&(!definition.parentVersionSha256||definition.parentVersionSha256===parent.sha256),'Native parent family/SHA differs');}
  else check(event.parentVersionSha256==null&&event.parentBindingState==='EXPLICIT_ROOT','Native root parent binding differs');
  const eventProof=executionProof(event,definition,work,{events,compiler}),media=one(activeMedia,m=>m.mediaId===family.id&&m.versionId===event.versionId,'Native output media');
  check(formal(media)&&media.metadata.authorityDomain==='FORMAL'&&media.metadata.registrationEventId===event.eventId&&media.sha256===event.sha256&&media.byteSize===event.byteSize&&pinnedMediaHashes[event.path]===event.sha256,'Native candidate lacks exact active FORMAL byte/registration proof');
  const pin=eventPin(event,compiler);
  records.push({baseVersionHash:baseVersion?hash(baseVersion):null,productionKind,familyId:family.id,versionId:event.versionId,workItemId:work.id,expectedOutputId:output.id,path:event.path,sha256:event.sha256,byteSize:event.byteSize,eventId:event.eventId,eventPath:pin.path,eventSha256:pin.sha256,eventProof,sourceProof:sources(sourceRows,documents),definitionId:definition.id,definitionHash:definition.definitionHash,definitionContentHash:hash(definition),familyHash:hash(family),workItemHash:hash(work),expectedOutputHash:hash(output)});
 }
 records.sort((a,b)=>a.versionId.localeCompare(b.versionId));
 const proof={schemaVersion:'NATIVE_MATERIAL_CANDIDATE_PROOF_V1',releaseId:baseRelease.releaseId,snapshotSha256:sha256(baseRelease.snapshotBytes),recipesSha256:sha256(baseRelease.recipesBytes),records};return{...proof,proofSha256:hash(proof)};
}

export function assertNativeCandidatePreservation({proof,snapshot,recipes,events}){
 if(!proof)return null;const {proofSha256,...body}=proof;check(proof.schemaVersion==='NATIVE_MATERIAL_CANDIDATE_PROOF_V1'&&hash(body)===proofSha256,'Native proof digest differs');
 const model=snapshot.productionModel;
 for(const row of proof.records){
  const family=one(model.assetFamilies,f=>f.id===row.familyId,'Preserved native family'),work=one(row.productionKind==='MP'?model.materialWorkItems:model.workItems,w=>w.id===row.workItemId,'Preserved native work'),output=one(model.expectedOutputs,o=>o.id===row.expectedOutputId,'Preserved native output'),definition=one(recipes.executionDefinitions,d=>d.id===row.definitionId,'Preserved native definition');
  const versions=(model.assetVersions||[]).filter(v=>v.id===row.versionId);
  check(hash(family)===row.familyHash&&hash(work)===row.workItemHash&&hash(output)===row.expectedOutputHash&&hash(definition)===row.definitionContentHash&&(row.baseVersionHash?versions.length===1&&hash(versions[0])===row.baseVersionHash:versions.length===0),'Compiler changed native closure or a preexisting base version, or inserted an event-only version');
  for(const pin of row.eventProof)check(hash(one(events,e=>e.eventId===pin.eventId,'Preserved native event'))===pin.sha256,'Compiler changed or dropped a native event');
 }
 return{schemaVersion:proof.schemaVersion,proofSha256,versionIds:proof.records.map(r=>r.versionId),eventsPreserved:true,baseCandidateVersionsCreated:0};
}
