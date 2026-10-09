const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const staticRoot=path.join(__dirname,'../review_desk/static');
class Node{
 constructor(tag='div'){this.tag=tag;this.children=[];this.attrs={};this.scrollLeft=0;this.scrollTop=0;this.dataset={};this.className=''}
 append(node){node.parent=this;this.children.push(node)}
 replaceChildren(){this.children=[]}
 setAttribute(key,value){this.attrs[key]=String(value)}
 contains(node){return node===this||this.children.some(child=>child.contains(node))}
 focus(){this.document.activeElement=this}
 scrollIntoView(){this.scrolled=true}
}
function fixture(workspace='story.sources',query=''){
 const root=new Node('nav'),positions=new Node(),requests=[],storage=new Map(),windowEvents={};root.id='workspace-subnav';
 const document={activeElement:null,querySelector:s=>s==='#workspace-subnav'?root:s==='#screenplay-reader'?positions:null,getElementById:id=>root.children.find(n=>n.id===id),addEventListener(){}};
 const location={href:'http://fixture/?workspace='+workspace+query};const context={URL,URLSearchParams,location,document,state:{workspace},requestAnimationFrame:cb=>cb(),sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},window:{scrollX:0,scrollY:0,addEventListener:(name,fn)=>windowEvents[name]=fn,scrollTo(x,y){this.scrollX=x;this.scrollY=y}},history:{replaceState(_state,_title,url){location.href=String(url)},pushState(_state,_title,url){requests.push(String(url));location.href=String(url)}},nodeText:(tag,cls,text,parent)=>{const n=new Node(tag);n.className=cls;n.textContent=text;n.document=document;parent.append(n);return n},renderConfigurations(){context.showConfigurationSection()},showConfigurationSection(){context.shown=context.state.configSection},selectApproachTab(tab){const u=new URL(location.href);u.searchParams.set('tab',tab);context.history.pushState(null,'',u);context.renderWorkspaceTabs()},switchWorkspace(id,update=true){context.rememberWorkspaceRoute();context.state.workspace=id;if(update){const u=new URL(location.href);u.searchParams.set('workspace',id);context.history.pushState(null,'',u)}context.renderWorkspaceTabs()}};
 vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(staticRoot,'navigation.js'),'utf8'),context);vm.runInContext(fs.readFileSync(path.join(staticRoot,'production-breakdown.js'),'utf8').split('function productionTabs')[0],context);
 context.renderWorkspaceTabs();return {context,root,requests,location,positions,storage,document,windowEvents};
}
test('four main pages use one subtab container with one selected and keyboard-focusable tab',()=>{
 for(const [workspace,titles] of [['production.approach',['故事创作','生产制作']],['story.sources',['故事采编','故事结构','故事剧本']],['settings.workspace',['视听制作','实体管理','素材管理']],['production.workspace',['视听制作','实体管理','素材管理']],['project.configuration',['故事项目','系统与 AI','工作方法','编号前缀']]]){
  const f=fixture(workspace);assert.deepEqual(f.root.children.map(n=>n.textContent),titles);assert.equal(f.root.children.filter(n=>n.attrs['aria-selected']==='true').length,1);assert.equal(f.root.children.filter(n=>n.tabIndex===0).length,1);assert.ok(f.root.children.every(n=>n.attrs.role==='tab'&&n.attrs['aria-controls']));
 }
 const html=fs.readFileSync(path.join(staticRoot,'index.html'),'utf8');assert.match(html,/<header class="workspace-topbar">.*id="workspace-subnav"/);assert.doesNotMatch(html,/class="(?:story-mode-tabs|approach-tabs)"/);
});
test('arrow and Home/End activate exact subtabs and preserve keyboard focus after rendering',()=>{
 const f=fixture('story.sources'),press=(index,key)=>f.root.children[index].onkeydown({key,preventDefault(){}});press(0,'ArrowRight');assert.equal(f.context.state.workspace,'story.outline');assert.equal(f.document.activeElement.id,'open-story-structure');press(1,'End');assert.equal(f.context.state.workspace,'story.script');press(2,'Home');assert.equal(f.context.state.workspace,'story.sources');const before=f.requests.length;f.root.children[0].onclick();assert.equal(f.requests.length,before);
});
test('instance method tabs share navigation and preserve legacy routes',()=>{
 const f=fixture('production.approach','&tab=another-method');
 f.context.approachTabs=()=>[{id:'story',label:'故事创作'},{id:'materials',label:'生产制作'},{id:'another-method',label:'实例方法'}];
 f.context.renderWorkspaceTabs();
 assert.deepEqual(f.root.children.map(n=>n.textContent),['故事创作','生产制作','实例方法']);
 assert.equal(f.root.children[2].attrs['aria-selected'],'true');
 f.root.children[2].onkeydown({key:'Home',preventDefault(){}});
 assert.equal(new URL(f.location.href).searchParams.get('tab'),'story');
 f.root.children[1].onclick();assert.equal(new URL(f.location.href).searchParams.get('tab'),'materials');
 f.location.href='http://fixture/?workspace=production.approach&tab=missing';f.context.renderWorkspaceTabs();
 assert.equal(f.root.children[0].attrs['aria-selected'],'true');
});
test('production navigation creates one accurate route and removes old record selection',()=>{
 const f=fixture('materials.workspace','&production_tab=materials&production_object=old&material_target=old-candidate&breakdown_episode=ep-A');f.root.children[1].onclick();const u=new URL(f.location.href);assert.equal(f.requests.length,1);assert.equal(u.searchParams.get('workspace'),'settings.workspace');assert.equal(u.searchParams.get('production_tab'),'entities');assert.equal(u.searchParams.get('production_object'),null);assert.equal(u.searchParams.get('material_target'),null);assert.equal(u.searchParams.get('breakdown_episode'),'ep-A');assert.equal(f.root.children[1].attrs['aria-selected'],'true');
});

