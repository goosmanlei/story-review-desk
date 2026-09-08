import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {readFileSync} from 'node:fs';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
const root=process.cwd(),moduleAt=file=>import(pathToFileURL(path.join(root,file)));
const {canonicalJson,sha256}=await moduleAt('host/instance-runtime/bytes.mjs');
const {canonicalSha256}=await moduleAt('host/instance-runtime/archive-integrity.mjs');
const {APPLICATION_ID,SCHEMA_VERSION}=await moduleAt('host/instance-runtime/schema.mjs');
const {BUSINESS_TABLES}=await moduleAt('host/instance-runtime/postgres-schema.mjs');
const {validateArchive}=await moduleAt('host/instance-runtime/postgres.mjs');
const {projectGitBusinessArchive,projectGitBusinessRows,scanGitBusinessArchive,GIT_EXCLUDED_NAMESPACES}=await moduleAt('host/instance-runtime/git-business-archive.mjs');
const {writeArchiveFile,writeArchiveRowsFile,hashArchiveRows}=await moduleAt('host/instance-runtime/archive-file.mjs');
const {retirementManifestFromArchive}=await moduleAt('host/instance-runtime/media-retirement-transfer.mjs');
const encoded=value=>{const bytes=Buffer.from(typeof value==='string'?value:canonicalJson(value));return{value:{encoding:'base64',bytes:bytes.toString('base64')},sha:sha256(bytes)};};
function fixture(){
 const tables=Object.fromEntries(BUSINESS_TABLES.map(table=>[table,[]]));
 tables.repository_meta=[{singleton:1,instance_id:'instance-fixture',runtime_epoch:'epoch-one',repository_revision:5000,current_release_id:'release-one',created_at:'2026-01-01'}];
 function record(namespace,key,value,previous=null){const data=encoded(value),row={revision_id:namespace+':'+key+':'+(previous?2:1),namespace,record_key:key,revision_number:previous?2:1,previous_revision_id:previous?.revision_id||null,content_bytes:data.value,content_sha256:data.sha,media_type:'application/json',metadata_json:'{}',deleted:0,created_at:'2026-01-01'};tables.record_revisions.push(row);tables.record_heads=tables.record_heads.filter(head=>head.namespace!==namespace||head.record_key!==key);tables.record_heads.push({namespace,record_key:key,revision_id:row.revision_id});return row;}
 const profile=record('settings','instance-profile',{projectId:'story-fixture',instanceId:'instance-fixture'});
 const draft=record('aux:production-preparation','current',{sceneRole:'draft-one'});
 record('aux:assistant-public','health.json',{password:'a'.repeat(40),checkedAt:'initial'});
 const snapshot=encoded({snapshotId:'snapshot-one',productionModel:{}}),recipes=encoded({snapshotId:'snapshot-one'});
 tables.releases=[{release_id:'release-one',snapshot_id:'snapshot-one',snapshot_bytes:snapshot.value,snapshot_sha256:snapshot.sha,recipes_bytes:recipes.value,recipes_sha256:recipes.sha,source_revision_ids_json:'[]',profile_revision_id:profile.revision_id,created_at:'2026-01-01'}];
 const event=encoded({eventId:'event-one',eventKind:'review',idempotencyKeyHash:'e'.repeat(64)});
 tables.domain_events=[{storage_sequence:1,event_id:'event-one',authority_domain:'FORMAL',event_kind:'review',original_sequence:1,recorded_at:'2026-01-01',event_bytes:event.value,event_sha256:event.sha,idempotency_key_hash:'e'.repeat(64),request_hash:'f'.repeat(64),raw_request_hash:null,source_ref_json:'null'}];
 const archive=()=>{const body={schemaVersion:SCHEMA_VERSION,applicationId:APPLICATION_ID,instanceId:'instance-fixture',tables,sequence:[{name:'domain_events',seq:1}],mediaIncluded:false};return {...body,exportSha256:canonicalSha256(body)};};
 return{tables,archive,record,draft};
}

