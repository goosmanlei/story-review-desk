const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../review_desk/static/editing.js'),'utf8');
const key='episode-edit:/:episode',plain=value=>JSON.parse(JSON.stringify(value));
const project=version=>({id:'revision-'+version,version,payload:{episode:{object_id:'episode'},text:'server '+version}});
// Each boot is a new page realm, sharing only persisted storage. Run the real
// catalog initialization, mutation, recovery and persistence; layout is separate.
async function boot(storage,current){
  const host={querySelector:()=>null,replaceChildren(){}},messages=[];
  const c={URL,location:{href:'http://fixture/?edit_episode=episode',pathname:'/'},
    state:{workspace:'settings.workspace'},productionReadEpoch:0,productionTab:()=> 'editing',
    renderComments(){},productionTabs(){},nodeText(){},$:()=>host,toast:message=>messages.push(message),
    api:async()=>({episodes:[{id:'episode'}],projects:[plain(current)],outputs:[],jobs:[]}),
    localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)}};
  c.history={replaceState:(_a,_b,url)=>{c.location.href=String(url)}};
  vm.createContext(c);vm.runInContext(source,c);
  vm.runInContext('renderEpisodeEditing=ctx=>editRemember(ctx);globalThis.contexts=episodeEditing.contexts;',c);
  await c.loadEpisodeEditing();assert.deepEqual(messages,[]);
  return {c,ctx:c.contexts.get('episode')};
}
test('legacy unsaved draft survives two complete reloads and repeated renders',async()=>{
  const storage=new Map([[key,JSON.stringify({basis:'revision-1',draft:{text:'my unsaved draft'}})]]);
  let f=await boot(storage,project(2));assert.equal(f.ctx.draft.text,'server 2');
  for(let i=0;i<5;i++)f.c.renderEpisodeEditing(f.ctx);
  f=await boot(storage,project(2));f=await boot(storage,project(2));
  assert.equal(f.ctx.recoveries.length,1);assert.equal(f.ctx.recoveries[0].draft.text,'my unsaved draft');
  f.c.editRestoreDraft(f.ctx,f.ctx.recoveries[0]);f=await boot(storage,project(2));
  assert.equal(f.ctx.draft.text,'my unsaved draft');assert.equal(f.ctx.recoveries.length,0);
  assert.equal(JSON.parse(storage.get(key)).basis,'revision-2');
});
test('successive server revisions preserve both independently edited drafts',async()=>{
  const storage=new Map();let f=await boot(storage,project(1));
  f.c.editMutation(f.ctx,p=>{p.text='first draft'});
  f=await boot(storage,project(2));f.c.editMutation(f.ctx,p=>{p.text='second draft'});
  f=await boot(storage,project(3));f=await boot(storage,project(4));
  assert.deepEqual(plain(f.ctx.recoveries.map(r=>[r.basis,r.draft.text])),[['revision-1','first draft'],['revision-2','second draft']]);
  for(const saved of f.ctx.recoveries)assert.deepEqual(Object.keys(saved).sort(),['basis','draft','version']);
  f.c.editRestoreDraft(f.ctx,f.ctx.recoveries[0]);f=await boot(storage,project(4));
  assert.equal(f.ctx.draft.text,'first draft');assert.equal(f.ctx.recoveries[0].draft.text,'second draft');
});
test('restoring an older draft also preserves the currently edited draft across refresh',async()=>{
  const storage=new Map();let f=await boot(storage,project(1));
  f.c.editMutation(f.ctx,p=>{p.text='older work'});f=await boot(storage,project(2));
  f.c.editMutation(f.ctx,p=>{p.text='newer work'});f.c.editRestoreDraft(f.ctx,f.ctx.recoveries[0]);
  f=await boot(storage,project(2));assert.equal(f.ctx.draft.text,'older work');
  assert.equal(f.ctx.recoveries[0].draft.text,'newer work');
  f.c.editRestoreDraft(f.ctx,f.ctx.recoveries[0]);f=await boot(storage,project(2));
  assert.equal(f.ctx.draft.text,'newer work');assert.equal(f.ctx.recoveries[0].draft.text,'older work');
});
test('unchanged server snapshots do not accumulate pending drafts',async()=>{
  const storage=new Map();let f;
  for(let version=1;version<=8;version++)f=await boot(storage,project(version));
  assert.equal(f.ctx.recoveries.length,0);assert.equal(f.ctx.draft.text,'server 8');
});
for(const redo of [false,true])test('undoing draft recovery preserves both drafts after reload'+(redo?' and redo':''),async()=>{
  const storage=new Map();let f=await boot(storage,project(1));
  f.c.editMutation(f.ctx,p=>{p.text='older work'});f=await boot(storage,project(2));
  f.c.editMutation(f.ctx,p=>{p.text='newer work'});
  f.c.editRestoreDraft(f.ctx,f.ctx.recoveries[0]);f.c.editHistory(f.ctx,'undo','redo');
  if(redo)f.c.editHistory(f.ctx,'redo','undo');
  f=await boot(storage,project(2));assert.equal(f.ctx.draft.text,redo?'older work':'newer work');
  assert.equal(f.ctx.recoveries.length,1);assert.equal(f.ctx.recoveries[0].draft.text,redo?'newer work':'older work');
});
test('storage failure retains the earlier persisted recovery and warns without losing in-page work',async()=>{
  const storage=new Map();let f=await boot(storage,project(1));
  f.c.editMutation(f.ctx,p=>{p.text='older work'});f=await boot(storage,project(2));
  const before=storage.get(key),messages=[];
  f.c.localStorage.setItem=()=>{throw Error('quota')};f.c.toast=value=>messages.push(value);
  f.c.editMutation(f.ctx,p=>{p.text='current work'});
  assert.equal(storage.get(key),before);assert.equal(f.ctx.draft.text,'current work');
  assert.match(messages[0],/本机草稿保存失败/);
});
