// Independent task-0009 regressions. DOM fixtures do not certify visual layout.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');

class Element {
  constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.attributes={};this.style={};this.className='';this.scrollTop=0;this.isConnected=true;this.classList={add(){},remove(){},toggle(){}}}
  append(...nodes){for(const node of nodes){node.parentNode=this;this.children.push(node)}}
  replaceChildren(...nodes){this.children=[];this.append(...nodes)}
  remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(n=>n!==this)}
  setAttribute(key,value){this.attributes[key]=String(value)}
  getAttribute(key){return this.attributes[key]}
  removeAttribute(key){delete this.attributes[key]}
  all(){return this.children.flatMap(node=>[node,...node.all()])}
  querySelectorAll(selector){return this.all().filter(n=>selector==='button'?n.tag==='button':false)}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null}
}
const scene=id=>({object_id:id,id:id+'-r1',kind:'PREPARATION',payload:{title:id,source:{scene_id:id==='scene-a'?1:2},blocks:[]}});
function fixture(){
  const host=new Element('main'),a=scene('scene-a'),b=scene('scene-b');
  const shot={object_id:'old-shot',id:'old-shot-r1',kind:'SHOT_DESIGN',payload:{parent:{object_id:a.object_id,revision_id:a.id}}};
  const c={URL,URLSearchParams,CSS:{escape:x=>x},console,location:{href:'http://fixture/?workspace=settings.workspace&production_tab=breakdown&breakdown_episode=episode&breakdown_scene=scene-a&breakdown_object=old-shot&breakdown_revision=old-shot-r1&production_object=old-shot&production_revision=old-shot-r1&material_id=old-need&material_version=2&material_target=old-result'},state:{workspace:'settings.workspace',productionRecords:[],breakdownData:{episode:'episode'}}};
  c.el=(tag,classes)=>{const n=new Element(tag);n.className=classes||'';return n};
  c.nodeText=(tag,classes,text,parent)=>{const n=c.el(tag,classes);n.textContent=text;parent.append(n);return n};
  c.$=()=>host;c.document={querySelectorAll:()=>[]};
  c.history={replaceState(_state,_title,url){c.location.href=String(url)}};
  vm.createContext(c);require('./load_review_helpers.cjs')(c);
  for(const name of ['production.js','production-breakdown.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static',name),'utf8'),c);
  c.rememberProductionDraft=()=>{};c.restoreProductionDraft=()=>{};c.paintReviewCommentCounts=()=>{};c.renderComments=()=>{};
  c.materialReferenceLink=()=>{};c.materialTextSurface=parent=>parent;c.entityReviewDetail=record=>({record,history:[record],uses:[]});
  c.toast=message=>{throw Error(message)};
  const requested=[];
  c.api=async url=>{
    if(url.startsWith('/api/production/breakdown?'))return {episode:'episode',episodes:[],scenes:[a,b],shots:[shot],lock:null};
    if(url.startsWith('/api/production/scene?')){const id=new URL(url,'http://fixture').searchParams.get('object_id');requested.push(id);return {scene:id===a.object_id?a:b,shots:[],shared:[]}}
    throw Error('unexpected API '+url);
  };
  vm.runInContext('breakdownEpoch=1',c);
  c.scrollBreakdownTarget=()=>{};c.rememberBreakdownPosition=()=>{};c.requestAnimationFrame=()=>1;c.window={scrollY:0,addEventListener(){},removeEventListener(){},scrollTo(){}};
  return {c,host,a,b,requested};
}

test('manual scene route replaces an old exact shot and clears material selection before refresh',async()=>{
  const {c,b}=fixture();let loaded=0;c.loadProductionBreakdown=async()=>{loaded++};c.history.pushState=c.history.replaceState;
  await c.breakdownNavigate({breakdown_episode:'episode',breakdown_scene:b.object_id,breakdown_object:b.object_id,breakdown_revision:b.id});
  const params=new URL(c.location.href).searchParams;
  assert.equal(params.get('breakdown_scene'),b.object_id);assert.equal(params.get('breakdown_object'),b.object_id);assert.equal(params.get('breakdown_revision'),b.id);
  for(const key of ['production_object','production_revision','material_id','material_version','material_target'])assert.equal(params.has(key),false,key);
  assert.equal(loaded,1);
});

