import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {canonicalJson,sha256} from '../host/instance-runtime/bytes.mjs';
import {domainHash} from '../host/instance-runtime/domain-model.mjs';
import {materialProductionFixture as baseMaterialProductionFixture,imageRequirementId,imageRepresentationId,changeDomain} from './material-production-fixture.mjs';
import {getMaterialProductionWorkspace,saveMaterialProductionDraft,previewMaterialProduction,enqueueMaterialProduction,applyMaterialProductionJob} from '../host/instance-runtime/material-production-service.mjs';
import {preserveMaterialProductionProjection} from '../host/instance-runtime/material-production-preservation.mjs';
import {domainProductionSlice} from '../host/instance-runtime/domain-projection.mjs';
import {findCompatibleRequirementBinding,findHistoricalCompatibleRequirementBinding,validateDomainProductionCompatibilityRecord} from '../host/instance-runtime/domain-production-compatibility.mjs';
import {sealCompatibility} from './fixtures/domain-production-compatibility.mjs';
import {validateMaterialProductionRebaseArchive} from '../host/instance-runtime/material-production-rebase-archive.mjs';

// Only isolated synthetic repositories and tiny registered fixture bytes.
// No provider, official instance, deployment, native image or audio is opened.
const api={projectOperationalState(snapshot,reviews,candidates){
 const m=snapshot.productionModel,versions=[...m.assetVersions,...candidates.map(c=>({...c,id:c.versionId,outputState:'PRESENT'}))],families=m.assetFamilies.map(f=>({...f}));
 for(const f of families){const approved=reviews.filter(r=>r.familyId===f.id&&r.action==='APPROVE_AND_RELEASE'&&r.applicationStatus==='APPLIED').at(-1);if(approved){f.currentVersionId=approved.versionId;Object.assign(versions.find(v=>v.id===approved.versionId),{canFlowDownstream:true,lifecycleState:'RELEASED'});}}
 return{assetFamiliesById:Object.fromEntries(families.map(f=>[f.id,f])),assetVersionsById:Object.fromEntries(versions.map(v=>[v.id,v]))};
}};
const workspace=repo=>repo.readTransaction(tx=>getMaterialProductionWorkspace(tx,{requirementId:imageRequirementId,api}));
const content=prompt=>({model:'codex:gpt-image-2',prompt,negativePrompt:'Only the same synthetic identity.',parameters:{width:1,height:1},inputBindings:[]});
async function provision(repo,key){
 const w=await workspace(repo),s=await repo.writeTransaction(tx=>saveMaterialProductionDraft(tx,{requirementId:imageRequirementId,expectedReleaseId:w.releaseId,expectedDraftRevisionId:w.draftHeadRevisionId,expectedBasisHash:w.basisHash,content:content(key)},{api}));
 const p=await repo.readTransaction(tx=>previewMaterialProduction(tx,{requirementId:imageRequirementId,draftRevisionId:s.revisionId},{api}));
 const j=await repo.writeTransaction(tx=>enqueueMaterialProduction(tx,{requirementId:imageRequirementId,draftRevisionId:s.revisionId,previewHash:p.previewHash,requestId:key},{api}));
 return repo.writeTransaction(tx=>applyMaterialProductionJob(tx,{jobId:j.jobId,api}));
}
let sequence=0;
async function append(repo,kind,payload){const id='compatibility-fixture:'+ ++sequence;return(await repo.writeTransaction(tx=>tx.appendEvent({kind,idempotencyKey:id,requestHash:sha256(id),eventSchemaVersion:'2.2',payload}))).event;}
async function register(f){
 const v=await f.repo.readView(),m=v.snapshot.productionModel,plan=m.materialProductionPlans[0],work=m.materialWorkItems.find(w=>w.id===plan.workItemId),definition=v.recipes.executionDefinitions.find(d=>d.id===work.executionDefinitionRef),output=m.expectedOutputs.find(o=>o.id===definition.output.expectedOutputRef),versionId=plan.familyId+'@'+output.plannedVersionLabel,bytes=Buffer.from('synthetic native '+versionId),binding={executionRequestId:'request:'+versionId,executionDefinitionId:definition.id,callPackageHash:definition.definitionHash};
 await mkdir(path.dirname(path.join(f.root,output.targetPath)),{recursive:true});await writeFile(path.join(f.root,output.targetPath),bytes,{flag:'wx'});
 await append(f.repo,'execution-request',{...binding,workItemId:work.id,familyId:plan.familyId,executor:'CODEX',requestState:'CLAIMED',maxOutputs:1});
 await append(f.repo,'run',{...binding,runId:'run:'+versionId,runState:'SUCCEEDED'});
 await f.repo.writeTransaction(tx=>tx.registerMedia({mediaId:plan.familyId,versionId,relativePath:output.targetPath,sha256:sha256(bytes),byteSize:bytes.length,aliases:[],metadata:{authorityDomain:'FORMAL'}}));
 const candidate=await append(f.repo,'asset-version',{...binding,runId:'run:'+versionId,familyId:plan.familyId,versionId,expectedOutputId:output.id,path:output.targetPath,sha256:sha256(bytes),parentVersionId:definition.parentVersionId,inputBindings:[],lifecycleState:'REVIEW_PENDING',projectRightsGate:'UNKNOWN'});
 await append(f.repo,'review',{subjectType:'ASSET',familyId:plan.familyId,versionId,versionSha256:candidate.sha256,action:'APPROVE_AND_RELEASE',applicationStatus:'APPLIED',effect:'APPLIED'});
 return{plan,work,definition,output,candidate};
}
async function addScope(repo,label){
 const before=await repo.readView(),sceneId='scene:'+label,revisionId='scene-revision:'+label;
 let evidence;
 await repo.writeTransaction(async tx=>{const v=await tx.readView(),snapshot=structuredClone(v.snapshot),quote='The same physical identity is required in '+label+'.',doc=await tx.putDocument({documentId:'scope:'+label,aliases:['story/scope-fixture/'+label+'.txt'],expectedRevisionId:null,bytes:quote,metadata:{sourceRole:'SOURCE_DOCUMENT'}});evidence={sourceId:'source_'+doc.sha256,revisionId:doc.revisionId,sha256:doc.sha256,locator:sceneId+'/block:1',quote};snapshot.productionModel.sceneScriptRevisions.push({id:revisionId,sceneId,isCurrent:true,contentHash:domainHash(label),sourceRevisionId:doc.revisionId,sourceSha256:doc.sha256});await tx.publishRelease({snapshot,recipes:v.recipes,expectedReleaseId:v.releaseId,sourceRevisionIds:[...v.sourceRevisionIds,doc.revisionId]});});
 const demand=before.snapshot.productionModel.domainGraph.requirements.find(r=>r.id===imageRequirementId);
 await changeDomain(repo,'MATERIAL',[{collection:'requirements',id:demand.id,beforeHash:domainHash(demand),value:{...demand,scope:[...demand.scope,{scopeType:'SCENE',scopeId:sceneId,revisionId}],evidence:[...demand.evidence,evidence]}}]);
 return{before,after:await repo.readView()};
}
async function materialProductionFixture(t){const f=await baseMaterialProductionFixture(t);await addScope(f.repo,'original');return f;}
async function frozen(f){const v=await f.repo.readView();return{baseSnapshot:v.snapshot,baseRecipes:v.recipes,documents:await Promise.all(v.sourceRevisionIds.map(id=>f.repo.readDocumentRevision(id)))};}
function preserve(input){return preserveMaterialProductionProjection({...input,snapshot:structuredClone(input.baseSnapshot),recipes:structuredClone(input.baseRecipes)});}
async function proofFor(f,{before,after},label,{includeOccurrences=false}={}){
 const old=before.snapshot.productionModel,current=after.snapshot.productionModel,meta=await f.repo.getMetadata();
 const slice=m=>domainProductionSlice(m.domainGraph,[imageRepresentationId],{configuration:m.systemConfiguration.config.domain,referencePolicies:m.domainReferencePolicyBindings,representationPolicies:m.domainRepresentationPolicyBindings});
 const beforeDemand=old.domainGraph.requirements.find(r=>r.id===imageRequirementId),afterDemand=current.domainGraph.requirements.find(r=>r.id===imageRequirementId),representation=current.domainGraph.representations.find(r=>r.id===imageRepresentationId);
 const record=sealCompatibility({schemaVersion:'DOMAIN_PRODUCTION_COMPATIBILITY_V1',compatibilityId:'compatibility:'+label,instanceId:meta.instanceId,runtimeEpoch:meta.runtimeEpoch,beforeGraphRef:old.domainGraphRef,afterGraphRef:current.domainGraphRef,beforeSlice:slice(old),afterSlice:slice(current),metadataApprovals:[],occurrences:includeOccurrences?(current.domainInvalidations||[]).map((o,index)=>({index,hash:domainHash(o),familyId:o.familyId,previousHash:o.previousHash,currentHash:o.currentHash})).filter(o=>o.index>=(old.domainInvalidations||[]).length):[],requirementBindings:[{requirementId:imageRequirementId,beforeHash:domainHash({demand:beforeDemand,representation}),afterHash:domainHash({demand:afterDemand,representation}),representationId:imageRepresentationId,representationHash:domainHash(representation),beforeDemand,afterDemand}],versionBindings:[],approval:{confirmed:true,reason:'Synthetic host test: same physical contract, exact published source and additive scene scope.'}});
 assert(validateDomainProductionCompatibilityRecord(record,{model:current,instanceId:meta.instanceId}));return record;
}
async function install(f,record){await f.repo.writeTransaction(async tx=>{const v=await tx.readView(),snapshot=structuredClone(v.snapshot);snapshot.productionModel.domainProductionCompatibilities=[...(snapshot.productionModel.domainProductionCompatibilities||[]),structuredClone(record)];await tx.publishRelease({snapshot,recipes:v.recipes,expectedReleaseId:v.releaseId,sourceRevisionIds:v.sourceRevisionIds});});}
async function compatibleFixture(t){const f=await materialProductionFixture(t);await provision(f.repo,'compat:first');const first=await register(f),change=await addScope(f.repo,'approved'),record=await proofFor(f,change,'approved');await install(f,record);return {...f,first,record};}

