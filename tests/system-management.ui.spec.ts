import {test,expect,type Page} from '@playwright/test';
import {blankProfile,blankSnapshot} from '../host/instance-runtime/blank.mjs';
import {defaultConfiguration} from '../host/instance-runtime/configuration-model.mjs';
import {emptyDomainGraph,validateInitializationContent} from '../host/instance-runtime/domain-model.mjs';
import {compileAuthoringRoots,validateAuthoringRoot,type AuthoringRoot,type AuthoringRootInput} from '../host/instance-runtime/domain-authoring.mjs';
import {publishedInitializationProjection} from '../app/api/instance/_published-initialization';
import type {InitializationContent} from '../host/instance-runtime/domain-model.mjs';

async function fixture(page:Page,{sourceReadOnly=false}={}){
  const profile=blankProfile({title:'新剧初始化验收',instanceId:'system-management-ui',projectId:'system-management-story'});profile.capabilities.landingView='system';
  const snapshot=blankSnapshot(profile).snapshot;const configuration=defaultConfiguration(profile);const sources:Array<{id:string;title:string;role:string;format:string;sha256:string;revisionId:string;status:string;textAvailable?:boolean;documentId?:string;documentRevisionId?:string;documentSha256?:string;text?:string}>=[];
  const authoringRoots:AuthoringRoot[]=[];let candidates:Array<{creativeRevisionId:string;rootId:string;rootRevisionId:string;review:Record<string,unknown>|null}>=[];let adoptedCreativeRevisionId:string|null=null;let published:Record<string,unknown>|null=null;let publishedOnly=false;
  let draft:{revisionId:string;content:InitializationContent}|null=null;let initialized=false;let sequence=0;const mutations:Record<string,unknown>[]=[];const unexpected:string[]=[];
  await page.route('**/api/**',async route=>{const request=route.request();const url=new URL(request.url());const json=(body:unknown)=>route.fulfill({json:body});
    if(url.pathname==='/api/instance/profile')return json(profile);
    if(url.pathname==='/api/v8/ui/bootstrap')return json({data:snapshot,snapshotId:snapshot.snapshotId});
    if(url.pathname==='/api/instance/documents')return url.searchParams.get('id')?json({documentId:url.searchParams.get('id'),revisionId:'source-r1',sha256:'a'.repeat(64),text:sources.find(s=>s.documentId===url.searchParams.get('id'))?.text||'来源正文精确读取',focusId:'doc-focus'}):json({documents:[]});
    if(url.pathname==='/api/v8/operations')return json({snapshotId:snapshot.snapshotId,events:[],sourceOperationEvents:[],creativeRevisionEvents:[]});
    if(url.pathname==='/api/v8/ui/episode-plan')return route.fulfill({status:404,json:{error:'尚未登记完整方案'}});
    if(url.pathname==='/api/assistant/v1/conversations')return json({conversations:[],bridge:{online:false},pagination:{}});
    if(url.pathname==='/api/assistant/v1/context')return json({context:{focus:request.postDataJSON().focus,resources:[],missing:[],draftTargets:[]}});
    if(url.pathname==='/api/v8/operations/snapshot')return json({mutationEtag:'"fixture-etag"'});
    if(url.pathname==='/api/instance/sources'){
      if(request.method()==='GET')return json({releaseId:'fixture-release',sources,readOnly:sourceReadOnly});
      const body=request.postDataJSON();mutations.push(body);if(sourceReadOnly)return route.fulfill({status:405,json:{error:'本实例来源只读'}});expect(request.headers()['if-match']).toBe('"fixture-etag"');sources.push({id:`source-${sources.length}`,title:body.title,role:body.role,format:'text',sha256:'a'.repeat(64),revisionId:'source-r1',status:'TEXT_AVAILABLE',textAvailable:true,documentId:`document:source-${sources.length}`,documentRevisionId:'source-r1',documentSha256:'a'.repeat(64),text:body.text});return json(sources.at(-1));
    }
    if(url.pathname==='/api/instance/initialization'){
      if(request.method()==='GET')return json({releaseId:'fixture-release',state:initialized?'READY':draft?'DRAFT':'NOT_STARTED',sourceCount:sources.length,draft:publishedOnly?null:draft,published,readOnly:publishedOnly});
      const body=request.postDataJSON();mutations.push(body);
      if(body.action==='prepare')draft={revisionId:`draft-${++sequence}`,content:{schemaVersion:'1.0',title:profile.storyTitle,summary:'',configuration,graph:emptyDomainGraph(),uncertainties:['目标平台待确认'],sourceBindings:sources.map(s=>({sourceId:s.id,revisionId:s.revisionId,sha256:s.sha256}))}};
      if(body.action==='save'&&body.expectedDraftRevisionId!==(draft?.revisionId||null))return route.fulfill({status:409,json:{error:'初始化草稿已变化，本地修改未覆盖远端'}});
      if(body.action==='save')draft={revisionId:`draft-${++sequence}`,content:validateInitializationContent(body.content)};
      if(body.action==='preview')return json({previewHash:'preview-sha',checks:['来源版本一致','实体身份有效']});
      if(body.action==='publish'){expect(body.previewHash).toBe('preview-sha');initialized=true;}
      return json({revisionId:draft?.revisionId,status:body.action==='run'?'REQUESTED':'SUCCEEDED',state:initialized?'READY':'DRAFT'});
    }
    if(url.pathname==='/api/instance/authoring'){
      if(request.method()==='GET')return json({releaseId:'fixture-release',roots:authoringRoots,candidates,adoptedCreativeRevisionId,initializationReady:initialized,readOnly:false,sourceBindings:sources.map(s=>({sourceId:s.id,revisionId:s.revisionId,sha256:s.sha256}))});
      const body=request.postDataJSON();mutations.push(body);if(body.action==='adoptionPreview')return json({previewHash:'adopt-sha',checks:['只采用方案，场正文仍需逐场审阅']});if(body.action==='adopt'){expect(body.previewHash).toBe('adopt-sha');adoptedCreativeRevisionId=body.creativeRevisionId;return json({releaseId:'fixture-release',creativeRevisionId:body.creativeRevisionId,state:'SOURCE_CURRENT'});}const previous=authoringRoots.find(r=>r.id===body.root?.id)||null;if(body.expectedRevisionId!==(previous?.revisionId||null))return route.fulfill({status:409,json:{error:'作者草稿已变化，本地修改未覆盖远端'}});const checked=validateAuthoringRoot(body.root,{previous,roots:authoringRoots});const root:AuthoringRoot={...checked,revisionId:`author-r${++sequence}`,status:'DRAFT',sourcePath:`story/authoring/${checked.id}.json`,sceneRevisionBindings:[],sha256:'b'.repeat(64),parentRevisionId:null,contentHash:'c'.repeat(64),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),formalAdoptionPerformed:false};const index=authoringRoots.findIndex(r=>r.id===root.id);if(index>=0)authoringRoots.splice(index,1,root);else authoringRoots.push(root);return json({root,releaseId:'fixture-release'});
    }
    if(url.pathname==='/api/instance/configuration')return json({configuration,defaults:configuration,releaseId:'fixture-release',revisionId:'config-r1',sha256:'a'.repeat(64),history:[],bindings:[],boundStandards:[],reviewCatalog:{},initialized:true,draft:null});
    if(url.pathname==='/api/instance/maintenance')return json({runtime:{instanceId:'system-management-ui',status:'READY'},storage:{provider:'postgresql'},backups:[],capabilities:{backup:true,verify:true,export:true},operations:[]});
    if(url.pathname==='/api/instance/domain-workspaces')return json({snapshotId:snapshot.snapshotId,releaseId:'fixture-release',revisionId:null,graph:emptyDomainGraph(),ownership:{},configuration:configuration.domain,requirements:[],spatial:null,draft:null,draftHeadRevisionId:null,legacyDrafts:[],readOnly:false});
    if(url.pathname==='/api/instance/relations')return json({releaseId:'fixture-release',revisionId:null,graph:emptyDomainGraph(),draft:null});
    unexpected.push(`${request.method()} ${url.pathname}`);return route.fulfill({status:418,json:{error:'Unexpected fixture request'}});
  });
  return{mutations,unexpected,seedPublished:()=>{initialized=true;publishedOnly=true;sources.push({id:'source-0',title:'已确认原文',role:'PRIMARY',format:'TEXT',revisionId:'source-r1',sha256:'a'.repeat(64),status:'TEXT_AVAILABLE'});published={revisionId:'confirmed-init',content:{title:'已确认故事',summary:'确认后的故事理解',uncertainties:['一项待核来源'],sourceBindings:[{sourceId:'source-0',revisionId:'source-r1',sha256:'a'.repeat(64)}]}};},seedGeneric:(formalShell=false)=>{initialized=true;const make=(id:string,kind:AuthoringRoot['kind'],parentId:string|null):AuthoringRoot=>({id,kind,title:id,body:'作者正文',parentId,sceneIds:[],sourceBindings:[{sourceId:'source-0',revisionId:'source-r1',sha256:'a'.repeat(64)}],revisionId:id+'-r1',status:'DRAFT',sourcePath:'story/'+id+'.json',sceneRevisionBindings:[],sha256:'a'.repeat(64),parentRevisionId:null,contentHash:'b'.repeat(64),createdAt:'2026-09-07',updatedAt:'2026-09-07',formalAdoptionPerformed:false});authoringRoots.push(make('story-one','STORY_OUTLINE',null),make('script-one','SCREENPLAY','story-one'),make('scene-one','SCENE_SCRIPT','script-one'));if(formalShell)Object.assign(snapshot,compileAuthoringRoots(snapshot,authoringRoots));else{const plan=make('plan-one','EPISODE_PLAN','script-one');plan.planContent={planId:profile.episodePlanId,episodes:[]} as unknown as AuthoringRoot['planContent'];authoringRoots.push(plan);candidates=[{rootId:plan.id,rootRevisionId:plan.revisionId,creativeRevisionId:'candidate-one',review:null}];}return{approve:()=>{candidates[0].review={eventId:'review-one',action:'APPROVE_AND_RELEASE',applicationStatus:'APPLIED',effect:'APPLIED',sourceSyncState:'PENDING'};}};},updateInitialization:()=>{if(!draft)throw new Error('draft missing');draft={revisionId:`external-${++sequence}`,content:{...draft.content,summary:'远端新草稿'}};},updateAuthoring:()=>{const root=authoringRoots[0];if(!root)throw new Error('root missing');root.revisionId=`external-author-${++sequence}`;root.body='远端修改的正文';}};
}

