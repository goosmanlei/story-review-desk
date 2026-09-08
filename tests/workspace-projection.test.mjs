import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {projectWorkspaceModules,projectStoryProgress,WORKSPACE_MODULES} from '../host/instance-runtime/workspace-projection.mjs';
import {workflowOverview} from '../host/instance-runtime/workflow-overview.mjs';
import {CREATOR_PRODUCTION_STAGES,creatorProductionGateDefinition} from '../host/instance-runtime/creator-production-workflow.mjs';
const counts={total:1,ready:1,inProgress:0,waiting:0,blocked:0,humanCanAdvance:1,aiCanAdvance:0,humanAndAi:0,aiCanAssist:1,automation:0};
function fixture(){
 const gates=CREATOR_PRODUCTION_STAGES.flatMap(stage=>stage.gateIds).map(id=>({id,...creatorProductionGateDefinition(id)}));
 const model={episodes:[{id:'episode-a'},{id:'episode-a'}],scenes:[{id:'scene-a'}],shots:[{id:'historical-shot',scopeRole:'EVIDENCE_ONLY'}],
  domainGraph:{entities:[{id:'one',type:'CHARACTER'},{id:'place',type:'LOCATION'}],relations:[]},domainGraphRef:{revisionId:'graph-a'},
  systemConfiguration:{reference:{revisionId:'config-a',sha256:'a'.repeat(64)},config:{workflow:{phases:[...new Set(gates.map(gate=>gate.phaseId))].map(id=>({id})),gates}}}};
 const queue={snapshotId:'snapshot-a',operationRevision:'ops-a',summary:{inventory:{materialRequirements:2,covered:1,pendingReviewCandidates:1}},workspaceSummary:{domains:[{id:'STORY_CREATION',status:'ACTIVE',headline:'候选待核',counts,stages:[]},{id:'FULL_PRODUCTION',status:'UNKNOWN',headline:'范围未锁',counts:{...counts,total:0,ready:0},stages:CREATOR_PRODUCTION_STAGES.map(stage=>({id:stage.id,label:stage.label,count:0,denominator:null,denominatorState:'UNKNOWN'}))}]}};
 const metadata={snapshotId:'snapshot-a',releaseId:'release-a',runtimeEpoch:'epoch-a',repositoryRevision:8,eventSequence:5};
 return {model,queue,metadata,operations:{snapshotId:'snapshot-a',operationRevision:'ops-a',counts:{reviews:3,episodePlanSubmissions:6}},preparation:{revisionId:'prep-a',content:{scenes:[{sceneId:'candidate-scene'}]},candidate:{revisionId:'candidate-a'},stale:false}};
}
test('workspace catalogue has four stable module owners and no story-specific facts',()=>{
 assert.deepEqual(WORKSPACE_MODULES.map(module=>module.id),['STORY_CREATION','STORY_SETTINGS','WORLD_AND_MATERIALS','FULL_PRODUCTION']);
 assert.equal(Object.isFrozen(WORKSPACE_MODULES),true);
 assert.doesNotMatch(JSON.stringify(WORKSPACE_MODULES),/九头案|七集|142/);
});
test('live module projection preserves exact metadata and never promotes preparation or inventory to denominator',()=>{
 const f=fixture(),before=JSON.stringify(f),result=projectWorkspaceModules(f);
 assert.equal(JSON.stringify(f),before);assert.equal(result.freshness.mode,'LIVE_TRANSACTION');assert.equal(result.freshness.eventSequence,5);
 assert.equal(result.modules[0].facts.find(fact=>fact.id==='registered-episodes').value,1);assert.equal(result.modules[1].facts.find(fact=>fact.id==='locations').value,1);
 const production=result.modules.find(module=>module.id==='FULL_PRODUCTION');
 assert.equal(production.facts.find(fact=>fact.id==='preparation-scenes').value,1);
 assert.equal(production.facts.find(fact=>fact.id==='registered-shots').value,1);
 assert.ok(production.stages.every(stage=>stage.denominator===null&&stage.denominatorState==='UNKNOWN'));
 assert.equal(result.modules[1].work,null,'settings must not impersonate all material work');
 assert.equal(result.audit.configuration.phaseCount,5);assert.equal(result.audit.creatorStages.length,4);
 const overview=workflowOverview(f.model,f.preparation,f);
 assert.equal(overview.denominatorState,'UNKNOWN');assert.equal(overview.definition.phases,f.model.systemConfiguration.config.workflow.phases);
 assert.ok(overview.nodes.filter(node=>node.group==='全剧制作').every(node=>node.definitionState==='DEFINED'));
});
test('no evidence remains UNKNOWN; declared CURRENT records do not imply a release',()=>{
 const result=projectWorkspaceModules();assert.equal(result.freshness.mode,'UNVERIFIED');
 assert.equal(result.modules[0].facts[0].value,null);assert.equal(result.modules[2].facts[0].value,null);
 const overview=workflowOverview({episodePlanRevisions:[{isCurrent:true,scopeRole:'CURRENT'}]},null);
 assert.doesNotMatch(overview.nodes.find(node=>node.id==='STORY').detail,/分集已采用/);
 assert.equal(overview.denominatorState,'UNKNOWN');
});
test('read-only projection identifies a published snapshot and does not expose local epoch as live status',()=>{
 const result=projectWorkspaceModules({...fixture(),readOnly:true});
 assert.equal(result.freshness.mode,'PUBLISHED_READ_ONLY');assert.equal(result.freshness.runtimeEpoch,null);
 assert.equal(result.freshness.repositoryRevision,null);assert.equal(result.freshness.eventSequence,null);
 assert.equal(result.freshness.snapshotId,'snapshot-a');assert.match(result.audit.authority,/只读快照/);
});