test('removed ownership controls cannot filter explicitly linked material identities',()=>{
  const {c}=fixture();c.state.breakdownLevels=[];const items=[{object_id:'entity-material',media_type:'image',classification:{key:'image:character',label:'图像—角色'}}];
  assert.equal(c.breakdownScopeFilters,undefined);assert.equal(c.groupedShotMaterials(items)[0].items[0].object_id,'entity-material');
});

test('C04 a real video image preview is used when the original itself is not an image',()=>{
  const {c}=fixture();
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static/unified-cards.js'),'utf8'),c);
  const preview={id:'thumbnail',role:'preview',mime:'image/jpeg',file:'real-video-preview.jpg'};
  const original={id:'original',role:'original',mime:'video/mp4',file:'real-video.mp4'};
  const record={object_id:'video',id:'video-r1',payload:{title:'实拍视频',media_type:'video',components:[original,preview]}};
  const item=c.modelSmallItem({identity:record,candidates:[{record}]});
  assert.equal(item.preview,preview);
});

test('C03 a lower card version request completing under a child card leaves its selector consistent with its content',async()=>{
  const {c}=fixture();
  c.Option=function(text,value){const n=new Element('option');n.textContent=text;n.value=value;return n};
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static/entity-review.js'),'utf8'),c);
  const row={object_id:'entity-a',id:'a-r1',current_revision:'a-r2',kind:'ENTITY',payload:{title:'实体甲'}};
  const second={...row,id:'a-r2'},data={entity:row,versions:{'entity-a':[{id:'a-r1',version:1},{id:'a-r2',version:2}]},comment_records:[],comment_targets:[]};
  c.state.entityReview=data;
  let resolve,changed=null;c.api=()=>new Promise(done=>{resolve=done});
  const parent=new Element('section');c.entityVersionControl(parent,row,next=>{changed=next});
  const select=parent.children[0],button=select.children.find(n=>n.dataset.choiceId==='a-r2');
  const pending=button.onclick();await new Promise(done=>setImmediate(done));
  // openUnifiedMaterial replaces the global active card while keeping its parent DOM.
  c.state.entityReview={entity:{object_id:'entity-b'}};
  resolve({record:second});await pending;
  // Closing the child restores that same parent data and DOM.
  c.state.entityReview=data;
  assert.equal(changed,null);assert.equal(select.children.find(n=>n.attributes['aria-pressed']==='true').dataset.choiceId,row.id);
});

function requirementFixture(description='劳作后未擦手：双手沾粉。'){
  const {c}=fixture();
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static/material-review.js'),'utf8'),c);
  c.materialTextSurface=parent=>parent;c.state.comments=[];
  const row={object_id:'need',id:'need-r1',kind:'REQUIREMENT',payload:{title:'劳作后未擦手',blocks:[{id:'requirement',text:'双手沾粉。'}],generation:{output:{name:'人物状态图',description,review_criteria:['保留粉迹']}}}};
  const descriptionBlock=c.productionTextBlocks(row).find(b=>b.field==='generation.output.description');
  const render=()=>{const parent=new Element('section');c.renderMaterialRequirements(parent,row);return parent.all().filter(n=>n.dataset.blockId)};
  return {c,row,descriptionBlock,render};
}

test('C07 an exactly repeated titled requirement description appears once in normal reading',()=>{
  const {render}=requirementFixture(),blocks=render();
  assert.deepEqual(blocks.map(n=>n.textContent),['双手沾粉。','保留粉迹']);
  assert.equal(blocks[0].dataset.blockId,'requirement');
});

