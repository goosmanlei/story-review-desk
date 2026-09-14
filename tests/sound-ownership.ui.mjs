import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {chromium} from '@playwright/test';
import {requiredPhase} from '../tools/process-resources.mjs';

assert.ok(await requiredPhase(process.cwd()),'Use the managed process runner');
const base=process.env.REVIEW_UI_BASE||'http://127.0.0.1:3967',out=process.env.REVIEW_UI_ARTIFACT_DIR||process.env.REVIEW_TASK_DIR;
assert.ok(out,'Managed artifact directory is required');mkdirSync(out,{recursive:true});
const get=async path=>{const response=await fetch(base+'/api/v1/'+path);assert.equal(response.status,200,await response.clone().text());return response.json();};
const profile=await get('workspaces/profile');assert.match(profile.instanceId,/^ui-fixture-/,'Writes only in the isolated UI fixture');
let setupWrites=0;
const post=async(path,body)=>{const operationId=randomUUID(),response=await fetch(base+'/api/v1/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Review-Runtime':profile.deployment.runtimeEpoch,'Idempotency-Key':operationId},body:JSON.stringify({...body,operationId})}),data=await response.json();setupWrites++;assert.equal(response.status,200,JSON.stringify(data));assert.notEqual(data.status,'FAILED',JSON.stringify(data));return data;};
const save=async command=>post('transactions',{actor:{kind:'HUMAN',label:'声音归属 Web 隔离验收'},commands:[{type:'save',expectedVersion:0,...command}]});
const exact=(row,kind)=>({objectId:row.id,kind,revisionId:row.revision.id,sha256:row.revision.sha256,expectedVersion:row.version});
const prefix='sound-ui-'+randomUUID(),storyId=prefix+'-story',shotId=prefix+'-shot',designId=prefix+'-design',sceneId='episode-1-scene-1',episodeId='episode-1',spaceId='车站',resourceId='素材需求';

await save({id:storyId,kind:'STORY',title:'声音归属验收剧',content:{schemaVersion:'2.0',runtimeMethod:'声音归属隔离验收',changeSummary:'仅建立受控 Web 验收故事对象',sequences:[],causalChains:[],documents:[]},links:[1,2,3].map(index=>({id:'episode-'+index,role:'EPISODE'}))});
await save({id:shotId,kind:'SHOT',title:'声音归属验收镜头',content:{visualIntent:'验证镜级声音归属入口',scopeRole:'CURRENT'},links:[{id:sceneId,role:'SCENE'},{id:resourceId,role:'REQUIREMENT'}]});
await save({id:designId,kind:'SHOT_DESIGN',title:'声音归属验收镜头设计',content:{sceneId,title:'声音归属验收镜头设计',status:'DRAFT'},links:[{id:sceneId,role:'SCENE'},{id:shotId,role:'SHOT'}]});
const initialScene=await get('objects/'+encodeURIComponent(sceneId));
await post('transactions',{actor:{kind:'HUMAN',label:'声音 stale 隔离验收'},commands:[{type:'submit',id:sceneId,expectedVersion:initialScene.version,revisionId:initialScene.revision.id},{type:'review',id:sceneId,expectedVersion:initialScene.version+1,revisionId:initialScene.revision.id,decision:'ADOPT',explicit:true,findings:[],note:'建立声音归属引用的已采用场依据'}]});
const targets={SPACE:await get('objects/'+encodeURIComponent(spaceId)),STORY:await get('objects/'+encodeURIComponent(storyId)),EPISODE:await get('objects/'+encodeURIComponent(episodeId)),SCENE:await get('objects/'+encodeURIComponent(sceneId)),SHOT:await get('objects/'+encodeURIComponent(shotId))},resource=await get('objects/'+encodeURIComponent(resourceId)),resourceRef=exact(resource,'REQUIREMENT');
const bindingIds={},usages={};
for(const kind of ['SPACE','STORY','EPISODE','SCENE','SHOT']){
  const bindingId=prefix+'-binding-'+kind.toLowerCase(),usage=prefix+'-'+kind+'-usage';bindingIds[kind]=bindingId;usages[kind]=usage;
  await post('workspaces/sound-ownership',{action:'save',bindingId,expectedVersion:0,title:'声音归属 · '+kind,content:{role:'SOUND_OWNERSHIP',schemaVersion:'1.0',status:'ASSIGNED',usage,target:exact(targets[kind],kind),resources:[resourceRef]}});
}
const pendingId=prefix+'-pending',pendingReason='原场记只有环境声提示，尚无可绑定的永久目标',pendingTodo='核对场记原件与目标对象后另行确认归属',missingEvidence=['缺少带时间码的声音场记','缺少录音与目标镜头的精确对照'];
await post('workspaces/sound-ownership',{action:'save',bindingId:pendingId,expectedVersion:0,title:'待确认环境声',content:{role:'SOUND_OWNERSHIP',schemaVersion:'1.0',status:'PENDING_CONFIRMATION',usage:prefix+'-pending-usage',resources:[resourceRef],pending:{reason:pendingReason,missingEvidence,todo:pendingTodo}}});

