const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
class Element{
  constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.isConnected=true;this.className=''}
  append(...nodes){this.children.push(...nodes)}
  replaceChildren(){this.children=[]}
  setAttribute(){}
  querySelectorAll(){return []}
}
test('[defect-probing] saving away from a material invalidates its cached judgments on return',async()=>{
  const reads=[],context={state:{},document:{querySelectorAll:()=>[]},el:tag=>new Element(tag),nodeText:(tag,cls,text,parent)=>{const node=new Element(tag);node.textContent=text;parent.append(node);return node},businessTitle:()=> 'M1',productionButton:(parent,label)=>{const node=new Element('button');node.textContent=label;parent.append(node);return node},api:async url=>{reads.push(url);return {current:[],history:[],conflicting:false}},URLSearchParams};
  vm.createContext(context);vm.runInContext(fs.readFileSync(require.resolve('../review_desk/static/material-review.js'),'utf8'),context);
  const target={object_id:'asset',revision_id:'exact'},row={object_id:'asset',id:'exact',version:1,payload:{title:'Original'}},cached={judgments:{current:[],history:[],conflicting:false}};
  await context.refreshMaterialJudgments(target);context.renderMaterialResultReview(new Element('main'),row,cached);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(reads.length,1);assert.match(reads[0],/object_id=asset.*revision_id=exact/);
});
