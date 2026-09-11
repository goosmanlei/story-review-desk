import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const compile=file=>ts.transpileModule(readFileSync(new URL('../app/'+file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace(/^import .*;$/gm,'');
const source=compile('paged-production-data.ts')+compile('workspace-read-cache.ts');
const cache=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const savedFetch=globalThis.fetch;
test.after(()=>{globalThis.fetch=savedFetch;});
const page=(ids,{version='a',cursor=null,total=ids.length}={})=>({schemaVersion:'1',snapshotId:'snapshot',operationRevision:version,readVersion:version,page:{materialRequirements:ids.map(id=>({id}))},count:ids.length,total,hasMore:!!cursor,nextCursor:cursor,appliedFilters:{}});
const response=(value,etag='"a"')=>new Response(JSON.stringify(value),{headers:{ETag:etag}});
const delay=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
test('complete pagination publishes once; reentry validates only the first version and preserves the parsed graph',async()=>{
 let calls=0;const last=delay();globalThis.fetch=async(url,init)=>{calls++;if(init.headers['If-None-Match'])return new Response(null,{status:304});if(url.includes('cursor=')){await last.promise;return response(page(['b'],{total:2}));}return response(page(['a'],{cursor:'next',total:2}));};
 let completed=false;const task=cache.readCompleteProduction('materials',{},'complete').then(value=>{completed=true;return value;});await new Promise(yes=>setImmediate(yes));assert.equal(completed,false);last.resolve();const value=await task;assert.deepEqual(value.page.materialRequirements.map(r=>r.id),['a','b']);assert.equal(calls,2);assert.equal(await cache.readCompleteProduction('materials',{},'complete'),value);assert.equal(calls,3);
});
test('a changed middle page restarts the complete read and never mixes versions',async()=>{
 let calls=0;globalThis.fetch=async()=>{calls++;return response(calls===1?page(['old'],{cursor:'old-cursor',total:2}):calls===2?page(['new'],{version:'b',total:2}):calls===3?page(['new-a'],{version:'b',cursor:'new-cursor',total:2}):page(['new-b'],{version:'b',total:2}));};
 const value=await cache.readCompleteProduction('materials',{},'changing');assert.equal(calls,4);assert.deepEqual(value.page.materialRequirements.map(r=>r.id),['new-a','new-b']);
});
test('failed reads reject instead of returning cached or empty data; retry stays available',async()=>{
 let fail=false;globalThis.fetch=async()=>fail?new Response('{"error":"offline"}',{status:503}):response({state:'complete'});
 await cache.readWorkspaceJson('/settings','failure');fail=true;await assert.rejects(cache.readWorkspaceJson('/settings','failure'),/offline/);fail=false;assert.equal((await cache.readWorkspaceJson('/settings','failure')).state,'complete');
});
test('cancelling one subscriber preserves another; cancelling all subscribers aborts transport',async()=>{
 let calls=0,signal;const ready=delay();globalThis.fetch=async(_url,init)=>{calls++;signal=init.signal;await ready.promise;return response({ok:true});};
 const a=new AbortController(),b=new AbortController(),first=cache.readWorkspaceJson('/same','subscribers',a.signal),second=cache.readWorkspaceJson('/same','subscribers',b.signal);a.abort();await assert.rejects(first,{name:'AbortError'});assert.equal(signal.aborted,false);ready.resolve();assert.equal((await second).ok,true);assert.equal(calls,1);
 const hold=delay();globalThis.fetch=async(_url,init)=>{signal=init.signal;await hold.promise;return response({ok:true});};const c=new AbortController(),only=cache.readWorkspaceJson('/only','subscribers',c.signal);c.abort();await assert.rejects(only,{name:'AbortError'});assert.equal(signal.aborted,true);hold.resolve();
});
test('cache scope separates instances and runtime epochs and evicts old entries',async()=>{
 const conditionals=[];globalThis.fetch=async(url,init)=>{conditionals.push(init.headers['If-None-Match']||null);return response({url});};
 await cache.readWorkspaceJson('/x','epoch-a');await cache.readWorkspaceJson('/x','epoch-b');assert.deepEqual(conditionals,[null,null]);
 for(let i=0;i<13;i++)await cache.readWorkspaceJson('/entry'+i,'bounded');await cache.readWorkspaceJson('/entry0','bounded');assert.equal(conditionals.at(-1),null);
});
test('duplicate identities and looping cursors fail instead of claiming completeness',async()=>{
 globalThis.fetch=async(url)=>response(page(['same'],{total:2,cursor:url.includes('cursor=')?null:'next'}));await assert.rejects(cache.readCompleteProduction('materials',{},'duplicates'),/对象数/);
 globalThis.fetch=async()=>response(page(['same'],{total:3,cursor:'loop'}));await assert.rejects(cache.readCompleteProduction('materials',{},'looping'),/游标重复/);
});

test('parallel workspace reads restart when their committed repository bases differ',async()=>{
 let calls=0;
 globalThis.fetch=async url=>{calls++;const basis=calls===1?'old':'new';return new Response(JSON.stringify(url.includes('/materials')?page(['current']):{snapshotId:'snapshot'}),{headers:{ETag:'"'+basis+'"','X-Review-Basis':basis}});};
 const value=await cache.readProductionWorkspace('materials',{},'consistent',['/preparation']);
 assert.equal(calls,4);assert.deepEqual(value.payload.page.materialRequirements.map(row=>row.id),['current']);
});
test('same content conditional responses carry the new repository basis',async()=>{
 let calls=0;globalThis.fetch=async()=>++calls===1?new Response('{"ok":true}',{headers:{ETag:'"same"','X-Review-Basis':'old'}}):new Response(null,{status:304,headers:{ETag:'"same"','X-Review-Basis':'new'}});
 const before=await cache.readWorkspaceJson('/stable','basis');const after=await cache.readWorkspaceBatch(['/stable'],'basis');assert.equal(after[0],before);
});
test('complete material catalog starts prerequisites together and waits for exact trial snapshots once',async()=>{
 const calls=[],held=delay();let done=false;
 globalThis.fetch=async url=>{
  calls.push(url);let value;
  if(url.includes('/ui/materials'))value=page(['a']);
  else if(url==='/api/trial/scopes')value={scopes:[{id:'trial-one'}]};
  else if(url.includes('/trial/snapshot')){await held.promise;value={mode:'LOCAL_TRIAL',scope:{id:'trial-one'},assets:[{versionId:'v'}],recipes:[]};}
  else value={releaseId:'release'};
  return new Response(JSON.stringify(value),{headers:{ETag:'"same"','X-Review-Basis':'same'}});
 };
 const pending=cache.readProductionWorkspace('materials',{},'bundle',['/directory','/preparation'],undefined,{trialCatalog:true}).then(value=>{done=true;return value;});
 await new Promise(yes=>setImmediate(yes));assert(calls.includes('/directory'));assert(calls.includes('/preparation'));assert.equal(done,false);
 held.resolve();const result=await pending;assert.equal(result.materialCatalog.trials[0].assets[0].scopeId,'trial-one');assert.equal(result.materialCatalog.values.length,2);
 assert.equal(calls.filter(url=>url==='/directory').length,1);assert.equal(calls.filter(url=>url==='/api/trial/scopes').length,1);
});
test('trial scope changes restart the whole material bundle and a failed scope cannot appear empty',async()=>{
 let indexes=0;
 globalThis.fetch=async url=>{
  const isIndex=url==='/api/trial/scopes';if(isIndex)indexes++;
  const old=isIndex&&indexes===1;
  const value=url.includes('/ui/materials')?page(['a']):isIndex?{scopes:[{id:old?'old':'new'}]}:url.includes('/trial/snapshot')?{mode:'LOCAL_TRIAL',scope:{id:url.endsWith('old')?'old':'new'},assets:[],recipes:[]}:{releaseId:'release'};
  return new Response(JSON.stringify(value),{headers:{ETag:'"'+(old?'old':'new')+'"','X-Review-Basis':old?'old':'new'}});
 };
 const result=await cache.readProductionWorkspace('materials',{},'scope-race',['/directory'],undefined,{trialCatalog:true});assert.equal(indexes,2);assert.equal(result.materialCatalog.trials[0].scope.id,'new');
 globalThis.fetch=async url=>url.includes('/trial/scopes')?new Response('{"error":"scope unavailable"}',{status:503}):response(page(['a']));
 await assert.rejects(cache.readProductionWorkspace('materials',{},'scope-failure',[],undefined,{trialCatalog:true}),/scope unavailable/);
});
