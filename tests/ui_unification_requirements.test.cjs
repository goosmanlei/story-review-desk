// Independent regressions for task-0008 findings; DOM stubs do not certify layout.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');

class Element {
  constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.attributes={};this.style={};this.className='';this.value='';this.isConnected=true;this.classList={add(){},remove(){},toggle(){}}}
  append(...nodes){for(const node of nodes){node.parentNode=this;this.children.push(node)}}
  prepend(...nodes){for(const node of nodes)node.parentNode=this;this.children.unshift(...nodes)}
  replaceChildren(...nodes){this.children=[];this.append(...nodes)}
  remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(n=>n!==this);this.isConnected=false}
  setAttribute(key,value){this.attributes[key]=String(value)}
  getAttribute(key){return this.attributes[key]}
  addEventListener(){}
  focus(){}
  all(){return this.children.flatMap(node=>[node,...node.all()])}
  get childNodes(){return this.children}
  get childElementCount(){return this.children.length}
  get textContent(){return (this.ownText||'')+this.children.map(n=>n.textContent).join('')}
  set textContent(text){this.ownText=String(text);this.children=[]}
  querySelectorAll(selector){return this.all().filter(node=>selector==='[data-material-id]'?!!node.dataset.materialId:selector==='select'?node.tag==='select':false)}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null}
}
function fixture(){
  const host=new Element('main'),reader=new Element('article');reader.id='production-reader';host.append(reader);
  const c={URL,URLSearchParams,CSS:{escape:v=>v},state:{workspace:'materials.workspace',productionRecords:[],comments:[]},location:{href:'http://fixture/?workspace=materials.workspace'},setTimeout,clearTimeout,getSelection:()=>({isCollapsed:true}),console};
  c.el=(tag,classes)=>{const n=new Element(tag);n.className=classes||'';return n};
  c.nodeText=(tag,classes,text,parent)=>{const n=c.el(tag,classes);n.textContent=text;parent.append(n);return n};
  c.Option=function(text,value){const n=new Element('option');n.textContent=text;n.value=value;return n};
  c.document={createTextNode:text=>{const n=new Element('#text');n.textContent=text;return n},querySelectorAll:()=>[],querySelector:()=>null};
  c.$=selector=>selector==='#production-view'?host:host.all().find(n=>n.id===selector.slice(1));
  c.history={replaceState(_a,_b,url){c.location.href=String(url)},pushState(_a,_b,url){c.location.href=String(url)}};
  c.isProduction=()=>true;c.reviewSurface=node=>node;
  vm.createContext(c);
  for(const name of ['production.js','material-review.js','entity-review.js','production-breakdown.js','unified-cards.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static',name),'utf8'),c);
  c.renderComments=()=>{};c.paintProductionReview=()=>{};c.paintReviewCommentCounts=()=>{};c.rememberProductionDraft=()=>{};c.restoreProductionDraft=()=>{};
  c.productionEntityIcon=()=>new Element('svg');c.materialReferenceLink=(parent,ref,label)=>{const n=c.nodeText('a',null,label,parent);n.reference=ref;return n};
  c.productionTextBlocks=row=>Object.entries(row.payload.generation?{'generation.prompt':row.payload.generation.prompt}:{'call.prompt':row.payload.prompt}).filter(([,text])=>typeof text==='string').map(([field,text])=>({id:field,field,text}));
  c.materialReferenceRequest=ref=>({url:'/?revision='+ref.revision_id});
  c.openMaterialReference=()=>{};c.toast=message=>{throw Error(message)};
  return {c,host,reader};
}
const row=(object_id,kind,payload={},id=object_id+'-r1')=>({object_id,id,current_revision:id,kind,version:1,created_at:'2026-10-04',payload:{title:object_id,blocks:[],...payload}});
const ref=r=>({object_id:r.object_id,revision_id:r.id});
function material(){
  const need=row('need','REQUIREMENT',{media_type:'image',slot:'overall',scope:{object_id:'form',revision_id:'form-r1'}});
  const asset=row('asset','ASSET',{media_type:'image',candidate_requirements:[ref(need)],components:[{id:'original',role:'original',mime:'image/png'},{id:'preview',role:'preview',mime:'image/png'}]});
  const round={number:1,model:'plan-v1',plan:need,members:[need,asset],results:[asset]};
  return {need,asset,round};
}

