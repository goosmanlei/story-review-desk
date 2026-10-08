const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../review_desk/static/production.js'),'utf8');
class Element{constructor(tag){Object.assign(this,{tag,children:[],dataset:{},attrs:{},classList:{toggle(){},add(){}}})}append(...nodes){this.children.push(...nodes)}replaceChildren(){this.children=[]}setAttribute(k,v){this.attrs[k]=v}get childElementCount(){return this.children.length}all(){return [this,...this.children.flatMap(n=>n.all())]}}
// Execute the actual index renderer and shared card; DOM checks do not certify layout.
function render(records,episodes=[]){
  const opened=[],index=new Element('nav');
  const ctx={result:{material_card_counts:Object.fromEntries(records.filter(r=>r.card_counts).map(r=>[r.object_id,r.card_counts]))},workspaceRows:records,matches:()=>true,workspace:records[0]?.kind==='ASSET'?'materials.workspace':'production.workspace',productionGroups:{'materials.workspace':['ASSET'],'production.workspace':['CALL','AV_SCENE','AV_SHOT']},
    productionKinds:{ASSET:'原件',CALL:'调用',AV_SCENE:'场',AV_SHOT:'镜'},productionLabels:{},contexts:new Map(records.map(r=>[r.object_id,{episode:(r.payload.episode||r.payload.source)?.object_id,episodeRevision:(r.payload.episode||r.payload.source)?.revision_id,scene:r.payload.scene_id||r.payload.source?.scene_id,number:r.payload.number}])),
    childrenByEntity:new Map(),flatFilters:false,state:{},episodes,index,openProductionRecord:id=>opened.push(id),el:tag=>new Element(tag),productionEntityIcon:()=>new Element('svg'),
    productionButton(parent,text,onclick){const n=new Element('button');n.textContent=text;n.onclick=onclick;parent.append(n);return n},
    nodeText(tag,_class,text,parent){const n=new Element(tag);n.textContent=text;parent.append(n);return n}};
  vm.createContext(ctx);require('./load_review_helpers.cjs')(ctx);vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static/production-breakdown.js'),'utf8'),ctx);const start=source.indexOf('  const renderIndex=()=>{'),end=source.indexOf('  const refreshIndex=()=>{',start);
  assert.ok(start>=0&&end>start);vm.runInContext(source.slice(start,end)+'\nglobalThis.draw=renderIndex;',ctx);ctx.draw();
  return {buttons:index.all().filter(n=>n.tag==='button'),opened,title:button=>button.all().find(n=>n.tag==='strong')?.textContent,subtitle:button=>button.all().find(n=>n.tag==='small')?.textContent};
}
test('asset card totals are independent of selected version and record revision, with navigation',()=>{
  const f=render([{object_id:'old-result',kind:'ASSET',version:9,material_version:1,material_generated:true,card_counts:{version_count:2,candidate_count:3},payload:{title:'Older result'}}]);
  assert.equal(f.subtitle(f.buttons[0]),'版本 2 个 · 候选 3 个');f.buttons[0].onclick();assert.deepEqual(f.opened,['old-result']);assert.equal(f.buttons[0].className,'material-small-card');
});
test('asset list without a positive integer material round does not invent a version or empty label',()=>{
  for(const material_version of [undefined,null,0,-1,'2']){
    const f=render([{object_id:'legacy',kind:'ASSET',version:9,material_version,payload:{title:'Legacy original'}}]);
    assert.equal(f.title(f.buttons[0]),'Legacy original');assert.equal(f.subtitle(f.buttons[0]),'版本未登记 · 候选未登记');
  }
});
test('other production records retain their record revision label',()=>{
  const f=render([{object_id:'call',kind:'CALL',version:4,payload:{title:'Actual call'}}]);assert.equal(f.subtitle(f.buttons[0]),'修订 4');assert.equal(f.buttons[0].className,'material-small-card');
});
test('history scene and shot records use shared cards with exact global location codes',()=>{
 const records=[{object_id:'scene',kind:'AV_SCENE',version:5,payload:{title:'01-01 米铺门口',source:{object_id:'ep',revision_id:'ep-old',scene_id:'s012'}}},{object_id:'shot',kind:'AV_SHOT',version:3,payload:{title:'E02-004 河街开场',episode:{object_id:'ep',revision_id:'ep-old'},scene_id:'s012',number:4}}],episodes=[{object_id:'ep',id:'ep-current',payload:{number:99}},{object_id:'ep',id:'ep-old',payload:{number:2}}],before=JSON.stringify(records),f=render(records,episodes);
 assert.deepEqual(f.buttons.map(f.title),['S012 · 米铺门口','SH004 · 河街开场']);assert.deepEqual(f.buttons.map(f.subtitle),['E02 / S012 · 修订 5','E02 / S012 / SH004 · 修订 3']);assert.ok(f.buttons.every(b=>b.className==='material-small-card'));f.buttons[1].onclick();assert.deepEqual(f.opened,['shot']);assert.equal(JSON.stringify(records),before);
});
