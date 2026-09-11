import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalJson,sha256} from '../host/instance-runtime/bytes.mjs';
import {readRestoredAuxiliaryHistory,classifyRestoredAuxiliaryHistory,inspectAuxiliaryHistoryScript} from '../host/instance-runtime/vps-quiescence.mjs';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {VpsDriver} from '../host/instance-runtime/vps-driver.mjs';

const epoch='restore_v1_11111111-1111-4111-8111-111111111111';
function fixture({head='old-head',brokenRow=false}={}){
 const namespace='aux:worker-comment-polish',key='request.json',bytes=Buffer.from(JSON.stringify({state:'UNKNOWN',requestId:'original'}));
 const tables={record_heads:[{namespace,record_key:key,revision_id:head}],record_revisions:[{namespace,record_key:key,revision_id:'old-head',content_bytes:{encoding:'base64',bytes:bytes.toString('base64')},content_sha256:brokenRow?'f'.repeat(64):sha256(bytes),deleted:0}],repository_meta:[{instance_id:'fixture',runtime_epoch:'origin-epoch',current_release_id:'original-release',repository_revision:7}]};
 const records=Object.entries(tables).flatMap(([table,rows])=>rows.map(row=>({row,table})));
 const archive=Buffer.from([{format:'REVIEW_REPOSITORY_ARCHIVE_NDJSON_1',header:{instanceId:'fixture'},tableNames:Object.keys(tables)},...records,{end:true,rows:records.length}].map(JSON.stringify).join('\n')+'\n');
 const baseline={instanceId:'fixture',releaseId:'original-release',repositoryRevision:7,manifestSha256:'b'.repeat(64),database:{path:'data/repository.jsonl',format:'REVIEW_REPOSITORY_ARCHIVE_NDJSON_1',sha256:sha256(archive),bytes:archive.length}};
 const source={manifest:{baseline},opens:0,async *open(relative){assert.equal(relative,'baseline/data/repository.jsonl');this.opens++;for(let i=0;i<archive.length;i+=37)yield archive.subarray(i,i+37);}};
 const runtime={id:'runtime-fixture',instanceId:'fixture',runtimeEpoch:epoch,web:'fixture-web'};
 const row={namespace,key,revisionId:'old-head',sha256:sha256(bytes),state:'UNKNOWN'};
 const metadata={instanceId:'fixture',runtimeEpoch:epoch};
 const check={metadata,blockers:[{namespace,key,state:'UNKNOWN'},{namespace:'http-requests',key:'gateway',state:'RUNNING',count:1}]};
 const inspection={metadata,restoreManifestHash:sha256(canonicalJson(baseline)),records:[row],restoreProof:{status:'RESTORED_VERIFIED',instanceId:'fixture',runtimeEpoch:epoch,releaseId:baseline.releaseId,originalBytesPreserved:true,businessIdsPreserved:true,integrity:{ok:true},streamPasses:4,scratchArchiveBytes:0}};
 return {source,runtime,row,check,inspection};
}

test('exact restored unknown remains historical, preserving HTTP blockers and original states',async()=>{
 const f=fixture(),history=await readRestoredAuxiliaryHistory(f.source),before=structuredClone(f.check);
 const result=classifyRestoredAuxiliaryHistory(f.check,f.inspection,history,f.runtime);
 assert.equal(f.source.opens,2);assert.deepEqual(result.blockers,[f.check.blockers[1]]);
 assert.equal(result.restoredHistory[0].externalResult,'STILL_UNKNOWN');assert.equal(result.restoredHistory[0].executionResumed,false);
 assert.deepEqual(f.check,before);assert.equal(f.inspection.records[0].state,'UNKNOWN');
});

test('same bytes in a new revision, changed bytes, and new unknowns remain blocking',async()=>{
 for(const change of [r=>r.revisionId='new-head',r=>r.sha256='a'.repeat(64),r=>r.key='new-request.json',r=>r.state='RUNNING']){
  const f=fixture(),history=await readRestoredAuxiliaryHistory(f.source);change(f.inspection.records[0]);
  const result=classifyRestoredAuxiliaryHistory(f.check,f.inspection,history,f.runtime);
  assert.equal(result.restoredHistory.length,0);assert.equal(result.blockers.length,2);
 }
});

test('re-reading all active heads catches a request added during the archive scan',async()=>{
 const f=fixture(),history=await readRestoredAuxiliaryHistory(f.source);
 f.inspection.records.push({...f.row,key:'arrived-after-first-check',revisionId:'new',state:'RESULT_UNKNOWN'});
 const result=classifyRestoredAuxiliaryHistory(f.check,f.inspection,history,f.runtime);
 assert.equal(result.restoredHistory.length,1);assert.equal(result.blockers[1].key,'arrived-after-first-check');
});

