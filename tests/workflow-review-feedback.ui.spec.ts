import {test,expect,type Page} from '@playwright/test';
import {blankProfile,blankSnapshot} from '../host/instance-runtime/blank.mjs';
import {defaultConfiguration} from '../host/instance-runtime/configuration-model.mjs';
import {workflowOverview} from '../host/instance-runtime/workflow-overview.mjs';
import {CREATOR_PRODUCTION_STAGES} from '../host/instance-runtime/creator-production-workflow.mjs';

test('三个制作模块以同一真实主页面上下文留存视觉验收图',async({page},testInfo)=>{
 const f=await fixture(page);
 await page.setViewportSize({width:1440,height:1000});
 await page.goto('/?view=pipeline&creatorStage=shot-breakdown&preparationEpisode=episode-alpha&preparationScene=scene-alpha');
 for(const [index,stage] of CREATOR_PRODUCTION_STAGES.entries()){
  await page.locator('[data-creator-stage="'+stage.id+'"]').click();
  await expect(page.locator('[data-creator-stage="'+stage.id+'"]')).toHaveAttribute('aria-pressed','true');
  await expect(page.locator('[data-preparation-episode="episode-alpha"]')).toHaveAttribute('aria-pressed','true');
  if(stage.scope==='SCENE'){
   await expect(page.locator('[data-preparation-scene="scene-alpha"]')).toHaveAttribute('aria-current','location');
   expect(new URL(page.url()).searchParams.get('preparationScene')).toBe('scene-alpha');
  }else{
   await expect(page.getByRole('navigation',{name:'制作上下文场次'})).toHaveCount(0);
   expect(new URL(page.url()).searchParams.has('preparationScene')).toBe(false);
   expect(new URL(page.url()).searchParams.has('scene')).toBe(false);
  }
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.evaluate(()=>window.scrollTo(0,0));
  const image=testInfo.outputPath('production-stage-'+String(index+1).padStart(2,'0')+'-'+stage.id.toLowerCase()+'.png');
  await page.screenshot({path:image,fullPage:true,animations:'disabled'});
  await testInfo.attach(stage.label,{path:image,contentType:'image/png'});
 }
 expect(f.writes).toEqual([]);expect(f.unexpected).toEqual([]);expect(f.errors).toEqual([]);
});