test('5.3/5.8 expanding a second left group retains one selected material and paints the right once',()=>{
  const {c,reader}=fixture(),{need,asset,round}=material();
  const legacy=row('legacy','ASSET',{media_type:'audio',components:[{id:'original',role:'original',mime:'audio/wav'}]});
  const data={unifiedMaterialId:need.object_id};c.state.entityReview=data;
  c.renderEntityReview=left=>{c.renderUnifiedModels(left,[{need,candidates:[{record:asset}],round,rounds:[round],material_id:need.object_id}],data);c.renderUnifiedModels(left,[{identity:legacy,candidates:[{record:legacy}]}],data)};
  const painted=[];c.renderMaterialCard=(_parent,model)=>painted.push(c.materialModelKey(model));
  c.renderUnifiedCard(reader);
  assert.deepEqual(painted,['need']);assert.equal(data.unifiedMaterialId,'need');
  assert.deepEqual(reader.querySelectorAll('[data-material-id]').map(n=>[n.dataset.materialId,n.getAttribute('aria-pressed')]),[['need','true'],['legacy','false']]);
  data.unifiedMaterialId='legacy';painted.length=0;c.state.materialCommentCard=null;c.renderUnifiedCard(reader);
  assert.deepEqual(painted,['legacy']);assert.equal(data.unifiedMaterialId,'legacy');
});

test('5.4 entity material exposes all files and renders the explicitly chosen component',()=>{
  const {c,reader}=fixture(),{need,asset,round}=material();
  const data={material_versions:{need:[round]},media:[{id:'placement',record:asset,component:asset.payload.components[0]}]};
  const model=c.materialRoundModels([need],data.media,data)[0],shown=[];
  c.materialMedia=(_parent,item)=>shown.push(item.component.id);c.renderActualGeneration=()=>{};c.materialTextSurface=parent=>parent;c.materialField=()=>{};
  c.renderMaterialCard(reader,model,{selectedCandidateId:asset.id,selectCandidate(){},selectedComponents:{[asset.id]:'preview'},selectComponent(){},roundChange(){}});
  assert.deepEqual(shown,['preview']);
  const select=reader.all().find(n=>n.attributes['aria-label']==='原件与预览组成');
  assert.ok(select);assert.deepEqual(select.children.map(n=>n.value),['original','preview']);assert.equal(select.value,'preview');
});

for(const kind of ['CALL','JUDGMENT'])test(`5.6/C.3 historical ${kind} keeps its generic exact reader rather than becoming an asset`,()=>{
  const {c}=fixture(),record=row('history',kind),detail={record,history:[record],uses:[]};
  c.focusProductionReview=d=>{c.state.productionSelected=d.record;c.state.productionDetail=d};
  const shown=[];c.renderProductionRecord=(_root,value)=>shown.push(value.record.id);
  c.activateUnifiedCard({detail,entity_review:null,scope:null,params:new URLSearchParams(),explicit:true});c.renderProductionReader();
  assert.equal(c.state.materialReview,null);assert.deepEqual(shown,[record.id]);assert.equal(c.state.productionSelected.id,record.id);
});

