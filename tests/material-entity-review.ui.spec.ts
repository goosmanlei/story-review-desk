/**
 * Integrate at tests/material-entity-review.ui.spec.ts.
 * Run with tests/review-feedback.ui.config.ts against owner-started neutral 4294.
 * Real browser/components; synthetic business responses only. Every API request
 * is intercepted, unexpected reads/writes fail closed; no live data or media.
 */
import {test,expect,type Page,type Locator} from '@playwright/test';
import {materialDisplayText,materialCriterionDescription,materialExtraReviewPoints} from '../app/material-review-display';
import {readFileSync} from 'node:fs';
import {defaultConfiguration} from '../host/instance-runtime/configuration-model.mjs';
import {workspaceProjection} from '../host/instance-runtime/domain-workspaces.mjs';
import type {DomainGraph} from '../host/instance-runtime/domain-model.mjs';
import type {ExpectedOutput,MaterialRequirement} from '../app/production-workbench';

const base=JSON.parse(readFileSync(new URL('./fixtures/generic-adopted-scene.json',import.meta.url),'utf8'));
const ids={a:'material-person-a',b:'material-person-b',place:'material-place',day:'material-state-day',night:'material-state-night',bday:'material-state-b',empty:'material-state-empty',ep1:'material-episode-uid-1',ep2:'material-episode-uid-2',s1:'material-scene-uid-1',s2:'material-scene-uid-2'};
const hash=(n:number)=>n.toString(16).padStart(64,'0');
test('主页面一次读取完整素材依赖，试制目录未齐前不展示，子页面不重复读取',async({page})=>{
 const f=await materialFixture(page),counts=new Map<string,number>();let release!:()=>void;
 const pending=new Promise<void>(resolve=>{release=resolve;});
 page.on('request',request=>{const url=new URL(request.url());if(['/api/instance/domain-workspaces','/api/instance/material-directory','/api/instance/production-preparation'].includes(url.pathname))counts.set(url.pathname,(counts.get(url.pathname)||0)+1);});
 await page.route('**/api/trial/scopes',async route=>{await pending;await route.fallback();});
 await page.goto('/?view=materials');await expect.poll(()=>f.materialRequests.length).toBeGreaterThan(0);await expect(root(page)).not.toBeVisible();
 release();await expect(root(page)).toBeVisible();await page.waitForTimeout(100);
 expect([...counts.values()]).toEqual([1,1,1]);clean(f);
});
test('五轴素材筛选都可再次点击取消，其他筛选保持不变',async({page})=>{
 const f=await materialFixture(page);await open(page,'classification');
 expect(f.materialRequests.every(query=>!new URLSearchParams(query).has('requirementId'))).toBe(true);
 for(const [axis,label] of [['媒介','图像'],['实体类别','人物'],['集','E01'],['场','S01'],['推进到哪一步','已定义']]){
  const selected=chip(page,axis,label);await selected.click();await expect(selected).toHaveAttribute('aria-pressed','true');
  await selected.click();await expect(selected).toHaveAttribute('aria-pressed','false');
  await expect(facet(page,axis).locator('button[aria-pressed="true"]')).toHaveCount(1);
 }
 await chip(page,'媒介','图像').click();await chip(page,'实体类别','人物').click();await chip(page,'实体类别','人物').click();await expect(chip(page,'媒介','图像')).toHaveAttribute('aria-pressed','true');clean(f);
});
test('关闭浮层的显式未知实体深链不清空身份或选中默认实体',async({page})=>{
 const f=await materialFixture(page);await page.goto('/?view=materials&materialPanel=closed&entity=UNKNOWN_ID');
 await expect(page.getByText('所选实体身份未匹配当前目录，已保留原值；请核对来源或重新选择实体。',{exact:true})).toBeVisible();
 await expect(root(page).locator('[data-entity-id][aria-pressed="true"]')).toHaveCount(0);await expect(drawer(page)).not.toBeVisible();expect(new URL(page.url()).searchParams.get('entity')).toBe('UNKNOWN_ID');clean(f);
});
test('跨模块返回恢复实体、类别和相机但不重开详情，刷新保持当前浏览',async({page})=>{
 const f=await materialFixture(page,{flatProof:true});
 await page.route('**/api/instance/maintenance',route=>route.fulfill({json:{runtime:{status:'测试维护'},storage:{provider:'PostgreSQL'},backups:[],operations:[],capabilities:{},readOnly:true}}));
 await open(page,'classification');await root(page).locator('[data-entity-id="'+ids.a+'"]').click();await chip(page,'实体类别','人物').click();await fit(page);
 const viewport=root(page).locator('.free-canvas-viewport');await viewport.focus();await viewport.press('ArrowRight');const camera=await viewport.getAttribute('data-canvas-x');
 await node(page,ids.a).dblclick();await expect(drawer(page)).toHaveAttribute('data-material-panel','entity');
 await closeDrawer(page);
 await page.locator('.workspace-nav button').filter({hasText:'系统管理'}).click();
 await page.locator('.workspace-nav button').filter({hasText:'素材管理'}).click();
 await expect(root(page).locator('[data-entity-id="'+ids.a+'"]')).toHaveAttribute('aria-pressed','true');
 await expect(chip(page,'实体类别','人物')).toHaveAttribute('aria-pressed','true');await expect(drawer(page)).not.toBeVisible();await expect(viewport).toHaveAttribute('data-canvas-x',camera!);
 await page.reload();await expect(chip(page,'实体类别','人物')).toHaveAttribute('aria-pressed','true');await expect(drawer(page)).not.toBeVisible();await expect(viewport).toHaveAttribute('data-canvas-x',camera!);
 await node(page,ids.a).dblclick();await expect(drawer(page)).toHaveAttribute('data-material-panel','entity');
 // A full navigation away from an open drawer also restores only its browsing context.
 await page.goto('/?view=system');await page.locator('.workspace-nav button').filter({hasText:'素材管理'}).click();await expect(drawer(page)).not.toBeVisible();await expect(root(page).locator('[data-entity-id="'+ids.a+'"]')).toHaveAttribute('aria-pressed','true');clean(f);
});
function requirement(id:string,title:string,mediaKind:string,category:string,index:number):MaterialRequirement{
 // Every fixture need carries a stable permanent identity.
 return {id,title,category,mediaKind,requirementClass:'REQUIRED',reuseScope:'PROJECT',productionLane:'MATERIAL_PREP',workflowStepId:null,assetFamilyRefs:[],plannedAssetFamilyId:null,materialWorkItemRef:'work-'+id,consumerWorkItemRefs:[],episodeIds:[],episodeUids:[],sceneIds:[],shotIds:[],currentShotIds:[],structureCardRefs:[],storyBasis:{sourceRef:'fixture-exact-source',factBoundary:'合成测试资料，不是故事事实或媒体观察',whyNeeded:'辨认主体并保持连续性',onScreenRequirement:title},storyApplicability:{kind:'PROJECT_LEVEL',reason:'跨场复用；用途另行精确绑定'},acceptanceProfile:'FIXTURE',acceptanceCriteria:['身份与状态不混淆','未知不得冒充事实'],requirementHash:hash(index),coverageContextHash:hash(index),coverageSatisfied:index===4,bindingStale:false,coverageReasons:index===4?[]:['NO_CURRENT_OUTPUT'],coveredByFamilyRefs:[],coveredByVersionRefs:[],materialWorkItemLifecycleState:'WAITING_UPSTREAM'};
}
async function materialFixture(page:Page,{fullDenominator=false,definitionOnly=false,wideScopes=false,flatProof=false,stateAuditProjection='both',trialMediaMismatch=false,compactReview=false,realizedExpected=false}={}){
 const capture=structuredClone(base),snapshot=capture.responses.bootstrap.data,profile=snapshot.instance;
 profile.capabilities.landingView='materials';const configuration=defaultConfiguration(profile);
 const requirements=[requirement('MATREQ-FIXTURE-A','人物甲白天形象','IMAGE','人物身份',1),requirement('MATREQ-FIXTURE-A-VOICE','人物甲夜间声音','AUDIO','声音身份',2),requirement('MATREQ-FIXTURE-B','人物乙来访形象','IMAGE','人物身份',3),requirement('MATREQ-FIXTURE-PLACE','小店空态画面','IMAGE','地点空态',4),requirement('MATREQ-FIXTURE-TEXT','小店对白说明','TEXT','对白文本',5)];
 if(fullDenominator)for(let index=6;index<=201;index++)requirements.push(requirement('MATREQ-FIXTURE-'+index,'人物甲补充素材 '+index,'IMAGE','人物身份',index));
 if(definitionOnly)requirements.splice(0);
 const entity=(id:string,name:string,type:string)=>({id,name,type,description:name+'的素材与状态准备。',aliases:[],authority:'A' as const,evidence:[]});
 const state=(id:string,entityId:string,label:string,dimensions:Record<string,string>)=>({id,entityId,label,dimensions,scope:[],authority:'A' as const,evidence:[]});
 const graph:DomainGraph={schemaVersion:'1.0',entities:[entity(ids.a,'人物甲','CHARACTER'),entity(ids.b,'人物乙','CHARACTER'),entity(ids.place,'小店','LOCATION')],states:[state(ids.day,ids.a,'白天身份',{storyTime:'白天'}),state(ids.night,ids.a,'夜间西侧',{storyTime:'夜间',viewpoint:'西侧'}),state(ids.bday,ids.b,'来访阶段',{storyTime:'来访时'}),state(ids.empty,ids.place,'空态北向',{viewpoint:'北向'})],representations:[],requirements:[],relations:[{id:'material-state-development',type:'CONTINUITY',from:{kind:'STATE',id:ids.day},to:{kind:'STATE',id:ids.night},label:'入夜后的发展',purpose:'',inherit:[],exclude:[],scope:[],authority:'A',evidence:[],status:'PROPOSED'}]};
 const bindings=requirements.map((item,index)=>({requirementId:item.id,requirementHash:item.requirementHash,entityId:index===2?ids.b:[3,4].includes(index)?ids.place:ids.a,stateId:index===1?ids.night:index===2?ids.bday:[3,4].includes(index)?ids.empty:ids.day}));
 graph.representations=bindings.map(binding=>({id:'rep-'+binding.requirementId,entityId:binding.entityId,stateId:binding.stateId,type:'IDENTITY',label:requirements.find(item=>item.id===binding.requirementId)!.title,dimensions:{},assetFamilyIds:[],requirementIds:[binding.requirementId],authority:'A',evidence:[]}));
 if(flatProof)graph.relations.push({id:'material-exact-reference',type:'VISUAL_REFERENCE',from:{kind:'REPRESENTATION',id:'rep-MATREQ-FIXTURE-A'},to:{kind:'REPRESENTATION',id:'rep-MATREQ-FIXTURE-A-VOICE'},label:'已登记声音视觉参考',purpose:'仅证明参考定义，非实际输入',inherit:[],exclude:[],scope:[],authority:'A',evidence:[],status:'PROPOSED'});
 const imageUrl='data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="16" height="9"%3E%3Crect width="16" height="9" fill="%23796"/%3E%3C/svg%3E';
 const assetFamilies=flatProof?[{id:'fixture-family-a',label:'人物甲图像族',kind:'IMAGE',subtype:'IDENTITY',episodeIds:[],sceneIds:[],segmentIds:[],shotIds:[],currentVersionId:'fixture-family-a@V001',versionRefs:['fixture-family-a@V001','fixture-family-a@V002'],sourceRef:'fixture',outputState:'PRESENT',lifecycleState:'RELEASED'}]:[];
 const assetVersions=flatProof?[1,2].map(version=>({id:'fixture-family-a@V00'+version,familyId:'fixture-family-a',label:'人物甲版本 '+version,path:'fixture-person-a-v'+version+'.png',sha256:hash(900+version),preview:imageUrl,mediaUrl:imageUrl,audioProxy:null,promptRef:null,model:null,historyId:null,resourceId:null,sourceRef:'fixture',outputState:'PRESENT',lifecycleState:'RELEASED',historyRole:'CURRENT'})):[];
 const expectedOutputs:ExpectedOutput[]=realizedExpected?[{id:'EXPECTED_OUTPUT:fixture-family-a@V001',familyId:'fixture-family-a',label:'旧精确计划',targetPath:'fixture-person-a-v1.png',plannedVersionLabel:'V001',legacyVersionId:'fixture-family-a@PLANNED-V001',expectationState:'REALIZED',realizedVersionId:'fixture-family-a@V001',realizedVersionSha256:hash(901)}]:[];
 if(realizedExpected)Object.assign(assetFamilies[0],{expectedOutputRefs:expectedOutputs.map(item=>item.id),currentExpectedOutputId:null});
 if(flatProof){requirements[0].assetFamilyRefs=['fixture-family-a'];graph.representations[0].assetFamilyIds=['fixture-family-a'];}
 if(compactReview){Object.assign(requirements[0],{acceptanceCriteria:['身份清晰','UNKNOWN',' '],storyBasis:{sourceRef:'fixture-exact-source',whyNeeded:'UNKNOWN',onScreenRequirement:'独立补充：服装连续',factBoundary:'UNKNOWN'},reviewSpec:{profileId:'compact-review',configurationHash:hash(750),hash:hash(751),criteria:['身份清晰','服装连续','构图可用','无多余文字'].map((label,index)=>({id:'compact-criterion-'+index,label,question:label,required:true,allowNA:false,noteRequiredOnFail:false}))}});assetVersions[1].lifecycleState='REVIEW_PENDING';}
 const workItems=requirements.map((item,index)=>({id:item.materialWorkItemRef,label:item.title,lane:'MATERIAL_PREP',workflowStepId:null,requirementRef:item.id,requirementHash:item.requirementHash,scopeType:'PROJECT',scopeId:profile.projectId,episodeIds:[],sceneIds:[],shotIds:[],inputAssetRefs:[],outputAssetRef:'',additionalOutputAssetRefs:[],consumerWorkItemRefs:[],sourceRef:'fixture-exact-source',executionDefinitionRef:null,applicabilityState:'REQUIRED',lifecycleState:['WAITING_UPSTREAM','READY_TO_START','REVIEW_PENDING','RELEASED'][index]||'WAITING_UPSTREAM',flowBlockReasons:[],executionBlockReasons:[]}));
 if(compactReview)Object.assign(workItems[0],{executionDefinitionRef:'fixture-compact-recipe',outputAssetRef:'fixture-family-a'});
 Object.assign(snapshot.productionModel,{domainGraph:graph,systemConfiguration:{config:configuration},materialRequirements:requirements,materialWorkItems:workItems,assetFamilies,assetVersions,expectedOutputs});
 // Existing published episodes deliberately differ. Candidate permanent IDs and
 // exact hashes, not historical E01/S01 aliases, must drive the material axes.
 const episodes=[{episodeUid:ids.ep1,displayId:'E01',title:'白天到店',sceneIds:[ids.s1]},{episodeUid:ids.ep2,displayId:'E02',title:'夜间来访',sceneIds:[ids.s2]}];
 const scenes=[{id:ids.s1,displayId:'S01',title:'白天入店',contentHash:hash(301)},{id:ids.s2,displayId:'S02',title:'夜间访客',contentHash:hash(302)}];
 if(wideScopes){for(let index=3;index<=22;index++)episodes.push({episodeUid:'extra-episode-'+index,displayId:'E'+String(index).padStart(2,'0'),title:'候选集 '+index,sceneIds:[]});for(let index=3;index<=142;index++)scenes.push({id:'extra-scene-'+index,displayId:'S'+String(index).padStart(3,'0'),title:'候选场 '+index,contentHash:hash(1000+index)});}
 const refs=(indexes:number[])=>indexes.filter(index=>requirements[index]).map(index=>({requirementId:requirements[index].id,requirementHash:requirements[index].requirementHash,reason:'精确准备关联',matchKind:'EXACT_PROPOSAL'}));
 const preparation={releaseId:'release-fixture',revisionId:'preparation-fixture',stale:false,materialLinksStale:false,readOnly:true,formalAdoptionPerformed:false,denominatorState:'UNKNOWN',candidate:{revisionId:'candidate-fixture',contentHash:hash(300),episodes,scenes},materialLinks:{scenes:[{sceneId:ids.s1,sceneContentHash:scenes[0].contentHash,references:refs([0,1,3,0]),unboundNeeds:[]},{sceneId:ids.s2,sceneContentHash:scenes[1].contentHash,references:refs([0,2,4]),unboundNeeds:[]}]}};
 const trialAssets=[1,2].map(version=>({id:'trial-asset-'+version,mediaId:'trial-media-'+version,versionId:'trial-version-'+version,sha256:hash(800+version),mediaKind:'IMAGE',mediaUrl:'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="16" height="9"/%3E',version,lifecycle:version===1?'REVISION_REQUIRED':'RELEASED',title:'独立试制 0',metadata:{RIGHTS_STATUS:'UNKNOWN'},prompt:'合成试制测试，无真实生成',qa:{},reviewCriteria:[],latestReview:{payload:{decision:version===1?'REVISION_REQUIRED':'RELEASED',comment:version===1?'原返修意见':'原项目内放行意见'}},reviewHeadId:'trial-review-'+version}));
 const trials=Array.from({length:definitionOnly?0:6},(_,index)=>({trialThemeId:'trial-fixture-'+index,entityId:ids.a,stateId:ids.day,title:'独立试制 '+index,mediaType:'IMAGE',displayState:'已通过',reason:'独立试制不计正式需求分母',versions:index===0?trialAssets.map(asset=>({mediaId:asset.mediaId,versionId:asset.versionId,sha256:asset.sha256,lifecycle:asset.lifecycle})):[]}));
 const workspaceGraph=structuredClone(graph),directoryGraph=structuredClone(graph);
 if(stateAuditProjection==='workspace-only')directoryGraph.states=directoryGraph.states.filter(row=>row.id!==ids.day);
 if(stateAuditProjection==='directory-only'){workspaceGraph.states=workspaceGraph.states.filter(row=>row.id!==ids.day);Object.assign(directoryGraph.states.find(row=>row.id===ids.day)!,{directoryOnly:true,appliesTo:'DIRECTORY_METADATA_ONLY'});}
 if(trialMediaMismatch)trialAssets[0].mediaId='wrong-media-same-version-and-sha';
 const directory={graph:directoryGraph,bindings,trials,staleIds:[],revisionId:'directory-fixture',releaseId:'release-fixture',readOnly:!definitionOnly};
 const operations={...capture.responses.operations,snapshotId:snapshot.snapshotId,mutationEtag:'"material-fixture"'};
 if(compactReview)operations.stateProjection={...operations.stateProjection,assetVersionsById:{...operations.stateProjection?.assetVersionsById,'fixture-family-a@V002':{reviewContextHash:hash(760),lifecycleState:'REVIEW_PENDING',outputState:'PRESENT',projectRightsGate:'UNKNOWN'}}};
 const aiRequests:unknown[]=[];
 const unexpected:string[]=[],writes:string[]=[],errors:string[]=[],materialRequests:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/api/**',async route=>{
  const request=route.request(),url=new URL(request.url()),json=(value:unknown)=>route.fulfill({json:value});
  if(url.pathname==='/api/assistant/v1/context'&&request.method()==='POST')return json({context:{focus:request.postDataJSON().focus,resources:[],missing:[],draftTargets:[]}});
  if(compactReview&&url.pathname==='/api/v8/material-review-drafts'&&request.method()==='POST'){aiRequests.push(request.postDataJSON());return json({draft:{qualityRecommendation:'QUALITY_PASS_ON_OBSERVED_EVIDENCE',summary:'仅合成测试 AI 草稿，不是媒体观察',observations:[],unobserved:['权利尚未核验'],criterionFindings:requirements[0].reviewSpec!.criteria.map(c=>({criterionId:c.id,verdict:'PASS',note:'fixture草稿 '+c.id})),overallNote:'AI合成意见',revisionInstructions:{preserve:[],change:[],mustNotRegress:[]}}});}
  if(!['GET','HEAD'].includes(request.method())){writes.push(request.method()+' '+url.pathname);return route.fulfill({status:418,json:{error:'FIXTURE_MUTATION_BLOCKED'}});}
  if(compactReview&&url.pathname==='/api/v8/asset-versions'){const versionId=url.searchParams.get('versionId');return json({events:versionId==='fixture-family-a@V002'?[{eventId:'fixture-generation',familyId:'fixture-family-a',versionId,sha256:hash(902),actualPromptHash:hash(761),actualPrompt:{main:'本次实际旧Prompt'},recipePromptHash:hash(762),promptChangedFromCallPackage:true,promptSyncRequired:true,runId:'fixture-run',callPackageHash:hash(763),inputBindings:[{order:1,path:'fixture-actual-input.png',assetFamilyRef:'fixture-input-family',assetVersionRef:'fixture-input@V001',sha256:hash(764)}],inputBindingsHash:hash(765)}]:[]});}
  if(realizedExpected&&url.pathname==='/api/v8/asset-versions')return json({events:[]});
  if(compactReview&&url.pathname==='/api/v8/recipes/fixture-compact-recipe')return json({recipe:{id:'fixture-compact-recipe',title:'合成制作定义',pipelineStageCode:'P03',executorKind:'MODEL_API',definitionHash:hash(763),currentRevisionId:'fixture-recipe-r1',upload:{items:[{order:1,path:'fixture-current-input.png'}],rawText:'当前附件定义'},model:{branch:'fixture-model',rawRule:'fixture',resolution:'1920x1080'},parametersRaw:'seed=42',prompt:{main:'当前权威Prompt不等于历史实际Prompt',negative:'无多余文字',negativeApplication:'APPEND'},output:{path:'fixture-output.png',mediaType:'IMAGE'},declaredGate:'INTERNAL_MACHINE_ONLY',rawSourceBlock:'fixture-only'}});
  if(url.pathname==='/api/trial/scopes')return json({scopes:[{id:'trial-fixture',countsTowardFormalProject:false}],defaultScopeId:'trial-fixture'});
  if(url.pathname==='/api/trial/snapshot')return json({mode:'LOCAL_TRIAL',scope:{id:'trial-fixture',countsTowardFormalProject:false},recipes:[],assets:trialAssets,mutationEtag:'trial-fixture'});
  if(url.pathname==='/api/instance/profile')return json(profile);
  if(url.pathname==='/api/v8/ui/bootstrap')return json({data:snapshot,snapshotId:snapshot.snapshotId});
  if(url.pathname==='/api/v8/snapshot')return json(snapshot);
  if(url.pathname==='/api/v8/operations/snapshot')return json(operations);
  if(url.pathname==='/api/v8/ui/materials'){
   materialRequests.push(url.search);const id=url.searchParams.get('requirementId'),items=id?requirements.filter(item=>item.id===id):requirements;
   return json({schemaVersion:'1.0',snapshotId:snapshot.snapshotId,operationRevision:'op-fixture',appliedMode:'requirements',detailState:'COMPLETE',page:{materialRequirements:items,materialWorkItems:workItems.filter(item=>!id||item.requirementRef===id),assetFamilies,assetVersions,expectedOutputs},count:items.length,total:items.length,nextCursor:null,hasMore:false,appliedFilters:{}});
  }
  if(url.pathname==='/api/instance/domain-workspaces')return json({...workspaceProjection(snapshot,workspaceGraph,'MATERIAL'),requirements,readOnly:!definitionOnly,releaseId:'release-fixture',revisionId:'graph-fixture',draft:null,draftHeadRevisionId:null,legacyDrafts:[]});
  if(url.pathname==='/api/instance/material-directory')return json(directory);
  if(url.pathname==='/api/instance/production-preparation')return json(preparation);
  if(url.pathname==='/api/instance/configuration')return json({configuration,defaults:configuration,releaseId:'release-fixture',revisionId:'config-fixture',sha256:hash(400),history:[],bindings:[],boundStandards:[],reviewCatalog:{},initialized:true,draft:null,readOnly:true});
  if(url.pathname==='/api/instance/relations')return json({graph,configuration:configuration.domain,revisionId:'graph-fixture',releaseId:'release-fixture',readOnly:true,draft:null});
  if(url.pathname==='/api/assistant/v1/conversations')return json({conversations:[],bridge:{online:false},pagination:{}});
  if(url.pathname==='/api/v8/reviews')return json({events:[]});
  if(url.pathname==='/api/instance/documents')return json({documents:[]});
  for(const[key,value]of Object.entries(capture.routes))if(url.pathname===String(value).split('?')[0])return json(capture.responses[key]);
  unexpected.push(request.method()+' '+url.pathname);return route.fulfill({status:418,json:{error:'UNEXPECTED_FIXTURE_API'}});
 });return {requirements,graph,assetFamilies,assetVersions,expectedOutputs,unexpected,writes,errors,materialRequests,aiRequests,bootstrapData:snapshot};
}
type Fixture=Awaited<ReturnType<typeof materialFixture>>;
function clean(f:Fixture){expect(f.unexpected,'No business API may escape interception').toEqual([]);expect(f.writes).toEqual([]);expect(f.errors).toEqual([]);}
const root=(page:Page)=>page.locator('.material-entity-review');
const facet=(page:Page,label:string)=>root(page).locator(`[data-material-facet="${label}"]`);
const chip=(page:Page,axis:string,label:string)=>facet(page,axis).getByRole('button',{name:new RegExp(`^${axis}：${label}，\\d+项需求$`)});
async function count(page:Page,axis:string,label:string,expected:number){await expect(chip(page,axis,label)).toHaveAccessibleName(`${axis}：${label}，${expected}项需求`);}
async function dimensions(locator:Locator){await expect(locator).toBeVisible();const value=await locator.boundingBox();expect(value).not.toBeNull();return value!;}
async function open(page:Page,mode:string){await page.goto('/?view=materials&materialMode='+mode);await expect(root(page)).toHaveAttribute('data-material-view','classification');await expect.poll(()=>new URL(page.url()).searchParams.get('materialMode')).toBe('classification');await expect(page.getByRole('tablist',{name:'素材管理视角'})).toHaveCount(0);await expect(page.getByRole('tab',{name:'剧集视角管理',exact:true})).toHaveCount(0);await count(page,'媒介','全部媒介',5);}


const drawer=(page:Page)=>root(page).locator('dialog.material-review-drawer');
const node=(page:Page,id:string)=>root(page).locator('[data-canvas-node-id="'+id+'"]');
async function fit(page:Page){await root(page).locator('.material-entity-workspace').getByRole('button',{name:'适配全图',exact:true}).click();}
async function closeDrawer(page:Page){await drawer(page).getByRole('button',{name:'关闭详情',exact:true}).click();await expect(drawer(page)).not.toBeVisible();}

test('原生素材缺少用途上下文时先等精确详情，再保留原版本并显示不可用',async({page})=>{
 const f=await materialFixture(page,{flatProof:true,realizedExpected:true});
 // Native DOMAIN_GRAPH detail legitimately omits this legacy presentation field.
 const nativeRequirement:Partial<MaterialRequirement>=f.requirements[0];delete nativeRequirement.storyBasis;
 let releaseDetail!:()=>void;const detailGate=new Promise<void>(resolve=>{releaseDetail=resolve;});let requested=false;
 await page.route('**/api/v8/ui/materials?**',async route=>{
  if(new URL(route.request().url()).searchParams.get('requirementId')==='MATREQ-FIXTURE-A'){requested=true;await detailGate;}
  await route.fallback();
 });
 await page.goto('/?view=materials&material=MATREQ-FIXTURE-A&family=fixture-family-a&version=fixture-family-a%40V001');
 await expect.poll(()=>requested).toBe(true);await expect(drawer(page).getByText('正在读取这项素材的产物、版本、审阅与完整生产资料…',{exact:true})).toBeVisible();
 await expect(drawer(page).locator('[data-material-info-id]')).toHaveCount(0);releaseDetail();
 const card=drawer(page).locator('[data-material-info-id="MATREQ-FIXTURE-A"]');await expect(card).toHaveAttribute('data-family-id','fixture-family-a');
 await expect(card.getByText('当前详情未提供用途上下文，暂不可用。',{exact:true})).toBeVisible();
 await expect(card.locator('[data-material-section="production"]')).toHaveAttribute('data-production-version-id','fixture-family-a@V001');
 await expect(card.locator('[data-material-section="purpose-usage"]')).not.toContainText('辨认主体并保持连续性');
 expect(new URL(page.url()).searchParams.get('version')).toBe('fixture-family-a@V001');clean(f);
});

