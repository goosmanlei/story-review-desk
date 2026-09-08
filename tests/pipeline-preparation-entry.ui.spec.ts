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
async function fixture(page:Page){
 const capture=structuredClone(base),snapshot=capture.responses.bootstrap.data,model=snapshot.productionModel,profile=snapshot.instance;
 profile.capabilities.landingView='pipeline';
 const configuration=defaultConfiguration(profile),scene=model.scenes[0],episodeUid=scene.episodeUid,sceneContext=capture.responses.sceneReviewContext.context;
 expect(model.scenes.length).toBeGreaterThan(0);expect(snapshot.creativeLineage.scenes.length).toBeGreaterThan(0);expect(typeof episodeUid).toBe('string');expect(episodeUid.length).toBeGreaterThan(0);expect(model.shots).toEqual([]);
 expect(model.episodes.find((episode:{episodeUid:string})=>episode.episodeUid===episodeUid)?.sceneIds).toContain(scene.id);
 expect(sceneContext.sceneId).toBe(scene.id);expect(sceneContext.episodeUid).toBe(episodeUid);expect(sceneContext.sceneDocument.scriptBlocks.length).toBeGreaterThan(0);expect(sceneContext.sceneDocument.contentHash).toBe(sceneContext.sceneContentHash);expect(sceneContext.sceneContentHash).toMatch(/^[a-f0-9]{64}$/);
 Object.assign(model,{systemConfiguration:{config:configuration},workItems:[],workPackages:[],assetFamilies:[],assetVersions:[],expectedOutputs:[],counts:{...model.counts,currentShotSpecCount:0,currentP07ShotPlans:0}});
 const episodes=[{episodeUid,displayId:'E01',title:'有正文的准备上下文',sceneIds:[scene.id]}];
 const scenes=[{sceneId:scene.id,displayId:scene.displayId,episodeUid,sceneContentHash:sceneContext.sceneContentHash,sourceSummary:{title:'门外等待'},preparation:{sceneRole:'先核对当前场的制作意图',audienceTakeaway:'访客尚在门外',materialGaps:['门外状态素材尚未就绪'],nextPreparationAction:'明确门向与人物站位',generationAuthorized:false,formalShotIds:[]}}];
 const preparation={releaseId:'release-pipeline-entry',revisionId:'prep-pipeline-entry',stale:false,readOnly:true,comments:[],content:{basis:{candidateRevisionId:'candidate-pipeline-entry',candidateContentHash:'b'.repeat(64)},episodes,scenes},candidate:{revisionId:'candidate-pipeline-entry',contentHash:'b'.repeat(64),episodes,scenes:scenes.map(s=>({id:s.sceneId,displayId:s.displayId,title:s.sourceSummary.title}))}};
 const state={unexpected:[] as string[],writes:[] as string[],errors:[] as string[],productionRequests:[] as string[]};
 page.on('pageerror',e=>state.errors.push(e.message));
 await page.route('**/api/**',async route=>{
  const request=route.request(),url=new URL(request.url()),json=(value:unknown)=>route.fulfill({json:value});
  if(url.pathname==='/api/assistant/v1/context'&&request.method()==='POST')return json({context:{focus:request.postDataJSON().focus,resources:[],missing:[],draftTargets:[]}});
  if(!['GET','HEAD'].includes(request.method())){state.writes.push(request.method()+' '+url.pathname);return route.fulfill({status:418,json:{error:'FIXTURE_MUTATION_BLOCKED'}});}
  if(url.pathname==='/api/instance/profile')return json(profile);
  if(url.pathname==='/api/v8/ui/bootstrap')return json({data:snapshot,snapshotId:snapshot.snapshotId});
  if(url.pathname==='/api/v8/episode-production')return json({snapshotId:snapshot.snapshotId,episode:{episodeUid:url.searchParams.get('episodeUid'),displayId:'E01'},sceneId:url.searchParams.get('sceneId'),release:null,plans:[],wholePlanAdopted:false,formalShotCount:null});
  if(url.pathname==='/api/instance/shot-production')return json({sceneId:url.searchParams.get('sceneId'),releaseId:'release-pipeline-entry',readOnly:true,basis:null,blockers:['尚未建立正式镜头设计'],defaultContent:null,currentPlan:null,draft:null,draftHeadRevisionId:null,availableInputs:[],jobs:[],readiness:{ready:false,readyCount:0,shotCount:null,shots:[]}});
  if(url.pathname==='/api/v8/ui/production'){
   state.productionRequests.push(url.search);
   return json({schemaVersion:'1.0',snapshotId:snapshot.snapshotId,operationRevision:'op-pipeline-entry',page:{workItems:[],workPackages:[],shots:[],assetFamilies:[],assetVersions:[],expectedOutputs:[]},count:0,total:0,nextCursor:null,hasMore:false,appliedFilters:{}});
  }
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