function videoFixture(){
  const f=fixture(),input=row('input-old','ASSET',{media_type:'image',components:[{id:'original',role:'original',mime:'image/png'}]});
  const need=row('video-need','REQUIREMENT',{media_type:'video',slot:'video',generation:{model:'plan-model',prompt:'CURRENT PLAN must not replace history',inputs:[],parameters:{}}});
  const call=row('actual-call','CALL',{model:'actual-model',prompt:'先看🧵 @图片1，再保留两行\n末行。',inputs:[{...ref(input),component_id:'original'}],parameters:{}});
  const asset=row('video-result','ASSET',{media_type:'video',components:[{id:'original',role:'original',mime:'video/mp4'}],production:ref(call)});
  const round={number:1,model:'plan-v1',plan:need,members:[need,call,asset],results:[asset]};
  const context={adoptions:[],video_details:{[need.object_id]:{record:need,material_versions:{[need.object_id]:[round]},review_contexts:{[asset.id]:{call,inputs:[input],requirements:[need]}}}}};
  return {...f,input,need,call,asset,round,context};
}
test('10.2/10.4 selected generated video renders actual prompt and exact references without changing text',()=>{
  const {c,reader,need,call,input,context}=videoFixture();c.breakdownPrompt(reader,need,context);
  const prompt=reader.all().find(n=>n.className==='shot-generation-prompt');assert.equal(prompt.textContent,call.payload.prompt);assert.ok(!reader.textContent.includes(need.payload.generation.prompt));
  const inline=prompt.all().find(n=>n.tag==='a');assert.equal(inline.textContent,'@图片1');assert.equal(inline.href,'/?revision='+input.id);
  const above=reader.all().find(n=>n.reference);assert.equal(above.reference.revision_id,input.id);assert.equal(above.reference.component_id,'original');
});
test('10.4 candidate without a real call reports the gap and never fills it from the plan',()=>{
  const {c,reader,need,context,asset}=videoFixture();delete context.video_details[need.object_id].review_contexts[asset.id];c.breakdownPrompt(reader,need,context);
  assert.match(reader.textContent,/未登记真实调用/);assert.ok(!reader.textContent.includes(need.payload.generation.prompt));
});
test('5.7/10.4 empty current video version stays empty until the user selects the historical version',()=>{
  const {c,reader,need,call,round,context}=videoFixture();context.video_details[need.object_id].material_versions[need.object_id].unshift({...round,number:2,members:[need],results:[]});
  c.breakdownPrompt(reader,need,context);assert.match(reader.textContent,/待生成/);assert.ok(reader.textContent.includes(need.payload.generation.prompt));assert.ok(!reader.textContent.includes(call.payload.prompt));
  const version=reader.all().find(n=>n.attributes['aria-label']==='素材版本');version.value=1;version.onchange();assert.ok(reader.textContent.includes(call.payload.prompt));assert.equal(c.state.breakdownVideoSelections[need.id].number,1);
});
test('10.1/10.4 row material opens the exact video version and candidate chosen beside its prompt',async()=>{
  const {c,reader,need,asset,call,round,context}=videoFixture();
  const other=row('video-other','ASSET',{...asset.payload},'video-other-r1');round.results.push(other);round.members.push(other);context.video_details[need.object_id].review_contexts[other.id]={call,inputs:[],requirements:[need]};
  context.video_details[need.object_id].material_versions[need.object_id].unshift({...round,number:2,members:[need],results:[]});
  const scene=row('scene','PREPARATION'),shot=row('shot','SHOT_DESIGN',{number:1,duration_frames:120,fps:24});
  Object.assign(context,{requirements:[need],materials:[{object_id:need.object_id,id:need.id,title:need.payload.title,media_type:'video',slot:'video',generated:true}],entities:[],states:[]});
  c.state.workspace='production.workspace';c.state.breakdownData={episode:'episode'};c.api=async()=>({scene,shared:[],shots:[{record:shot,context}]});c.breakdownSelect=()=>{};vm.runInContext('breakdownEpoch=7',c);
  const opened=[];c.openUnifiedMaterial=reference=>opened.push(reference);
  await c.showBreakdownScene(scene,reader,new Element('nav'),7);
  const version=reader.all().find(n=>n.attributes['aria-label']==='素材版本');version.value=1;version.onchange();
  const candidate=reader.all().find(n=>n.attributes['aria-label']==='视频候选');candidate.value=other.id;candidate.onchange();
  await reader.querySelectorAll('[data-material-id]')[0].onclick();
  assert.equal(opened.length,1);assert.equal(opened[0].object_id,need.object_id);assert.equal(opened[0].params.get('material_version'),'1');assert.equal(opened[0].params.get('material_target'),other.id);
});

