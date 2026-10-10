const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
// DOM and controlled promises exercise production callbacks; real pixels,
// browser modal stacking and scroll restoration are checked in the instance.
class Node{
 constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.attrs={};this.events={};this.hidden=false;this.open=false;this.isConnected=true;this.classList={add(){}}}
 append(...items){for(const item of items){item.parent=this;this.children.push(item)}}
 replaceChildren(){this.children=[];this.text=''}
 set textContent(v){this.text=String(v);this.children=[]}get textContent(){return (this.text||'')+this.children.map(n=>n.textContent).join('')}
 setAttribute(k,v){this.attrs[k]=String(v)}getAttribute(k){return this.attrs[k]}
 addEventListener(k,fn){this.events[k]=fn}
 all(){return this.children.flatMap(n=>[n,...n.all()])}
 querySelector(s){return this.all().find(n=>s[0]==='.'?n.className===s.slice(1):n.tag===s)||null}
 querySelectorAll(s){return this.all().filter(n=>n.tag===s)}
 click(){return this.onclick?.()}focus(){this.focused=true}scrollIntoView(){}
 showModal(){this.open=true}close(){this.open=false;this.events.close?.()}remove(){this.isConnected=false}
}
function setup(){
 const body=new Node('body'),pending=[],zooms=[];
 const ctx={URLSearchParams,state:{workspace:'story.outline',structureRevision:'current',comments:[]},isStructure:()=>ctx.state.workspace==='story.outline',commentChanges:new Set(),anchorLabel:()=>'',changeComment:()=>assert.fail('reading must not write'),reviewURL:x=>x,
 document:{body,createElement:t=>new Node(t),createTextNode:t=>{const n=new Node('text');n.text=t;return n},createElementNS:(_ns,t)=>new Node(t)},
 el:(t,c)=>{const n=new Node(t);n.className=c;return n},nodeText:(t,c,text,parent)=>{const n=ctx.el(t,c);n.textContent=text;parent?.append(n);return n},structureBlocks:d=>d.sections.flatMap(s=>[{id:'heading-'+s.id,text:s.title},...s.blocks]),structureVisuals:d=>d.sections.flatMap(s=>s.visuals||[]),openStructureImage:(v,n)=>zooms.push({v,n}),api:url=>new Promise((resolve,reject)=>pending.push({url,resolve,reject}))};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../review_desk/static/comment-review.js'),'utf8'),ctx);
 return {ctx,body,pending,zooms};
}
const record={kind:'STRUCTURE',payload:{sections:[{id:'a',title:'Chapter A',blocks:[{id:'b',text:'Exact old manuscript 🙂'}],visuals:[{id:'v',file:'old.png',title:'Old image',description:'Exact caption'}]},{id:'c',title:'Chapter C',blocks:[{id:'d',text:'Final text'}],visuals:[]}]}};
const row=id=>({original:{object_id:'story-structure',revision_id:'old',version:1},comment:{id,business_code:id,status:'OPEN',body:'Original opinion',anchor:{type:'visual',visual_id:'v',asset_file:'old.png'}},responses:[{response:{object_id:'story-structure',revision_id:'response',version:2},explanation:'Original response'}],current_evidence:[]});
const button=(root,text)=>root.all().find(n=>n.tag==='button'&&n.textContent===text);
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('unanchored whole manuscript shows sections, text, original image and caption once, with existing zoom',()=>{
 const f=setup(),root=new Node('div');f.ctx.renderCommentReviewContent(root,record,null);
 assert.deepEqual(root.querySelectorAll('h4').map(n=>n.textContent),['Chapter A','Chapter C']);assert.equal(root.querySelectorAll('img').length,1);assert.equal(root.querySelectorAll('details').length,0);
 assert.equal(root.textContent.split('Exact old manuscript 🙂').length,2);assert.match(root.textContent,/Exact caption/);
 const img=root.querySelector('img');assert.equal(img.src,'/assets/old.png');img.click();img.onkeydown({key:'Enter',preventDefault(){}});assert.equal(f.zooms.length,2);assert.equal(f.zooms[0].v.file,'old.png');
 img.events.error();img.click();assert.equal(f.zooms.length,2);assert.equal(img.getAttribute('aria-disabled'),'true');assert.match(root.textContent,/准确原图文件不可用/);
});
test('anchored excerpt and whole manuscript do not display duplicate batches; repeated toggles do not append again',()=>{
 const f=setup(),root=new Node('div');f.ctx.renderCommentReviewContent(root,record,{type:'visual',visual_id:'v',asset_file:'old.png'});
 const focus=root.querySelector('.comment-review-exact'),full=root.querySelector('details');assert.equal(focus.querySelectorAll('img').length,1);assert.equal(full.querySelectorAll('img').length,0);
 full.open=true;full.events.toggle();assert.equal(focus.hidden,true);assert.equal(full.querySelectorAll('img').length,1);full.events.toggle();assert.equal(full.querySelectorAll('img').length,1);
 full.open=false;full.events.toggle();assert.equal(focus.hidden,false);
});
test('pure text and source images remain readable; invalid local image never falls back',()=>{
 const f=setup(),root=new Node('div'),source={kind:'SOURCE',payload:{blocks:[{id:'a',text:'Pure text 🙂'}],assets:[]}};
 f.ctx.renderCommentReviewContent(root,source,null);assert.equal(root.textContent,'Pure text 🙂');assert.equal(root.querySelectorAll('img').length,0);
 root.replaceChildren();source.payload.assets=[{file:'source.png',title:'Source',note:'Original note'}];f.ctx.renderCommentReviewContent(root,source,null);assert.match(root.textContent,/Original note/);assert.equal(root.querySelector('img').src,'/assets/source.png');
 root.replaceChildren();f.ctx.renderCommentReviewContent(root,record,{type:'visual',visual_id:'missing',asset_file:'old.png'});assert.match(root.textContent,/准确原图已不可用/);assert.equal(root.querySelectorAll('img').length,0);
});
for(const failure of [false,true])test(`late ${failure?'failure':'success'} cannot replace another step, opinion, reopened dialog or manuscript`,async()=>{
 for(const action of ['step','opinion','reopen','manuscript']){
  const f=setup();const opened=f.ctx.openCommentReview(row('one'),{object_id:'story-structure',version:10},new Node('button'));const first=f.pending[0];const dialog=f.body.children.at(-1);
  if(action==='step')button(dialog,'作者回应 · 结构第 2 稿').click();
  if(action==='opinion')f.ctx.openCommentReview(row('two'),{version:10},new Node('button'));
  if(action==='reopen'){dialog.close();f.ctx.openCommentReview(row('one'),{version:10},new Node('button'))}
  if(action==='manuscript')f.ctx.state.structureRevision='another';
  failure?first.reject(Error('late failure')):first.resolve({record});await opened;await tick();
  const current=f.body.children.at(-1);assert.doesNotMatch(current.querySelector('.comment-review-body').textContent,/late failure|Exact old manuscript/);
  if(action==='step')assert.match(current.textContent,/Original response/);
 }
});
test('current read failure is visible and exact URL never requests latest',async()=>{
 const f=setup(),opening=f.ctx.openCommentReview(row('one'),{version:10},new Node('button'));
 assert.match(f.pending[0].url,/revision_id=old/);assert.doesNotMatch(f.pending[0].url,/latest/);f.pending[0].reject(Error('Exact target unavailable'));await opening;
 assert.match(f.body.children.at(-1).textContent,/Exact target unavailable/);
});

test('legacy production text anchors highlight the exact original quotation without changing the stored anchor',()=>{
 const f=setup(),root=new Node('div'),anchor={block_id:'p',end_block_id:'p',start:2,end:4,quote:'范围'};
 f.ctx.renderCommentReviewContent(root,{kind:'REQUIREMENT',payload:{format:'production-requirement-v1',components:[]},review_blocks:[{id:'p',text:'起止范围说明'}]},anchor);
 assert.equal(root.querySelector('mark').textContent,'范围');assert.equal(anchor.type,undefined);
});
