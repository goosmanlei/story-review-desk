import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {requiredPhase} from '../tools/process-resources.mjs';
assert.ok(await requiredPhase(process.cwd()));
const base=process.env.REVIEW_UI_BASE||'http://127.0.0.1:3916';
const profile=await fetch(base+'/api/v1/workspaces/profile').then(r=>r.json());
assert.match(profile.instanceId,/^ui-fixture-/);
const browser=await chromium.launch({channel:'chrome'});
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],writes=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST')writes.push(r.url())});
 await page.goto(base+'/?view=story&storyMode=source',{waitUntil:'networkidle'});
 const root=page.locator('.unified-source-workspace'),nav=root.locator('.text-reader-index'),audio=root.locator('audio');
 await root.locator('.transcript-segments').waitFor();
 const sections=nav.getByRole('tab');assert.equal(await sections.count(),9);
 assert.equal(await sections.first().getAttribute('aria-selected'),'true');
 const transcript=nav.getByRole('button',{name:/主工作文本/}),outline=nav.getByRole('button',{name:/网友故事梗概/}),derived=nav.getByRole('button',{name:/整理稿/});
 for(const button of [transcript,outline,derived]) {
  const box=await button.boundingBox(),index=await nav.boundingBox();assert(box&&index&&box.y>=index.y&&box.y+box.height<=index.y+index.height,'All sources visible without scrolling');
 }
 for(const title of ['原始资料','整理文本','辅助资料'])assert.equal(await nav.getByRole('heading',{name:title,exact:true}).count(),0);
 const scroll=root.locator('.text-reader-scroll');await scroll.evaluate(e=>e.scrollTop=220);
 const position=await scroll.evaluate(e=>e.scrollTop),text=await scroll.innerText();
 await nav.getByRole('button',{name:'折叠逐字稿目录',exact:true}).click();
 assert.equal(await sections.count(),0);assert.equal(await scroll.innerText(),text);assert.equal(await scroll.evaluate(e=>e.scrollTop),position);
 await nav.getByRole('button',{name:'展开逐字稿目录',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.source-reader-main audio')?.readyState>=1);
 await audio.evaluate(async a=>{window.__sourceAudio=a;a.muted=true;a.currentTime=20;await a.play()});
 const start=await audio.evaluate(a=>a.currentTime);
 for(const button of [outline,derived,transcript,sections.nth(1)]) {
  await button.click();await root.locator('.text-reader-document').waitFor();
  assert.equal(await audio.count(),1);assert.equal(await audio.evaluate(a=>a===window.__sourceAudio),true);
  assert.equal(await audio.evaluate(a=>a.paused),false);assert((await audio.evaluate(a=>a.currentTime))>=start);
 }
 await root.locator('.transcript-segments article button').first().click();
 const time=await root.locator('.transcript-segments article time').first().innerText();
 const seconds=time.split(':').reduce((sum,n)=>sum*60+Number(n),0);
 assert(Math.abs((await audio.evaluate(a=>a.currentTime))-seconds)<3);
 await audio.evaluate(a=>a.pause());const pausedAt=await audio.evaluate(a=>a.currentTime);
 await derived.click();await root.locator('.empty-source-text').waitFor();assert.equal(await audio.evaluate(a=>a.paused),true);
 assert.equal(await audio.evaluate(a=>a.currentTime),pausedAt);
 const derivedText=await root.locator('.text-reader-scroll').innerText();
 await nav.getByRole('button',{name:'折叠逐字稿目录',exact:true}).click();assert.equal(await root.locator('.text-reader-scroll').innerText(),derivedText);
 assert.equal(await audio.evaluate(a=>Boolean(a.closest('.text-reader-scroll'))),false);
 assert.equal(await nav.getByRole('button',{name:'＋ 补充来源',exact:true}).count(),1);
 if(process.env.REVIEW_SCREENSHOT)await root.screenshot({path:process.env.REVIEW_SCREENSHOT});
 assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
 console.log(JSON.stringify({status:'PASSED',checks:['default 9 sections and first part','3 visible sibling sources','independent fold and scroll','single persistent player','playing and paused states retained','timecode seeks same player','source import retained','no business writes'],observedAudio:'playback state only, no content listening'}));
} finally {await browser.close()}
