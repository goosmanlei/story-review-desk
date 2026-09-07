import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createInstanceRepository,sha256} from '../host/instance-runtime/index.mjs';
import {blankProfile,blankSnapshot} from '../host/instance-runtime/blank.mjs';
import {inspectGuidance,updateGuidance} from '../host/instance-runtime/guidance-service.mjs';
import {TOPIC_GUIDANCE_ALIASES} from '../host/instance-runtime/guidance-aliases.mjs';
import {sharedStoryPostgres} from './fixtures/shared-story-postgres.mjs';

const newTopic = (alias=TOPIC_GUIDANCE_ALIASES[0], content='专题规则\r\n') => ({
 alias,expectedRevisionId:null,expectedSha256:null,newSha256:sha256(content),contentBase64:Buffer.from(content).toString('base64'),
});
async function topicBatch(repo){const input=await manifest(repo);input.schemaVersion='1.1';input.changes.push(...TOPIC_GUIDANCE_ALIASES.map(alias=>newTopic(alias)));return input;}

async function verifyTopics(repo){
 const input=await topicBatch(repo),before=await repo.readRelease(),events=await repo.listEvents();
 const inspection=await repo.readTransaction(tx=>inspectGuidance(tx,{includeTopics:true}));
 assert.equal((await repo.readTransaction(inspectGuidance)).documents.length,3);
 assert.equal(inspection.documents.length,8);assert.equal(inspection.documents.filter(x=>x.creatable).length,5);
 const proof=await repo.writeTransaction(tx=>updateGuidance(tx,input)),after=await repo.readRelease();
 assert.equal(proof.schemaVersion,'1.1');assert.equal(proof.documents.length,8);
 assert.deepEqual(after.snapshotBytes,before.snapshotBytes);assert.deepEqual(after.recipesBytes,before.recipesBytes);
 assert.deepEqual(after.sourceRevisionIds.filter(id=>!proof.documents.some(x=>x.revisionId===id)),before.sourceRevisionIds.slice(3));
 assert.deepEqual(await repo.listEvents(),events);
 for(const alias of TOPIC_GUIDANCE_ALIASES){
  const row=await repo.getPublishedDocument(alias);assert.equal(row.metadata.sourceRole,'PROJECT_GUIDANCE');
  assert.equal(row.documentId,'project-guidance:'+alias);assert.equal(row.metadata.authoringEntry,'GUIDANCE_UPDATE');
 }
 const replay=await repo.writeTransaction(tx=>updateGuidance(tx,input));assert.equal(replay.replayed,true);
 const current=await repo.readTransaction(tx=>inspectGuidance(tx,{includeTopics:true}));
 assert.equal(current.documents.filter(x=>x.eligible).length,8);
 const topic=current.documents.find(x=>x.alias===TOPIC_GUIDANCE_ALIASES[0]),update={...input,operationId:'guidance_'+randomUUID(),expectedReleaseId:after.releaseId,changes:[{...newTopic(topic.alias,'new topic'),expectedRevisionId:topic.revisionId,expectedSha256:topic.sha256}]};
 await repo.writeTransaction(tx=>updateGuidance(tx,update));assert.equal((await repo.getPublishedDocument(topic.alias)).bytes.toString(),'new topic');
 assert.equal((await repo.readDocument(topic.documentId,{revisionId:topic.revisionId})).sha256,topic.sha256);
 await assert.rejects(repo.writeTransaction(tx=>updateGuidance(tx,{...input,operationId:'guidance_'+randomUUID()})),{code:'GUIDANCE_CONFLICT'});
 const rollback=await topicBatch(repo),stable=await repo.getMetadata();rollback.changes[3].expectedRevisionId=null;rollback.changes[3].expectedSha256=null;
 await assert.rejects(repo.writeTransaction(tx=>updateGuidance(tx,rollback)),{code:'GUIDANCE_CONFLICT'});
 assert.deepEqual(await repo.getMetadata(),stable);
}
test('1.1 creates five exact topics atomically, preserves history, updates by CAS and never publishes unrelated drafts',()=>fixture(verifyTopics));
test('PostgreSQL executes the same 1.0/1.1 guidance transaction and rollback contracts',{skip:process.env.REVIEW_TEST_POSTGRES!=='1',timeout:120000},()=>fixture(async repo=>{
 const first=await manifest(repo);await repo.writeTransaction(tx=>updateGuidance(tx,first));await verifyTopics(repo);
},true));

