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
 const records=[entity,form,second,submission],data={entity,states:[second,form],submission,media:[],comment_targets:[entity,form,second,submission].map(ref)};
 const ctx={state:{workspace:'settings.workspace',productionRecords:records,comments:[]},URL,URLSearchParams,location:{href:'http://local/?workspace=settings.workspace'},document:{querySelectorAll:()=>[]},api:read||(async()=>data),isProduction:()=>true,renderComments:()=>{}};
 ctx.history={replaceState:(_s,_t,url)=>{ctx.location.href=String(url)}};
 vm.createContext(ctx);vm.runInContext(code,ctx);ctx.renderProductionReader=()=>{};ctx.paintProductionReview=()=>{};
 return {ctx,data};
}
test('whole-entity snapshot remains constant when selecting a different form or comment target',async()=>{
 const {ctx,data}=setup();await ctx.openEntityReview('person',{record:entity},0,null);
 assert.equal(ctx.state.productionChildDetail.record,form);
 ctx.selectEntityReviewState(second);
 assert.equal(ctx.state.entityReview,data);assert.equal(ctx.state.productionSelected,second);
 assert.equal(new URL(ctx.location.href).searchParams.get('entity_submission'),submission.id);
 assert.equal(ctx.productionEntityChildren('person').length,2); // submission is not a setting/state choice
});
test('an explicit historical state stays exact and flags the card; normal refresh follows the submitted revision',async()=>{
 const old={...form,id:'old'};const {ctx,data}=setup();
 await ctx.openEntityReview('person',{record:old},0,'old');assert.equal(data.historicalTarget,old);assert.equal(ctx.state.productionSelected,old);
 await ctx.openEntityReview('person',{record:old},0,null);assert.equal(data.historicalTarget,null);assert.equal(ctx.state.productionSelected,form);
});
test('comments aggregate only exact submitted references and switching focus does not narrow them',async()=>{
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
