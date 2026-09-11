/**
 * Install at tests/pipeline-preparation-entry.ui.spec.ts.
 * This deliberately uses the populated adopted-scene fixture: blank instances
 * bypass page.tsx's paged production URL resolver and cannot catch this bug.
 * All business requests are intercepted; no live state/media or writes.
 */
import {test,expect,type Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {defaultConfiguration} from '../host/instance-runtime/configuration-model.mjs';

const base=JSON.parse(readFileSync(new URL('./fixtures/generic-adopted-scene.json',import.meta.url),'utf8'));
async function fixture(page:Page, designOnly=false, withNextScene=false){
 const capture=structuredClone(base),snapshot=capture.responses.bootstrap.data,model=snapshot.productionModel,profile=snapshot.instance;
 profile.capabilities.landingView='pipeline';
 const configuration=defaultConfiguration(profile),scene=model.scenes[0],episodeUid=scene.episodeUid,sceneContext=capture.responses.sceneReviewContext.context;
 expect(model.scenes.length).toBeGreaterThan(0);expect(snapshot.creativeLineage.scenes.length).toBeGreaterThan(0);expect(typeof episodeUid).toBe('string');expect(episodeUid.length).toBeGreaterThan(0);expect(model.shots).toEqual([]);
 expect(model.episodes.find((episode:{episodeUid:string})=>episode.episodeUid===episodeUid)?.sceneIds).toContain(scene.id);
 expect(sceneContext.sceneId).toBe(scene.id);expect(sceneContext.episodeUid).toBe(episodeUid);expect(sceneContext.sceneDocument.scriptBlocks.length).toBeGreaterThan(0);expect(sceneContext.sceneDocument.contentHash).toBe(sceneContext.sceneContentHash);expect(sceneContext.sceneContentHash).toMatch(/^[a-f0-9]{64}$/);
 Object.assign(model,{systemConfiguration:{config:configuration},workItems:[],workPackages:[],assetFamilies:[],assetVersions:[],expectedOutputs:[],counts:{...model.counts,currentShotSpecCount:0,currentP07ShotPlans:0}});
 const designShots=designOnly?[1,2].map(order=>({id:scene.id+'-SH00'+order,title:'当前设计镜头'+order,sceneId:scene.id,episodeUid,episodeId:scene.episodeId,scopeRole:'CURRENT',activeInCurrentProduction:true,shotPlanSetRevisionId:'formal-shot-plan',workPackageRefs:[],stageInstanceRefs:[],segmentIds:[],workItemRefs:[],issueRefs:[]})):[];
 if(designOnly){scene.scopeRole='DISCOVERED';const episode=model.episodes.find((row:{episodeUid:string})=>row.episodeUid===episodeUid);episode.scopeRole='DISCOVERED';}
 const episodes=[{episodeUid,displayId:'E01',title:'有正文的准备上下文',sceneIds:[scene.id]}];
 const scenes=[{sceneId:scene.id,displayId:scene.displayId,episodeUid,sceneContentHash:sceneContext.sceneContentHash,sourceSummary:{title:'门外等待'},preparation:{sceneRole:'先核对当前场的制作意图',audienceTakeaway:'访客尚在门外',materialGaps:['门外状态素材尚未就绪'],nextPreparationAction:'明确门向与人物站位',generationAuthorized:false,formalShotIds:[]}}];
 const nextSceneId=scene.id+'-next';if(withNextScene){episodes[0].sceneIds.push(nextSceneId);scenes.push({...scenes[0],sceneId:nextSceneId,displayId:'S02',sourceSummary:{title:'下一场上下文'}});model.scenes.push({...scene,id:nextSceneId,displayId:'S02'});}
 const preparation={releaseId:'release-pipeline-entry',revisionId:'prep-pipeline-entry',stale:false,readOnly:true,comments:[],content:{basis:{candidateRevisionId:'candidate-pipeline-entry',candidateContentHash:'b'.repeat(64)},episodes,scenes},candidate:{revisionId:'candidate-pipeline-entry',contentHash:'b'.repeat(64),episodes,scenes:scenes.map(s=>({id:s.sceneId,displayId:s.displayId,title:s.sourceSummary.title}))}};
 const state={sceneId:scene.id,nextSceneId,episodeUid,designShotIds:designShots.map(shot=>shot.id),unexpected:[] as string[],writes:[] as string[],errors:[] as string[],profileRequests:0,profileFailure:false,productionRequests:[] as string[]};
 page.on('pageerror',e=>state.errors.push(e.message));
 await page.route('**/api/**',async route=>{
  const request=route.request(),url=new URL(request.url()),json=(value:unknown)=>route.fulfill({json:value});
  if(url.pathname==='/api/assistant/v1/context'&&request.method()==='POST')return json({context:{focus:request.postDataJSON().focus,resources:[],missing:[],draftTargets:[]}});
  if(!['GET','HEAD'].includes(request.method())){state.writes.push(request.method()+' '+url.pathname);return route.fulfill({status:418,json:{error:'FIXTURE_MUTATION_BLOCKED'}});}
  if(url.pathname==='/api/instance/profile'){state.profileRequests++;return state.profileFailure?route.fulfill({status:503,json:{error:'FIXTURE_PROFILE_UNAVAILABLE'}}):json(profile);}
  if(url.pathname==='/api/v8/ui/bootstrap')return json({data:snapshot,snapshotId:snapshot.snapshotId});
  if(url.pathname==='/api/v8/episode-production')return json({snapshotId:snapshot.snapshotId,episode:{episodeUid:url.searchParams.get('episodeUid'),displayId:'E01'},sceneId:url.searchParams.get('sceneId'),release:null,plans:[],wholePlanAdopted:false,formalShotCount:null});
  if(url.pathname==='/api/instance/shot-production')return json({sceneId:url.searchParams.get('sceneId'),releaseId:'release-pipeline-entry',readOnly:true,basis:null,blockers:['尚未建立正式镜头设计'],defaultContent:null,currentPlan:null,draft:null,draftHeadRevisionId:null,availableInputs:[],jobs:[],readiness:{ready:false,readyCount:0,shotCount:null,shots:[]}});
  if(url.pathname==='/api/v8/ui/production'){
   state.productionRequests.push(url.search);
   return json({schemaVersion:'1.0',snapshotId:snapshot.snapshotId,operationRevision:'op-pipeline-entry',page:{workItems:[],workPackages:[],shots:designShots,assetFamilies:[],assetVersions:[],expectedOutputs:[]},count:0,total:0,nextCursor:null,hasMore:false,appliedFilters:{}});
  }
  if(url.pathname==='/api/instance/workflow')return json({definition:configuration.workflow});
  if(url.pathname==='/api/instance/production-preparation')return json(preparation);
  if(url.pathname==='/api/instance/configuration')return json({configuration,defaults:configuration,releaseId:'release-pipeline-entry',revisionId:'config-pipeline-entry',sha256:'c'.repeat(64),history:[],bindings:[],boundStandards:[],reviewCatalog:{},initialized:true,draft:null,readOnly:true});
  if(url.pathname==='/api/assistant/v1/conversations')return json({conversations:[],bridge:{online:false},pagination:{}});
  if(url.pathname==='/api/v8/reviews')return json({events:[]});
  if(url.pathname==='/api/instance/documents')return json({documents:[]});
  for(const[key,value]of Object.entries(capture.routes))if(url.pathname===String(value).split('?')[0])return json(capture.responses[key]);
  state.unexpected.push(request.method()+' '+url.pathname);return route.fulfill({status:418,json:{error:'UNEXPECTED_FIXTURE_API'}});
 });return state;
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function clean(f:Fixture){expect(f.productionRequests.length,'Populated shell must actually read the paged production endpoint').toBeGreaterThan(0);expect(f.unexpected).toEqual([]);expect(f.writes).toEqual([]);expect(f.errors).toEqual([]);}
const navigationError=(page:Page)=>page.getByRole('alert').filter({hasText:/无法.*定位|未回退|停止静默回退/});
const phases=(page:Page)=>page.getByRole('navigation',{name:'全剧制作模块'});

test('准备数据未齐时统一等待，返回根目录清除深链且不补回参数',async({page})=>{
 const f=await fixture(page);let release!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve;});
 await page.route('**/api/instance/production-preparation',async route=>{await hold;await route.fallback();});
 await page.goto('/?view=pipeline&creatorStage=shot-generation#old');
 await expect(page.getByRole('heading',{name:'正在装入完整工作区数据'})).toBeVisible();
 await expect(page.locator('.production-v2-empty-state')).toHaveCount(0);
 release();await expect(page.locator('.production-v2-full-workbench')).toBeVisible();
 await page.getByRole('button',{name:'返回审阅台首页'}).click();
 await expect(page.getByRole('heading',{name:'门外等待',exact:true})).toBeVisible();
 await expect(page).toHaveURL(new URL('/',page.url()).href);
 await page.reload();await expect(page.getByRole('heading',{name:'门外等待',exact:true})).toBeVisible();
 await expect(page).toHaveURL(new URL('/',page.url()).href);clean(f);
});

