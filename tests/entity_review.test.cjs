const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const code=['production.js','entity-review.js'].map(f=>fs.readFileSync(path.join(__dirname,'../review_desk/static',f),'utf8')).join('\n');
const row=(id,kind,payload={},revision=id+'-v1')=>({object_id:id,id:revision,current_revision:revision,kind,payload,version:1});
const entity=row('person','ENTITY',{title:'人物'});
const form=row('form','STATE',{title:'人物 · 基础',state_model:'complete-v1',entity:{object_id:'person'},sources:[{scene_id:'s001'}]});
const second=row('later','STATE',{title:'人物 · 后续',state_model:'complete-v1',entity:{object_id:'person'},sources:[{scene_id:'s002'}]});
const submission=row('review','REPRESENTATION',{review_model:'entity-review-v1',entities:[{object_id:'person'}],states:[]});
const ref=r=>({object_id:r.object_id,revision_id:r.id});
function setup(read){
 const records=[entity,form,second,submission],data={entity,states:[second,form],media:[],comment_targets:[entity,form,second].map(ref)};
 const ctx={state:{workspace:'settings.workspace',productionRecords:records,comments:[]},URL,URLSearchParams,location:{href:'http://local/?workspace=settings.workspace'},document:{querySelectorAll:()=>[]},api:read||(async()=>data),isProduction:()=>true,renderComments:()=>{}};
 ctx.history={replaceState:(_s,_t,url)=>{ctx.location.href=String(url)}};
 vm.createContext(ctx);vm.runInContext(code,ctx);ctx.renderProductionReader=()=>{};ctx.paintProductionReview=()=>{};
 for(const name of ['entityReviewStateMedia','entityReviewUnassignedMedia','entityReviewMediaCount'])ctx[name]=vm.runInContext(name,ctx);
 return {ctx,data};
}
test('review notes keep exact text and field index without mutating immutable payloads',()=>{
 const {ctx}=setup(),payload={blocks:[{id:'@review/unknowns/1',text:'已有正文🧵'}],facts:['已有正文🧵','事实'],choices:['事实','选择'],unknowns:['','未知','未知',null]},before=JSON.stringify(payload);
 assert.deepEqual(JSON.parse(JSON.stringify(ctx.productionTextBlocks({payload}))),[payload.blocks[0],
  {id:'@@review/facts/1',text:'事实',field:'facts',index:1},
  {id:'@@review/choices/1',text:'选择',field:'choices',index:1},
  {id:'@@review/unknowns/1',text:'未知',field:'unknowns',index:1}]);
 assert.equal(JSON.stringify(payload),before);
});
test('generation parameters retain server numeric spelling for exact comment offsets',()=>{
 const {ctx}=setup(),text='{\n  "epsilon": 1e-07,\n  "pitch": 1.0\n}';
 const record={payload:{blocks:[],generation:{parameters:{epsilon:1e-7,pitch:1}}},review_parameter_text:text};
 assert.equal(ctx.productionTextBlocks(record).find(b=>b.field==='generation.parameters').text,text);
});
test('switching one version back to current cannot accept another still historical section',()=>{
 const {ctx,data}=setup();
 const oldEntity={...entity,id:'person-old'},oldState={...form,id:'form-old'};
 data.historicalTarget=null;
 assert.equal(ctx.entityReviewHasHistoricalContent(data,oldEntity,form),true);
 assert.equal(ctx.entityReviewHasHistoricalContent(data,entity,oldState),true);
 assert.equal(ctx.entityReviewHasHistoricalContent(data,entity,form),false);
 data.localVersions={recipe:{id:'old-recipe',current_revision:'new-recipe'}};
 assert.equal(ctx.entityReviewHasHistoricalContent(data,entity,form),true);
});
test('whole-entity content remains constant when selecting a different form or comment target',async()=>{
 const {ctx,data}=setup();await ctx.openEntityReview('person',{record:entity},0,null);
 assert.equal(ctx.state.productionChildDetail.record,form);
 ctx.selectEntityReviewState(second);
 assert.equal(ctx.state.entityReview,data);assert.equal(ctx.state.productionSelected,second);
 assert.equal(new URL(ctx.location.href).searchParams.get('entity_submission'),null);
 assert.equal(new URL(ctx.location.href).searchParams.get('production_revision'),null);
 assert.equal(ctx.productionEntityChildren('person').length,2); // submission is not a setting/state choice
});
test('an explicit historical state stays exact and flags the card; normal refresh follows current content',async()=>{
 const old={...form,id:'old'};const {ctx,data}=setup();
 await ctx.openEntityReview('person',{record:old},0,'old');assert.equal(data.historicalTarget,old);assert.equal(ctx.state.productionSelected,old);
 await ctx.openEntityReview('person',{record:old},0,null);assert.equal(data.historicalTarget,null);assert.equal(ctx.state.productionSelected,form);
});
test('comments aggregate exact references and switching focus does not narrow them',async()=>{
 const {ctx}=setup();await ctx.openEntityReview('person',{record:entity},0,null);
 ctx.state.comments=[{id:'a',target_object_id:'person',target_revision_id:entity.id},{id:'b',target_object_id:'later',target_revision_id:second.id},{id:'old',target_object_id:'later',target_revision_id:'old'}];
 ctx.selectEntityReviewState(form);assert.deepEqual(Array.from(ctx.entityReviewComments(),r=>r.id),['a','b']);
 ctx.entityReviewFocus(entity);assert.equal(ctx.entityReviewComments().length,2);
});
test('a delayed aggregate cannot overwrite a newer selection',async()=>{
 let release;const {ctx,data}=setup(()=>new Promise(resolve=>{release=resolve}));
 const pending=ctx.openEntityReview('person',{record:entity},0,null);
 vm.runInContext('productionReadEpoch++',ctx);release(data);await pending;
 assert.equal(ctx.state.entityReview,undefined);
});

