import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,writeFile} from 'node:fs/promises';
import {createServer} from 'vite';
import {apiFixture,pngs} from './fixtures/material-native-revision-api.mjs';
import {changeDomain,imageRequirementId,imageRepresentationId} from './material-production-fixture.mjs';
import {canonicalJson,sha256} from '../host/instance-runtime/bytes.mjs';
import {MATERIAL_USAGE_NS,runMaterialUsageIteration,applyMaterialUsageJob} from '../host/instance-runtime/material-usage-service.mjs';
import {validateMaterialUsageLedger} from '../host/instance-runtime/material-usage-model.mjs';
import {validateArchive} from '../host/instance-runtime/postgres.mjs';
import {validateModernEventsInChild} from '../host/instance-modern-event-bridge.mjs';
import {productionBindingReasons} from '../host/instance-runtime/shot-production-model.mjs';
import {getMaterialProductionWorkspace} from '../host/instance-runtime/material-production-service.mjs';

const options={skip:process.env.REVIEW_TEST_POSTGRES!=='1',timeout:180000};

// Actual isolated PostgreSQL, immutable registered PNG bytes and API Review
// protocol. The one-pixel fixture is never an artistic observation or a model
// result. sharedStoryPostgres owns UUID-named disposable container + volume.
async function usageFixture(t){
 const f=await apiFixture(t),production=await f.provision(await f.workspace(),'Fixed PNG protocol fixture, no provider invoked.'),candidate=await f.register(production,await f.beginRun(production),pngs[0]);
 const adoption=await f.review(production,candidate,'APPROVE_AND_RELEASE');
 await f.evidence(production.result.familyId,candidate);
 const before=await f.repo.readView(),graph=before.snapshot.productionModel.domainGraph,originalRep=graph.representations.find(r=>r.id===imageRepresentationId),originalDemand=graph.requirements.find(r=>r.id===imageRequirementId);
 const targets=['alternate','detail','another'].map(name=>({requirementId:'demand:usage-'+name,familyId:production.result.familyId,versionId:candidate.versionId,sha256:candidate.sha256}));
 await changeDomain(f.repo,'MATERIAL',targets.flatMap((target,index)=>{
  const representation={...originalRep,id:'representation:usage-'+index,type:'APPEARANCE',label:'Additional exact protocol purpose '+index,assetFamilyIds:[],requirementIds:[target.requirementId]},demand={...originalDemand,id:target.requirementId,title:'New exact image purpose '+index,representationId:representation.id,acceptanceCriteria:['Fixed PNG protocol fixture satisfies only this explicit synthetic purpose '+index]};
  return [['representations',representation],['requirements',demand]].map(([collection,value])=>({collection,id:value.id,beforeHash:null,value}));
 }));
 const server=await createServer({root:f.softwareRoot,configFile:false,logLevel:'error',cacheDir:path.join(f.root,'usage-vite-cache'),server:{middlewareMode:true,hmr:false,ws:false},appType:'custom'});
 const store=await server.ssrLoadModule('/app/api/v8/_store.ts'),route=await server.ssrLoadModule('/app/api/instance/material-usage/route.ts'),materialsRoute=await server.ssrLoadModule('/app/api/v8/ui/materials/route.ts'),repository=await store.instanceRepository();
 t.after(async()=>{await repository.close();await server.close();});
 const api={projectOperationalState:store.projectOperationalState,safeGeneratedPath:store.safeGeneratedPath,hashStableFile:store.hashStableFile};
 const get=async(target=targets[0],{selection=false}={})=>{
  const query=new URLSearchParams(selection?{requirementId:target.requirementId}:target),response=await route.GET(new Request('http://localhost/api/instance/material-usage?'+query));
  return {status:response.status,body:await response.json()};
 };
 const materialPage=async(target=targets[0],summary=false)=>{const response=await materialsRoute.GET(new Request('http://localhost/api/v8/ui/materials?'+new URLSearchParams({requirementId:target.requirementId,...(summary?{detail:'summary'}:{})}))),body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body.page;};
 const workspace=async(target=targets[0])=>{const r=await get(target);assert.equal(r.status,200,JSON.stringify(r.body));assert.deepEqual(r.body.blockers,[]);return r.body;};
 const content=(w,action='APPROVE_AND_RELEASE')=>({
  purposeNote:'Reuse the exact test PNG for this new leaf only; no new original asset or artwork claim.',
  authorization:{scope:'PROJECT_INTERNAL_ONLY',basis:'Explicit isolated protocol test authorization, not real project or commercial rights.'},
  observation:{versionId:candidate.versionId,sha256:candidate.sha256,originalViewed:true,note:'Synthetic tiny-PNG observation field exercises protocol binding; no real artistic quality finding.'},
  decision:{action,reviewSpecHash:w.reviewSpec.hash,criterionFindings:w.reviewSpec.criteria.map((criterion,index)=>({criterionId:criterion.id,verdict:action==='APPROVE_AND_RELEASE'||index>0?'PASS':'FAIL',note:'Exact synthetic target criterion, protocol evidence only.'})),note:'Isolated new-purpose decision, preserves original ASSET history.'},
 });
 const post=(body,opts)=>f.post(route,'instance/material-usage',body,opts);
 const saveBody=(target,w,action)=>({...target,action:'save',expectedReleaseId:w.releaseId,expectedBasisHash:w.basisHash,expectedDraftRevisionId:w.draftHeadRevisionId,content:content(w,action)});
 let sequence=0;
 const stage=async(target=targets[0],action='APPROVE_AND_RELEASE')=>{
  const w=await workspace(target),saved=await post(saveBody(target,w,action));assert.equal(saved.status,200,JSON.stringify(saved.body));assert.ok(saved.body.revisionId);
  assert.equal(saved.body.formalUsageReviewPerformed,false);assert.equal(saved.body.modelCalls,0);
  const preview=await post({...target,action:'preview',draftRevisionId:saved.body.revisionId});assert.equal(preview.status,200,JSON.stringify(preview.body));assert.equal(preview.body.formalUsageReviewPerformed,false);assert.equal(preview.body.modelCalls,0);
  assert.equal(preview.body.usage.basis.source.adoption.eventId,adoption.eventId);assert.equal(preview.body.usage.basis.source.sha256,candidate.sha256);
  return {target,w,saved,preview,body:{...target,action:'publish',draftRevisionId:saved.body.revisionId,previewHash:preview.body.previewHash},key:'usage-api:publish:'+String(++sequence)};
 };
 const queue=async staged=>{const result=await post(staged.body,{key:staged.key});assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.status,'QUEUED');assert.equal(result.body.formalUsageReviewPerformed,false);return result;};
 const publish=async(target=targets[0],action='APPROVE_AND_RELEASE')=>{
  const staged=await stage(target,action),beforeQueue=await f.repo.readView(),queued=await queue(staged);
  assert.equal((await f.repo.readView()).releaseId,beforeQueue.releaseId,'Web queues AUX and never publishes a source');
  assert.deepEqual(await post(staged.body,{key:staged.key}),queued,'same publish request replays the existing queue receipt');
  const result=await runMaterialUsageIteration({repository:f.repo,api});assert.equal(result.status,'SUCCEEDED',JSON.stringify(result));assert.equal(result.usageId,staged.preview.body.usage.usageId);assert.equal(result.formalAdoptionPerformed,false);assert.equal(result.formalUsageReviewPerformed,true);assert.equal(result.modelCalls,0);
  const view=await f.repo.readView(),document=await f.repo.readDocumentRevision(result.sourceRevisionId);assert.equal(document.sha256,result.sourceSha256);assert.deepEqual(JSON.parse(document.bytes),staged.preview.body.usage);assert.equal(document.metadata.sourceRole,'MATERIAL_USAGE_REVIEW');
  return {staged,queued,result,view,document};
 };
 const projection=async()=>((await store.operationalSnapshot()).stateProjection);
 const media=await f.repo.getMedia(production.result.familyId,candidate.versionId),originalBytes=await readFile(path.join(f.root,media.relativePath));assert.equal(sha256(originalBytes),candidate.sha256);
 return {...f,production,candidate,adoption,targets,route,usageStore:store,api,get,materialPage,workspace,content,postUsage:post,saveBody,stage,queue,publish,projection,media,originalBytes};
}

