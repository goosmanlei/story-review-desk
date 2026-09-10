import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const site=new URL('../',import.meta.url);
const require=createRequire(new URL('package.json',site)),ts=require('typescript');
function harness(){
 const assistant={focus:[],drafts:[]},modules=new Map();
 const jsx=(type,props)=>({type,props});
 const react={useState(value){return[typeof value==='function'?value():value,()=>{}];},useEffect(){},useMemo(fn){return fn();},useCallback(fn){return fn;}};
 function load(name){if(modules.has(name))return modules.get(name);const module={exports:{}};modules.set(name,module.exports);
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('app/'+name+'.tsx',site),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{
   module,exports:module.exports,console,structuredClone,require(id){
    if(id==='react')return react;if(id==='react/jsx-runtime')return{jsx,jsxs:jsx};
    if(id==='./runtime-path')return{runtimePath:value=>value};
    if(id==='./instance-profile')return{projectIdFor:model=>model.instance.projectId,episodePlanIdFor:model=>model.instance.episodePlanId};
    if(id==='./client-storage')return{instanceLocalStorage:{getItem:()=>null,setItem(){},removeItem(){}}};
    if(id==='./runtime-mode')return{useRuntimeMode:()=>({hostedReadOnly:false})};
    if(id==='./review-semantics')return{publicRef:value=>value,visibleText:value=>value};
    if(id==='./assistant/context-provider')return{useAssistantFocus:value=>assistant.focus.push(value)};
    if(id==='./assistant/project-draft-adapters')return{useProjectAssistantDraftTargets:config=>{assistant.drafts.push(config);return{hasTargets:config.fields.length>0,activateField(){},askAboutField(){}};}};
    if(id==='./episode-scene-navigator')return load('episode-scene-navigator');
    if(id==='./episode-review-criteria'||id==='./narrative-revision'||id==='./review-shortcuts'){const criteria={exports:{}};vm.runInNewContext(ts.transpileModule(readFileSync(new URL('app/'+id.slice(2)+'.ts',site),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:criteria,exports:criteria.exports});return criteria.exports;}
    if(id.endsWith('.css'))return {};throw Error('Unexpected dependency '+id);
   },fetch(){assert.fail('rendering navigation must not issue writes or reads');}
  });return module.exports;
 }
 return {load,assistant};
}
function all(tree){if(Array.isArray(tree))return tree.flatMap(all);return tree&&typeof tree==='object'?[tree,...Object.values(tree.props||{}).flatMap(all)]:[];}
function text(tree){if(tree==null||typeof tree==='boolean')return'';if(typeof tree==='string'||typeof tree==='number')return String(tree);if(Array.isArray(tree))return tree.map(text).join('');return text(tree.props?.children);}
const captured=JSON.parse(readFileSync(new URL('tests/fixtures/generic-adopted-scene.json',site),'utf8'));
function workbenchProps(extra={}){const plan=structuredClone(captured.responses.episodePlan.plan);return {resolvedPlan:plan,model:captured.responses.bootstrap.data.productionModel,snapshotId:plan.snapshotId,baseRevisionHash:plan.baseRevisionHash,sceneIds:plan.content.episodes.flatMap(e=>e.sceneIds),selectedEpisodeId:plan.content.episodes[0].episodeUid,onSelectEpisode(){},selectedCriterionId:'opening-boundary',onSelectCriterion(){},children:'EPISODE_READING',...extra};}
function renderWorkbench(h,props){const wrapper=h.load('episode-plan-workbench').EpisodePlanWorkbench(props);return typeof wrapper.type==='function'?wrapper.type(wrapper.props):wrapper;}
test('scene reading slot receives the permanent scene while all episode judgments and assistant targets remain',()=>{
 const h=harness(),seen=[],sceneId=captured.sceneId,tree=renderWorkbench(h,workbenchProps({selectedSceneId:sceneId,onSelectScene(){},renderSceneReading:id=>{seen.push(id);return{type:'article',props:{children:'SCENE_READING'}};}}));
 assert.deepEqual(seen,[sceneId]);assert.ok(all(tree).some(node=>text(node.props?.sceneReading).includes('SCENE_READING')));assert.ok(text(tree).includes('EPISODE_READING'));
 assert.equal(all(tree).filter(node=>node.props?.['data-criterion-id']).length,6);
 assert.equal(h.assistant.focus.at(-1).subjectType,'EPISODE');assert.equal(h.assistant.drafts.at(-1).fields.length,7);
});
test('episode mode retains all six judgment cards and its own receipt',()=>{
 const h=harness(),tree=renderWorkbench(h,workbenchProps());assert.equal(all(tree).filter(node=>node.props?.['data-criterion-id']).length,6);assert.ok(text(tree).includes('EPISODE_READING'));assert.ok(text(tree).includes('当前权威方案'));assert.equal(h.assistant.focus.at(-1).subjectType,'EPISODE');assert.equal(h.assistant.drafts.at(-1).fields.length,7);
});
test('unknown scene fails closed and never calls a renderer with the first scene',()=>{
 const h=harness(),tree=renderWorkbench(h,workbenchProps({selectedSceneId:'S01',renderSceneReading(){assert.fail('display label must not become a permanent scene');}}));
 assert.ok(all(tree).some(node=>node.props?.role==='alert'&&text(node).includes('此场不属于当前集')));assert.ok(!text(tree).includes('EPISODE_READING'));assert.equal(all(tree).filter(node=>node.type==='form').length,0);
});
test('repeated display labels in two episodes never replace callback identities',()=>{
 const h=harness(),called=[],episode=captured.responses.episodePlan.plan.content.episodes[0],episodes=[{...episode,episodeUid:'ep-a',displayId:'E01',sceneIds:['scene-a']},{...episode,episodeUid:'ep-b',displayId:'E01',sceneIds:['scene-b']}];
 const tree=h.load('episode-scene-navigator').EpisodeSceneNavigator({episodes,selectedEpisodeUid:'ep-b',selectedSceneId:'scene-b',sceneLabels:{'scene-a':{displayId:'S01',title:'同名'},'scene-b':{displayId:'S01',title:'同名'}},states:{},onSelectEpisode:id=>called.push(id),onSelectScene:id=>called.push(id)});
 all(tree).find(node=>node.props?.['data-episode-uid']==='ep-a').props.onClick();all(tree).find(node=>node.props?.['data-scene-id']==='scene-b').props.onClick();assert.equal(all(tree).filter(node=>node.type==='button'&&text(node).includes('本集拆解与审阅')).length,0);
 assert.deepEqual(called,['ep-a','scene-b']);assert.equal(all(tree).filter(node=>node.props?.['data-scene-id']==='scene-a').length,0);
});
test('editing an episode submission keeps other episode selection locked',()=>{
 const h=harness(),episode=captured.responses.episodePlan.plan.content.episodes[0],tree=h.load('episode-scene-navigator').EpisodeSceneNavigator({episodes:[{...episode,episodeUid:'ep-a'},{...episode,episodeUid:'ep-b'}],selectedEpisodeUid:'ep-a',sceneLabels:{},states:{},lockedEpisodeUid:'ep-a',onSelectEpisode(){},onSelectScene(){}});
 assert.equal(all(tree).find(node=>node.props?.['data-episode-uid']==='ep-b').props.disabled,true);assert.equal(all(tree).find(node=>node.props?.['data-episode-uid']==='ep-a').props.disabled,false);
});

