import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {createServer} from 'vite';
import {blankProfile,blankSnapshot} from '../host/instance-runtime/blank.mjs';
import {createInstanceRepository,sha256} from '../host/instance-runtime/index.mjs';
import {updateGuidance} from '../host/instance-runtime/guidance-service.mjs';
import {ROOT_GUIDANCE_ALIASES,TOPIC_GUIDANCE_ALIASES} from '../host/instance-runtime/guidance-aliases.mjs';

test('real assistant context reads published guidance by exact revision without autoloading topics or mutating events',async()=>{
 const root=path.resolve(import.meta.dirname,'..'),parent=path.join(root,'tests/.test-tmp');await mkdir(parent,{recursive:true});
 const temporary=await mkdtemp(path.join(parent,'guidance-context-')),profile=blankProfile({title:'指引隔离验收'}),dbPath=path.join(temporary,'review.sqlite');
 const repo=await createInstanceRepository({dbPath,instanceId:profile.instanceId,profile});
 const keys=['REVIEW_INSTANCE_DB','REVIEW_INSTANCE_ID','REVIEW_INSTANCE_ROOT','REVIEW_INSTANCE_READ_ONLY','REVIEW_REMOTE_READ_ONLY','REVIEW_SITE_ROOT'];
 const previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 Object.assign(process.env,{REVIEW_INSTANCE_DB:dbPath,REVIEW_INSTANCE_ID:profile.instanceId,REVIEW_INSTANCE_ROOT:'',REVIEW_INSTANCE_READ_ONLY:'',REVIEW_REMOTE_READ_ONLY:'',REVIEW_SITE_ROOT:root});
 const server=await createServer({root,configFile:false,logLevel:'error',cacheDir:path.join(temporary,'vite'),server:{middlewareMode:true},appType:'custom'});let store;
 const change=alias=>({alias,expectedRevisionId:null,expectedSha256:null,newSha256:sha256('规则 '+alias),contentBase64:Buffer.from('规则 '+alias).toString('base64')});
 try{
  await repo.writeTransaction(async tx=>{const ids=[];for(const alias of ROOT_GUIDANCE_ALIASES)ids.push((await tx.putDocument({documentId:'guide:'+alias,aliases:[alias],bytes:'共同规则 '+alias,expectedRevisionId:null,metadata:{sourceRole:'PROJECT_GUIDANCE'}})).revisionId);await tx.publishRelease({...blankSnapshot(profile),expectedReleaseId:null,sourceRevisionIds:ids});});
  const release=await repo.readRelease();await repo.writeTransaction(tx=>updateGuidance(tx,{schemaVersion:'1.1',operationId:'guidance_'+randomUUID(),expectedReleaseId:release.releaseId,changes:TOPIC_GUIDANCE_ALIASES.map(change)}));
  store=await server.ssrLoadModule('/app/api/v8/_store.ts');
  const context=await server.ssrLoadModule('/app/api/assistant/v1/_context.ts'),view=await repo.readView(),before=await repo.listEvents();
  const built=await context.buildAssistantContext({projectId:profile.projectId,subjectType:'PROJECT',subjectId:profile.projectId,snapshotId:view.snapshot.snapshotId,view:'overview',title:'当前工作'});
  assert(built.packet.body.initialResourceIds.includes('guidance:index'));assert(built.packet.body.initialResourceIds.includes('guidance:AGENTS.md'));
  for(const alias of TOPIC_GUIDANCE_ALIASES){const document=await repo.getPublishedDocument(alias),resource=built.catalog.resources.find(x=>x.id==='guidance:'+alias);assert.equal(resource.versionId,document.revisionId);assert.equal(resource.sha256,document.sha256);assert(!built.packet.body.initialResourceIds.includes(resource.id));}
  const alias=TOPIC_GUIDANCE_ALIASES[0],old=await repo.getPublishedDocument(alias),current=await repo.readRelease();
  await repo.writeTransaction(tx=>updateGuidance(tx,{schemaVersion:'1.1',operationId:'guidance_'+randomUUID(),expectedReleaseId:current.releaseId,changes:[{...change(alias),expectedRevisionId:old.revisionId,expectedSha256:old.sha256,newSha256:sha256('新规则'),contentBase64:Buffer.from('新规则').toString('base64')}]}));
  assert.equal(await context.isAssistantContextCurrent(built.packet,[],built.catalog),false);
  assert.deepEqual(await repo.listEvents(),before);
 }finally{await (await store?.instanceRepository())?.close();await repo.close();await server.close();for(const k of keys){if(previous[k]===undefined)delete process.env[k];else process.env[k]=previous[k];}await rm(temporary,{recursive:true,force:true});}
});