async function materialListFixture(linked){
  const f=fixture(),{c}=f,{need,asset}=material(),candidate={...asset,object_id:'historical-candidate',id:'historical-candidate-r1'};
  const item={object_id:need.object_id,id:need.id,title:'A material',media_type:'image',generated:true};
  if(linked)c.location.href+='&production_object='+linked+'&production_revision='+linked+'-r1';
  const opened=[];
  c.api=async url=>{
    if(url.startsWith('/api/production/breakdown'))return {lock:null,scenes:[],shots:[],episodes:[]};
    if(url.startsWith('/api/production/card')){
      const target=new URL(url,'http://fixture').searchParams.get('object_id');opened.push(target);
      const record=target===candidate.object_id?candidate:need;
      return {entity_review:null,scope:null,adoption_context:null,detail:{record,history:[record],uses:[],material_versions:{need:[{number:1,model:'plan-v1',plan:need,members:[need,candidate],results:[candidate]}]}}};
    }
    return {items:[item],total:1,offset:0,limit:40,facets:{media:{'':1,image:1},status:{'':1,generated:1},episode:{'':1},scene:{'':1}}};
  };
  c.renderProductionReader=()=>{};
  await c.loadProductionMaterials();return {...f,opened};
}
test('8.2 automatic first material and direct demand links set the visible list selection',async()=>{
  for(const linked of [null,'need']){const {host,opened}=await materialListFixture(linked);assert.deepEqual(opened,['need']);assert.deepEqual(host.querySelectorAll('[data-material-id]').map(n=>n.getAttribute('aria-pressed')),['true'])}
});
test('8.2/C.2 historical candidate link selects its owning material in the list',async()=>{
  const {host,opened}=await materialListFixture('historical-candidate');assert.deepEqual(opened,['historical-candidate']);
  assert.deepEqual(host.querySelectorAll('[data-material-id]').map(n=>[n.dataset.materialId,n.getAttribute('aria-pressed')]),[['need','true']]);
});

function entityFilterFixture({exactMaterial=false}={}){
  const f=fixture(),{c,host}=f;
  const a=row('a-entity','ENTITY',{entity_type:'prop'}),b=row('b-entity','ENTITY',{entity_type:'character'});
  const form=entity=>row(entity.object_id+'-form','STATE',{entity:ref(entity),state_model:'complete-v1',sources:[]});
  const aForm=form(a),bForm=form(b),{need,asset,round}=material();need.payload.scope=ref(aForm);
  const currentNeed={...need,id:'need-r2',version:2},records=[a,b,aForm,bForm,currentNeed,asset];
  const review=entity=>({entity,states:[entity===a?aForm:bForm],requirements:entity===a?[currentNeed]:[],relationships:[],media:[],comment_records:[need,asset],comment_targets:[ref(need),ref(asset)],
    material_versions:entity===a?{need:[{number:2,model:'plan-v1',plan:currentNeed,members:[currentNeed],results:[]},round]}:{}});
  c.state.workspace='settings.workspace';c.state.screenplays=[];
  c.location.href='http://fixture/?workspace=settings.workspace&production_tab=entities'+(exactMaterial?'&production_object=asset&production_revision=asset-r1&production_entity=a-entity&entity_state=a-entity-form&material_id=need&material_version=1':'');
  const held=[],waiters=[],rendered=[];
  c.api=async url=>{
    const request=new URL(url,'http://fixture');
    if(request.pathname==='/api/production/index')return {records,entity_statuses:{'a-entity':'unaccepted','b-entity':'unaccepted'},entity_material_counts:{}};
    if(request.pathname==='/api/production/entity-review'){
      const entity=request.searchParams.get('entity_id')===a.object_id?a:b;
      return new Promise(resolve=>{held.push({entity,release:()=>resolve(structuredClone(review(entity)))});while(waiters.length)waiters.shift()()});
    }
    const record=records.find(r=>r.object_id===request.searchParams.get('object_id'));
    assert.ok(record,'unexpected production record request: '+url);return {record,history:[record],uses:[]};
  };
  c.renderProductionReader=()=>{rendered.push(c.state.productionSelected.id);const reader=c.state.unifiedCardRoot||c.$('#production-reader');reader.replaceChildren();c.nodeText('p',null,c.state.entityReview.entity.payload.title,reader)};
  const filter=(key,value)=>host.all().find(n=>n.dataset.filterKey===key&&n.dataset.filterValue===value);
  const clear=()=>host.all().find(n=>n.tag==='button'&&n.textContent==='清除筛选');
  const waiting=async count=>{while(held.length<count)await new Promise(resolve=>waiters.push(resolve))};
  return {...f,a,b,aForm,bForm,asset,held,rendered,filter,clear,waiting,review};
}
const drain=()=>new Promise(resolve=>setImmediate(resolve));

