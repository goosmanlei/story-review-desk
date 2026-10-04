const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');

class Element {
  constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.style={};this.isConnected=true;this.attributes={};this.classList={add(){},remove(){},toggle(){}};}
  append(...children){for(const child of children){child.parentNode=this;this.children.push(child)}}
  prepend(child){this.children.unshift(child)}
  replaceChildren(...children){this.children=[];this.append(...children)}
  setAttribute(k,v){this.attributes[k]=v}
  removeAttribute(k){delete this.attributes[k]}
  addEventListener(type,callback){this.listeners||={};this.listeners[type]=callback}
  remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(n=>n!==this);this.parentNode=null}
  insertBefore(child){this.append(child)}
  querySelector(){return null}
  querySelectorAll(){return []}
}
const row=(object_id,kind,id=object_id+'-1',payload={})=>({object_id,kind,id,current_revision:id,version:1,created_at:'2026-10-04T00:00:00Z',payload:{title:object_id,blocks:[],...payload}});
const ref=r=>({object_id:r.object_id,revision_id:r.id});
function setup(){
  const ctx={URL,URLSearchParams,CSS:{escape:x=>x},console,setTimeout:()=>1,clearTimeout(){},location:{href:'http://isolated/?workspace=settings.workspace'},history:{replaceState(_a,_b,u){ctx.location.href=String(u)}},localStorage:{getItem:()=>null},document:{addEventListener(){},querySelector:()=>null,querySelectorAll:()=>[],createElement:tag=>new Element(tag),createElementNS:(_ns,tag)=>new Element(tag)}};
  ctx.Option=function(text,value){const e=new Element('option');e.textContent=text;e.value=value;return e};
  vm.createContext(ctx);
  for(const name of ['app.js','production.js','material-review.js','entity-review.js','production-breakdown.js','unified-cards.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static',name),'utf8'),ctx);
  vm.runInContext('globalThis.state=state',ctx);ctx.state.workspace='settings.workspace';
  for(const fn of ['renderProductionReader','renderComments','paintProductionReview'])ctx[fn]=()=>{};
  return ctx;
}
function fixture(ctx){
  const entity=row('entity','ENTITY',undefined,{entity_type:'character'}),form=row('form','STATE',undefined,{entity:ref(entity)});
  const need=row('need','REQUIREMENT',undefined,{scope:ref(form),slot:'overall',media_type:'image'});
  const asset=(id,date)=>({...row(id,'ASSET',undefined,{media_type:'image',components:[{id:'original',role:'original',mime:'image/png',sha256:id}],candidate_requirements:[ref(need)]}),created_at:date});
  const older=asset('z-old','2026-10-03T00:00:00Z'),newer=asset('a-new','2026-10-04T00:00:00Z');
  const items=[older,newer].map(record=>({record,component:record.payload.components[0],components:record.payload.components}));
  const round={number:1,model:'plan-v1',plan:need,members:[need,older,newer],results:[older,newer]};
  const data={entity,states:[form],requirements:[need],relationships:[],media:[],comment_records:[],comment_targets:[],usages:{},material_versions:{need:[round]},materialContexts:{},adoptions:[]};
  const model={material_id:'need',need,identity:need,round,rounds:[round],candidates:items};
  Object.assign(ctx.state,{entityReview:data,productionSelected:form,productionEntityDetail:{record:entity},productionChildDetail:{record:form},productionRecords:[entity,form,need,older,newer]});
  return {entity,form,need,older,newer,items,round,data,model};
}