test('timing navigation follows permanent scope and does not borrow missing estimates',()=>{
 const h=harness(),episode=captured.responses.episodePlan.plan.content.episodes[0],props={episodes:[{...episode,sceneIds:['scene-a','scene-b']}],selectedEpisodeUid:episode.episodeUid,sceneLabels:{},states:{},onSelectEpisode(){},onSelectScene(){},summary:{type:'section',props:{'data-summary':true}},sceneReading:{type:'article',props:{'data-scene-reading':'scene-a',children:'CURRENT_SCENE_BODY'}},sceneRuntimes:{'scene-a':{baseSec:30,compactSec:20,spaciousSec:40,rationale:'当前永久场估时'},'unrelated-scene':{baseSec:999,compactSec:999,spaciousSec:999}}};
 const tree=h.load('episode-scene-navigator').EpisodeSceneNavigator(props);
 assert.deepEqual(all(tree).filter(node=>node.props?.['data-timing-scene-id']).map(node=>node.props['data-timing-scene-id']),['scene-a','scene-b']);
 assert.ok(!text(tree).includes('16分39秒'));assert.ok(text(tree).includes('CURRENT_SCENE_BODY'));assert.equal(all(tree).filter(node=>node.props?.scope==='col').length,3);
 const missing=all(tree).find(node=>node.props?.['data-timing-scene-id']==='scene-b');assert.equal((text(missing).match(/UNKNOWN/g)||[]).length,2);
 const children=tree.props.children.filter(Boolean);assert.equal(children[0].props.className,'episode-review-navigator');assert.equal(children[1].props['data-summary'],true);assert.equal(children[2].props.className,'episode-scene-navigator');
});
