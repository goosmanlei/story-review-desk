const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const app=fs.readFileSync(path.join(__dirname,'../review_desk/static/app.js'),'utf8');
const structure=fs.readFileSync(path.join(__dirname,'../review_desk/static/structure.js'),'utf8');
// Actual response button, exact-revision locator and comment panel rendering.
// Image loading and physical scroll visibility remain real-browser acceptance.
class Element{
  constructor(tag='div'){this.tag=tag;this.children=[];this.dataset={};this.attrs={};this.className='';this.hidden=false;this.classList={add(){},remove(){},toggle(){}}}
  append(...nodes){for(const node of nodes){node.parent=this;this.children.push(node)}}
  replaceChildren(...nodes){this.children=[];this.append(...nodes)}
  setAttribute(key,value){this.attrs[key]=value}
  addEventListener(){}
  all(){return this.children.flatMap(node=>[node,...node.all()])}
  scrollIntoView(options){this.scrolled=options}
  matches(selector){
    if(selector.startsWith('#'))return this.id===selector.slice(1);
    if(selector.startsWith('.'))return selector.slice(1).split('.').every(cls=>this.className.split(' ').includes(cls));
    const data=selector.match(/^\[data-(structure-block|visual-id)="([^"]+)"\]$/);
    if(data)return this.dataset[data[1]==='structure-block'?'structureBlock':'visualId']===data[2];
    return this.tag===selector;
  }
  querySelectorAll(selector){return this.all().filter(node=>node.matches(selector))}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null}
}
function fixture({closed=false,missingRevision=false,invalid=false,missingAnchor=false}={}){
  const root=new Element('main'),nodes=new Map(),messages=[],pushes=[];
  for(const selector of ['#toast','#structure-status','#structure-index','#structure-reader','#structure-workspace .structure-layout','#comments-toggle','#comment-body','#comment-panel','#open-count','#screenplay-comments']){const node=new Element();if(selector.startsWith('#')&&!selector.includes(' '))node.id=selector.slice(1);nodes.set(selector,node);root.append(node)}
  nodes.get('#comment-panel').hidden=true;
  Object.defineProperty(nodes.get('#toast'),'textContent',{set:value=>messages.push(value),get:()=>messages.at(-1)||''});
  const comment={id:'original-comment',target_object_id:'story-structure',target_revision_id:'revision-old',anchor:{type:'region',visual_id:missingAnchor?'absent':'map',asset_file:'old-red.png',points:[{x:0,y:0},{x:1,y:0},{x:1,y:1}]},anchor_state:{valid:!invalid,reason:invalid?'原图已失效':null},status:closed?'CLOSED':'OPEN',body:'Exact old red image opinion',updated_at:'2026-01-01'};
  const revision=(id,version,file,responses=[])=>({id,version,created_at:'2026-01-01',payload:{title:id,direction_selection_revision:'selection',sections:[{id:'theme',title:'Theme',blocks:[],visuals:[{id:'map',file,title:'Map'}]}],responses}});
  const old=revision('revision-old',1,'old-red.png'),latest=revision('revision-new',2,'new-blue.png',[{comment_id:comment.id,explanation:'Technical response preserving the old original'}]);
  const context={URL,CSS:{escape:value=>value},console,location:{href:'http://fixture/?workspace=story.outline&structure_revision=revision-new'},history:{pushState(_state,_title,url){context.location.href=String(url);pushes.push(String(url))}},setTimeout:()=>0,clearTimeout(){},document:{addEventListener(){},querySelector:s=>nodes.get(s)||root.querySelector(s),querySelectorAll:s=>root.querySelectorAll(s),createElement:tag=>new Element(tag),createDocumentFragment:()=>new Element('fragment'),createTextNode:text=>{const node=new Element('text');node.textContent=text;return node}},window:{addEventListener(){}},getSelection:()=>({removeAllRanges(){}}),localStorage:{getItem:()=>null},fetch(){throw Error('this local reading action must not write or load another manuscript')}};
  vm.createContext(context);require('./load_review_helpers.cjs')(context);vm.runInContext(app,context);vm.runInContext(structure,context);vm.runInContext('globalThis.state=state;',context);
  Object.assign(context.state,{workspace:'story.outline',sources:[],structure:{selection:{id:'selection'},selection_history:[{id:'selection',payload:{source_id:'source',source_revision:'source-exact'}}],current_revision:latest.id,revisions:missingRevision?[latest]:[latest,old]},structureRevision:latest.id,comments:closed?[...Array.from({length:24},(_,i)=>({...comment,id:'closed-'+i})),comment]:[comment],historyOpen:false,historyLimit:20});
  context.hideSelectionAction=()=>{};context.reviewSurface=node=>node;context.watchStructureIndex=()=>{};context.paintStructureRegions=()=>{};
  context.renderStructureVisual=visual=>{const figure=new Element('figure');figure.dataset.visualId=visual.id;figure.file=visual.file;return figure};
  context.renderStructureReader();
  const button=root.all().find(node=>node.tag==='button'&&node.textContent==='查看原稿意见');assert.ok(button);
  return {context,root,nodes,messages,pushes,comment,button};
}
test('response entry selects the exact old visual, opens the existing panel and reveals its comment',()=>{
  const f=fixture(),before=JSON.stringify(f.context.state.comments);assert.equal(f.button.onclick(),true);
  assert.equal(f.context.state.structureRevision,'revision-old');assert.equal(f.context.state.selected,f.comment.id);assert.equal(new URL(f.context.location.href).searchParams.get('structure_revision'),'revision-old');
  assert.equal(f.nodes.get('#comment-panel').hidden,false);assert.equal(f.nodes.get('#comments-toggle').attrs['aria-expanded'],'true');
  const card=f.root.querySelector('#comment-original-comment');assert.ok(card);assert.equal(card.scrolled.block,'nearest');assert.ok(card.all().some(node=>node.textContent===f.comment.body));
  const visual=f.root.querySelector('[data-visual-id="map"]');assert.equal(visual.file,'old-red.png');assert.equal(visual.scrolled.block,'center');assert.equal(JSON.stringify(f.context.state.comments),before);
});
test('closed historical response beyond the initial limit uses the same history panel',()=>{
  const f=fixture({closed:true});assert.equal(f.button.onclick(),true);assert.equal(f.context.state.historyOpen,true);assert.equal(f.context.state.historyLimit,25);
  assert.equal(f.nodes.get('#comment-panel').hidden,false);assert.equal(f.root.querySelector('#comment-original-comment').scrolled.block,'nearest');assert.equal(f.context.state.comments.length,25);assert.ok(f.context.state.comments.every(comment=>comment.status==='CLOSED'));
});
test('unavailable original and invalid anchors retain their explanation without selecting the newer same-id visual',()=>{
  for(const options of [{missingRevision:true},{invalid:true}]){
    const f=fixture(options),before=JSON.stringify(f.context.state.comments);assert.equal(f.button.onclick(),false);
    assert.equal(f.context.state.structureRevision,'revision-new');assert.equal(f.context.state.selected,null);assert.equal(f.nodes.get('#comment-panel').hidden,true);assert.equal(f.pushes.length,0);
    assert.match(f.messages.at(-1),options.invalid?/原引用已失效.*原图已失效/:/原稿已不可用.*评论仍保留/);
    assert.ok(f.root.all().some(node=>(node.textContent||'').includes(f.comment.body)));assert.equal(f.root.querySelector('[data-visual-id="map"]').scrolled,undefined);assert.equal(JSON.stringify(f.context.state.comments),before);
  }
});
test('a missing visual keeps the accurate old revision and existing failure explanation',()=>{
  const f=fixture({missingAnchor:true});assert.equal(f.button.onclick(),false);assert.equal(f.context.state.structureRevision,'revision-old');assert.equal(f.nodes.get('#comment-panel').hidden,true);assert.match(f.messages.at(-1),/原引用已失效.*评论仍保留在原稿/);assert.equal(f.root.querySelector('[data-visual-id="map"]').scrolled,undefined);
});