const require=createRequire(import.meta.url),ts=require('typescript');
function routeFixture({mismatch=false,hosted=false}={}){
 let active=false,transactions=0;
 const f=fixture(),data={snapshotId:'snapshot-a',productionModel:f.model};
 const check=()=>{if(!hosted)assert.equal(active,true,'every read belongs to the same outer transaction');};
 const repo={async readTransaction(callback){assert.equal(active,false);active=true;transactions++;try{return await callback({async getMetadata(){check();return f.metadata;}});}finally{active=false;}}};
 class HttpError extends Error{constructor(status,message){super(message);this.status=status;}}
 const mod={exports:{}},ctx={module:mod,exports:mod.exports,URL,Request,Promise,Error,require(id){
  if(id.endsWith('workflow-overview.mjs'))return {workflowOverview};
  if(id.endsWith('production-preparation.mjs'))return {async readProductionPreparation(){check();return f.preparation;}};
  if(id==='../../v8/_action-queue')return {async buildActionQueue(){check();return {...f.queue,operationRevision:mismatch?'different':'ops-a'};}};
  if(id==='../../v8/_store')return {hostedReadOnlyMode:()=>hosted,HttpError,async reviewData(){check();return data;},async operationalSnapshot(){check();return f.operations;}};
  if(id==='../_domain')return {domainRepository:async()=>repo,jsonResponse:body=>({status:200,body}),domainError:error=>({status:error.status||500,error:error.message})};
  throw Error('unmocked dependency '+id);
 }};
 vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../app/api/instance/workflow/route.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,ctx);
 return {GET:mod.exports.GET,transactions:()=>transactions};
}
test('combined endpoint reads queue, configuration model, preparation and watermarks in one transaction',async()=>{
 const f=routeFixture(),result=await f.GET(new Request('http://local/api/instance/workflow?workspace=1'));
 assert.equal(result.status,200);assert.equal(f.transactions(),1);
 assert.equal(result.body.queue.operationRevision,result.body.workflow.freshness.operationRevision);
 assert.equal(result.body.queue.snapshotId,result.body.workflow.freshness.snapshotId);
});
test('legacy workflow shape remains available; mixed event watermarks fail closed',async()=>{
 const f=routeFixture(),result=await f.GET(new Request('http://local/api/instance/workflow'));
 assert.equal(result.status,200);assert.ok(result.body.nodes);assert.equal(result.body.queue,undefined);
 const bad=await routeFixture({mismatch:true}).GET(new Request('http://local/api/instance/workflow?workspace=1'));assert.equal(bad.status,409);
 const published=routeFixture({hosted:true}),readOnly=await published.GET(new Request('http://local/api/instance/workflow?workspace=1'));
 assert.equal(published.transactions(),0);assert.equal(readOnly.body.workflow.freshness.mode,'PUBLISHED_READ_ONLY');
});

