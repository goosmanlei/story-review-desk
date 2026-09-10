import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalJson,sha256} from '../host/instance-runtime/bytes.mjs';
import {materialUsageFixture} from './material-usage-fixture.mjs';
import {usageHash,assertMaterialUsageSource,validateMaterialUsageLedger,materialUsageRequirementBasis,materialUsageEventPayload,projectMaterialUsages,effectiveRequirementFamilyIds,exactRequirementUsageBinding} from '../host/instance-runtime/material-usage-model.mjs';
import {loadMaterialUsageEvidence,materialUsageMediaCurrent,preserveMaterialUsageProjection} from '../host/instance-runtime/material-usage-preservation.mjs';
import {applyRequirementCompositionCoverage} from '../host/instance-runtime/material-requirement-composition.mjs';
import {productionBindingReasons} from '../host/instance-runtime/shot-production-model.mjs';

function close(f){
 const base=Object.fromEntries(Object.entries(f.body).filter(([key])=>key!=='id'));f.body.id='MUSE-REV-'+usageHash(base).slice(0,32);
 const doc=f.documents[0];doc.aliases=['story/material-usages/'+f.body.id+'.json'];doc.bytes=Buffer.from(canonicalJson(f.body));doc.sha256=sha256(doc.bytes);
 Object.assign(f.ref,{id:f.body.id,usageId:f.body.usageId,sourceRef:doc.aliases[0],sourceSha256:doc.sha256});
 const envelope=Object.fromEntries(['eventId','eventKind','idempotencyKeyHash','requestHash','recordedAt','eventSequence'].map(k=>[k,f.event[k]]));
 for(const k of Object.keys(f.event))delete f.event[k];Object.assign(f.event,materialUsageEventPayload(f.body,f.ref),envelope);return f;
}
function projected(f){f.model.materialUsageEvidence=validateMaterialUsageLedger(f).map(r=>({...r,mediaCurrent:true}));return projectMaterialUsages(f.model,f.state);}
function currentTx(f,override={}){const media={...f.media,availability:'PRESENT',metadata:{authorityDomain:'FORMAL',visibility:'PUBLIC'}};return {getMedia:async()=>media,resolveMedia:async()=>media,getAux:async()=>null,listAux:async()=>[],listEvents:async()=>f.events,listPublishedDocumentMetadata:async()=>f.documents,readDocumentRevision:async()=>f.documents[0],readView:async()=>({sourceRevisionIds:f.documents.map(d=>d.revisionId)}),...override};}

test('usage evidence skips unrelated published bodies while preserving exact evidence',async()=>{
 const f=materialUsageFixture(),baseline=await loadMaterialUsageEvidence(currentTx(f),f.model),reads=[];
 const unrelated=Array.from({length:300},(_,i)=>({revisionId:'unrelated-'+i,metadata:{sourceRole:'SCRIPT'},aliases:['story/scripts/'+i+'.md']}));
 const docs=[...unrelated,...f.documents],tx=currentTx(f,{
  listPublishedDocumentMetadata:async()=>docs,
  readView:async()=>({sourceRevisionIds:docs.map(d=>d.revisionId)}),
  readDocumentRevision:async id=>{reads.push(id);assert(!id.startsWith('unrelated-'),'unrelated source body must not be transferred');return f.documents.find(d=>d.revisionId===id);},
 });
 assert.deepEqual(await loadMaterialUsageEvidence(tx,f.model),baseline);
 assert.deepEqual(reads,[f.documents[0].revisionId]);
});
test('usage metadata filtering still fails closed for missing, deleted, mislabelled and orphan sources',async()=>{
 for(const change of ['missing','deleted','mislabelled','orphan']){
  const f=materialUsageFixture();
  if(change==='deleted')f.documents[0].deleted=true;
  if(change==='mislabelled')f.documents[0].metadata.sourceRole='SCRIPT';
  if(change==='orphan')f.model.materialUsageLedger=[];
  const tx=currentTx(f,{
   listPublishedDocumentMetadata:async()=>change==='missing'||change==='deleted'?[]:f.documents,
   readDocumentRevision:async()=>change==='missing'?null:f.documents[0],
  });
  await assert.rejects(loadMaterialUsageEvidence(tx,f.model),undefined,change);
 }
});