function originalProjection(view){
 const model=structuredClone(view.snapshot.productionModel);delete model.materialUsageLedger;delete model.materialUsageEvidence;
 const recipes=structuredClone(view.recipes);delete recipes.snapshotId;
 return {model,recipes,events:Object.fromEntries(['review','asset-version','run','execution-request'].map(k=>[k,view.eventsByKind[k]||[]]))};
}

test('IMAGE new-use API publishes exact usage reviews without changing original media/ASSET; rejecting one use and withdrawing the source invalidate only their dependants',options,async t=>{
 const f=await usageFixture(t),[one,two]=f.targets,before=await f.repo.readView(),original=originalProjection(before),mediaBefore=await f.repo.listMedia();
 const selection=await f.get(one,{selection:true});assert.equal(selection.status,200,JSON.stringify(selection.body));assert.deepEqual(selection.body.eligibleSources.map(r=>[r.familyId,r.versionId,r.sha256]),[[one.familyId,one.versionId,one.sha256]]);
 assert.equal((await f.projection()).materialRequirementsById[one.requirementId].coverageSatisfied,false);
 const first=await f.publish(one),second=await f.publish(two),state=await f.projection();
 for(const target of [one,two]){const row=state.materialRequirementsById[target.requirementId];assert.equal(row.coverageSatisfied,true,JSON.stringify(row));assert.deepEqual(row.assetFamilyRefs,[],'new use does not rewrite DOMAIN family ownership');assert.deepEqual(row.coveredByVersionRefs,[f.candidate.versionId]);assert.equal(row.materialUsageBindings.length,1);}
 const exactUsagePage=async(target,eligible)=>{for(const summary of [true,false]){const page=await f.materialPage(target,summary),requirement=page.materialRequirements.find(r=>r.id===target.requirementId);assert.deepEqual(requirement.assetFamilyRefs,[]);assert.ok(page.assetFamilies.some(r=>r.id===target.familyId));assert.deepEqual(page.assetVersions.map(r=>[r.id,r.familyId,r.sha256]),[[target.versionId,target.familyId,target.sha256]],'usage details expose only the exact bound source version');assert.equal(requirement.materialUsageBindings.find(b=>b.versionId===target.versionId).eligible,eligible);}};
 await exactUsagePage(one,true);
 const usedModel=(await f.repo.readView()).snapshot.productionModel;
 assert.deepEqual(productionBindingReasons(usedModel,state,one),[],'real exact usage qualifies as a production input, not just a green UI row');
 assert.ok(productionBindingReasons(usedModel,state,{...one,sha256:'0'.repeat(64)}).includes('INPUT_FILE_OR_SHA_MISSING'));
 assert.ok(productionBindingReasons(usedModel,state,f.targets[2]).includes('INPUT_REQUIREMENT_BINDING_CHANGED'),'same source SHA cannot satisfy an unreviewed third purpose');
 const noDuplicate=await f.repo.readTransaction(tx=>getMaterialProductionWorkspace(tx,{requirementId:one.requirementId,api:f.api}));assert.ok(noDuplicate.blockers.some(reason=>reason.includes('不重复创建生产族')));
 assert.equal(state.materialRequirementsById[imageRequirementId].coverageSatisfied,true);
 assert.deepEqual(originalProjection(await f.repo.readView()),original);assert.deepEqual(await f.repo.listMedia(),mediaBefore);assert.deepEqual(await readFile(path.join(f.root,f.media.relativePath)),f.originalBytes);
 const approvedView=await f.repo.readView(),documents=await Promise.all(approvedView.snapshot.productionModel.materialUsageLedger.map(r=>f.repo.readDocumentRevision(r.sourceRevisionId))),events=await f.repo.listEvents();
 assert.equal(validateMaterialUsageLedger({snapshot:approvedView.snapshot,documents,events}).length,2);assert.equal(approvedView.eventsByKind['material-usage-review'].length,2);
 assert.deepEqual(approvedView.eventsByKind.review,[f.adoption]);
 const refused=await f.publish(one,'DO_NOT_USE'),afterRefusal=await f.projection();
 assert.equal(afterRefusal.materialRequirementsById[one.requirementId].coverageSatisfied,false);assert.equal(afterRefusal.materialRequirementsById[two.requirementId].coverageSatisfied,true);assert.equal(afterRefusal.assetVersionsById[f.candidate.versionId].canFlowDownstream,true);
 assert.ok(productionBindingReasons((await f.repo.readView()).snapshot.productionModel,afterRefusal,one).includes('INPUT_REQUIREMENT_BINDING_CHANGED'));
 assert.deepEqual(productionBindingReasons((await f.repo.readView()).snapshot.productionModel,afterRefusal,two),[]);
 await exactUsagePage(one,false);
 assert.deepEqual(originalProjection(await f.repo.readView()),original,'new-purpose rejection cannot rewrite original quality/rights/recipe');
 assert.equal(refused.document&&JSON.parse(refused.document.bytes).basis.previousHead.eventId,first.result.eventId);
 const reviewData=await f.store.reviewData(),spec=reviewData.productionModel.materialRequirements.find(r=>r.id===imageRequirementId).reviewSpec;
 const correction=await f.post(f.reviews,'v8/reviews',{schemaVersion:'2.2',subjectType:'ASSET',subjectId:one.familyId,familyId:one.familyId,versionId:one.versionId,versionSha256:one.sha256,contextHash:f.store.assetReviewContextHash(reviewData,one.familyId,one.versionId,one.sha256),reviewSpecHash:spec.hash,action:'REQUEST_REVISION',supersedesReviewEventId:f.adoption.eventId,
  criterionFindings:spec.criteria.map((c,i)=>({criterionId:c.id,verdict:i===0?'FAIL':'PASS',note:'Explicit synthetic source correction; no real art finding.'})),revisionInstructions:{preserve:['Original fixture history'],change:['Source no longer meets its original fixture criterion'],mustNotRegress:['Exact immutable source SHA and original Review remain']},note:'Isolated test of source adoption withdrawal after explicit new uses.'});
 assert.equal(correction.status,201,JSON.stringify(correction.body));assert.equal(correction.body.event.effect,'APPLIED');
 const sourceRevision=correction.body.event,afterSource=await f.projection();
 assert.equal(afterSource.materialRequirementsById[two.requirementId].coverageSatisfied,false);assert.equal(afterSource.assetVersionsById[f.candidate.versionId].canFlowDownstream,false);
 assert.ok(afterSource.materialUsageBindings.find(b=>b.requirementId===two.requirementId).reasons.includes('USAGE_SOURCE_NOT_CURRENT_RELEASED'));
 const finalView=await f.repo.readView();assert.deepEqual([...finalView.eventsByKind.review].sort((a,b)=>a.eventSequence-b.eventSequence),[f.adoption,sourceRevision]);
 assert.deepEqual(await f.repo.readDocumentRevision(first.result.sourceRevisionId),first.document);assert.deepEqual(await f.repo.readDocumentRevision(second.result.sourceRevisionId),second.document);assert.deepEqual(await f.repo.listMedia(),mediaBefore);assert.deepEqual(await readFile(path.join(f.root,f.media.relativePath)),f.originalBytes);
 await f.repo.readTransaction(async tx=>{
  const archive=await tx.exportState();validateArchive(archive,f.profile.instanceId);
  const scan=await tx.scanValidatedArchive();assert.equal(scan.exportSha256,archive.exportSha256,'streamed PG validator preserves the same complete archive');
  const view=await tx.readView(),documents=await Promise.all(view.snapshot.productionModel.materialUsageLedger.map(r=>tx.readDocumentRevision(r.sourceRevisionId))),events=await tx.listEvents();
  const child=await validateModernEventsInChild({events,baseRelease:await tx.readRelease(),documents,eventDirectory:'events'});
  assert.equal(child.proof.eventsOmitted,0);assert.equal(child.proof.originalEventsUnchanged,true);
  for(const usage of events.filter(e=>e.eventKind==='material-usage-review'))assert.equal(child.proof.partition.find(p=>p.eventId===usage.eventId).recordValidator,'RUNTIME_MODERN');
 });
 const blocked=await f.get(two);assert.equal(blocked.status,200);assert.ok(blocked.body.blockers.length);assert.equal(f.externalCalls(),0);
});

