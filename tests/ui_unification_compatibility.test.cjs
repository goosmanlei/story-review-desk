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
test('an exact entity relation is readable in settings without admitting adoption relations',()=>{
  const ctx=setup();
  assert.equal(vm.runInContext("productionWorkspaceCanRead('settings.workspace',{kind:'RELATION',payload:{relation_type:'entity'}})",ctx),true);
  assert.equal(vm.runInContext("productionWorkspaceCanRead('settings.workspace',{kind:'RELATION',payload:{relation_type:'adoption'}})",ctx),false);
});
test('shared candidates use the chosen material round number in both small and large cards',()=>{
  const ctx=setup(),f=fixture(ctx);f.model.identity={...f.need,business_code:'M004'};f.model.need=null;f.model.round.business_code='M841 / MV001';
  assert.equal(ctx.materialModelCode(f.model),'M841');
  assert.equal(ctx.modelSmallItem(f.model).business_code,'M841');
});
function setup(){
  const ctx={URL,URLSearchParams,CSS:{escape:x=>x},console,setTimeout:()=>1,clearTimeout(){},location:{href:'http://isolated/?workspace=settings.workspace'},history:{replaceState(_a,_b,u){ctx.location.href=String(u)}},localStorage:{getItem:()=>null},document:{addEventListener(){},querySelector:()=>null,querySelectorAll:()=>[],createElement:tag=>new Element(tag),createElementNS:(_ns,tag)=>new Element(tag)}};
  ctx.Option=function(text,value){const e=new Element('option');e.textContent=text;e.value=value;return e};
  vm.createContext(ctx);require('./load_review_helpers.cjs')(ctx);
  for(const name of ['app.js','production.js','material-review.js','entity-review.js','production-breakdown.js','unified-cards.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static',name),'utf8'),ctx);
  vm.runInContext('globalThis.state=state',ctx);ctx.state.workspace='settings.workspace';
  for(const fn of ['renderProductionReader','renderComments','paintProductionReview'])ctx[fn]=()=>{};
  ctx.scrollBreakdownTarget=()=>{};ctx.rememberBreakdownPosition=()=>{};ctx.requestAnimationFrame=()=>1;ctx.window={scrollY:0,addEventListener(){},removeEventListener(){},scrollTo(){}};
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

test('complete cards on every story page own exact comments and drafts until parent restoration',()=>{
  for(const workspace of ['story.sources','story.outline','story.script']){
    const ctx=setup();ctx.state.workspace=workspace;ctx.state.current={id:'source',target_revision_id:'source-r1'};
    ctx.state.structureRevision='structure-r1';ctx.scriptEpisode=()=>({object_id:'episode',id:'episode-r4'});
    const outer=vm.runInContext('JSON.stringify(commentTarget())',ctx),anchor={type:'text',block_id:'old-block',quote:'same quote'};
    ctx.state.anchor=anchor;const originalKey=vm.runInContext('draftKey()',ctx);
    ctx.state.unifiedCardRoot={isConnected:true};ctx.state.productionSelected={object_id:'old-asset',id:'old-asset-r1',payload:{blocks:[]}};
    assert.equal(vm.runInContext('isProduction()',ctx),true);assert.equal(vm.runInContext('isProductionWorkspace()',ctx),false);
    assert.equal(vm.runInContext('isScript() || isStructure()',ctx),false);
    assert.equal(vm.runInContext('JSON.stringify(commentTarget())',ctx),JSON.stringify({target_object_id:'old-asset',target_revision_id:'old-asset-r1'}));
    assert.notEqual(vm.runInContext('draftKey()',ctx),originalKey);
    // Native close removes DOM before saving the card's draft.
    ctx.state.unifiedCardRoot.isConnected=false;assert.equal(vm.runInContext('isProduction()',ctx),true);
    ctx.state.unifiedCardRoot=null;assert.equal(vm.runInContext('JSON.stringify(commentTarget())',ctx),outer);
    assert.equal(vm.runInContext('draftKey()',ctx),originalKey);
  }
});

