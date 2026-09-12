import assert from 'node:assert/strict';
import {requiredPhase} from '../tools/process-resources.mjs';
import {database,closeDatabase} from '../server/db.mjs';
import {workOnce} from '../server/jobs.mjs';
import {hash} from '../server/shared/contracts.mjs';
assert.ok(await requiredPhase(process.cwd()),'Use managed process runner');
const base=(process.env.REVIEW_UI_BASE||'http://127.0.0.1:3913')+'/api/v1/';
async function get(p){const r=await fetch(base+p),v=await r.json();assert.equal(r.status,200,JSON.stringify(v));return v;}
const profile=await get('workspaces/profile');assert.match(profile.instanceId,/^ui-fixture-/);
const epoch=profile.deployment.runtimeEpoch;
async function post(path,body,key=crypto.randomUUID()){const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Review-Runtime':epoch,'Idempotency-Key':key},body:JSON.stringify(body)});return {status:r.status,value:await r.json()};}
async function ok(p){const r=await p;assert.equal(r.status,200,JSON.stringify(r.value));return r.value;}
const pool=await database();assert.equal((await pool.query('SELECT instance_id FROM project')).rows[0].instance_id,profile.instanceId);
let called=0;
try{
 const id='assistant-fixture:'+crypto.randomUUID(),created=await ok(post('transactions',{operationId:crypto.randomUUID(),commands:[{type:'save',id,kind:'ENTITY',title:'助手接口隔离主体',expectedVersion:0,content:{description:'仅供隔离助手验收',authority:'U'}}]}));
 const focus={projectId:profile.projectId,snapshotId:profile.instanceId+':'+epoch,view:'settings',subjectType:'PROJECT',subjectId:profile.projectId,title:'隔离主体',filters:{settingId:id}};
 const target={id:'draft:'+crypto.randomUUID(),label:'意见',fieldId:'note',subjectId:focus.subjectId,value:'原意见',baseHash:hash('原意见')};
 const context=(await ok(post('assistant/context',{focus,draftTargets:[target]}))).context;
 assert.ok(context.resources.some(r=>r.id===id));
 const body={action:'START',mode:'DISCUSS',allowSettingsPublish:false,userMessage:'请帮助完善这条意见',focus,draftTargets:[target],expectedDependencyHash:context.dependencyHash},key='assistant-test:'+crypto.randomUUID();
 const queued=await ok(post('assistant/conversations',body,key));assert.equal(queued.status,'QUEUED');
 const conversationId=queued.conversation.id;assert.ok(queued.conversation.activeTurnId);
 const active=await ok(post('assistant/conversations',body,key));assert.equal(active.conversation.id,conversationId);
 assert.equal((await post('assistant/conversations',{...body,userMessage:'另一个问题'},key)).status,409);
 await workOnce(pool,{root:process.env.REVIEW_INSTANCE_ROOT,workerId:'ui-assistant-simulation',providers:{suggest:async({request,object})=>{
   called++;assert.equal(object.id,id);assert.equal(request.operationId,key);
   return {summary:'受控模拟：请补充具体依据。',patch:{},draftSuggestions:[{targetId:target.id,text:'模拟优化后的意见'}],sourceVersions:[]};
 }}});
 assert.equal(called,1);
 const completed=await get('assistant/conversations?conversationId='+conversationId),reply=completed.conversation.messages.find(m=>m.role==='assistant');
 assert.equal(reply.status,'SUCCEEDED');assert.equal(reply.workContext.stale,false);assert.equal(reply.workContext.suggestions[0].text,'模拟优化后的意见');assert.deepEqual(reply.workContext.observedImageIds,[]);
 const check={conversationId,messageId:reply.id,assistantContext:{packetId:reply.context.packetId,packetHash:reply.context.packetHash},targetId:target.id,expectedDraftHash:target.baseHash};
 assert.equal((await ok(post('assistant/suggestions/check',check))).formalAdoptionPerformed,false);
 let object=await get('objects/'+encodeURIComponent(id));assert.equal(object.version,1,'Discussion must not write the business object');
 await ok(post('transactions',{operationId:crypto.randomUUID(),commands:[{type:'save',id,expectedVersion:object.version,content:{...object.revision.content,description:'隔离并发修改'}}]}));
 assert.equal((await post('assistant/suggestions/check',check)).status,409);
 assert.equal((await post('assistant/conversations',{...body,action:'SEND',conversationId,expectedTurnHeadHash:completed.conversation.headHash})).status,409);
 console.log('PASS frozen context, single queued mock call, lost-response replay, draft preview and stale-source rejection');
 await ok(post('assistant/conversations',{action:'ARCHIVE',conversationId,expectedTurnHeadHash:completed.conversation.headHash}));
 assert.ok((await get('assistant/conversations?archived=only')).conversations.some(c=>c.id===conversationId));
 const archived=await get('assistant/conversations?conversationId='+conversationId);
 await ok(post('assistant/conversations',{action:'RESTORE',conversationId,expectedTurnHeadHash:archived.conversation.headHash}));
 const latest=await get('assistant/conversations?conversationId='+conversationId),fresh=(await ok(post('assistant/context',{focus,draftTargets:[target]}))).context;
 const second=await ok(post('assistant/conversations',{...body,action:'SEND',conversationId,expectedTurnHeadHash:latest.conversation.headHash,expectedDependencyHash:fresh.dependencyHash}));
 const cancelled=await ok(post('assistant/conversations',{action:'CANCEL',conversationId,turnId:second.conversation.activeTurnId,expectedTurnHeadHash:second.conversation.headHash}));assert.equal(cancelled.conversation.activeTurnId,null);
 assert.equal(called,1,'Queued cancellation must not invoke the model');
 const stream=await fetch(base+'assistant/events?conversationId='+conversationId),reader=stream.body.getReader(),frame=await reader.read();assert.match(new TextDecoder().decode(frame.value),/^data: /);await reader.cancel();
 assert.equal(Number((await pool.query("SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'")).rows[0].n),0);
 console.log('PASS conversation archive, restore, queued cancellation and SSE without an open transaction');
 const executeContext=(await ok(post('assistant/context',{focus,draftTargets:[]}))).context;
 const executeBody={action:'START',mode:'EXECUTE',userMessage:'请完善当前档案说明，先给出修改预览',focus,draftTargets:[],expectedDependencyHash:executeContext.dependencyHash},executeKey='assistant-execute:'+crypto.randomUUID();
 const execution=await ok(post('assistant/conversations',executeBody,executeKey));
 const before=await get('objects/'+encodeURIComponent(id));
 await workOnce(pool,{root:process.env.REVIEW_INSTANCE_ROOT,workerId:'ui-assistant-simulation',providers:{suggest:async()=>({summary:'仅隔离验收：档案说明修改预览',patch:{description:'隔离测试的修改建议'},sourceVersions:[]})}});
 const change=(await get('assistant/conversations?conversationId='+execution.conversation.id)).conversation.messages.find(m=>m.role==='assistant');
 assert.equal(change.changePreview.fields[0].before,before.revision.content.description);assert.equal(change.changePreview.fields[0].after,'隔离测试的修改建议');
 assert.equal((await get('objects/'+encodeURIComponent(id))).version,before.version,'Preview must not write an object');
 const applyBody={objectId:id,expectedVersion:before.version},applyId='assistant-apply:'+crypto.randomUUID();
 const applied=await ok(post('suggestions/'+encodeURIComponent(executeKey)+'/apply',applyBody,applyId));assert.equal(applied.status,'SUCCEEDED');
 assert.deepEqual(await ok(post('suggestions/'+encodeURIComponent(executeKey)+'/apply',applyBody,applyId)),applied);
 const after=await get('objects/'+encodeURIComponent(id));assert.equal(after.revision.content.description,'隔离测试的修改建议');assert.equal(after.state,'DRAFT');assert.equal(after.adoptedRevisionId,before.adoptedRevisionId);
 assert.equal((await post('suggestions/'+encodeURIComponent(executeKey)+'/apply',{...applyBody,expectedVersion:after.version})).status,409);
 assert.equal((await get('assistant/conversations?conversationId='+execution.conversation.id)).conversation.messages.find(m=>m.role==='assistant').changePreview.appliedRevisionId,after.revision.id);
 console.log('PASS execution mode previews exact before/after content, applies via shared API only on confirmation, and replays without a duplicate revision');
}finally{await closeDatabase();}
