const selected=n=>n.children.find(b=>b.attributes['aria-pressed']==='true')?.dataset.choiceId;
const choose=(n,id)=>n.children.find(b=>String(b.dataset.choiceId)===String(id)).onclick();
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
class Element{
 constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.attributes={};this.isConnected=true;this.classList={add(){},remove(){},toggle(){}}}
 append(...nodes){this.children.push(...nodes)}replaceChildren(...nodes){this.children=[...nodes]}setAttribute(k,v){this.attributes[k]=v}addEventListener(){}all(){return this.children.flatMap(node=>[node,...node.all()])}
}
function setup(){
 const row=(object,kind,id,payload={})=>({object_id:object,kind,id,current_revision:id,version:1,payload:{title:object,blocks:[{id:'description',text:object+' exact text'}],...payload}});
 const plan=row('need','REQUIREMENT','plan',{media_type:'audio',scope:{object_id:'form',revision_id:'form-v1'}});
 const callA=row('call-a','CALL','call-a-v1'),callB=row('call-b','CALL','call-b-v1');
 const asset=(object,id,call)=>row(object,'ASSET',id,{media_type:'audio',production:{object_id:call.object_id,revision_id:call.id},components:[{id:'original',role:'original',mime:'audio/wav',sha256:id}]});
 const a=asset('asset-a','a-new',callA),oldA=asset('asset-a','a-old',callA),b=asset('asset-b','b-exact',callB);
 const rounds=[{number:2,state:'produced',plan,members:[plan,a,callA],results:[a]},{number:1,state:'produced',plan,members:[plan,oldA,b,callA,callB],results:[oldA,b]}];
 const detail={record:b,history:[b],review_context:{call:callB,requirements:[plan]},review_contexts:{[a.id]:{call:callA,requirements:[plan]},[oldA.id]:{call:callA,requirements:[plan]},[b.id]:{call:callB,requirements:[plan]}},material_versions:{need:rounds}};
 const root=new Element('main'),requests=[];
 const ctx={URL,URLSearchParams,CSS:{escape:x=>x},console,setTimeout:()=>1,clearTimeout(){},getSelection:()=>null,location:{href:'http://local/?workspace=materials.workspace&production_object=previous&material_round=2&material_target=previous'},history:{replaceState(_a,_b,u){ctx.location.href=String(u)}},localStorage:{getItem:()=>null},document:{addEventListener(){},querySelector:s=>s==='#production-reader'?root:null,querySelectorAll:()=>[],createElement:tag=>new Element(tag)},fetch:async url=>{requests.push(url);return {ok:true,json:async()=>detail}}};
 ctx.Option=function(text,value){const n=new Element('option');n.textContent=text;n.value=value;return n};vm.createContext(ctx);require('./load_review_helpers.cjs')(ctx);
 ctx.document.createElementNS=(_namespace,tag)=>new Element(tag);
 for(const name of ['app.js','production.js','material-review.js','entity-review.js','production-breakdown.js','unified-cards.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static',name),'utf8'),ctx);
 vm.runInContext('globalThis.state=state;',ctx);ctx.state.workspace='materials.workspace';ctx.state.productionRecords=[plan,a,b];ctx.state.materialReview={record:{object_id:'previous'}};
 ctx.renderComments=()=>{};ctx.paintProductionReview=()=>{};ctx.focusMaterialRoundControl=()=>{};
 // Load the same shared card and draft-context dependencies as index.html.
 // Keep the real navigation, workspace/card renderer, round/candidate controls
 // and focus callbacks. Substitute only media internals and text decoration.
 ctx.reviewSurface=host=>host;ctx.materialMedia=(parent,item)=>{const n=new Element('media');n.dataset.reviewRevision=item.record.id;n.dataset.objectId=item.record.object_id;n.onfocus=()=>ctx.focusProductionReview({record:item.record,history:[item.record],uses:[]});parent.append(n)};
 ctx.renderActualGeneration=(parent,context)=>{const n=new Element('call');n.dataset.revision=context?.call?.id;parent.append(n)};
 ctx.reviewTextBlocks=(parent,r)=>{const n=new Element('text');n.dataset.revision=r.id;n.textContent=r.payload.blocks[0].text;parent.append(n)};
 const nodes=tag=>root.all().filter(n=>n.tag===tag),roundControl=()=>root.all().find(n=>n.attributes['aria-label']==='素材版本');
 return {ctx,root,requests,plan,a,oldA,b,rounds,detail,nodes,roundControl};
}
for(const explicit of [false,true])test(`${explicit?'exact link':'asset index'} opens B in its own older round, with B media, call, text and comment target`,async()=>{
 const f=setup();await f.ctx.openProductionRecord(f.b.object_id,explicit?f.b.id:null);
 assert.equal(selected(f.roundControl()),1);assert.deepEqual(f.nodes('media').map(n=>n.dataset.reviewRevision),[f.b.id]);assert.deepEqual(f.nodes('call').map(n=>n.dataset.revision),['call-b-v1']);assert.deepEqual(f.nodes('text').map(n=>n.dataset.revision),[f.b.id]);
 const choice=f.root.all().find(n=>n.attributes['aria-label']==='本轮候选');assert.equal(selected(choice),f.b.id);
 f.nodes('media')[0].onfocus();assert.equal(f.ctx.state.productionSelected.id,f.b.id);assert.equal(new URL(f.ctx.location.href).searchParams.get('material_target'),f.b.id);assert.equal(f.requests.length,1);
});
test('the actual asset renderer defaults to its own exact candidate without relying on a URL target',()=>{
 const f=setup();f.ctx.location.href='http://local/?workspace=materials.workspace';f.ctx.state.materialReview=f.detail;f.ctx.renderMaterialWorkspace(f.root,f.detail);
 assert.equal(selected(f.roundControl()),1);assert.equal(f.nodes('media')[0].dataset.reviewRevision,f.b.id);assert.equal(f.nodes('text')[0].dataset.revision,f.b.id);
});
test('a deliberate round change still opens that round and allows returning to the saved exact candidate',async()=>{
 const f=setup();await f.ctx.openProductionRecord(f.b.object_id);let select=f.roundControl();await choose(select,2);
 assert.equal(selected(f.roundControl()),2);assert.equal(f.nodes('media')[0].dataset.reviewRevision,f.a.id);assert.equal(f.ctx.state.productionSelected.id,f.a.id);
 select=f.roundControl();await choose(select,1);assert.equal(selected(f.roundControl()),1);assert.equal(f.nodes('media')[0].dataset.reviewRevision,f.b.id);assert.equal(f.ctx.state.productionSelected.id,f.b.id);
});
for(const explicit of [false,true])test(`${explicit?'explicit':'ordinary'} PLAN respects an exact target or defaults to a generated version`,async()=>{
 const f=setup();f.rounds[0].state='preparing';f.rounds[0].members=[f.plan];f.rounds[0].results=[];f.detail.record=f.plan;f.detail.history=[f.plan];f.detail.candidate_records=[f.oldA,f.b];
 await f.ctx.openProductionRecord(f.plan.object_id,explicit?f.plan.id:null);
 assert.equal(selected(f.roundControl()),explicit?2:1);assert.equal(f.nodes('media').length,explicit?0:1);
});
test('an asset remains readable in its historical round while a newer round is preparing',async()=>{
 const f=setup();f.rounds[0].state='preparing';f.rounds[0].members=[f.plan];f.rounds[0].results=[];await f.ctx.openProductionRecord(f.b.object_id);
 assert.equal(selected(f.roundControl()),1);assert.equal(f.nodes('media')[0].dataset.reviewRevision,f.b.id);
 const select=f.roundControl();await choose(select,2);assert.equal(selected(f.roundControl()),2);assert.equal(f.nodes('media').length,0);
});
test('multiple material memberships retain the explicitly selected nonfirst card and its matching exact round',()=>{
 const f=setup(),otherPlan={...f.plan,object_id:'other',id:'other-plan',payload:{...f.plan.payload,title:'Other material'}};
 f.detail.material_versions.other=f.rounds.map(round=>({...round,number:round.number+2,plan:otherPlan,members:round.members.map(r=>r===f.plan?otherPlan:r)}));
 f.ctx.state.materialReview=f.detail;f.ctx.state.materialCommentCard={data:f.detail,material_id:'other',number:4};f.ctx.location.href='http://local/?workspace=materials.workspace';f.ctx.renderMaterialWorkspace(f.root,f.detail);
 const card=f.root.all().find(n=>n.className==='material-card');assert.equal(card.dataset.materialKey,'other');assert.equal(selected(f.roundControl()),3);assert.equal(f.nodes('media')[0].dataset.reviewRevision,f.b.id);assert.equal(f.detail.selectedMaterialRounds.need,undefined);
});
test('a previous detail card cannot override the newly opened asset membership',async()=>{
 const f=setup();f.ctx.state.materialCommentCard={data:f.ctx.state.materialReview,material_id:'other',number:9};await f.ctx.openProductionRecord(f.b.object_id);
 const card=f.root.all().find(n=>n.className==='material-card');assert.equal(card.dataset.materialKey,'need');assert.equal(selected(f.roundControl()),1);assert.equal(f.nodes('media')[0].dataset.reviewRevision,f.b.id);
});

