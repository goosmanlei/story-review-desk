// These check slot identity, persistence and text anchoring; they do not certify layout.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function fixture({selected=true,readonly=false,indirect=false,media='image',deferred=false}={}){
  const timers=new Map(),observers=[],events=[],calls=[];let clock=0,resolveRead;
  const original=(file,id='original')=>({id,role:'original',mime:media+'/test',file});
  const candidates=[1,2,3].map(number=>({number,candidate:{object_id:'asset-'+number,revision_id:'candidate-'+number},media_type:media,originals:number===3?[original('three','first'),original('four','second')]:[original('file-'+number)]}));
  class Element{
    constructor(tag,classes=''){this.tagName=tag.toUpperCase();this.className=classes||'';this.dataset={};this.attrs={};this.children=[];this.parentNode=null;this.style={setProperty(k,v){this[k]=v}};this.paused=true;this.classList={toggle:(c,on)=>{const set=new Set(this.className.split(' ').filter(Boolean));if(on)set.add(c);else set.delete(c);this.className=[...set].join(' ')}}}
    append(...nodes){for(const n of nodes){n.parentNode=this;this.children.push(n)}}
    replaceChildren(...nodes){for(const n of this.children)n.parentNode=null;this.children=[];this.ownText='';this.append(...nodes)}
    set textContent(v){this.replaceChildren();this.ownText=String(v)}
    get textContent(){return (this.ownText||'')+this.children.map(n=>n.textContent).join('')}
    get isConnected(){return this===body||!!this.parentNode?.isConnected}
    remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(n=>n!==this);this.parentNode=null}
    setAttribute(k,v){this.attrs[k]=String(v)}getAttribute(k){return this.attrs[k]??null}removeAttribute(k){delete this.attrs[k];if(k==='src')this.src=null}
    all(){return this.children.flatMap(n=>[n,...n.all()])}
    querySelectorAll(selectors){return this.all().filter(n=>selectors.split(',').some(s=>s.startsWith('.')?n.className.split(' ').includes(s.slice(1)):s==='[data-candidate-revision]'?!!n.dataset.candidateRevision:n.tagName===s.toUpperCase()))}
    querySelector(s){return this.querySelectorAll(s)[0]||null}
    contains(n){return this===n||this.all().includes(n)}matches(){return !!this.hover}
    getBoundingClientRect(){return {left:700,right:760,top:200,bottom:220,width:parseFloat(this.style.width)||60,height:Math.min(parseFloat(this.style.maxHeight)||520,520)}}
    showPopover(){this.shown=true}focus(){c.document.activeElement=this;this.onfocus?.({type:'focus'})}pause(){this.paused=true}load(){this.loaded=true}
  }
  const body=new Element('body'),anchor=new Element('a');anchor.textContent='@准确素材';body.append(anchor);
  const value=selected?{reference:candidates[0].candidate,component_id:'original',range:{start_seconds:0,end_seconds:5.6}}:{reference:{object_id:'material',revision_id:'m'},selection_state:'unselected'};
  const slot={index:0,input_key:'initial-0',material_id:'material',canonical_material_id:'material',direct:!indirect,value,candidate:selected?candidates[0].candidate:null,component:selected?candidates[0].originals[0]:null,record:{kind:selected?'ASSET':'REQUIREMENT',payload:{media_type:media,components:selected?candidates[0].originals:[]}}};
  const other={...slot,index:1,input_key:'initial-1',value:{reference:{object_id:'other',revision_id:'other-r'},component_id:'keep',crop:{x:.2,y:.2,width:.5,height:.5}}};
  const need={kind:readonly?'CALL':'REQUIREMENT',object_id:'consumer',id:'consumer-r',current_content:!readonly,edit_token:1,content_sha256:'one',payload:{generation:{inputs:[value,other.value]}},review_shot_slots:[slot,other]};
  const c={state:{},URLSearchParams,crypto:require('node:crypto').webcrypto,AbortController,
    el:(tag,cl)=>new Element(tag,cl),nodeText:(tag,cl,text,parent)=>{const n=new Element(tag,cl);n.textContent=text;parent.append(n);return n},productionEntityIcon:()=>new Element('svg','production-entity-icon'),reviewURL:s=>s,
    document:{body,activeElement:null,documentElement:{clientWidth:1920},addEventListener:(name,fn,opts)=>events.push({name,fn,signal:opts.signal}),createTextNode:text=>{const n=new Element('#text');n.textContent=text;return n}},
    window:{innerHeight:1000,addEventListener(){}},MutationObserver:class{constructor(fn){this.fn=fn;observers.push(this)}observe(){}disconnect(){this.closed=true}},requestAnimationFrame:fn=>fn(),
    setTimeout:fn=>{timers.set(++clock,fn);return clock},clearTimeout:id=>timers.delete(id)};
  c.productionButton=(parent,text,fn)=>{const n=c.nodeText('button','',text,parent);n.onclick=e=>fn(e);return n};
  c.api=async(url,options)=>{
    if(!options){calls.push({method:'GET'});if(deferred)return new Promise(resolve=>resolveRead=resolve);return {material_id:'material',candidates}}
    const request=JSON.parse(options.body);calls.push(request);if(c.failSave)throw Error('lost response');
    const slots=need.review_shot_slots.map(s=>s.index!==request.index?s:{...s,input_key:'saved-'+calls.length,candidate:request.candidate,component:request.candidate?candidates.find(v=>v.candidate.revision_id===request.candidate.revision_id).originals.find(v=>v.id===request.component_id):null,value:request.candidate?{reference:request.candidate,component_id:request.component_id}:{reference:{object_id:'material',revision_id:'m'},selection_state:'unselected'}});
    return {requirement_id:need.object_id,revision_id:need.id,edit_token:calls.length,content_sha256:'saved',slots};
  };
  vm.createContext(c);vm.runInContext(fs.readFileSync('review_desk/static/reference-candidate-picker.js','utf8'),c);
  const item={index:0,label:'图片1',slot,value,ref:value.reference,row:slot.record};
  const view=c.bindPromptReferencePreview(anchor,item,need,{selectable:!readonly});
  const settle=async()=>{for(let i=0;i<8;i++)await Promise.resolve()};
  const popup=()=>body.querySelector('.prompt-reference-preview'),choice=n=>popup().querySelector('.reference-candidate-choices').querySelectorAll('[data-candidate-revision]')[n-1];
  return {c,body,anchor,need,item,view,candidates,calls,settle,popup,choice,Element,read:()=>resolveRead({material_id:'material',candidates}),leave:()=>{for(const fn of timers.values())fn();timers.clear()},mutate:()=>observers.filter(o=>!o.closed).forEach(o=>o.fn()),key:key=>events.filter(e=>e.name==='keydown'&&!e.signal.aborted).forEach(e=>e.fn({key,preventDefault(){},stopImmediatePropagation(){}}))};
}
test('hover restores the confirmed original without saving; click switches then explicitly cancels',async()=>{
 const f=fixture();f.anchor.onmouseenter();await f.settle();assert.equal(f.popup().querySelector('img').src,'/api/production/files/file-1');
 f.choice(2).onmouseenter();assert.equal(f.popup().querySelector('img').src,'/api/production/files/file-2');f.choice(2).onmouseleave();assert.equal(f.popup().querySelector('img').src,'/api/production/files/file-1');assert.equal(f.calls.filter(v=>v.id).length,0);
 let mirrored;f.c.referencePickerConsumer(f.need).listeners.add({connected:()=>true,refresh:()=>mirrored=f.need.review_shot_slots[0].candidate});
 await f.choice(2).onclick({stopPropagation(){}});assert.equal(f.choice(2).getAttribute('aria-pressed'),'true');assert.equal(mirrored.revision_id,'candidate-2');
 await f.choice(2).onclick({stopPropagation(){}});assert.equal(f.choice(2).getAttribute('aria-pressed'),'false');assert.ok(f.popup().querySelector('.reference-preview-placeholder'));assert.equal(f.need.payload.generation.inputs[0].range,undefined);assert.equal(f.need.review_shot_slots[1].value.crop.x,.2);
 assert.equal(f.calls.filter(v=>v.id)[1].candidate,null);assert.notEqual(f.calls.filter(v=>v.id)[0].id,f.calls.filter(v=>v.id)[1].id);
});
test('unselected defaults to placeholder; multi-original preview never selects the first original',async()=>{
 const f=fixture({selected:false});f.anchor.onmouseenter();await f.settle();assert.ok(f.popup().querySelector('.reference-preview-placeholder'));
 f.choice(2).onmouseenter();assert.ok(f.popup().querySelector('img'));f.choice(2).onmouseleave();assert.ok(f.popup().querySelector('.reference-preview-placeholder'));
 await f.choice(3).onclick({stopPropagation(){}});assert.equal(f.calls.filter(v=>v.id).length,0);const originals=f.popup().querySelector('.reference-originals').querySelectorAll('button');originals[1].onmouseenter();assert.equal(f.popup().querySelector('img').src,'/api/production/files/four');originals[1].onmouseleave();assert.ok(f.popup().querySelector('.reference-preview-placeholder'));
 await originals[1].onclick({stopPropagation(){}});assert.equal(f.need.review_shot_slots[0].value.component_id,'second');
});
test('unknown clear retains confirmed choice and retries the same exact request',async()=>{
 const f=fixture();f.anchor.onmouseenter();await f.settle();f.c.failSave=true;await f.choice(1).onclick({stopPropagation(){}});assert.equal(f.choice(1).getAttribute('aria-pressed'),'true');
 delete f.c.failSave;await f.popup().querySelectorAll('button').find(b=>b.textContent==='重试保存').onclick();const saved=f.calls.filter(v=>v.id);assert.equal(saved[0].id,saved[1].id);assert.equal(saved[1].candidate,null);assert.equal(f.choice(1).getAttribute('aria-pressed'),'false');
});
test('historical preview stays exact and read-only; closing stops playback',async()=>{
 const f=fixture({readonly:true,media:'audio'});f.item.ref.snapshot_record={id:'frozen-original'};f.anchor.onmouseenter();await f.settle();const player=f.popup().querySelector('audio');assert.equal(player.paused,true);assert.equal(player.preload,'none');assert.equal(f.calls.length,0);assert.equal(f.popup().querySelectorAll('[data-candidate-revision]').length,0);assert.equal(f.view.input(),f.item);
 player.paused=false;f.view.close();assert.equal(player.paused,true);assert.equal(player.src,null);assert.equal(player.isConnected,false);assert.equal(f.popup(),null);
});
test('an indirect reference previews its exact original without exposing choice or borrowing its owner',async()=>{
 const f=fixture({indirect:true});const before=JSON.stringify(f.need);f.anchor.onmouseenter();await f.settle();assert.equal(f.popup().querySelector('img').src,'/api/production/files/file-1');assert.equal(f.popup().querySelectorAll('[data-candidate-revision]').length,0);assert.equal(f.calls.length,0);assert.equal(JSON.stringify(f.need),before);
});
test('a candidate read preserves active playback of the same original, and mouse leave stops it',async()=>{
 const f=fixture({media:'audio',deferred:true});f.anchor.onmouseenter();const player=f.popup().querySelector('audio');assert.equal(player.paused,true);player.paused=false;f.read();await f.settle();assert.equal(f.popup().querySelector('audio'),player);assert.equal(player.paused,false);f.anchor.onmouseleave({type:'mouseleave'});f.leave();assert.equal(player.paused,true);assert.equal(f.popup(),null);
});
test('a closed then reopened hover receives its pending candidate read and Esc does not reopen it',async()=>{
 const f=fixture({deferred:true});f.anchor.onmouseenter();f.view.close();f.anchor.onmouseenter();f.read();await f.settle();assert.equal(f.popup().querySelectorAll('[data-candidate-revision]').length,3);f.key('Escape');assert.equal(f.popup(),null);assert.equal(f.c.document.activeElement,f.anchor);
});
test('Prompt text offsets remain unchanged and activation uses the latest slot receipt',async()=>{
 const f=fixture(),source=fs.readFileSync('review_desk/static/production-breakdown.js','utf8'),start=source.indexOf('function renderLinkedPrompt(');vm.runInContext(source.slice(start,source.indexOf('\nfunction ',start+1)),f.c);
 const raw='甲😀 @图片1 后文',opened=[];Object.assign(f.c,{productionTextBlocks:()=>[{id:'prompt',field:'prompt',text:raw}],materialInputs:()=>[f.item],materialReferenceRequest:()=>({url:'/exact'}),businessCode:()=> 'M1',getSelection:()=>({isCollapsed:true}),openMaterialReference:r=>opened.push(r)});const parent=new f.Element('main');f.body.append(parent);f.c.renderLinkedPrompt(parent,f.need,[],[],'prompt',null,{selectable:true});
 const pre=parent.querySelector('pre'),a=pre.querySelector('a'),text=pre.textContent,map=JSON.stringify(pre.reviewTextMap);a.onmouseenter();await f.settle();assert.equal(pre.textContent,text);assert.equal(pre.reviewSourceText,raw);assert.equal(JSON.stringify(pre.reviewTextMap),map);assert.equal(pre.querySelector('.prompt-reference-preview'),null);
 await f.choice(2).onclick({stopPropagation(){}});a.onclick({preventDefault(){}});assert.equal(opened[0].revision_id,'candidate-2');assert.equal(pre.textContent,text);assert.equal(JSON.stringify(pre.reviewTextMap),map);
});
