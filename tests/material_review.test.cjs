const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const ctx={URLSearchParams,state:{productionRecords:[]}};vm.createContext(ctx);require('./load_review_helpers.cjs')(ctx);
for(const f of ['production.js','material-review.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static',f),'utf8'),ctx);
const need=(id,revision=id+'-v1',media='image')=>({object_id:id,id:revision,current_revision:revision,payload:{media_type:media}});
const item=(id,refs,media='image')=>({id,record:{object_id:id,id:id+'-v1',payload:{media_type:media,candidate_requirements:refs}}});
const ref=r=>({object_id:r.object_id,revision_id:r.id});
test('old design demands keep their own definition without assigning another plan results to them',()=>{
 const old={...need('shot-video','old','video'),kind:'REQUIREMENT',version:1,current_revision:'now',payload:{media_type:'video',scope:{object_id:'shot',revision_id:'design-one'},generation:{prompt:'old start to old end'}}};
 const current={...old,id:'now',version:2,payload:{...old.payload,scope:{object_id:'shot',revision_id:'design-two'},generation:{prompt:'new start to new end'}}};
 const round={number:1,plan:current,definition_records:{requirement:current},members:[old,current],results:[{id:'actual',object_id:'asset',kind:'ASSET',payload:{components:[{role:'original'}]}}]};
 for(const frozen of [false,true]){
  round.frozen=frozen;const data={material_versions:{'shot-video':[round]}};
  const before=JSON.stringify(round),model=ctx.materialRoundModels([old],[],data)[0];
  assert.equal(model.need,old);assert.equal(model.historicalRecipe,true);assert.equal(model.candidates.length,0);assert.equal(JSON.stringify(round),before);
  assert.equal(ctx.materialHistoricalDefinition(current,round),false);
 }
 assert.equal(ctx.materialHistoricalDefinition(old,{definition_records:{requirement:old}}),false);
 assert.equal(ctx.materialHistoricalDefinition(old,{definition_records:{}}),true,'missing definition does not fill an exact old record from a head');
});
test('material opinion groups explain the old record without moving its comment to the current definition',()=>{
 const old={...need('video','old'),kind:'REQUIREMENT',version:1,payload:{title:'old'}},current={...old,id:'current',version:4};
 const c={state:{productionSelected:current,materialReview:{record:current,history:[old]},comments:[]},businessTitle:r=>r.payload.title,commentCard:c=>c};vm.createContext(c);vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static/material-review.js'),'utf8'),c);
 const labels=[],rendered=[];c.nodeText=(_tag,_class,text)=>labels.push(text);
 const comment={id:'old-opinion',target_revision_id:'old'},newComment={id:'new-opinion',target_revision_id:'current'};
 c.appendMaterialReviewComments({append:v=>rendered.push(v)},[comment,newComment]);
 assert.deepEqual(labels,['原方案意见 · old · 需求记录 1','所读记录的意见']);assert.deepEqual(rendered,[comment,newComment]);assert.equal(comment.target_revision_id,'old');
});
test('old demand with no recorded output remains readable and does not borrow current output text',()=>{
 const c={state:{comments:[]},productionTextBlocks:()=>[],materialTextSurface:x=>x,materialField:()=>{},el:()=>({}),nodeText:()=>{}};vm.createContext(c);vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static/material-review.js'),'utf8'),c);
 c.materialTextSurface=x=>x;
 assert.doesNotThrow(()=>c.renderMaterialRequirements({append(){}},{id:'old',payload:{title:'old',generation:{prompt:'kept'}}}));
});
test('an external edit displays its actual production note without inventing an unknown model',()=>{
 const c={};vm.createContext(c);vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static/material-review.js'),'utf8'),c);
 const text=[];c.el=()=>({});c.nodeText=(_t,_c,value)=>text.push(value);c.materialTextSurface=x=>x;c.renderMaterialInputs=()=>{};
 c.materialField=(_host,_row,_field,label)=>text.push(label);c.materialParameters=()=>assert.fail('external edit is not a model call');
 c.renderActualGeneration({append(){}},{call:{payload:{method:'external-edit',tool:'vector editor',inputs:[],prompt:'layout'}}});
 assert.deepEqual(text,['制作记录','vector editor','制作说明']);
});
test('an exact review link chooses its candidate and its original call, not the first result',()=>{
 const a={record:{id:'first'},review_context:{call:{id:'call-first'}}},b={record:{id:'requested'},review_context:{call:{id:'call-requested'}}};
 assert.equal(ctx.materialCandidateChoice([a,b],'requested'),b);
 assert.equal(ctx.materialCandidateChoice([a,b],'call-requested'),b);
 assert.equal(ctx.materialCandidateChoice([a,b],'missing'),a);
 assert.equal(ctx.materialCandidateChoice([],'requested'),null);
});
test('a historical target keeps its exact revision after feedback updates the asset metadata',()=>{
 const original={id:'original',role:'original',sha256:'same-file'};
 const old={object_id:'asset',id:'old',kind:'ASSET',payload:{production:{object_id:'call'},components:[original]}};
 const current={...old,id:'current'},other={...old,object_id:'other',id:'other'};
 const requestedContext={call:{id:'actual-call'},requirements:[]};
 const detail={record:current,history:[current,old],review_contexts:{old:requestedContext}};
 const items=[{record:other,component:original},{record:current,component:original}];
 const exact=ctx.materialExactCandidates(detail,items,'old');
 assert.equal(exact[0],items[0]);assert.equal(exact[1].record,old);assert.equal(exact[1].review_context,requestedContext);
 assert.equal(ctx.materialCandidateChoice(exact,'old').record.id,'old');assert.equal(items[1].record.id,'current');
 const different={...current,payload:{production:{object_id:'other-call'},components:[original]}};
 assert.equal(ctx.materialExactCandidates(detail,[{record:different,component:original}],'old')[0].record,different);
});