test('C08 locating an old output-description comment restores its original prefix and anchor identity',()=>{
  const {c,row,descriptionBlock,render}=requirementFixture();
  c.state.selected='old-comment';
  c.state.comments=[{id:'old-comment',target_revision_id:row.id,anchor:{type:'text',block_id:descriptionBlock.id,start:7,end:12}}];
  const blocks=render();
  assert.deepEqual(blocks.map(n=>n.textContent),['劳作后未擦手：双手沾粉。','保留粉迹']);
  assert.equal(blocks[0].dataset.blockId,descriptionBlock.id);
});

test('C07 similar output descriptions retain their additional requirement text',()=>{
  const {render}=requirementFixture('劳作后未擦手：双手沾粉。左袖必须卷起。');
  assert.deepEqual(render().map(n=>n.textContent),['双手沾粉。','劳作后未擦手：双手沾粉。左袖必须卷起。','保留粉迹']);
});

test('C08 a historical cross-block comment retains both exact endpoint blocks',()=>{
  const {c,row,descriptionBlock,render}=requirementFixture();
  c.state.selected='cross-block-comment';
  c.state.comments=[{id:'cross-block-comment',target_revision_id:row.id,anchor:{type:'text',block_id:'requirement',start:0,end_block_id:descriptionBlock.id,end:12}}];
  const blocks=render();
  assert.ok(blocks.some(n=>n.dataset.blockId==='requirement'));
  assert.ok(blocks.some(n=>n.dataset.blockId===descriptionBlock.id));
});

for(const submitted of [false,true])test(`P05/C06 empty frozen video version ${submitted?'shows its exact failed call':'does not borrow the current plan'}`,()=>{
  const {c}=fixture();
  for(const name of ['material-review.js','unified-cards.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static',name),'utf8'),c);
  c.materialTextSurface=parent=>parent;
  c.document.createTextNode=text=>{const n=new Element('#text');n.textContent=text;return n};
  c.Option=function(text,value){const n=new Element('option');n.textContent=text;n.value=value;return n};
  const need={object_id:'video-need',id:'current-need',kind:'REQUIREMENT',payload:{title:'本镜视频',media_type:'video',generation:{model:'current-model',prompt:'CURRENT PLAN MUST NOT BE BORROWED',inputs:[],parameters:{},output:{}}}};
  const call={object_id:'old-call',id:'old-call-r1',kind:'CALL',payload:{format:'production-call-v1',status:'failed',model:'historical-model',prompt:'EXACT FAILED CALL',inputs:[],parameters:{}}};
  const round={number:2,model:'plan-v1',frozen:true,plan:null,members:submitted?[call]:[],results:[],definition_records:{requirement:null,call:submitted?call:null}};
  const context={adoptions:[],video_details:{'video-need':{material_versions:{'video-need':[round]},review_contexts:{}}}};
  const parent=new Element('section');c.breakdownPrompt(parent,need,context);
  const text=parent.all().map(n=>n.textContent||'').join('\n');
  assert.ok(!text.includes('CURRENT PLAN MUST NOT BE BORROWED'));
  assert.ok(submitted?text.includes('EXACT FAILED CALL'):text.includes('未保留完整生成方案'));
});

