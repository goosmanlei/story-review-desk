import {test,expect} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const roots=Object.fromEntries([['baseline',process.env.REVIEW_PERF_BASELINE_URL],['candidate',process.env.REVIEW_PERF_CANDIDATE_URL]].filter((entry):entry is [string,string]=>Boolean(entry[1])));
const output=process.env.REVIEW_PERF_OUTPUT||path.resolve('tests/.test-tmp/navigation-loading-performance/measurements');
for(const base of Object.values(roots)){const url=new URL(base);if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!url.port||url.port==='3000')throw Error('Measure only explicitly owned isolated loopback servers.');}
const labels={settings:'故事设定',materials:'素材管理',pipeline:'全剧制作'};
const selectors={settings:'[aria-label="主体与关联关系画板"]',materials:'.material-entity-review[aria-busy="false"]',pipeline:'.production-flow-workspace .preparation-stage-layout'};
for(const [variant,base] of Object.entries(roots))test(`${variant}: complete first entry and five same-version round trips`,async({browser})=>{
 test.setTimeout(900_000);await mkdir(output,{recursive:true});
 const samples:Record<string,unknown>[]=[];
 for(const view of Object.keys(labels) as Array<keyof typeof labels>){
  const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'}),page=await context.newPage();
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.url().includes('/api/')&&r.status()>=500)errors.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`);});
  const begin=Date.now();expect((await page.goto(base+'/?view='+view))?.status()).toBe(200);
  await expect(page.locator(selectors[view])).toBeVisible({timeout:180_000});
  if(view==='materials')await expect(page.getByRole('region',{name:'素材筛选'}).locator('button:not([disabled])').first()).toBeEnabled();
  if(view==='pipeline')await expect(page.locator('[data-preparation-scene]').first()).toBeVisible();
  await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
  samples.push({view,kind:'new-browser',ms:Date.now()-begin,errors:[...errors]});
  await page.screenshot({path:path.join(output,`${variant}-${view}.png`),fullPage:false});
  for(let n=0;n<5;n++){
   const away=view==='settings'?'全剧制作':'故事设定';
   await page.locator('.workspace-nav').getByRole('button',{name:new RegExp(away)}).click();
   await expect(page.locator(view==='settings'?selectors.pipeline:selectors.settings)).toBeVisible({timeout:120_000});
   const start=Date.now();await page.locator('.workspace-nav').getByRole('button',{name:new RegExp(labels[view])}).click();
   await expect(page.locator(selectors[view])).toBeVisible({timeout:120_000});
   await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
   await expect(page.locator(selectors[view])).toBeVisible();
   samples.push({view,kind:'return',run:n+1,ms:Date.now()-start});
  }
  samples.push({view,kind:'requests',resources:await page.evaluate(()=>performance.getEntriesByType('resource').filter(r=>r.name.includes('/api/')).map(r=>({url:r.name,duration:r.duration,bytes:(r as PerformanceResourceTiming).transferSize,server:(r as PerformanceResourceTiming).serverTiming.map(s=>({name:s.name,ms:s.duration}))})))});
  await writeFile(path.join(output,`${variant}-browser-performance.json`),JSON.stringify(samples,null,2));
  expect(errors).toEqual([]);await context.close();
 }
 await writeFile(path.join(output,`${variant}-browser-performance.json`),JSON.stringify(samples,null,2));
});

for(const [variant,base] of Object.entries(roots))test(`${variant}: shot input workspace episode and scene switches`,async({browser})=>{
 test.setTimeout(900_000);await mkdir(output,{recursive:true});
 const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'}),page=await context.newPage();
 const errors:string[]=[],samples:Array<{kind:string;id:string;ms:number}>=[];
 page.on('pageerror',error=>errors.push(error.message));page.on('response',r=>{if(r.url().includes('/api/')&&r.status()>=500)errors.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`);});
 const ready=async()=>{await expect(page.getByRole('region',{name:'镜头制作设置',exact:true})).toBeVisible({timeout:180_000});await expect(page.locator('.episode-production-entry [role="status"]')).toHaveCount(0);await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));};
 const started=Date.now();await page.goto(base+'/?view=pipeline');await ready();samples.push({kind:'initial',id:'pipeline',ms:Date.now()-started});
 const episodes=await page.locator('[data-preparation-episode]').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('data-preparation-episode')!));
 test.skip(episodes.length<2,'At least two formal navigation episodes are required for a measured round trip.');
 const select=async(attribute:string,id:string,kind:string)=>{
  const button=page.locator(`[${attribute}=${JSON.stringify(id)}]`);
  if(await button.getAttribute(attribute==='data-preparation-episode'?'aria-pressed':'aria-current')===(attribute==='data-preparation-episode'?'true':'location'))return;
  const start=Date.now();await button.click();await ready();samples.push({kind,id,ms:Date.now()-start});
 };
 for(const episode of episodes.slice(0,4)){
  await select('data-preparation-episode',episode,'new-episode');
  const scenes=await page.locator('[data-preparation-scene]').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('data-preparation-scene')!));
  for(const scene of scenes.slice(1,3))await select('data-preparation-scene',scene,'new-scene');
 }
 for(let run=0;run<5;run++){
  await select('data-preparation-episode',episodes[run%2],'return-episode');
  const second=page.locator('[data-preparation-scene]').nth(1);
  if(await second.count())await select('data-preparation-scene',(await second.getAttribute('data-preparation-scene'))!,'return-scene');
 }
 await writeFile(path.join(output,`${variant}-scene-switch-performance.json`),JSON.stringify({samples,errors},null,2));
 expect(errors).toEqual([]);await context.close();
});