test('素材深链不在bootstrap摘要时直接读取所选需求，不请求默认条目',async({page})=>{
 const f=await materialFixture(page),requestedId='MATREQ-FIXTURE-B';
 const summary=structuredClone(f.bootstrapData);summary.productionModel.materialRequirements=f.requirements.filter(r=>r.id!==requestedId);
 await page.route('**/api/v8/ui/bootstrap',route=>route.fulfill({json:{data:summary,snapshotId:summary.snapshotId}}));
 await page.route('**/api/v8/ui/materials?**',route=>{
  if(new URL(route.request().url()).searchParams.has('requirementId'))return route.fallback();
  return route.fulfill({json:{schemaVersion:'1.0',snapshotId:summary.snapshotId,detailState:'SUMMARY',page:{materialRequirements:summary.productionModel.materialRequirements},count:4,total:4,nextCursor:null,hasMore:false,appliedFilters:{}}});
 });
 await page.goto('/?view=materials&material='+requestedId);
 await expect(drawer(page).locator('[data-material-info-id="'+requestedId+'"]').getByText('人物乙来访形象',{exact:true}).first()).toBeVisible();
 const exactRequests=f.materialRequests.map(query=>new URLSearchParams(query).get('requirementId')).filter(Boolean);
 expect(exactRequests.length).toBeGreaterThan(0);expect(new Set(exactRequests)).toEqual(new Set([requestedId]));
 expect(new URL(page.url()).searchParams.get('material')).toBe(requestedId);clean(f);
});