test('IMAGE new-use API enforces Origin/read-only/CAS/exact source and rejects legacy Review ingress purpose fields before any writes',options,async t=>{
 const f=await usageFixture(t),target=f.targets[0],w=await f.workspace(target),body=f.saveBody(target,w),before=await f.repo.exportState();
 for(const [label,headers,status] of [['external Origin',{Origin:'https://untrusted.example'},403],['missing CAS',{'If-Match':''},428],['stale CAS',{'If-Match':'"stale-fixture-etag"'},412]]){
  const r=await f.postUsage(body,{headers});assert.equal(r.status,status,label+': '+JSON.stringify(r.body));assert.deepEqual(await f.repo.exportState(),before);
 }
 for(const [label,changed,status] of [['stale basis',{...body,expectedBasisHash:'0'.repeat(64)},409],['wrong source SHA',{...body,sha256:'0'.repeat(64)},409],['wrong observation version',{...body,content:{...body.content,observation:{...body.content.observation,versionId:'other@V001'}}},409],['arbitrary metadata',{...body,purpose:'do not bypass original Review'},422]]){
  const r=await f.postUsage(changed);assert.equal(r.status,status,label+': '+JSON.stringify(r.body));assert.deepEqual(await f.repo.exportState(),before);
 }
 for(const envKey of ['REVIEW_INSTANCE_READ_ONLY','REVIEW_REMOTE_READ_ONLY']){
  process.env[envKey]='1';try{
   // Deliberately no private-model/CAS fetch: read-only must reject first.
   const response=await f.route.POST(new Request('http://localhost/api/instance/material-usage',{method:'POST',body:JSON.stringify(body)}));assert.equal(response.status,405,await response.text());
  }finally{process.env[envKey]='';}
  assert.deepEqual(await f.repo.exportState(),before);
 }
 for(const field of ['reviewPurpose','usageBindingId','usageId']){
  const r=await f.post(f.reviews,'v8/reviews',{schemaVersion:'2.2',subjectType:'ASSET',subjectId:target.familyId,familyId:target.familyId,versionId:target.versionId,versionSha256:target.sha256,action:'APPROVE_AND_RELEASE',[field]:field==='reviewPurpose'?'MATERIAL_USAGE':'usage:forbidden-legacy-ingress'});
  assert.equal(r.status,422,field+': '+JSON.stringify(r.body));assert.match(r.body.error,/MATERIAL_USAGE_V1/);assert.deepEqual(await f.repo.exportState(),before);
 }
 const staged=await f.stage(),savedState=await f.repo.exportState();
 const staleHead=await f.postUsage(body);assert.equal(staleHead.status,409,JSON.stringify(staleHead.body));assert.deepEqual(await f.repo.exportState(),savedState);
 const tampered=await f.postUsage({...staged.body,previewHash:'f'.repeat(64)});assert.equal(tampered.status,409);assert.deepEqual(await f.repo.exportState(),savedState);
 assert.equal(f.externalCalls(),0);
});

