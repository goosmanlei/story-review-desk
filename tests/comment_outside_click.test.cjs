const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');

// Exercise the actual init listeners, closePanel and startDraft in DOM event
// order. Browser hit testing and geometry still require browser acceptance.
class Element{
  constructor(tag='div'){this.tagName=tag.toUpperCase();this.className='';this.dataset={};this.attrs={};this.children=[];this.listeners={};this.hidden=false;this.textContent='';this.value=''}
  append(...children){for(const child of children){child.remove();child.parentNode=this;this.children.push(child)}}
  remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(n=>n!==this);this.parentNode=null}
  insertBefore(child,next){this.append(child);if(next){this.children.pop();this.children.splice(this.children.indexOf(next),0,child)}}
  get isConnected(){return this.tagName==='BODY'||!!this.parentNode?.isConnected}
  get ownerDocument(){return this.document||this.parentNode?.ownerDocument}
  contains(node){for(;node;node=node.parentNode)if(node===this)return true;return false}
  matches(selector){
    if(selector.includes(','))return selector.split(',').some(s=>this.matches(s.trim()));
    if(selector.startsWith('.'))return selector.slice(1).split('.').every(c=>this.className.split(' ').includes(c));
    if(selector.startsWith('#'))return this.id===selector.slice(1);
    const block=selector.match(/^\[data-block-id="(.*)"\]$/);if(block)return this.dataset.blockId===block[1];
    if(selector==='[data-review-dialog-trigger]')return Object.hasOwn(this.dataset,'reviewDialogTrigger');
    return this.tagName===selector.toUpperCase();
  }
  closest(selectors){for(let node=this;node;node=node.parentNode)if(selectors.split(',').some(s=>node.matches(s)))return node;return null}
  setAttribute(key,value){this.attrs[key]=String(value)}
  getAttribute(key){return this.attrs[key]}
  get classList(){return {add:(...names)=>{this.className=[...new Set([...this.className.split(' ').filter(Boolean),...names])].join(' ')},remove:(...names)=>{this.className=this.className.split(' ').filter(name=>!names.includes(name)).join(' ')}}}
  querySelectorAll(selector){return this.children.flatMap(n=>[...(n.matches(selector)?[n]:[]),...n.querySelectorAll(selector)])}
  querySelector(selector){return selector.startsWith(':scope > ')?this.children.find(n=>n.matches(selector.slice(9)))||null:this.querySelectorAll(selector)[0]||null}
  getBoundingClientRect(){return {top:100,bottom:500,left:0,width:400,height:400}}
  getClientRects(){for(let n=this;n;n=n.parentNode)if(n.hidden)return [];return this.isConnected?[this.getBoundingClientRect()]:[]}
  addEventListener(type,listener,options){(this.listeners[type]??=[]).push({listener,capture:options===true||!!options?.capture})}
  focus(options){this.focused=true;this.focusOptions=options;if(this.ownerDocument)this.ownerDocument.activeElement=this}
}

