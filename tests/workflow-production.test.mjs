import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
// Exercise installed components and their real workflow contract.
const site=new URL('../',import.meta.url);
const sourceRoot=new URL('app/',site);
const require=createRequire(new URL('package.json',site)),ts=require('typescript');
const creatorWorkflow=await import(new URL('host/instance-runtime/creator-production-workflow.mjs',site));
const settle=async()=>{await new Promise(setImmediate);await new Promise(setImmediate);};
function load(name){
 const state=[],refs=[],effects=[],pending=[],requests=[],listeners=new Map(),timers=new Set(),writes=[];let si=0,ri=0,ei=0;
 const jsx=(type,props)=>({type,props});
 const react={useState(initial){const i=si++;if(!(i in state))state[i]=typeof initial==='function'?initial():initial;return [state[i],v=>{state[i]=typeof v==='function'?v(state[i]):v;}];},useRef(initial){const i=ri++;return refs[i]||(refs[i]={current:initial});},useEffect(fn,deps){const i=ei++,old=effects[i];if(!old||!deps||deps.some((d,j)=>d!==old.deps[j])){old?.cleanup?.();effects[i]={deps,fn};pending.push(i);}},useMemo(fn){return fn();}};
 const module={exports:{}},location=new URL('http://fixture.invalid/?view=pipeline'),history={state:{},pushState(value,_title,url){this.state=value;location.href=new URL(url,location.href).href;},replaceState(value,title,url){this.pushState(value,title,url);}};
 const context={module,exports:module.exports,AbortController,Response,Error,URL,URLSearchParams,Date,console,structuredClone,confirm:()=>true,fetch(url,options){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});requests.push({url,resolve,reject,signal:options.signal});return promise;},document:{visibilityState:'visible',addEventListener(n,f){listeners.set('document:'+n,f);},removeEventListener(n){listeners.delete('document:'+n);}},window:{location,history,confirm:()=>true,addEventListener(n,f){listeners.set(n,f);},removeEventListener(n){listeners.delete(n);},setInterval(f){timers.add(f);return f;},clearInterval(f){timers.delete(f);}},require(id){if(id==='./creator-production-workflow')return creatorWorkflow;if(id==='react')return react;if(id==='react/jsx-runtime')return{jsx,jsxs:jsx};if(id==='./system-management-client')return{async readManagementResponse(r){const p=await r.json();if(!r.ok)throw Error(p.error);return p;},async managementMutation(...args){writes.push(args);return {};}};if(id==='./runtime-mode')return{useRuntimeMode:()=>({hostedReadOnly:false})};if(id==='./management-draft-guard')return{useManagementDraftGuard(){}};if(id==='./review-semantics')return{visibleText:v=>v};return {};}};
 const raw=readFileSync(new URL(name,sourceRoot),'utf8');
 vm.runInNewContext(ts.transpileModule(raw,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
 return{exports:module.exports,state,requests,listeners,timers,writes,render(fn,args){si=0;ri=0;ei=0;const result=module.exports[fn](args);while(pending.length){const i=pending.shift();effects[i].cleanup=effects[i].fn();}return result;},cleanup(){effects.forEach(e=>e.cleanup?.());},context};
}
const wf=load('workflow-overview.tsx').exports;
test('preparation capability filters do not promote AI assistance into independent advancement',()=>{const check=load('current-work-center.tsx').exports.preparationMatchesFilters;const prep={status:'READY',capabilities:['人可推进','AI可辅助']};const filter={actor:'HUMAN',state:'NOW',type:'ALL'};assert.equal(check(prep,filter),true);assert.equal(check(prep,{...filter,actor:'AI'}),false);assert.equal(check(prep,{...filter,actor:'BOTH'}),false);assert.equal(check({...prep,status:'BLOCKED'},filter),false);});
test('stage identity follows canonical workflow fields; names never infer material lifecycle',()=>{
 assert.equal(wf.workflowItemStage({ownerModule:'FULL_PRODUCTION',productionPhaseId:'SCENE_FINISH'}),null);
 assert.equal(wf.workflowItemStage({ownerModule:'FULL_PRODUCTION',productionPhaseId:'PREVIS',productionGateId:'SHOT_PLAN_INPUT_LOCK'}),'SHOT_BREAKDOWN');
 assert.equal(wf.workflowItemStage({ownerModule:'FULL_PRODUCTION',productionPhaseId:'PREVIS',productionGateId:'STORYBOARD_DIALOGUE'}),'SHOT_GENERATION');
 assert.equal(wf.workflowItemStage({ownerModule:'FULL_PRODUCTION',productionPhaseId:'SCENE_FINISH',productionGateId:'SCENE_QA'}),'SCENE_EDIT');
 assert.equal(wf.workflowItemStage({ownerModule:'FULL_PRODUCTION',productionPhaseId:'SERIES_DELIVERY',productionGateId:'DELIVERY_ARCHIVE'}),'EPISODE_EDIT');
 assert.equal(wf.workflowItemStage({ownerModule:'FULL_PRODUCTION',productionGateId:'UNKNOWN',title:'镜头生成'}),null);
 assert.equal(wf.workflowItemStage({ownerModule:'STORY_CREATION',workstream:'EPISODE_PLANNING'}),'EPISODE_PLAN');
 assert.equal(wf.workflowItemStage({ownerModule:'WORLD_AND_MATERIALS',title:'已通过素材',workType:'FORMAL_REVIEW'}),null);
 assert.equal(wf.workflowItemStage({ownerModule:'WORLD_AND_MATERIALS',materialCreatorStage:'PENDING_REVIEW'}),'PENDING_REVIEW');
});
test('candidate preparation never supplies a formal denominator or formal task',()=>{
 const result=wf.buildWorkflowStages({id:'FULL_PRODUCTION',stages:[{id:'SHOT_BREAKDOWN',label:'配置标签',count:0,denominator:null,denominatorState:'UNKNOWN'}],navigationIntent:{href:'formal'},nextUnlockText:'next'},{nodes:[],preparationWork:{sceneCount:142,status:'READY'}},[]);
 assert.equal(result[0].preparation.sceneCount,142);assert.equal(result[0].denominator,null);assert.equal(result[0].items.length,0);assert.equal(result[0].label,'配置标签');assert.match(wf.workflowCount(result[0]),/正式分母未锁定/);
});
test('material stage selection filters exact demand stages and retains the same directory filter in its link',()=>{
 const items=[{ownerModule:'WORLD_AND_MATERIALS',requirementId:'exact-a',materialCreatorStage:'INITIAL'}, {ownerModule:'WORLD_AND_MATERIALS',requirementId:'exact-b',materialCreatorStage:'PENDING_REVIEW'}, {ownerModule:'WORLD_AND_MATERIALS',title:'待审阅但无精确归属'}];
 const [stage]=wf.buildWorkflowStages({id:'WORLD_AND_MATERIALS',stages:[{id:'PENDING_REVIEW',label:'待审阅',count:1,denominator:2,denominatorState:'KNOWN'}],navigationIntent:{href:'?view=materials'},nextUnlockText:'next'},{nodes:[]},items);
 assert.deepEqual(Array.from(stage.items,item=>item.requirementId),['exact-b']);
 assert.equal(stage.href,'?view=materials&materialMode=classification&materialCreatorStage=PENDING_REVIEW');
});
test('creator task filtering preserves canonical gate scope while phase-only tasks stay unassigned',()=>{
 const items=[
  {ownerModule:'FULL_PRODUCTION',productionPhaseId:'PREVIS',productionGateId:'SHOT_PLAN_INPUT_LOCK',subjectId:'plan'},
  {ownerModule:'FULL_PRODUCTION',productionPhaseId:'PREVIS',productionGateId:'STORYBOARD_DIALOGUE',subjectId:'shot'},
  {ownerModule:'FULL_PRODUCTION',productionPhaseId:'SERIES_DELIVERY',productionGateId:'DELIVERY_ARCHIVE',subjectId:'whole-project'},
  {ownerModule:'FULL_PRODUCTION',productionPhaseId:'PREVIS',subjectId:'unbound'},
 ];
 const stages=creatorWorkflow.CREATOR_PRODUCTION_STAGES.map(s=>({id:s.id,label:s.label,count:0,denominator:null,denominatorState:'UNKNOWN'}));
 const result=wf.buildWorkflowStages({id:'FULL_PRODUCTION',stages,navigationIntent:{href:'formal'},nextUnlockText:'next'},{nodes:[],preparationWork:{sceneCount:142,status:'READY'}},items);
 assert.deepEqual(Array.from(result,s=>Array.from(s.items,i=>i.subjectId)),[['plan'],['shot'],[],['whole-project']]);
 assert.equal(result.filter(s=>s.preparation).length,1);assert.equal(result[0].id,'SHOT_BREAKDOWN');
 assert.equal(wf.workflowItemStage(items[3]),null);
});
const workspacePacket=marker=>({queue:{marker,snapshotId:'snapshot',operationRevision:'ops'},workflow:{marker,freshness:{snapshotId:'snapshot',operationRevision:'ops'}}});
for(const oldResult of ['success','failure'])test('atomic projection ignores older '+oldResult,async()=>{
 const h=load('workflow-overview.tsx');h.render('useWorkflowProjection');h.listeners.get('review:operations-updated')();assert.equal(h.requests.length,2);
 assert.equal(h.requests[0].url,'/api/instance/workflow?workspace=1');
 h.requests[1].resolve(new Response(JSON.stringify(workspacePacket('LATEST'))));await settle();
 assert.equal(h.state[0].queue.marker,'LATEST');
 h.requests[0].resolve(new Response(JSON.stringify(oldResult==='success'?workspacePacket('OLD'):{error:'old failure'}),{status:oldResult==='success'?200:503}));await settle();
 assert.equal(h.state[0].workflow.marker,'LATEST');assert.equal(h.state[1],'');h.cleanup();
});
test('latest failed or mismatched projection closes the view instead of retaining old task data',async()=>{
 for(const mismatch of [false,true]){
  const h=load('workflow-overview.tsx');h.render('useWorkflowProjection');h.requests[0].resolve(new Response(JSON.stringify(workspacePacket('FIRST'))));await settle();h.listeners.get('focus')();
  const bad=workspacePacket('MISMATCH');bad.workflow.freshness.operationRevision='different';
  h.requests[1].resolve(new Response(JSON.stringify(mismatch?bad:{error:'failed'}),{status:mismatch?200:503}));await settle();
  assert.equal(h.state[0],null);assert.match(h.state[1],mismatch?/依据不一致/:/failed/);h.cleanup();
 }
});
test('poll, visibility, shared mutation events and cleanup all use one atomic refresh',async()=>{
 const h=load('workflow-overview.tsx');h.render('useWorkflowProjection');assert.equal(h.timers.size,1);
 for(const name of h.exports.workflowEvents)assert.equal(typeof h.listeners.get(name),'function');h.listeners.get('document:visibilitychange')();assert.equal(h.requests.length,2);h.cleanup();assert.equal(h.timers.size,0);assert.equal(h.listeners.size,0);h.requests.forEach(r=>assert.equal(r.signal.aborted,true));
});
function all(tree){if(Array.isArray(tree))return tree.flatMap(all);return tree&&typeof tree==='object'?[tree,...Object.values(tree.props||{}).flatMap(all)]:[];}
function text(tree){if(tree==null||typeof tree==='boolean')return '';if(typeof tree==='string'||typeof tree==='number')return String(tree);if(Array.isArray(tree))return tree.map(text).join('');return text(tree.props?.children);}
const prep=()=>{const fixture=({releaseId:'release1',revisionId:'prep1',stale:false,comments:[],candidate:{revisionId:'candidate1',contentHash:'a'.repeat(64),episodes:[],scenes:[{id:'permanent-1',displayId:'S01',title:'场一'},{id:'permanent-2',displayId:'S01',title:'场二'}]},content:{basis:{candidateRevisionId:'candidate1'},episodes:[{episodeUid:'episode-1',displayId:'E01',title:'甲',sceneIds:['permanent-1']},{episodeUid:'episode-2',displayId:'E02',title:'乙',sceneIds:['permanent-2']}],scenes:[{sceneId:'permanent-1',displayId:'S01',episodeUid:'episode-1',sceneContentHash:'1'.repeat(64),preparation:{sceneRole:'本场一',generationAuthorized:false,formalShotIds:[]}},{sceneId:'permanent-2',displayId:'S01',episodeUid:'episode-2',sceneContentHash:'2'.repeat(64),preparation:{sceneRole:'本场二',generationAuthorized:false,formalShotIds:[]}}]}});fixture.candidate.episodes=structuredClone(fixture.content.episodes);return fixture;};
const contractGates=creatorWorkflow.CREATOR_PRODUCTION_STAGES.flatMap(s=>s.gateIds).map(id=>creatorWorkflow.creatorProductionGateDefinition(id));
const workflow={phases:[...new Set(contractGates.map(g=>g.phaseId))].map(id=>({id,label:id})),gates:contractGates.map(g=>({id:g.gateId,phaseId:g.phaseId,scopeType:g.scopeType,label:g.gateId}))};
test('creator checks preserve shared dependency order despite interleaved phase-local input orders',async()=>{
 const interleaved=['KEYFRAMES','STORYBOARD_DIALOGUE','SHOT_VIDEO','ANIMATIC_LOCK','SHOT_LOCK'];
 const reordered={...workflow,gates:[...interleaved.map(id=>workflow.gates.find(g=>g.id===id)),...workflow.gates.filter(g=>!interleaved.includes(g.id))]};
 const frozen=JSON.stringify(reordered),h=load('production-preparation-workspace.tsx'),seen=[],props={workflow:reordered,initialCreatorStageId:'SHOT_GENERATION',renderStage:ctx=>{seen.push(ctx);return null;}};
 h.render('ProductionPreparationWorkspace',props);h.requests[0].resolve(new Response(JSON.stringify(prep())));await settle();
 const tree=h.render('ProductionPreparationWorkspace',props),buttons=all(tree).filter(n=>n.props?.['data-production-check']);
 assert.deepEqual(buttons.map(n=>n.props['data-production-check']),['STORYBOARD_DIALOGUE','ANIMATIC_LOCK','KEYFRAMES','SHOT_VIDEO','SHOT_LOCK']);
 for(const button of buttons){button.props.onClick();h.render('ProductionPreparationWorkspace',props);const expected=creatorWorkflow.creatorProductionGateDefinition(button.props['data-production-check']);assert.equal(seen.at(-1).gateId,expected.gateId);assert.equal(seen.at(-1).phaseId,expected.phaseId);assert.equal(seen.at(-1).scopeType,expected.scopeType);assert.equal(seen.at(-1).sceneId,'permanent-1');}
 assert.equal(JSON.stringify(reordered),frozen);assert.equal(h.writes.length,0);h.cleanup();
});
test('one permanent scene context survives stage change and no mutation is created',async()=>{
 const h=load('production-preparation-workspace.tsx'),seen=[],props={workflow,renderStage:ctx=>{seen.push(ctx);return null;}};h.render('ProductionPreparationWorkspace',props);h.requests[0].resolve(new Response(JSON.stringify(prep())));await settle();let tree=h.render('ProductionPreparationWorkspace',props);
 all(tree).find(n=>n.type==='button'&&n.props['data-preparation-episode']==='episode-2').props.onClick();tree=h.render('ProductionPreparationWorkspace',props);
 all(tree).find(n=>n.type==='button'&&n.props['data-creator-stage']==='SHOT_GENERATION').props.onClick();h.render('ProductionPreparationWorkspace',props);
 assert.equal(seen.at(-1).sceneId,'permanent-2');assert.equal(seen.at(-1).episodeUid,'episode-2');assert.equal(seen.at(-1).phaseId,'PREVIS');assert.equal(seen.at(-1).gateId,'STORYBOARD_DIALOGUE');assert.equal(seen.at(-1).scopeType,'SHOT');assert.equal(seen.at(-1).navigationScopeType,'SCENE');assert.equal(h.writes.length,0);h.cleanup();
});
test('dirty preparation preserves the old exact revision when background candidate changes',async()=>{
 const h=load('production-preparation-workspace.tsx'),props={workflow};h.render('ProductionPreparationWorkspace',props);h.requests[0].resolve(new Response(JSON.stringify(prep())));await settle();let tree=h.render('ProductionPreparationWorkspace',props);
 all(tree).find(n=>n.type==='button'&&text(n)==='编辑本场准备内容').props.onClick();h.render('ProductionPreparationWorkspace',props);h.listeners.get('focus')();h.render('ProductionPreparationWorkspace',props);
 const newer=prep();newer.revisionId='prep2';newer.stale=true;h.requests.at(-1).resolve(new Response(JSON.stringify(newer)));await settle();assert.equal(h.state[0].revisionId,'prep1');assert.match(h.state[1],/原版本基线已保留/);assert.equal(h.writes.length,0);h.cleanup();
});
test('an unknown permanent scene deep link cannot silently remap to the first scene',async()=>{
 const h=load('production-preparation-workspace.tsx'),seen=[];h.context.window.location.search='?preparationScene=absent-permanent-id';const props={workflow,initialPhaseId:'SHOT_FINISH',renderStage:c=>{seen.push(c);return null;}};h.render('ProductionPreparationWorkspace',props);h.requests[0].resolve(new Response(JSON.stringify(prep())));await settle();h.render('ProductionPreparationWorkspace',props);assert.equal(seen.length,0);assert.equal(h.writes.length,0);h.cleanup();
});

for(const [query,message] of [
 ['preparationEpisode=episode-absent','永久集身份不在当前准备稿中'],
 ['preparationEpisode=E01','永久集身份不在当前准备稿中'],
 ['preparationEpisode=episode-1&preparationScene=permanent-2','永久集与场身份不匹配'],
])test('invalid preparation context fails closed without formal render or writes: '+query,async()=>{
 const h=load('production-preparation-workspace.tsx'),seen=[];h.context.window.location.search='?view=pipeline&'+query;
 const props={workflow,initialPhaseId:'SHOT_FINISH',renderStage:c=>{seen.push(c);return null;}};h.render('ProductionPreparationWorkspace',props);h.requests[0].resolve(new Response(JSON.stringify(prep())));await settle();
 const tree=h.render('ProductionPreparationWorkspace',props);
 assert.ok(all(tree).some(n=>n.props?.role==='alert'&&text(n).includes(message)));
 assert.equal(seen.length,0);assert.equal(all(tree).filter(n=>n.type==='button'&&['编辑本场准备内容','保存准备意见'].includes(text(n))).length,0);
 assert.equal(h.writes.length,0);assert.equal(h.context.window.location.search,'?view=pipeline&'+query);h.cleanup();
});
test('permanent context selection writes both URL identities and popstate restores the same scene',async()=>{
 const h=load('production-preparation-workspace.tsx'),props={workflow};h.context.window.location.search='?view=pipeline&preparationEpisode=episode-1&preparationScene=permanent-1';
 h.render('ProductionPreparationWorkspace',props);h.requests[0].resolve(new Response(JSON.stringify(prep())));await settle();let tree=h.render('ProductionPreparationWorkspace',props);
 all(tree).find(n=>n.type==='button'&&n.props['data-preparation-episode']==='episode-2').props.onClick();tree=h.render('ProductionPreparationWorkspace',props);
 assert.equal(h.context.window.location.searchParams.get('preparationEpisode'),'episode-2');assert.equal(h.context.window.location.searchParams.get('preparationScene'),'permanent-2');
 h.context.window.location.search='?view=pipeline&preparationEpisode=episode-1&preparationScene=permanent-1';h.listeners.get('popstate')({stopImmediatePropagation(){assert.fail('clean navigation must not be blocked');}});tree=h.render('ProductionPreparationWorkspace',props);
 assert.equal(all(tree).find(n=>n.type==='button'&&n.props['data-preparation-scene']==='permanent-1').props['aria-current'],'location');assert.equal(h.writes.length,0);h.cleanup();
});

for(const [gateId,scopeType,navigationScopeType] of [['EPISODE_ASSEMBLY','EPISODE','EPISODE'],['SERIES_CONTINUITY','PROJECT','PROJECT']])test('episode workspace never supplies a scene to '+gateId,async()=>{
 const h=load('production-preparation-workspace.tsx'),seen=[],props={workflow,initialGateId:gateId,renderStage:c=>{seen.push(c);return null;}};
 h.context.window.location.search='?view=pipeline&preparationEpisode=episode-2&preparationScene=permanent-2&scene=permanent-2';h.render('ProductionPreparationWorkspace',props);h.requests[0].resolve(new Response(JSON.stringify(prep())));await settle();const tree=h.render('ProductionPreparationWorkspace',props);
 assert.equal(seen.at(-1).episodeUid,'episode-2');assert.equal(seen.at(-1).scopeType,scopeType);assert.equal(seen.at(-1).navigationScopeType,navigationScopeType);assert.equal(Object.hasOwn(seen.at(-1),'sceneId'),false);assert.equal(all(tree).filter(n=>n.props?.['aria-label']==='制作上下文场次').length,0);assert.equal(h.context.window.location.searchParams.has('preparationScene'),false);assert.equal(h.context.window.location.searchParams.has('scene'),false);assert.equal(h.writes.length,0);h.cleanup();
});
test('canonical gate and creator stage mismatch does not render or allow preparation saves',async()=>{
 const h=load('production-preparation-workspace.tsx'),seen=[],props={workflow,initialCreatorStageId:'SHOT_BREAKDOWN',initialGateId:'KEYFRAMES',renderStage:c=>{seen.push(c);return null;}};
 h.render('ProductionPreparationWorkspace',props);h.requests[0].resolve(new Response(JSON.stringify(prep())));await settle();const tree=h.render('ProductionPreparationWorkspace',props);
 assert.equal(seen.length,0);assert.ok(all(tree).some(n=>n.props?.role==='alert'&&text(n).includes('制作阶段与检查不匹配')));assert.equal(all(tree).filter(n=>n.type==='button'&&text(n)==='编辑本场准备内容').length,0);assert.equal(h.writes.length,0);h.cleanup();
});