test('old workflow URLs return to current content without a separate state option',async()=>{
 const {ctx}=setup();ctx.location.href='http://local/?production_entity=person&entity_submission=old&production_object=review';
 await ctx.openEntityReview('person',{record:submission},0,submission.id);
 assert.equal(new URL(ctx.location.href).searchParams.get('entity_submission'),null);
 assert.equal(ctx.state.productionChildDetail.record,form);assert.equal(ctx.state.entityReview.historicalTarget,null);
 assert.deepEqual(Array.from(ctx.productionEntityChildren('person'),r=>r.object_id),['form','later']);
});
test('earlier revision opinions remain in the entity panel',async()=>{
 const {ctx,data}=setup();const old={...form,id:'old',current_revision:form.id};data.comment_records=[old];data.comment_targets.push(ref(old));
 await ctx.openEntityReview('person',{record:entity},0,null);
 const comment={id:'history',target_object_id:'form',target_revision_id:'old'};ctx.state.comments=[comment];
 assert.equal(ctx.entityReviewComments()[0],comment);assert.match(ctx.entityReviewCommentGroup(comment),/历史版本/);
});
test('locating a current opinion resets an earlier historical state context',async()=>{
 const {ctx,data}=setup();const old={...form,id:'old',current_revision:form.id};data.comment_records=[old];
 await ctx.openEntityReview('person',{record:entity},0,null);ctx.locateProductionComment=()=>{};
 ctx.locateEntityReviewComment({id:'old-comment',target_revision_id:'old',anchor:{type:'global'}});
 assert.equal(ctx.state.productionChildDetail.record,old);assert.equal(data.historicalTarget,old);
 ctx.locateEntityReviewComment({id:'current-comment',target_revision_id:entity.id,anchor:{type:'global'}});
 assert.equal(ctx.state.productionChildDetail.record,form);assert.equal(data.historicalTarget,null);
});
test('state media excludes entity-only candidates, other states and other revisions',()=>{
 const {ctx}=setup(),asset=row('image','ASSET',{title:'候选'});
 const media=[{id:'unassigned',state:null,record:asset},{id:'base',state:ref(form),record:asset},{id:'later',state:ref(second),record:asset},{id:'old',state:{...ref(form),revision_id:'old'},record:asset},{id:'wrong-owner',state:{object_id:'other',revision_id:form.id},record:asset}];
 assert.deepEqual(Array.from(ctx.entityReviewStateMedia({media},form),m=>m.id),['base']);
 assert.deepEqual(Array.from(ctx.entityReviewStateMedia({media},second),m=>m.id),['later']);
 assert.deepEqual(Array.from(ctx.entityReviewUnassignedMedia({media}),m=>m.id),['unassigned']);
 assert.equal(ctx.entityReviewStateMedia({media},undefined).length,0);
 // Historical comparisons use the same exact-state filter, without a fallback.
 assert.deepEqual(Array.from(ctx.entityReviewStateMedia({media},{...form,id:'old'}),m=>m.id),['old']);
});
test('several materials can describe one state and reuse requires explicit coverage for each state',()=>{
 const {ctx}=setup(),image=row('image','ASSET'),voice=row('voice','ASSET'),crop={x:.1,y:.1,width:.5,height:.5},range={start_seconds:1,end_seconds:3};
 const media=[{id:'image',state:ref(form),record:image,role:'overall',crop},{id:'voice-base',state:ref(form),record:voice,role:'detail',range},{id:'voice-later',state:ref(second),record:voice,role:'detail',range}];
 assert.equal(ctx.entityReviewMediaCount(ctx.entityReviewStateMedia({media},form)),2);
 assert.equal(ctx.entityReviewMediaCount(ctx.entityReviewStateMedia({media},second)),1);
 assert.equal(ctx.entityReviewStateMedia({media},form)[0].crop,crop);
 assert.equal(ctx.entityReviewStateMedia({media},second)[0].range,range);
});
test('unassigned media comments open their separate area without changing the selected state',async()=>{
 const {ctx,data}=setup(),asset=row('voice','ASSET',{title:'待关联声音'}),item={id:'voice',state:null,record:asset,component_id:'original'};data.media=[item];
 await ctx.openEntityReview('person',{record:entity},0,null);ctx.locateProductionComment=()=>{};
 ctx.selectEntityReviewState(second);ctx.locateEntityReviewComment({id:'c',target_revision_id:asset.id,anchor:{type:'time',component_id:'original',start_seconds:1,end_seconds:2}});
 assert.equal(data.unassignedOpen,true);assert.equal(ctx.state.productionChildDetail.record,second);
 assert.equal(ctx.state.entityReviewUnassignedMedia,item.id);assert.equal(ctx.entityReviewStateMedia(data,second).length,0);
 ctx.selectEntityReviewState(form);assert.equal(data.unassignedOpen,false);
});
test('mapped media comments select their state; historical unlinked media stays separate',async()=>{
 const {ctx,data}=setup(),asset=row('image','ASSET',{title:'图像',components:[{id:'original',mime:'image/png'}]}),old={...asset,id:'old-image',current_revision:asset.id};
 data.media=[{id:'image',state:ref(second),record:asset,component_id:'original'}];data.comment_records=[old];
 await ctx.openEntityReview('person',{record:entity},0,null);ctx.locateProductionComment=()=>{};
 ctx.locateEntityReviewComment({id:'c',target_revision_id:asset.id,anchor:{type:'visual',visual_id:'original'}});
 assert.equal(ctx.state.productionChildDetail.record,second);assert.equal(ctx.state.entityReviewMedia,'image');assert.equal(data.unassignedOpen,false);
 ctx.locateEntityReviewComment({id:'old',target_revision_id:old.id,anchor:{type:'visual',visual_id:'original'}});
 assert.equal(data.historicalMedia.record,old);assert.equal(data.historicalMedia.state,null);assert.equal(data.historicalTarget,old);
 assert.equal(ctx.entityReviewStateMedia(data,second)[0].record,asset);
});
test('a time opinion outside current coverage opens its original file separately',async()=>{
 const {ctx,data}=setup(),asset=row('voice','ASSET',{title:'声音',components:[{id:'original',mime:'audio/wav'}]});
 data.media=[{id:'voice',state:ref(form),record:asset,component_id:'original',range:{start_seconds:3,end_seconds:5}}];
 await ctx.openEntityReview('person',{record:entity},0,null);ctx.locateProductionComment=()=>{};
 ctx.locateEntityReviewComment({id:'c',target_revision_id:asset.id,anchor:{type:'time',component_id:'original',start_seconds:1,end_seconds:2}});
 assert.equal(data.historicalMedia.record,asset);assert.equal(data.unassignedOpen,false);
});
test('time comment location scopes a repeated component id to the exact asset revision',()=>{
 const {ctx}=setup();ctx.state.entityReview={};let selector,component,focused=false;
 const player={dataset:{},scrollIntoView:()=>{},focus:()=>{focused=true}};
 ctx.CSS={escape:x=>x};ctx.$=()=>null;ctx.document.querySelector=value=>{selector=value;return value.startsWith('[data-comment-media]')?null:{querySelector:value=>{component=value;return player}}};
 ctx.locateProductionComment({id:'c',target_revision_id:'voice-v2',anchor:{type:'time',component_id:'original',start_seconds:1.2}},true);
 assert.equal(selector,'[data-review-revision="voice-v2"]');assert.equal(component,'[data-component-id="original"]');assert.equal(player.currentTime,1.2);assert.equal(focused,true);
});

test('refreshing a media comment keeps the explicitly selected state',async()=>{
 const {ctx}=setup();ctx.location.href='http://local/?production_entity=person&entity_state=later&production_object=voice';
 const voice=row('voice','ASSET',{title:'声音'});await ctx.openEntityReview('person',{record:voice},0,null);
 assert.equal(ctx.state.productionChildDetail.record,second);
 assert.equal(new URL(ctx.location.href).searchParams.get('entity_state'),'later');
});
