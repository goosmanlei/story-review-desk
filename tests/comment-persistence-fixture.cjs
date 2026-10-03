// Execute the actual shared editor functions without simulating a browser render.
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),crypto=require('node:crypto');
function fixture({storage=new Map(),fetch:transport}={}){
  const textarea={value:'',disabled:false,readOnly:false},intent={checked:false,disabled:false},messages=[],requests=[],buttons=[{},{}];
  const editor={querySelector:s=>s==='textarea'?textarea:s==='#material-revision-intent'?context.intent:s==='[data-comment-submit]'?buttons[0]:buttons[1],querySelectorAll:()=>buttons};
  const nodes={'#comment-editor-text':textarea,'.comment-editor':editor,'#toast':{classList:{add(){},remove(){}},set textContent(v){messages.push(v)}}};
  class Element{constructor(tag){this.tag=tag;this.children=[];this.dataset={}}append(...children){this.children.push(...children)}setAttribute(){} }
  const context={crypto,URL,console,setTimeout:()=>1,clearTimeout(){},intent,
    document:{addEventListener(){},querySelector:s=>s==='#material-revision-intent'?context.intent:nodes[s],createElement:tag=>new Element(tag)},
    localStorage:{getItem:k=>storage.has(k)?storage.get(k):null,setItem:(k,v)=>storage.set(k,String(v)),removeItem:k=>storage.delete(k)},
    fetch:async(url,options)=>{requests.push({url,...options});return transport?transport(url,options):{ok:true,json:async()=>({})}},
    location:{href:'http://127.0.0.1/'},history:{replaceState(){}},
    isEntityReview:()=>context.state.workspace==='settings.workspace'&&!!context.state.entityReview,
    reloadEntityReview:async()=>{context.reloads++},openProductionRecord:async()=>{context.reloads++},reloads:0};
  vm.createContext(context);
  for(const name of ['app.js','material-review.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static',name),'utf8'),context);
  vm.runInContext(`globalThis.state=state;globalThis.key=draftKey;globalThis.legacyKey=legacyDraftKey;
    renderComments=()=>{globalThis.renders=(globalThis.renders||0)+1};refreshComments=async()=>{};
    renderDocument=()=>{};renderStructureReader=()=>{};renderScriptReader=()=>{};paintProductionReview=()=>{};
    globalThis.forgetScriptDraft=()=>{};globalThis.scriptEpisode=()=>state.episode;
    globalThis.focusProductionReview=detail=>{state.productionSelected=detail.record};`,context);
  const target=(workspace='story.sources',id='source-1',revision='rev-1')=>{
    Object.assign(context.state,{workspace,current:{id,target_revision_id:revision},structureRevision:revision,episode:{object_id:id,id:revision},productionSelected:{object_id:id,id:revision},editing:null,anchor:{type:'global'},materialReview:null,entityReview:null});
    context.intent=null;textarea.value='opinion';return context.key();
  };
  const material=(number=1,mid='need',data=null)=>{
    target('materials.workspace','plan','plan-v1');const row=context.state.productionSelected;
    context.state.materialReview=data||{record:{object_id:mid},material_versions:{[mid]:[2,1].map(n=>({number:n,state:n===1?'produced':'preparing',members:[row],plan:row,results:[]}))},selectedMaterialRounds:{[mid]:number}};
    context.state.materialReview.selectedMaterialRounds[mid]=number;return context.key();
  };
  return {context,storage,textarea,intent,messages,requests,target,material,Element};
}
module.exports={fixture};
