import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const here=path.dirname(fileURLToPath(import.meta.url));
const softwareRoot=path.resolve(here,'..');
const helper=path.join(softwareRoot,'host/instance-runtime/archive-integrity.mjs');
const {canonicalSha256,archiveRowHashes,assertArchiveRowHashes}=await import(pathToFileURL(helper).href);
const {BUSINESS_TABLES}=await import(pathToFileURL(path.join(softwareRoot,'host/instance-runtime/postgres-schema.mjs')).href);
const {APPLICATION_ID,SCHEMA_VERSION}=await import(pathToFileURL(path.join(softwareRoot,'host/instance-runtime/schema.mjs')).href);
const {restoredRuntimeEpoch}=await import(pathToFileURL(path.join(softwareRoot,'host/instance-runtime/execution-epoch.mjs')).href);
const restoreUuid='11111111-2222-4333-8444-555555555555';
const expectedRestoreEpoch=restoredRuntimeEpoch(restoreUuid);
const sha256=x=>createHash('sha256').update(x).digest('hex');
const canonicalJson=value=>{
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonicalJson).join(',')+']';
 return '{'+Object.keys(value).filter(key=>value[key]!==undefined).sort().map(key=>JSON.stringify(key)+':'+canonicalJson(value[key])).join(',')+'}';
};
const fixtures=[null,true,false,0,-0,NaN,Infinity,'中文🙂','\ud800','\udc00','a\nb\\"',[undefined,,1],{b:2,a:[null,{b:'é',a:1}],u:undefined},{fn:()=>1},new Date(0)];
let seed=319873;const next=()=>((seed=(seed*1664525+1013904223)>>>0)/2**32);
function value(depth=0){
 const n=Math.floor(next()*6);
 if(depth>4||n<2)return [null,next()*10000,Boolean(n),'汉字😀\n'+Math.floor(next()*100)][Math.floor(next()*4)];
 if(n<4)return Array.from({length:Math.floor(next()*7)},()=>value(depth+1));
 return Object.fromEntries(Array.from({length:Math.floor(next()*7)},(_,i)=>['k'+i,value(depth+1)]));
}
for(let i=0;i<2500;i++)fixtures.push(value());
for(const fixture of fixtures)assert.equal(canonicalSha256(fixture),sha256(canonicalJson(fixture)));
assert.throws(()=>canonicalSha256(undefined));assert.throws(()=>canonicalSha256(1n));