function sharedMaterialFixture(){
  const {c}=fixture();
  for(const name of ['material-review.js','entity-review.js','unified-cards.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static',name),'utf8'),c);
  const scope=id=>({object_id:id,revision_id:id+'-r1'});
  const need=(id,state)=>({object_id:id,id:id+'-r1',kind:'REQUIREMENT',material_identity:{id:'shared'},payload:{title:'共同音色',media_type:'audio',slot:'voice',scope:scope(state)}});
  const shared=need('shared','state-a'),alias=need('alias','state-b');
  const asset=id=>({object_id:id,id:id+'-r1',kind:'ASSET',version:1,created_at:id==='asset-a'?'2026-10-01':'2026-10-02',payload:{title:id,media_type:'audio',components:[{id:'original',role:'original',mime:'audio/wav',file:id+'.wav'}]}});
  const a=asset('asset-a'),b=asset('asset-b'),items=[a,b].map(record=>({record,component:record.payload.components[0]}));
  const round=(number,plan)=>({number,model:'plan-v1',plan,members:[plan,a,b],results:[a,b]});
  const data={entity:{object_id:'entity',id:'entity-r1',kind:'ENTITY',payload:{title:'实体'}},states:['state-a','state-b'].map(id=>({object_id:id,id:id+'-r1',kind:'STATE',payload:{title:id}})),comment_records:[],comment_targets:[],requirements:[shared,alias],material_versions:{shared:[round(2,shared)],alias:[round(5,alias)]},media:items,adoptions:[
    {payload:{scope:scope('state-a'),slot:'voice',asset:scope('asset-a'),component_id:'original'}},
    {payload:{scope:scope('state-b'),slot:'voice',asset:scope('asset-b'),component_id:'original'}},
  ]};
  c.state.entityReview=data;c.state.productionSelected=null;c.isProduction=()=>true;
  return {c,data,shared,alias,a,b,items};
}

test('D01/C06 state aliases browse the same canonical material without changing their adoption scope',()=>{
  const {c,data,shared,alias,items}=sharedMaterialFixture();
  const first=c.entityReviewMaterialModels([shared],items,data)[0],second=c.entityReviewMaterialModels([alias],items,data)[0];
  assert.equal(first.material_id,'shared');assert.equal(second.material_id,'shared');
  assert.equal(first.round.number,2);assert.equal(second.round.number,2);
  assert.equal(first.association_need,shared);assert.equal(second.association_need,alias);
  assert.equal(c.materialDefaultCandidate(first,data),'asset-b-r1');
  assert.equal(c.materialDefaultCandidate(second,data),'asset-b-r1');
});

test('D06 an exact legacy alias card retains its own version number and members',()=>{
  const {c,data,alias,items}=sharedMaterialFixture();
  c.state.materialCommentCard={data,material_id:'alias',number:5};
  c.state.productionSelected=alias;
  const model=c.entityReviewMaterialModels([alias],items,data)[0];
  assert.equal(model.material_id,'alias');assert.equal(model.round.number,5);
  assert.ok(model.round.members.includes(alias));
  assert.equal(model.association_need,alias);
});

test('D06 an exact alias revision keeps historical numbering even without a selected comment card',()=>{
  const {c,data,alias,items}=sharedMaterialFixture();data.localVersions={alias};
  const model=c.entityReviewMaterialModels([alias],items,data)[0];
  assert.equal(model.material_id,'alias');assert.equal(model.round.number,5);
});

test('D01 a shared material owned by another entity still uses its canonical card',()=>{
  const {c,data,alias,items}=sharedMaterialFixture();
  // The owning entity's requirement is not part of this entity's acceptance scope.
  data.requirements=[alias];
  const model=c.entityReviewMaterialModels([alias],items,data)[0];
  assert.equal(model.material_id,'shared');assert.equal(model.round.number,2);
  assert.equal(model.association_need,alias);
  assert.equal(data.requirements.length,1);
});

test('D01 state-specific default adoption does not leak through a cached shared candidate',()=>{
  const {c,data,shared,alias,items}=sharedMaterialFixture();
  data.entity={object_id:'entity',id:'entity-r1',kind:'ENTITY',payload:{title:'实体'}};
  const form=id=>({object_id:id,id:id+'-r1',kind:'STATE',payload:{title:id}});
  const first=form('state-a'),second=form('state-b');data.states=[first,second];
  data.unifiedRight=new Element('aside');c.renderMaterialCard=()=>{};c.cancelMaterialCommentLocation=()=>{};
  c.renderProductionReader=()=>{const selected=c.state.productionChildDetail.record;data.unifiedGroups=c.entityReviewMaterialModels(data.requirements.filter(n=>n.payload.scope.revision_id===selected.id),items,data);c.renderUnifiedSelected(data)};
  c.selectEntityReviewState(first);
  assert.equal(data.selectedCandidates.shared,'asset-b-r1');
  c.selectEntityReviewState(second);
  assert.equal(data.selectedCandidates.shared,'asset-b-r1');
  data.selectedComponents['asset-b-r1']='preview-b';
  c.selectEntityReviewState(first);
  assert.equal(data.selectedCandidates.shared,'asset-b-r1');
  assert.equal(data.selectedComponents['asset-b-r1'],undefined);
  c.selectEntityReviewState(second);
  assert.equal(data.selectedComponents['asset-b-r1'],'preview-b');
});

