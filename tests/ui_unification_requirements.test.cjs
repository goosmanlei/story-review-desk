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
  scrollIntoView(){}
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
  vm.createContext(c);vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static/app.js'),'utf8').split('const state=')[0],c);require('./load_review_helpers.cjs')(c);
  for(const name of ['production.js','material-review.js','entity-review.js','production-breakdown.js','unified-cards.js','management-cards.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static',name),'utf8'),c);
  c.renderComments=()=>{};c.paintProductionReview=()=>{};c.paintReviewCommentCounts=()=>{};c.rememberProductionDraft=()=>{};c.restoreProductionDraft=()=>{};
  c.productionEntityIcon=()=>new Element('svg');c.materialReferenceLink=(parent,ref,label)=>{const n=c.nodeText('a',null,label,parent);n.reference=ref;return n};
  c.productionTextBlocks=row=>Object.entries(row.payload.generation?{'generation.prompt':row.payload.generation.prompt}:{'call.prompt':row.payload.prompt}).filter(([,text])=>typeof text==='string').map(([field,text])=>({id:field,field,text}));
  c.materialReferenceRequest=ref=>({url:'/?revision='+ref.revision_id});
  c.openMaterialReference=()=>{};c.toast=message=>{throw Error(message)};
  c.scrollBreakdownTarget=()=>{};c.rememberBreakdownPosition=()=>{};c.requestAnimationFrame=()=>1;c.window={scrollY:0,addEventListener(){},removeEventListener(){},scrollTo(){}};
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
  call.review_shot_slots=[{index:0,input_key:'key',material_id:'input-material',number:3,candidate:ref(input),candidate_number:2,record:input,component:input.payload.components[0],issues:[]}];
  const round={number:1,model:'plan-v1',plan:need,members:[need,call,asset],results:[asset]};
  const context={adoptions:[],video_details:{[need.object_id]:{record:need,material_versions:{[need.object_id]:[round]},review_contexts:{[asset.id]:{call,inputs:[input],requirements:[need]}}}}};
  return {...f,input,need,call,asset,round,context};
}
test('10.2/10.4 selected generated video renders actual prompt and exact references without changing text',async()=>{
  const {c,reader,need,call,input,context}=videoFixture();c.breakdownPrompt(reader,need,context);
  const prompt=reader.all().find(n=>n.className==='shot-generation-prompt');assert.equal(prompt.textContent,call.payload.prompt);assert.ok(!reader.textContent.includes(need.payload.generation.prompt));
  const inline=prompt.all().find(n=>n.tag==='a');assert.equal(inline.textContent,'@图片1');assert.equal(inline.href,'/?revision='+input.id);
  const opened=[];c.openUnifiedMaterial=ref=>opened.push(ref);await reader.querySelectorAll('[data-material-id]')[0].onclick();assert.equal(opened[0].revision_id,input.id);assert.equal(opened[0].component_id,'original');assert.equal(opened[0].params.get('material_version'),'3');assert.equal(opened[0].params.get('material_target'),input.id);
});
test('10.4 candidate without a real call reports the gap and never fills it from the plan',()=>{
  const {c,reader,need,context,asset}=videoFixture();delete context.video_details[need.object_id].review_contexts[asset.id];c.breakdownPrompt(reader,need,context);
  assert.match(reader.textContent,/未登记真实调用/);assert.ok(!reader.textContent.includes(need.payload.generation.prompt));
});
test('video prompt links keep the deployment prefix and exact old revision',()=>{
  const {c,reader,need,input,context}=videoFixture();c.REVIEW_DEPLOYMENT={base_path:'/lijizhanshe'};
  c.breakdownPrompt(reader,need,context);
  const inline=reader.all().find(n=>n.className==='shot-generation-prompt').all().find(n=>n.tag==='a');
  assert.equal(inline.href,'/lijizhanshe/?revision='+input.id);
  assert.equal(inline.textContent,'@图片1');
});
test('video defaults to latest empty version and exact manual old version retains its actual prompt',async()=>{
  const {c,reader,need,call,round,context}=videoFixture();context.video_details[need.object_id].material_versions[need.object_id].unshift({...round,number:2,members:[need],results:[]});
  c.breakdownPrompt(reader,need,context);assert.match(reader.textContent,/待生成/);assert.ok(reader.textContent.includes(need.payload.generation.prompt));assert.ok(!reader.textContent.includes(call.payload.prompt));
  const version=reader.all().find(n=>n.attributes['aria-label']==='素材版本');await version.children.find(n=>n.dataset.choiceId===1).onclick();assert.ok(reader.textContent.includes(call.payload.prompt));assert.equal(c.state.breakdownVideoSelections[need.id].number,1);
});
test('10.1/10.4 row material opens the exact video version and candidate chosen beside its prompt',async()=>{
  const {c,reader,need,asset,call,round,context}=videoFixture();
  const other=row('video-other','ASSET',{...asset.payload},'video-other-r1');round.results.push(other);round.members.push(other);context.video_details[need.object_id].review_contexts[other.id]={call,inputs:[],requirements:[need]};
  context.video_details[need.object_id].material_versions[need.object_id].unshift({...round,number:2,members:[need],results:[]});
  const scene=row('scene','AV_SCENE'),shot=row('shot','AV_SHOT',{number:1,duration_frames:120,fps:24});
  Object.assign(context,{requirements:[need],materials:[{object_id:need.object_id,id:need.id,title:need.payload.title,media_type:'video',slot:'video',generated:true}],entities:[],states:[]});
  c.state.workspace='production.workspace';c.state.breakdownData={episode:'episode'};c.api=async()=>({scene,shared:[],shots:[{record:shot,context}]});c.breakdownSelect=()=>{};vm.runInContext('breakdownEpoch=7',c);
  const opened=[];c.openUnifiedMaterial=reference=>opened.push(reference);
  await c.showBreakdownScene(scene,reader,new Element('nav'),7);
  const version=reader.all().find(n=>n.attributes['aria-label']==='素材版本');await version.children.find(n=>n.dataset.choiceId===1).onclick();
  const candidate=reader.all().find(n=>n.attributes['aria-label']==='素材候选');await candidate.children.find(n=>n.dataset.choiceId===other.id).onclick();
  await reader.querySelectorAll('[data-material-id]').find(n=>n.dataset.materialId===need.object_id).onclick();
  assert.equal(opened.length,1);assert.equal(opened[0].object_id,other.object_id);assert.equal(opened[0].revision_id,other.id);assert.equal(opened[0].params.get('material_version'),'1');assert.equal(opened[0].params.get('material_target'),other.id);
});

