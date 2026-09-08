import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {createServer} from 'vite';
import {createInstanceRepository} from '../host/instance-runtime/index.mjs';
import {blankProfile,blankSnapshot} from '../host/instance-runtime/blank.mjs';
import {initializeConfiguration} from '../host/instance-runtime/configuration-service.mjs';
import {canonicalJson,sha256} from '../host/instance-runtime/bytes.mjs';
import {applyProductionSpatialProjection,spatialShotViewReasons} from '../host/instance-runtime/spatial-production.mjs';
import {SPATIAL_SHOT_VIEW_NS,runSpatialShotViewIteration} from '../host/instance-runtime/spatial-shot-view-service.mjs';
import {sharedStoryPostgres} from './fixtures/shared-story-postgres.mjs';

const hash=value=>sha256(canonicalJson(value));
const scenes=['scene:spatial-pg-one','scene:spatial-pg-two'];
const environmentKeys=['REVIEW_INSTANCE_DB','REVIEW_INSTANCE_ID','REVIEW_INSTANCE_ROOT','REVIEW_INSTANCE_READ_ONLY','REVIEW_REMOTE_READ_ONLY','REVIEW_SITE_ROOT','REVIEW_EXPORT_DIR','REVIEW_ALLOWED_ORIGINS','REVIEW_POSTGRES_HOST','REVIEW_POSTGRES_PORT','REVIEW_POSTGRES_PASSWORD_FILE','REVIEW_POSTGRES_PASSWORD','REVIEW_POSTGRES_USER'];