const sceneBefore=targets.SCENE;
await post('transactions',{actor:{kind:'HUMAN',label:'声音 stale 隔离验收'},commands:[{type:'save',id:sceneId,expectedVersion:sceneBefore.version,title:sceneBefore.title,content:{...sceneBefore.revision.content,purpose:'更新后验证原声音归属依据保持可追溯'}}]});
const changedScene=await get('objects/'+encodeURIComponent(sceneId));
await post('transactions',{actor:{kind:'HUMAN',label:'声音 stale 隔离验收'},commands:[{type:'submit',id:sceneId,expectedVersion:changedScene.version,revisionId:changedScene.revision.id},{type:'review',id:sceneId,expectedVersion:changedScene.version+1,revisionId:changedScene.revision.id,decision:'ADOPT',explicit:true,findings:[],note:'确认新的场修订以验证旧声音依据失效'}]});
const apiChecks=[];
for(const kind of ['SPACE','STORY','EPISODE','SCENE','SHOT']){
  const value=await get('workspaces/sound-ownership?'+new URLSearchParams({ownerId:targets[kind].id,limit:'50'}));
  assert.deepEqual(value.bindings.map(row=>row.id),[bindingIds[kind]]);assert.equal(value.bindings[0].target.objectId,targets[kind].id);apiChecks.push('ownerId '+kind);
}
const sceneBinding=(await get('workspaces/sound-ownership?'+new URLSearchParams({ownerId:sceneId,limit:'50'}))).bindings[0];
assert.equal(sceneBinding.stale,true);assert.equal(sceneBinding.exactReferences.target,true);assert.equal(sceneBinding.currentReferences.target,false);assert.equal(sceneBinding.target.revisionId,sceneBefore.revision.id);apiChecks.push('stale keeps exact scene revision');
const byResource=await get('workspaces/sound-ownership?'+new URLSearchParams({resourceId,limit:'50'}));assert.equal(byResource.bindings.length,6);apiChecks.push('resourceId');
const pendingOnly=await get('workspaces/sound-ownership?'+new URLSearchParams({status:'UNKNOWN',limit:'50'}));assert.deepEqual(pendingOnly.bindings.map(row=>row.id),[pendingId]);apiChecks.push('status UNKNOWN');
const searched=await get('workspaces/sound-ownership?'+new URLSearchParams({q:usages.STORY,limit:'50'}));assert.deepEqual(searched.bindings.map(row=>row.id),[bindingIds.STORY]);apiChecks.push('q');
const absentSource=await get('workspaces/sound-ownership?'+new URLSearchParams({sourceId:prefix+'-absent-source',limit:'50'}));assert.deepEqual(absentSource.bindings,[]);apiChecks.push('sourceId');
const domain=await get('workspaces/domain-workspaces?owner=SETTINGS');
assert(domain.soundOwnership.some(row=>row.id===bindingIds.SPACE));assert.equal(domain.graph.entities.some(row=>row.type==='SOUND'),false);assert.equal(domain.configuration.entityTypes.some(row=>row.id==='SOUND'),false);
const domainRequirement=domain.graph.requirements.find(row=>row.id===resourceId);assert(domainRequirement?.soundOwnership.some(row=>row.id===bindingIds.STORY));assert.equal(domainRequirement.soundOwnershipPending,true);apiChecks.push('domain and material projections');

