import assert from 'node:assert/strict';
import {parseArgs} from 'node:util';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium} from '@playwright/test';
import {requiredPhase} from '../tools/process-resources.mjs';
import {originalModules,originalReady} from './original-readiness.mjs';
async function workspaceNavigation(){
const {values}=parseArgs({options:{url:{type:'string'},output:{type:'string'}}});
assert(await requiredPhase(process.cwd()),'Use managed runner');
const base=values.url||process.env.REVIEW_UI_BASE||'http://127.0.0.1:3913';
const get=async p=>{const r=await fetch(base+'/api/v1/'+p);assert(r.ok);return r.json();};
const health=await get('health');assert.match(health.project.instanceId,/^ui-fixture-/);
const browser=await chromium.launch({channel:'chrome'}),errors=[],checked=[];
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/?view=overview');await originalReady(page,'overview');
 for(const [view,label]of originalModules){await page.locator('.workspace-nav').getByRole('button',{name:new RegExp(label)}).click();await originalReady(page,view);assert.equal(new URL(page.url()).searchParams.get('view'),view);checked.push(view);}
 const plan=(await get('workspaces/views/episode-plan')).plan,episode=plan.content.episodes.at(-1),scene=episode.sceneIds.at(-1);
 await page.goto(base+'/?view=story&storyMode=logic&narrativeLevel=scene&episode='+encodeURIComponent(episode.episodeUid)+'&scene='+encodeURIComponent(scene));await originalReady(page,'story',scene);
 const originalText=await page.locator('.episode-scene-reader [aria-label="本场完整正文"]').innerText();assert(originalText.length>50);
 await page.locator('.workspace-nav').getByRole('button',{name:/故事设定/}).click();await originalReady(page,'settings');
 await page.goBack();await originalReady(page,'story',scene);assert.equal(await page.locator('.episode-scene-reader [aria-label="本场完整正文"]').innerText(),originalText);checked.push('permanent scene deep link and browser back');
 await page.goto(base+'/settings');await originalReady(page,'system');await page.locator('#management-panel-configuration .configuration-page').waitFor();await page.getByRole('tab',{name:'系统配置',exact:true}).getAttribute('aria-selected').then(value=>assert.equal(value,'true'));assert.equal(new URL(page.url()).searchParams.get('systemTab'),'configuration');checked.push('settings deep link');
 assert.deepEqual(errors,[]);const report={status:'PASSED',checked,errors,fixture:health.project.instanceId,productionWrites:0,realModelCalls:0};
 if(values.output){const output=path.resolve(values.output),root=path.resolve(process.env.REVIEW_TASK_DIR);assert(output.startsWith(root+path.sep));await writeFile(output,JSON.stringify(report,null,2));}
 console.log(JSON.stringify(report));
}finally{await browser.close();}

}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await workspaceNavigation();