test('usage integrity keeps complete original assets and separate review history unchanged',()=>{
 const f=materialUsageFixture(),before=canonicalJson({families:f.model.assetFamilies,versions:f.model.assetVersions,recipes:f.recipes,adoption:f.adoption});
 const rows=validateMaterialUsageLedger(f);assert.equal(rows.length,1);assert.equal(rows[0].event.subjectType,'MATERIAL_USAGE');
 assert.equal(rows[0].event.originalAssetAdoptionPerformed,false);assert.equal(rows[0].event.originalRightsChanged,false);assert.equal(rows[0].event.adoptionIntent,undefined);
 assert.equal(canonicalJson({families:f.model.assetFamilies,versions:f.model.assetVersions,recipes:f.recipes,adoption:f.adoption}),before);
});
const corruptions={
 'missing ledger':f=>delete f.model.materialUsageLedger,
 'different instance':f=>f.snapshot.instance.instanceId='instance:other',
 'non-array ledger':f=>f.model.materialUsageLedger={},
 'missing event':f=>f.events=f.events.filter(e=>e!==f.event),
 'missing source':f=>f.documents=[],
 'unrecognized source role marked by usage path':f=>f.documents[0].metadata.sourceRole='OTHER',
 'unrecognized event kind marked by usage subject':f=>f.event.eventKind='other',
 'wrong alias':f=>f.documents[0].aliases=['story/material-usages/wrong.json'],
 'source bytes':f=>f.documents[0].bytes=Buffer.from('{}'),
 'review payload':f=>f.event.action='DO_NOT_USE',
 'old ASSET adoption field':f=>f.event.adoptionIntent='ADOPT_THIS_VERSION',
 'missing original review':f=>f.events=f.events.filter(e=>e!==f.adoption),
 'original review changed':f=>f.adoption.note='tampered',
 'duplicate ledger':f=>f.model.materialUsageLedger.push({...f.ref}),
 'invalid envelope request hash':f=>f.event.requestHash='unknown',
 'invalid recorded time':f=>f.event.recordedAt='unknown',
 'explicit purpose null in original ASSET':f=>{f.adoption.reviewPurpose=null;f.body.basis.source.adoption.sha256=usageHash(f.adoption);close(f);},
 'source after usage':f=>{f.adoption.eventSequence=10;f.body.basis.source.adoption.sha256=usageHash(f.adoption);close(f);},
 'original approval wrong family':f=>{f.adoption.familyId='OTHER';f.body.basis.source.adoption.sha256=usageHash(f.adoption);close(f);},
 'unobserved original':f=>{f.body.content.observation.originalViewed=false;close(f);},
 'partial criteria':f=>{f.body.content.decision.criterionFindings.pop();close(f);},
 'passing with failed criterion':f=>{f.body.content.decision.criterionFindings[0].verdict='FAIL';close(f);},
 'non-image newly authored requirement':f=>{f.body.basis.requirement.demand.mediaType='AUDIO';f.body.basis.requirement.requirementHash=usageHash({demand:f.body.basis.requirement.demand,representation:f.body.basis.requirement.representation});close(f);},
 'nonempty existing production representation':f=>{f.body.basis.requirement.representation.assetFamilyIds=['OTHER'];f.body.basis.requirement.requirementHash=usageHash({demand:f.body.basis.requirement.demand,representation:f.body.basis.requirement.representation});close(f);},
 'unknown original rights':f=>{f.body.basis.source.projectRightsGate='UNKNOWN';close(f);},
 'cross-family same SHA physical media':f=>{f.body.basis.source.media.mediaId='OTHER';close(f);},
 'forked first usage':f=>{f.body.basis.previousHead={eventId:'nonexistent',sha256:usageHash('wrong')};close(f);},
};
for(const [name,mutate] of Object.entries(corruptions))test('usage ledger rejects '+name,()=>{const f=materialUsageFixture();mutate(f);assert.throws(()=>validateMaterialUsageLedger(f));});