function mockManagementModal(c){c.openUnifiedMaterial=async ref=>{const result=await c.readUnifiedCard(ref.object_id,ref.revision_id,ref.params);c.activateUnifiedCard(result);c.renderProductionReader()}}
async function materialListFixture(linked){
  const f=fixture(),{c}=f,{need,asset}=material(),candidate={...asset,object_id:'historical-candidate',id:'historical-candidate-r1'};
  const item={canonical_material_id:need.object_id,object_id:need.object_id,id:need.id,title:'A material',media_type:'image',generated:true,version_count:2,candidate_count:1};
  if(linked)c.location.href+='&production_object='+linked+'&production_revision='+linked+'-r1';
  const opened=[];
  c.api=async url=>{
    if(url.startsWith('/api/production/breakdown'))return {lock:null,scenes:[],shots:[],episodes:[]};
    if(url.startsWith('/api/production/card')){
      const target=new URL(url,'http://fixture').searchParams.get('object_id');opened.push(target);
      const record=target===candidate.object_id?candidate:need;
      return {entity_review:null,scope:null,adoption_context:null,detail:{record,history:[record],uses:[],material_versions:{need:[{number:1,model:'plan-v1',plan:need,members:[need,candidate],results:[candidate]}]}}};
    }
    return {items:[item],total:1,display_total:1,groups:[{key:'unassigned',level:'unassigned',material_ids:[item.object_id]}],offset:0,limit:40,facets:{media:{'':1,image:1},status:{'':1,generated:1},episode:{'':1},scene:{'':1}}};
  };
  c.renderProductionReader=()=>{};
  mockManagementModal(c);await c.loadProductionMaterials();return {...f,opened};
}
test('management does not open a default large card; exact demand links open a modal',async()=>{
  for(const linked of [null,'need']){const {host,opened}=await materialListFixture(linked);assert.deepEqual(opened,linked?['need']:[]);assert.deepEqual(host.querySelectorAll('[data-material-id]').map(n=>n.getAttribute('aria-pressed')),['false'])}
});
test('historical candidate opens exactly without changing the current page cards',async()=>{
  const {host,opened}=await materialListFixture('historical-candidate');assert.deepEqual(opened,['historical-candidate']);
  assert.deepEqual(host.querySelectorAll('[data-material-id]').map(n=>n.dataset.materialId),['need']);
});

