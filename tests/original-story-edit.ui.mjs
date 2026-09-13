import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {requiredPhase} from '../tools/process-resources.mjs';
assert.ok(await requiredPhase(process.cwd()),'Use managed runner');
const base=process.env.REVIEW_UI_BASE||'http://127.0.0.1:3913';
const get=async path=>{const r=await fetch(base+'/api/v1/'+path);assert.equal(r.status,200);return r.json();};
const profile=await get('workspaces/profile');assert.match(profile.instanceId,/^ui-fixture-/);
const plan=(await get('workspaces/views/episode-plan')).plan,episode=plan.content.episodes.at(-1),id=episode.sceneIds.at(-1);
const before=await get('workspaces/story-editing?objectId='+encodeURIComponent(id));
const beforeObject=await get('objects/'+encodeURIComponent(id));
const otherId=episode.sceneIds[0],other=await get('objects/'+encodeURIComponent(otherId));
const browser=await chromium.launch({channel:'chrome'});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const url=base+'/?view=story&storyMode=logic&narrativeLevel=scene&episode='+encodeURIComponent(episode.episodeUid)+'&scene='+encodeURIComponent(id);
 await page.goto(url,{waitUntil:'networkidle'});await page.locator('.episode-scene-reader').waitFor();
 assert.equal(await page.getByText('编辑本稿',{exact:true}).count(),0);
 const original=before.content.blocks[0].text,text=original+'\n仅隔离编辑接口验证 '+crypto.randomUUID();
 const blocks=before.content.blocks.map((b,index)=>({id:b.id,type:b.type,text:index===0?text:b.text,speaker:b.speaker||'',performanceNote:b.performanceNote||''}));
 const saved=await fetch(base+'/api/v1/workspaces/story-editing',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID(),'X-Review-Runtime':profile.deployment.runtimeEpoch},body:JSON.stringify({objectId:id,revisionId:before.revisionId,expectedVersion:before.expectedVersion,title:before.title,content:{blocks}})});
 assert.equal(saved.status,200,await saved.text());
 const after=await get('objects/'+encodeURIComponent(id));assert.equal(after.state,'DRAFT');assert.equal(after.revision.content.blocks[0].id,before.content.blocks[0].id);assert.equal(after.revision.content.blocks[0].text,text);assert.equal(after.adoptedRevisionId,beforeObject.adoptedRevisionId);
 assert.equal((await get('objects/'+encodeURIComponent(otherId))).revision.id,other.revision.id);
 const stale=await fetch(base+'/api/v1/workspaces/story-editing',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID(),'X-Review-Runtime':profile.deployment.runtimeEpoch},body:JSON.stringify({objectId:id,revisionId:before.revisionId,expectedVersion:before.expectedVersion,title:before.title,content:{blocks:before.content.blocks}})});assert.equal(stale.status,409);
 assert.deepEqual(errors,[]);console.log('PASS original scene reader, no direct edit entry, generic editing API retains stable block identity and save/readback, precise version conflict, unrelated scene unchanged');
}finally{await browser.close();}