const legacy={id:prefix+'-legacy',title:'旧广播声来源',version:2,historical:true,revisionId:prefix+'-legacy-revision',revisionSha256:'e'.repeat(64)};
const browser=await chromium.launch({channel:'chrome'}),page=await browser.newPage({viewport:{width:1440,height:1000}}),browserWrites=[],errors=[],soundReads=[],browserChecks=[];
page.on('request',request=>{if(request.method()==='POST'&&request.url().includes('/api/'))browserWrites.push(request.url());if(request.method()==='GET'&&request.url().includes('/api/v1/workspaces/sound-ownership'))soundReads.push(new URL(request.url()).search);});
page.on('pageerror',error=>errors.push(error.message));
await page.route('**/api/v1/workspaces/sound-ownership?*',async route=>{const response=await route.fetch(),value=await response.json(),url=new URL(route.request().url());if(!url.searchParams.has('ownerId')&&!url.searchParams.has('resourceId'))value.legacySources=[...(value.legacySources||[]),legacy];await route.fulfill({response,json:value});});
const visitScope=async(path,label,bindingId,expected)=>{await page.goto(base+path,{waitUntil:'networkidle'});const region=page.getByRole('region',{name:label,exact:true});await region.waitFor();const card=region.locator('[data-sound-binding-id="'+bindingId+'"]');await card.waitFor();assert.match(await card.innerText(),new RegExp(expected));browserChecks.push(label);return {region,card};};
try{
  await page.goto(base+'/?view=settings',{waitUntil:'networkidle'});
  await page.getByText('声音归属与待确认',{exact:true}).waitFor();assert.equal(await page.locator('.sound-ownership-directory').evaluate(node=>node.open),false);await page.getByText('声音归属与待确认',{exact:true}).click();const pendingCard=page.locator('[data-sound-binding-id="'+pendingId+'"]');await pendingCard.waitFor();
  for(const text of [pendingReason,pendingTodo,...missingEvidence,'草稿（未采用）'])await pendingCard.getByText(text,{exact:false}).waitFor();
  assert.equal(await pendingCard.getByRole('button').count(),0,'Sound cards cannot adopt or generate');
  const statusFilters=page.getByRole('navigation',{name:'声音归属状态筛选',exact:true});
  await Promise.all([page.waitForResponse(response=>response.url().includes('/sound-ownership?')&&new URL(response.url()).searchParams.get('status')==='UNKNOWN'),statusFilters.getByRole('button',{name:'待确认',exact:true}).click()]);await pendingCard.waitFor();assert.equal(await page.locator('[data-sound-binding-id="'+bindingIds.SPACE+'"]').count(),0);
  await Promise.all([page.waitForResponse(response=>response.url().includes('/sound-ownership?')&&!new URL(response.url()).searchParams.has('status')),statusFilters.getByRole('button',{name:'全部',exact:true}).click()]);
  const search=page.getByRole('textbox',{name:'搜索声音归属',exact:true});await search.fill(usages.STORY);const queryResponse=page.waitForResponse(response=>response.url().includes('/sound-ownership?')&&new URL(response.url()).searchParams.get('q')===usages.STORY);await page.getByRole('button',{name:'检索',exact:true}).click();await queryResponse;await page.locator('[data-sound-binding-id="'+bindingIds.STORY+'"]').waitFor();assert.equal(await page.locator('.sound-binding-card').count(),1);browserChecks.push('discoverable pending and server search/filter');
  const legacySummary=page.getByText('旧 SOUND 来源 · 历史追溯 1 项',{exact:true});await legacySummary.click();await page.getByText('不把旧 SOUND 恢复为当前独立主体',{exact:false}).waitFor();await page.getByText(legacy.id,{exact:true}).waitFor();await page.getByText(legacy.revisionId,{exact:true}).waitFor();const legacySha=page.getByText(legacy.revisionSha256,{exact:true});assert.equal(await legacySha.isVisible(),false);await page.getByText('技术 SHA',{exact:true}).click();assert.equal(await legacySha.isVisible(),true);assert.match(await page.getByRole('link',{name:'读取旧来源精确修订 ↗'}).getAttribute('href'),new RegExp(encodeURIComponent(legacy.revisionId)));browserChecks.push('legacy source is history only');

  const space=await visitScope('/?'+new URLSearchParams({view:'settings',settingsSection:'space',settingsEntity:spaceId}),'空间声音归属',bindingIds.SPACE,usages.SPACE);
  await page.getByRole('region',{name:'实体评论',exact:true}).waitFor();const spaceReference=space.region.locator('[data-sound-reference-kind="SPACE"][data-sound-reference-id="'+spaceId+'"]');assert((await spaceReference.innerText()).includes(targets.SPACE.revision.id));const spaceSha=spaceReference.getByText(targets.SPACE.revision.sha256,{exact:true});assert.equal(await spaceSha.isVisible(),false);await spaceReference.getByText('技术追溯 · SHA 与对象版本',{exact:true}).click();assert.equal(await spaceSha.isVisible(),true);browserChecks.push('space keeps comments and collapses technical SHA');
  await visitScope('/?'+new URLSearchParams({view:'story',storyMode:'story-structure'}),'本剧声音归属',bindingIds.STORY,usages.STORY);
  await visitScope('/?'+new URLSearchParams({view:'story',storyMode:'logic',episode:episodeId}),'本集声音归属',bindingIds.EPISODE,usages.EPISODE);
  const scene=await visitScope('/?'+new URLSearchParams({view:'story',storyMode:'audit',episode:episodeId,scene:sceneId}),'本场声音归属',bindingIds.SCENE,usages.SCENE);assert.match(await scene.card.innerText(),/依据已过时/);assert.match(await scene.card.innerText(),/当前头已变化/);assert((await scene.card.innerText()).includes(sceneBefore.revision.id));browserChecks.push('stale is separate from draft/adoption state');
  const material=await visitScope('/?'+new URLSearchParams({view:'materials',material:resourceId}),'素材声音归属',bindingIds.STORY,usages.STORY);assert(await material.region.locator('[data-sound-binding-id="'+bindingIds.SPACE+'"]').isVisible());assert(await material.region.locator('[data-sound-binding-id="'+pendingId+'"]').isVisible());browserChecks.push('material card traces assigned and pending ownership');
  await visitScope('/?'+new URLSearchParams({view:'pipeline',creatorStage:'shot-production',productionGate:'shot-plan-input-lock',preparationEpisode:episodeId,preparationScene:sceneId}),'制作范围声音归属',bindingIds.SCENE,usages.SCENE);
  await visitScope('/?'+new URLSearchParams({view:'pipeline',creatorStage:'shot-production',productionGate:'shot-plan-input-lock',preparationEpisode:episodeId,preparationScene:sceneId,shot:shotId}),'本镜声音归属',bindingIds.SHOT,usages.SHOT);
  // Controlled read responses exercise page boundaries and overlapping searches;
  // all base records above were created through the isolated API.
  let pagedOwner=false,releaseOldPage,oldRequested;
  const oldPageRequested=new Promise(resolve=>oldRequested=resolve),oldPageReleased=new Promise(resolve=>releaseOldPage=resolve),ownerOffsets=[];
  const storyRecord=byResource.bindings.find(row=>row.id===bindingIds.STORY),pendingRecord=byResource.bindings.find(row=>row.id===pendingId);
  await page.route('**/api/v1/workspaces/sound-ownership?*',async route=>{
    const url=new URL(route.request().url()),params=url.searchParams;
    if(pagedOwner&&params.get('ownerId')===targets.STORY.id){
      const offset=Number(params.get('offset')||0);ownerOffsets.push(offset);
      const bindings=[offset?{...storyRecord,id:prefix+'-last-page',title:'最后一页声音'}:storyRecord];
      return route.fulfill({json:{...byResource,bindings,pending:[],hasMore:!offset,nextOffset:offset?null:500}});
    }
    if(params.get('q')==='cursor-race'){
      if(params.get('status')==='UNKNOWN')return route.fulfill({json:{...pendingOnly,bindings:[{...pendingRecord,title:'当前筛选结果'}],hasMore:false,nextOffset:null}});
      if(params.has('offset')){oldRequested();await oldPageReleased;return route.fulfill({json:{...byResource,bindings:[{...storyRecord,title:'旧分页响应不得覆盖'}],pending:[],hasMore:false,nextOffset:null}});}
      return route.fulfill({json:{...pendingOnly,bindings:[{...pendingRecord,title:'初始分页结果'}],hasMore:true,nextOffset:100}});
    }
    return route.fallback();
  });
  pagedOwner=true;
  await page.goto(base+'/?'+new URLSearchParams({view:'story',storyMode:'story-structure'}),{waitUntil:'networkidle'});
  await page.locator('[data-sound-binding-id="'+prefix+'-last-page"]').waitFor();
  assert(ownerOffsets.includes(0)&&ownerOffsets.includes(500));browserChecks.push('scope reads subsequent API pages');
  pagedOwner=false;
  await page.goto(base+'/?view=settings',{waitUntil:'networkidle'});
  await page.getByText('声音归属与待确认',{exact:true}).click();await page.getByRole('textbox',{name:'搜索声音归属',exact:true}).fill('cursor-race');
  await page.getByRole('button',{name:'检索',exact:true}).click();await page.getByText('初始分页结果',{exact:true}).waitFor();
  await page.getByRole('button',{name:'继续读取声音归属',exact:true}).click();await oldPageRequested;
  await page.getByRole('navigation',{name:'声音归属状态筛选',exact:true}).getByRole('button',{name:'待确认',exact:true}).click();
  await page.getByText('当前筛选结果',{exact:true}).waitFor();
  const oldResponse=page.waitForResponse(response=>new URL(response.url()).searchParams.get('q')==='cursor-race'&&new URL(response.url()).searchParams.get('offset')==='100');
  releaseOldPage();await oldResponse;await page.waitForLoadState('networkidle');
  assert.equal(await page.getByText('旧分页响应不得覆盖',{exact:true}).count(),0);
  assert(await page.getByText('当前筛选结果',{exact:true}).isVisible());browserChecks.push('late previous page cannot overwrite new filter');
  await page.setViewportSize({width:390,height:844});await page.goto(base+'/?view=settings',{waitUntil:'networkidle'});await page.getByText('声音归属与待确认',{exact:true}).waitFor();await page.getByText('声音归属与待确认',{exact:true}).click();await page.screenshot({path:out+'/sound-ownership-narrow.png',fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));browserChecks.push('narrow layout has no horizontal overflow');
  assert(soundReads.some(query=>new URLSearchParams(query).get('status')==='UNKNOWN'));assert(soundReads.some(query=>new URLSearchParams(query).get('q')===usages.STORY));assert.deepEqual(browserWrites,[],'Browser review and navigation do not write business data');assert.deepEqual(errors,[]);
  const result={status:'PASS',fixture:profile.instanceId,setupWrites,apiChecks,browserChecks,browserPostCount:browserWrites.length,pageErrors:errors};writeFileSync(out+'/sound-ownership-ui.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}finally{await browser.close();}
