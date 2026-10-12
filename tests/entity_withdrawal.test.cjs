const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
class Element{
 constructor(tag,text=''){this.tag=tag;this._text=text;this.children=[];this.dataset={};this.attrs={};this.style={};this.isConnected=true;this.classList={add(){},remove(){},toggle(){}}}
 replaceChildren(...nodes){this.children=[...nodes]}
 append(...nodes){this.children.push(...nodes)}setAttribute(k,v){this.attrs[k]=v}addEventListener(){}querySelectorAll(){return []}
 closest(){return null}
 get childNodes(){return this.children}set textContent(v){this._text=String(v)}get textContent(){return this._text+this.children.map(n=>n.textContent).join('')}
 all(){return this.children.flatMap(n=>[n,...n.all()])}
}
const row=(object_id,kind,payload={},id=object_id+'-v1')=>({object_id,kind,id,current_revision:id,version:1,payload:{title:object_id,blocks:[{id:'body',text:'原文中的待审说明保留 🧵'}],sources:[],...payload}}),ref=r=>({object_id:r.object_id,revision_id:r.id});
function setup(){
 const entity=row('old-entity','ENTITY',{entity_type:'prop',status:'withdrawn',withdrawal_reason:'已确认归并；保留原件和评论。'},'entity-v2');entity.version=2;
 const form=row('old-state','STATE',{entity:ref(entity),status:'withdrawn',withdrawal_reason:entity.payload.withdrawal_reason},'form-v2');form.version=2;
 const target=row('new-entity','ENTITY'),first=row('new-state','STATE'),second=row('other-state','STATE');entity.payload.merged_into=[ref(target)];form.payload.merged_into=[ref(first),ref(second)];
 const assets=['old-image-a','old-image-b'].map(id=>row(id,'ASSET',{media_type:'image',components:[{id:'original',role:'original',mime:'image/png',sha256:id}]}));const data={entity,states:[],requirements:[],media:assets.map(record=>({record,state:null})),usages:{},versions:{},comment_records:[],comment_targets:[],can_accept:true,can_revoke:false,preparation:{issues:[{message:'尚无完整状态'}]}};
 const opened=[],renderedMedia=[],requests=[],toast=new Element('p'),context={URL,URLSearchParams,console,setTimeout:()=>1,clearTimeout(){},location:{href:'http://isolated/?workspace=settings.workspace'},history:{replaceState(){}},document:{addEventListener(){},querySelector:selector=>selector==='#toast'?toast:null,querySelectorAll:()=>[],createElement:tag=>new Element(tag)}};
 vm.createContext(context);require('./load_review_helpers.cjs')(context);for(const file of ['app.js','production.js','material-review.js','entity-review.js','production-breakdown.js','unified-cards.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static',file),'utf8'),context);
 context.Option=function(text,value){const option=new Element('option',text);option.value=String(value);return option};
 vm.runInContext('globalThis.state=state;',context);Object.assign(context.state,{workspace:'settings.workspace',entityReview:data,productionEntityDetail:{record:entity},productionChildDetail:{record:form},productionSelected:form,productionRecords:[target,first,second],screenplays:[],comments:[]});
 const realRenderMedia=context.renderEntityReviewMedia;
 context.reviewSurface=node=>node;context.renderEntityRelations=()=>{};context.productionEntityIcon=()=>new Element('svg');context.renderEntityReviewMedia=(_parent,items)=>renderedMedia.push(...items);
 context.renderUnifiedModels=(_parent,models)=>renderedMedia.push(...models.flatMap(m=>m.candidates));
 context.renderComments=()=>{};context.renderProductionReader=()=>{};context.paintProductionReview=()=>{};
 context.openProductionRecord=async(...args)=>opened.push(args);context.fetch=async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>({})}};context.reloadEntityReview=async()=>{};context.toast=()=>{};
 const render=()=>{const root=new Element('main');context.renderEntityReview(root);return {root,text:root.textContent,nodes:root.all(),accept:root.all().find(n=>n.tag==='button'&&['认可设计内容','认可设计及制作许可'].includes(n.textContent))}};
 return {context,data,entity,form,target,first,second,assets,opened,renderedMedia,requests,render,realRenderMedia};
}
test('withdrawn exact page preserves content and originals but removes completion cues and follows exact merge references',async()=>{
 const f=setup(),before=JSON.stringify(f.data),view=f.render();
 assert.match(view.text,/此实体已撤回/);assert.match(view.text,/此状态已撤回/);assert.equal(view.text.split(f.entity.payload.withdrawal_reason).length-1,1);assert.match(view.text,/原文中的待审说明保留 🧵/);assert.match(view.text,/素材列表/);
 assert.doesNotMatch(view.text,/生成前待完善|此状态的素材方案待完善|待关联状态|完整状态 · 0/);assert.equal(view.accept,undefined);assert.equal(f.requests.length,0);
 const targets=view.nodes.filter(n=>n.tag==='button'&&[f.target.payload.title,f.first.payload.title,f.second.payload.title].includes(n.textContent));assert.equal(targets.length,3);for(const button of targets)await button.onclick();
 assert.deepEqual(f.opened,[[f.target.object_id,f.target.id,true],[f.first.object_id,f.first.id,true],[f.second.object_id,f.second.id,true]]);
 assert.deepEqual(f.renderedMedia.map(m=>m.record.id),f.assets.map(r=>r.id));assert.deepEqual(f.data.media.map(m=>m.record.id),f.assets.map(r=>r.id));delete f.data.unassignedOpen;delete f.data.evidenceViews;delete f.data.unifiedMaterialId;assert.equal(JSON.stringify({...f.data,materialTab:undefined}),before);
});
test('old v1 remains unchanged while a proven current withdrawal is stated separately',()=>{
 const f=setup(),oldEntity=row(f.entity.object_id,'ENTITY',{entity_type:'prop'},'entity-v1'),oldForm=row(f.form.object_id,'STATE',{entity:ref(oldEntity)},'form-v1');oldEntity.current_revision=f.entity.id;oldForm.current_revision=f.form.id;
 f.context.state.productionEntityDetail.record=oldEntity;f.context.state.productionChildDetail.record=oldForm;const before=JSON.stringify([oldEntity,oldForm]),view=f.render();
 assert.match(view.text,/此实体当前已撤回/);assert.doesNotMatch(view.text,/此状态已撤回|此状态的素材方案待完善/);assert.equal(JSON.stringify([oldEntity,oldForm]),before);assert.equal(oldEntity.payload.status,undefined);assert.equal(oldForm.payload.merged_into,undefined);assert.equal(view.accept,undefined);
});
test('old acceptance without the current payload does not infer withdrawal from historical or a newer head id',()=>{
 const f=setup();f.context.CSS={escape:s=>s};const old=row('old-entity','ENTITY',{entity_type:'prop'},'entity-v1');old.current_revision='unloaded-v2';f.data.entity=old;f.data.historical=true;f.context.state.productionEntityDetail.record=old;f.context.state.productionChildDetail=null;f.data.media=[];
 const view=f.render();assert.doesNotMatch(view.text,/已撤回|归并至/);assert.equal(view.accept,undefined);
});
test('an explicitly withdrawn historical version is not labeled as the current entity status after reactivation',()=>{
 const f=setup(),current=row(f.entity.object_id,'ENTITY',{entity_type:'prop'},'entity-v3');f.entity.current_revision=current.id;f.data.entity=current;f.context.state.productionChildDetail=null;
 const view=f.render();assert.match(view.text,/此实体版本已撤回/);assert.doesNotMatch(view.text,/此实体当前已撤回|此实体已撤回/);assert.equal(view.accept,undefined);
});
test('a withdrawn state does not fabricate withdrawal of its active entity or remove real current entity issues',()=>{
 const f=setup();delete f.entity.payload.status;delete f.entity.payload.withdrawal_reason;delete f.entity.payload.merged_into;const view=f.render();
 assert.match(view.text,/此状态已撤回/);assert.doesNotMatch(view.text,/此实体.*撤回|此状态的素材方案待完善/);assert.doesNotMatch(view.text,/生成前待完善/);assert.equal(view.accept,undefined);
});
test('missing cause and destinations remain unknown; a different cached target revision cannot supply its historical title',()=>{
 const f=setup();delete f.entity.payload.withdrawal_reason;delete f.form.payload.withdrawal_reason;f.form.payload.merged_into=null;f.target.id='new-entity-v9';f.target.payload.title='新版名称不冒充旧版';const view=f.render();
 assert.match(view.text,/此实体已撤回/);assert.match(view.text,/查看归并去向 1/);assert.doesNotMatch(view.text,/已确认归并|新版名称不冒充旧版/);
});
test('active current records retain their completion hints, original media section without an approval callback',async()=>{
 const f=setup();for(const r of [f.entity,f.form]){delete r.payload.status;delete r.payload.withdrawal_reason;delete r.payload.merged_into}f.data.states=[f.form];f.data.scope={entity:ref(f.entity),states:[ref(f.form)]};f.data.decision_version=0;const view=f.render();
 assert.doesNotMatch(view.text,/已撤回|归并至|保留素材/);assert.match(view.text,/素材列表/);assert.match(view.text,/基础状态/);assert.doesNotMatch(view.text,/生成前待完善/);assert.equal(view.accept,undefined);
 assert.equal(f.requests.length,0);
});
test('a withdrawn plan with an existing recipe and result retains its exact commentable fields and original',()=>{
 const f=setup(),need=row('need','REQUIREMENT',{status:'withdrawn',media_type:'image',generation:{model:'technical',parameters:{},inputs:[],prompt:'原方案仍可评论',output:{name:'准确旧方案'}}});
 const item={record:f.assets[0],component:{id:'original'}};const shown=[];f.context.materialMedia=(_host,value)=>shown.push(value);f.context.renderActualGeneration=()=>{};
 const parent=new Element('main');f.context.renderMaterialCard(parent,{need,candidates:[item]});assert.match(parent.textContent,/此素材需求已撤回/);assert.doesNotMatch(parent.textContent,/查看原方案/);assert.match(parent.textContent,/历史生成依据/);assert.doesNotMatch(parent.textContent,/原方案仍可评论/);assert.equal(need.payload.generation.prompt,'原方案仍可评论');assert.deepEqual(shown,[item]);assert.ok(!parent.all().some(n=>n.dataset.productionBlocks===need.id));assert.doesNotMatch(parent.textContent,/此版本未附生成方案/);
});
test('an active material without a recipe or result keeps its actionable placeholder and preparation message',()=>{
 const f=setup(),need=row('need','REQUIREMENT',{media_type:'image'}),parent=new Element('main');f.context.renderMaterialCard(parent,{need,candidates:[]});
 assert.match(parent.textContent,/图像 · 未生成/);assert.match(parent.textContent,/原文中的待审说明保留/);assert.doesNotMatch(parent.textContent,/撤回|此版本未附生成方案/);
});
