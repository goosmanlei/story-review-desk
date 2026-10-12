const router=require('../review_desk/static/entity-graph-routing.js'),{instance}=require('../review_desk/static/vendor/viz-3.31.0.js');
const renderer=instance();
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
// DOM identity assertions cover atomic replacement; real font/viewport and
// pointer behavior are verified in the instance's Chrome acceptance.
class Element{
 constructor(tag){this.tag=tag;this.children=[];this.attrs={};this.dataset={};this.style={};this.isConnected=true;this.scrollHeight=110;this.clientWidth=1200;this.clientHeight=900;this.scrollLeft=0;this.scrollTop=0;this.classList={add(){},toggle(){}};this.textContent='';}
 append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=[...nodes];}setAttribute(k,v){this.attrs[k]=String(v);}get childNodes(){return this.children;}
 all(){return this.children.flatMap(n=>[n,...n.all()]);}
}
async function fixture(){
 const viz=await renderer;
 const f=JSON.parse(fs.readFileSync('tests/fixtures/entity-graph-ash242.json','utf8')),frames=[],observers=[];
 const el=(tag,cls)=>{const n=new Element(tag);n.className=cls;return n;},nodeText=(tag,cls,text,parent)=>{const n=el(tag,cls);n.textContent=text;parent.append(n);return n;};
 const c={businessCode:r=>r.business_code,el,nodeText,document:{createElementNS:(_ns,tag)=>new Element(tag),addEventListener(){}},window:{addEventListener(){}},requestAnimationFrame:fn=>frames.push(fn),ResizeObserver:class{constructor(fn){observers.push(fn);}observe(){}disconnect(){}},entitySmallCard:host=>{const n=new Element('button');host.append(n);return n;},productionButton:(parent,text,action)=>{const n=nodeText('button','',text,parent);n.onclick=action;return n;}};
 vm.createContext(c);vm.runInContext(fs.readFileSync('review_desk/static/entity-relations.js','utf8'),c);
 c.managementEdgeGeometry=async(nodes,edges)=>router.layout(viz,nodes,edges);
 const root=new Element('main'),memory={};c.renderManagementEntityGraph(root,f.rows,{entity_graph:{edges:f.edges}},memory);
 return {c,root,memory,frames,observers};
}
test('a failed single route preserves the complete same-scope DOM, bounds, selection and viewport until retry succeeds',async()=>{
 const f=await fixture();await f.frames[0]();const svg=f.root.all().find(n=>n.tag==='svg'),edges=svg.children[1],captions=svg.children[2],viewport=f.root.all().find(n=>n.className==='relation-graph-viewport management-graph-viewport');
 const cards=svg.children.filter(n=>n.attrs['data-entity-id']),before=edges.children.slice(),beforeCaptions=captions.children.slice(),box=svg.attrs.viewBox;
 cards[0].children[0].children[0].onclick({detail:1,stopPropagation(){}});
 f.memory.mode='custom';viewport.scrollLeft=83;viewport.scrollTop=147;viewport.onscroll();const saved=JSON.stringify(f.memory);
 const route=f.c.managementEdgeGeometry;f.c.managementEdgeGeometry=async()=>{throw Error('injected single-route failure');};
 cards[0].children[0].scrollHeight=115;await f.frames[0]();
 assert.deepEqual(edges.children,before);assert.deepEqual(captions.children,beforeCaptions);assert.equal(svg.attrs.viewBox,box);assert.equal(cards[0].attrs.height,'110');assert.equal(JSON.stringify(f.memory),saved);assert.match(f.root.all().map(n=>n.textContent).join(''),/仍保留上一次完整结果.*injected single-route failure/);
 f.c.managementEdgeGeometry=route;await f.root.all().find(n=>n.textContent==='重新绘制关系图').onclick();
 assert.equal(edges.children.length,before.length);assert.notEqual(edges.children[0],before[0]);assert.equal(cards[0].attrs.height,'115');assert.equal(f.memory.selection.id,'entity-crossbeam');assert.equal(viewport.scrollLeft,83);assert.equal(viewport.scrollTop,147);
});
test('initial route failure is explicit and does not present a partial successful graph',async()=>{
 const f=await fixture();f.c.managementEdgeGeometry=async()=>{throw Error('initial route failure');};await f.frames[0]();
 const svg=f.root.all().find(n=>n.tag==='svg');assert.equal(svg.children[1].children.length,0);assert.equal(svg.children[2].children.length,0);assert.match(f.root.all().map(n=>n.textContent).join(''),/关系图绘制失败.*initial route failure/);assert.equal(f.memory.scale,null);
});

test('an older successful layout cannot overwrite a newer measured layout',async()=>{
 const f=await fixture(),route=f.c.managementEdgeGeometry;
 let resolveOld;f.c.managementEdgeGeometry=(...args)=>new Promise(resolve=>{resolveOld=async()=>resolve(await route(...args));});
 const old=f.frames[0]();f.c.managementEdgeGeometry=route;
 const svg=f.root.all().find(n=>n.tag==='svg'),card=svg.children.find(n=>n.attrs['data-entity-id']);card.children[0].scrollHeight=155;
 await f.frames[0]();const edge=svg.children[1].children[0];await resolveOld();await old;
 assert.equal(card.attrs.height,'155');assert.equal(svg.children[1].children[0],edge);
});
test('a detached graph discards its late result without committing a partial layer',async()=>{
 const f=await fixture(),route=f.c.managementEdgeGeometry;let release;
 f.c.managementEdgeGeometry=(...args)=>new Promise(resolve=>{release=async()=>resolve(await route(...args));});
 const work=f.frames[0](),viewport=f.root.all().find(n=>n.className==='relation-graph-viewport management-graph-viewport');viewport.isConnected=false;
 await release();await work;
 const svg=f.root.all().find(n=>n.tag==='svg');assert.equal(svg.children[1].children.length,0);assert.equal(svg.style.visibility,'hidden');
});