test('self-consistent source still requires the complete exact target standard and observed image',()=>{
 const f=materialUsageFixture();assert.equal(assertMaterialUsageSource(f.body),f.body);
 for(const mutate of [b=>b.content.decision.reviewSpecHash=usageHash('other'),b=>b.basis.requirement.reviewSpec.criteria[0].question='changed',b=>b.basis.requirement.composition={schemaVersion:'1.0'},b=>b.basis.source.media.byteSize=0,b=>b.content.authorization.scope='COMMERCIAL',b=>b.content.decision.criterionFindings[0].verdict='NA']){const n=structuredClone(f);mutate(n.body);close(n);assert.throws(()=>assertMaterialUsageSource(n.body));}
});
test('target first-setup eligibility rejects aggregate, existing family, inactive and non-IMAGE requirements',()=>{
 for(const mutate of [f=>f.model.materialRequirements[0].composition={schemaVersion:'1.0',mode:'ALL',requiredComponents:[]},f=>f.model.materialRequirements[0].scopeRole='EVIDENCE_ONLY',f=>f.model.materialRequirements[0].assetFamilyRefs=['OTHER'],f=>f.model.materialRequirements[0].materialWorkItemRef='work:already',f=>{f.graph.requirements[0].mediaType='AUDIO';f.model.domainGraph.requirements[0].mediaType='AUDIO';}]){const f=materialUsageFixture();mutate(f);assert.throws(()=>materialUsageRequirementBasis(f.model,f.target.requirementId));}
});
test('same exact usage binding drives requirement coverage and downstream input qualification',()=>{
 const f=materialUsageFixture(),r=f.model.materialRequirements[0],binding={...f.target},state={...f.state,materialUsageBindings:projected(f)};
 assert.deepEqual(effectiveRequirementFamilyIds(state,r),[f.target.familyId]);assert.equal(exactRequirementUsageBinding(state,r,binding),true);
 assert.deepEqual(productionBindingReasons(f.model,state,binding),[]);
 const rows=[{...r,coverageSatisfied:true,coveredByFamilyRefs:[f.target.familyId],coveredByVersionRefs:[f.target.versionId]},{id:'aggregate',requirementClass:'REQUIRED',assetFamilyRefs:[],composition:{schemaVersion:'1.0',mode:'ALL',requiredComponents:[{id:'empty',requirementId:r.id}]}}];
 assert.equal(applyRequirementCompositionCoverage(rows)[1].coverageSatisfied,false,'forged green leaf alone cannot cover aggregate');
 assert.equal(applyRequirementCompositionCoverage(rows,{usageBindings:state.materialUsageBindings})[1].coverageSatisfied,true);
 for(const key of ['familyId','versionId','sha256']){const other={...binding,[key]:key==='sha256'?usageHash('other'):'OTHER'};assert.equal(exactRequirementUsageBinding(state,r,other),false);assert.notDeepEqual(productionBindingReasons(f.model,state,other),[]);}
 assert.equal(exactRequirementUsageBinding(state,{...r,requirementHash:usageHash('changed')},binding),false);
});
test('revoked use, stale target, changed adoption, unknown rights and missing original media all fail locally',()=>{
 for(const mutate of [f=>{f.body.content.decision.action='DO_NOT_USE';f.body.content.decision.criterionFindings[0]={criterionId:'purpose',verdict:'FAIL',note:'新用途不合适'};close(f);},f=>f.model.materialRequirements[0].reviewSpec.hash=usageHash('new-spec'),f=>f.state.assetFamiliesById[f.target.familyId].currentVersionId='OTHER',f=>f.state.assetVersionsById[f.target.versionId].reviewCorrection.headEventId='review:new',f=>f.state.assetVersionsById[f.target.versionId].projectRightsGate='UNKNOWN',f=>f.state.assetVersionsById[f.target.versionId].canFlowDownstream=false]){
  const f=materialUsageFixture(),assetBefore=canonicalJson(f.model.assetVersions);mutate(f);const bindings=projected(f);assert.equal(bindings[0].eligible,false);assert.equal(canonicalJson(f.model.assetVersions),assetBefore);assert.deepEqual(effectiveRequirementFamilyIds({materialUsageBindings:bindings},f.model.materialRequirements[0]),[]);
 }
 const f=materialUsageFixture();projected(f);f.model.materialUsageEvidence[0].mediaCurrent=false;assert.equal(projectMaterialUsages(f.model,f.state)[0].eligible,false);
});
test('source review A-to-B-to-A approval creates a different head and cannot revive an old use',()=>{
 const f=materialUsageFixture();projected(f);f.state.assetVersionsById[f.target.versionId].reviewCorrection.headEventId='review:readopted';
 assert.deepEqual(projectMaterialUsages(f.model,f.state)[0].reasons,['USAGE_SOURCE_ADOPTION_CHANGED']);
});
test('loader validates marked orphans and malformed empty ledger before its empty fast path',async()=>{
 const f=materialUsageFixture(),tx=currentTx(f);assert.equal((await loadMaterialUsageEvidence(tx,f.model)).materialUsageEvidence.length,1);
 const noLedger={...f.model,materialUsageLedger:[]};await assert.rejects(loadMaterialUsageEvidence(currentTx(f,{listEvents:async()=>[]}),noLedger));
 await assert.rejects(loadMaterialUsageEvidence(currentTx(f,{listEvents:async()=>[],listPublishedDocumentMetadata:async()=>[]}),{...f.model,materialUsageLedger:{}}));
 const empty={};assert.equal(await loadMaterialUsageEvidence(currentTx(f,{listEvents:async()=>[],listPublishedDocumentMetadata:async()=>[]}),empty),empty);
});
test('actual registered source permits exact logical alias and rejects private, trial, unknown or cross-family resolution',async()=>{
 const f=materialUsageFixture(),source={...f.body.basis.source,path:'media/logical/original.png'};
 assert.equal(await materialUsageMediaCurrent(currentTx(f),source),true);
 for(const metadata of [{authorityDomain:'PRIVATE'},{authorityDomain:'LOCAL_TRIAL'},{authorityDomain:'UNKNOWN'},{authorityDomain:'FORMAL',visibility:'PRIVATE'},{authorityDomain:'FORMAL',visibility:'UNKNOWN'},{authorityDomain:'FORMAL',sourceRole:'ORIGINAL_SOURCE'}])assert.equal(await materialUsageMediaCurrent(currentTx(f,{getMedia:async()=>({...f.media,availability:'PRESENT',metadata})}),source),false);
 for(const change of [{mediaId:'OTHER'},{versionId:'OTHER'},{sha256:usageHash('other')},{byteSize:f.media.byteSize+1},{relativePath:'different.png'}])assert.equal(await materialUsageMediaCurrent(currentTx(f,{resolveMedia:async()=>({...f.media,...change})}),source),false);
});
test('source synchronization restores full usage history but cannot modify source assets or recipes',()=>{
 const f=materialUsageFixture(),snapshot=structuredClone(f.snapshot),recipes=structuredClone(f.recipes);delete snapshot.productionModel.materialUsageLedger;
 const before=canonicalJson({families:snapshot.productionModel.assetFamilies,versions:snapshot.productionModel.assetVersions,recipes});
 const restored=preserveMaterialUsageProjection({...f,snapshot,recipes,baseSnapshot:f.snapshot});assert.deepEqual(restored.snapshot.productionModel.materialUsageLedger,[f.ref]);
 assert.equal(canonicalJson({families:snapshot.productionModel.assetFamilies,versions:snapshot.productionModel.assetVersions,recipes}),before);
 snapshot.productionModel.materialUsageLedger[0].eventId='different';assert.throws(()=>preserveMaterialUsageProjection({...f,snapshot,recipes,baseSnapshot:f.snapshot}));
});

