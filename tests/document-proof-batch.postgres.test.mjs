import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {createInstanceRepository,sha256} from '../host/instance-runtime/index.mjs';
import {blankProfile} from '../host/instance-runtime/blank.mjs';
import {sharedStoryPostgres} from './fixtures/shared-story-postgres.mjs';
test('read-only metadata shares concurrent queries only within its snapshot; writes and later reads see new heads',{skip:process.env.REVIEW_TEST_POSTGRES!=='1'},async()=>{
 const parent=path.resolve('tests/.test-tmp/document-proof');await mkdir(parent,{recursive:true});
 const root=await mkdtemp(path.join(parent,'metadata-')),profile=blankProfile(),pg=await sharedStoryPostgres(root);let repo;
 try{
  repo=await createInstanceRepository({root,backend:'postgres',database:pg.database,instanceId:profile.instanceId,profile});
  const first=await repo.readTransaction(async tx=>{
   let events=0,heads=0;const all=tx.all.bind(tx);
   tx.all=async(sql,args)=>{if(sql.includes('max(storage_sequence)'))events++;if(sql.startsWith('SELECT namespace,record_key,revision_id'))heads++;return all(sql,args);};
   const values=await Promise.all(Array.from({length:5},async()=>({metadata:await tx.getMetadata(),workspace:await tx.getWorkspaceFingerprint(),projection:await tx.getProjectionFingerprint(['domain-graph'])})));
   assert.equal(events,1);assert.equal(heads,2);for(const value of values)assert.deepEqual(value,values[0]);
   values[1].metadata.instanceId='caller-mutated';assert.equal((await tx.getMetadata()).instanceId,profile.instanceId);
   return values[0];
  });
  await repo.writeTransaction(async tx=>{
   const before=await tx.getMetadata(),workspace=await tx.getWorkspaceFingerprint(),projection=await tx.getProjectionFingerprint(['domain-graph']);
   await tx.putAux({namespace:'domain-graph',key:'current',bytes:'{}',expectedRevisionId:null});
   assert((await tx.getMetadata()).repositoryRevision>before.repositoryRevision);
   assert.notEqual(await tx.getWorkspaceFingerprint(),workspace);assert.notEqual(await tx.getProjectionFingerprint(['domain-graph']),projection);
  });
  const after=await repo.getWorkspaceFingerprint();assert.notEqual(after,first.workspace);
  await assert.rejects(repo.writeTransaction(async tx=>{const head=await tx.getAux('domain-graph','current');await tx.putAux({namespace:'domain-graph',key:'current',bytes:'{"rollback":true}',expectedRevisionId:head.revisionId});await tx.getWorkspaceFingerprint();throw Error('rollback');}),/rollback/);
  assert.equal(await repo.getWorkspaceFingerprint(),after);
  await repo.readTransaction(async tx=>{
   const all=tx.all.bind(tx);let fail=true;tx.all=(...args)=>{if(fail){fail=false;throw Error('descriptor unavailable');}return all(...args);};
   await assert.rejects(tx.getWorkspaceFingerprint(),/descriptor unavailable/);assert.equal(await tx.getWorkspaceFingerprint(),after);
  });
 }finally{await repo?.close();await pg.cleanup();await rm(root,{recursive:true,force:true});}
});
test('historical source batch reads original revisions with bounded bodies and rejects missing, deleted and corrupt sources',{skip:process.env.REVIEW_TEST_POSTGRES!=='1'},async()=>{
 const parent=path.resolve('tests/.test-tmp/document-proof');await mkdir(parent,{recursive:true});
 const root=await mkdtemp(path.join(parent,'instance-')),profile=blankProfile(),pg=await sharedStoryPostgres(root);let repo;
 try {
  repo=await createInstanceRepository({root,backend:'postgres',database:pg.database,instanceId:profile.instanceId,profile});
  const documents=[];
  await repo.writeTransaction(async tx=>{for(let i=0;i<67;i++)documents.push(await tx.putDocument({documentId:'doc:'+i,bytes:i===0?'z'.repeat(5*1024*1024):' original '+i+'\n',aliases:['alias:'+i],expectedRevisionId:null}));});
  await repo.readTransaction(async tx=>{
   let largest=0,queries=0;const all=tx.all.bind(tx);tx.all=async(sql,args)=>{if(sql.includes('SELECT revision_id,record_key,content_bytes')){largest=Math.max(largest,args[0].length);queries++;}return all(sql,args);};
   const proofs=await tx.verifyDocumentRevisions(documents.map(d=>d.revisionId));assert(queries>=4&&queries<=5);assert(largest<=32);
   assert.deepEqual(proofs.sort((a,b)=>a.documentId.localeCompare(b.documentId)),documents.map(d=>({documentId:d.documentId,revisionId:d.revisionId,sha256:sha256(d.bytes),byteSize:d.bytes.length})).sort((a,b)=>a.documentId.localeCompare(b.documentId)));
   assert.deepEqual(await tx.readDocumentRevision(documents[1].revisionId),documents[1]);
  });
  await repo.writeTransaction(async tx=>{await tx.putDocument({documentId:'other',aliases:['doc:1'],bytes:'different',expectedRevisionId:null});});
  assert.deepEqual(await repo.readDocumentRevision(documents[1].revisionId),documents[1]);
  await assert.rejects(repo.verifyDocumentRevisions(['missing']),/missing/);
  const deleted=await repo.writeTransaction(tx=>tx.putDocument({documentId:'deleted',bytes:'deleted',deleted:true,expectedRevisionId:null}));
  await assert.rejects(repo.verifyDocumentRevisions([deleted.revisionId]),/unavailable/);
  // Test-only malformed insertion; never disable the immutable-history trigger.
  await repo.writeTransaction(tx=>tx.run("INSERT INTO record_revisions SELECT 'irv_corrupt-proof',namespace,'corrupt-proof',1,NULL,$1,content_sha256,media_type,metadata_json,deleted,created_at FROM record_revisions WHERE revision_id=$2",[Buffer.from('corrupt'),documents[1].revisionId]));
  await assert.rejects(repo.verifyDocumentRevisions(['irv_corrupt-proof']),/changed/);
 } finally {await repo?.close();await pg.cleanup();await rm(root,{recursive:true,force:true});}
});