test('后台实例校验返回相同配置时不卸载已选工作区',async({page})=>{
 const f=await fixture(page);await page.goto('/?view=pipeline');
 const workbench=page.locator('.production-v2-full-workbench');
 await expect(workbench).toBeVisible();
 const profileRequests=f.profileRequests,productionRequests=f.productionRequests.length;
 await page.evaluate(()=>window.dispatchEvent(new Event('review:configuration-updated')));
 await expect.poll(()=>f.profileRequests).toBe(profileRequests+1);
 await expect(workbench).toBeVisible();
 await expect(page.locator('.production-view-loading')).toHaveCount(0);
 expect(f.productionRequests).toHaveLength(productionRequests);
 clean(f);
});

test('后台实例校验短暂失败时保留已验证工作区',async({page})=>{
 const f=await fixture(page);await page.goto('/?view=pipeline');
 const workbench=page.locator('.production-v2-full-workbench');
 await expect(workbench).toBeVisible();
 const profileRequests=f.profileRequests,productionRequests=f.productionRequests.length;
 f.profileFailure=true;
 await page.evaluate(()=>window.dispatchEvent(new Event('review:configuration-updated')));
 await expect.poll(()=>f.profileRequests).toBe(profileRequests+1);
 await expect(workbench).toBeVisible();
 await expect(page.getByRole('alert').filter({hasText:'无法读取当前实例配置'})).toHaveCount(0);
 expect(f.productionRequests).toHaveLength(productionRequests);
 clean(f);
});

