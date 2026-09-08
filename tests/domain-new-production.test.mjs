import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,h,api} from './domain-new-production-fixture.mjs';
import {productionBindingReasons} from '../host/instance-runtime/shot-production-model.mjs';
const isHeld=(state,v)=>state.assetVersionsById[v.versionId]?.flowBlockReasons.includes('DOMAIN_RELATION_INPUT_CHANGED');
const context=()=>{const f=fixture(),r=f.addRoot();return {f,r};};
for(const executor of ['CODEX','USER_EXTERNAL'])test('actual projection accepts only a fully new '+executor+' producer after the exact root re-review',()=>{
 const {f,r}=context(),before=f.project();assert.equal(before.assetVersionsById[r.versionId].canFlowDownstream,true);assert.deepEqual(productionBindingReasons(f.data.productionModel,before,r),[]);
 const child=f.produce('child',[r],{executor}),frozen=JSON.stringify(f),state=f.project();assert.equal(state.assetVersionsById[child.versionId].canFlowDownstream,true);assert.equal(isHeld(state,child),false);assert.equal(JSON.stringify(f),frozen);
});
test('fresh candidate remains REVIEW_PENDING until its own actual review',()=>{const {f,r}=context(),child=f.produce('child',[r],{review:false}),state=f.project();assert.equal(isHeld(state,child),false);assert.equal(state.assetVersionsById[child.versionId].canFlowDownstream,false);assert.equal(state.assetVersionsById[child.versionId].lifecycleState,'REVIEW_PENDING');});
for(const [name,mutate]of [
 ['old authorization even with late registration',({c})=>{c.auth.eventSequence=5;}],
 ['old claim',({c})=>{c.claim.eventSequence=9;}],
 ['old submitted event',({c})=>{c.submitted.eventSequence=9;}],
 ['missing AUTHORIZE',({f})=>{f.requests.shift();}],
 ['missing CLAIM for CODEX',({f})=>{f.requests.splice(1,1);}],
 ['missing SUBMITTED',({f})=>{f.runs.shift();}],
 ['missing authorizationRuntime',({c})=>{delete c.auth.authorizationRuntime;delete c.claim.authorizationRuntime;}],
 ['changed claim epoch',({c})=>{c.claim.authorizationRuntime.runtimeEpoch='different';}],
 ['changed claim instance',({c})=>{c.claim.authorizationRuntime.instanceId='another';}],
 ['changed claim maxOutputs',({c})=>{c.claim.maxOutputs=2;}],
 ['changed AUTHORIZE family',({c})=>{c.auth.familyId='other';}],
 ['changed request definition hash',({c})=>{c.claim.callPackageHash=h('wrong');}],
 ['changed run definition hash',({c})=>{c.success.callPackageHash=h('wrong');}],
 ['changed input binding hash',({c})=>{c.success.inputBindingsHash=h('wrong');}],
 ['changed authorized inputs',({c})=>{c.auth.inputBindings[0].sha256=h('wrong');}],
 ['changed candidate input family',({c})=>{c.candidate.inputBindings[0].assetFamilyRef='other';}],
 ['candidate from another snapshot',({c})=>{c.candidate.snapshotId='snapshot:other';}],
 ['ambiguous same-version candidates',({f,c})=>{f.candidates.push({...c.candidate,eventId:'candidate:duplicate',eventSequence:19});}],
 ['missing positive event sequence',({c})=>{delete c.auth.eventSequence;}],
 ['duplicate event sequence',({c})=>{c.claim.eventSequence=c.auth.eventSequence;}],
 ['unknown result',({c})=>{c.success.runState=c.success.state='RESULT_UNKNOWN';}],
 ['unreconciled UNKNOWN to success',({f,c})=>{c.success.eventSequence=15;c.candidate.eventSequence=16;c.review.eventSequence=17;f.runs.splice(1,0,{...c.submitted,eventId:'unknown',eventSequence:14,runState:'RESULT_UNKNOWN',state:'RESULT_UNKNOWN'});}],
 ['success without a submitted run',({c})=>{c.submitted.runState=c.submitted.state='PLANNED';}],
 ['second unresolved run on request',({f,c})=>{f.runs.push({...c.submitted,eventId:'other-run',eventSequence:14,runId:'another-run',runState:'RESULT_UNKNOWN',state:'RESULT_UNKNOWN'});}],
 ['historical child without producer events',({f})=>{f.requests=[];f.runs=[];}],
])test('new descendant exemption refuses '+name,()=>{const {f,r}=context(),c=f.produce('child',[r]);mutate({f,r,c});assert.equal(isHeld(f.project(),c),true);});
test('a pre-existing child stays held after root recovery despite a new child review',()=>{const {f,r}=context(),c=f.produce('old-child',[r],{start:1,review:false});f.review(c,30);assert.equal(isHeld(f.project(),c),true);});
test('new grandchild requires both its full fresh chain and the newly produced parent own Review',()=>{const {f,r}=context(),c=f.produce('child',[r]),g=f.produce('grandchild',[c],{start:30});const state=f.project();assert.equal(isHeld(state,c),false);assert.equal(isHeld(state,g),false);assert.equal(state.assetVersionsById[g.versionId].canFlowDownstream,true);c.review.eventSequence=14;assert.equal(isHeld(f.project(),g),true);});
test('multi-parent output requires every invalidated parent exact fresh review',()=>{const {f,r}=context(),s=f.addRoot('second',20),c=f.produce('multi',[r,s],{start:21});assert.equal(isHeld(f.project(),c),false);s.review.eventSequence=40;assert.equal(isHeld(f.project(),c),true);});
test('a legacy review with no sequence may recover its root but cannot prove a new multi-parent exemption',()=>{const {f,r}=context(),s=f.addRoot('second',20),c=f.produce('multi',[r,s],{start:21});delete s.review.eventSequence;const state=f.project();assert.equal(state.assetVersionsById[s.versionId].canFlowDownstream,true);assert.equal(isHeld(state,c),true);});
test('a direct historical invalidation on the child cannot be erased by new root evidence',()=>{const {f,r}=context(),c=f.produce('child',[r]);const family=f.data.productionModel.assetFamilies.find(x=>x.id===c.familyId);f.data.productionModel.domainInvalidations.unshift({familyId:c.familyId,previousHash:h('old-child'),currentHash:family.domainContext.hash,versionIds:[c.versionId]});c.review.contextHash=api.assetReviewContextHash(f.data,c.familyId,c.versionId,c.sha256);assert.equal(isHeld(f.project(),c),true);});
test('cycle and wrong-family edges are never fresh-production exemptions',()=>{const {f,r}=context(),c=f.produce('child',[r]);const root=f.data.productionModel.assetVersions[0];root.inputVersionBindings=[{familyId:c.familyId,versionId:c.versionId,sha256:c.sha256}];assert.equal(isHeld(f.project(),c),true);});
test('same-hash A-B-A occurrence still requires a later root review and new execution',()=>{const {f,r}=context(),c=f.produce('old-child',[r]);const history=f.data.productionModel.domainInvalidations,oldHash=history[0].currentHash;history.push({familyId:r.familyId,previousHash:oldHash,currentHash:h('intermediate'),versionIds:[r.versionId]},{familyId:r.familyId,previousHash:h('intermediate'),currentHash:oldHash,versionIds:[r.versionId]});assert.equal(f.project().assetVersionsById[r.versionId].canFlowDownstream,false);f.reviews=[];r.review=f.review(r,50);assert.equal(isHeld(f.project(),c),true);const fresh=f.produce('fresh-child',[r],{start:51});assert.equal(isHeld(f.project(),fresh),false);});
test('resolved UNKNOWN uses the same Run and explicit reconciliation, never a second attempt',()=>{const {f,r}=context(),c=f.produce('child',[r]);c.success.eventSequence=15;c.candidate.eventSequence=16;c.review.eventSequence=17;f.runs.splice(1,0,{...c.submitted,eventId:'unknown',eventSequence:14,runState:'RESULT_UNKNOWN',state:'RESULT_UNKNOWN'});c.success.reconciliationEvidence={requestId:c.auth.executionRequestId,logId:'fixed-response-proof',providerStatusCheckedAt:'2026-09-08T01:00:00Z',providerConclusion:'SUCCEEDED'};assert.equal(isHeld(f.project(),c),false);c.success.reconciliationEvidence.requestId='wrong-request';assert.equal(isHeld(f.project(),c),true);});
test('USER_EXTERNAL cannot acquire a fabricated claim branch',()=>{const {f,r}=context(),c=f.produce('child',[r],{executor:'USER_EXTERNAL'});f.requests.push({...c.auth,eventId:'fabricated-claim',eventSequence:12,action:'CLAIM',requestState:'CLAIMED',status:'CLAIMED'});assert.equal(isHeld(f.project(),c),true);});
