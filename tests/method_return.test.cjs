const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.join(__dirname,'../review_desk/static');
function fixture(href='http://fixture/?workspace=materials.workspace&production_tab=materials&production_scope_episode=late&production_scope_revision=exact&production_scope_scene=last&material_search=M1194&material_page=2',saved=null,publication='one'){
 const location={href,get origin(){return new URL(this.href).origin}},frames=[],events={},offset={scrollTop:210,scrollLeft:0};
 const c={URL,location,REVIEW_DEPLOYMENT:{base_path:'',publication_id:publication},state:{workspace:new URL(href).searchParams.get('workspace')},document:{querySelector:s=>s==='#production-reader'?offset:null,addEventListener(){}},window:{scrollX:0,scrollY:130,addEventListener:(k,f)=>events[k]=f,scrollTo(x,y){this.scrollX=x;this.scrollY=y}},requestAnimationFrame:f=>frames.push(f),sessionStorage:{getItem:()=>null,setItem(){}},history:{state:saved,replaceState(s,t,u){this.state=s;location.href=String(u)},pushState(s,t,u){this.state=s;location.href=String(u)}},productionTab:()=>new URL(location.href).searchParams.get('production_tab'),switchWorkspace(id){c.state.workspace=id},reviewURL:x=>x};
 vm.createContext(c);vm.runInContext(fs.readFileSync(path.join(root,'navigation.js'),'utf8'),c);c.restoreWorkspaceNavigation();
 return {c,location,events,offset,flush(){while(frames.length)frames.shift()()}};
}
test('method hops and a reloaded history entry restore the exact list and its reading offsets',()=>{
 const f=fixture(),original=f.location.href;f.c.rememberWorkspacePosition();f.c.rememberWorkspaceRoute();
 for(const tab of ['filmcraft','video-handbook','filmcraft'])f.c.navigateApproachLink(new URL('http://fixture/?workspace=production.approach&tab='+tab+'#chapter'));
 const saved=JSON.parse(JSON.stringify(f.c.history.state)),reloaded=fixture(f.location.href,saved);
 reloaded.c.navigateWorkspace('settings.workspace');assert.equal(reloaded.location.href,original);assert.equal(reloaded.c.state.workspace,'materials.workspace');reloaded.c.restoreWorkspacePosition();reloaded.flush();assert.equal(reloaded.offset.scrollTop,210);assert.equal(reloaded.c.window.scrollY,130);
});
test('a clean link in another tab and a different publication have no inherited production route',()=>{
 const f=fixture();f.c.rememberWorkspaceRoute();f.c.navigateApproachLink(new URL('http://fixture/?workspace=production.approach&tab=filmcraft'));
 for(const clean of [fixture(f.location.href),fixture(f.location.href,f.c.history.state,'two')]){
  clean.c.navigateWorkspace('settings.workspace');assert.equal(new URL(clean.location.href).searchParams.get('material_search'),null);assert.equal(new URL(clean.location.href).searchParams.get('production_tab'),'breakdown');
 }
});
test('history visits and newer explicit choices use their own return snapshot',()=>{
 const f=fixture(),old=f.location.href;f.c.rememberWorkspaceRoute();f.c.navigateApproachLink(new URL('http://fixture/?workspace=production.approach&tab=filmcraft'));const older=JSON.parse(JSON.stringify(f.c.history.state));
 f.c.navigateWorkspace('settings.workspace');f.location.href=old.replace('M1194','M2673').replace('exact','new-exact');f.c.rememberWorkspaceRoute();f.c.navigateApproachLink(new URL('http://fixture/?workspace=production.approach&tab=video-handbook'));const newer=f.c.history.state;
 f.location.href='http://fixture/?workspace=production.approach&tab=filmcraft';f.c.state.workspace='production.approach';f.c.history.state=older;f.c.restoreWorkspaceNavigation();f.c.navigateWorkspace('settings.workspace');assert.equal(f.location.href,old);
 f.location.href='http://fixture/?workspace=production.approach&tab=video-handbook';f.c.state.workspace='production.approach';f.c.history.state=newer;f.c.restoreWorkspaceNavigation();f.c.navigateWorkspace('settings.workspace');assert.match(f.location.href,/M2673/);assert.match(f.location.href,/new-exact/);
});
test('restoration preserves unrelated history state and rejects foreign deployment paths',()=>{
 const f=fixture();f.c.history.state={sourceReading:{block:'retained'}};f.c.rememberWorkspaceRoute();assert.equal(f.c.history.state.sourceReading.block,'retained');
 f.c.history.state.workspaceNavigation.routes=[['settings.workspace','http://other/?workspace=materials.workspace'],['story.sources','http://fixture/other/?workspace=story.sources']];f.c.history.state.workspaceNavigation.subRoutes=[];f.location.href='http://fixture/?workspace=production.approach';f.c.state.workspace='production.approach';f.c.restoreWorkspaceNavigation();f.c.navigateWorkspace('settings.workspace');assert.equal(new URL(f.location.href).searchParams.get('production_tab'),'breakdown');
});
test('only ordinary method-link clicks are handled; exact work, external, download and modified clicks stay native',()=>{
 const f=fixture('http://fixture/?workspace=production.approach&tab=filmcraft');vm.runInContext(fs.readFileSync(path.join(root,'approach.js'),'utf8'),f.c);
 let navigations=0;f.c.navigateApproachLink=()=>navigations++;
 for(const [href,options,handled] of [
  ['http://fixture/?workspace=production.approach&tab=video-handbook',{},true],
  ['http://fixture/?workspace=production.approach&tab=filmcraft#section',{},true],
  ['http://fixture/?workspace=story.script&script=v4&episode=e1',{},false],
  ['https://source.example/paper',{},false],
  ['http://fixture/other/?workspace=production.approach',{},false],
  ['http://fixture/?workspace=production.approach',{metaKey:true},false],
  ['http://fixture/?workspace=production.approach',{ctrlKey:true},false],
  ['http://fixture/?workspace=production.approach',{button:1},false],
  ['http://fixture/?workspace=production.approach',{target:'_blank'},false],
  ['http://fixture/?workspace=production.approach',{download:true},false]]){
  let click,prevented=false;const link={href,target:options.target||'',hasAttribute:()=>!!options.download,addEventListener:(k,fn)=>click=fn};f.c.bindApproachNavigation(link);const before=navigations;click({button:0,...options,preventDefault(){prevented=true}});assert.equal(prevented,handled);assert.equal(navigations-before,handled?1:0);
 }
});
test('an instance change on the same origin rejects a prior project return snapshot',()=>{
 const f=fixture();f.c.state.navigationInstanceId='project-one';f.c.rememberWorkspaceRoute();f.c.navigateApproachLink(new URL('http://fixture/?workspace=production.approach&tab=filmcraft'));
 f.c.state.navigationInstanceId='project-two';f.c.restoreWorkspaceNavigation();f.c.navigateWorkspace('settings.workspace');assert.equal(new URL(f.location.href).searchParams.get('material_search'),null);
});
test('management reload takes pagination from the requested URL rather than the mounted list',()=>{
 const f=fixture();vm.runInContext(fs.readFileSync(path.join(root,'management-cards.js'),'utf8'),f.c);
 let memory=f.c.managementMemory('materials',new URLSearchParams('material_page=8&material_rows=20'),'material_');memory.page=3;memory.rows=50;
 memory=f.c.managementMemory('materials',new URLSearchParams('material_page=2&material_rows=5'),'material_');assert.equal(memory.page,2);assert.equal(memory.rows,5);
});
test('navigation definitions load before the application state in the real bundle order',()=>{
 const c=vm.createContext({URL,location:{href:'http://fixture/'},history:{state:null}});
 assert.doesNotThrow(()=>vm.runInContext(fs.readFileSync(path.join(root,'navigation.js'),'utf8')+'\nconst state={navigationInstanceId:"project"};',c));
 assert.match(c.workspaceNavigationScope(),/project$/);
});