const pg=await readFile(path.join(softwareRoot,'host/instance-runtime/postgres.mjs'),'utf8');
assert(pg.includes('async function verifyImportedRepository'),'installed restore verification implementation is required');
assert(pg.includes('export function validateArchive'),'installed archive validator is required');
const source=pg.slice(pg.indexOf('export function validateArchive')).replaceAll('export function ','function ').replaceAll('export async function ','async function ');
const ids={revision:'r1',release:'release_fixture',instance:'fixture'};
const encode=bytes=>({encoding:'base64',bytes:Buffer.from(bytes).toString('base64')});
const jsonBytes=value=>Buffer.from(JSON.stringify(value));
function archiveFixture(){
 const recordBytes=jsonBytes({instanceId:ids.instance}),snapshot=jsonBytes({snapshotId:'snapshot_fixture'}),event=jsonBytes({eventId:'e1',eventKind:'TEST'});
 const tables=Object.fromEntries(BUSINESS_TABLES.map(t=>[t,[]]));
 tables.repository_meta=[{singleton:1,instance_id:ids.instance,runtime_epoch:'old_epoch',repository_revision:1,current_release_id:ids.release,created_at:'date'}];
 tables.record_revisions=[{revision_id:ids.revision,namespace:'settings',record_key:'instance-profile',revision_number:1,previous_revision_id:null,content_bytes:encode(recordBytes),content_sha256:sha256(recordBytes),media_type:'application/json',metadata_json:'{}',deleted:0,created_at:'date'}];
 tables.record_heads=[{namespace:'settings',record_key:'instance-profile',revision_id:ids.revision}];
 tables.document_aliases=[{alias:'fixture',document_id:'fixture_doc'}];
 tables.releases=[{release_id:ids.release,snapshot_id:'snapshot_fixture',snapshot_bytes:encode(snapshot),snapshot_sha256:sha256(snapshot),recipes_bytes:encode(snapshot),recipes_sha256:sha256(snapshot),source_revision_ids_json:'["r1"]',profile_revision_id:ids.revision,created_at:'date'}];
 tables.domain_events=[{storage_sequence:1,event_id:'e1',event_kind:'TEST',event_bytes:encode(event),event_sha256:sha256(event),idempotency_key_hash:null}];
 tables.media_versions=[1,2].map(i=>({media_id:'m'+i,version_id:'v1',relative_path:'media/m'+i,sha256:sha256('media'+i),byte_size:6,availability:'PRESENT',metadata_json:'{}',created_at:'date'}));
 tables.media_aliases=[{alias:'media_alias',media_id:'m1',version_id:'v1'}];
 const body={schemaVersion:SCHEMA_VERSION,applicationId:APPLICATION_ID,instanceId:ids.instance,tables,sequence:[{name:'domain_events',seq:1}],mediaIncluded:false};
 return {...body,exportSha256:canonicalSha256(body)};
}
async function runScenario(mode){
 const original=archiveFixture(),stored=Object.fromEntries(BUSINESS_TABLES.map(t=>[t,[]])),counts={commits:0,exports:0,schema:0,views:0,writes:0,closed:0,metadata:0};
 const ensure=(ok,code,message)=>{if(!ok)throw Object.assign(new Error(message),{code});};
 const number=x=>Number(x),parse=x=>JSON.parse(Buffer.from(x).toString('utf8'));
 const client={async query(sql,params){
  if(sql.startsWith('SELECT column_name'))return{rows:Object.keys(original.tables[params[1]][0]||{}).map(column_name=>({column_name}))};
  if(sql.startsWith('INSERT INTO ')){const m=sql.match(/^INSERT INTO ([a-z_]+)\(([^)]+)\)/);stored[m[1]].push(Object.fromEntries(m[2].split(',').map((k,i)=>[k,params[i]])));return{rows:[]};}
  if(sql.startsWith('UPDATE repository_meta')){stored.repository_meta[0].runtime_epoch=params[0];stored.repository_meta[0].repository_revision++;return{rows:[]};}
  if(sql.startsWith('SELECT setval'))return{rows:[]};throw Error('unexpected SQL');
 }};
 const metadata=()=>({instanceId:ids.instance,releaseId:ids.release,runtimeEpoch:expectedRestoreEpoch,repositoryRevision:2,eventSequence:1});
 let cursorRows=[];
 const tx={async query(sql){
  if(sql.startsWith('DECLARE review_restore_verify_rows')){
   const table=sql.match(/FROM ([a-z_]+)/)[1];cursorRows=stored[table].map(row=>({...row}));
   if(table==='media_versions'){
    if(mode==='row-mutation')cursorRows[0].byte_size++;
    if(mode==='row-addition')cursorRows.push({...cursorRows[0],media_id:'m3'});
    if(mode==='reorder')cursorRows.reverse();
   }
   if(mode==='missing-head'&&table==='record_heads')cursorRows=[];
   if(mode==='bytes-tamper'&&table==='record_revisions')cursorRows[0].content_bytes=Buffer.from('changed');
   return{rows:[]};
  }
  if(sql==='FETCH FORWARD 1 FROM review_restore_verify_rows')return{rows:cursorRows.length?[cursorRows.shift()]:[]};
  if(sql==='CLOSE review_restore_verify_rows'){cursorRows=[];return{rows:[]};}
  throw Error('unexpected verification SQL: '+sql);
 },async exportState(){
  counts.exports++;
  const tables=Object.fromEntries(Object.entries(stored).map(([name,rows])=>[name,rows.map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,Buffer.isBuffer(v)?encode(v):v])))]));
  if(mode==='row-mutation')tables.media_versions[0].byte_size++;
  if(mode==='row-addition')tables.media_versions.push({...tables.media_versions[0],media_id:'m3'});
  if(mode==='missing-head')tables.record_heads=[];
  if(mode==='bytes-tamper')tables.record_revisions[0].content_bytes=encode('changed');
  if(mode==='reorder')tables.media_versions.reverse();
  const {exportSha256,...body}=original;body.tables=tables;return{...body,exportSha256:canonicalSha256(body)};
 },async readView(){counts.views++;if(mode==='view-failure')throw Error('view invariant failed');return{};},
 async readRelease(){return null;},async getMetadata(){counts.metadata++;return metadata();}};
 const repo={instanceId:ids.instance,async validateSchema(){counts.schema++;if(mode==='schema-failure')throw Error('schema invariant failed');},
 async readTransaction(callback){return callback(tx);},async writeTransaction(callback){counts.writes++;return callback(tx);},
 async exportState(){throw Error('duplicate export forbidden');},async integrityCheck(){throw Error('duplicate integrity pass forbidden');},
 async close(){counts.closed++;}};
 const bindings={ensure,readOnlyProcess:()=>false,number,parse,digest:x=>x,sha256,canonicalJson,canonicalSha256,archiveRowHashes,assertArchiveRowHashes,restoredRuntimeEpoch,BUSINESS_TABLES,APPLICATION_ID,SCHEMA_VERSION,
 postgresConnection:async options=>{assert(!Object.hasOwn(options,'archive'));return{};},
 emptySchema:async(_connection,callback)=>{await callback(client);counts.commits++;},
 openPostgresRepository:async options=>{assert(!Object.hasOwn(options,'archive'));return repo;},
 rebuildQueryModel:async()=>{throw Error('no fixture current release body');},randomUUID:()=>restoreUuid};
 const make=new Function(...Object.keys(bindings),source+'\nreturn {importPostgresState,validateArchive};');
 const impl=make(...Object.values(bindings));
 if(mode==='invalid-input-hash')original.exportSha256='0'.repeat(64);
 try{
  const restored=await impl.importPostgresState({archive:original,instanceId:ids.instance});
  assert.equal(mode==='success'||mode==='reorder',true);
  assert.equal(restored,repo);assert.equal(repo.importVerification.status,'POSTGRES_IMPORT_VERIFIED');
  assert.equal(repo.importVerification.integrity.ok,true);assert(Object.isFrozen(repo.importVerification));assert(Object.isFrozen(repo.importVerification.metadata));
  assert.equal(stored.repository_meta[0].runtime_epoch,expectedRestoreEpoch,'restore uses the actual prefixed fresh epoch helper');
  assert.equal(repo.importVerification.metadata.runtimeEpoch,expectedRestoreEpoch);
  assert.equal(counts.exports,0);assert.equal(counts.schema,1);assert.equal(counts.views,1);assert.equal(counts.metadata,1);assert.equal(counts.writes,1);
  assert.throws(()=>{repo.importVerification={status:'fake'};});
  assert.equal(original.tables.repository_meta[0].runtime_epoch,'old_epoch','caller archive is not mutated');
 }catch(error){
  if(mode==='success'||mode==='reorder')throw error;
  const expected={'row-mutation':/Migration changed original business rows/,'row-addition':/Migration changed original business rows/,'missing-head':/Missing head/,'bytes-tamper':/Record bytes mismatch/,'view-failure':/view invariant/,'schema-failure':/schema invariant/,'invalid-input-hash':/Business archive changed/};
  assert.match(error.message,expected[mode]);
  if(mode==='invalid-input-hash')assert.equal(counts.commits,0);else assert.equal(counts.closed,1);
  assert.equal(repo.importVerification,undefined);
 }
 return counts;
}
const scenarios={};
for(const mode of ['success','reorder','row-mutation','row-addition','missing-head','bytes-tamper','view-failure','schema-failure','invalid-input-hash'])scenarios[mode]=await runScenario(mode);
console.log(JSON.stringify({status:'PASS',canonicalParityFixtures:fixtures.length,importScenarios:Object.keys(scenarios).length,successfulRestoreExportCount:scenarios.success.exports,realDatabaseConnections:0,mediaOperations:0,filesystemWrites:0}));
