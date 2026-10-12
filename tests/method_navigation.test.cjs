const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
class Node {
 constructor(tag,cls){this.tag=tag;this.className=cls;this.children=[];this.attrs={};this.dataset={};this.isConnected=false;this.style={setProperty(){}};this.classList={toggle:(k,on)=>{this.classes||=new Set();on?this.classes.add(k):this.classes.delete(k)},add:()=>{}}}
 connected(on){this.isConnected=on;for(const n of this.children)n.connected?.(on)}
 append(...nodes){for(let n of nodes){if(typeof n==='string'){const t=new Node('text');t.text=n;n=t}n.parent=this;this.children.push(n);n.connected?.(this.isConnected)}}
 replaceChildren(...nodes){for(const n of this.children)n.connected?.(false);this.children=[];this.text='';this.append(...nodes)}
 set textContent(t){this.replaceChildren();this.text=String(t)}get textContent(){return (this.text||'')+this.children.map(n=>n.textContent).join('')}
 setAttribute(k,v){this.attrs[k]=String(v)} getAttribute(k){return this.attrs[k]}
 get lastElementChild(){return this.children.at(-1)}
 all(){return this.children.flatMap(n=>[n,...n.all()])}
 querySelectorAll(s){return this.all().filter(n=>s.startsWith('#')?n.id===s.slice(1):n.tag===s)} querySelector(s){return this.querySelectorAll(s)[0]}
 remove(){this.parent.children=this.parent.children.filter(n=>n!==this);this.connected(false)} focus(){this.focused=true}
}
const skill=(id,type,version)=>({object_id:'method.skill.'+id,revision_id:id+version,version,payload:{format:'managed-method-skill-v1',title:id,purpose:id+' purpose',work_types:[type],files:{'SKILL.md':'exact '+id+version},resources:[]}});
const binding=(type,m)=>({object_id:'method.binding.'+type,revision_id:'binding-'+type,version:1,payload:{format:'managed-method-binding-v1',work_type:type,rules:[{object_id:m.object_id,revision_id:m.revision_id,when:{}}]}});
function setup(href='http://fixture/?workspace=project.configuration&config_section=METHODS'){
 const structure=skill('structure','story-structure',2),oldStructure=skill('structure','story-structure',1),video=skill('video','media-plan',3),unused=skill('old-comment','comment-polish',1),unknown=skill('future','future-work',1),bs=[binding('media-plan',video),binding('story-structure',oldStructure),binding('future-work',unknown)];
 const data={skill:[unused,video,unknown,structure],resource:[],binding:bs,condition_texts:{},referenced:Object.fromEntries([oldStructure,video,unknown].map(r=>[r.revision_id,r])),versions:{[structure.object_id]:[structure,oldStructure],[video.object_id]:[video],[unused.object_id]:[unused],[unknown.object_id]:[unknown]}};
 data.flow={stages:[{id:'source',title:'采编与方向',methods:[]},{id:'structure',title:'故事结构',methods:[{object_id:structure.object_id,title:'故事结构'}]},{id:'video',title:'视频方案',methods:[{object_id:video.object_id,title:'视频方案'}]}],branches:[]};
 const root=new Node('div');root.connected(true);const location={href},saved=new Map(),pending=[];let delay=false;
 const ctx={matchMedia:()=>({matches:false}),reviewURL:s=>s,toast(){},URL,URLSearchParams,Blob,state:{workspace:'project.configuration',configSection:'METHODS',comments:[]},fixtureData:data,location,history:{state:{},replaceState(s,t,u){location.href=String(u)}},window:{scrollY:0,addEventListener(){},scrollTo(x,y){this.scrollY=y}},sessionStorage:{getItem:k=>saved.get(k)||null,setItem:(k,v)=>saved.set(k,v)},localStorage:{getItem:()=>null},document:{createTextNode:t=>{const n=new Node('text');n.text=t;return n}},el:(t,c)=>new Node(t,c),nodeText:(t,c,text,p)=>{const n=new Node(t,c);n.textContent=text;p?.append(n);return n},hideSelectionAction(){},renderComments(){},reviewSurface(){},api(url){const q=new URL(url,'http://fixture'),oid=q.searchParams.get('object_id'),rid=q.searchParams.get('revision_id');const record=[...data.skill,...data.binding,...Object.values(data.referenced)].find(r=>r.object_id===oid&&(!rid||r.revision_id===rid));const versions=(data.versions[oid]||[]).map(r=>({version:r.version,kind:'text'}));
 const requested=Number(q.searchParams.get('version'));const exact=requested?(data.versions[oid]||[]).find(r=>r.version===requested):record;
 const result=q.pathname.endsWith('/files')?{record,files:Object.keys(record.payload.files).map(path=>({path,selected:{version:record.version},versions}))}:q.pathname.endsWith('/file')?{record:exact,file:q.searchParams.get('file'),present:true,content:'text',blocks:[],file_version:{version:exact.version},versions}:q.pathname==='/api/methods'?data:record;
 if(delay&&q.pathname.endsWith('/file'))return new Promise((resolve,reject)=>pending.push({url,resolve,reject,result}));return Promise.resolve(result)}};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../review_desk/static/methods.js'),'utf8')+'\nmethodView.data=fixtureData;renderMethodBlocks=()=>{};paintMethodComments=()=>{};',ctx);
 return {ctx,root,data,structure,oldStructure,video,unused,unknown,pending,delay(){delay=true},read:()=>vm.runInContext('({selected:methodView.selected,revision:methodView.revision,document:methodView.document,filters:methodView.filters})',ctx)};
}
const flush=()=>new Promise(r=>setImmediate(r));
test('first visit uses flow order and latest file; no tabs, authoring or fake source button',async()=>{
 const f=setup();await f.ctx.drawMethods(f.root);assert.equal(f.read().selected,f.structure.object_id);assert.equal(f.read().revision,'structure2');assert.equal(f.root.querySelectorAll('select').length,0);
 assert.equal(f.root.querySelectorAll('button').some(b=>b.textContent==='采编与方向'),false);assert.equal(f.root.querySelector('#method-tab-skill'),undefined);assert.doesNotMatch(f.root.textContent,/新建|执行配置|下载|old-comment/);
});
test('legacy exact links read their original file while ordinary node selection starts latest',async()=>{
 const f=setup('http://fixture/?method_category=skill&method_object=method.skill.old-comment&method_revision=old-comment1');await f.ctx.drawMethods(f.root);assert.equal(f.read().revision,'old-comment1');
 await f.ctx.methodSelectNode(f.root,f.structure.object_id);assert.equal(f.read().revision,'structure2');
});
test('a late file response cannot replace a newer exact file or selected node',async()=>{
 const f=setup();await f.ctx.drawMethods(f.root);f.delay();
 const a=f.ctx.methodOpen(f.root,'skill',f.video.object_id,'video3','SKILL.md');await flush();
 const b=f.ctx.methodOpen(f.root,'skill',f.structure.object_id,'structure1','SKILL.md');await flush();
 assert.equal(f.pending.length,2);f.pending[1].resolve(f.pending[1].result);await b;f.pending[0].resolve(f.pending[0].result);await a;
 assert.equal(f.read().document.record.revision_id,'structure1');
});
test('exact read failure keeps target and offers explicit retry without displaying another file',async()=>{
 const f=setup();await f.ctx.drawMethods(f.root);f.delay();const pending=f.ctx.methodOpen(f.root,'skill',f.structure.object_id,'structure1','SKILL.md');await flush();f.pending[0].reject(Error('exact file unavailable'));await pending;
 assert.equal(f.read().document,null);assert.match(f.root.textContent,/exact file unavailable.*重试准确文件/);assert.equal(new URL(f.ctx.location.href).searchParams.get('method_revision'),'structure1');
});
test('shared export links resolve only the exact indexed resource and retain its path',async()=>{
 const f=setup(),resource={object_id:'method.resource.review',revision_id:'exact-resource',payload:{files:{'skills/review/SKILL.md':'Body'},sections:{main:'skills/review/SKILL.md'}}};
 f.data.referenced[resource.revision_id]=resource;let opened;f.ctx.methodOpen=(...args)=>{opened=args;return Promise.resolve()};
 f.ctx.methodLink(f.root,{file:'SKILL.md',record:{payload:{files:{'SKILL.md':'entry'},resources:[{object_id:resource.object_id,revision_id:resource.revision_id,section:'main'}]}}},{text:'完整方法',href:'shared/0/skills/review/SKILL.md'},f.root);
 f.root.querySelector('a').onclick({preventDefault(){}});await flush();assert.deepEqual(opened.slice(1,5),['resource',resource.object_id,resource.revision_id,'skills/review/SKILL.md']);
});
test('comparison defaults previous against latest despite outer old version and never changes the reader',async()=>{
 const f=setup();await f.ctx.drawMethods(f.root);const before=f.read().document,body=new Node('div'),dialog=new Node('dialog');dialog.connected(true);body.connected(true);
 const requests=[];f.ctx.openReviewDialog=()=>({body,dialog});f.ctx.api=async url=>{const q=new URL(url,'http://fixture');requests.push(q);return {left:{content:'旧文\n'},right:{content:'新文\n'},equal:q.searchParams.get('left')===q.searchParams.get('right'),changes:[{type:'replace',left:['旧文\n'],right:['新文\n'],left_start:1,right_start:1}]}};
 await f.ctx.compareMethodFile({...before,file_version:{version:1},versions:[{version:3},{version:2},{version:1}]},null);
 assert.equal(requests[0].searchParams.get('left'),'2');assert.equal(requests[0].searchParams.get('right'),'3');assert.match(body.textContent,/旧文.*新文/);
 body.querySelectorAll('button').find(n=>n.textContent==='第 3 版').onclick();await flush();assert.match(body.textContent,/内容相同，无差异/);assert.equal(f.read().document,before);
});
test('method comment draft metadata is isolated by object, revision, file and browser page',()=>{
 const source=fs.readFileSync(require('node:path').join(__dirname,'../review_desk/static/app.js'),'utf8');
 const c={state:{workspace:'project.configuration',anchor:{file:'one.md',quote:'Original'},editing:null},methodView:{document:{record:{object_id:'method.skill.one',revision_id:'v1'},file:'one.md'}},isMethodsReading:()=>true,commentPageId:'page',localStorage:{getItem:()=>null,setItem(){}},markActiveCommentDraft(){},commentTarget(){return {target_object_id:c.methodView.document.record.object_id,target_revision_id:c.methodView.document.record.revision_id}}};
 vm.createContext(c);vm.runInContext(source.slice(source.indexOf('function storyDraftMetaKey()'),source.indexOf('function switchWorkspace(')),c);
 const first=c.storyDraftMetaKey();c.methodView.document.file='two.md';assert.notEqual(c.storyDraftMetaKey(),first);c.methodView.document.file='one.md';c.methodView.document.record.revision_id='v2';assert.notEqual(c.storyDraftMetaKey(),first);c.methodView.document.record.revision_id='v1';assert.equal(c.storyDraftMetaKey(),first);
});
test('opening an exact SVG file shows the diagram, keeps the original source anchor, and reports image failure without substitution',()=>{
 const f=setup(),source=fs.readFileSync(require('node:path').join(__dirname,'../review_desk/static/methods.js'),'utf8');
 vm.runInContext(source.slice(source.indexOf('function renderMethodBlocks('),source.indexOf('function paintMethodComments(')),f.ctx);
 const body='<svg xmlns="http://www.w3.org/2000/svg"><title>原准确图示</title><text>Original</text></svg>',doc={file:'book/diagram.svg',record:{payload:{files:{'book/diagram.svg':body,'book/other.svg':'<svg>Other</svg>'}}},blocks:[{id:'original-source'}]};
 f.ctx.renderMethodBlocks(f.root,doc,f.root);const picture=f.root.querySelector('img');
 assert.equal(decodeURIComponent(picture.src.split(',')[1]),body);assert.equal(picture.alt,'原准确图示');assert.equal(picture.parent.dataset.blockId,'original-source');assert.doesNotMatch(f.root.textContent,/<svg/);
 picture.onerror();assert.equal(f.root.querySelectorAll('img').length,0);assert.match(f.root.textContent,/准确图示无法显示.*未替换/);
});