async function fixture(){
  const nodes=new Map(),listeners={},storage=new Map(),renders=[],body=new Element('body');
  const node=selector=>{if(!nodes.has(selector)){const value=new Element();body.append(value);nodes.set(selector,value)}return nodes.get(selector)};
  const c={URL,URLSearchParams,console,setTimeout:()=>0,clearTimeout(){},CSS:{escape:x=>x},
    location:{href:'http://fixture/?workspace=story.sources&source=source'},
    window:{innerWidth:1024,innerHeight:800,addEventListener(){}},Node:{TEXT_NODE:3},getSelection:()=>({removeAllRanges(){}}),
    document:{body,activeElement:null,querySelector:node,querySelectorAll:()=>[],
      createElement:tag=>new Element(tag),
      addEventListener(type,listener,options){(listeners[type]??=[]).push({listener,capture:options===true||!!options?.capture})}},
    localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,String(value)),removeItem:key=>storage.delete(key)}};
  body.document=c.document;
  const source={id:'source',target_revision_id:'source-r1',blocks:[{id:'paragraph',text:'Exact original'}]};
  const responses={'/api/business-codes':{objects:[],types:[]},'/api/instance':{title:'Fixture'},'/api/sources?with_revision=1':[source],'/api/comments':[],
    '/api/framework':{},'/api/configurations':{},'/api/story-structure':{current_revision:null},
    '/api/screenplays':{versions:[]},'/api/screenplay-summaries':{episodes:[]}};
  c.fetch=async url=>{assert.ok(Object.hasOwn(responses,url),url);return {ok:true,json:async()=>responses[url]}};
  vm.createContext(c);require('./load_review_helpers.cjs')(c);vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static/app.js'),'utf8'),c,{filename:'app.js'});
  // Keep event/draft behavior real; unrelated page rendering and selection
  // observers are outside this fixture's small DOM.
  vm.runInContext(`globalThis.state=state;globalThis.draftKeyNow=draftKey;
    applyFavicon=()=>{};resolveStructureRevision=()=>null;
    chooseSource=()=>{state.current=state.sources[0]};chooseScript=()=>{};
    switchWorkspace=workspace=>{state.workspace=workspace};restoreSourceChapter=()=>{};
    renderDocument=()=>{};watchTextSelection=()=>{};scheduleSourceChapter=()=>{};`,c);
  c.renderComments=()=>renders.push({anchor:c.state.anchor,hidden:node('#comment-panel').hidden});
  await c.init();assert.doesNotMatch(node('#source-view').textContent,/^加载失败/);
  assert.ok((listeners.click||[]).length,'init registered its real outside-click listener');
  const panel=node('#comment-panel');panel.hidden=false;
  function dispatch(type,target,extra={}){
    const event={type,target,detail:1,button:0,pointerId:1,defaultPrevented:false,stopped:false,
      preventDefault(){this.defaultPrevented=true},stopPropagation(){this.stopped=true},...extra};
    for(const item of listeners[type]||[])if(item.capture)item.listener(event);
    for(let current=target;current&&!event.stopped;current=current.parentNode){
      if(typeof current['on'+type]==='function')current['on'+type](event);
      for(const item of current.listeners[type]||[])if(!item.capture)item.listener(event);
    }
    if(!event.stopped)for(const item of listeners[type]||[])if(!item.capture)item.listener(event);
    return event;
  }
  const outside=new Element('button');body.append(outside);
  return {c,node,body,panel,outside,dispatch,storage,renders};
}

async function dialogFixture(width=1024){
  const f=await fixture();f.c.window.innerWidth=width;
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static/unified-cards.js'),'utf8'),f.c,{filename:'unified-cards.js'});
  const dialog=new Element('dialog'),body=new Element(),card=new Element(),context=new Element(),material=new Element(),paragraph=new Element('p'),media=new Element('video'),trigger=new Element('button'),close=new Element('button');
  dialog.className='unified-card-dialog';body.className='review-dialog-body';card.className='unified-card';context.className='unified-card-context';material.className='unified-card-material';close.className='review-dialog-close';
  paragraph.dataset.blockId='original-block';paragraph.textContent='Exact historical paragraph';
  media.src='/api/production/files/exact-original.mp4';media.currentTime=7.25;
  context.append(paragraph,trigger);material.append(media);card.append(context,material);body.append(card);dialog.append(close,body,f.panel);f.body.append(dialog);
  f.panel.append(f.node('#comments-close'),f.node('#comment-editor-text'));f.panel.hidden=true;body.scrollTop=120;material.scrollTop=200;
  return {...f,dialog,reader:body,card,context,material,paragraph,media,trigger,dialogClose:close};
}

test('outside pointerdown leaves layout intact; click capture closes before the original target opens its new draft',async()=>{
  const f=await fixture(),anchor={type:'global'},order=[];
  f.outside.onclick=event=>{order.push(['target',f.panel.hidden,event.defaultPrevented]);f.c.startDraft(anchor)};
  f.dispatch('pointerdown',f.outside);
  assert.equal(f.panel.hidden,false,'pointerdown must not reflow the reader before click hit testing');
  const event=f.dispatch('click',f.outside);
  assert.deepEqual(order,[['target',true,false]],'outside close happens in capture without consuming the target action');
  assert.equal(event.stopped,false);assert.equal(f.panel.hidden,false);assert.equal(f.c.state.anchor,anchor);
});

