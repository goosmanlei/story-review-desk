const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
class Node {
 constructor(tag,cls){this.tag=tag;this.className=cls;this.children=[];this.attrs={};this.dataset={};this.isConnected=false;this.classList={toggle:(k,on)=>{this.classes||=new Set();on?this.classes.add(k):this.classes.delete(k)},add:()=>{}}}
 connected(on){this.isConnected=on;for(const n of this.children)n.connected?.(on)}
 append(...nodes){for(let n of nodes){if(typeof n==='string'){const t=new Node('text');t.text=n;n=t}n.parent=this;this.children.push(n);n.connected?.(this.isConnected)}}
 replaceChildren(...nodes){for(const n of this.children)n.connected?.(false);this.children=[];this.text='';this.append(...nodes)}
 set textContent(t){this.replaceChildren();this.text=String(t)}get textContent(){return (this.text||'')+this.children.map(n=>n.textContent).join('')}
 setAttribute(k,v){this.attrs[k]=String(v)} getAttribute(k){return this.attrs[k]}
 all(){return this.children.flatMap(n=>[n,...n.all()])}
 querySelectorAll(s){return this.all().filter(n=>s.startsWith('#')?n.id===s.slice(1):n.tag===s)} querySelector(s){return this.querySelectorAll(s)[0]}
 remove(){this.parent.children=this.parent.children.filter(n=>n!==this);this.connected(false)} focus(){this.focused=true}
}
const skill=(id,type,version)=>({object_id:'method.skill.'+id,revision_id:id+version,version,payload:{format:'managed-method-skill-v1',title:id,purpose:id+' purpose',work_types:[type],files:{'SKILL.md':'exact '+id+version},resources:[]}});
const binding=(type,m)=>({object_id:'method.binding.'+type,revision_id:'binding-'+type,version:1,payload:{format:'managed-method-binding-v1',work_type:type,rules:[{object_id:m.object_id,revision_id:m.revision_id,when:{}}]}});
function setup(href='http://fixture/?workspace=project.configuration&config_section=METHODS'){
 const structure=skill('structure','story-structure',2),oldStructure=skill('structure','story-structure',1),video=skill('video','media-plan',3),unused=skill('old-comment','comment-polish',1),unknown=skill('future','future-work',1),bs=[binding('media-plan',video),binding('story-structure',oldStructure),binding('future-work',unknown)];
 const data={skill:[unused,video,unknown,structure],resource:[],binding:bs,condition_texts:{},referenced:Object.fromEntries([oldStructure,video,unknown].map(r=>[r.revision_id,r])),versions:{[structure.object_id]:[structure,oldStructure],[video.object_id]:[video],[unused.object_id]:[unused],[unknown.object_id]:[unknown]}};
 const root=new Node('div');root.connected(true);const location={href},saved=new Map(),pending=[];let delay=false;
 const ctx={URL,URLSearchParams,Blob,state:{workspace:'project.configuration',configSection:'METHODS',comments:[]},fixtureData:data,location,history:{state:{},replaceState(s,t,u){location.href=String(u)}},window:{scrollY:0,addEventListener(){},scrollTo(x,y){this.scrollY=y}},sessionStorage:{getItem:k=>saved.get(k)||null,setItem:(k,v)=>saved.set(k,v)},localStorage:{getItem:()=>null},document:{createTextNode:t=>{const n=new Node('text');n.text=t;return n}},el:(t,c)=>new Node(t,c),nodeText:(t,c,text,p)=>{const n=new Node(t,c);n.textContent=text;p?.append(n);return n},hideSelectionAction(){},renderComments(){},reviewSurface(){},api(url){const q=new URL(url,'http://fixture'),oid=q.searchParams.get('object_id'),rid=q.searchParams.get('revision_id');const record=[...data.skill,...data.binding,...Object.values(data.referenced)].find(r=>r.object_id===oid&&(!rid||r.revision_id===rid));const result=q.pathname.endsWith('document')?{record,file:q.searchParams.get('file'),blocks:[]}:record;if(delay)return new Promise((resolve,reject)=>pending.push({url,resolve,reject,result}));return Promise.resolve(result)}};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../review_desk/static/methods.js'),'utf8')+'\nmethodView.data=fixtureData;renderMethodBlocks=()=>{};paintMethodComments=()=>{};',ctx);
 return {ctx,root,data,structure,oldStructure,video,unused,unknown,pending,delay(){delay=true},read:()=>vm.runInContext('({selected:methodView.selected,revision:methodView.revision,document:methodView.document,filters:methodView.filters})',ctx)};
}
const flush=()=>new Promise(r=>setImmediate(r));
test('first visit uses business order and the actually bound revision, not the newest or an unbound legacy method',async()=>{
 const f=setup();await f.ctx.drawMethods(f.root);assert.equal(f.read().selected,f.structure.object_id);assert.equal(f.read().revision,'structure1');assert.doesNotMatch(f.root.textContent,/old-comment purpose/);assert.match(f.root.textContent,/第 2 版/);assert.equal(f.root.querySelectorAll('select').length,0);
 assert.equal(f.root.querySelector('#method-tab-skill').attrs['aria-selected'],'true');assert.equal(f.root.querySelector('#method-tab-resource').tabIndex,-1);assert.equal(f.root.querySelector('#method-panel-skill').attrs.role,'tabpanel');
});
test('legacy deep links override active filtering; unknown work types remain visible under other',async()=>{
 const f=setup('http://fixture/?method_category=skill&method_object=method.skill.old-comment&method_revision=old-comment1');await f.ctx.drawMethods(f.root);assert.equal(f.read().selected,f.unused.object_id);assert.equal(f.read().filters.skill.range,'all');
 vm.runInContext('methodFilter().group="other";methodFilter().range="active"',f.ctx);assert.deepEqual(Array.from(f.ctx.methodRows(),r=>r.object_id),[f.unknown.object_id]);
});
test('keyboard tab switches read existing bindings and expose rules without entering a new configuration form',async()=>{
 const f=setup();await f.ctx.drawMethods(f.root);let prevented=false;f.root.querySelector('#method-tab-skill').onkeydown({key:'End',preventDefault(){prevented=true}});await flush();assert.equal(prevented,true);assert.equal(f.root.querySelector('#method-tab-binding').focused,true);assert.match(f.root.textContent,/故事结构/);assert.equal(f.root.querySelectorAll('form').length,0);assert.equal(f.root.querySelectorAll('select').length,0);
});
test('a delayed exact read cannot replace a newer exact selection',async()=>{
 const f=setup();await f.ctx.drawMethods(f.root);f.delay();const a=f.ctx.methodOpen(f.root,'skill',f.video.object_id,'video3','SKILL.md');const b=f.ctx.methodOpen(f.root,'skill',f.structure.object_id,'structure1','SKILL.md');f.pending[1].resolve(f.pending[1].result);await flush();f.pending[2].resolve(f.pending[2].result);await b;f.pending[0].resolve(f.pending[0].result);await a;assert.equal(f.read().document.record.revision_id,'structure1');assert.doesNotMatch(f.root.textContent,/video purpose.*正文版本/);
});
test('method comment draft metadata is isolated by object, revision, file and browser page',()=>{
 const source=fs.readFileSync(require('node:path').join(__dirname,'../review_desk/static/app.js'),'utf8');
 const c={state:{workspace:'project.configuration',anchor:{file:'one.md',quote:'Original'},editing:null},methodView:{document:{record:{object_id:'method.skill.one',revision_id:'v1'},file:'one.md'}},isMethodsReading:()=>true,commentPageId:'page',localStorage:{getItem:()=>null,setItem(){}},markActiveCommentDraft(){},commentTarget(){return {target_object_id:c.methodView.document.record.object_id,target_revision_id:c.methodView.document.record.revision_id}}};
 vm.createContext(c);vm.runInContext(source.slice(source.indexOf('function storyDraftMetaKey()'),source.indexOf('function switchWorkspace(')),c);
 const first=c.storyDraftMetaKey();c.methodView.document.file='two.md';assert.notEqual(c.storyDraftMetaKey(),first);c.methodView.document.file='one.md';c.methodView.document.record.revision_id='v2';assert.notEqual(c.storyDraftMetaKey(),first);c.methodView.document.record.revision_id='v1';assert.equal(c.storyDraftMetaKey(),first);
});