async function fixture(t){
 const softwareRoot=path.resolve(import.meta.dirname,'..'),temporaryParent=path.join(softwareRoot,'tests/.test-tmp');
 await mkdir(temporaryParent,{recursive:true});
 const root=await mkdtemp(path.join(temporaryParent,'spatial-view-postgres-')),env=Object.fromEntries(environmentKeys.map(key=>[key,process.env[key]])),originalFetch=globalThis.fetch;
 let pg,repo,server,storeRepository,externalCalls=0;
 t.after(async()=>{globalThis.fetch=originalFetch;process.env.REVIEW_INSTANCE_READ_ONLY='';process.env.REVIEW_REMOTE_READ_ONLY='';await storeRepository?.close();await server?.close();await repo?.close();await pg?.cleanup();await rm(root,{recursive:true,force:true});for(const key of environmentKeys){if(env[key]===undefined)delete process.env[key];else process.env[key]=env[key];}});
 const profile=blankProfile({title:'Isolated spatial author PostgreSQL protocol test'});
 pg=await sharedStoryPostgres(root);repo=await createInstanceRepository({root,instanceId:profile.instanceId,backend:'postgres',database:pg.database,profile});
 await repo.writeTransaction(tx=>tx.publishRelease({...blankSnapshot(profile),expectedReleaseId:null,sourceRevisionIds:[]}));
 await repo.writeTransaction(tx=>initializeConfiguration(tx));
 const spec={version:'fixture-1',locations:[{id:'ROOM-A',name:'测试房间 A'},{id:'ROOM-B',name:'测试房间 B'}],minimal_location_packages:Object.fromEntries(['A','B'].map(letter=>['ROOM-'+letter,{name:'测试房间 '+letter,fact_boundary:'原始测试空间',lock_boundary:'原门窗与几何保持',zones:[{id:'ZONE-'+letter,name:'原区域'}],cameras:[{id:'CAM-'+letter,zoneId:'ZONE-'+letter,from:'南侧门槛',looks:'北'}]}]))};
 let map;
 await repo.writeTransaction(async tx=>{
  const view=await tx.readView();map=await tx.putDocument({documentId:'spatial:pg-map',aliases:['data/production_map_spec.json'],expectedRevisionId:null,bytes:canonicalJson(spec),metadata:{sourceRole:'MACHINE_MODEL_SOURCE'}});
  const snapshot=structuredClone(view.snapshot),model=snapshot.productionModel;
  snapshot.sourceHashes={...snapshot.sourceHashes,productionMapSha256:map.sha256};
  model.sceneScriptRevisions=scenes.map((sceneId,index)=>({id:'script:spatial-pg-'+index,sceneId,scopeRole:'CURRENT',episodeNarrativeReleaseId:'episode:spatial-pg-release',contentHash:hash(sceneId)}));
  model.episodeNarrativeReleases=[{id:'episode:spatial-pg-release',episodeUid:'episode:spatial-pg',scopeRole:'CURRENT',sourceSyncState:'SOURCE_CURRENT',episodeScriptReleaseSnapshot:{id:'episode:spatial-pg-snapshot',contentHash:hash(scenes)},reviewInput:{scenes:scenes.map(sceneId=>({id:sceneId,contentHash:hash(sceneId)}))}}];
  model.shots=scenes.map((sceneId,index)=>({id:'shot:spatial-pg-'+index,sceneId,scopeRole:'CURRENT',activeInCurrentProduction:true}));
  await tx.publishRelease({snapshot,recipes:view.recipes,expectedReleaseId:view.releaseId,sourceRevisionIds:[...view.sourceRevisionIds,map.revisionId]});
 });
 await writeFile(path.join(root,'instance.json'),JSON.stringify({schemaVersion:'2.0',instanceId:profile.instanceId,database:pg.database}));
 Object.assign(process.env,{REVIEW_INSTANCE_DB:'',REVIEW_INSTANCE_ID:profile.instanceId,REVIEW_INSTANCE_ROOT:root,REVIEW_INSTANCE_READ_ONLY:'',REVIEW_REMOTE_READ_ONLY:'',REVIEW_SITE_ROOT:softwareRoot,REVIEW_EXPORT_DIR:'',REVIEW_ALLOWED_ORIGINS:'http://localhost'});
 server=await createServer({root:softwareRoot,configFile:false,logLevel:'error',cacheDir:path.join(root,'vite-cache'),server:{middlewareMode:true,hmr:false},appType:'custom'});
 const store=await server.ssrLoadModule('/app/api/v8/_store.ts'),route=await server.ssrLoadModule('/app/api/instance/spatial-shot-view/route.ts');
 storeRepository=await store.instanceRepository();
 globalThis.fetch=async()=>{externalCalls++;throw Error('External provider calls are forbidden in this isolated spatial protocol test');};
 let sequence=0;
 const workspace=async(sceneId=scenes[0])=>{const response=await route.GET(new Request('http://localhost/api/instance/spatial-shot-view?sceneId='+encodeURIComponent(sceneId)));assert.equal(response.status,200,await response.clone().text());return response.json();};
 const post=async(body,{key,headers={}}={})=>{
  const h=new Headers({'Content-Type':'application/json',Origin:'http://localhost','If-Match':(await store.operationalSnapshot()).mutationEtag,'Idempotency-Key':key||'spatial-pg:'+String(++sequence)});
  for(const [name,value] of Object.entries(headers)){if(value===null)h.delete(name);else h.set(name,value);}
  const response=await route.POST(new Request('http://localhost/api/instance/spatial-shot-view',{method:'POST',headers:h,body:JSON.stringify(body)}));return {status:response.status,body:await response.json()};
 };
 const author=(w,note='原门窗不动，在本场增加床的机位与摆位。')=>({sceneId:w.sceneId,viewId:w.viewId,locationId:'ROOM-A',zoneId:'ZONE-A',camera:{origin:'NORTHEAST_INTERIOR',looks:'SOUTHWEST',height:'EYE_LEVEL',purpose:'测试本场反向视角'},dressing:[{id:'DRESSING-PG-BED',kind:'BED',anchor:{kind:'CAMERA',id:'CAM-A'},relation:'WEST_OF',orientation:'EAST_WEST',appearance:'独立原木床，与原家具分开'}],note});
 const saveBody=(w,content=author(w))=>({action:'save',sceneId:w.sceneId,viewId:w.viewId,expectedReleaseId:w.releaseId,expectedBasisHash:w.basisHash,expectedDraftRevisionId:w.draftHeadRevisionId,content});
 const stage=async(w,content=author(w))=>{
  const saved=await post(saveBody(w,content));assert.equal(saved.status,200,JSON.stringify(saved.body));assert.equal(saved.body.modelCalls,0);
  const preview=await post({action:'preview',sceneId:w.sceneId,viewId:w.viewId,draftRevisionId:saved.body.revisionId});assert.equal(preview.status,200,JSON.stringify(preview.body));assert.equal(preview.body.modelCalls,0);assert.equal(preview.body.formalAdoptionPerformed,false);
  assert.equal(preview.body.view.sceneBinding.sceneId,w.sceneId);assert.equal(preview.body.view.base.sourceRevisionId,map.revisionId);assert.equal(preview.body.view.base.sourceSha256,map.sha256);
  assert.equal(preview.body.view.camera.origin,content.camera.origin);assert.deepEqual(preview.body.view.dressing,content.dressing);
  return {w,content,saved:saved.body,preview:preview.body,publish:{action:'publish',sceneId:w.sceneId,viewId:w.viewId,draftRevisionId:saved.body.revisionId,previewHash:preview.body.previewHash}};
 };
 const queue=async(s,key)=>{const result=await post(s.publish,{key});assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.status,'QUEUED');return result;};
 return {repo,map,store,workspace,post,author,saveBody,stage,queue,externalCalls:()=>externalCalls};
}

