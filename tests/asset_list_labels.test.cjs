const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../review_desk/static/production.js'),'utf8');
// Execute the actual index renderer. The DOM records labels and click callbacks;
// no browser layout, HTTP or other workspaces are simulated as passing here.
function render(records){
  const nodes=[],opened=[],index={replaceChildren(){nodes.length=0},get childElementCount(){return nodes.length}};
  const ctx={workspaceRows:records,matches:()=>true,workspace:'materials.workspace',productionGroups:{'materials.workspace':['ASSET','CALL']},
    productionKinds:{ASSET:'原件',CALL:'调用'},productionLabels:{},contexts:new Map(records.map(r=>[r.object_id,{}])),
    childrenByEntity:new Map(),flatFilters:false,state:{},index,openProductionRecord:id=>opened.push(id),
    productionButton(parent,text,onclick){const n={textContent:text,onclick,children:[],dataset:{},classList:{toggle(){}}};nodes.push(n);return n},
    nodeText(tag,_class,text,parent){const n={tag,textContent:text};if(parent===index)nodes.push(n);else parent.children.push(n);return n}};
  vm.createContext(ctx);const start=source.indexOf('  const renderIndex=()=>{'),end=source.indexOf('  const refreshIndex=()=>{',start);
  assert.ok(start>=0&&end>start);vm.runInContext(source.slice(start,end)+'\nglobalThis.draw=renderIndex;',ctx);ctx.draw();
  return {buttons:nodes.filter(n=>n.onclick),opened};
}
test('asset list shows evidenced material round independently of record revision and keeps navigation',()=>{
  const {buttons,opened}=render([{object_id:'old-result',kind:'ASSET',version:9,material_version:1,payload:{title:'Older result'}}]);
  assert.equal(buttons[0].children[0].textContent.trim(),'版本 1');buttons[0].onclick();assert.deepEqual(opened,['old-result']);
});
test('asset list without a positive integer material round does not invent a version or empty label',()=>{
  for(const material_version of [undefined,null,0,-1,'2']){
    const {buttons}=render([{object_id:'legacy',kind:'ASSET',version:9,material_version,payload:{title:'Legacy original'}}]);
    assert.equal(buttons[0].textContent,'Legacy original');assert.equal(buttons[0].children.length,0);
  }
});
test('other production records retain their record revision label',()=>{
  const {buttons}=render([{object_id:'call',kind:'CALL',version:4,payload:{title:'Actual call'}}]);
  assert.equal(buttons[0].children[0].textContent.trim(),'修订 4');
});