test('an exact member replaces its deduplicated representative without expanding or mutating the round',()=>{
 const original={id:'original',role:'original',sha256:'same-file'},preview={id:'preview',role:'preview',sha256:'a-preview'};
 const a={object_id:'a',id:'a-revision',kind:'ASSET',payload:{production:{object_id:'call',revision_id:'call-revision'},components:[original,preview]}},b={...a,object_id:'b',id:'b-revision'};
 const ownContext={call:{id:'call-revision'},requirements:[]},round={members:[a,b],results:[b]},detail={record:a,history:[a],review_context:ownContext};
 const items=[{record:b,component:{id:'removed-preview',role:'preview'},review_context:{call:{id:'wrong-old-call'}}}],before=JSON.stringify({round,items});
 const exact=ctx.materialExactCandidates(detail,items,a.id,round);
 assert.equal(exact.length,1);assert.equal(exact[0].record,a);assert.equal(exact[0].component,original);assert.equal(exact[0].review_context,ownContext);assert.equal(JSON.stringify({round,items}),before);
});
test('exact fallback cannot borrow a nonmember from another round or a different original or call',()=>{
 const row=(object,call,sha)=>({object_id:object,id:object+'-revision',kind:'ASSET',payload:{production:{object_id:call,revision_id:call+'-revision'},components:[{id:'original',role:'original',sha256:sha}]}});
 const a=row('a','call','sha'),detail={record:a,history:[a]};
 for(const [b,members] of [[row('b','call','sha'),[]],[row('b','other-call','sha'),[a]],[row('b','call','different-sha'),[a]]]){
  const items=[{record:b,component:b.payload.components[0]}],round={members:[...members,b],results:[b]};
  assert.equal(ctx.materialExactCandidates(detail,items,a.id,round),items);
 }
});
test('exact member substitution prefers its own object and preserves other distinct candidates',()=>{
 const original={id:'original',role:'original',sha256:'same'},a={object_id:'a',id:'a-old',kind:'ASSET',payload:{production:{object_id:'call'},components:[original]}},newA={...a,id:'a-new'},b={...a,object_id:'b',id:'b-revision'},other={...a,object_id:'other',id:'other',payload:{...a.payload,production:{object_id:'another-call'}}};
 const items=[b,newA,other].map(record=>({record,component:original})),round={members:[a,newA,b,other],results:[b,newA,other]},detail={record:newA,history:[newA,a]};
 const exact=ctx.materialExactCandidates(detail,items,a.id,round);assert.equal(exact.length,3);assert.equal(exact[0],items[0]);assert.equal(exact[1].record,a);assert.equal(exact[2],items[2]);
});
test('cards preserve exact plan candidates and do not attach an old candidate to a new recipe',()=>{
 const a=need('a'),b=need('b'),old=need('a','a-old'),clip=item('clip',[ref(a),ref(b)]),previous=item('old',[ref(old)]);
 const cards=ctx.materialCardModels([a,b],[clip,previous]);
 assert.equal(cards.length,3);assert.equal(cards[0].candidates[0],clip);assert.equal(cards[1].candidates[0],clip);
 assert.equal(cards[2].need,null);assert.equal(cards[2].candidates[0],previous);
 assert.equal(ctx.materialCardModels([a],[previous])[0].candidates.length,0);
});
test('audio and image remain individual material cards without media-type columns',()=>{
 const cards=ctx.materialCardModels([need('voice',undefined,'audio'),need('front'),need('back')],[]);
 assert.equal(cards.length,3);assert.equal(cards[0].need.object_id,'front');assert.equal(cards[1].need.object_id,'back');assert.equal(cards[2].need.object_id,'voice');
});
test('CALL review uses server numeric spelling and omits only a duplicate prompt parameter',()=>{
 const row={payload:{format:'production-call-v1',blocks:[],model:'m',parameters:{prompt:'words',pitch:1},prompt:'words'},review_call_parameter_text:'{\n  "pitch": 1.0\n}'};
 const blocks=ctx.productionTextBlocks(row);assert.equal(blocks.find(b=>b.field==='call.parameters').text,row.review_call_parameter_text);
 assert.equal(blocks.find(b=>b.field==='call.prompt').text,'words');assert.equal(row.payload.parameters.prompt,'words');
});
test('older asset versions keep their card using placement context without rewriting history',()=>{
 const current=need('voice','v3','audio'),previous=item('voice-asset',[],'audio');
 previous.placement_requirements=[ref(current)];const before=JSON.stringify(previous.record);
 const cards=ctx.materialCardModels([current],[previous]);assert.equal(cards.length,1);assert.equal(cards[0].candidates[0],previous);assert.equal(JSON.stringify(previous.record),before);
});

