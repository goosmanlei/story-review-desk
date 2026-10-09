// Synthetic DOM/request timing verifies the shared reader contract, not browser layout.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
class Element{
 constructor(tag,cls=''){this.tag=tag;this.className=cls;this.children=[];this.dataset={};this.attrs={};this.isConnected=true;this.scrollTop=0;this.classList={add:x=>this.className+=' '+x};}
 append(...ns){this.children.push(...ns)} replaceChildren(...ns){this.children=ns} setAttribute(k,v){this.attrs[k]=v}
 all(){return this.children.flatMap(n=>[n,...n.all()])} querySelector(s){return this.all().find(n=>s==='button'?n.tag==='button':n.className.includes(s.slice(1)))||null}
 focus(){this.focused=true} scrollIntoView(){this.located=true}
}
const ref={object_id:'ep',revision_id:'historic',scene_id:'s',block_ids:['b','d']};
const excerpt={reference:ref,title:'原场',scene:{id:'s'},blocks:[{id:'b',text:'引用乙'},{id:'d',text:'引用丁'}],scene_context:{block_count:5,omissions:[{before_block_id:'b',count:1},{before_block_id:'d',count:1},{before_block_id:null,count:1}]}};
const full={...excerpt,full_scene:true,highlight_block_ids:['b','d'],blocks:['a','b','c','d','e'].map(id=>({id,text:id})),scene_context:{block_count:5,omissions:[]}};
function fixture(){
 const views=[],requests=[],state={productionRecords:[],productionSelected:{id:'original-material'},anchor:{quote:'原意见'},pending:'未提交'};
 const c={URLSearchParams,state,reviewPositionText:x=>x,reviewPositionLabel:()=> '准确场',nodeText:(tag,cls,text,parent)=>{const n=new Element(tag,cls||'');n.textContent=text;parent.append(n);return n},productionButton:(parent,text,fn)=>{const n=new Element('button');n.textContent=text;n.onclick=fn;parent.append(n);return n},openReviewDialog:()=>{const v={dialog:new Element('dialog'),body:new Element('section'),title:new Element('h2')};views.push(v);return v},api:async url=>{requests.push(url);return url.includes('full_scene')?full:excerpt}};
 vm.createContext(c);vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static/material-review.js'),'utf8'),c);
 const button=(v,text)=>v.body.all().find(n=>n.tag==='button'&&n.textContent===text);
 return {c,views,requests,state,button};
}
test('same-dialog full text keeps original citation, exact URL, draft ownership and excerpt scroll',async()=>{
 const f=fixture(),before=JSON.stringify({ref,excerpt,state:f.state});await f.c.openMaterialReference(ref,null,true);const v=f.views[0];v.body.scrollTop=120;
 assert.equal(v.body.all().filter(n=>n.className==='reference-omission').length,3);
 await f.button(v,'读完整场').onclick();assert.equal(f.views.length,1);assert.equal(v.body.all().filter(n=>n.dataset.referenceBlock).length,5);
 assert.deepEqual(v.body.all().filter(n=>n.attrs['aria-label']==='原引用').map(n=>n.dataset.referenceBlock),['b','d']);
 const url=new URL(f.requests[1],'http://fixture');assert.equal(url.searchParams.get('revision_id'),'historic');assert.equal(url.searchParams.get('scene_id'),'s');assert.equal(url.searchParams.get('block_ids'),'b,d');
 await f.button(v,'返回选段').onclick();assert.equal(v.body.scrollTop,120);assert.equal(v.body.all().filter(n=>n.dataset.referenceBlock).length,2);
 assert.equal(JSON.stringify({ref,excerpt,state:f.state}),before);
});
test('complete scene and existing full-scene paths add no redundant action or false gap',async()=>{
 for(const data of [{...excerpt,scene_context:{block_count:2,omissions:[]}},full]){
  const f=fixture();f.c.api=async()=>data;await f.c.openMaterialReference(ref,null,'full_scene');const v=f.views[0];
  assert.equal(f.button(v,'读完整场'),undefined);assert.equal(v.body.all().filter(n=>n.className==='reference-omission').length,0);
 }
});
test('ambiguous block-only citation explains unavailable context without guessing',async()=>{
 const f=fixture();f.c.api=async()=>({...excerpt,scene:null,scene_context:null,context_unavailable_reason:'无法确定唯一准确场'});
 await f.c.openMaterialReference({...ref,scene_id:undefined},null,true);const v=f.views[0];assert.equal(f.button(v,'读完整场'),undefined);assert.ok(v.body.all().some(n=>n.textContent?.includes('无法确定唯一准确场')));
});
for(const phase of ['initial','full'])for(const failed of [false,true])test(`${phase} late ${failed?'failure':'success'} after close cannot change a newer source or focus`,async()=>{
 const f=fixture();let resolve,reject;
 const pending=new Promise((r,j)=>{resolve=r;reject=j});
 if(phase==='initial')f.c.api=()=>pending;
 const opening=f.c.openMaterialReference(ref,null,true);
 if(phase==='full')await opening;
 const old=f.views[0];let operation=opening;
 if(phase==='full'){f.c.api=()=>pending;operation=f.button(old,'读完整场').onclick()}
 old.dialog.isConnected=false;f.c.api=async()=>({...excerpt,title:'另一来源'});await f.c.openMaterialReference({...ref,object_id:'new'},null,true);const next=f.views[1],before=next.body.all().map(n=>n.textContent);
 failed?reject(Error('迟到失败')):resolve(phase==='full'?full:excerpt);await operation;
 assert.deepEqual(next.body.all().map(n=>n.textContent),before);assert.equal(next.body.all().some(n=>n.focused),false);assert.equal(f.state.productionSelected.id,'original-material');
});
test('current full read failure leaves readable excerpt and an explicit retry',async()=>{
 const f=fixture();await f.c.openMaterialReference(ref,null,true);f.c.api=async()=>{throw Error('准确历史不可用')};const v=f.views[0],b=f.button(v,'读完整场');await b.onclick();
 assert.equal(v.body.all().filter(n=>n.dataset.referenceBlock).length,2);assert.equal(b.disabled,false);assert.ok(v.body.all().some(n=>n.textContent?.includes('准确历史不可用')));
});