test('1.0 remains root replacement only; 1.1 refuses null roots, half-null, role injection, unsafe paths, duplicates and oversize batches',()=>fixture(async repo=>{
 for(const mutate of [
  x=>{x.schemaVersion='1.0';x.changes=[newTopic()];},
  x=>{x.changes=[newTopic('README.md')];},
  x=>{x.changes=[{...newTopic(),expectedSha256:'a'.repeat(64)}];},
  x=>{x.changes=[{...newTopic(),expectedRevisionId:'revision'}];},
  x=>{x.changes=[{...newTopic(),sourceRole:'DIRECT_PROMPT'}];},
  x=>{x.changes=[newTopic('guidance/../AGENTS.md')];},
  x=>{x.changes=[newTopic('guidance/custom.md')];},
  x=>{x.changes=[newTopic(),newTopic()];},
  x=>{x.changes.push(newTopic());},
 ]){
  const input=await topicBatch(repo);mutate(input);
  await assert.rejects(repo.writeTransaction(tx=>updateGuidance(tx,input)),{code:'GUIDANCE_INPUT'});
 }
}));
test('an unpublished alias, reserved identity, deleted alias or multi-alias topic cannot be hijacked',()=>fixture(async repo=>{
 const alias=TOPIC_GUIDANCE_ALIASES[0],input=await topicBatch(repo),before=await repo.readRelease();
 await repo.writeTransaction(tx=>tx.putDocument({documentId:'unrelated',aliases:[alias],bytes:'private draft',expectedRevisionId:null,metadata:{sourceRole:'AUTHORING_DRAFT'}}));
 const frozen=await repo.getMetadata();
 await assert.rejects(repo.writeTransaction(tx=>updateGuidance(tx,input)),{code:'GUIDANCE_CONFLICT'});
 assert.deepEqual(await repo.getMetadata(),frozen);assert.equal((await repo.readRelease()).releaseId,before.releaseId);
 const second=TOPIC_GUIDANCE_ALIASES[1];
 await repo.writeTransaction(tx=>tx.putDocument({documentId:'project-guidance:'+second,bytes:'collision',expectedRevisionId:null,metadata:{sourceRole:'AUTHORING_DRAFT'}}));
 await assert.rejects(repo.writeTransaction(tx=>updateGuidance(tx,{...input,changes:[newTopic(second)]})),{code:'GUIDANCE_CONFLICT'});
 const third=TOPIC_GUIDANCE_ALIASES[2];await repo.writeTransaction(tx=>tx.putDocument({documentId:'deleted-topic',aliases:[third],bytes:'deleted evidence',expectedRevisionId:null,deleted:true,metadata:{sourceRole:'PROJECT_GUIDANCE'}}));
 await assert.rejects(repo.writeTransaction(tx=>updateGuidance(tx,{...input,changes:[newTopic(third)]})),{code:'GUIDANCE_CONFLICT'});
}));
test('created topic replacements cannot use a foreign source role or multiple aliases',()=>fixture(async repo=>{
 const initialRelease=await repo.readRelease();await repo.writeTransaction(tx=>updateGuidance(tx,{schemaVersion:'1.1',operationId:'guidance_'+randomUUID(),expectedReleaseId:initialRelease.releaseId,changes:[newTopic()]}));
 const alias=TOPIC_GUIDANCE_ALIASES[0];
 await repo.writeTransaction(async tx=>{const old=await tx.readDocument(alias),release=await tx.readRelease(),next=await tx.putDocument({documentId:old.documentId,bytes:old.bytes,expectedRevisionId:old.revisionId,metadata:{sourceRole:'INSTANCE_GUIDANCE'},aliases:['another-alias']});await tx.publishRelease({snapshotBytes:release.snapshotBytes,recipesBytes:release.recipesBytes,expectedReleaseId:release.releaseId,sourceRevisionIds:release.sourceRevisionIds.map(id=>id===old.revisionId?next.revisionId:id)});});
 const row=await repo.getPublishedDocument(alias),input={schemaVersion:'1.1',operationId:'guidance_'+randomUUID(),expectedReleaseId:(await repo.readRelease()).releaseId,changes:[{...newTopic(),expectedRevisionId:row.revisionId,expectedSha256:row.sha256}]};
 await assert.rejects(repo.writeTransaction(tx=>updateGuidance(tx,input)),{code:'GUIDANCE_ROLE'});
}));