test('a shared chapter stays embedded and its reader/comment identity belongs to the shared resource',async()=>{
 const f=setup(),resource={object_id:'method.resource.book',revision_id:'book1',version:1,payload:{files:{'chapter.md':'# 共享章节'},sections:{main:'chapter.md'}}};
 f.structure.payload.resources=[{object_id:resource.object_id,revision_id:resource.revision_id,section:'main'}];
 f.data.referenced[resource.revision_id]=resource;f.data.versions[resource.object_id]=[resource];
 await f.ctx.drawMethods(f.root);
 await f.ctx.methodOpen(f.root,'resource',resource.object_id,resource.revision_id,'chapter.md',true);
 assert.equal(f.read().document.record.object_id,resource.object_id);
 assert.equal(f.read().document.file,'chapter.md');
 assert.doesNotMatch(f.root.textContent,/返回原阅读位置/);
 assert.equal(new URL(f.ctx.location.href).searchParams.get('method_node'),f.structure.object_id);
 // A persisted stack from a previous interface must not reintroduce the guide.
 vm.runInContext('methodView.stack=[{selected:"old"}];methodView.rootRecord=null',f.ctx);
 await f.ctx.drawMethods(f.root);assert.doesNotMatch(f.root.textContent,/返回原阅读位置/);
});
