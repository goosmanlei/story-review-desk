const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
// Real image gesture handlers; event paths model synchronous polygon removal
// and a dialog stopping bubbling. Physical dragging is verified in Chrome.
function fixture({modal=false,detachedTarget=false}={}){
 const events={},drafts=[],focuses=[],captures=[];
 const record={object_id:'image',id:'image-exact'},other={object_id:'other',id:'other-exact'};
 const reader={contains:n=>n===stage},body={contains:n=>n===stage},overlay={setPointerCapture:id=>captures.push(id)};
 const pane={reviewFocus(){focuses.push('focus');ctx.state.productionSelected=record}};
 const stage={dataset:{visualId:'original'},classList:{remove(){}},matches:s=>s==='.structure-visual-stage',closest:s=>s==='.structure-visual-stage'?stage:s==='.entity-review-media-pane'?pane:null,querySelector:()=>overlay,getBoundingClientRect:()=>({left:0,top:0,width:100,height:100})};
 const polygon={closest:s=>detachedTarget?null:stage.closest(s)},ctx={
  state:{workspace:'materials.workspace',productionSelected:other,unifiedCardRoot:modal?body:null,drawMode:'original'},
  document:{addEventListener:(name,fn,options)=>(events[name]??=[]).push({fn,capture:options===true||options?.capture===true})},window:{addEventListener(){}},
  $:s=>s==='#production-reader'?reader:null,isProduction:()=>true,isStructure:()=>false,
  commentTarget:()=>({target_object_id:ctx.state.productionSelected.object_id,target_revision_id:ctx.state.productionSelected.id}),
  productionVisuals:()=>ctx.state.productionSelected.id===record.id?[{id:'original',file:'exact-image.png'}]:[],
  startDraft:anchor=>drafts.push({anchor,target:ctx.commentTarget()}),toast(){},requestAnimationFrame:()=>1
 };
 vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static/structure.js'),'utf8'),ctx);ctx.paintStructureRegions=()=>{};
 const emit=(name,x,y)=>{
  const event={target:polygon,composedPath:()=>[polygon,overlay,stage,pane,...(modal?[body]:[]),reader],clientX:x,clientY:y,pointerId:7,shiftKey:true,preventDefault(){}};
  // A modal's pointerdown stopper runs after document capture. No document
  // bubble listener can receive that gesture, including when its target lives.
  for(const handler of events[name]||[])if(handler.capture)handler.fn(event);
  if(!(modal&&name==='pointerdown'))for(const handler of events[name]||[])if(!handler.capture)handler.fn(event);
 };
 return {ctx,reader,body,record,stage,events,drafts,focuses,captures,emit};
}
for(const modal of [false,true])test(`exact image region starts from a removed polygon in ${modal?'modal':'inline'} reader`,()=>{
 const f=fixture({modal,detachedTarget:true});f.emit('pointerdown',10,10);f.emit('pointermove',30,30);f.emit('pointerup',40,40);
 assert.equal(f.focuses.length,1);assert.deepEqual(f.captures,[7]);assert.equal(f.drafts.length,1);
 assert.deepEqual(JSON.parse(JSON.stringify(f.drafts[0])),{anchor:{type:'region',visual_id:'original',asset_file:'exact-image.png',points:[{x:.1,y:.1},{x:.4,y:.1},{x:.4,y:.4},{x:.1,y:.4}]},target:{target_object_id:'image',target_revision_id:'image-exact'}});
 assert.equal(f.ctx.state.drawMode,null);
 for(const type of ['pointerdown','pointermove','pointerup'])assert.ok(f.events[type][0].capture,type+' must own the gesture before modal bubbling stops');
});
for(const change of ['workspace','revision','modal-close','modal-replace','stage-detach'])test(`modal image late pointerup after ${change} cannot write a different review context`,()=>{
 const f=fixture({modal:true});f.emit('pointerdown',10,10);
 if(change==='workspace')f.ctx.state.workspace='settings.workspace';
 if(change==='revision')f.ctx.state.productionSelected={...f.record,id:'later-exact'};
 if(change==='modal-close')f.ctx.state.unifiedCardRoot=null;
 if(change==='modal-replace')f.ctx.state.unifiedCardRoot={contains:()=>true};
 if(change==='stage-detach')f.body.contains=()=>false;
 f.emit('pointerup',40,40);assert.equal(f.drafts.length,0);assert.equal(f.ctx.state.drawMode,null);
});
