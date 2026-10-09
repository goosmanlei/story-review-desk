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
  const render=player=>{box.all().slice(1).forEach(e=>e.isConnected=false);box.children=[];c.renderShotReferenceChoice(box,model,item,player);return box.all().find(e=>e.tag==='button'&&!e.textContent?.startsWith('试听'))};
  const input=name=>box.all().find(e=>e.attrs['aria-label']===name);
  return {c,context,box,item,slot,model,calls,saved,render,input};
}
test('selected current reference carries the consolidation baseline to the shared exact reader',()=>{
  const f=fixture();let opened;f.c.openUnifiedMaterial=ref=>opened=ref;
  f.c.openShotReference({slot:f.slot,value:f.slot.value},{need:f.context.need,number:1},null);
  assert.equal(opened.params.get('material_baseline'),'baseline');
  assert.equal(opened.params.get('material_target'),'candidate');
});
test('audition follows saved and unsaved reference fields, discard restores them, and comment selection has no write',()=>{
  const f=fixture(),played=[],player={reviewAudition:b=>{played.push(plain(b));return true},reviewPause(){}};f.render(player);
  const audition=f.box.all().find(e=>e.textContent?.startsWith('试听'));
  assert.equal(audition.textContent,'试听已保存片段 · 1–4 秒');audition.onclick();
  f.input('结束秒数').value='5';f.input('结束秒数').oninput();assert.equal(audition.textContent,'试听未保存范围 · 1–5 秒');audition.onclick();
  f.box.all().find(e=>e.textContent==='放弃范围修改').onclick();assert.equal(audition.textContent,'试听已保存片段 · 1–4 秒');audition.onclick();
  assert.deepEqual(played,[{start_seconds:1,end_seconds:4},{start_seconds:1,end_seconds:5},{start_seconds:1,end_seconds:4}]);assert.equal(f.calls.length,0);
  f.item.component={...f.item.component,id:'preview',role:'preview'};f.render(player);assert.equal(f.input('使用时间段（秒）').checked,false);assert.equal(f.box.all().find(e=>e.textContent?.startsWith('试听')).hidden,true);
});
test('invalid reference audition is refused without saving or changing the user numbers',()=>{
  const f=fixture(),player={reviewAudition:()=>false,reviewPause(){}};f.render(player);
  f.input('开始秒数').value='6';f.input('开始秒数').oninput();f.box.all().find(e=>e.textContent?.startsWith('试听')).onclick();
  assert.match(f.context.error,/起点须早于终点/);assert.equal(f.input('开始秒数').value,'6');assert.equal(f.calls.length,0);
});
test('another material version sharing a candidate does not inherit the saved range',()=>{
  const f=fixture();f.model.round.number=2;f.render();assert.equal(f.input('使用时间段（秒）').checked,false);
  f.model.round.number=1;f.render();assert.equal(f.input('使用时间段（秒）').checked,true);assert.equal(f.input('结束秒数').value,'4');
});
test('saving releases busy and another range edit is unsaved and can be submitted',async()=>{
  const f=fixture(),button=f.render();f.input('结束秒数').value='5';f.input('结束秒数').oninput?.();
  await button.onclick();assert.equal(f.context.busy,false);
  f.input('结束秒数').value='6';f.input('结束秒数').oninput?.();
  assert.equal(button.disabled,false);assert.match(button.textContent,/保存/);assert.doesNotMatch(button.textContent,/已保存/);
  await button.onclick();assert.equal(f.calls.length,2);assert.equal(f.calls[1].range.end_seconds,6);
});
test('a save receipt advances the exact consumer revision and slot for the next operation',async()=>{
  const f=fixture(),button=f.render();f.input('结束秒数').value='5';f.input('结束秒数').oninput?.();await button.onclick();
  assert.equal(f.context.need.id,'new-plan-1');assert.equal(f.context.slot.input_key,'new-slot-1');
  f.input('结束秒数').value='6';f.input('结束秒数').oninput?.();await button.onclick();
  assert.equal(f.calls[1].expected_revision,'new-plan-1');assert.equal(f.calls[1].input_key,'new-slot-1');
});
test('a saved selection is compared by values independently of database JSON key order',()=>{
  const f=fixture();f.slot.value.range={end_seconds:4,start_seconds:1};
  const button=f.render();assert.equal(button.disabled,true);assert.match(button.textContent,/已保存/);
});
test('unchanged browsing has no write; discard restores persisted range rather than an earlier draft',async()=>{
  const f=fixture(),button=f.render();await button.onclick();assert.equal(f.calls.length,0);
  f.input('结束秒数').value='5';f.input('结束秒数').oninput();
  f.box.all().find(e=>e.textContent==='放弃范围修改').onclick();
  assert.equal(f.input('结束秒数').value,'4');assert.equal(button.disabled,true);assert.equal(f.calls.length,0);
});
test('failed save retains exact fields and retries the same operation without a second id',async()=>{
  const f=fixture(),button=f.render();f.c.reply=()=>{throw Error('network unavailable')};
  f.input('结束秒数').value='5';f.input('结束秒数').oninput();await button.onclick();
  assert.equal(f.input('结束秒数').value,'5');assert.equal(button.disabled,false);assert.match(f.context.error,/network/);
  delete f.c.reply;await button.onclick();assert.equal(f.calls[0].id,f.calls[1].id);assert.equal(f.context.need.id,'new-plan-2');
});
test('empty enabled fields fail before the request; unchecked range controls remain disabled',async()=>{
  const f=fixture(),button=f.render();f.input('结束秒数').value='';f.input('结束秒数').oninput();await button.onclick();
  assert.equal(f.calls.length,0);assert.match(f.context.error,/完整/);
  const toggle=f.input('使用时间段（秒）');toggle.checked=false;toggle.onchange();
  assert.equal(f.input('开始秒数').disabled,true);assert.equal(f.input('结束秒数').disabled,true);
  await button.onclick();assert.equal(f.calls.length,1);assert.equal('range' in f.calls[0],false);
});
test('typing during save keeps the newer unsaved range when the earlier receipt arrives',async()=>{
  const f=fixture(),button=f.render();let resolve;f.c.reply=()=>new Promise(r=>resolve=r);
  f.input('结束秒数').value='5';f.input('结束秒数').oninput();const pending=button.onclick();
  f.input('结束秒数').value='6';f.input('结束秒数').oninput();
  resolve({requirement_id:'video',revision_id:'saved-five',number:1,slots:[{...f.slot,input_key:'five-slot',value:{...f.slot.value,range:{start_seconds:1,end_seconds:5}}}]});await pending;
  assert.equal(f.input('结束秒数').value,'6');assert.equal(button.disabled,false);assert.doesNotMatch(button.textContent,/已保存/);
});
test('candidate and component drafts are separate; a late save updates only the active view state',async()=>{
  const f=fixture(),button=f.render();let resolve;f.c.reply=()=>new Promise(r=>resolve=r);
  f.input('结束秒数').value='5';f.input('结束秒数').oninput();const pending=button.onclick();
  f.item.record={...f.item.record,id:'other-candidate'};const other=f.render();assert.equal(f.input('使用时间段（秒）').checked,false);
  resolve({requirement_id:'video',revision_id:'saved-five',number:1,slots:[{...f.slot,input_key:'five-slot',value:{...f.slot.value,range:{start_seconds:1,end_seconds:5}}}]});await pending;
  assert.doesNotMatch(other.textContent,/已保存/);assert.equal(other.disabled,false);
  f.item.record={...f.item.record,id:'candidate'};f.render();assert.equal(f.input('结束秒数').value,'5');
  f.item.component={...f.item.component,id:'preview',role:'preview'};assert.equal(f.render().disabled,true);assert.equal(f.input('使用时间段（秒）').checked,false);
});
test('frozen save receipt carries the new plan and remapped active input index into the next edit',async()=>{
  const f=fixture(),button=f.render();f.context.frozen=true;
  f.c.reply=()=>({requirement_id:'video',revision_id:'draft-v2',number:2,selected_index:6,slots:[{...f.slot,index:6,input_key:'mapped-slot',value:{...f.slot.value,range:{start_seconds:1,end_seconds:5}}}]});
  f.input('结束秒数').value='5';f.input('结束秒数').oninput();await button.onclick();
  f.input('结束秒数').value='6';f.input('结束秒数').oninput();delete f.c.reply;await button.onclick();
  assert.equal(f.calls[1].plan_number,2);assert.equal(f.calls[1].index,6);assert.equal(f.calls[1].expected_revision,'draft-v2');assert.equal(f.calls[1].input_key,'mapped-slot');
});
test('close during save does not change another reference card, and refresh requires the original page',async()=>{
  for(const pageActive of [true,false]){
    const f=fixture(),button=f.render();let resolve;f.c.reply=()=>new Promise(r=>resolve=r);f.context.pageActive=()=>pageActive;
    f.input('结束秒数').value='5';f.input('结束秒数').oninput();const pending=button.onclick();
    f.context.dialog.isConnected=false;f.c.state.shotReferenceContext={slot:{index:1}};
    resolve({requirement_id:'video',revision_id:'late',number:1,slots:[{...f.slot,input_key:'late-slot',value:{...f.slot.value,range:{start_seconds:1,end_seconds:5}}}]});await pending;
    assert.deepEqual(plain(f.c.state.shotReferenceContext),{slot:{index:1}});assert.equal(f.saved.length,pageActive?1:0);
  }
});
test('a closed reference waits for a different open reader before refreshing the consumer',()=>{
  const f=fixture();let opened,refreshes=0,onClose;f.c.openUnifiedMaterial=ref=>opened=ref;f.c.afterReviewDialogReturn=action=>action();
  vm.runInContext('const reviewDialogStack=[];',f.c);
  const trigger={isConnected:true,closest:()=>null};f.c.openShotReference({slot:f.slot,value:f.slot.value},{need:f.context.need,number:1,onSaved:()=>refreshes++},trigger);
  f.c.newDialog={addEventListener:(_,fn)=>onClose=fn};vm.runInContext('reviewDialogStack.push(newDialog)',f.c);
  opened.shotReference.onSaved({number:1});assert.equal(refreshes,0);
  vm.runInContext('reviewDialogStack.pop()',f.c);onClose();assert.equal(refreshes,1);
});
