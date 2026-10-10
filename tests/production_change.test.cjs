const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const test=require('node:test'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.join(__dirname,'../review_desk/static/production.js'),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value)),flush=()=>new Promise(resolve=>setImmediate(resolve));
class Node{
  constructor(tag,cls){Object.assign(this,{tag,className:cls||'',children:[],dataset:{},attrs:{},value:'',disabled:false,isConnected:true});this.classList={add(){},remove(){},toggle(){}}}
  append(...nodes){for(const n of nodes){n.parent=this;this.children.push(n)}}
  detach(){this.isConnected=false;this.children.forEach(n=>n.detach())}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this);this.detach()}
  replaceChildren(...nodes){this.children.forEach(n=>n.detach());this.children=[];this.append(...nodes)}
  replaceWith(n){const p=this.parent;assert.ok(p);const index=p.children.indexOf(this);this.detach();n.parent=p;p.children[index]=n}
  insertBefore(n,ref){n.parent=this;this.children.splice(this.children.indexOf(ref),0,n)}
  setAttribute(k,v){this.attrs[k]=v}
  all(){return this.children.flatMap(n=>[n,...n.all()])}
  querySelectorAll(selector){if(selector==='[data-decision-id]')return this.all().filter(n=>n.dataset.decisionId);assert.equal(selector,'.production-editor');return this.all().filter(n=>n.className.split(' ').includes('production-editor'))}
  get childElementCount(){return this.children.length}
}
const record=(object_id,kind,payload={})=>({object_id,id:object_id+'-r1',current_revision:object_id+'-r1',kind,version:1,payload:{title:object_id,...payload}});
const change={object_id:'upstream',used_revision:'upstream-r1',current_revision:'upstream-r2',target:{object_id:'exact-use',revision_id:'exact-use-r1'}};
const ready=(scope,count=1)=>({scope:record(scope,'EPISODE'),required_count:count,missing_count:count,inputs_ready:false,package_available:false,requirements:Array.from({length:count},(_,i)=>({requirement:record(scope+'-need-'+String(i+1).padStart(2,'0'),'REQUIREMENT',{purpose:'technical test',usage:'post_audio',required:true}),issues:['upstream_needs_review'],pending_changes:[plain(change)]}))});
function fixture(){
  const host=new Node('main'),episodes=[record('episode-A','EPISODE'),record('episode-B','EPISODE')],records=episodes.flatMap(e=>['a','b'].map(letter=>record(e.object_id+'-prep-'+letter,'AV_SCENE',{source:{object_id:e.object_id,revision_id:e.id,scene_id:'scene-'+letter}})));
  const messages=[],requests=[],reads=[],posts=[];
  const context={state:{workspace:'materials.workspace',screenplays:[{episodes}]},URL,URLSearchParams,location:{href:'http://fixture/?workspace=materials.workspace'},document:{querySelectorAll:()=>[],createElementNS:(namespace,tag)=>Object.assign(new Node(tag),{namespaceURI:namespace})},isProduction:()=>true,renderComments(){},toast:text=>messages.push(text),el:(tag,cls)=>new Node(tag,cls),nodeText:(tag,cls,text,parent)=>{const n=new Node(tag,cls);n.textContent=text;parent.append(n);return n},crypto:require('node:crypto').webcrypto};
  context.api=async(url,options)=>{
    if(options?.method==='POST')posts.push(JSON.parse(options.body));
    if(url==='/api/production')return {records};
    if(url.startsWith('/api/production?')){const id=new URL(url,'http://fixture').searchParams.get('object_id');return {record:records.find(r=>r.object_id===id),history:[],uses:[]}}
    return new Promise((resolve,reject)=>requests.push({url,options,resolve,reject}));
  };
  context.fetch=url=>new Promise((resolve,reject)=>reads.push({url,resolve,reject}));
  context.$=selector=>selector==='#production-view'?host:host.all().find(n=>n.id===selector.slice(1));
  context.history={replaceState(_state,_title,url){context.location.href=String(url)}};
  context.Option=function(text,value){const n=new Node('option');n.textContent=text;n.value=value;return n};
  vm.createContext(context);require('./load_review_helpers.cjs')(context);vm.runInContext(source,context);
  context.renderProductionReader=()=>{const root=context.$('#production-reader');root.replaceChildren();context.nodeText('p',null,context.state.productionSelected.object_id,root)};
  context.productionRefLink=()=>{};
  const byLabel=label=>host.all().find(n=>n.attrs['aria-label']===label),button=(label,root=host)=>root.all().find(n=>n.tag==='button'&&n.textContent===label),text=root=>root.all().map(n=>n.textContent||'').join('\n');
  const form=box=>({box,field:label=>box.all().find(n=>n.attrs['aria-label']===label),button:label=>button(label,box),notice:()=>box.all().find(n=>n.attrs.role==='status')});
  const open=(options={},parent=host)=>{context.showProductionChange(parent,plain(change),options);const f=form(parent.children.at(-1));f.field('变更处理').value='keep';f.field('复核者').value='Technical reviewer';f.field('复核依据').value='Keep the exact original reference';return f};
  return {context,host,episodes,records,messages,requests,reads,posts,byLabel,button,text,form,open};
}
const response=(status,data)=>({status,ok:status>=200&&status<300,json:async()=>data});
const saved=request=>({object_id:request.object_id,kind:'JUDGMENT',version:1,payload:plain(request.payload)});

