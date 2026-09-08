import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createServer} from 'vite';
import {createInstanceRepository} from '../host/instance-runtime/index.mjs';
import {sharedStoryPostgres} from './fixtures/shared-story-postgres.mjs';
import {sha256} from '../host/instance-runtime/bytes.mjs';
import {legacyAudioFixture as materialProductionFixture,audioRequirementId as imageRequirementId,legacyFamily,legacyWork,params,wav} from './material-legacy-audio-fixture.mjs';
import {legacyObjects,changeDomain} from './material-production-fixture.mjs';
import {preserveMaterialProductionProjection} from '../host/instance-runtime/material-production-preservation.mjs';
import {applyMaterialProductionJob} from '../host/instance-runtime/material-production-service.mjs';
import {productionBindingReasons} from '../host/instance-runtime/shot-production-model.mjs';

const pngs=[wav(0),wav(1)];
const downstreamRequirementId='demand:derived-voice';
const keys=['REVIEW_INSTANCE_DB','REVIEW_INSTANCE_ID','REVIEW_INSTANCE_ROOT','REVIEW_INSTANCE_READ_ONLY','REVIEW_REMOTE_READ_ONLY','REVIEW_SITE_ROOT','REVIEW_EXPORT_DIR','REVIEW_ALLOWED_ORIGINS','REVIEW_POSTGRES_HOST','REVIEW_POSTGRES_PORT','REVIEW_POSTGRES_PASSWORD_FILE','REVIEW_POSTGRES_PASSWORD','REVIEW_POSTGRES_USER'];

