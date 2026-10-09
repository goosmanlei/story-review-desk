const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const file=name=>fs.readFileSync(__dirname+'/../review_desk/static/'+name,'utf8');
test('current use opinions name their exact relationship and retain historical revision distinction',()=>{
 const relation={id:'edge-old',object_id:'edge',current_revision:'edge-now',version:1,kind:'MATERIAL_RELATION',payload:{title:'保留身份'}};
 const c={state:{entityReview:{entity:{payload:{title:'角色'}},states:[],media:[],comment_records:[relation]}},reviewPositionText:x=>x,materialRelationTitle:r=>'旧原件 → 状态方案'};vm.createContext(c);vm.runInContext(file('entity-review.js'),c);
 assert.equal(c.entityReviewCommentGroup({target_revision_id:'edge-old'}),'参考用途 · 旧原件 → 状态方案 · 历史版本 1');
 relation.id='edge-now';assert.equal(c.entityReviewCommentGroup({target_revision_id:'edge-now'}),'参考用途 · 旧原件 → 状态方案');
});
test('editing or locating a use opinion preserves its current card instead of treating it as an entity section',()=>{
 const c={state:{entityReview:{}},locateMaterialRelationComment:()=>true,cancelMaterialCommentLocation:()=>assert.fail('must not rebuild outer card')};vm.createContext(c);vm.runInContext(file('entity-review.js'),c);
 assert.equal(c.locateEntityReviewComment({target_revision_id:'edge'}),true);
});
test('material comment aggregation retains use opinions on their original revision',()=>{
 const c={state:{materialReview:{record:{id:'plan'},relation_records:[{id:'edge-old'},{id:'edge-now'}]},comments:[{id:'A',target_revision_id:'edge-old'},{id:'B',target_revision_id:'other'}]}};vm.createContext(c);vm.runInContext(file('material-review.js'),c);
 assert.deepEqual(Array.from(c.materialReviewComments(),x=>x.id),['A']);
});
