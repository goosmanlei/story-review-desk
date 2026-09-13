import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {chromium} from '@playwright/test';
import {requiredPhase} from '../tools/process-resources.mjs';
import {CREATOR_PRODUCTION_STAGES,creatorProductionGateDefinition} from '../web/presentation/creator-production-workflow.mjs';
assert.ok(await requiredPhase(process.cwd()));
const base=process.env.REVIEW_UI_BASE||'http://127.0.0.1:3916',out=process.env.REVIEW_UI_ARTIFACT_DIR||process.env.REVIEW_TASK_DIR;
mkdirSync(out,{recursive:true});
const preparation=await (await fetch(base+'/api/v1/workspaces/production-preparation')).json(),episodes=preparation.candidate?.episodes||preparation.content.episodes;
assert.ok(episodes.length>=2&&episodes[0].sceneIds.length>=2);
const [first,second]=episodes,scene=first.sceneIds[1],slug=s=>s.toLowerCase().replaceAll('_','-');
const link=(stage,gate,episode=first.episodeUid,sceneId=scene)=>base+'/?'+new URLSearchParams({view:'pipeline',creatorStage:slug(stage),productionGate:slug(gate),preparationEpisode:episode,...(stage!=='EPISODE_EDIT'?{preparationScene:sceneId}:{})});
const browser=await chromium.launch({channel:'chrome'}),page=await browser.newPage({viewport:{width:1440,height:1000}}),writes=[],errors=[],results=[];
page.on('request',r=>{if(r.method()==='POST'&&r.url().includes('/api/'))writes.push(r.url());});page.on('pageerror',e=>errors.push(e.message));
const main=page.locator('.preparation-stage-workspace'),directory=page.locator('.preparation-scene-directory');
const ep=id=>page.locator(`[data-preparation-episode="${id}"]`),sc=id=>page.locator(`[data-preparation-scene="${id}"]`),toggle=id=>page.locator(`[data-preparation-toggle="${id}"]`),gate=id=>page.locator(`[data-production-check="${id}"]`),stage=id=>page.locator(`[data-creator-stage="${id}"]`);
const settle=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
async function current(gateId,episodeId,sceneId){
 await page.waitForFunction(({gateId,episodeId,sceneId})=>{const m=document.querySelector('.preparation-stage-workspace');return m?.getAttribute('data-preparation-current-gate')===gateId&&m.getAttribute('data-preparation-current-episode')===episodeId&&(m.getAttribute('data-preparation-current-scene')||'')===sceneId;},{gateId,episodeId,sceneId:sceneId||''});
 await page.waitForFunction(()=>document.querySelector('.preparation-stage-workspace .workspace-read-boundary')?.getAttribute('aria-busy')==='false');
 assert.equal(await ep(episodeId).getAttribute('aria-pressed'),'true');
 if(sceneId)assert.equal(await sc(sceneId).getAttribute('aria-current'),'location');
 const d=await directory.boundingBox(),m=await main.boundingBox();assert.ok(d.x+d.width<=m.x&&Math.abs(d.y-m.y)<2);
 assert.equal(await page.locator('.preparation-episode-chips').count(),0);
}
try{
 await page.goto(link('SHOT_PRODUCTION','SHOT_PLAN_INPUT_LOCK'),{waitUntil:'networkidle'});await current('SHOT_PLAN_INPUT_LOCK',first.episodeUid,scene);
 const before=await main.boundingBox();await toggle(second.episodeUid).click();await settle();assert.deepEqual(await main.boundingBox(),before);await toggle(second.episodeUid).click();await settle();assert.deepEqual(await main.boundingBox(),before);
 assert.equal(await sc(second.sceneIds[0]).isVisible(),false);assert.equal(await toggle(second.episodeUid).getAttribute('aria-expanded'),'false');
 results.push({check:'expand/collapse leaves right content geometry unchanged',rect:before});
 await main.evaluate(e=>e.scrollTop=240);await directory.evaluate(e=>e.scrollTop=110);await settle();const reading=await main.evaluate(e=>e.scrollTop),navReading=await directory.evaluate(e=>e.scrollTop);assert.ok(reading>=230&&navReading>=100);
 let release,entered,finished;const held=new Promise(r=>release=r),started=new Promise(r=>entered=r),completed=new Promise(r=>finished=r);
 const holdRead=async route=>{entered();await held;try{await route.continue();}finally{finished();}};
 await page.route('**/api/v1/workspaces/views/production?*gateId=STORYBOARD_DIALOGUE*',holdRead);
 await gate('STORYBOARD_DIALOGUE').click();await started;await settle();assert.ok(await directory.isVisible());assert.ok(await stage('SHOT_PRODUCTION').isVisible());assert.deepEqual(await main.boundingBox(),before);assert.equal(await page.locator('.preparation-stage-workspace .workspace-read-boundary').getAttribute('aria-busy'),'true');assert.equal(await page.locator('.preparation-stage-workspace [inert]').count(),1);
 release();await completed;await page.unroute('**/api/v1/workspaces/views/production?*gateId=STORYBOARD_DIALOGUE*',holdRead);await current('STORYBOARD_DIALOGUE',first.episodeUid,scene);
 results.push({check:'held production read keeps navigation and layout visible while content is inert',passed:true});assert.equal(await directory.evaluate(e=>e.scrollTop),navReading);assert.equal(await toggle(second.episodeUid).getAttribute('aria-expanded'),'false');
 await gate('SHOT_PLAN_INPUT_LOCK').click();await current('SHOT_PLAN_INPUT_LOCK',first.episodeUid,scene);await page.waitForFunction(v=>Math.abs(document.querySelector('.preparation-stage-workspace').scrollTop-v)<2,reading);
 results.push({check:'submenu round trip preserves exact scene, collapse, directory and content reading',reading,navReading});
 for(const group of CREATOR_PRODUCTION_STAGES){
  await stage(group.id).click();
  for(const id of group.gateIds){
   if(group.exportGateIds.includes(id)&&!(await gate(id).isVisible()))await page.locator('.preparation-export-checks>summary').click();
   await gate(id).click();await current(id,first.episodeUid,group.scope==='SCENE'?scene:undefined);
   assert.equal(await toggle(first.episodeUid).count(),group.scope==='SCENE'?1:0);
   assert.equal(await main.getAttribute('data-creator-scope'),creatorProductionGateDefinition(id).scopeType==='PROJECT'?'PROJECT':group.scope);
   assert.equal(new URL(page.url()).searchParams.get('preparationScene'),group.scope==='SCENE'?scene:null);
   results.push({check:'submenu uses shared left navigation and precise context',stage:group.id,gate:id});
  }
 }
 await ep(second.episodeUid).click();await current('DELIVERY_ARCHIVE',second.episodeUid);assert.equal(await sc(scene).count(),0);
 await ep(first.episodeUid).click();await stage('SCENE_EDIT').click();await current('PICTURE_LOCK',first.episodeUid,scene);
 await toggle(second.episodeUid).click();await sc(second.sceneIds[1]).click();await current('PICTURE_LOCK',second.episodeUid,second.sceneIds[1]);
 await ep(first.episodeUid).click();await current('PICTURE_LOCK',first.episodeUid,scene);await ep(second.episodeUid).click();await current('PICTURE_LOCK',second.episodeUid,second.sceneIds[1]);
 await page.goBack();await current('PICTURE_LOCK',first.episodeUid,scene);await page.goForward();await current('PICTURE_LOCK',second.episodeUid,second.sceneIds[1]);
 results.push({check:'episode-only menu, valid last scene per episode, cross-episode scene and history navigation',passed:true});
 for(const group of CREATOR_PRODUCTION_STAGES){
  await page.goto(link(group.id,group.defaultGateId),{waitUntil:'networkidle'});await current(group.defaultGateId,first.episodeUid,group.scope==='SCENE'?scene:undefined);
  await main.evaluate(e=>e.scrollTop=0);await directory.evaluate(e=>e.scrollTop=0);await settle();await page.screenshot({path:out+'/'+slug(group.id)+'-desktop.png'});
 }
 await page.goto(link('SCENE_EDIT','SCENE_QA','missing-permanent-episode',scene),{waitUntil:'networkidle'});await page.getByText('此链接的永久集身份不在当前准备稿中。',{exact:false}).waitFor();assert.equal(await main.getAttribute('data-preparation-current-episode'),null);
 await ep(first.episodeUid).click();await current('SCENE_QA',first.episodeUid,scene);
 await page.goto(link('SCENE_EDIT','PICTURE_LOCK',first.episodeUid,second.sceneIds[0]),{waitUntil:'networkidle'});await page.getByText('此链接的永久集与场身份不匹配。',{exact:false}).waitFor();assert.equal(await main.getAttribute('data-preparation-current-scene'),null);
 results.push({check:'deep links locate all modules; missing and mismatched permanent identities remain errors',passed:true});
 await page.goto(link('SHOT_PRODUCTION','SHOT_PLAN_INPUT_LOCK'),{waitUntil:'networkidle'});await current('SHOT_PLAN_INPUT_LOCK',first.episodeUid,scene);
 const note=page.getByRole('textbox',{name:'本场准备意见',exact:true});await note.fill('浏览器隔离测试：未提交的准备意见');await ep(second.episodeUid).click();await ep(first.episodeUid).click();assert.equal(await note.inputValue(),'浏览器隔离测试：未提交的准备意见');
 await page.evaluate(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.includes('editor-draft:preparation:'))throw Error('fixture storage unavailable');return original.call(this,k,v);};});await note.fill('本机保留失败时的未提交意见');await settle();
 const cancelled=[];page.on('dialog',async d=>{cancelled.push(d.message());await d.dismiss();});const protectedUrl=page.url();
 for(const action of [()=>ep(second.episodeUid).click(),()=>page.goBack()]){const n=cancelled.length;await action();await settle();assert.equal(cancelled.length,n+1);assert.equal(page.url(),protectedUrl);assert.equal(await note.inputValue(),'本机保留失败时的未提交意见');}
 await gate('STORYBOARD_DIALOGUE').click();assert.equal(page.url(),protectedUrl);await page.getByText('本机草稿未能保留，请先保存或复制。',{exact:false}).waitFor();assert.equal(await note.inputValue(),'本机保留失败时的未提交意见');
 results.push({check:'retained draft survives context switches; unavailable draft storage protects episode/history/submenu navigation',cancelled:cancelled.length});
 await note.fill('');await settle();
 await page.evaluate(()=>{window.__cancelNavigation=e=>e.preventDefault();window.addEventListener('review:configuration-before-leave',window.__cancelNavigation);});await stage('SCENE_EDIT').click();assert.equal(page.url(),protectedUrl);assert.equal(await stage('SHOT_PRODUCTION').getAttribute('aria-pressed'),'true');await page.evaluate(()=>window.removeEventListener('review:configuration-before-leave',window.__cancelNavigation));
 results.push({check:'parent rejection does not prematurely change visible module',passed:true});
 await page.setViewportSize({width:390,height:844});
 for(const group of CREATOR_PRODUCTION_STAGES){await page.goto(link(group.id,group.defaultGateId),{waitUntil:'networkidle'});await current(group.defaultGateId,first.episodeUid,group.scope==='SCENE'?scene:undefined);await main.evaluate(e=>e.scrollTop=0);await directory.evaluate(e=>e.scrollTop=0);await settle();await page.screenshot({path:out+'/'+slug(group.id)+'-narrow.png'});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));}
 assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);writeFileSync(out+'/verification-ui.json',JSON.stringify({status:'PASS',base,episodes:episodes.length,scenes:preparation.candidate?.scenes.length,results,browserPostCount:writes.length,errors},null,2)+'\n');console.log(JSON.stringify({status:'PASS',checks:results.length,browserPostCount:writes.length}));
}finally{await browser.close();}