test('current version uses its explicitly adopted candidate and exact component before newer results',()=>{
  const ctx=setup(),f=fixture(ctx);
  f.data.adoptions=[{payload:{scope:ref(f.form),slot:'overall',asset:ref(f.older),component_id:'original'}}];
  assert.equal(ctx.materialDefaultCandidate(f.model,f.data),f.older.id);
  assert.equal(f.data.selectedComponents[f.older.id],'original');
});
test('without adoption the newest result wins independently of object ID or array order',()=>{
  const ctx=setup(),f=fixture(ctx);
  assert.equal(ctx.materialDefaultCandidate(f.model,f.data),f.newer.id);
  f.model.candidates.reverse();assert.equal(ctx.materialDefaultCandidate(f.model,f.data),f.newer.id);
});
test('adoption from another state with the same slot does not select this requirement candidate',()=>{
  const ctx=setup(),f=fixture(ctx);
  f.data.adoptions=[{payload:{scope:{object_id:'other-form',revision_id:'other-form-1'},slot:'overall',asset:ref(f.older),component_id:'original'}}];
  assert.equal(ctx.materialDefaultCandidate(f.model,f.data),f.newer.id);
});
test('the entity material renderer displays the adopted file component, not the first file',()=>{
  const ctx=setup(),f=fixture(ctx);
  const second={...f.older.payload.components[0],id:'alternate',sha256:'alternate'};f.older.payload.components.push(second);f.round.results=[f.older];
  const media=[{record:f.older,component:f.older.payload.components[0],component_id:'original',state:ref(f.form)}];
  const model=ctx.entityReviewMaterialModels([f.need],media,f.data)[0];
  f.data.adoptions=[{payload:{scope:ref(f.form),slot:'overall',asset:ref(f.older),component_id:'alternate'}}];
  f.data.selectedCandidates={need:ctx.materialDefaultCandidate(model,f.data)};
  let visibleComponent;ctx.reviewSurface=host=>host;ctx.materialMedia=(_root,item)=>{visibleComponent=item.component.id};ctx.renderActualGeneration=()=>{};
  ctx.renderMaterialCard(new Element('main'),model,ctx.entityMaterialCandidateOptions(f.data,model));
  assert.equal(visibleComponent,'alternate');
});
test('a preparing current version never borrows its historical adopted result',()=>{
  const ctx=setup(),f=fixture(ctx);
  f.data.adoptions=[{payload:{scope:ref(f.form),slot:'overall',asset:ref(f.older),component_id:'original'}}];
  f.data.material_versions.need.unshift({number:2,model:'plan-v1',plan:f.need,members:[f.need],results:[]});
  const models=ctx.materialRoundModels([f.need],f.items,f.data);
  assert.equal(models[0].round.number,2);assert.equal(models[0].candidates.length,0);
  assert.equal(ctx.materialDefaultCandidate(models[0],f.data),null);
});
for(const version of ['999','not-a-version','0'])test(`an explicit invalid version ${version} is rejected without changing the URL`,()=>{
  const ctx=setup(),f=fixture(ctx),url=ctx.location.href;
  assert.throws(()=>ctx.validateUnifiedReference({detail:{record:f.need,history:[f.need],material_versions:f.data.material_versions},params:new URLSearchParams({material_version:version})}));
  assert.equal(ctx.location.href,url);
});
test('an explicit unknown material identity is rejected even without a numeric version',()=>{
  const ctx=setup(),f=fixture(ctx);
  assert.throws(()=>ctx.validateUnifiedReference({detail:{record:f.need,history:[f.need],material_versions:f.data.material_versions},params:new URLSearchParams({material_id:'foreign'})}));
});
test('an explicit candidate must belong to the named material version',()=>{
  const ctx=setup(),f=fixture(ctx);
  assert.throws(()=>ctx.validateUnifiedReference({detail:{record:f.need,history:[f.need],material_versions:f.data.material_versions},params:new URLSearchParams({material_id:'need',material_version:'1',material_target:'foreign-result'})}));
});
test('a material requirement URL restores its requested older candidate inside the owning entity card',()=>{
  const ctx=setup(),f=fixture(ctx),params=new URLSearchParams({material_id:'need',material_version:'1',material_target:f.older.id});
  const result={detail:{record:f.need,history:[f.need],material_versions:f.data.material_versions},entity_review:f.data,form:f.form,params,explicit:true};
  ctx.validateUnifiedReference(result);ctx.activateUnifiedCard(result);
  let shown;ctx.materialSmallCard=()=>{};ctx.renderMaterialCard=(_root,_model,options)=>{shown=options.selectedCandidateId};
  f.data.unifiedRight=new Element('aside');ctx.renderUnifiedModels(new Element('main'),[f.model],f.data);
  assert.equal(shown,f.older.id);
});
test('same-entity version responses cannot replace a newer choice when they arrive out of order',async()=>{
  const ctx=setup(),f=fixture(ctx),requests=[],shown=[];
  f.data.versions={[f.entity.object_id]:[{id:'old',version:1},{id:f.entity.id,version:2}]};
  ctx.fetch=url=>new Promise(resolve=>requests.push({url,resolve:value=>resolve({ok:true,json:async()=>value})}));let control;
  ctx.entityVersionControl({append:n=>control=n},f.entity,r=>shown.push(r.id));
  control.value='old';const first=control.onchange();control.value=f.entity.id;const last=control.onchange();
  requests[1].resolve({record:f.entity});await last;requests[0].resolve({record:{...f.entity,id:'old'}});await first;
  assert.deepEqual(shown,[f.entity.id]);
});
test('a response to a detached entity version control cannot restore its obsolete selection',async()=>{
  const ctx=setup(),f=fixture(ctx),shown=[];let release,control;
  f.data.versions={[f.entity.object_id]:[{id:'old',version:1},{id:f.entity.id,version:2}]};
  ctx.fetch=()=>new Promise(resolve=>{release=value=>resolve({ok:true,json:async()=>value})});
  ctx.entityVersionControl({append:n=>control=n},f.entity,r=>shown.push(r.id));
  control.value='old';const request=control.onchange();control.isConnected=false;
  release({record:{...f.entity,id:'old'}});await request;assert.deepEqual(shown,[]);
});
test('editing a carried exact text in one material version is not restored into another version',()=>{
  const ctx=setup(),f=fixture(ctx);
  f.round.results=[];f.model.candidates=[];
  f.data.material_versions.need=[{...f.round,number:2},f.round];f.data.selectedMaterialRounds={need:1};
  Object.assign(ctx.state,{productionSelected:f.need,materialCommentCard:{data:f.data,material_id:'need',number:1},anchor:{type:'global'},editing:'saved-comment-in-version-1'});
  ctx.rememberProductionDraft();ctx.switchMaterialRound(f.data,'need',2);
  assert.equal(ctx.state.editing,null);
  assert.equal(ctx.materialCommentContext().number,2);
});