test('relationship labels changed independently of prose still have an exact anchor',()=>{
 const r={payload:{format:'production-relation-v1',relation_type:'entity',blocks:[{id:'relationship',text:'旧说法'}],label:'保管歌本'}};
 const block=ctx.productionTextBlocks(r).find(b=>b.field==='relationship.label');assert.equal(block.text,'保管歌本');assert.equal(block.id,'@review/relationship/label');
});

test('story references use the exact source reader and preserve scene and block limits',()=>{
 const ref={object_id:'episode',revision_id:'old-version',scene_id:'s010',block_ids:['b005','b006']};
 const request=ctx.materialReferenceRequest(ref,true),url=new URL(request.url,'http://localhost');
 assert.equal(request.isSource,true);assert.equal(url.pathname,'/api/production/source');
 assert.equal(url.searchParams.get('revision_id'),'old-version');assert.equal(url.searchParams.get('scene_id'),'s010');assert.equal(url.searchParams.get('block_ids'),'b005,b006');
 // Even an unscoped story/structure/source reference must not use production-get.
 assert.equal(ctx.materialReferenceRequest({object_id:'story',revision_id:'r1'}).isSource,true);
});

test('material references retain their exact media reader; explicit evidence can cite an entity',()=>{
 ctx.state.productionRecords=[{object_id:'voice',kind:'ASSET'},{object_id:'person',kind:'ENTITY'}];
 const ref={object_id:'voice',revision_id:'voice-v1'};
 assert.equal(new URL(ctx.materialReferenceRequest(ref).url,'http://localhost').pathname,'/api/production');
 assert.equal(ctx.materialReferenceRequest({object_id:'person',revision_id:'person-v1'},true).isSource,true);
 ctx.state.productionRecords=[];
 assert.equal(ctx.materialReferenceRequest(ref,false).isSource,false);
});

