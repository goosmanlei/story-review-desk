import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createServer} from 'vite';
import {blankProfile,blankSnapshot} from '../../host/instance-runtime/blank.mjs';
import {createInstanceRepository} from '../../host/instance-runtime/index.mjs';
import {initializeConfiguration,getConfiguration,previewConfiguration,publishConfiguration} from '../../host/instance-runtime/configuration-service.mjs';
import {sharedStoryPostgres} from './shared-story-postgres.mjs';
import {fixture} from '../modern-event-validator.test.mjs';
const keys=['REVIEW_INSTANCE_DB','REVIEW_INSTANCE_ID','REVIEW_INSTANCE_ROOT','REVIEW_INSTANCE_READ_ONLY','REVIEW_REMOTE_READ_ONLY','REVIEW_SITE_ROOT','REVIEW_EXPORT_DIR','REVIEW_ALLOWED_ORIGINS','REVIEW_POSTGRES_HOST','REVIEW_POSTGRES_PORT','REVIEW_POSTGRES_PASSWORD_FILE','REVIEW_POSTGRES_PASSWORD','REVIEW_POSTGRES_USER'];
export async function episodeSpecApiFixture(t){
 const software=path.resolve(import.meta.dirname,'../..'),parent=path.join(software,'tests/.test-tmp');await mkdir(parent,{recursive:true});const root=await mkdtemp(path.join(parent,'episode-spec-'));
 const env=Object.fromEntries(keys.map(k=>[k,process.env[k]]));let pg,repo,storeRepository,server;
 t.after(async()=>{await storeRepository?.close();await server?.close();await repo?.close();await pg?.cleanup();await rm(root,{recursive:true,force:true});for(const k of keys){if(env[k]===undefined)delete process.env[k];else process.env[k]=env[k];}});
 const f=fixture(),profile=blankProfile({title:'Neutral episode review inheritance',episodePlanId:f.candidate.subjectId}),blank=blankSnapshot(profile);
 pg=await sharedStoryPostgres(root);repo=await createInstanceRepository({root,instanceId:profile.instanceId,backend:'postgres',database:pg.database,profile});
 const snapshot={...blank.snapshot,...f.snapshot,instance:profile,scope:{...blank.snapshot.scope,storyScenes:1},productionModel:{...blank.snapshot.productionModel,...f.snapshot.productionModel,instance:profile}};
 snapshot.productionModel.scenes=[{id:'OLD',title:'旧场',shotIds:[]}];snapshot.productionModel.systemModel={stateModel:{reviewContract:{schemaVersion:'2.2',actions:['APPROVE_AND_RELEASE','REQUEST_REVISION','DO_NOT_USE']}}};
 snapshot.productionModel.episodePlanRevisions=[{id:'plan:proposal',planId:f.candidate.subjectId,scopeRole:'PROPOSAL',revisionState:'PROPOSAL',revisionHash:f.candidate.baseRevisionHash,episodes:[{episodeUid:'episode:old',sceneIds:['OLD']}],retiredEpisodeUids:[]}];
 await repo.writeTransaction(tx=>tx.publishRelease({snapshot,recipes:{...blank.recipes,snapshotId:snapshot.snapshotId},expectedReleaseId:null,sourceRevisionIds:[]}));await repo.writeTransaction(tx=>initializeConfiguration(tx));
 await writeFile(path.join(root,'instance.json'),JSON.stringify({schemaVersion:'2.0',instanceId:profile.instanceId,database:pg.database}));
 Object.assign(process.env,{REVIEW_INSTANCE_DB:'',REVIEW_INSTANCE_ID:profile.instanceId,REVIEW_INSTANCE_ROOT:root,REVIEW_INSTANCE_READ_ONLY:'',REVIEW_REMOTE_READ_ONLY:'',REVIEW_SITE_ROOT:software,REVIEW_EXPORT_DIR:'',REVIEW_ALLOWED_ORIGINS:'http://localhost'});
 server=await createServer({root:software,configFile:false,logLevel:'error',cacheDir:path.join(root,'vite-cache'),server:{middlewareMode:true,hmr:false,ws:false},appType:'custom'});
 const store=await server.ssrLoadModule('/app/api/v8/_store.ts'),route=await server.ssrLoadModule('/app/api/v8/creative-revisions/route.ts');storeRepository=await store.instanceRepository();
 const content=structuredClone(f.candidate.content);content.retiredEpisodeUids=['episode:old'];
 for(const episode of content.episodes){const claim=episode.reviewDossier.purpose.episodeTask;episode.reviewQuestion='本集行动是否清楚？';episode.reviewDossier.informationLayers.hiddenTruth.class='U';episode.reviewDossier.informationLayers.characterKnowledge=[{subjectId:'person:one',knowledge:claim}];episode.reviewDossier.progressionSlices=[{sliceId:episode.episodeUid+':seq:one',sequenceId:'seq:one',sequenceTitle:claim,sceneIds:episode.sceneIds,coverageRole:'EPISODE_SLICE',structuralRole:claim,turningPoint:claim,audienceGain:claim,outputState:claim}];}
 let serial=0;
 const request=async(contentValue=content,{key,etag,extra={}}={})=>{
  const state=await store.operationalSnapshot(),data=await store.reviewData();
  return new Request('http://localhost/api/v8/creative-revisions',{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://localhost','If-Match':etag||state.mutationEtag,'Idempotency-Key':key||'episode-spec:'+String(++serial)},body:JSON.stringify({snapshotId:data.snapshotId,subjectKind:'EPISODE_PLAN',subjectId:f.candidate.subjectId,baseRevisionHash:f.candidate.baseRevisionHash,content:contentValue,basisBindings:f.candidate.basisBindings,authorityClass:'A',evidenceRefs:[],...extra})});
 };
 const post=async(c=content,o={})=>{const response=await route.POST(await request(c,o));return {status:response.status,body:await response.json()};};
 const publishDefaults=async(mutate,upgradeKeys=[])=>{const state=await repo.readTransaction(tx=>getConfiguration(tx)),configuration=structuredClone(state.configuration);mutate(configuration);const input={configuration,expectedReleaseId:state.releaseId,expectedConfigurationRevisionId:state.revisionId,upgradeKeys};const preview=await repo.readTransaction(tx=>previewConfiguration(tx,input));return repo.writeTransaction(tx=>publishConfiguration(tx,{...input,previewHash:preview.previewHash,requestId:'config:fixture:'+String(++serial)}));};
 const first=await post();assert.equal(first.status,201,JSON.stringify(first.body));assert.equal(first.body.event.reviewSpecInheritance,undefined);
 return {root,software,repo,store,route,profile,content,first:first.body.event,post,request,publishDefaults};
}
