import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,symlink,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {recoveryFixture} from './animatic-recovery-fixture.mjs';
import {canonicalJson,sha256} from '../host/instance-runtime/bytes.mjs';
import {animaticHash} from '../host/instance-runtime/animatic-model.mjs';
import {ANIMATIC_NS,saveAnimaticTimeline,readAnimaticState,enqueueAnimaticRender,claimAnimaticRender,finishAnimaticRender} from '../host/instance-runtime/animatic-service.mjs';
import {ANIMATIC_RECOVERY_NS,enqueueAnimaticReconciliation,runAnimaticReconciliationIteration,inspectAnimaticOutput} from '../host/instance-runtime/animatic-recovery.mjs';
import {runAnimaticWorkerIteration} from '../scripts/instance-animatic-worker.mjs';
import {animaticProcess} from '../host/instance-runtime/animatic-render.mjs';
const read=row=>JSON.parse(row.bytes),key=()=>randomUUID();
async function setup(f){const state=await f.repo.readTransaction(tx=>readAnimaticState(tx,{sceneId:f.v.sceneId,model:f.model}));return f.repo.writeTransaction(tx=>saveAnimaticTimeline(tx,{sceneId:f.v.sceneId,expectedReleaseId:state.releaseId,expectedRevisionId:state.revisionId,requestId:key(),content:f.v},{model:f.model}));}
async function queue(f){const s=await f.repo.readTransaction(tx=>readAnimaticState(tx,{sceneId:f.v.sceneId,model:f.model}));return f.repo.writeTransaction(tx=>enqueueAnimaticRender(tx,{sceneId:f.v.sceneId,expectedReleaseId:s.releaseId,expectedRevisionId:s.revisionId,timelineRevisionId:s.timelineRevisionId,requestId:key()},{model:f.model}));}
async function updateJob(f,jobId,changes){return f.repo.writeTransaction(async tx=>{const row=await tx.getAux(ANIMATIC_NS.jobs,jobId);return tx.putAux({namespace:ANIMATIC_NS.jobs,key:jobId,bytes:canonicalJson({...read(row),...changes}),expectedRevisionId:row.revisionId});});}
async function recoveryInput(f,jobId){const metadata=await f.repo.getMetadata(),row=await f.repo.getAux(ANIMATIC_NS.jobs,jobId);return{sceneId:f.v.sceneId,jobId,expectedJobRevisionId:row.revisionId,expectedRuntimeEpoch:metadata.runtimeEpoch,expectedReleaseId:metadata.releaseId,requestId:key()};}
async function enqueueCheck(f,jobId){const input=await recoveryInput(f,jobId);return f.repo.writeTransaction(tx=>enqueueAnimaticReconciliation(tx,input));}
async function output(f,job){const file=path.join(f.root,job.expectedOutput.targetPath);await mkdir(path.dirname(file),{recursive:true});await animaticProcess('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','color=c=navy:s=1920x1080:r=24','-frames:v','72','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-n',file]);return inspectAnimaticOutput(f.root,job.expectedOutput.targetPath);}

