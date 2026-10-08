const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../review_desk/static/app.js'),'utf8').split('const state=')[0];
function storage(){const map=new Map();return {map,get length(){return map.size},key:i=>[...map.keys()][i],getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,String(v)),removeItem:k=>map.delete(k)}}
function page(publication,local,session,base='/lijizhanshe'){const requests=[],context={REVIEW_DEPLOYMENT:{base_path:base,publication_id:publication},localStorage:local,sessionStorage:session,location:{reload(){context.reloaded=true}},fetch:async(url,options)=>{requests.push({url,options});return {status:200}}};vm.createContext(context);vm.runInContext(source,context);return {...context,context,requests}}
test('new publication removes old persistence only for this environment; an old open tab cannot use it',()=>{
 const local=storage(),session=storage();local.setItem('review-draft:formal','keep');
 const first=page('first',local,session);vm.runInContext("localStorage.setItem('review-draft:example','old draft');sessionStorage.setItem('review-view-position','old selection')",first.context);
 const other=page('first',local,session,'/other');vm.runInContext("localStorage.setItem('review-draft:example','other')",other.context);
 const second=page('second',local,session);
 assert.equal(vm.runInContext("localStorage.getItem('review-draft:example')",second.context),null);
 assert.equal(vm.runInContext("sessionStorage.getItem('review-view-position')",second.context),null);
 assert.equal(local.getItem('review-draft:formal'),'keep');assert.equal(vm.runInContext("localStorage.getItem('review-draft:example')",other.context),'other');
 assert.ok(![...local.map.keys(),...session.map.keys()].some(k=>k.startsWith('review-env:%2Flijizhanshe:first:')));
 assert.throws(()=>vm.runInContext("localStorage.getItem('review-draft:example')",first.context),/体验版本已更新/);assert.equal(first.context.reloaded,true);
 vm.runInContext("localStorage.setItem('review-draft:example','current')",second.context);assert.equal(vm.runInContext("localStorage.getItem('review-draft:example')",page('second',local,session).context),'current');
});
test('requests and local resources use the prefix once, with an exact publication header',async()=>{
 const p=page('second',storage(),storage());
 for(const [input,expected] of [['/api/instance','/lijizhanshe/api/instance'],['/lijizhanshe/assets/x','/lijizhanshe/assets/x'],['https://example.org/x','https://example.org/x'],['blob:123','blob:123'],['//example.org/x','//example.org/x']])assert.equal(p.context.reviewURL(input),expected);
 await p.context.reviewFetch('/api/comments',{method:'POST'});assert.equal(p.requests[0].url,'/lijizhanshe/api/comments');assert.equal(p.requests[0].options.headers['X-Review-Publication'],'second');
 const root=page('',storage(),storage(),'');assert.equal(root.context.reviewURL('/assets/x'),'/assets/x');
});
