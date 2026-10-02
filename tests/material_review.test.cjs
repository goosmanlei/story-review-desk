const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const ctx={URLSearchParams,state:{productionRecords:[]}};vm.createContext(ctx);
for(const f of ['production.js','material-review.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static',f),'utf8'),ctx);
const need=(id,revision=id+'-v1',media='image')=>({object_id:id,id:revision,current_revision:revision,payload:{media_type:media}});
const item=(id,refs,media='image')=>({id,record:{object_id:id,id:id+'-v1',payload:{media_type:media,candidate_requirements:refs}}});
const ref=r=>({object_id:r.object_id,revision_id:r.id});
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
});

const ui={...ctx,document:{addEventListener(){}}};vm.createContext(ui);vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static/review-ui.js'),'utf8'),ui);
test('block scope aggregates all live statuses and anchor kinds, excludes other blocks and versions, deduplicates',()=>{
 const c=(id,r,anchor,status='OPEN')=>({id,target_revision_id:r,anchor,status});
 const rows=[c('a','r',{type:'text',block_id:'prompt'}),c('b','r',{type:'global'},'CLOSED'),c('c','r',{type:'text',block_id:'other'}),c('d','old',{type:'text',block_id:'prompt'}),c('a','r',{type:'text',block_id:'prompt'})];
 assert.deepEqual(Array.from(ui.reviewBlockComments(rows,{revision:'r',kind:'text',blockIds:['prompt']}),c=>c.id),['a','b']);
 const media=[c('region','r',{type:'region',visual_id:'one',asset_file:'a.png'}),c('whole','r',{type:'visual',visual_id:'one',asset_file:'a.png'},'CLOSED'),c('other','r',{type:'visual',visual_id:'two',asset_file:'b.png'})];
 assert.deepEqual(Array.from(ui.reviewBlockComments(media,{revision:'r',kind:'image',visualId:'one',file:'a.png'}),c=>c.id),['region','whole']);
 const audio=[c('t','r',{type:'time',component_id:'original',asset_file:'a.wav',start_seconds:1,end_seconds:3}),c('outside','r',{type:'time',component_id:'original',asset_file:'a.wav',start_seconds:8,end_seconds:9}),c('file','r',{type:'time',component_id:'original',asset_file:'b.wav',start_seconds:1,end_seconds:3})];
 assert.deepEqual(Array.from(ui.reviewBlockComments(audio,{revision:'r',kind:'audio',componentId:'original',file:'a.wav',from:0,to:5}),c=>c.id),['t']);
});
test('effective inputs retain source order and type numbering, ignore storyline context',()=>{
 const refs=[{kind:'ENTITY',id:'person',object_id:'person',payload:{}},{kind:'ASSET',id:'i',object_id:'i',payload:{components:[{id:'original',mime:'image/png'}]}},{kind:'ASSET',id:'a',object_id:'a',payload:{components:[{id:'original',mime:'audio/wav'}]}},{kind:'ASSET',id:'j',object_id:'j',payload:{components:[{id:'original',mime:'image/png'}]}}];
 const inputs=refs.map(r=>({object_id:r.object_id,revision_id:r.id,component_id:r.kind==='ASSET'?'original':undefined}));
 const items=ctx.materialInputs(inputs,refs);assert.deepEqual(Array.from(items,i=>i.label),['图片1','音频1','图片2']);assert.deepEqual(Array.from(items,i=>i.index),[1,2,3]);assert.equal(ctx.materialInputs([],refs).length,0);
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
