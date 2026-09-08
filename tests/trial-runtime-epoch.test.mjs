import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {canonicalJson,sha256} from '../host/instance-runtime/bytes.mjs';
import * as trial from '../host/instance-runtime/trial.mjs';

// Pure transactional fixture exercises the production adapter without a model,
// a formal instance, or a claim that a database restore itself occurred here.
async function fixture(t){
 const root=await mkdtemp(path.join(os.tmpdir(),'trial-runtime-epoch-'));t.after(()=>rm(root,{recursive:true,force:true}));
 let aux=new Map(),serial=0;const view={instanceId:'instance-fixture',runtimeEpoch:'epoch-before',releaseId:'release-fixture',snapshot:{snapshotId:'snapshot-fixture'}};
 const tx={readView:async()=>structuredClone(view),getAux:async(ns,key)=>aux.get(ns+'|'+key)||null,listAux:async(ns,{prefix=''}={})=>[...aux.values()].filter(r=>r.namespace===ns&&r.key.startsWith(prefix)),putAux:async value=>{const key=value.namespace+'|'+value.key,old=aux.get(key);assert.equal(value.expectedRevisionId,old?.revisionId??null);const row={...value,revisionId:'aux-'+(++serial),metadata:value.metadata||{},deleted:false};aux.set(key,row);return row;},importEvent:async()=>{},readDocumentRevision:async id=>id==='source-fixture'?{revisionId:id,sha256:sha256('source'),documentId:'source'}:null,listMedia:async()=>[]};
 const repo={backend:'postgres',options:{root},readTransaction:fn=>fn(tx),writeTransaction:async fn=>{const prior=structuredClone(aux);try{return await fn(tx);}catch(e){aux=prior;throw e;}}};
 const scopeId='scope-fixture',scopeBody={expectedReleaseId:view.releaseId,expectedIndexRevisionId:null,scope:{id:scopeId,title:'试制',projectTitle:'隔离',countsTowardFormalProject:false},authorization:{id:'authorization-scope',userInstruction:'仅隔离测试',maxOutputsPerRecipe:1},limits:{IMAGE:10,AUDIO:0,VIDEO:0}};
 await trial.instanceTrialPrepareScope(repo,scopeBody,{idempotencyKey:'scope-fixture-key'});
 const options=async key=>({root,scopeId,ifMatch:(await trial.instanceTrialInspect(repo,{scopeId})).mutationEtag,idempotencyKey:key});
 const recipe=id=>({id:'recipe-'+id,subjectId:'subject-'+id,label:'测试图像',mediaKind:'IMAGE',model:'GPT-IMG-2',fullPrompt:'完整的测试说明',inputBindings:[],sourceBindings:[{documentId:'source',revisionId:'source-fixture',sha256:sha256('source')}],authorization:{id:'authorization-'+id,userInstruction:'一个测试候选',maxOutputs:1},output:{relativePath:'media/_review_pending/'+id+'/test.png',versionId:'subject-'+id+'@V1'},runtimeBlockers:[]});
 const prepare=async id=>trial.instanceTrialPrepareRecipe(repo,{recipe:recipe(id)},await options('prepare-'+id));
 const reserve=async id=>trial.instanceTrialReserve(repo,{recipeId:'recipe-'+id,workerId:'worker-fixture',runtimeEpoch:view.runtimeEpoch},await options('reserve-'+id));
 const binding=r=>Object.fromEntries(['requestId','leaseToken','fencingToken','inputHash','promptHash','runtimeEpoch'].map(k=>[k,r.execution[k]]));
 return {repo,view,scopeId,scopeBody,options,recipe,prepare,reserve,binding,restore:()=>{view.runtimeEpoch='restore_v1_epoch-after';},forgetScopeEpoch:()=>{const entry=aux.get('local-trial:'+scopeId+'|meta/config'),row=JSON.parse(entry.bytes),config=JSON.parse(row.value);delete config.runtimeEpoch;row.value=canonicalJson(config);entry.bytes=canonicalJson(row);},inspect:()=>trial.instanceTrialInspect(repo,{scopeId}),raw:()=>canonicalJson([...aux.values()])};
}

