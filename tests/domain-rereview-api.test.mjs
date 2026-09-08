import test from 'node:test';
import assert from 'node:assert/strict';
import {apiFixture,pngs} from './fixtures/material-native-revision-api.mjs';
import {changeDomain,imageRequirementId} from './material-production-fixture.mjs';
import {domainHash} from '../host/instance-runtime/domain-model.mjs';
import {getMaterialProductionWorkspace,applyMaterialProductionJob} from '../host/instance-runtime/material-production-service.mjs';

test('real domain publish and same-byte ASSET re-review restore only the current exact context',{skip:process.env.REVIEW_TEST_POSTGRES!=='1',timeout:180000},async t=>{
 const f=await apiFixture(t),first=await f.provision(await f.workspace(),'Fixed fixture; no generation.'),run=await f.beginRun(first),candidate=await f.register(first,run,pngs[0]);
 const oldReview=await f.review(first,candidate,'APPROVE_AND_RELEASE'),oldView=await f.repo.readView();
 const familyId=first.result.familyId,versionId=candidate.versionId;
 const context=await f.store.reviewData(),oldContext=f.store.assetReviewContextHash(context,familyId,versionId,candidate.sha256);
 const family=context.productionModel.assetFamilies.find(row=>row.id===familyId),oldDomain=family.domainContext.hash;
 const oldRequirements=structuredClone(context.productionModel.materialRequirements.map(r=>[r.id,r.requirementHash]).sort());
 const entity=oldView.snapshot.productionModel.domainGraph.entities.find(row=>row.id==='character:letter-writer');
 await changeDomain(f.repo,'SETTINGS',[{collection:'entities',id:entity.id,beforeHash:domainHash(entity),value:{...entity,description:'Revised fixture identity condition; same media requires a new exact review.'}}]);
 const changed=await f.store.reviewData(),view=await f.repo.readView(),invalidations=structuredClone(changed.productionModel.domainInvalidations);
 assert.deepEqual(changed.productionModel.materialRequirements.map(r=>[r.id,r.requirementHash]).sort(),oldRequirements,'entity-only changes need domain binding even when requirement hashes are unchanged');
 assert.ok(invalidations.some(row=>row.familyId===familyId&&row.versionIds.includes(versionId)));
 assert.notEqual(changed.productionModel.assetFamilies.find(row=>row.id===familyId).domainContext.hash,oldDomain);
 const newContext=f.store.assetReviewContextHash(changed,familyId,versionId,candidate.sha256);assert.notEqual(newContext,oldContext);
 const projection=(data,reviews)=>f.store.projectOperationalState(data,reviews,view.eventsByKind['asset-version']||[],view.eventsByKind.run||[],view.eventsByKind['source-operation']||[],view.eventsByKind['execution-request']||[]).assetVersionsById[versionId];
 assert.ok(projection(changed,view.eventsByKind.review).flowBlockReasons.includes('DOMAIN_RELATION_INPUT_CHANGED'));
 const approved=await f.review(first,candidate,'APPROVE_AND_RELEASE'),final=await f.repo.readView();
 assert.equal(approved.contextHash,newContext);assert.equal(approved.versionSha256,candidate.sha256);
 const active=projection(changed,final.eventsByKind.review);assert.equal(active.canFlowDownstream,true);assert.equal(active.lifecycleState,'RELEASED');assert.ok(!active.flowBlockReasons.includes('DOMAIN_RELATION_INPUT_CHANGED'));
 assert.deepEqual(final.snapshot.productionModel.domainInvalidations,invalidations,'no historical invalidation removed');
 assert.deepEqual(final.eventsByKind.review.find(r=>r.eventId===oldReview.eventId),oldReview);
 assert.deepEqual(final.eventsByKind['asset-version'],view.eventsByKind['asset-version']);
 assert.deepEqual(final.eventsByKind.run,view.eventsByKind.run);assert.deepEqual(final.recipes,view.recipes);
 for(const [name,mutate]of [
  ['old context',r=>{r.contextHash=oldContext;}],['wrong SHA',r=>{r.versionSha256='0'.repeat(64);}],['wrong family',r=>{r.familyId='other';}],
  ['not applied',r=>{r.effect='IGNORED';}],['invalid rights attestation',r=>{r.rightsUnknownConfirmation=null;}],
  ['source sync still pending',r=>{r.canFlowDownstream=false;r.internalDownstreamEligibility='INELIGIBLE_PENDING_PROMPT_SYNC';r.sourceSyncRequired=true;r.sourceSyncState='PENDING';}],
  ['unverified supersession',r=>{r.reviewEventRole='SUPERSEDING_CORRECTION';r.supersedesReviewEventId='missing';}],
 ]){const altered=structuredClone(approved);mutate(altered);assert.equal(projection(changed,[oldReview,altered]).canFlowDownstream,false,name);}
 const duplicate={...approved,eventId:'unverified-extra-head',eventSequence:approved.eventSequence+1};
 assert.equal(projection(changed,[...final.eventsByKind.review,duplicate]).canFlowDownstream,false,'ambiguous effective review chain cannot clear a domain invalidation');
 const later=structuredClone(changed),laterFamily=later.productionModel.assetFamilies.find(r=>r.id===familyId),prior=laterFamily.domainContext.hash;laterFamily.domainContext.hash='e'.repeat(64);
 later.productionModel.domainInvalidations.push({familyId,previousHash:prior,currentHash:laterFamily.domainContext.hash,versionIds:[versionId]});
 assert.equal(projection(later,final.eventsByKind.review).canFlowDownstream,false,'a later domain change invalidates the re-review');
 later.productionModel.domainInvalidations.push({familyId,previousHash:laterFamily.domainContext.hash,currentHash:prior,versionIds:[versionId]});laterFamily.domainContext.hash=prior;
 assert.equal(projection(later,final.eventsByKind.review).canFlowDownstream,false,'returning to the same domain hash cannot resurrect an earlier review');
 const rights=structuredClone(changed),candidateEvents=structuredClone(view.eventsByKind['asset-version']);candidateEvents.find(r=>r.versionId===versionId).projectRightsGate='BLOCKED';
 const rightsState=f.store.projectOperationalState(rights,final.eventsByKind.review,candidateEvents,view.eventsByKind.run||[]).assetVersionsById[versionId];assert.equal(rightsState.canFlowDownstream,false);assert.equal(rightsState.lifecycleState,'RIGHTS_HOLD');assert.ok(rightsState.flowBlockReasons.includes('CURRENT_RIGHTS_BLOCKED'));
 for(const action of ['REQUEST_REVISION','DO_NOT_USE']){
  const decision=action==='REQUEST_REVISION'?'REVISION_REQUIRED':'DO_NOT_USE';
  const correction={...approved,eventId:'fixture-later-decision',eventSequence:approved.eventSequence+1,reviewEventRole:'SUPERSEDING_CORRECTION',supersedesReviewEventId:approved.eventId,action,reviewDecision:decision,lifecycleState:decision,canFlowDownstream:false,internalDownstreamEligibility:'INELIGIBLE',adoptionIntent:'DO_NOT_ADOPT',appliedProjectRightsGate:approved.projectRightsGateAtReview,rightsUnknownConfirmation:null};
  const refused=projection(changed,[...final.eventsByKind.review,correction]);assert.equal(refused.canFlowDownstream,false,action);assert.equal(refused.lifecycleState,decision);
 }
 assert.equal(f.externalCalls(),0);
});