test('素材精确详情误返摘要时显示不可用且重读，不渲染摘要为完整卡',async({page})=>{
 const f=await materialFixture(page);let detailAttempts=0;
 await page.route('**/api/v8/ui/materials?**',route=>{
  if(new URL(route.request().url()).searchParams.get('requirementId')!=='MATREQ-FIXTURE-A')return route.fallback();
  detailAttempts++;if(detailAttempts>1)return route.fallback();
  return route.fulfill({json:{schemaVersion:'1.0',snapshotId:f.bootstrapData.snapshotId,detailState:'SUMMARY',page:{materialRequirements:[f.requirements[0]]},count:1,total:1,nextCursor:null,hasMore:false,appliedFilters:{}}});
 });
 await page.goto('/?view=materials&material=MATREQ-FIXTURE-A');
 await expect(drawer(page).getByRole('alert')).toHaveText('当前返回的是素材摘要，完整详情暂不可用。');await expect(drawer(page).locator('[data-material-info-id]')).toHaveCount(0);
 await drawer(page).getByRole('button',{name:'重新读取素材详情',exact:true}).click();await expect(drawer(page).locator('[data-material-info-id="MATREQ-FIXTURE-A"]')).toBeVisible();
 expect(detailAttempts).toBe(2);clean(f);
});

for(const width of [1440,390])test(width+'px素材单击只高亮精确直接关联，全图曲线与阅读相机保持原位',async({page})=>{
 const f=await materialFixture(page,{flatProof:true});await page.setViewportSize({width,height:1000});await open(page,'classification');await root(page).locator('[data-entity-id="'+ids.a+'"]').click();await fit(page);
 const workspace=root(page).locator('.material-entity-workspace'),viewport=workspace.locator('.free-canvas-viewport'),selected='material:MATREQ-FIXTURE-A';
 const geometry=()=>viewport.evaluate(element=>({camera:['data-canvas-x','data-canvas-y','data-canvas-scale'].map(name=>element.getAttribute(name)),nodes:[...element.querySelectorAll('[data-canvas-node-id]')].map(node=>({id:node.getAttribute('data-canvas-node-id'),x:node.getAttribute('data-canvas-node-x'),y:node.getAttribute('data-canvas-node-y')})),edges:[...element.querySelectorAll('[data-canvas-edge-path]')].map(edge=>({id:edge.getAttribute('data-canvas-edge-path'),from:edge.getAttribute('data-canvas-edge-from'),to:edge.getAttribute('data-canvas-edge-to'),d:edge.getAttribute('d')}))}));
 const before=await geometry(),url=page.url(),graph=JSON.stringify(f.graph);expect(before.nodes).toHaveLength(9);expect(before.edges.some(edge=>edge.id==='material-exact-reference')).toBe(true);expect(before.edges.every(edge=>/C/.test(edge.d||''))).toBe(true);
 await node(page,selected).click();await expect(node(page,selected)).toHaveAttribute('aria-pressed','true');await expect(drawer(page)).not.toBeVisible();expect(page.url()).toBe(url);expect(await geometry()).toEqual(before);
 const relatedEdges=before.edges.filter(edge=>edge.from===selected||edge.to===selected),relatedNodes=[...new Set([selected,...relatedEdges.flatMap(edge=>[edge.from!,edge.to!])])].sort();
 expect(relatedNodes).toEqual([ids.a,'material:MATREQ-FIXTURE-A','material:MATREQ-FIXTURE-A-VOICE'].sort());
 await expect.poll(()=>viewport.locator('[data-canvas-node-related="true"]').evaluateAll(elements=>elements.map(element=>element.getAttribute('data-canvas-node-id')).sort())).toEqual(relatedNodes);
 await expect.poll(()=>viewport.locator('[data-canvas-edge-path][data-canvas-related="true"]').evaluateAll(elements=>elements.map(element=>element.getAttribute('data-canvas-edge-path')).sort())).toEqual(relatedEdges.map(edge=>edge.id).sort());
 await expect(node(page,'material:trial-fixture-0')).toHaveAttribute('data-canvas-node-related','false');
 const strokes=await viewport.locator('[data-canvas-edge-path]').evaluateAll(elements=>elements.map(element=>({related:element.getAttribute('data-canvas-related'),stroke:getComputedStyle(element).stroke})));expect(strokes.some(edge=>edge.related==='false')).toBe(true);expect(strokes.find(edge=>edge.related==='true')!.stroke).not.toBe(strokes.find(edge=>edge.related==='false')!.stroke);
 await expect(workspace.locator('.board-readable-list')).toHaveCount(0);await expect(workspace.getByRole('button',{name:'聚焦关联',exact:true})).toHaveCount(0);await expect(workspace.getByRole('button',{name:'全部连线',exact:true})).toHaveCount(0);await expect(workspace.locator('.free-canvas-edge-label[data-canvas-edge^="entity-material:"]')).toHaveCount(0);for(const edge of before.edges){await expect(workspace.locator('[data-canvas-edge-hit="'+edge.id+'"]')).toHaveAttribute('role','button');}
 await node(page,'material:trial-fixture-0').focus();await page.keyboard.press('Enter');await expect(drawer(page)).not.toBeVisible();await expect(node(page,'material:trial-fixture-0')).toHaveAttribute('aria-pressed','true');expect(await geometry()).toEqual(before);expect(page.url()).toBe(url);
 await workspace.getByRole('button',{name:'取消高亮',exact:true}).click();await expect(viewport.locator('[data-canvas-node-related="true"]')).toHaveCount(0);expect(await geometry()).toEqual(before);expect(JSON.stringify(f.graph)).toBe(graph);clean(f);
});

