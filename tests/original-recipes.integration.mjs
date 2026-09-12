import assert from 'node:assert/strict';
import {requiredPhase} from '../tools/process-resources.mjs';
assert.ok(await requiredPhase(process.cwd()));
const base=(process.env.REVIEW_UI_BASE||'http://127.0.0.1:3913')+'/api/v1/';
async function get(p){const r=await fetch(base+p),v=await r.json();assert.equal(r.status,200,JSON.stringify(v));return v;}
const profile=await get('workspaces/profile');assert.match(profile.instanceId,/^ui-fixture-/);
async function post(p,b,key=crypto.randomUUID()){const r=await fetch(base+p,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key,'X-Review-Runtime':profile.deployment.runtimeEpoch},body:JSON.stringify(b)});return {status:r.status,value:await r.json()};}
const catalogue=await get('workspaces/views/production'),work=catalogue.page.workItems.find(w=>w.deliverableKey==='STORYBOARD');assert.ok(work);
const route='workspaces/shot-production/recipes',read=()=>get(route+'?workItemId='+encodeURIComponent(work.id));
let state=await read();assert.deepEqual(state.blockers,[]);
const content={model:'mock-only',prompt:'仅隔离验证调用包保存。',negativePrompt:'',parameters:{test:true}},save={action:'save',workItemId:work.id,expectedReleaseId:state.releaseId,expectedDraftRevisionId:state.draftHeadRevisionId,content},key=crypto.randomUUID();
let response=await post(route,save,key);assert.equal(response.status,200,JSON.stringify(response));assert.equal((await post(route,save,key)).status,200);assert.equal((await post(route,save)).status,409);
state=await read();assert.deepEqual(state.draft.content,content);const preview=await post(route,{action:'preview',workItemId:work.id,draftRevisionId:state.draft.revisionId});assert.equal(preview.status,200,JSON.stringify(preview));
response=await post(route,{action:'publish',workItemId:work.id,draftRevisionId:state.draft.revisionId,previewHash:preview.value.previewHash});assert.equal(response.status,200,JSON.stringify(response));assert.equal(response.value.modelCalls,0);
const call=await get('objects/'+encodeURIComponent(response.value.callId));assert.equal(call.state,'DRAFT');assert.equal(call.revision.content.authorContent.prompt,content.prompt);assert.ok(call.dependencies.some(d=>d.purpose==='DEFINITION'));assert.equal((await read()).draft,null);
console.log('PASS original shot recipe save, replay, conflict, preview, exact inputs and draft definition without generation');
const history=await get('workspaces/story-history');assert.ok(history.items.length>=10);
for(const item of history.items){const p=(await get('workspaces/views/episode-plan?archive=1&revisionId='+encodeURIComponent(item.revisionId))).plan;assert.equal(p.revisionId,item.revisionId);assert.equal(p.archived,true);assert.equal(p.readOnly,true);assert.ok(p.content.episodes.length);assert.equal(p.originalEvent.sha256,item.sha256);await get('workspaces/episode-plan-reviews?archive=1&subjectRevisionId='+encodeURIComponent(item.revisionId));if(p.content.narrativeRevision?.scenes?.length)await get('workspaces/views/scene-review-context?archive=1&revisionId='+encodeURIComponent(item.revisionId)+'&sceneId='+encodeURIComponent(p.content.narrativeRevision.scenes[0].id));}
console.log('PASS every original plan remains separately readable with exact revision, SHA and historical read-only binding');