function storyFixture(){
 const episodes=Array.from({length:22},(_,index)=>({episodeUid:'permanent-episode-'+index,sceneIds:[]}));
 const scenes=Array.from({length:142},(_,index)=>({id:'permanent-scene-'+index}));
 for(let index=0;index<scenes.length;index++)episodes[index<6?0:index<10?1:index<17?2:3+(index-17)%19].sceneIds.push(scenes[index].id);
 const plan={sourceRole:'CANDIDATE',revisionId:'candidate-current',contentHash:'c'.repeat(64),content:{episodes,narrativeRevision:{scenes}}};
 const releases=Object.fromEntries(episodes.slice(0,3).map((episode,index)=>[episode.episodeUid,{
  id:'release-'+index,episodeUid:episode.episodeUid,scopeRole:'CURRENT',state:'READY',canFlowDownstream:true,sourceSyncState:'SOURCE_CURRENT',
  reviewEventId:'formal-review-'+index,sourceOperationId:'sync-operation-'+index,reviewInput:{scenes:episode.sceneIds.map(id=>({id}))},
 }]));
 return {plan,releases};
}
test('current 22/142 candidate and 3 formally released episodes are separate from old 7/47 inventory',()=>{
 const {plan,releases}=storyFixture(),f=fixture(),before=JSON.stringify([plan,releases]);
 f.model.episodes=Array.from({length:7},(_,i)=>({id:'historical-episode-'+i}));
 f.model.scenes=Array.from({length:47},(_,i)=>({id:'historical-scene-'+i}));
 f.queue.storyProgress=projectStoryProgress(plan,releases);
 const result=projectWorkspaceModules(f),story=result.modules[0],facts=Object.fromEntries(story.facts.map(f=>[f.id,f]));
 assert.equal(facts['current-episodes'].value,22);assert.equal(facts['current-scenes'].value,142);
 assert.equal(facts['released-episodes'].value,3);assert.equal(facts['released-episode-scenes'].value,17);
 assert.equal(facts['registered-episodes'].value,7);assert.match(facts['registered-episodes'].label,/历史/);
 assert.equal(facts['registered-scenes'].value,47);assert.match(facts['registered-scenes'].label,/历史/);
 assert.equal(story.revisionId,plan.revisionId);assert.equal(f.queue.storyProgress.formalDenominatorState,'UNKNOWN');
 assert.equal(workflowOverview(f.model,f.preparation,f).denominatorState,'UNKNOWN');
 assert.match(workflowOverview(f.model,f.preparation,f).nodes.find(node=>node.id==='STORY').detail,/22 集 \/ 142 场；3 集/);
 assert.equal(JSON.stringify([plan,releases]),before);
});
test('review inputs, unsynced or stale releases and obsolete episode identities do not inflate current releases',()=>{
 const {plan,releases}=storyFixture();
 releases[plan.content.episodes[0].episodeUid].state='STALE';
 releases[plan.content.episodes[1].episodeUid].sourceSyncState='PENDING';
 releases['obsolete-episode']={...releases[plan.content.episodes[2].episodeUid],episodeUid:'obsolete-episode'};
 const pending=plan.content.episodes[3];releases[pending.episodeUid]={episodeUid:pending.episodeUid,reviewInput:{scenes:pending.sceneIds.map(id=>({id}))},recommendation:'APPROVE_AND_RELEASE'};
 const progress=projectStoryProgress(plan,releases);assert.equal(progress.releasedEpisodeCount,1);assert.equal(progress.releasedSceneCount,7);
 const corrupted=structuredClone(releases);corrupted[plan.content.episodes[2].episodeUid].reviewInput.scenes.reverse();
 assert.equal(projectStoryProgress(plan,corrupted).releasedEpisodeCount,0,'display IDs or mismatched scene order cannot bind a release');
 assert.equal(projectStoryProgress(plan,undefined).releasedEpisodeCount,null,'missing release projection is UNKNOWN, not zero');
});
test('unreadable candidate cannot revive the old snapshot as current or turn a declaration into adoption',()=>{
 const f=fixture();f.queue.storyProgress=projectStoryProgress(null,{},'candidate basis stale');
 const story=projectWorkspaceModules(f).modules[0];assert.equal(story.facts.find(f=>f.id==='current-episodes').value,null);
 const {plan}=storyFixture(),progress=projectStoryProgress(plan,{});assert.equal(progress.releasedEpisodeCount,0);
 assert.match(progress.headline,/候选规模不等于全剧采用/);assert.equal(progress.formalDenominatorState,'UNKNOWN');
 const duplicate=structuredClone(plan);duplicate.content.episodes[1].episodeUid=duplicate.content.episodes[0].episodeUid;
 assert.equal(projectStoryProgress(duplicate,{}).state,'UNAVAILABLE');
});

