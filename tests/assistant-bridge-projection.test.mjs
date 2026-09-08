import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const site=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url),ts=require('typescript');
const source=readFileSync(path.join(site,'app/api/v8/_codex-conversation-store.ts'),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;

function fixture(){
  let health=null,reads=0;
  const repo={async getAux(namespace,key){
    assert.equal(namespace,'assistant-public');assert.equal(key,'health.json');reads++;
    return health===null?null:{bytes:Buffer.from(JSON.stringify(health))};
  }};
  const profile={projectId:'project:bridge-test',assistant:{schedulerProtocol:'REVIEW_CODEX_SCHEDULER_V1',conversationHashNamespace:'CONVERSATION_TEST',archiveHashNamespace:'ARCHIVE_TEST'}};
  const module={exports:{}};
  const dependencies=specifier=>{
    if(specifier==='./_store')return{
      instanceMode:()=>true,instanceRepository:async()=>repo,reviewData:async()=>({}),
      eventStorePath:()=>{throw Error('file store must not be used');},
      HttpError:class extends Error{constructor(status,message){super(message);this.status=status;}},
    };
    if(specifier==='../../instance-profile')return{instanceProfile:()=>profile};
    if(specifier==='node:fs/promises')return new Proxy({}, {get:()=>()=>{throw Error('projection must not access the filesystem');}});
    if(specifier.startsWith('.'))return require(path.resolve(site,'app/api/v8',specifier));
    return require(specifier);
  };
  new Function('require','module','exports','process',compiled)(dependencies,module,module.exports,{env:{REVIEW_INSTANCE_ROOT:'/synthetic/explicit-instance'}});
  return{setHealth(value){health=value;},project:module.exports.codexBridgeProjection,get reads(){return reads;}};
}
const ready=versions=>({checkedAt:new Date().toISOString(),status:'READY',executionProtocol:'REVIEW_CONTROLLED_ACTIONS_V1',workContextProtocol:'REVIEW_WORK_CONTEXT_V1',workContextCatalogVersions:versions,workContextPreflightVerified:true,mode:'REAL',runnableSlotCount:1});

test('actual bridge projection preserves catalog1.2 through the pre-send compatibility check',async()=>{
  const f=fixture();f.setHealth(ready(['1.0','1.1','1.2','1.3','bogus',1.2,null]));
  const bridge=await f.project();
  assert.deepEqual(bridge.workContextCatalogVersions,['1.0','1.1','1.2']);
  assert.equal(bridge.online,true);assert.equal(bridge.executionProtocol,'REVIEW_CONTROLLED_ACTIONS_V1');
  assert.equal(bridge.workContextProtocol,'REVIEW_WORK_CONTEXT_V1');assert.equal(bridge.workContextPreflightVerified,true);
  assert.equal(bridge.workContextCatalogVersions.includes('1.2'),true);
  assert.equal(f.reads,1);
});
test('actual bridge projection keeps legacy,unknown and stale health boundaries',async()=>{
  const f=fixture();
  f.setHealth(ready(['1.0','1.1']));let bridge=await f.project();
  assert.deepEqual(bridge.workContextCatalogVersions,['1.0','1.1']);assert.equal(bridge.workContextCatalogVersions.includes('1.2'),false);
  f.setHealth(ready(['1.3',1.2,null,{}]));bridge=await f.project();assert.deepEqual(bridge.workContextCatalogVersions,[]);
  f.setHealth(ready(undefined));bridge=await f.project();assert.deepEqual(bridge.workContextCatalogVersions,['1.0']);
  f.setHealth({...ready(['1.2']),checkedAt:new Date(Date.now()-16000).toISOString()});bridge=await f.project();
  assert.equal(bridge.online,false);assert.equal(bridge.status,'OFFLINE');assert.equal(bridge.executionProtocol,null);assert.equal(bridge.workContextPreflightVerified,false);
  f.setHealth(null);bridge=await f.project();assert.equal(bridge.online,false);assert.deepEqual(bridge.workContextCatalogVersions,['1.0']);
  assert.equal(f.reads,5);
});