test('raw evidence without its exact source ledger cannot create coverage and is stripped by the loader',async()=>{
 const f=materialUsageFixture();projected(f);delete f.model.materialUsageLedger;assert.deepEqual(projectMaterialUsages(f.model,f.state),[]);
 const clean=await loadMaterialUsageEvidence(currentTx(f,{listEvents:async()=>[],listPublishedDocumentMetadata:async()=>[]}),f.model);assert.equal(Object.hasOwn(clean,'materialUsageEvidence'),false);
});

test('explicit aggregate input expansion requires every exact child and never uses the parent own family',async()=>{
 const {requirementInputFamilyIds}=await import('../host/instance-runtime/material-requirement-composition.mjs');
 const {api}=await import('./domain-new-production-fixture.mjs');
 const f=materialUsageFixture(),leaf=f.model.materialRequirements[0],second={id:'REQ-SECOND',requirementClass:'REQUIRED',requirementHash:usageHash('second'),assetFamilyRefs:['IMAGE-SECOND']};
 const aggregate={id:'REQ-ALL',requirementClass:'REQUIRED',requirementHash:usageHash('aggregate'),assetFamilyRefs:['PARENT-NOT-A-COMPONENT'],composition:{schemaVersion:'1.0',mode:'ALL',requiredComponents:[{id:'empty',requirementId:leaf.id},{id:'second',requirementId:second.id}]}};
 f.model.materialRequirements.push(second,aggregate);f.state.materialUsageBindings=projected(f);
 f.state.assetFamiliesById['IMAGE-SECOND']={currentVersionId:'IMAGE-SECOND@V001',canFlowDownstream:true};f.state.assetVersionsById['IMAGE-SECOND@V001']={id:'IMAGE-SECOND@V001',familyId:'IMAGE-SECOND',sha256:usageHash('second-image'),path:'media/second.png',canFlowDownstream:true,lifecycleState:'RELEASED'};
 const project=(secondCovered=true)=>{f.state.materialRequirementsById=Object.fromEntries(applyRequirementCompositionCoverage([{...leaf,coverageSatisfied:true},{...second,coverageSatisfied:secondCovered},aggregate],{usageBindings:f.state.materialUsageBindings}).map(r=>[r.id,r]));};
 project(false);assert.deepEqual(requirementInputFamilyIds(f.model,f.state,aggregate),[]);
 project();assert.deepEqual(requirementInputFamilyIds(f.model,f.state,aggregate),[f.target.familyId,'IMAGE-SECOND']);
 assert.deepEqual(productionBindingReasons(f.model,f.state,{...f.target,requirementId:aggregate.id}),[]);
 f.model.sceneCoveragePlanRevisions=[{scopeId:'SCENE-TEST',scopeRole:'CURRENT',episodeNarrativeReleaseId:'release:current',content:{beats:[{materialRequirementRefs:[aggregate.id]}]}}];
 const adopted=api.deriveCurrentAdoptedMaterialSet(f.snapshot,f.state,'SCENE-TEST');assert.deepEqual(adopted.bindings.map(b=>b.familyId),['IMAGE-SECOND',f.target.familyId]);
 project(false);assert.throws(()=>api.deriveCurrentAdoptedMaterialSet(f.snapshot,f.state,'SCENE-TEST'),/未齐套/);
 project();f.state.materialRequirementsById[second.id].requirementHash=usageHash('changed');assert.deepEqual(requirementInputFamilyIds(f.model,f.state,aggregate),[]);
 project();f.state.materialRequirementsById[leaf.id].bindingStale=true;assert.deepEqual(requirementInputFamilyIds(f.model,f.state,aggregate),[]);
 aggregate.composition.requiredComponents=[{id:'only',requirementId:leaf.id}];project();assert.deepEqual(requirementInputFamilyIds(f.model,f.state,aggregate),[f.target.familyId]);
 aggregate.composition.requiredComponents=[];project();assert.deepEqual(requirementInputFamilyIds(f.model,f.state,aggregate),[]);
});