const sourceOf=archive=>{const {tables,...header}=archive;return{header,tableNames:Object.keys(tables),iterate:async function*(table){for(const row of tables[table])yield row;}};};
test('streamed projection preserves original export SHA, seven table multisets, business fingerprint and exact NDJSON',async()=>{
 const f=fixture();f.record('documents','b','body');f.record('documents','a','body-two');f.tables.document_aliases=[{alias:'z',document_id:'b'},{alias:'a',document_id:'a'}];
 const original=f.archive(),before=canonicalJson(original),old=projectGitBusinessArchive(original),plan=await projectGitBusinessRows(sourceOf(original));
 assert.equal(plan.exportSha256,old.archive.exportSha256);assert.deepEqual(plan.business,old.business);assert.deepEqual(plan.tableDigests,old.tableDigests);
 assert.equal(canonicalJson(original),before);assert.equal(plan.metadata.repository_revision,old.archive.tables.repository_meta[0].repository_revision);
 assert.equal(plan.frozenRetirement.tables.record_revisions.length,0);assert(!('releases'in plan.frozenRetirement.tables));assert(!JSON.stringify(plan).includes('body-two'));
 const temp=await realpath(await mkdtemp(path.join(os.tmpdir(),'git-stream-bytes-')));
 try{
  const legacy=await writeArchiveFile(path.join(temp,'legacy'),old.archive),stream=await writeArchiveRowsFile(path.join(temp,'stream'),{...plan,iterate:plan.createIterator()});
  assert.deepEqual(stream,legacy);assert.deepEqual(await readFile(path.join(temp,'legacy')),await readFile(path.join(temp,'stream')));
  assert.equal(plan.archiveBytes,stream.bytes);
 }finally{await rm(temp,{recursive:true,force:true});}
});
test('export preflight enforces the same whole-file, row and row-count capacity before a target or manifest exists',async()=>{
 const source=sourceOf(fixture().archive()),plan=await projectGitBusinessRows(source);
 for(const options of[{maxBytes:plan.archiveBytes-1},{maxRowBytes:700},{maxRows:1}])await assert.rejects(projectGitBusinessRows(source,options),/complete-reader capacity/);
 for(const options of[{maxBytes:16*1024**3+1},{maxRowBytes:128*1024**2+1},{maxRows:1000001}])await assert.rejects(projectGitBusinessRows(source,options),/complete-reader limits/);
});
test('complete source validation precedes exclusion; retained credentials and release-to-excluded-source fail closed',async()=>{
 const good=fixture();for(const name of [...GIT_EXCLUDED_NAMESPACES,'aux:assistant-future']){const r=good.record(name,'chain',{password:'private'.repeat(8)});good.record(name,'chain',{private:'second'},r);}
 const projected=await projectGitBusinessRows(sourceOf(good.archive()));assert.equal(projected.exportSha256,projectGitBusinessArchive(good.archive()).archive.exportSha256);
 const bad=fixture();bad.tables.record_revisions.find(r=>r.namespace==='aux:assistant-public').content_sha256='0'.repeat(64);
 await assert.rejects(projectGitBusinessRows(sourceOf(bad.archive())),/Record bytes/);
 for(const change of [f=>f.record('documents','secret',{api_key:'credential'.repeat(5)}),f=>{f.tables.record_revisions[0].metadata_json=JSON.stringify({password:'secret'.repeat(8)});}]){
  const f=fixture();change(f);await assert.rejects(projectGitBusinessRows(sourceOf(f.archive())),/credential/);
 }
 const reference=fixture();reference.tables.releases[0].source_revision_ids_json=JSON.stringify([reference.tables.record_revisions.find(r=>r.namespace==='aux:assistant-public').revision_id]);
 await assert.rejects(projectGitBusinessRows(sourceOf(reference.archive())),/Release source binding/);
});
test('normalization is idempotent, assistant-only changes stable, draft history changes and duplicate row multiplicity are exact',async()=>{
 const f=fixture(),before=await projectGitBusinessRows(sourceOf(f.archive()));
 f.record('aux:assistant-private','thread','ignored');f.tables.repository_meta[0].repository_revision++;f.tables.repository_meta[0].runtime_epoch='new';
 const unchanged=await projectGitBusinessRows(sourceOf(f.archive()));assert.equal(before.exportSha256,unchanged.exportSha256);assert.equal(before.business.fingerprint,unchanged.business.fingerprint);
 f.record('aux:production-preparation','current',{sceneRole:'two'},f.draft);const changed=await projectGitBusinessRows(sourceOf(f.archive()));assert.notEqual(before.business.fingerprint,changed.business.fingerprint);
 f.tables.document_aliases.push({alias:'duplicate',document_id:'a'},{alias:'duplicate',document_id:'a'});const duplicate=await projectGitBusinessRows(sourceOf(f.archive()));assert.deepEqual(duplicate.tableDigests,projectGitBusinessArchive(f.archive()).tableDigests);assert.equal(duplicate.rowHashes.document_aliases.length,2);assert.equal(duplicate.rowHashes.document_aliases[0],duplicate.rowHashes.document_aliases[1]);
 const again=await projectGitBusinessRows(sourceOf(projectGitBusinessArchive(f.archive()).archive));assert.equal(again.exportSha256,duplicate.exportSha256);
});
test('actual scan function requires a read-only unit and first-pass metadata; second pass detects changed retained row',async()=>{
 const f=fixture(),a=f.archive(),source=sourceOf(a),decode=row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,v?.encoding==='base64'?Buffer.from(v.bytes,'base64'):v]));
 let active=true,passes=0;const tx={writable:false,meta:async()=>decode(f.tables.repository_meta[0]),one:async()=>({n:1}),iterateArchiveRows:async function*(table){assert(active);if(table==='document_aliases')passes++;yield* source.iterate(table);}};
 const plan=await scanGitBusinessArchive(tx);assert.equal(plan.exportSha256,projectGitBusinessArchive(a).archive.exportSha256);
 assert.equal(passes,1);f.tables.document_aliases.push({alias:'drift',document_id:'a'});const second=await hashArchiveRows(plan.header,plan.tableNames,plan.createIterator());assert.notEqual(second.exportSha256,plan.exportSha256);
 active=false;await assert.rejects(scanGitBusinessArchive({...tx,writable:true}),/read-only/);
});