test('system tabs preserve links and five compact configuration groups fit narrow screens',async({page})=>{
  const f=await fixture(page);await page.goto('/?view=system#system-configuration');await expect(page.getByRole('tab',{name:'系统配置',exact:true})).toHaveAttribute('aria-selected','true');
  for(const name of ['项目与交付','资料与设定','素材与制作','审阅标准','AI与界面'])await expect(page.getByRole('button',{name,exact:true})).toBeVisible();
  await page.getByRole('button',{name:'资料与设定',exact:true}).click();await page.getByRole('button',{name:'实体体系',exact:true}).click();const structure=page.getByRole('navigation',{name:'配置结构目录',exact:true});await expect(structure).toBeVisible();await structure.getByRole('button',{name:'关系类型',exact:true}).click();await expect(structure.getByRole('button',{name:'关系类型',exact:true})).toHaveAttribute('aria-pressed','true');await expect(page.getByRole('combobox',{name:'关系用途',exact:true})).toBeVisible();await expect(page.getByRole('combobox',{name:'关系用途',exact:true}).getByRole('option')).toHaveCount(4);
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(390);
  await page.getByRole('tab',{name:'数据与运行',exact:true}).click();await expect(page.locator('.management-runtime-facts').first().getByText('postgresql',{exact:true})).toBeVisible();await page.reload();await expect(page.getByRole('tab',{name:'数据与运行',exact:true})).toHaveAttribute('aria-selected','true');
  expect(f.unexpected).toEqual([]);
});