test('hosted omission explains its scope without falsely asserting the formal source is unavailable',()=>{
 const f=materialUsageFixture();projected(f);Object.assign(f.model.materialUsageEvidence[0],{mediaCurrent:false,mediaAvailabilityScope:'HOSTED_EXPORT',mediaCurrentInSourceProjection:true});
 assert.deepEqual(projectMaterialUsages(f.model,f.state)[0].reasons,['HOSTED_SOURCE_MEDIA_NOT_INCLUDED']);
});

test('location state matching accepts only exact adopted usage and its fully covered aggregate leaf',async()=>{
 const {productionSpaceReasons}=await import('../host/instance-runtime/shot-production-space.mjs');
 const f=materialUsageFixture(),r=f.model.materialRequirements[0];f.model.domainGraph.entities[0].type='LOCATION';
 f.body.basis.requirement=materialUsageRequirementBasis(f.model,r.id);close(f);f.state.materialUsageBindings=projected(f);
 const hash=usageHash('spatial'),loc=f.model.domainGraph.entities[0].id;f.model.spatialEvidence={projectionSchemaVersion:'PRODUCTION_SPATIAL_V1',sourceRef:'story/map.json',sourceSha256:hash,locations:[{id:loc}],locationPackages:[{id:loc,zones:[{id:'ZONE'}],cameras:[{id:'CAM',zoneId:'ZONE'}]}]};f.model.sourceHashes={productionMapSha256:hash};
 const settings={space:{loc,state:f.model.domainGraph.states[0].id,zone:'ZONE',camera:'CAM',freeze:hash},inputs:[f.target]};
 assert.deepEqual(productionSpaceReasons(f.model,settings,f.state),[]);
 assert.deepEqual(productionSpaceReasons(f.model,settings),['SPACE_STATE_NOT_BOUND_TO_ADOPTED_INPUT']);
 assert.deepEqual(productionSpaceReasons(f.model,{...settings,inputs:[{...f.target,sha256:usageHash('wrong')}]},f.state),['SPACE_STATE_NOT_BOUND_TO_ADOPTED_INPUT']);
 const aggregate={id:'REQ-LOCATION-ALL',requirementClass:'REQUIRED',requirementHash:usageHash('all'),assetFamilyRefs:[],composition:{schemaVersion:'1.0',mode:'ALL',requiredComponents:[{id:'night',requirementId:r.id}]}};f.model.materialRequirements.push(aggregate);
 f.state.materialRequirementsById=Object.fromEntries(applyRequirementCompositionCoverage([{...r,coverageSatisfied:true},aggregate],{usageBindings:f.state.materialUsageBindings}).map(row=>[row.id,row]));
 const allSettings={...settings,inputs:[{...f.target,requirementId:aggregate.id}]};assert.deepEqual(productionSpaceReasons(f.model,allSettings,f.state),[]);
 f.state.materialRequirementsById[r.id].bindingStale=true;assert.deepEqual(productionSpaceReasons(f.model,allSettings,f.state),['SPACE_STATE_NOT_BOUND_TO_ADOPTED_INPUT']);
});