test('IMAGE usage RESULT_UNKNOWN remains non-dispatchable; a lost successful PG commit response is reconciled without duplicating the source/event',options,async t=>{
 const f=await usageFixture(t),[unknownTarget,goodTarget]=f.targets,unknown=await f.stage(unknownTarget),queued=await f.queue(unknown);
 await f.repo.writeTransaction(async tx=>{const row=await tx.getAux(MATERIAL_USAGE_NS.jobs,queued.body.jobId);await tx.putAux({namespace:MATERIAL_USAGE_NS.jobs,key:queued.body.jobId,expectedRevisionId:row.revisionId,bytes:canonicalJson({...JSON.parse(row.bytes),status:'RESULT_UNKNOWN',error:'Isolated injected indeterminate transport result; not a provider call.'}),mediaType:'application/json'});});
 const beforeUnknown=await f.repo.exportState();assert.deepEqual(await runMaterialUsageIteration({repository:f.repo,api:f.api}),{processed:false});
 const w=await f.workspace(unknownTarget);assert.equal(w.jobs[0].status,'RESULT_UNKNOWN');
 const save=await f.postUsage(f.saveBody(unknownTarget,w));assert.equal(save.status,409);assert.match(save.body.error,/未知/);
 const again=await f.postUsage(unknown.body);assert.equal(again.status,409);assert.match(again.body.error,/未知/);
 await assert.rejects(f.repo.writeTransaction(tx=>applyMaterialUsageJob(tx,{jobId:queued.body.jobId,api:f.api})),/不能自动重试/);assert.deepEqual(await f.repo.exportState(),beforeUnknown);
 const good=await f.stage(goodTarget),goodQueue=await f.queue(good);let loseResponse=true;
 const repository=new Proxy(f.repo,{get(target,key){if(key==='writeTransaction')return async callback=>{const result=await target.writeTransaction(callback);if(loseResponse){loseResponse=false;throw Error('Injected lost PG commit response after successful commit');}return result;};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
 const result=await runMaterialUsageIteration({repository,api:f.api});assert.equal(result.status,'SUCCEEDED',JSON.stringify(result));assert.equal(result.processed,true);assert.equal(result.usageId,good.preview.body.usage.usageId);
 const view=await f.repo.readView();assert.equal(view.eventsByKind['material-usage-review'].length,1);assert.equal(view.snapshot.productionModel.materialUsageLedger.length,1);
 const succeeded=JSON.parse((await f.repo.getAux(MATERIAL_USAGE_NS.jobs,goodQueue.body.jobId)).bytes);assert.equal(succeeded.status,'SUCCEEDED');assert.equal(succeeded.result.eventId,result.eventId);assert.equal(JSON.parse((await f.repo.getAux(MATERIAL_USAGE_NS.jobs,queued.body.jobId)).bytes).status,'RESULT_UNKNOWN');
 const final=await f.repo.exportState();assert.deepEqual(await runMaterialUsageIteration({repository:f.repo,api:f.api}),{processed:false});assert.deepEqual(await f.repo.exportState(),final);assert.deepEqual(view.eventsByKind.review,[f.adoption]);assert.equal(f.externalCalls(),0);
});

test('queued IMAGE usage verifies actual registered bytes under its media lease and cannot publish after the source file changes',options,async t=>{
 const f=await usageFixture(t),staged=await f.stage(),queued=await f.queue(staged),before=await f.repo.readView(),media=await f.repo.listMedia(),file=path.join(f.root,f.media.relativePath);
 // Deliberate corruption of this disposable fixture only, restored in finally.
 await writeFile(file,Buffer.from('corrupted isolated PNG fixture, no formal media touched'));
 try{
  const result=await runMaterialUsageIteration({repository:f.repo,api:f.api});assert.equal(result.status,'FAILED',JSON.stringify(result));assert.equal(result.jobId,queued.body.jobId);
  const after=await f.repo.readView();assert.equal(after.releaseId,before.releaseId);assert.deepEqual(after.eventsByKind,before.eventsByKind);assert.deepEqual(after.snapshot,before.snapshot);assert.deepEqual(await f.repo.listMedia(),media);assert.equal((after.eventsByKind['material-usage-review']||[]).length,0);assert.equal((after.snapshot.productionModel.materialUsageLedger||[]).length,0);
 }finally{await writeFile(file,f.originalBytes);}
 assert.equal(sha256(await readFile(file)),f.candidate.sha256);assert.equal(f.externalCalls(),0);
});