test('history result summaries explain D3 once while preserving an exact historical open',async()=>{
  const {host,opened}=await materialListFixture('historical-candidate');
  const statusGroups=host.all().filter(n=>n.attributes.role==='group'&&n.attributes['aria-label']?.includes('含历史版本'));
  assert.equal(statusGroups.length,1);
  const card=host.querySelectorAll('[data-material-id]')[0];
  assert.match(card.textContent,/版本 2 个 · 候选 1 个/);
  assert.doesNotMatch(card.textContent,/含历史版本|已生成/,'the filter group already states the list-wide range');
  assert.deepEqual(opened,['historical-candidate']);
  assert.equal(card.dataset.materialId,'need');
});

for(const workspace of ['settings.workspace','production.workspace'])test(`scene cards expose each supplied generation scope without rebinding ${workspace} links`,async()=>{
  const {c,reader}=fixture(),media=workspace==='production.workspace'?'video':'audio';
  const scene=row('scene','AV_SCENE'),shot=row('shot','AV_SHOT',{number:1,duration_frames:120,fps:24});
  const items=[
    {object_id:'historical-need',id:'historical-need-r3',title:'Changed current plan',media_type:media,generated:true,generation_scope:'history',version_count:2,candidate_count:1},
    {object_id:'exact-empty',id:'exact-empty-r1',title:'An exact record',media_type:media,generated:false,generation_scope:'exact',version_count:1,candidate_count:0},
    {object_id:'old-projection',id:'old-projection-r1',title:'An older projection',media_type:media,generated:true}
  ];
  c.state.workspace=workspace;c.state.breakdownData={episode:'episode'};
  c.location.href='http://fixture/?workspace='+workspace;
  c.api=async()=>({scene,shared:[],shots:[{record:shot,context:{requirements:[],materials:items,entities:[],states:[]}}]});
  c.breakdownShotText=()=>{};c.breakdownSelect=()=>{};vm.runInContext('breakdownEpoch=9',c);
  const opened=[];c.openUnifiedMaterial=reference=>opened.push(reference);
  c.state.breakdownVideoSelections={'historical-need-r3':{number:1,candidate:'old-original-r1'}};
  await c.showBreakdownScene(scene,reader,new Element('nav'),9);
  const cards=reader.querySelectorAll('[data-material-id]');
  assert.deepEqual(cards.map(n=>n.dataset.materialId),items.map(i=>i.object_id));
  assert.match(cards[0].textContent,/版本 2 个 · 候选 1 个/);
  assert.match(cards[1].textContent,/版本 1 个 · 候选 0 个/);assert.doesNotMatch(cards[1].textContent,/历史/);
  assert.match(cards[2].textContent,/版本未登记 · 候选未登记/);assert.doesNotMatch(cards[2].textContent,/历史/);
  for(const card of cards)assert.equal(card.dataset.reviewDialogTrigger,'');
  await cards[0].onclick();await cards[1].onclick();
  assert.equal(opened[0].revision_id,'historical-need-r3');
  assert.equal(opened[0].params.get('material_version'),'1');assert.equal(opened[0].params.get('material_target'),'old-original-r1');
  assert.equal(opened[1].revision_id,'exact-empty-r1');assert.equal(opened[1].params,null);
});