test('materials count current identities and show only genuine missing state demands',()=>{
 const form={object_id:'form',id:'form-v2',kind:'STATE',payload:{state_model:'complete-v1'}};
 const demand={...need('need'),kind:'REQUIREMENT',payload:{media_type:'image',scope:ref(form)}};
 const oldDemand={...need('old-need'),kind:'REQUIREMENT',payload:{media_type:'audio',scope:{object_id:'form',revision_id:'form-v1'}}};
 const shotDemand={...need('shot-need'),kind:'REQUIREMENT',payload:{media_type:'video',scope:{object_id:'shot',revision_id:'shot-v1'}}};
 const relation={object_id:'rel',kind:'RELATION',payload:{relation_type:'entity'}};
 const records=[form,demand,oldDemand,shotDemand,relation];
 assert.deepEqual(Array.from(ctx.productionWorkspaceRows(records,'materials.workspace'),r=>r.object_id),['need','old-need','shot-need']);
 const asset={object_id:'asset',kind:'ASSET',payload:{media_type:'image',components:[{id:'original'}],candidate_requirements:[ref(demand)]}};
 records.push(asset);
 assert.deepEqual(Array.from(ctx.productionWorkspaceRows(records,'materials.workspace'),r=>r.object_id),['need','old-need','shot-need']);
 assert.equal(ctx.productionWorkspaceRows(records,'materials.workspace')[0].material_generated,false);
 asset.payload.components[0].role='original';assert.equal(ctx.productionWorkspaceRows(records,'materials.workspace')[0].material_generated,true);
 asset.payload.placeholder=true;
 assert.ok(ctx.productionWorkspaceRows(records,'materials.workspace').some(r=>r.object_id===demand.object_id&&!r.material_generated));
});

test('content facets include actual calls, review conclusions and adoption through their material',()=>{
 const audio={object_id:'audio',kind:'ASSET',payload:{media_type:'audio'}};
 const call={object_id:'call',kind:'CALL',payload:{outputs:[{object_id:'audio',revision_id:'a1'}]}};
 const judgment={object_id:'judgment',kind:'JUDGMENT',payload:{target:{object_id:'call',revision_id:'c1'}}};
 const adoption={object_id:'adoption',kind:'RELATION',payload:{asset:{object_id:'audio',revision_id:'a1'}}};
 const by=new Map([audio,call,judgment,adoption].map(r=>[r.object_id,r]));
 for(const r of [call,judgment,adoption])assert.deepEqual(Array.from(ctx.productionFilterMediaTypes(r,by)),['audio']);
 call.payload.outputs.push({object_id:'judgment',revision_id:'j1'});
 assert.deepEqual(Array.from(ctx.productionFilterMediaTypes(call,by)),['audio']);
});

test('review workspaces have no manual-entry forms or workflow navigation',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../review_desk/static/production.js'),'utf8')+fs.readFileSync(path.join(__dirname,'../review_desk/static/material-review.js'),'utf8');
 for(const forbidden of ['showProductionImport','showProductionUpload','showProductionEditor','showProductionStateNeed','showProductionCoverage','剧本依据 → 制作设定 → 实际素材 → 镜头输入'])assert.ok(!source.includes(forbidden),forbidden);
});

