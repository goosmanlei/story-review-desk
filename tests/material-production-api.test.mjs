import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createServer} from 'vite';
import {materialProductionFixture,imageRequirementId} from './material-production-fixture.mjs';

test('first-family API uses the real repository, exact CAS and idempotent queue without model calls',async t=>{
 const f=await materialProductionFixture(t),keys=['REVIEW_INSTANCE_DB','REVIEW_INSTANCE_ID','REVIEW_INSTANCE_ROOT','REVIEW_INSTANCE_READ_ONLY','REVIEW_REMOTE_READ_ONLY','REVIEW_SITE_ROOT','REVIEW_EXPORT_DIR','REVIEW_ALLOWED_ORIGINS'],env=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 Object.assign(process.env,{REVIEW_INSTANCE_DB:f.dbPath,REVIEW_INSTANCE_ID:f.profile.instanceId,REVIEW_INSTANCE_ROOT:'',REVIEW_INSTANCE_READ_ONLY:'',REVIEW_REMOTE_READ_ONLY:'',REVIEW_SITE_ROOT:f.softwareRoot,REVIEW_EXPORT_DIR:'',REVIEW_ALLOWED_ORIGINS:'http://localhost'});
 const server=await createServer({root:f.softwareRoot,configFile:false,logLevel:'error',cacheDir:path.join(f.root,'vite-cache'),server:{middlewareMode:true},appType:'custom'});let store;
 try{
  store=await server.ssrLoadModule('/app/api/v8/_store.ts');const api=await server.ssrLoadModule('/app/api/instance/material-production/route.ts');
  let externalCalls=0;const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{externalCalls++;throw Error('No provider request is authorized by this test');};
  try{
   const before=await f.repo.exportState(),read=()=>api.GET(new Request('http://localhost/api/instance/material-production?requirementId='+encodeURIComponent(imageRequirementId))),response=await read();assert.equal(response.status,200);const workspace=await response.json();assert.equal(workspace.requirementId,imageRequirementId);assert.equal(workspace.draft,null);assert.equal(workspace.readOnly,false);assert.deepEqual(workspace.jobs,[]);
   const content={model:'test-image-model',prompt:'生成本次明确人物身份的干净母版。',negativePrompt:'无身份漂移。',parameters:{width:1024,height:1024},inputBindings:[]};
   const save={action:'save',requirementId:imageRequirementId,expectedReleaseId:workspace.releaseId,expectedDraftRevisionId:workspace.draftHeadRevisionId,content};
   const request=(body,headers={})=>new Request('http://localhost/api/instance/material-production',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
   const validHeaders=async id=>({Origin:'http://localhost','If-Match':(await store.operationalSnapshot()).mutationEtag,'Idempotency-Key':id});
   assert.equal((await api.POST(request(save))).status,403);assert.equal((await api.POST(request(save,{Origin:'https://other.example'}))).status,403);assert.equal((await api.POST(request(save,{Origin:'http://localhost'}))).status,428);
   assert.equal((await api.POST(request(save,{Origin:'http://localhost','If-Match':'"stale"','Idempotency-Key':'material-api:stale'}))).status,412);
   assert.equal((await api.POST(request({...save,modelCalls:1},await validHeaders('material-api:field')))).status,422);
   assert.equal((await api.POST(request({...save,content:{...content,parameters:{api_key:'FORBIDDEN-TEST-ONLY'}}},await validHeaders('material-api:secret')))).status,422);
   assert.deepEqual(await f.repo.exportState(),before,'rejected requests must not mutate any document, AUX record, event or release');
   const savedResponse=await api.POST(request(save,await validHeaders('material-api:save')));assert.equal(savedResponse.status,200,await savedResponse.clone().text());const saved=await savedResponse.json();assert.ok(saved.revisionId);assert.equal((await f.repo.readView()).releaseId,workspace.releaseId);
   const previewResponse=await api.POST(request({action:'preview',requirementId:imageRequirementId,draftRevisionId:saved.revisionId},await validHeaders('material-api:preview')));assert.equal(previewResponse.status,200,await previewResponse.clone().text());const preview=await previewResponse.json();assert.match(preview.previewHash,/^[a-f0-9]{64}$/);assert.equal(preview.modelCalls,0);
   const publish={action:'publish',requirementId:imageRequirementId,draftRevisionId:saved.revisionId,previewHash:preview.previewHash},queuedResponse=await api.POST(request(publish,await validHeaders('material-api:queue')));assert.equal(queuedResponse.status,200,await queuedResponse.clone().text());const queued=await queuedResponse.json();assert.ok(queued.jobId);assert.equal(queued.status,'QUEUED');assert.equal((await f.repo.readView()).releaseId,workspace.releaseId);
   const replay=await api.POST(request(publish,await validHeaders('material-api:queue')));assert.equal(replay.status,200);assert.deepEqual(await replay.json(),queued);const afterQueue=await (await read()).json();assert.equal(afterQueue.jobs.length,1);assert.equal(afterQueue.jobs[0].jobId,queued.jobId);
   const protectedState=await f.repo.exportState();for(const key of ['REVIEW_INSTANCE_READ_ONLY','REVIEW_REMOTE_READ_ONLY']){process.env[key]='1';assert.equal((await api.POST(request(save))).status,405);process.env[key]='';}assert.deepEqual(await f.repo.exportState(),protectedState);
   assert.equal(externalCalls,0);const view=await f.repo.readView();assert.equal(view.snapshot.productionModel.assetVersions.length,0);assert.equal((await f.repo.listMedia()).length,0);for(const kind of ['execution-request','run','asset-version','review'])assert.equal(view.eventsByKind[kind]?.length||0,0,kind);
  }finally{globalThis.fetch=originalFetch;}
 }finally{
  process.env.REVIEW_SITE_ROOT=f.softwareRoot;process.env.REVIEW_REMOTE_READ_ONLY='';process.env.REVIEW_INSTANCE_READ_ONLY='';await (await store?.instanceRepository())?.close();await server.close();for(const key of keys){if(env[key]===undefined)delete process.env[key];else process.env[key]=env[key];}
 }
});