test('集场计划与镜头制作均读完后统一展示工作区',async({page})=>{
 const f=await fixture(page);let releaseEpisode!:()=>void,releaseShot!:()=>void;
 const episode=new Promise<void>(done=>releaseEpisode=done),shot=new Promise<void>(done=>releaseShot=done);
 await page.route('**/api/v8/episode-production?*',async route=>{await episode;await route.fallback();});
 await page.route('**/api/instance/shot-production?*',async route=>{await shot;await route.fallback();});
 await page.goto('/?view=pipeline');
 await expect(page.getByText('正在读取完整集场计划与镜头制作资料…',{exact:true})).toBeVisible();
 await expect(page.locator('.preparation-stage-layout')).not.toBeVisible();
 releaseEpisode();await expect(page.locator('.preparation-stage-layout')).not.toBeVisible();
 releaseShot();await expect(page.getByRole('heading',{name:'门外等待',exact:true})).toBeVisible();clean(f);
});

test('必要读取失败不显示空对象，重试后完整进入',async({page})=>{
 const f=await fixture(page);let failing=true;
 await page.route('**/api/instance/production-preparation',route=>failing?route.fulfill({status:503,json:{error:'暂时无法读取准备稿'}}):route.fallback());
 await page.goto('/?view=pipeline');await expect(page.getByRole('heading',{name:'当前工作区数据未完整读取'})).toBeVisible();
 await expect(page.locator('.production-v2-empty-state')).toHaveCount(0);
 failing=false;await page.getByRole('button',{name:'重新完整读取',exact:true}).click();
 await expect(page.getByRole('heading',{name:'门外等待',exact:true})).toBeVisible();clean(f);
});