async function apiFixture(t){
 const env=Object.fromEntries(keys.map(k=>[k,process.env[k]]));let pg;
 const f=await materialProductionFixture(t,{repositoryFactory:async({root,profile})=>{pg=await sharedStoryPostgres(root);return createInstanceRepository({root,instanceId:profile.instanceId,backend:'postgres',database:pg.database,profile});}});
 t.after(()=>pg.cleanup());
 await f.repo.writeTransaction(async tx=>{const view=await tx.readView(),snapshot=structuredClone(view.snapshot);snapshot.productionModel.systemModel={...snapshot.productionModel.systemModel,stateModel:{...snapshot.productionModel.systemModel?.stateModel,reviewContract:{schemaVersion:'2.2',actions:['APPROVE_AND_RELEASE','REQUEST_REVISION','DO_NOT_USE']}}};await tx.publishRelease({snapshot,recipes:view.recipes,expectedReleaseId:view.releaseId,sourceRevisionIds:view.sourceRevisionIds});});
 await writeFile(path.join(f.root,'instance.json'),JSON.stringify({schemaVersion:'2.0',instanceId:f.profile.instanceId,database:pg.database}));
 Object.assign(process.env,{REVIEW_INSTANCE_DB:'',REVIEW_INSTANCE_ID:f.profile.instanceId,REVIEW_INSTANCE_ROOT:f.root,REVIEW_INSTANCE_READ_ONLY:'',REVIEW_REMOTE_READ_ONLY:'',REVIEW_SITE_ROOT:f.softwareRoot,REVIEW_EXPORT_DIR:'',REVIEW_ALLOWED_ORIGINS:'http://localhost'});
 const server=await createServer({root:f.softwareRoot,configFile:false,logLevel:'error',cacheDir:path.join(f.root,'vite-cache'),server:{middlewareMode:true,hmr:false},appType:'custom'});
 const store=await server.ssrLoadModule('/app/api/v8/_store.ts');
 const storeRepository=await store.instanceRepository();
 const modules=await Promise.all(['instance/material-production','v8/execution-requests','v8/runs','v8/asset-versions','v8/reviews'].map(p=>server.ssrLoadModule('/app/api/'+p+'/route.ts')));
 const [material,requests,runs,versions,reviews]=modules,adapter={projectOperationalState:store.projectOperationalState,safeGeneratedPath:store.safeGeneratedPath};
 const originalFetch=globalThis.fetch;let externalCalls=0,sequence=0;
 globalThis.fetch=async()=>{externalCalls++;throw Error('External model/provider calls are forbidden in this isolated protocol test');};
 t.after(async()=>{globalThis.fetch=originalFetch;process.env.REVIEW_INSTANCE_READ_ONLY='';process.env.REVIEW_REMOTE_READ_ONLY='';await storeRepository.close();await server.close();for(const k of keys){if(env[k]===undefined)delete process.env[k];else process.env[k]=env[k];}});
 const post=async(route,url,body,{key,headers={}}={})=>{
  const op=await store.operationalSnapshot();
  const response=await route.POST(new Request('http://localhost/api/'+url,{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://localhost','If-Match':op.mutationEtag,'Idempotency-Key':key||'material-native:'+String(++sequence),...headers},body:JSON.stringify({...(url.startsWith('v8/')?{snapshotId:(await store.reviewData()).snapshotId}:{}),...body})}));
  return {status:response.status,body:await response.json()};
 };
 const materialPost=(body,options)=>post(material,'instance/material-production',{requirementId:imageRequirementId,...body},options);
 const workspace=async(requirementId=imageRequirementId)=>{const r=await material.GET(new Request('http://localhost/api/instance/material-production?requirementId='+encodeURIComponent(requirementId)));assert.equal(r.status,200,await r.clone().text());return r.json();};
 const saveBody=(w,prompt)=>({action:'save',expectedReleaseId:w.releaseId,expectedBasisHash:w.basisHash,expectedDraftRevisionId:w.draftHeadRevisionId,content:{model:'seed-audio-1.0',prompt,negativePrompt:'No identity drift. Fixture protocol only.',parameters:structuredClone(params),inputBindings:[]}});
 const provision=async(w,prompt,{expectedMode='LEGACY_AUDIO_REVISION'}={})=>{
  assert.equal(w.mode,expectedMode);
  const saved=await materialPost(saveBody(w,prompt));assert.equal(saved.status,200,JSON.stringify(saved.body));
  const preview=await materialPost({action:'preview',draftRevisionId:saved.body.revisionId});assert.equal(preview.status,200,JSON.stringify(preview.body));assert.equal(preview.body.modelCalls,0);
  const queueBody={action:'publish',draftRevisionId:saved.body.revisionId,previewHash:preview.body.previewHash},key='material-native:queue:'+String(++sequence);
  const queued=await materialPost(queueBody,{key});assert.equal(queued.status,200,JSON.stringify(queued.body));assert.equal(queued.body.status,'QUEUED');
  const replay=await materialPost(queueBody,{key});assert.deepEqual(replay,queued);
  const blockedBefore=await f.repo.exportState(),second=await materialPost(queueBody);assert.equal(second.status,409,JSON.stringify(second.body));assert.deepEqual(await f.repo.exportState(),blockedBefore,'second pending publish cannot create another job');
  const result=await f.repo.writeTransaction(tx=>applyMaterialProductionJob(tx,{jobId:queued.body.jobId,api:adapter}));
  const view=await f.repo.readView(),recipe=view.recipes.executionDefinitions.find(d=>d.id===result.definitionId);assert.ok(recipe);assert.equal(result.modelCalls,0);
  return {result,recipe,plan:preview.body.plan,view};
 };
 const beginRun=async p=>{
  const a=await post(requests,'v8/execution-requests',{action:'AUTHORIZE',workItemId:p.result.workItemId,familyId:p.result.familyId,executionDefinitionId:p.recipe.id,callPackageHash:p.recipe.definitionHash,executor:'CODEX',authorized:true,maxOutputs:1,inputBindings:[]});assert.equal(a.status,201,JSON.stringify(a.body));
  const requestId=a.body.executionRequestId,claim=await post(requests,'v8/execution-requests',{action:'CLAIM',executionRequestId:requestId,claimedBy:'isolated-native-revision-fixture'});assert.equal(claim.status,201,JSON.stringify(claim.body));
  const binding={executionRequestId:requestId,executionDefinitionId:p.recipe.id,callPackageHash:p.recipe.definitionHash};
  const submitted=await post(runs,'v8/runs',{...binding,state:'SUBMITTED',note:'Synthetic protocol test; no provider invocation.'});assert.equal(submitted.status,201,JSON.stringify(submitted.body));
  return {...binding,runId:submitted.body.runId};
 };
 const register=async(p,run,bytes,{unknown=false,parentVersionId=p.recipe.parentVersionId,wrongParentVersionId=null}={})=>{
  const target=path.join(f.root,'media/_review_pending/'+p.result.familyId+'/'+path.basename(p.recipe.output.path));await mkdir(path.dirname(target),{recursive:true});await writeFile(target,bytes,{flag:'wx'});
  const completed=await post(runs,'v8/runs',{...run,state:'SUCCEEDED',note:'Fixed local WAV fixture SHA '+sha256(bytes)+'; no generated result claimed.',...(unknown?{reconciliationEvidence:{requestId:run.executionRequestId,logId:'fixture-local-file:'+sha256(bytes),providerStatusCheckedAt:new Date().toISOString(),providerConclusion:'SUCCEEDED'}}:{})});assert.equal(completed.status,201,JSON.stringify(completed.body));
  const body={familyId:p.result.familyId,expectedOutputId:p.recipe.output.expectedOutputRef,executionDefinitionId:p.recipe.id,callPackageHash:p.recipe.definitionHash,...run,path:p.recipe.output.path,parentVersionId,actualPrompt:p.recipe.prompt,inputBindings:[]};
  if(parentVersionId){const before=await f.repo.exportState();const wrong=await post(versions,'v8/asset-versions',{...body,parentVersionId:null});assert.equal(wrong.status,422,JSON.stringify(wrong.body));assert.deepEqual(await f.repo.exportState(),before);}
  if(wrongParentVersionId){const before=await f.repo.exportState();const wrong=await post(versions,'v8/asset-versions',{...body,parentVersionId:wrongParentVersionId});assert.equal(wrong.status,422,JSON.stringify(wrong.body));assert.deepEqual(await f.repo.exportState(),before,'same-family historical version cannot replace the exact fixed parent');}
  const candidate=await post(versions,'v8/asset-versions',body);assert.equal(candidate.status,201,JSON.stringify(candidate.body));assert.equal(candidate.body.sha256,sha256(bytes));
  const media=await f.repo.getMedia(p.result.familyId,candidate.body.versionId);assert.equal(media.sha256,sha256(bytes));assert.equal(media.metadata.authorityDomain,'FORMAL');
  return {versionId:candidate.body.versionId,sha256:sha256(bytes),body:candidate.body};
 };
 const evidence=async(familyId,candidate)=>{const r=await versions.GET(new Request('http://localhost/api/v8/asset-versions?familyId='+encodeURIComponent(familyId)+'&versionId='+encodeURIComponent(candidate.versionId)+'&sha256='+candidate.sha256+'&productionEvidence=1'));assert.equal(r.status,200,await r.clone().text());const projection=(await r.json()).events[0].productionEvidence;assert.equal(Object.keys(projection.fields).length,8);for(const [name,field] of Object.entries(projection.fields))assert.equal(field.status,'VERIFIED',name+': '+field.reason);return projection;};
 const review=async(p,candidate,action)=>{
  const data=await store.reviewData(),requirement=data.productionModel.materialRequirements.find(r=>r.id===imageRequirementId),spec=requirement.reviewSpec;
  const response=await post(reviews,'v8/reviews',{schemaVersion:'2.2',subjectType:'ASSET',subjectId:p.result.familyId,familyId:p.result.familyId,versionId:candidate.versionId,versionSha256:candidate.sha256,contextHash:store.assetReviewContextHash(data,p.result.familyId,candidate.versionId,candidate.sha256),reviewSpecHash:spec.hash,action,
   criterionFindings:spec.criteria.map((c,i)=>({criterionId:c.id,verdict:action==='REQUEST_REVISION'&&i===0?'FAIL':'PASS',note:'Synthetic local WAV fixture protocol assertion; not a real artistic observation or production review.'})),
   revisionInstructions:action==='REQUEST_REVISION'?{preserve:['Preserve fixture family identity'],change:['Use the second fixed WAV fixture'],mustNotRegress:['Preserve V001 history and SHA']}:null,
   ...(action==='APPROVE_AND_RELEASE'?{rightsUnknownConfirmation:{confirmed:true,scope:'PROJECT_INTERNAL_ONLY',basis:'Test-authored synthetic WAV fixture; no commercial or real production claim.'}}:{}),note:'Isolated real-repository formal review protocol test.'});
  assert.equal(response.status,201,JSON.stringify(response.body));assert.equal(response.body.event.applicationStatus,'APPLIED');assert.equal(response.body.event.effect,'APPLIED');return response.body.event;
 };
 return {...f,store,adapter,materialPost,workspace,saveBody,provision,beginRun,register,review,evidence,post,runs,versions,externalCalls:()=>externalCalls};
}

 test('legacy AUDIO real PostgreSQL API V001 revision → V002 → V003 with immutable source and exact parent',{skip:process.env.REVIEW_TEST_POSTGRES!=='1',timeout:180000},async t=>{
  const f=await apiFixture(t),initial=await f.repo.readView(),old=legacyObjects(initial),definition=initial.recipes.executionDefinitions.find(d=>d.workItemRef===legacyWork);
  const first={result:{familyId:legacyFamily,workItemId:legacyWork},recipe:definition};
  const run1=await f.beginRun(first),v1=await f.register(first,run1,pngs[0],{parentVersionId:null});
  const beforeReview=await f.workspace();assert.equal(beforeReview.mode,'LEGACY_AUDIO_REVISION');assert.ok(beforeReview.blockers.some(b=>b.includes('正式要求修改')));
  const event1=await f.review(first,v1,'REQUEST_REVISION'),w=await f.workspace();assert.deepEqual(w.blockers,[]);assert.equal(w.parentVersionId,v1.versionId);assert.equal(w.parentVersionSha256,v1.sha256);assert.equal(w.plannedVersionLabel,'V002');
  const untouched=await f.repo.exportState(),body=f.saveBody(w,'Second exact fixture voice.');
  assert.equal((await f.materialPost(body,{headers:{Origin:'https://untrusted.example'}})).status,403);assert.equal((await f.materialPost(body,{headers:{'If-Match':'"stale"'}})).status,412);
  assert.equal((await f.materialPost({...body,expectedBasisHash:'0'.repeat(64)})).status,409);
  const {expectedBasisHash,...missing}=body;assert.equal((await f.materialPost(missing)).status,409);
  for(const k of ['REVIEW_INSTANCE_READ_ONLY','REVIEW_REMOTE_READ_ONLY']){process.env[k]='1';assert.equal((await f.materialPost(body)).status,405);process.env[k]='';}assert.deepEqual(await f.repo.exportState(),untouched);
  const second=await f.provision(w,'Second exact fixture voice.');assert.equal(second.plan.schemaVersion,'LEGACY_AUDIO_RECIPE_REVISION_V1');assert.equal(second.result.mode,'LEGACY_AUDIO_REVISION');assert.equal(second.recipe.parentVersionId,v1.versionId);assert.equal(second.recipe.parentVersionSha256,v1.sha256);assert.equal(second.recipe.output.path,'production/generated/05_audio/FIXTURE_VOICE_MASTER_V002.wav');
  const published=await f.repo.readView();assert.deepEqual(published.recipes.executionDefinitions.find(d=>d.id===definition.id),definition);assert.deepEqual(published.eventsByKind.review.find(e=>e.eventId===event1.eventId),event1);assert.equal(published.snapshot.productionModel.materialProductionPlans?.length||0,0);
  const revision=published.snapshot.productionModel.legacyMaterialRecipeRevisions[0],source=await f.repo.readDocumentRevision(revision.sourceRevisionId);assert.equal(source.metadata.sourceRole,'LEGACY_MATERIAL_RECIPE_REVISION');assert.equal(sha256(source.bytes),revision.sourceSha256);
  const documents=await Promise.all(published.sourceRevisionIds.map(id=>f.repo.readDocumentRevision(id))),restored=preserveMaterialProductionProjection({snapshot:initial.snapshot,recipes:initial.recipes,baseSnapshot:published.snapshot,baseRecipes:published.recipes,documents});assert.deepEqual({...restored.recipes,snapshotId:published.recipes.snapshotId},published.recipes);assert.deepEqual(restored.snapshot.productionModel.legacyMaterialRecipeRevisions,published.snapshot.productionModel.legacyMaterialRecipeRevisions);
  const damaged=structuredClone(published.snapshot);damaged.productionModel.legacyMaterialRecipeRevisions[0].parentVersionSha256='0'.repeat(64);assert.throws(()=>preserveMaterialProductionProjection({snapshot:initial.snapshot,recipes:initial.recipes,baseSnapshot:damaged,baseRecipes:published.recipes,documents}),{code:'MATERIAL_PRODUCTION_SOURCE_CONFLICT'});
  const run2=await f.beginRun(second),busy=await f.workspace();assert.ok(busy.blockers.some(b=>b.includes(run2.runId)));assert.equal((await f.materialPost(f.saveBody(busy,'Cannot duplicate'))).status,409);
  assert.equal((await f.post(f.runs,'v8/runs',{...run2,state:'RESULT_UNKNOWN',note:'Fixture outcome unknown, no provider.'})).status,201);const unknown=await f.workspace();assert.ok(unknown.blockers.some(b=>b.includes(run2.runId)));assert.equal((await f.materialPost(f.saveBody(unknown,'No unknown retry'))).status,409);
  const v2=await f.register(second,run2,pngs[1],{unknown:true});assert.equal(v2.versionId,legacyFamily+'@V002');await f.evidence(legacyFamily,v1);await f.evidence(legacyFamily,v2);
  await f.review(second,v2,'REQUEST_REVISION');const third=await f.provision(await f.workspace(),'Third exact fixture voice.');assert.equal(third.recipe.parentVersionId,v2.versionId);
  const v3=await f.register(third,await f.beginRun(third),pngs[0],{wrongParentVersionId:v1.versionId});assert.equal(v3.versionId,legacyFamily+'@V003');await f.review(third,v3,'APPROVE_AND_RELEASE');
  const final=await f.store.operationalSnapshot();assert.equal(final.stateProjection.assetFamiliesById[legacyFamily].currentVersionId,v3.versionId);assert.equal(final.stateProjection.assetVersionsById[v3.versionId].canFlowDownstream,true);
  assert.deepEqual(legacyObjects(await f.repo.readView()),old);
  // An actual approved legacy candidate uses a logical path while its immutable
  // registry points into media/_review_pending. Exercise the real API consumer,
  // not projection flags, through draft, preview, queue and host publication.
  const graph=(await f.repo.readView()).snapshot.productionModel.domainGraph,representation={...graph.representations.find(r=>r.assetFamilyIds.includes(legacyFamily)),id:'representation:derived-voice',assetFamilyIds:[],requirementIds:[downstreamRequirementId]};
  const demand={...graph.requirements[0],id:downstreamRequirementId,representationId:representation.id,mediaType:'AUDIO',category:'voice-identity',acceptanceCriteria:['Synthetic same-identity voice input closure.']};
  await changeDomain(f.repo,'MATERIAL',[{collection:'representations',id:representation.id,beforeHash:null,value:representation},{collection:'requirements',id:demand.id,beforeHash:null,value:demand}]);
  const reference={familyId:legacyFamily,versionId:v3.versionId,sha256:v3.sha256},downstream=await f.workspace(downstreamRequirementId);
  assert.ok(downstream.availableInputs.some(b=>b.familyId===reference.familyId&&b.versionId===reference.versionId&&b.sha256===reference.sha256));
  const registered=await f.repo.getMedia(legacyFamily,v3.versionId);assert.notEqual(registered.relativePath,third.recipe.output.path);assert.equal(sha256(await readFile(path.join(f.root,registered.relativePath))),v3.sha256);
  const sourceBefore=await f.repo.readView(),saved=await f.materialPost({requirementId:downstreamRequirementId,...f.saveBody(downstream,'Synthetic reference input protocol fixture.'),content:{model:'fixture:audio',prompt:'Synthetic same-identity voice input closure only.',negativePrompt:'',parameters:structuredClone(params),inputBindings:[reference]}});
  assert.equal(saved.status,200,JSON.stringify(saved.body));
  const preview=await f.materialPost({action:'preview',requirementId:downstreamRequirementId,draftRevisionId:saved.body.revisionId});assert.equal(preview.status,200,JSON.stringify(preview.body));
  const queued=await f.materialPost({action:'publish',requirementId:downstreamRequirementId,draftRevisionId:saved.body.revisionId,previewHash:preview.body.previewHash});assert.equal(queued.status,200,JSON.stringify(queued.body));
  const applied=await f.repo.writeTransaction(tx=>applyMaterialProductionJob(tx,{jobId:queued.body.jobId,api:f.adapter}));assert.equal(applied.modelCalls,0);
  const downstreamDefinition=(await f.repo.readView()).recipes.executionDefinitions.find(d=>d.id===applied.definitionId);
  assert.deepEqual(downstreamDefinition.upload.items,[{order:1,path:third.recipe.output.path,assetFamilyRef:legacyFamily,assetVersionRef:v3.versionId,sha256:v3.sha256}]);
  const sourceAfter=await f.repo.readView();assert.deepEqual(sourceAfter.eventsByKind,sourceBefore.eventsByKind);assert.deepEqual(await f.repo.getMedia(legacyFamily,v3.versionId),registered);
  assert.equal(sha256(await readFile(path.join(f.root,'media/_review_pending/'+legacyFamily+'/FIXTURE_VOICE_MASTER_V001.wav'))),v1.sha256);assert.deepEqual(legacyObjects(sourceAfter),legacyObjects(sourceBefore));assert.equal(f.externalCalls(),0);
 });