test('scope addition without a controlled proof still fails; the initial plan/source/recipe/work hash stay frozen',async t=>{
 const f=await materialProductionFixture(t);await provision(f.repo,'compat:first');const first=await register(f),before=await f.repo.readView(),source=await f.repo.readDocumentRevision(first.plan.sourceRevisionId);
 await addScope(f.repo,'unconfirmed');await assert.rejects(workspace(f.repo),{code:'DOMAIN_CONFLICT'});
 const after=await f.repo.readView();assert.deepEqual(after.snapshot.productionModel.materialProductionPlans,before.snapshot.productionModel.materialProductionPlans);assert.deepEqual(after.recipes,before.recipes);assert.equal(after.snapshot.productionModel.materialWorkItems.find(w=>w.id===first.work.id).requirementHash,first.work.requirementHash);assert.deepEqual(await f.repo.readDocumentRevision(first.plan.sourceRevisionId),source);
 assert.deepEqual(preserve(await frozen(f)).recipes,after.recipes);
});

test('three exact additive scopes bridge chained hashes; V002/V003/V004 freeze their own current hash without editing initial plan or work',async t=>{
 const f=await materialProductionFixture(t);await provision(f.repo,'chain:first');const initial=await register(f),start=await f.repo.readView(),source=await f.repo.readDocumentRevision(initial.plan.sourceRevisionId);const hashes=[initial.plan.requirementHash];
 for(const [i,label]of ['second-scene','third-scene','fourth-scene'].entries()){
  const change=await addScope(f.repo,label),record=await proofFor(f,change,label);await install(f,record);const w=await workspace(f.repo);assert.deepEqual(w.blockers,[]);assert.notEqual(w.requirement.requirementHash,hashes.at(-1));hashes.push(w.requirement.requirementHash);assert.equal(w.basis.revision.requirementCompatibilities.length,i+1);
  const result=await provision(f.repo,'chain:revision:'+i),v=await f.repo.readView(),m=v.snapshot.productionModel,definition=v.recipes.executionDefinitions.find(d=>d.id===result.definitionId),row=m.materialProductionRecipeRevisions.at(-1),body=JSON.parse((await f.repo.readDocumentRevision(row.sourceRevisionId)).bytes);
  assert.equal(result.plannedVersionLabel,'V'+String(i+2).padStart(3,'0'));assert.equal(row.requirementHash,w.requirement.requirementHash);assert.equal(definition.materialRequirementHash,w.requirement.requirementHash);assert.equal(body.basis.requirementHash,w.requirement.requirementHash);assert.equal(body.requirementAfter.requirementHash,w.requirement.requirementHash);
  assert.equal(m.materialWorkItems.find(w=>w.id===initial.work.id).requirementHash,initial.work.requirementHash);assert.deepEqual(m.materialProductionPlans,start.snapshot.productionModel.materialProductionPlans);assert.deepEqual(v.recipes.executionDefinitions.find(d=>d.id===initial.definition.id),initial.definition);assert.deepEqual(await f.repo.readDocumentRevision(initial.plan.sourceRevisionId),source);
  const preserved=preserve(await frozen(f));assert.deepEqual(preserved.recipes,v.recipes);assert.deepEqual(preserved.snapshot.productionModel.materialProductionRecipeRevisions,m.materialProductionRecipeRevisions);
  if(i<2)await register(f);
 }
 const final=await f.repo.readView(),m=final.snapshot.productionModel,rep=m.domainGraph.representations.find(r=>r.id===imageRepresentationId),query={requirementId:imageRequirementId,beforeHash:hashes[0],afterHash:hashes[1],representationId:imageRepresentationId,representationHash:domainHash(rep),instanceId:f.profile.instanceId,runtimeEpoch:'restored-new-epoch'};
 assert.equal(findHistoricalCompatibleRequirementBinding(m,query).eligibility,'HISTORICAL_ONLY');assert.equal(findCompatibleRequirementBinding(m,{...query,afterHash:hashes.at(-1)}).links.length,3);
 // An actual later production change blocks execution, not restoration of the
 // already-frozen compatible recipes and their historical proof chain.
 const demand=m.domainGraph.requirements.find(r=>r.id===imageRequirementId);await changeDomain(f.repo,'MATERIAL',[{collection:'requirements',id:demand.id,beforeHash:domainHash(demand),value:{...demand,acceptanceCriteria:[...demand.acceptanceCriteria,'A materially different face design is required.']}}]);
 await assert.rejects(workspace(f.repo),{code:'DOMAIN_CONFLICT'});assert.deepEqual(preserve(await frozen(f)).recipes,final.recipes);
});

