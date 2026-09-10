import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,realpath,lstat,rm} from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import {sharedStoryPostgres} from './fixtures/shared-story-postgres.mjs';
import {docker,POSTGRES_IMAGE} from '../scripts/instance-postgres.mjs';
import {blankProfile,blankSnapshot} from '../host/instance-runtime/blank.mjs';
import {canonicalJson,sha256} from '../host/instance-runtime/bytes.mjs';
import {canonicalSha256,archiveRowHashes} from '../host/instance-runtime/archive-integrity.mjs';
import {BUSINESS_TABLES} from '../host/instance-runtime/postgres-schema.mjs';
import {createPostgresRepository,createArchiveStreamValidator,importPostgresRows} from '../host/instance-runtime/postgres.mjs';
import {writeArchiveRowsFile,writeArchiveFile} from '../host/instance-runtime/archive-file.mjs';
import {openArchiveRowsWithBinding,validateArchiveRows} from '../host/instance-runtime/archive-stream-validation.mjs';
import {isRestoredRuntime} from '../host/instance-runtime/execution-epoch.mjs';
import {dockerHostPath} from '../host/instance-runtime/docker-path.mjs';

// Opt-in only. No default project/database/port, and no real media fixture.
// This test owns one UUID container/volume and all databases inside it. It does
// not call instance initialization, transport, workers, Web routes or providers.
test('real PostgreSQL NDJSON import preserves rows and rejects casts before commit',
 {skip:process.env.REVIEW_TEST_POSTGRES!=='1',timeout:120000},async t=>{
 const declared=process.env.REVIEW_STREAM_PG_TEST_ROOT;
 assert(declared&&path.isAbsolute(declared),'REVIEW_STREAM_PG_TEST_ROOT must be an explicit absolute test parent');
 const parent=path.resolve(declared);
 assert.equal(path.basename(parent),'postgres-stream-test-runs','Use the dedicated test parent, not an instance root');
 await mkdir(parent,{recursive:true,mode:0o700});assert.equal(await realpath(parent),parent);
 const temporary=await mkdtemp(path.join(parent,'stream-pg-'));
 assert.equal(await realpath(temporary),temporary);
 const envKeys=['REVIEW_POSTGRES_HOST','REVIEW_POSTGRES_PORT','REVIEW_POSTGRES_PASSWORD_FILE',
  'REVIEW_POSTGRES_PASSWORD','REVIEW_POSTGRES_USER','REVIEW_INSTANCE_READ_ONLY','REVIEW_REMOTE_READ_ONLY'];
 const previous=new Map(envKeys.map(key=>[key,process.env[key]]));
 const receipt={schemaVersion:'1.0',syntheticOnly:true,startedAt:new Date().toISOString(),testRoot:temporary,
  image:POSTGRES_IMAGE,resources:null,scenarios:[],cleanup:null};
 const repositories=new Set(),readers=new Set(),clients=new Set(),sqlEvents=[];
 const realQuery=pg.Client.prototype.query;
 let fixture,resource,connection,admin;
 const ownedDatabases=new Set(['review']);
 async function connect(database){
  assert(ownedDatabases.has(database));const client=new pg.Client({...connection,database});
  clients.add(client);await client.connect();return client;
 }
 async function createTarget(database){
  assert(/^stream_import_[a-z]+$/.test(database));assert(!ownedDatabases.has(database));
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);ownedDatabases.add(database);
  const client=await connect(database);
  assert.equal((await client.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'")).rows[0].n,0);
  await client.end();clients.delete(client);
  return {...connection,database};
 }
 async function readValidated(file,binding,instanceId){
  const reader=await openArchiveRowsWithBinding(file,binding);readers.add(reader);
  const proof=await validateArchiveRows(reader,{instanceId,createValidator:createArchiveStreamValidator});
  return {reader,proof};
 }
 try{
  fixture=await sharedStoryPostgres(temporary);
  const prefix=fixture.database.volume.slice('review_pg_'.length);
  assert(/^[a-f0-9]{20}$/.test(prefix));
  const names=String(await docker(['ps','-a','--filter','label=review.test=shared-story-comments','--format','{{.Names}}']))
   .trim().split('\n').filter(name=>name.startsWith('review-comments-test-'+prefix));
  assert.equal(names.length,1,'The fixture must resolve to exactly its own UUID container');
  const inspected=JSON.parse(String(await docker(['inspect',names[0]])))[0];
  const suffix=names[0].slice('review-comments-test-'.length),volume='review_comments_test_'+suffix;
  resource={containerName:names[0],containerId:inspected.Id,volume};
  receipt.resources={...resource,imageId:inspected.Image};
  assert(/^[a-f0-9]{32}$/.test(suffix));assert.equal(inspected.Name,'/'+names[0]);
  assert.equal(inspected.Config.Labels['review.test'],'shared-story-comments');
  const mounts=inspected.Mounts,media=mounts.find(row=>row.Destination==='/var/lib/postgresql'),secret=mounts.find(row=>row.Destination==='/run/secrets/password');
  assert.equal(mounts.length,2);assert.equal(media.Type,'volume');assert.equal(media.Name,volume);
  assert.equal(secret.Type,'bind');assert.equal(secret.RW,false);
  const secretPath=path.join(temporary,'runtime/private/postgres-password');
  assert.equal(dockerHostPath(secret.Source),secretPath);
  const ports=inspected.NetworkSettings.Ports['5432/tcp'];
  assert.equal(ports.length,1);assert.equal(ports[0].HostIp,'127.0.0.1');
  resource.loopbackPort=Number(ports[0].HostPort);
  receipt.resources.loopbackPort=resource.loopbackPort;
  const passwordInfo=await lstat(secretPath);assert(passwordInfo.isFile()&&!passwordInfo.isSymbolicLink());
  assert.equal(passwordInfo.mode&0o077,0);
  connection={host:'127.0.0.1',port:resource.loopbackPort,user:'review',database:'review',
   password:(await readFile(secretPath,'utf8')).trim(),connectionTimeoutMillis:5000,statement_timeout:30000,
   application_name:'isolated-archive-stream-test'};
  process.env.REVIEW_INSTANCE_READ_ONLY='';process.env.REVIEW_REMOTE_READ_ONLY='';
  // Observe real pg calls without replacing any result. Only identifiers and
  // transaction boundaries are retained; SQL parameters/body/credentials are not.
  pg.Client.prototype.query=function(...args){
   const p=this.connectionParameters;
   assert.equal(p.host,connection.host);assert.equal(Number(p.port),connection.port);
   assert(ownedDatabases.has(p.database),'No query may escape the owned test databases');
   const sql=typeof args[0]==='string'?args[0]:args[0]?.text;
   if(typeof sql==='string'){
    const trimmed=sql.trim(),insert=/^INSERT INTO ([a-z_]+)/.exec(trimmed);
    if(/^(BEGIN|COMMIT|ROLLBACK)(?:\s|$)/.test(trimmed))sqlEvents.push({database:p.database,kind:trimmed.split(/\s/)[0]});
    else if(insert&&BUSINESS_TABLES.includes(insert[1]))sqlEvents.push({database:p.database,kind:'INSERT',table:insert[1]});
   }
   return Reflect.apply(realQuery,this,args);
  };
  admin=await connect('review');
  const profile=blankProfile({title:'流式恢复隔离测试'}),instanceId=profile.instanceId;
  const source=await createPostgresRepository({instanceId,profile,connection});repositories.add(source);
  const documentBytes=[Buffer.from('# 合成来源\r\n甲：仅用于隔离验证。\r\n'),Buffer.from('# 合成来源\n甲：第二修订，保留字节。\n')];
  let sourceIds=[],releaseId;
  await source.writeTransaction(async tx=>{
   let document=await tx.putDocument({documentId:'synthetic-source',aliases:['source/synthetic.md'],bytes:documentBytes[0],expectedRevisionId:null,mediaType:'text/markdown'});
   sourceIds.push(document.revisionId);
   const first=await tx.publishRelease({...blankSnapshot(profile),expectedReleaseId:null,sourceRevisionIds:[document.revisionId]});
   document=await tx.putDocument({documentId:'synthetic-source',aliases:['source/synthetic.md'],bytes:documentBytes[1],expectedRevisionId:document.revisionId,mediaType:'text/markdown'});
   sourceIds.push(document.revisionId);
   const aux=await tx.putAux({namespace:'synthetic-stream-test',key:'current',bytes:'{ "step": 1 }\r\n',expectedRevisionId:null,mediaType:'application/json'});
   await tx.putAux({namespace:'synthetic-stream-test',key:'current',bytes:'{"step":2}\n',expectedRevisionId:aux.revisionId,mediaType:'application/json'});
   for(let index=0;index<2;index++)await tx.appendEvent({kind:'SYNTHETIC_ARCHIVE_TEST',idempotencyKey:'synthetic-'+index,
    requestHash:sha256('synthetic-request-'+index),payload:{synthetic:true,sourceRevisionId:document.revisionId,index}});
   await tx.registerMedia({mediaId:'synthetic-missing-media',versionId:'V001',relativePath:null,
    sha256:sha256('synthetic media metadata only; no physical file'),byteSize:48,availability:'MISSING_HISTORY',
    aliases:['synthetic/media-alias'],metadata:{synthetic:true,rightsStatus:'UNKNOWN'}});
   releaseId=(await tx.publishRelease({...blankSnapshot(profile),expectedReleaseId:first.releaseId,sourceRevisionIds:[document.revisionId]})).releaseId;
  });
  const file=path.join(temporary,'source.ndjson');let scan,binding;
  await source.readTransaction(async tx=>{
   scan=await tx.scanValidatedArchive();
   binding=await writeArchiveRowsFile(file,{...scan,iterate:table=>tx.iterateArchiveRows(table)});
  });
  const {reader,proof}=await readValidated(file,binding,instanceId);
  assert.equal(scan.exportSha256,proof.exportSha256);assert.equal(scan.rows,proof.rows);
  const original=await source.exportState(); // Tiny synthetic baseline only; never a production archive.
  assert.equal(original.exportSha256,proof.exportSha256);
  assert.deepEqual(archiveRowHashes(original),proof.rowHashes);
  for(const table of BUSINESS_TABLES)assert(original.tables[table].length>0,table+' must exercise a real row');
  const baselineView=await source.readView();
  await t.test('repository integrity validates the real database in one read snapshot without changing rows',async()=>{
   const before=sqlEvents.length,integrity=await source.integrityCheck();
   assert.equal(integrity.ok,true);assert.equal(integrity.instanceId,instanceId);assert.equal(integrity.backend,'postgres');
   assert.deepEqual(sqlEvents.slice(before).map(row=>row.kind),['BEGIN','COMMIT']);
   assert.deepEqual(await source.exportState(),original);
   receipt.scenarios.push({name:'streamed-repository-integrity',status:'PASS',readSnapshots:1,originalRowsPreserved:true});
  });
  await t.test('scan/write and indexed reader produce one exact logical/physical source',async()=>{
   assert.equal(sha256(await readFile(file)),binding.sha256);
   assert.equal((await lstat(file)).size,binding.bytes);
   assert.equal(proof.metadata.current_release_id,releaseId);
   assert.equal(proof.rowHashesSha256,sha256(canonicalJson(archiveRowHashes(original))));
   receipt.scenarios.push({name:'source-scan-write-reader',status:'PASS',rows:proof.rows,fileBytes:binding.bytes,
    fileSha256:binding.sha256,exportSha256:proof.exportSha256,rowHashesSha256:proof.rowHashesSha256,
    tableRows:Object.fromEntries(BUSINESS_TABLES.map(table=>[table,original.tables[table].length]))});
  });
  await t.test('empty target imports out-of-FK-order tables, verifies all rows and starts a new epoch',async()=>{
   const target=await createTarget('stream_import_ok');
   const restored=await importPostgresRows({reader,instanceId,connection:target});repositories.add(restored);
   const imported=await restored.exportState(),meta=imported.tables.repository_meta[0],old=original.tables.repository_meta[0];
   assert.deepEqual(archiveRowHashes(imported),proof.rowHashes);
   for(const table of BUSINESS_TABLES.filter(table=>table!=='repository_meta'))assert.deepEqual(imported.tables[table],original.tables[table],table);
   assert.equal(meta.repository_revision,old.repository_revision+1);assert.notEqual(meta.runtime_epoch,old.runtime_epoch);
   assert(isRestoredRuntime(meta.runtime_epoch));
   assert.deepEqual({...meta,runtime_epoch:old.runtime_epoch,repository_revision:old.repository_revision},old);
   const view=await restored.readView();
   for(const key of ['snapshot','recipes','profile','eventsByKind','sourceRevisionIds','releaseId','profileRevisionId'])assert.deepEqual(view[key],baselineView[key],key);
   assert.equal(view.repositoryRevision,baselineView.repositoryRevision+1);assert.equal(view.runtimeEpoch,meta.runtime_epoch);
   assert(view.dataFingerprint.startsWith(meta.runtime_epoch+':'+releaseId+':'));
   for(let i=0;i<sourceIds.length;i++)assert.deepEqual((await restored.readDocumentRevision(sourceIds[i])).bytes,documentBytes[i]);
   assert.equal((await restored.getPublishedDocument('source/synthetic.md')).revisionId,sourceIds[1]);
   assert.equal((await restored.getAux('synthetic-stream-test','current')).bytes.toString(),'{'+'"step":2}\n');
   const verify=restored.importVerification;
   assert.equal(verify.status,'POSTGRES_IMPORT_VERIFIED');assert(verify.integrity.ok&&verify.originalBytesPreserved&&verify.businessIdsPreserved);
   assert.equal(verify.metadata.repositoryRevision,old.repository_revision+1);
   assert.equal(verify.streamedSource.fileSha256,binding.sha256);assert.equal(verify.streamedSource.semanticPasses,2);
   assert.equal(verify.streamedSource.rowHashesSha256,proof.rowHashesSha256);
   const targetClient=await connect('stream_import_ok');
   const fks=(await targetClient.query("SELECT conrelid::regclass::text AS table_name,condeferrable,condeferred FROM pg_constraint WHERE contype='f' AND connamespace='public'::regnamespace ORDER BY table_name")).rows;
   for(const table of ['record_heads','releases','media_aliases'])assert(fks.some(row=>row.table_name===table&&row.condeferrable&&row.condeferred),table);
   const inserts=sqlEvents.filter(event=>event.database==='stream_import_ok'&&event.kind==='INSERT').map(event=>event.table);
   assert(inserts.indexOf('record_heads')<inserts.indexOf('record_revisions'));
   assert(inserts.indexOf('media_aliases')<inserts.indexOf('media_versions'));
   const projection=(await targetClient.query('SELECT projection_version FROM read_projection_versions WHERE release_id=$1',[releaseId])).rows;
   assert.equal(projection.length,1);assert(Number.isSafeInteger(projection[0].projection_version));
   await targetClient.end();clients.delete(targetClient);
   receipt.scenarios.push({name:'import-success',status:'PASS',sevenTablesExact:true,metadataOnlyChanges:['runtime_epoch','repository_revision'],
    repositoryRevisionDelta:1,freshRestoredEpoch:true,currentReadViewExact:true,sourceBytesExact:true,finalProofStatus:verify.status,
    importInsertOrder:[...new Set(inserts)],deferredForeignKeys:fks,finalReadProjectionPresent:true});
  });
  for(const attack of [
   {name:'extra',code:'EXPORT_ROW_MISMATCH',mutate:archive=>{archive.tables.domain_events[0].unexpected_column='reject';}},
   {name:'cast',code:'INTEGRITY_FAILED',mutate:archive=>{archive.tables.record_revisions[0].deleted=String(archive.tables.record_revisions[0].deleted);}},
  ])await t.test(attack.name+' passes source preflight but rolls back schema and rows before commit',async()=>{
   const changed=structuredClone(original);attack.mutate(changed);
   const {exportSha256,...body}=changed;changed.exportSha256=canonicalSha256(body);
   const attackFile=path.join(temporary,attack.name+'.ndjson'),attackBinding=await writeArchiveFile(attackFile,changed);
   const captured=await readValidated(attackFile,attackBinding,instanceId);
   const database='stream_import_'+attack.name,target=await createTarget(database);
   // CAST really is legal PostgreSQL normalization: it is the row-byte proof,
   // not INSERT syntax or CHECK failure, that must reject this archive.
   if(attack.name==='cast'){
    const targetClient=await connect(database);
    assert.equal((await targetClient.query('SELECT $1::integer AS value',['0'])).rows[0].value,0);
    await targetClient.end();clients.delete(targetClient);
   }
   let caught;
   await assert.rejects(async()=>{try{await importPostgresRows({reader:captured.reader,instanceId,connection:target});}catch(error){caught=error;throw error;}},error=>error.code===attack.code);
   if(attack.name==='cast')assert.match(caught.message,/Migration changed original business rows: record_revisions/);
   const targetClient=await connect(database);
   const remaining=(await targetClient.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'")).rows[0].n;
   assert.equal(remaining,0,'Transactional CREATE TABLE and all inserts must be rolled back');
   const trace=sqlEvents.filter(event=>event.database===database);
   assert(trace.some(event=>event.kind==='BEGIN'));assert(trace.some(event=>event.kind==='ROLLBACK'));
   assert(!trace.some(event=>event.kind==='COMMIT'),'No target COMMIT may have been issued');
   assert(trace.some(event=>event.kind==='INSERT'),'This rejection must exercise actual transaction inserts');
   await targetClient.end();clients.delete(targetClient);
   receipt.scenarios.push({name:'reject-'+attack.name,status:'PASS',sourcePreflightPassed:true,errorCode:caught.code,
    transactionRollbackObserved:true,commitIssued:false,publicTablesAfterFailure:remaining,
    insertedTablesBeforeRejection:[...new Set(trace.filter(event=>event.kind==='INSERT').map(event=>event.table))]});
  });
  assert.equal(receipt.scenarios.length,5,'Every required scenario must have completed its assertions');
  receipt.status='PASS';
 }finally{
  const closeFailures=[];
  for(const reader of readers)try{await reader.close();}catch{closeFailures.push('reader');}
  for(const repo of repositories)try{await repo.close();}catch{closeFailures.push('repository');}
  for(const client of clients)try{await client.end();}catch{closeFailures.push('client');}
  pg.Client.prototype.query=realQuery;
  if(fixture)await fixture.cleanup();
  for(const [key,value]of previous)if(value===undefined)delete process.env[key];else process.env[key]=value;
  for(const [key,value]of previous)assert.equal(process.env[key],value,'Restore only the test process environment');
  if(resource){
   const remainingContainer=String(await docker(['ps','-a','--filter','id='+resource.containerId,'--format','{{.ID}}'])).trim();
   const remainingVolume=String(await docker(['volume','ls','--filter','name=^'+resource.volume+'$','--format','{{.Name}}'])).trim();
   assert.equal(remainingContainer,'','Owned test container cleanup must be verified');
   assert.equal(remainingVolume,'','Owned test volume cleanup must be verified');
   assert.equal(path.dirname(temporary),parent);assert.equal(await realpath(temporary),temporary);
   assert(/^stream-pg-[a-zA-Z0-9]+$/.test(path.basename(temporary)));
   await rm(temporary,{recursive:true});
   await assert.rejects(lstat(temporary),{code:'ENOENT'});
   receipt.cleanup={containerRemoved:true,volumeRemoved:true,privateTestRootRemoved:true,environmentRestored:true};
  }
  receipt.finishedAt=new Date().toISOString();
  if(closeFailures.length)receipt.status='FAIL_CLOSE';
  t.diagnostic('PG_STREAM_RECEIPT '+JSON.stringify(receipt));
  assert.deepEqual(closeFailures,[],'Cleanup must attempt container/volume removal even if a handle close fails');
 }
});