function provenanceFixture(){
  const f=sharedMaterialFixture(),{c,data,shared,a,b}=f;
  data.material_versions.shared[0]={...data.material_versions.shared[0],plan:null,members:[a,b],definition_records:{requirement:shared,call:null}};
  c.state.productionSelected=shared;c.state.materialCommentCard={data,material_id:'shared',number:2};
  const params=new URLSearchParams({material_id:'shared',material_version:'2',material_target:shared.id});
  const result={params,entity_review:data,detail:{record:shared,history:[shared],material_versions:data.material_versions}};
  return {...f,params,result};
}

test('D04/C08 a displayed exact definition source submits comment context for its frozen version',()=>{
  const {c,data,shared}=provenanceFixture();
  assert.deepEqual(JSON.parse(JSON.stringify(c.materialCommentContext())),{material_id:'shared',number:2,model:'plan-v1'});
  assert.equal(data.material_versions.shared[0].members.some(r=>r.id===shared.id),false);
});

test('D04/C08 refreshing an exact definition-source target is accepted without making it a candidate',()=>{
  const {c,data,shared,result}=provenanceFixture();
  assert.doesNotThrow(()=>c.validateUnifiedReference(result));
  assert.equal(data.material_versions.shared[0].results.some(r=>r.id===shared.id),false);
  result.params.set('material_target','unrelated-source-r1');
  assert.throws(()=>c.validateUnifiedReference(result),/不存在|不属于/);
});

test('D04/C08 an entity route can locate the exact frozen definition source outside old members',()=>{
  const {c,data,shared,params}=provenanceFixture();
  const route=c.entityMaterialRoute(data,shared,params);
  assert.equal(route.selected.material_id,'shared');assert.equal(route.selected.round.number,2);
  assert.equal(route.row,shared);
});

function componentFixture(entry='demand'){
  const {c}=fixture();
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static/material-review.js'),'utf8'),c);
  c.location.href='http://fixture/?workspace=materials.workspace';
  c.document.querySelector=()=>null;c.productionRefLink=()=>{};c.productionName=()=> '夹具';
  c.focusProductionReview=detail=>{c.state.productionSelected=detail.record};
  const asset=id=>({object_id:id,id:id+'-r1',kind:'ASSET',version:1,payload:{title:id,media_type:'video',production:{object_id:id+'-call'},components:[
    {id:'original',role:'original',mime:'video/mp4',file:id+'.mp4',sha256:id+'-sha'},
    {id:'preview',role:'preview',mime:'image/png',file:id+'.png',sha256:id+'-preview-sha'},
  ]}});
  const a=asset('candidate-a'),b=asset('candidate-b'),need={object_id:'need',id:'need-r1',kind:'REQUIREMENT',payload:{title:'多组成夹具',media_type:'video',slot:'video',scope:{object_id:'scope',revision_id:'scope-r1'}}};
  const round={number:1,model:'plan-v1',plan:need,members:[need,a,b],results:[a,b]};
  const detail={record:entry==='demand'?need:a,history:[entry==='demand'?need:a],candidate_records:[a,b],material_versions:{need:[round]},selectedCandidateId:a.id,uses:[]};
  c.state.materialReview=detail;
  let last;
  c.renderMaterialCard=(_root,model,options)=>{last={model,options,shown:c.materialCandidateChoice(model.candidates,options.selectedCandidateId)}};
  c.renderProductionReader=()=>c.renderMaterialWorkspace(new Element('article'),detail);
  c.renderProductionReader();
  return {c,detail,a,b,current:()=>last};
}

