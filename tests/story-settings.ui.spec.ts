import {test,expect,type Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
import type {MaterialRequirement} from '../app/production-workbench';
import {blankProfile,blankSnapshot} from '../host/instance-runtime/blank.mjs';
import {defaultConfiguration} from '../host/instance-runtime/configuration-model.mjs';
import {domainHash,type DomainGraph} from '../host/instance-runtime/domain-model.mjs';
import {workspaceProjection} from '../host/instance-runtime/domain-workspaces.mjs';
import type {DomainChange} from '../host/instance-runtime/domain-workspaces.mjs';
const materialBase=JSON.parse(readFileSync(new URL('./fixtures/generic-adopted-scene.json',import.meta.url),'utf8'));
async function fixture(page:Page,{readonly=false,saved=false,materials=false}={}){
 const capture=materials?structuredClone(materialBase):null;
 const profile=blankProfile({title:'设定工作区测试',instanceId:'settings-ui',projectId:'settings-story'}),snapshot=capture?.responses.bootstrap.data||blankSnapshot(profile).snapshot,config=defaultConfiguration(profile);
 snapshot.instance=profile;snapshot.productionModel.instance=profile;
 const graph:DomainGraph={schemaVersion:'1.0',entities:[{id:'a',name:'人物甲',type:'CHARACTER',description:'经营小店，谨慎守信。',aliases:[],authority:'A',evidence:[]},{id:'b',name:'人物乙',type:'CHARACTER',description:'来访的人。',aliases:[],authority:'U',evidence:[]},{id:'loc',name:'小店',type:'LOCATION',description:'门向与方位待核。',aliases:[],authority:'U',evidence:[]}],states:[{id:'state-a',entityId:'a',label:'到店之前',dimensions:{},scope:[],authority:'A',evidence:[]}],representations:[{id:'rep-a',entityId:'a',stateId:null,type:'IDENTITY',label:'人物甲身份母版',dimensions:{},assetFamilyIds:[],requirementIds:[],authority:'A',evidence:[]}],relations:[{id:'rel-ab',type:'SOCIAL',from:{kind:'ENTITY',id:'a'},to:{kind:'ENTITY',id:'b'},label:'互相认识',purpose:'',inherit:[],exclude:[],scope:[],authority:'A',evidence:[],status:'PROPOSED'}],requirements:[]};
 // Only the embedded-material dirty test needs selectable requirements. The
 // state-only deep-link test deliberately keeps zero requirements.
 const requirements:MaterialRequirement[]=materials?['a','b'].map((id,index)=>({id:'req-'+id,title:'人物'+(id==='a'?'甲':'乙')+'身份母版',category:'人物身份',mediaKind:'IMAGE',requirementClass:'REQUIRED',reuseScope:'PROJECT',productionLane:'MATERIAL_PREP',workflowStepId:null,assetFamilyRefs:[],plannedAssetFamilyId:null,materialWorkItemRef:null,consumerWorkItemRefs:[],episodeIds:[],episodeUids:[],sceneIds:[],shotIds:[],currentShotIds:[],structureCardRefs:[],storyBasis:{sourceRef:'fixture-source',factBoundary:'仅合成测试数据，没有新增实际媒体',whyNeeded:'辨认主体',onScreenRequirement:'人物身份清晰'},storyApplicability:{kind:'PROJECT_LEVEL',reason:'复用身份资料'},acceptanceProfile:'FIXTURE',acceptanceCriteria:['身份不得混淆'],requirementHash:String(index+1).repeat(64),coverageContextHash:String(index+1).repeat(64),coverageSatisfied:false,bindingStale:false,coverageReasons:['NO_CURRENT_OUTPUT'],coveredByFamilyRefs:[],coveredByVersionRefs:[],materialWorkItemLifecycleState:'WAITING_UPSTREAM'})):[];
 if(materials){graph.representations[0].requirementIds=['req-a'];graph.representations.push({...graph.representations[0],id:'rep-b',entityId:'b',label:'人物乙身份母版',requirementIds:['req-b']});Object.assign(snapshot.productionModel,{domainGraph:graph,systemConfiguration:{config},materialRequirements:requirements,materialWorkItems:[],assetFamilies:[],assetVersions:[],expectedOutputs:[]});}
 const drafts:Record<string,{revisionId:string;baseReleaseId:string;changes:DomainChange[]}|null>={SETTINGS:saved?{revisionId:'d-old',baseReleaseId:'r1',changes:[{collection:'entities',id:'b',beforeHash:domainHash(graph.entities[1]),value:{...graph.entities[1],name:'乙的已保存修改'}}]}:null,MATERIAL:null};let n=0;
 const mutations:Record<string,unknown>[]=[],unexpected:string[]=[],errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/**',async route=>{const req=route.request(),url=new URL(req.url()),json=(body:unknown)=>route.fulfill({json:body});
  if(url.pathname==='/api/instance/profile')return json(profile);
  if(url.pathname==='/api/v8/ui/bootstrap')return json({data:snapshot,snapshotId:snapshot.snapshotId});
  if(url.pathname==='/api/v8/snapshot')return json({snapshotId:snapshot.snapshotId,executionRecipes:{...blankSnapshot(profile).recipes,snapshotId:snapshot.snapshotId}});
  if(url.pathname==='/api/instance/documents')return json({documents:[]});
  if(url.pathname==='/api/instance/sources')return json({releaseId:'r1',sources:[]});
  if(url.pathname==='/api/instance/material-directory')return json({releaseId:'r1',revisionId:'dir-1',graph,bindings:[],trials:[],staleIds:[]});
  if(url.pathname==='/api/trial/scopes'&&req.method()==='GET')return json({scopes:[],defaultScopeId:null});
  if(url.pathname==='/api/instance/production-preparation')return json({releaseId:'r1',revisionId:null,content:null,candidate:null,comments:[],materialLinks:null,stale:false,readOnly:readonly});
  if(url.pathname==='/api/instance/authoring')return json({releaseId:'r1',roots:[],initializationReady:true,sourceBindings:[]});
  if(url.pathname==='/api/instance/setting-extraction')return json({releaseId:'r1',sources:[],results:[],input:null,task:null,capability:{initialize:false},readOnly:readonly});
  if(url.pathname==='/api/instance/spatial-settings')return json({status:'AVAILABLE',snapshotId:snapshot.snapshotId,sourceBinding:{logicalPath:'data/production_map_spec.json',revisionId:'sp-r1',sha256:'a'.repeat(64)},specification:{orientation:'北上东右',tower:{name:'小店空间包',zones:[{id:'zone-1',label:'门厅',rect:[0,0,5,6]}],cameras:[{id:'cam-1',label:'正门固定机位'}]},scene_route_locks:[{scene_id:'旧场-01',note:'原修订的路线'}]}});
  if(url.pathname==='/api/instance/configuration')return json({configuration:config,defaults:config,releaseId:'r1',revisionId:'c1',sha256:'a'.repeat(64),history:[],bindings:[],boundStandards:[],reviewCatalog:{},initialized:true,draft:null});
  if(url.pathname==='/api/v8/operations/snapshot')return json({...capture?.responses.operations,snapshotId:snapshot.snapshotId,mutationEtag:'"fixture"'});
  if(url.pathname==='/api/v8/ui/materials'){const id=url.searchParams.get('requirementId'),rows=id?requirements.filter(row=>row.id===id):requirements;return json({schemaVersion:'1.0',snapshotId:snapshot.snapshotId,operationRevision:'fixture-op',appliedMode:'requirements',detailState:'COMPLETE',page:{materialRequirements:rows,materialWorkItems:[],assetFamilies:[],assetVersions:[],expectedOutputs:[]},count:rows.length,total:rows.length,nextCursor:null,hasMore:false,appliedFilters:{}});}
  if(url.pathname==='/api/v8/reviews')return json({events:[]});
  if(url.pathname==='/api/assistant/v1/conversations')return json({conversations:[],bridge:{online:false},pagination:{}});
  if(url.pathname==='/api/assistant/v1/context')return json({context:{focus:req.postDataJSON().focus,resources:[],missing:[],draftTargets:[]}});
  if(url.pathname==='/api/instance/domain-workspaces'){
   const owner=url.searchParams.get('owner')||'SETTINGS';
   if(req.method()==='GET')return json({...workspaceProjection(snapshot,graph,owner),releaseId:'r1',revisionId:'g1',readOnly:readonly,draft:drafts[owner],draftHeadRevisionId:drafts[owner]?.revisionId||null,legacyDrafts:[]});
   const body=req.postDataJSON();mutations.push(body);if(readonly)return route.fulfill({status:405,json:{error:'只读'}});
   if(body.action==='save'){drafts[body.owner]={revisionId:'draft-'+(++n),baseReleaseId:'r1',changes:body.changes};return json({revisionId:drafts[body.owner]?.revisionId});}
   if(body.action==='preview')return json({previewHash:'pv1',checks:['其他模块草稿不会随本次确认生效'],impact:{added:0,changed:1,removed:0,affectedFamilies:[],invalidations:[]}});
   if(body.action==='publish'){for(const change of drafts[body.owner]?.changes||[]){const rows=graph[change.collection] as Array<{id:string}>;const index=rows.findIndex(r=>r.id===change.id);if(change.value){if(index>=0)rows[index]=change.value;else rows.push(change.value);}}drafts[body.owner]=null;return json({releaseId:'r1'});}
   return route.fulfill({status:409,json:{error:'FIXTURE_CONFLICT'}});
  }
  if(capture&&req.method()==='GET')for(const[key,path]of Object.entries(capture.routes))if(url.pathname===String(path).split('?')[0])return json(capture.responses[key]);
  unexpected.push(req.method()+' '+url.pathname);return route.fulfill({status:418,json:{error:'unexpected'}});
 });
 return {graph,drafts,mutations,unexpected,errors};
}
test('six entry navigation, full-width setting canvases and scoped space remain available at narrow widths',async({page})=>{
 const f=await fixture(page);await page.goto('/?view=settings');await expect(page.locator('.workspace-nav>button')).toHaveCount(6);
 for(const label of ['主体档案','空间设定'])await expect(page.getByRole('tab',{name:label,exact:true})).toBeVisible();
 for(const label of ['关系全景','状态与连续性'])await expect(page.getByRole('button',{name:label,exact:true})).toHaveCount(0);
 await expect(page.getByRole('region',{name:'主体与关联关系'})).toBeVisible();await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.locator('.settings-layout')).toHaveClass(/is-canvas-view/);await page.getByLabel('搜索设定与关系').fill('不存在');await expect(page.getByText('当前筛选没有匹配内容。可以修改关键词或取消筛选。')).toBeVisible();await page.getByLabel('搜索设定与关系').fill('');
 await page.getByRole('tab',{name:'空间设定',exact:true}).click();
 await expect(page.getByRole('region',{name:'全局空间与地点',exact:true})).toBeVisible();
 await expect(page.getByRole('navigation',{name:'实体分类',exact:true})).toHaveCount(0);
 await expect(page.getByText('空间总图与已发布坐标基线',{exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'＋ 登记实体关系',exact:true})).toHaveCount(0);
 const unplaced=page.getByRole('region',{name:'位置待核地点',exact:true});await expect(unplaced).toContainText('小店');
 await unplaced.getByRole('button',{name:'小店 位置未知',exact:true}).click();
 const location=page.getByRole('dialog',{name:'对象设定详情',exact:true});await expect(location.getByRole('heading',{name:'小店',exact:true})).toBeVisible();
 await expect(location.getByRole('region',{name:'地点视觉资料',exact:true})).toContainText('尚无精确关联的地点图片');
 await location.getByRole('button',{name:'关闭对象详情',exact:true}).click();
 await page.setViewportSize({width:390,height:844});await expect(page.locator('.mobile-nav>button')).toHaveCount(6);expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(390);
 expect(f.errors).toEqual([]);expect(f.unexpected).toEqual([]);
});
test('editing automatically resumes a saved owner draft and never silently replaces its other changes',async({page})=>{
 const f=await fixture(page,{saved:true});await page.goto('/?view=settings&settingsEntity=a');const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();await dialog.getByRole('button',{name:'编辑此项',exact:true}).click();await dialog.getByLabel('实体名称',{exact:true}).fill('甲的本次修改');await dialog.getByRole('button',{name:'保存草稿',exact:true}).click();await expect(dialog.getByRole('status')).toHaveText('草稿已保存，尚未生效。');
 const save=f.mutations.find(m=>m.action==='save') as {changes:DomainChange[]};
 expect(save).toMatchObject({owner:'SETTINGS',expectedReleaseId:'r1',expectedDraftRevisionId:'d-old'});
 expect(save.changes.map(c=>c.id).sort()).toEqual(['a','b']);expect(save.changes.find(c=>c.id==='b')?.value).toMatchObject({name:'乙的已保存修改'});
 await dialog.getByRole('button',{name:'预览影响',exact:true}).click();await expect(dialog.getByText('其他模块草稿不会随本次确认生效')).toBeVisible();await dialog.getByRole('button',{name:'确认本模块更新',exact:true}).click();
 await expect(dialog.getByRole('status')).toHaveText('本模块修改已确认；剧本采用和素材放行没有改变。');
 expect(f.mutations.find(m=>m.action==='publish')).toMatchObject({owner:'SETTINGS',draftRevisionId:'draft-1',previewHash:'pv1'});
 expect(f.errors).toEqual([]);expect(f.unexpected).toEqual([]);
});
test('state and relation deep links restore exact objects and return to the default view',async({page})=>{
 const f=await fixture(page);await page.goto('/?view=settings&settingsEntity=a');
 await page.getByRole('button',{name:/到店之前/}).click();
 await expect(page).toHaveURL(/view=materials/);await expect(page).toHaveURL(/entity=a/);await expect(page).toHaveURL(/materialState=state-a/);
 await page.reload();
 // This entity has a registered state but no requirements: a deep link must
 // still restore the exact condition, not silently show a default material.
 await expect(page).toHaveURL(/materialState=state-a/);
 await expect(page.locator('[data-canvas-node-id^="material:"]')).toHaveCount(0);
 const condition=page.locator('dialog.material-review-drawer[open]');
 await expect(condition.locator('.material-panel-facts')).toContainText('state-a');
 await expect(condition.getByRole('heading',{name:'到店之前',exact:true})).toBeVisible();
 await expect(condition).toContainText('历史状态／属性来源审计');
 await expect(page.locator('[data-canvas-node-id="state-a"]')).toHaveCount(0);
 await expect(condition.getByRole('button',{name:'维护这项状态定义',exact:true})).toHaveCount(0);
 await expect(condition.getByRole('region',{name:'素材定义与依赖',exact:true})).toHaveCount(0);
 await page.goto('/?view=settings&settingsRelation=rel-ab');await expect(page).toHaveURL(/settingsRelation=rel-ab/);
 await page.reload();await expect(page.getByRole('heading',{name:'互相认识',exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'关系定义',exact:true})).toBeVisible();
 await page.goto('/?view=settings');await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.getByRole('region',{name:'主体与关联关系',exact:true}).getByRole('button',{name:'人物甲',exact:true})).toBeVisible();expect(f.mutations).toEqual([]);expect(f.errors).toEqual([]);expect(f.unexpected).toEqual([]);
});
test('embedded material detail restores its draft; drawer closing and history module leave can both be declined',async({page})=>{
 const f=await fixture(page,{materials:true});await page.goto('/?view=story');await page.getByRole('complementary',{name:'审阅台主导航',exact:true}).getByRole('button',{name:/素材管理/}).click();
 await expect(page.locator('.material-entity-review')).toHaveAttribute('aria-busy','false');
 // Install the exact legacy definition location in the current SPA history
 // entry; the previous entry remains the real main-navigation story view.
 await page.evaluate(()=>{history.replaceState(history.state,'','/?view=materials&entity=a&materialDefinitionKind=representations&materialDefinitionId=rep-a');window.dispatchEvent(new PopStateEvent('popstate',{state:history.state}));});
 const drawer=page.locator('dialog.material-review-drawer[open]');await expect(drawer).toBeVisible();
 await drawer.getByRole('button',{name:'编辑此项',exact:true}).click();const name=drawer.getByLabel('素材形态名称',{exact:true});await name.fill('尚未保存的母版说明');
 const refreshed=page.waitForResponse(response=>response.url().includes('/api/instance/material-directory'));await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await refreshed;await expect(name).toBeVisible();await expect(name).toHaveValue('尚未保存的母版说明');
 await drawer.getByRole('button',{name:'关闭对象详情',exact:true}).click();await expect(name).toHaveCount(0);
 await page.goBack();await expect(page).toHaveURL(/materialDefinitionId=rep-a/);await drawer.getByRole('button',{name:'编辑此项',exact:true}).click();await expect(name).toHaveValue('尚未保存的母版说明');
 let dialogs=0;page.on('dialog',async d=>{dialogs+=1;await d.dismiss();});
 await drawer.getByRole('button',{name:'关闭详情',exact:true}).click();await expect.poll(()=>dialogs).toBe(1);await expect(drawer).toBeVisible();await expect(name).toHaveValue('尚未保存的母版说明');await expect(page).toHaveURL(/entity=a/);
 // The native modal makes the outside entity/module navigation inert.
 // Browser Back exercises a real cross-module exit without force-clicking it.
 await page.goBack();await expect.poll(()=>dialogs).toBe(2);await expect(page).toHaveURL(/view=materials/);await expect(name).toHaveValue('尚未保存的母版说明');
 expect(f.mutations).toHaveLength(0);expect(f.errors).toEqual([]);expect(f.unexpected).toEqual([]);
});
test('explicit setting deep link retains unsaved edits when changing section or module is declined',async({page})=>{
 const f=await fixture(page);await page.goto('/?view=settings&settingsEntity=a');
 const detail=page.getByRole('dialog',{name:'对象设定详情',exact:true});await expect(detail).toBeVisible();await detail.getByRole('button',{name:'编辑此项',exact:true}).click();await detail.getByLabel('实体名称',{exact:true}).fill('尚未保存');
 // Close only the detail presentation; the existing local workspace draft survives.
 await detail.getByRole('button',{name:'关闭对象详情',exact:true}).click();await expect(detail).toHaveCount(0);
 const board=page.getByRole('region',{name:'主体与关联关系',exact:true});await expect(board.getByRole('button',{name:'尚未保存',exact:true})).toBeVisible();
 let dialogs=0;page.on('dialog',async d=>{dialogs+=1;await d.dismiss();});
 await page.getByRole('tab',{name:'空间设定',exact:true}).click();await expect.poll(()=>dialogs).toBe(1);await expect(board).toBeVisible();expect(new URL(page.url()).searchParams.get('settingsSection')).not.toBe('space');
 await page.getByRole('navigation',{name:'主导航',exact:true}).getByRole('button',{name:'故事创作',exact:true}).click();await expect.poll(()=>dialogs).toBe(2);await expect(page).toHaveURL(/view=settings/);await expect(board.getByRole('button',{name:'尚未保存',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'返回审阅台首页',exact:true}).click();await expect.poll(()=>dialogs).toBe(3);await expect(page).toHaveURL(/view=settings/);await expect(board.getByRole('button',{name:'尚未保存',exact:true})).toBeVisible();
 // Native Back restores the exact initial entity deep link, not a newly fabricated route.
 await page.goBack();await expect(page).toHaveURL(/settingsEntity=a/);await expect(detail).toBeVisible();await detail.getByRole('button',{name:'编辑此项',exact:true}).click();await expect(detail.getByLabel('实体名称',{exact:true})).toHaveValue('尚未保存');expect(dialogs).toBe(3);
 expect(f.mutations).toEqual([]);expect(f.errors).toEqual([]);expect(f.unexpected).toEqual([]);
});
test('read-only settings expose facts and never render editing or confirmation controls',async({page})=>{
 const f=await fixture(page,{readonly:true});await page.goto('/?view=settings&settingsEntity=a');await expect(page.getByRole('heading',{name:'人物甲',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'编辑此项',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:/登记主体/})).toHaveCount(0);for(const label of ['保存草稿','预览影响','确认本模块更新'])await expect(page.getByRole('button',{name:label,exact:true})).toHaveCount(0);expect(f.mutations).toEqual([]);expect(f.errors).toEqual([]);expect(f.unexpected).toEqual([]);
});

test('登记弹窗取消不留下空主体，明确保存合并既有草稿并保持未发布',async({page})=>{
 const f=await fixture(page,{saved:true});await page.goto('/?view=settings');
 await expect(page.getByRole('heading',{name:'依据资料整理设定草稿',exact:true})).toHaveCount(0);
 const trigger=page.getByRole('button',{name:'＋ 登记主体',exact:true});
 await trigger.click();
 const dialog=page.getByRole('dialog',{name:'登记主体',exact:true});
 await dialog.getByLabel('主体名称',{exact:true}).fill('取消的主体');
 await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);
 expect(f.mutations).toEqual([]);expect(f.drafts.SETTINGS?.changes).toHaveLength(1);
 await expect(page.getByRole('button',{name:'取消的主体',exact:true})).toHaveCount(0);
 await trigger.click();await expect(dialog.getByLabel('主体名称',{exact:true})).toHaveValue('');
 await dialog.getByLabel('主体名称',{exact:true}).fill('明确保存的主体');
 await dialog.getByRole('button',{name:'保存草稿',exact:true}).click();await expect(dialog).toHaveCount(0);
 expect(f.mutations).toHaveLength(1);
 const saved=f.mutations[0] as {changes:DomainChange[]};
 expect(saved).toMatchObject({action:'save',owner:'SETTINGS',expectedReleaseId:'r1',expectedDraftRevisionId:'d-old'});
 expect(saved.changes).toHaveLength(2);expect(saved.changes.find(change=>change.id==='b')?.value).toMatchObject({name:'乙的已保存修改'});
 expect(saved.changes.find(change=>change.id!=='b')?.value).toMatchObject({name:'明确保存的主体',authority:'A'});
 expect(f.graph.entities.some(entity=>entity.name==='明确保存的主体')).toBe(false);
 expect(f.errors).toEqual([]);expect(f.unexpected).toEqual([]);
});

test('空间卡仅展示空间图片及关键信息，编辑在标题栏且键盘页签可切换',async({page})=>{
 const f=await fixture(page);await page.goto('/?view=settings');
 await page.getByRole('tab',{name:'主体档案',exact:true}).focus();await page.keyboard.press('ArrowRight');
 await expect(page.getByRole('tab',{name:'空间设定',exact:true})).toHaveAttribute('aria-selected','true');
 await page.getByRole('region',{name:'位置待核地点'}).getByRole('button',{name:'小店 位置未知',exact:true}).click();
 const detail=page.getByRole('dialog',{name:'对象设定详情',exact:true});
 await expect(detail.locator('a[href*="view=materials"]')).toHaveCount(0);
 await expect(detail.getByRole('heading',{name:/关联素材|状态与制作条件|关联关系/})).toHaveCount(0);
 await expect(detail.locator('header').getByRole('button',{name:'编辑此项',exact:true})).toBeVisible();
 await detail.getByRole('button',{name:'编辑此项',exact:true}).click();await expect(detail.getByLabel('实体名称',{exact:true})).toHaveValue('小店');
 expect(f.mutations).toEqual([]);expect(f.errors).toEqual([]);expect(f.unexpected).toEqual([]);
});

test('brand from populated and invalid deep links stays at the bare root after background reads settle',async({page})=>{
 await fixture(page,{materials:true});
 for(const route of ['/?view=settings&settingsEntity=a#old','/?view=materials&material=missing&family=missing#unknown','/?view=overview&workStage=invalid#old']){
  await page.goto(route);
  const dialog=page.getByRole('dialog',{name:'对象设定详情'});
  if(route.includes('settingsEntity=')){await expect(dialog).toBeVisible();await dialog.getByRole('button',{name:'关闭对象详情',exact:true}).click();}
  if(route.includes('material=missing')){const missing=page.getByRole('dialog',{name:'无法定位原对象',exact:true});await expect(missing).toBeVisible();await missing.press('Escape');await expect(missing).not.toBeVisible();}
  await page.getByRole('button',{name:'返回审阅台首页',exact:true}).click();
  await expect.poll(()=>new URL(page.url()).pathname+new URL(page.url()).search+new URL(page.url()).hash).toBe('/');
  await page.waitForTimeout(600);
  expect(new URL(page.url()).search+new URL(page.url()).hash).toBe('');
 }
});
