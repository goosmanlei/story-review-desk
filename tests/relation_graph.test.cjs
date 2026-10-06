const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ctx={};vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static/entity-relations.js'),'utf8'),ctx);
test('zoom and resize preserve the chosen logical center, including centered overview offsets',()=>{
  const center={x:540,y:1390},original=ctx.relationGraphPosition(center,542,542,1);
  const enlarged=ctx.relationGraphPosition(center,312,312,1.25);
  assert.equal((original.x+271),center.x);assert.equal((enlarged.x+156)/1.25,center.x);
  assert.equal((enlarged.y+156)/1.25,center.y);
  const fit=ctx.relationGraphPosition(center,312,312,.1,{x:102,y:17});
  assert.equal((fit.x+156-102)/.1,center.x);assert.equal((fit.y+156-17)/.1,center.y);
});
test('node selection covers all displayed direct edges; an edge selects its exact identity',()=>{
 const rows=[['r1','a','b'],['r2','b','a'],['r3','a','c']].map(([object_id,...ids])=>({object_id,payload:{entities:ids.map(object_id=>({object_id}))}}));
 const select=s=>Array.from(ctx.relationSelection(rows,'a',s));
 assert.deepEqual(select({kind:'node',id:'b'}),['r1','r2']);
 assert.deepEqual(select({kind:'edge',id:'r2'}),['r2']);
 assert.deepEqual(select(null),[]);
});
test('curve direction reverses the real endpoints and contains smooth curves',()=>{
 const args=[[230,300],[460,100],[760,100],[850,100]];
 const forward=ctx.relationCurve(...args,true),reverse=ctx.relationCurve(...args,false);
 assert.ok(forward.startsWith('M230 300 C'));assert.ok(forward.endsWith('850 100'));
 assert.ok(reverse.startsWith('M850 100 C'));assert.ok(reverse.endsWith('230 300'));
 assert.equal((forward.match(/C/g)||[]).length,2);assert.ok(!forward.includes('NaN'));
});
