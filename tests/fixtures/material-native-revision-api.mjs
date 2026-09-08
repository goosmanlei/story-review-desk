import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {createServer} from 'vite';
import {createInstanceRepository} from '../../host/instance-runtime/index.mjs';
import {sharedStoryPostgres} from './shared-story-postgres.mjs';
import {sha256} from '../../host/instance-runtime/bytes.mjs';
import {materialProductionFixture,imageRequirementId} from '../material-production-fixture.mjs';
import {applyMaterialProductionJob} from '../../host/instance-runtime/material-production-service.mjs';

// Fixed tiny PNG fixtures exercise persistence, never model or artistic quality.
export const pngs=[
 Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQ0AAAAASUVORK5CYII=','base64'),
 Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64'),
];
const keys=['REVIEW_INSTANCE_DB','REVIEW_INSTANCE_ID','REVIEW_INSTANCE_ROOT','REVIEW_INSTANCE_READ_ONLY','REVIEW_REMOTE_READ_ONLY','REVIEW_SITE_ROOT','REVIEW_EXPORT_DIR','REVIEW_ALLOWED_ORIGINS','REVIEW_POSTGRES_HOST','REVIEW_POSTGRES_PORT','REVIEW_POSTGRES_PASSWORD_FILE','REVIEW_POSTGRES_PASSWORD','REVIEW_POSTGRES_USER'];

export async function apiFixture(t){
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
 const [material,requests,runs,versions,reviews]=modules,adapter={projectOperationalState:store.projectOperationalState,safeGeneratedPath:store.safeGeneratedPath,safeReviewPendingPath:store.safeReviewPendingPath};
 const originalFetch=globalThis.fetch;let externalCalls=0,sequence=0;
 globalThis.fetch=async()=>{externalCalls++;throw Error('External model/provider calls are forbidden in this isolated protocol test');};
 t.after(async()=>{globalThis.fetch=originalFetch;process.env.REVIEW_INSTANCE_READ_ONLY='';process.env.REVIEW_REMOTE_READ_ONLY='';await storeRepository.close();await server.close();for(const k of keys){if(env[k]===undefined)delete process.env[k];else process.env[k]=env[k];}});
 const post=async(route,url,body,{key,headers={}}={})=>{
  const op=await store.operationalSnapshot();
  const response=await route.POST(new Request('http://localhost/api/'+url,{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://localhost','If-Match':op.mutationEtag,'Idempotency-Key':key||'material-native:'+String(++sequence),...headers},body:JSON.stringify({...(url.startsWith('v8/')?{snapshotId:(await store.reviewData()).snapshotId}:{}),...body})}));
  return {status:response.status,body:await response.json()};
 };
 const materialPost=(body,options)=>post(material,'instance/material-production',{requirementId:imageRequirementId,...body},options);
 const workspace=async()=>{const r=await material.GET(new Request('http://localhost/api/instance/material-production?requirementId='+encodeURIComponent(imageRequirementId)));assert.equal(r.status,200,await r.clone().text());return r.json();};
 const saveBody=(w,prompt,{inputBindings=[]}={})=>({action:'save',expectedReleaseId:w.releaseId,expectedBasisHash:w.basisHash,expectedDraftRevisionId:w.draftHeadRevisionId,content:{model:'codex:gpt-image-2',prompt,negativePrompt:'No identity drift. Fixture protocol only.',parameters:{width:1,height:1},inputBindings}});
 const provision=async(w,prompt,{expectedMode='FIRST_SETUP',inputBindings=[]}={})=>{
  assert.equal(w.mode,expectedMode);
  const saved=await materialPost(saveBody(w,prompt,{inputBindings}));assert.equal(saved.status,200,JSON.stringify(saved.body));
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
  const a=await post(requests,'v8/execution-requests',{action:'AUTHORIZE',workItemId:p.result.workItemId,familyId:p.result.familyId,executionDefinitionId:p.recipe.id,callPackageHash:p.recipe.definitionHash,executor:'CODEX',authorized:true,maxOutputs:1,inputBindings:p.recipe.upload?.items||[]});assert.equal(a.status,201,JSON.stringify(a.body));
  const requestId=a.body.executionRequestId,claim=await post(requests,'v8/execution-requests',{action:'CLAIM',executionRequestId:requestId,claimedBy:'isolated-native-revision-fixture'});assert.equal(claim.status,201,JSON.stringify(claim.body));
  const binding={executionRequestId:requestId,executionDefinitionId:p.recipe.id,callPackageHash:p.recipe.definitionHash};
  const submitted=await post(runs,'v8/runs',{...binding,state:'SUBMITTED',note:'Synthetic protocol test; no provider invocation.'});assert.equal(submitted.status,201,JSON.stringify(submitted.body));
  return {...binding,runId:submitted.body.runId};
 };
 const register=async(p,run,bytes,{unknown=false,parentVersionId=p.recipe.parentVersionId,wrongParentVersionId=null}={})=>{
  const target=path.join(f.root,p.recipe.output.path);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,bytes,{flag:'wx'});
  const completed=await post(runs,'v8/runs',{...run,state:'SUCCEEDED',note:'Fixed local PNG fixture SHA '+sha256(bytes)+'; no generated result claimed.',...(unknown?{reconciliationEvidence:{requestId:run.executionRequestId,logId:'fixture-local-file:'+sha256(bytes),providerStatusCheckedAt:new Date().toISOString(),providerConclusion:'SUCCEEDED'}}:{})});assert.equal(completed.status,201,JSON.stringify(completed.body));
  const body={familyId:p.result.familyId,expectedOutputId:p.recipe.output.expectedOutputRef,executionDefinitionId:p.recipe.id,callPackageHash:p.recipe.definitionHash,...run,path:p.recipe.output.path,parentVersionId,actualPrompt:p.recipe.prompt,inputBindings:p.recipe.upload?.items||[]};
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
   criterionFindings:spec.criteria.map((c,i)=>({criterionId:c.id,verdict:action==='REQUEST_REVISION'&&i===0?'FAIL':'PASS',note:'Synthetic one-pixel fixture protocol assertion; not a real artistic observation or production review.'})),
   revisionInstructions:action==='REQUEST_REVISION'?{preserve:['Preserve fixture family identity'],change:['Use the second fixed PNG fixture'],mustNotRegress:['Preserve V001 history and SHA']}:null,
   ...(action==='APPROVE_AND_RELEASE'?{rightsUnknownConfirmation:{confirmed:true,scope:'PROJECT_INTERNAL_ONLY',basis:'Test-authored synthetic PNG fixture; no commercial or real production claim.'}}:{}),note:'Isolated real-repository formal review protocol test.'});
  assert.equal(response.status,201,JSON.stringify(response.body));assert.equal(response.body.event.applicationStatus,'APPLIED');assert.equal(response.body.event.effect,'APPLIED');return response.body.event;
 };
 return {...f,store,adapter,materialPost,workspace,saveBody,provision,beginRun,register,review,evidence,post,runs,versions,reviews,externalCalls:()=>externalCalls};
}
