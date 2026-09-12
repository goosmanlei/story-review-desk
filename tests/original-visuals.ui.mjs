import assert from 'node:assert/strict';
import path from 'node:path';
import {writeFile} from 'node:fs/promises';
import {chromium} from '@playwright/test';
import {requiredPhase} from '../tools/process-resources.mjs';
import {originalModules,originalReady} from './original-readiness.mjs';
const phase=await requiredPhase(process.cwd());assert(phase);
const base=process.env.REVIEW_UI_BASE||'http://127.0.0.1:3915',reference=process.env.REVIEW_UI_REFERENCE||'http://127.0.0.1:3914';
const directory=path.resolve('.process/stages/original-ui-visuals-'+Date.now());await phase.directory(directory);
const browser=await chromium.launch({channel:'chrome'}),records=[];
try{
 for(const [variant,url]of [['reference',reference],['current',base]]){
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  for(const [view,label]of originalModules){
   await page.goto(url+'/?view='+view);await originalReady(page,view);
   const metrics=await page.locator('.workspace-nav').evaluate(node=>{const r=node.getBoundingClientRect(),s=getComputedStyle(node),button=node.querySelector('button'),b=getComputedStyle(button);return {x:r.x,y:r.y,width:r.width,height:r.height,background:s.backgroundColor,fontFamily:b.fontFamily,fontSize:b.fontSize,color:b.color};});
   records.push({variant,view,label,metrics});await page.screenshot({path:path.join(directory,variant+'-'+view+'.png')});
  }
  await page.close();
 }
 for(const [view]of originalModules)assert.deepEqual(records.find(r=>r.variant==='current'&&r.view===view).metrics,records.find(r=>r.variant==='reference'&&r.view===view).metrics,'Original navigation geometry and typography: '+view);
 await writeFile(path.join(directory,'visuals.json'),JSON.stringify({status:'PASSED',viewport:{width:1440,height:1000},records},null,2));await phase.transfer('path',directory,'local-delivery');
 console.log(JSON.stringify({status:'PASSED',originalNavigationGeometry:true,views:6,directory}));
}finally{await browser.close();}
