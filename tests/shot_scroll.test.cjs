const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../review_desk/static/production-breakdown.js'),'utf8');
const code=source.slice(source.indexOf('function scrollBreakdownTarget('),source.indexOf('function breakdownSelectionKey('));
test('nested pane navigation uses the actual changed sticky height and outer scroller',()=>{
  let height=104;
  const outer={scrollTop:153,scrollHeight:2000,clientHeight:900,parentElement:null,css:{overflowY:'auto'}};
  const view={parentElement:outer,getBoundingClientRect:()=>({top:223-outer.scrollTop})};
  const header={css:{position:'sticky'},getBoundingClientRect:()=>({height})};
  const body={scrollTop:500,clientTop:1,css:{overflowY:'auto'},querySelector:()=>header,closest:()=>view,getBoundingClientRect:()=>({top:193})};
  const target={getBoundingClientRect:()=>({top:1500-body.scrollTop})};
  const context={getComputedStyle:e=>e.css,document:{querySelector:()=>({getBoundingClientRect:()=>({bottom:70})})},window:{scrollY:0,scrollX:0,scrollTo(){throw Error('desktop has an outer element scroller')}}};
  vm.createContext(context);vm.runInContext(code,context);
  context.scrollBreakdownTarget(body,target);
  assert.equal(target.getBoundingClientRect().top,193+1+height);
  height=168;context.scrollBreakdownTarget(body,target);
  assert.equal(target.getBoundingClientRect().top,193+1+height);
  context.scrollBreakdownTarget(body,header);assert.equal(body.scrollTop,0);
});
test('page-scrolling narrow layout measures the visible topbar instead of desktop header',()=>{
  const win={scrollY:500,scrollX:0,scrollTo(x,y){this.scrollY=y}};
  const header={css:{position:'static'},getBoundingClientRect:()=>({height:220})};
  const topbar={css:{position:'sticky'},getBoundingClientRect:()=>({bottom:138})};
  const body={css:{overflowY:'visible'},querySelector:()=>header};
  const target={getBoundingClientRect:()=>({top:1200-win.scrollY})};
  const context={window:win,document:{querySelector:()=>topbar},getComputedStyle:e=>e.css};
  vm.createContext(context);vm.runInContext(code,context);context.scrollBreakdownTarget(body,target);
  assert.equal(target.getBoundingClientRect().top,138);
});

test('shot selection address restores its group, material, candidate and component after refresh',()=>{
  const shared=fs.readFileSync(require('node:path').join(__dirname,'../review_desk/static/unified-cards.js'),'utf8');
  const route=shared.slice(shared.indexOf('function writeShotWorkspaceRoute('),shared.indexOf('function renderShotEntityWorkspace('));
  const render=source.slice(source.indexOf('function renderBreakdownShot('),source.indexOf('function renderThreePartShot('));
  const context={URL,location:{href:'http://local/?breakdown_object=shot'},state:{},renderShotEntityWorkspace:(_root,data)=>data,breakdownRoute:values=>{
    const u=new URL(context.location.href);for(const [key,value] of Object.entries(values))value==null?u.searchParams.delete(key):u.searchParams.set(key,value);context.location.href=String(u);
  }};
  vm.createContext(context);vm.runInContext(route+render,context);
  const workspace=()=>({entity:{object_id:'shot'},material_groups:[{key:'video',material_ids:['video-a','video-b']}],material_versions:{'video-b':[{results:[{id:'candidate-2',payload:{components:[{id:'preview'}]}}]}]}});
  const selected={...workspace(),shotTab:'video',unifiedMaterialId:'video-b',shotSelections:{video:'video-b'},selectedCandidates:{'video-b':'candidate-2'},selectedComponents:{'candidate-2':'preview'}};
  context.writeShotWorkspaceRoute(selected);
  const restored=context.renderBreakdownShot(null,{record:{object_id:'shot',id:'shot-r1',version:1},entity_workspace:workspace()});
  assert.equal(restored.shotTab,'video');assert.equal(restored.unifiedMaterialId,'video-b');
  assert.equal(restored.selectedCandidates['video-b'],'candidate-2');assert.equal(restored.selectedComponents['candidate-2'],'preview');
  context.location.href=context.location.href.replace('shot_component=preview','shot_component=missing');
  assert.throws(()=>context.renderBreakdownShot(null,{record:{object_id:'shot',id:'shot-r1',version:1},entity_workspace:workspace()}),/准确镜头文件组成不存在/);
  context.location.href=context.location.href.replace('shot_component=missing','shot_component=preview');
  context.location.href=context.location.href.replace('candidate-2','missing');
  assert.throws(()=>context.renderBreakdownShot(null,{record:{object_id:'shot',id:'shot-r1',version:1},entity_workspace:workspace()}),/准确镜头候选不存在/);
});