test('different epoch, different manifest, incomplete restore, or absent current inspection fails closed',async()=>{
 const changes=[f=>f.inspection.metadata={...f.inspection.metadata,runtimeEpoch:'origin-epoch'},f=>f.runtime.instanceId='other',f=>f.inspection.restoreManifestHash='d'.repeat(64),f=>f.inspection.restoreProof.originalBytesPreserved=false,f=>f.inspection.restoreProof.runtimeEpoch='restore_v1_other',f=>f.inspection.restoreProof.releaseId='other-release',f=>f.inspection.restoreProof.integrity.ok=false,f=>f.inspection.restoreProof.streamPasses=3,f=>delete f.inspection.records];
 for(const change of changes){const f=fixture(),history=await readRestoredAuxiliaryHistory(f.source);change(f);assert.throws(()=>classifyRestoredAuxiliaryHistory(f.check,f.inspection,history,f.runtime));}
});

test('only the frozen head counts, not an older revision retained in history',async()=>{
 const f=fixture({head:'newer-head'}),history=await readRestoredAuxiliaryHistory(f.source);
 assert.equal(history.records.size,0);assert.equal(classifyRestoredAuxiliaryHistory(f.check,f.inspection,history,f.runtime).blockers.length,2);
});

test('corrupt archived row SHA or archive bytes cannot establish an exemption',async()=>{
 await assert.rejects(readRestoredAuxiliaryHistory(fixture({brokenRow:true}).source),/SHA differs/);
 const f=fixture();f.source.manifest.baseline.database.sha256='0'.repeat(64);
 await assert.rejects(readRestoredAuxiliaryHistory(f.source),/SHA/);
});

test('publisher reads current revision proofs even when the deployed checker is older',async()=>{
 const f=fixture(),state={current:{runtime:f.runtime,cleanReady:true,manifestSha256:'manifest'}};
 const driver=new VpsDriver({},state);driver.owned=async()=>({State:{Running:true}});driver.cleanSource=async()=>f.source;
 let rereads=0;
 driver.docker=async args=>{
  if(args.includes(inspectAuxiliaryHistoryScript)){rereads++;return JSON.stringify(f.inspection);}
  assert(args.includes('scripts/instance-vps-runtime-check.mjs'));return JSON.stringify(f.check);
 };
 assert.equal((await driver.runtimeCheck(f.runtime)).restoredHistory.length,1);
 f.inspection.records.push({...f.row,key:'fresh-result',revisionId:'new-head'});
 const next=await driver.runtimeCheck(f.runtime);assert(next.blockers.some(b=>b.key==='fresh-result'));
 assert.equal(f.source.opens,2);assert.equal(rereads,2);
});


test('archive verification refreshes non-AUX activity before judging quiescence',async()=>{
 const f=fixture(),driver=new VpsDriver({},{current:{runtime:f.runtime,cleanReady:true,manifestSha256:'manifest'}});
 driver.owned=async()=>({State:{Running:true}});driver.cleanSource=async()=>f.source;
 let checks=0;
 driver.docker=async args=>{
  if(args.includes(inspectAuxiliaryHistoryScript))return JSON.stringify(f.inspection);
  checks++;
  return JSON.stringify({...f.check,blockers:[...f.check.blockers,...(checks>1?[{namespace:'formal-executions',key:'new-run',state:'RUNNING'}]:[])]});
 };
 const result=await driver.runtimeCheck(f.runtime);
 assert.equal(checks,2);assert(result.blockers.some(b=>b.key==='new-run'));
});

test('minified publisher keeps the compatibility inspector self-contained',async()=>{
 const built=await build({entryPoints:[fileURLToPath(new URL('../host/instance-runtime/vps-quiescence.mjs',import.meta.url))],bundle:true,platform:'node',format:'esm',target:'node22',write:false,minify:true});
 const packed=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
 const script=packed.inspectAuxiliaryHistoryScript;
 const body=script.slice(script.indexOf('const readCurrentAuxiliaryActivity='),script.indexOf('const repo='));
 const readCurrent=Function(body+'return readCurrentAuxiliaryActivity;')();
 const bytes=Buffer.from('{"state":"UNKNOWN"}');
 const row={namespace:'aux:worker',record_key:'old',revision_id:'head',content_bytes:bytes,content_sha256:sha256(bytes)};
 const result=await readCurrent({all:async()=>[row],getMetadata:async()=>({instanceId:'fixture'})});
 assert.equal(result.records[0].sha256,row.content_sha256);
 assert.equal(result.records[0].revisionId,'head');
 await assert.rejects(readCurrent({all:async()=>[{...row,content_sha256:'f'.repeat(64)}]}),/SHA differs/);
});
