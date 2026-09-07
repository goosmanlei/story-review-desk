import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import ts from 'typescript';
import * as epoch from '../host/instance-runtime/execution-epoch.mjs';
import {createInstanceRepository,openInstanceRepository,restoreInstanceRepository,importRepositoryState} from '../host/instance-runtime/index.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),nativeRequire=createRequire(import.meta.url);
const h=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function moduleLoader(overrides={}){
 const cache=new Map();
 function load(filename){
  if(cache.has(filename))return cache.get(filename).exports;
  const module={exports:{}};cache.set(filename,module);
  const source=ts.transpileModule(readFileSync(filename,'utf8'),{fileName:filename.replace(/\.mjs$/,'.ts'),compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  new Function('require','module','exports',source)(specifier=>{
   if(Object.hasOwn(overrides,specifier))return overrides[specifier];
   if(!specifier.startsWith('.'))return nativeRequire(specifier);
   return load(path.resolve(path.dirname(filename),/\.[cm]?[jt]sx?$/.test(specifier)?specifier:specifier+'.ts'));
  },module,module.exports);
  return module.exports;
 }return load;
}
const gate=moduleLoader()(path.join(root,'app/gate-evaluation.ts'));
const restored={instanceId:'instance:fixture',runtimeEpoch:epoch.restoredRuntimeEpoch(randomUUID())};
const requestBase={eventId:'auth:old',executionRequestId:'xreq_old',snapshotId:'snapshot:current',workItemId:'work:a',familyId:'family:a',executionDefinitionId:'definition:a',executionDefinitionHash:'a'.repeat(64),callPackageHash:'a'.repeat(64),executor:'CODEX',authorized:true,maxOutputs:1,inputBindings:[],inputBindingsHash:h([]),requestState:'CLAIMED',status:'CLAIMED'};
const definition={id:'definition:a',definitionStatus:'DEFINED',definitionHash:'a'.repeat(64),declaredGate:'READY_TO_START',output:{assetFamilyRef:'family:a'}};
const latest=events=>[...new Map([...events].reverse().map(event=>[event.executionRequestId,event])).values()];
function fixture({requests=[{...requestBase}],runs=[],runtime=restored}={}){
 const f={runtime,requests,runs,candidates:[],definitions:[definition],writes:0,beforeLock:null,data:{snapshotId:'snapshot:current',productionModel:{assetFamilies:[{id:'family:a'}]}}};
 const operations=()=>({executionRuntime:f.runtime,executionRequests:{events:f.requests},candidates:{events:f.candidates},runs:{events:f.runs,latestByRunId:[...new Map([...f.runs].reverse().map(event=>[event.runId,event])).values()].map(event=>({event}))},stateProjection:{workItemsById:{'work:a':{lifecycleState:'READY_TO_START'}},materialWorkItemsById:{},assetFamiliesById:{},assetVersionsById:{}},etag:'"fixture"',mutationEtag:'"fixture"',operationRevision:'op:fixture'});
 class HttpError extends Error{constructor(status,message,details){super(message);this.status=status;this.details=details;}}
 const store={
  HttpError,assertStableId:v=>String(v),assertSha256:v=>{assert.match(v,/^[a-f0-9]{64}$/);return v;},optionalString:v=>v==null?'':String(v),
  errorResponse:e=>Response.json({error:e.message,details:e.details},{status:e.status||500}),jsonResponse:(body,init)=>Response.json(body,init),
  validateMutationRequest:async req=>({data:f.data,idempotencyKey:req.headers.get('Idempotency-Key')||'fixture',ifMatch:'"fixture"'}),
  currentExecutionRuntime:async()=>f.runtime,listAllEvents:async kind=>kind==='run'?f.runs:kind==='execution-request'?f.requests:f.candidates,
  recipeCatalog:async()=>({executionDefinitions:f.definitions}),eventLimit:()=>100,reviewData:async()=>f.data,operationalSnapshot:async()=>({...operations(),operationRevision:'op:fixture'}),
  mutationRequestHash:(_kind,body)=>h(body),replayIdempotentEvent:async()=>null,
  appendEvent:async(kind,_id,_hash,_etag,body,_schema,validate)=>{
   if(f.beforeLock){f.beforeLock();f.beforeLock=null;}
   await validate(operations());f.writes++;
   const event={...body,eventId:'event:'+f.writes};(kind==='run'?f.runs:f.requests).unshift(event);return{event,replayed:false,operations:operations()};
  },
 };
 const workflow={
  projectedExecutionRequests:latest,executionRequestExecutors:new Set(['CODEX','USER_EXTERNAL']),executionRequestStatuses:new Set(['AUTHORIZED','CLAIMED','CANCELLED']),
  executionRequestId:String,latestAggregateEvent:(events,key,id)=>events.find(e=>e[key]===id),
  canonicalInputBindings:()=>[],inputBindingsHash:h,assertCallPackageHash:(value,d)=>{if(value!==d.definitionHash)throw new HttpError(409,'stale package');return value;},
  definitionForWorkItem:()=>({workItem:{outputAssetRef:'family:a'},definition}),
  executionEligibilityReasons:gate.executionEligibilityReasons,
  assertExecutionEligibility:(op,d,req)=>{const reasons=gate.executionEligibilityReasons(op,d,req);if(reasons.length)throw new HttpError(422,reasons.join(','));},
  assertExecutionRequestBinding:(req,binding)=>{for(const key of ['executionRequestId','executionDefinitionId','callPackageHash'])if(req[key]!==binding[key])throw new HttpError(409,'request binding mismatch');},
  unresolvedResultUnknownRunsForWorkItem:(_requests,events)=>[...new Map([...events].reverse().map(event=>[event.runId,event])).values()].filter(event=>event.runState==='RESULT_UNKNOWN'),
 };
 const load=moduleLoader({'../_store':store,'../_workflow':workflow});
 f.route=name=>load(path.join(root,'app/api/v8',name,'route.ts'));
 f.post=async(name,body)=>f.route(name).POST(new Request('http://localhost/api/v8/'+name,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'fixture:'+Math.random()},body:JSON.stringify(body)}));
 f.authorize=()=>({action:'AUTHORIZE',snapshotId:f.data.snapshotId,workItemId:'work:a',familyId:'family:a',executor:'CODEX',authorized:true,maxOutputs:1,callPackageHash:definition.definitionHash,inputBindings:[]});
 f.run=(state,extra={})=>({snapshotId:requestBase.snapshotId,executionRequestId:requestBase.executionRequestId,executionDefinitionId:requestBase.executionDefinitionId,callPackageHash:requestBase.callPackageHash,state,note:'核查原平台请求，不调用模型',...extra});
 return f;
}