test('unowned demand sees a real older plan result without replacing its exact current reader',()=>{
  const {c,reader}=fixture(),{need,asset,round}=material();
  need.payload.scope={object_id:'scene',revision_id:'scene-r1'};
  const current={...need,id:'need-r2',version:2};
  const data={record:current,history:[current,need],candidate_records:[],material_card_counts:{need:{version_count:2,candidate_count:1}},material_versions:{need:[
    {number:2,model:'plan-v1',plan:current,members:[current],results:[]},round]}};
  c.state.entityReview=null;c.state.unifiedScope=null;c.state.materialReview=data;
  const opened=[];c.renderMaterialWorkspace=(_right,detail)=>opened.push(detail.record);
  c.renderUnifiedCard(reader);
  const card=reader.all().find(n=>n.className==='production-meta material-summary-counts');
  assert.match(card.textContent,/版本 2 个 · 候选 1 个/);
  assert.deepEqual(opened,[current]);assert.equal(data.material_versions.need[0].results.length,0);
  assert.equal(data.material_versions.need[1].results[0].id,asset.id);
});

for(const candidateKind of ['placeholder','preview-only','call'])test(`unowned demand does not count ${candidateKind} as an original result`,()=>{
  const {c,reader}=fixture(),{need,asset}=material();
  need.payload.scope={object_id:'scene',revision_id:'scene-r1'};
  const candidate=candidateKind==='call'?row('attempt','CALL',{status:'failed'}):structuredClone(asset);
  if(candidateKind==='placeholder')candidate.payload.placeholder=true;
  if(candidateKind==='preview-only')candidate.payload.components=candidate.payload.components.filter(v=>v.role!=='original');
  const data={record:need,history:[need],candidate_records:[candidate],material_card_counts:{need:{version_count:1,candidate_count:0}},material_versions:{}};
  c.state.entityReview=null;c.state.materialReview=data;c.renderMaterialWorkspace=()=>{};
  c.renderUnifiedCard(reader);
  const card=reader.all().find(n=>n.className==='production-meta material-summary-counts');
  assert.match(card.textContent,/版本 1 个 · 候选 0 个/);assert.doesNotMatch(card.textContent,/有生成结果|已生成/);
  assert.equal(data.candidate_records[0],candidate,'history remains available despite its not being a real original');
});

for(const variant of ['original','placeholder','preview-only'])test(`unowned exact ${variant} asset never borrows a result from another historical revision`,()=>{
  const {c,reader}=fixture(),{asset}=material(),exact=structuredClone(asset);
  exact.id='exact-'+variant;
  if(variant==='placeholder')exact.payload.placeholder=true;
  if(variant==='preview-only')exact.payload.components=exact.payload.components.filter(v=>v.role!=='original');
  const data={record:exact,history:[exact,asset],candidate_records:[asset],material_versions:{}};
  c.state.entityReview=null;c.state.materialReview=data;const rendered=[];
  c.renderMaterialWorkspace=(_right,detail)=>rendered.push(detail.record.id);
  c.renderUnifiedCard(reader);
  const card=reader.all().find(n=>n.className==='production-meta material-summary-counts');
  assert.match(card.textContent,/版本未登记 · 候选未登记/);
  assert.doesNotMatch(card.textContent,/历史|有生成结果|无生成结果/);
  assert.deepEqual(rendered,[exact.id]);assert.equal(data.history[1].id,asset.id);
});

