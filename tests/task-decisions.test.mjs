import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm,lstat} from 'node:fs/promises';
import {mutate,location,readLedger,readBindings,startRun,updateBinding,stopRun} from '../tools/task-ledger.mjs';
import {decisionHash,encodeDecisionAnswer,pendingDecisions} from '../tools/task-decision-protocol.mjs';
import {decisionSnapshot,decisionVersions,listDecisions,persistDecisionMessage,drainDecisionInbox,deliverDecision,assertNoPendingDecisions,cancelAssignmentDecisions,readDecisionFile,durableDecisionFile} from '../tools/task-decisions.mjs';
import {taskCapacity} from '../tools/task-capacity.mjs';
import {main} from '../tools/tasks.mjs';
import {runDecisionChannel,channelPaths,channelClient,callDecisionChannel} from '../tools/task-decision-channel.mjs';
import {decisionsAction} from '../tools/task-decision-cli.mjs';
import {continueBackend,decisionFollowupPrompt,syncBackend} from '../tools/task-backend.mjs';

const req=x=>({operationId:randomUUID(),actor:'DECISION_FIXTURE',...x});
const capabilities={backend:'PROJECT_APP_SERVER',delegation:true,closeVerified:true,agentCapacity:3,availableSlots:3,models:[{model:'gpt-5.6-sol',efforts:['xhigh']}]};
const spec={clarified:true,type:'SYSTEM',title:'决策通路受控测试',originalRequest:'仅模拟协议，不代答真实用户',goal:'验证原请求往返',scope:['fixture'],deliverables:['结果'],acceptanceCriteria:['验证成功'],authorization:'仅模拟，无业务、模型或公共服务操作',discussion:{approved:true,summary:'fixture',feasibility:'fixture',approvedRequirements:['fixture']}};
const cp={summary:'受控检查点',completedSteps:['保存原步骤'],nextSteps:['核查'],inputs:['fixture@1'],artifacts:[],operations:[]};
async function fixture(t,{count=1}={}) {
 assert(process.env.REVIEW_TASK_DIR,'测试须经受管 process');
 const root=await mkdtemp(path.join(process.env.REVIEW_TASK_DIR,'decisions-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(path.join(root,'instance/runtime'),{recursive:true});await writeFile(path.join(root,'instance/instance.json'),JSON.stringify({id:randomUUID()}));
 const published=await mutate(root,'publish',req({tasks:Array.from({length:count},(_,i)=>({...spec,key:'task-'+i}))})),run=await startRun(root,{capabilities});
 const loc=await location(root),service={serviceId:'service-'+randomUUID(),generation:'generation-'+randomUUID()};
 await mkdir(path.join(loc.runtime,'server'));await writeFile(path.join(loc.runtime,'server/server.json'),JSON.stringify(service));
 const assignments=[];
 for(const taskId of published.taskIds){
  let task=(await readLedger(root)).tasks[taskId];
  const scheduled=await mutate(root,'schedule',req({runId:run.id,expectedVersions:{[taskId]:task.version},assignments:[{taskId,key:'worker',goal:'受控问答',deliverables:['结果'],acceptanceCriteria:['成功'],resources:[{kind:'OBJECT',key:taskId,access:'WRITE'}],execution:{longRunning:true,rationale:'fixture'}}]}));
  const id=scheduled.assignments[0].id;
  const state={root,run,taskId,id,loc,service};await assignmentChange(state,'dispatch');
  const threadId='thread-'+randomUUID(),turnId='turn-'+randomUUID();
  await assignmentChange(state,'start',{workspaceEvidence:'受控读对象',nativeThreadId:threadId});
  await updateBinding(root,run.id,id,b=>{b.backendServiceId=service.serviceId;b.backendGeneration=service.generation;b.backendCreation={threadId,...service};b.backendRequest={operationId:'work-'+id,turnId,state:'RUNNING'};});
  assignments.push({...state,threadId,turnId});
 }
 return {...assignments[0],assignments};
}
async function assignmentChange(s,action,extra={}) {
 const task=(await readLedger(s.root)).tasks[s.taskId],a=task.assignments.find(a=>a.id===s.id);
 return mutate(s.root,'assignment:'+action,req({runId:s.run.id,taskId:task.id,assignmentId:a.id,expectedVersions:{[task.id]:task.version},expectedAssignmentVersion:a.version,...extra}));
}
function message(s,{id=77,method='item/tool/call',params={}}={}) {
 const p={threadId:s.threadId,turnId:s.turnId,callId:'call-'+id,tool:'review_task_decision',namespace:null,arguments:{key:'delivery-choice',question:'选择哪个受控验证标记？',context:'只写测试结果，无外部效果',options:[{label:'alpha',description:'写 alpha 标记'},{label:'beta',description:'写 beta 标记'}],recommendation:'alpha',pendingWork:['写入所选测试标记'],completedSteps:['准备测试输入']},...params};
 return {id,method,params:p};
}
async function receive(s,m=message(s),connectionId='connection-a') {
 const file=await persistDecisionMessage(s.root,s.service,connectionId,m);await drainDecisionInbox(s.root);
 const saved=await readDecisionFile(file);assert.equal(saved.state,'APPLIED',saved.error);
 return (await listDecisions(s.root,{assignmentId:s.id,includeHistory:true})).find(d=>d.id===saved.result.decisionId);
}
async function decide(s,id,action,extra={}) {
 const current=await decisionSnapshot(s.root,id);
 return mutate(s.root,'decision:'+action,req({runId:s.run.id,...decisionVersions(current),...extra}));
}
async function presentAndAnswer(s,d,answer={text:'alpha'}) {
 await decide(s,d.id,'present',{evidence:'受控测试模拟提问；不是真实用户呈现'});
 return decide(s,d.id,'answer',{actor:'USER',explicitUserAnswer:true,evidence:'受控 fixture 用户答复',answer});
}
async function signal(s,method,params={},connectionId='connection-a') {
 await persistDecisionMessage(s.root,s.service,connectionId,{method,params});await drainDecisionInbox(s.root);
}

test('in-flight questions are durable, typed, independently bound and block collection, acceptance and DONE',async t=>{
 const s=await fixture(t,{count:2}),other=s.assignments[1],m=message(s),d=await receive(s,m),e=await receive(other,message(other));
 assert.notEqual(d.id,e.id);assert.equal(d.kind,'BUSINESS');assert.equal(d.status,'OPEN');
 const sequence=(await readLedger(s.root)).sequence;assert.equal((await receive(s,m)).id,d.id);assert.equal((await readLedger(s.root)).sequence,sequence);
 const ledger=await readLedger(s.root),a=ledger.tasks[s.taskId].assignments[0];assert.equal(a.status,'WAITING_DECISION');assert.equal(taskCapacity(ledger.tasks).occupied,2);
 await assert.rejects(assertNoPendingDecisions(s.root,s.id),/DECISION_PENDING/);
 await assert.rejects(assignmentChange(s,'result',{checkpoint:cp,result:{summary:'pretend completed',artifacts:[],acceptance:[{criterion:0,evidence:'fake'}]}}),/DECISION_PENDING/);
 await assert.rejects(assignmentChange(s,'accept',{evidence:'must not accept'}),/DECISION_PENDING/);
 await assert.rejects(mutate(s.root,'transition',req({runId:s.run.id,taskId:s.taskId,expectedVersions:{[s.taskId]:ledger.tasks[s.taskId].version},status:'DONE',reason:'pretend',result:{}})),/关闭|核查/);
 const state=await decisionSnapshot(s.root,d.id);
 await assert.rejects(mutate(s.root,'decision:answer',req({runId:s.run.id,...decisionVersions(state),assignmentId:other.id,actor:'USER',explicitUserAnswer:true,answer:{text:'beta'},evidence:'wrong thread'})),/DECISION_BINDING|DECISION_VERSION/);
 const raw=JSON.stringify((await readLedger(s.root)).events);for(const value of [s.threadId,s.turnId,s.service.serviceId,s.service.generation])assert(!raw.includes(value),'机器绑定不得进入长期账本');
 assert.match(await main(['decisions','list','--project',s.root,'--format','markdown']),/选择哪个受控验证标记/);
});

test('reply is saved before sending, duplicate and conflicting answers never execute again, matching tool output confirms delivery',async t=>{
 const s=await fixture(t),d=await receive(s);
 await decide(s,d.id,'present',{evidence:'受控测试已呈现'});
 let snapshot=await decisionSnapshot(s.root,d.id);
 const answer=req({operationId:'a'.repeat(101),runId:s.run.id,...decisionVersions(snapshot),actor:'USER',explicitUserAnswer:true,evidence:'fixture explicit user alpha',answer:{text:'alpha'}});
 await mutate(s.root,'decision:answer',answer);
 const replay=await mutate(s.root,'decision:answer',answer);assert.equal(replay.replayed,true);
 await assert.rejects(mutate(s.root,'decision:answer',{...answer,answer:{text:'beta'}}),/同一操作/);
 await assert.rejects(decide(s,d.id,'answer',{actor:'USER',explicitUserAnswer:true,evidence:'fixture',answer:{text:'beta'}}),/CONFLICT/);
 let count=0,response;
 const client={hasRequest:id=>id===77,async respond(id,r){count++;response=r;const saved=await decisionSnapshot(s.root,d.id);assert.equal(saved.decision.status,'DELIVERY_UNKNOWN');assert.equal(saved.decision.answer.value.text,'alpha');}};
 await deliverDecision(s.root,s.run.id,d.id,{client,connectionId:'connection-a',service:s.service});
 await deliverDecision(s.root,s.run.id,d.id,{client,connectionId:'connection-a',service:s.service});assert.equal(count,1);
 await signal(s,'serverRequest/resolved',{threadId:s.threadId,requestId:77});
 snapshot=await decisionSnapshot(s.root,d.id);assert.equal(snapshot.decision.status,'NEEDS_RECONCILIATION','resolved 可为清理，不能等同用户答复送达');
 await signal(s,'item/completed',{threadId:s.threadId,turnId:s.turnId,item:{id:'call-77',type:'dynamicToolCall',status:'completed',tool:'review_task_decision',arguments:message(s).params.arguments,success:true,contentItems:response.contentItems}});
 snapshot=await decisionSnapshot(s.root,d.id);assert.equal(snapshot.decision.status,'RESOLVED');assert.equal(snapshot.assignment.status,'RUNNING');await assertNoPendingDecisions(s.root,s.id);
});

test('native input and permission approvals keep original shapes and reject defaults, secret input and expanded grants',async t=>{
 const s=await fixture(t);
 const d=await receive(s,message(s,{method:'item/tool/requestUserInput',params:{itemId:'input-item',isBlocking:false,autoResolutionMs:1,questions:[{id:'color',header:'颜色',question:'选择受控颜色',options:[{label:'red',description:'红'}]}]}}));
 let wire=(await decisionSnapshot(s.root,d.id)).wire;assert.equal(d.kind,'INPUT');
 assert.deepEqual(encodeDecisionAnswer(d,wire,{answers:{color:{answers:['red']}}}),{answers:{color:{answers:['red']}}});
 assert.throws(()=>encodeDecisionAnswer(d,wire,{answers:{other:{answers:['red']}}}),/原问题 ID/);
 assert.throws(()=>encodeDecisionAnswer(d,wire,{answers:{color:{answers:[]}}}),/空答复/);
 await signal(s,'serverRequest/resolved',{threadId:s.threadId,requestId:77});await signal(s,'turn/completed',{threadId:s.threadId,turn:{id:s.turnId,status:'completed'}});
 const cleared=await decisionSnapshot(s.root,d.id);assert.equal(cleared.decision.answer,null);assert.equal(cleared.decision.status,'NEEDS_RECONCILIATION');
 const approval=await receive(s,message(s,{id:78,method:'item/permissions/requestApproval',params:{itemId:'permissions',permissions:{network:{enabled:true}}}}));
 wire=(await decisionSnapshot(s.root,approval.id)).wire;assert.equal(approval.kind,'APPROVAL');
 assert.deepEqual(encodeDecisionAnswer(approval,wire,{decision:'grant'}),{permissions:{network:{enabled:true}},scope:'turn'});
 assert.throws(()=>encodeDecisionAnswer(approval,wire,{decision:'grant',scope:'session'}),/不能扩大/);
 const secret=await receive(s,message(s,{id:79,method:'item/tool/requestUserInput',params:{questions:[{id:'secret',header:'secret',question:'secret',isSecret:true}]}}));assert.equal(secret.supported,false);
 const unknown=await receive(s,message(s,{id:80,method:'unknown/approval'}));assert.equal(unknown.kind,'UNSUPPORTED');assert.equal(unknown.status,'NEEDS_RECONCILIATION');
});

test('no coordinator, coordinator change and early turn notifications retain questions and presentation identity',async t=>{
 const s=await fixture(t),runFile=path.join(s.loc.runtime,'run.json');
 const old=JSON.parse(await readFile(runFile,'utf8'));await writeFile(runFile,JSON.stringify({...old,owner:{pid:process.pid,birth:'not-the-live-owner'}}));
 const m=message(s),file=await persistDecisionMessage(s.root,s.service,'connection-a',m);
 await updateFixtureTurn(s,null);await drainDecisionInbox(s.root);assert.equal((await readDecisionFile(file)).state,'NEEDS_RECONCILIATION');
 await signal(s,'serverRequest/resolved',{threadId:s.threadId,requestId:77});
 await updateFixtureTurn(s,s.turnId);await drainDecisionInbox(s.root);
 let d=(await listDecisions(s.root))[0];assert.equal(d.status,'NEEDS_RECONCILIATION');assert.equal(d.answer,null);
 const next=await startRun(s.root,{capabilities});
 await assert.rejects(decide({...s,run:next},d.id,'present',{evidence:'must reconcile first'}),/DECISION_RUN/);
 await assignmentChange({...s,run:next},'reconcile',{checkpoint:cp,reconciliation:{processes:'fixture ended',workspace:'unchanged',versions:'checked',operations:'checked',agent:'original remains'}});
 await decide({...s,run:next},d.id,'present',{evidence:'fixture 新主会话真正提问'});
 const replayed=await decide({...s,run:next},d.id,'present',{evidence:'same prompt must not be asked again'});assert.equal(replayed.alreadyPresented,true);
 await decide({...s,run:next},d.id,'answer',{actor:'USER',explicitUserAnswer:true,answer:{text:'alpha'},evidence:'fixture 新主会话明确答复'});
 d=(await decisionSnapshot(s.root,d.id)).decision;assert.equal(d.status,'NEEDS_RECONCILIATION','已失效请求的答复保留核查，不发给新请求');assert.equal(d.presentations.length,1);
});
async function updateFixtureTurn(s,turnId){const f=path.join(s.loc.runtime,'bindings.json'),b=JSON.parse(await readFile(f,'utf8'));b.assignments[s.id].backendRequest.turnId=turnId;await writeFile(f,JSON.stringify(b));}

test('disconnect after saved answer and unknown send never replay across a connection or service generation',async t=>{
 const s=await fixture(t),m=message(s),d=await receive(s,m);await presentAndAnswer(s,d);
 let sends=0;const client={hasRequest:()=>true,respond:async()=>{sends++;throw Error('fixture write interrupted');}};
 await deliverDecision(s.root,s.run.id,d.id,{client,connectionId:'connection-a',service:s.service});
 await signal(s,'connection/closed');assert.equal((await decisionSnapshot(s.root,d.id)).decision.status,'NEEDS_RECONCILIATION');
 await receive(s,m,'connection-b');
 const again=await deliverDecision(s.root,s.run.id,d.id,{client,connectionId:'connection-b',service:s.service});assert.equal(again.sent,false);assert.equal(sends,1);
 const original=await decisionSnapshot(s.root,d.id),service={...s.service,generation:'new-generation'};await writeFile(path.join(s.loc.runtime,'server/server.json'),JSON.stringify(service));
 const newMessage={...m,params:{...m.params,arguments:{...m.params.arguments,key:'new-distinct-request'}}};
 const n=await receive({...s,service},newMessage,'connection-c');assert.notEqual(n.id,d.id);assert.equal(n.answer,null);assert.equal(original.decision.answer.value.text,'alpha');
 await assert.rejects(mutate(s.root,'decision:answer',req({runId:s.run.id,...decisionVersions(await decisionSnapshot(s.root,n.id)),bindingToken:original.decision.bindingToken,actor:'USER',explicitUserAnswer:true,answer:{text:'alpha'},evidence:'wrong incarnation'})),/DECISION_BINDING/);
});

test('waiting retains capacity, stop rejects new answers and verified close cancels requests without inventing consent',async t=>{
 const s=await fixture(t),d=await receive(s);await decide(s,d.id,'present',{evidence:'fixture presented'});
 await assert.rejects(assignmentChange(s,'close',{outcome:'CANCELLED',reason:'stop',cleanup:'fixture'}),/DECISION_PENDING/);
 await stopRun(s.root,s.run.id);
 await assert.rejects(decide(s,d.id,'answer',{actor:'USER',explicitUserAnswer:true,answer:{text:'alpha'},evidence:'too late'}),/执行资格/);
 await updateBinding(s.root,s.run.id,s.id,b=>{b.closureReceipt={verified:true,nativeThreadId:s.threadId,history:'PRESERVED'};});
 await cancelAssignmentDecisions(s.root,s.run.id,s.id);
 await assignmentChange(s,'close',{outcome:'CANCELLED',reason:'fixture 已停止',cleanup:'保留恢复输入'});
 const saved=await decisionSnapshot(s.root,d.id);assert.equal(saved.decision.status,'CANCELLED');assert.equal(saved.decision.answer,null);assert.equal(saved.assignment.status,'CLOSED');
 assert.equal(taskCapacity((await readLedger(s.root)).tasks).occupied,1,'父任务尚未收尾，保留正式任务占用');
});

test('persistent receiver discovers a question after the dispatch client leaves, routes the explicit fixture reply once, and records disconnect',async t=>{
 const s=await fixture(t),originalCwd=process.cwd(),originalHome=process.env.CODEX_HOME;
 // Relative private control path keeps Unix socket length bounded in managed
 // test scratch. The native transport is fully controlled and calls no model.
 process.chdir(s.root);process.env.CODEX_HOME='fixture-codex-home';await mkdir('fixture-codex-home');
 let native,runner,stopped=false;
 t.after(async()=>{if(native){native.close();await runner;}process.chdir(originalCwd);if(originalHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=originalHome;});
 const paths=await channelPaths(s.root);s.service.serviceId=paths.serviceId;
 await writeFile(path.join(s.loc.runtime,'server/server.json'),JSON.stringify(s.service));
 await updateBinding(s.root,s.run.id,s.id,b=>{b.backendServiceId=paths.serviceId;b.backendCreation.serviceId=paths.serviceId;b.backendRequest.state='TURN_STARTING';delete b.backendRequest.turnId;});
 const channelSpec={id:randomUUID(),root:s.root,serviceId:paths.serviceId,generation:s.service.generation,sourceDigest:'controlled-fixture',socket:paths.channelSocket};
 const calls=[],responses=[];let hooks;
 runner=runDecisionChannel(channelSpec,{handleSignals:false,verifyServer:async(project,{connect})=>{
  assert.equal(project,s.root);
  native=connect({socket:'/fixture/owned-native.sock',transportFactory:h=>{hooks=h;return {socket:h.socket,ready:Promise.resolve(),close(){stopped=true;},async send(m){
   if(!m.method){responses.push(m);hooks.onMessage({method:'item/completed',params:{threadId:s.threadId,turnId:s.turnId,item:{id:'call-77',type:'dynamicToolCall',status:'completed',tool:'review_task_decision',arguments:message(s).params.arguments,success:true,contentItems:m.result.contentItems}}});return;}
   calls.push(m.method);if(m.method==='initialized')return;
   if(m.method==='initialize'){hooks.onMessage({id:m.id,result:{userAgent:'fixture'}});return;}
   if(m.method==='turn/start'){
    hooks.onMessage({id:m.id,result:{turn:{id:s.turnId,status:'inProgress'}}});
    setTimeout(()=>hooks.onMessage(message(s)),50);return;
   }
   throw Error('Unexpected fixture RPC '+m.method);
  }};}});
  await native.initialize();return {record:s.service,client:native};
 }});
 for(let i=0;i<100;i++){const r=await readDecisionFile(paths.channelRecord);if(r?.status==='READY')break;await new Promise(r=>setTimeout(r,20));}
 const client=channelClient(s.root,s.run.id,s.id);assert.equal((await client.call('turn/start',{threadId:s.threadId,input:[{type:'text',text:'fixture'}]})).turn.id,s.turnId);client.close();
 await updateBinding(s.root,s.run.id,s.id,b=>{b.backendRequest.state='RUNNING';b.backendRequest.turnId=s.turnId;});
 let d;for(let i=0;i<100;i++){d=(await listDecisions(s.root))[0];if(d)break;await new Promise(r=>setTimeout(r,20));}assert(d,'没有任何活跃 CLI 时必须持续接收原服务问题');
 assert.equal(stopped,false);assert.equal(d.status,'OPEN');assert.equal(calls.filter(c=>c==='turn/start').length,1);
 await decide(s,d.id,'present',{evidence:'受控测试模拟主会话呈现'});
 const answer={...req({runId:s.run.id,...decisionVersions(await decisionSnapshot(s.root,d.id)),actor:'USER',explicitUserAnswer:true,evidence:'受控 fixture user beta',answer:{text:'beta'}})};
 const result=await decisionsAction(s.root,'answer',{run:s.run.id},answer);assert.equal(result.delivery.sent,true);
 await decisionsAction(s.root,'answer',{run:s.run.id},answer);
 await callDecisionChannel(s.root,{action:'drain'});
 assert.equal(responses.length,1);assert.equal(JSON.parse(responses[0].result.contentItems[0].text).userAnswer,'beta');
 assert.equal((await decisionSnapshot(s.root,d.id)).decision.status,'RESOLVED');
 native.close();await runner;
 assert.equal((await readDecisionFile(paths.channelRecord)).status,'FAILED');assert.equal(stopped,true);
});

test('waiting workers retain their resources while independent work can still be scheduled',async t=>{
 const s=await fixture(t),d=await receive(s);
 const pub=await mutate(s.root,'publish',req({tasks:[{...spec,key:'independent'},{...spec,key:'conflicting'}]})),ledger=await readLedger(s.root);
 const candidates=pub.taskIds.map((taskId,i)=>({taskId,key:'next',goal:'fixture next',deliverables:['result'],acceptanceCriteria:['pass'],resources:[{kind:'OBJECT',key:i?s.taskId:taskId,access:'WRITE'}],execution:{rationale:'fixture'}}));
 const scheduled=await mutate(s.root,'schedule',req({runId:s.run.id,expectedVersions:Object.fromEntries(pub.taskIds.map(id=>[id,ledger.tasks[id].version])),assignments:candidates}));
 assert.equal(scheduled.assignments.length,1);assert.equal(scheduled.assignments[0].taskId,pub.taskIds[0]);assert.equal(scheduled.deferred[0].reason,'RESOURCE_CONFLICT');
 assert.equal((await decisionSnapshot(s.root,d.id)).assignment.status,'WAITING_DECISION');
});

test('invalidated request uses a checked same-scope FOLLOWUP; replay, active, failed and unknown turns never start twice',async t=>{
 const s=await fixture(t),d=await receive(s);await presentAndAnswer(s,d);await signal(s,'connection/closed');
 await decide(s,d.id,'reconcile',{resolution:'FOLLOWUP',checkedOriginalOperation:true,evidence:'受控原线程已完成；保存的决定尚未应用'});
 await updateBinding(s.root,s.run.id,s.id,b=>{b.workspace=s.root;});
 const final=JSON.stringify({summary:'fixture paused at decision',artifacts:[],acceptance:[{criterion:0,evidence:'fixture'}],completedSteps:['prepare'],nextSteps:['await decision']});
 let turnStatus='inProgress',threadStatus='active',calls=0,failAfterStart=false;
 const turns=[{id:s.turnId,status:turnStatus,items:[{type:'agentMessage',text:final}]}];
 const client={close(){},async flush(){},async call(method,p){
  if(method==='thread/read')return {thread:{id:s.threadId,cwd:s.root,status:{type:threadStatus}}};
  if(method==='thread/loaded/list')return {data:[s.threadId]};
  if(method==='thread/turns/list'){turns[0].status=turnStatus;return {data:turns};}
  if(method==='turn/start'){
   calls++;assert(p.input[0].text.includes('alpha'));assert(!p.input[0].text.includes('扩大授权。\nnew scope'));
   turns.push({id:'followup-turn',status:'inProgress',items:[]});threadStatus='active';
   if(failAfterStart)throw Error('fixture lost response');return {turn:{id:'followup-turn'}};
  }
  throw Error('unexpected fixture RPC '+method);
 }};
 const verifyServer=async()=>({client,record:s.service,paths:s.loc});
 const request={operationId:'fixture-followup',decisionIds:[d.id],prompt:decisionFollowupPrompt([(await decisionSnapshot(s.root,d.id)).decision])};
 await assert.rejects(continueBackend(s.root,s.run.id,s.id,request,{verifyServer}),/上一轮尚未确认成功/);assert.equal(calls,0);
 turnStatus='failed';threadStatus='idle';await assert.rejects(continueBackend(s.root,s.run.id,s.id,request,{verifyServer}),/上一轮尚未确认成功/);assert.equal(calls,0);
 turnStatus='completed';
 await assert.rejects(continueBackend(s.root,s.run.id,s.id,{...request,prompt:'expand scope'},{verifyServer}),/DECISION_FOLLOWUP/);
 failAfterStart=true;await assert.rejects(continueBackend(s.root,s.run.id,s.id,request,{verifyServer}),/lost response/);assert.equal(calls,1);
 assert.equal((await decisionSnapshot(s.root,d.id)).decision.status,'DELIVERY_UNKNOWN');
 const unknown=await continueBackend(s.root,s.run.id,s.id,request,{verifyServer});assert.equal(unknown.status,'RESULT_UNKNOWN');assert.equal(calls,1,'唯一可见轮次不能证明其属于原操作');
 assert.equal((await decisionSnapshot(s.root,d.id)).decision.status,'DELIVERY_UNKNOWN');
 const receiptId=decisionHash({assignmentId:s.id,operationId:request.operationId,method:'turn/start'});
 await durableDecisionFile(path.join(s.loc.runtime,'decision-channel/calls',receiptId+'.json'),{assignmentId:s.id,operationId:request.operationId,method:'turn/start',state:'SUCCEEDED',...s.service,params:{threadId:s.threadId},result:{turn:{id:'followup-turn'}},at:new Date().toISOString()});
 const recovered=await continueBackend(s.root,s.run.id,s.id,request,{verifyServer});assert.equal(recovered.status,'RUNNING');assert.equal(calls,1,'精确原调用回执恢复轮次，不重启工作');
 assert.equal((await decisionSnapshot(s.root,d.id)).decision.status,'RESOLVED');
 await assert.rejects(continueBackend(s.root,s.run.id,s.id,{operationId:'different',prompt:'another turn'},{verifyServer}),/上一轮尚未确认成功/);assert.equal(calls,1);
 turns.push({id:'foreign-active',status:'inProgress'});await assert.rejects(syncBackend(s.root,s.run.id,s.id,{verifyServer}),/BACKEND_TURN_MISMATCH/);
});

test('service restart before inbox projection preserves the original question without reviving its callback',async t=>{
 const s=await fixture(t),file=await persistDecisionMessage(s.root,s.service,'old-connection',message(s));
 await writeFile(path.join(s.loc.runtime,'server/server.json'),JSON.stringify({...s.service,generation:'restarted-generation'}));
 await drainDecisionInbox(s.root);assert.equal((await readDecisionFile(file)).state,'APPLIED');
 const d=(await listDecisions(s.root))[0],saved=await decisionSnapshot(s.root,d.id);
 assert.equal(d.status,'NEEDS_RECONCILIATION');assert.equal(saved.wire.protocolState,'STALE');assert.equal(saved.wire.generation,s.service.generation);
 await presentAndAnswer(s,d);assert.equal((await decisionSnapshot(s.root,d.id)).decision.status,'NEEDS_RECONCILIATION');
});

test('crash after runtime send intent but before ledger append remains unknown and never sends',async t=>{
 const s=await fixture(t),d=await receive(s);await presentAndAnswer(s,d);
 await updateBinding(s.root,s.run.id,s.id,b=>{b.decisions[d.id].deliveryAttemptedAt=new Date().toISOString();});
 let sends=0;const result=await deliverDecision(s.root,s.run.id,d.id,{client:{hasRequest:()=>true,respond:async()=>sends++},connectionId:'connection-a',service:s.service});
 assert.equal(sends,0);assert.equal(result.status,'DELIVERY_UNKNOWN');assert.equal((await decisionSnapshot(s.root,d.id)).decision.status,'DELIVERY_UNKNOWN');
});

test('connection lost during initialization cannot leave a READY receiver or a live control socket',async t=>{
 const s=await fixture(t),cwd=process.cwd(),codexHome=process.env.CODEX_HOME;
 process.chdir(s.root);process.env.CODEX_HOME='fixture-home';await mkdir('fixture-home');
 t.after(()=>{process.chdir(cwd);if(codexHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=codexHome;});
 const p=await channelPaths(s.root),spec={id:randomUUID(),root:s.root,serviceId:p.serviceId,generation:s.service.generation,sourceDigest:'fixture',socket:p.channelSocket};
 await writeFile(path.join(s.loc.runtime,'server/server.json'),JSON.stringify(spec));
 await assert.rejects(runDecisionChannel(spec,{handleSignals:false,verifyServer:async(project,{connect})=>{
  let hooks;const client=connect({socket:'/fixture/owned.sock',transportFactory:h=>{hooks=h;return {socket:h.socket,ready:Promise.resolve(),close(){},async send(m){if(m.method==='initialize')hooks.onMessage({id:m.id,result:{userAgent:'fixture'}});}};}});
  await client.initialize();client.close();await client.flush();return {client,record:spec};
 }}),/DECISION_CHANNEL_DISCONNECTED/);
 assert.equal((await readDecisionFile(p.channelRecord)).status,'FAILED');
 await assert.rejects(lstat(p.channelSocket),error=>error.code==='ENOENT');
});

test('a late request cancelled during shutdown cannot inherit an earlier ACCEPTED outcome',async t=>{
 const s=await fixture(t);
 await assignmentChange(s,'result',{checkpoint:cp,result:{summary:'fixture original result',artifacts:[],acceptance:[{criterion:0,evidence:'fixture original review'}]}});
 await assignmentChange(s,'accept',{evidence:'fixture original acceptance'});
 const d=await receive(s);
 await updateBinding(s.root,s.run.id,s.id,b=>{b.closureReceipt={verified:true,nativeThreadId:s.threadId,history:'PRESERVED'};});
 await cancelAssignmentDecisions(s.root,s.run.id,s.id);
 await assert.rejects(assignmentChange(s,'close',{outcome:'ACCEPTED',cleanup:'fixture closed'}),/DECISION_PENDING/);
 await assignmentChange(s,'close',{outcome:'CANCELLED',reason:'新出现的问题未解决',cleanup:'fixture closed; recovery retained'});
 assert.equal((await decisionSnapshot(s.root,d.id)).assignment.outcome,'CANCELLED');
});

test('original RPC intent fences pre-send, completed-without-receipt and duplicate requests across receiver restart',async t=>{
 for(const window of ['before-send','completed-without-receipt','receipt-saved'])await t.test(window,async t=>{
  const s=await fixture(t),cwd=process.cwd(),codexHome=process.env.CODEX_HOME;
  process.chdir(s.root);process.env.CODEX_HOME='isolated-home';await mkdir('isolated-home');
  let native,runner;
  t.after(async()=>{if(native){native.close();await runner;}process.chdir(cwd);if(codexHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=codexHome;});
  const p=await channelPaths(s.root);s.service.serviceId=p.serviceId;
  await writeFile(path.join(s.loc.runtime,'server/server.json'),JSON.stringify(s.service));
  await updateBinding(s.root,s.run.id,s.id,b=>{b.backendServiceId=p.serviceId;b.backendCreation.serviceId=p.serviceId;b.backendRequest.state='TURN_STARTING';b.backendRequest.generation=s.service.generation;delete b.backendRequest.turnId;});
  const operationId=(await readBindings(s.loc)).assignments[s.id].backendRequest.operationId;
  const params={threadId:s.threadId,input:[{type:'text',text:'execute original once'}]},rpcId=decisionHash({assignmentId:s.id,operationId,method:'turn/start'}),file=path.join(p.directory,'calls',rpcId+'.json');
  const effect=path.join(s.root,'isolated-effect.json');await durableDecisionFile(effect,{operationId,count:0});
  if(window==='before-send')await durableDecisionFile(file,{rpcId,assignmentId:s.id,operationId,method:'turn/start',params,...s.service,state:'PENDING'});
  const start=async()=>{
   const spec={id:randomUUID(),root:s.root,...s.service,sourceDigest:'fixture',socket:p.channelSocket};
   runner=runDecisionChannel(spec,{handleSignals:false,verifyServer:async(project,{connect})=>{
    native=connect({socket:'/fixture/native',transportFactory:hooks=>({ready:Promise.resolve(),close(){},async send(m){
     if(m.method==='initialized')return;
     if(m.method==='initialize'){hooks.onMessage({id:m.id,result:{userAgent:'fixture'}});return;}
     assert.equal(m.method,'turn/start');
     const saved=await readDecisionFile(effect);await durableDecisionFile(effect,{operationId,count:saved.count+1,result:'completed'});
     if(window==='completed-without-receipt')hooks.onMessage({id:m.id,error:{message:'fixture completed; acknowledgement lost'}});
     else hooks.onMessage({id:m.id,result:{turn:{id:s.turnId,status:'completed'}}});
    }})});
    await native.initialize();return {record:s.service,client:native};
   }});
   for(let i=0;i<100;i++){if((await readDecisionFile(p.channelRecord))?.status==='READY')return;await new Promise(r=>setTimeout(r,20));}
   throw Error('fixture receiver not ready');
  };
  await start();
  const responses=await Promise.allSettled([1,2].map(()=>channelClient(s.root,s.run.id,s.id).call('turn/start',params)));
  if(window==='receipt-saved')assert(responses.every(r=>r.status==='fulfilled'&&r.value.turn.id===s.turnId));
  else assert(responses.every(r=>r.status==='rejected'));
  assert.equal((await readDecisionFile(effect)).count,window==='before-send'?0:1);
  const prior=await readDecisionFile(file);assert.equal(prior.operationId,operationId);assert.equal(prior.state,window==='receipt-saved'?'SUCCEEDED':window==='before-send'?'PENDING':'RESULT_UNKNOWN');
  native.close();await runner;native=null;
  await start();
  const replay=channelClient(s.root,s.run.id,s.id).call('turn/start',params);
  if(window==='receipt-saved')assert.equal((await replay).turn.id,s.turnId);
  else await assert.rejects(replay,/RESULT_UNKNOWN/);
  await assert.rejects(channelClient(s.root,s.run.id,s.id).call('turn/start',{...params,input:[{type:'text',text:'different request'}]}),/REPLAY/);
  assert.equal((await readDecisionFile(effect)).count,window==='before-send'?0:1);
  native.close();await runner;native=null;
 });
});

test('two concurrent FOLLOWUP intents cannot replace each other or start two turns',async t=>{
 const s=await fixture(t);await updateBinding(s.root,s.run.id,s.id,b=>{b.workspace=s.root;});
 const final=JSON.stringify({summary:'original completed',artifacts:[],acceptance:[],completedSteps:[],nextSteps:[]});
 let starts=0,turns=[{id:s.turnId,status:'completed',items:[{type:'agentMessage',text:final}]}];
 const client={close(){},async flush(){},async call(method,p){
  if(method==='thread/read')return {thread:{id:s.threadId,cwd:s.root,status:{type:starts?'active':'idle'}}};
  if(method==='thread/loaded/list')return {data:[s.threadId]};
  if(method==='thread/turns/list')return {data:turns};
  if(method==='turn/start'){starts++;turns=[...turns,{id:'sole-followup',status:'inProgress',items:[]}];return {turn:{id:'sole-followup'}};}
  throw Error('Unexpected fixture RPC '+method);
 }};
 const verifyServer=async()=>({client,record:s.service,paths:s.loc});
 const outcomes=await Promise.allSettled(['one','two'].map(id=>continueBackend(s.root,s.run.id,s.id,{operationId:'competing-'+id,prompt:'same bounded next step'},{verifyServer})));
 assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.equal(starts,1);
 const saved=(await readBindings(s.loc)).assignments[s.id];assert.equal(saved.backendHistory.length,1);assert.equal(saved.backendRequest.turnId,'sole-followup');
 const error=outcomes.find(r=>r.status==='rejected').reason;assert.match(error.message,/OPERATION_CHANGED|上一轮尚未确认成功/);
});