test('legacy authorization survives ordinary restart but no legacy or other-epoch request survives restoration',()=>{
 const legacy={instanceId:restored.instanceId,runtimeEpoch:randomUUID()};
 assert.equal(epoch.executionRuntimeReason(legacy,requestBase),null);
 assert.equal(epoch.executionRuntimeReason(restored,requestBase),'RESTORED_REQUEST_REQUIRES_NEW_AUTHORIZATION');
 const bound={...requestBase,authorizationRuntime:restored};
 assert.equal(epoch.executionRuntimeReason({...restored},bound),null);
 assert.notEqual(epoch.executionRuntimeReason({...restored,runtimeEpoch:epoch.restoredRuntimeEpoch(randomUUID())},bound),null);
 assert.notEqual(epoch.executionRuntimeReason({...restored,instanceId:'instance:other'},bound),null);
 assert.equal(epoch.executionRuntimeReason(restored,{workItemId:'prospective'}),null);
 assert.equal(epoch.executionRuntimeReason(restored,{...bound,authorizationRuntime:{...restored,extra:true}}),'EXECUTION_RUNTIME_BINDING_INVALID');
});

test('new AUTHORIZE freezes server instance/epoch and still requires explicit user authorization',async()=>{
 const f=fixture({requests:[]}),response=await f.post('execution-requests',{...f.authorize(),authorizationRuntime:{instanceId:'forged',runtimeEpoch:'forged'}});
 assert.equal(response.status,201,await response.clone().text());assert.deepEqual(f.requests[0].authorizationRuntime,restored);
 const denied=await f.post('execution-requests',{...f.authorize(),authorized:false});assert.equal(denied.status,422);assert.equal(f.writes,1);
});