test('entity material totals remain unchanged when selecting an empty or produced version',()=>{
  const {c,reader}=fixture(),{need,asset,round}=material();
  const current={...need,id:'need-r2'},empty={number:2,model:'plan-v1',plan:current,members:[current],results:[]};
  const data={unifiedCollecting:true,unifiedMaterialId:need.object_id,material_versions:{need:[empty,round]}};
  c.state.entityReview=data;
  c.renderUnifiedModels(reader,[{cardCounts:{version_count:2,candidate_count:1},need:current,material_id:need.object_id,round:empty,rounds:[empty,round],candidates:[]}],data);
  assert.match(reader.querySelectorAll('[data-material-id]')[0].textContent,/版本 2 个 · 候选 1 个/);
  assert.doesNotMatch(reader.textContent,/历史|有生成结果|无生成结果/);
  reader.replaceChildren();data.unifiedGroups=[];
  c.renderUnifiedModels(reader,[{cardCounts:{version_count:2,candidate_count:1},need,material_id:need.object_id,round,rounds:[empty,round],candidates:[{record:asset}]}],data);
  assert.match(reader.querySelectorAll('[data-material-id]')[0].textContent,/版本 2 个 · 候选 1 个/);
  assert.equal(data.material_versions.need[0].results.length,0,'viewing the old model cannot populate the current plan');
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
  const target={canonical_material_id:need.object_id,object_id:need.object_id,id:currentNeed.id,title:'Linked material',media_type:'image',generated:true};
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
    const items=empty?[]:outside?firstPage:[...firstPage,target];
    const total=items.length;
    return {items,total,display_total:total,groups:total?[{key:'all',level:'unassigned',material_ids:items.map(i=>i.object_id)}]:[],facets:{media:{'':total,image:total},status:{'':total,generated:total},episode:{'':total},scene:{'':total}}};
  };
  c.renderProductionReader=()=>{nextRender?.();nextRender=null};
  mockManagementModal(c);await c.loadProductionMaterials();
  return {...f,need,candidate,listed,opened,rendered:()=>new Promise(resolve=>{nextRender=resolve})};
}
test('exact historical links beyond the first page open the old candidate without resetting pagination',async()=>{
  for(const explicitMaterial of [false,true]){const f=await focusedMaterialListFixture({explicitMaterial});
    assert.equal(f.listed[0].grouped,'1');assert.equal(f.listed[0].focus,undefined);
    assert.equal(f.host.querySelectorAll('[data-material-id]').length,40);
    assert.equal(f.c.state.productionSelected.id,f.candidate.id);
    assert.deepEqual(f.opened,[{object_id:f.candidate.object_id,revision_id:f.candidate.id}]);
    if(explicitMaterial)assert.equal(f.c.state.materialReview.selectedCandidateId,f.candidate.id);
  }
});
test('pagination changes only the group/card collection and does not automatically read another material',async()=>{
  const f=await focusedMaterialListFixture();const next=f.host.all().find(n=>n.tag==='button'&&n.textContent==='下一页');assert.ok(next);await next.onclick();
  assert.equal(f.listed.length,1);assert.equal(f.host.querySelectorAll('[data-material-id]').length,1);
  assert.equal(f.opened.length,1);assert.equal(f.c.state.productionSelected.id,f.candidate.id);
});
test('a linked old candidate outside filters remains exact without changing unique or display counts',async()=>{
  for(const empty of [false,true]){const f=await focusedMaterialListFixture({explicitMaterial:true,outside:true,empty});
    assert.equal(f.listed[0].search,'excluded');const summary=f.host.all().find(n=>n.className==='production-filter-summary');assert.equal(summary.textContent,`素材数 ${empty?0:40} · 展示项数 ${empty?0:40}`);
    assert.equal(f.c.state.productionSelected.id,f.candidate.id);assert.equal(f.c.state.materialReview.selectedCandidateId,f.candidate.id);
  }
});

