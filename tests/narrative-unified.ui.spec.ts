import {test,expect,type Page,type Locator} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {blankSnapshot} from '../host/instance-runtime/blank.mjs';
import {stableObjectHash} from '../app/api/v8/_store';
import {storyCommentSources,type StoryCommentTarget} from '../app/story-comment-model';

const base=JSON.parse(readFileSync(new URL('./fixtures/generic-adopted-scene.json',import.meta.url),'utf8'));
async function fixture(page:Page,{candidate=false,crossEpisode=false,withComments=false,sameEpisodeScenes=false,readingScrollStress=false}={}){
 const capture=structuredClone(base),plan=capture.responses.episodePlan.plan,event=capture.responses.operations.creativeRevisions.events.find((item:{creativeRevisionId:string})=>item.creativeRevisionId===plan.revisionId);

 const sceneContexts:Record<string,typeof capture.responses.sceneReviewContext.context>={};
 if(crossEpisode||sameEpisodeScenes){
  // Synthetic second episode is derived from the checked-in generic fixture.
  // Hashes are computed from these exact payloads; no published identity is remapped.
  const firstDocument=capture.responses.sceneReviewContext.context.sceneDocument,secondId='author-unified-second-permanent',secondUid='episode-unified-second-permanent';
  const runtime={compactSec:20,baseSec:30,spaciousSec:40,dialogueChars:0,dialogueSec:0,actionSec:20,reactionSec:8,transitionSec:2,overlapSec:0,rationale:'隔离回归的动作与转场估时，未锁时',confidence:'中'};
  const scene=(document:typeof firstDocument)=>({...document,slugline:'内景 客栈 日',oldSceneIds:[],sourceSegmentIds:[],storyTime:'白天',viewpoint:'甲',purpose:document.title,audienceKnown:'先见到来信',audienceWithheld:'来信人的身份',transition:'保留因果顺序',runtime:{...runtime}});
  const secondDocument={...structuredClone(firstDocument),id:secondId,title:'回收场',scriptBlocks:[{...firstDocument.scriptBlocks[0],id:secondId+'-B001',text:'第二集精确回收场正文：人物此时才读到落款。'}]};secondDocument.contentHash=stableObjectHash(secondDocument.scriptBlocks);
  const secondEpisode=structuredClone(plan.content.episodes[0]);secondEpisode.episodeUid=secondUid;secondEpisode.displayId='E02';secondEpisode.title='回收集';secondEpisode.sceneIds=[secondId];
  const rewriteIdentity=(value:unknown):unknown=>typeof value==='string'?value===firstDocument.id?secondId:value===firstDocument.scriptBlocks[0].id?secondDocument.scriptBlocks[0].id:value===firstDocument.contentHash?secondDocument.contentHash:value:Array.isArray(value)?value.map(rewriteIdentity):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,rewriteIdentity(item)])):value;
  secondEpisode.reviewDossier=rewriteIdentity(secondEpisode.reviewDossier);
  const chain={id:'unified-cross-episode-chain',title:'落款的先后因果',setupSceneIds:[firstDocument.id],payoffSceneIds:[secondId],status:'PENDING_PAYOFF',mustPreserve:'第一集不能提前透露第二集才读到的落款。'};
  plan.content.episodes.push(secondEpisode);for(const episode of plan.content.episodes)episode.reviewDossier.causalChainIds=[chain.id];
  plan.content.narrativeRevision={schemaVersion:'1.0',title:'两集永久身份回归候选',baseScriptSha256:capture.responses.bootstrap.data.creativeLineage.scriptDocument.sha256,transcriptSha256:'f'.repeat(64),runtimeMethod:'隔离回归估时，未锁时',retiredSceneIds:[],scenes:[scene(firstDocument),scene(secondDocument)],sequences:[],causalChains:[chain],legacySceneEstimates:[],sourceNarrationIndex:[],documents:[]};
  plan.revisionId='cr-unified-cross-episode-fixture';plan.contentHash=stableObjectHash(plan.content);plan.contextHash=stableObjectHash({scope:'unified-cross-episode-fixture',contentHash:plan.contentHash});
  plan.presentation[secondUid]={opening:{sceneId:secondId,blocks:secondDocument.scriptBlocks},ending:{sceneId:secondId,blocks:secondDocument.scriptBlocks}};
  Object.assign(event,{creativeRevisionId:plan.revisionId,revisionId:plan.revisionId,content:plan.content,contentHash:plan.contentHash,contextHash:plan.contextHash});
  for(const document of [firstDocument,secondDocument]){const episode=plan.content.episodes.find((item:{sceneIds:string[]})=>item.sceneIds.includes(document.id));sceneContexts[document.id]={...structuredClone(capture.responses.sceneReviewContext.context),revisionId:plan.revisionId,planContentHash:plan.contentHash,sceneId:document.id,sceneContentHash:document.contentHash,episodeUid:episode.episodeUid,episode:{displayId:episode.displayId,title:episode.title,scenePosition:1,sceneCount:1},sceneDocument:document,sceneLabels:{[firstDocument.id]:'S01 第一场',[secondId]:'S01 回收场'},requirements:[],chains:[],neighbours:[],formalTarget:null,upstreamState:'PENDING_REVIEW',formalBlockReason:'当前候选未正式采用，本场确认保持关闭。'};}
 }
 if(sameEpisodeScenes){
  const first=plan.content.episodes[0],original=plan.content.narrativeRevision.scenes[0],id='author-unified-same-episode-second';
  const second={...structuredClone(original),id,displayId:'S02',title:'同集后续场',scriptBlocks:[{...original.scriptBlocks[0],id:id+'-B001',text:'本集第二场精确正文：人物合上信封后离开。'}],runtime:{...original.runtime,baseSec:70,compactSec:55,spaciousSec:85,rationale:'本集第二场动作与离场估时，不借用首场依据'}};
  second.contentHash=stableObjectHash(second.scriptBlocks);plan.content.narrativeRevision.scenes.push(second);first.sceneIds.push(id);
  first.reviewDossier.sceneFlow.push({sceneId:id,function:{class:'A',text:'同集选场独立阅读回归',evidenceRefs:[]}});
  plan.presentation[first.episodeUid].ending={sceneId:id,blocks:second.scriptBlocks};
  plan.contentHash=stableObjectHash(plan.content);plan.contextHash=stableObjectHash({scope:'same-episode-reading-fixture',contentHash:plan.contentHash});Object.assign(event,{content:plan.content,contentHash:plan.contentHash,contextHash:plan.contextHash});
  for(const context of Object.values(sceneContexts))context.planContentHash=plan.contentHash;
 }
 if(readingScrollStress){
  const episode=plan.content.episodes[0],scenes=plan.content.narrativeRevision.scenes,first=scenes.find((scene:{id:string})=>scene.id===episode.sceneIds[0]),short=scenes.find((scene:{id:string})=>scene.id===episode.sceneIds[1]);
  first.scriptBlocks=Array.from({length:36},(_,index)=>({...first.scriptBlocks[0],id:first.id+'-scroll-'+index,text:'长场正文第'+(index+1)+'段：人物依次核对每封来信的落款、时间与送信人。这是隔离滚动回归正文，不是当前正式故事来源。'}));first.contentHash=stableObjectHash(first.scriptBlocks);
  for(let index=0;index<22;index++){const id='author-scroll-directory-'+index,scene={...structuredClone(short),id,displayId:'T'+(index+3),title:'目录滚动回归场 '+(index+3),scriptBlocks:[{...short.scriptBlocks[0],id:id+'-B001',text:'目录回归短场 '+(index+3)}]};scene.contentHash=stableObjectHash(scene.scriptBlocks);scenes.push(scene);episode.sceneIds.push(id);episode.reviewDossier.sceneFlow.push({sceneId:id,function:{class:'A',text:'独立滚动夹具场次',evidenceRefs:[]}});}
  plan.presentation[episode.episodeUid].opening={sceneId:first.id,blocks:first.scriptBlocks};
  const last=scenes.find((scene:{id:string})=>scene.id===episode.sceneIds.at(-1));plan.presentation[episode.episodeUid].ending={sceneId:last.id,blocks:last.scriptBlocks};
  plan.contentHash=stableObjectHash(plan.content);plan.contextHash=stableObjectHash({scope:'reading-scroll-fixture',contentHash:plan.contentHash});Object.assign(event,{content:plan.content,contentHash:plan.contentHash,contextHash:plan.contextHash});
  for(const scene of scenes){const owner=plan.content.episodes.find((item:{sceneIds:string[]})=>item.sceneIds.includes(scene.id));sceneContexts[scene.id]={...structuredClone(capture.responses.sceneReviewContext.context),revisionId:plan.revisionId,planContentHash:plan.contentHash,sceneId:scene.id,sceneContentHash:scene.contentHash,episodeUid:owner.episodeUid,episode:{displayId:owner.displayId,title:owner.title,scenePosition:owner.sceneIds.indexOf(scene.id)+1,sceneCount:owner.sceneIds.length},sceneDocument:structuredClone(scene),requirements:[],chains:[],neighbours:[],formalTarget:null,upstreamState:'PENDING_REVIEW',formalBlockReason:'隔离候选尚未采用；滚动检查不创建审阅结论。'};}
 }
 if(candidate){plan.sourceRole='CANDIDATE';plan.contextHash=event.contextHash;plan.basisBindingsHash=event.basisBindingsHash;const context=capture.responses.sceneReviewContext.context;context.upstreamState='PENDING_REVIEW';context.formalTarget=null;context.formalBlockReason='待当前候选整套方案审阅并受控同步后，才能正式确认本场。';}

 const commentTargets:StoryCommentTarget[]=withComments?storyCommentSources(plan).map(source=>{
  const scene=plan.content.narrativeRevision?.scenes.find((item:{id:string})=>item.id===source.subjectId);
  const contentHash=source.kind==='SCENE_SCRIPT'?scene.contentHash:stableObjectHash(source.blocks);
  const contextHash=stableObjectHash({snapshotId:plan.snapshotId,planContextHash:plan.contextHash,basisBindingsHash:plan.basisBindingsHash,revisionId:plan.revisionId,planContentHash:plan.contentHash,kind:source.kind,subjectId:source.subjectId,episodeUid:source.episodeUid,contentHash});
  return {...source,revisionId:plan.revisionId,planContentHash:plan.contentHash,contentHash,contextHash};
 }):[];
 const threadTarget=commentTargets.find(target=>target.kind==='SCENE_SCRIPT'&&target.subjectId===capture.sceneId);
 const commentThreads=threadTarget?[{commentId:'fixture-narrative-thread',commentRevisionId:'fixture-comment-rev',latestEventId:'fixture-comment-event',target:threadTarget,anchor:{blockId:threadTarget.blocks[0].id,startOffset:0,endOffset:threadTarget.blocks[0].text.length,quote:threadTarget.blocks[0].text},commentText:'同一永久正文的既有评论',status:'OPEN',updatedAt:'2026-09-07T00:00:00Z',anchorMatchesCurrentText:true,applicabilityState:'CURRENT'}]:[];
 const snapshot=capture.responses.bootstrap.data,configuration=snapshot.productionModel.systemConfiguration,ref=capture.responses.runtime.configurationRef;
 const errors:string[]=[],writes:string[]=[],unexpected:string[]=[],commentReads:Array<{sceneId:string|null;episodeUid:string|null;revisionId:string|null}>=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/api/**',async route=>{
  const request=route.request(),url=new URL(request.url()),json=(value:unknown)=>route.fulfill({json:value});
  if(url.pathname==='/api/assistant/v1/context'&&request.method()==='POST')return json({context:{focus:request.postDataJSON().focus,resources:[],missing:[],draftTargets:[]}});
  if(request.method()!=='GET'){writes.push(request.method()+' '+url.pathname);return route.fulfill({status:405,json:{error:'No business mutations in unified review fixture'}});}
  if(url.pathname==='/api/instance/profile')return json(snapshot.instance);
  if(url.pathname==='/api/instance/configuration')return json({configuration:configuration.config,defaults:configuration.defaults,releaseId:capture.responses.runtime.releaseId,revisionId:ref.revisionId,sha256:ref.sha256,history:[],bindings:[],boundStandards:[],reviewCatalog:{},initialized:true,draft:null});
  if(url.pathname==='/api/v8/snapshot')return json({snapshotId:plan.snapshotId,executionRecipes:{...blankSnapshot(snapshot.instance).recipes,snapshotId:plan.snapshotId}});
  if(url.pathname==='/api/v8/script-comments'){
   const sceneId=url.searchParams.get('sceneId'),episodeUid=url.searchParams.get('episodeUid');commentReads.push({revisionId:url.searchParams.get('revisionId'),sceneId,episodeUid});
   const episodeIndex=plan.content.episodes.findIndex((episode:{episodeUid:string;sceneIds:string[]})=>sceneId?episode.sceneIds.includes(sceneId):episode.episodeUid===episodeUid);
   const neighbours=plan.content.episodes.slice(Math.max(0,episodeIndex-1),episodeIndex+2).map((episode:{episodeUid:string})=>episode.episodeUid);
   const targets=commentTargets.filter(target=>sceneId?target.kind==='SCENE_SCRIPT'?target.subjectId===sceneId:target.episodeUid===plan.content.episodes[episodeIndex]?.episodeUid:neighbours.includes(target.episodeUid));
   return json({snapshotId:plan.snapshotId,revisionId:plan.revisionId,planContentHash:plan.contentHash,targets,threads:commentThreads.filter(thread=>targets.some(target=>target.kind===thread.target.kind&&target.subjectId===thread.target.subjectId)),closedHistory:[]});
  }
  if(crossEpisode&&url.pathname==='/api/v8/ui/scene-review-context'){const context=sceneContexts[url.searchParams.get('sceneId')||''];if(!context||url.searchParams.get('revisionId')!==plan.revisionId)return route.fulfill({status:404,json:{error:'Exact scene context missing'}});return json({context});}
  if(url.pathname==='/api/instance/documents')return json({documents:[]});
  if(url.pathname==='/api/assistant/v1/conversations')return json({conversations:[],bridge:{online:false},pagination:{}});
  if(url.pathname==='/api/v8/creative-revisions')return json({events:[event]});
  if(['/api/v8/reviews','/api/v8/episode-plan-reviews','/api/v8/source-operations'].includes(url.pathname))return json({events:[],heads:[],latestHeads:[],operations:[]});
  for(const[key,path]of Object.entries(capture.routes))if(url.pathname===String(path).split('?')[0])return json(capture.responses[key]);
  unexpected.push(request.method()+' '+url.pathname);return route.fulfill({status:418,json:{error:'Unexpected unified review fixture request'}});
 });
 return {capture,plan,errors,writes,unexpected,commentReads};
}
function clean(f:Awaited<ReturnType<typeof fixture>>){expect(f.writes).toEqual([]);expect(f.unexpected).toEqual([]);expect(f.errors).toEqual([]);}
const workbench=(page:Page)=>page.locator('.episode-plan-workbench');
test('本集可通过仅快捷补全当前六项空判断，保留问题和备注且不提交',async({page})=>{
 const f=await fixture(page,{candidate:true,crossEpisode:true}),first=f.plan.content.episodes[0],second=f.plan.content.episodes[1];
 await page.goto('/?view=story&storyMode=logic&episodePlanRevision='+encodeURIComponent(f.plan.revisionId)+'&episode='+encodeURIComponent(first.episodeUid));
 const desk=workbench(page),criteria=desk.locator('.episode-review-criteria [data-criterion-id]'),nav=desk.locator('.episode-review-navigator');
 await expect(criteria).toHaveCount(6);
 await criteria.nth(0).getByRole('radio',{name:'有问题',exact:true}).click();await criteria.nth(0).getByRole('textbox').fill('必须保留的失败依据');
 await criteria.nth(1).getByRole('textbox').fill('未选结论时写下的备注');
 await desk.getByRole('radio',{name:'本集可通过',exact:false}).click();
 await expect(criteria.nth(0).getByRole('radio',{name:'有问题',exact:true})).toBeChecked();
 for(let i=1;i<6;i++)await expect(criteria.nth(i).getByRole('radio',{name:'通过',exact:true})).toBeChecked();
 await expect(criteria.nth(0).getByRole('textbox')).toHaveValue('必须保留的失败依据');await expect(criteria.nth(1).getByRole('textbox')).toHaveValue('未选结论时写下的备注');
 await expect(desk.getByRole('button',{name:/提交.*可通过结论/})).toBeDisabled();
 await nav.locator('[data-episode-uid="'+second.episodeUid+'"]').click();await expect(criteria.locator('[role="radio"][aria-checked="true"]')).toHaveCount(0);
 await nav.locator('[data-episode-uid="'+first.episodeUid+'"]').click();await expect(criteria.locator('[role="radio"][aria-checked="true"]')).toHaveCount(6);
 await page.reload();await expect(criteria.locator('[role="radio"][aria-checked="true"]')).toHaveCount(6);clean(f);
});
async function readingClickPoint(button:Locator){
 await button.evaluate(element=>element.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'}));
 const point=await button.evaluate(element=>{const box=element.getBoundingClientRect(),x=box.x+box.width/2,y=box.y+box.height/2;return {x,y,hit:element.contains(document.elementFromPoint(x,y))};});
 expect(point.hit,'切换前目标必须真实可点击，不能被固定页眉或表头遮挡').toBe(true);return point;
}

test('切集保留上方目录位置，不自动跳到默认判断；永久身份和六项草稿往返不变',async({page},info)=>{
 const f=await fixture(page,{candidate:true,crossEpisode:true,withComments:true}),first=f.plan.content.episodes[0],second=f.plan.content.episodes[1];
 await page.goto('/?view=story&storyMode=logic&episodePlanRevision='+encodeURIComponent(f.plan.revisionId)+'&episode='+encodeURIComponent(first.episodeUid));
 const desk=workbench(page),nav=desk.locator('.episode-review-navigator'),criteria=desk.locator('.episode-review-criteria [data-criterion-id]'),reader=desk.getByRole('region',{name:'本场正文与估时依据',exact:true});
 await expect(criteria).toHaveCount(6);await expect(reader).toHaveAttribute('data-scene-id',first.sceneIds[0]);
 const verdicts=['通过','有问题','通过','有问题','通过','有问题'];
 for(let index=0;index<6;index++){await criteria.nth(index).getByRole('radio',{name:verdicts[index],exact:true}).click();await criteria.nth(index).getByRole('textbox').fill('切集前第'+(index+1)+'项未提交判断');}
 await nav.evaluate(element=>element.scrollIntoView({block:'nearest',behavior:'instant'}));await expect(nav).toBeInViewport({ratio:.9});
 await page.evaluate(()=>{const calls:string[]=[];(window as typeof window&{__episodeLogicScrollCalls:string[]}).__episodeLogicScrollCalls=calls;const original=Element.prototype.scrollIntoView;Element.prototype.scrollIntoView=function(...args){if(this.id.startsWith('logic-'))calls.push(this.id);return original.apply(this,args);};});
 const position=()=>nav.evaluate(element=>({top:element.getBoundingClientRect().top,mainTop:document.querySelector('.workspace-main')?.scrollTop,windowY:window.scrollY,calls:[...(window as typeof window&{__episodeLogicScrollCalls:string[]}).__episodeLogicScrollCalls]}));
 await nav.locator('[data-episode-uid="'+second.episodeUid+'"]').click({trial:true});const before=await position();
 await nav.locator('[data-episode-uid="'+second.episodeUid+'"]').click();await expect(desk.locator('.episode-logic-summary')).toHaveAttribute('data-episode-uid',second.episodeUid);
 const secondScene=f.plan.content.narrativeRevision.scenes.find((scene:{id:string})=>scene.id===second.sceneIds[0]);
 await expect(reader).toHaveAttribute('data-scene-id',secondScene.id);await expect(reader).toHaveAttribute('data-scene-content-hash',secondScene.contentHash);
 await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
 const after=await position();await info.attach('episode-switch-scroll',{body:JSON.stringify({before,after},null,2),contentType:'application/json'});
 expect(after.calls).toEqual([]);expect(Math.abs(after.top-before.top)).toBeLessThan(4);await expect(nav).toBeInViewport({ratio:.9});
 const url=new URL(page.url());expect(url.searchParams.get('episode')).toBe(second.episodeUid);expect(url.searchParams.get('episodePlanRevision')).toBe(f.plan.revisionId);expect(url.searchParams.has('scene')).toBe(false);
 await expect(criteria).toHaveCount(6);await expect(desk.locator('.adaptation-formal-review,.scene-narrative-review')).toHaveCount(0);
 await expect.poll(()=>f.commentReads.some(read=>read.episodeUid===second.episodeUid&&read.revisionId===f.plan.revisionId)).toBe(true);
 await nav.locator('[data-episode-uid="'+first.episodeUid+'"]').click();await expect(reader).toHaveAttribute('data-scene-id',first.sceneIds[0]);await expect(page.locator('.story-comment-trigger:visible')).toHaveCount(1);
 for(let index=0;index<6;index++){await expect(criteria.nth(index).getByRole('textbox')).toHaveValue('切集前第'+(index+1)+'项未提交判断');await expect(criteria.nth(index).getByRole('radio',{name:verdicts[index],exact:true})).toHaveAttribute('aria-checked','true');}
 await desk.locator('[data-logic-group="episode-purpose"]').click();await expect.poll(async()=>(await position()).calls).toContain('logic-episode-task');
 expect(new URL(page.url()).searchParams.get('logicGroup')).toBe('episode-purpose');expect(new URL(page.url()).searchParams.get('episode')).toBe(first.episodeUid);
 await page.locator('.story-comment-trigger:visible').click();await expect(page.locator('[data-comment-id="fixture-narrative-thread"]')).toContainText('同一永久正文的既有评论');
 clean(f);
});

for(const width of [1440,390])test(width+'px场表与正文固定高度独立滚动，长短场及切集不拖动主容器',async({page},info)=>{
 const f=await fixture(page,{candidate:true,crossEpisode:true,sameEpisodeScenes:true,readingScrollStress:true}),first=f.plan.content.episodes[0],second=f.plan.content.episodes[1];
 await page.setViewportSize({width,height:1000});await page.goto('/?view=story&storyMode=logic&episodePlanRevision='+encodeURIComponent(f.plan.revisionId)+'&episode='+encodeURIComponent(first.episodeUid)+'&logicGroup=episode-purpose');
 const desk=workbench(page),nav=desk.locator('.episode-review-navigator'),area=desk.locator('.episode-scene-navigator'),left=area.locator('.episode-scene-table-scroll'),right=area.locator('.episode-scene-reading-slot'),reader=desk.getByRole('region',{name:'本场正文与估时依据',exact:true});
 const metrics=()=>area.evaluate(element=>{const l=element.querySelector<HTMLElement>('.episode-scene-table-scroll')!,r=element.querySelector<HTMLElement>('.episode-scene-reading-slot')!;return {left:{height:l.clientHeight,content:l.scrollHeight,top:l.scrollTop,overflow:getComputedStyle(l).overflowY},right:{height:r.clientHeight,content:r.scrollHeight,top:r.scrollTop,overflow:getComputedStyle(r).overflowY},main:document.querySelector('.workspace-main')?.scrollTop,window:window.scrollY};});
 await expect(reader).toHaveAttribute('data-scene-id',first.sceneIds[0]);await expect(left.locator('tbody tr')).toHaveCount(first.sceneIds.length);await area.evaluate(element=>element.scrollIntoView({block:'center',behavior:'instant'}));
 const before=await metrics();expect(before.left.height).toBeGreaterThan(0);expect(before.right.height).toBeGreaterThan(0);expect(before.left.overflow).toBe('auto');expect(before.right.overflow).toBe('auto');expect(before.left.content).toBeGreaterThan(before.left.height+60);expect(before.right.content).toBeGreaterThan(before.right.height+60);
 if(width>760)expect(Math.abs(before.left.height-before.right.height)).toBeLessThan(2);else expect(before.left.height).toBeGreaterThanOrEqual(238);
 expect(before.right.height).toBeGreaterThanOrEqual(640);expect(before.right.height).toBeLessThanOrEqual(652);
 await left.evaluate(element=>element.scrollTo({top:120,behavior:'instant'}));let changed=await metrics();expect(changed.left.top).toBe(120);expect(changed.right.top).toBe(before.right.top);expect(changed.main).toBe(before.main);expect(changed.window).toBe(before.window);
 await right.evaluate(element=>element.scrollTo({top:220,behavior:'instant'}));changed=await metrics();expect(changed.right.top).toBe(220);expect(changed.left.top).toBe(120);expect(changed.main).toBe(before.main);expect(changed.window).toBe(before.window);
 const shortId=first.sceneIds[1],shortScene=f.plan.content.narrativeRevision.scenes.find((scene:{id:string})=>scene.id===shortId);
 const shortButton=left.locator('button[data-scene-id="'+shortId+'"]');const shortPoint=await readingClickPoint(shortButton);const beforeShort=await metrics();await page.mouse.click(shortPoint.x,shortPoint.y);await expect(reader).toHaveAttribute('data-scene-id',shortId);await expect(reader).toHaveAttribute('data-scene-content-hash',shortScene.contentHash);
 const short=await metrics();expect(short.left.height).toBe(before.left.height);expect(short.right.height).toBe(before.right.height);expect(short.main).toBe(beforeShort.main);expect(short.window).toBe(beforeShort.window);await expect(desk.locator('.episode-review-criteria [data-criterion-id]')).toHaveCount(6);
 const longButton=left.locator('button[data-scene-id="'+first.sceneIds[0]+'"]');const longPoint=await readingClickPoint(longButton);const beforeLong=await metrics();await page.mouse.click(longPoint.x,longPoint.y);await expect(reader).toHaveAttribute('data-scene-id',first.sceneIds[0]);const longAgain=await metrics();expect(longAgain.right.height).toBe(before.right.height);expect(longAgain.right.content).toBeGreaterThan(longAgain.right.height+60);expect(longAgain.main).toBe(beforeLong.main);expect(longAgain.window).toBe(beforeLong.window);
 const episodeButton=nav.locator('[data-episode-uid="'+second.episodeUid+'"]');const episodePoint=await readingClickPoint(episodeButton);const priorEpisode=await metrics();await page.mouse.click(episodePoint.x,episodePoint.y);await expect(reader).toHaveAttribute('data-scene-id',second.sceneIds[0]);await expect(desk.locator('.episode-logic-summary')).toHaveAttribute('data-episode-uid',second.episodeUid);
 const afterEpisode=await metrics();expect(afterEpisode.left.height).toBe(before.left.height);expect(afterEpisode.right.height).toBe(before.right.height);expect(afterEpisode.main).toBe(priorEpisode.main);expect(afterEpisode.window).toBe(priorEpisode.window);
 const url=new URL(page.url());expect(url.searchParams.get('episode')).toBe(second.episodeUid);expect(url.searchParams.get('episodePlanRevision')).toBe(f.plan.revisionId);await expect(desk.locator('.scene-narrative-review,.adaptation-formal-review')).toHaveCount(0);expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width);
 await info.attach('fixed-scene-reading-scroll-'+width,{body:JSON.stringify({before,short,longAgain,priorEpisode,afterEpisode},null,2),contentType:'application/json'});clean(f);
});

test('上方同集切场只换精确正文，下方当前材料与六项未提交判断保持不变',async({page})=>{
 const f=await fixture(page,{candidate:true,sameEpisodeScenes:true}),episode=f.plan.content.episodes[0],firstId=episode.sceneIds[0],secondId=episode.sceneIds[1];
 await page.goto('/?view=story&storyMode=logic&episodePlanRevision='+encodeURIComponent(f.plan.revisionId)+'&episode='+encodeURIComponent(episode.episodeUid)+'&logicGroup=episode-purpose');
 const desk=workbench(page),criteria=desk.locator('.episode-review-criteria'),cards=criteria.locator('[data-criterion-id]'),reader=desk.getByRole('region',{name:'本场正文与估时依据',exact:true});
 await expect(cards).toHaveCount(6);await expect(reader).toHaveAttribute('data-scene-id',firstId);
 const verdicts=['通过','有问题','通过','有问题','通过','有问题'];
 for(let index=0;index<6;index++){await cards.nth(index).getByRole('radio',{name:verdicts[index],exact:true}).click();await cards.nth(index).getByRole('textbox').fill('本集第'+(index+1)+'项未提交依据');}
 const surface=desk.locator('.story-comment-surface'),detail=desk.locator('.episode-logic-detail');await expect(surface).toHaveCount(1);await surface.evaluate(element=>element.setAttribute('data-reader-provider-probe','stable'));
 const materialBefore=await detail.innerText(),commentReadCount=f.commentReads.length;
 const assertJudgments=async()=>{await expect(cards).toHaveCount(6);for(let index=0;index<6;index++){await expect(cards.nth(index).getByRole('textbox')).toHaveValue('本集第'+(index+1)+'项未提交依据');await expect(cards.nth(index).getByRole('radio',{name:verdicts[index],exact:true})).toHaveAttribute('aria-checked','true');}await expect(desk.locator('[data-logic-group="episode-purpose"]')).toHaveAttribute('aria-current','location');expect(await detail.innerText()).toBe(materialBefore);await expect(surface).toHaveAttribute('data-reader-provider-probe','stable');};
 await desk.locator('.episode-scene-navigator button[data-scene-id="'+secondId+'"]').click();await expect(reader).toHaveAttribute('data-scene-id',secondId);await expect(reader.locator('.narrative-script-body')).toContainText('本集第二场精确正文：人物合上信封后离开。');await expect(reader.locator('.episode-scene-rationale')).toContainText('本集第二场动作与离场估时，不借用首场依据');await assertJudgments();
 await expect(desk.locator('.episode-review-per-episode')).toHaveCount(1);await expect(desk.locator('.adaptation-formal-review,.scene-narrative-review,.episode-full-script,.episode-unit-entry')).toHaveCount(0);await expect(page.getByRole('heading',{name:'本场正式审阅',exact:true})).toHaveCount(0);
 await expect(page.locator('.story-comment-trigger:visible')).toHaveCount(1);await expect(page.locator('.source-return-bar')).toHaveCount(0);expect(f.commentReads.length).toBe(commentReadCount);
 const url=new URL(page.url());expect(url.searchParams.get('storyMode')).toBe('logic');expect(url.searchParams.get('scene')).toBe(secondId);expect(url.searchParams.get('episode')).toBe(episode.episodeUid);expect(url.searchParams.get('logicGroup')).toBe('episode-purpose');
 await desk.locator('.episode-scene-navigator button[data-scene-id="'+firstId+'"]').click();await expect(reader).toHaveAttribute('data-scene-id',firstId);await assertJudgments();clean(f);
});

test('旧逐场深链保留永久场和正文hash，只打开阅读器且下方集判断常驻',async({page})=>{
 const f=await fixture(page),sceneId=f.capture.sceneId;
 await page.goto('/?view=story&storyMode=audit&episodePlanRevision='+encodeURIComponent(f.plan.revisionId)+'&scene='+encodeURIComponent(sceneId));
 await expect(page).toHaveURL(/storyMode=logic/);expect(new URL(page.url()).searchParams.get('scene')).toBe(sceneId);
 const desk=workbench(page),reader=desk.getByRole('region',{name:'本场正文与估时依据',exact:true});await expect(reader).toHaveAttribute('data-scene-id',sceneId);await expect(reader).toHaveAttribute('data-scene-content-hash',f.capture.responses.sceneReviewContext.context.sceneContentHash);await expect(reader).toContainText('这是作者明确写下的候选正文。');
 await expect(desk.locator('.episode-review-criteria [data-criterion-id]')).toHaveCount(6);await expect(desk.locator('.adaptation-formal-review,.scene-narrative-review')).toHaveCount(0);await expect(page.getByRole('heading',{name:'本场正式审阅',exact:true})).toHaveCount(0);
 await expect(page.locator('.story-mode-tabs [role="tab"]')).toHaveText(['来源资料','故事结构','叙事拆解']);await expect(page.locator('.story-comment-trigger:visible')).toHaveCount(1);clean(f);
});

test('统一审阅拒绝旧显示场号作为永久场身份，不静默显示首场正文',async({page})=>{
 const f=await fixture(page);
 await page.goto('/?view=story&storyMode=logic&episodePlanRevision='+encodeURIComponent(f.plan.revisionId)+'&episode='+encodeURIComponent(f.plan.content.episodes[0].episodeUid)+'&scene=S01');
 await expect(page.getByText('这是作者明确写下的候选正文。',{exact:true})).toHaveCount(0);
 await expect(page.getByRole('alert')).toContainText(/不属于|无法定位|不匹配/);
 expect(new URL(page.url()).searchParams.get('scene')).toBe('S01');await expect(page.locator('.episode-review-per-episode')).toHaveCount(0);
 clean(f);
});

test('390px集场目录与嵌入场正文不增加页面横向溢出',async({page})=>{
 const f=await fixture(page);await page.setViewportSize({width:390,height:844});
 await page.goto('/?view=story&storyMode=logic&episodePlanRevision='+encodeURIComponent(f.plan.revisionId)+'&episode='+encodeURIComponent(f.plan.content.episodes[0].episodeUid)+'&scene='+encodeURIComponent(f.capture.sceneId));
 await expect(workbench(page).locator('.episode-scene-reader .narrative-script-body').getByText('这是作者明确写下的候选正文。',{exact:true})).toBeVisible();
 await expect(workbench(page).getByRole('region',{name:'集与场审阅目录',exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(390);
 await expect(page.locator('.story-comment-trigger:visible')).toHaveCount(1);clean(f);
});


test('真实主页面跨集因果端点以永久集场导航，刷新与历史前后退保持同一对象',async({page})=>{
 const f=await fixture(page,{candidate:true,crossEpisode:true}),first=f.plan.content.episodes[0],second=f.plan.content.episodes[1],sceneId=second.sceneIds[0],scene=f.plan.content.narrativeRevision.scenes.find((item:{id:string})=>item.id===sceneId);
 const contentHash=f.plan.contentHash;
 await page.goto('/?view=story&storyMode=logic&episodePlanRevision='+encodeURIComponent(f.plan.revisionId)+'&episode='+encodeURIComponent(first.episodeUid)+'&logicGroup=information-causality');
 const endpoint=page.locator('.episode-causal-flow [data-scene-id="'+sceneId+'"]');await expect(endpoint).toContainText('S01');const origin=page.url();await endpoint.click();
 const assertSecond=async()=>{
  await expect(workbench(page).getByRole('region',{name:'本场正文与估时依据',exact:true})).toBeVisible();
  await expect(workbench(page).locator('.episode-scene-reader .narrative-script-body').getByText(scene.scriptBlocks[0].text,{exact:true})).toBeVisible();
  const url=new URL(page.url());expect(url.searchParams.get('storyMode')).toBe('logic');expect(url.searchParams.get('narrativeLevel')).toBe('scene');expect(url.searchParams.get('episode')).toBe(second.episodeUid);expect(url.searchParams.get('scene')).toBe(sceneId);expect(url.searchParams.get('episodePlanRevision')).toBe(f.plan.revisionId);
  await expect(workbench(page).locator('.episode-review-criteria [data-criterion-id]')).toHaveCount(6);
  await expect(workbench(page).locator('.adaptation-formal-review,.scene-narrative-review')).toHaveCount(0);
  await expect(workbench(page).getByRole('region',{name:'本场正文与估时依据',exact:true})).toHaveAttribute('data-scene-content-hash',scene.contentHash);
  expect(url.searchParams.get('logicGroup')).toBe('information-causality');
 };
 await assertSecond();await expect(page.locator('.source-return-bar')).toHaveCount(0);await page.reload();await assertSecond();
 await page.goBack();await expect(page).toHaveURL(origin);await expect(workbench(page).locator('.episode-review-criteria [data-criterion-id]')).toHaveCount(6);await expect(page.locator('.episode-review-navigator [data-episode-uid="'+first.episodeUid+'"]')).toHaveAttribute('aria-pressed','true');
 await page.goForward();await assertSecond();
 await workbench(page).locator('.episode-logic-navigation [data-logic-group="episode-purpose"]').click();expect(new URL(page.url()).searchParams.get('episode')).toBe(second.episodeUid);expect(new URL(page.url()).searchParams.get('scene')).toBe(sceneId);await expect(workbench(page).locator('.episode-review-criteria [data-criterion-id]')).toHaveCount(6);
 expect(f.plan.contentHash).toBe(contentHash);expect(stableObjectHash(f.plan.content)).toBe(contentHash);expect(f.commentReads.some(read=>read.episodeUid===second.episodeUid&&read.revisionId===f.plan.revisionId)).toBe(true);clean(f);
});


test('请求修订与服务端返回修订不一致时关闭审阅，不显示另一候选正文',async({page})=>{
 const f=await fixture(page),requestedRevision='cr-requested-revision-not-returned';
 await page.goto('/?view=story&storyMode=logic&episodePlanRevision='+requestedRevision+'&episode='+encodeURIComponent(f.plan.content.episodes[0].episodeUid)+'&scene='+encodeURIComponent(f.capture.sceneId));
 await expect(page.getByRole('alert').filter({hasText:/修订|版本|revision|不匹配/})).toBeVisible();
 await expect(page.getByText('这是作者明确写下的候选正文。',{exact:true})).toHaveCount(0);
 await expect(page.locator('.episode-review-per-episode,.adaptation-formal-review')).toHaveCount(0);
 expect(new URL(page.url()).searchParams.get('episodePlanRevision')).toBe(requestedRevision);expect(f.commentReads).toEqual([]);clean(f);
});

test('明确分集与场永久身份归属矛盾时保持原URL且关闭两类提交',async({page})=>{
 const f=await fixture(page,{candidate:true,crossEpisode:true}),first=f.plan.content.episodes[0],second=f.plan.content.episodes[1],sceneId=second.sceneIds[0],scene=f.plan.content.narrativeRevision.scenes.find((item:{id:string})=>item.id===sceneId);
 await page.goto('/?view=story&storyMode=logic&narrativeLevel=scene&episodePlanRevision='+encodeURIComponent(f.plan.revisionId)+'&episode='+encodeURIComponent(first.episodeUid)+'&scene='+encodeURIComponent(sceneId));
 await expect(page.getByRole('alert').filter({hasText:/不属于|不匹配|归属/})).toBeVisible();
 await expect(page.getByText(scene.scriptBlocks[0].text,{exact:true})).toHaveCount(0);await expect(page.getByText('这是作者明确写下的候选正文。',{exact:true})).toHaveCount(0);
 await expect(page.locator('.episode-review-per-episode,.adaptation-formal-review')).toHaveCount(0);
 const url=new URL(page.url());expect(url.searchParams.get('episode')).toBe(first.episodeUid);expect(url.searchParams.get('scene')).toBe(sceneId);expect(url.searchParams.get('episodePlanRevision')).toBe(f.plan.revisionId);clean(f);
});

test('已有搜索来源在内部集场导航中保留，不改写为叙事拆解来源',async({page})=>{
 const f=await fixture(page,{candidate:true}),episode=f.plan.content.episodes[0];
 await page.goto('/?view=story&storyMode=logic&episodePlanRevision='+encodeURIComponent(f.plan.revisionId)+'&episode='+encodeURIComponent(episode.episodeUid));await expect(workbench(page)).toBeVisible();
 await page.evaluate(()=>{const state={...(history.state||{}),reviewOrigin:{label:'搜索结果'}};history.replaceState(state,'',location.href);window.dispatchEvent(new PopStateEvent('popstate',{state}));});
 await expect(page.locator('.source-return-bar')).toContainText('搜索结果');await expect(workbench(page).locator('.episode-review-criteria [data-criterion-id]')).toHaveCount(6);
 await workbench(page).locator('.episode-scene-navigator button[data-scene-id="'+f.capture.sceneId+'"]').click();await expect(workbench(page).locator('.episode-scene-reader .narrative-script-body').getByText('这是作者明确写下的候选正文。',{exact:true})).toBeVisible();await expect(page.locator('.source-return-bar')).toHaveCount(1);await expect(page.locator('.source-return-bar')).toContainText('搜索结果');
 await workbench(page).locator('.episode-logic-navigation [data-logic-group="episode-purpose"]').click();await expect(page.locator('.source-return-bar')).toContainText('搜索结果');expect(await page.evaluate(()=>history.state.reviewOrigin.label)).toBe('搜索结果');clean(f);
});

for(const width of [1440,1536,390]){
 test(width+'px 全局概要与估时场导航位于三栏之前，三页签等宽无空格',async({page},testInfo)=>{
  const f=await fixture(page,{candidate:true,crossEpisode:true}),episode=f.plan.content.episodes[0];await page.setViewportSize({width,height:1000});
  await page.goto('/?view=story&storyMode=logic&episodePlanRevision='+encodeURIComponent(f.plan.revisionId)+'&episode='+encodeURIComponent(episode.episodeUid));
  const desk=workbench(page),summary=desk.getByRole('region',{name:'本集全局概要',exact:true}),table=desk.locator('.episode-scene-timing-table'),menu=desk.locator('.episode-logic-navigation'),material=desk.locator('.episode-logic-detail'),criteria=desk.locator('.episode-review-criteria');
  await expect(criteria.locator('[data-criterion-id]')).toHaveCount(6);await expect(summary).toHaveAttribute('data-episode-uid',episode.episodeUid);
  await expect(table.getByRole('columnheader')).toHaveText(['场次','基准','紧凑／舒展']);await expect(table.locator('tbody tr')).toHaveCount(episode.sceneIds.length);
  await expect(table.locator('tbody tr')).toHaveAttribute('data-timing-scene-id',episode.sceneIds[0]);await expect(table.locator('tbody td').nth(0)).toHaveText('0分30秒');await expect(desk.locator('.episode-scene-rationale')).toContainText('隔离回归的动作与转场估时，未锁时');await expect(summary).toContainText('0分30秒');await expect(desk.locator('.episode-unit-entry,.episode-full-script')).toHaveCount(0);
  const boxes=await Promise.all([desk.locator('.episode-review-navigator'),summary,desk.locator('.episode-scene-navigator'),menu,material,criteria,desk.locator('.episode-scene-table-scroll')].map(item=>item.boundingBox()));expect(boxes.every(Boolean)).toBe(true);
  const [epBox,summaryBox,navBox,menuBox,materialBox,criteriaBox,tableBox]=boxes.map(box=>box!);
  expect(epBox.y+epBox.height).toBeLessThanOrEqual(summaryBox.y+1);expect(summaryBox.y+summaryBox.height).toBeLessThanOrEqual(navBox.y+1);expect(navBox.y+navBox.height).toBeLessThanOrEqual(menuBox.y+1);
  const tabs=page.locator('.story-mode-tabs [role="tab"]');await expect(tabs).toHaveCount(3);const tabBoxes=(await Promise.all([0,1,2].map(index=>tabs.nth(index).boundingBox()))).map(box=>box!);const tabParent=(await page.locator('.story-mode-tabs').boundingBox())!;
  for(const box of tabBoxes){expect(Math.abs(box.width-tabBoxes[0].width)).toBeLessThan(2);expect(Math.abs(box.y-tabBoxes[0].y)).toBeLessThan(2);}
  expect(Math.abs(tabBoxes[0].x-tabParent.x)).toBeLessThan(2);expect(Math.abs(tabBoxes[2].x+tabBoxes[2].width-tabParent.x-tabParent.width)).toBeLessThan(2);
  if(width>=1280){
   expect(menuBox.x+menuBox.width).toBeLessThanOrEqual(materialBox.x+1);expect(materialBox.x+materialBox.width).toBeLessThanOrEqual(criteriaBox.x+1);expect(Math.abs(menuBox.y-materialBox.y)).toBeLessThan(2);expect(Math.abs(criteriaBox.y-materialBox.y)).toBeLessThan(2);
   const readingBox=(await desk.locator('.episode-scene-reader').boundingBox())!;expect(tableBox.x+tableBox.width).toBeLessThanOrEqual(readingBox.x+1);expect(Math.abs(tableBox.y-readingBox.y)).toBeLessThan(2);expect(readingBox.width).toBeGreaterThan(400);expect(tableBox.width).toBeGreaterThan(300);
  }else{
   expect(menuBox.y+menuBox.height).toBeLessThanOrEqual(materialBox.y+1);expect(materialBox.y+materialBox.height).toBeLessThanOrEqual(criteriaBox.y+1);
   expect(tableBox.x).toBeGreaterThanOrEqual(0);expect(tableBox.x+tableBox.width).toBeLessThanOrEqual(width);const readingBox=(await desk.locator('.episode-scene-reader').boundingBox())!;expect(tableBox.y+tableBox.height).toBeLessThanOrEqual(readingBox.y+1);expect(readingBox.x).toBeGreaterThanOrEqual(0);expect(readingBox.x+readingBox.width).toBeLessThanOrEqual(width);
  }
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width);
  // workspace-main scrolls independently: capture the visible review surfaces,
  // not the unrelated authoring form at its initial top position.
  await summary.scrollIntoViewIfNeeded();await expect(summary).toBeInViewport({ratio:0.9});await page.screenshot({path:testInfo.outputPath('narrative-summary-'+width+'.png'),fullPage:true});
  await desk.locator('.episode-scene-reader').scrollIntoViewIfNeeded();await expect(desk.locator('.episode-scene-reader')).toBeInViewport({ratio:0.5});await page.screenshot({path:testInfo.outputPath('narrative-layout-'+width+'.png'),fullPage:true});
  await menu.scrollIntoViewIfNeeded();await expect(menu).toBeInViewport({ratio:0.5});await page.screenshot({path:testInfo.outputPath('narrative-six-criteria-'+width+'.png'),fullPage:true});clean(f);
 });
}

test('全局概要原生选区和已有正文评论保持精确上下文，切判断不重建provider',async({page})=>{
 const f=await fixture(page,{candidate:true,crossEpisode:true,withComments:true}),episode=f.plan.content.episodes[0],scene=f.plan.content.narrativeRevision.scenes.find((item:{id:string})=>item.id===f.capture.sceneId);
 await page.goto('/?view=story&storyMode=logic&episodePlanRevision='+encodeURIComponent(f.plan.revisionId)+'&episode='+encodeURIComponent(episode.episodeUid));
 const summary=page.getByRole('region',{name:'本集全局概要',exact:true}),anchor=summary.locator('[data-comment-target="EPISODE_DESIGN:'+episode.episodeUid+'"][data-comment-block="purpose.episodeTask"]');
 await expect(anchor).toHaveText(episode.reviewDossier.purpose.episodeTask.text);await expect(page.locator('.story-comment-trigger:visible')).toHaveCount(1);
 await anchor.scrollIntoViewIfNeeded();await anchor.evaluate(element=>{const range=document.createRange();range.selectNodeContents(element);const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);element.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));});
 await expect(page.getByRole('button',{name:'添加评论',exact:true})).toBeVisible();expect(await page.evaluate(()=>window.getSelection()?.toString())).toBe(episode.reviewDossier.purpose.episodeTask.text);
 await page.evaluate(()=>window.getSelection()?.removeAllRanges());
 const surface=workbench(page).locator('.story-comment-surface');await expect(surface).toHaveCount(1);await surface.evaluate(element=>element.setAttribute('data-layout-provider-probe','stable'));const reads=f.commentReads.length;
 await page.locator('.episode-logic-navigation [data-logic-group="information-causality"]').click();await expect(surface).toHaveAttribute('data-layout-provider-probe','stable');expect(f.commentReads.length).toBe(reads);
 await page.locator('.story-comment-trigger:visible').click();const thread=page.locator('[data-comment-id="fixture-narrative-thread"]');await expect(thread).toContainText('同一永久正文的既有评论');await thread.locator('.story-comment-location').click();
 const block=workbench(page).locator('[data-comment-target="SCENE_SCRIPT:'+scene.id+'"][data-comment-block="'+scene.scriptBlocks[0].id+'"]');await expect(block.first()).toHaveText(scene.scriptBlocks[0].text);
 await page.getByRole('button',{name:'收起文字评论',exact:true}).click();await workbench(page).locator('.episode-scene-timing-table [data-scene-id="'+scene.id+'"]').click();await expect(workbench(page).getByRole('region',{name:'本场正文与估时依据',exact:true})).toBeVisible();
 await expect(page.locator('.story-comment-trigger:visible')).toHaveCount(1);await page.locator('.story-comment-trigger:visible').click();await expect(thread).toContainText('同一永久正文的既有评论');
 await expect(surface).toHaveAttribute('data-layout-provider-probe','stable');expect(f.commentReads.some(read=>read.episodeUid===episode.episodeUid&&read.revisionId===f.plan.revisionId)).toBe(true);await expect(block).toHaveCount(1);clean(f);
});