test('old shot URLs preserve immutable location and selected input when entering the merged page',()=>{
 const suffix='&production_tab=shots&breakdown_episode=e02&breakdown_scene=s03&breakdown_object=shot17&breakdown_revision=exact&shot_material_id=video&shot_plan=2&shot_candidate=old-candidate&material_baseline=frozen';
 const f=fixture('production.workspace',suffix),before=new URL(f.location.href);
 assert.equal(f.context.normalizeProductionWorkspace('production.workspace'),'settings.workspace');
 const after=new URL(f.location.href);assert.equal(after.searchParams.get('production_tab'),'breakdown');
 for(const [key,value] of before.searchParams)if(!['workspace','production_tab'].includes(key))assert.equal(after.searchParams.get(key),value);
 const other=fixture('story.script','&production_tab=shots');assert.equal(other.context.normalizeProductionWorkspace('story.script'),'story.script');
 const retired=fixture('production.workspace','&production_tab=history&production_object=deleted&production_revision=gone');retired.context.normalizeProductionWorkspace('production.workspace');
 assert.equal(new URL(retired.location.href).searchParams.get('production_tab'),'history');assert.equal(retired.context.productionTab(),'retired');
});
test('configuration URL selects exact subsection on refresh and back/forward',()=>{
 const f=fixture('project.configuration','&config_section=SYSTEM');assert.equal(f.root.children[1].attrs['aria-selected'],'true');f.root.children[0].onclick();assert.equal(f.context.shown,'PROJECT');assert.equal(new URL(f.location.href).searchParams.get('config_section'),'PROJECT');f.location.href='http://fixture/?workspace=project.configuration&config_section=SYSTEM';f.context.renderWorkspaceTabs();assert.equal(f.root.children[1].attrs['aria-selected'],'true');
});
test('main navigation restores the last exact URL of another main page',()=>{
 const f=fixture('materials.workspace','&production_tab=materials&material_id=need&material_version=2&material_target=candidate');const exact=f.location.href;f.context.navigateWorkspace('production.workspace');f.context.navigateWorkspace('settings.workspace');assert.equal(f.location.href,exact);assert.equal(f.context.state.workspace,'materials.workspace');
});
test('reading offsets restore by exact URL and refresh and never overwrite a different URL',()=>{
 const f=fixture('story.script','&scene=s003');f.positions.scrollTop=231;f.context.window.scrollY=120;f.context.rememberWorkspacePosition();f.positions.scrollTop=0;f.context.window.scrollY=0;f.context.restoreWorkspacePosition();assert.equal(f.positions.scrollTop,231);assert.equal(f.context.window.scrollY,120);f.location.href+='&scene=s004';f.positions.scrollTop=7;f.context.restoreWorkspacePosition();assert.equal(f.positions.scrollTop,7);
});
test('E/S/SH labels retain existing numbers, preserve unknown IDs, and leave source strings unchanged',()=>{
 const f=fixture(),c=f.context;assert.equal(c.reviewPositionLabel('episode',2),'E02');assert.equal(c.reviewPositionLabel('scene','s003'),'S003');assert.equal(c.reviewPositionLabel('shot','SH004'),'SH004');assert.equal(c.reviewPositionLabel('scene',1234),'S1234');assert.equal(c.reviewPositionLabel('scene','custom-scene'),'custom-scene');const source='第 2 集 · 第3场 · 第4镜 · E2 / s3 / sh4';assert.equal(c.reviewPositionText(source),'E02 · S003 · SH004 · E02 / S003 / SH004');assert.equal(source,'第 2 集 · 第3场 · 第4镜 · E2 / s3 / sh4');
});

test('returning to a production subpage restores its precise version/candidate and active clicks do not reload',()=>{
 const f=fixture('materials.workspace','&production_tab=materials&material_id=need&material_version=2&material_target=exact');const original=f.location.href;f.root.children[1].onclick();f.root.children[2].onclick();assert.equal(f.location.href,original);let called=0;const previous=f.context.switchWorkspace;f.context.switchWorkspace=(...args)=>{called++;previous(...args)};f.context.navigateWorkspace('settings.workspace');assert.equal(called,0);
});

test('legacy episode-shot titles use both exact numbers while ambiguous chapter-local headings remain unchanged',()=>{
 const c=fixture().context;assert.equal(c.reviewPositionText('E1-004 河街唱曲开场'),'E01 / SH004 河街唱曲开场');assert.equal(c.reviewPositionText('01-01 米铺门口'),'01-01 米铺门口');
});
test('episode and scene filter labels use authoritative numbers without altering the API catalog',()=>{
 const c={};vm.createContext(c);require('./load_review_helpers.cjs')(c);vm.runInContext(fs.readFileSync(path.join(staticRoot,'production-breakdown.js'),'utf8'),c);
 const catalog={episodes:[{object_id:'episode',number:17,title:'第17集 回家',scenes:[{id:'s042',title:'17-01 米铺门口'}]}]},before=JSON.stringify(catalog);
 assert.equal(c.breakdownFacetTitle('episode','episode',catalog),'E17 · 回家');assert.equal(c.breakdownFacetTitle('scene','s042',catalog),'S042 · 米铺门口');assert.equal(c.breakdownFacetTitle('scene','unknown-scene',catalog),'unknown-scene');assert.equal(JSON.stringify(catalog),before);
 assert.equal(c.reviewPositionText('图片1 · E1-004 河街唱曲开场'),'图片1 · E01 / SH004 河街唱曲开场');
});