test('explicit entity revision and state identity survive unified-card activation',()=>{
  const f=entityFilterFixture(),old={...f.a,id:'a-old',current_revision:f.a.id,version:1};
  const data=f.review(f.a);f.c.activateUnifiedCard({detail:{record:old,history:[old]},entity_review:data,form:null,params:new URLSearchParams({entity_state:f.aForm.object_id}),explicit:true});
  assert.equal(f.c.state.productionEntityDetail.record.id,'a-old');assert.equal(f.c.state.productionChildDetail.record.object_id,f.aForm.object_id);assert.equal(data.localVersions[f.a.object_id].id,'a-old');
});
test('explicit state outranks a material default form and the owner reaches the exact card API',async()=>{
  const f=entityFilterFixture(),data=f.review(f.a),other=row('other-state','STATE',{entity:ref(f.a),state_model:'complete-v1'});data.states.push(other);
  f.c.entityMaterialRoute=()=>({row:f.asset,selected:{material_id:'need'}});f.c.restoreEntityMaterialRoute=()=>{f.c.state.productionChildDetail={record:f.aForm}};
  const params=new URLSearchParams({production_entity:f.a.object_id,entity_state:other.object_id});f.c.activateUnifiedCard({detail:{record:f.asset,history:[f.asset]},entity_review:data,form:f.aForm,params,explicit:true});
  assert.equal(f.c.state.productionChildDetail.record.object_id,other.object_id);
  let requested;f.c.api=async url=>{requested=new URL(url,'http://fixture');return {detail:{record:f.a},entity_review:null}};
  await f.c.readUnifiedCard(f.a.object_id,'a-old',params);assert.equal(requested.searchParams.get('entity_id'),f.a.object_id);assert.equal(requested.searchParams.get('revision_id'),'a-old');
});

function shotChoiceFixture(){
  const f=fixture(),{need,asset,round}=material(),dialog={isConnected:true},box=new Element('section');box.closest=()=>dialog;
  const callbacks=[],source={onSaved:result=>callbacks.push(result)};
  const context={dialog,source,need:row('video','REQUIREMENT'),slot:{material_id:'need',canonical_material_id:'need',index:0,input_key:'ordered-slot'},number:1,pageActive:()=>true};
  f.c.state.shotReferenceContext=context;f.c.crypto={randomUUID:require('node:crypto').randomUUID};
  return {...f,box,context,dialog,callbacks,model:{material_id:'need',round},item:{record:asset,component:asset.payload.components[0]},button:()=>box.all().find(n=>n.tag==='button')};
}
test('shot reference browsing adds no writes and ordinary cards expose no selection operation',()=>{
  const f=shotChoiceFixture(),calls=[];f.c.api=(...args)=>calls.push(args);
  f.c.renderShotReferenceChoice(f.box,f.model,f.item);assert.equal(calls.length,0);
  f.c.state.shotReferenceContext=null;const ordinary=new Element('section');ordinary.closest=()=>f.dialog;
  f.c.renderShotReferenceChoice(ordinary,f.model,f.item);assert.equal(ordinary.children.length,0);
});
test('shot reference unknown save retries keep operation identity and changed choices get a new one',async()=>{
  const f=shotChoiceFixture(),requests=[];f.c.api=async(_url,options)=>{requests.push(JSON.parse(options.body));throw Error('response lost')};
  f.c.renderShotReferenceChoice(f.box,f.model,f.item);await f.button().onclick();await f.button().onclick();
  assert.equal(requests[0].id,requests[1].id);assert.equal(f.context.source.saved,undefined);assert.ok(f.box.textContent.includes('保存失败'));
  const other={...f.item,record:{...f.item.record,id:'other-result'}};f.box.replaceChildren();f.c.renderShotReferenceChoice(f.box,f.model,other);await f.button().onclick();assert.notEqual(requests[0].id,requests[2].id);
});
test('late save refreshes only the active page and never paints a closed dialog',async()=>{
  for(const active of [true,false]){const f=shotChoiceFixture();let finish;f.context.pageActive=()=>active;f.c.api=()=>new Promise(resolve=>finish=resolve);
    f.c.renderShotReferenceChoice(f.box,f.model,f.item);const promise=f.button().onclick();await Promise.resolve();f.dialog.isConnected=false;finish({number:2});await promise;
    assert.equal(f.callbacks.length,active?1:0);assert.equal(f.button().textContent,'正在保存…');
  }
});
test('an empty reference version can be saved without a candidate and frozen versions explain the new plan',async()=>{
  const f=shotChoiceFixture(),requests=[];f.context.frozen=true;f.c.api=async(_url,options)=>{requests.push(JSON.parse(options.body));return {number:2}};
  f.c.renderShotReferenceChoice(f.box,f.model,null);assert.equal(f.button().disabled,false);assert.ok(f.box.textContent.includes('建立新制作版本'));
  assert.ok(f.box.textContent.includes('候选仍待选'));await f.button().onclick();assert.equal(requests[0].candidate,null);assert.equal(requests[0].component_id,undefined);
});
test('an exact shot video candidate mismatch never falls back to another result',()=>{
  const {c,reader,need,context}=videoFixture();c.location.href='http://fixture/?shot_material_id=video-need&shot_plan=1&shot_candidate=missing';c.breakdownPrompt(reader,need,context);
  assert.ok(reader.textContent.includes('准确素材候选不属于此制作版本'));assert.ok(!reader.textContent.includes('真实生成内容'));
});
test('saved reference routing waits for the modal history entry to return',()=>{
  const {c}=fixture();let pop;c.window.addEventListener=(name,handler)=>{if(name==='popstate')pop=handler};
  const source=fs.readFileSync(path.join(__dirname,'../review_desk/static/review-ui.js'),'utf8');vm.runInContext(source.slice(source.indexOf('let reviewDialogSerial='),source.indexOf('function openReviewDialog(')),c);
  vm.runInContext('reviewDialogBackPending=true',c);let changed=false;c.afterReviewDialogReturn(()=>changed=true);assert.equal(changed,false);pop({stopImmediatePropagation(){}});assert.equal(changed,true);
});
test('reference save refresh keeps the draft attached to the original immutable text',async()=>{
  const {c}=fixture(),old=row('video','REQUIREMENT'),anchor={type:'text',quote:'original'};c.state.workspace='settings.workspace';c.state.anchor=anchor;c.state.productionSelected=old;c.state.breakdownVideoSelections={};
  c.loadProductionBreakdown=async()=>{c.state.anchor=null;c.state.productionSelected=row('scene','AV_SCENE')};c.document.querySelector=()=>({querySelector(){return {focus(){c.state.anchor=null}}}});
  await c.refreshShotReference({need:{...old,payload:{scope:{object_id:'shot'}}}},{index:0},{number:2});assert.equal(c.state.anchor,anchor);assert.equal(c.state.productionSelected,old);assert.ok(c.location.href.includes('shot_plan=2'));
});

