const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
class Element{
  constructor(tag,cls=''){this.tag=tag;this.className=cls;this.children=[];this.attrs={};this.dataset={};this.isConnected=true;this.value='';this.disabled=false}
  append(...nodes){this.children.push(...nodes)}
  setAttribute(k,v){this.attrs[k]=v}
  closest(selector){return selector==='dialog'?this.dialog:null}
  all(){return [this,...this.children.flatMap(n=>n instanceof Element?n.all():[])]}
}
const plain=v=>JSON.parse(JSON.stringify(v));
function fixture(){
  const dialog={isConnected:true},box=new Element('article'),calls=[],saved=[];box.dialog=dialog;
  const item={record:{object_id:'asset',id:'candidate',payload:{}},component:{id:'original',role:'original',mime:'audio/mp3',duration_seconds:10},candidate_number:1};
  const slot={index:4,input_key:'old-slot',material_id:'song',canonical_material_id:'song',number:1,baseline_id:'baseline',candidate:{object_id:'asset',revision_id:'candidate'},value:{component_id:'original',range:{start_seconds:1,end_seconds:4}},record:item.record};
  const context={dialog,source:{onSaved:r=>saved.push(r)},need:{object_id:'video',id:'old-plan'},number:1,slot};
  const c={state:{shotReferenceContext:context},URLSearchParams,URL,crypto:require('node:crypto').webcrypto,location:{href:'http://fixture/'},
    el:(tag,cls)=>new Element(tag,cls),document:{createTextNode:text=>text},
    nodeText:(tag,cls,text,parent)=>{const e=new Element(tag,cls);e.textContent=text;parent.append(e);return e},
    productionButton:(parent,text,fn)=>{const e=new Element('button');e.textContent=text;e.onclick=fn;parent.append(e);return e},
    productionRef:r=>({object_id:r.object_id,revision_id:r.id}),toast(){},
    api:async(url,options)=>{const request=JSON.parse(options.body);calls.push(request);if(c.reply)return c.reply(request);return {requirement_id:'video',revision_id:'new-plan-'+calls.length,number:1,slots:[{...slot,input_key:'new-slot-'+calls.length,value:{...slot.value,...request},candidate:request.candidate}]}}
  };
  vm.createContext(c);vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static/production-breakdown.js'),'utf8'),c);
  const model={material_id:'song',round:{number:1}};
  const input=name=>box.all().find(e=>e.attrs['aria-label']===name);
  return {c,context,box,item,slot,model,calls,saved,input};
}
test('selected current reference opens the exact candidate without a removed baseline',()=>{
  const f=fixture();let opened;f.c.openUnifiedMaterial=ref=>opened=ref;
  f.c.openShotReference({slot:f.slot,value:f.slot.value},{need:f.context.need,number:1},null);
  assert.equal(opened.params.get('material_baseline'),null);
  assert.equal(opened.params.get('material_target'),'candidate');
});
test('a closed reference waits for a different open reader before refreshing the consumer',()=>{
  const f=fixture();let opened,refreshes=0,onClose;f.c.openUnifiedMaterial=ref=>opened=ref;f.c.afterReviewDialogReturn=action=>action();
  vm.runInContext('const reviewDialogStack=[];',f.c);
  const trigger={isConnected:true,closest:()=>null};f.c.openShotReference({slot:f.slot,value:f.slot.value},{need:f.context.need,number:1,onSaved:()=>refreshes++},trigger);
  f.c.newDialog={addEventListener:(_,fn)=>onClose=fn};vm.runInContext('reviewDialogStack.push(newDialog)',f.c);
  opened.shotReference.onSaved({number:1});assert.equal(refreshes,0);
  vm.runInContext('reviewDialogStack.pop()',f.c);onClose();assert.equal(refreshes,1);
});
