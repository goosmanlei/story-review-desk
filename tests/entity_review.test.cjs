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
 return {ctx,data};
}
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