async function fixture(run,postgres=false){const parent=postgres?path.resolve('tests/.test-tmp'):os.tmpdir();await mkdir(parent,{recursive:true});const root=await mkdtemp(path.join(parent,'guidance-test-')),profile=blankProfile({title:'说明维护验收',instanceId:`instance_${randomUUID()}`}),pg=postgres?await sharedStoryPostgres(root):null,repo=await createInstanceRepository(pg?{root,instanceId:profile.instanceId,backend:'postgres',database:pg.database,profile}:{dbPath:path.join(root,'review.sqlite'),instanceId:profile.instanceId,profile});
 try{await repo.writeTransaction(async tx=>{const ids=[];for(const alias of ['README.md','AGENTS.md','STATE.md']){const role=alias==='README.md'?'INSTANCE_GUIDANCE':alias==='AGENTS.md'?'PROJECT_RULE_SOURCE':'MACHINE_MODEL_SOURCE';const row=await tx.putDocument({documentId:'guide:'+alias,aliases:[alias],bytes:alias+' 原始\r\n',expectedRevisionId:null,mediaType:'text/markdown',metadata:{sourceRole:role,role,migrationRebase:'GUIDANCE_REBASE_TO_ACTUAL_BYTES',legacyExpectedSha256:sha256('legacy:'+alias)}});ids.push(row.revisionId);}const creative=await tx.putDocument({documentId:'creative',aliases:['data/creative.json'],bytes:'{"version":1}',expectedRevisionId:null,metadata:{sourceRole:'CREATIVE_SOURCE'}});ids.push(creative.revisionId);const data=blankSnapshot(profile);await tx.publishRelease({snapshotBytes:Buffer.from(' \n'+JSON.stringify(data.snapshot)+'\n'),recipesBytes:Buffer.from('\n'+JSON.stringify(data.recipes)+'  '),expectedReleaseId:null,sourceRevisionIds:ids});await tx.putDocument({documentId:'creative',bytes:'{"version":2}',expectedRevisionId:creative.revisionId});});await run(repo);}finally{await repo.close();await pg?.cleanup();await rm(root,{recursive:true,force:true});}}
async function manifest(repo){const current=await repo.readTransaction(inspectGuidance);return{schemaVersion:'1.0',operationId:`guidance_${randomUUID()}`,expectedReleaseId:current.releaseId,changes:current.documents.map(r=>{const content=Buffer.from(r.alias+' 新说明\r\n\n');return{alias:r.alias,expectedRevisionId:r.revisionId,expectedSha256:r.sha256,newSha256:sha256(content),contentBase64:content.toString('base64')};})};}