async function gitFileFixture({changeArchive,changeManifest,changeGzip}={}){
 const base=await realpath(await mkdtemp(path.join(os.tmpdir(),'git-stream-verify-'))),snapshot=path.join(base,'snapshot'),mediaRoot=path.join(base,'instances/story');
 await mkdir(snapshot);await mkdir(path.join(mediaRoot,'media'),{recursive:true});
 const f=fixture(),media=Buffer.from('exact registered media');await writeFile(path.join(mediaRoot,'media/source.txt'),media);
 f.tables.media_versions=[{media_id:'media',version_id:'v1',relative_path:'media/source.txt',sha256:sha256(media),byte_size:media.length,availability:'PRESENT',metadata_json:'{}'}];f.tables.media_aliases=[{alias:'source',media_id:'media',version_id:'v1'}];
 const projected=projectGitBusinessArchive(f.archive()),archive=structuredClone(projected.archive);
 if(changeArchive)await changeArchive(archive,f);
 const raw=path.join(base,'raw');await writeArchiveFile(raw,archive);const rawBytes=await readFile(raw);let compressed=gzipSync(rawBytes);if(changeGzip)compressed=changeGzip(compressed);
 await writeFile(path.join(snapshot,'repository.jsonl.gz'),compressed);await writeFile(path.join(snapshot,'RESTORE.md'),'fixture restore instructions');
 const retirement=await retirementManifestFromArchive(projected.archive),meta=projected.archive.tables.repository_meta[0];
 const body={schemaVersion:'1.0',kind:'REVIEW_GIT_BUSINESS_SNAPSHOT_1',instanceId:archive.instanceId,releaseId:meta.current_release_id,repositoryRevision:meta.repository_revision,businessFingerprint:projected.business.fingerprint,schemaHash:projected.business.schemaHash,
  core:{repository:'owner/core',commit:'c'.repeat(40),packageManifestSha256:'d'.repeat(64)},mediaPrefix:'instances/story/media',documentation:{path:'RESTORE.md',sha256:sha256('fixture restore instructions')},
  database:{path:'repository.jsonl.gz',format:'REVIEW_REPOSITORY_ARCHIVE_NDJSON_1',bytes:compressed.length,sha256:sha256(compressed),uncompressedBytes:rawBytes.length,archiveSha256:archive.exportSha256},
  tableDigests:projected.tableDigests,media:projected.archive.tables.media_versions,files:retirement.files,mediaRetirement:retirement,excludedNamespaces:projected.excludedNamespaces,originalRetainedRowBytesPreserved:true,normalizedRuntimeMetadata:true,privateConversationHistoryIncluded:false,providerCredentialsIncluded:false,runtimeIncluded:false,fullBackup:false};
 if(changeManifest)changeManifest(body);await writeFile(path.join(snapshot,'manifest.json'),canonicalJson({...body,manifestSha256:sha256(canonicalJson(body))}));
 return{base,snapshot,body,mediaRoot,cleanup:()=>rm(base,{recursive:true,force:true})};
}
const reseal=archive=>{const {exportSha256,...body}=archive;archive.exportSha256=canonicalSha256(body);};
const {manifestHash,targetSetHash,RETIREMENT_NAMESPACES:NS}=await moduleAt('host/instance-runtime/media-retirement.mjs');
const retirementSource=readFileSync(path.join(root,'tests/media-retirement-transfer.test.mjs'),'utf8'),retirementPrelude=retirementSource.slice(retirementSource.indexOf('const canonical ='),retirementSource.indexOf("test('ACTIVE"));
const retirementFixture=Function('createHash','manifestHash','targetSetHash','NS','retirementManifestFromArchive',retirementPrelude.replaceAll("'unit-instance'","'instance-fixture'")+';return fixture;')(createHash,manifestHash,targetSetHash,NS,retirementManifestFromArchive);
function withRetirement(phase){const f=fixture(),evidence=retirementFixture(phase,true);f.tables.record_revisions.push(...evidence.tables.record_revisions);f.tables.record_heads.push(...evidence.tables.record_heads);f.tables.media_versions=evidence.tables.media_versions;f.tables.media_aliases=evidence.tables.media_aliases;return f;}
test('Git streaming retirement projection preserves nine complete success/error cases and never reads live AUX',async()=>{
 const {retirementManifestFromFrozenRows}=await moduleAt('host/instance-runtime/media-retirement-transfer.mjs');
 const result=async callback=>{try{return{value:await callback()};}catch(error){return{code:error.code,message:error.message};}};
 for(const phase of['ACTIVE','QUARANTINED','PURGED','QUARANTINE_INTENT','PURGE_INTENT','RESULT_UNKNOWN']){
  const f=withRetirement(phase),old=projectGitBusinessArchive(f.archive()),plan=await projectGitBusinessRows(sourceOf(f.archive()));assert.equal(plan.exportSha256,old.archive.exportSha256);
  assert.deepEqual(await result(()=>retirementManifestFromFrozenRows(plan.frozenRetirement)),await result(()=>retirementManifestFromArchive(old.archive)));
 }
 for(const change of[f=>f.tables.media_aliases.push({...f.tables.media_aliases[0],alias:'new-alias'}),f=>{f.tables.record_revisions.at(-1).deleted=1;},f=>{f.tables.record_heads.pop();}]){
  const f=withRetirement('PURGED');change(f);await assert.rejects(async()=>{const plan=await projectGitBusinessRows(sourceOf(f.archive()));await retirementManifestFromFrozenRows(plan.frozenRetirement);});
 }
});
test('actual Git export function keeps both complete passes in one frozen RO transaction and media lease; pending creates no target',async()=>{
 const ts=(await moduleAt('node_modules/typescript/lib/typescript.js')).default,source=readFileSync(path.join(root,'scripts/instance-git-export.mjs'),'utf8'),ast=ts.createSourceFile('export.mjs',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='exportGitSnapshot').getText(ast).replace(/^export\s+/,'');
 const {retirementManifestFromFrozenRows}=await moduleAt('host/instance-runtime/media-retirement-transfer.mjs'),{createReadStream,createWriteStream}=await import('node:fs'),{pipeline}=await import('node:stream/promises'),{createGzip}=await import('node:zlib'),{lstat,unlink}=await import('node:fs/promises');
 for(const pending of[false,true]){
  const base=await realpath(await mkdtemp(path.join(os.tmpdir(),'git-stream-export-'))),instanceRoot=path.join(base,'instance'),target=path.join(base,'snapshot');await mkdir(instanceRoot);
  const f=withRetirement(pending?'PURGE_INTENT':'QUARANTINED'),frozen=structuredClone(f.archive()),old=projectGitBusinessArchive(frozen);let active=false,lease=false,passes=0,transactions=0,mediaChecks=0;
  const tx={writable:false,meta:async()=>frozen.tables.repository_meta[0],one:async()=>({n:1}),iterateArchiveRows:async function*(table){assert(active&&lease);if(table==='document_aliases')passes++;for(const row of frozen.tables[table])yield row;}};
  const repo={withMediaReadLease:async callback=>{lease=true;try{return await callback();}finally{lease=false;}},readTransaction:async callback=>{assert(lease);transactions++;active=true;try{return await callback(tx);}finally{active=false;}},close:async()=>{},exportState:()=>assert.fail('Whole archive export'),listAux:()=>assert.fail('Live AUX')};
  const bindings={coreBinding:x=>x,relative:x=>x,resolveInstance:()=>({backend:'postgres',root:instanceRoot,instanceId:frozen.instanceId}),process:{env:{REVIEW_DATABASE_BACKEND:'postgres'}},openInstanceRepository:async()=>repo,path,gitBusinessState:async()=>{assert(active);return old.business;},scanGitBusinessArchive,retirementManifestFromFrozenRows,mkdir:async(...args)=>{assert(active&&lease);f.record('documents','concurrent-live-change','not-in-frozen-snapshot');return mkdir(...args);},realpath,writeArchiveRowsFile,pipeline,createReadStream,createGzip,createWriteStream,verifyFiles:async(_root,files)=>{assert(lease&&!active);assert.equal(files.length,1);mediaChecks++;},digest:async filename=>sha256(await readFile(filename)),lstat,sha256,RESTORE_TEXT:'restore fixture',GIT_BUSINESS_PROTOCOL:'REVIEW_GIT_BUSINESS_SNAPSHOT_1',canonicalJson,writeFile:async(...args)=>{assert(lease&&!active);return writeFile(...args);},unlink};
  bindings.ARCHIVE_FILE_FORMAT='REVIEW_REPOSITORY_ARCHIVE_NDJSON_1';
  const exporter=Function(...Object.keys(bindings),fn+';return exportGitSnapshot;')(...Object.values(bindings));
  try{
   if(pending){await assert.rejects(exporter(instanceRoot,target,{expectedFingerprint:old.business.fingerprint,mediaPrefix:'instances/story/media',core:{}}),{code:'RETIREMENT_RESULT_UNKNOWN'});await assert.rejects(lstat(target),{code:'ENOENT'});assert.equal(mediaChecks,0);assert.equal(passes,1);}
   else{const out=await exporter(instanceRoot,target,{expectedFingerprint:old.business.fingerprint,mediaPrefix:'instances/story/media',core:{}}),manifest=JSON.parse(await readFile(path.join(target,'manifest.json'),'utf8'));assert.equal(out.status,'GIT_BUSINESS_EXPORTED_VERIFIED');assert.equal(manifest.database.archiveSha256,old.archive.exportSha256);assert.deepEqual(manifest.tableDigests,old.tableDigests);assert.equal(passes,2);assert.equal(mediaChecks,1);assert(!('archive'in out));}
   assert.equal(transactions,1);assert(!lease&&!active);
  }finally{await rm(base,{recursive:true,force:true});}
 }
});
test('actual Git verifier grants callback only after complete logical/semantic/media proof; reader remains open inside and closes on errors',async()=>{
 const {withVerifiedGitSnapshot,verifyGitSnapshot}=await moduleAt('scripts/instance-git-export.mjs'),f=await gitFileFixture();let observedReader;
 try{
  let callbacks=0;const value=await withVerifiedGitSnapshot(f.snapshot,f.base,async({manifest,reader,rowHashes})=>{callbacks++;observedReader=reader;assert.equal(Object.keys(rowHashes).length,7);const {exportSha256,...header}=reader.header;assert.equal((await hashArchiveRows(header,reader.tableNames,reader.iterate)).exportSha256,exportSha256);return manifest.instanceId;});
  assert.equal(value,'instance-fixture');assert.equal(callbacks,1);await assert.rejects(observedReader.assertUnchanged(),/closed/);assert(!(await readdir(f.snapshot)).some(name=>name.startsWith('.verify-')));
  assert.equal((await verifyGitSnapshot(f.snapshot,f.base)).status,'GIT_BUSINESS_VERIFIED');
  await assert.rejects(withVerifiedGitSnapshot(f.snapshot,f.base,()=>{throw Error('callback deliberate failure');}),/callback deliberate/);assert(!(await readdir(f.snapshot)).some(name=>name.startsWith('.verify-')));
 }finally{await f.cleanup();}
});
test('Git verifier rejects excluded-row smuggling, counter drift, wrong seven-table proof, credential history and media tampering before callback',async()=>{
 const {withVerifiedGitSnapshot}=await moduleAt('scripts/instance-git-export.mjs');
 const cases=[
  {changeArchive:(a,f)=>{a.tables.record_revisions.push(f.tables.record_revisions.find(r=>r.namespace==='aux:assistant-public'));a.tables.record_heads.push(f.tables.record_heads.find(r=>r.namespace==='aux:assistant-public'));}},
  {changeArchive:a=>{a.tables.repository_meta[0].runtime_epoch='still-live';reseal(a);}},
  {changeManifest:m=>{m.tableDigests.record_revisions.rows++;}},
  {changeManifest:m=>{m.tableDigests.document_aliases.sha256='0'.repeat(64);}},
  {changeArchive:a=>{const r=a.tables.record_revisions[0];r.metadata_json=JSON.stringify({api_key:'secret'.repeat(8)});reseal(a);}},
  {changeManifest:m=>{m.media[0].sha256='1'.repeat(64);}},
  {changeManifest:m=>{m.files=[];}},
 ];
 for(const options of cases){const f=await gitFileFixture(options);let called=false;try{await assert.rejects(withVerifiedGitSnapshot(f.snapshot,f.base,()=>{called=true;}));assert.equal(called,false);assert(!(await readdir(f.snapshot)).some(name=>name.startsWith('.verify-')));}finally{await f.cleanup();}}
 const f=await gitFileFixture();try{await writeFile(path.join(f.mediaRoot,'media/source.txt'),'changed media');await assert.rejects(withVerifiedGitSnapshot(f.snapshot,f.base,()=>assert.fail('Callback on corrupt media')),/media hash\/size/);}finally{await f.cleanup();}
});
test('stream-only 16 GiB hard cap and decompression exact byte counting reject oversized/truncated inputs without callback',async()=>{
 const {withVerifiedGitSnapshot,GIT_STREAM_MAX_ARCHIVE_BYTES}=await moduleAt('scripts/instance-git-export.mjs');assert.equal(GIT_STREAM_MAX_ARCHIVE_BYTES,16*1024**3);
 for(const [options,error]of[
  [{changeManifest:m=>{m.database.uncompressedBytes=GIT_STREAM_MAX_ARCHIVE_BYTES+1;}},/streamed restore capacity/],
  [{changeManifest:m=>{m.database.uncompressedBytes=5*1024**3;}},/Decompressed size differs/],
  [{changeManifest:m=>{m.database.uncompressedBytes--;}},/Decompressed size exceeds/],
  [{changeManifest:m=>{m.database.uncompressedBytes++;}},/Decompressed size differs/],
  [{changeGzip:b=>b.subarray(0,b.length-7)},/unexpected end|unexpected EOF/i],
 ]){const f=await gitFileFixture(options);try{await assert.rejects(withVerifiedGitSnapshot(f.snapshot,f.base,()=>assert.fail('Callback before all bytes validated')),error);assert(!(await readdir(f.snapshot)).some(name=>name.startsWith('.verify-')));}finally{await f.cleanup();}}
});
test('the exact compressed bytes consumed are rehashed, rejecting a same-size gzip-header swap after its initial file digest',async()=>{
 const ts=(await moduleAt('node_modules/typescript/lib/typescript.js')).default,source=readFileSync(path.join(root,'scripts/instance-git-export.mjs'),'utf8'),ast=ts.createSourceFile('export.mjs',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='withVerifiedGitSnapshot').getText(ast).replace(/^export\s+/,'');
 const {lstat}=await import('node:fs/promises'),{Readable,Transform}=await import('node:stream'),{pipeline}=await import('node:stream/promises'),{createGunzip}=await import('node:zlib'),{createWriteStream}=await import('node:fs'),f=await gitFileFixture();
 try{
  const altered=Buffer.from(await readFile(path.join(f.snapshot,'repository.jsonl.gz')));altered[4]^=1;let consumed=0;
  const bindings={realpath,lstat,readFile,regular:async(root,name)=>path.join(root,name),GIT_BUSINESS_PROTOCOL:'REVIEW_GIT_BUSINESS_SNAPSHOT_1',sha256,canonicalJson,coreBinding:x=>x,relative:x=>x,path,digest:async file=>sha256(await readFile(file)),ARCHIVE_FILE_FORMAT:'REVIEW_REPOSITORY_ARCHIVE_NDJSON_1',GIT_STREAM_MAX_ARCHIVE_BYTES:16*1024**3,mkdtemp,createHash,pipeline,createReadStream:()=>{consumed++;return Readable.from([altered]);},Transform,createGunzip,createWriteStream,rm};
  const verifier=Function(...Object.keys(bindings),fn+';return withVerifiedGitSnapshot;')(...Object.values(bindings));
  await assert.rejects(verifier(f.snapshot,f.base,()=>assert.fail('Callback on swapped gzip')),/Compressed archive changed/);assert.equal(consumed,1);assert(!(await readdir(f.snapshot)).some(name=>name.startsWith('.verify-')));
 }finally{await f.cleanup();}
});

