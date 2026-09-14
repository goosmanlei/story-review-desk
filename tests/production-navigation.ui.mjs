import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import path from 'node:path';
import {chromium} from '@playwright/test';
import {requiredPhase} from '../tools/process-resources.mjs';
import {CREATOR_PRODUCTION_STAGES,creatorProductionGateDefinition} from '../web/presentation/creator-production-workflow.mjs';
import {verifyPreparationReading} from './workspace-navigation.ui.mjs';

const phase=await requiredPhase(process.cwd());assert.ok(phase,'Use managed runner');
const out=path.resolve(process.env.REVIEW_UI_ARTIFACT_DIR||process.env.REVIEW_TASK_DIR);
assert.ok(out===path.resolve(process.env.REVIEW_TASK_DIR)||out.startsWith(path.resolve(process.env.REVIEW_TASK_DIR)+path.sep),'Artifacts must stay in this phase');
mkdirSync(out,{recursive:true});
const isolated=process.argv.includes('--isolated'),slug=s=>s.toLowerCase().replaceAll('_','-');

// This component fixture has no database, production instance or model access.
// It renders the actual shared workspace, CSS, storage and draft/read guards.
// Only host data adapters and the downstream workbench are simulated. The
// default URL mode remains available for a coordinator's full-app fixture QA.
async function componentFixture(){
 const root=process.cwd(),build=path.join(out,'component-fixture');mkdirSync(build,{recursive:true});
 const episodes=Array.from({length:4},(_,i)=>({episodeUid:`fixture-episode-${i}`,displayId:`E${i+1}`,title:i===1?'长集名'+('UnbrokenName'.repeat(12)):`隔离分集 ${i+1}`,sceneIds:Array.from({length:8},(_,j)=>`fixture-scene-${i}-${j}`)}));
 const scenes=episodes.flatMap(ep=>ep.sceneIds.map((sceneId,j)=>({sceneId,displayId:`S${j+1}`,episodeUid:ep.episodeUid,sceneContentHash:'fixture-hash',objectId:sceneId,revisionId:'fixture-r1',expectedVersion:1,sourceSummary:{title:`隔离场 ${j+1}`},preparation:{sceneRole:'隔离制作意图',audienceTakeaway:'隔离测试准备稿'}})));
 const preparation={releaseId:'fixture-release',revisionId:'fixture-preparation-r1',content:{basis:{},episodes,scenes},candidate:{revisionId:'fixture-candidate',contentHash:'fixture-hash',episodes,scenes:scenes.map((s,i)=>({id:s.sceneId,displayId:s.displayId,title:i===10?'长场名'+('SceneName'.repeat(18)):s.sourceSummary.title}))},comments:[],stale:false};
 const gates=CREATOR_PRODUCTION_STAGES.flatMap(s=>s.gateIds.map(id=>{const g=creatorProductionGateDefinition(id);return {id,phaseId:g.phaseId,scopeType:g.scopeType,label:id};}));
 const workflow={phases:[...new Set(gates.map(g=>g.phaseId))].map(id=>({id,label:id})),gates};
 const appFile=name=>path.join(root,'web/app',name),generated=(name,source)=>{const file=path.join(build,name);writeFileSync(file,source);return file;};
 const adapters=generated('adapters.ts',`
 export const profile={instanceId:'ui-fixture-production-navigation',deployment:{runtimeEpoch:'fixture'},capabilities:{}};
 export const useInstanceProfile=()=>profile;
 export const workspaceCacheScope=()=>profile.instanceId;
 export const readWorkspaceJson=async(url,scope,signal)=>{const r=await fetch(url,{signal});if(!r.ok)throw Error('Fixture read failed');return r.json();};
 export const useRuntimeMode=()=>({hostedReadOnly:false});
 export const runtimePath=p=>p;
 export const visibleText=s=>s;
 export const SoundOwnershipList=()=>null;
 export const bindingsForObject=()=>[];
 export const managementMutation=()=>{throw Error('No mutations in the component fixture');};
 export const readManagementResponse=()=>{throw Error('No mutations in the component fixture');};
 `);
 const entry=generated('entry.tsx',`
 import React,{useEffect,useState} from 'react';import {createRoot} from 'react-dom/client';
 import {ProductionPreparationWorkspace} from ${JSON.stringify(appFile('production-preparation-workspace.tsx'))};
 import {useWorkspaceReadiness} from ${JSON.stringify(appFile('workspace-read-boundary.tsx'))};
 import {configureClientStorage} from ${JSON.stringify(appFile('client-storage.ts'))};
 import {profile} from './adapters';configureClientStorage(profile);
 function Panel({context}){
  const [pending,setPending]=useState(true),[rows,setRows]=useState(70);
  useEffect(()=>{const c=new AbortController();setPending(true);fetch('/api/v1/workspaces/views/production?gateId='+context.gateId+'&episode='+context.episodeUid+'&scene='+(context.sceneId||''),{signal:c.signal}).then(()=>{if(!c.signal.aborted)setPending(false);}).catch(error=>{if(!c.signal.aborted)throw error;});return()=>c.abort();},[context.gateId,context.episodeUid,context.sceneId]);
  useEffect(()=>{const resize=e=>setRows(e.detail);window.addEventListener('fixture:rows',resize);return()=>window.removeEventListener('fixture:rows',resize);},[]);
  useWorkspaceReadiness(pending,'',()=>{});
  return <section data-fixture-body><h3>隔离正文</h3>{Array.from({length:rows},(_,i)=><p key={i}>阅读检查段落 {i+1}。这段内容仅用于验证自然高度、导航和阅读位置，不包含真实故事资料。</p>)}<p data-fixture-end>正文结束</p></section>;
 }
 function App(){const [visible,setVisible]=useState(true);return <><header style={{padding:'60px 0'}}>制作导航隔离测试</header><nav><button data-fixture-module onClick={()=>{if(window.dispatchEvent(new Event('review:configuration-before-leave',{cancelable:true})))setVisible(v=>!v);}}>切换模块</button></nav>{visible&&<ProductionPreparationWorkspace renderStage={context=><Panel context={context}/>}/>}</>;}
 createRoot(document.getElementById('root')).render(<React.StrictMode><App/></React.StrictMode>);
 `);
 const require=createRequire(import.meta.url),webpackPackage=require('next/dist/compiled/webpack/webpack');
 const loader=generated('typescript.cjs',`const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=function(source){return ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText;};`);
 const cssLoader=generated('style.cjs',`module.exports=function(source){return 'const style=document.createElement("style");style.textContent='+JSON.stringify(source)+';document.head.append(style);';};`);
 const empty=generated('empty.css','');
 const aliases=Object.fromEntries(['workspace-read-cache','instance-context','runtime-mode','runtime-path','review-semantics','sound-ownership','system-management-client'].map(name=>['./'+name+'$',adapters]));
 aliases['./entity-workspace.css$']=empty;
 const compiler=webpackPackage.webpack({mode:'development',devtool:false,cache:false,entry,target:'web',output:{path:build,filename:'bundle.js'},resolve:{extensions:['.tsx','.ts','.mjs','.js'],modules:[path.dirname(require.resolve('react/package.json'))+'/..'],alias:aliases},module:{rules:[{test:/\.tsx?$/,use:loader},{test:/\.css$/,use:cssLoader}]}});
 await new Promise((resolve,reject)=>compiler.run((error,stats)=>compiler.close(closeError=>error||closeError||stats.hasErrors()?reject(error||closeError||Error(stats.toString({all:false,errors:true}))):resolve())));
 const requests=[];
 const server=createServer((req,res)=>{
  requests.push({method:req.method,url:req.url});
  if(req.method!=='GET'){res.writeHead(405);res.end();return;}
  const url=new URL(req.url,'http://fixture');
  const json=url.pathname==='/api/v1/health'?{project:{instanceId:'ui-fixture-production-navigation'}}:url.pathname==='/api/v1/workspaces/production-preparation'?preparation:url.pathname==='/api/v1/workspaces/workflow'?{definition:workflow}:url.pathname==='/api/v1/workspaces/views/production'?{}:null;
  if(json){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(json));return;}
  if(url.pathname==='/bundle.js'){res.setHeader('Content-Type','application/javascript');res.end(readFileSync(path.join(build,'bundle.js')));return;}
  if(url.pathname!=='/'){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:20px;--ink:#342d25;--muted:#82776c;--line:#d8cdbf;--paper-bright:#fffdf8;--paper-soft:#f5efe5;--red:#a05238}button{font:inherit}</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return {base:`http://127.0.0.1:${server.address().port}`,requests,close:()=>new Promise(resolve=>server.close(resolve))};
}

const fixture=isolated?await componentFixture():null;
const base=fixture?.base||process.env.REVIEW_UI_BASE||'http://127.0.0.1:3916';
let browser;
try{
 const health=await (await fetch(base+'/api/v1/health')).json();assert.match(health.project.instanceId,/^ui-fixture-/,'UI tests require an isolated fixture');
 const preparation=await (await fetch(base+'/api/v1/workspaces/production-preparation')).json(),episodes=preparation.candidate?.episodes||preparation.content.episodes;
 assert.ok(episodes.length>=2&&episodes[0].sceneIds.length>=2);
 const [first,second]=episodes,scene=first.sceneIds[1];
 const link=(stage,gate,episode=first.episodeUid,sceneId=scene)=>base+'/?'+new URLSearchParams({view:'pipeline',creatorStage:slug(stage),productionGate:slug(gate),preparationEpisode:episode,...(stage!=='EPISODE_EDIT'?{preparationScene:sceneId}:{})});
 browser=await chromium.launch({channel:'chrome'});
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),writes=[],errors=[],results=[];
 await page.route('**/*',route=>new URL(route.request().url()).origin===new URL(base).origin?route.continue():route.abort());
 page.on('request',r=>{if(!['GET','HEAD'].includes(r.method())&&r.url().includes('/api/'))writes.push(r.url());});page.on('pageerror',e=>errors.push(e.message));
 const main=page.locator('.preparation-stage-workspace'),directory=page.locator('.preparation-scene-directory');
 const ep=id=>page.locator(`[data-preparation-episode="${id}"]`),sc=id=>page.locator(`[data-preparation-scene="${id}"]`),toggle=id=>page.locator(`[data-preparation-toggle="${id}"]`),gate=id=>page.locator(`[data-production-check="${id}"]`),stage=id=>page.locator(`[data-creator-stage="${id}"]`);
 const settle=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
 const activate=locator=>locator.dispatchEvent('click'); // Keep navigation activation separate from Playwright's automatic scroll-to-click.
 const rect=locator=>locator.evaluate(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y+(e.closest('.workspace-main')?.scrollTop??scrollY),width:r.width,height:r.height};});
 async function current(gateId,episodeId,sceneId){
  await page.waitForFunction(({gateId,episodeId,sceneId})=>{const m=document.querySelector('.preparation-stage-workspace');return m?.getAttribute('data-preparation-current-gate')===gateId&&m.getAttribute('data-preparation-current-episode')===episodeId&&(m.getAttribute('data-preparation-current-scene')||'')===sceneId;},{gateId,episodeId,sceneId:sceneId||''});
  await page.waitForFunction(()=>document.querySelector('.preparation-stage-workspace .workspace-read-boundary')?.getAttribute('aria-busy')==='false');await settle();
  assert.equal(await ep(episodeId).getAttribute(sceneId?'aria-current':'aria-pressed'),sceneId?'location':'true');
  if(sceneId)assert.equal(await sc(sceneId).getAttribute('aria-current'),'location');
  const d=await rect(directory),m=await rect(main);assert.ok(d.x+d.width<=m.x&&Math.abs(d.y-m.y)<2,'Independent columns start at the same document position');
 }
 async function expanded(id,open){
  assert.equal(await toggle(id).getAttribute('aria-expanded'),String(open));assert.equal(await ep(id).getAttribute('aria-expanded'),String(open));
  assert.equal(await toggle(id).textContent(),open?'▾':'▸');
  assert.equal(await toggle(id).getAttribute('aria-controls'),await ep(id).getAttribute('aria-controls'));
  assert.equal(await page.locator(`[id="${await ep(id).getAttribute('aria-controls')}"]`).evaluate(e=>e.hidden),!open);
 }
 async function setOpen(id,open){if(await ep(id).getAttribute('aria-expanded')!==String(open))await activate(ep(id));await settle();await expanded(id,open);}
 async function collapseChecks(group,id){
  const url=page.url(),history=await page.evaluate(()=>window.history.length),before=await rect(main);
  for(const episode of [first,second]){
   const initial=await ep(episode.episodeUid).getAttribute('aria-expanded')==='true';
   for(const control of [ep(episode.episodeUid),toggle(episode.episodeUid),ep(episode.episodeUid),toggle(episode.episodeUid)]){
    const open=await control.getAttribute('aria-expanded')==='true';await activate(control);await settle();await expanded(episode.episodeUid,!open);
    await current(id,first.episodeUid,scene);assert.equal(page.url(),url);assert.equal(await page.evaluate(()=>window.history.length),history);assert.deepEqual(await rect(main),before);
   }
   await expanded(episode.episodeUid,initial);
  }
  for(const episode of episodes)await setOpen(episode.episodeUid,true);
  const expandedHeight=(await rect(directory)).height;
  assert.ok(await directory.evaluate(e=>e.scrollHeight<=e.clientHeight+1),'Every expanded directory item contributes to natural height');
  for(const episode of episodes)await setOpen(episode.episodeUid,false);
  assert.ok((await rect(directory)).height<expandedHeight);assert.deepEqual(await rect(main),before);
  assert.equal(await main.evaluate(e=>e.scrollTop),0);assert.ok(await main.evaluate(e=>e.scrollHeight<=e.clientHeight+1),'Right content has no nested scrollport');
  results.push({check:'title and arrow repeat for current/other episodes; all menus expand/collapse without changing context, history or right geometry',stage:group.id,gate:id,expandedHeight,collapsedHeight:(await rect(directory)).height});
 }
 for(const group of CREATOR_PRODUCTION_STAGES){
  await page.goto(link(group.id,group.defaultGateId),{waitUntil:'networkidle'});
  for(const id of group.gateIds){
   if(group.exportGateIds.includes(id)&&!(await gate(id).isVisible()))await activate(page.locator('.preparation-export-checks>summary'));
   await activate(gate(id));await current(id,first.episodeUid,group.scope==='SCENE'?scene:undefined);
   assert.equal(await toggle(first.episodeUid).count(),group.scope==='SCENE'?1:0);
   assert.equal(await main.getAttribute('data-creator-scope'),creatorProductionGateDefinition(id).scopeType==='PROJECT'?'PROJECT':group.scope);
   assert.equal(new URL(page.url()).searchParams.get('preparationScene'),group.scope==='SCENE'?scene:null);
   if(group.scope==='SCENE')await collapseChecks(group,id);
   else{await activate(ep(second.episodeUid));await current(id,second.episodeUid);await activate(ep(first.episodeUid));await current(id,first.episodeUid);results.push({check:'episode title still selects the precise episode',gate:id});}
   if(isolated){for(const episode of [first,second])assert.ok(await ep(episode.episodeUid).locator('b').evaluate(e=>e.getBoundingClientRect().height<=parseFloat(getComputedStyle(e).lineHeight)+1),'Short display identities stay on one line beside long titles');assert.ok((await rect(main)).height>2000);assert.ok((await rect(main)).height>(await rect(directory)).height);await page.locator('[data-fixture-end]').scrollIntoViewIfNeeded();assert.ok(await page.evaluate(()=>scrollY>1000));assert.equal(await main.evaluate(e=>e.scrollTop),0);}
  }
  await page.evaluate(()=>scrollTo(0,0));await settle();await page.screenshot({path:path.join(out,slug(group.id)+'-desktop.png')});
 }
 results.push(...await verifyPreparationReading(page,{first,second,scene,link,current,isolated}));
 await page.goto(link('SCENE_EDIT','PICTURE_LOCK'),{waitUntil:'networkidle'});await current('PICTURE_LOCK',first.episodeUid,scene);
 await setOpen(second.episodeUid,true);await sc(second.sceneIds[1]).click();await current('PICTURE_LOCK',second.episodeUid,second.sceneIds[1]);
 await setOpen(first.episodeUid,true);await activate(sc(scene));await current('PICTURE_LOCK',first.episodeUid,scene);
 await page.goBack();await current('PICTURE_LOCK',second.episodeUid,second.sceneIds[1]);await page.goForward();await current('PICTURE_LOCK',first.episodeUid,scene);
 results.push({check:'scene buttons and browser back/forward preserve exact cross-episode identities',passed:true});
 // A missing identity is repaired only by explicit scene selection, never by a title toggle.
 await page.goto(link('SCENE_EDIT','SCENE_QA','missing-permanent-episode',scene),{waitUntil:'networkidle'});await page.getByText('此链接的永久集身份不在当前准备稿中。',{exact:false}).waitFor();assert.equal(await main.getAttribute('data-preparation-current-episode'),null);
 const invalidUrl=page.url();await setOpen(first.episodeUid,true);assert.equal(page.url(),invalidUrl);await activate(sc(scene));await current('SCENE_QA',first.episodeUid,scene);
 await page.goto(link('SCENE_EDIT','PICTURE_LOCK',first.episodeUid,second.sceneIds[0]),{waitUntil:'networkidle'});await page.getByText('此链接的永久集与场身份不匹配。',{exact:false}).waitFor();assert.equal(await main.getAttribute('data-preparation-current-scene'),null);
 results.push({check:'missing and mismatched permanent deep links remain explicit errors',passed:true});
 await page.goto(link('SHOT_PRODUCTION','SHOT_PLAN_INPUT_LOCK'),{waitUntil:'networkidle'});await current('SHOT_PLAN_INPUT_LOCK',first.episodeUid,scene);
 // Real mouse and keyboard activation complement the scroll-neutral geometry checks.
 await ep(first.episodeUid).click();await settle();let open=await ep(first.episodeUid).getAttribute('aria-expanded')==='true';await expanded(first.episodeUid,open);
 await ep(first.episodeUid).press('Enter');await settle();await expanded(first.episodeUid,!open);await ep(first.episodeUid).press('Space');await settle();await expanded(first.episodeUid,open);
 await toggle(first.episodeUid).click();await settle();await expanded(first.episodeUid,!open);await current('SHOT_PLAN_INPUT_LOCK',first.episodeUid,scene);
 const note=page.getByRole('textbox',{name:'本场准备意见',exact:true});await note.fill('隔离测试：未提交的准备意见');
 await setOpen(second.episodeUid,true);await activate(sc(second.sceneIds[1]));await current('SHOT_PLAN_INPUT_LOCK',second.episodeUid,second.sceneIds[1]);await setOpen(first.episodeUid,true);await activate(sc(scene));await current('SHOT_PLAN_INPUT_LOCK',first.episodeUid,scene);assert.equal(await note.inputValue(),'隔离测试：未提交的准备意见');
 if(isolated){await activate(page.locator('[data-fixture-module]'));await page.waitForFunction(()=>!document.querySelector('.creator-production-workspace'));await activate(page.locator('[data-fixture-module]'));await current('SHOT_PLAN_INPUT_LOCK',first.episodeUid,scene);assert.equal(await note.inputValue(),'隔离测试：未提交的准备意见');}
 await page.evaluate(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.includes('editor-draft:preparation:'))throw Error('fixture storage unavailable');return original.call(this,k,v);};});await note.fill('本机保留失败时的未提交意见');await settle();
 const cancelled=[];page.on('dialog',async d=>{cancelled.push(d.message());await d.dismiss();});const protectedUrl=page.url();
 for(const control of [ep(first.episodeUid),toggle(first.episodeUid),ep(second.episodeUid),toggle(second.episodeUid)]){await activate(control);await settle();assert.equal(cancelled.length,0);assert.equal(page.url(),protectedUrl);assert.equal(await note.inputValue(),'本机保留失败时的未提交意见');}
 await setOpen(second.episodeUid,true);
 for(const action of [()=>activate(sc(second.sceneIds[0])),()=>page.goBack()]){const n=cancelled.length;await action();await settle();assert.equal(cancelled.length,n+1);assert.equal(page.url(),protectedUrl);assert.equal(await note.inputValue(),'本机保留失败时的未提交意见');}
 await activate(gate('STORYBOARD_DIALOGUE'));assert.equal(page.url(),protectedUrl);await page.getByText('本机草稿未能保留，请先保存或复制。',{exact:false}).waitFor();assert.equal(await note.inputValue(),'本机保留失败时的未提交意见');
 results.push({check:'retained draft survives navigation/remount; failed storage blocks scene/history/subpage changes and allows folding',cancelled:cancelled.length});
 await note.fill('');await settle();
 await page.evaluate(()=>{window.__cancelNavigation=e=>e.preventDefault();window.addEventListener('review:configuration-before-leave',window.__cancelNavigation);});await activate(stage('SCENE_EDIT'));assert.equal(page.url(),protectedUrl);assert.equal(await stage('SHOT_PRODUCTION').getAttribute('aria-pressed'),'true');await page.evaluate(()=>window.removeEventListener('review:configuration-before-leave',window.__cancelNavigation));
 results.push({check:'rejected leave does not change the visible module or URL',passed:true});
 for(const width of [390,320]){
  await page.setViewportSize({width,height:844});
  for(const group of CREATOR_PRODUCTION_STAGES){
   await page.goto(link(group.id,group.defaultGateId),{waitUntil:'networkidle'});
   for(const id of group.gateIds){
    if(group.exportGateIds.includes(id)&&!(await gate(id).isVisible()))await activate(page.locator('.preparation-export-checks>summary'));
    await activate(gate(id));await current(id,first.episodeUid,group.scope==='SCENE'?scene:undefined);
    if(group.scope==='SCENE'){for(const episode of episodes)await setOpen(episode.episodeUid,true);const before=await rect(main);for(const episode of episodes)await setOpen(episode.episodeUid,false);assert.deepEqual(await rect(main),before);}
    const overflow=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,elements:Array.from(document.querySelectorAll('body *')).filter(e=>e.getBoundingClientRect().right>innerWidth+1).slice(0,15).map(e=>({tag:e.tagName,className:e.className,right:e.getBoundingClientRect().right}))}));
    assert.ok(overflow.scrollWidth<=overflow.width+1,`No horizontal overflow: ${width} ${id} ${JSON.stringify(overflow)}`);
    results.push({check:'narrow layout preserves independent geometry without overflow',width,gate:id});
   }
   await page.evaluate(()=>scrollTo(0,0));await settle();await page.screenshot({path:path.join(out,slug(group.id)+'-'+width+'.png')});
  }
 }
 assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
 const sources=Object.fromEntries(['web/app/production-preparation-workspace.tsx','web/app/preparation-navigation.tsx','web/app/preparation-workspace.css','tests/production-navigation.ui.mjs','tests/workspace-navigation.ui.mjs'].map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')]));
 const report={status:'PASS',sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sourceSha256:sources,mode:isolated?'isolated-react-component-fixture':'isolated-full-app-fixture',gates:15,results,browserWriteCount:writes.length,serverWriteCount:fixture?.requests.filter(r=>r.method!=='GET').length,errors,limitations:isolated?['No real story or deployed-page acceptance','Component fixture simulates downstream workbench and host data adapters; full-app inheritance and host navigation remain coordinator checks']:['Isolated mirror uses the original app; deployed current-story Chrome acceptance is separate']};
 writeFileSync(path.join(out,'verification-ui.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}catch(error){writeFileSync(path.join(out,'failure.txt'),String(error.stack||error));throw error;}
finally{await browser?.close();await fixture?.close();}
