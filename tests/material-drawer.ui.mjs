import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {chromium} from '@playwright/test';
import {requiredPhase} from '../tools/process-resources.mjs';
assert.ok(await requiredPhase(process.cwd()));
const base=process.env.REVIEW_UI_BASE||'http://127.0.0.1:3916',out=process.env.REVIEW_UI_ARTIFACT_DIR||process.env.REVIEW_TASK_DIR,baseline=process.env.REVIEW_EXPECT_DRAWER_BUGS==='1';mkdirSync(out,{recursive:true});
const get=async p=>{const r=await fetch(base+'/api/v1/'+p);assert.equal(r.status,200);return r.json();};
const profile=await get('workspaces/profile');let fixtureSetupWrites=0;
if(process.env.REVIEW_DRAWER_PREPARE==='1'){
 assert.match(profile.instanceId,/^ui-fixture-/);
 const plan=(await get('workspaces/views/episode-plan')).plan,designs=await get('objects?kind=SHOT_DESIGN&limit=100');let sceneId;
 for(const row of designs.items){const design=await get('objects/'+encodeURIComponent(row.id)),id=design.links.find(l=>l.role==='SCENE')?.id;if(id&&plan.content.episodes.some(e=>e.sceneIds.includes(id))&&design.links.filter(l=>l.role==='SHOT').length>=2){sceneId=id;break;}}
 assert.ok(sceneId);const route='workspaces/shot-production',read=()=>get(route+'?sceneId='+sceneId);
 const post=async body=>{const r=await fetch(base+'/api/v1/'+route,{method:'POST',headers:{'Content-Type':'application/json','X-Review-Runtime':profile.deployment.runtimeEpoch,'Idempotency-Key':crypto.randomUUID()},body:JSON.stringify(body)}),v=await r.json();assert.equal(r.status,200,JSON.stringify(v));fixtureSetupWrites++;return v;};
 let w=await read();await post({action:'save',sceneId,content:w.defaultContent,expectedReleaseId:w.releaseId,expectedDraftRevisionId:w.draftHeadRevisionId});w=await read();const preview=await post({action:'preview',sceneId,draftRevisionId:w.draft.revisionId});const published=await post({action:'publish',sceneId,draftRevisionId:w.draft.revisionId,previewHash:preview.previewHash});assert.equal(published.generationAuthorized,false);assert.equal(published.formalAdoptionPerformed,false);
}
const domain=await get('workspaces/domain-workspaces?owner=MATERIAL'),catalogue=(await get('workspaces/views/material-catalog')).page;
const q=domain.requirements.find(q=>q.assetFamilyRefs.some(id=>catalogue.assetVersions.some(v=>v.familyId===id&&v.outputState==='PRESENT'&&v.historyRole!=='HISTORICAL'))&&domain.graph.entities.some(e=>e.id===q.entityRef&&e.type==='CHARACTER'));
assert.ok(q);const entity=q.entityRef,entityUrl=base+'/?'+new URLSearchParams({view:'materials',materialPanel:'entity',entity});
const browser=await chromium.launch({channel:'chrome'}),page=await browser.newPage({viewport:{width:1440,height:1000}}),writes=[],errors=[],results=[];
page.on('request',r=>{if(r.method()==='POST'&&r.url().includes('/api/'))writes.push(r.url());});page.on('pageerror',e=>errors.push(e.message));
const drawer=page.locator('.material-review-drawer');
const opened=()=>drawer.waitFor({state:'visible'}),closed=()=>drawer.waitFor({state:'hidden'});
const overlayClick=async()=>{const rect=await drawer.boundingBox();assert.ok(rect&&rect.x>20);await page.mouse.click(rect.x/2,180);};
async function refreshHeld(){
 let release,entered,completed;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r),finished=new Promise(r=>completed=r);
 const handler=async route=>{entered();await gate;try{await route.continue();}catch(e){if(!page.isClosed())throw e;}finally{completed();}};
 await page.route('**/api/v1/workspaces/domain-workspaces?owner=MATERIAL',handler);
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await Promise.race([started,new Promise((_,reject)=>setTimeout(()=>reject(Error('focus did not revalidate directory')),10000))]);
 await page.waitForFunction(()=>document.querySelector('.material-entity-review')?.getAttribute('aria-busy')==='true');
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 return async()=>{release();await finished;await page.unroute('**/api/v1/workspaces/domain-workspaces?owner=MATERIAL',handler);await page.waitForFunction(()=>document.querySelector('.material-entity-review')?.getAttribute('aria-busy')==='false');};
}
try{
 await page.goto(entityUrl,{waitUntil:'networkidle'});await opened();
 const release=await refreshHeld(),visibleDuringRead=await drawer.isVisible();
 await page.screenshot({path:out+(baseline?'/before-refresh.png':'/after-refresh.png')});
 assert.equal(visibleDuringRead,!baseline);results.push({check:'focus refresh preserves visible drawer',visibleDuringRead});
 if(!baseline){await overlayClick();await closed();assert.equal(new URL(page.url()).searchParams.get('materialPanel'),'closed');}
 await release();
 if(baseline){await opened();await overlayClick();await closed();}else{await closed();}
 results.push({check:'close during/after read stays closed',passed:true});
 const selected=new URL(page.url()).searchParams.get('entity');
 await page.getByRole('tab',{name:'制作过程素材',exact:true}).click();await page.getByRole('tab',{name:'基础素材',exact:true}).click();
 await page.waitForFunction(()=>Boolean(document.querySelector('.material-entity-review')));await page.waitForLoadState('networkidle');
 assert.equal(await drawer.isVisible(),baseline);assert.equal(new URL(page.url()).searchParams.get('entity'),selected);
 results.push({check:'catalog round trip',unexpectedReopen:await drawer.isVisible()});await page.screenshot({path:out+(baseline?'/before-roundtrip.png':'/after-roundtrip.png')});
 if(!baseline){
  for(const key of ['button','escape']){
   await page.goto(entityUrl,{waitUntil:'networkidle'});await opened();if(key==='button')await page.getByRole('button',{name:'关闭详情',exact:true}).click();else await page.keyboard.press('Escape');await closed();
   for(let i=0;i<2;i++){await page.getByRole('tab',{name:'制作过程素材',exact:true}).click();await page.getByRole('tab',{name:'基础素材',exact:true}).click();await page.waitForLoadState('networkidle');await closed();}
  }
  results.push({check:'button and Escape persist across repeated catalog switches',passed:true});
  const releaseClosed=await refreshHeld();await closed();await releaseClosed();await closed();
  const name=domain.graph.entities.find(e=>e.id===entity).name;await page.getByRole('textbox',{name:'查找目录实体',exact:true}).fill(name);
  await page.locator('.material-filter-chip[aria-label^="媒介：图像"]').click();const filtered=new URL(page.url());
  await page.getByRole('tab',{name:'制作过程素材',exact:true}).click();await page.getByRole('tab',{name:'基础素材',exact:true}).click();await page.waitForLoadState('networkidle');await closed();
  assert.equal(await page.getByRole('textbox',{name:'查找目录实体',exact:true}).inputValue(),name);assert.equal(new URL(page.url()).searchParams.get('materialMedia'),filtered.searchParams.get('materialMedia'));assert.equal(new URL(page.url()).searchParams.get('entity'),entity);
  await page.getByRole('button',{name:'故事 故事创作 来源资料、故事结构与叙事拆解',exact:true}).click();await page.goBack();await page.waitForURL(u=>u.searchParams.get('view')==='materials');await page.waitForLoadState('networkidle');await closed();await page.goForward();await page.waitForURL(u=>u.searchParams.get('view')==='story');await page.goBack();await page.waitForLoadState('networkidle');await closed();
  results.push({check:'closed refresh, entity/media/directory filters and browser back/forward',passed:true});
  await page.goto(base+'/?'+new URLSearchParams({view:'materials',entity}),{waitUntil:'networkidle'});await opened();assert.equal(await drawer.getAttribute('data-material-panel'),'entity');await page.getByRole('button',{name:'关闭详情',exact:true}).click();
  await page.locator('.material-entity-workspace .free-canvas-node[data-canvas-node-id="'+entity+'"]').count().then(async count=>{if(count)await page.locator('.material-entity-workspace .free-canvas-node[data-canvas-node-id="'+entity+'"]').dblclick();else await page.getByRole('button',{name:domain.graph.entities.find(e=>e.id===entity).name,exact:true}).dblclick();});await opened();await page.keyboard.press('Escape');
  const v=catalogue.assetVersions.find(v=>q.assetFamilyRefs.includes(v.familyId)&&v.outputState==='PRESENT'&&v.historyRole!=='HISTORICAL');assert.ok(v);
  const materialUrl=base+'/?'+new URLSearchParams({view:'materials',material:q.id,family:v.familyId,version:v.id});await page.goto(materialUrl,{waitUntil:'networkidle'});await opened();
  const note=page.getByRole('textbox',{name:'整体审阅说明',exact:true});await note.fill('隔离浏览器未提交说明');const releaseNote=await refreshHeld();assert.equal(await note.inputValue(),'隔离浏览器未提交说明');await releaseNote();assert.equal(await note.inputValue(),'隔离浏览器未提交说明');assert.equal(new URL(page.url()).searchParams.get('version'),v.id);
  results.push({check:'explicit legacy entity and precise material/version links; retained note survives refresh',passed:true});
  await page.evaluate(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.includes('editor-draft:material-overall:'))throw Error('fixture storage unavailable');return original.call(this,k,v);};});await note.fill('保留内存中的未提交说明');await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  const cancelled=[];page.on('dialog',async d=>{cancelled.push(d.message());await d.dismiss();});
  for(const action of [()=>overlayClick(),()=>page.getByRole('button',{name:'关闭详情',exact:true}).click(),()=>page.keyboard.press('Escape')]){const before=cancelled.length;await action();await opened();assert.equal(cancelled.length,before+1);assert.equal(await note.inputValue(),'保留内存中的未提交说明');}
  assert(cancelled.every(m=>m.includes('未保存')));results.push({check:'storage unavailable: backdrop/button/Escape cancel preserves input and drawer',passed:true});
  // Discard only this isolated browser's in-memory text; do not save a decision.
  page.removeAllListeners('dialog');page.on('dialog',d=>d.accept());await page.getByRole('button',{name:'关闭详情',exact:true}).click();await closed();
  const production=await get('workspaces/views/production-materials?limit=50&detail=summary');
  if(production.entries.length){const row=production.entries[0],version=row.currentVersionId||row.currentExpectedOutputId;await page.goto(base+'/?'+new URLSearchParams({view:'materials',materialCatalog:'production',productionMaterial:row.familyId,...(version?{productionMaterialVersion:version}:{})}),{waitUntil:'networkidle'});await opened();await page.locator('.production-material-info-card').waitFor();assert.equal(await page.locator('.production-material-info-card .creator-focus-review').count(),0);assert.equal(await page.locator('.production-material-info-card').getAttribute('data-family-id'),row.familyId);await page.screenshot({path:out+'/production-detail.png'});await overlayClick();await closed();await page.getByRole('tab',{name:'基础素材',exact:true}).click();await page.getByRole('tab',{name:'制作过程素材',exact:true}).click();await page.waitForLoadState('networkidle');await closed();await page.locator('[data-production-material-id="'+row.familyId+'"]').click();await opened();await page.keyboard.press('Escape');await closed();results.push({check:'registered fixture production detail exact version, reopen and close across catalogs',passed:true});}
  else results.push({check:'production content',status:'EMPTY_CURRENT_PROJECT; shared path covered by isolated production fixture'});
 }
 assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);writeFileSync(out+'/'+(process.env.REVIEW_UI_RESULT_NAME||(baseline?'before.json':'after.json')),JSON.stringify({baseline,entity,requirement:q.id,results,businessPosts:writes.length,fixtureSetupWrites},null,2)+'\n');console.log(JSON.stringify({baseline,results,businessPosts:0,fixtureSetupWrites}));
}finally{await browser.close();}
