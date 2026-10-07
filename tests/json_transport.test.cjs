const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../review_desk/static/app.js'),'utf8');
const unpack=vm.runInNewContext('('+source.slice(source.indexOf('function unpackReviewGraph('),source.indexOf('const api='))+')');
test('lossless graph restores independent repeated trees and literal reserved-looking fields',()=>{
  const value=unpack({format:'review-graph-v1',nodes:[['s','完整正文'],['o',[['text',{$:0}],['__proto__',1],['$',2]]],['a',[{$:1},{$:1},true,1,null]]],root:{$:2}});
  assert.equal(JSON.stringify(value),'[{"text":"完整正文","__proto__":1,"$":2},{"text":"完整正文","__proto__":1,"$":2},true,1,null]');
  value[0].text='修改仅影响当前记录';assert.equal(value[1].text,'完整正文');
  assert.ok(Object.hasOwn(value[0],'__proto__'));
});
test('invalid and cyclic graph references fail without an expanding recursion',()=>{
  assert.throws(()=>unpack({format:'review-graph-v1',nodes:[['a',[{$:0}]]],root:{$:0}}),/Invalid review reference/);
  assert.throws(()=>unpack({format:'review-graph-v1',nodes:[],root:{$:1}}),/Invalid review reference/);
});