test('7.3/C.2 pending entity response cannot repopulate a filter with zero matches',async()=>{
  const f=entityFilterFixture(),loading=f.c.loadProductionWorkspace();await f.waiting(1);
  await f.filter('acceptance','accepted').onclick();assert.equal(f.c.state.productionVisibleEntities.size,0);
  f.held[0].release();await loading;
  assert.equal(f.c.state.entityReview,null);assert.equal(f.c.state.productionSelected,null);assert.deepEqual(f.rendered,[]);
  assert.match(f.c.$('#production-reader').textContent,/没有符合筛选条件的实体/);
  assert.ok(f.host.all().some(n=>n.textContent==='当前结果：0 个实体'));
});
test('7.3/C.2 clearing an empty filter opens a fresh first entity and ignores the older pending response',async()=>{
  const f=entityFilterFixture(),loading=f.c.loadProductionWorkspace();await f.waiting(1);
  await f.filter('acceptance','accepted').onclick();await f.clear().onclick();await f.waiting(2);
  f.held[1].release();await drain();assert.equal(f.c.state.productionEntityId,f.a.object_id);assert.deepEqual(f.rendered,[f.aForm.id]);
  f.held[0].release();await loading;assert.deepEqual(f.rendered,[f.aForm.id]);assert.equal(f.c.state.productionVisibleEntities.size,2);
});
test('7.3/C.2 a nonempty filter excludes a pending owner before its response can replace the new owner',async()=>{
  const f=entityFilterFixture(),loading=f.c.loadProductionWorkspace();await f.waiting(1);
  await f.filter('category','character').onclick();await f.waiting(2);assert.equal(f.held[1].entity.object_id,f.b.object_id);
  f.held[1].release();await drain();f.held[0].release();await loading;
  assert.equal(f.c.state.productionEntityId,f.b.object_id);assert.deepEqual(f.rendered,[f.bForm.id]);
});
test('5.6/7.3 exact entity material link and clearing a still-visible filter retain the requested old candidate',async()=>{
  const f=entityFilterFixture({exactMaterial:true}),loading=f.c.loadProductionWorkspace();await f.waiting(1);f.held[0].release();await loading;
  assert.equal(f.c.state.productionSelected.id,f.asset.id);assert.equal(f.c.state.entityReview.selectedMaterialRounds.need,1);
  await f.filter('acceptance','unaccepted').onclick();await f.clear().onclick();await drain();
  assert.equal(f.held.length,1);assert.equal(f.c.state.productionSelected.id,f.asset.id);assert.equal(f.c.state.entityReview.selectedMaterialRounds.need,1);
  const params=new URL(f.c.location.href).searchParams;assert.equal(params.get('production_revision'),f.asset.id);assert.equal(params.get('material_version'),'1');
});
test('7.3/C.2 a previous empty entity filter does not suppress card refreshes on the breakdown page',async()=>{
  const f=entityFilterFixture(),loading=f.c.loadProductionWorkspace();await f.waiting(1);await f.filter('acceptance','accepted').onclick();f.held[0].release();await loading;
  const read=f.c.api;f.c.api=url=>url.startsWith('/api/production/breakdown')?Promise.resolve({lock:null,scenes:[],shots:[],episodes:[]}):read(url);
  f.c.location.href='http://fixture/?workspace=settings.workspace&production_tab=breakdown';await f.c.loadProductionBreakdown();
  const old=f.review(f.a);f.c.activateUnifiedCard({detail:{record:f.a,history:[f.a],uses:[]},entity_review:old,scope:null,params:new URLSearchParams()});f.c.state.unifiedCardRoot=new Element('dialog');
  const refreshing=f.c.reloadEntityReview();await f.waiting(2);f.held[1].release();await refreshing;
  assert.notEqual(f.c.state.entityReview,old,'the inactive entity-list filter must not reject a breakdown card refresh');
  assert.equal(f.c.state.entityReview.entity.object_id,f.a.object_id);
});