for(const [label,mutate]of [
 ['proof hash',r=>r.proofHash='0'.repeat(64)],
 ['false approval',r=>{r.approval.confirmed=false;sealCompatibility(r);}],
 ['cross instance',r=>{r.instanceId='other-instance';sealCompatibility(r);}],
 ['changed physical criterion',r=>{r.afterSlice.requirements[0].acceptanceCriteria.push('New physical condition.');r.requirementBindings[0].afterDemand=structuredClone(r.afterSlice.requirements[0]);r.requirementBindings[0].afterHash=domainHash({demand:r.requirementBindings[0].afterDemand,representation:r.afterSlice.representations[0]});sealCompatibility(r);}],
 ['changed representation',r=>{r.afterSlice.representations[0].dimensions={costume:'different costume'};sealCompatibility(r);}],
 ['changed rights field',r=>{r.afterSlice.entities[0].rights='CLEAR';sealCompatibility(r);}],
])test('native scope bridge rejects '+label+' rather than laundering frozen provenance',async t=>{
 const f=await materialProductionFixture(t);await provision(f.repo,'negative:first');await register(f);const change=await addScope(f.repo,'negative'),record=await proofFor(f,change,'negative');mutate(record);await install(f,record);const before=await f.repo.exportState();await assert.rejects(workspace(f.repo),{code:'DOMAIN_CONFLICT'});assert.deepEqual(await f.repo.exportState(),before);
});

