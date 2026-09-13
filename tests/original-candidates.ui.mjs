import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {requiredPhase} from '../tools/process-resources.mjs';
assert.ok(await requiredPhase(process.cwd()),'Use managed runner');
const base=process.env.REVIEW_UI_BASE||'http://127.0.0.1:3913';
const catalog=await fetch(base+'/api/v1/workspaces/views/material-catalog').then(r=>r.json());
const retained=catalog.page.materialRequirements.filter(r=>r.requirementClass==='OPTIONAL');assert(retained.length);
const browser=await chromium.launch({channel:'chrome'});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=400&&r.url().includes('/api/'))errors.push(r.status()+' '+r.url());});
 for(const row of retained){
   await page.goto(base+'/?view=materials&material='+encodeURIComponent(row.id),{waitUntil:'networkidle'});
   const detail=page.getByRole('region',{name:'统一素材详情'});await detail.waitFor();
   assert.ok((await detail.innerText()).includes(row.title));assert.ok(await detail.locator('img,video,audio').count());
   assert.deepEqual((await page.getByRole('alert').allTextContents()).filter(s=>s.trim()),[]);
 }
 assert.deepEqual(errors,[]);console.log(JSON.stringify({status:'PASS',retainedFamilies:retained.length,checks:['original unified drawer','native version media','ordinary candidate detail']}));
}finally{await browser.close();}
