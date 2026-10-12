const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function setup(){
  const context={URLSearchParams};vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static/material-review.js'),'utf8'),context);
  return context;
}
test('all removed material-version links fail explicitly without rewriting the URL',()=>{
 const c=setup();
 for(const query of ['material_version=1','material_version=3&material_baseline=old','material_round=1']){
  const params=new URLSearchParams('material_id=need&'+query),before=params.toString();
  assert.throws(()=>c.validateMaterialRoute(params),/已删除/);assert.equal(params.toString(),before);
 }
});
test('current material links carry exact identity without version or baseline selectors',()=>{
 const c=setup(),params=new URLSearchParams('material_round=1&material_version=2&material_baseline=old&material_target=exact-candidate');
 c.writeMaterialRoute(params,'need');c.validateMaterialRoute(params);
 assert.equal(params.toString(),'material_target=exact-candidate&material_id=need');
});
