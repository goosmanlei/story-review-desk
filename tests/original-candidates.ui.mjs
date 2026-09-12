import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {requiredPhase} from '../tools/process-resources.mjs';
assert.ok(await requiredPhase(process.cwd()),'Use managed runner');
const base=process.env.REVIEW_UI_BASE||'http://127.0.0.1:3913';
const directory=await fetch(base+'/api/v1/workspaces/material-directory').then(r=>r.json());
const browser=await chromium.launch({channel:'chrome'});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=400&&r.url().includes('/api/'))errors.push(r.status()+' '+r.url());});
 const scopes=[...new Set(directory.trials.flatMap(t=>t.versions.map(v=>v.scopeId)))];
 for(const scopeId of scopes){const trial=directory.trials.find(t=>t.versions.some(v=>v.scopeId===scopeId));
   await page.goto(base+'/?view=materials&materialPanel=material&materialTrial='+encodeURIComponent(trial.trialThemeId)+'&entity='+encodeURIComponent(trial.entityId),{waitUntil:'networkidle'});
   const detail=page.getByRole('region',{name:'统一素材详情'});await detail.waitFor();
   assert.ok((await detail.innerText()).includes('独立试制'));assert.ok(await detail.locator('img,video,audio').count());
   assert.deepEqual((await page.getByRole('alert').allTextContents()).filter(s=>s.trim()),[]);
 }
 assert.deepEqual(errors,[]);console.log('PASS both independent candidate scopes in the original unified material drawer');
}finally{await browser.close();}
