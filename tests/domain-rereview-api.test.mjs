import test from 'node:test';
import assert from 'node:assert/strict';
import {apiFixture,pngs} from './fixtures/material-native-revision-api.mjs';
import {changeDomain} from './material-production-fixture.mjs';
import {domainHash} from '../host/instance-runtime/domain-model.mjs';

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
