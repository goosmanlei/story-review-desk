const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
// Real editor renderer and polish callbacks; every HTTP response is a local
// technical stub. These tests never read credentials or invoke a model.
class Element{
 constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.attrs={};this.listeners={};this.className='';this.value='';this.classList={add(){},remove(){}}}
 append(...nodes){for(const n of nodes){n.parent=this;this.children.push(n)}}replaceChildren(...nodes){this.children=[];this.append(...nodes)}setAttribute(k,v){this.attrs[k]=v}addEventListener(k,fn){this.listeners[k]=fn}
 all(){return this.children.flatMap(n=>[n,...n.all()])}setSelectionRange(start,end,direction){this.selectionStart=start;this.selectionEnd=end;this.selectionDirection=direction}
 matches(s){if(s.startsWith('#'))return this.id===s.slice(1);if(s.startsWith('.'))return this.className.split(' ').includes(s.slice(1));if(s==='[data-polish]')return this.dataset.polish!==undefined;if(s==='[data-comment-submit]')return this.dataset.commentSubmit!==undefined;return this.tag===s}
 querySelectorAll(s){if(s==='.editor-actions button')return this.all().filter(n=>n.tag==='button'&&n.parent.className==='editor-actions');return this.all().filter(n=>n.matches(s))}querySelector(s){return this.querySelectorAll(s)[0]||null}
}
const preview={context:{creative_stage:{label:'Technical only'},story_background:'Fixture',creative_background:'Fixture',target_medium:'Fixture',audience:'Fixture',style:'Fixture',selected_quote:'Exact',neighbor_blocks:[],source_documents:[]},context_sha256:'mock-exact-context',saved:false};
const tick=()=>new Promise(done=>setImmediate(done));
function fixture(){
 const root=new Element('main'),storage=new Map(),pending=[],requests=[],messages=[];for(const id of ['comment-body','comment-panel','comments-toggle','screenplay-comments','open-count','toast']){const n=new Element('div');n.id=id;root.append(n)}Object.defineProperty(root.querySelector('#toast'),'textContent',{set:v=>messages.push(v)});
 const ctx={console,URL,setTimeout:()=>0,clearTimeout(){},document:{addEventListener(){},querySelector:s=>root.querySelector(s),createElement:t=>new Element(t),createTextNode:t=>{const n=new Element('text');n.textContent=t;return n}},localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,String(v)),removeItem:k=>storage.delete(k)},fetch:(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return new Promise(resolve=>pending.push((data,ok=true)=>resolve({ok,json:async()=>data})))} };
 vm.createContext(ctx);vm.runInContext(fs.readFileSync(process.env.POLISH_DRAFT_APP||path.join(__dirname,'../review_desk/static/app.js'),'utf8'),ctx);vm.runInContext('globalThis.state=state;globalThis.key=draftKey;',ctx);
 Object.assign(ctx.state,{workspace:'story.sources',current:{id:'source-a',target_revision_id:'source-rev'},anchor:{type:'text',block_id:'p',end_block_id:'p',start:0,end:5,quote:'Exact'}});storage.set(ctx.key(),'old durable text');ctx.renderComments();
 return {ctx,root,storage,pending,requests,messages,input:()=>root.querySelector('#comment-editor-text'),key:ctx.key()};
}
function failStorage(f){f.ctx.localStorage.setItem=()=>{throw Error('quota exceeded')}}
function edit(f,value){f.input().value=value;try{f.input().listeners.input()}catch{}}
for(const failure of ['set','get'])test(`${failure} failure cannot replace the live draft or its selection during comment repaint`,()=>{
 const f=fixture();if(failure==='set')failStorage(f);edit(f,'  only live opinion\n');f.input().setSelectionRange(3,9,'backward');
 if(failure==='get')f.ctx.localStorage.getItem=()=>{throw Error('read denied')};
 assert.doesNotThrow(()=>f.ctx.renderComments());assert.equal(f.input().value,'  only live opinion\n');
 assert.deepEqual([f.input().selectionStart,f.input().selectionEnd,f.input().selectionDirection],[3,9,'backward']);assert.equal(f.requests.length,0);
});
for(const failedKey of ['body','meta'])test(`${failedKey} write failure restores the exact source draft after leaving and returning`,()=>{
 const f=fixture(),original={...f.ctx.state.current},set=f.ctx.localStorage.setItem;
 f.ctx.localStorage.setItem=(key,value)=>{if(failedKey==='body'?key===f.key:key.startsWith('review-story-editor:'))throw Error('quota');set(key,value)};
 edit(f,'only original source input');f.ctx.rememberStoryDraft();f.ctx.state.current={id:'other',target_revision_id:'other-rev'};f.ctx.state.anchor=null;f.ctx.restoreStoryDraft();f.ctx.renderComments();assert.equal(f.input(),null);
 f.ctx.state.current=original;f.ctx.restoreStoryDraft();f.ctx.renderComments();assert.equal(f.input().value,'only original source input');assert.equal(f.requests.length,0);
});
test('a later successful input supersedes the failed-write fallback before leaving',()=>{
 const f=fixture(),set=f.ctx.localStorage.setItem,original={...f.ctx.state.current};failStorage(f);edit(f,'failed old');
 f.ctx.localStorage.setItem=set;edit(f,'durable newer');f.ctx.rememberStoryDraft();f.ctx.state.current={id:'B',target_revision_id:'B-rev'};f.ctx.state.anchor=null;f.ctx.renderComments();
 f.ctx.state.current=original;f.ctx.restoreStoryDraft();f.ctx.renderComments();assert.equal(f.input().value,'durable newer');assert.equal(f.storage.get(f.key),'durable newer');
});
for(const cancel of [false,true])test(`an older failed anchor cannot reclaim a newer ${cancel?'cancelled':'active'} draft on return`,()=>{
 const f=fixture(),set=f.ctx.localStorage.setItem,original={...f.ctx.state.current};failStorage(f);edit(f,'older anchor');f.ctx.rememberStoryDraft();
 f.ctx.localStorage.setItem=set;f.ctx.state.anchor={type:'global'};f.ctx.rememberStoryDraft();f.ctx.renderComments();edit(f,'newer anchor');
 if(cancel){f.ctx.renderDocument=()=>{};f.ctx.abandonDraft('cancelled')}
 f.ctx.state.current={id:'B',target_revision_id:'B-rev'};f.ctx.state.anchor=null;f.ctx.renderComments();
 f.ctx.state.current=original;f.ctx.restoreStoryDraft();f.ctx.renderComments();
 if(cancel)assert.equal(f.input(),null);else{assert.equal(f.ctx.state.anchor.type,'global');assert.equal(f.input().value,'newer anchor')}
});
test('failed-write source fallback never follows the same legacy key into another exact revision',()=>{
 const f=fixture(),original={...f.ctx.state.current};failStorage(f);edit(f,'unique old revision');f.ctx.rememberStoryDraft();
 f.ctx.state.current={...original,target_revision_id:'another-revision'};f.ctx.state.anchor=null;f.ctx.restoreStoryDraft();f.ctx.renderComments();assert.equal(f.input(),null);
 f.ctx.state.current=original;f.ctx.restoreStoryDraft();f.ctx.renderComments();assert.equal(f.input().value,'unique old revision');
});
test('successful cancellation removes a failed-write fallback and cannot revive it on the same anchor',()=>{
 const f=fixture(),anchor=f.ctx.state.anchor;failStorage(f);edit(f,'cancel me');f.ctx.renderDocument=()=>{};f.ctx.abandonDraft('cancelled');assert.equal(f.input(),null);
 f.ctx.state.anchor=anchor;f.ctx.renderComments();assert.equal(f.input().value,'');assert.equal(f.requests.length,0);
});
test('failed explicit suggestion apply retains original text and suggestion, then successful apply replaces the fallback',()=>{
 const f=fixture(),set=f.ctx.localStorage.setItem;failStorage(f);edit(f,'original unique input');f.ctx.state.suggestion='[MOCK] chosen suggestion';f.ctx.renderComments();
 const apply=()=>f.root.all().find(n=>n.tag==='button'&&n.textContent==='采用到草稿').onclick();apply();assert.equal(f.input().value,'original unique input');assert.equal(f.ctx.state.suggestion,'[MOCK] chosen suggestion');
 f.ctx.localStorage.setItem=set;apply();assert.equal(f.input().value,'[MOCK] chosen suggestion');assert.equal(f.ctx.state.suggestion,null);f.ctx.renderComments();assert.equal(f.input().value,'[MOCK] chosen suggestion');assert.equal(f.requests.length,0);
});
for(const success of [true,false])test(`storage failure before suggestion ${success?'success':'failure'} keeps the unique raw input and selection`,async()=>{
 const f=fixture();failStorage(f);edit(f,'  unique unsaved opinion  ');f.input().setSelectionRange(3,9,'backward');const p=f.ctx.polishComment();f.pending.shift()(preview);await tick();f.pending.shift()(success?{suggestion:'[MOCK] suggestion'}:{error:'[MOCK] failure'},success);await p;
 assert.equal(f.input().value,'  unique unsaved opinion  ');assert.equal(f.input().selectionStart,3);assert.equal(f.input().selectionEnd,9);assert.equal(f.input().selectionDirection,'backward');assert.equal(f.storage.get(f.key),'old durable text');assert.equal(f.requests[0].body.body,'unique unsaved opinion');assert.equal(f.requests[1].body.expected_context_sha256,preview.context_sha256);assert.equal(f.root.querySelector('[data-polish]').disabled,false);
});
test('reference context failure also preserves unique unsaved input',async()=>{const f=fixture();failStorage(f);edit(f,'not durable');const p=f.ctx.polishComment();f.pending.shift()({error:'[MOCK] context failure'},false);await p;assert.equal(f.input().value,'not durable');assert.equal(f.requests.length,1);assert.match(f.messages.at(-1),/context failure/)});
test('preview keeps raw whitespace instead of replacing it with the trimmed request',async()=>{const f=fixture();failStorage(f);edit(f,'  original wording\n');const p=f.ctx.previewPolish();f.pending.shift()(preview);await p;assert.equal(f.input().value,'  original wording\n');assert.equal(f.requests[0].body.body,'original wording');assert.equal(f.ctx.state.previewExpanded,true)});
for(const phase of ['context','suggestion'])test(`late ${phase} ignores a newer unique text`,async()=>{const f=fixture();edit(f,'first');const p=f.ctx.polishComment();if(phase==='suggestion'){f.pending.shift()(preview);await tick()}failStorage(f);edit(f,'later unique input');const input=f.input();f.pending.shift()(phase==='context'?preview:{suggestion:'[MOCK] obsolete'});await p;assert.equal(f.input(),input);assert.equal(f.input().value,'later unique input');assert.equal(f.ctx.state.suggestion,null);assert.equal(f.requests.length,phase==='context'?1:2)});
for(const method of ['polishComment','previewPolish'])test(`${method} rejects another exact revision even when source draftKey and body match`,async()=>{const f=fixture();edit(f,'same wording');const p=f.ctx[method]();f.ctx.state.current={...f.ctx.state.current,target_revision_id:'new-source-rev'};assert.equal(f.ctx.key(),f.key);f.pending.shift()(preview);await tick();if(f.pending.length)f.pending.shift()({suggestion:'[MOCK] stale revision result'});await p;assert.equal(f.ctx.state.preview,null);assert.equal(f.ctx.state.suggestion,null);assert.equal(f.requests.length,1);assert.equal(f.messages.length,0)});
test('late suggestion failure does not repaint another source editor',async()=>{const f=fixture();edit(f,'A');const p=f.ctx.polishComment();f.pending.shift()(preview);await tick();f.ctx.state.current={id:'B',target_revision_id:'B-rev'};f.storage.set(f.ctx.key(),'B unique draft');f.ctx.renderComments();const input=f.input();f.pending.shift()({error:'[MOCK] old failure'},false);await p;assert.equal(f.input(),input);assert.equal(f.input().value,'B unique draft');assert.equal(f.messages.length,0)});
test('whitespace edited during request survives a still-matching trimmed result',async()=>{const f=fixture();edit(f,'opinion');const p=f.ctx.polishComment();f.pending.shift()(preview);await tick();failStorage(f);edit(f,'\n opinion  ');f.pending.shift()({suggestion:'[MOCK] suggestion'});await p;assert.equal(f.input().value,'\n opinion  ');assert.equal(f.ctx.state.suggestion,'[MOCK] suggestion')});
test('technical suggestion changes the draft only on explicit apply and never submits a comment',async()=>{const f=fixture();edit(f,'user opinion');const p=f.ctx.polishComment();f.pending.shift()(preview);await tick();f.pending.shift()({suggestion:'[MOCK] proposed opinion'});await p;assert.equal(f.input().value,'user opinion');f.root.all().find(n=>n.tag==='button'&&n.textContent==='采用到草稿').onclick();assert.equal(f.input().value,'[MOCK] proposed opinion');assert.ok(f.requests.every(r=>r.url!=='/api/comments'));assert.equal(f.ctx.state.comments.length,0)});
test('storage failure does not interrupt input controls after an old polish request',async()=>{
 const f=fixture();edit(f,'old');const p=f.ctx.polishComment();f.pending.shift()(preview);await tick();failStorage(f);f.input().value='new unique input';
 assert.doesNotThrow(()=>f.input().listeners.input());assert.match(f.messages.at(-1),/本机草稿保存失败/);assert.equal(f.root.querySelector('[data-polish]').disabled,false);
 f.pending.shift()({suggestion:'[MOCK] obsolete'});await p;assert.equal(f.input().value,'new unique input');assert.equal(f.ctx.state.suggestion,null);assert.equal(f.root.querySelector('[data-polish]').disabled,false);
});
for(const success of [true,false])test(`old polish ${success?'success':'failure'} cannot unlock a newer request after storage failure`,async()=>{
 const f=fixture();edit(f,'old');const old=f.ctx.polishComment();f.pending.shift()(preview);await tick();const finishOld=f.pending.shift();failStorage(f);f.input().value='new';f.input().listeners.input();
 const current=f.ctx.polishComment();assert.equal(f.root.querySelector('[data-polish]').disabled,true);finishOld(success?{suggestion:'[MOCK] obsolete'}:{error:'[MOCK] obsolete'},success);await old;
 assert.equal(f.root.querySelector('[data-polish]').disabled,true);assert.equal(f.ctx.state.suggestion,null);f.pending.shift()(preview);await tick();f.pending.shift()({suggestion:'[MOCK] current'});await current;assert.equal(f.ctx.state.suggestion,'[MOCK] current');assert.equal(f.input().value,'new');assert.equal(f.root.querySelector('[data-polish]').disabled,false);
});
test('inspected snapshot is reused for submit and changed server context preserves the opinion',async()=>{
 const f=fixture();edit(f,'user opinion');const inspect=f.ctx.previewPolish();f.pending.shift()(preview);await inspect;
 const run=f.ctx.polishComment();assert.equal(f.requests.length,2);assert.equal(f.requests[1].url,'/api/comments/polish');assert.equal(f.requests[1].body.expected_context_sha256,preview.context_sha256);
 f.pending.shift()({error:'[MOCK] 上下文已变化'},false);await run;assert.equal(f.input().value,'user opinion');assert.equal(f.ctx.state.suggestion,null);
});
test('adopting a local mocked suggestion invalidates the old reference snapshot',async()=>{
 const f=fixture();edit(f,'user opinion');const inspect=f.ctx.previewPolish();f.pending.shift()(preview);await inspect;f.ctx.state.suggestion='[MOCK] new opinion';f.ctx.renderComments();
 f.root.all().find(n=>n.tag==='button'&&n.textContent==='采用到草稿').onclick();assert.equal(f.ctx.state.preview,null);
 const run=f.ctx.polishComment();assert.equal(f.requests.at(-1).url,'/api/comments/polish-context');f.pending.shift()(preview);await tick();f.pending.shift()({suggestion:'[MOCK] next'});await run;
});
