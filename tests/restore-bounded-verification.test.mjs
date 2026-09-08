import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import path from'node:path';import{pathToFileURL}from'node:url';import{createHash}from'node:crypto';import{execFileSync}from'node:child_process';import{EventEmitter}from'node:events';
const root=process.cwd(),read=file=>fs.readFileSync(path.join(root,file),'utf8');
const pg=read('host/instance-runtime/postgres.mjs'),implementation=pg.slice(pg.indexOf('export function validateArchive'),pg.indexOf('export async function importPostgresState')).replaceAll('export function ','function ');
const {canonicalSha256,archiveRowHashes}=await import(pathToFileURL(path.join(root,'host/instance-runtime/archive-integrity.mjs')));
const {BUSINESS_TABLES}=await import(pathToFileURL(path.join(root,'host/instance-runtime/postgres-schema.mjs')));
const {SCHEMA_VERSION,APPLICATION_ID}=await import(pathToFileURL(path.join(root,'host/instance-runtime/schema.mjs')));
const {canonicalJson}=await import(pathToFileURL(path.join(root,'host/instance-runtime/bytes.mjs')));
const {validateMaterialUsageArchive}=await import(pathToFileURL(path.join(root,'host/instance-runtime/material-usage-archive.mjs')));
const sha256=value=>createHash('sha256').update(value).digest('hex'),parse=value=>JSON.parse(Buffer.from(value).toString('utf8'));
const ensure=(ok,code,message)=>{if(!ok)throw Object.assign(Error(message),{code});};
const number=value=>{const result=Number(value);ensure(Number.isSafeInteger(result),'INTEGER_RANGE','Database integer exceeds safe range');return result;};
const encode=row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,Buffer.isBuffer(v)?{encoding:'base64',bytes:v.toString('base64')}:['repository_revision','storage_sequence','original_sequence','byte_size'].includes(k)&&v!==null?number(v):v]));
const bindings={ensure,sha256,parse,number,canonicalJson,canonicalSha256,validateMaterialUsageArchive,digest:value=>value,SCHEMA_VERSION,APPLICATION_ID,BUSINESS_TABLES};
const impl=Function(...Object.keys(bindings),implementation+';return{validateArchive,verifyRestoredRows,verifyImportedRepository};')(...Object.values(bindings));
function fixture(){
 const record=Buffer.from('{"title":"original"}'),snapshot=Buffer.from('{"snapshotId":"snap"}'),event=Buffer.from('{"eventId":"event","eventKind":"TEST","idempotencyKeyHash":"key"}');
 const tables=Object.fromEntries(BUSINESS_TABLES.map(t=>[t,[]]));
 tables.repository_meta=[{instance_id:'fixture',runtime_epoch:'restore_v1_fixture',repository_revision:9,singleton:1,current_release_id:'release',created_at:'original-date'}];
 tables.record_revisions=[{revision_id:'r1',namespace:'settings',record_key:'profile',revision_number:1,previous_revision_id:null,content_bytes:record,content_sha256:sha256(record)}];
 tables.record_heads=[{namespace:'settings',record_key:'profile',revision_id:'r1'}];
 tables.releases=[{release_id:'release',snapshot_bytes:snapshot,snapshot_sha256:sha256(snapshot),recipes_bytes:snapshot,recipes_sha256:sha256(snapshot),profile_revision_id:'r1',source_revision_ids_json:'["r1"]'}];
 tables.domain_events=[{event_id:'event',event_kind:'TEST',event_bytes:event,event_sha256:sha256(event),idempotency_key_hash:'key',storage_sequence:'1',original_sequence:null}];
 tables.media_versions=[{media_id:'m1',version_id:'v1',byte_size:'10'},{media_id:'m2',version_id:'v1',byte_size:'20'}];
 tables.media_aliases=[{alias:'alias',media_id:'m1',version_id:'v1'}];tables.document_aliases=[{alias:'source',document_id:'doc'}];
 return tables;
}
function archive(tables){const body={schemaVersion:SCHEMA_VERSION,applicationId:APPLICATION_ID,instanceId:'fixture',tables:Object.fromEntries(Object.entries(tables).map(([k,rows])=>[k,rows.map(encode)]))};return{...body,exportSha256:canonicalSha256(body)};}
function transaction(tables,{doubleFetch=false,queryFailure=false,closeFailure=false}={}){
 let cursor=null,offset=0;const log=[];
 return{log,async query(sql){log.push(sql);if(sql.startsWith('DECLARE review_restore_verify_rows')){assert.equal(cursor,null);cursor=sql.match(/FROM ([a-z_]+)/)[1];offset=0;return{rows:[]};}
  if(sql==='FETCH FORWARD 1 FROM review_restore_verify_rows'){assert(cursor);if(queryFailure)throw Error('read failed');return{rows:tables[cursor].slice(offset,offset+=(doubleFetch?2:1))};}
  if(sql==='CLOSE review_restore_verify_rows'){cursor=null;if(closeFailure)throw Error('cursor close failed');return{rows:[]};}throw Error('unexpected SQL');
 },async exportState(){throw Error('Whole-archive export forbidden');},async readView(){return{};},async getMetadata(){return{instanceId:'fixture',runtimeEpoch:'restore_v1_fixture'};}};
}
test('bounded verifier retains every archive structural, byte, chain, head, event and release-reference check',async()=>{
 const scenarios={
  'record bytes':t=>{t.record_revisions[0].content_sha256='0'.repeat(64);},
  'revision number':t=>{t.record_revisions[0].revision_number=2;},
  'previous revision':t=>{t.record_revisions[0].previous_revision_id='missing';},
  'wrong head':t=>{t.record_heads[0].revision_id='missing';},
  'missing head':t=>{t.record_heads=[];},
  'event bytes':t=>{t.domain_events[0].event_sha256='0'.repeat(64);},
  'event identity':t=>{t.domain_events[0].event_id='different';},
  'event kind':t=>{t.domain_events[0].event_kind='different';},
  'event idempotency':t=>{t.domain_events[0].idempotency_key_hash='different';},
  'snapshot bytes':t=>{t.releases[0].snapshot_sha256='0'.repeat(64);},
  'recipes bytes':t=>{t.releases[0].recipes_sha256='0'.repeat(64);},
  'snapshot pair':t=>{const body=Buffer.from('{"snapshotId":"other"}');t.releases[0].recipes_bytes=body;t.releases[0].recipes_sha256=sha256(body);},
  'profile reference':t=>{t.releases[0].profile_revision_id='missing';},
  'source reference':t=>{t.releases[0].source_revision_ids_json='["missing"]';},
  'metadata identity':t=>{t.repository_meta[0].instance_id='other';},
  'metadata cardinality':t=>{t.repository_meta.push({...t.repository_meta[0]});}
 };
 const valid=fixture();impl.validateArchive(archive(valid),'fixture');await impl.verifyRestoredRows(transaction(valid),'fixture',archiveRowHashes(archive(valid)),valid.repository_meta[0]);
 for(const [name,mutate]of Object.entries(scenarios)){const changed=fixture();mutate(changed);const value=archive(changed),expected=archiveRowHashes(value),tx=transaction(changed);assert.throws(()=>impl.validateArchive(value,'fixture'),undefined,name);await assert.rejects(impl.verifyRestoredRows(tx,'fixture',expected,valid.repository_meta[0]),undefined,name);assert.equal(tx.log.at(-1),'CLOSE review_restore_verify_rows',name);}
 const badBase64=archive(fixture());badBase64.tables.record_revisions[0].content_bytes.bytes+='!';const{exportSha256,...body}=badBase64;badBase64.exportSha256=canonicalSha256(body);assert.throws(()=>impl.validateArchive(badBase64,'fixture'),/Invalid base64/);
});
test('exact row SHA multisets ignore order but reject additions, omissions, changed columns, duplicate multiplicity and table-set drift',async()=>{
 const expected=archiveRowHashes(archive(fixture())),expectedMeta=fixture().repository_meta[0];
 for(const mode of['reverse','changed','extra','missing','duplicate','extra-column']){const rows=fixture();if(mode==='reverse')rows.media_versions.reverse();if(mode==='changed')rows.media_versions[0].byte_size='11';if(mode==='extra')rows.media_versions.push({media_id:'m3'});if(mode==='missing')rows.media_versions.pop();if(mode==='duplicate')rows.media_versions[1]={...rows.media_versions[0]};if(mode==='extra-column')rows.media_versions[0].unexpected='value';const action=impl.verifyRestoredRows(transaction(rows),'fixture',expected,expectedMeta);if(mode==='reverse')await action;else await assert.rejects(action,/Migration changed original business rows/);}
 for(const [key,value]of Object.entries({runtime_epoch:'restore_v1_other',repository_revision:10,current_release_id:'other-release',created_at:'changed-date'})){const rows=fixture();rows.repository_meta[0][key]=value;await assert.rejects(impl.verifyRestoredRows(transaction(rows),'fixture',expected,expectedMeta),/Restored metadata differs/,key);}
 await assert.rejects(impl.verifyRestoredRows(transaction(fixture()),'fixture',{...expected,extra:[]},expectedMeta),/business table set/);
 const missing={...expected};delete missing.releases;await assert.rejects(impl.verifyRestoredRows(transaction(fixture()),'fixture',missing,expectedMeta),/business table set/);
 await assert.rejects(impl.verifyRestoredRows(transaction(fixture(),{doubleFetch:true}),'fixture',expected,expectedMeta),/exceeded one row/);
 const failed=transaction(fixture(),{queryFailure:true});await assert.rejects(impl.verifyRestoredRows(failed,'fixture',expected,expectedMeta),/read failed/);assert.equal(failed.log.at(-1),'CLOSE review_restore_verify_rows');
 await assert.rejects(impl.verifyRestoredRows(transaction(fixture(),{closeFailure:true}),'fixture',expected,expectedMeta),/cursor close failed/);
 await assert.rejects(impl.verifyRestoredRows(transaction(fixture(),{queryFailure:true,closeFailure:true}),'fixture',expected,expectedMeta),/read failed/);
 let snapshots=0,schema=0;const tx=transaction(fixture()),repo={instanceId:'fixture',async validateSchema(){schema++;},async readTransaction(fn){snapshots++;return fn(tx);}};
 const proof=await impl.verifyImportedRepository(repo,expected,expectedMeta);assert.equal(snapshots,1);assert.equal(schema,1);assert.equal(proof.status,'POSTGRES_IMPORT_VERIFIED');assert(Object.isFrozen(proof));assert(Object.isFrozen(proof.metadata));assert(tx.log.every(sql=>!/INSERT|UPDATE|DELETE|COMMIT/.test(sql)));
});
async function largeFixtureMain(){
 const fs=await import('node:fs'),{createHash}=await import('node:crypto');const v=JSON.parse(fs.readFileSync(0,'utf8'));
 const sha256=x=>createHash('sha256').update(x).digest('hex'),canonicalJson=x=>x===null||typeof x!=='object'?JSON.stringify(x):Array.isArray(x)?'['+x.map(canonicalJson).join(',')+']':'{'+Object.keys(x).filter(k=>x[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+canonicalJson(x[k])).join(',')+'}';
 const canonicalSha256=Function('createHash',v.hashSource+';return canonicalSha256;')(createHash),parse=x=>JSON.parse(Buffer.from(x).toString('utf8')),ensure=(ok,code,msg)=>{if(!ok)throw Error(code+': '+msg);},number=Number;
 const {BUSINESS_TABLES,SCHEMA_VERSION,APPLICATION_ID}=v;const args={ensure,sha256,canonicalJson,canonicalSha256,parse,number,BUSINESS_TABLES,SCHEMA_VERSION,APPLICATION_ID,digest:x=>x};const impl=Function(...Object.keys(args),v.implementation+';return{verifyImportedRepository};')(...Object.values(args));
 const record=Buffer.from('{}'),small=Buffer.from('{"snapshotId":"snap"}');
 const tables=Object.fromEntries(BUSINESS_TABLES.map(k=>[k,[]]));tables.repository_meta=[{instance_id:'fixture',runtime_epoch:'restore_v1_fixture'}];tables.record_revisions=[{namespace:'settings',record_key:'profile',revision_id:'r1',revision_number:1,previous_revision_id:null,content_bytes:record,content_sha256:sha256(record)}];tables.record_heads=[{namespace:'settings',record_key:'profile',revision_id:'r1'}];
 const count=70,payloadBytes=24*1024*1024;let lowerBound=0,peak=0,fetches=0;
 const release=i=>{const snapshot=Buffer.from(JSON.stringify({snapshotId:'snap',padding:String.fromCharCode(65+i%26).repeat(payloadBytes)}));return{release_id:'release_'+i,snapshot_bytes:snapshot,snapshot_sha256:sha256(snapshot),recipes_bytes:small,recipes_sha256:sha256(small),source_revision_ids_json:'["r1"]',profile_revision_id:'r1'};};
 const hashRow=row=>canonicalSha256(Object.fromEntries(Object.entries(row).map(([k,x])=>[k,Buffer.isBuffer(x)?{encoding:'base64',bytes:x.toString('base64')}:x])));
 const expected=Object.fromEntries(BUSINESS_TABLES.filter(t=>t!=='repository_meta').map(t=>[t,tables[t].map(hashRow)]));
 for(let i=0;i<count;i++){const row=release(i);expected.releases.push(hashRow(row));lowerBound+=Math.ceil(row.snapshot_bytes.length/3)*4;peak=Math.max(peak,process.memoryUsage().rss);}
 let table=null,offset=0,snapshots=0;const tx={async query(sql){if(sql.startsWith('DECLARE')){if(table!==null)throw Error('cursor leak');table=sql.match(/FROM ([a-z_]+)/)[1];offset=0;return{rows:[]};}if(sql.startsWith('FETCH')){if(sql!=='FETCH FORWARD 1 FROM review_restore_verify_rows')throw Error('unbounded fetch');fetches++;const row=table==='releases'?(offset<count?release(offset):null):(tables[table][offset]||null);offset++;peak=Math.max(peak,process.memoryUsage().rss);return{rows:row?[row]:[]};}if(sql.startsWith('CLOSE')){table=null;return{rows:[]};}throw Error('unexpected SQL');},async readView(){return{};},async getMetadata(){return{runtimeEpoch:'restore_v1_fixture'};},async exportState(){throw Error('full export forbidden');}};
 const repo={instanceId:'fixture',async validateSchema(){},async readTransaction(fn){snapshots++;return fn(tx);}};
 impl.verifyImportedRepository(repo,expected,tables.repository_meta[0]).then(proof=>{if(proof.status!=='POSTGRES_IMPORT_VERIFIED'||lowerBound<2166029427||snapshots!==1)throw Error('bad proof');console.log(JSON.stringify({status:'PASS',releaseRows:count,archivePayloadLowerBoundBytes:lowerBound,peakRssBytes:peak,fetches,readSnapshots:snapshots,wholeArchiveMaterializations:0,models:0,databaseWrites:0}));}).catch(e=>{console.error(e);process.exitCode=1;});
}
test('over 2.16 GB restored archive is verified under a 256 MiB JS heap without whole-archive allocation',{timeout:120000},()=>{
 const hashSource=read('host/instance-runtime/archive-integrity.mjs').split('/** Tiny immutable')[0].replace("import {createHash} from 'node:crypto';",'').replace('export function ','function ');
 const out=execFileSync(process.execPath,['--max-old-space-size=256','-e','('+largeFixtureMain.toString()+')()'],{input:JSON.stringify({implementation,hashSource,BUSINESS_TABLES,SCHEMA_VERSION,APPLICATION_ID}),encoding:'utf8',timeout:115000,maxBuffer:32000,env:{PATH:process.env.PATH}});
 const result=JSON.parse(out);assert.equal(result.status,'PASS');assert(result.archivePayloadLowerBoundBytes>=2166029427);assert(result.peakRssBytes<900*1024*1024);console.log(JSON.stringify(result));
});
test('actual Docker wrapper and Git restore CLI retain safe exit/signal/timeout diagnostics without raw stderr credentials',async()=>{
 const source=read('scripts/instance-postgres.mjs'),code=source.slice(source.indexOf('export function postgresDockerFailure('),source.indexOf('export async function pgBootstrap(')).replaceAll('export function ','function ');
 const secret='password=do-not-disclose Bearer sk-private-example';
 async function run({exitCode=1,signal=null,stderr='',timeout=false,limit=false,output=''}={}){
  let timerCallback,kills=[];const spawn=()=>{const p=new EventEmitter();p.stdout=new EventEmitter();p.stderr=new EventEmitter();p.stdin=new EventEmitter();p.kill=s=>{kills.push(s);};p.stdin.end=()=>queueMicrotask(()=>{if(timeout)timerCallback();if(limit)p.stdout.emit('data',{length:513*1024*1024});else if(output)p.stdout.emit('data',Buffer.from(output));p.emit('exit',exitCode,signal);p.stderr.emit('data',Buffer.from(stderr));p.emit('close',exitCode,signal);});return p;};
  const make=Function('spawn','setTimeout','clearTimeout',code+';return{docker,postgresDockerFailure};'),api=make(spawn,callback=>(timerCallback=callback,1),()=>{});try{return{ok:await api.docker(['synthetic'])};}catch(error){assert(!JSON.stringify(error).includes(secret));return{error,kills};}
 }
 assert.equal((await run({exitCode:0,output:'ok'})).ok.toString(),'ok');
 const oom=await run({exitCode:137,stderr:secret});assert.equal(oom.error.diagnostics.exitCode,137);assert.equal(oom.error.diagnostics.diagnostic,'PROCESS_KILLED_POSSIBLE_OOM');assert.deepEqual(JSON.parse(String(oom.error.detail)),oom.error.diagnostics,'Existing string-detail consumers keep safe diagnostic fields');
 const signal=await run({exitCode:null,signal:'SIGKILL',stderr:secret});assert.equal(signal.error.diagnostics.signal,'SIGKILL');
 assert.equal((await run({stderr:'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n'+secret})).error.diagnostics.diagnostic,'NODE_HEAP_EXHAUSTED');
 assert.equal((await run({stderr:'ERR_MODULE_NOT_FOUND '+secret})).error.diagnostics.diagnostic,'DEPENDENCY_MISSING');
 const timed=await run({exitCode:null,signal:'SIGTERM',timeout:true,stderr:secret});assert.equal(timed.error.diagnostics.timedOut,true);assert.equal(timed.error.diagnostics.diagnostic,'TIMEOUT');assert.deepEqual(timed.kills,['SIGTERM']);
 assert.equal((await run({limit:true,stderr:secret})).error.diagnostics.outputLimitExceeded,true);
 const cli=read('scripts/instance-git-export.mjs'),body=cli.slice(cli.lastIndexOf(' try{'),cli.lastIndexOf('\n}'));let text='';const fakeProcess={argv:[],stderr:{write:value=>{text+=value;}},stdout:{write:()=>{throw Error('unexpected success');}},exitCode:0};
 const scope={process:fakeProcess,parseArgs:()=>({values:{},positionals:['restore']}),restoreGitSnapshot:async()=>{throw oom.error;}};
 await Object.getPrototypeOf(async function(){}).constructor(...Object.keys(scope),body)(...Object.values(scope));
 const publicError=JSON.parse(text);assert.equal(fakeProcess.exitCode,1);assert.equal(publicError.code,'POSTGRES_DOCKER_FAILED');assert.equal(publicError.detail.exitCode,137);assert(!text.includes(secret));assert(!text.includes('sk-private'));
});