test('素材双击与Shift+Enter才打开精确实体和素材，单击可高亮且节点仍可个人拖动',async({page})=>{
 const f=await materialFixture(page,{flatProof:true});await page.setViewportSize({width:1440,height:1000});await open(page,'classification');await root(page).locator('[data-entity-id="'+ids.a+'"]').click();await fit(page);
 const entity=node(page,ids.a);await entity.dblclick();await expect(drawer(page)).toHaveAttribute('data-material-panel','entity');await expect(drawer(page).locator('[data-related-material-id]')).toHaveCount(0);await expect(drawer(page)).toContainText('永久身份');await expect(drawer(page).locator('pre')).toHaveCount(0);await closeDrawer(page);await expect(entity).toBeFocused();
 const material=node(page,'material:MATREQ-FIXTURE-A-VOICE');await material.focus();await page.keyboard.press('Enter');await expect(drawer(page)).not.toBeVisible();await expect(material).toHaveAttribute('aria-pressed','true');await page.keyboard.press('Shift+Enter');await expect(drawer(page).locator('[data-material-info-id]')).toHaveAttribute('data-material-info-id','MATREQ-FIXTURE-A-VOICE');await expect(page).toHaveURL(/material=MATREQ-FIXTURE-A-VOICE/);await closeDrawer(page);await expect(material).toBeFocused();
 const trial=node(page,'material:trial-fixture-0');await trial.dblclick();await expect(page).toHaveURL(/materialTrial=trial-fixture-0/);await expect(drawer(page).locator('.trial-version')).toContainText('原项目内放行意见');await closeDrawer(page);
 await fit(page);const url=page.url(),graph=JSON.stringify(f.graph),before={x:Number(await entity.getAttribute('data-canvas-node-x')),y:Number(await entity.getAttribute('data-canvas-node-y'))},box=await dimensions(entity);
 await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+28,box.y+box.height/2+22,{steps:6});await page.mouse.up();
 expect(Number(await entity.getAttribute('data-canvas-node-x'))).toBeGreaterThan(before.x+10);expect(Number(await entity.getAttribute('data-canvas-node-y'))).toBeGreaterThan(before.y+10);await expect(drawer(page)).not.toBeVisible();expect(page.url()).toBe(url);expect(JSON.stringify(f.graph)).toBe(graph);clean(f);
});

test('关闭素材抽屉后待执行动画帧不得抢走新的键盘目标，Enter与Shift+Enter保持精确对象',async({page})=>{
 const f=await materialFixture(page,{flatProof:true});await open(page,'classification');await root(page).locator('[data-entity-id="'+ids.a+'"]').click();await fit(page);
 const entity=node(page,ids.a),material=node(page,'material:MATREQ-FIXTURE-A-VOICE');await entity.dblclick();await expect(drawer(page)).toHaveAttribute('data-material-panel','entity');
 // Exercise the exact close/next-input interleaving deterministically. No
 // business data is mocked beyond the existing fixture; only queued browser
 // frames are released after the user has chosen the next keyboard target.
 await page.evaluate(()=>{
  const request=window.requestAnimationFrame,cancel=window.cancelAnimationFrame,queue=new Map<number,FrameRequestCallback>();let id=1000000;
  window.requestAnimationFrame=callback=>{const token=++id;queue.set(token,callback);return token;};window.cancelAnimationFrame=token=>{if(!queue.delete(token))cancel.call(window,token);};
  (window as typeof window&{releaseMaterialCloseFrames?:()=>void}).releaseMaterialCloseFrames=()=>{window.requestAnimationFrame=request;window.cancelAnimationFrame=cancel;for(const callback of queue.values())callback(performance.now());queue.clear();};
 });
 await closeDrawer(page);await expect(entity).toBeFocused();await material.focus();await expect(material).toBeFocused();
 await page.evaluate(()=>{(window as typeof window&{releaseMaterialCloseFrames?:()=>void}).releaseMaterialCloseFrames?.();});
 await expect(material).toBeFocused();await page.keyboard.press('Enter');await expect(material).toHaveAttribute('aria-pressed','true');await expect(drawer(page)).not.toBeVisible();
 await page.keyboard.press('Shift+Enter');await expect(drawer(page).locator('[data-material-info-id]')).toHaveAttribute('data-material-info-id','MATREQ-FIXTURE-A-VOICE');await expect(page).toHaveURL(/material=MATREQ-FIXTURE-A-VOICE/);await closeDrawer(page);await expect(material).toBeFocused();clean(f);
});

for(const width of [1440,1920,390])test(width+'px素材目录为两列竖卡，详情桌面半屏且手机全屏',async({page})=>{
 const f=await materialFixture(page,{flatProof:true});await page.setViewportSize({width,height:1000});await open(page,'classification');
 const directory=root(page).locator('.material-entity-directory'),card=directory.locator('[data-entity-id="'+ids.a+'"]');const directoryBox=await dimensions(directory),cardBox=await dimensions(card),thumbnail=await dimensions(card.locator('.material-entity-thumbnail')),copy=await dimensions(card.locator('.material-entity-directory-copy'));
 if(width>1150){expect(directoryBox.width).toBeGreaterThanOrEqual(378);expect(directoryBox.width).toBeLessThanOrEqual(382);}expect(Math.abs(thumbnail.width-56)).toBeLessThan(1);expect(Math.abs(thumbnail.height-56)).toBeLessThan(1);expect(copy.y).toBeGreaterThanOrEqual(thumbnail.y+thumbnail.height+7);expect(cardBox.height).toBeGreaterThanOrEqual(width>480?148:120);
 const other=await dimensions(directory.locator('[data-entity-id="'+ids.b+'"]'));if(width>480){expect(other.x).toBeGreaterThan(cardBox.x);expect(Math.abs(other.y-cardBox.y)).toBeLessThan(1);}else{expect(Math.abs(other.x-cardBox.x)).toBeLessThan(1);expect(other.y).toBeGreaterThan(cardBox.y);}
 await directory.locator('[data-entity-id="'+ids.b+'"]').click();await fit(page);await node(page,'material:MATREQ-FIXTURE-B').dblclick();await expect(drawer(page).locator('[data-material-info-id]')).toHaveAttribute('data-material-info-id','MATREQ-FIXTURE-B');
 const panel=await dimensions(drawer(page)),expected=width<=760?width:Math.min(860,Math.max(560,width/2));expect(Math.abs(panel.width-expected)).toBeLessThan(2);expect(Math.abs(panel.x+panel.width-width)).toBeLessThan(2);expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width);clean(f);
});