test('spatial author real PostgreSQL API publishes exact local views, preserves base/history and limits reopening to their consumers',{skip:process.env.REVIEW_TEST_POSTGRES!=='1',timeout:180000},async t=>{
 const f=await fixture(t),before=await f.repo.readView(),initial=await f.workspace(),save=f.saveBody(initial),unchanged=await f.repo.exportState();
 assert.deepEqual(initial.blockers,[]);assert.equal(initial.defaults.locationId,'');assert.equal(initial.draftHeadRevisionId,null);
 assert.equal((await f.post(save,{headers:{Origin:'https://untrusted.example'}})).status,403);
 assert.equal((await f.post(save,{headers:{'If-Match':null}})).status,428);
 assert.equal((await f.post(save,{headers:{'If-Match':'"stale"'}})).status,412);
 assert.equal((await f.post({...save,expectedBasisHash:'0'.repeat(64)})).status,409);
 assert.equal((await f.post({...save,content:{...save.content,sourceRevisionId:f.map.revisionId}})).status,422);
 for(const key of ['REVIEW_INSTANCE_READ_ONLY','REVIEW_REMOTE_READ_ONLY']){try{process.env[key]='1';assert.equal((await f.post(save)).status,405);}finally{process.env[key]='';}}
 assert.deepEqual(await f.repo.exportState(),unchanged,'invalid or read-only requests must not write AUX or formal state');

 const first=await f.stage(initial),queued=await f.queue(first,'spatial-pg:first');
 assert.deepEqual(await f.queue(first,'spatial-pg:first'),queued);
 const queuedState=await f.repo.exportState();assert.equal((await f.post(first.publish)).status,409);assert.deepEqual(await f.repo.exportState(),queuedState);
 const afterQueue=await f.repo.readView();assert.ok(afterQueue.repositoryRevision>before.repositoryRevision);assert.deepEqual({...afterQueue,repositoryRevision:before.repositoryRevision},before,'Web save/preview/queue changes AUX revision only, leaving the published view untouched');
 // Lose the transaction acknowledgement after its actual PG commit. The worker
 // must reread its exact job, return the committed proof and never publish twice.
 let loseCommitResponse=true;
 const repository={readOnly:false,readTransaction:callback=>f.repo.readTransaction(callback),writeTransaction:async callback=>{const value=await f.repo.writeTransaction(callback);if(loseCommitResponse){loseCommitResponse=false;throw Error('Synthetic lost PostgreSQL commit response');}return value;}};
 const result=await runSpatialShotViewIteration({repository});assert.equal(result.status,'SUCCEEDED');assert.equal(result.jobId,queued.body.jobId);assert.equal(result.modelCalls,0);assert.equal(result.formalAdoptionPerformed,false);
 const afterFirst=await f.repo.readView(),v1=afterFirst.snapshot.productionModel.spatialShotViews[0],source1=await f.repo.readDocumentRevision(v1.sourceRevisionId);
 assert.equal(v1.id,first.preview.view.id);assert.equal(source1.metadata.sourceRole,'SPATIAL_SHOT_VIEW');assert.equal(sha256(source1.bytes),v1.sourceSha256);assert.deepEqual(JSON.parse(source1.bytes),first.preview.view);assert.equal(v1.content.preserveBaseGeometry,true);
 const readAfterFirst=await f.workspace();assert.equal(readAfterFirst.currentView.id,v1.id);assert.equal(readAfterFirst.draft,null);assert.deepEqual(readAfterFirst.staleDraft.content,first.content);assert.ok(readAfterFirst.jobs.some(job=>job.jobId===queued.body.jobId&&job.status==='SUCCEEDED'));

 const other=await f.stage(await f.workspace(scenes[1]),f.author(await f.workspace(scenes[1]),'第二永久场的独立视角，不借第一场身份。'));await f.queue(other,'spatial-pg:other');assert.equal((await runSpatialShotViewIteration({repository:f.repo})).status,'SUCCEEDED');
 const otherView=(await f.repo.readView()).snapshot.productionModel.spatialShotViews.find(row=>row.viewId===other.w.viewId),otherSource=await f.repo.readDocumentRevision(otherView.sourceRevisionId);
 const current=await f.workspace(),oldScope=await f.repo.exportState();
 assert.equal((await f.post({...f.saveBody(current),content:{...f.author(current),locationId:'ROOM-B',zoneId:'ZONE-B',dressing:[]}})).status,409);
 assert.deepEqual(await f.repo.exportState(),oldScope,'a stable local view cannot move to another location');
 const second=await f.stage(current,{...f.author(current,'本场机位调整到西北角，原门窗与家具身份保持。'),camera:{...f.author(current).camera,origin:'NORTHWEST_INTERIOR',looks:'SOUTHEAST'}});await f.queue(second,'spatial-pg:second');assert.equal((await runSpatialShotViewIteration({repository:f.repo})).status,'SUCCEEDED');
 const after=await f.repo.readView(),rows=after.snapshot.productionModel.spatialShotViews,v2=rows.find(row=>row.viewId===initial.viewId&&row.scopeRole==='CURRENT');
 assert.equal(rows.length,3);assert.equal(rows.find(row=>row.id===v1.id).scopeRole,'EVIDENCE_ONLY');assert.notEqual(v1.id,v2.id);assert.equal(v1.content.camera.id,v2.content.camera.id);
 assert.deepEqual(rows.find(row=>row.id===otherView.id),otherView);assert.deepEqual(await f.repo.readDocumentRevision(v1.sourceRevisionId),source1);assert.deepEqual(await f.repo.readDocumentRevision(otherView.sourceRevisionId),otherSource);
 const model=await f.repo.readTransaction(tx=>applyProductionSpatialProjection(tx,{...after.snapshot.productionModel,sourceHashes:after.snapshot.sourceHashes},{view:after}));
 const binding=(row,index)=>({shotId:'shot:spatial-pg-'+index,space:{loc:row.content.base.locationId,zone:row.content.base.zoneId,camera:row.content.camera.id,freeze:row.id}});
 assert.deepEqual(spatialShotViewReasons(model,binding(v1,0)),['SPACE_LOCAL_VIEW_NOT_CURRENT']);assert.deepEqual(spatialShotViewReasons(model,binding(v2,0)),[]);assert.deepEqual(spatialShotViewReasons(model,binding(otherView,1)),[]);assert.ok(spatialShotViewReasons(model,binding(v2,1)).length,'local views cannot bind another permanent scene');
 assert.deepEqual(await f.repo.readDocumentRevision(f.map.revisionId),f.map);assert.deepEqual(await f.repo.readDocument('data/production_map_spec.json'),f.map);assert.equal(after.snapshot.sourceHashes.productionMapSha256,f.map.sha256);
 assert.deepEqual(after.snapshot.productionModel.domainGraph,before.snapshot.productionModel.domainGraph);assert.deepEqual(after.recipes.executionDefinitions,before.recipes.executionDefinitions);assert.deepEqual(after.eventsByKind,before.eventsByKind);assert.deepEqual(await f.repo.listMedia(),[]);assert.equal(after.snapshot.snapshotId,after.recipes.snapshotId);

 const unknownDraft=await f.stage(await f.workspace(),f.author(await f.workspace(),'只测试结果未知防重发，不能声称空间已发布。')),unknown=await f.queue(unknownDraft,'spatial-pg:unknown');
 await f.repo.writeTransaction(async tx=>{const record=await tx.getAux(SPATIAL_SHOT_VIEW_NS.jobs,unknown.body.jobId);await tx.putAux({namespace:SPATIAL_SHOT_VIEW_NS.jobs,key:unknown.body.jobId,expectedRevisionId:record.revisionId,bytes:canonicalJson({...JSON.parse(record.bytes),status:'RESULT_UNKNOWN'})});});
 const unknownState=await f.repo.exportState();assert.deepEqual(await runSpatialShotViewIteration({repository:f.repo}),{processed:false});assert.equal((await f.post(unknownDraft.publish)).status,409);assert.deepEqual(await f.repo.exportState(),unknownState);assert.ok((await f.workspace()).jobs.some(job=>job.jobId===unknown.body.jobId&&job.status==='RESULT_UNKNOWN'));
 assert.equal(f.externalCalls(),0);
});
