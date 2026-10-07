const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function setup(){
  const context={URLSearchParams};vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static/material-review.js'),'utf8'),context);
  return context;
}
test('a deleted old V1 cannot impersonate the consolidated V1 while the retained old V3 resolves',()=>{
  const c=setup(),versions={need:[{number:1,baseline_id:'baseline',previous_numbers:{1:null,2:null,3:1}}]};
  const old=new URLSearchParams('material_id=need&material_version=1');
  assert.throws(()=>c.normalizeConsolidatedMaterialRoute(old,versions),/已删除/);
  assert.equal(old.get('material_version'),'1');assert.equal(old.has('material_baseline'),false);
  const kept=new URLSearchParams('material_id=need&material_version=3');
  c.normalizeConsolidatedMaterialRoute(kept,versions);
  assert.equal(kept.get('material_version'),'1');assert.equal(kept.get('material_baseline'),'baseline');
  c.normalizeConsolidatedMaterialRoute(kept,versions);
  const wrong=new URLSearchParams('material_id=need&material_version=1&material_baseline=previous');
  assert.throws(()=>c.normalizeConsolidatedMaterialRoute(wrong,versions),/基线已失效/);
  assert.throws(()=>c.normalizeConsolidatedMaterialRoute(new URLSearchParams('material_id=need&material_round=1'),versions),/已删除/);
});
test('new links retain the explicit baseline and ordinary pre-migration links retain their old version',()=>{
  const c=setup(),params=new URLSearchParams();
  c.writeMaterialVersionRoute(params,'need',{number:2,model:'plan-v1',baseline_id:'baseline'});
  assert.equal(params.get('material_version'),'2');assert.equal(params.get('material_baseline'),'baseline');
  const old=new URLSearchParams('material_id=need&material_version=2');
  c.normalizeConsolidatedMaterialRoute(old,{need:[{number:2}]});
  assert.equal(old.toString(),'material_id=need&material_version=2');
});
