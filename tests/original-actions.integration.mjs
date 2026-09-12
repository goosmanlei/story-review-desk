import assert from 'node:assert/strict';
import { requiredPhase } from '../tools/process-resources.mjs';
const phase=await requiredPhase(process.cwd());
if(!phase)throw Error('Use managed process runner');
const base=process.env.REVIEW_UI_BASE||'http://127.0.0.1:3913';
const get=async path=>{const r=await fetch(base+'/api/v1/'+path);const v=await r.json();assert.equal(r.status,200,JSON.stringify(v));return v;};
const profile=await get('workspaces/profile');
assert.match(profile.instanceId,/^ui-fixture-/,'Never run creative write verification on a production instance');
async function post(path,body,key=crypto.randomUUID()) {
  const r=await fetch(base+'/api/v1/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Review-Runtime':profile.deployment.runtimeEpoch,'Idempotency-Key':key},body:JSON.stringify(body)});
  const value=await r.json();return {status:r.status,value,key};
}
const success=async promise=>{const r=await promise;assert.equal(r.status,200,JSON.stringify(r.value));return r.value;};
const owner='SETTINGS',id='ui-check:'+crypto.randomUUID();
let workspace=await get('workspaces/domain-workspaces?owner='+owner);
const value={id,name:'界面验收临时主体',type:'CHARACTER',description:'隔离接口验收使用',authority:'U',aliases:[],evidence:[]};
const save={action:'save',owner,expectedDraftRevisionId:workspace.draftHeadRevisionId,changes:[{collection:'entities',id,beforeHash:null,value}]};
const key=crypto.randomUUID(),saved=await success(post('workspaces/domain-workspaces',save,key));
const replay=await success(post('workspaces/domain-workspaces',save,key));assert.deepEqual(replay,saved);
assert.equal((await post('workspaces/domain-workspaces',{...save,changes:[]},key)).status,409);
workspace=await get('workspaces/domain-workspaces?owner='+owner);
assert.ok(!workspace.graph.entities.some(e=>e.id===id),'Unconfirmed settings draft must remain distinct');
assert.equal(workspace.draft.changes[0].value.description,value.description);
const preview=await success(post('workspaces/domain-workspaces',{action:'preview',owner,draftRevisionId:saved.revisionId}));
await success(post('workspaces/domain-workspaces',{action:'publish',owner,draftRevisionId:saved.revisionId,previewHash:preview.previewHash}));
workspace=await get('workspaces/domain-workspaces?owner='+owner);
assert.equal(workspace.graph.entities.find(e=>e.id===id).description,value.description);
const stale={action:'save',owner,expectedDraftRevisionId:workspace.draftHeadRevisionId,changes:[{collection:'entities',id,beforeHash:'0'.repeat(64),value:{...value,description:'must not save'}}]};
assert.equal((await post('workspaces/domain-workspaces',stale)).status,409);
console.log('PASS settings draft, preview, confirm, idempotency and stale edit rejection');

const config=await get('workspaces/configuration'),next=structuredClone(config.configuration);
next.presentation.description+=' · 隔离验收';
async function configure(state,configuration) {
  const d=await success(post('workspaces/configuration',{configuration,expectedDraftRevision:state.draft?.revisionId||null,expectedConfigurationRevisionId:state.revisionId,upgradeKeys:[]}));
  const p=await success(post('workspaces/configuration/preview',{draftRevisionId:d.revisionId}));
  await success(post('workspaces/configuration/publish',{draftRevisionId:d.revisionId,previewHash:p.previewHash}));
  return get('workspaces/configuration');
}
const configured=await configure(config,next);assert.equal(configured.configuration.presentation.description,next.presentation.description);
const restored=await configure(configured,config.configuration);assert.deepEqual(restored.configuration,config.configuration);
console.log('PASS original configuration save, preview, publish and lossless round trip');

const plan=(await get('workspaces/views/episode-plan')).plan;
const ep=plan.content.episodes[0];
const comments=await get('workspaces/script-comments?episodeUid='+encodeURIComponent(ep.episodeUid));
const target=comments.targets.find(t=>t.kind==='EPISODE_DESIGN'),block=target.blocks.find(b=>b.text.length>4),commentId='ui-comment:'+crypto.randomUUID();
const create={commentAction:'CREATE',commentId,target,anchor:{blockId:block.id,startOffset:0,endOffset:4,quote:block.text.slice(0,4)},commentText:'隔离 UI 评论验证'};
const comment=await success(post('workspaces/script-comments',create));
let state=await get('workspaces/script-comments?episodeUid='+encodeURIComponent(ep.episodeUid));
assert.ok(state.threads.find(t=>t.commentId===commentId)?.anchorMatchesCurrentText);
const edit={commentAction:'EDIT',commentId,commentRevisionId:comment.commentRevisionId,latestEventId:comment.eventId,commentText:'隔离 UI 评论修改验证'};
const edited=await success(post('workspaces/script-comments',edit));
assert.equal((await post('workspaces/script-comments',{...edit,commentText:'过期修改'})).status,409);
await success(post('workspaces/script-comments',{commentAction:'RESOLVE_USER',commentId,commentRevisionId:edited.commentRevisionId,latestEventId:edited.eventId}));
state=await get('workspaces/script-comments?episodeUid='+encodeURIComponent(ep.episodeUid));assert.ok(!state.threads.some(t=>t.commentId===commentId));
const wrong={...create,commentId:'ui-comment:'+crypto.randomUUID(),anchor:{...create.anchor,startOffset:1,endOffset:5}};
assert.equal((await post('workspaces/script-comments',wrong)).status,409);
console.log('PASS anchored episode comment, edit, close, CAS and exact offset validation');

const preparation=await get('workspaces/production-preparation');
assert.ok(preparation.materialLinks.scenes.some(s=>s.references.length>0),'Exact scene material occurrences must be restored');
assert.equal(preparation.materialLinks.projectionPolicy,'PER_OCCURRENCE_V2');
const unchangedPlan=(await get('workspaces/views/episode-plan')).plan;assert.equal(unchangedPlan.contentHash,plan.contentHash,'Comments and configuration must not change narrative content hash');
console.log('PASS exact material occurrences and stable authored plan identity');
