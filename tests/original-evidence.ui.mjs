import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {requiredPhase} from '../tools/process-resources.mjs';
import {database,closeDatabase} from '../server/db.mjs';
assert(await requiredPhase(process.cwd()));
const base=process.env.REVIEW_UI_BASE||'http://127.0.0.1:3913',get=async p=>{const r=await fetch(base+'/api/v1/'+p);assert(r.ok);return r.json();};
const profile=await get('workspaces/profile');assert.match(profile.instanceId,/^ui-fixture-/);
const pool=await database();assert.equal((await pool.query('SELECT instance_id FROM project')).rows[0].instance_id,profile.instanceId);
const transaction=async commands=>{const r=await fetch(base+'/api/v1/transactions',{method:'POST',headers:{'Content-Type':'application/json','X-Review-Runtime':profile.deployment.runtimeEpoch},body:JSON.stringify({operationId:crypto.randomUUID(),commands})}),v=await r.json();assert.equal(v.status,'SUCCEEDED',JSON.stringify(v));return v;};
const id='evidence-ui:'+crypto.randomUUID(),original='原修订的完整正文，读取历史依据时必须保留这一版本。',changed='新稿正文不能替换原依据。';
await transaction([{type:'save',id,expectedVersion:0,kind:'SCENE',title:'隔离证据版本核验',content:{text:original}}]);
const old=await get('objects/'+encodeURIComponent(id));await transaction([{type:'save',id,expectedVersion:old.version,content:{text:changed}}]);
const browser=await chromium.launch({channel:'chrome'});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/?view=overview&evidenceRef='+encodeURIComponent('NARRATIVE:'+id+':'+old.revision.sha256));
 await page.getByText(original,{exact:true}).waitFor();assert.equal(await page.getByText(changed,{exact:true}).count(),0);await page.getByRole('button',{name:'关闭证据阅读器'}).click();
 const source=(await pool.query("SELECT logical_path FROM source_documents WHERE mime_type IN ('text/plain','text/markdown','application/json') AND octet_length(content_bytes)<60000 GROUP BY logical_path HAVING count(DISTINCT original_sha256)>1 ORDER BY logical_path LIMIT 1")).rows[0];assert(source,'Fixture needs a logical source with distinct historical bytes');
 const versions=(await pool.query('SELECT DISTINCT ON(original_sha256) revision_id,original_sha256 FROM source_documents WHERE logical_path=$1 ORDER BY original_sha256,revision_id LIMIT 2',[source.logical_path])).rows;
 await page.goto(base+'/?view=overview&evidenceRef='+encodeURIComponent(source.logical_path));await page.getByText('此来源保留了多个历史版本，请按原引用选择修订。',{exact:true}).waitFor();
 let delayed=false;
 await page.route('**/api/v1/workspaces/views/evidence?*',async route=>{const url=new URL(route.request().url());if(url.searchParams.get('sourceRevisionId')===versions[0].revision_id){delayed=true;const response=await route.fetch();await new Promise(r=>setTimeout(r,400));await route.fulfill({response}).catch(()=>{});}else await route.continue();});
 await page.getByRole('button',{name:'查看修订 '+versions[0].revision_id+' · SHA '+versions[0].original_sha256.slice(0,12),exact:true}).click();
 await page.getByRole('button',{name:'查看修订 '+versions[1].revision_id+' · SHA '+versions[1].original_sha256.slice(0,12),exact:true}).click();
 await page.locator('.evidence-reader article[data-source-sha256="'+versions[1].original_sha256+'"]').waitFor();
 await page.waitForTimeout(500);assert(delayed);assert.equal(await page.locator('.evidence-reader article').getAttribute('data-source-sha256'),versions[1].original_sha256);assert.deepEqual(errors,[]);
 console.log('PASS original evidence deep link preserves historical content; ambiguous sources require a revision; late responses cannot replace the selected version');
}finally{await browser.close();await closeDatabase();}