for(const exact of [false,true])test(`unified material ${exact?'exact reference':'fresh entry'} ignores another card's version in the caller URL`,()=>{
 const f=setup();f.ctx.location.href='http://local/?workspace=materials.workspace&material_page=2&material_media=audio&material_id=foreign&material_round=9&material_target=foreign-result';
 const params=new URLSearchParams(exact?'material_id=need&material_round=1&material_target=b-exact':'');
 f.detail.legacy_material_versions=f.detail.material_versions;
 const result={entity_review:null,detail:f.detail,params,explicit:true};
 f.ctx.validateUnifiedReference(result);f.ctx.activateUnifiedCard(result);f.ctx.renderMaterialWorkspace(f.root,f.detail);
 assert.equal(selected(f.roundControl()),1);assert.equal(f.nodes('media')[0].dataset.reviewRevision,f.b.id);
 const url=new URL(f.ctx.location.href);assert.equal(url.searchParams.get('material_page'),'2');assert.equal(url.searchParams.get('material_media'),'audio');assert.notEqual(url.searchParams.get('material_id'),'foreign');assert.equal(url.searchParams.get('material_round'),'1');
});

for(const explicit of [false,true])test(`deduplicated ${explicit?'exact link':'asset index'} keeps the requested member and submits its accurate judgment`,async()=>{
 const f=setup();f.a.payload.production={...f.b.payload.production};f.a.payload.components=f.b.payload.components.map(c=>({...c}));
 f.detail.record=f.a;f.detail.history=[f.a];f.detail.review_context=f.detail.review_contexts[f.b.id];f.detail.review_contexts[f.a.id]=f.detail.review_context;
 f.rounds.splice(0,f.rounds.length,{number:1,state:'produced',plan:f.plan,members:[f.plan,f.a,f.b],results:[f.b]});
 const before=JSON.stringify(f.rounds);await f.ctx.openProductionRecord(f.a.object_id,explicit?f.a.id:null);
 assert.equal(selected(f.roundControl()),1);assert.deepEqual(f.nodes('media').map(n=>n.dataset.reviewRevision),[f.a.id]);assert.deepEqual(f.nodes('text').map(n=>n.dataset.revision),[f.a.id]);
 const candidates=f.root.all().find(n=>n.attributes['aria-label']==='本轮候选');assert.equal(candidates.children.length,1);assert.equal(candidates.children[0].textContent,'候选1');assert.equal(JSON.stringify(f.rounds),before);
 f.ctx.crypto=require('node:crypto').webcrypto;f.ctx.toast=()=>{};
 await f.nodes('button').find(n=>n.textContent==='记录本版本审阅结论').onclick();
 assert.equal(f.ctx.state.productionSelected.id,f.a.id);assert.equal(new URL(f.ctx.location.href).searchParams.get('material_target'),f.a.id);
 const field=label=>f.root.all().find(n=>n.attributes['aria-label']===label);field('审阅者').value='Technical reviewer';field('结论依据').value='Exact member A';field('审阅结果').value='passed';
 const posts=[];let release;f.ctx.fetch=(url,options)=>{posts.push({url,payload:JSON.parse(options.body)});return new Promise(resolve=>{release=resolve})};
 const saving=f.nodes('button').find(n=>n.textContent==='保存审阅').onclick();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(posts.length,1);assert.deepEqual(JSON.parse(JSON.stringify(posts[0].payload.payload.target)),{object_id:f.a.object_id,revision_id:f.a.id});
 f.ctx.state.workspace='story.sources';release({ok:true,json:async()=>({saved:true})});await saving;
});