const ui={...ctx,document:{addEventListener(){}}};vm.createContext(ui);require('./load_review_helpers.cjs')(ui);vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static/review-ui.js'),'utf8'),ui);
test('block scope aggregates all live statuses and anchor kinds, excludes other blocks and versions, deduplicates',()=>{
 const c=(id,r,anchor,status='OPEN')=>({id,target_revision_id:r,anchor,status});
 const rows=[c('a','r',{type:'text',block_id:'prompt'}),c('b','r',{type:'global'},'CLOSED'),c('c','r',{type:'text',block_id:'other'}),c('d','old',{type:'text',block_id:'prompt'}),c('a','r',{type:'text',block_id:'prompt'})];
 assert.deepEqual(Array.from(ui.reviewBlockComments(rows,{revision:'r',kind:'text',blockIds:['prompt']}),c=>c.id),['a','b']);
 const media=[c('region','r',{type:'region',visual_id:'one',asset_file:'a.png'}),c('whole','r',{type:'visual',visual_id:'one',asset_file:'a.png'},'CLOSED'),c('other','r',{type:'visual',visual_id:'two',asset_file:'b.png'})];
 assert.deepEqual(Array.from(ui.reviewBlockComments(media,{revision:'r',kind:'image',visualId:'one',file:'a.png'}),c=>c.id),['region','whole']);
 const audio=[c('t','r',{type:'time',component_id:'original',asset_file:'a.wav',start_seconds:1,end_seconds:3}),c('outside','r',{type:'time',component_id:'original',asset_file:'a.wav',start_seconds:8,end_seconds:9}),c('file','r',{type:'time',component_id:'original',asset_file:'b.wav',start_seconds:1,end_seconds:3})];
 assert.deepEqual(Array.from(ui.reviewBlockComments(audio,{revision:'r',kind:'audio',componentId:'original',file:'a.wav',from:0,to:5}),c=>c.id),['t']);
});
test('effective inputs retain source order and type numbering, include exact storyline context',()=>{
 const refs=[{kind:'ENTITY',id:'person',object_id:'person',payload:{}},{kind:'ASSET',id:'i',object_id:'i',payload:{components:[{id:'original',mime:'image/png'}]}},{kind:'ASSET',id:'a',object_id:'a',payload:{components:[{id:'original',mime:'audio/wav'}]}},{kind:'ASSET',id:'j',object_id:'j',payload:{components:[{id:'original',mime:'image/png'}]}}];
 const inputs=refs.map(r=>({object_id:r.object_id,revision_id:r.id,component_id:r.kind==='ASSET'?'original':undefined}));
 const items=ctx.materialInputs(inputs,refs);assert.deepEqual(Array.from(items,i=>i.label),['实体','图片1','音频1','图片2']);assert.deepEqual(Array.from(items,i=>i.index),[0,1,2,3]);assert.equal(ctx.materialInputs([],refs).length,0);
});

test('carried text revisions keep comments inside the selected material round',()=>{
 const rows=[{id:'one',target_revision_id:'same',anchor:{type:'text',block_id:'first',end_block_id:'last'},material_scopes:[{material_id:'need',number:1}]},{id:'two',target_revision_id:'same',anchor:{type:'global'},material_scopes:[{material_id:'need',number:2}]}];
 const scope={revision:'same',materialId:'need',materialNumber:1,kind:'text',blockIds:['middle'],orderedBlockIds:['first','middle','last']};
 assert.deepEqual(Array.from(ui.reviewBlockComments(rows,scope),c=>c.id),['one']);
 scope.materialNumber=2;assert.deepEqual(Array.from(ui.reviewBlockComments(rows,scope),c=>c.id),['two']);
});

test('an exact historical candidate does not replace other real calls in the same material round',()=>{
 const row=(id,call,sha)=>({id,object_id:'same-asset',payload:{production:{object_id:call},components:[{role:'original',sha256:sha}]}});
 const old=row('old','call1','a'),metadata=row('metadata','call1','a'),other=row('other','call2','b');
 const round={results:[metadata,other],members:[old,metadata,other]};
 assert.deepEqual(Array.from(ctx.materialRoundResults(round,old,true),r=>r.id),['old','other']);
 assert.deepEqual(Array.from(ctx.materialRoundResults(round,other,true),r=>r.id),['metadata','other']);
});

test('a preparing round owns its older results without showing duplicate current cards',()=>{
 const demand={...need('demand'),kind:'REQUIREMENT'};
 const old={...item('asset',[ref(demand)]).record,kind:'ASSET'};
 old.payload.components=[{id:'original',role:'original'}];
 const first={number:1,plan:demand,results:[old],members:[demand,old]};
 const pending={number:2,plan:demand,results:[],members:[demand]};
 const data={material_versions:{demand:[pending,first]}};
 const cards=ctx.materialRoundModels([demand],[{record:old}],data);
 assert.equal(cards.length,1);assert.equal(cards[0].round.number,1);assert.equal(cards[0].candidates.length,1);
 data.selectedMaterialRounds.demand=1;
 const history=ctx.materialRoundModels([demand],[{record:old}],data);
 assert.equal(history.length,1);assert.equal(history[0].candidates[0].record.id,old.id);
});

