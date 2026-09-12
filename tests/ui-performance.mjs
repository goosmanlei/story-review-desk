import assert from 'node:assert/strict';
import {parseArgs} from 'node:util';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from '@playwright/test';
import {requiredPhase} from '../tools/process-resources.mjs';
import {originalModules,originalReady,timedInteraction} from './original-readiness.mjs';
const {values}=parseArgs({options:{url:{type:'string'},minutes:{type:'string',default:'60'},switches:{type:'string',default:'300'},saves:{type:'string',default:'100'}}});
const phase=await requiredPhase(process.cwd());assert(phase,'Use managed runner');
const base=values.url||process.env.REVIEW_UI_BASE;
const get=async p=>{const r=await fetch(base+'/api/v1/'+p);assert(r.ok,await r.clone().text());return r.json();};
const health=await get('health');assert.match(health.project.instanceId,/^ui-fixture-/);
const minutes=Number(values.minutes),steps=Number(values.switches),saveCount=Number(values.saves);
assert(minutes>=0&&steps>=30&&saveCount>0&&steps>=saveCount);
const plan=(await get('workspaces/views/episode-plan')).plan,episode=plan.content.episodes.at(-1),scene=episode.sceneIds.at(-1),other=episode.sceneIds[0];
assert.notEqual(scene,other);
const sceneURL=base+'/?view=story&storyMode=logic&narrativeLevel=scene&episode='+encodeURIComponent(episode.episodeUid)+'&scene='+encodeURIComponent(scene);
const original=await get('objects/'+encodeURIComponent(scene)),untouched=await get('objects/'+encodeURIComponent(other));
const browser=await chromium.launch({channel:'chrome',args:['--enable-precise-memory-info']});
const errors=[],cold=[],modules=[],scenes=[],saves=[],resources=[];
const observe=page=>{page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&/Cannot update|hydration|Each child/.test(m.text()))errors.push(m.text());});};
const stats=xs=>{const s=[...xs].sort((a,b)=>a-b);return{n:s.length,p50:Math.round(s[Math.floor(s.length/2)]||0),p95:Math.round(s[Math.min(s.length-1,Math.ceil(s.length*.95)-1)]||0),max:Math.round(s.at(-1)||0)};};
let report;
try{
 for(let i=0;i<5;i++){
  const ctx=await browser.newContext({viewport:{width:1440,height:1000}}),page=await ctx.newPage();observe(page);
  const cdp=await ctx.newCDPSession(page);await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
  await page.goto(base+'/?view=overview',{waitUntil:'domcontentloaded'});await originalReady(page,'overview');
  cold.push(await page.evaluate(()=>performance.now()));await ctx.close();
 }
 console.log(JSON.stringify({coldBrowserMs:cold.map(Math.round)}));
 const ctx=await browser.newContext({viewport:{width:1440,height:1000}}),page=await ctx.newPage();observe(page);
 const nav=label=>page.locator('.workspace-nav').getByRole('button',{name:new RegExp(label)});
 await page.goto(sceneURL);await originalReady(page,'story',scene);await nav('当前工作').click();await originalReady(page,'overview');
 for(let i=0;i<30;i++){
  const [view,label]=originalModules[(i+1)%6];
  const ms=await timedInteraction(page,nav(label),()=>originalReady(page,view));modules.push(ms);
  console.log(JSON.stringify({module:view,sample:i+1,ms:Math.round(ms)}));
 }
 await nav('故事创作').click();await originalReady(page,'story',scene);
 for(let i=0;i<40;i++){
  const id=i%2?scene:other;
  scenes.push(await timedInteraction(page,page.locator('.episode-scene-navigator button[data-scene-id="'+id+'"]'),()=>originalReady(page,'story',id)));
 }
 console.log(JSON.stringify({moduleMs:stats(modules),sceneMs:stats(scenes)}));
 const cdp=await ctx.newCDPSession(page);await cdp.send('HeapProfiler.enable');
 const sample=async()=>{const editor=page.getByRole('region',{name:'集场正文编辑'});if(await editor.isVisible())await page.getByText('编辑本稿',{exact:true}).click();await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));await cdp.send('HeapProfiler.collectGarbage');resources.push({at:Date.now(),...(await cdp.send('Memory.getDOMCounters')),heap:await page.evaluate(()=>performance.memory.usedJSHeapSize)});};
 await sample();
 const start=Date.now();let savedCount=0,version=original.version;
 for(let i=0;i<steps;i++){
  const [view,label]=originalModules[i%6];await nav(label).click();await originalReady(page,view);
  if(savedCount<Math.floor((i+1)*saveCount/steps)){
   await nav('故事创作').click();await originalReady(page,'story',scene);
   const editor=page.getByRole('region',{name:'集场正文编辑'});
   if(!await editor.isVisible())await page.getByText('编辑本稿',{exact:true}).click();
   const input=editor.getByRole('textbox',{name:'正文',exact:true}).first();await input.waitFor();
   const text=original.revision.content.blocks[0].text+'\n隔离持续使用验收 '+savedCount;
   await input.fill(text);
   if(savedCount%10===0){
    await nav('故事设定').click();await originalReady(page,'settings');await nav('故事创作').click();await originalReady(page,'story',scene);
    if(!await editor.isVisible())await page.getByText('编辑本稿',{exact:true}).click();
    assert.equal(await input.inputValue(),text,'Unsaved draft lost during navigation');
   }
   const ms=await timedInteraction(page,editor.getByRole('button',{name:'保存本稿草稿',exact:true}),async()=>{
    await editor.getByRole('status').filter({hasText:'草稿已保存'}).waitFor();
    const fresh=await get('objects/'+encodeURIComponent(scene));assert.equal(fresh.version,++version);assert.equal(fresh.revision.content.blocks[0].text,text);assert.equal(fresh.adoptedRevisionId,original.adoptedRevisionId);
   });saves.push(ms);savedCount++;
   await originalReady(page,'story',scene);
  }
  if(i%5===4)console.log(JSON.stringify({progress:i+1,saves:savedCount,elapsedSeconds:Math.round((Date.now()-start)/1000)}));
  if(i%25===24){await nav('故事创作').click();await originalReady(page,'story',scene);await sample();}
  const remaining=start+(i+1)*minutes*60000/steps-Date.now();if(remaining>0)await new Promise(r=>setTimeout(r,remaining));
 }
 await nav('故事创作').click();await originalReady(page,'story',scene);await sample();
 assert.equal((await get('objects/'+encodeURIComponent(other))).revision.id,untouched.revision.id,'Unrelated scene changed');
 const findings=[];
 if(!cold.every(x=>x<=3000))findings.push('Cold browser readiness exceeds 3 seconds');
 if(stats(modules).p95>500)findings.push('Module P95 exceeds 500 ms');
 if(stats(scenes).p95>300)findings.push('Scene P95 exceeds 300 ms');
 if(stats(saves).p95>1000)findings.push('Save/readback P95 exceeds 1 second');
 if(resources.at(-1).heap-resources[0].heap>32*1024*1024)findings.push('Retained heap growth exceeds 32 MiB after cache warmup');
 if(errors.length)findings.push('Browser errors');
 if(savedCount!==saveCount)findings.push('Save count mismatch');
 report={status:findings.length?'FAILED':'PASSED',software:health.softwareCommit,fixture:health.project.instanceId,browser:await browser.version(),viewport:{width:1440,height:1000},coldBrowserMs:cold.map(Math.round),moduleMs:stats(modules),sceneMs:stats(scenes),saveMs:stats(saves),soak:{minutes:(Date.now()-start)/60000,switches:steps,saves:savedCount,resources},findings,errors,realModelCalls:0,productionWrites:0};
 const output=path.resolve('.process/stages/ui-performance-'+Date.now());await phase.directory(output);await writeFile(path.join(output,'performance.json'),JSON.stringify(report,null,2));await phase.transfer('path',output,'local-delivery');
 console.log(JSON.stringify({...report,reportPath:path.join(output,'performance.json')}));
 if(findings.length)process.exitCode=1;
}finally{await browser.close();}