test('new story authors an outline then a screenplay using exact confirmed sources and a parent draft',async({page})=>{
 const f=await fixture(page);f.seedPublished();
 await page.goto('/?view=story&storyMode=story-structure');
 const outline=page.locator('.generic-authoring-workspace').filter({has:page.getByRole('heading',{name:'故事结构草稿',exact:true})});
 await outline.getByLabel('草稿名称',{exact:true}).fill('古宅故事结构');await outline.getByRole('textbox',{name:'正文',exact:true}).fill('林青在古宅里发现家族留下的信。');await outline.locator('fieldset input[type=checkbox]').first().check();await outline.locator('fieldset input[type=checkbox]').first().check();await outline.getByRole('button',{name:'保存作者草稿',exact:true}).click();await expect(outline.getByText('作者草稿已保存。完整候选经对应正式审阅后才能采用。')).toBeVisible();
 // The independent screenplay panel refreshes after the shared authoring event.
 const screenplay=page.locator('.generic-authoring-workspace').filter({has:page.getByRole('heading',{name:'完整剧本草稿',exact:true})});
 await screenplay.getByRole('combobox',{name:'依据的故事结构',exact:true}).selectOption({label:'古宅故事结构'});await screenplay.getByLabel('草稿名称',{exact:true}).fill('古宅完整剧本');await screenplay.getByLabel('正文',{exact:true}).fill('第一场，林青推开古宅的门。');await screenplay.locator('fieldset input[type=checkbox]').first().check();await screenplay.getByRole('button',{name:'保存作者草稿',exact:true}).click();await expect(screenplay.getByText('作者草稿已保存。完整候选经对应正式审阅后才能采用。')).toBeVisible();
 const saves=f.mutations.filter(m=>m.action==='save'&&m.root) as Array<{root:AuthoringRootInput}>;expect(saves).toHaveLength(2);expect(saves[0].root.sourceBindings).toHaveLength(1);expect(saves[1].root.parentId).toMatch(/^author_/);expect(f.unexpected).toEqual([]);
});