test('shared media use its associated requirement round even outside the visible state plans',()=>{
 const demand={...need('other-state-demand'),kind:'REQUIREMENT'};
 const asset={...item('shared-voice',[ref(demand)],'audio').record,kind:'ASSET'};
 asset.payload.components=[{id:'original',role:'original'}];
 const round={number:1,plan:demand,results:[asset],members:[demand,asset]};
 const data={material_versions:{'other-state-demand':[round]}};
 const cards=ctx.materialRoundModels([],[{record:asset}],data);
 assert.equal(cards.length,1);assert.equal(cards[0].material_id,demand.object_id);
 assert.equal(cards[0].round.number,1);assert.equal(cards[0].need.id,demand.id);
});

test('a pending material round keeps earlier results inside history instead of creating duplicate cards',()=>{
 const plan=need('portrait'),asset={id:'old-image',object_id:'portrait-image',kind:'ASSET',payload:{media_type:'image',components:[{id:'original',role:'original'}]}},media={id:'media',record:asset,component:asset.payload.components[0]};
 const old={number:1,plan,members:[plan,asset],results:[asset]},pending={number:2,plan,members:[plan],results:[]};
 const data={material_versions:{portrait:[pending,old]}};
 let cards=ctx.materialRoundModels([plan],[media],data);
 assert.equal(cards.length,1);assert.equal(cards[0].round.number,1);assert.equal(cards[0].candidates.length,1);
 data.selectedMaterialRounds.portrait=1;cards=ctx.materialRoundModels([plan],[media],data);
 assert.equal(cards.length,1);assert.equal(cards[0].candidates[0].record.id,'old-image');
});

test('legacy audio requirements do not inherit an unrelated image card through display sorting',()=>{
 const voice=need('voice',undefined,'audio'),unrelated=item('image',[]);
 const cards=ctx.materialRoundModels([voice],[unrelated],{});
 assert.equal(cards.length,2);assert.equal(cards[0].need,voice);assert.equal(cards[0].candidates.length,0);assert.equal(cards[1].candidates[0],unrelated);
});

test('a shared asset uses its producing requirement rounds on another state instead of database revisions',()=>{
 const plan=need('foreign-plan'),asset={id:'shared-v4',object_id:'shared',kind:'ASSET',version:4,payload:{media_type:'audio',components:[{id:'original',role:'original'}]}};
 const original={id:'shared-media',record:asset,component:asset.payload.components[0],range:{start_seconds:1,end_seconds:2}};
 const old={number:1,plan,members:[plan,asset],results:[asset]},pending={number:2,plan,members:[plan],results:[]};
 const data={material_versions:{'foreign-plan':[pending,old]}};
 let cards=ctx.materialRoundModels([],[original],data);
 assert.equal(cards.length,1);assert.equal(cards[0].material_id,'foreign-plan');assert.equal(cards[0].round.number,1);assert.equal(cards[0].candidates.length,1);
 data.selectedMaterialRounds['foreign-plan']=1;cards=ctx.materialRoundModels([],[original],data);
 assert.equal(cards[0].round.number,1);assert.equal(cards[0].need,plan);assert.deepEqual(cards[0].candidates[0].range,original.range);
});