function fill(f,box){const form=f.form(box);form.field('变更处理').value='keep';form.field('复核者').value='Technical reviewer';form.field('复核依据').value='Keep exact reference';return form}






test('download labels use the exact readiness scope, including kind-less screenplay snapshots',async()=>{
  for(const [kind,label] of [['EPISODE','本集'],['AV_SCENE','本场'],['AV_SHOT','逐镜'],['STATE','状态参考']]){
    const f=fixture(),subject=record('accurate-scope',kind);
    // screenplay.snapshot() emits episode payload/revision without a kind field.
    if(kind==='EPISODE'){delete subject.kind;subject.payload.format='screenplay-episode-v1'}
    f.context.state.productionSelected=subject;
    const rendering=f.context.renderProductionReadiness(f.host,subject);await flush();
    f.requests[0].resolve({...ready(subject.object_id),scope:record(subject.object_id,kind)});await rendering;
    assert.equal(f.requests[0].url,'/api/production/readiness?scope=accurate-scope');
    const buttons=f.host.all().filter(n=>n.tag==='button'&&n.textContent.startsWith('下载'));
    assert.equal(buttons.length,1);assert.equal(buttons[0].textContent,'下载'+label+(kind==='STATE'?'清单':'输入清单'));
  }
});

function materialJudgmentFixture(){
  const f=fixture();f.context.state.workspace='materials.workspace';f.context.location.href='http://fixture/?workspace=materials.workspace&production_object=asset-A';
  f.records.splice(0,f.records.length,record('asset-A','ASSET',{components:[]}),record('asset-B','ASSET',{components:[]}));
  f.context.productionEntityIcon=()=>new Node('svg');vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static/material-review.js'),'utf8'),f.context);return f;
}
function openMaterialJudgment(f){
  const root=f.context.$('#production-reader');f.context.document.querySelectorAll=selector=>selector==='[data-judgment-target]'?root.all().filter(n=>n.dataset.judgmentTarget):[];
  f.context.renderMaterialResultReview(root,f.context.state.productionSelected,{judgments:{current:[],history:[],conflicting:false}});
  const section=root.children.at(-1);f.context.showProductionJudgment(section);const form=f.form(section.children.at(-1));
  form.field('审阅结果').value='passed';form.field('审阅者').value='Technical reviewer';form.field('结论依据').value='Exact asset candidate';return form;
}

