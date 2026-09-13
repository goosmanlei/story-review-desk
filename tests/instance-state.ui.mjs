import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {chromium} from '@playwright/test';
import {requiredPhase} from '../tools/process-resources.mjs';
assert.ok(await requiredPhase(process.cwd()));
const base=process.env.REVIEW_UI_BASE||'http://127.0.0.1:3916',out=process.env.REVIEW_UI_ARTIFACT_DIR||process.env.REVIEW_TASK_DIR;mkdirSync(out,{recursive:true});
const profile=await fetch(base+'/api/v1/workspaces/profile').then(r=>r.json()),oldEpoch=crypto.randomUUID(),oldDeployment='fixture-old-deployment',url=base+'/?view=story&storyMode=source';
const browser=await chromium.launch({channel:'chrome'}),page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],mutations=[],results=[];
page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(!['GET','HEAD','OPTIONS'].includes(r.method())&&r.url().includes('/api/v1/'))mutations.push({method:r.method(),url:r.url(),headers:r.headers()});});
let mode='loading',releaseLoading;const loadingGate=new Promise(r=>releaseLoading=r);
await page.route('**/api/v1/workspaces/profile',async route=>{
 const current=mode;if(current==='loading')await loadingGate;
 if(current==='error')return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'fixture unavailable'})});
 const body=structuredClone(profile);if(current==='old')Object.assign(body.deployment,{runtimeEpoch:oldEpoch,deploymentId:oldDeployment});if(current==='deployment')body.deployment.deploymentId='fixture-new-deployment';
 await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
});
const state=()=>page.locator('.instance-state-page'),action=()=>page.locator('.instance-state-action');
async function capture(name){
 await state().waitFor();
 for(const [label,size]of [['desktop',{width:1440,height:1000}],['narrow',{width:390,height:844}]]){
  await page.setViewportSize(size);const box=await page.locator('.instance-state-card').boundingBox();assert(box&&box.x>=16&&box.x+box.width<=size.width-15&&box.y>=16&&box.y+box.height<=size.height-15);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.equal(await page.locator('.instance-state-icon svg').count(),1);await page.screenshot({path:out+'/'+name+'-'+label+'.png'});
 }
 await page.setViewportSize({width:1440,height:1000});results.push({check:name+' desktop/narrow layout and actual screenshots',passed:true});
}
async function actionStates(){
 const button=action(),original=await button.evaluate(e=>getComputedStyle(e).backgroundColor);assert.notEqual(original,'rgba(0, 0, 0, 0)');
 await button.hover();await page.waitForFunction(color=>getComputedStyle(document.querySelector('.instance-state-action')).backgroundColor!==color,original);
 const box=await button.boundingBox();await page.mouse.down();await page.waitForFunction(()=>{const t=getComputedStyle(document.querySelector('.instance-state-action')).transform;return t!=='none'&&new DOMMatrix(t).m42>0;});await page.mouse.move(0,0);await page.mouse.up();
 // Release outside the button so this check does not activate the refresh.
 assert.ok(box);await page.keyboard.press('Tab');for(let i=0;i<4&&!await button.evaluate(e=>e===document.activeElement);i++)await page.keyboard.press('Tab');assert.ok(await button.evaluate(e=>e===document.activeElement));assert.notEqual(await button.evaluate(e=>getComputedStyle(e).outlineStyle),'none');
 results.push({check:'primary action default/hover/active/keyboard focus',passed:true});
}
async function keyboardReload(){
 const before=page.url(),navigation=page.waitForNavigation({waitUntil:'domcontentloaded'}),feedback=page.waitForFunction(()=>{const b=document.querySelector('.instance-state-action');return b?.disabled&&b.textContent.includes('正在重新加载');});await action().press('Enter');await feedback;const response=await navigation;assert.equal(response.request().url(),before);return before;
}
const enterSource=async()=>{await page.getByRole('button',{name:'＋ 补充来源',exact:true}).waitFor();await page.getByRole('button',{name:'＋ 补充来源',exact:true}).click();await page.getByRole('textbox',{name:'资料名称',exact:true}).waitFor();};
try{
 await page.goto(url,{waitUntil:'domcontentloaded'});await page.getByRole('heading',{name:'正在连接审阅台',exact:true}).waitFor();assert.equal(await state().getAttribute('aria-busy'),'true');assert.equal(await action().count(),0);await capture('loading');
 await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await page.locator('.instance-state-spinner').evaluate(e=>getComputedStyle(e).animationName),'none');await page.emulateMedia({reducedMotion:'no-preference'});
 mode='actual';releaseLoading();await state().waitFor({state:'hidden'});await enterSource();
 await page.getByRole('textbox',{name:'资料名称',exact:true}).fill('同一工作区保留草稿');await page.getByRole('textbox',{name:'来源正文',exact:true}).fill('仅浏览器未提交草稿');await page.reload({waitUntil:'networkidle'});await enterSource();assert.equal(await page.getByRole('textbox',{name:'资料名称',exact:true}).inputValue(),'同一工作区保留草稿');results.push({check:'normal workspace same-epoch draft survives reload',passed:true});
 mode='error';await page.reload({waitUntil:'domcontentloaded'});await page.getByRole('heading',{name:'暂时无法打开审阅台',exact:true}).waitFor();await capture('error');await actionStates();
 // A successful reload from this error card must keep the exact address.
 mode='actual';await keyboardReload();await state().waitFor({state:'hidden'});await page.getByRole('button',{name:'＋ 补充来源',exact:true}).waitFor();results.push({check:'error retry keyboard activation preserves URL and restores workspace',passed:true});
 mode='old';await page.reload({waitUntil:'networkidle'});await enterSource();assert.equal(await page.getByRole('textbox',{name:'资料名称',exact:true}).inputValue(),'');await page.getByRole('textbox',{name:'资料名称',exact:true}).fill('旧运行期独立草稿');await page.getByRole('textbox',{name:'来源正文',exact:true}).fill('不得带入当前运行期');
 const operationId='state-ui-'+crypto.randomUUID(),rejection=await page.evaluate(async id=>{const r=await fetch('/api/v1/transactions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operationId:id,actor:{kind:'HUMAN',label:'隔离状态验证'},commands:[]})});return {status:r.status,body:await r.json()};},operationId);
 assert.equal(rejection.status,409);assert.equal(rejection.body.error.code,'RUNTIME_CHANGED');assert.equal(mutations.length,1);assert.equal(mutations[0].headers['x-review-runtime'],oldEpoch);assert.equal(mutations[0].headers['x-review-deployment-id'],oldDeployment);
 const absent=await fetch(base+'/api/v1/operations/'+operationId);assert.equal(absent.status,404);results.push({check:'actual server rejects old runtime before recording an operation',status:409,code:rejection.body.error.code});
 mode='actual';await page.evaluate(()=>window.dispatchEvent(new Event('review:configuration-updated')));await page.getByRole('heading',{name:'审阅台已更新',exact:true}).waitFor();assert.equal(await page.getByRole('textbox').count(),0);await capture('updated');await actionStates();
 await keyboardReload();await state().waitFor({state:'hidden'});await enterSource();assert.equal(await page.getByRole('textbox',{name:'资料名称',exact:true}).inputValue(),'同一工作区保留草稿');assert.equal(await page.getByRole('textbox',{name:'来源正文',exact:true}).inputValue(),'仅浏览器未提交草稿');
 assert.ok(await page.evaluate(epoch=>Object.keys(sessionStorage).some(key=>key.includes(epoch)&&sessionStorage.getItem(key)?.includes('旧运行期独立草稿')),oldEpoch));results.push({check:'updated refresh restores current-epoch draft and retains old draft in its own scope',passed:true});
 mode='deployment';await page.evaluate(()=>window.dispatchEvent(new Event('review:configuration-updated')));await page.getByRole('heading',{name:'审阅台已更新',exact:true}).waitFor();assert.equal(await page.getByRole('textbox').count(),0);mode='actual';await keyboardReload();await state().waitFor({state:'hidden'});results.push({check:'deployment-only change pauses workspace; reload recovers',passed:true});
 assert.deepEqual(errors,[]);assert.equal(mutations.length,1);writeFileSync(out+'/verification.json',JSON.stringify({status:'PASS',results,attemptedMutations:1,rejectedBeforeOperation:1,businessWrites:0},null,2)+'\n');console.log(JSON.stringify({status:'PASS',results,businessWrites:0}));
}finally{releaseLoading();await browser.close();}
