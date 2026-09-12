import assert from 'node:assert/strict';
import {parseArgs} from 'node:util';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from '@playwright/test';
import {requiredPhase} from '../tools/process-resources.mjs';
import {originalModules,originalReady} from './original-readiness.mjs';
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