test('authoring notifications keep local edits and reject saving over a newer remote revision',async({page})=>{
 const f=await fixture(page);f.seedPublished();await page.goto('/?view=story&storyMode=story-structure');
 const outline=page.locator('.generic-authoring-workspace').filter({has:page.getByRole('heading',{name:'故事结构草稿',exact:true})});await outline.getByLabel('草稿名称',{exact:true}).fill('我的提纲');await outline.getByRole('textbox',{name:'正文',exact:true}).fill('第一版提纲');await outline.locator('fieldset input[type=checkbox]').first().check();await outline.getByRole('button',{name:'保存作者草稿',exact:true}).click();await expect(outline.getByText('作者草稿已保存。完整候选经对应正式审阅后才能采用。')).toBeVisible();await outline.getByRole('textbox',{name:'正文',exact:true}).fill('我未保存的提纲');f.updateAuthoring();await page.evaluate(()=>window.dispatchEvent(new Event('review:authoring-updated')));await expect(outline.getByText('远端作者草稿已有更新。你的未保存正文已保留；保存将核对原编辑版本，避免覆盖他处修改。')).toBeVisible();await expect(outline.getByRole('textbox',{name:'正文',exact:true})).toHaveValue('我未保存的提纲');await outline.locator('fieldset input[type=checkbox]').first().check();await outline.getByRole('button',{name:'保存作者草稿',exact:true}).click();await expect(outline.getByText('作者草稿已变化，本地修改未覆盖远端')).toBeVisible();await expect(outline.getByRole('textbox',{name:'正文',exact:true})).toHaveValue('我未保存的提纲');expect(f.mutations.at(-1)?.expectedRevisionId).toBe('author-r1');expect(f.unexpected).toEqual([]);
});


