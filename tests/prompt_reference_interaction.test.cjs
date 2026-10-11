const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
class Element{
 constructor(tag){this.tag=tag;this.dataset={};this.attrs={};this.children=[];this.text='';this.listeners=[];}
 append(...nodes){this.children.push(...nodes);}
 setAttribute(k,v){this.attrs[k]=v;}
 addEventListener(...args){this.listeners.push(args);}
 set textContent(v){this.text=v;}
 get textContent(){return this.text+this.children.map(n=>n.textContent).join('');}
}
const source=fs.readFileSync('review_desk/static/production-breakdown.js','utf8'),start=source.indexOf('function renderLinkedPrompt('),body=source.slice(start,source.indexOf('\nfunction ',start+1));
for(const kind of ['REQUIREMENT','CALL'])for(const marker of ['@图片1','参考图1','图1'])test(kind+' '+marker+' prompt keeps exact activation and source offsets without hover/focus/arrow bindings',()=>{
 const raw=`原文😀 ${marker} 后文`,reference={object_id:'old-image',revision_id:'exact-old',candidate_id:'candidate-A',component_id:'original',crop:{x:.1,y:.2,width:.4,height:.3},range:{start_seconds:2,end_seconds:4}},opened=[];
 const input={index:0,label:'图片1',ref:reference,row:{object_id:'old-image',payload:{title:'准确旧图'}},slot:{relation_context:{summary:'不要在 Prompt 弹出',record:{id:'old-relation'}}}};
 const c={el:tag=>new Element(tag),nodeText:()=>{},productionTextBlocks:()=>[{id:'prompt',field:'prompt',text:raw}],materialInputs:()=>[input],shotReferenceItems:()=>[input],materialReferenceRequest:()=>({url:'/exact'}),reviewURL:s=>s,businessCode:()=> 'M1',getSelection:()=>({isCollapsed:true}),openMaterialReference:(r)=>opened.push(r),openShotReference:(i)=>opened.push(i.ref),bindRelationSummary:()=>{throw Error('Prompt must not bind a relation popover');},document:{createTextNode:text=>{const e=new Element('#text');e.textContent=text;return e;}}};
 vm.createContext(c);vm.runInContext(body,c);const root=new Element('main'),row={kind,payload:{},review_shot_slots:[{index:0,relation_context:input.slot.relation_context}]};
 c.renderLinkedPrompt(root,row,[],[],'prompt');const pre=root.children[0],link=pre.children.find(n=>n.tag==='a');assert.equal(pre.reviewSourceText,raw);assert.equal(link.textContent,'@准确旧图');assert.equal(link.listeners.length,0);assert.deepEqual(JSON.parse(JSON.stringify(pre.reviewTextMap)),[{sourceStart:4,sourceEnd:4+Array.from(marker).length,displayStart:4,displayEnd:9}]);link.onclick({preventDefault(){}});assert.equal(opened[0],reference);
});