async function syntheticStoryQueue(){
 const {blankProfile,blankSnapshot}=await import('../host/instance-runtime/blank.mjs');
 const {normalizeReviewSnapshot}=await import('../host/instance-runtime/snapshot-contract.mjs');
 const {plan,releases}=storyFixture(),profile=blankProfile({title:'共享当前故事投影测试'}),{snapshot,recipes}=blankSnapshot(profile);
 snapshot.creativeLineage.scenes=Array.from({length:47},(_,i)=>({id:'legacy-scene-'+i}));
 snapshot.productionModel.scenes=snapshot.creativeLineage.scenes;
 snapshot.productionModel.episodes=Array.from({length:7},(_,i)=>({id:'legacy-episode-'+i}));
 const data=normalizeReviewSnapshot(snapshot),candidate={subjectKind:'EPISODE_PLAN',subjectId:profile.episodePlanId,creativeRevisionId:plan.revisionId,contentHash:plan.contentHash,content:plan.content};
 const operations={snapshotId:data.snapshotId,operationRevision:'operations-current',etag:'"synthetic"',reviews:{events:[]},creativeRevisions:{events:[candidate]},candidates:{events:[]},runs:{events:[]},executionRequests:{current:[]},sourceOperations:{events:[],latestById:[]},stateProjection:{workItemsById:{},materialWorkItemsById:{},assetFamiliesById:{},assetVersionsById:{},materialRequirementsById:{},scopeLocksById:{},structuresById:{},scriptScenesById:{},episodeNarrativeReleasesByUid:releases}};
 const store={reviewData:async()=>data,operationalSnapshot:async()=>operations,recipeCatalog:async()=>recipes,storyConfirmationTargets:()=>[],audioVerificationTargets:()=>[],assertCreativeRevisionBasisCurrent:()=>{throw Error('Legacy seed has no current basis');},stableObjectHash:()=> 'd'.repeat(64),workProductReviewBinding:()=>{throw Error('No production operation is authorized');}};
 const fs=await import('node:fs'),path=await import('node:path'),url=await import('node:url');
 const cache=new Map();
 function load(filename){
  if(filename.endsWith('.mjs'))return require(filename);
  if(cache.has(filename))return cache.get(filename).exports;
  const module={exports:{}};cache.set(filename,module);
  const source=ts.transpileModule(readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const localRequire=id=>{
   if(id.endsWith('/_store')||id==='./_store')return store;
   // The canonical resolver boundary is supplied; queue/progress/audit are actual source.
   if(id==='./_episode-plan')return {resolveEpisodePlan:()=>plan};
   if(!id.startsWith('.'))return require(id);
   let next=path.resolve(path.dirname(filename),id);
   if(!/\.[cm]?[jt]sx?$/.test(next))next+=fs.existsSync(next+'.ts')?'.ts':'.tsx';
   return load(next);
  };
  new Function('require','module','exports',source)(localRequire,module,module.exports);return module.exports;
 }
 const before=JSON.stringify([data,operations]),queue=await load(url.fileURLToPath(new URL('../app/api/v8/_action-queue.ts',import.meta.url))).buildActionQueue();
 assert.equal(JSON.stringify([data,operations]),before);return {data,operations,queue};
}
test('real action queue and system audit consume the same candidate and scoped-release progress',async()=>{
 const {data,operations,queue}=await syntheticStoryQueue();
 assert.equal(queue.storyProgress.episodeCount,22);assert.equal(queue.storyProgress.sceneCount,142);
 assert.equal(queue.storyProgress.releasedEpisodeCount,3);assert.equal(queue.storyProgress.releasedSceneCount,17);
 const domain=queue.workspaceSummary.domains.find(d=>d.id==='STORY_CREATION');
 assert.match(domain.headline,/22 集 \/ 142 场；3 集/);assert.doesNotMatch(domain.headline,/整体审阅当前/);
 assert.match(domain.nextUnlockText,/已同步集可独立/);
 assert.match(queue.programs.find(p=>p.id==='EPISODE_PLAN').summary,/3 集已独立正式通过并完成源同步/);
 const metric=domain.metrics.find(m=>m.id==='EPISODES_SOURCE_CURRENT');
 assert.equal(metric.value,3);assert.equal(metric.denominator,null);assert.equal(metric.denominatorState,'UNKNOWN');
 const audit=projectWorkspaceModules({model:data.productionModel,operations,queue,readOnly:true});
 assert.equal(audit.modules[0].headline,domain.headline);
 assert.equal(audit.modules[0].facts.find(f=>f.id==='released-episodes').value,metric.value);
 assert.equal(audit.freshness.mode,'PUBLISHED_READ_ONLY');
 assert.equal(queue.workspaceSummary.domains.find(d=>d.id==='FULL_PRODUCTION').stages.every(stage=>stage.denominatorState==='UNKNOWN'),true);
});