test('recovery request binds current epoch, exact job CAS and idempotency without changing a job or creating output',async t=>{
 const f=await recoveryFixture(t);await setup(f);const q=await queue(f);await f.repo.writeTransaction(tx=>claimAnimaticRender(tx,q.jobId,'old-worker'));const input=await recoveryInput(f,q.jobId),before=await f.repo.exportState();
 for(const wrong of [{expectedJobRevisionId:'stale'},{expectedRuntimeEpoch:'stale'},{expectedReleaseId:'stale'},{sceneId:'other'}])await assert.rejects(f.repo.writeTransaction(tx=>enqueueAnimaticReconciliation(tx,{...input,...wrong})));
 assert.deepEqual(await f.repo.exportState(),before);const first=await f.repo.writeTransaction(tx=>enqueueAnimaticReconciliation(tx,input));assert.deepEqual(await f.repo.writeTransaction(tx=>enqueueAnimaticReconciliation(tx,input)),first);assert.equal(first.automaticRetry,false);assert.equal(read(await f.repo.getAux(ANIMATIC_NS.jobs,q.jobId)).status,'RUNNING');
 await assert.rejects(f.repo.writeTransaction(tx=>enqueueAnimaticReconciliation(tx,{...input,jobId:'other'})));await assert.rejects(runAnimaticReconciliationIteration({repository:f.repo,instanceRoot:f.root,workerId:'check'}),/排他租约/);
 const state=await f.repo.readTransaction(tx=>readAnimaticState(tx,{sceneId:f.v.sceneId,model:f.model}));assert.equal(state.jobs[0].jobRevisionId,input.expectedJobRevisionId);assert.equal(state.jobs[0].pendingReconciliation.reconciliationId,first.reconciliationId);
});
test('output inspection rejects traversal, symlinks, malformed media and changing SHA evidence',async t=>{
 const f=await recoveryFixture(t);await setup(f);const q=await queue(f),job=read(await f.repo.getAux(ANIMATIC_NS.jobs,q.jobId)),file=await output(f,job);assert.equal(file.sha256,sha256(await readFile(path.join(f.root,file.relativePath))));assert.equal(file.frameCount,72);
 await assert.rejects(inspectAnimaticOutput(f.root,'media/_review_pending/../escape.mp4'));await symlink(path.join(f.root,file.relativePath),path.join(f.root,'media/_review_pending/alias.mp4'));await assert.rejects(inspectAnimaticOutput(f.root,'media/_review_pending/alias.mp4'),/符号链接/);
 await writeFile(path.join(f.root,'media/_review_pending/bad.mp4'),'not a movie');await assert.rejects(inspectAnimaticOutput(f.root,'media/_review_pending/bad.mp4'));assert.equal((await inspectAnimaticOutput(f.root,'media/_review_pending/not-created/none.mp4')).state,'ABSENT');
 await assert.rejects(inspectAnimaticOutput(f.root,file.relativePath,{run:async()=>{await writeFile(path.join(f.root,file.relativePath),'changed during probe');return JSON.stringify({streams:[{width:1920,height:1080,r_frame_rate:'24/1',nb_read_frames:'72'}]});}}),/探测过程中输出文件发生变化/);
});
test('stale timeline is explicitly replaced by a current-plan revision while frozen history remains unchanged',async t=>{
 const f=await recoveryFixture(t),old=await setup(f),frozen=await f.repo.getAux(ANIMATIC_NS.revisions,old.timelineRevisionId),model=structuredClone(f.model),plan=model.shotPlanSetRevisions[0];plan.id='plan:current';plan.content.shots=[{shotId:'shot:current',sceneId:f.v.sceneId,order:1}];plan.contentHash=animaticHash(plan.content);Object.assign(model.scopeLocks[0],{shotPlanSetRevisionId:plan.id,shotPlanSetRevisionHash:plan.contentHash,shotIds:['shot:current']});model.shots=[{id:'shot:current',sceneId:f.v.sceneId,scopeRole:'CURRENT',shotPlanSetRevisionId:plan.id,shotPlanSetRevisionHash:plan.contentHash}];
 const state=await f.repo.readTransaction(tx=>readAnimaticState(tx,{sceneId:f.v.sceneId,model}));assert.equal(state.stale,true);const input={sceneId:f.v.sceneId,expectedReleaseId:state.releaseId,expectedRevisionId:state.revisionId,requestId:key()};await assert.rejects(f.repo.writeTransaction(tx=>saveAnimaticTimeline(tx,{...input,content:f.v},{model})));
 const content={...f.v,shotPlanRevisionId:plan.id,shots:[{shotId:'shot:current',durationFrames:60,panels:[],beats:[]}]},saved=await f.repo.writeTransaction(tx=>saveAnimaticTimeline(tx,{...input,requestId:key(),content},{model}));assert.notEqual(saved.timelineRevisionId,old.timelineRevisionId);assert.deepEqual(await f.repo.getAux(ANIMATIC_NS.revisions,old.timelineRevisionId),frozen);assert.equal(read(await f.repo.getAux(ANIMATIC_NS.revisions,saved.timelineRevisionId)).baseTimelineRevisionId,old.timelineRevisionId);assert.equal((await f.repo.readTransaction(tx=>readAnimaticState(tx,{sceneId:f.v.sceneId,model}))).stale,false);
});