test('a region draft opened on pointerup survives its trailing click and keeps exact draft metadata',async()=>{
  const f=await fixture(),region=new Element('svg');f.body.append(region);
  const anchor={type:'region',visual_id:'original.png',asset_file:'original.png',points:[{x:.1,y:.2},{x:.6,y:.2},{x:.6,y:.7}]};
  region.onpointerup=()=>{f.c.startDraft(anchor);f.storage.set(f.c.draftKeyNow(),'new region opinion')};
  f.dispatch('pointerdown',region);f.dispatch('pointerup',region);
  const key=f.c.draftKeyNow(),metadata=[...f.storage.entries()];
  f.dispatch('click',region);
  assert.equal(f.panel.hidden,false);assert.equal(f.c.state.anchor,anchor);assert.equal(f.c.draftKeyNow(),key);
  assert.deepEqual([...f.storage.entries()],metadata);assert.equal(f.storage.get(key),'new region opinion');
  // The exception belongs to that pointer sequence, not every later outside click.
  f.dispatch('pointerdown',f.outside);f.dispatch('click',f.outside);
  assert.equal(f.panel.hidden,true);assert.equal(f.storage.get(key),'new region opinion');
});

test('keyboard click ignores stale pointer state and still lets its target start a draft',async()=>{
  const f=await fixture(),first={type:'global'},next={type:'text',block_id:'paragraph',start:0,end:5,quote:'Exact'};
  f.dispatch('pointerdown',f.outside);f.c.startDraft(first);
  let targetSawHidden;
  f.outside.onclick=event=>{targetSawHidden=f.panel.hidden;assert.equal(event.defaultPrevented,false);f.c.startDraft(next)};
  f.dispatch('click',f.outside,{detail:0});
  assert.equal(targetSawHidden,true,'keyboard activation is not a trailing pointer click');
  assert.equal(f.panel.hidden,false);assert.equal(f.c.state.anchor,next);
});

for(const kind of ['dialog','review-cue','material-reference','marked-trigger'])test(`${kind} descendant keeps the outer comments open through pointerdown and click`,async()=>{
  const f=await fixture(),parent=new Element(kind==='dialog'?'dialog':'button'),child=new Element('span');
  if(kind==='marked-trigger')parent.dataset.reviewDialogTrigger='';else if(kind!=='dialog')parent.className=kind;
  parent.append(child);f.body.append(parent);
  const anchor={type:'global'};f.c.startDraft(anchor);const key=f.c.draftKeyNow();f.storage.set(key,'outer opinion');
  let invoked=0;parent.onclick=()=>{invoked++;assert.equal(f.panel.hidden,false)};
  f.dispatch('pointerdown',child);assert.equal(f.panel.hidden,false);f.dispatch('click',child);
  assert.equal(invoked,1);assert.equal(f.panel.hidden,false);assert.equal(f.c.state.anchor,anchor);assert.equal(f.storage.get(key),'outer opinion');
});

test('plain outside click collapses without discarding draft, while panel descendants stay open',async()=>{
  const f=await fixture(),editor=new Element('textarea');f.panel.append(editor);
  f.c.startDraft({type:'global'});const key=f.c.draftKeyNow();f.storage.set(key,'unsaved opinion');
  f.dispatch('pointerdown',editor);f.dispatch('click',editor);assert.equal(f.panel.hidden,false);
  f.dispatch('pointerdown',f.outside);f.dispatch('click',f.outside);
  assert.equal(f.panel.hidden,true);assert.equal(f.storage.get(key),'unsaved opinion');
  assert.equal(f.node('#comments-toggle').getAttribute('aria-expanded'),'false');
});