test('story-hosted complete cards locate production comments and select only their exact text surface',()=>{
  const ctx=setup();ctx.state.workspace='story.script';ctx.state.productionSelected={object_id:'edge',id:'edge-old',payload:{blocks:[]}};
  const range={startContainer:{},endContainer:{}},surface={dataset:{productionBlocks:'edge-old'},contains:()=>true};
  ctx.state.unifiedCardRoot={querySelectorAll:()=>[surface]};ctx.getSelection=()=>({rangeCount:1,getRangeAt:()=>range});
  ctx.productionTextBlocks=()=>['exact blocks'];ctx.textSelectionAnchor=(host,blocks)=>({host,blocks});
  ctx.textSelectionRange=(host,r)=>host.contains(r.startContainer)&&host.contains(r.endContainer)?r:null;
  assert.equal(ctx.selectedAnchor().host,surface);
  let located;ctx.locateProductionComment=comment=>{located=comment;return true};const comment={id:'old-opinion'};
  assert.equal(ctx.locateComment(comment),true);assert.equal(located,comment);
  surface.dataset.productionBlocks='another-r1';assert.equal(ctx.selectedAnchor(),null);
});

test('current version defaults to its latest candidate without changing adoption or selected components',()=>{
  const ctx=setup(),f=fixture(ctx);
  f.data.adoptions=[{payload:{scope:ref(f.form),slot:'overall',asset:ref(f.older),component_id:'original'}}];
  const before=JSON.stringify(f.data.adoptions);assert.equal(ctx.materialDefaultCandidate(f.model,f.data),f.newer.id);assert.equal(f.data.selectedComponents,undefined);assert.equal(JSON.stringify(f.data.adoptions),before);
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
test('the entity material renderer uses the candidate original and preserves adopted alternate-file metadata',()=>{
  const ctx=setup(),f=fixture(ctx);
  const second={...f.older.payload.components[0],id:'alternate',sha256:'alternate'};f.older.payload.components.push(second);f.round.results=[f.older];
  const media=[{record:f.older,component:f.older.payload.components[0],component_id:'original',state:ref(f.form)}];
  const model=ctx.entityReviewMaterialModels([f.need],media,f.data)[0];
  f.data.adoptions=[{payload:{scope:ref(f.form),slot:'overall',asset:ref(f.older),component_id:'alternate'}}];
  f.data.selectedCandidates={need:ctx.materialDefaultCandidate(model,f.data)};
  let visibleComponent;ctx.reviewSurface=host=>host;ctx.materialMedia=(_root,item)=>{visibleComponent=item.component.id};ctx.renderActualGeneration=()=>{};
  ctx.renderMaterialCard(new Element('main'),model,ctx.entityMaterialCandidateOptions(f.data,model));
  assert.equal(visibleComponent,'original');assert.equal(f.data.adoptions[0].payload.component_id,'alternate');
});
test('a preparing current version never borrows its historical adopted result',()=>{
  const ctx=setup(),f=fixture(ctx);
  f.data.adoptions=[{payload:{scope:ref(f.form),slot:'overall',asset:ref(f.older),component_id:'original'}}];
  f.data.material_versions.need.unshift({number:2,model:'plan-v1',plan:f.need,members:[f.need],results:[]});
  f.data.selectedMaterialRounds={need:2};const models=ctx.materialRoundModels([f.need],f.items,f.data);
  assert.equal(models[0].round.number,2);assert.equal(models[0].candidates.length,0);
  assert.equal(ctx.materialDefaultCandidate(models[0],f.data),null);
});
test('ordinary demand cards choose the last generated version while exact and manual targets retain the empty version',()=>{
  const ctx=setup(),f=fixture(ctx),latest={...f.need,id:'need-2',current_revision:'need-2',version:2};
  f.data.requirements=[latest];f.data.material_versions.need.unshift({number:2,model:'plan-v1',plan:latest,members:[latest],results:[]});
  const empty=new URLSearchParams();
  assert.equal(ctx.entityMaterialRoute(f.data,latest,empty,{defaultSelection:true}).selected.round.number,1);
  assert.equal(ctx.entityMaterialRoute(f.data,latest,empty).selected.round.number,2);
  assert.equal(ctx.entityMaterialRoute(f.data,latest,new URLSearchParams({material_version:2}),{defaultSelection:true}).selected.round.number,2);
  assert.equal(ctx.entityMaterialRoute(f.data,latest,new URLSearchParams({material_target:'need-2'}),{defaultSelection:true}).selected.round.number,2);
  assert.equal(f.data.selectedMaterialRounds,undefined);
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
  const first=control.children.find(n=>n.dataset.choiceId==='old').onclick();await new Promise(done=>setImmediate(done));const last=control.children.find(n=>n.dataset.choiceId===f.entity.id).onclick();await new Promise(done=>setImmediate(done));
  requests[1].resolve({record:f.entity});await last;requests[0].resolve({record:{...f.entity,id:'old'}});await first;
  assert.deepEqual(shown,[f.entity.id]);
});
test('a response to a detached entity version control cannot restore its obsolete selection',async()=>{
  const ctx=setup(),f=fixture(ctx),shown=[];let release,control;
  f.data.versions={[f.entity.object_id]:[{id:'old',version:1},{id:f.entity.id,version:2}]};
  ctx.fetch=()=>new Promise(resolve=>{release=value=>resolve({ok:true,json:async()=>value})});
  ctx.entityVersionControl({append:n=>control=n},f.entity,r=>shown.push(r.id));
  const request=control.children.find(n=>n.dataset.choiceId==='old').onclick();await new Promise(done=>setImmediate(done));control.isConnected=false;
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
  const triggers=['#comments-toggle','#screenplay-comments'].map(selector=>[selector,new Element('button')]);
  // index.html starts with comments hidden and both existing toggles collapsed.
  panel.hidden=true;for(const [,button] of triggers){button.setAttribute('aria-expanded','false');outer.append(button)}
  const nodes=new Map([['#comment-panel',panel],...triggers]);ctx.document.querySelector=s=>nodes.get(s)||null;
  ctx.openReviewDialog=()=>({dialog,body});ctx.renderUnifiedCard=()=>{};
  const result={detail:{record:f.need,history:[f.need],material_versions:f.data.material_versions},entity_review:f.data,form:f.form};
  return {panel,outer,dialog,body,result,triggers:triggers.map(([,button])=>button)};
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
test('closing during a second reference save waits for that response instead of refreshing the earlier receipt',async()=>{
  for(const pending of [true,false]){
    const ctx=setup(),f=fixture(ctx),m=modalFixture(ctx,f),receipts=[];
    ctx.fetch=async()=>({ok:true,json:async()=>m.result});
    const selection={saved:{number:1},pending,onSaved:result=>receipts.push(result)};
    await ctx.openUnifiedMaterial({...ref(f.need),shotReference:selection},null);
    m.dialog.isConnected=false;m.dialog.listeners.close();
    assert.equal(receipts.length,pending?0:1);
  }
});
test('saving the restored outer draft cannot overwrite a closed modal draft',async()=>{
  const ctx=setup(),f=fixture(ctx),m=modalFixture(ctx,f);
  ctx.restoreProductionDraft();ctx.state.anchor={type:'global'};ctx.state.editing='outer-comment';
  ctx.fetch=async()=>({ok:true,json:async()=>m.result});await ctx.openUnifiedMaterial(ref(f.need),null);
  ctx.setPanelOpen(true);
  ctx.state.anchor={type:'global'};ctx.state.editing='inner-comment';const innerKey=ctx.productionDraftKey();
  m.dialog.isConnected=false;m.dialog.listeners.close();
  assert.equal(ctx.state.editing,'outer-comment');ctx.rememberProductionDraft();
  assert.equal(ctx.state.productionDraftContexts[innerKey].editing,'inner-comment');
  assert.equal(m.panel.hidden,true);for(const button of m.triggers)assert.equal(button.attributes['aria-expanded'],'false');
});
test('an exact historical shot link preserves its requested revision in the all-shot scene reader',async()=>{
  const ctx=setup(),source={object_id:'episode',revision_id:'episode-1',scene_id:'scene'};
  const scene=row('scene','AV_SCENE',undefined,{source});
  const current=row('shot','AV_SHOT','shot-current',{parent:ref(scene),source,number:1,fps:24,duration_frames:120});
  const original={...current,id:'shot-original',version:1,payload:{...current.payload,title:'Original shot design'}};
  const sceneData={scene,shared:[],shots:[{record:original,context:{requirements:[],materials:[]}}]};
  ctx.state.breakdownData={episode:'episode',shots:[original]};ctx.state.productionRecords=[scene,current];
  ctx.document.createTextNode=text=>({textContent:text});ctx.reviewSurface=host=>host;ctx.paintReviewCommentCounts=()=>{};
  ctx.fetch=async url=>({ok:true,json:async()=>String(url).includes('/api/production/scene?')?sceneData:{record:original,history:[current,original],uses:[]}});
  const params=new URLSearchParams({breakdown_object:'shot',breakdown_revision:'shot-original'});
  await ctx.showBreakdownScene(scene,new Element('main'),new Element('nav'),0,params);
  assert.equal(ctx.state.productionSelected.id,'shot-original');
  assert.equal(new URL(ctx.location.href).searchParams.get('breakdown_revision'),'shot-original');
});

function genericMaterialFixture(ctx){
  const scope=row('scene','AV_SCENE'),plan=number=>row('video-need','REQUIREMENT','plan-'+number,{
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
function preparingRevisionFixture(ctx){
  const f=genericMaterialFixture(ctx),old=f.plan(1),current=f.plan(2);
  for(const [revision,label] of [[old,'original'],[current,'current']]){
    revision.payload.blocks=[{id:'purpose',text:label+' requirement'}];
    revision.payload.generation.output.description=label+' description';
    revision.payload.generation.parameters={duration:label==='original'?12:18};
    revision.payload.generation.inputs=[{reference:{object_id:'image',revision_id:label+'-image'},use:label+' input'}];
  }
  old.current_revision=current.id;old.review_shot_slots=[];current.review_shot_slots=[];
  f.rounds.splice(0,f.rounds.length,{number:1,model:'plan-v1',frozen:false,plan:current,members:[old,current],results:[],definition_records:{requirement:current}});
  Object.assign(f.detail,{record:old,history:[current,old],explicitRevision:true});
  ctx.state.productionSelected=old;ctx.state.productionRecords=[f.scope,old,current];
  const controls=[],inputs=[];
  ctx.renderProductionAcceptance=(_host,need)=>controls.push(['accept',need.id]);
  ctx.renderMaterialRouteChoices=(_host,need)=>controls.push(['route',need.id]);
  ctx.renderShotInputs=(_host,need)=>controls.push(['edit-inputs',need.id]);
  ctx.renderShotReferenceChoice=()=>controls.push(['reference-choice']);
  ctx.renderMaterialAdoptionControls=()=>controls.push(['adopt']);
  ctx.renderMaterialInputs=(_host,values,_records,need)=>inputs.push([need.id,values[0]?.reference.revision_id]);
  return {...f,old,current,controls,inputs};
}
test('an exact earlier preparation revision keeps its own requirements, prompt and comment targets without editing the latest plan',()=>{
  const ctx=setup(),f=preparingRevisionFixture(ctx),before=JSON.stringify(f.rounds),root=f.render();
  const nodes=descendants(root),text=nodes.map(n=>n.textContent||'').join('\n');
  assert.match(text,/plan 1/);assert.doesNotMatch(text,/plan 2/);assert.match(text,/生成方案/);
  assert.match(text,/original requirement/);assert.match(text,/original description/);assert.doesNotMatch(text,/current requirement|current description/);assert.match(text,/"duration": 12/);assert.doesNotMatch(text,/"duration": 18/);
  assert.ok(nodes.some(n=>n.dataset?.productionBlocks===f.old.id));assert.ok(!nodes.some(n=>n.dataset?.productionBlocks===f.current.id));
  assert.deepEqual(f.inputs,[[f.old.id,'original-image']]);assert.deepEqual(f.controls,[['accept',f.old.id]]);assert.equal(JSON.stringify(f.rounds),before);
  assert.equal(ctx.materialCommentContext().number,1);assert.equal(ctx.state.productionSelected.id,f.old.id);
});
for(const explicit of [false,true])test(`${explicit?'exact current':'ordinary'} preparation entry still shows the editable current plan`,()=>{
  const ctx=setup(),f=preparingRevisionFixture(ctx);f.detail.explicitRevision=explicit;if(explicit)f.detail.record=f.current;
  const text=descendants(f.render()).map(n=>n.textContent||'').join('\n');
  assert.match(text,/current requirement/);assert.match(text,/plan 2/);assert.doesNotMatch(text,/plan 1/);assert.doesNotMatch(text,/原方案/);
  assert.ok(f.controls.some(([kind,id])=>kind==='edit-inputs'&&id===f.current.id));assert.ok(f.controls.some(([kind])=>kind==='accept'));assert.deepEqual(f.inputs,[]);
});
test('an earlier demand reads its original definition separately without rewriting a frozen material version',()=>{
  const ctx=setup(),f=preparingRevisionFixture(ctx);f.rounds[0].frozen=true;
  const before=JSON.stringify(f.rounds);
  const text=descendants(f.render()).map(n=>n.textContent||'').join('\n');
  assert.match(text,/plan 1/);assert.doesNotMatch(text,/plan 2/);assert.match(text,/生成方案/);
  assert.equal(JSON.stringify(f.rounds),before);assert.deepEqual(f.controls,[['accept',f.old.id]]);
});
test('a frozen definition source outside the member list remains a requirement without creating an editable recipe',()=>{
  const ctx=setup(),f=preparingRevisionFixture(ctx);Object.assign(f.rounds[0],{frozen:true,plan:null,members:[],definition_records:{requirement:f.old}});f.detail.selectedMaterialRounds={'video-need':1};f.detail.localPlans={'video-need':f.old};
  const text=descendants(f.render()).map(n=>n.textContent||'').join('\n');
  assert.match(text,/original requirement/);assert.match(text,/plan 1/);assert.deepEqual(f.inputs,[[f.old.id,'original-image']]);assert.ok(!f.controls.some(([kind])=>kind==='edit-inputs'||kind==='route'));
});
test('locating an older demand in a frozen empty version reads its own requirements and recipe without saving controls',()=>{
  const ctx=setup(),f=preparingRevisionFixture(ctx);f.rounds[0].frozen=true;f.detail.localPlans={'video-need':f.old};
  const text=descendants(f.render()).map(n=>n.textContent||'').join('\n');
  assert.match(text,/original requirement/);assert.doesNotMatch(text,/current requirement/);assert.match(text,/plan 1/);assert.match(text,/生成方案/);
  assert.deepEqual(f.inputs,[[f.old.id,'original-image']]);assert.deepEqual(f.controls,[['accept',f.old.id]]);
});
test('returning from another material version leaves an old explicit preparation link and reads that version normally',()=>{
  const ctx=setup(),f=preparingRevisionFixture(ctx),next=f.plan(3);
  f.rounds.unshift({number:2,model:'plan-v1',plan:next,members:[next],results:[]});f.render();
  ctx.switchMaterialRound(f.detail,'video-need',2);f.render();ctx.switchMaterialRound(f.detail,'video-need',1);
  const text=descendants(f.render()).map(n=>n.textContent||'').join('\n');
  assert.match(text,/current requirement/);assert.match(text,/plan 2/);assert.doesNotMatch(text,/plan 1/);assert.equal(f.detail.explicitRevision,false);
});
test('a non-entity demand defaults to the latest candidate original without copying adoption range',()=>{
  const ctx=setup(),f=genericMaterialFixture(ctx);f.render();
  assert.equal(f.shown.length,1);assert.equal(f.shown[0].record.id,f.new2.id);assert.equal(f.shown[0].component.id,'original');assert.equal(f.shown[0].range,undefined);
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
test('selecting a non-entity candidate focuses its exact revision without changing the material comment version',async()=>{
  const ctx=setup(),f=genericMaterialFixture(ctx),root=f.render();
  const candidates=descendants(root).find(n=>n.attributes?.['aria-label']==='本轮候选');
  await candidates.children.find(n=>n.dataset.choiceId===f.old2.id).onclick();await descendants(f.render()).find(n=>n.attributes?.['aria-label']==='本轮候选').children.find(n=>n.dataset.choiceId===f.new2.id).onclick();f.render();
  assert.equal(f.shown[0].record.id,f.new2.id);assert.equal(ctx.state.productionSelected.id,f.new2.id);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.materialCommentContext())),{material_id:'video-need',number:2,model:'plan-v1'});
  assert.equal(new URL(ctx.location.href).searchParams.get('material_target'),f.new2.id);
});
test('an explicit non-entity file choice can replace the adopted default without reverting on repaint',()=>{
  const ctx=setup(),f=genericMaterialFixture(ctx);f.detail.selectedCandidateId=f.old2.id;f.detail.selectedComponents={[f.old2.id]:'alternate'};const root=f.render();
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
  ctx.setPanelOpen(true);
  const g=installImageGesture(ctx,old,m.body);ctx.state.drawMode='original';g.emit('pointerdown');
  m.dialog.isConnected=false;m.dialog.listeners.close();
  assert.equal(ctx.state.productionSelected.id,'image-new');assert.equal(ctx.state.anchor,outerAnchor);
  assert.equal(m.panel.hidden,true);for(const button of m.triggers)assert.equal(button.attributes['aria-expanded'],'false');
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

// Append to tests/ui_unification_compatibility.test.cjs; reuse its existing fixtures.
function ux010SelectionFixture(){
  const ctx=setup(),f=fixture(ctx),other=row('other-entity','ENTITY',undefined,{entity_type:'prop'}),otherForm=row('other-form','STATE',undefined,{entity:ref(other),state_model:'complete-v1'});
  const otherData={entity:other,states:[otherForm],media:[],requirements:[],relationships:[],comment_records:[],comment_targets:[]};
  ctx.state.productionRecords.push(other,otherForm);ctx.state.productionEntityId=f.entity.object_id;
  ctx.state.productionVisibleEntities=new Set([f.entity.object_id,other.object_id]);
  ctx.location.href='http://isolated/?workspace=settings.workspace&production_tab=entities&production_entity='+f.entity.object_id+'&production_object='+f.form.object_id;
  const cards=[f.entity,other].map(record=>{const button=new Element('button');button.dataset.objectId=record.object_id;button.active=record===f.entity;button.classList.toggle=(name,value)=>{if(name==='active')button.active=!!value};button.setAttribute('aria-pressed',String(record===f.entity));return button});
  const unrelated=new Element('button');cards.push(unrelated);ctx.document.querySelectorAll=selector=>selector==='#production-index button'?cards:[];
  const records=[...ctx.state.productionRecords],details=new Map(records.map(record=>[record.id,record]));
  ctx.ux010Read=async url=>{const p=new URL(url,'http://isolated');if(p.pathname==='/api/production/entity-review')return structuredClone(p.searchParams.get('entity_id')===other.object_id?otherData:f.data);const record=p.searchParams.has('revision_id')?details.get(p.searchParams.get('revision_id')):records.find(r=>r.object_id===p.searchParams.get('object_id'));assert.ok(record,'unexpected record '+url);return {record,history:[record],uses:[]}};
  ctx.fetch=async url=>({ok:true,json:async()=>ctx.ux010Read(url)});
  const markers=()=>cards.map(button=>({id:button.dataset.objectId,active:button.active,pressed:button.attributes['aria-pressed']}));
  const snapshot=()=>({owner:ctx.state.productionEntityId,selected:ctx.state.productionSelected.id,url:ctx.location.href,markers:markers()});
  const expectOwner=owner=>{assert.equal(ctx.state.productionEntityId,owner);assert.equal(new URL(ctx.location.href).searchParams.get('production_entity'),owner);for(const b of cards.filter(b=>b.dataset.objectId)){assert.equal(b.active,b.dataset.objectId===owner);assert.equal(b.attributes['aria-pressed'],String(b.dataset.objectId===owner))}assert.equal(unrelated.attributes['aria-pressed'],undefined)};
  return {ctx,f,other,otherForm,otherData,cards,details,markers,snapshot,expectOwner};
}
const ux010Deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}};
const ux010Drain=()=>new Promise(resolve=>setImmediate(resolve));
test('UX010 entity selection synchronizes both markers while exact historical targets retain their owner',async()=>{
  const x=ux010SelectionFixture(),{ctx}=x;await ctx.openProductionRecord(x.other.object_id);x.expectOwner(x.other.object_id);assert.equal(ctx.state.productionSelected.id,x.otherForm.id);
  for(const current of [x.other,x.otherForm]){const old={...current,id:current.id+'-old',version:0};x.details.set(old.id,old);await ctx.openProductionRecord(current.object_id,old.id);x.expectOwner(x.other.object_id);assert.equal(ctx.state.productionSelected.id,old.id);assert.equal(new URL(ctx.location.href).searchParams.get('production_revision'),old.id)}
  await ctx.openProductionRecord(x.f.entity.object_id);x.expectOwner(x.f.entity.object_id);
});
for(const stage of ['record','aggregate'])test('UX010 failed '+stage+' read preserves completed reader and selection',async()=>{
  const x=ux010SelectionFixture(),read=x.ctx.ux010Read,before=x.snapshot();x.ctx.ux010Read=url=>url.includes(stage==='record'?'object_id=other-entity':'entity_id=other-entity')?Promise.reject(Error('expected read failure')):read(url);
  await assert.rejects(x.ctx.openProductionRecord(x.other.object_id),/expected read failure/);assert.deepEqual(x.snapshot(),before);
});
for(const stage of ['record','aggregate'])test('UX010 stale '+stage+' success cannot replace newer reader or either marker',async()=>{
  const x=ux010SelectionFixture(),read=x.ctx.ux010Read,held=ux010Deferred();x.ctx.ux010Read=url=>url.includes(stage==='record'?'object_id=other-entity':'entity_id=other-entity')?held.promise:read(url);
  const pending=x.ctx.openProductionRecord(x.other.object_id);await ux010Drain();await x.ctx.openProductionRecord(x.f.entity.object_id);const newest=x.snapshot();held.resolve(stage==='record'?{record:x.other}:structuredClone(x.otherData));await pending;assert.deepEqual(x.snapshot(),newest);
});
function ux010ModalFixture(){
  const x=ux010SelectionFixture(),{ctx,f}=x,m=modalFixture(ctx,f);
  Object.assign(ctx.state,{entityReview:x.otherData,productionSelected:x.otherForm,productionDetail:{record:x.otherForm},productionChildDetail:{record:x.otherForm},productionEntityDetail:{record:x.other},productionEntityId:x.other.object_id});
  for(const b of x.cards.filter(b=>b.dataset.objectId)){b.active=b.dataset.objectId===x.other.object_id;b.setAttribute('aria-pressed',String(b.active))}
  ctx.location.href='http://isolated/?workspace=settings.workspace&production_tab=entities&production_entity='+x.other.object_id+'&production_object='+x.otherForm.object_id;
  const before=x.snapshot(),read=ctx.ux010Read;ctx.ux010Read=url=>url.includes('/api/production/card?')?Promise.resolve({...m.result,params:new URLSearchParams(),explicit:true}):read(url);
  const open=()=>ctx.openUnifiedMaterial(ref(f.need),null),close=()=>{m.dialog.isConnected=false;m.dialog.listeners.close()};return {...x,m,before,open,close};
}
test('UX010 modal entity refresh does not alter the outer list and closing restores its reader',async()=>{
  const x=ux010ModalFixture();await x.open();assert.deepEqual(x.markers(),x.before.markers);await x.ctx.reloadEntityReview();assert.equal(x.ctx.state.entityReview.entity.object_id,x.f.entity.object_id);assert.deepEqual(x.markers(),x.before.markers);x.close();assert.deepEqual(x.snapshot(),x.before);
});
test('UX010 modal refresh completing after close cannot overwrite the restored outer context',async()=>{
  const x=ux010ModalFixture();await x.open();const held=ux010Deferred();x.ctx.ux010Read=()=>held.promise;const pending=x.ctx.reloadEntityReview();x.close();assert.deepEqual(x.snapshot(),x.before);held.resolve(structuredClone(x.f.data));await pending;assert.deepEqual(x.snapshot(),x.before);
});
test('UX010 outer refresh completing after a modal opens cannot overwrite the inner context',async()=>{
  const x=ux010ModalFixture(),read=x.ctx.ux010Read,held=ux010Deferred();x.ctx.ux010Read=url=>url.includes('/entity-review?')?held.promise:read(url);const pending=x.ctx.reloadEntityReview();await x.open();const inner=x.snapshot();held.resolve(structuredClone(x.otherData));await pending;assert.deepEqual(x.snapshot(),inner);assert.equal(x.ctx.state.entityReview.entity.object_id,x.f.entity.object_id);x.close();assert.deepEqual(x.snapshot(),x.before);
});
test('shared requirement cards prefer their actual identity over an earlier legacy alias',()=>{
  const ctx=setup(),f=fixture(ctx),row={...f.need,current_revision:f.need.id,material_identity:{id:'need',aliases:['legacy','need']}};
  f.data.material_versions={legacy:[f.round],need:[f.round]};
  assert.equal(ctx.entityMaterialRoute(f.data,row,new URLSearchParams(),{defaultSelection:true}).selected.material_id,'need');
  assert.equal(ctx.entityMaterialRoute(f.data,row,new URLSearchParams({material_id:'legacy',material_version:1})).selected.material_id,'legacy');
});
test('an exact shared alias retains its own round and members inside the unified card',()=>{
  const ctx=setup(),f=fixture(ctx),alias={...f.need,object_id:'legacy-voice',id:'legacy-plan',material_identity:{id:'need',aliases:['need','legacy-voice']}};
  f.need.material_identity=alias.material_identity;f.data.requirements=[f.need,alias];
  const old={...f.round,number:1,plan:alias,members:[alias,f.older],results:[f.older]};
  f.data.material_versions['legacy-voice']=[old];f.data.selectedMaterialRounds={'legacy-voice':1};
  ctx.state.materialCommentCard={data:f.data,material_id:'legacy-voice',number:1};ctx.state.productionSelected=alias;
  const models=ctx.entityReviewMaterialModels([f.need],f.items,f.data);
  const selected=ctx.unifiedModelSelection(models,f.data);
  assert.equal(selected.material_id,'legacy-voice');assert.equal(selected.round.number,1);
  assert.deepEqual(selected.round.members.map(r=>r.id),['legacy-plan',f.older.id]);
  assert.equal(selected.candidates.length,1);assert.equal(selected.candidates[0].record.id,f.older.id);
  assert.ok(models.some(m=>m.material_id==='need'),'other current state material remains available');
});
