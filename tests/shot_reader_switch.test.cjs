const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
class Element{
  constructor(tag,cls=''){this.tag=tag;this.className=cls;this.children=[];this.dataset={};this.attrs={};this.isConnected=true;this.scrollTop=0;this.scrollLeft=0;this.replacements=[]}
  append(...nodes){for(const n of nodes){n.remove?.();n.parent=this;this.children.push(n)}}
  prepend(n){n.remove?.();n.parent=this;this.children.unshift(n)}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this);this.parent=null}
  replaceChildren(...nodes){this.replacements.push(nodes.length);for(const n of this.children)n.parent=null;this.children=[];this.append(...nodes)}
  setAttribute(k,v){this.attrs[k]=v}
  querySelectorAll(selector){return this.children.flatMap(n=>[n,...n.querySelectorAll(selector)]).filter(n=>selector==='[data-material-id]'?n.dataset.materialId:n.className.split(' ').includes(selector.slice(1)))}
  querySelector(s){return this.querySelectorAll(s)[0]||null}
  closest(s){return s==='.breakdown-body'?body:null}
  getBoundingClientRect(){return {top:120}}
}
const body={scrollTop:240};
function fixture(){
  const root=new Element('main'),reads=[],renders=[],models=['a','b','c'].map(id=>({material_id:id,need:{object_id:id,id:id+'-plan',payload:{title:id}},candidates:[],round:{number:1}}));
  const data={entity:{object_id:'shot',id:'shot-r1',payload:{}},requirements:models.map(m=>m.need),material_groups:[{key:'video',label:'视频',material_ids:['a','b','c']}],deferred_materials:['b','c'],selectedCandidates:{a:'current',b:'current',c:'current'}};
  const c={state:{},getComputedStyle:()=>({overflowY:'auto'}),el:(tag,cls)=>new Element(tag,cls),breakdownShotTitle:()=>'',materialTextSurface:x=>x,materialField(){},entitySources(){},pauseReviewMedia(){},rememberProductionDraft(){},saveUnifiedMaterialReader(){},restoreUnifiedMaterialReader(){},renderComments(){},paintProductionReview(){},entityReviewDetail:r=>r,focusProductionReview(){},restoreProductionDraft(){},materialModelCode:m=>m.material_id,reviewPositionText:x=>x,materialModelKey:m=>m.material_id,entityReviewMaterialModels:()=>models,modelSmallItem:m=>({id:m.material_id}),
    nodeText:(tag,cls,text,parent)=>{const n=new Element(tag,cls);n.textContent=text;parent.append(n);return n},
    productionButton:(parent,text,fn)=>{const n=new Element('button');n.textContent=text;n.onclick=fn;parent.append(n);return n},
    materialSourceSection:parent=>{const n=new Element('section','material-source-group');parent.append(n);return n},
    materialSmallCard:(parent,item,fn)=>{const n=new Element('button');n.dataset.materialId=item.id;n.onclick=fn;parent.append(n)},
    queueShotDetail:(_data,id,candidate)=>new Promise((resolve,reject)=>reads.push({id,candidate,reject,resolve:()=>{data.deferred_materials=data.deferred_materials.filter(x=>x!==id);resolve()}})),
    renderMaterialCard:(parent,model,options)=>{const n=new Element('article');n.textContent=model.material_id;n.options=options;parent.append(n);renders.push(n);return n}
  };
  const source=fs.readFileSync(path.join(__dirname,'../review_desk/static/unified-cards.js'),'utf8');vm.createContext(c);vm.runInContext(source.slice(source.indexOf('function renderShotEntityWorkspace(')),c);c.renderShotEntityWorkspace(root,data);
  const right=root.children[0].children[1],button=id=>root.querySelectorAll('[data-material-id]').find(n=>n.dataset.materialId===id);
  return {data,right,reads,renders,button};
}
const settle=async()=>{await new Promise(resolve=>setImmediate(resolve))};
test('uncached selection keeps the previous reader and scroll until its exact replacement is ready',async()=>{
  const f=fixture(),previous=f.right.children[0],left=f.button('b');f.right.scrollTop=123;left.onclick();
  assert.ok(f.right.children.includes(previous));assert.equal(previous.inert,true);assert.equal(f.right.scrollTop,123);assert.equal(f.right.attrs['aria-busy'],'true');assert.equal(f.right.replacements.length,1);
  f.reads[0].resolve();await settle();assert.equal(f.right.children.length,1);assert.equal(f.right.children[0].textContent,'b');assert.equal(f.right.children[0].inert,undefined);assert.equal(f.right.attrs['aria-busy'],'false');assert.equal(f.right.scrollTop,123);assert.equal(f.button('b'),left);assert.ok(f.right.replacements.every(count=>count===1));
});
test('clicking the active material or active candidate preserves the reader and media node',()=>{
  const f=fixture(),previous=f.right.children[0];f.button('a').onclick();previous.options.selectCandidate('current');assert.equal(f.right.children[0],previous);assert.equal(f.renders.length,1);assert.equal(f.reads.length,0);
});
test('a superseded response cannot flash another material into the active reader',async()=>{
  const f=fixture();f.button('b').onclick();f.button('c').onclick();f.reads[0].resolve();await settle();assert.equal(f.renders.length,1);assert.equal(f.right.attrs['aria-busy'],'true');f.reads[1].resolve();await settle();assert.equal(f.right.children[0].textContent,'c');
});
test('failed exact read keeps the prior content disabled and retries the same selection',async()=>{
  const f=fixture(),previous=f.right.children[0];f.button('b').onclick();f.reads[0].reject(Error('offline'));await settle();assert.ok(f.right.children.includes(previous));assert.equal(previous.inert,true);assert.equal(f.data.unifiedMaterialId,'b');assert.equal(f.right.attrs['aria-busy'],'false');
  const retry=f.right.querySelector('.material-reader-status').children.find(n=>n.tag==='button');retry.onclick();assert.equal(f.reads[1].id,'b');f.reads[1].resolve();await settle();assert.equal(f.right.children[0].textContent,'b');
});
