import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {mutate,readLedger,startRun,updateBinding} from '../tools/task-ledger.mjs';
import {syncBackend,requestFingerprint} from '../tools/task-backend.mjs';
import {decisionHash} from '../tools/task-decision-protocol.mjs';
import {closeNativeThread} from '../tools/task-native.mjs';

const request=x=>({operationId:randomUUID(),actor:'RECOVERY_FIXTURE',...x});
async function fixture(t,{threadStatus='idle',error='list_turns is not supported yet',final=true,complete=true,foreign=false}={}) {
 assert(process.env.REVIEW_TASK_DIR,'Use the managed process runner');
 const root=await mkdtemp(path.join(process.env.REVIEW_TASK_DIR,'observed-turn-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(path.join(root,'instance'),{recursive:true});
 await writeFile(path.join(root,'instance/instance.json'),JSON.stringify({id:randomUUID()}));
 const published=await mutate(root,'publish',request({task:{clarified:true,type:'SYSTEM',title:'Recovery fixture',originalRequest:'Verify exact original result recovery',goal:'Preserve original operations',scope:['isolated fixture'],deliverables:['evidence'],acceptanceCriteria:['original result verified'],authorization:'isolated fake RPC only',discussion:{approved:true,summary:'isolated recovery tests',feasibility:'fake transport',approvedRequirements:['no real model']}}}));
 const run=await startRun(root,{capabilities:{delegation:true,closeVerified:true,agentCapacity:1,models:[{model:'gpt-5.6-sol',efforts:['xhigh']}]}});
 const task=(await readLedger(root)).tasks[published.taskId];
 const schedule=await mutate(root,'schedule',request({runId:run.id,expectedVersions:{[task.id]:task.version},assignments:[{taskId:task.id,key:'original',goal:'recover',deliverables:['result'],acceptanceCriteria:['result'],execution:{rationale:'isolated recovery'},resources:[{kind:'OBJECT',key:'fixture/read',access:'READ',version:'v1'}]}]}));
 const assignmentId=schedule.assignments[0].id,threadId='original-thread',turnId='original-turn',operationId='original-operation',serviceId='fixture-service',generation='original-generation',connectionId='original-connection';
 const runtime=path.join(root,'instance/runtime/task-execution'),calls=[];
 await updateBinding(root,run.id,assignmentId,b=>Object.assign(b,{workspace:root,backendServiceId:serviceId,nativeThreadId:threadId,backendCreation:{threadId,serviceId},backendRequest:{operationId,turnId,generation,state:'RUNNING'}}));
 await mkdir(path.join(runtime,'server'),{recursive:true});
 await writeFile(path.join(runtime,'server/server.json'),JSON.stringify({serviceId,generation:'recovered-generation'}));
 const key=decisionHash({assignmentId,operationId,method:'turn/start'}),receipt={rpcId:key,assignmentId,operationId,method:'turn/start',serviceId,generation,connectionId,state:'SUCCEEDED',params:{threadId},result:{turn:{id:turnId}},at:'2026-01-01T00:00:00.000Z'};
 await mkdir(path.join(runtime,'decision-channel/calls'),{recursive:true});
 await writeFile(path.join(runtime,'decision-channel/calls',key+'.json'),JSON.stringify(receipt));
 const add=async message=>{const identity={serviceId,generation:foreign?'foreign-generation':generation,connectionId,message},id=decisionHash(identity),file=path.join(runtime,'decision-channel/inbox',id+'.json');await mkdir(path.dirname(file),{recursive:true});await writeFile(file,JSON.stringify({...identity,id,receivedAt:'2026-01-01T00:00:10.000Z',state:'APPLIED'}));return file;};
 const answer={summary:'original successful result',artifacts:['owned-report.json'],acceptance:[{criterion:0,evidence:'original'}],completedSteps:['done'],nextSteps:[]};
 const item={type:'agentMessage',id:'final-item',phase:'final_answer',text:JSON.stringify(answer)};
 const completionFile=complete?await add({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed',items:final?[item]:[],error:null}}}):null;
 if(final)await add({method:'item/completed',params:{threadId,turnId,item}});
 const client={close(){},async flush(){},async call(method,params){calls.push({method,params});if(method==='thread/read'&&!params.includeTurns)return {thread:{id:threadId,cwd:root,status:{type:threadStatus}}};if(method==='thread/read'||method==='thread/turns/list')throw Error(error);throw Error('Unexpected RPC '+method);}};
 const sync=()=>syncBackend(root,run.id,assignmentId,{verifyServer:async()=>({record:{generation:'recovered-generation'},client})});
 return {root,runtime,run,assignmentId,operationId,completionFile,receipt,key,add,calls,sync,answer};
}

test('service restart recovers the exact completion from original persisted notifications without starting a turn',async t=>{
 const f=await fixture(t),result=await f.sync();
 assert.equal(result.status,'SUCCEEDED');assert.equal(result.operationId,f.operationId);assert.equal(result.resultReady,true);
 const file=path.join(f.runtime,'backend-results/operations',requestFingerprint({assignmentId:f.assignmentId,operationId:f.operationId})+'.json');
 const saved=JSON.parse(await readFile(file,'utf8'));assert.deepEqual(saved.result,f.answer);assert.equal(saved.source.kind,'PERSISTED_ORIGINAL_NOTIFICATION');
 assert.equal(saved.source.generation,'original-generation');assert.equal(saved.generation,'recovered-generation');
 assert(f.calls.every(c=>['thread/read','thread/turns/list'].includes(c.method)));
});

test('reports or final messages alone do not prove completion, and missing final text cannot be accepted',async t=>{
 const noCompletion=await fixture(t,{complete:false});assert.equal((await noCompletion.sync()).status,'RESULT_UNKNOWN');
 const noText=await fixture(t,{final:false});const result=await noText.sync();assert.equal(result.status,'SUCCEEDED');assert.equal(result.resultReady,false);
 const foreign=await fixture(t,{foreign:true});assert.equal((await foreign.sync()).status,'RESULT_UNKNOWN');
});

test('an active or unobservable original execution is never replaced by a stored completion',async t=>{
 const active=await fixture(t,{threadStatus:'active'});await assert.rejects(active.sync,/BACKEND_TURN_UNKNOWN/);
 const lost=await fixture(t,{error:'connection lost'});await assert.rejects(lost.sync,/connection lost/);
});

test('changed notification bytes, mismatched start receipts and conflicting completions fail closed',async t=>{
 const changed=await fixture(t),entry=JSON.parse(await readFile(changed.completionFile,'utf8'));entry.message.params.turn.status='failed';await writeFile(changed.completionFile,JSON.stringify(entry));await assert.rejects(changed.sync,/BACKEND_NOTIFICATION_INTEGRITY/);
 const receipt=await fixture(t);await writeFile(path.join(receipt.runtime,'decision-channel/calls',receipt.key+'.json'),JSON.stringify({...receipt.receipt,operationId:'different-operation'}));await assert.rejects(receipt.sync,/BACKEND_NOTIFICATION_RECEIPT/);
 const conflict=await fixture(t);await conflict.add({method:'turn/completed',params:{threadId:'original-thread',turn:{id:'original-turn',status:'interrupted',items:[],error:null}}});await assert.rejects(conflict.sync,/BACKEND_NOTIFICATION_CONFLICT/);
});

test('cleanup resumes original metadata without unsupported full-history hydration, then verifies unload',async()=>{
 let loaded=false;const calls=[];
 const client={async call(method,params){calls.push({method,params});
  if(method==='thread/goal/get')return {goal:null};
  if(method==='thread/read'){assert.equal(params.includeTurns,false);return {thread:{id:'original',cwd:'/fixture',status:{type:loaded?'idle':'notLoaded'}}};}
  if(method==='thread/resume'){assert.equal(params.threadId,'original');assert.equal(params.excludeTurns,true);assert(!('history' in params));loaded=true;return {thread:{id:'original'}};}
  if(method==='thread/backgroundTerminals/list')return {data:[]};
  if(method==='thread/loaded/list')return {data:loaded?['original']:[]};
  if(method==='thread/archive'){loaded=false;return {};}
  throw Error('Unexpected RPC '+method);
 }};
 const result=await closeNativeThread(client,'original',null,{resumeIfUnloaded:true,verifyOwnership:async()=>{}});
 assert.equal(result.verified,true);assert.equal(result.history,'PRESERVED');assert.equal(loaded,false);
 assert(!calls.some(c=>c.method==='turn/start'||c.method==='thread/turns/list'));
});

test('cleanup queries the loaded original runtime after an explicit hydration failure without retrying resume',async()=>{
 let loaded=false,resumes=0;const client={async call(method,params){
  if(method==='thread/read')return {thread:{id:'original',cwd:'/fixture',status:{type:loaded?'idle':'notLoaded'}}};
  if(method==='thread/resume'){resumes++;loaded=true;throw Error('list_turns is not supported yet');}
  if(method==='thread/goal/get'){assert(loaded,'Goal requires a loaded runtime');return {goal:null};}
  if(method==='thread/backgroundTerminals/list'){assert(loaded);return {data:[]};}
  if(method==='thread/loaded/list')return {data:loaded?['original']:[]};
  if(method==='thread/archive'){loaded=false;return {};}
  throw Error('Unexpected RPC '+method);
 }};
 const result=await closeNativeThread(client,'original',null,{resumeIfUnloaded:true,verifyOwnership:async()=>{}});
 assert.equal(result.verified,true);assert.equal(resumes,1);assert.equal(loaded,false);
});

test('cleanup retains uncertainty when resume times out or explicit history failure leaves the runtime unloaded',async()=>{
 for(const error of ['connection lost','list_turns is not supported yet']){
  const calls=[],client={async call(method){calls.push(method);if(method==='thread/read')return {thread:{id:'original',cwd:'/fixture',status:{type:'notLoaded'}}};if(method==='thread/resume')throw Error(error);throw Error('Unexpected RPC '+method);}};
  await assert.rejects(closeNativeThread(client,'original',null,{resumeIfUnloaded:true,verifyOwnership:async()=>{}}),new RegExp(error));
  assert.equal(calls.filter(x=>x==='thread/resume').length,1);assert(!calls.includes('thread/archive'));assert(!calls.includes('turn/start'));
 }
});