test('list load failure replaces its own loading message and keeps the error for the save caller',async()=>{
 const f=fixture(),failure=Error('list unavailable');f.context.api=async()=>{throw failure};
 await assert.rejects(f.context.loadProductionWorkspace(),error=>error===failure);
 assert.match(f.text(f.host),/制作记录读取失败：list unavailable/);assert.match(f.text(f.host),/左侧导航/);assert.doesNotMatch(f.text(f.host),/正在读取/);
});
test('a failed list load cannot replace newer loading, another detail read or another workspace',async()=>{
 for(const takeover of ['new-load','new-read','workspace','detached']){
  const f=fixture(),requests=[];f.context.api=()=>new Promise((resolve,reject)=>requests.push({resolve,reject}));
  const old=f.context.loadProductionWorkspace();let newer;
  if(takeover==='new-load')newer=f.context.loadProductionWorkspace();
  if(takeover==='new-read')newer=f.context.openProductionRecord('new-target');
  if(takeover==='workspace')f.context.state.workspace='story.sources';
  if(takeover==='detached')f.host.replaceChildren(new Node('p'));
  const before=f.text(f.host);requests[0].reject(Error('old list unavailable'));
  if(takeover==='detached')await assert.rejects(old,/old list unavailable/);else await old;
  assert.equal(f.text(f.host),before);
  if(newer){requests[1].reject(Error('new request unavailable'));await assert.rejects(newer,/new request unavailable/);if(takeover==='new-load')assert.match(f.text(f.host),/new request unavailable/)}
 }
});

const decisionRecord=(version=3,action='keep',id='existing-decision')=>({object_id:id,id:id+'-r'+version,kind:'JUDGMENT',version,payload:{format:'production-judgment-v1',title:'upstream · 变更复核',blocks:[{id:'decision',text:'Existing explicit reason'}],target:plain(change.target),verdict:'impact_resolved',actor:'Original recorded actor',reason:'Existing explicit reason',change:{old:{object_id:change.object_id,revision_id:change.used_revision},new:{object_id:change.object_id,revision_id:change.current_revision},action}}});
function judgmentRouteFixture(href='http://fixture/?workspace=materials.workspace'){
 const f=fixture(),c=f.context,old=decisionRecord(1,'keep'),latest=decisionRecord(2,'rework'),originalApi=c.api;
 const stack=[href],positions=[],reads=[],switches=[];let cursor=0;
 c.location.href=href;c.state.workspace=new URL(href).searchParams.get('workspace');
 c.history={replaceState(_s,_t,url){c.location.href=stack[cursor]=String(url)},pushState(_s,_t,url){stack.splice(++cursor);stack.push(String(url));c.location.href=String(url)}};
 c.rememberWorkspacePosition=()=>positions.push({url:c.location.href,scroll:c.$('#production-reader')?.scrollTop});
 c.rememberWorkspaceRoute=()=>{};
 c.productionTab=()=> 'records';c.productionTabs=()=>{};
 c.api=async(url,options)=>{
  reads.push(url);const params=new URL(url,'http://fixture').searchParams;
  if(url.startsWith('/api/production/index?'))return {records:[...f.records,...(params.get('object_id')===latest.object_id?[latest]:[])]};
  if(url.startsWith('/api/production?')&&params.get('object_id')===latest.object_id)return {record:params.get('revision_id')===old.id?old:latest,history:[latest,old],uses:[]};
  return originalApi(url,options);
 };
 c.switchWorkspace=(workspace,updateUrl)=>{switches.push({workspace,updateUrl});c.state.workspace=workspace;return c.loadProductionWorkspace()};
 const pop=async direction=>{cursor+=direction;c.location.href=stack[cursor];c.state.workspace=new URL(c.location.href).searchParams.get('workspace');await c.loadProductionWorkspace()};
 return {...f,old,latest,stack,positions,routeReads:reads,switches,pop};
}






function editDecision(f,record=decisionRecord()){
 f.context.showProductionChange(f.host,{...plain(change),decision:record});return f.form(f.host.children.at(-1));
}