test('flat management scope choices preserve authoritative labels and single selection linkage',async()=>{
 const {c}=fixture(),host=new Element('div'),filters={episode:'',scene:''},changes=[];
 const catalog={episodes:[{object_id:'e1',number:1},{object_id:'e2',number:2}]},locations=[{episode:'e1',scene:'s1'},{episode:'e2',scene:'s2'}];
 c.reviewPositionLabel=(kind,row)=>kind==='episode'?'E0'+row.number:row==='s1'?'S001':'S002';
 c.state.businessCodes=new Map([['scene:e1:s1','S001'],['scene:e2:s2','S002']]);assert.equal(c.managementSceneLabel('s1',null,catalog),'S001');
 const draw=()=>{host.replaceChildren();c.managementScopeFilters(host,filters,catalog,locations,()=>{changes.push({...filters});draw()})};
 const button=value=>host.all().find(n=>n.dataset.filterValue===value);
 draw();assert.equal(host.all().some(n=>n.tag==='select'),false);assert.equal(button('e1').textContent,'E01');assert.equal(button('s1').textContent,'S001');
 await button('s1').onclick();assert.equal(filters.scene,'s1');assert.equal(button('s1').attributes['aria-pressed'],'true');
 await button('e2').onclick();assert.equal(filters.episode,'e2');assert.equal(filters.scene,'');assert.equal(button('s1'),undefined);assert.equal(button('s2').textContent,'S002');
 await button('s2').onclick();await button('s2').onclick();assert.equal(filters.scene,'');
 await button('e2').onclick();assert.equal(filters.episode,'');assert.ok(button('s1'));assert.ok(changes.length>=5);
 filters.scene='missing';draw();assert.equal(filters.scene,'');
});
