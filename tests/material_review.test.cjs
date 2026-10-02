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

test('materials count current identities and show only genuine missing state demands',()=>{
 const form={object_id:'form',id:'form-v2',kind:'STATE',payload:{state_model:'complete-v1'}};
 const demand={...need('need'),kind:'REQUIREMENT',payload:{media_type:'image',scope:ref(form)}};
 const oldDemand={...need('old-need'),kind:'REQUIREMENT',payload:{media_type:'audio',scope:{object_id:'form',revision_id:'form-v1'}}};
 const shotDemand={...need('shot-need'),kind:'REQUIREMENT',payload:{media_type:'video',scope:{object_id:'shot',revision_id:'shot-v1'}}};
 const relation={object_id:'rel',kind:'RELATION',payload:{relation_type:'entity'}};
 const records=[form,demand,oldDemand,shotDemand,relation];
 assert.deepEqual(Array.from(ctx.productionWorkspaceRows(records,'materials.workspace'),r=>r.object_id),['need']);
 const asset={object_id:'asset',kind:'ASSET',payload:{media_type:'image',components:[{id:'original'}],candidate_requirements:[ref(demand)]}};
 records.push(asset);
 assert.deepEqual(Array.from(ctx.productionWorkspaceRows(records,'materials.workspace'),r=>r.object_id),['asset']);
 asset.payload.placeholder=true;
 assert.ok(ctx.productionWorkspaceRows(records,'materials.workspace').includes(demand));
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