test('已有故事正文但零正式镜头：初始入口展示筹备，刷新不产生虚构镜头或导航错误',async({page})=>{
 const f=await fixture(page);await page.goto('/?view=pipeline');
 await expect(page.getByRole('heading',{name:'门外等待',exact:true})).toBeVisible();await expect(page.getByText('先核对当前场的制作意图',{exact:true})).toBeVisible();
 await expect(phases(page).getByRole('button')).toHaveCount(3);await expect(navigationError(page)).toHaveCount(0);
 await expect.poll(()=>new URL(page.url()).searchParams.get('productionObject')).toBe('UNKNOWN');expect(new URL(page.url()).searchParams.has('shot')).toBe(false);
 await page.reload();await expect(page.getByRole('heading',{name:'门外等待',exact:true})).toBeVisible();await expect(navigationError(page)).toHaveCount(0);expect(new URL(page.url()).searchParams.has('shot')).toBe(false);
 const steps=page.getByRole('navigation',{name:'镜头制作六步骤'});await expect(steps.getByRole('button')).toHaveCount(6);
 await steps.locator('[data-production-check="STORYBOARD_DIALOGUE"]').click();await expect.poll(()=>new URL(page.url()).searchParams.get('productionPhase')).toBe('previs');await expect.poll(()=>new URL(page.url()).searchParams.get('productionGate')).toBe('storyboard-dialogue');await expect.poll(()=>new URL(page.url()).searchParams.get('creatorStage')).toBe('shot-production');
 await page.reload();await expect(phases(page).getByRole('button',{name:/镜头制作/})).toHaveAttribute('aria-pressed','true');await expect(page.locator('.production-v2-empty-state')).toContainText('尚未建立本项正式制作对象');await expect(navigationError(page)).toHaveCount(0);expect(new URL(page.url()).searchParams.has('shot')).toBe(false);clean(f);
});

test('零正式镜头的旧精确检查深链归入三个模块且保持 UNKNOWN 范围',async({page})=>{
 const f=await fixture(page);await page.goto('/?view=pipeline&productionPhase=shot-finish&productionGate=keyframes&productionScope=SHOT&productionObject=UNKNOWN');
 await expect(phases(page).getByRole('button',{name:/镜头制作/})).toHaveAttribute('aria-pressed','true');await expect(navigationError(page)).toHaveCount(0);
 await expect(page.locator('.production-v2-full-workbench')).toBeVisible();await expect(page.locator('.production-v2-full-workbench')).toContainText('UNKNOWN');expect(new URL(page.url()).searchParams.get('productionPhase')).toBe('shot-finish');expect(new URL(page.url()).searchParams.get('productionGate')).toBe('keyframes');expect(new URL(page.url()).searchParams.get('creatorStage')).toBe('shot-production');
 expect(new URL(page.url()).searchParams.has('shot')).toBe(false);await page.reload();await expect(phases(page).getByRole('button',{name:/镜头制作/})).toHaveAttribute('aria-pressed','true');await expect(navigationError(page)).toHaveCount(0);clean(f);
});

for(const [legacy,gate]of [['shot-breakdown','SHOT_PLAN_INPUT_LOCK'],['shot-generation','STORYBOARD_DIALOGUE']] as const)test('历史模块深链 '+legacy+' 定位到镜头制作的精确子步骤',async({page})=>{
 const f=await fixture(page);await page.goto('/?view=pipeline&creatorStage='+legacy);
 await expect(phases(page).getByRole('button',{name:/镜头制作/})).toHaveAttribute('aria-pressed','true');
 await expect(page.getByRole('navigation',{name:'镜头制作六步骤'}).locator('[data-production-check="'+gate+'"]').first()).toHaveAttribute('aria-pressed','true');
 await expect(navigationError(page)).toHaveCount(0);expect(new URL(page.url()).searchParams.has('shot')).toBe(false);
 await page.reload();await expect(page.locator('[data-production-check="'+gate+'"]').first()).toHaveAttribute('aria-pressed','true');clean(f);
});

