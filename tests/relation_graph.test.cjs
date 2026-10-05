const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ctx={};vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static/entity-relations.js'),'utf8'),ctx);
test('resizing through the minimum readable scale keeps the same graph point centered',()=>{
  const oldWidth=542,oldScale=oldWidth/720,center=1390;
  const saved={x:center*oldScale-oldWidth/2,y:center*oldScale-oldWidth/2,width:oldWidth,height:oldWidth,scale:oldScale};
  const next=ctx.relationGraphPosition(saved,312,312,.55,center);
  assert.ok(Math.abs(next.x-(center*.55-156))<1e-6);
  assert.ok(Math.abs(next.y-(center*.55-156))<1e-6);
  const pan=ctx.relationGraphPosition({...saved,x:saved.x+80},312,312,.55,center);
  assert.ok(Math.abs(pan.x-next.x-80*.55/oldScale)<1e-6);
});
