const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
class Node {
  constructor(){this.children=[];this.dataset={};this.scrollTop=0;this.scrollLeft=0;this.isConnected=true}
  append(...nodes){for(const n of nodes){n.parent=this;this.children.push(n)}}
  replaceChildren(...nodes){for(const n of this.children)n.isConnected=false;this.children=[];this.append(...nodes)}
  querySelector(){return null}
  querySelectorAll(){return []}
  setAttribute(){}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this);this.isConnected=false}
}
function fixture(){
  const host=new Node(),c={state:{workspace:'settings.workspace',comments:[]},URL,URLSearchParams,
    location:{href:'http://fixture/?workspace=settings.workspace&production_tab=breakdown'},
    document:{querySelector:()=>null,querySelectorAll:()=>[]},$:()=>host,el:()=>new Node(),
    nodeText:(_tag,_class,text,parent)=>{const n=new Node();n.text=text;parent.append(n);return n},
    rememberProductionDraft(){},renderEpisodeCard(){},renderAudiovisualEdition(){},renderComments(){}};
  c.history={state:null,replaceState(_s,_t,url){c.location.href=String(url)},pushState(_s,_t,url){c.location.href=String(url)}};
  vm.createContext(c);
  for(const file of ['production.js','production-breakdown.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static',file),'utf8'),c);
  c.breakdownHeading=()=>{};
  c.rememberProductionDraft=()=>{};c.breakdownSceneTitle=row=>row.object_id;
  c.loadEntityManagement=result=>{c.state.productionSelected=result.records[0];host.replaceChildren({text:'entity list'});return result};
  return {c,host};
}
const catalog=episode=>({episode,episodes:[],scenes:[],shots:[]});
const entity={object_id:'entity',id:'entity-exact',kind:'ENTITY'};
function choose(c,tab){c.invalidateProductionReads();c.location.href='http://fixture/?workspace=settings.workspace&production_tab='+tab}
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}}

for(const failure of [false,true])test(`departed directory ${failure?'failure':'success'} cannot replace the entity page or its exact review target`,async()=>{
  const {c,host}=fixture(),old=deferred();
  c.api=url=>url.includes('/breakdown?')?old.promise:Promise.resolve({records:[entity],entity_state_counts:{}});
  const pending=c.loadProductionBreakdown();choose(c,'entities');await c.loadProductionWorkspace();
  c.state.anchor={quote:'entity draft'};const before=c.location.href,body=host.children;
  if(failure)old.reject(Error('old directory failure'));else old.resolve(catalog('old'));
  await pending;
  assert.equal(c.location.href,before);assert.deepEqual(host.children,body);assert.equal(c.state.productionSelected,entity);
  assert.equal(c.state.anchor.quote,'entity draft');assert.equal(c.state.breakdownCatalog,undefined);
});

for(const failure of [false,true])test(`departed scene ${failure?'failure':'success'} cannot commit or restore a review after A to B to A`,async()=>{
  const {c}=fixture(),old=deferred(),scene={object_id:'scene-old',id:'old-exact',payload:{}};
  c.state.breakdownData={shots:[]};c.api=()=>old.promise;let writes=0,commits=0;
  const pending=c.showBreakdownScene(scene,{replaceChildren(){writes++}},null,0,null,null,()=>commits++);
  choose(c,'entities');choose(c,'breakdown');c.state.productionSelected=entity;
  if(failure)old.reject(Error('old scene failure'));else old.resolve({scene,shots:[]});
  if(failure)await assert.rejects(pending,/old scene failure/);else await pending;
  assert.equal(writes,0);assert.equal(commits,0);assert.equal(c.state.productionSelected,entity);
  assert.equal(new URL(c.location.href).searchParams.get('breakdown_object'),null);
});

test('A to B to A rejects an older directory even after the new A directory commits',async()=>{
  const {c,host}=fixture(),old=deferred();let count=0;
  c.api=()=>++count===1?old.promise:Promise.resolve(catalog('new-A'));
  const pending=c.loadProductionBreakdown();choose(c,'entities');choose(c,'breakdown');
  await c.loadProductionBreakdown();const body=host.children;
  old.resolve(catalog('old-A'));await pending;
  assert.equal(c.state.breakdownData.episode,'new-A');assert.deepEqual(host.children,body);
});

test('current directory failure remains visible and a new navigation can recover',async()=>{
  const {c,host}=fixture();c.api=async()=>{throw Error('current failure')};
  await assert.rejects(c.loadProductionBreakdown(),/current failure/);
  assert.match(host.children[0].text,/current failure/);
  c.api=async()=>catalog('recovered');await c.loadProductionBreakdown();
  assert.equal(c.state.breakdownData.episode,'recovered');assert.doesNotMatch(host.children.map(n=>n.text).join(''),/current failure/);
});

test('a current scene still commits its exact route and review context',async()=>{
  const {c}=fixture(),scene={object_id:'scene-current',id:'scene-exact',payload:{}};
  c.state.breakdownData={episode:'episode',shots:[]};c.state.productionRecords=[];
  c.api=async()=>({scene,shots:[]});c.renderAudiovisualSources=c.renderAudiovisualDesign=c.renderProductionAcceptance=()=>{};
  c.activateBreakdownScene=data=>{c.state.productionSelected=data.scene};let commits=0;
  await c.showBreakdownScene(scene,new Node(),null,0,null,null,()=>commits++);
  assert.equal(commits,1);assert.equal(c.state.productionSelected,scene);
  assert.equal(new URL(c.location.href).searchParams.get('breakdown_scene'),scene.object_id);
});

test('late entity failure cannot replace a newer entity directory',async()=>{
  const {c,host}=fixture(),old=deferred();choose(c,'entities');let count=0;
  c.api=()=>++count===1?old.promise:Promise.resolve({records:[entity],entity_state_counts:{}});
  const pending=c.loadProductionWorkspace();choose(c,'breakdown');choose(c,'entities');await c.loadProductionWorkspace();
  const body=host.children;old.reject(Error('old entity failure'));await pending;
  assert.deepEqual(host.children,body);assert.equal(c.state.productionSelected,entity);
});

test('a completed workspace load cannot restore position after a newer scene load',async()=>{
  for(const superseded of [false,true]){
    const {c}=fixture(),pending=deferred();let restored=0;
    c.state.framework={workspaces:[{id:'settings.workspace'}]};c.window={scrollTo(){}};
    c.isProduction=()=>true;c.isScript=()=>false;
    for(const name of ['rememberStoryDraft','hideSelectionAction','renderWorkspaceNav','closePanel'])c[name]=()=>{};
    c.restoreWorkspacePosition=()=>restored++;
    c.loadProductionWorkspace=()=>{c.invalidateProductionReads();return pending.promise};
    const app=fs.readFileSync(path.join(__dirname,'../review_desk/static/app.js'),'utf8'),start=app.indexOf('function switchWorkspace(');
    vm.runInContext('let workspaceReadEpoch=0;let storyDataReady=true;\n'+app.slice(start,app.indexOf('\nfunction ',start+1)),c);
    c.switchWorkspace('settings.workspace',false);
    if(superseded)c.invalidateProductionReads();
    pending.resolve();await pending.promise;await new Promise(resolve=>setImmediate(resolve));
    assert.equal(restored,superseded?0:1);
  }
});
