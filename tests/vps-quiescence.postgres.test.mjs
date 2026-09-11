import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import {sharedStoryPostgres} from './fixtures/shared-story-postgres.mjs';
import {blankProfile,blankSnapshot} from '../host/instance-runtime/blank.mjs';
import {createPostgresRepository,importPostgresRows,createArchiveStreamValidator} from '../host/instance-runtime/postgres.mjs';
import {writeArchiveRowsFile} from '../host/instance-runtime/archive-file.mjs';
import {openRepeatableArchive} from '../host/instance-runtime/archive-repeatable-stream.mjs';
import {validateArchiveRows} from '../host/instance-runtime/archive-stream-validation.mjs';
import {canonicalJson,sha256} from '../host/instance-runtime/bytes.mjs';
import {readRestoredAuxiliaryHistory,readCurrentAuxiliaryActivity,classifyRestoredAuxiliaryHistory} from '../host/instance-runtime/vps-quiescence.mjs';

test('real isolated PostgreSQL restore distinguishes imported unknowns from new execution heads',
 {skip:process.env.REVIEW_TEST_POSTGRES!=='1',timeout:120000},async t=>{
 await mkdir('.test-tmp',{recursive:true});const root=await mkdtemp(path.resolve('.test-tmp/vps-quiescence-pg-'));
 let fixture,source,restored,reader,admin;
 t.after(async()=>{await reader?.close();await restored?.close();await source?.close();await admin?.end();await fixture?.cleanup();await rm(root,{recursive:true,force:true});});
 fixture=await sharedStoryPostgres(root);
 const connection={host:process.env.REVIEW_POSTGRES_HOST,port:Number(process.env.REVIEW_POSTGRES_PORT),user:'review',database:'review',password:(await readFile(process.env.REVIEW_POSTGRES_PASSWORD_FILE,'utf8')).trim()};
 const profile=blankProfile({title:'Synthetic VPS quiescence'});
 source=await createPostgresRepository({instanceId:profile.instanceId,profile,connection});
 await source.writeTransaction(async tx=>{
  await tx.publishRelease({...blankSnapshot(profile),expectedReleaseId:null,sourceRevisionIds:[]});
  await tx.putAux({namespace:'worker-comment-polish',key:'old.json',bytes:'{"state":"UNKNOWN","requestId":"old"}',expectedRevisionId:null});
 });
 const file=path.join(root,'source.ndjson');let binding,metadata;
 await source.readTransaction(async tx=>{
  const scan=await tx.scanValidatedArchive();metadata=await tx.getMetadata();
  binding=await writeArchiveRowsFile(file,{...scan,iterate:table=>tx.iterateArchiveRows(table)});
 });
 const baseline={instanceId:metadata.instanceId,releaseId:metadata.releaseId,repositoryRevision:metadata.repositoryRevision,database:{path:'data/repository.jsonl',...binding}};
 baseline.manifestSha256=sha256(canonicalJson(baseline));
 const history=await readRestoredAuxiliaryHistory({manifest:{baseline},open:()=>createReadStream(file)});
 reader=await openRepeatableArchive(()=>createReadStream(file),binding);
 await validateArchiveRows(reader,{instanceId:profile.instanceId,createValidator:createArchiveStreamValidator});
 admin=new pg.Client(connection);await admin.connect();await admin.query('CREATE DATABASE quiescence_restored TEMPLATE template0');
 restored=await importPostgresRows({reader,instanceId:profile.instanceId,connection:{...connection,database:'quiescence_restored'}});
 const actual=restored.importVerification;
 const proof={status:'RESTORED_VERIFIED',...actual.metadata,originalBytesPreserved:actual.originalBytesPreserved,businessIdsPreserved:actual.businessIdsPreserved,integrity:actual.integrity,streamPasses:reader.passes,scratchArchiveBytes:0};
 assert.equal(reader.passes,4);assert(actual.integrity.ok);
 const runtime={instanceId:profile.instanceId,runtimeEpoch:actual.metadata.runtimeEpoch};
 const inspect=async()=>({...await restored.readTransaction(readCurrentAuxiliaryActivity),restoreManifestHash:sha256(canonicalJson(baseline)),restoreProof:proof});
 let inspection=await inspect();const check={metadata:inspection.metadata,blockers:inspection.records.map(({namespace,key,state})=>({namespace,key,state}))};
 let result=classifyRestoredAuxiliaryHistory(check,inspection,history,runtime);
 assert.equal(result.restoredHistory.length,1);assert.equal(result.blockers.length,0);
 const old=await restored.getAux('worker-comment-polish','old.json');
 await restored.writeTransaction(async tx=>{
  const changed=await tx.putAux({namespace:'worker-comment-polish',key:'old.json',bytes:'{"state":"UNKNOWN","requestId":"new"}',expectedRevisionId:old.revisionId});
  await tx.putAux({namespace:'worker-comment-polish',key:'old.json',bytes:old.bytes,expectedRevisionId:changed.revisionId});
  await tx.putAux({namespace:'worker-comment-polish',key:'new.json',bytes:'{"status":"RUNNING"}',expectedRevisionId:null});
 });
 inspection=await inspect();result=classifyRestoredAuxiliaryHistory(check,inspection,history,runtime);
 assert.equal(result.restoredHistory.length,0);assert.equal(result.blockers.length,2);
 assert.deepEqual(new Set(result.blockers.map(b=>b.key)),new Set(['old.json','new.json']));
 assert.equal((await restored.getAux('worker-comment-polish','old.json')).sha256,old.sha256);
 assert.notEqual((await restored.getAux('worker-comment-polish','old.json')).revisionId,old.revisionId);
 assert.equal((await source.getAux('worker-comment-polish','old.json')).revisionId,old.revisionId);
});