test('missing exact file composition is reported instead of falling back to another original',()=>{
 const row={id:'r',object_id:'asset',kind:'ASSET',payload:{media_type:'audio',components:[{id:'original',role:'original',mime:'audio/wav'}]}};
 const inputs=[{object_id:'asset',revision_id:'r',component_id:'removed',range:{start_seconds:2,end_seconds:4}}];
 const gap=ctx.materialInputs(inputs,[row])[0];assert.equal(gap.missing,true);assert.equal(gap.ref.component_id,'removed');assert.equal(gap.ref.range.end_seconds,4);
 assert.equal(ctx.materialInputs([{object_id:'lost',revision_id:'old'}],[])[0].missing,true);
});

 test('default round uses the largest generated version and candidate numbers survive metadata edits',()=>{
  const original={role:'original'},asset=(id,n,time)=>({record:{id,candidate_number:n,created_at:time,payload:{components:[original]}}});
  const one=asset('one',1,'2026-10-05'),two=asset('two',2,'2026-10-04');assert.equal(ctx.materialCandidateChoice([one,two],null),two);
  assert.equal(ctx.materialCandidateChoice([one,two],'one'),one);
  const rounds=[{number:9,results:[]},{number:2,results:[two.record]},{number:7,results:[one.record]}];assert.equal(ctx.materialDefaultRound(rounds).number,7);
  for(const r of rounds)r.results=[];assert.equal(ctx.materialDefaultRound(rounds).number,9);
 });

test('shared material cards display the exact definition and candidate without relation lists',async t=>{
 const row=(object,id,kind='REQUIREMENT')=>({object_id:object,id,kind,payload:{title:object,components:[]}});
 const current=row('need','current'),frozen=row('need','frozen'),a=row('asset-a','a','ASSET'),b=row('asset-b','b','ASSET');
 const scenarios=[
  {name:'frozen definition with no active plan',need:null,round:{model:'plan-v1',frozen:true,plan:null,definition_records:{requirement:frozen}},expected:frozen},
  {name:'direct candidate in a frozen material',need:null,identity:a,round:{model:'plan-v1',frozen:true,plan:null,definition_records:{requirement:frozen}},expected:frozen},
  {name:'exact old demand overrides another round definition',need:frozen,exactPreparingRevision:true,round:{definition_records:{requirement:current}},expected:frozen},
  {name:'preparing plan remains its own exact record',need:current,expected:current},
  {name:'missing frozen definition uses exact selected candidate',need:null,round:{definition_records:{}},selectedCandidateId:b.id,expected:b},
  {name:'standalone original uses its own identity',need:null,identity:a,material_id:undefined,expected:a},
  {name:'frozen version without an original still uses its definition',need:null,candidates:[],round:{model:'plan-v1',members:[],definition_records:{requirement:frozen}},expected:frozen},
 ];
 for(const s of scenarios)await t.test(s.name,()=>{
  const c={state:{},URLSearchParams};vm.createContext(c);vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static/material-review.js'),'utf8'),c);
  const node=()=>({dataset:{},append(){},addEventListener(){}}),requests=[];
  c.el=node;c.nodeText=()=>{};c.businessTitle=r=>r.object_id;c.materialModelCode=()=>'';c.reviewPositionText=x=>x;
  c.renderHistoricalProductionDefinition=()=>{};c.materialCompareControl=()=>{};c.renderProductionAcceptance=()=>{};
  c.renderMaterialRelations=()=>assert.fail('relations do not belong in this card');c.renderSelectedGenerationRecipe=(_box,record,candidate)=>requests.push({record,candidate});c.materialRoundControl=()=>{};c.reviewChoiceButtons=()=>{};
  c.materialMedia=()=>{};c.renderActualGeneration=()=>{};c.renderMaterialRequirements=()=>{};c.renderMaterialPlaceholder=()=>{};c.renderGenerationRecipe=()=>{};
  const model={material_id:'need',identity:current,candidates:[a,b].map(record=>({record,components:[],component:{mime:'application/zip'}})),...s};
  const before=JSON.stringify(model);c.renderMaterialCard(node(),model,{selectCandidate:()=>{},selectedCandidateId:s.selectedCandidateId});
  assert.equal(requests.length,1);assert.equal(requests[0].record??null,['ASSET'].includes(s.expected.kind)?null:s.expected);if(s.selectedCandidateId)assert.equal(requests[0].candidate.record.id,s.selectedCandidateId);assert.equal(JSON.stringify(model),before);
 });
});