test('hosted projection keeps only confirmed summary and source metadata',()=>{const value=publishedInitializationProjection({initialization:{state:'READY',revisionId:'r1',draft:{secret:'private draft'},content:{title:'公开故事',summary:'已确认',uncertainties:['待核'],privateTask:'private',sourceBindings:[{sourceId:'source-one',revisionId:'s1',sha256:'a'.repeat(64),text:'private'}]},sources:[{id:'source-one',title:'原件',text:'private original',relativePath:'/private/original.wav',secret:'secret',observation:'ORIGINAL_UNOBSERVED'}]}});expect(value.sourceCount).toBe(1);expect(value.published?.content).toMatchObject({summary:'已确认',uncertainties:['待核']});expect(JSON.stringify(value)).not.toMatch(/private|secret|relativePath/);expect(publishedInitializationProjection({initialization:{state:'DRAFT',draft:{content:{summary:'unconfirmed'}}}}).published).toBeNull();});

test('a reviewed authoring candidate requires preview before exact adoption',async({page})=>{const f=await fixture(page),authoring=f.seedGeneric();await page.goto('/?view=story&storyMode=logic');const planPanel=page.locator('.generic-authoring-workspace').filter({has:page.getByRole('heading',{name:'分集方案草稿',exact:true})});await expect(planPanel).toHaveCount(1);await planPanel.getByRole('combobox',{name:'已保存草稿',exact:true}).selectOption('plan-one');await expect(page.getByRole('button',{name:'预览方案采用',exact:true})).toHaveCount(0);authoring.approve();await page.evaluate(()=>window.dispatchEvent(new Event('review:operations-updated')));await expect(page.getByRole('button',{name:'确认采用分集方案',exact:true})).toBeDisabled();await page.getByRole('button',{name:'预览方案采用',exact:true}).click();await expect(page.getByText('只采用方案，场正文仍需逐场审阅',{exact:true})).toBeVisible();await page.getByRole('button',{name:'确认采用分集方案',exact:true}).click();await expect(page.getByText('分集方案已采用。场正文继续逐场审阅，制作范围尚未锁定。')).toBeVisible();expect(f.mutations.map(m=>m.action)).toEqual(['adoptionPreview','adopt']);expect(f.mutations.at(-1)).toMatchObject({rootId:'plan-one',expectedRevisionId:'plan-one-r1',creativeRevisionId:'candidate-one',reviewEventId:'review-one'});});

test('the populated generic shell retains authoring and the integrated general source directory',async({page})=>{const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));const f=await fixture(page);f.seedGeneric(true);await page.goto('/?view=story&storyMode=story-structure');await expect(page.getByRole('heading',{name:'故事结构草稿',exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'完整剧本草稿',exact:true})).toBeVisible();await page.goto('/?view=story&storyMode=source');await expect(page.locator('.unified-source-workspace').getByRole('heading',{name:'来源资料',exact:true})).toBeVisible();await expect(page.getByRole('navigation',{name:'实例来源目录',exact:true})).toBeVisible();await expect(page.getByText('完整来源资料暂时无法读取',{exact:false})).toHaveCount(0);expect(errors).toEqual([]);});