test('explicit conflicting host links and frozen source tampering still fail even with a valid scope proof',async t=>{
 const f=await compatibleFixture(t),before=await f.repo.readView();
 for(const fault of [c=>{c.requirement.materialWorkItemRef='other-work';},c=>{c.representation.assetFamilyIds=['other-family'];}]){
  const w=await workspace(f.repo);await assert.rejects(f.repo.readTransaction(async tx=>{const read=tx.readView.bind(tx);tx.readView=async()=>{const v=await read(),m=v.snapshot.productionModel;fault({requirement:m.materialRequirements.find(r=>r.id===imageRequirementId),representation:m.domainGraph.representations.find(r=>r.id===imageRepresentationId)});return v;};return getMaterialProductionWorkspace(tx,{requirementId:imageRequirementId,api});}));assert.equal(w.mode,'REVISION');
 }
 await assert.rejects(f.repo.readTransaction(tx=>{const read=tx.readDocumentRevision.bind(tx);tx.readDocumentRevision=async id=>{const doc=await read(id);return id===f.first.plan.sourceRevisionId?{...doc,bytes:Buffer.from('{}')}:doc;};return getMaterialProductionWorkspace(tx,{requirementId:imageRequirementId,api});}),{code:'MATERIAL_PRODUCTION_SOURCE_CONFLICT'});
 assert.equal((await f.repo.readView()).releaseId,before.releaseId);
});

