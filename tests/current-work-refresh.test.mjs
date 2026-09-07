import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

// Hook-level race regression: execute the actual component effects with controlled
// promises. No browser, HTTP, database, service, business write or production fixture.
const reviewRoot=new URL('../',import.meta.url);
const require=createRequire(new URL('package.json',reviewRoot));
const ts=require('typescript');
const settle=async()=>{await new Promise(setImmediate);await new Promise(setImmediate);};
function mount(filename,exportName){
 const state=[],effects=[],requests=[],listeners=new Map();let stateIndex=0;
 const react={useState(initial){const index=stateIndex++;state[index]=initial;return [initial,value=>{state[index]=typeof value==='function'?value(state[index]):value;}];},useEffect(effect){effects.push(effect);},useMemo(fn){return fn();}};
 const module={exports:{}};
 const context={module,exports:module.exports,AbortController,Response,console,document:{visibilityState:'visible',addEventListener(name,callback){listeners.set('document:'+name,callback);},removeEventListener(name){listeners.delete('document:'+name);}},fetch(_url,options){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});requests.push({resolve,reject,signal:options.signal});return promise;},window:{setInterval(){return 1;},clearInterval(){},addEventListener(name,callback){listeners.set(name,callback);},removeEventListener(name){listeners.delete(name);}},require(name){
  if(name==='react')return react;
  if(name==='react/jsx-runtime')return {jsx(){return null;},jsxs(){return null;}};
  if(name==='./system-management-client')return {async readManagementResponse(response){const result=await response.json();if(!response.ok)throw Error(result.error);return result;}};
  return {};
 }};
 const source=readFileSync(new URL('app/'+filename,reviewRoot),'utf8');
 const {outputText}=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}});
 vm.runInNewContext(outputText,context,{filename:fileURLToPath(new URL('app/'+filename,reviewRoot))});
 module.exports[exportName]({value:{area:'ALL',actor:'ALL',state:'NOW',type:'ALL'},onChange(){},reviewRemaining:0,materialRequirementCount:0});
 const cleanup=effects.map(effect=>effect()).filter(Boolean);
 return {state,requests,refresh(){listeners.get('review:operations-updated')();},cleanup(){cleanup.forEach(fn=>fn());}};
}
const packet=marker=>({queue:{marker,snapshotId:'snapshot',operationRevision:'ops'},workflow:{marker,freshness:{snapshotId:'snapshot',operationRevision:'ops'}}});
for(const oldResult of ['success','failure'])test('atomic workspace ignores older '+oldResult+' after latest success',async()=>{
 const app=mount('workflow-overview.tsx','useWorkflowProjection');app.refresh();assert.equal(app.requests.length,2);
 app.requests[1].resolve(new Response(JSON.stringify(packet('LATEST'))));await settle();assert.equal(app.state[0]?.queue.marker,'LATEST');
 app.requests[0].resolve(new Response(JSON.stringify(oldResult==='success'?packet('OLD'):{error:'OLDER_REQUEST_FAILED'}),{status:oldResult==='success'?200:503}));await settle();
 assert.equal(app.state[0]?.queue.marker,'LATEST');assert.equal(app.state[0]?.workflow.marker,'LATEST');assert.equal(app.state[1],'');app.cleanup();
});
test('atomic workspace does not apply a success after cleanup',async()=>{
 const app=mount('workflow-overview.tsx','useWorkflowProjection');app.cleanup();assert.equal(app.requests.length,1);assert.equal(app.requests[0].signal.aborted,true);
 app.requests[0].resolve(new Response(JSON.stringify(packet('UNMOUNTED'))));await settle();assert.equal(app.state[0],null);
});
