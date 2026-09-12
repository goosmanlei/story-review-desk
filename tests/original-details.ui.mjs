import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { requiredPhase } from '../tools/process-resources.mjs';
const phase=await requiredPhase(process.cwd());if(!phase)throw Error('Use managed runner');
const base=process.env.REVIEW_UI_BASE||'http://127.0.0.1:3913';
const browser=await chromium.launch({channel:'chrome'});
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=400&&r.url().includes('/api/'))errors.push(r.status()+' '+r.url());});
 const domain=await fetch(base+'/api/v1/workspaces/domain-workspaces?owner=SETTINGS').then(r=>r.json()),entity=domain.graph.entities.find(e=>e.type==='CHARACTER'),location=domain.graph.entities.find(e=>e.type==='LOCATION'),representation=domain.graph.representations.find(r=>r.requirementIds.length),requirement=representation.requirementIds[0];assert(entity&&location&&representation);
 const failures=[];const cases=[['settings','&settingsEntity='+encodeURIComponent(entity.id)],['settings','&settingsSection=space&settingsEntity='+encodeURIComponent(location.id)],['materials','&material='+encodeURIComponent(requirement)],['materials','&materialPanel=definitions&materialDefinitionKind=representations&materialDefinitionId='+encodeURIComponent(representation.id)],['pipeline','&productionGate=storyboard-dialogue&productionPhase=previs'],['pipeline','&productionGate=animatic-lock&productionPhase=previs'],['materials','&materialCatalog=production'],['system','&systemTab=configuration']];
 for(const [view,extra]of cases) {
  errors.length=0;await page.goto(base+'/?view='+view+extra,{waitUntil:'networkidle'});
  const text=await page.locator('body').innerText(),alerts=(await page.getByRole('alert').allTextContents()).filter(a=>a.trim());if(errors.length||alerts.length||text.includes('工作区接口不存在'))failures.push({route:view+extra,errors,alerts});console.log(JSON.stringify({route:view+extra,errors:[...errors],alerts,dialogs:await page.getByRole('dialog').count()}));
 }
 await page.goto(base+'/?view=materials',{waitUntil:'networkidle'});
 console.log(JSON.stringify({materialFacetCounts:await page.locator('[data-material-facet=集] button').allTextContents()}));
 assert.deepEqual(failures,[]);
}finally{await browser.close();}