test('conflicting proof paths are rejected; changing epoch alone does not erase host business history',async t=>{
 const f=await compatibleFixture(t),w=await workspace(f.repo);assert.equal(w.mode,'REVISION');
 const m=(await f.repo.readView()).snapshot.productionModel,b=f.record.requirementBindings[0],q={...b,instanceId:f.profile.instanceId,runtimeEpoch:'different-restored-epoch'};assert.equal(findCompatibleRequirementBinding(m,q).eligibility,'CURRENT');
 const duplicate=structuredClone(f.record);duplicate.compatibilityId+='-duplicate';sealCompatibility(duplicate);await install(f,duplicate);await assert.rejects(workspace(f.repo),{code:'DOMAIN_CONFLICT'});
});

test('later duplicate authorization blocks new current bridging but does not erase the exact proof frozen by an earlier recipe',async t=>{
 const f=await compatibleFixture(t);await provision(f.repo,'history:revision');const before=await frozen(f),duplicate=structuredClone(f.record);duplicate.compatibilityId+='-later';sealCompatibility(duplicate);await install(f,duplicate);
 await assert.rejects(workspace(f.repo),{code:'DOMAIN_CONFLICT'});assert.deepEqual(preserve(await frozen(f)).recipes,before.baseRecipes);
});

test('immutable recipe compatibility path cannot be removed or rewritten even if source/body hashes are recomputed',async t=>{
 const f=await compatibleFixture(t);await provision(f.repo,'proof:revision');const initial=await frozen(f);
 const missing=structuredClone(initial);missing.baseSnapshot.productionModel.domainProductionCompatibilities=[];assert.throws(()=>preserve(missing),{code:'MATERIAL_PRODUCTION_SOURCE_CONFLICT'});
 for(const mutate of [body=>body.basis.revision.requirementCompatibilities=[],body=>body.basis.revision.requirementCompatibilities[0].proofHash='0'.repeat(64),body=>body.basis.demand.acceptanceCriteria.push('Forged physical condition.')]){
  const input=structuredClone(initial),row=input.baseSnapshot.productionModel.materialProductionRecipeRevisions.at(-1),doc=input.documents.find(d=>d.revisionId===row.sourceRevisionId),body=JSON.parse(Buffer.from(doc.bytes).toString('utf8'));
  mutate(body);body.basisHash=domainHash(body.basis);row.basisHash=body.basisHash;doc.bytes=Buffer.from(canonicalJson(body));doc.sha256=sha256(doc.bytes);row.sourceSha256=doc.sha256;
  for(const key of ['executionDefinitions','promptRevisions'])for(const d of input.baseRecipes[key])if(d.sourceRevisionId===doc.revisionId)d.sourceSha256=doc.sha256;
  assert.throws(()=>preserve(input),{code:'MATERIAL_PRODUCTION_SOURCE_CONFLICT'});
 }
});

test('compiler reconstruction restores all frozen native members and recipes after compatible hash changes',async t=>{
 const f=await compatibleFixture(t);await provision(f.repo,'restore:revision');const input=await frozen(f),snapshot=structuredClone(input.baseSnapshot),recipes=structuredClone(input.baseRecipes),model=snapshot.productionModel,plans=model.materialProductionPlans,families=new Set(plans.map(p=>p.familyId)),works=new Set(plans.map(p=>p.workItemId));
 for(const key of ['assetFamilies','assetVersions','expectedOutputs'])model[key]=model[key].filter(r=>!families.has(r.familyId||r.id));model.materialWorkItems=model.materialWorkItems.filter(r=>!works.has(r.id));model.reviewContexts=[];model.materialProductionPlans=[];model.materialProductionRecipeRevisions=[];recipes.executionDefinitions=recipes.executionDefinitions.filter(d=>!works.has(d.workItemRef));recipes.promptRevisions=[];
 const restored=preserveMaterialProductionProjection({...input,snapshot,recipes});assert.deepEqual(restored.recipes,input.baseRecipes);for(const key of ['assetFamilies','assetVersions','expectedOutputs','materialWorkItems','reviewContexts','materialProductionPlans','materialProductionRecipeRevisions','domainProductionCompatibilities'])assert.deepEqual(restored.snapshot.productionModel[key],input.baseSnapshot.productionModel[key],key);
});