test('claim and execution queue exclude old authorization; newly bound claim succeeds',async()=>{
 const f=fixture({requests:[{...requestBase,requestState:'AUTHORIZED',status:'AUTHORIZED'}]});
 let result=await f.post('execution-requests',{action:'CLAIM',snapshotId:f.data.snapshotId,executionRequestId:requestBase.executionRequestId,claimedBy:'fixture'});
 assert.equal(result.status,422);assert.equal(f.writes,0);
 const queued=await f.route('execution-queue').GET(new Request('http://localhost/api/v8/execution-queue'));assert.equal((await queued.json()).count,0);
 f.requests[0].authorizationRuntime=restored;
 result=await f.post('execution-requests',{action:'CLAIM',snapshotId:f.data.snapshotId,executionRequestId:requestBase.executionRequestId,claimedBy:'fixture'});
 assert.equal(result.status,201,await result.clone().text());assert.deepEqual(f.requests[0].authorizationRuntime,restored);
});

test('authorization restore race fails within locked validation',async()=>{
 const f=fixture({requests:[]});f.beforeLock=()=>{f.runtime={...restored,runtimeEpoch:epoch.restoredRuntimeEpoch(randomUUID())};};
 const result=await f.post('execution-requests',f.authorize());assert.equal(result.status,422);assert.equal(f.writes,0);
});

test('old new-run attempts and old PLANNED/SUBMITTED/RUNNING advances are blocked without writes',async()=>{
 for(const previousState of ['', 'PLANNED','SUBMITTED','RUNNING']){
  const f=fixture({runs:previousState?[{eventId:'run:event',runId:'run_old',...requestBase,runState:previousState}]:[]});
  for(const next of ['PLANNED','SUBMITTED','RUNNING']){
   const response=await f.post('runs',f.run(next,previousState?{runId:'run_old'}:{}));
   assert.equal(response.status,409,await response.clone().text());assert.equal(f.writes,0);
  }
 }
});

test('current work exposes restored unfinished runs across historical snapshots, never completed history',()=>{
 const old={...requestBase,snapshotId:'snapshot:old'},success={...old,executionRequestId:'xreq_success'};
 const terminal={...success,runId:'run_done',runState:'SUCCEEDED'},running={...old,runId:'run_old',runState:'RUNNING'};
 const before=JSON.stringify([old,success,running,terminal]);
 let rows=epoch.executionRequestsForRuntimeQueue(restored,[],[old,success],[running,terminal]);
 assert.equal(rows.length,1);assert.equal(rows[0].executionRequestId,old.executionRequestId);assert.equal(rows[0].restoreBlockedRun.runId,running.runId);
 assert.equal(JSON.stringify([old,success,running,terminal]),before);
 rows=epoch.executionRequestsForRuntimeQueue(restored,[],[old,success],[{...running,runState:'FAILED'},running,terminal]);assert.equal(rows.length,0);
 rows=epoch.executionRequestsForRuntimeQueue({instanceId:restored.instanceId,runtimeEpoch:'ordinary'},[],[old],[running]);assert.equal(rows.length,0);
});

test('restore retains success history and permits only explicit evidence-based reconciliation, even after definition/snapshot changes',async()=>{
 const f=fixture({runs:[{...requestBase,eventId:'run:old',runId:'run_old',runState:'RUNNING'}]});
 const historicalBytes=JSON.stringify(f.runs[0]);f.data.snapshotId='snapshot:new';f.definitions=[];
 let result=await f.post('runs',f.run('RUNNING',{runId:'run_old'}));assert.equal(result.status,409);
 result=await f.post('runs',f.run('SUCCEEDED',{runId:'run_old'}));assert.equal(result.status,422);
 result=await f.post('runs',f.run('RESULT_UNKNOWN',{runId:'run_old'}));assert.equal(result.status,201,await result.clone().text());
 result=await f.post('runs',f.run('SUCCEEDED',{runId:'run_old',reconciliationEvidence:{requestId:'provider-request',logId:'provider-log',providerStatusCheckedAt:new Date().toISOString(),providerConclusion:'SUCCEEDED'}}));
 assert.equal(result.status,201,await result.clone().text());
 assert.equal(f.runs[0].runState,'SUCCEEDED');assert.equal(JSON.stringify(f.runs.at(-1)),historicalBytes);
 result=await f.post('runs',f.run('SUBMITTED',{runId:'run_old'}));assert.equal(result.status,409);
});