test('real adopted generic scene retains exact shared reading and six episode criteria without legacy scene review',async({page})=>{
 const {readFile}=await import('node:fs/promises');const capture=JSON.parse(await readFile(new URL('./fixtures/generic-adopted-scene.json',import.meta.url),'utf8'));
 const {stableObjectHash}=await import('../app/api/v8/_store');
 const plan=capture.responses.episodePlan.plan,context=capture.responses.sceneReviewContext.context,document=context.sceneDocument,episode=plan.content.episodes.find((row:{sceneIds:string[]})=>row.sceneIds.includes(capture.sceneId));
 expect(document.id).toBe(capture.sceneId);expect(document.contentHash).toBe(stableObjectHash(document.scriptBlocks));expect(context.sceneContentHash).toBe(document.contentHash);expect(context.formalTarget.sceneContentHash).toBe(document.contentHash);expect(context.revisionId).toBe(plan.revisionId);expect(context.planContentHash).toBe(plan.contentHash);expect(context.snapshotId).toBe(plan.snapshotId);expect(context.episodeUid).toBe(episode.episodeUid);
 const errors:string[]=[],writes:string[]=[],sceneReads:Array<{sceneId:string|null;revisionId:string|null}>=[];page.on('pageerror',error=>errors.push(error.message));let sourceFailure=false,sourceFailures=0;
 await page.route('**/api/**',async route=>{const request=route.request(),url=new URL(request.url()),json=(value:unknown)=>route.fulfill({json:value});if(request.method()!=='GET'){writes.push(url.pathname);return route.fulfill({status:405,json:{error:'Read-only test'}});}
  if(url.pathname==='/api/instance/profile')return json(capture.responses.bootstrap.data.instance);
  if(url.pathname==='/api/instance/sources'&&sourceFailure){sourceFailures+=1;return route.fulfill({status:503,json:{error:'通用来源目录暂时不可用'}});}
  if(url.pathname==='/api/v8/ui/scene-review-context'){const scope={sceneId:url.searchParams.get('sceneId'),revisionId:url.searchParams.get('revisionId')};sceneReads.push(scope);expect(scope).toEqual({sceneId:capture.sceneId,revisionId:capture.revisionId});return json(capture.responses.sceneReviewContext);}
  for(const [name,path] of Object.entries(capture.routes)){if(url.pathname===String(path).split('?')[0])return json(capture.responses[name]);}
  if(url.pathname==='/api/assistant/v1/conversations')return json({conversations:[],bridge:{online:false},pagination:{}});
  return route.fulfill({status:404,json:{error:'Outside this synthetic fixture'}});
 });
 const model=capture.responses.bootstrap.data.productionModel;expect(model.shots).toEqual([]);expect(model.assetVersions).toEqual([]);expect(model.scopeLocks).toEqual([]);expect(capture.responses.storySources.storySources.transcript.segments).toEqual([]);expect(capture.responses.storySources.storySources.outline.blocks).toEqual([]);
 const exactUrl='/?view=story&storyMode=audit&episodePlanRevision='+capture.revisionId+'&scene='+capture.sceneId;
 const assertExactReading=async()=>{
  const desk=page.locator('.episode-plan-workbench'),reader=desk.getByRole('region',{name:'本场正文与估时依据',exact:true});
  await expect(reader).toHaveAttribute('data-scene-id',capture.sceneId);await expect(reader).toHaveAttribute('data-scene-content-hash',document.contentHash);await expect(reader.getByRole('heading',{name:'本场完整正文',exact:true})).toBeVisible();
  const body=reader.locator('.narrative-script-body');await expect(body).toHaveAttribute('id','scene-body-'+capture.sceneId);await expect(body.locator('[data-block-id]')).toHaveCount(document.scriptBlocks.length);
  for(const block of document.scriptBlocks){const rendered=body.locator('[data-block-id="'+block.id+'"]');await expect(rendered).toHaveAttribute('id',block.id);await expect(rendered).toHaveText(block.text);}
  await expect(reader.locator('.episode-scene-rationale')).toContainText('UNKNOWN');
  expect(await desk.locator('.episode-review-criteria [data-criterion-id]').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('data-criterion-id')))).toEqual(['opening-boundary','episode-purpose','escalation-turn','information-causality','episode-payoff','ending-propulsion']);
  await expect(desk.locator('.episode-review-criteria').getByRole('radiogroup')).toHaveCount(6);await expect(desk.locator('.episode-review-navigator button[data-episode-uid="'+episode.episodeUid+'"]')).toHaveAttribute('aria-pressed','true');
  const url=new URL(page.url());expect(url.searchParams.get('storyMode')).toBe('logic');expect(url.searchParams.get('episodePlanRevision')).toBe(capture.revisionId);expect(url.searchParams.get('episode')).toBe(episode.episodeUid);expect(url.searchParams.get('scene')).toBe(capture.sceneId);
  await expect(page.locator('.adaptation-formal-review,.scene-narrative-review')).toHaveCount(0);await expect(page.getByRole('radiogroup',{name:'分集意图与本场落实',exact:true})).toHaveCount(0);await expect(page.getByText('这一正文哈希已经完成正式裁决',{exact:true})).toHaveCount(0);await expect(page.getByText('8小时09分',{exact:false})).toHaveCount(0);await expect(page.locator('.transcript-segments,.source-evidence-tree,.source-audio-panel')).toHaveCount(0);
 };
 await page.goto(exactUrl);await assertExactReading();
 sourceFailure=true;await page.goto('/?view=story&storyMode=source');await expect(page.getByText('通用来源目录暂时不可用',{exact:false})).toBeVisible();expect(sourceFailures).toBeGreaterThan(0);
 await page.goto(exactUrl);await assertExactReading();await page.reload();await assertExactReading();expect(sceneReads.length).toBeGreaterThanOrEqual(3);expect(writes).toEqual([]);expect(errors).toEqual([]);
});