test('reserve input, recipe authorization and lease carry exact instance and epoch, and omitted request epochs fail closed',async t=>{
 const f=await fixture(t);await f.prepare('one');
 const before=f.raw();await assert.rejects(trial.instanceTrialReserve(f.repo,{recipeId:'recipe-one',workerId:'worker-fixture'},await f.options('reserve-no-epoch')),{code:'RUNTIME_EPOCH_CONFLICT'});assert.equal(f.raw(),before);
 const r=await f.reserve('one');assert.equal(r.execution.instanceId,f.view.instanceId);assert.equal(r.execution.runtimeEpoch,f.view.runtimeEpoch);assert.equal(r.execution.input.runtimeEpoch,f.view.runtimeEpoch);
 assert.equal((await f.inspect()).recipes[0].runtimeEpoch,f.view.runtimeEpoch);assert.equal((await f.inspect()).config.runtimeEpoch,f.view.runtimeEpoch);
});
test('restore with unchanged release blocks unused recipe authorization and claimed leases despite freshly inspected CAS',async t=>{
 const f=await fixture(t);await f.prepare('unused');await f.prepare('claimed');const r=await f.reserve('claimed'),before=f.raw();f.restore();
 await assert.rejects(f.reserve('unused'),{code:'RUNTIME_EPOCH_CONFLICT'});
 await assert.rejects(trial.instanceTrialStart(f.repo,{...f.binding(r),runtimeEpoch:f.view.runtimeEpoch},await f.options('start-after-restore')),{code:'RUNTIME_EPOCH_CONFLICT'});
 await assert.rejects(trial.instanceTrialPrepareRecipe(f.repo,{recipe:f.recipe('new-under-old-scope')},await f.options('prepare-after-restore')),{code:'RUNTIME_EPOCH_CONFLICT'});
 await assert.rejects(trial.instanceTrialPrepareScope(f.repo,f.scopeBody,{idempotencyKey:'scope-fixture-key'}),{code:'RUNTIME_EPOCH_CONFLICT'});
 assert.equal(f.raw(),before);assert.equal((await f.inspect()).executions[0].state,'CLAIMED');
});
test('same-epoch start replay is idempotent, but restore cannot replay an old successful dispatch receipt',async t=>{
 const f=await fixture(t);await f.prepare('running');const r=await f.reserve('running'),body=f.binding(r),options=await f.options('start-running');
 const first=await trial.instanceTrialStart(f.repo,body,options),replay=await trial.instanceTrialStart(f.repo,body,{...options,ifMatch:'stale'});assert.equal(first.execution.dispatchId,replay.execution.dispatchId);assert.equal(replay.replayed,true);
 f.restore();const before=f.raw();await assert.rejects(trial.instanceTrialStart(f.repo,{...body,runtimeEpoch:f.view.runtimeEpoch},{...await f.options('start-running')}),{code:'RUNTIME_EPOCH_CONFLICT'});assert.equal(f.raw(),before);
});
test('restored unknown result only accepts exact explicit origin and provider reconciliation and never authorizes retry',async t=>{
 const f=await fixture(t);await f.prepare('unknown');const r=await f.reserve('unknown'),binding=f.binding(r),start=await trial.instanceTrialStart(f.repo,binding,await f.options('start-unknown'));
 const receipt={dispatchId:start.execution.dispatchId,requestId:'provider-request-original'};
 await trial.instanceTrialResult(f.repo,{...binding,outcome:'RESULT_UNKNOWN',receipt},await f.options('unknown-receipt'));
 f.restore();const body={...binding,runtimeEpoch:f.view.runtimeEpoch,originRuntimeEpoch:binding.runtimeEpoch,reconciled:true,outcome:'FAILED',receipt:{...receipt,definitiveFailure:true}};
 for(const bad of [{...body,reconciled:false},{...body,originRuntimeEpoch:'wrong'},{...body,receipt:{...body.receipt,requestId:'other-request'}},{...body,receipt:{...receipt}}])await assert.rejects(trial.instanceTrialResult(f.repo,bad,await f.options('bad-reconcile-'+Math.random().toString().slice(2))));
 const result=await trial.instanceTrialResult(f.repo,body,await f.options('reconcile-unknown'));assert.equal(result.execution.runtimeEpoch,binding.runtimeEpoch);assert.equal(result.execution.state,'FAILED');assert.equal(result.asset,null);assert.equal((await f.inspect()).budgets[0].spent,1);
 await assert.rejects(f.reserve('unknown'),{code:'RUNTIME_EPOCH_CONFLICT'});await assert.rejects(trial.instanceTrialStart(f.repo,{...binding,runtimeEpoch:f.view.runtimeEpoch},await f.options('restart-reconciled')),{code:'RUNTIME_EPOCH_CONFLICT'});
});
test('historical trial records without an epoch remain inspectable and cannot acquire dispatch authority',async t=>{
 const f=await fixture(t);await f.prepare('legacy');f.forgetScopeEpoch();await assert.rejects(f.reserve('legacy'),{code:'RUNTIME_EPOCH_CONFLICT'});assert.equal((await f.inspect()).recipes.length,1);
});