for(const width of [1024,1440])test(`dialog comments at ${width}px retain the exact reader and media while opening and returning focus`,async()=>{
  const f=await dialogFixture(width),children=[...f.card.children],draft={type:'text',block_id:'original-block',start:0,end:5,quote:'Exact'};
  f.c.state.anchor=draft;const key=f.c.draftKeyNow();f.storage.set(key,'unsaved exact opinion');f.trigger.focus();
  const beforeRenders=f.renders.length;
  f.c.openPanel();
  assert.equal(f.panel.hidden,false);assert.equal(f.c.document.activeElement,width<1200?f.node('#comments-close'):f.trigger);
  assert.equal(f.node('#comments-toggle').getAttribute('aria-expanded'),'true');
  f.node('#comment-editor-text').focus();f.c.openPanel();
  assert.equal(f.c.document.activeElement,f.node('#comment-editor-text'),'opening an already visible panel must not steal editing focus');
  f.node('#comments-close').focus();f.dispatch('click',f.node('#comments-close'),{detail:0});
  assert.equal(f.panel.hidden,true);assert.equal(f.c.document.activeElement,f.trigger);
  assert.equal(f.trigger.focusOptions.preventScroll,true);
  assert.deepEqual(f.card.children,children);assert.equal(f.context.children[0],f.paragraph);assert.equal(f.material.children[0],f.media);
  assert.equal(f.paragraph.textContent,'Exact historical paragraph');assert.equal(f.media.src,'/api/production/files/exact-original.mp4');assert.equal(f.media.currentTime,7.25);
  assert.equal(f.renders.length,beforeRenders,'panel toggles must not rerender the reader or editor');
  assert.equal(f.storage.get(key),'unsaved exact opinion');assert.equal(f.c.state.anchor,draft);
});

for(const stale of ['removed','hidden'])test(`closing comments falls back inside the dialog when its original trigger is ${stale}`,async()=>{
  const f=await dialogFixture();f.trigger.focus();f.c.openPanel();
  if(stale==='removed')f.trigger.remove();else f.trigger.hidden=true;
  f.c.closePanel();assert.equal(f.c.document.activeElement,f.dialogClose);assert.equal(f.dialogClose.focusOptions.preventScroll,true);
});

for(const width of [390,1199,1200,1440])for(const type of ['text','time'])test(`exact reference ${type} location at ${width}px sees the correct panel state before seeking`,async()=>{
  const f=await dialogFixture(width),calls=[],anchor=type==='text'?{type,block_id:'original-block',start:0,end:5,quote:'Exact'}:{type,component_id:'original',asset_file:'exact-original.mp4',start_seconds:7.25,end_seconds:8.5};
  const record={object_id:'historical-asset',id:'historical-revision'};
  f.c.state.reviewReferenceContext={dialog:f.dialog,record};f.c.paintProductionReview=()=>calls.push('paint');
  f.paragraph.scrollIntoView=options=>{assert.equal(f.panel.hidden,width<1200);assert.equal(options.block,'center');calls.push('text')};
  f.media.className='review-media-player';f.media.reviewLocate=value=>{assert.equal(f.panel.hidden,width<1200);assert.equal(value,anchor);calls.push('time')};
  f.trigger.focus();f.c.openPanel();f.node('#comments-close').focus();
  f.c.locateComment({id:'historical-comment',target_object_id:record.object_id,target_revision_id:record.id,anchor});
  assert.deepEqual(calls,[type,'paint']);assert.equal(f.c.state.selected,'historical-comment');assert.equal(f.c.state.reviewReferenceContext.record,record);
  assert.equal(f.panel.hidden,width<1200);assert.equal(f.node('#comments-toggle').getAttribute('aria-expanded'),String(width>=1200));
  assert.equal(f.material.children[0],f.media);assert.equal(f.media.src,'/api/production/files/exact-original.mp4');assert.equal(f.media.currentTime,7.25);
});

for(const width of [390,1199,1200,1440])test(`production comment routing at ${width}px reveals the reader before forwarding the exact material anchor`,async()=>{
  const f=await dialogFixture(width),comment={id:'material-comment',target_revision_id:'old-r1',material_scopes:[{material_id:'need',number:1}],anchor:{type:'region',component_id:'original',asset_file:'old.png',points:[{x:.1,y:.2},{x:.6,y:.2},{x:.6,y:.7}]}};
  f.c.state.workspace='production.workspace';let located=false;
  f.c.locateProductionComment=value=>{assert.equal(value,comment);assert.equal(f.panel.hidden,width<1200);located=true};
  f.trigger.focus();f.c.openPanel();f.c.locateComment(comment);
  assert.equal(located,true);assert.equal(f.panel.hidden,width<1200);
});