test('system owns rules only and importing returns to the same source directory and exact document',async({page})=>{
 const f=await fixture(page);await page.goto('/');await expect(page.getByRole('heading',{name:'系统管理',exact:true})).toBeVisible();await expect(page.getByLabel('来源正文',{exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'确认初始化',exact:true})).toHaveCount(0);
 await page.getByRole('navigation',{name:'主导航',exact:true}).getByRole('button',{name:'故事创作',exact:true}).click();await page.getByRole('button',{name:'＋ 补充来源',exact:true}).click();await page.getByLabel('资料名称',{exact:true}).fill('本故事原文');await page.getByLabel('来源正文',{exact:true}).fill('这是明确导入的来源。');await page.getByRole('button',{name:'登记这份资料',exact:true}).click();
 const entry=page.getByRole('navigation',{name:'实例来源目录',exact:true}).getByRole('button',{name:/本故事原文/});await expect(entry).toBeVisible();await expect(entry).toHaveAttribute('aria-pressed','true');await expect(page.locator('.empty-source-text')).toHaveText('这是明确导入的来源。');await expect(page.getByLabel('来源正文',{exact:true})).toHaveCount(0);
 expect(f.mutations).toHaveLength(1);expect(f.mutations[0]).toMatchObject({title:'本故事原文',role:'PRIMARY',text:'这是明确导入的来源。',expectedReleaseId:'fixture-release'});expect(f.unexpected).toEqual([]);
});

test('source API readOnly hides importing while keeping the registered source readable',async({page})=>{
 const f=await fixture(page,{sourceReadOnly:true});f.seedPublished();await page.goto('/?view=story&storyMode=source');
 const tree=page.getByRole('navigation',{name:'实例来源目录',exact:true});await tree.getByRole('button',{name:/已确认原文/}).click();await expect(page.getByRole('heading',{name:'已确认原文',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'＋ 补充来源',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'登记这份资料',exact:true})).toHaveCount(0);await expect(page.getByLabel('来源正文',{exact:true})).toHaveCount(0);expect(f.mutations).toEqual([]);expect(f.unexpected).toEqual([]);
});

test('an unsaved source import can decline returning to reading or switching modules',async({page})=>{
 const f=await fixture(page);await page.goto('/?view=story&storyMode=source');await page.getByRole('button',{name:'＋ 补充来源',exact:true}).click();const body=page.getByRole('textbox',{name:'来源正文',exact:true});await page.getByLabel('资料名称',{exact:true}).fill('未提交来源');await body.fill('尚未提交的原文。');
 let dialogs=0;page.on('dialog',async d=>{dialogs+=1;await d.dismiss();});await page.getByRole('button',{name:'返回阅读',exact:true}).click();await expect.poll(()=>dialogs).toBe(1);await expect(page.getByLabel('资料名称',{exact:true})).toHaveValue('未提交来源');await expect(body).toHaveValue('尚未提交的原文。');
 await page.getByRole('navigation',{name:'主导航',exact:true}).getByRole('button',{name:'系统管理',exact:true}).click();await expect.poll(()=>dialogs).toBe(2);await expect(page).toHaveURL(/view=story/);await expect(body).toHaveValue('尚未提交的原文。');expect(f.mutations).toEqual([]);expect(f.unexpected).toEqual([]);
});