test('batch guidance preserves raw release bytes, legacy roles, unrelated published refs and events',()=>fixture(async repo=>{
 const before=await repo.readRelease(),input=await manifest(repo),events=await repo.listEvents();const proof=await repo.writeTransaction(tx=>updateGuidance(tx,input)),after=await repo.readRelease();
 assert.deepEqual(after.snapshotBytes,before.snapshotBytes);assert.deepEqual(after.recipesBytes,before.recipesBytes);assert.deepEqual(await repo.listEvents(),events);assert.equal(after.sourceRevisionIds.at(-1),before.sourceRevisionIds.at(-1));assert.equal(proof.formalAdoptionPerformed,false);assert.equal(proof.productionAuthorizationCreated,false);
 for(const change of proof.documents){const doc=await repo.getPublishedDocument(change.alias);assert.equal(doc.documentId,'guide:'+change.alias);assert.equal(doc.metadata.sourceRole,change.sourceRole);assert.equal(doc.metadata.legacyExpectedSha256,sha256('legacy:'+change.alias));assert.equal(doc.metadata.authoringEntry,'GUIDANCE_UPDATE');assert.equal(doc.sha256,change.sha256);}
 const replay=await repo.writeTransaction(tx=>updateGuidance(tx,input));assert.equal(replay.replayed,true);assert.equal(replay.releaseId,proof.releaseId);assert.equal((await repo.readRelease()).releaseId,after.releaseId);
 const changed=structuredClone(input);changed.changes[0].contentBase64=Buffer.from('changed').toString('base64');changed.changes[0].newSha256=sha256('changed');await assert.rejects(repo.writeTransaction(tx=>updateGuidance(tx,changed)),{code:'GUIDANCE_CONFLICT'});
}));
test('a later batch conflict rolls back earlier documents and the release',()=>fixture(async repo=>{
 const input=await manifest(repo),before=await repo.getMetadata();input.changes[1].expectedSha256='0'.repeat(64);await assert.rejects(repo.writeTransaction(tx=>updateGuidance(tx,input)),{code:'GUIDANCE_CONFLICT'});assert.deepEqual(await repo.getMetadata(),before);assert.equal((await repo.readDocument('README.md')).revisionId,input.changes[0].expectedRevisionId);
}));
test('an unpublished guidance head cannot be silently adopted',()=>fixture(async repo=>{
 const input=await manifest(repo);await repo.writeTransaction(tx=>tx.putDocument({documentId:'guide:AGENTS.md',bytes:'unpublished',expectedRevisionId:input.changes[1].expectedRevisionId}));await assert.rejects(repo.writeTransaction(tx=>updateGuidance(tx,input)),{code:'GUIDANCE_CONFLICT'});assert.equal((await repo.readRelease()).releaseId,input.expectedReleaseId);
}));
test('unknown aliases, arbitrary files, unsafe roles and non-text bytes fail closed',()=>fixture(async repo=>{
 const input=await manifest(repo);for(const transform of [x=>{x.changes[0].alias='production/prompts/direct/test.md';},x=>{x.changes[0].file='/tmp/arbitrary';},x=>{x.changes[0].contentBase64=Buffer.from([0xff]).toString('base64');x.changes[0].newSha256=sha256(Buffer.from([0xff]));}]){const bad=structuredClone(input);transform(bad);await assert.rejects(repo.writeTransaction(tx=>updateGuidance(tx,bad)),e=>['GUIDANCE_INPUT','GUIDANCE_BYTES'].includes(e.code));}
 await repo.writeTransaction(async tx=>{const old=await tx.readDocument('README.md'),r=await tx.putDocument({documentId:old.documentId,bytes:old.bytes,expectedRevisionId:old.revisionId,metadata:{sourceRole:'DIRECT_PROMPT'}}),release=await tx.readRelease();await tx.publishRelease({snapshotBytes:release.snapshotBytes,recipesBytes:release.recipesBytes,expectedReleaseId:release.releaseId,sourceRevisionIds:release.sourceRevisionIds.map(id=>id===old.revisionId?r.revisionId:id)});});await assert.rejects(repo.writeTransaction(async tx=>updateGuidance(tx,await manifest(repo))),{code:'GUIDANCE_ROLE'});
}));
