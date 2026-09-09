import test from 'node:test';
import assert from 'node:assert/strict';
import {domainProductionProofs} from '../host/instance-runtime/domain-production-lineage.mjs';
import {fixture} from './domain-new-production-fixture.mjs';
function make(executor='CODEX'){
 const f=fixture(),c=f.produce('generated-without-media-input',[],{executor,review:false}),versions=new Map([[c.versionId,{familyId:c.familyId,sha256:c.sha256,path:c.path,inputVersionBindings:[]}]]);
 const params=()=>({candidates:f.candidates,requests:f.requests,runs:f.runs,versions});return{f,c,params};
}
for(const executor of ['CODEX','USER_EXTERNAL'])test('inputless '+executor+' complete historical proof is opt-in, not the default new-descendant exemption',()=>{
 const {c,params}=make(executor);assert.equal(domainProductionProofs(params()).size,0);
 const proof=domainProductionProofs({...params(),allowInputless:true}).get(c.versionId);assert.ok(proof);assert.deepEqual(proof.inputs,[]);
 for(const value of [false,1,'true',null])assert.equal(domainProductionProofs({...params(),allowInputless:value}).size,0);
});
for(const [name,mutate] of [
 ['absent authorization',({f})=>{f.requests.shift();}],
 ['absent CODEX claim',({f})=>{f.requests.pop();}],
 ['claim epoch mismatch',({c})=>{c.claim.authorizationRuntime.runtimeEpoch='other';}],
 ['missing exact empty input hash',({c})=>{delete c.candidate.inputBindingsHash;}],
 ['nonempty input mismatch',({c})=>{c.candidate.inputBindings=[{order:1,path:'media/other.png',assetFamilyRef:'other',assetVersionRef:'other@V1',sha256:'a'.repeat(64)}];}],
 ['unknown Run result',({c})=>{c.success.runState=c.success.state='RESULT_UNKNOWN';}],
 ['missing SUBMITTED',({f})=>{f.runs.shift();}],
 ['changed execution hash',({c})=>{c.success.executionDefinitionHash='a'.repeat(64);}],
 ['ambiguous candidate',({f,c})=>{f.candidates.push({...c.candidate,eventId:'duplicate',eventSequence:30});}],
 ['different candidate bytes',({c})=>{c.candidate.sha256='0'.repeat(64);}],
 ['missing sequence',({c})=>{delete c.auth.eventSequence;}],
])test('inputless audit still rejects '+name,()=>{const f=make();mutate(f);assert.equal(domainProductionProofs({...f.params(),allowInputless:true}).size,0);});