for(const mode of ['classification','episodes']){
 test(mode+'：五轴chip保留其他筛选的唯一需求计数，实体和状态不再是筛选',async({page})=>{
  const f=await materialFixture(page);await open(page,mode);
  await expect(root(page).locator('select')).toHaveCount(0);await expect(root(page).locator('[data-material-facet]')).toHaveCount(5);
  await expect(facet(page,'实体')).toHaveCount(0);await expect(facet(page,'状态、发展与方位')).toHaveCount(0);
  for(const[axis,label,n]of [['媒介','图像',3],['媒介','音频',1],['媒介','文本',1],['实体类别','人物',3],['实体类别','地点',2],['集','E01',3],['集','E02',3],['场','S01',3],['场','S02',3],['推进到哪一步','已定义',2],['推进到哪一步','待生成',1],['推进到哪一步','待审阅',1],['推进到哪一步','已通过',1]] as const)await count(page,axis,label,n);
  await chip(page,'实体类别','人物').click();await count(page,'媒介','图像',2);await count(page,'媒介','音频',1);await count(page,'媒介','文本',0);await count(page,'集','E01',2);await count(page,'集','E02',2);
  await chip(page,'媒介','音频').click();await count(page,'集','E01',1);await count(page,'集','E02',0);
  await chip(page,'集','E02').click();await expect(chip(page,'集','E02')).toHaveAttribute('aria-pressed','true');await expect(chip(page,'媒介','音频')).toHaveAttribute('aria-pressed','true');await count(page,'媒介','图像',2);await count(page,'媒介','音频',0);
  await chip(page,'媒介','图像').click();await chip(page,'场','S02').click();await count(page,'推进到哪一步','已定义',1);await count(page,'推进到哪一步','待审阅',1);await count(page,'场','S01',0);
  await chip(page,'推进到哪一步','已定义').click();await count(page,'媒介','全部媒介',1);await count(page,'实体类别','地点',0);
  const border=await chip(page,'实体类别','地点').evaluate(element=>{const style=getComputedStyle(element);return {width:style.borderTopWidth,style:style.borderTopStyle,color:style.borderTopColor};});expect(border.width).toBe('1px');expect(border.style).toBe('solid');expect(border.color).not.toBe('rgba(0, 0, 0, 0)');
  await root(page).getByRole('button',{name:'清除筛选',exact:true}).click();await count(page,'媒介','全部媒介',5);clean(f);
 });
 test(mode+'：分类目录左窄右宽、默认无抽屉，节点打开半屏详情且目录不收窄',async({page})=>{
  const f=await materialFixture(page);await open(page,mode);const directory=root(page).locator('.material-entity-directory'),workspace=root(page).locator('.material-entity-workspace');
  await expect(drawer(page)).not.toBeVisible();await expect(page).toHaveURL(/materialPanel=closed/);
  await expect(directory.locator('.material-entity-directory-card')).toHaveCount(3);await expect(directory.locator('.material-entity-type-group')).toHaveCount(2);await expect(directory.locator('.material-entity-card')).toHaveCount(0);
  const category=directory.locator('[data-entity-type="CHARACTER"]');await category.locator('summary').click();await expect(category.locator('[data-entity-id="'+ids.a+'"]')).not.toBeVisible();await category.locator('summary').click();
  await directory.locator('[data-entity-id="'+ids.a+'"]').click();await expect(drawer(page)).not.toBeVisible();
  const left=await dimensions(directory),right=await dimensions(workspace);expect(left.width).toBeGreaterThanOrEqual(378);expect(left.width).toBeLessThanOrEqual(382);expect(right.width).toBeGreaterThan(left.width);expect(right.x).toBeGreaterThan(left.x+left.width);
  await expect(workspace.locator('.material-entity-materials,.material-entity-card,.material-entity-selected-detail')).toHaveCount(0);
  const list=directory.locator('.material-entity-directory-list'),beforeScroll=await list.evaluate(element=>element.scrollTop);await fit(page);const source=node(page,'material:MATREQ-FIXTURE-A-VOICE');await source.dblclick();
  await expect(drawer(page)).toHaveAttribute('data-material-panel','material');await expect(drawer(page).locator('.material-review-drawer-header').getByRole('heading',{name:'人物甲夜间声音',exact:true})).toBeVisible();
  const bounds=await dimensions(drawer(page));expect(bounds.width).toBeCloseTo(720,0);expect(bounds.x).toBeCloseTo(720,0);expect(bounds.height).toBe(1000);
  await expect(directory.locator('.material-entity-directory-card')).toHaveCount(3);expect(await list.evaluate(element=>element.scrollTop)).toBe(beforeScroll);await count(page,'媒介','全部媒介',5);
  await page.keyboard.press('Escape');await expect(drawer(page)).not.toBeVisible();await expect(source).toBeFocused();await expect(page).toHaveURL(/materialPanel=closed/);await page.reload();await count(page,'媒介','全部媒介',5);await expect(drawer(page)).not.toBeVisible();clean(f);
 });
 test(mode+'：移动端保留画布、详情抽屉全屏且关闭后焦点回原节点',async({page})=>{
  const f=await materialFixture(page);await page.setViewportSize({width:390,height:844});await open(page,mode);const directory=root(page).locator('.material-entity-directory'),workspace=root(page).locator('.material-entity-workspace');await expect(directory).toBeVisible();await expect(workspace).toBeVisible();await expect(drawer(page)).not.toBeVisible();
  await directory.locator('[data-entity-id="'+ids.b+'"]').click();await fit(page);const source=node(page,'material:MATREQ-FIXTURE-B');await source.dblclick();await expect(drawer(page).locator('.material-review-drawer-header').getByRole('heading',{name:'人物乙来访形象',exact:true})).toBeInViewport({ratio:0.1});
  const bounds=await dimensions(drawer(page));expect(bounds).toEqual({x:0,y:0,width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(390);expect(await drawer(page).evaluate(element=>element.scrollWidth)).toBeLessThanOrEqual(390);
  await closeDrawer(page);await expect(source).toBeFocused();await expect(directory).toBeVisible();await expect(workspace).toBeVisible();clean(f);
 });
}

test('旧视角别名收敛到同一分类入口，需求永久身份与详情顺序不变',async({page})=>{
 const f=await materialFixture(page),observations=[];
 for(const mode of ['classification','episodes','relations']){await open(page,mode);await root(page).locator('[data-entity-id="'+ids.b+'"]').click();await fit(page);await node(page,'material:MATREQ-FIXTURE-B').dblclick();const detail=drawer(page).locator('.material-info-card');await expect(drawer(page).locator('.material-review-drawer-header').getByRole('heading',{name:'人物乙来访形象',exact:true})).toBeVisible();await expect(detail).toHaveAttribute('data-material-info-id','MATREQ-FIXTURE-B');observations.push(await detail.evaluate(element=>({id:element.getAttribute('data-material-info-id'),headings:Array.from(element.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]'),heading=>heading.textContent||'')})));await closeDrawer(page);}
 expect(observations[0]).toEqual(observations[1]);expect(observations[0]).toEqual(observations[2]);expect(observations[0].id).toBe('MATREQ-FIXTURE-B');clean(f);
});
test('201正式需求与6独立试制不混计，22集142场chip默认全部展开',async({page})=>{
 const f=await materialFixture(page,{fullDenominator:true,wideScopes:true});await page.goto('/?view=materials&materialMode=classification');await count(page,'媒介','全部媒介',201);await count(page,'集','E01',3);await count(page,'集','E02',3);await count(page,'场','S01',3);await expectDirectoryProgress(page,ids.a,[197,1,0,0],198,6);
 await expect(facet(page,'集').locator('.material-filter-chip')).toHaveCount(23);await expect(facet(page,'场').locator('.material-filter-chip')).toHaveCount(143);await expect(chip(page,'集','E22')).toBeVisible();await expect(chip(page,'场','S142')).toBeVisible();await expect(facet(page,'集').locator('.material-facet-more>button')).toHaveAttribute('aria-expanded','true');await expect(facet(page,'场').locator('.material-facet-more>button')).toHaveAttribute('aria-expanded','true');await expect(drawer(page)).not.toBeVisible();clean(f);
});
for(const legacyMode of ['episodes','relations'])test(legacyMode+'旧入口保留五轴与精确素材，规范化后刷新和返回不换绑',async({page})=>{
 const f=await materialFixture(page);
 const query={view:'materials',materialMode:legacyMode,materialEpisode:ids.ep2,materialScene:ids.s2,materialMedia:'IMAGE',materialEntityType:'CHARACTER',materialCreatorStage:'PENDING_REVIEW',entity:ids.b,materialPanel:'material',material:'MATREQ-FIXTURE-B'};
 await page.goto('/?'+new URLSearchParams(query));await expect(root(page)).toHaveAttribute('data-material-view','classification');
 const assertExact=async()=>{
  for(const [key,value]of Object.entries({...query,materialMode:'classification'}))await expect.poll(()=>new URL(page.url()).searchParams.get(key)).toBe(value);
  await expect(page.getByRole('tablist',{name:'素材管理视角'})).toHaveCount(0);await expect(page.getByRole('tab',{name:'剧集视角管理',exact:true})).toHaveCount(0);
  for(const[axis,label]of [['集','E02'],['场','S02'],['媒介','图像'],['实体类别','人物'],['推进到哪一步','待审阅']])await expect(chip(page,axis,label)).toHaveAttribute('aria-pressed','true');
  await count(page,'媒介','全部媒介',1);await expect(drawer(page).locator('[data-material-info-id]')).toHaveAttribute('data-material-info-id','MATREQ-FIXTURE-B');await expect(node(page,'material:MATREQ-FIXTURE-B')).toHaveAttribute('aria-pressed','true');
 };
 await assertExact();await page.reload();await assertExact();const exactUrl=page.url();
 await page.goto('/?view=materials&materialMode='+legacyMode+'&materialEpisode='+ids.ep1);await count(page,'媒介','全部媒介',3);await expect(drawer(page)).not.toBeVisible();
 await page.goBack();await expect(page).toHaveURL(exactUrl);await assertExact();await closeDrawer(page);await fit(page);await node(page,'material:MATREQ-FIXTURE-B').dblclick();await assertExact();await closeDrawer(page);await expect(node(page,'material:MATREQ-FIXTURE-B')).toBeFocused();clean(f);
});
test('当前候选永久集UID深链可恢复，未知集场保持原值并明确报错',async({page})=>{
 const f=await materialFixture(page);await page.goto('/?view=materials&materialMode=episodes&materialEpisode='+ids.ep2);await expect(chip(page,'集','E02')).toHaveAttribute('aria-pressed','true');await count(page,'媒介','全部媒介',3);await count(page,'场','S01',0);await count(page,'场','S02',3);await expect(drawer(page)).not.toBeVisible();
 await page.goto('/?view=materials&materialMode=episodes&materialEpisode=unknown-permanent-episode&materialScene=unknown-permanent-scene');await expect(root(page).locator('.material-invalid-scope')).toContainText('已保留原筛选值');await expect(facet(page,'集').locator('[aria-pressed="true"]')).toContainText('未匹配集');await expect(facet(page,'场').locator('[aria-pressed="true"]')).toContainText('未匹配场');await expect(page).toHaveURL(/materialEpisode=unknown-permanent-episode/);await expect(page).toHaveURL(/materialScene=unknown-permanent-scene/);await count(page,'媒介','全部媒介',0);clean(f);
});
test('零素材的永久状态深链只读保留来源审计，状态不成为隐藏筛选',async({page})=>{
 const f=await materialFixture(page,{definitionOnly:true});await page.goto('/?view=materials&entity='+ids.a+'&materialState='+ids.day);await count(page,'媒介','全部媒介',0);await expect(drawer(page)).toHaveAttribute('data-material-panel','state');await expect(drawer(page).getByRole('heading',{name:'白天身份',exact:true})).toBeVisible();await expect(drawer(page)).toContainText('没有已登记的精确关联需求');
 await page.reload();await expect(page).toHaveURL(new RegExp('materialState='+ids.day));await expect(drawer(page).getByRole('heading',{name:'白天身份',exact:true})).toBeVisible();await expect(root(page).locator('.material-info-card[data-material-info-id]')).toHaveCount(0);
 await expect(drawer(page)).toContainText('历史状态／属性来源审计');await expect(node(page,ids.day)).toHaveCount(0);await expect(drawer(page).getByRole('button',{name:'维护这项状态定义',exact:true})).toHaveCount(0);await expect(drawer(page).getByRole('region',{name:'素材定义与依赖',exact:true})).toHaveCount(0);expect(f.requirements).toHaveLength(0);clean(f);
});
test('实体与素材双击展示精确关联，连线只读且历史状态审计保留',async({page})=>{
 const f=await materialFixture(page);await open(page,'classification');await root(page).locator('[data-entity-id="'+ids.a+'"]').click();await fit(page);const source=node(page,ids.a);await source.dblclick();await expect(drawer(page)).toHaveAttribute('data-material-panel','entity');await expect(drawer(page).locator('[data-related-material-id]')).toHaveCount(0);await expect(drawer(page)).toContainText('永久身份');await expect(drawer(page).locator('pre')).toHaveCount(0);await expect(drawer(page).locator('[data-related-material-id="MATREQ-FIXTURE-B"]')).toHaveCount(0);await page.mouse.click(20,500);await expect(drawer(page)).not.toBeVisible();await expect(source).toBeFocused();
 await expect(node(page,ids.night)).toHaveCount(0);await expect(root(page).locator('[data-canvas-edge="material-state-development"]')).toHaveCount(0);await node(page,'material:MATREQ-FIXTURE-A-VOICE').dblclick();await expect(drawer(page).getByRole('region',{name:'素材条件与属性',exact:true})).toHaveCount(0);await closeDrawer(page);
 await expect(root(page).locator('[data-canvas-edge="entity-material:MATREQ-FIXTURE-A-VOICE"]')).toHaveCount(0);await expect(root(page).locator('[data-canvas-edge-hit="entity-material:MATREQ-FIXTURE-A-VOICE"]')).toHaveAttribute('role','button');await expect(drawer(page)).not.toBeVisible();await page.goto('/?view=materials&materialMode=classification&materialPanel=relation&entity='+ids.a+'&materialRelation='+encodeURIComponent('entity-material:MATREQ-FIXTURE-A-VOICE'));await expect(drawer(page)).toContainText('目录归属投影');await expect(drawer(page).locator('[data-related-material-id]')).toHaveCount(1);await expect(page).toHaveURL(/materialRelation=entity-material%3AMATREQ-FIXTURE-A-VOICE/);await page.reload();await expect(drawer(page)).toContainText('目录归属投影');clean(f);
});
test('显式素材深链与同模块事件读取准确，父层默认 material 写入不打开抽屉',async({page})=>{
 const f=await materialFixture(page);await open(page,'classification');await page.evaluate(()=>{const url=new URL(location.href);url.searchParams.set('material','MATREQ-FIXTURE-B');history.replaceState(history.state,'',url);});await expect(drawer(page)).not.toBeVisible();
 await page.goto('/?view=materials&material=MATREQ-FIXTURE-B');await expect(drawer(page).locator('.material-review-drawer-header').getByRole('heading',{name:'人物乙来访形象',exact:true})).toBeVisible();await closeDrawer(page);
 await page.evaluate(({entity,state})=>{const url=new URL(location.href);url.searchParams.set('materialPanel','state');url.searchParams.set('entity',entity);url.searchParams.set('materialState',state);history.pushState(history.state,'',url);window.dispatchEvent(new Event('review:material-panel-location'));},{entity:ids.a,state:ids.night});await expect(drawer(page).getByRole('heading',{name:'夜间西侧',exact:true})).toBeVisible();await count(page,'媒介','全部媒介',5);clean(f);
});
for(const [name,query]of [['未知状态','entity='+ids.a+'&materialState=unknown-permanent-state'],['跨实体状态','entity='+ids.b+'&materialState='+ids.day],['未知实体','materialPanel=entity&entity=unknown-permanent-entity'],['未知需求','materialPanel=material&material=unknown-permanent-need'],['未知关系','materialPanel=relation&entity='+ids.a+'&materialRelation=unknown-permanent-relation']] as const)test(name+'永久身份失败关闭且刷新不换绑',async({page})=>{
 const f=await materialFixture(page);await page.goto('/?view=materials&'+query);await expect(drawer(page).locator('.material-panel-error')).toBeVisible();await expect(drawer(page).locator('.material-info-card')).toHaveCount(0);const before=new URL(page.url());await page.reload();await expect(drawer(page).locator('.material-panel-error')).toBeVisible();for(const key of ['entity','materialState','material','materialRelation'])if(before.searchParams.has(key))expect(new URL(page.url()).searchParams.get(key)).toBe(before.searchParams.get(key));clean(f);
});
test('未知 panel 类型不打开任何默认对象并保留原值',async({page})=>{
 const f=await materialFixture(page);await page.goto('/?view=materials&materialPanel=guess&material=MATREQ-FIXTURE-A');await expect(root(page).locator('.material-invalid-panel')).toContainText('未猜测');await expect(drawer(page)).not.toBeVisible();await expect(page).toHaveURL(/materialPanel=guess/);clean(f);
});
test('已登记的旧素材表现深链仍精确到定义，未知表现不得回退',async({page})=>{
 const f=await materialFixture(page);await page.goto('/?view=materials&materialPanel=definitions&materialRepresentation=rep-MATREQ-FIXTURE-A');await expect(drawer(page).getByRole('region',{name:'素材定义与依赖',exact:true}).getByRole('heading',{name:'人物甲白天形象',exact:true})).toBeVisible();await page.goto('/?view=materials&materialPanel=definitions&materialRepresentation=unknown-representation');await expect(drawer(page).locator('.material-panel-error')).toContainText('永久身份未登记');await expect(drawer(page).locator('.material-info-card')).toHaveCount(0);clean(f);
});

test('独立试制版本选择保存专用永久身份，刷新保留原意见与UNKNOWN权利',async({page})=>{
 const f=await materialFixture(page);await page.goto('/?view=materials&materialPanel=material&entity='+ids.a+'&materialTrial=trial-fixture-0');
 await expect(drawer(page).locator('.trial-version')).toContainText('原项目内放行意见');await drawer(page).getByRole('button',{name:'版本 1',exact:true}).click();await expect(drawer(page).locator('.trial-version')).toContainText('原返修意见');await expect(page).toHaveURL(/materialTrialVersion=trial-version-1/);expect(new URL(page.url()).searchParams.has('version')).toBe(false);
 await page.reload();await expect(drawer(page).locator('.trial-version')).toContainText('原返修意见');await expect(drawer(page).getByRole('button',{name:'版本 1',exact:true})).toHaveAttribute('aria-pressed','true');await expect(page).toHaveURL(/materialTrial=trial-fixture-0/);await count(page,'媒介','全部媒介',5);await expect(drawer(page).getByText(/UNKNOWN/, {exact:false})).toHaveCount(1);clean(f);
});

test('新试制范围按需求永久身份进入素材卡，候选不增加正式需求分母',async({page})=>{
 const f=await materialFixture(page),scopeId='new-trial-scope',subjectId='new-trial-material';
 await page.route('**/api/trial/scopes',route=>route.fulfill({json:{scopes:[{id:scopeId,title:'新独立范围',countsTowardFormalProject:false}],defaultScopeId:scopeId}}));
 const asset={id:'new-trial-asset',mediaId:subjectId,versionId:'new-trial-version',sha256:hash(999),mediaKind:'IMAGE',mediaUrl:'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="16" height="9"/%3E',version:1,lifecycle:'REVIEW_PENDING',title:'新人物候选',metadata:{RIGHTS_STATUS:'UNKNOWN'},prompt:'新范围实际Prompt',qa:{},reviewCriteria:[]};
 await page.route('**/api/trial/snapshot*',route=>route.fulfill({json:{mode:'LOCAL_TRIAL',scope:{id:scopeId,title:'新独立范围',countsTowardFormalProject:false},recipes:[{id:'new-trial-recipe',subjectId,sourceRequirementId:'MATREQ-FIXTURE-A',sourceRequirementHash:f.requirements[0].requirementHash,label:'新人物候选',model:'FIXTURE',mediaKind:'IMAGE'}],assets:[asset],mutationEtag:'"new-trial-head"'}}));
 const themeId=`TRIAL:${scopeId}:${subjectId}`;
 await page.goto('/?view=materials&materialPanel=material&entity='+ids.a+'&materialTrial='+encodeURIComponent(themeId));
 await expect(drawer(page).locator('.trial-version')).toContainText('新人物候选');
 await expect(drawer(page).locator('.trial-status')).toHaveText('待你审阅');
 await expect(drawer(page).locator('.material-trial-production')).toContainText('新范围实际Prompt');
 await count(page,'媒介','全部媒介',5);
 await page.reload();await expect(drawer(page).locator('.trial-version')).toContainText('新人物候选');clean(f);
});


for(const stateAuditProjection of ['workspace-only','directory-only'])test(stateAuditProjection+'旧状态定义深链精确展示来源审计而非空白或编辑器',async({page})=>{
 const f=await materialFixture(page,{definitionOnly:true,stateAuditProjection});const url='/?view=materials&entity='+ids.a+'&materialPanel=definitions&materialDefinitionKind=states&materialDefinitionId='+ids.day;await page.goto(url);
 for(let pass=0;pass<2;pass++){await expect(drawer(page)).toHaveAttribute('data-material-panel','state');await expect(drawer(page).getByRole('heading',{name:'白天身份',exact:true})).toBeVisible();await expect(drawer(page).locator('.material-panel-facts')).toContainText(ids.day);await expect(drawer(page)).toContainText('历史状态／属性来源审计');await expect(drawer(page).locator('.material-panel-facts')).toContainText('白天');await expect(drawer(page).getByRole('region',{name:'素材定义与依赖',exact:true})).toHaveCount(0);await expect(drawer(page).getByRole('button',{name:'编辑此项',exact:true})).toHaveCount(0);await count(page,'媒介','全部媒介',0);await expect(page).toHaveURL(new RegExp('materialDefinitionId='+ids.day));if(!pass)await page.reload();}
 expect(f.requirements).toHaveLength(0);clean(f);
});
test('未知或跨实体旧状态定义不借用当前素材来源',async({page})=>{
 const f=await materialFixture(page,{definitionOnly:true});for(const[entity,id]of [[ids.a,'unknown-state-definition'],[ids.b,ids.day]]){await page.goto('/?view=materials&entity='+entity+'&materialPanel=definitions&materialDefinitionKind=states&materialDefinitionId='+id);await expect(drawer(page).locator('.material-panel-error')).toContainText('永久身份未登记');await expect(drawer(page).locator('.material-panel-facts')).toHaveCount(0);await expect(page).toHaveURL(new RegExp('materialDefinitionId='+id));}clean(f);
});
test('试制同版本和SHA但mediaId不一致时拒绝原件且不换用最新版本',async({page})=>{
 const f=await materialFixture(page,{trialMediaMismatch:true});await page.goto('/?view=materials&materialPanel=material&entity='+ids.a+'&materialTrial=trial-fixture-0&materialTrialVersion=trial-version-1');await expect(drawer(page).locator('.material-panel-error')).toContainText('未换用最新版本');await expect(drawer(page).locator('.trial-version')).toHaveCount(0);await expect(page).toHaveURL(/materialTrialVersion=trial-version-1/);await page.reload();await expect(drawer(page).locator('.material-panel-error')).toContainText('未换用最新版本');await expect(page).toHaveURL(/materialTrialVersion=trial-version-1/);clean(f);
});

test('素材四类媒介与类别图标可见，四进度在筛选、画布、详情颜色和图形一致',async({page})=>{
 const f=await materialFixture(page);await open(page,'classification');
 for(const value of ['IMAGE','AUDIO','VIDEO','TEXT'])await expect(facet(page,'媒介').locator('[data-material-icon-value="'+value+'"] svg')).toHaveCount(1);
 for(const value of ['CHARACTER','LOCATION'])await expect(facet(page,'实体类别').locator('[data-material-icon-value="'+value+'"] svg')).toHaveCount(1);
 const rows=[['INITIAL','MATREQ-FIXTURE-A',ids.a],['PRODUCTION_READY','MATREQ-FIXTURE-A-VOICE',ids.a],['PENDING_REVIEW','MATREQ-FIXTURE-B',ids.b],['APPROVED','MATREQ-FIXTURE-PLACE',ids.place]];
 const appearances=[];
 for(const[stage,id,entityId]of rows){await root(page).locator('[data-entity-id="'+entityId+'"]').click();await fit(page);const card=node(page,'material:'+id),filter=facet(page,'推进到哪一步').locator('[data-material-progress="'+stage+'"]'),badge=card.locator('[data-canvas-badge="'+stage+'"]');await expect(badge).toBeVisible();const filterStyle=await filter.evaluate(element=>({tone:getComputedStyle(element).getPropertyValue('--material-progress-tone').trim(),path:element.querySelector('svg path')?.getAttribute('d')}));const canvasStyle=await badge.evaluate(element=>({tone:getComputedStyle(element).getPropertyValue('--material-progress-tone').trim(),path:element.querySelector('svg path')?.getAttribute('d')}));expect(canvasStyle).toEqual(filterStyle);await card.dblclick();await expect(drawer(page).locator('.material-info-card')).toHaveAttribute('data-material-info-id',id);const detail=drawer(page).locator('.material-info-header [data-material-progress="'+stage+'"]');await expect(detail).toBeVisible();expect(await detail.evaluate(element=>({tone:getComputedStyle(element).getPropertyValue('--material-progress-tone').trim(),path:element.querySelector('svg path')?.getAttribute('d')}))).toEqual(filterStyle);appearances.push(filterStyle);await closeDrawer(page);}
 expect(new Set(appearances.map(row=>row.tone)).size).toBe(4);expect(new Set(appearances.map(row=>row.path)).size).toBe(4);clean(f);
});
test('目录代表图优先采用的精确版本与SHA，无已登记图像使用媒介图标',async({page})=>{
 const f=await materialFixture(page,{flatProof:true});await open(page,'classification');const directory=root(page).locator('.material-entity-directory'),image=directory.locator('[data-entity-id="'+ids.a+'"] .material-entity-thumbnail');await expect(image).toHaveAttribute('data-thumbnail-version','fixture-family-a@V001');await expect(image).toHaveAttribute('data-thumbnail-sha',hash(901));await expect(image.locator('img')).toHaveAttribute('src',f.assetVersions[0].mediaUrl);await expect.poll(()=>image.locator('img').evaluate(element=>(element as HTMLImageElement).naturalWidth)).toBe(16);const fallback=directory.locator('[data-entity-id="'+ids.b+'"] .material-entity-thumbnail');await expect(fallback.locator('img')).toHaveCount(0);await expect(fallback.locator('[data-material-icon-kind="media"] svg')).toHaveCount(1);await expect(drawer(page)).not.toBeVisible();expect(f.assetFamilies[0].currentVersionId).toBe('fixture-family-a@V001');clean(f);
});
test('画板不产生STATE层，参考标签只读且精确历史深链不伪称实际衍生',async({page})=>{
 const f=await materialFixture(page,{flatProof:true});await open(page,'classification');await root(page).locator('[data-entity-id="'+ids.a+'"]').click();await fit(page);const workspace=root(page).locator('.material-entity-workspace'),before=JSON.stringify(f.graph);
 expect((await workspace.locator('[data-canvas-node-id]').evaluateAll(elements=>elements.map(element=>element.getAttribute('data-canvas-node-id')))).every(id=>id===ids.a||id?.startsWith('material:'))).toBe(true);for(const state of f.graph.states)await expect(node(page,state.id)).toHaveCount(0);await expect(workspace.locator('[data-canvas-edge="material-state-development"]')).toHaveCount(0);
 const a=node(page,'material:MATREQ-FIXTURE-A'),voice=node(page,'material:MATREQ-FIXTURE-A-VOICE');expect(Number(await voice.getAttribute('data-canvas-node-x'))).toBeGreaterThan(Number(await a.getAttribute('data-canvas-node-x')));
 const edge=workspace.locator('[data-canvas-edge="material-exact-reference"]');await expect(edge).toBeVisible();await expect(edge).toBeEnabled();await expect(drawer(page)).not.toBeVisible();await edge.click();await expect(drawer(page)).toContainText('登记参考定义');await expect(drawer(page)).toContainText('不证明已经作为模型输入');await expect(drawer(page)).toContainText('PROPOSED');await expect(drawer(page).locator('[data-related-material-id]')).toHaveCount(2);await expect(drawer(page).locator('[data-related-material-id="MATREQ-FIXTURE-B"]')).toHaveCount(0);await expect(page).toHaveURL(/materialRelation=material-exact-reference/);await page.reload();await expect(drawer(page)).toContainText('material-exact-reference');expect(JSON.stringify(f.graph)).toBe(before);clean(f);
});

test('素材阅读占位过滤与去重不改判断身份或有意义UNKNOWN事实',()=>{
 // Rendering cleanup does not change canonical unknown facts.
 expect(['UNKNOWN',' unknown ','',' ','NULL','N/A','—'].map(materialDisplayText)).toEqual(['','','','','','','']);
 expect(materialDisplayText('权利 UNKNOWN 阻断下传')).toBe('权利 UNKNOWN 阻断下传');
 expect(materialCriterionDescription('身份清晰','身份清晰。')).toBe('');
 expect(materialCriterionDescription('身份清晰','检查面部与已批准母版一致')).toBe('检查面部与已批准母版一致');
 expect(materialExtraReviewPoints({reviewSpec:{criteria:[{label:'身份清晰',question:'身份清晰。'}]},acceptanceCriteria:['身份清晰','UNKNOWN','补充约束','补充约束。'],storyBasis:{onScreenRequirement:'补充约束',factBoundary:'权利 UNKNOWN 阻断下传'}})).toEqual(['补充约束','权利 UNKNOWN 阻断下传']);
 expect(materialExtraReviewPoints({acceptanceCriteria:['原正式标准','UNKNOWN'],storyBasis:{factBoundary:'UNKNOWN'}})).toEqual([]);
 expect(materialExtraReviewPoints({reviewSpec:{criteria:[]},acceptanceCriteria:['没有正式条目时仍可读的已登记约束']})).toEqual(['没有正式条目时仍可读的已登记约束']);
});
for(const width of [1440,390])test(width+'px素材详情压缩保留4判断及AI/权利门禁，生产资料直接铺开',async({page},testInfo)=>{
 await page.setViewportSize({width,height:1000});const f=await materialFixture(page,{flatProof:true,compactReview:true});
 await page.goto('/?view=materials&materialPanel=material&material=MATREQ-FIXTURE-A&family=fixture-family-a&version=fixture-family-a%40V002');
 const card=drawer(page).locator('[data-material-info-id="MATREQ-FIXTURE-A"]'),review=card.locator('[data-material-section="review"]'),production=card.locator('[data-material-section="production"]');
 await expect(card).toBeVisible();await expect(production).toHaveAttribute('data-production-version-id','fixture-family-a@V002');
 await expect(review.locator('.material-criteria-list>article')).toHaveCount(4);expect(await review.locator('[data-criterion-id]').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('data-criterion-id')))).toEqual([0,1,2,3].map(i=>'compact-criterion-'+i));
 const drawerBox=await dimensions(drawer(page));expect(Math.abs(drawerBox.width-(width===390?390:720))).toBeLessThanOrEqual(1);expect(Math.abs(drawerBox.x+drawerBox.width-width)).toBeLessThanOrEqual(1);
 const criterionGeometry=await review.locator('.material-criteria-list>article').evaluateAll(nodes=>nodes.map(article=>{const box=article.getBoundingClientRect();return{width:box.width,scrollWidth:article.scrollWidth,clientWidth:article.clientWidth,buttons:[...article.querySelectorAll('button')].map(button=>{const r=button.getBoundingClientRect();return{x:r.x-box.x,right:r.right-box.x,height:r.height}})};}));
 for(const row of criterionGeometry){expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth+1);for(const button of row.buttons){expect(button.x).toBeGreaterThanOrEqual(0);expect(button.right).toBeLessThanOrEqual(row.width+1);expect(button.height).toBeGreaterThanOrEqual(32);}}
 await testInfo.attach('compact-geometry',{body:JSON.stringify({viewport:width,drawer:drawerBox,criteria:criterionGeometry}),contentType:'application/json'});
 await review.evaluate(node=>node.scrollIntoView({block:'start'}));await page.screenshot({path:testInfo.outputPath('compact-review-'+width+'.png')});
 await expect(review.locator('.material-criterion-copy>p')).toHaveCount(0);await expect(review.getByText('身份清晰',{exact:true})).toHaveCount(1);
 await expect(review.getByRole('region',{name:'审阅要点'})).toContainText('独立补充：服装连续');await expect(review.getByRole('region',{name:'审阅要点'})).not.toContainText('UNKNOWN');
 for(const textarea of await review.locator('textarea').all())await expect(textarea).toHaveAttribute('rows','2');
 await expect(production.locator('details.material-candidate-facts,details.v8-recipe-panel')).toHaveCount(0);await expect(production.locator('section.v8-recipe-panel')).toContainText('当前权威Prompt不等于历史实际Prompt');await expect(production.locator('.material-prompt-difference')).toContainText('本次实际旧Prompt');await expect(production.locator('.material-generation-provenance')).toContainText(hash(761));await expect(production).toContainText('fixture-actual-input.png');
 const fixed=production.locator('.is-output');await expect(fixed).toContainText('fixture-output.png');await expect(fixed.getByRole('button',{name:'复制固定输出',exact:true})).toBeVisible();
 expect(await fixed.evaluate(node=>{const panel=node.closest('.v8-recipe-panel')!;return panel.querySelector('.creator-call-package-actions')!.compareDocumentPosition(node)&Node.DOCUMENT_POSITION_PRECEDING;})).toBeTruthy();
 expect(await production.locator('.v8-recipe-panel').evaluate(node=>Boolean(node.compareDocumentPosition(node.parentElement!.querySelector('.material-candidate-facts')!)&Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
 await expect(production.locator('.material-input-provenance')).toContainText(hash(764));await expect(production.locator('.material-input-provenance')).toContainText(hash(765));await expect(production.locator('.v8-recipe-panel')).toContainText('fixture-current-input.png');await expect(production.locator('.material-prompt-difference')).toContainText('获批后仍需受控同步');
 await production.evaluate(node=>node.scrollIntoView({block:'start'}));await page.screenshot({path:testInfo.outputPath('compact-production-'+width+'.png')});
 await expect(production).not.toContainText('INTERNAL_MACHINE_ONLY');await expect(card.getByText('版本状态',{exact:true})).toHaveCount(0);await expect(card).not.toContainText('剧集视角');await expect(card.getByText('当前版本的实际生成记录',{exact:true})).toHaveCount(0);
 const ai=review.getByRole('region',{name:'AI辅助 Review'});await review.getByRole('button',{name:'AI 辅助审阅',exact:true}).click();await expect(ai.locator('.material-ai-draft')).toBeVisible();expect(f.aiRequests).toEqual([expect.objectContaining({requirementId:'MATREQ-FIXTURE-A',familyId:'fixture-family-a',versionId:'fixture-family-a@V002',versionSha256:hash(902),reviewSpecHash:hash(751),contextHash:hash(760)})]);
 await expect(review.locator('.material-criteria-list button[aria-pressed="true"]')).toHaveCount(0);
 await ai.getByRole('button',{name:'填入下方可编辑表单'}).click();await expect(review.locator('.material-criteria-list button[aria-pressed="true"]')).toHaveCount(4);await expect(review.locator('.material-review-actions button[aria-pressed="true"]')).toHaveCount(0);
 const submit=review.getByRole('button',{name:'提交正式裁决',exact:true});await expect(submit).toBeDisabled();
 await review.getByRole('button',{name:'通过并放行',exact:true}).click();await expect(submit).toBeDisabled();await review.getByRole('checkbox',{name:/PROJECT_INTERNAL_ONLY/}).check();await expect(submit).toBeEnabled();
 // Do not submit: local edit and mocked AI are not a formal event or user authorization.
 for(let i=0;i<4;i++){await expect(review.locator('[data-criterion-id="compact-criterion-'+i+'"] textarea')).toHaveValue('fixture草稿 compact-criterion-'+i);}
 await expect(review.locator('.material-review-submit-bar')).toContainText('禁止使用');await expect(review.locator('.material-review-submit-bar')).toContainText('要求修改');expect(await drawer(page).evaluate(node=>node.scrollWidth<=node.clientWidth+1)).toBe(true);clean(f);
});
test('素材历史资料缺项不借当前Prompt；只读试制去重并默认铺开真实Prompt',async({page})=>{
 const f=await materialFixture(page,{flatProof:true,compactReview:true});await page.goto('/?view=materials&materialPanel=material&material=MATREQ-FIXTURE-A&family=fixture-family-a&version=fixture-family-a%40V001');
 const production=drawer(page).locator('[data-material-section="production"]');await expect(production.locator('.material-candidate-facts')).toHaveAttribute('data-production-material-mode','HISTORICAL');await expect(production.locator('.material-candidate-facts')).toHaveAttribute('data-production-material-status','ABSENT');await expect(production.locator('[data-evidence-status="MISSING"]')).toHaveCount(8);await expect(production.locator('.v8-recipe-panel')).toHaveCount(0);await expect(production).not.toContainText('当前权威Prompt');await expect(production).not.toContainText('fixture-current-input.png');
 await page.goto('/?view=materials&materialPanel=material&materialTrial=trial-fixture-0&materialTrialVersion=trial-version-1');const trial=drawer(page);await expect(trial).toContainText('原返修意见');await expect(trial.locator('details.trial-details')).toHaveCount(0);await expect(trial.locator('section.material-trial-production')).toContainText('合成试制测试，无真实生成');await expect(trial.locator('.entity-review-points')).toHaveCount(0);await expect(trial.getByRole('button',{name:'通过并放行',exact:true})).toBeDisabled();clean(f);
});

function addDeletedVersionFixture(f:Fixture){
 const deleted={...f.assetVersions[0],id:'fixture-family-a@AUDIT-006',label:'原删除审计版本',path:null,sha256:null,preview:null,mediaUrl:null,outputState:'DELETED',lifecycleState:'DELETED_AUDIT',historyRole:'DELETED_AUDIT'} as unknown as Fixture['assetVersions'][number];
 f.assetFamilies[0].versionRefs.push(deleted.id);f.assetVersions.push(deleted);return deleted;
}
test('日常素材版本选择排除精确删除审计但保留原模型及当前采用',async({page})=>{
 const f=await materialFixture(page,{flatProof:true,compactReview:true}),deleted=addDeletedVersionFixture(f),before=JSON.stringify({families:f.assetFamilies,versions:f.assetVersions});
 await page.goto('/?view=materials&materialPanel=material&material=MATREQ-FIXTURE-A&family=fixture-family-a');
 const card=drawer(page).locator('[data-material-info-id="MATREQ-FIXTURE-A"]'),chips=card.locator('.material-version-chips');
 await expect(chips.getByRole('button')).toHaveCount(2);await expect(chips).not.toContainText('原删除审计版本');
 await expect(chips.getByRole('button',{name:/人物甲版本 1/})).toBeVisible();await expect(chips.getByRole('button',{name:/人物甲版本 2/})).toBeVisible();
 expect(f.assetFamilies[0].currentVersionId).toBe('fixture-family-a@V001');expect(f.assetFamilies[0].versionRefs).toContain(deleted.id);expect(JSON.stringify({families:f.assetFamilies,versions:f.assetVersions})).toBe(before);clean(f);
});
test('已实现EO不重复显示尚未产出，旧精确EO深链绑定原实际版本与SHA而非最新版本',async({page})=>{
 const f=await materialFixture(page,{flatProof:true,realizedExpected:true}),id=f.expectedOutputs[0].id,before=JSON.stringify({families:f.assetFamilies,versions:f.assetVersions,expected:f.expectedOutputs});
 await page.goto('/?view=materials&materialPanel=material&material=MATREQ-FIXTURE-A&family=fixture-family-a&version='+encodeURIComponent(id));
 const card=drawer(page).locator('[data-material-info-id="MATREQ-FIXTURE-A"]'),output=card.locator('.material-output-viewer'),chips=card.locator('.material-version-chips');
 await expect(output).toHaveAttribute('data-version-id','fixture-family-a@V001');await expect(output).toHaveAttribute('data-version-sha256',hash(901));await expect(chips.getByRole('button')).toHaveCount(2);await expect(chips).not.toContainText('尚未产出');await expect(chips.getByRole('button',{name:/人物甲版本 1/})).toHaveAttribute('aria-pressed','true');
 expect(new URL(page.url()).searchParams.get('version')).toBe(id);await page.reload();await expect(output).toHaveAttribute('data-version-id','fixture-family-a@V001');expect(JSON.stringify({families:f.assetFamilies,versions:f.assetVersions,expected:f.expectedOutputs})).toBe(before);clean(f);
});
for(const defect of ['unknown','wrong-family','sha-mismatch','ambiguous'])test('无效EO深链不回退真实最新版本：'+defect,async({page})=>{
 const f=await materialFixture(page,{flatProof:true,realizedExpected:true}),expected=f.expectedOutputs[0];
 if(defect==='wrong-family')expected.familyId='other-family';if(defect==='sha-mismatch')expected.realizedVersionSha256=hash(999);if(defect==='ambiguous')f.expectedOutputs.push({...expected});
 const id=defect==='unknown'?'EXPECTED_OUTPUT:unknown':expected.id;
 await page.goto('/?view=materials&materialPanel=material&material=MATREQ-FIXTURE-A&family=fixture-family-a&version='+encodeURIComponent(id));
 const card=drawer(page).locator('[data-material-info-id="MATREQ-FIXTURE-A"]');if(defect==='ambiguous')await expect(drawer(page).getByRole('alert')).toContainText('重复身份');else await expect(card.locator('.material-selection-error')).toBeVisible();await expect(drawer(page).locator('.material-output-viewer,[data-material-section="review"]')).toHaveCount(0);expect(new URL(page.url()).searchParams.get('version')).toBe(id);clean(f);
});
for(const width of [1440,390])test('已删版本深链只读说明且不换绑或提供裁决 '+width,async({page})=>{
 await page.setViewportSize({width,height:900});const f=await materialFixture(page,{flatProof:true}),deleted=addDeletedVersionFixture(f),before=JSON.stringify({families:f.assetFamilies,versions:f.assetVersions}),url='/?view=materials&materialPanel=material&material=MATREQ-FIXTURE-A&family=fixture-family-a&version='+encodeURIComponent(deleted.id);
 await page.goto(url);const card=drawer(page).locator('[data-material-info-id="MATREQ-FIXTURE-A"]'),message=card.locator('[data-deleted-material-version]');
 await expect(message).toHaveAttribute('data-deleted-material-version',deleted.id);await expect(message).toContainText('原历史记录未改写');await expect(message).toContainText('没有执行物理删除');
 await expect(card.locator('[data-material-section="review"],[data-material-section="production"],.material-output-viewer,.material-version-chips')).toHaveCount(0);
 await expect(card.getByRole('button',{name:/提交正式裁决|通过并放行|执行生成|调用模型/})).toHaveCount(0);
 expect(new URL(page.url()).searchParams.get('version')).toBe(deleted.id);await page.reload();await expect(message).toBeVisible();expect(new URL(page.url()).searchParams.get('version')).toBe(deleted.id);
 expect(JSON.stringify({families:f.assetFamilies,versions:f.assetVersions})).toBe(before);clean(f);
});

const directoryStages=[['INITIAL','已定义'],['PRODUCTION_READY','待生成'],['PENDING_REVIEW','待审阅'],['APPROVED','已通过']] as const;
async function expectDirectoryProgress(page:Page,entityId:string,counts:readonly number[],total:number,trialCount:number){
 const row=root(page).locator('.material-entity-directory [data-entity-id="'+entityId+'"]'),summary=row.locator('[data-entity-progress-summary]');
 await expect(summary).toBeVisible();expect(counts.reduce((a,b)=>a+b,0)).toBe(total);
 await expect(summary.locator('[data-entity-stage-count]')).toHaveCount(4);
 expect(await summary.locator('[data-entity-stage-count]').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('data-entity-stage-count')))).toEqual(directoryStages.map(([id])=>id));
 for(let index=0;index<directoryStages.length;index++){
  const [stage,label]=directoryStages[index],item=summary.locator('[data-entity-stage-count="'+stage+'"]');
  await expect(item).toBeVisible();await expect(item).toHaveAttribute('data-count',String(counts[index]));await expect(item).toHaveAttribute('role','img');await expect(item).toHaveAccessibleName(label+' '+counts[index]+'项需求');await expect(item).toContainText(String(counts[index]));
  const icon=item.locator('[data-material-icon-kind="stage"][data-material-icon-value="'+stage+'"]'),filterIcon=facet(page,'推进到哪一步').locator('[data-material-icon-kind="stage"][data-material-icon-value="'+stage+'"]');
  await expect(icon).toHaveCount(1);expect(await icon.locator('svg').innerHTML()).toBe(await filterIcon.locator('svg').innerHTML());expect(await icon.evaluate(node=>getComputedStyle(node).color)).toBe(await filterIcon.evaluate(node=>getComputedStyle(node).color));
 }
 await expect(summary.locator('[data-entity-total-count]')).toHaveAttribute('data-entity-total-count',String(total));await expect(summary.locator('[data-entity-total-count]')).toHaveText('总'+total);
 expect(await summary.evaluate(node=>node.lastElementChild?.hasAttribute('data-entity-total-count'))).toBe(true);
 if(trialCount)await expect(row.locator('.material-entity-trial-count')).toHaveText('另 '+trialCount+' 项独立试制');else await expect(row.locator('.material-entity-trial-count')).toHaveCount(0);
 return row;
}
test('实体目录四态数量按当前筛选重算，重复用途去重且独立试制不混分母',async({page})=>{
 const f=await materialFixture(page);await open(page,'classification');
 await expectDirectoryProgress(page,ids.a,[1,1,0,0],2,6);await expectDirectoryProgress(page,ids.b,[0,0,1,0],1,0);await expectDirectoryProgress(page,ids.place,[1,0,0,1],2,0);
 await root(page).locator('.material-entity-directory [data-entity-id="'+ids.a+'"]').click();
 await chip(page,'推进到哪一步','已通过').click();
 // Trial-only matching entity remains visible, but all four REQUIRED counts are zero.
 await expectDirectoryProgress(page,ids.a,[0,0,0,0],0,6);await expectDirectoryProgress(page,ids.place,[0,0,0,1],1,0);
 await chip(page,'媒介','音频').click();await expectDirectoryProgress(page,ids.a,[0,0,0,0],0,0);
 await root(page).getByRole('button',{name:'清除筛选',exact:true}).click();await expectDirectoryProgress(page,ids.a,[1,1,0,0],2,6);
 await chip(page,'集','E01').click();await chip(page,'场','S01').click();
 // This exact scene has two references to MATREQ-FIXTURE-A, and the need also occurs in E02.
 await expectDirectoryProgress(page,ids.a,[1,1,0,0],2,0);await expectDirectoryProgress(page,ids.place,[0,0,0,1],1,0);
 await chip(page,'媒介','图像').click();await expectDirectoryProgress(page,ids.a,[1,0,0,0],1,0);
 await chip(page,'推进到哪一步','待生成').click();await expectDirectoryProgress(page,ids.a,[0,0,0,0],0,0);
 await expect(drawer(page)).not.toBeVisible();clean(f);
});
test('390px实体目录四态零值和三位数总数可换行且无溢出，仍保留201正式需求与6试制',async({page},testInfo)=>{
 await page.setViewportSize({width:390,height:1000});const f=await materialFixture(page,{fullDenominator:true});
 await page.goto('/?view=materials&materialMode=classification&materialPanel=closed');
 await count(page,'媒介','全部媒介',201);const row=await expectDirectoryProgress(page,ids.a,[197,1,0,0],198,6);await expectDirectoryProgress(page,ids.b,[0,0,1,0],1,0);await expectDirectoryProgress(page,ids.place,[1,0,0,1],2,0);
 await row.scrollIntoViewIfNeeded();
 const geometry=await row.evaluate(node=>{const box=node.getBoundingClientRect(),summary=node.querySelector('[data-entity-progress-summary]')!,items=[...summary.querySelectorAll('[data-entity-stage-count],[data-entity-total-count]')].map(item=>{const r=item.getBoundingClientRect();return{x:r.x-box.x,y:r.y-box.y,width:r.width,right:r.right-box.x,height:r.height};});return{width:box.width,scrollWidth:node.scrollWidth,clientWidth:node.clientWidth,items,thumbnail:node.querySelector('.material-entity-thumbnail')!.getBoundingClientRect().width};});
 expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth+1);expect(geometry.thumbnail).toBeGreaterThanOrEqual(40);expect(geometry.items).toHaveLength(5);
 for(const item of geometry.items){expect(item.width).toBeGreaterThan(0);expect(item.x).toBeGreaterThanOrEqual(0);expect(item.right).toBeLessThanOrEqual(geometry.width+1);}
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(390);
 await testInfo.attach('directory-four-stage-geometry',{body:JSON.stringify(geometry),contentType:'application/json'});await row.screenshot({path:testInfo.outputPath('directory-four-stage-390.png')});
 await chip(page,'媒介','图像').click();await expectDirectoryProgress(page,ids.a,[197,0,0,0],197,6);await count(page,'媒介','全部媒介',201);
 await expect(drawer(page)).not.toBeVisible();clean(f);
});
