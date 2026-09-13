import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {chromium} from '@playwright/test';
import {requiredPhase} from '../tools/process-resources.mjs';
assert.ok(await requiredPhase(process.cwd()));
const base=process.env.REVIEW_UI_BASE||'http://127.0.0.1:3916',out=process.env.REVIEW_UI_ARTIFACT_DIR||process.env.REVIEW_TASK_DIR;
mkdirSync(out,{recursive:true});
const get=p=>fetch(base+'/api/v1/'+p).then(async r=>{assert.equal(r.status,200);return r.json()});
const domain=await get('workspaces/domain-workspaces?owner=MATERIAL'),model=(await get('workspaces/views/material-catalog')).page;
const selected=[];
for(const [entityType,media]of [['CHARACTER','IMAGE'],['PROP','IMAGE'],['CHARACTER','AUDIO']]){
 const q=domain.requirements.find(q=>domain.graph.entities.find(e=>e.id===q.entityRef)?.type===entityType&&q.assetFamilyRefs.some(id=>model.assetVersions.some(v=>v.familyId===id&&v.mediaKind===media&&v.outputState==='PRESENT'&&v.historyRole!=='HISTORICAL')));
 assert.ok(q,entityType+' '+media);const v=model.assetVersions.find(v=>q.assetFamilyRefs.includes(v.familyId)&&v.mediaKind===media&&v.outputState==='PRESENT'&&v.historyRole!=='HISTORICAL');selected.push({q,v,entityType,media});
}
const browser=await chromium.launch({channel:'chrome'}),page=await browser.newPage({viewport:{width:1440,height:1000}}),writes=[],errors=[],focuses=[];
page.on('request',r=>{if(r.method()==='POST'&&r.url().includes('/api/'))writes.push(r.url());});page.on('pageerror',e=>errors.push(e.message));
try{
 for(const [i,{q,v,entityType,media}]of selected.entries()){
  const focus=await get('workspaces/material-review-focus?'+new URLSearchParams({requirementId:q.id,versionId:v.id}));assert.ok(focus.sections.length);assert.ok(focus.sources.some(s=>s.objectId===q.entityRef));focuses.push(focus.sections.map(s=>s.text).join('\n'));
  await page.goto(base+'/?view=materials&material='+encodeURIComponent(q.id)+'&family='+encodeURIComponent(v.familyId)+'&version='+encodeURIComponent(v.id),{waitUntil:'networkidle'});
  const form=page.locator('.material-review-form');await form.getByRole('heading',{name:'此素材的关注重点'}).waitFor();await form.scrollIntoViewIfNeeded();
  assert.equal(await form.getByRole('textbox',{name:'整体审阅说明',exact:true}).count(),1);assert.equal(await form.getByRole('button',{name:'禁止使用',exact:true}).count(),0);
  await page.screenshot({path:out+'/material-'+i+'-desktop.png'});
  await page.setViewportSize({width:390,height:844});await form.scrollIntoViewIfNeeded();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));await page.screenshot({path:out+'/material-'+i+'-narrow.png'});await page.setViewportSize({width:1440,height:1000});
  console.log(JSON.stringify({entityType,media,requirement:q.id,version:v.id,focusSections:focus.sections.length,missing:focus.missing.length,sources:focus.sources.length}));
 }
 assert.equal(new Set(focuses).size,3,'business focus must differ across actual business attributes');assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
 console.log('PASS three actual material contexts, desktop/narrow, no business writes');
}finally{await browser.close();}
