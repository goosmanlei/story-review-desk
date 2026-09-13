import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chromium} from '@playwright/test';
import {requiredPhase} from '../tools/process-resources.mjs';
assert.ok(await requiredPhase(process.cwd()));
const base=process.env.REVIEW_UI_BASE||'http://127.0.0.1:3916';
const get=async p=>{const r=await fetch(base+'/api/v1/'+p);assert.equal(r.status,200);return r.json()};
assert.match((await get('workspaces/profile')).instanceId,/^ui-fixture-/);
const plan=(await get('workspaces/views/episode-plan')).plan,episode=plan.content.episodes[0];
const browser=await chromium.launch({channel:'chrome'});
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/?view=story&storyMode=logic&narrativeLevel=scene&episode='+encodeURIComponent(episode.episodeUid)+'&scene='+encodeURIComponent(episode.sceneIds[0]),{waitUntil:'networkidle'});
 const span=page.locator('.episode-scene-reader [data-comment-text]').first();await span.waitFor();await span.scrollIntoViewIfNeeded();
 await span.evaluate(el=>{const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);const text=walker.nextNode();const range=document.createRange();range.setStart(text,0);range.setEnd(text,Math.min(4,text.textContent.length));const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);el.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));});
 await page.getByRole('button',{name:'添加评论',exact:true}).click();
 const marker='未提交的隔离意见-'+randomUUID(),input=page.getByRole('textbox',{name:'修改意见',exact:true});await input.fill(marker);
 const feedback=await get('workspaces/story-feedback?episodeId='+encodeURIComponent(episode.episodeUid)+'&limit=100');assert(!feedback.feedback.some(f=>f.text===marker),'Unsaved draft is not saved feedback');
 await page.reload({waitUntil:'networkidle'});
 await page.getByRole('button',{name:/查看评论/}).click();await input.waitFor();assert.equal(await input.inputValue(),marker);
 const response=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/workspaces/script-comments'));
 await page.getByRole('button',{name:'提交评论',exact:true}).click();const saved=await response;assert.equal(saved.status(),200,await saved.text());
 const fresh=await get('workspaces/story-feedback?episodeId='+encodeURIComponent(episode.episodeUid)+'&limit=100');assert(fresh.feedback.some(f=>f.text===marker&&f.applicability==='CURRENT'));
 assert.equal(await page.getByText('编辑本稿',{exact:true}).count(),0);assert.deepEqual(errors,[]);
 console.log('PASS scene selection comment creation, draft survives reload, saved feedback readback, no direct edit entry');
} finally {await browser.close()}