async function fixture(page:Page,{readonly=false,conflict=false}={}){
 const profile=blankProfile({title:'流程回归实例',instanceId:'workflow-fixture',projectId:'workflow-story'}),snapshot=blankSnapshot(profile).snapshot,configuration=defaultConfiguration(profile);
 const episodes=[{episodeUid:'episode-alpha',displayId:'E01',title:'前半',sceneIds:['scene-alpha']},{episodeUid:'episode-beta',displayId:'E02',title:'后半',sceneIds:['scene-beta']}];
 const scenes=[{sceneId:'scene-alpha',displayId:'S01',episodeUid:'episode-alpha',sceneContentHash:'a'.repeat(64),sourceSummary:{title:'门外等待'},preparation:{sceneRole:'先让观众知道访客仍在门外',audienceTakeaway:'双方尚未见面',beats:[{visualIntent:'门内外分置，保持门扇方向'}],entityStateRequirements:[{entityName:'访客',state:'门外等待',canonicalEntityId:null,stateId:null,bindingStatus:'UNBOUND_PROPOSAL'}],materialGaps:['门外等待状态图尚未定义'],nextPreparationAction:'先核对门向，再补状态要求',reviewFocus:['不要提前显示门内人物'],generationAuthorized:false,formalShotIds:[]}},{sceneId:'scene-beta',displayId:'S01',episodeUid:'episode-beta',sceneContentHash:'b'.repeat(64),sourceSummary:{title:'开门相见'},preparation:{sceneRole:'让观众看到两人第一次见面',audienceTakeaway:'陌生关系开始变化',beats:[{visualIntent:'人物让出门口，保留视线衔接'}],materialGaps:['开门状态与人物相对位置'],nextPreparationAction:'核对初次见面的观察视点',reviewFocus:['不能把两人的距离当作已锁坐标'],generationAuthorized:false,formalShotIds:[]}}];
 const prep={releaseId:'release-fixture',revisionId:'prep-fixture',stale:false,readOnly:readonly,comments:[],content:{basis:{candidateRevisionId:'candidate-fixture',candidateContentHash:'c'.repeat(64)},episodes,scenes},candidate:{revisionId:'candidate-fixture',contentHash:'c'.repeat(64),episodes,scenes:scenes.map(s=>({id:s.sceneId,displayId:s.displayId,title:s.sourceSummary.title}))}};
 const counts={total:1,ready:1,inProgress:0,waiting:0,blocked:0,humanCanAdvance:1,aiCanAdvance:0,humanAndAi:0,aiCanAssist:0,automation:0};
 const action={actionKey:'action-fixture',subjectId:'plan-fixture',workUnitKey:'plan-fixture',sourceActionKeys:['action-fixture'],workState:'READY',workType:'AUTHORING',workstream:'EPISODE_PLANNING',ownerModule:'STORY_CREATION',productionPhaseId:null,title:'核对当前分集任务',reasonText:'候选分集说明已经整理',nextActionText:'阅读第一集的任务与结尾',unlockText:'形成清晰的分集准备说明',impactSummary:{label:'保持候选，不自动采用'},progressCapabilities:[{actorGroup:'HUMAN',actorKind:'USER',level:'ADVANCE',availability:'NOW',actionType:'AUTHORING'}],navigationIntent:{href:'/?view=story&storyMode=logic',label:'阅读候选'}};
 const domains=[{id:'STORY_CREATION',label:'故事 → 剧本',status:'ACTIVE',currentGate:'全剧分集方案',headline:'当前分集准备说明待核对',nextUnlockText:'再核对逐场正文',navigationIntent:{href:'/?view=story&storyMode=logic',label:'进入故事创作'},counts,metrics:[],stages:[{id:'EPISODE_PLAN',label:'全剧分集方案',status:'ACTIVE',count:0,denominator:1,denominatorState:'KNOWN'},{id:'STORY_CONFIRMATION',label:'逐场正文',status:'WAITING',count:0,denominator:null,denominatorState:'UNKNOWN'}]},{id:'WORLD_AND_MATERIALS',label:'剧本 → 素材',status:'UNKNOWN',currentGate:'等待素材定义',headline:'当前素材尚未登记',nextUnlockText:'明确实体和状态',navigationIntent:{href:'/?view=materials',label:'进入素材管理'},counts:{...counts,total:0,ready:0,humanCanAdvance:0},metrics:[],stages:[{id:'INITIAL',label:'已定义',status:'UNKNOWN',count:0,denominator:null,denominatorState:'UNKNOWN'}]},{id:'FULL_PRODUCTION',label:'剧本 + 素材 → 全剧制作',status:'UNKNOWN',currentGate:'正式范围未锁定',headline:'候选准备不建立正式镜头分母',nextUnlockText:'先核对准备稿',navigationIntent:{href:'/?view=pipeline',label:'进入全剧制作'},counts:{...counts,total:0,ready:0,humanCanAdvance:0},metrics:[],stages:CREATOR_PRODUCTION_STAGES.map(p=>({id:p.id,label:p.label,status:'UNKNOWN',count:0,denominator:null,denominatorState:'UNKNOWN'}))}];
 const state={readOnly:readonly,headline:'当前分集准备说明待核对',writes:[] as Record<string,unknown>[],unexpected:[] as string[],errors:[] as string[]};page.on('pageerror',e=>state.errors.push(e.message));
 await page.route('**/api/**',async route=>{const request=route.request(),url=new URL(request.url()),json=(value:unknown)=>route.fulfill({json:value});
  if(url.pathname==='/api/instance/profile')return json(profile);
  if(url.pathname==='/api/v8/ui/bootstrap')return json({data:snapshot,snapshotId:snapshot.snapshotId});
  if(url.pathname==='/api/instance/workflow'){const queue={snapshotId:snapshot.snapshotId,operationRevision:state.headline,items:[action],workUnits:[action],summary:{inventory:{materialRequirements:0,covered:0,uncovered:0}},workspaceSummary:{counts,domains:domains.map(d=>d.id==='STORY_CREATION'?{...d,headline:state.headline}:d),criticalBlockers:[]},recommendations:{mainline:action}};const workflow=workflowOverview({...snapshot.productionModel,systemConfiguration:{config:configuration}},prep,{queue,snapshotId:snapshot.snapshotId});return json(url.searchParams.get('workspace')==='1'?{queue,workflow}:workflow);}
  if(url.pathname==='/api/v8/action-queue')return json({snapshotId:snapshot.snapshotId,operationRevision:state.headline,items:[action],workUnits:[action],summary:{inventory:{materialRequirements:0,covered:0,uncovered:0}},workspaceSummary:{counts,domains:domains.map(d=>d.id==='STORY_CREATION'?{...d,headline:state.headline}:d),criticalBlockers:[]},recommendations:{mainline:action}});
  if(url.pathname==='/api/instance/production-preparation'){if(request.method()==='GET')return json(prep);state.writes.push(request.postDataJSON());return route.fulfill({status:readonly?405:conflict?409:200,json:readonly?{error:'只读'}:conflict?{error:'CAS_CONFLICT：准备稿基线已变化'}:{saved:true}});}
  if(url.pathname==='/api/instance/sources')return json({releaseId:'release-fixture',sources:[],readOnly:readonly});
  if(url.pathname==='/api/instance/configuration')return json({configuration,defaults:configuration,releaseId:'release-fixture',revisionId:'config-fixture',sha256:'d'.repeat(64),history:[],bindings:[],boundStandards:[],reviewCatalog:{},initialized:true,draft:null});
  if(url.pathname==='/api/v8/operations/snapshot')return json({mutationEtag:'"workflow-fixture"'});
  if(url.pathname==='/api/assistant/v1/conversations')return json({conversations:[],bridge:{online:false},pagination:{}});
  if(url.pathname==='/api/assistant/v1/context')return json({context:{focus:request.postDataJSON().focus,resources:[],missing:[],draftTargets:[]}});
  state.unexpected.push(request.method()+' '+url.pathname);return route.fulfill({status:418,json:{error:'UNEXPECTED_FIXTURE_API'}});
 });return Object.assign(state,{prep,configuration});
}