for(const [key,value,extra]of [
 ['shot','unknown-permanent-shot',''],['scene','unknown-permanent-scene',''],['work','unknown-permanent-work',''],['item','unknown-permanent-item',''],['target','unknown-legacy-target','&stage=P07'],['productionObject','unknown-permanent-object','&productionScope=SHOT'],['family','unknown-permanent-family',''],['version','unknown-permanent-version',''],
] as const)test(`零正式镜头仍拒绝显式 ${key} 深链且保留原身份`,async({page})=>{
 const f=await fixture(page);await page.goto(`/?view=pipeline&${key}=${value}${extra}`);
 await expect(navigationError(page)).toBeVisible();await expect.poll(()=>new URL(page.url()).searchParams.get(key)).toBe(value);
 await page.reload();await expect(navigationError(page)).toBeVisible();expect(new URL(page.url()).searchParams.get(key)).toBe(value);clean(f);
});

test('加载中切换模块后，迟到读取不得恢复旧模块或旧深链',async({page})=>{
 const f=await fixture(page);let release!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve;});
 await page.route('**/api/instance/production-preparation',async route=>{await hold;await route.fallback();});
 await page.goto('/?view=pipeline&creatorStage=shot-generation');
 await expect(page.getByRole('heading',{name:'正在装入完整工作区数据'})).toBeVisible();
 await page.locator('.workspace-nav').getByRole('button',{name:/当前工作/}).click();
 await expect.poll(()=>new URL(page.url()).searchParams.get('view')).toBe('overview');
 release();await page.waitForTimeout(250);
 await expect.poll(()=>new URL(page.url()).searchParams.get('view')).toBe('overview');
 await expect(page.locator('.pipeline-view')).toHaveCount(0);clean(f);
});

test('正式设计尚无制作工作包时，精确镜头深链可进入且刷新保留，不被重标为历史或锁定范围',async({page})=>{
 const f=await fixture(page,true),shotId=f.designShotIds[1];
 const params=new URLSearchParams({view:'pipeline',creatorStage:'shot-production',preparationEpisode:f.episodeUid,preparationScene:f.sceneId,shot:shotId,productionPhase:'previs',productionGate:'shot-plan-input-lock',productionScope:'SCENE',productionObject:'UNKNOWN'});
 await page.goto('/?'+params);await expect(page.getByRole('heading',{name:'门外等待',exact:true})).toBeVisible();
 await expect.poll(()=>new URL(page.url()).searchParams.get('shot')).toBe(shotId);
 await expect(navigationError(page)).toHaveCount(0);expect(new URL(page.url()).searchParams.get('productionObject')).toBe('UNKNOWN');
 await expect(page.locator('[data-historical-shot-id]')).toHaveCount(0);
 await page.reload();await expect(page.getByRole('heading',{name:'门外等待',exact:true})).toBeVisible();
 await expect.poll(()=>new URL(page.url()).searchParams.get('shot')).toBe(shotId);
 expect(new URL(page.url()).searchParams.get('preparationScene')).toBe(f.sceneId);expect(new URL(page.url()).searchParams.get('productionObject')).toBe('UNKNOWN');
 await expect(navigationError(page)).toHaveCount(0);await expect(page.locator('[data-historical-shot-id]')).toHaveCount(0);clean(f);
});


test('精确设计镜头切到新场时清除旧镜头焦点，刷新和品牌入口保持新的导航范围',async({page})=>{
 const f=await fixture(page,true,true),shotId=f.designShotIds[1];
 const params=new URLSearchParams({view:'pipeline',preparationEpisode:f.episodeUid,preparationScene:f.sceneId,shot:shotId,productionPhase:'previs',productionGate:'shot-plan-input-lock'});
 await page.goto('/?'+params);await expect(page.getByRole('heading',{name:'门外等待',exact:true})).toBeVisible();
 await page.locator('[data-preparation-scene='+JSON.stringify(f.nextSceneId)+']').click();
 await expect(page.getByRole('heading',{name:'下一场上下文',exact:true})).toBeVisible();
 await expect.poll(()=>new URL(page.url()).searchParams.get('shot')).toBe(null);
 await page.reload();await expect(page.getByRole('heading',{name:'下一场上下文',exact:true})).toBeVisible();expect(new URL(page.url()).searchParams.get('preparationScene')).toBe(f.nextSceneId);
 await page.getByRole('button',{name:'返回审阅台首页'}).click();await expect(page.getByRole('heading',{name:'门外等待',exact:true})).toBeVisible();await expect(page).toHaveURL(new URL('/',page.url()).href);clean(f);
});
