import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {requiredPhase} from '../tools/process-resources.mjs';
assert.ok(await requiredPhase(process.cwd()));
const base=process.env.REVIEW_UI_BASE||'http://127.0.0.1:3913',history=await fetch(base+'/api/v1/workspaces/story-history').then(r=>r.json());
const browser=await chromium.launch({channel:'chrome'});
try{const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.url().includes('/api/')&&r.status()>=400)errors.push(r.status()+' '+r.url());});
for(const item of [history.items[0],history.items.at(-1)]){for(const mode of ['story-structure','logic']){await page.goto(base+'/?view=story&storyMode='+mode+'&episodePlanArchive=1&episodePlanRevision='+encodeURIComponent(item.revisionId),{waitUntil:'networkidle'});assert.equal(await page.getByRole('button',{name:'保存正文草稿',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'确认并采用',exact:true}).count(),0);console.log(JSON.stringify({revisionId:item.revisionId,mode,title:(await page.title()),errors:[...errors]}));}}
assert.deepEqual(errors,[]);console.log('PASS earliest and latest original historical plan UI and read-only boundaries');
}finally{await browser.close();}
