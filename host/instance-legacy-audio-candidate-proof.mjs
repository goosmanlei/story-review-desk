import path from 'node:path';
import {canonicalJson,sha256} from './instance-runtime/bytes.mjs';
import {inspectExecutionDefinitionHash} from './instance-runtime/execution-definition-hash.mjs';
import {preserveLegacyAudioProjection} from './instance-runtime/material-legacy-audio-preservation.mjs';
import {LEGACY_AUDIO_SCHEMA,LEGACY_AUDIO_SOURCE,legacyAudioTarget} from './instance-runtime/material-legacy-audio.mjs';

const hash=v=>sha256(canonicalJson(v)),same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const check=(v,message)=>{if(!v)throw Object.assign(new Error(message),{code:'SOURCE_LEGACY_AUDIO_CANDIDATE_BINDING'});};
const one=(rows,predicate,label)=>{const found=(rows||[]).filter(predicate);check(found.length===1,label+' must be exact and unique');return found[0];};
const safe=v=>typeof v==='string'&&v&&!path.posix.isAbsolute(v)&&!/[\\\u0000-\u001f%?#]/.test(v)&&path.posix.normalize(v)===v&&!v.split('/').some(p=>!p||p==='.'||p==='..');
const marker=e=>/^LA-(EO|CALL|RECIPE)-/.test(e.expectedOutputId||'')||/^LA-(EO|CALL|RECIPE)-/.test(e.executionDefinitionId||'');
const json=bytes=>JSON.parse(Buffer.from(bytes).toString('utf8'));
const formal=m=>m&&m.availability==='PRESENT'&&['FORMAL','IMPORTED_EVIDENCE'].includes(m.metadata?.authorityDomain)&&[undefined,'PUBLIC'].includes(m.metadata?.visibility)&&m.metadata?.private!==true&&m.metadata?.sourceRole!=='ORIGINAL_SOURCE';
const aliases=m=>[m.relativePath,m.metadata?.sourcePath,m.metadata?.legacyVersion?.path,...(m.aliases||[])];
function eventPin(e,compiler){check(e.eventId&&hex(e.idempotencyKeyHash)&&safe(compiler.eventDirectory),'Unsafe immutable event path');return{eventId:e.eventId,path:compiler.eventDirectory+'/'+e.eventKind+'-'+e.idempotencyKeyHash+'.json',sha256:hash(e)};}
function documentPin(doc,alias){check(doc&&!doc.deleted&&doc.revisionId&&safe(alias)&&doc.aliases?.includes(alias)&&hex(doc.sha256)&&sha256(doc.bytes)===doc.sha256,'Immutable source path/revision/bytes differ');return{path:alias,revisionId:doc.revisionId,sha256:doc.sha256};}
function versionWitness(model,events,id){const base=(model.assetVersions||[]).filter(v=>v.id===id),event=events.filter(e=>e.eventKind==='asset-version'&&e.versionId===id);check(base.length<=1&&event.length===1,'Candidate version requires one original event and at most one published version');if(base[0])check(['familyId','path','sha256'].every(k=>base[0][k]===event[0][k]),'Published version differs from original candidate');return{event:event[0],base:base[0]||null};}
function candidateProof(event,definition,work,output,input){
 const {events,activeMedia,pinnedMediaHashes,compiler,model}=input;
 check(inspectExecutionDefinitionHash(definition).valid&&definition.executorKind==='AUDIO_MODEL'&&definition.model?.branch==='seed-audio-1.0'&&definition.workItemRef===work.id,'Legacy audio executor/definition hash differs');
 const target=legacyAudioTarget(output,event.familyId);
 check(event.schemaVersion==='1.1'&&safe(event.path)&&event.path===target.logical&&output.familyId===event.familyId&&event.versionId===event.familyId+'@'+output.plannedVersionLabel&&event.expectedOutputId===output.id&&event.plannedVersionId===(output.legacyVersionId||output.id)&&definition.output?.path===event.path&&definition.output?.expectedOutputRef===output.id&&definition.output?.assetFamilyRef===event.familyId&&definition.output?.mediaType==='AUDIO','Legacy audio candidate output identity differs');
 check(event.realizationRelation==='REALIZES'&&same(event.realizes,{relationType:'REALIZES',expectedOutputId:output.id,assetVersionId:event.versionId})&&event.outputState==='PRESENT'&&event.historyRole==='CANDIDATE'&&event.lifecycleState==='REVIEW_PENDING'&&event.reviewDecision==='PENDING'&&event.registrationState==='CANDIDATE_REGISTERED_EXPECTED_OUTPUT_REALIZED'&&event.adoptionPerformed===false,'Legacy audio event is not an immutable candidate registration');
 check(hex(event.sha256)&&Number.isSafeInteger(event.byteSize)&&event.byteSize>0&&same(definition.upload?.items,[])&&same(event.inputBindings,[])&&event.inputBindingsHash===hash([]),'Legacy audio revision currently requires exact zero-reference inputs');
 check(event.actualPrompt&&hash(event.actualPrompt)===event.actualPromptHash&&hash(definition.prompt)===event.recipePromptHash&&event.promptChangedFromCallPackage===(event.actualPromptHash!==event.recipePromptHash)&&event.promptSyncRequired===event.promptChangedFromCallPackage,'Legacy audio actual/frozen prompt evidence differs');
 check(event.executionDefinitionId===definition.id&&event.executionDefinitionHash===definition.definitionHash&&event.callPackageHash===definition.definitionHash&&event.promptRevisionId===definition.currentRevisionId,'Legacy audio candidate does not bind the frozen call');
 const requests=events.filter(e=>e.eventKind==='execution-request'&&e.executionRequestId===event.executionRequestId).sort((a,b)=>a.eventSequence-b.eventSequence);
 check(requests.length===2&&requests[0].action==='AUTHORIZE'&&requests[1].action==='CLAIM'&&requests.every(e=>e.authorized===true&&e.maxOutputs===1&&e.familyId===event.familyId&&e.workItemId===work.id&&same(e.inputBindings,[])),'Legacy audio authorization/claim is incomplete');
 const runs=events.filter(e=>e.eventKind==='run'&&e.runId===event.runId).sort((a,b)=>a.eventSequence-b.eventSequence),states=runs.map(e=>e.state),submitted=states.indexOf('SUBMITTED');
 check(runs.length>=2&&runs.at(-1).state==='SUCCEEDED'&&states.filter(s=>s==='SUBMITTED').length===1&&states.filter(s=>s==='SUCCEEDED').length===1&&submitted>=0&&submitted<=1&&(submitted===0||states[0]==='PLANNED')&&states.slice(submitted+1,-1).every(s=>['RUNNING','RESULT_UNKNOWN'].includes(s)),'Legacy audio Run is not a resolved successful sequence');
 if(states.includes('RESULT_UNKNOWN')){const p=runs.at(-1).reconciliationEvidence;check(p?.requestId===event.executionRequestId&&p.providerConclusion==='SUCCEEDED'&&typeof p.logId==='string'&&p.logId&&Number.isFinite(Date.parse(p.providerStatusCheckedAt)),'Unknown audio result lacks exact successful reconciliation');}
 const fields=['executionRequestId','executionDefinitionId','executionDefinitionHash','promptRevisionId','callPackageHash','inputBindingsHash'],chain=[...requests,...runs,event].sort((a,b)=>a.eventSequence-b.eventSequence);
 check(chain.at(-1)===event&&requests[1].eventSequence<runs[submitted].eventSequence&&chain.every((e,i)=>typeof e.snapshotId==='string'&&e.snapshotId&&Number.isSafeInteger(e.eventSequence)&&e.eventSequence>0&&(!i||e.eventSequence>chain[i-1].eventSequence)&&fields.every(k=>e[k]===event[k])),'Legacy audio request/Run/candidate closure differs');
 const media=one(activeMedia,m=>m.mediaId===event.familyId&&m.versionId===event.versionId,'Legacy audio registered media');
 const imported=media.metadata?.legacyVersion,registrationBound=media.metadata?.registrationEventId===event.eventId||!media.metadata?.registrationEventId&&imported&&Object.entries(event).every(([k,v])=>same(imported[k],v));
 check(formal(media)&&registrationBound&&media.sha256===event.sha256&&media.byteSize===event.byteSize&&aliases(media).includes(event.path)&&pinnedMediaHashes[event.path]===event.sha256,'Legacy audio candidate lacks exact active registered bytes/alias');
 const {base}=versionWitness(model,events,event.versionId);
 return{eventProof:chain.map(e=>eventPin(e,compiler)),baseVersionHash:base?hash(base):null,mediaProof:{mediaId:media.mediaId,versionId:media.versionId,path:event.path,relativePath:media.relativePath,sha256:media.sha256,byteSize:media.byteSize}};
}

/** Separate legacy AUDIO revision authority. No native plan or fabricated Run. */
export function legacyAudioCandidateProof({documents,events,activeMedia,pinnedMediaHashes,baseRelease,compiler}){
 const candidates=events.filter(e=>e.eventKind==='asset-version');if(!candidates.length)return null;
 let snapshot,recipes;try{snapshot=json(baseRelease?.snapshotBytes);recipes=json(baseRelease?.recipesBytes);}catch{check(!candidates.some(marker),'Legacy audio proof requires a readable published release');return null;}
 const model=snapshot.productionModel||{},rows=model.legacyMaterialRecipeRevisions||[];
 const selected=candidates.filter(e=>marker(e)||rows.some(r=>r.definitionId===e.executionDefinitionId||r.expectedOutputId===e.expectedOutputId||(model.expectedOutputs||[]).some(o=>o.id===r.expectedOutputId&&e.versionId===r.familyId+'@'+o.plannedVersionLabel)));
 if(!selected.length)return null;
 check(baseRelease.releaseId&&snapshot.productionModel&&snapshot.snapshotId===recipes.snapshotId,'Legacy audio snapshot/recipes differ');
 try{preserveLegacyAudioProjection({snapshot,recipes,baseSnapshot:snapshot,baseRecipes:recipes,documents});}catch(e){check(false,'Legacy audio immutable source closure failed: '+e.message);}
 const records=[];
 for(const event of selected){
  const row=one(rows,r=>r.definitionId===event.executionDefinitionId&&r.expectedOutputId===event.expectedOutputId&&r.familyId===event.familyId,'Legacy audio revision owner');
  const family=one(model.assetFamilies,f=>f.id===row.familyId,'Legacy audio family'),work=one(model.materialWorkItems,w=>w.id===row.workItemId,'Legacy audio work'),output=one(model.expectedOutputs,o=>o.id===row.expectedOutputId,'Legacy audio output'),definition=one(recipes.executionDefinitions,d=>d.id===row.definitionId,'Legacy audio definition');
  const requirement=one(model.materialRequirements,r=>r.id===row.requirementId,'Legacy audio requirement');
  check(family.kind==='AUDIO'&&family.ownerRef===work.id&&work.outputAssetRef===family.id&&work.requirementRef===requirement.id&&work.requirementHash===row.requirementHash&&requirement.requirementHash===row.requirementHash&&same(requirement.assetFamilyRefs,[family.id])&&family.expectedOutputRefs?.includes(output.id),'Legacy audio family/work/requirement ownership differs');
  const doc=one(documents,d=>d.revisionId===row.sourceRevisionId,'Legacy audio immutable source'),body=json(doc.bytes);
  check(doc.metadata?.sourceRole===LEGACY_AUDIO_SOURCE&&body.schemaVersion===LEGACY_AUDIO_SCHEMA&&body.basis?.revision?.mode==='LEGACY_AUDIO_REVISION','Unknown legacy audio source authority');
  const proofInput={model,events,activeMedia,pinnedMediaHashes,compiler},proof=candidateProof(event,definition,work,output,proofInput);
  check((event.parentVersionId||null)===row.parentVersionId&&event.parentVersionSha256===row.parentVersionSha256&&definition.parentVersionId===row.parentVersionId&&definition.parentVersionSha256===row.parentVersionSha256,'Legacy audio actual parent differs from frozen revision');
  const parent=versionWitness(model,events,row.parentVersionId).event;
  check(same(parent,body.parentCandidate)&&parent.familyId===family.id&&parent.sha256===row.parentVersionSha256,'Legacy audio frozen parent event differs');
  const parentDef=one(recipes.executionDefinitions,d=>d.id===row.previousDefinitionId,'Legacy audio parent definition'),parentOutput=one(model.expectedOutputs,o=>o.id===row.previousExpectedOutputId,'Legacy audio parent output'),parentProof=candidateProof(parent,parentDef,work,parentOutput,proofInput);
  const reviewBinding=body.basis.revision.parentReview,review=one(events,e=>e.eventKind==='review'&&e.eventId===reviewBinding.eventId,'Legacy audio frozen revision review');
  check(hash(review)===reviewBinding.sha256&&review.eventSequence===reviewBinding.eventSequence&&review.eventSequence>parent.eventSequence&&review.eventSequence<event.eventSequence&&review.subjectType==='ASSET'&&(review.familyId||review.subjectId)===family.id&&review.versionId===parent.versionId&&review.versionSha256===parent.sha256&&review.action==='REQUEST_REVISION'&&review.applicationStatus==='APPLIED'&&review.effect==='APPLIED','Legacy audio parent lacks the exact formal REQUEST_REVISION');
  const basisEvents=[];
  for(const[key,kind]of[['requestHeads','execution-request'],['runHeads','run']]){
   check(Array.isArray(body.basis.revision[key])&&body.basis.revision[key].length,'Legacy audio frozen execution basis is missing');
   for(const binding of body.basis.revision[key]){const actual=one(events,e=>e.eventId===binding.eventId&&e.eventKind===kind,'Legacy audio frozen execution head');check(actual.eventSequence===binding.eventSequence&&hash(actual)===binding.sha256&&actual.eventSequence<event.eventSequence,'Legacy audio frozen execution head differs');basisEvents.push(eventPin(actual,compiler));}
  }
  const sourceProof=new Map();for(const member of rows.filter(r=>r.familyId===family.id)){const source=one(documents,d=>d.revisionId===member.sourceRevisionId,'Legacy audio family source'),frozen=json(source.bytes);const add=(d,alias)=>{const pin=documentPin(d,alias),prior=sourceProof.get(alias);check(!prior||same(prior,pin),'Conflicting legacy audio source alias');sourceProof.set(alias,pin);};add(source,member.sourcePath);for(const binding of frozen.sourceBindings||[])add(one(documents,d=>d.revisionId===binding.revisionId,'Legacy audio origin source'),binding.path);}
  const eventProof=[...proof.eventProof,...parentProof.eventProof,...basisEvents,eventPin(review,compiler)],unique=new Map();for(const pin of eventProof){const prior=unique.get(pin.eventId);check(!prior||same(prior,pin),'Conflicting legacy audio event evidence');unique.set(pin.eventId,pin);}
  const pin=eventPin(event,compiler);
  records.push({productionKind:'LEGACY_AUDIO',familyId:family.id,versionId:event.versionId,workItemId:work.id,expectedOutputId:output.id,definitionId:definition.id,definitionHash:definition.definitionHash,definitionContentHash:hash(definition),familyHash:hash(family),workItemHash:hash(work),expectedOutputHash:hash(output),revisionId:row.id,revisionHash:hash(row),requirementId:requirement.id,requirementHash:hash(requirement),parentVersionId:parent.versionId,parentVersionSha256:parent.sha256,parentDefinitionId:parentDef.id,parentDefinitionContentHash:hash(parentDef),parentExpectedOutputId:parentOutput.id,parentExpectedOutputHash:hash(parentOutput),parentBaseVersionHash:parentProof.baseVersionHash,baseVersionHash:proof.baseVersionHash,path:event.path,sha256:event.sha256,byteSize:event.byteSize,eventId:event.eventId,eventPath:pin.path,eventSha256:pin.sha256,eventProof:[...unique.values()],sourceProof:[...sourceProof.values()],mediaProof:[proof.mediaProof,parentProof.mediaProof]});
 }
 check(new Set(records.map(r=>r.versionId)).size===records.length&&new Set(records.map(r=>r.path)).size===records.length,'Duplicate legacy audio candidate identity/path');
 const proof={schemaVersion:'LEGACY_AUDIO_CANDIDATE_PROOF_V1',releaseId:baseRelease.releaseId,snapshotSha256:sha256(baseRelease.snapshotBytes),recipesSha256:sha256(baseRelease.recipesBytes),records:records.sort((a,b)=>a.versionId.localeCompare(b.versionId))};return{...proof,proofSha256:hash(proof)};
}
export function assertLegacyAudioCandidatePreservation({proof,snapshot,recipes,events}){
 if(!proof)return null;const{proofSha256,...body}=proof;check(proof.schemaVersion==='LEGACY_AUDIO_CANDIDATE_PROOF_V1'&&hash(body)===proofSha256,'Legacy audio proof hash differs');const m=snapshot.productionModel;
 for(const r of proof.records){
  for(const[key,id,digest]of[['assetFamilies',r.familyId,r.familyHash],['materialWorkItems',r.workItemId,r.workItemHash],['expectedOutputs',r.expectedOutputId,r.expectedOutputHash],['legacyMaterialRecipeRevisions',r.revisionId,r.revisionHash],['materialRequirements',r.requirementId,r.requirementHash]])check(hash(one(m[key],v=>v.id===id,'Preserved legacy audio '+key))===digest,'Compiler changed legacy audio '+key);
  check(hash(one(recipes.executionDefinitions,d=>d.id===r.definitionId,'Preserved legacy audio definition'))===r.definitionContentHash,'Compiler changed legacy audio definition');
  const versions=(m.assetVersions||[]).filter(v=>v.id===r.versionId);check(r.baseVersionHash?versions.length===1&&hash(versions[0])===r.baseVersionHash:versions.length===0,'Compiler inserted or changed a legacy audio base candidate');
  check(hash(one(recipes.executionDefinitions,d=>d.id===r.parentDefinitionId,'Preserved parent definition'))===r.parentDefinitionContentHash&&hash(one(m.expectedOutputs,o=>o.id===r.parentExpectedOutputId,'Preserved parent output'))===r.parentExpectedOutputHash,'Compiler changed legacy audio parent call/output');
  const parents=(m.assetVersions||[]).filter(v=>v.id===r.parentVersionId);check(r.parentBaseVersionHash?parents.length===1&&hash(parents[0])===r.parentBaseVersionHash:parents.length===0,'Compiler inserted or changed a legacy audio parent base version');
  for(const p of r.eventProof)check(hash(one(events,e=>e.eventId===p.eventId,'Preserved legacy audio event'))===p.sha256,'Compiler changed legacy audio history');
 }
 return{schemaVersion:proof.schemaVersion,proofSha256,versionIds:proof.records.map(r=>r.versionId),eventsPreserved:true,baseCandidateVersionsCreated:0};
}
