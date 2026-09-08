import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {createServer} from 'vite';
import {createInstanceRepository} from '../host/instance-runtime/index.mjs';
import {sharedStoryPostgres} from './fixtures/shared-story-postgres.mjs';
import {sha256} from '../host/instance-runtime/bytes.mjs';
import {materialProductionFixture,imageRequirementId,legacyObjects} from './material-production-fixture.mjs';
import {getMaterialProductionWorkspace,saveMaterialProductionDraft,previewMaterialProduction,enqueueMaterialProduction,applyMaterialProductionJob} from '../host/instance-runtime/material-production-service.mjs';

test('real native first-family CODEX authorize/claim/Run and exact-file candidate registration preserve pending status',{skip:process.env.REVIEW_TEST_POSTGRES!=='1',timeout:120000},async t=>{
 let pg;const keys=['REVIEW_INSTANCE_DB','REVIEW_INSTANCE_ID','REVIEW_INSTANCE_ROOT','REVIEW_INSTANCE_READ_ONLY','REVIEW_REMOTE_READ_ONLY','REVIEW_SITE_ROOT','REVIEW_EXPORT_DIR','REVIEW_ALLOWED_ORIGINS','REVIEW_POSTGRES_HOST','REVIEW_POSTGRES_PORT','REVIEW_POSTGRES_PASSWORD_FILE','REVIEW_POSTGRES_PASSWORD','REVIEW_POSTGRES_USER'],env=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 const f=await materialProductionFixture(t,{repositoryFactory:async({root,profile})=>{pg=await sharedStoryPostgres(root);return createInstanceRepository({root,instanceId:profile.instanceId,backend:'postgres',database:pg.database,profile});}});
 t.after(async()=>{await pg?.cleanup();});
 await writeFile(path.join(f.root,'instance.json'),JSON.stringify({schemaVersion:'2.0',instanceId:f.profile.instanceId,database:pg.database}));
 Object.assign(process.env,{REVIEW_INSTANCE_DB:'',REVIEW_INSTANCE_ID:f.profile.instanceId,REVIEW_INSTANCE_ROOT:f.root,REVIEW_INSTANCE_READ_ONLY:'',REVIEW_REMOTE_READ_ONLY:'',REVIEW_SITE_ROOT:f.softwareRoot,REVIEW_EXPORT_DIR:'',REVIEW_ALLOWED_ORIGINS:'http://localhost'});
 const server=await createServer({root:f.softwareRoot,configFile:false,logLevel:'error',cacheDir:path.join(f.root,'vite-cache'),server:{middlewareMode:true},appType:'custom'});let store;
 try{
  store=await server.ssrLoadModule('/app/api/v8/_store.ts');const adapter={projectOperationalState:store.projectOperationalState},req=await server.ssrLoadModule('/app/api/v8/execution-requests/route.ts'),runs=await server.ssrLoadModule('/app/api/v8/runs/route.ts'),versions=await server.ssrLoadModule('/app/api/v8/asset-versions/route.ts');
  let externalCalls=0;const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{externalCalls++;throw Error('No model/provider call is authorized');};
  try{
   const old=legacyObjects(await f.repo.readView()),workspace=await f.repo.readTransaction(tx=>getMaterialProductionWorkspace(tx,{requirementId:imageRequirementId,api:adapter}));
   const content={model:'codex:gpt-image-2',prompt:'本测试不调用模型。人物干净母版。',negativePrompt:'无漂移。',parameters:{width:1024,height:1024},inputBindings:[]};
   const saved=await f.repo.writeTransaction(tx=>saveMaterialProductionDraft(tx,{requirementId:imageRequirementId,expectedReleaseId:workspace.releaseId,expectedDraftRevisionId:null,content},{api:adapter}));
   const preview=await f.repo.readTransaction(tx=>previewMaterialProduction(tx,{requirementId:imageRequirementId,draftRevisionId:saved.revisionId},{api:adapter}));
   const job=await f.repo.writeTransaction(tx=>enqueueMaterialProduction(tx,{requirementId:imageRequirementId,draftRevisionId:saved.revisionId,previewHash:preview.previewHash,requestId:'native-test:provision'},{api:adapter}));
   const provision=await f.repo.writeTransaction(tx=>applyMaterialProductionJob(tx,{jobId:job.jobId,api:adapter}));
   const view=await f.repo.readView(),recipe=view.recipes.executionDefinitions.find(d=>d.id===provision.definitionId),snapshotId=view.snapshot.snapshotId;
   const post=async(route,url,body,key)=>{const op=await store.operationalSnapshot();const response=await route.POST(new Request('http://localhost'+url,{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://localhost','If-Match':op.mutationEtag,'Idempotency-Key':'native-image-test:'+key},body:JSON.stringify({snapshotId,...body})}));return{status:response.status,body:await response.json()};};
   const authorized=await post(req,'/api/v8/execution-requests',{action:'AUTHORIZE',workItemId:provision.workItemId,familyId:provision.familyId,executionDefinitionId:recipe.id,callPackageHash:recipe.definitionHash,executor:'CODEX',authorized:true,maxOutputs:1,inputBindings:[]},'authorize');assert.equal(authorized.status,201,JSON.stringify(authorized.body));const executionRequestId=authorized.body.executionRequestId;
   const claimed=await post(req,'/api/v8/execution-requests',{action:'CLAIM',executionRequestId,claimedBy:'isolated-test-worker'},'claim');assert.equal(claimed.status,201,JSON.stringify(claimed.body));
   const runBinding={executionRequestId,executionDefinitionId:recipe.id,callPackageHash:recipe.definitionHash};
   const submitted=await post(runs,'/api/v8/runs',{...runBinding,state:'SUBMITTED',note:'Isolated fixture; no model invocation.'},'submitted');assert.equal(submitted.status,201,JSON.stringify(submitted.body));const runId=submitted.body.runId;
   // A pre-existing fixed one-pixel PNG fixture, never a claimed model result.
   const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQ0AAAAASUVORK5CYII=','base64');const target=path.join(f.root,recipe.output.path);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,bytes,{flag:'wx'});
   const succeeded=await post(runs,'/api/v8/runs',{...runBinding,runId,state:'SUCCEEDED',note:'Test fixture file exists with SHA '+sha256(bytes)+'; no external provider was invoked.'},'succeeded');assert.equal(succeeded.status,201,JSON.stringify(succeeded.body));
   const candidate={familyId:provision.familyId,expectedOutputId:recipe.output.expectedOutputRef,executionDefinitionId:recipe.id,callPackageHash:recipe.definitionHash,executionRequestId,runId,path:recipe.output.path,parentVersionId:null,actualPrompt:recipe.prompt,inputBindings:[]};
   for(const [name,patch] of [['wrong-eo',{expectedOutputId:'MP-EO-'+'f'.repeat(24)}],['wrong-path',{path:recipe.output.path.replace('V001','V999')}],['wrong-version',{versionId:provision.familyId+'@V999'}]]){const before=await f.repo.exportState(),rejected=await post(versions,'/api/v8/asset-versions',{...candidate,...patch},name);assert.equal(rejected.status,422,JSON.stringify(rejected.body));assert.deepEqual(await f.repo.exportState(),before);}
   const registered=await post(versions,'/api/v8/asset-versions',candidate,'register');assert.equal(registered.status,201,JSON.stringify(registered.body));assert.equal(registered.body.versionId,provision.familyId+'@V001');assert.equal(registered.body.sha256,sha256(bytes));
   const media=await f.repo.getMedia(provision.familyId,registered.body.versionId);assert.equal(media.sha256,sha256(bytes));assert.equal(media.metadata.authorityDomain,'FORMAL');
   const candidateEvents=(await f.repo.readView()).eventsByKind['asset-version'];assert.equal(candidateEvents.length,1);assert.equal(candidateEvents[0].expectedOutputId,recipe.output.expectedOutputRef);assert.equal(candidateEvents[0].plannedVersionId,recipe.output.expectedOutputRef);assert.equal(candidateEvents[0].projectRightsGate,'UNKNOWN');assert.equal(candidateEvents[0].lifecycleState,'REVIEW_PENDING');
   const duplicate=await post(versions,'/api/v8/asset-versions',candidate,'register-again');assert.equal(duplicate.status,409);assert.equal((await f.repo.readView()).eventsByKind['asset-version'].length,1);
   const evidence=await versions.GET(new Request('http://localhost/api/v8/asset-versions?familyId='+encodeURIComponent(provision.familyId)+'&versionId='+encodeURIComponent(registered.body.versionId)+'&sha256='+sha256(bytes)+'&productionEvidence=1'));assert.equal(evidence.status,200);const projection=(await evidence.json()).events[0].productionEvidence;assert.equal(projection.fields.executionDefinition.status,'VERIFIED');assert.equal(projection.fields.output.status,'VERIFIED');assert.equal(projection.fields.run.status,'VERIFIED');
   const after=await f.repo.readView();assert.deepEqual(legacyObjects(after),old);assert.equal(after.eventsByKind.review?.length||0,0);assert.equal(externalCalls,0);
  }finally{globalThis.fetch=originalFetch;}
 }finally{process.env.REVIEW_REMOTE_READ_ONLY='';process.env.REVIEW_INSTANCE_READ_ONLY='';await (await store?.instanceRepository())?.close();await server.close();for(const key of keys){if(env[key]===undefined)delete process.env[key];else process.env[key]=env[key];}}
});