test('real PostgreSQL recovery proves absence, preserves unregistered output, checks exact registration, and fences active renderers',{skip:process.env.REVIEW_TEST_POSTGRES!=='1',timeout:120000},async t=>{
 const f=await recoveryFixture(t,{postgres:true});await setup(f);const worker=()=>runAnimaticReconciliationIteration({repository:f.repo,instanceRoot:f.root,workerId:'checker'}),job=id=>f.repo.getAux(ANIMATIC_NS.jobs,id).then(read);
 await t.test('historical runtime epoch can only be inspected, never redispatched; confirmed absence permits unique new slot',async()=>{
  const q=await queue(f);await f.repo.writeTransaction(tx=>claimAnimaticRender(tx,q.jobId,'crashed'));await updateJob(f,q.jobId,{runtimeEpoch:'historical-epoch'});assert.equal((await runAnimaticWorkerIteration({repository:f.repo,instanceRoot:f.root,workerId:'new',render:()=>assert.fail('must not retry')})).processed,false);
  await enqueueCheck(f,q.jobId);const checked=await worker();assert.equal(checked.outcome,'NO_OUTPUT_CONFIRMED');assert.equal((await job(q.jobId)).runtimeEpoch,'historical-epoch');assert.equal((await job(q.jobId)).reconciliation.observed,false);
 });
 await t.test('unregistered actual MP4 is retained with SHA; next slot does not reuse or overwrite it',async()=>{
  const q=await queue(f),claim=await f.repo.writeTransaction(tx=>claimAnimaticRender(tx,q.jobId,'crashed')),file=await output(f,claim.job);assert.match(file.relativePath,/V002\.mp4$/);await updateJob(f,q.jobId,{status:'RESULT_UNKNOWN',result:file});await enqueueCheck(f,q.jobId);assert.equal((await worker()).status,'RECONCILED_UNREGISTERED');assert.equal((await job(q.jobId)).result,null);assert.equal((await job(q.jobId)).reconciliation.file.sha256,file.sha256);assert.equal(sha256(await readFile(path.join(f.root,file.relativePath))),file.sha256);assert.equal(((await f.repo.readView()).eventsByKind['asset-version']||[]).length,0);
 });
 await t.test('exact existing deterministic registration recovers success without creating events or observation',async()=>{
  const q=await queue(f),claim=await f.repo.writeTransaction(tx=>claimAnimaticRender(tx,q.jobId,'finished')),file=await output(f,claim.job);assert.match(file.relativePath,/V003\.mp4$/);await f.repo.writeTransaction(tx=>finishAnimaticRender(tx,{jobId:q.jobId,jobRevisionId:claim.jobRevisionId,workerId:'finished',result:file},{model:f.model}));await updateJob(f,q.jobId,{status:'RESULT_UNKNOWN'});const before=(await f.repo.readView()).eventsByKind;await enqueueCheck(f,q.jobId);assert.equal((await worker()).status,'SUCCEEDED');assert.deepEqual((await f.repo.readView()).eventsByKind,before);assert.equal((await job(q.jobId)).reconciliation.formalReviewCreated,false);
  await updateJob(f,q.jobId,{status:'RESULT_UNKNOWN',result:{...(await job(q.jobId)).result,sha256:'0'.repeat(64)}});await enqueueCheck(f,q.jobId);assert.equal((await worker()).status,'BLOCKED');assert.equal((await job(q.jobId)).status,'RESULT_UNKNOWN');await updateJob(f,q.jobId,{status:'SUCCEEDED',result:{...(await job(q.jobId)).result,sha256:file.sha256}});
 });
 await t.test('recovery waits for live renderer shared lease and supersedes stale job CAS after it finishes',async()=>{
  const q=await queue(f);let release,started;const ready=new Promise(resolve=>{started=resolve;}),hold=new Promise(resolve=>{release=resolve;});
  const rendering=runAnimaticWorkerIteration({repository:f.repo,instanceRoot:f.root,workerId:'live-renderer',modelProvider:async()=>f.model,render:async({job:claimed})=>{started();await hold;return output(f,claimed);}});await ready;await enqueueCheck(f,q.jobId);
  const busy=await worker();assert.equal(busy.reconciliationPending,true);assert.equal((await job(q.jobId)).status,'RUNNING');release();assert.equal((await rendering).status,'SUCCEEDED');assert.equal((await worker()).status,'SUPERSEDED');assert.equal((await job(q.jobId)).status,'SUCCEEDED');
 });
 await t.test('recovery refuses read-only and altered epoch without performing inspection',async()=>{
  const q=await queue(f);await f.repo.writeTransaction(tx=>claimAnimaticRender(tx,q.jobId,'crashed'));const check=await enqueueCheck(f,q.jobId);await updateJob(f,q.jobId,{runtimeEpoch:'changed-after-request'});assert.equal((await worker()).status,'SUPERSEDED');assert.equal(read(await f.repo.getAux(ANIMATIC_RECOVERY_NS.jobs,check.reconciliationId)).status,'SUPERSEDED');
  await assert.rejects(runAnimaticReconciliationIteration({repository:{readOnly:true},instanceRoot:f.root,workerId:'readonly',inspect:()=>assert.fail('no read')}),/只读/);
 });
});