function modalFixture(ctx,f){
  const panel=new Element('aside'),outer=new Element('main'),dialog=new Element('dialog'),body=new Element('div');outer.append(panel);
  ctx.document.querySelector=s=>s==='#comment-panel'?panel:null;
  ctx.openReviewDialog=()=>({dialog,body});ctx.renderUnifiedCard=()=>{};
  const result={detail:{record:f.need,history:[f.need],material_versions:f.data.material_versions},entity_review:f.data,form:f.form};
  return {panel,outer,dialog,body,result};
}
test('a pending modal read cannot reactivate its card after browser navigation changes workspace',async()=>{
  const ctx=setup(),f=fixture(ctx),m=modalFixture(ctx,f);let release;
  ctx.fetch=()=>new Promise(resolve=>{release=()=>resolve({ok:true,json:async()=>m.result})});
  const opening=ctx.openUnifiedMaterial(ref(f.need),null),newReader=row('new-page','SOURCE');
  ctx.state.workspace='story.sources';ctx.state.productionSelected=newReader;ctx.location.href='http://isolated/?workspace=story.sources';
  release();await opening;
  assert.equal(ctx.state.productionSelected,newReader);
  assert.equal(new URL(ctx.location.href).searchParams.get('workspace'),'story.sources');
});
test('closing an obsolete modal cannot restore its saved reader or URL over newer navigation',async()=>{
  const ctx=setup(),f=fixture(ctx),m=modalFixture(ctx,f);
  ctx.fetch=async()=>({ok:true,json:async()=>m.result});await ctx.openUnifiedMaterial(ref(f.need),null);
  const newReader=row('new-page','SOURCE');ctx.state.workspace='story.sources';ctx.state.productionSelected=newReader;ctx.location.href='http://isolated/?workspace=story.sources';
  m.dialog.isConnected=false;m.dialog.listeners.close();
  assert.equal(ctx.state.productionSelected,newReader);
  assert.equal(new URL(ctx.location.href).searchParams.get('workspace'),'story.sources');
});
test('saving the restored outer draft cannot overwrite a closed modal draft',async()=>{
  const ctx=setup(),f=fixture(ctx),m=modalFixture(ctx,f);
  ctx.restoreProductionDraft();ctx.state.anchor={type:'global'};ctx.state.editing='outer-comment';
  ctx.fetch=async()=>({ok:true,json:async()=>m.result});await ctx.openUnifiedMaterial(ref(f.need),null);
  ctx.state.anchor={type:'global'};ctx.state.editing='inner-comment';const innerKey=ctx.productionDraftKey();
  m.dialog.isConnected=false;m.dialog.listeners.close();
  assert.equal(ctx.state.editing,'outer-comment');ctx.rememberProductionDraft();
  assert.equal(ctx.state.productionDraftContexts[innerKey].editing,'inner-comment');
});
test('an exact historical shot link preserves its requested revision in the all-shot scene reader',async()=>{
  const ctx=setup(),source={object_id:'episode',revision_id:'episode-1',scene_id:'scene'};
  const scene=row('scene','PREPARATION',undefined,{source});
  const current=row('shot','SHOT_DESIGN','shot-current',{parent:ref(scene),source,number:1,fps:24,duration_frames:120});
  const original={...current,id:'shot-original',version:1,payload:{...current.payload,title:'Original shot design'}};
  const sceneData={scene,shared:[],shots:[{record:current,context:{requirements:[],materials:[]}}]};
  ctx.state.breakdownData={episode:'episode'};ctx.state.productionRecords=[scene,current];
  ctx.document.createTextNode=text=>({textContent:text});ctx.reviewSurface=host=>host;ctx.paintReviewCommentCounts=()=>{};
  ctx.fetch=async url=>({ok:true,json:async()=>String(url).includes('/api/production/scene?')?sceneData:{record:original,history:[current,original],uses:[]}});
  const params=new URLSearchParams({breakdown_object:'shot',breakdown_revision:'shot-original'});
  await ctx.showBreakdownScene(scene,new Element('main'),new Element('nav'),0,params);
  assert.equal(ctx.state.productionSelected.id,'shot-original');
  assert.equal(new URL(ctx.location.href).searchParams.get('breakdown_revision'),'shot-original');
});