test('real PostgreSQL DOMAIN publisher records repeated A-B-A cycles without reviving earlier approvals',{skip:process.env.REVIEW_TEST_POSTGRES!=='1',timeout:180000},async t=>{
 const f=await apiFixture(t),first=await f.provision(await f.workspace(),'Cycle fixture, no provider.'),candidate=await f.register(first,await f.beginRun(first),pngs[0]);
 const initial=await f.repo.readView(),entity=initial.snapshot.productionModel.domainGraph.entities.find(r=>r.id==='character:letter-writer'),history=[];
 await f.review(first,candidate,'APPROVE_AND_RELEASE');
 for(const label of ['B','A','B','A']){
  const before=await f.repo.readView(),current=before.snapshot.productionModel.domainGraph.entities.find(r=>r.id===entity.id),priorRows=structuredClone(before.snapshot.productionModel.domainInvalidations);
  await changeDomain(f.repo,'SETTINGS',[{collection:'entities',id:entity.id,beforeHash:domainHash(current),value:{...entity,description:label==='A'?entity.description:'Condition B, fixture only.'}}]);
  const view=await f.repo.readView(),data=await f.store.reviewData(),rows=view.snapshot.productionModel.domainInvalidations;
  assert.equal(rows.length,history.length+1);assert.deepEqual(rows.slice(0,-1),priorRows);
  const family=data.productionModel.assetFamilies.find(r=>r.id===first.result.familyId),ctx=f.store.assetReviewContextHash(data,family.id,candidate.versionId,candidate.sha256);
  assert.equal(rows.at(-1).currentHash,family.domainContext.hash);
  const blocked=await f.store.operationalSnapshot();assert.equal(blocked.stateProjection.assetVersionsById[candidate.versionId].canFlowDownstream,false,'transition '+String(history.length+1)+' requires a fresh review');
  const approved=await f.review(first,candidate,'APPROVE_AND_RELEASE');assert.equal(approved.contextHash,ctx);
  const restored=await f.store.operationalSnapshot();assert.equal(restored.stateProjection.assetVersionsById[candidate.versionId].canFlowDownstream,true,'each new B and A review can restore its root');
  history.push({domainHash:family.domainContext.hash,contextHash:ctx,review:approved});
 }
 assert.equal(history[0].domainHash,history[2].domainHash);assert.equal(history[1].domainHash,history[3].domainHash);
 assert.notEqual(history[0].contextHash,history[2].contextHash);assert.notEqual(history[1].contextHash,history[3].contextHash);
 const final=await f.repo.readView();for(const row of history)assert.deepEqual(final.eventsByKind.review.find(r=>r.eventId===row.review.eventId),row.review);
 assert.deepEqual(final.eventsByKind['asset-version'],initial.eventsByKind['asset-version']);assert.deepEqual(final.eventsByKind.run,initial.eventsByKind.run);assert.equal(f.externalCalls(),0);
});