for(const entry of ['demand','asset'])test(`C07 ${entry} entry keeps a preview choice per exact candidate revision`,()=>{
  const {c,detail,a,b,current}=componentFixture(entry);
  assert.equal(current().shown.component.id,'original');
  current().options.selectComponent('preview',a.id);
  assert.equal(current().shown.component.id,'preview');
  current().options.selectCandidate(b.id);
  assert.equal(current().shown.record.id,b.id);
  assert.equal(current().shown.component.id,'original');
  current().options.selectCandidate(a.id);
  assert.equal(current().shown.component.id,'preview');
  assert.equal(detail.selectedComponents[a.id],'preview');
  assert.equal(detail.selectedComponents[b.id],undefined);
});

test('C08 locating a preview comment records only its exact candidate component',async()=>{
  const {c,detail,a,b,current}=componentFixture('asset');
  let located=null;c.materialPlanCommentNeedsHistory=()=>false;c.locateProductionComment=comment=>{located=comment.id};
  const comment={id:'preview-comment',target_revision_id:a.id,anchor:{type:'visual',visual_id:'preview'},material_plan_scopes:[{material_id:'need',number:1}]};
  assert.equal(await c.locateMaterialComment(comment),true);
  assert.equal(located,comment.id);
  assert.equal(detail.selectedComponents[a.id],'preview');
  assert.equal(current().shown.component.id,'preview');
  current().options.selectCandidate(b.id);
  assert.equal(current().shown.component.id,'original');
  assert.equal(detail.selectedComponents[b.id],undefined);
});

test('C09 an exact asset reader offers adoption only for its matching material requirement',()=>{
  const {c,detail,a,b}=componentFixture('asset'),need=detail.material_versions.need[0].plan;
  const unrelated={...need,object_id:'unrelated',id:'unrelated-r1'};
  let requests=[];c.renderMaterialAdoptionControls=(_root,value)=>{requests.push(value)};
  detail.adoptionContext={requirements:[unrelated],adoptions:[]};
  c.renderProductionReader();assert.equal(requests.length,0);
  detail.adoptionContext.requirements.push(need);
  c.renderProductionReader();assert.equal(requests.length,1);
  assert.equal(requests[0].record,need);
  assert.deepEqual(Array.from(requests[0].candidate_records.map(r=>r.id)),[a.id,b.id]);
  detail.material_versions={};c.renderProductionReader();assert.equal(requests.length,1);
});

test('C09 material adoption forwards its exact candidates even without global asset rows',async()=>{
  const {c,detail,a,b}=componentFixture('asset');
  c.Option=function(text,value){const n=new Element('option');n.textContent=text;n.value=value;return n};
  detail.record=detail.material_versions.need[0].plan;
  detail.adoptionContext={requirements:[detail.record],adoptions:[]};
  c.state.productionRecords=[];
  const parent=new Element('article');
  c.renderMaterialAdoptionControls(parent,detail);
  const button=parent.all().find(n=>n.tag==='button'&&n.textContent==='选择采用');
  assert.ok(button);
  await button.onclick();
  const selector=parent.all().find(n=>n.tag==='select'&&n.getAttribute('aria-label')==='选择素材');
  assert.ok(selector);
  assert.deepEqual(selector.children.map(n=>n.value),['',a.object_id,b.object_id]);
});

