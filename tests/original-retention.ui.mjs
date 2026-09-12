import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {requiredPhase} from '../tools/process-resources.mjs';
assert.ok(await requiredPhase(process.cwd()));
const base=process.env.REVIEW_UI_BASE||'http://127.0.0.1:3913';
const get=async p=>{const r=await fetch(base+'/api/v1/'+p);assert.equal(r.status,200);return r.json();};
assert.match((await get('workspaces/profile')).instanceId,/^ui-fixture-/);
const browser=await chromium.launch({channel:'chrome'});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/?view=story&storyMode=source',{waitUntil:'networkidle'});
 await page.getByRole('button',{name:'＋ 补充来源',exact:true}).click();
 await page.getByRole('textbox',{name:'资料名称',exact:true}).fill('保留来源草稿');await page.getByRole('textbox',{name:'来源正文',exact:true}).fill('尚未提交的原始依据');
 await page.goto(base+'/?view=settings',{waitUntil:'networkidle'});await page.goto(base+'/?view=story&storyMode=source',{waitUntil:'networkidle'});
 await page.getByRole('button',{name:'＋ 补充来源',exact:true}).click();
 assert.equal(await page.getByRole('textbox',{name:'资料名称',exact:true}).inputValue(),'保留来源草稿');assert.equal(await page.getByRole('textbox',{name:'来源正文',exact:true}).inputValue(),'尚未提交的原始依据');
 console.log('PASS source text draft survives navigation and reload');
 await page.goto(base+'/?view=system&systemTab=configuration',{waitUntil:'networkidle'});
 const title=page.getByRole('textbox',{name:'故事名称',exact:true}),original=await title.inputValue();await title.fill(original+' · 草稿保留验收');
 await page.goto(base+'/?view=materials',{waitUntil:'networkidle'});await page.goto(base+'/?view=system&systemTab=configuration',{waitUntil:'networkidle'});
 assert.equal(await title.inputValue(),original+' · 草稿保留验收');
 let intercepted=0,posts=0;page.on('request',r=>{if(r.method()==='PUT'&&new URL(r.url()).pathname==='/api/v1/workspaces/configuration')posts++;});
 await page.route('**/api/v1/workspaces/configuration',async route=>{if(route.request().method()!=='PUT'||intercepted){await route.continue();return;}intercepted++;const committed=await route.fetch();if(!committed.ok())console.log('save error',committed.status(),await committed.text());await route.abort('failed');});
 await page.getByRole('button',{name:'保存草稿',exact:true}).click();
 try{await page.getByText('草稿已保存，当前有效规则保持原版本',{exact:false}).waitFor({timeout:15000});}catch(e){console.log({intercepted,posts,alerts:await page.getByRole('alert').allTextContents()});throw e;}
 assert.equal(intercepted,1);assert.equal(posts,1);
 const config=await get('workspaces/configuration');assert.equal(config.draft.configuration.presentation.storyTitle,original+' · 草稿保留验收');assert.equal(config.configuration.presentation.storyTitle,original);
 console.log('PASS configuration draft original CAS, lost POST response recovered from operation, exactly one submission and no adoption');
 assert.deepEqual(errors,[]);
}finally{await browser.close();}