test('late relation success or error cannot populate a replaced material card',async t=>{
 for(const reject of [false,true])await t.test(reject?'late error':'late success',async()=>{
  let resolve,rejectRequest;const box={isConnected:true,append(){},remove(){assert.fail('detached card should be ignored')}};
  const c={URLSearchParams,state:{materialReview:{}},isEntityReview:()=>false,el:()=>box,api:()=>new Promise((a,b)=>{resolve=a;rejectRequest=b}),nodeText:()=>assert.fail('late card should not render'),rememberMaterialRelations:()=>assert.fail('late card should not alter comment records')};
  vm.createContext(c);vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static/production-breakdown.js'),'utf8'),c);
  const pending=c.renderMaterialRelations({append(){}},'need',{object_id:'need',id:'frozen',payload:{}});box.isConnected=false;c.state.materialReview={};
  if(reject)rejectRequest(new Error('previous object error'));else resolve({relations:[]});await pending;
 });
});

test('original generation details preserve exact calls, missing history and reading position',async t=>{
 function fixture(){
  const frames=[],rendered=[];
  const node=tag=>({tag,dataset:{},children:[],isConnected:true,scrollTop:0,scrollLeft:0,append(n){n.parentElement=this;this.children.push(n)},addEventListener(name,fn){this[name]=fn},focus(o){this.focusOptions=o},scrollIntoView(){this.scrolled=true}});
  const c={state:{},el:node,requestAnimationFrame:fn=>frames.push(fn),window:{scrollX:8,scrollY:40,scrollTo(x,y){this.scrollX=x;this.scrollY=y}},nodeText:(tag,cls,text,parent)=>{const n=node(tag);n.text=text;parent.append(n);return n},productionButton:(parent,text,fn)=>{const n=node('button');n.onclick=fn;parent.append(n)}};
  vm.createContext(c);vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static/material-review.js'),'utf8'),c);
  c.renderActualGeneration=(host,context)=>rendered.push({host,context});return {c,node,frames,rendered};
 }
 const item={record:{id:'asset-exact'},review_context:{call:{id:'call-old',payload:{method:'external-edit'}},inputs:[{id:'input'}]}};
 await t.test('complete historical call is collapsed once without changing its context',()=>{
  const {c,node,rendered}=fixture(),host=node('main'),before=JSON.stringify(item);c.materialGenerationDetails(host,item);
  const detail=host.children[0];assert.equal(detail.tag,'details');assert.equal(detail.open,false);assert.equal(rendered[0].host,detail);assert.equal(rendered[0].context,item.review_context);assert.equal(JSON.stringify(item),before);
 });
 await t.test('closing restores every enclosing scroller after layout and keeps focus visible',()=>{
  const {c,node,frames}=fixture(),outer=node('dialog'),host=node('column');outer.append(host);host.scrollTop=87;outer.scrollTop=135;host.scrollLeft=6;
  c.materialGenerationDetails(host,item);const detail=host.children[0],summary=detail.children[0];summary.onclick({});detail.open=true;
  host.scrollTop=900;outer.scrollTop=800;c.window.scrollY=500;detail.children.at(-1).onclick();assert.equal(detail.open,false);assert.equal(summary.focusOptions.preventScroll,true);
  frames.shift()();assert.equal(host.scrollTop,87);assert.equal(outer.scrollTop,135);assert.equal(host.scrollLeft,6);assert.equal(c.window.scrollY,40);
 });
 await t.test('open state follows exact asset and call rather than another candidate',()=>{
  const {c,node}=fixture(),host=node('main');c.materialGenerationDetails(host,item);const detail=host.children[0];detail.open=true;detail.toggle();
  const reopened=node('main');c.materialGenerationDetails(reopened,item);assert.equal(reopened.children[0].open,true);
  const other=node('main');c.materialGenerationDetails(other,{...item,record:{id:'other-asset'}});assert.equal(other.children[0].open,false);
 });
 await t.test('absent CALL stays immediately readable and is not replaced by a recipe',()=>{
  const {c,node,rendered}=fixture(),host=node('main');c.materialGenerationDetails(host,{record:{id:'asset'}});assert.equal(host.children.length,0);assert.equal(rendered[0].host,host);assert.equal(rendered[0].context,undefined);
 });
});