function genericMaterialFixture(ctx){
  const scope=row('scene','PREPARATION'),plan=number=>row('video-need','REQUIREMENT','plan-'+number,{
    scope:ref(scope),slot:'scene-video',media_type:'video',generation:{model:'fixture',parameters:{},prompt:'plan '+number,inputs:[],output:{name:'Fixture video',review_criteria:[]}}});
  const asset=(id,date)=>({...row(id,'ASSET',id+'-exact',{media_type:'video',components:[
    {id:'original',role:'original',mime:'video/mp4',sha256:id,file:id+'.mp4'},
    {id:'alternate',role:'original',mime:'video/mp4',sha256:id+'-alternate',file:id+'-alternate.mp4'}]}),created_at:date});
  const old1=asset('old-v1','2026-10-01T00:00:00Z'),new1=asset('new-v1','2026-10-02T00:00:00Z');
  const old2=asset('adopted-v2','2026-10-03T00:00:00Z'),new2=asset('latest-v2','2026-10-04T00:00:00Z');
  const rounds=[{number:2,model:'plan-v1',plan:plan(2),results:[old2,new2]},{number:1,model:'plan-v1',plan:plan(1),results:[old1,new1]}];
  for(const round of rounds)round.members=[round.plan,...round.results];
  const detail={record:rounds[0].plan,history:rounds.map(r=>r.plan),uses:[],material_versions:{'video-need':rounds},
    adoptionContext:{adoptions:[{payload:{scope:ref(scope),slot:'scene-video',asset:ref(old2),component_id:'alternate',range:{start_seconds:.5,end_seconds:1.5}}}]}};
  Object.assign(ctx.state,{workspace:'materials.workspace',entityReview:null,materialReview:detail,productionSelected:detail.record,productionDetail:detail,productionRecords:[scope,...rounds.flatMap(r=>r.members)]});
  ctx.location.href='http://isolated/?workspace=materials.workspace';
  ctx.reviewSurface=host=>host;ctx.renderActualGeneration=()=>{};ctx.renderMaterialAdoptionControls=()=>{};
  const shown=[];ctx.materialMedia=(_host,item)=>shown.push(item);
  function render(){shown.length=0;const root=new Element('main');ctx.renderMaterialDemand(root,detail);return root}
  return {scope,detail,rounds,old1,new1,old2,new2,shown,render,plan};
}
function descendants(node){return [node,...(node.children||[]).flatMap(descendants)]}
test('a non-entity demand defaults to its adopted candidate, exact file and range',()=>{
  const ctx=setup(),f=genericMaterialFixture(ctx);f.render();
  assert.equal(f.shown.length,1);assert.equal(f.shown[0].record.id,f.old2.id);
  assert.equal(f.shown[0].component.id,'alternate');
  assert.deepEqual(JSON.parse(JSON.stringify(f.shown[0].range)),{start_seconds:.5,end_seconds:1.5});
});
test('switching a non-entity demand to an older version picks that version newest result and comment scope',()=>{
  const ctx=setup(),f=genericMaterialFixture(ctx);f.render();
  ctx.switchMaterialRound(f.detail,'video-need',1);f.render();
  assert.equal(f.shown[0].record.id,f.new1.id);assert.equal(ctx.state.productionSelected.id,f.new1.id);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.materialCommentContext())),{material_id:'video-need',number:1,model:'plan-v1'});
  assert.equal(new URL(ctx.location.href).searchParams.get('material_target'),f.new1.id);
});
test('switching a non-entity demand to an empty version keeps its plan and never borrows an adopted historical file',()=>{
  const ctx=setup(),f=genericMaterialFixture(ctx),plan=f.plan(3);
  f.rounds.unshift({number:3,model:'plan-v1',plan,members:[plan],results:[]});f.detail.selectedMaterialRounds={'video-need':2};f.render();
  ctx.switchMaterialRound(f.detail,'video-need',3);f.render();
  assert.equal(f.shown.length,0);assert.equal(ctx.state.productionSelected.id,plan.id);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.materialCommentContext())),{material_id:'video-need',number:3,model:'plan-v1'});
});
test('selecting a non-entity candidate focuses its exact revision without changing the material comment version',()=>{
  const ctx=setup(),f=genericMaterialFixture(ctx),root=f.render();
  const candidates=descendants(root).find(n=>n.attributes?.['aria-label']==='本轮候选');
  candidates.value=f.new2.id;candidates.onchange();f.render();
  assert.equal(f.shown[0].record.id,f.new2.id);assert.equal(ctx.state.productionSelected.id,f.new2.id);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.materialCommentContext())),{material_id:'video-need',number:2,model:'plan-v1'});
  assert.equal(new URL(ctx.location.href).searchParams.get('material_target'),f.new2.id);
});
test('an explicit non-entity file choice can replace the adopted default without reverting on repaint',()=>{
  const ctx=setup(),f=genericMaterialFixture(ctx),root=f.render();
  const components=descendants(root).find(n=>n.attributes?.['aria-label']==='原件与预览组成');
  assert.equal(components.value,'alternate');components.value='original';components.onchange();f.render();
  assert.equal(f.shown[0].record.id,f.old2.id);assert.equal(f.shown[0].component.id,'original');
  assert.equal(f.shown[0].range??null,null,'an adopted alternate-file range cannot annotate another file');
});
test('media comments require the exact candidate, file component and material version together',()=>{
  const ctx=setup(),f=genericMaterialFixture(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static/review-ui.js'),'utf8'),ctx);
  const make=(id,revision,component,number)=>({id,target_revision_id:revision,material_plan_scopes:[{material_id:'video-need',number}],
    anchor:{type:'time',component_id:component,asset_file:component+'.mp4',start_seconds:.5,end_seconds:1.5}});
  const comments=[make('exact',f.old2.id,'original',2),make('other-file',f.old2.id,'alternate',2),
    make('other-candidate',f.new2.id,'original',2),make('other-version',f.old2.id,'original',1)];
  const shown=ctx.reviewBlockComments(comments,{kind:'video',revision:f.old2.id,revisions:[f.old2.id],
    componentId:'original',file:'original.mp4',from:0,to:4,materialId:'video-need',materialNumber:2,materialModel:'plan-v1'});
  assert.deepEqual(Array.from(shown,c=>c.id),['exact']);
});
for(const closeBy of ['button','Escape'])test(`entity reload inside a shared dialog preserves its history marker until ${closeBy} closes it`,async()=>{
  const ctx=setup(),f=fixture(ctx);let backCount=0;
  ctx.document.body=new Element('body');
  ctx.document.createElement=tag=>{const e=new Element(tag);if(tag==='dialog'){e.showModal=()=>{};e.close=()=>{e.isConnected=false;e.listeners.close()}}return e};
  ctx.history={state:{outside:true},pushState(value,_title,url){this.state=value;ctx.location.href=String(url)},
    replaceState(value,_title,url){this.state=value;ctx.location.href=String(url)},back(){backCount++}};
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static/review-ui.js'),'utf8'),ctx);
  const {dialog}=ctx.openReviewDialog('Fixture entity',null),marker=ctx.history.state.reviewDialog;
  ctx.fetch=async()=>({ok:true,json:async()=>f.data});await ctx.reloadEntityReview();
  assert.equal(ctx.history.state?.reviewDialog,marker);
  if(closeBy==='button')await descendants(dialog).find(n=>n.attributes?.['aria-label']==='关闭').onclick();
  else dialog.listeners.keydown({key:'Escape',preventDefault(){},stopPropagation(){}});
  assert.equal(backCount,1,'closing consumes exactly the history entry owned by this dialog');
});

function installImageGesture(ctx,record,reader){
  const handlers={};ctx.window={addEventListener(){}};ctx.requestAnimationFrame=()=>1;
  ctx.document.addEventListener=(name,fn)=>{(handlers[name]??=[]).push(fn)};
  const previousQuery=ctx.document.querySelector;ctx.document.querySelector=s=>s==='#production-reader'?reader:previousQuery(s);
  ctx.getSelection=()=>({removeAllRanges(){}});ctx.hideSelectionAction=()=>{};ctx.openPanel=()=>{};ctx.renderActiveReader=()=>{};
  const overlay={setPointerCapture(){}},pane={reviewFocus:()=>ctx.focusProductionReview({record,history:[record],uses:[]},false)};
  const stage={dataset:{visualId:'original'},classList:{remove(){}},matches:s=>s==='.structure-visual-stage',
    closest:s=>s==='.entity-review-media-pane'?pane:s==='.structure-visual-stage'?stage:null,
    querySelector:()=>overlay,getBoundingClientRect:()=>({left:0,top:0,width:100,height:100})};
  reader.contains=n=>n===stage;
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static/structure.js'),'utf8'),ctx);
  vm.runInContext('globalThis.exactCommentTarget=commentTarget',ctx);ctx.paintStructureRegions=()=>{};
  const emit=(name,x=10,y=10)=>{const e={target:stage,composedPath:()=>[stage,pane,reader],clientX:x,clientY:y,pointerId:9,shiftKey:true,preventDefault(){}};for(const fn of handlers[name]||[])fn(e)};
  return {stage,emit};
}
function imageRevision(id,file){return row('same-image','ASSET',id,{media_type:'image',components:[{id:'original',role:'original',mime:'image/png',file,sha256:file}]})}
test('shared image gesture captures the exact old image target after real production focus changes from a newer revision',()=>{
  const ctx=setup(),old=imageRevision('image-old','old.png'),newer=imageRevision('image-new','new.png'),reader=new Element('main');
  Object.assign(ctx.state,{workspace:'materials.workspace',productionSelected:newer,entityReview:null,materialReview:null,drawMode:'original'});
  const g=installImageGesture(ctx,old,reader);g.emit('pointerdown');g.emit('pointerup',40,40);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.exactCommentTarget())),{target_object_id:'same-image',target_revision_id:'image-old'});
  assert.equal(ctx.state.anchor.asset_file,'old.png');assert.equal(ctx.state.anchor.visual_id,'original');
});
test('late image pointerup cannot replace the newer revision comment draft after a real focus change',()=>{
  const ctx=setup(),old=imageRevision('image-old','old.png'),newer=imageRevision('image-new','new.png'),reader=new Element('main');
  Object.assign(ctx.state,{workspace:'materials.workspace',productionSelected:old,entityReview:null,materialReview:null,drawMode:'original'});
  const g=installImageGesture(ctx,old,reader);g.emit('pointerdown');
  ctx.focusProductionReview({record:newer,history:[newer],uses:[]},false);const newerAnchor={type:'global'};ctx.state.anchor=newerAnchor;
  g.emit('pointerup',40,40);assert.equal(ctx.state.anchor,newerAnchor);assert.equal(ctx.exactCommentTarget().target_revision_id,'image-new');
});
test('actual unified dialog close restores the outer revision and draft before a late inner image pointerup',async()=>{
  const ctx=setup(),f=fixture(ctx),m=modalFixture(ctx,f),old=imageRevision('image-old','old.png'),newer=imageRevision('image-new','new.png');
  const outerAnchor={type:'global'};Object.assign(ctx.state,{workspace:'materials.workspace',entityReview:null,materialReview:null,productionSelected:newer,anchor:outerAnchor});
  m.result={detail:{record:old,history:[old],uses:[],material_versions:{}},entity_review:null};
  ctx.fetch=async()=>({ok:true,json:async()=>m.result});await ctx.openUnifiedMaterial(ref(old),null);
  const g=installImageGesture(ctx,old,m.body);ctx.state.drawMode='original';g.emit('pointerdown');
  m.dialog.isConnected=false;m.dialog.listeners.close();
  assert.equal(ctx.state.productionSelected.id,'image-new');assert.equal(ctx.state.anchor,outerAnchor);
  g.emit('pointerup',40,40);assert.equal(ctx.state.productionSelected.id,'image-new');assert.equal(ctx.state.anchor,outerAnchor);
});
test('an exact withdrawn entity material remains readable outside the active entity list',async()=>{
  const ctx=setup(),f=fixture(ctx);f.entity.payload.status='withdrawn';ctx.state.productionVisibleEntities=new Set();
  ctx.fetch=async()=>({ok:true,json:async()=>f.data});
  await ctx.openEntityReview(f.entity.object_id,{record:f.older,history:[f.older],uses:[]},0,f.older.id);
  assert.equal(ctx.state.productionSelected.id,f.older.id);assert.equal(ctx.state.entityReview.entity.object_id,f.entity.object_id);
});
test('a withdrawn entity without an exact revision cannot repopulate an empty active filter',async()=>{
  const ctx=setup(),f=fixture(ctx);f.entity.payload.status='withdrawn';
  Object.assign(ctx.state,{productionVisibleEntities:new Set(),productionSelected:null,entityReview:null});
  ctx.fetch=async()=>({ok:true,json:async()=>f.data});
  await ctx.openEntityReview(f.entity.object_id,{record:f.entity,history:[f.entity],uses:[]},0,null);
  assert.equal(ctx.state.productionSelected,null);assert.equal(ctx.state.entityReview,null);
});
test('an exact withdrawn entity response still loses to a newer filter request epoch',async()=>{
  const ctx=setup(),f=fixture(ctx);f.entity.payload.status='withdrawn';let release;
  ctx.state.productionVisibleEntities=new Set();ctx.fetch=()=>new Promise(resolve=>{release=()=>resolve({ok:true,json:async()=>f.data})});
  const pending=ctx.openEntityReview(f.entity.object_id,{record:f.older,history:[f.older],uses:[]},0,f.older.id);
  vm.runInContext('productionReadEpoch++',ctx);ctx.state.productionSelected=null;ctx.state.entityReview=null;
  release();await pending;assert.equal(ctx.state.productionSelected,null);assert.equal(ctx.state.entityReview,null);
});