function materialDraftFixture(){
  const {c}=fixture();
  for(const name of ['material-review.js','unified-cards.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static',name),'utf8'),c);
  const draftSource=fs.readFileSync(path.join(__dirname,'../review_desk/static/production-breakdown.js'),'utf8');
  vm.runInContext(draftSource.slice(draftSource.indexOf('function productionDraftKey()')),c);
  c.isProduction=()=>true;c.isEntityReview=()=>false;c.location.href='http://fixture/?workspace=materials.workspace';
  const drafts=new Map();c.localStorage={getItem:key=>drafts.get(key)??null};
  // Use the actual body key: changing material context can turn it into the
  // legacy key even while productionSelected still refers to the previous card.
  const appSource=fs.readFileSync(path.join(__dirname,'../review_desk/static/app.js'),'utf8');
  vm.runInContext(appSource.split('\n').filter(line=>/^const (legacyDraftKey|draftKey)=/.test(line)).join('\n'),c);
  c.state.workspace='materials.workspace';
  const create=(id,number=1)=>{
    const need={object_id:id,id:id+'-r1',kind:'REQUIREMENT',payload:{title:id}};
    const asset={object_id:id+'-asset',id:id+'-asset-r1',kind:'ASSET',payload:{title:id+' image',components:[{id:'original',role:'original',mime:'image/png',file:id+'.png'}]}};
    const round={number,model:'plan-v1',plan:need,members:[need,asset],results:[asset]};
    return {entity_review:null,explicit:false,allowDraftFocus:true,params:new URLSearchParams(),detail:{record:need,history:[need],candidate_records:[asset],material_versions:{[id]:[round]}}};
  };
  const first=create('first'),second=create('second'),asset=first.detail.candidate_records[0];
  c.activateUnifiedCard(first);c.focusProductionReview({record:asset,history:[asset],uses:[]},false);
  const anchor={type:'visual',visual_id:'original',asset_file:'first.png',rect:{x:.1,y:.1,width:.2,height:.2}};
  c.state.anchor=anchor;const bodyKey=vm.runInContext('draftKey()',c);drafts.set(bodyKey,'保留这处图像草稿');c.rememberProductionDraft();
  const contextKey=c.productionDraftKey();
  c.activateUnifiedCard(second);
  assert.equal(c.state.productionDraftContexts[contextKey].draftKey,bodyKey,'switching current material cannot overwrite the old body key');
  assert.equal(c.state.anchor,null);
  return {c,create,asset,anchor,drafts};
}

test('C08 returning to a normal material card restores its exact asset draft focus and image anchor',()=>{
  const {c,create,asset,anchor}=materialDraftFixture();
  c.activateUnifiedCard(create('first'));
  assert.equal(c.state.productionSelected.id,asset.id);
  assert.equal(JSON.stringify(c.state.anchor),JSON.stringify(anchor));
});

test('C08 saved asset draft focus never overrides explicit requirement or material-version links',()=>{
  for(const exact of ['revision','material_version','material_round']){
    const {c,create}=materialDraftFixture(),target=create('first');
    if(exact==='revision'){target.explicit=true;target.params.set('production_revision',target.detail.record.id)}else target.params.set(exact,'1');
    c.activateUnifiedCard(target);
    assert.equal(c.state.productionSelected.id,'first-r1',exact);
    assert.equal(c.state.anchor,null,exact);
  }
});

test('C08 a removed draft or an exact-reference entry cannot revive a prior asset draft focus',()=>{
  for(const mode of ['removed','exact-reference']){
    const {c,create,drafts}=materialDraftFixture(),target=create('first');
    if(mode==='removed')drafts.clear();else target.allowDraftFocus=false;
    c.activateUnifiedCard(target);
    assert.equal(c.state.productionSelected.id,'first-r1',mode);
    assert.equal(c.state.anchor,null,mode);
  }
});

test('C08 saved asset draft focus cannot cross its material version or surviving membership',()=>{
  for(const mismatch of ['version','member']){
    const {c,create}=materialDraftFixture(),target=create('first',mismatch==='version'?2:1);
    if(mismatch==='member'){
      target.detail.material_versions.first[0].members=[target.detail.record];
      target.detail.material_versions.first[0].results=[];target.detail.candidate_records=[];
    }
    c.activateUnifiedCard(target);
    assert.equal(c.state.productionSelected.id,'first-r1',mismatch);
    assert.equal(c.state.anchor,null,mismatch);
  }
});
