import assert from 'node:assert/strict';
import {requiredPhase} from '../tools/process-resources.mjs';
assert.ok(await requiredPhase(process.cwd()),'Use managed runner');
const base=(process.env.REVIEW_UI_BASE||'http://127.0.0.1:3913')+'/api/v1/';
const profile=await fetch(base+'workspaces/profile').then(r=>r.json());assert.match(profile.instanceId,/^ui-fixture-/);
async function get(path){const response=await fetch(base+path),value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;}
async function post(input,key=crypto.randomUUID()){const response=await fetch(base+'workspaces/material-production',{method:'POST',headers:{'Content-Type':'application/json','X-Review-Runtime':profile.deployment.runtimeEpoch,'Idempotency-Key':key},body:JSON.stringify(input)});return {status:response.status,value:await response.json()};}
const catalog=(await get('workspaces/views/materials')).page;let requirementId,state;
for(const requirement of catalog.materialRequirements.filter(r=>(r.mediaType==='IMAGE'||r.mediaKind==='IMAGE'))){const candidate=await get('workspaces/material-production?requirementId='+encodeURIComponent(requirement.id));if(candidate.parentVersionId&&candidate.defaults&&!candidate.blockers.length){requirementId=requirement.id;state=candidate;break;}}
assert.ok(state,'Fixture needs an adopted image with editable production settings');
const parent=await get('objects/'+encodeURIComponent(state.parentVersionId)),content={...state.defaults,prompt:state.defaults.prompt+'\n仅隔离测试制作资料保存，不调用模型。'};
const save={action:'save',requirementId,expectedReleaseId:state.releaseId,expectedBasisHash:state.basisHash,expectedDraftRevisionId:state.draftHeadRevisionId,content},key=crypto.randomUUID();
let response=await post(save,key);assert.equal(response.status,200,JSON.stringify(response.value));assert.equal((await post(save,key)).status,200);assert.equal((await post(save)).status,409);
state=await get('workspaces/material-production?requirementId='+requirementId);assert.equal(state.draft.content.prompt,content.prompt);
response=await post({action:'preview',requirementId,draftRevisionId:state.draft.revisionId});assert.equal(response.status,200,JSON.stringify(response.value));
const preview=response.value;
response=await post({action:'publish',requirementId,draftRevisionId:state.draft.revisionId,previewHash:preview.previewHash});assert.equal(response.status,200,JSON.stringify(response.value));assert.equal(response.value.modelCalls,0);assert.equal(response.value.generationAuthorized,false);
const call=await get('objects/'+encodeURIComponent(response.value.callId));assert.equal(call.state,'DRAFT');assert.equal(call.revision.content.prompt,content.prompt);assert.equal((await get('objects/'+encodeURIComponent(parent.id))).version,parent.version);
const fresh=await get('workspaces/material-production?requirementId='+requirementId);assert.equal(fresh.currentDefinitionId,call.id);assert.equal(fresh.draft,null);assert.equal(fresh.defaults.prompt,content.prompt);
console.log('PASS original material setup, complete prompt, preview, exact call draft, concurrency and untouched original artifact');