async function ordinaryLocationFixture(width,kind,{atEnd=false,missingTarget=false}={}){
  const f=await fixture(),calls=[];f.c.window.innerWidth=width;
  const blockId=kind==='source'?'paragraph':kind==='structure'?'structure-original':atEnd?'script-end':'script-start';
  const block=new Element('p'),mark=new Element('span');mark.className='comment-mark selected';block.append(mark);
  let selector,comment;
  if(kind==='source'){
    block.id='block-'+blockId;f.node('#source-view').append(block);
    comment={id:'source-comment',target_object_id:'source',target_revision_id:'source-r1',anchor:{type:'text',block_id:blockId,end_block_id:blockId,start:0,end:5,quote:'Exact'}};
    if(missingTarget)block.remove();
  }else if(kind==='structure'){
    f.c.state.workspace='story.outline';f.c.state.structureRevision='structure-new';
    f.c.state.structure={current_revision:'structure-new',revisions:[{id:'structure-new'},{id:'structure-old'}]};
    f.c.chooseStructureRevision=(revision,updateUrl)=>{calls.push(['structure-version',revision,updateUrl]);f.c.state.structureRevision=revision};
    f.c.renderStructureReader=()=>calls.push(['structure-render']);
    selector='[data-structure-block="'+blockId+'"]';
    comment={id:'structure-comment',target_object_id:'story-structure',target_revision_id:'structure-old',anchor:{type:'text',block_id:blockId,end_block_id:blockId,start:0,end:5,quote:'Exact'}};
  }else{
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static/screenplay.js'),'utf8'),f.c,{filename:'screenplay.js'});
    const old={object_id:'historical-episode',id:'episode-old',payload:{scenes:[{id:'scene-start',block_ids:['script-start']},{id:'scene-end',block_ids:['script-end']}]}};
    f.c.state.workspace='story.script';f.c.state.screenplays=[{object_id:'version-new',episodes:[{object_id:'current-episode',id:'episode-new',payload:{scenes:[]}}]},{object_id:'version-old',episodes:[old]}];
    f.c.state.screenplayVersion='version-new';f.c.state.screenplayEpisode='current-episode';f.c.state.screenplayScene='scene-new';
    f.c.chooseScript=(version,episode,scene)=>{calls.push(['script-version',version,episode,scene]);f.c.state.screenplayVersion=version;f.c.state.screenplayEpisode=episode;f.c.state.screenplayScene=scene};
    f.c.renderScriptReader=()=>calls.push(['script-render']);
    selector='#screenplay-reader [data-block-id="'+blockId+'"]';
    comment={id:'script-comment',target_object_id:old.object_id,target_revision_id:old.id,anchor:{type:'text',block_id:'script-start',end_block_id:'script-end',start:0,end:5,quote:'Exact\nending'}};
  }
  if(selector){
    f.body.append(block);const query=f.c.document.querySelector;
    f.c.document.querySelector=value=>value===selector?(missingTarget?null:block):query(value);
  }
  const editor=f.node('#comment-editor-text');editor.tagName='TEXTAREA';editor.value='Unsaved exact opinion';f.panel.append(editor);
  f.c.state.anchor={type:'text',block_id:'draft-block',end_block_id:'draft-block',start:0,end:5,quote:'Draft'};
  const key=f.c.draftKeyNow();f.storage.set(key,editor.value);f.storage.set(key+':discussion','true');
  f.c.openPanel();editor.focus();const close=f.c.closePanel;
  f.c.closePanel=()=>{
    // The close action must preserve the current editor. Existing location
    // renderers are separate lifecycle boundaries and can rebuild their DOM.
    const priorStorage=[...f.storage.entries()],priorEditor=f.node('#comment-editor-text'),priorValue=priorEditor.value;
    close();calls.push(['close']);
    assert.equal(f.node('#comment-editor-text'),priorEditor);assert.equal(priorEditor.value,priorValue);
    assert.deepEqual([...f.storage.entries()],priorStorage);
  };
  mark.scrollIntoView=options=>{
    assert.equal(f.panel.hidden,width<1200,'successful location reveals the exact target before scrolling');
    if(width<1200){assert.equal(f.c.document.activeElement,f.node('#comments-toggle'));assert.equal(f.node('#comments-toggle').focusOptions.preventScroll,true)}
    assert.equal(options.behavior,'smooth');assert.equal(options.block,'center');
    calls.push(['scroll',blockId,comment.target_revision_id]);
  };
  return {...f,kind,comment,block,mark,calls,editor,key,locate(){return kind==='script'&&atEnd?f.c.locateScriptComment(comment,true):f.c.locateComment(comment)}};
}