async function focusedMaterialListFixture({explicitMaterial=false,outside=false,empty=false}={}){
  const f=fixture(),{c}=f,{need,asset,round}=material();
  const candidate={...asset,object_id:'historical-candidate',id:'historical-candidate-r1'};
  const currentNeed={...need,id:'need-r2',version:2};
  const target={object_id:need.object_id,id:currentNeed.id,title:'Linked material',media_type:'image',generated:true};
  const firstPage=Array.from({length:40},(_,i)=>({object_id:'first-'+i,id:'first-'+i+'-r1',title:'First '+i,media_type:'image',generated:true}));
  const listed=[],opened=[];let nextRender=null;
  c.location.href+='&production_object='+candidate.object_id+'&production_revision='+candidate.id;
  if(explicitMaterial)c.location.href+='&material_id=need&material_version=1&material_target='+candidate.id;
  if(outside)c.location.href+='&material_search=excluded';
  c.api=async url=>{
    if(url.startsWith('/api/production/breakdown'))return {lock:null,scenes:[],shots:[],episodes:[]};
    const params=new URL(url,'http://fixture').searchParams;
    if(url.startsWith('/api/production/card')){
      opened.push(Object.fromEntries(params));
      const exact=params.get('object_id')===candidate.object_id;
      const record=exact?candidate:row(params.get('object_id'),'REQUIREMENT',need.payload);
      const versions=exact?{need:[{...round,number:2,plan:currentNeed,members:[currentNeed],results:[]},{...round,members:[need,candidate],results:[candidate]}]}:{};
      return {entity_review:null,scope:null,adoption_context:null,detail:{record,history:[record],uses:[],material_versions:versions}};
    }
    listed.push(Object.fromEntries(params));
    const focused=params.has('focus'),offset=focused&&!outside?40:Number(params.get('offset'));
    const items=empty?[]:focused&&!outside?[target]:firstPage;
    const total=empty?0:outside?40:41;
    return {items,total,offset,limit:40,focused_outside:focused&&outside?target:null,facets:{media:{'':total,image:total},status:{'':total,generated:total},episode:{'':total},scene:{'':total}}};
  };
  c.renderProductionReader=()=>{nextRender?.();nextRender=null};
  await c.loadProductionMaterials();
  return {...f,need,candidate,listed,opened,rendered:()=>new Promise(resolve=>{nextRender=resolve})};
}
test('8.2/C.2 exact historical links beyond the first 40 materials focus the owning page and keep the old candidate',async()=>{
  for(const explicitMaterial of [false,true]){
    const f=await focusedMaterialListFixture({explicitMaterial});
    assert.equal(f.listed[0].focus,explicitMaterial?'need':'historical-candidate');
    assert.equal(f.listed[0].offset,'0');
    assert.deepEqual(f.host.querySelectorAll('[data-material-id]').map(n=>[n.dataset.materialId,n.getAttribute('aria-pressed')]),[['need','true']]);
    assert.equal(f.c.state.productionSelected.id,f.candidate.id);
    assert.deepEqual(f.opened,[{object_id:f.candidate.object_id,revision_id:f.candidate.id}]);
    if(explicitMaterial)assert.equal(f.c.state.materialReview.selectedCandidateId,f.candidate.id);
  }
});
test('8.2 focused material page uses the server offset for later ordinary pagination',async()=>{
  const f=await focusedMaterialListFixture();
  const previous=f.host.all().find(n=>n.tag==='button'&&n.textContent==='上一页');assert.ok(previous);
  const rendered=f.rendered();await previous.onclick();await rendered;
  assert.equal(f.listed[1].offset,'0');assert.equal(f.listed[1].focus,undefined);
  assert.equal(f.host.querySelectorAll('[data-material-id]').length,40);
  assert.equal(f.opened[1].object_id,'first-0');
});
test('5.6/8.2/C.2 a linked old candidate outside filters remains selected without changing filtered counts',async()=>{
  for(const empty of [false,true]){
    const f=await focusedMaterialListFixture({explicitMaterial:true,outside:true,empty});
    assert.equal(f.listed[0].search,'excluded');assert.equal(f.listed[0].focus,'need');
    const summary=f.host.all().find(n=>n.className==='production-filter-summary');assert.equal(summary.textContent,(empty?0:40)+' 项素材');
    assert.ok(f.host.textContent.includes('当前链接素材（筛选外）'));
    const selected=f.host.querySelectorAll('[data-material-id]').filter(n=>n.getAttribute('aria-pressed')==='true');
    assert.deepEqual(selected.map(n=>n.dataset.materialId),['need']);
    assert.equal(f.c.state.productionSelected.id,f.candidate.id);assert.equal(f.c.state.materialReview.selectedCandidateId,f.candidate.id);
    await selected[0].onclick();assert.equal(f.opened.at(-1).revision_id,f.candidate.id);
    assert.equal(f.c.state.productionSelected.id,f.candidate.id);
    assert.equal(new URL(f.c.location.href).searchParams.get('material_target'),f.candidate.id);
  }
});