test('restored pending provider work blocks fresh authorization across snapshots until reconciled',async()=>{
 const old={...requestBase,snapshotId:'snapshot:old'};
 const f=fixture({requests:[old],runs:[{...old,runId:'run_old',runState:'SUBMITTED'}]});
 let result=await f.post('execution-requests',f.authorize());assert.equal(result.status,409);assert.equal(f.writes,0);
 f.runs[0]={...f.runs[0],runState:'FAILED',reconciliationEvidence:{requestId:'provider',logId:'log',providerStatusCheckedAt:new Date().toISOString(),providerConclusion:'FAILED'}};
 result=await f.post('execution-requests',f.authorize());assert.equal(result.status,201,await result.clone().text());
});

test('old unstarted authorization may be explicitly cancelled without resurrecting its bindings',async()=>{
 const old={...requestBase,snapshotId:'snapshot:old',requestState:'AUTHORIZED'},f=fixture({requests:[old]});f.definitions=[];
 const result=await f.post('execution-requests',{action:'CANCEL',snapshotId:old.snapshotId,executionRequestId:old.executionRequestId,note:'恢复后撤销旧授权'});
 assert.equal(result.status,201,await result.clone().text());assert.equal(f.requests[0].requestState,'CANCELLED');assert.equal(f.requests[0].authorizationRuntime,undefined);
});

test('SQLite backup restore, archive import and explicit epoch reset preserve immutable business bytes',async()=>{
 const directory=mkdtempSync(path.join(os.tmpdir(),'restore-execution-gate-')),instanceId='instance:offline-restore';let repos=[];
 try{
  const dbPath=path.join(directory,'source.sqlite'),profile={instanceId,projectId:'project:offline',episodePlanId:'plan:offline',title:'隔离恢复测试'};
  const repo=createInstanceRepository({dbPath,instanceId,profile});repos.push(repo);
  const original=repo.getMetadata().runtimeEpoch,bytes=Buffer.from(' { "eventId":"xreq:history", "eventKind":"execution-request", "executionRequestId":"xreq_old", "requestState":"AUTHORIZED", "recordedAt":"2026-09-08T00:00:00Z", "note":"保持原始字节" }\r\n');
  await repo.writeTransaction(tx=>{tx.importEvent({bytes});tx.publishRelease({snapshotBytes:Buffer.from(JSON.stringify({snapshotId:'snapshot:offline'})),recipesBytes:Buffer.from(JSON.stringify({snapshotId:'snapshot:offline'})),expectedReleaseId:null,sourceRevisionIds:[]});});
  const archive=repo.exportState(),historyBefore=archive.tables.domain_events;
  const backup=repo.backupTo(path.join(directory,'backup.sqlite'));
  const restoredRepo=await restoreInstanceRepository({backupPath:backup.path,dbPath:path.join(directory,'restored.sqlite'),instanceId,expectedSha256:backup.sha256});repos.push(restoredRepo);
  const imported=await importRepositoryState({dbPath:path.join(directory,'imported.sqlite'),instanceId,archive});repos.push(imported);
  for(const target of [restoredRepo,imported]){
   const meta=target.getMetadata();assert.match(meta.runtimeEpoch,/^restore_v1_/);assert.notEqual(meta.runtimeEpoch,original);
   assert.deepEqual(target.exportState().tables.domain_events,historyBefore);
   assert.equal(epoch.executionRuntimeReason(meta,requestBase),'RESTORED_REQUEST_REQUIRES_NEW_AUTHORIZATION');
  }
  const before=repo.getMetadata().runtimeEpoch;await repo.close();repos=repos.filter(item=>item!==repo);
  const restarted=openInstanceRepository({dbPath,instanceId});repos.push(restarted);assert.equal(restarted.getMetadata().runtimeEpoch,before);
  await restarted.writeTransaction(tx=>tx.resetRuntimeEpoch());assert.match(restarted.getMetadata().runtimeEpoch,/^restore_v1_/);
 }finally{for(const repo of repos)await repo.close();rmSync(directory,{recursive:true,force:true});}
});

