import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

// Exercise installed source directly; missing source must fail, not overlay a proposal.
const site=fileURLToPath(new URL('../',import.meta.url));
const nativeRequire=createRequire(path.join(site,'package.json')),ts=nativeRequire('typescript');
const {blankProfile,blankSnapshot}=await import(path.join(site,'host/instance-runtime/blank.mjs'));
const {normalizeReviewSnapshot}=await import(path.join(site,'host/instance-runtime/snapshot-contract.mjs'));
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function sourceFor(filename){return readFileSync(filename,'utf8');}
function fixture({ready=true,decision='',basisCurrent=true}={}){
 const profile=blankProfile({title:'场正文只读导航独立测试'}),{snapshot,recipes}=blankSnapshot(profile);
 const scene={id:'scene-permanent-a',displayId:'S99',episodeId:'E99',episodeUid:'episode-permanent-a'};
 const episode={id:'E99',displayId:'E99',episodeUid:scene.episodeUid,sceneIds:[scene.id],title:'独立测试',openingHook:'开场',coreAdvance:'推进',endingCliffhanger:'结尾',reviewQuestion:'判断',reviewDossier:{schemaVersion:'1.0'}};
 snapshot.scope.storyScenes=1;snapshot.creativeLineage.scenes=[scene];snapshot.productionModel.scenes=[scene];
 snapshot.creativeLineage.episodes=[episode];snapshot.productionModel.episodes=[episode];
 snapshot.creativeLineage.storyStructure={planStatus:ready?'CURRENT':'PROPOSAL',sourceSha256:'a'.repeat(64)};
 snapshot.actionQueueInputs.rewrittenSceneConfirmations=[{sceneId:scene.id,subjectId:scene.id,sceneContentHash:'c'.repeat(64),scriptSha256:'d'.repeat(64),sourceBeatIds:['old-beat-do-not-route'],affectedDownstreamRefs:{episodeIds:['E01-wrong-alias'],shotIds:['historical-shot'],workItemIds:['history-work']}}];
 snapshot.productionModel.episodePlanRevisions=[{id:'plan-exact-revision',planId:profile.episodePlanId,episodes:[episode],retiredEpisodeUids:[],scopeRole:ready?'CURRENT':'PROPOSAL',revisionState:ready?'CURRENT':'PROPOSAL',isCurrent:ready,isCurrentProposal:!ready,basisBindingsHash:'b'.repeat(64),...(ready?{review:{state:'RELEASED'},sync:{state:'SOURCE_CURRENT'}}:{})}];
 snapshot.productionModel.revisionPointers={...(ready?{currentEpisodePlanRevisionId:'plan-exact-revision'}:{episodePlanProposalRevisionId:'plan-exact-revision'})};
 const operations={snapshotId:snapshot.snapshotId,baseSnapshotId:snapshot.snapshotId,operationRevision:'OP-READING',etag:'"reading"',reviews:{events:[]},creativeRevisions:{events:[]},candidates:{events:[]},runs:{events:[]},executionRequests:{current:[]},sourceOperations:{latestById:[]},stateProjection:{workItemsById:{},materialWorkItemsById:{},assetFamiliesById:{},assetVersionsById:{},materialRequirementsById:{},scopeLocksById:{},structuresById:{},scriptScenesById:decision?{[scene.id]:{reviewDecision:decision}}:{}}};
 const store={reviewData:async()=>normalizeReviewSnapshot(snapshot),operationalSnapshot:async()=>operations,recipeCatalog:async()=>recipes,storyConfirmationTargets:()=>snapshot.actionQueueInputs.rewrittenSceneConfirmations,audioVerificationTargets:()=>[],currentCreativeSubjectBaseHash:()=>snapshot.creativeLineage.storyStructure.sourceSha256,assertCreativeRevisionBasisCurrent:()=>{if(!basisCurrent)throw Error('basis unavailable');},stableObjectHash:hash,HttpError:class extends Error{},workProductReviewBinding:()=>{throw Error('Unexpected production review');}};
 const cache=new Map();function load(filename){
  if(filename.endsWith('.css'))return {};
  if(filename.endsWith('.mjs'))return nativeRequire(filename);
  if(cache.has(filename))return cache.get(filename).exports;
  const module={exports:{}};cache.set(filename,module);
  const source=ts.transpileModule(sourceFor(filename),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX},fileName:filename}).outputText;
  const require=id=>{if(id==='./_store'||id.endsWith('/_store'))return store;if(!id.startsWith('.'))return nativeRequire(id);let target=path.resolve(path.dirname(filename),id);if(!/\.[cm]?[jt]sx?$|\.css$/.test(id))target+=existsSync(target+'.ts')?'.ts':'.tsx';return load(target);};
  new Function('require','module','exports',source)(require,module,module.exports);return module.exports;
 }
 return {snapshot,operations,recipes,scene,episode,load,...load(path.join(site,'app/api/v8/_action-queue.ts'))};
}
const sceneTask=queue=>queue.items.find(item=>item.subjectType==='SCRIPT_SCENE');
function assertExactReading(item){
 const url=new URL(item.navigationIntent.href,'http://fixture.invalid');
 assert.equal(url.searchParams.get('storyMode'),'logic');assert.equal(url.searchParams.get('narrativeLevel'),'scene');
 assert.equal(url.searchParams.get('episode'),'episode-permanent-a');assert.equal(url.searchParams.get('episodePlanRevision'),'plan-exact-revision');
 assert.equal(url.searchParams.get('scene'),'scene-permanent-a');assert.equal(url.searchParams.get('confirmScene'),'scene-permanent-a');
 assert.equal(url.searchParams.has('auditBeat'),false);assert.equal(item.navigationIntent.label,'查看正文与评论');
}
test('unconfirmed scene exposes exact reading only and cannot advertise a formal review capability',async()=>{
 const f=fixture(),before=JSON.stringify([f.snapshot,f.operations]);const q=await f.buildActionQueue(),item=sceneTask(q);assertExactReading(item);
 assert.equal(item.permissions.canSubmitReview,false);assert.equal(Object.values(item.permissions).some(Boolean),false);
 assert.equal(item.requiredAction,'WAIT_FOR_SCRIPT_SCENE_CONFIRMATION');assert.equal(item.workState,'WAITING');assert.equal(item.actor,'NONE');
 assert.equal(item.progressCapabilities.some(c=>c.actionType==='FORMAL_REVIEW'),false);
 assert(item.reasonCodes.includes('REWRITTEN_SCENE_UNCONFIRMED'));assert(item.hardBlockers.some(b=>b.reasonCode==='SCRIPT_SCENE_CONFIRMATION_REQUIRED'));
 assert.equal(item.dependency.frontier,false);assert.equal(item.dependency.directUnlockCount,0);
 const collapsed=q.workUnits.find(row=>row.workUnitKey===item.workUnitKey);assert.equal(collapsed.permissions.canSubmitReview,false);assertExactReading(collapsed);
 assert.equal(JSON.stringify([f.snapshot,f.operations]),before);assert.equal(q.programs.find(p=>p.id==='STORY_CONFIRMATION').status,'WAITING');
 assert(!JSON.stringify(item).includes('核对并确认'));assert(!JSON.stringify(item).includes('提交正式结论'));
});
test('episode proposal review is unchanged and its source-sync blocker is not cleared by reading',async()=>{
 const f=fixture({ready:false}),q=await f.buildActionQueue(),item=sceneTask(q);assertExactReading(item);
 const plan=q.items.find(row=>row.workstream==='EPISODE_PLANNING');assert.equal(plan.permissions.canSubmitReview,true);assert.equal(plan.requiredAction,'FORMAL_REVIEW');
 assert.equal(item.requiredAction,'WAIT_FOR_EPISODE_PLAN');assert.equal(item.permissions.canSubmitReview,false);assert.equal(item.actionability,'WAITING_DEPENDENCY');
 assert(item.hardBlockers.some(b=>b.reasonCode==='CURRENT_SYNCED_EPISODE_PLAN_REQUIRED'));assert(item.dependency.blockers.some(b=>b.reasonCode==='CURRENT_SYNCED_EPISODE_PLAN_REQUIRED'));
});
for(const decision of ['REVISION_REQUIRED','DO_NOT_USE'])test('original '+decision+' remediation and prohibition survive UI retirement',async()=>{
 const f=fixture({decision}),before=JSON.stringify(f.operations),item=sceneTask(await f.buildActionQueue());assertExactReading(item);
 assert.equal(item.permissions.canSubmitReview,false);assert.equal(item.requiredAction,decision==='REVISION_REQUIRED'?'AUTHOR_SOURCE_REVISION':'RESOLVE_FORBIDDEN_SCENE');
 assert.equal(item.actor,decision==='REVISION_REQUIRED'?'CODEX':'NONE');assert.equal(item.actionability,decision==='REVISION_REQUIRED'?'ACTIONABLE':'BLOCKED');
 if(decision==='DO_NOT_USE')assert(item.hardBlockers.some(b=>b.reasonCode==='SCRIPT_SCENE_DO_NOT_USE'));
 assert.equal(JSON.stringify(f.operations),before);
});
test('released scenes retain immutable historical facts and completion without new task or write',async()=>{
 const f=fixture({decision:'RELEASED'});f.operations.reviews.events=[{eventId:'historical-review',subjectType:'SCRIPT_SCENE',subjectId:f.scene.id,reviewDecision:'RELEASED',subjectRevisionHash:'c'.repeat(64)}];
 const before=JSON.stringify([f.snapshot,f.operations]),q=await f.buildActionQueue();assert.equal(sceneTask(q),undefined);
 const p=q.programs.find(p=>p.id==='STORY_CONFIRMATION');assert.equal(p.status,'COMPLETE');assert.equal(p.totalCount,1);assert.equal(p.openCount,0);assert.equal(JSON.stringify([f.snapshot,f.operations]),before);
});
test('missing exact revision pointer never falls back to an episode alias or first scene',async()=>{
 const f=fixture();f.snapshot.productionModel.revisionPointers={};const item=sceneTask(await f.buildActionQueue());
 const url=new URL(item.navigationIntent.href,'http://fixture.invalid');assert.equal(url.searchParams.get('view'),'overview');assert.equal(url.searchParams.has('scene'),false);assert.equal(url.searchParams.has('episode'),false);
 assert.equal(item.navigationIntent.label,'正文定位待补齐');assert.equal(item.permissions.canSubmitReview,false);assert.match(item.nextActionText,/精确归属尚不可解析/);
});
test('a broken latest candidate never revives the old static reading destination',async()=>{
 const f=fixture();f.operations.creativeRevisions.events=[{subjectKind:'EPISODE_PLAN',subjectId:f.snapshot.productionModel.episodePlanRevisions[0].planId,creativeRevisionId:'broken-latest',content:{},contentHash:'0'.repeat(64)}];
 const q=await f.buildActionQueue(),item=sceneTask(q);assert.equal(new URL(item.navigationIntent.href,'http://fixture.invalid').searchParams.get('view'),'overview');assert.equal(item.permissions.canSubmitReview,false);
 assert(q.items.some(row=>row.reasonCodes.includes('EPISODE_PLAN_CONTEXT_UNAVAILABLE')));
});
test('exact reading helper rejects missing, duplicate, retired and display-only identities',()=>{
 const f=fixture(),base={revisionId:'pinned-revision',content:{episodes:[{episodeUid:'permanent-ep',displayId:'E01',sceneIds:['permanent-scene']}],retiredEpisodeUids:[]}};
 assert(f.exactSceneReadingIntent(base,'permanent-scene'));assert.equal(f.exactSceneReadingIntent(base,'S01'),null);
 for(const change of [p=>p.revisionId='',p=>p.content.episodes[0].episodeUid='',p=>p.content.episodes.push({...p.content.episodes[0]}),p=>p.content.episodes[0].sceneIds.push('permanent-scene'),p=>p.content.retiredEpisodeUids.push('permanent-ep'),p=>p.content.episodes.push({episodeUid:'permanent-ep',sceneIds:['different-scene']})]){const p=structuredClone(base);change(p);assert.equal(f.exactSceneReadingIntent(p,'permanent-scene'),null);}
});
test('current work stage and story domain use the canonical narrative route',async()=>{
 const f=fixture(),q=await f.buildActionQueue(),domain=q.workspaceSummary.domains.find(d=>d.id==='STORY_CREATION');
 assert.equal(new URL(domain.navigationIntent.href,'http://fixture.invalid').searchParams.get('storyMode'),'logic');
 const {buildWorkflowStages}=f.load(path.join(site,'app/workflow-overview.tsx'));
 const stages=buildWorkflowStages(domain,{nodes:[]},q.items),stage=stages.find(s=>s.id==='STORY_CONFIRMATION');
 assert.equal(new URL(stage.href,'http://fixture.invalid').searchParams.get('storyMode'),'logic');assert.equal(stage.label,'场正文与评论');
});
test('other material generation permission and hard rights blockers are not altered',async()=>{
 for(const rightsBlocked of [false,true]){
  const f=fixture(),m=f.snapshot.productionModel;m.materialRequirements=[{id:'required-exact',requirementClass:'REQUIRED',materialWorkItemRef:'material-exact',coverageSatisfied:false}];
  m.materialWorkItems=[{id:'material-exact',requirementRef:'required-exact',lifecycleState:'READY_TO_START',outputAssetRef:'family-exact',executionDefinitionRef:'definition-exact',flowBlockReasons:[],executionBlockReasons:[]}];
  f.operations.stateProjection.materialWorkItemsById={'material-exact':{lifecycleState:'READY_TO_START',flowBlockReasons:rightsBlocked?['RIGHTS_BLOCKED']:[]}};f.operations.stateProjection.executionGatesByWorkItem={'material-exact':[]};
  f.recipes.executionDefinitions=[{id:'definition-exact',definitionStatus:'DEFINED',definitionHash:'e'.repeat(64),output:{assetFamilyRef:'family-exact'},upload:{items:[]}}];
  const before=JSON.stringify([f.snapshot,f.operations]),q=await f.buildActionQueue(),authorization=q.items.find(row=>row.requiredAction==='AUTHORIZE_GENERATION');
  if(rightsBlocked){assert.equal(authorization,undefined);assert(q.items.some(row=>row.requiredAction==='RESOLVE_MATERIAL_BLOCKER'));}else{assert(authorization);assert.equal(authorization.permissions.canAuthorizeCodex,true);assert.equal(authorization.permissions.canAuthorizeExternal,true);}
  assert.equal(JSON.stringify([f.snapshot,f.operations]),before);assert.equal(sceneTask(q).permissions.canSubmitReview,false);
 }
});
test('a different material with exact version and review scope keeps its formal review permission',async()=>{
 const f=fixture(),m=f.snapshot.productionModel;
 m.materialRequirements=[{id:'material-required',requirementClass:'REQUIRED',materialWorkItemRef:'material-work',coverageSatisfied:false}];
 m.materialWorkItems=[{id:'material-work',requirementRef:'material-required',outputAssetRef:'material-family',lifecycleState:'REVIEW_PENDING'}];
 f.operations.stateProjection.materialWorkItemsById={'material-work':{lifecycleState:'REVIEW_PENDING'}};
 f.operations.stateProjection.assetFamiliesById={'material-family':{decisionVersionId:'material-version'}};
 f.operations.stateProjection.assetVersionsById={'material-version':{sha256:'f'.repeat(64),outputState:'PRESENT'}};
 const q=await f.buildActionQueue(),item=q.items.find(row=>row.subjectType==='ASSET'&&row.subjectId==='material-family');
 assert(item);assert.equal(item.requiredAction,'FORMAL_REVIEW');assert.equal(item.permissions.canSubmitReview,true);assert.equal(item.versionId,'material-version');
 assert.equal(item.navigationIntent.label,'打开素材正式审阅');assert.equal(sceneTask(q).permissions.canSubmitReview,false);
});