for(const width of [390,1199,1200,1440])for(const route of ['source','structure','script-start','script-end'])test(`ordinary ${route} location at ${width}px reveals its exact target and keeps the draft`,async()=>{
  const kind=route.startsWith('script')?'script':route,atEnd=route==='script-end',f=await ordinaryLocationFixture(width,kind,{atEnd});
  f.locate();
  assert.equal(f.calls.filter(call=>call[0]==='scroll').length,1);
  assert.equal(f.calls.filter(call=>call[0]==='close').length,width<1200?1:0);
  assert.equal(f.panel.hidden,width<1200);assert.equal(f.c.state.selected,f.comment.id);
  for(const trigger of ['#comments-toggle','#screenplay-comments'])assert.equal(f.node(trigger).getAttribute('aria-expanded'),String(width>=1200));
  if(width>=1200)assert.equal(f.c.document.activeElement,f.editor,'wide location must not run the narrow focus handoff');
  if(kind==='structure')assert.deepEqual(f.calls.find(call=>call[0]==='structure-version'),['structure-version','structure-old',true]);
  if(kind==='script')assert.deepEqual(f.calls.find(call=>call[0]==='script-version'),['script-version','version-old','historical-episode',atEnd?'scene-end':'scene-start']);
  assert.equal(f.storage.get(f.key),'Unsaved exact opinion');assert.equal(f.storage.get(f.key+':discussion'),'true');
  assert.equal(f.editor.value,'Unsaved exact opinion');
});

for(const kind of ['source','structure','script'])for(const failure of ['revision','target','invalid-anchor'])test(`failed ordinary ${kind} ${failure} location keeps the open panel and focus`,async()=>{
  const f=await ordinaryLocationFixture(390,kind,{missingTarget:failure==='target'});
  if(failure==='revision')f.comment.target_revision_id='missing-revision';
  if(failure==='invalid-anchor')f.comment.anchor_state={valid:false,reason:'fixture exact anchor is unavailable'};
  f.locate();
  assert.equal(f.panel.hidden,false);assert.equal(f.c.document.activeElement,f.editor);
  assert.equal(f.calls.some(call=>call[0]==='close'||call[0]==='scroll'),false);
  assert.equal(f.node('#comments-toggle').getAttribute('aria-expanded'),'true');
  assert.equal(f.storage.get(f.key),'Unsaved exact opinion');assert.equal(f.editor.value,'Unsaved exact opinion');
});

test('a narrow SOURCE location for a different source keeps its comment panel open',async()=>{
  const f=await ordinaryLocationFixture(1199,'source');f.comment.target_object_id='another-source';
  f.locate();assert.equal(f.panel.hidden,false);assert.equal(f.c.document.activeElement,f.editor);
  assert.equal(f.calls.some(call=>call[0]==='scroll'||call[0]==='close'),false);
});

test('direct narrow script end location with a missing endpoint keeps the panel open',async()=>{
  const f=await ordinaryLocationFixture(1199,'script',{atEnd:true,missingTarget:true});
  f.locate();assert.equal(f.panel.hidden,false);assert.equal(f.c.document.activeElement,f.editor);
  assert.equal(f.calls.some(call=>call[0]==='scroll'||call[0]==='close'),false);
});

test('narrow successful location restores focus even if comment rendering already moved it to BODY',async()=>{
  const f=await ordinaryLocationFixture(390,'source'),render=f.c.renderComments;
  f.c.renderComments=()=>{render();f.c.document.activeElement=f.body};
  f.locate();assert.equal(f.c.document.activeElement,f.node('#comments-toggle'));
  assert.equal(f.node('#comments-toggle').focusOptions.preventScroll,true);
  assert.equal(f.storage.get(f.key),'Unsaved exact opinion');
});

