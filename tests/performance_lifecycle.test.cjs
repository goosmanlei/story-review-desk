const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const desk = path.resolve(__dirname,'..');
const ui = fs.readFileSync(path.join(desk, 'review_desk/static/review-ui.js'), 'utf8');
function context(extra={}) {
  const observers=[];
  const c={URL,DOMException,AbortController,setTimeout,clearTimeout,location:{href:'http://fixture/'},document:{body:{},addEventListener(){}},window:{addEventListener(){}},MutationObserver:class {constructor(fn){observers.push(fn)} observe(){}},...extra};
  vm.createContext(c);vm.runInContext(ui,c);
  return {c,observers};
}
require('node:test').test('component disposal and coalesced media and graph requests preserve independent consumers',async()=>{
  const results={source_sha256:crypto.createHash('sha256').update(ui).digest('hex'),checks:[]};
  {
    const {c,observers}=context();
    const image={tagName:'IMG',src:'http://fixture/image.png',isConnected:false,addEventListener(){},removeAttribute(){}};
    let laterDisposed=0;
    c.reviewRefreshMedia(image);c.reviewLifetime({isConnected:false}).onDispose(()=>laterDisposed++);
    let error=null;try{observers[0]([{removedNodes:[image]}])}catch(e){error=String(e)}
    results.checks.push({name:'image_disposal_does_not_interrupt_later_components',passed:!error&&laterDisposed===1,error,laterDisposed});
  }
  {
    const {c}=context();
    const old=[{id:'a',target_revision_id:'r1',anchor:{type:'global'}}];
    const scope={revision:'r1',kind:'text',blockIds:[]};
    assert.equal(c.reviewBlockComments(old,scope).length,1);
    const fresh=old.concat({id:'b',target_revision_id:'r1',anchor:{type:'global'}});
    assert.equal(c.reviewBlockComments(fresh,scope).length,2);
    assert.equal(c.reviewBlockComments(old,{...scope,revision:'r2'}).length,0);
    results.checks.push({name:'comment_index_rebuilds_for_replacement_array',passed:true});
  }
  {
    let fetchCalls=0,sharedSignal,release;
    const {c}=context({fetch:(_url,options)=>{fetchCalls++;sharedSignal=options.signal;return new Promise(resolve=>release=resolve)}});
    const a=new AbortController(),b=new AbortController();
    const one=c.reviewWaveform('http://fixture/a.wav',a.signal).then(()=>null,e=>e.name);
    const two=c.reviewWaveform('http://fixture/a.wav',b.signal);
    a.abort();assert.equal(await one,'AbortError');assert.equal(sharedSignal.aborted,false);
    release({ok:true,json:async()=>({peaks:[.1,.2],duration:1})});
    assert.equal((await two).duration,1);assert.equal(fetchCalls,1);
    results.checks.push({name:'waveform_shared_request_survives_one_client_cancel',passed:true});
  }
  {
    let worker,posts=0;
    const {c}=context({reviewURL:u=>u,Worker:class {constructor(){worker=this} postMessage(value){posts++;this.input=value}terminate(){this.terminated=true}}});
    vm.runInContext(fs.readFileSync(path.join(desk,'review_desk/static/entity-relations.js'),'utf8'),c);
    const nodes=[{id:'n1',w:200,h:110,component:0,rank:0,row:{id:'r1'}}],edges=[];
    const a=new AbortController(),b=new AbortController();
    const one=c.managementEdgeGeometry(nodes,edges,a.signal).then(()=>null,e=>e.name);
    const two=c.managementEdgeGeometry(nodes,edges,b.signal);
    a.abort();assert.equal(await one,'AbortError');assert.equal(worker.terminated,undefined);assert.equal(posts,1);
    worker.onmessage({data:{id:worker.input.id,geometry:{width:500,height:500,nodes:[{id:'n1',x:0,y:0,w:200,h:110}],views:[]}}});
    assert.equal((await two).nodes[0].row.id,'r1');
    results.checks.push({name:'graph_same_input_coalesces_and_survives_one_client_cancel',passed:true});
  }
  for(const result of results.checks)assert.equal(result.passed,true,JSON.stringify(result));
});

require('node:test').test('focus deduplicates identical gestures without hiding hydrated records',()=>{
  const source=fs.readFileSync(path.join(desk,'review_desk/static/production.js'),'utf8');
  let paints=0,comments=0;
  const c={URL,state:{workspace:'settings.workspace'},location:{href:'http://fixture/?workspace=settings.workspace'},document:{querySelectorAll:()=>[]},restoreProductionDraft(){},rememberProductionDraft(){},paintProductionReview(){paints++},renderComments(){comments++}};
  c.history={state:null,replaceState(_state,_title,url){c.location.href=String(url)}};
  vm.createContext(c);vm.runInContext(source,c);c.paintProductionReview=()=>paints++;c.renderComments=()=>comments++;
  const light={id:'requirement-exact',object_id:'material',kind:'REQUIREMENT',edit_token:1,payload:{title:'Light'}};
  const full={...light,payload:{title:'Full',generation:{prompt:'Exact body'}}};
  c.focusProductionReview({record:light});
  const first=[paints,comments];
  c.focusProductionReview({record:light});
  assert.deepEqual([paints,comments],first);
  c.focusProductionReview({record:full});
  assert.equal(c.state.productionSelected,full);
  assert.equal(c.state.productionDetail.record,full);
  assert.equal(paints,first[0]+1);
});
