// Real browser + real API + isolated PostgreSQL. Mount the production workspace
// and its providers in a small Next test app, without changing the product's
// handbook/deployment build. Root integration owns that separate documentation QA.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {cp,mkdir,writeFile,symlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createServer} from 'node:net';
import {chromium} from '@playwright/test';
import {createSpatialFixture} from './spatial-placement.integration.mjs';

const f=await createSpatialFixture(),wt=fileURLToPath(new URL('..',import.meta.url));
const source=path.join(process.env.REVIEW_TASK_DIR,'placement-browser-source'),app=path.join(source,'fixture');
const out=await f.phase.directory(path.join(f.phase.config.root,f.phase.config.workspace,'placement-ui-evidence-'+randomUUID()));
let server,browser;const errors=[],writes=[],checks=[],logs=[];
try {
 await mkdir(path.join(app,'app'),{recursive:true});
 for(const name of ['web','server','tools','package.json','package-lock.json'])await cp(path.join(wt,name),path.join(source,name),{recursive:true,filter:p=>!p.includes(path.sep+'.next')&&!p.includes(path.sep+'.handbook')&&!p.endsWith('.tsbuildinfo')});
 await symlink(path.join(wt,'node_modules'),path.join(source,'node_modules'));
 // These fixture-only files select the real unchanged workspace/layout/API.
 await writeFile(path.join(app,'app/page.tsx'),"import {StorySettingsWorkspace} from '../../web/app/story-settings-workspace'; export default function Page(){return <StorySettingsWorkspace/>;}\n");
 await writeFile(path.join(app,'app/layout.tsx'),"export {default} from '../../web/app/layout';\n");
 await cp(path.join(source,'web/app/api'),path.join(app,'app/api'),{recursive:true});
 await writeFile(path.join(app,'next.config.mjs'),"export default {serverExternalPackages:['pg','pinyin-pro'],experimental:{webpackMemoryOptimizations:true}};\n");
 await writeFile(path.join(app,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',lib:['dom','dom.iterable','esnext'],allowJs:true,skipLibCheck:true,strict:true,noEmit:true,esModuleInterop:true,module:'esnext',moduleResolution:'bundler',resolveJsonModule:true,jsx:'react-jsx',plugins:[{name:'next'}]},include:['**/*.ts','**/*.tsx','.next/types/**/*.ts'],exclude:['node_modules']}));
 const port=await new Promise(resolve=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 const base='http://127.0.0.1:'+port;
 server=spawn(process.execPath,[path.join(wt,'node_modules/next/dist/bin/next'),'dev',app,'--webpack','--hostname','127.0.0.1','--port',String(port)],{cwd:source,env:{...process.env,REVIEW_INSTANCE_ROOT:f.instanceRoot,REVIEW_SOFTWARE_COMMIT:'SPATIAL-PLACEMENT-UI-FIXTURE',NEXT_TELEMETRY_DISABLED:'1'},stdio:['ignore','pipe','pipe']});
 server.stdout.on('data',v=>{logs.push(v.toString());if(/Ready in/.test(v.toString()))console.log('Isolated Next fixture ready');});server.stderr.on('data',v=>logs.push(v.toString()));
 for(let i=0;;i++){try{const r=await fetch(base+'/api/v1/workspaces/profile');if(r.ok)break;}catch{}if(i>=120||server.exitCode!==null)throw Error('UI fixture start failed: '+logs.slice(-8).join(''));await new Promise(r=>setTimeout(r,250));}
 const get=async pathname=>{const r=await fetch(base+'/api/v1/'+pathname);assert.equal(r.status,200,await r.clone().text());return r.json();};
 const profile=await get('workspaces/profile');assert.equal(profile.instanceId,f.instanceId);
 const post=async(pathname,body)=>{const operationId=randomUUID(),r=await fetch(base+'/api/v1/'+pathname,{method:'POST',headers:{'Content-Type':'application/json','X-Review-Runtime':profile.deployment.runtimeEpoch,'Idempotency-Key':operationId},body:JSON.stringify(body)});assert.equal(r.status,200,await r.clone().text());return r.json();};
 // Persist all five through the production HTTP API, then render its projection.
 const saved=await post('workspaces/spatial-settings/placements',{action:'save',drafts:Array.from({length:5},(_,i)=>f.draft(i))});assert.equal(saved.drafts.length,5);
 const before=await get('workspaces/domain-workspaces?owner=SETTINGS');assert.equal(before.spatialPlacements.pendingOverlays.length,5);
 browser=await chromium.launch({channel:'chrome'});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(20000);
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()!=='GET'&&r.url().includes('/api/'))writes.push({method:r.method(),url:r.url()});});
 await page.goto(base+'/?view=settings&settingsSection=space',{waitUntil:'networkidle'});
 const region=page.getByRole('region',{name:'地图待确认区域',exact:true}),pending=region.locator('[data-placement-classification="PENDING_OVERLAY"]');
 await region.waitFor();assert.equal(await pending.count(),5);
 assert.equal(await region.getAttribute('data-geographic'),'false');
 assert.equal(await region.locator('svg,[data-canvas-node-id],[data-canvas-edge-path],.free-canvas-anchor').count(),0);
 assert.equal(await page.locator('.free-canvas-anchor').count(),14);
 const anchorCoordinates=await page.locator('.free-canvas-anchor').evaluateAll(nodes=>Object.fromEntries(nodes.map(n=>[n.querySelector('text').textContent,[Number(n.querySelector('circle').getAttribute('cx')),Number(n.querySelector('circle').getAttribute('cy'))]])));
 assert.deepEqual(anchorCoordinates,Object.fromEntries(f.spatial.locations.map(v=>[v.name,v.pos.map(n=>n*16)])));
 assert.match(await page.locator('.settings-compass').innerText(),/北.*东/);
 for(let i=0;i<5;i++){
  const card=region.locator('[data-placement-target="'+f.locations[i].id+'"]');
  assert.match(await card.innerText(),/PENDING_CONFIRMATION/);assert.match(await card.innerText(),/UNKNOWN/);
  assert.equal(await page.locator('[data-canvas-node-id="'+f.locations[i].id+'"]').count(),0);
  await card.getByRole('button',{name:'打开地点 · 待核地点 '+i,exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'对象设定详情',exact:true});await dialog.waitFor();
  await dialog.getByRole('heading',{name:'待核地点 '+i,exact:true}).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('settingsEntity'),f.locations[i].id);
  await dialog.getByRole('button',{name:'关闭对象详情',exact:true}).click();
 }
 checks.push('five API-saved cards inside the map; every card opens the correct permanent location dialog and URL; no pending anchors, entrances or graph edges');
 const first=region.locator('[data-placement-target="'+f.locations[0].id+'"]');
 await first.getByText('查看提案与精确依据',{exact:true}).click();
 const exactHref=await first.getByRole('link',{name:'读取 NOTE 原修订 ↗'}).getAttribute('href');
 assert(exactHref.includes(encodeURIComponent(saved.drafts[0].revisionId)));
 const note=await (await fetch(base+exactHref)).json();assert.equal(note.revision.id,saved.drafts[0].revisionId);
 await first.getByText('技术追溯 · 修订 SHA 与原始来源 SHA',{exact:true}).click();
 assert.match(await first.locator('pre').innerText(),new RegExp(f.source.sha256));assert.match(await first.locator('pre').innerText(),new RegExp(f.source.sourceSha256));
 await first.getByText('查看提案与精确依据',{exact:true}).click();
 await region.screenshot({path:path.join(out,'pending-desktop.png')});
 await page.locator('.free-canvas-viewport').screenshot({path:path.join(out,'published-map.png')});
 checks.push('14 original anchors, entrances and north-up orientation retained; exact NOTE links and distinct revision/source SHA readback');

 await page.setViewportSize({width:390,height:844});await region.scrollIntoViewIfNeeded();
 assert.equal(await pending.count(),5);
 const fits=await region.locator('article').evaluateAll(nodes=>nodes.every(n=>n.scrollWidth<=n.clientWidth+1));assert.equal(fits,true,'Cards fit narrow viewport');
 await region.screenshot({path:path.join(out,'pending-mobile.png')});
 checks.push('390px layout keeps five cards readable without internal overflow');

 // Synthetic legacy conflict and actual evidence history change, served through
 // the same API on a fresh read. No route mocks and no replacement UI data.
 await f.pool.query('UPDATE objects SET historical=true WHERE id=$1',[f.scene.id]);
 await f.seed('fixture-conflict-note','NOTE',{role:'SPATIAL_PLACEMENT_DRAFT',placement:f.draft(1).content},{state:'DRAFT'});
 await f.seed('fixture-invalid-note','NOTE',{role:'SPATIAL_PLACEMENT_DRAFT',placement:{location:null}},{state:'DRAFT'});
 await page.setViewportSize({width:1440,height:1000});await page.reload({waitUntil:'networkidle'});await region.waitFor();
 assert.equal(await region.locator('[data-placement-classification="STALE_DRAFT"]').count(),3);
 assert.equal(await region.locator('[data-placement-classification="CONFLICT"]').count(),2);
 assert.equal(await region.locator('[data-placement-classification="INVALID_DRAFT"]').count(),1);
 assert.equal(await region.locator('[data-placement-classification="PENDING_OVERLAY"]').count(),1);
 const staleCard=region.locator('[data-placement-note="fixture-note-0"]');assert.match(await staleCard.innerText(),/原提案保留可查/);
 await staleCard.getByText('查看提案与精确依据',{exact:true}).click();
 assert((await staleCard.getByRole('link',{name:'读取 NOTE 原修订 ↗'}).getAttribute('href')).includes(encodeURIComponent(saved.drafts[0].revisionId)));
 await staleCard.getByRole('button',{name:'打开地点 · 待核地点 0',exact:true}).click();await page.getByRole('dialog').getByRole('heading',{name:'待核地点 0',exact:true}).waitFor();await page.getByRole('button',{name:'关闭对象详情',exact:true}).click();
 await region.screenshot({path:path.join(out,'stale-conflict.png')});
 assert.equal(await page.locator('.free-canvas-anchor').count(),14);
 const after=await get('workspaces/spatial-settings');assert.deepEqual(after.specification,f.spatial);
 assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
 checks.push('stale, duplicate conflict and malformed NOTE remain readable; old revision links preserved; browser performs no business writes and reports no page errors');
 const result={status:'PASSED',checks,syntheticOnly:true,realModelCalls:0,browserWrites:writes.length,artifacts:out};
 await writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2));
 await f.phase.retain('path',out,'Synthetic spatial-placement UI acceptance screenshots and result for root review');
 console.log(JSON.stringify(result,null,2));
} catch(error) {
 await writeFile(path.join(out,'failure.json'),JSON.stringify({message:error.message,errors,logs:logs.slice(-30)},null,2));
 await f.phase.retain('path',out,'Synthetic spatial-placement failed UI evidence for bounded repair');
 throw error;
} finally {
 await browser?.close();
 if(server&&server.exitCode===null){server.kill('SIGTERM');await new Promise(resolve=>server.once('exit',resolve));}
 await f.pool.end();
}