test('流程配置按三个模块与阶段内检查组织，导出检查保留全剧范围',async({page})=>{
 const f=await fixture(page),original=JSON.stringify(f.configuration);
 await page.goto('/?view=system&systemTab=configuration');
 await page.getByRole('navigation',{name:'系统配置分组'}).getByRole('button',{name:'素材与制作',exact:true}).click();
 await page.getByRole('navigation',{name:'素材与制作'}).getByRole('button',{name:'制作流程',exact:true}).click();
 const nav=page.getByRole('navigation',{name:'流程配置制作模块'});
 await expect(nav.getByRole('button')).toHaveCount(3);
 await nav.getByRole('button',{name:'01 镜头制作',exact:true}).click();
 await expect(page.getByRole('combobox',{name:'本阶段检查项',exact:true})).toHaveValue('SHOT_PLAN_INPUT_LOCK');
 await expect(page.getByRole('combobox',{name:'本阶段检查项',exact:true}).locator('option')).toHaveCount(6);
 expect(await page.getByRole('combobox',{name:'本阶段检查项',exact:true}).locator('option').evaluateAll(options=>options.map(option=>(option as HTMLOptionElement).value))).toEqual(['SHOT_PLAN_INPUT_LOCK','STORYBOARD_DIALOGUE','ANIMATIC_LOCK','KEYFRAMES','SHOT_VIDEO','SHOT_LOCK']);
 await page.getByRole('combobox',{name:'本阶段检查项',exact:true}).selectOption('STORYBOARD_DIALOGUE');
 await expect(page.getByRole('combobox',{name:'本阶段检查项',exact:true})).toHaveValue('STORYBOARD_DIALOGUE');
 await expect(page.getByText(/检查对象：单个镜头/)).toBeVisible();
 await nav.getByRole('button',{name:'03 分集成片',exact:true}).click();
 await expect(page.getByRole('combobox',{name:'本阶段检查项',exact:true}).locator('option')).toHaveCount(6);
 await expect(page.getByRole('combobox',{name:'本阶段检查项',exact:true}).locator('optgroup[label="导出时核对"]')).toHaveCount(1);
 await page.getByRole('combobox',{name:'本阶段检查项',exact:true}).selectOption('RIGHTS_SAFETY_TECH');
 await expect(page.getByText(/导出检查覆盖全剧，不因选择某集而缩小范围/)).toBeVisible();
 expect(f.configuration.workflow.phases).toHaveLength(5);expect(f.configuration.workflow.gates).toHaveLength(15);
 expect(JSON.stringify(f.configuration)).toBe(original);expect(f.writes).toEqual([]);expect(f.errors).toEqual([]);
});
test('三个模块配置只编辑选中的原检查记录，保存仍携带精确CAS并保留冲突草稿',async({page})=>{
 const f=await fixture(page),requests:Array<{body:Record<string,unknown>;etag:string|undefined}>=[];
 await page.route('**/api/instance/configuration',async route=>{
  if(route.request().method()!=='PUT')return route.fallback();
  requests.push({body:route.request().postDataJSON(),etag:route.request().headers()['if-match']});
  return route.fulfill({status:409,json:{error:'CAS_CONFLICT: fixture baseline changed'}});
 });
 await page.goto('/?view=system&systemTab=configuration');
 await page.getByRole('navigation',{name:'系统配置分组'}).getByRole('button',{name:'素材与制作',exact:true}).click();
 await page.getByRole('navigation',{name:'素材与制作'}).getByRole('button',{name:'制作流程',exact:true}).click();
 await page.getByRole('navigation',{name:'流程配置制作模块'}).getByRole('button',{name:'01 镜头制作',exact:true}).click();
 await page.getByRole('combobox',{name:'本阶段检查项',exact:true}).selectOption('STORYBOARD_DIALOGUE');
 await page.getByLabel('检查项名称',{exact:true}).fill('独立检查文案草稿');
 await page.getByRole('button',{name:'保存草稿',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText('CAS_CONFLICT');
 await expect(page.getByLabel('检查项名称',{exact:true})).toHaveValue('独立检查文案草稿');
 expect(requests).toHaveLength(1);expect(requests[0].etag).toBe('"workflow-fixture"');
 expect(requests[0].body).toMatchObject({expectedDraftRevision:null,expectedReleaseId:'release-fixture',expectedConfigurationRevisionId:'config-fixture'});
 const expected=structuredClone(f.configuration);expected.workflow.gates.find(g=>g.id==='STORYBOARD_DIALOGUE')!.label='独立检查文案草稿';
 expect(requests[0].body.configuration).toEqual(expected);
 await page.waitForTimeout(150);expect(requests).toHaveLength(1);expect(f.writes).toEqual([]);expect(f.errors).toEqual([]);
});
test('当前工作整体以三链和所选阶段组织，配置阶段与准备任务不建立正式分母',async({page})=>{
 const f=await fixture(page);await page.goto('/?view=overview');await expect(page.getByRole('region',{name:'流程驱动的当前工作'})).toBeVisible();await expect(page.getByText('核对当前分集任务',{exact:true})).toBeVisible();
 await page.getByRole('navigation',{name:'三条主体工作链'}).getByRole('button',{name:/全剧制作/}).click();await expect(page.locator('.flow-stage-tabs').getByRole('button')).toHaveCount(3);for(const stage of CREATOR_PRODUCTION_STAGES)await expect(page.locator('.flow-stage-tabs').getByRole('button',{name:new RegExp(stage.label)})).toBeVisible();await expect(page.getByText('第1阶段 · 前置筹备',{exact:true})).toBeVisible();await expect(page.getByText('2 场候选准备内容，独立于正式门禁进度。',{exact:true})).toBeVisible();await expect(page.locator('.workflow-stage-inspector')).toContainText('正式分母未锁定');await expect(page.locator('.current-work-rollup')).toHaveCount(0);expect(f.writes).toEqual([]);expect(f.errors).toEqual([]);expect(f.unexpected).toEqual([]);
});
test('当前工作在共享变更事件后自动更新，不要求重新进入页面',async({page})=>{
 const f=await fixture(page);await page.goto('/?view=overview');const chains=page.getByRole('navigation',{name:'三条主体工作链'});await expect(chains.getByText('当前分集准备说明待核对',{exact:true})).toBeVisible();f.headline='新投影已到达';await page.evaluate(()=>window.dispatchEvent(new Event('review:operations-updated')));await expect(chains.getByText('新投影已到达',{exact:true})).toBeVisible();expect(f.writes).toEqual([]);expect(f.errors).toEqual([]);
});
test('镜头制作在六步骤间保留同一永久集场，重复显示场号不发生错绑',async({page})=>{
 const f=await fixture(page);await page.goto('/?view=pipeline');await page.locator('[data-preparation-episode="episode-beta"]').click();await expect(page.locator('[data-preparation-scene="scene-beta"]')).toHaveAttribute('aria-current','location');await expect(page.getByRole('heading',{name:'开门相见',exact:true})).toBeVisible();await expect(page.getByText('让观众看到两人第一次见面',{exact:true})).toBeVisible();
 await page.locator('[data-production-check="STORYBOARD_DIALOGUE"]').click();await expect(page.locator('[data-preparation-scene="scene-beta"]')).toHaveAttribute('aria-current','location');await expect(page.getByRole('heading',{name:'本上下文尚未建立正式制作对象',exact:true})).toBeVisible();
 await page.locator('[data-production-check="SHOT_PLAN_INPUT_LOCK"]').click();await expect(page.getByText('让观众看到两人第一次见面',{exact:true})).toBeVisible();expect(f.writes).toEqual([]);expect(f.errors).toEqual([]);expect(f.unexpected).toEqual([]);
});
test('准备稿保存仍精确CAS，冲突保留作者文字且不自动重试',async({page})=>{
 const f=await fixture(page,{conflict:true});await page.goto('/?view=pipeline');await page.getByRole('button',{name:'编辑本场准备内容',exact:true}).click();const field=page.getByRole('textbox',{name:'本场作用',exact:true});await field.fill('尚未保存的本场作用');await page.getByRole('button',{name:'保存本场准备稿',exact:true}).click();await expect(page.getByRole('alert')).toContainText('CAS_CONFLICT');await expect(field).toHaveValue('尚未保存的本场作用');expect(f.writes).toHaveLength(1);expect(f.writes[0]).toMatchObject({action:'save',expectedReleaseId:'release-fixture',expectedRevisionId:'prep-fixture'});const body=f.writes[0].content as {scenes:Array<Record<string,unknown>>};expect(body.scenes[0].sceneId).toBe('scene-alpha');expect(body.scenes[0].sceneContentHash).toBe('a'.repeat(64));expect((body.scenes[0].preparation as Record<string,unknown>).generationAuthorized).toBe(false);await page.waitForTimeout(300);expect(f.writes).toHaveLength(1);expect(f.errors).toEqual([]);
});
test('只读准备页不出现保存动作，手机宽度无页面横向溢出',async({page})=>{
 const f=await fixture(page,{readonly:true});await page.setViewportSize({width:390,height:844});await page.goto('/?view=pipeline');await expect(page.getByRole('heading',{name:'门外等待',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'编辑本场准备内容',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'保存准备意见',exact:true})).toHaveCount(0);expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(390);expect(f.writes).toEqual([]);expect(f.errors).toEqual([]);
});

for(const scenario of [
 {name:'无效永久集',query:'preparationEpisode=episode-missing',message:'永久集身份不在当前准备稿中'},
 {name:'集显示号不是永久身份',query:'preparationEpisode=E01',message:'永久集身份不在当前准备稿中'},
 {name:'永久集场互相矛盾',query:'preparationEpisode=episode-alpha&preparationScene=scene-beta',message:'永久集与场身份不匹配'},
 {name:'无效永久场',query:'preparationEpisode=episode-alpha&preparationScene=scene-missing',message:'永久场身份不在当前准备稿中'},
])test('制作准备拒绝错绑：'+scenario.name,async({page})=>{
 const f=await fixture(page);await page.goto('/?view=pipeline&'+scenario.query);
 await expect(page.getByRole('alert')).toContainText(scenario.message);
 await expect(page.getByRole('button',{name:'编辑本场准备内容',exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'保存准备意见',exact:true})).toHaveCount(0);
 await expect(page.getByRole('heading',{name:'门外等待',exact:true})).toHaveCount(0);
 await expect(page.getByRole('heading',{name:'开门相见',exact:true})).toHaveCount(0);
 for(const [key,value] of new URLSearchParams(scenario.query))expect(new URL(page.url()).searchParams.get(key)).toBe(value);
 await page.locator('[data-preparation-episode="episode-beta"]').click();
 await expect(page.getByRole('alert')).toHaveCount(0);await expect(page.getByRole('heading',{name:'开门相见',exact:true})).toBeVisible();
 expect(new URL(page.url()).searchParams.get('preparationEpisode')).toBe('episode-beta');expect(new URL(page.url()).searchParams.get('preparationScene')).toBe('scene-beta');
 expect(f.writes).toEqual([]);expect(f.errors).toEqual([]);expect(f.unexpected).toEqual([]);
});

test('制作准备选集与选场都写永久URL，刷新和历史前后退恢复同一上下文',async({page})=>{
 const f=await fixture(page),extra=structuredClone(f.prep.content.scenes[0]);extra.sceneId='scene-alpha-next';extra.displayId='S02';extra.sourceSummary.title='本集第二场';extra.preparation.sceneRole='本集第二场独有意图';
 f.prep.content.scenes.push(extra);f.prep.content.episodes[0].sceneIds.push(extra.sceneId);f.prep.candidate.scenes.push({id:extra.sceneId,displayId:extra.displayId,title:extra.sourceSummary.title});
 await page.goto('/?view=pipeline&preparationEpisode=episode-alpha&preparationScene=scene-alpha');
 const assertContext=async(episode:string,scene:string,title:string)=>{
  await expect(page.locator('[data-preparation-episode="'+episode+'"]')).toHaveAttribute('aria-pressed','true');await expect(page.locator('[data-preparation-scene="'+scene+'"]')).toHaveAttribute('aria-current','location');
  expect(new URL(page.url()).searchParams.get('preparationEpisode')).toBe(episode);expect(new URL(page.url()).searchParams.get('preparationScene')).toBe(scene);
  await expect(page.getByRole('heading',{name:title,exact:true})).toBeVisible();
 };
 await page.locator('[data-preparation-scene="scene-alpha-next"]').click();await assertContext('episode-alpha','scene-alpha-next','本集第二场');
 await page.locator('[data-preparation-episode="episode-beta"]').click();await assertContext('episode-beta','scene-beta','开门相见');
 await page.reload();await assertContext('episode-beta','scene-beta','开门相见');
 await page.goBack();await assertContext('episode-alpha','scene-alpha-next','本集第二场');await expect(page.getByText('本集第二场独有意图',{exact:true})).toBeVisible();
 await page.goBack();await assertContext('episode-alpha','scene-alpha','门外等待');
 await page.goForward();await assertContext('episode-alpha','scene-alpha-next','本集第二场');
 for(const scene of f.prep.content.scenes){expect(scene.preparation.generationAuthorized).toBe(false);expect(scene.preparation.formalShotIds).toEqual([]);}
 expect(f.writes).toEqual([]);expect(f.errors).toEqual([]);expect(f.unexpected).toEqual([]);
});

test('制作准备历史切换可以取消，作者文字与原永久集场保持一致',async({page})=>{
 const f=await fixture(page);await page.goto('/?view=pipeline&preparationEpisode=episode-alpha&preparationScene=scene-alpha');
 await page.locator('[data-preparation-episode="episode-beta"]').click();
 await page.getByRole('button',{name:'编辑本场准备内容',exact:true}).click();const field=page.getByRole('textbox',{name:'本场作用',exact:true});await field.fill('第二集未保存文字');
 const original=page.url(),declined=page.waitForEvent('dialog');const back=page.goBack();const question=await declined;expect(question.message()).toContain('未保存');await question.dismiss();await back;
 await expect(field).toHaveValue('第二集未保存文字');await expect(page).toHaveURL(original);await expect(page.locator('[data-preparation-scene="scene-beta"]')).toHaveAttribute('aria-current','location');
 const allowed=page.waitForEvent('dialog');const backAgain=page.goBack();await (await allowed).accept();await backAgain;
 await expect(page.getByRole('heading',{name:'门外等待',exact:true})).toBeVisible();await expect(field).toHaveCount(0);expect(new URL(page.url()).searchParams.get('preparationScene')).toBe('scene-alpha');
 expect(f.writes).toEqual([]);expect(f.errors).toEqual([]);expect(f.unexpected).toEqual([]);
});

test('只有永久场深链时按实际归属读集，不借重复显示号换绑',async({page})=>{
 const f=await fixture(page);await page.goto('/?view=pipeline&preparationScene=scene-beta');await expect(page.locator('[data-preparation-episode="episode-beta"]')).toHaveAttribute('aria-pressed','true');await expect(page.getByRole('heading',{name:'开门相见',exact:true})).toBeVisible();await expect(page.getByText('让观众看到两人第一次见面',{exact:true})).toBeVisible();expect(f.writes).toEqual([]);expect(f.errors).toEqual([]);expect(f.unexpected).toEqual([]);
});

test('真实主页面从场拆解转到整集仅一次未保存确认，单条历史返回原永久场',async({page})=>{
 const f=await fixture(page);await page.goto('/?view=pipeline&creatorStage=shot-breakdown&preparationEpisode=episode-beta&preparationScene=scene-beta');
 await page.getByRole('button',{name:'编辑本场准备内容',exact:true}).click();await page.getByRole('textbox',{name:'本场作用',exact:true}).fill('只在第二集场内的未保存意见');
 const before=page.url(),historyLength=await page.evaluate(()=>history.length),questions:string[]=[];page.on('dialog',async dialog=>{questions.push(dialog.message());await dialog.accept();});
 await page.locator('[data-creator-stage="EPISODE_EDIT"]').click();await expect(page.locator('[data-creator-stage="EPISODE_EDIT"]')).toHaveAttribute('aria-pressed','true');await expect(page.getByRole('navigation',{name:'制作上下文场次'})).toHaveCount(0);
 expect(questions).toHaveLength(1);expect(questions[0]).toContain('未保存');expect(new URL(page.url()).searchParams.get('preparationEpisode')).toBe('episode-beta');expect(new URL(page.url()).searchParams.has('preparationScene')).toBe(false);expect(new URL(page.url()).searchParams.has('scene')).toBe(false);expect(await page.evaluate(()=>history.length)).toBe(historyLength+1);
 await page.goBack();await expect(page).toHaveURL(before);await expect(page.locator('[data-preparation-scene="scene-beta"]')).toHaveAttribute('aria-current','location');await expect(page.getByText('让观众看到两人第一次见面',{exact:true})).toBeVisible();expect(questions).toHaveLength(1);
 expect(f.writes).toEqual([]);expect(f.unexpected).toEqual([]);expect(f.errors).toEqual([]);
});