test('a valid requirement proof cannot authorize UNKNOWN-rights reference media',async t=>{
 const f=await compatibleFixture(t),w=await workspace(f.repo),before=await f.repo.exportState();
 const author={...content('Reference remains subject to actual rights gates.'),inputBindings:[{familyId:f.first.plan.familyId,versionId:f.first.candidate.versionId,sha256:f.first.candidate.sha256}]};
 await assert.rejects(f.repo.writeTransaction(tx=>saveMaterialProductionDraft(tx,{requirementId:imageRequirementId,expectedReleaseId:w.releaseId,expectedDraftRevisionId:w.draftHeadRevisionId,expectedBasisHash:w.basisHash,content:author},{api})),/参考版本/);
 assert.deepEqual(await f.repo.exportState(),before);
});

// Cross-feature contracts use actual isolated source/media/event rows. The
// file inspector is intentionally real; these tests never synthesize a provider
// success when the fixture has only a failed, unregistered expected output.
function inspectFixtureMedia(f){
 api.safeGeneratedPath=async(relative,binding)=>{const file=path.resolve(f.root,relative);assert.ok(file.startsWith(f.root+path.sep));assert.equal(sha256(await readFile(file)),binding.sha256);return file;};
 api.safeReviewPendingPath=async relative=>{const file=path.resolve(f.root,relative);assert.ok(file.startsWith(f.root+path.sep));await readFile(file);return file;};
}
async function failCurrent(f){
 const v=await f.repo.readView(),plan=v.snapshot.productionModel.materialProductionPlans[0],work=v.snapshot.productionModel.materialWorkItems.find(w=>w.id===plan.workItemId),definition=v.recipes.executionDefinitions.find(d=>d.id===work.executionDefinitionRef),binding={executionRequestId:'failed:'+definition.id,executionDefinitionId:definition.id,callPackageHash:definition.definitionHash,inputBindingsHash:domainHash([])};
 await append(f.repo,'execution-request',{...binding,workItemId:work.id,familyId:plan.familyId,executor:'CODEX',requestState:'CLAIMED',maxOutputs:1});
 await append(f.repo,'run',{...binding,runId:'failed-run:'+definition.id,runState:'FAILED',note:'Explicit synthetic provider rejection, no output and no provider call in this fixture.'});
 return definition;
}
async function explicitRebase(f,key){
 const mode='REQUIREMENT_REBASE',w=await f.repo.readTransaction(tx=>getMaterialProductionWorkspace(tx,{requirementId:imageRequirementId,mode,api}));
 const draft=await f.repo.writeTransaction(tx=>saveMaterialProductionDraft(tx,{requirementId:imageRequirementId,mode,expectedReleaseId:w.releaseId,expectedDraftRevisionId:w.draftHeadRevisionId,expectedBasisHash:w.basisHash,content:content(key),acknowledgement:{confirmed:true,beforeHash:w.rebase.beforeHash,afterHash:w.rebase.afterHash,note:'Same permanent owner and unchanged scope; explicitly reauthor this changed physical definition.'}},{api}));
 const preview=await f.repo.readTransaction(tx=>previewMaterialProduction(tx,{requirementId:imageRequirementId,mode,draftRevisionId:draft.revisionId},{api}));
 const job=await f.repo.writeTransaction(tx=>enqueueMaterialProduction(tx,{requirementId:imageRequirementId,mode,draftRevisionId:draft.revisionId,previewHash:preview.previewHash,requestId:key},{api}));
 return f.repo.writeTransaction(tx=>applyMaterialProductionJob(tx,{jobId:job.jobId,api}));
}

test('compatible ordinary successor may fail without output; remake keeps the actual earlier parent and frozen compatibility history',async t=>{
 const f=await compatibleFixture(t);inspectFixtureMedia(f);await provision(f.repo,'cross:compatible-v002');const failed=await failCurrent(f),w=await workspace(f.repo);
 assert.deepEqual(w.blockers,[]);assert.equal(w.parentVersionId,f.first.candidate.versionId);assert.equal(w.plannedVersionLabel,'V003');assert.equal(w.basis.revision.failedAttempt.definitionId,failed.id);
 await provision(f.repo,'cross:compatible-v003');const input=await frozen(f),result=preserve(input);
 assert.deepEqual(result.recipes,input.baseRecipes);assert.deepEqual(result.snapshot.productionModel.materialProductionPlans,[f.first.plan]);assert.equal(input.baseSnapshot.productionModel.materialProductionRecipeRevisions.at(-1).parentVersionId,f.first.candidate.versionId);
 assert.equal((await f.repo.listMedia()).length,1);
});