// Shared by the component fixture and full-app fixture. Geometry and actual
// scrolling are observed in Chromium; these checks do not inspect CSS strings.
export async function verifyPreparationReading(page,{first,second,scene,link,current,isolated}){
 const results=[],main=page.locator('.preparation-stage-workspace');
 const ep=id=>page.locator(`[data-preparation-episode="${id}"]`),sc=id=>page.locator(`[data-preparation-scene="${id}"]`),gate=id=>page.locator(`[data-production-check="${id}"]`);
 const activate=locator=>locator.dispatchEvent('click');
 const settle=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
 // The original app scrolls .workspace-main; the component fixture scrolls the document.
 const scrollSelector=isolated?null:'.workspace-main';
 const position=()=>main.evaluate((e,selector)=>{const host=selector?document.querySelector(selector):null;return (host?host.getBoundingClientRect().top+host.clientTop:0)-e.getBoundingClientRect().top;},scrollSelector);
 const readAt=async value=>{await main.evaluate((e,{value,selector})=>{const host=selector?document.querySelector(selector):null,origin=host?host.getBoundingClientRect().top+host.clientTop:0;(host||window).scrollTo({top:(host?host.scrollTop:scrollY)+e.getBoundingClientRect().top-origin+value,behavior:'instant'});},{value,selector:scrollSelector});await settle();return position();};
 const at=async value=>{await page.waitForFunction(({value,selector})=>{const e=document.querySelector('.preparation-stage-workspace'),host=selector?document.querySelector(selector):null;return Math.abs((host?host.getBoundingClientRect().top+host.clientTop:0)-e.getBoundingClientRect().top-value)<2;},{value,selector:scrollSelector});};
 const setOpen=async(id,open)=>{if(await ep(id).getAttribute('aria-expanded')!==String(open))await activate(ep(id));await settle();};
 await page.goto(link('SHOT_PRODUCTION','SHOT_PLAN_INPUT_LOCK'),{waitUntil:'networkidle'});await current('SHOT_PLAN_INPUT_LOCK',first.episodeUid,scene);
 const reading=await readAt(900);assert.ok(reading>850,'Long content is read with the actual page scrollport');assert.equal(await main.evaluate(e=>e.scrollTop),0);
 for(const id of [first.episodeUid,second.episodeUid,first.episodeUid,second.episodeUid]){await activate(ep(id));await settle();await at(reading);}
 const collapsed=await ep(first.episodeUid).getAttribute('aria-expanded');
 results.push({check:'folding current and other episodes preserves actual document reading',reading});

 const pattern='**/api/v1/workspaces/views/production?*gateId=STORYBOARD_DIALOGUE*';
 async function hold(){
  let release,entered,finished;const held=new Promise(r=>release=r),started=new Promise(r=>entered=r),done=new Promise(r=>finished=r);
  const route=async r=>{entered();await held;try{await r.continue();}finally{finished();}};
  await page.route(pattern,route);
  return {started,release:async()=>{release();await done;await page.unroute(pattern,route);}};
 }
 const held=await hold();
 try{
  await activate(gate('STORYBOARD_DIALOGUE'));await held.started;
  await page.waitForFunction(()=>document.querySelector('.preparation-stage-workspace .workspace-read-boundary')?.getAttribute('aria-busy')==='true');
  assert.ok(await page.locator('.preparation-scene-directory').isVisible());assert.equal(await page.locator('.preparation-stage-workspace [inert]').count(),1);
 }finally{await held.release();}
 await current('STORYBOARD_DIALOGUE',first.episodeUid,scene);
 const otherReading=await readAt(450);
 await activate(gate('SHOT_PLAN_INPUT_LOCK'));await current('SHOT_PLAN_INPUT_LOCK',first.episodeUid,scene);await at(reading);
 assert.equal(await ep(first.episodeUid).getAttribute('aria-expanded'),collapsed);
 await page.goBack();await current('STORYBOARD_DIALOGUE',first.episodeUid,scene);await at(otherReading);
 await page.goForward();await current('SHOT_PLAN_INPUT_LOCK',first.episodeUid,scene);await at(reading);
 results.push({check:'delayed reads retain mounted guards; subpage and browser history restore their own document offsets',reading,otherReading});

 if(isolated){
  // Content taller/shorter than the directory must not couple either height.
  const resize=async rows=>{await page.evaluate(rows=>window.dispatchEvent(new CustomEvent('fixture:rows',{detail:rows})),rows);await settle();};
  await resize(90);await at(reading);await resize(80);await at(reading);
  await page.mouse.move(800,400);await page.mouse.wheel(0,260);
  await page.waitForFunction(value=>-document.querySelector('.preparation-stage-workspace').getBoundingClientRect().top>value+120,reading);
  await settle();const userReading=await position();await resize(100);await at(userReading);await resize(90);await at(userReading);
  results.push({check:'resize does not repeatedly restore after success or override a user wheel scroll',userReading});
  // Wait on a visit that already has a checkpoint, then scroll before the read
  // completes. The pending checkpoint must never pull the user back later.
  const pending=await hold();let interrupted;
  try{
   await activate(gate('STORYBOARD_DIALOGUE'));await pending.started;
   await page.waitForFunction(()=>document.querySelector('.preparation-stage-workspace .workspace-read-boundary')?.getAttribute('aria-busy')==='true');
   await page.mouse.wheel(0,210);await page.waitForFunction(value=>-document.querySelector('.preparation-stage-workspace').getBoundingClientRect().top>value+80,userReading);await settle();interrupted=await position();
  }finally{await pending.release();}
  await current('STORYBOARD_DIALOGUE',first.episodeUid,scene);await at(interrupted);await resize(110);await at(interrupted);
  results.push({check:'active user scrolling cancels a pending restoration through delayed data and later resizes',interrupted});
  // A remount and reload restore the same instance/gate/episode/scene key.
  await activate(page.locator('[data-fixture-module]'));await page.waitForFunction(()=>!document.querySelector('.creator-production-workspace'));
  await activate(page.locator('[data-fixture-module]'));await current('STORYBOARD_DIALOGUE',first.episodeUid,scene);await at(interrupted);
  await page.reload({waitUntil:'networkidle'});await current('STORYBOARD_DIALOGUE',first.episodeUid,scene);await at(interrupted);
  const retained=await page.evaluate(()=>JSON.parse(Object.entries(sessionStorage).find(([key])=>key.endsWith(':production-navigation-v1'))[1]));
  assert.ok(Object.values(retained.reading).every(value=>typeof value==='number'));assert.deepEqual(Object.keys(retained).sort(),['expanded','reading','scenes']);
  results.push({check:'reading survives unmount/reload; navigation storage contains only identities, booleans and numeric offsets',passed:true});

  await page.evaluate(()=>{
   const storageKey=Object.keys(sessionStorage).find(key=>key.endsWith(':production-navigation-v1')),value=JSON.parse(sessionStorage.getItem(storageKey));
   const pageKey=Object.keys(value.reading).find(key=>key.startsWith('page:')&&JSON.parse(key.slice(5))[1]==='STORYBOARD_DIALOGUE');
   value.reading[pageKey.slice(5)]=675;delete value.reading[pageKey];sessionStorage.setItem(storageKey,JSON.stringify(value));
  });
  await page.reload({waitUntil:'networkidle'});await current('STORYBOARD_DIALOGUE',first.episodeUid,scene);await at(675);
  // Navigation above the body is a signed page offset, distinct from an
  // unvisited checkpoint or the first line of the body.
  const aboveBody=await readAt(-120);await activate(gate('SHOT_PLAN_INPUT_LOCK'));await current('SHOT_PLAN_INPUT_LOCK',first.episodeUid,scene);
  await activate(gate('STORYBOARD_DIALOGUE'));await current('STORYBOARD_DIALOGUE',first.episodeUid,scene);await at(aboveBody);
  results.push({check:'legacy pane checkpoints migrate; signed offsets above the body survive a round trip',aboveBody});

  // Hosts that scroll an outer workspace element use that scrollport, without
  // assigning a height or a scrollbar to either production column.
  await activate(page.locator('[data-fixture-module]'));await page.waitForFunction(()=>!document.querySelector('.creator-production-workspace'));
  await page.evaluate(()=>{scrollTo(0,0);Object.assign(document.getElementById('root').style,{height:'600px',overflowY:'auto'});});
  await activate(page.locator('[data-fixture-module]'));await current('STORYBOARD_DIALOGUE',first.episodeUid,scene);
  await main.evaluate(e=>{const host=document.getElementById('root');host.scrollTo(0,host.scrollTop+e.getBoundingClientRect().top-host.getBoundingClientRect().top+550);});await settle();
  const outerPosition=()=>main.evaluate(e=>document.getElementById('root').getBoundingClientRect().top-e.getBoundingClientRect().top);
  const outerReading=await outerPosition();assert.ok(outerReading>540);assert.equal(await page.evaluate(()=>scrollY),0);
  await activate(gate('SHOT_PLAN_INPUT_LOCK'));await current('SHOT_PLAN_INPUT_LOCK',first.episodeUid,scene);
  await activate(gate('STORYBOARD_DIALOGUE'));await current('STORYBOARD_DIALOGUE',first.episodeUid,scene);assert.ok(Math.abs(await outerPosition()-outerReading)<2);
  await activate(ep(first.episodeUid));await settle();assert.ok(Math.abs(await outerPosition()-outerReading)<2);
  await activate(page.locator('[data-fixture-module]'));await page.waitForFunction(()=>!document.querySelector('.creator-production-workspace'));
  await page.evaluate(()=>document.getElementById('root').removeAttribute('style'));
  await activate(page.locator('[data-fixture-module]'));await current('STORYBOARD_DIALOGUE',first.episodeUid,scene);
  results.push({check:'an outer workspace scrollport restores independently of window scroll',outerReading});

  await resize(0);await page.evaluate(()=>scrollTo(0,0));await settle();
  for(const id of await ep(first.episodeUid).evaluate(()=>Array.from(document.querySelectorAll('[data-preparation-episode]'),e=>e.dataset.preparationEpisode)))await setOpen(id,true);
  const geometry=await main.boundingBox(),directory=page.locator('.preparation-scene-directory');assert.ok((await directory.boundingBox()).height>geometry.height);
  await setOpen(first.episodeUid,false);await setOpen(second.episodeUid,false);assert.deepEqual(await main.boundingBox(),geometry);
  await resize(70);
  results.push({check:'long directory and short content have independent heights',passed:true});
 }

 await page.goto(link('SCENE_EDIT','PICTURE_LOCK'),{waitUntil:'networkidle'});await current('PICTURE_LOCK',first.episodeUid,scene);
 const firstReading=await readAt(420);await setOpen(second.episodeUid,true);await activate(sc(second.sceneIds[1]));await current('PICTURE_LOCK',second.episodeUid,second.sceneIds[1]);
 const secondReading=await readAt(660);
 await page.goBack();await current('PICTURE_LOCK',first.episodeUid,scene);await at(firstReading);
 await page.goForward();await current('PICTURE_LOCK',second.episodeUid,second.sceneIds[1]);await at(secondReading);
 results.push({check:'exact episode/scene checkpoints remain distinct through history navigation',firstReading,secondReading});
 return results;
}
