const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../review_desk/static/unified-cards.js'),'utf8');
const code=source.slice(source.indexOf('function retainLoadedMaterialMembers('),source.indexOf('function renderUnifiedCard('));
function fixture(){
 const before={object_id:'m',id:'m-current',version:4},data={entity:{object_id:'e',id:'e-current',edit_token:2},source_signature:'s1',requirements:[before],material_versions:{},materialContexts:{},deferred_materials:['m'],deferred_candidates:['c'],comment_records:[],comment_targets:[]};
 const results=[],context={URLSearchParams,api:url=>new Promise((resolve,reject)=>results.push({url,resolve,reject}))};vm.createContext(context);vm.runInContext(code,context);
 const response=()=>({entity:data.entity,source_signature:'s1',requirements:[{...before,payload:{generation:{prompt:'exact'}}}],material_versions:{m:[{number:1,results:[],members:[]}]},materialContexts:{c:{call:{id:'call-original'}}},comment_records:[],comment_targets:[]});return {context,data,results,response};
}
test('read failure retries the original candidate and never erases its choice',async()=>{
 const f=fixture(),first=f.context.loadEntityMaterial(f.data,'m','c');f.results[0].reject(Error('offline'));await assert.rejects(first,/offline/);assert.equal(f.data.deferred_candidates[0],'c');assert.equal(f.data.requirements[0].version,4);
 const retry=f.context.loadEntityMaterial(f.data,'m','c');assert.equal(f.results[1].url,f.results[0].url);f.results[1].resolve(f.response());await retry;assert.equal(f.data.materialContexts.c.call.id,'call-original');
});
test('same-address source drift fails before merging any plan or candidate',async()=>{
 const f=fixture(),read=f.context.loadEntityMaterial(f.data,'m','c'),result=f.response();result.source_signature='changed';f.results[0].resolve(result);await assert.rejects(read,/已更新/);assert.equal(f.data.material_versions.m,undefined);assert.equal(f.data.deferred_materials[0],'m');
});
test('parallel identical reads share one request while different targets stay separate',async()=>{
 const f=fixture(),one=f.context.loadEntityMaterial(f.data,'m','current'),two=f.context.loadEntityMaterial(f.data,'m','current'),candidate=f.context.loadEntityMaterial(f.data,'m','c');assert.equal(one,two);assert.equal(f.results.length,2);f.results[1].resolve(f.response());await candidate;f.results[0].resolve(f.response());await one;assert.equal(f.data.requirements[0].payload.generation.prompt,'exact');
});