async function largeGitStream(){
 const {pathToFileURL}=await import('node:url'),{createHash}=await import('node:crypto'),path=await import('node:path'),fs=await import('node:fs');
 const root=process.cwd(),at=f=>import(pathToFileURL(path.join(root,f))),{canonicalJson,sha256}=await at('host/instance-runtime/bytes.mjs'),{canonicalSha256}=await at('host/instance-runtime/archive-integrity.mjs');
 const {projectGitBusinessRows,projectGitBusinessArchive}=await at('host/instance-runtime/git-business-archive.mjs'),{BUSINESS_TABLES}=await at('host/instance-runtime/postgres-schema.mjs'),{APPLICATION_ID,SCHEMA_VERSION}=await at('host/instance-runtime/schema.mjs');
 const {hashArchiveRows,ARCHIVE_FILE_FORMAT}=await at('host/instance-runtime/archive-file.mjs'),ts=(await at('node_modules/typescript/lib/typescript.js')).default;
 const data=value=>{const bytes=Buffer.from(JSON.stringify(value));return{bytes:{encoding:'base64',bytes:bytes.toString('base64')},hash:sha256(bytes)};};
 const profile=data({projectId:'fixture'}),tables=Object.fromEntries(BUSINESS_TABLES.map(t=>[t,[]]));
 tables.repository_meta=[{singleton:1,instance_id:'fixture',runtime_epoch:'runtime',repository_revision:1000,current_release_id:'release-0',created_at:'now'}];
 tables.record_revisions=[{namespace:'settings',record_key:'profile',revision_id:'r1',revision_number:1,previous_revision_id:null,content_bytes:profile.bytes,content_sha256:profile.hash,deleted:0}];tables.record_heads=[{namespace:'settings',record_key:'profile',revision_id:'r1'}];
 const count=130,payloadBytes=24*1024**2;let peakRssObservedBytes=process.memoryUsage().rss;const sample=()=>{peakRssObservedBytes=Math.max(peakRssObservedBytes,process.memoryUsage().rss);};
 tables.releases=new Array(count);for(let i=0;i<count;i++)Object.defineProperty(tables.releases,i,{enumerable:true,get(){const snapshot=data({snapshotId:'s',padding:String.fromCharCode(65+i%26).repeat(payloadBytes)}),recipes=data({snapshotId:'s'});sample();return{release_id:'release-'+i,snapshot_id:'s',profile_revision_id:'r1',source_revision_ids_json:'[]',snapshot_bytes:snapshot.bytes,snapshot_sha256:snapshot.hash,recipes_bytes:recipes.bytes,recipes_sha256:recipes.hash};}});
 const header={schemaVersion:SCHEMA_VERSION,applicationId:APPLICATION_ID,instanceId:'fixture',sequence:[{name:'domain_events',seq:0}],mediaIncluded:false},body={...header,tables},original={...body,exportSha256:canonicalSha256(body)};
 const old=projectGitBusinessArchive(original),plan=await projectGitBusinessRows({header,tableNames:BUSINESS_TABLES,iterate:async function*(table){for(const row of tables[table]){sample();yield row;}}});
 if(plan.exportSha256!==old.archive.exportSha256||canonicalJson(plan.tableDigests)!==canonicalJson(old.tableDigests)||plan.business.fingerprint!==old.business.fingerprint)throw Error('Original business proof differs');
 const source=fs.readFileSync(path.join(root,'host/instance-runtime/archive-file.mjs'),'utf8'),ast=ts.createSourceFile('archive.mjs',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 const declaration=name=>{const node=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);if(!node)throw Error('Actual writer missing');return node.getText(ast).replace(/^export\s+/,'');};
 const output=()=>({bytes:0,async write(b,o,n){this.bytes+=n;sample();return{bytesWritten:n};},async sync(){},async close(){}}),sink=output(),legacy=output();
 const bindings={open:async()=>sink,createHash,canonicalJson,hashArchiveRows,ARCHIVE_FILE_FORMAT},writer=Function(...Object.keys(bindings),declaration('writeArchiveRowsFile')+';return writeArchiveRowsFile;')(...Object.values(bindings));
 const result=await writer('/no-file',{...plan,iterate:plan.createIterator()});
 const oldBindings={...bindings,open:async()=>legacy},oldWriter=Function(...Object.keys(oldBindings),declaration('writeArchiveFile')+';return writeArchiveFile;')(...Object.values(oldBindings));
 const reference=await oldWriter('/no-file',old.archive);
 if(result.bytes<=4*1024**3||result.sha256!==reference.sha256||result.bytes!==reference.bytes)throw Error('Large NDJSON differs or scale below legacy limit');
 console.log(JSON.stringify({status:'PASS',archiveBytes:result.bytes,exportSha256:plan.exportSha256,ndjsonSha256:result.sha256,releaseRows:count,rowHashes:Object.values(plan.rowHashes).reduce((n,a)=>n+a.length,0),jsHeapMiB:384,peakRssObservedBytes,wholeArchiveMaterializations:0,realFiles:0,databaseConnections:0,modelCalls:0}));
}
test('more than 4 GiB business archive preserves old SHA/digests/NDJSON under 384 MiB heap',{timeout:240000},()=>{
 const options=process.execArgv.flatMap((value,index)=>value==='--import'?['--import',process.execArgv[index+1]]:value.startsWith('--import=')?[value]:[]);
 const result=execFileSync(process.execPath,['--max-old-space-size=384',...options,'-e','('+largeGitStream.toString()+')().catch(e=>{console.error(e);process.exitCode=1;})'],{cwd:root,encoding:'utf8',timeout:235000,maxBuffer:32000,env:{PATH:process.env.PATH,...(process.env.GIT_STREAM_COMPANION?{GIT_STREAM_COMPANION:process.env.GIT_STREAM_COMPANION}:{})}});
 const proof=JSON.parse(result);assert.equal(proof.status,'PASS');assert(proof.archiveBytes>4*1024**3);console.log(JSON.stringify(proof));
});