async function provisionRequirement(f,requirementId,inputBindings){
 const w=await f.repo.readTransaction(tx=>getMaterialProductionWorkspace(tx,{requirementId,api:f.adapter}));
 const saved=await f.materialPost({...f.saveBody(w,'Fixed child PNG fixture; no provider.',{inputBindings}),requirementId});assert.equal(saved.status,200,JSON.stringify(saved.body));
 const preview=await f.materialPost({requirementId,action:'preview',draftRevisionId:saved.body.revisionId});assert.equal(preview.status,200,JSON.stringify(preview.body));
 const queued=await f.materialPost({requirementId,action:'publish',draftRevisionId:saved.body.revisionId,previewHash:preview.body.previewHash});assert.equal(queued.status,200,JSON.stringify(queued.body));
 const result=await f.repo.writeTransaction(tx=>applyMaterialProductionJob(tx,{jobId:queued.body.jobId,api:f.adapter})),view=await f.repo.readView();
 return{result,recipe:view.recipes.executionDefinitions.find(r=>r.id===result.definitionId),plan:preview.body.plan,view};
}
async function approveRequirement(f,p,candidate,requirementId,{expectedStatus=201}={}){
 const data=await f.store.reviewData(),spec=data.productionModel.materialRequirements.find(r=>r.id===requirementId).reviewSpec;
 const result=await f.post(f.reviews,'v8/reviews',{schemaVersion:'2.2',subjectType:'ASSET',subjectId:p.result.familyId,familyId:p.result.familyId,versionId:candidate.versionId,versionSha256:candidate.sha256,contextHash:f.store.assetReviewContextHash(data,p.result.familyId,candidate.versionId,candidate.sha256),reviewSpecHash:spec.hash,action:'APPROVE_AND_RELEASE',criterionFindings:spec.criteria.map(c=>({criterionId:c.id,verdict:'PASS',note:'Synthetic local fixture protocol check; no artistic observation claimed.'})),revisionInstructions:null,rightsUnknownConfirmation:{confirmed:true,scope:'PROJECT_INTERNAL_ONLY',basis:'Test-authored fixture PNG; no production or commercial approval.'},note:'Isolated formal review protocol test.'});
 assert.equal(result.status,expectedStatus,JSON.stringify(result.body));return expectedStatus===201?result.body.event:result.body;
}
test('real recorded child retains its ancestor invalidation under the API guard and an in-memory reviewed-parent projection',{skip:process.env.REVIEW_TEST_POSTGRES!=='1',timeout:180000},async t=>{
 const f=await apiFixture(t),parent=await f.provision(await f.workspace(),'Parent fixture, no provider.'),parentVersion=await f.register(parent,await f.beginRun(parent),pngs[0]);const originalParentReview=await f.review(parent,parentVersion,'APPROVE_AND_RELEASE');
 const entity={id:'style:derived-fixture',type:'STYLE',name:'Derived palette fixture',aliases:[],description:'Original child style condition',authority:'A',evidence:[]};
 await changeDomain(f.repo,'SETTINGS',[{collection:'entities',id:entity.id,beforeHash:null,value:entity}]);
 const requirementId='demand:derived-fixture',representation={id:'representation:derived-fixture',entityId:entity.id,stateId:null,type:'STYLE_ANCHOR',label:'Palette derived from the parent fixture',dimensions:{},assetFamilyIds:[],requirementIds:[requirementId],authority:'A',evidence:[]},demand={id:requirementId,title:'Derived style fixture',representationId:representation.id,mediaType:'IMAGE',category:'风格锚点',reuseScope:'PROJECT',scope:[],evidence:[],acceptanceCriteria:['The frozen fixture input and output can be verified.']};
 await changeDomain(f.repo,'MATERIAL',[{collection:'representations',id:representation.id,beforeHash:null,value:representation},{collection:'requirements',id:requirementId,beforeHash:null,value:demand}]);
 const child=await provisionRequirement(f,requirementId,[{familyId:parent.result.familyId,versionId:parentVersion.versionId,sha256:parentVersion.sha256}]);
 const childVersion=await f.register(child,await f.beginRun(child),pngs[1]);await approveRequirement(f,child,childVersion,requirementId);
 const beforeChange=await f.repo.readView(),currentChild=beforeChange.snapshot.productionModel.domainGraph.entities.find(r=>r.id===entity.id);
 await changeDomain(f.repo,'SETTINGS',[{collection:'entities',id:entity.id,beforeHash:domainHash(currentChild),value:{...currentChild,description:'New child condition; exact re-review required.'}}]);
 const childReview=await approveRequirement(f,child,childVersion,requirementId);assert.equal((await f.store.operationalSnapshot()).stateProjection.assetVersionsById[childVersion.versionId].canFlowDownstream,true);
 const beforeParent=await f.repo.readView(),parentEntity=beforeParent.snapshot.productionModel.domainGraph.entities.find(r=>r.id==='character:letter-writer');
 await changeDomain(f.repo,'SETTINGS',[{collection:'entities',id:parentEntity.id,beforeHash:domainHash(parentEntity),value:{...parentEntity,description:'Parent-only production condition changed.'}}]);
 const changed=await f.store.reviewData();assert.equal(f.store.assetReviewContextHash(changed,child.result.familyId,childVersion.versionId,childVersion.sha256),childReview.contextHash,'child own old context has not changed; it cannot prove the later parent change');
 const beforeRejected=await f.repo.exportState(),rejected=await approveRequirement(f,parent,parentVersion,imageRequirementId,{expectedStatus:409});assert.equal(rejected.reasonCode,'REVIEW_INITIAL_DECISION_LOCKED');assert.deepEqual(await f.repo.exportState(),beforeRejected,'existing downstream-consumption review guard is not relaxed');
 // The current API correctly refuses to change a consumed decision. Exercise
 // imported/event-projection defense without bypassing that guard or writing
 // a synthetic approval to PostgreSQL: only this one counterfactual is in memory.
 const actual=await f.repo.readView(),parentContext=f.store.assetReviewContextHash(changed,parent.result.familyId,parentVersion.versionId,parentVersion.sha256);
 const parentReview={...originalParentReview,eventId:'fixture-memory-only-parent-reapproval',eventSequence:Math.max(...Object.values(actual.eventsByKind).flat().map(e=>e.eventSequence||0))+1,snapshotId:changed.snapshotId,creationSnapshotId:changed.snapshotId,contextHash:parentContext,businessContextHash:parentContext};
 const state=f.store.projectOperationalState(changed,[...actual.eventsByKind.review,parentReview],actual.eventsByKind['asset-version'],actual.eventsByKind.run,actual.eventsByKind['source-operation']||[],actual.eventsByKind['execution-request']);
 assert.equal(state.assetVersionsById[parentVersion.versionId].canFlowDownstream,true);assert.equal(state.assetVersionsById[childVersion.versionId].canFlowDownstream,false);assert.ok(state.assetVersionsById[childVersion.versionId].flowBlockReasons.includes('DOMAIN_RELATION_INPUT_CHANGED'));
 const final=await f.repo.readView(),rows=final.snapshot.productionModel.domainInvalidations;
 assert.deepEqual(rows.map(r=>r.familyId),[child.result.familyId,parent.result.familyId]);assert.deepEqual(rows[0].versionIds,[childVersion.versionId]);assert.deepEqual(rows[1].versionIds,[parentVersion.versionId]);
 assert.deepEqual(final.eventsByKind.review.filter(r=>r.familyId===child.result.familyId),beforeParent.eventsByKind.review.filter(r=>r.familyId===child.result.familyId));
 assert.ok(!final.eventsByKind.review.some(r=>r.eventId===parentReview.eventId),'counterfactual review is never persisted');assert.deepEqual(final.eventsByKind['asset-version'],beforeParent.eventsByKind['asset-version']);assert.deepEqual(final.eventsByKind.run,beforeParent.eventsByKind.run);assert.deepEqual(final.recipes,beforeParent.recipes);assert.equal(f.externalCalls(),0);
});