test('Postgres restore has no epoch-preserving import bypass and all restore paths use the gate identity',()=>{
 const postgres=readFileSync(path.join(root,'host/instance-runtime/postgres.mjs'),'utf8');
 assert.match(postgres,/options\.resetEpoch===false[\s\S]*RESTORE_EPOCH_REQUIRED/);
 assert.equal((postgres.match(/restoredRuntimeEpoch\(randomUUID\(\)\)/g)||[]).length,2);
 const sqlite=readFileSync(path.join(root,'host/instance-runtime/index.mjs'),'utf8');
 assert.equal((sqlite.match(/restoredRuntimeEpoch\(randomUUID\(\)\)/g)||[]).length,3);
 for(const file of ['scripts/instance-transfer.mjs','scripts/instance-pg-transfer.mjs','scripts/instance-git-export.mjs'])assert.match(readFileSync(path.join(root,file),'utf8'),/OLD_REQUESTS_BLOCKED_NEW_AUTHORIZATION_REQUIRED/);
});


test('PostgreSQL transaction reset fences old authorization and epoch-preserving import fails before connecting',async()=>{
 let epochValue='legacy-epoch',connects=0,updates=0;
 const client={release(){},async query(sql,params=[]){
  if(sql.includes('pg_try_advisory'))return{rows:[{held:true}]};
  if(sql.startsWith('UPDATE repository_meta SET runtime_epoch=')){epochValue=params[0];updates++;return{rows:[]};}
  if(sql.includes('FROM repository_meta'))return{rows:[{singleton:1,instance_id:restored.instanceId,runtime_epoch:epochValue,repository_revision:1,current_release_id:null}]};
  return{rows:[]};
 }};
 class Pool{on(){}async connect(){connects++;return client;}async end(){}}
 const postgres=moduleLoader({pg:{default:{Pool}}})(path.join(root,'host/instance-runtime/postgres.mjs'));
 await assert.rejects(postgres.importPostgresState({resetEpoch:false}),e=>e.code==='RESTORE_EPOCH_REQUIRED');assert.equal(connects,0);
 const repository=new postgres.PostgresRepository({instanceId:restored.instanceId,connection:{}});
 const meta=await repository.writeTransaction(tx=>tx.resetRuntimeEpoch());
 assert.equal(updates,1);assert.match(meta.runtimeEpoch,/^restore_v1_/);
 assert.equal(epoch.executionRuntimeReason(meta,requestBase),'RESTORED_REQUEST_REQUIRES_NEW_AUTHORIZATION');await repository.close();
});

test('restored AI review cost receipts cannot be claimed again and do not invoke a model',async()=>{
 const {InstanceWorkerLedger}=moduleLoader()(path.join(root,'workers/instance-ledger.mjs'));
 for(const state of ['STARTED','UNKNOWN','SUCCEEDED_TOMBSTONE']){
  const receipt={schemaVersion:'1.0',requestId:'request:old',requestHash:'a'.repeat(64),state},bytes=Buffer.from(JSON.stringify(receipt)),row={bytes,sha256:createHash('sha256').update(bytes).digest('hex'),revisionId:'receipt:old',deleted:false};
  let writes=0;const repo={getAux:async()=>row,writeTransaction:async fn=>fn({getAux:async()=>row,putAux:async()=>{writes++;throw Error('Old receipt must not be rewritten');}})};
  const ledger=Object.create(InstanceWorkerLedger.prototype);Object.assign(ledger,{repository:Promise.resolve(repo),namespace:'worker-material-review',cache:new Map(),validate:value=>value,unavailable:()=>Error('unavailable')});
  const result=await ledger.claim(receipt.requestId,receipt.requestHash);assert.equal(result.claimed,false);assert.equal(result.record.state,state);assert.equal(writes,0);
 }
});