test('explicit rebase then compatible scope and failed ordinary successor preserve both independent proof chains and validate archived original rows',async t=>{
 const f=await materialProductionFixture(t);inspectFixtureMedia(f);await provision(f.repo,'cross:rebase-first');const first=await register(f),v=await f.repo.readView(),rep=v.snapshot.productionModel.domainGraph.representations.find(r=>r.id===imageRepresentationId);
 await changeDomain(f.repo,'MATERIAL',[{collection:'representations',id:rep.id,beforeHash:domainHash(rep),value:{...rep,label:'Explicit new physical fixture state'}}]);
 await assert.rejects(workspace(f.repo),{code:'DOMAIN_CONFLICT'});
 const rebased=await explicitRebase(f,'cross:rebase-v002'),second=await register(f),beforeScope=await frozen(f),change=await addScope(f.repo,'after-rebase');
 // Retain a synthetic archived invalidation occurrence as well as requirement
 // links: a historical compatibility receipt must still verify its exact row.
 await f.repo.writeTransaction(async tx=>{const v=await tx.readView(),snapshot=structuredClone(v.snapshot);snapshot.productionModel.domainInvalidations.push({familyId:first.plan.familyId,previousHash:domainHash(change.before.snapshot.productionModel.domainGraph),currentHash:change.after.snapshot.productionModel.assetFamilies.find(row=>row.id===first.plan.familyId).domainContext.hash,versionIds:[second.candidate.versionId]});await tx.publishRelease({snapshot,recipes:v.recipes,expectedReleaseId:v.releaseId,sourceRevisionIds:v.sourceRevisionIds});});change.after=await f.repo.readView();
 const record=await proofFor(f,change,'after-rebase',{includeOccurrences:true});assert.ok(record.occurrences.length);await install(f,record);
 const current=await workspace(f.repo);assert.deepEqual(current.blockers,[]);assert.equal(current.basis.revision.rebaseId,rebased.recipeRevisionId);assert.equal(current.basis.revision.requirementCompatibilities.length,1);assert.equal(current.basis.revision.requirementCompatibilities[0].beforeHash,rebased.requirementHash);
 await provision(f.repo,'cross:after-rebase-compatible-v003');await failCurrent(f);const failed=await workspace(f.repo);assert.deepEqual(failed.blockers,[]);assert.equal(failed.parentVersionId,second.candidate.versionId);assert.equal(failed.plannedVersionLabel,'V004');await provision(f.repo,'cross:after-rebase-compatible-v004');
 const input=await frozen(f),projected=preserve(input);assert.deepEqual(projected.recipes,input.baseRecipes);assert.deepEqual(projected.snapshot.productionModel.materialProductionPlans,[first.plan]);assert.deepEqual(input.baseSnapshot.productionModel.materialProductionRecipeRevisions[0],beforeScope.baseSnapshot.productionModel.materialProductionRecipeRevisions[0]);
 const archive=await f.repo.exportState();validateMaterialProductionRebaseArchive(archive);
 const lostOccurrence=structuredClone(archive),release=lostOccurrence.tables.releases.find(row=>row.release_id===lostOccurrence.tables.repository_meta[0].current_release_id),snapshot=JSON.parse(Buffer.from(release.snapshot_bytes.bytes,'base64'));snapshot.productionModel.domainInvalidations=[];const bytes=Buffer.from(canonicalJson(snapshot));release.snapshot_bytes={encoding:'base64',bytes:bytes.toString('base64')};release.snapshot_sha256=sha256(bytes);
 assert.throws(()=>validateMaterialProductionRebaseArchive(lostOccurrence),{code:'MATERIAL_PRODUCTION_SOURCE_CONFLICT'});
 const missing=structuredClone(input);missing.baseSnapshot.productionModel.domainProductionCompatibilities=[];assert.throws(()=>preserve(missing),{code:'MATERIAL_PRODUCTION_SOURCE_CONFLICT'});
 const foreign=structuredClone(input);foreign.baseSnapshot.instance.instanceId='another-instance';assert.throws(()=>preserve(foreign),{code:'MATERIAL_PRODUCTION_SOURCE_CONFLICT'});
});