async function unifiedCloseFixture(){
  const f=await fixture(),dialogs=[];
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static/unified-cards.js'),'utf8'),f.c,{filename:'unified-cards.js'});
  // Network/card painting are separate contracts. Execute the real modal owner,
  // panel relocation, saved-state close callback and setPanelOpen functions here.
  Object.assign(f.c,{productionLoadEpoch:0,rememberProductionDraft(){},restoreProductionDraft(){},renderProductionReader(){},paintProductionReview(){},history:{state:{},replaceState(){}},
    readUnifiedCard:async(object_id,id)=>({record:{object_id,id}}),activateUnifiedCard:value=>{f.c.state.productionSelected=value.record},
    openReviewDialog(){const dialog=new Element('dialog'),body=new Element();dialog.className='unified-card-dialog';body.className='review-dialog-body';dialog.append(body);f.body.append(dialog);dialogs.push(dialog);return {dialog,body}}});
  return {...f,dialogs,close(dialog){f.dispatch('close',dialog,{detail:0});dialog.remove()}};
}

for(const outerHidden of [true,false])test(`closing a unified card restores both outer visibility and aria-expanded (hidden=${outerHidden})`,async()=>{
  const f=await unifiedCloseFixture(),original={object_id:'outer',id:'outer-r1'};f.c.state.productionSelected=original;f.c.setPanelOpen(!outerHidden);
  await f.c.openUnifiedMaterial({object_id:'inner',revision_id:'inner-r2'});assert.equal(f.panel.parentNode,f.dialogs[0]);
  f.c.setPanelOpen(outerHidden);f.close(f.dialogs[0]);
  assert.equal(f.panel.parentNode,f.body);assert.equal(f.c.state.productionSelected,original);assert.equal(f.panel.hidden,outerHidden);
  for(const id of ['#comments-toggle','#screenplay-comments'])assert.equal(f.node(id).getAttribute('aria-expanded'),String(!outerHidden));
});

test('nested unified cards restore each owning reader and its own comment visibility in order',async()=>{
  const f=await unifiedCloseFixture(),original={object_id:'outer',id:'outer-r1'};f.c.state.productionSelected=original;f.c.closePanel();
  await f.c.openUnifiedMaterial({object_id:'first',revision_id:'first-r1'});f.c.openPanel();const first=f.c.state.productionSelected;
  await f.c.openUnifiedMaterial({object_id:'second',revision_id:'second-r1'});f.c.closePanel();
  f.close(f.dialogs[1]);assert.equal(f.panel.parentNode,f.dialogs[0]);assert.equal(f.panel.hidden,false);assert.equal(f.c.state.productionSelected,first);
  assert.equal(f.node('#comments-toggle').getAttribute('aria-expanded'),'true');
  f.close(f.dialogs[0]);assert.equal(f.panel.parentNode,f.body);assert.equal(f.panel.hidden,true);assert.equal(f.c.state.productionSelected,original);
  assert.equal(f.node('#comments-toggle').getAttribute('aria-expanded'),'false');
});

test('a late lower-card response waits for the newer upper card and returns to its own reader',async()=>{
  const f=await unifiedCloseFixture(),held={},stack=[];f.c.reviewDialogStack=stack;
  const open=f.c.openReviewDialog;f.c.openReviewDialog=(...args)=>{const result=open(...args);stack.push(result.dialog);return result};
  f.c.readUnifiedCard=(object_id,id)=>new Promise(resolve=>held[object_id]=()=>resolve({record:{object_id,id}}));
  const original={object_id:'manager',id:'manager'};f.c.state.productionSelected=original;
  const first=f.c.openUnifiedMaterial({object_id:'first',revision_id:'first-old'}),second=f.c.openUnifiedMaterial({object_id:'second',revision_id:'second-old'});
  held.second();await second;assert.equal(f.c.state.productionSelected.object_id,'second');
  held.first();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.c.state.productionSelected.object_id,'second');
  stack.pop();f.close(f.dialogs[1]);await first;assert.equal(f.c.state.productionSelected.id,'first-old');assert.equal(f.panel.parentNode,f.dialogs[0]);
  stack.pop();f.close(f.dialogs[0]);assert.equal(f.c.state.productionSelected,original);assert.equal(f.panel.parentNode,f.body);
});
