import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtemp,mkdir,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {createTaskObserver,createInboxTaskObserver} from '../tools/task-observation.mjs';
import {openAttachClient} from '../tools/task-attach-service.mjs';
import {decisionHash} from '../tools/task-decision-protocol.mjs';
import {readDecisionFile} from '../tools/task-decisions.mjs';
import {location,mutate,readLedger,startRun,readBindings,updateBinding} from '../tools/task-ledger.mjs';

const generation='original-generation',serviceId='original-service',connectionId='original-receiver';
const instant='2026-09-15T00:00:01.000Z';
const visibleItem=(id,text)=>({id,type:'agentMessage',text});
const completion=(id,item,extra={})=>({method:'item/completed',params:{threadId:'thread-'+id,turnId:'turn-'+id,item,...extra}});
async function temporary(t) {
 assert(process.env.REVIEW_TASK_DIR,'测试须经受管 process');
 const root=await mkdtemp(path.join(process.env.REVIEW_TASK_DIR,'attach-offline-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;
}
async function writeJson(file,value){await mkdir(path.dirname(file),{recursive:true});await writeFile(file,JSON.stringify(value)+'\n');}
async function digestTree(root) {
 const result={};
 const walk=async dir=>{for(const entry of await readdir(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())await walk(file);else if(entry.isFile())result[path.relative(root,file)]=createHash('sha256').update(await readFile(file)).digest('hex');else throw Error('unexpected fixture resource');}};
 await walk(root);return result;
}
async function inboxFixture(t) {
 const root=await temporary(t),runtime=path.join(root,'instance/runtime/task-execution'),task={id:'task-a',assignments:[]},bindings={assignments:{}};
 const addNode=async(id,owner=task)=>{
  owner.assignments.push({id,role:'WORKER',rootAssignmentId:id,status:'CLOSED'});
  const binding={workspace:path.join(root,'worktree-'+id),nativeThreadId:'thread-'+id,backendServiceId:serviceId,backendGeneration:generation,
   backendCreation:{serviceId,generation,threadId:'thread-'+id,createdAt:instant},
   executionAuthority:{assignmentId:id,taskId:owner.id,activatedAt:instant,revokedAt:instant},
   backendRequest:{operationId:'work-'+id,generation,turnId:'turn-'+id,state:'SUCCEEDED'}};
  bindings.assignments[id]=binding;await receipts(id,binding);return binding;
 };
 const receipts=async(id,binding)=>{
  const r=binding.backendRequest;
  for(const method of ['thread/start','turn/start']){
   const key=decisionHash({assignmentId:id,operationId:r.operationId,method});
   await writeJson(path.join(runtime,'decision-channel/calls',key+'.json'),{rpcId:key,assignmentId:id,operationId:r.operationId,method,serviceId,generation:r.generation,connectionId,state:'SUCCEEDED',at:instant,
    params:method==='thread/start'?{cwd:binding.workspace}:{threadId:binding.nativeThreadId},result:method==='thread/start'?{thread:{id:binding.nativeThreadId}}:{turn:{id:r.turnId}}});
  }
 };
 const save=async(message,extra={})=>{
  const entry={serviceId,generation,connectionId,message,receivedAt:'2026-09-15T00:00:02.000Z',receivedOrder:'10',state:'APPLIED',...extra};
  entry.id=decisionHash({serviceId:entry.serviceId,generation:entry.generation,connectionId:entry.connectionId,message:entry.message});
  const file=path.join(runtime,'decision-channel/inbox',entry.id+'.json');await writeJson(file,entry);return {entry,file};
 };
 await addNode('worker');return {root,runtime,task,bindings,addNode,save,receipts};
}

test('observers expose separate epochs and never display raw decision requests or reasoning items',()=>{
 const a=createTaskObserver(),b=createTaskObserver();assert.notEqual(a.observerId,b.observerId);
 a.observe({id:77,...completion('worker',visibleItem('forged','RAW_DECISION'))});
 a.observe(completion('worker',{id:'hidden',type:'reasoning',summary:['HIDDEN_REASONING']}));
 a.observe(completion('worker',visibleItem('public','public output')));
 assert.deepEqual(a.page('thread-worker').messages.map(m=>m.text),['public output']);assert.equal(a.page('thread-worker').observerId,a.observerId);
});

test('two nodes page complete items within a shared response budget without advancing an exhausted cursor',()=>{
 const observer=createTaskObserver();
 for(const id of ['worker','child'])for(let i=0;i<5;i++)observer.observe(completion(id,visibleItem('item-'+i,id+'-'+i+' '+'.'.repeat(80))));
 const empty=observer.page('thread-worker',0,0);assert.equal(empty.cursor,0);assert.deepEqual(empty.messages,[]);assert.equal(empty.hasMore,true);
 const cursors={worker:0,child:0},messages={worker:new Map(),child:new Map()};
 for(let round=0;round<15;round++){
  let remaining=600;
  for(const id of ['worker','child']){
   const page=observer.page('thread-'+id,cursors[id],remaining),bytes=Buffer.byteLength(JSON.stringify(page.messages));
   if(bytes>remaining)continue;
   for(const item of page.messages)messages[id].set(item.id,item);cursors[id]=page.cursor;remaining-=bytes;
  }
 }
 assert.equal(messages.worker.size,5);assert.equal(messages.child.size,5);assert.equal(observer.page('thread-child',cursors.child).hasMore,false);
 assert.equal(observer.page('thread-worker',0,1).messages.length,1,'正预算保留巨型完整单条，不截断正文');
});

test('offline history requires original receipts and keeps only same-node completed public items',async t=>{
 const s=await inboxFixture(t),other={id:'task-b',assignments:[]};await s.addNode('other',other);
 await s.save(completion('worker',visibleItem('first','first public')));
 await s.save({method:'turn/completed',params:{threadId:'thread-worker',turn:{id:'turn-worker',status:'completed',items:[visibleItem('final','final public'),{id:'r',type:'reasoning',text:'HIDDEN_REASONING'}]}}},{receivedOrder:'20'});
 await s.save(completion('other',visibleItem('foreign','OTHER_TASK')));
 await s.save(completion('worker',visibleItem('wrong-service','WRONG_SERVICE')),{serviceId:'foreign-service'});
 await s.save(completion('worker',visibleItem('wrong-generation','WRONG_GENERATION')),{generation:'later-generation'});
 await s.save(completion('worker',visibleItem('wrong-receiver','WRONG_RECEIVER')),{connectionId:'foreign-receiver'});
 await s.save(completion('worker',visibleItem('wrong-turn','WRONG_TURN'),{turnId:'unknown-turn'}));
 await s.save(completion('worker',visibleItem('too-early','BEFORE_CREATION')),{receivedAt:'2026-09-15T00:00:00.000Z'});
 await s.save({id:12,...completion('worker',visibleItem('raw','RAW_REQUEST'))});
 await s.save({method:'item/tool/call',id:13,params:{threadId:'thread-worker',turnId:'turn-worker',arguments:{question:'RAW_DECISION'}}});
 await s.save({method:'item/agentMessage/delta',params:{threadId:'thread-worker',turnId:'turn-worker',itemId:'delta',delta:'UNRETAINED_DELTA'}});
 await s.save(completion('worker',{id:'reasoning',type:'reasoning',text:'HIDDEN_REASONING'}));
 const corrupt=await s.save(completion('worker',visibleItem('corrupt','CORRUPT')));corrupt.entry.message.params.item.text='TAMPERED';await writeJson(corrupt.file,corrupt.entry);
 const before=await digestTree(s.root),observer=createInboxTaskObserver(s.runtime),result=await observer.read(s);
 assert.equal(result.nodes.length,1);assert.equal(result.nodes[0].historySource,'PERSISTED_COMPLETED_ITEMS');
 assert.deepEqual(result.nodes[0].messages.map(m=>m.text),['first public','final public']);
 assert.match(result.nodes[0].historyReason,/未保存的流式增量/);
 assert.deepEqual(await digestTree(s.root),before,'离线观察不能写第二份 transcript、lease、服务或 ledger');
 observer.close();
});

test('missing, copied or mismatched creation identity never reveals an inbox transcript',async t=>{
 const s=await inboxFixture(t);await s.save(completion('worker',visibleItem('public','private node output')));
 const original=structuredClone(s.bindings.assignments.worker);
 const variants=[
  {...original,backendCreation:undefined},
  {...original,backendCreation:{...original.backendCreation,serviceId:'foreign'}},
  {...original,nativeThreadId:'foreign-thread'},
  {...original,workspace:'/foreign/worktree'},
  {...original,executionAuthority:{...original.executionAuthority,taskId:'foreign-task'}},
  {...original,executionAuthority:{...original.executionAuthority,assignmentId:'foreign-node'}},
  {...original,backendRequest:{...original.backendRequest,operationId:'unreceipted-operation'}},
 ];
 for(const value of variants){s.bindings.assignments.worker=value;const page=(await createInboxTaskObserver(s.runtime).read(s)).nodes[0];assert.deepEqual(page.messages,[]);assert.equal(page.historySource,'UNVERIFIED');}
 s.bindings.assignments.worker=original;s.bindings.assignments.copy=structuredClone(original);
 assert.equal((await createInboxTaskObserver(s.runtime).read(s)).nodes[0].historySource,'UNVERIFIED');
 delete s.bindings.assignments.copy;
 const observer=createInboxTaskObserver(s.runtime);assert.equal((await observer.read(s)).nodes[0].messages.length,1);
 s.bindings.assignments.worker=variants[1];assert.equal((await observer.read(s)).nodes[0].messages.length,0,'绑定改变后不能复用旧观察缓存');
});

test('offline polling reads immutable files once, adds new completions, and isolates its own cursor',async t=>{
 const s=await inboxFixture(t);await s.save(completion('worker',visibleItem('one','one')));
 const reads=[],observer=createInboxTaskObserver(s.runtime,{read:async file=>{reads.push(file);return readDecisionFile(file);}});
 let page=(await observer.read(s)).nodes[0];assert.equal(page.messages.length,1);const firstReads=reads.length;
 const cursor={observerId:page.observerId,cursor:page.cursor};
 page=(await observer.read({...s,cursors:{worker:cursor}})).nodes[0];assert.deepEqual(page.messages,[]);assert.equal(reads.length,firstReads);
 await s.save(completion('worker',visibleItem('two','two')),{receivedOrder:'30'});
 page=(await observer.read({...s,cursors:{worker:cursor}})).nodes[0];assert.deepEqual(page.messages.map(m=>m.text),['two']);assert.equal(reads.length,firstReads+1);
 const reset=(await observer.read({...s,cursors:{worker:{observerId:'different-observer',cursor:99999}}})).nodes[0];assert.deepEqual(reset.messages.map(m=>m.text),['one','two']);
 assert.equal(reads.length,firstReads+1);observer.close();
});

test('late persisted completion cannot replace a newer completed item, and an original follow-up keeps both turns',async t=>{
 const s=await inboxFixture(t);await s.save(completion('worker',visibleItem('same','newer')),{receivedOrder:'30'});
 const observer=createInboxTaskObserver(s.runtime);await observer.read(s);
 await s.save(completion('worker',visibleItem('same','older')),{receivedOrder:'20'});
 assert.deepEqual((await observer.read(s)).nodes[0].messages.map(m=>m.text),['newer']);
 const b=s.bindings.assignments.worker;b.backendHistory=[b.backendRequest];b.backendRequest={operationId:'followup',generation,turnId:'turn-followup',state:'SUCCEEDED'};
 const key=decisionHash({assignmentId:'worker',operationId:'followup',method:'turn/start'});
 await writeJson(path.join(s.runtime,'decision-channel/calls',key+'.json'),{rpcId:key,assignmentId:'worker',operationId:'followup',method:'turn/start',serviceId,generation,connectionId,state:'SUCCEEDED',at:instant,params:{threadId:b.nativeThreadId},result:{turn:{id:'turn-followup'}}});
 await s.save(completion('worker',visibleItem('same','follow-up'),{turnId:'turn-followup'}),{receivedOrder:'40'});
 assert.deepEqual((await observer.read(s)).nodes[0].messages.map(m=>m.text),['newer','follow-up']);
});

test('a managed receiver reconnection needs the exact successful resume receipt for the original turn',async t=>{
 const s=await inboxFixture(t),observer=createInboxTaskObserver(s.runtime);
 await s.save(completion('worker',visibleItem('recovered','completed after receiver reconnected')),{connectionId:'resumed-receiver'});
 let page=(await observer.read(s)).nodes[0];assert.deepEqual(page.messages,[]);assert.equal(page.historyVerification,'PARTIAL_UNVERIFIED');assert.match(page.historyReason,/UNVERIFIED/);
 const params={threadId:'thread-worker',cwd:s.bindings.assignments.worker.workspace,excludeTurns:true};
 const key=decisionHash({assignmentId:'worker',operationId:'work-worker',method:'thread/resume',params,generation,connectionId:'resumed-receiver'});
 const value={rpcId:key,assignmentId:'worker',operationId:'work-worker',method:'thread/resume',params,serviceId,generation,connectionId:'resumed-receiver',state:'SUCCEEDED',at:instant,result:{thread:{id:'thread-worker'}}};
 await writeJson(path.join(s.runtime,'decision-channel/calls',key+'.json'),value);
 page=(await observer.read(s)).nodes[0];assert.equal(page.historyVerification,'VERIFIED');assert.deepEqual(page.messages.map(m=>m.text),['completed after receiver reconnected']);
 for(const patch of [{rpcId:'wrong-hash'},{assignmentId:'foreign-node'},{result:{thread:{id:'foreign-thread'}}}]){
  await writeJson(path.join(s.runtime,'decision-channel/calls',key+'.json'),{...value,...patch});
  const denied=(await createInboxTaskObserver(s.runtime).read(s)).nodes[0];assert.deepEqual(denied.messages,[]);assert.equal(denied.historyVerification,'PARTIAL_UNVERIFIED');
 }
});

async function attachFixture(t) {
 const root=await temporary(t);await writeJson(path.join(root,'instance/instance.json'),{id:randomUUID()});
 const request=value=>({operationId:randomUUID(),actor:'OFFLINE_FIXTURE',...value});
 const spec={key:'offline',clarified:true,type:'SYSTEM',title:'隔离离线观察测试',originalRequest:'仅模拟本地通知',goal:'验证只读历史',scope:['fixture'],deliverables:['测试'],acceptanceCriteria:['可见历史'],authorization:'仅隔离测试，无真实模型',discussion:{approved:true,summary:'fixture',feasibility:'fixture',approvedRequirements:['离线观察']}};
 const taskId=(await mutate(root,'publish',request({tasks:[spec]}))).taskIds[0];
 const run=await startRun(root,{capabilities:{backend:'PROJECT_APP_SERVER',delegation:true,closeVerified:true,agentCapacity:3,availableSlots:3,models:[{model:'gpt-5.6-sol',efforts:['xhigh']}]}});
 let task=(await readLedger(root)).tasks[taskId];
 const id=(await mutate(root,'schedule',request({runId:run.id,expectedVersions:{[taskId]:task.version},assignments:[{taskId,key:'worker',goal:'只读观察',deliverables:['测试'],acceptanceCriteria:['成功'],resources:[{kind:'OBJECT',key:taskId,access:'WRITE'}],execution:{longRunning:true,rationale:'fixture'}}]}))).assignments[0].id;
 const change=async(action,extra={})=>{task=(await readLedger(root)).tasks[taskId];return mutate(root,'assignment:'+action,request({runId:run.id,taskId,assignmentId:id,expectedVersions:{[taskId]:task.version},expectedAssignmentVersion:task.assignments[0].version,...extra}));};
 await change('dispatch');await change('start',{workspaceEvidence:'隔离运行态',nativeThreadId:'thread-fixture'});
 await updateBinding(root,run.id,id,b=>{b.workspace=root;b.backendServiceId=serviceId;b.backendGeneration=generation;b.backendCreation={serviceId,generation,threadId:b.nativeThreadId,createdAt:instant};b.backendRequest={operationId:'fixture-start',turnId:'turn-fixture',generation,state:'RUNNING'};});
 const loc=await location(root),bindings=await readBindings(loc),b=bindings.assignments[id];
 for(const method of ['thread/start','turn/start']){
  const key=decisionHash({assignmentId:id,operationId:b.backendRequest.operationId,method});await writeJson(path.join(loc.runtime,'decision-channel/calls',key+'.json'),{rpcId:key,assignmentId:id,operationId:b.backendRequest.operationId,method,serviceId,generation,connectionId,state:'SUCCEEDED',at:instant,params:method==='thread/start'?{cwd:root}:{threadId:b.nativeThreadId},result:method==='thread/start'?{thread:{id:b.nativeThreadId}}:{turn:{id:b.backendRequest.turnId}}});
 }
 const m={method:'item/completed',params:{threadId:b.nativeThreadId,turnId:b.backendRequest.turnId,item:visibleItem('saved','retained completed output')}};
 const hash=decisionHash({serviceId,generation,connectionId,message:m});await writeJson(path.join(loc.runtime,'decision-channel/inbox',hash+'.json'),{id:hash,serviceId,generation,connectionId,message:m,receivedAt:'2026-09-15T00:00:02.000Z',receivedOrder:'1',state:'APPLIED'});
 const runFile=path.join(loc.runtime,'run.json'),expired=JSON.parse(await readFile(runFile,'utf8'));expired.expiresAt='2000-01-01T00:00:00.000Z';await writeJson(runFile,expired);
 return {root,taskId,id,loc};
}

test('attach fallback with an expired coordinator is read-only and cannot enable sends',async t=>{
 const s=await attachFixture(t),before=await digestTree(s.root),calls=[];
 const client=await openAttachClient(s.root,s.taskId,{channel:async(_p,r)=>{calls.push(r);throw Error('original receiver unavailable');},send:async()=>{throw Error('snapshot must not send');}});
 for(let i=0;i<2;i++){
  const snapshot=await client.snapshot();assert.equal(snapshot.connection.status,'UNAVAILABLE');assert.equal(snapshot.nodes[0].historySource,'PERSISTED_COMPLETED_ITEMS');assert.equal(snapshot.nodes[0].canSend,false);
  assert(snapshot.nodes[0].messages.some(m=>m.text==='retained completed output'));assert(snapshot.nodes[0].messages.some(m=>/未保存的流式增量/.test(m.text)));
 }
 await client.close();assert.deepEqual(calls.map(c=>c.action),['observe','observe']);assert.deepEqual(await digestTree(s.root),before);
});

test('polling without a receiver leaves the runtime directory inventory unchanged',async t=>{
 const s=await attachFixture(t);
 await rm(path.join(s.loc.runtime,'decision-channel'),{recursive:true,force:true});
 const before=await digestTree(s.root),client=await openAttachClient(s.root,s.taskId);
 const snapshot=await client.snapshot();await client.close();
 assert.equal(snapshot.connection.status,'UNAVAILABLE');assert.equal(snapshot.nodes[0].canSend,false);
 assert.deepEqual(await digestTree(s.root),before,'只读路径不得创建 server、decision-channel、原执行 scope 或租约');
 assert(!(await readdir(s.loc.runtime)).includes('decision-channel'));assert(!(await readdir(s.loc.runtime)).includes('server'));
});

test('reconnection and live observer replacement restart only live cursors, preserving stable item identities',async t=>{
 const s=await attachFixture(t),calls=[];let phase='live-a';
 const client=await openAttachClient(s.root,s.taskId,{channel:async(_p,r)=>{
  calls.push(structuredClone(r));if(phase==='offline')throw Error('receiver disconnected');
  const a=phase==='live-a',observerId=a?'observer-a':'observer-b',cursor=a?400:1;
  const messages=(r.cursors[s.id]||0)<cursor?[{id:'turn-fixture:saved',type:'agentMessage',text:a?'live before disconnect':'retained completed output',sequence:cursor}]:[];
  return {nodes:[{id:s.id,observerId,cursor,messages,nativeStatus:'active'}]};
 }});
 let snapshot=await client.snapshot();assert.equal(snapshot.nodes[0].historySource,'LIVE');assert.equal(snapshot.nodes[0].canSend,true);
 await client.snapshot();assert.equal(calls.at(-1).cursors[s.id],400);
 phase='offline';snapshot=await client.snapshot();assert.equal(snapshot.nodes[0].historySource,'PERSISTED_COMPLETED_ITEMS');assert.equal(snapshot.nodes[0].canSend,false);
 phase='live-b';snapshot=await client.snapshot();assert.deepEqual(calls.at(-1).cursors,{});assert.equal(snapshot.nodes[0].historySource,'LIVE');assert.equal(snapshot.nodes[0].messages.filter(m=>m.id==='turn-fixture:saved').length,1);
 phase='live-a';await client.snapshot();assert.deepEqual(calls.at(-1).cursors,{},'observerId 改变必须以 0 补读，不能沿用另一个序列');
 await client.close();
});
