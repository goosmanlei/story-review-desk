import {captureHistoricalEventContexts} from '../host/instance-historical-event-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,runtime} from './modern-event-validator.test.mjs';
import {episodeSourceCompiler} from '../host/instance-runtime/episode-source-sync.mjs';
import {blankProfile,blankSnapshot} from '../host/instance-runtime/blank.mjs';
import {createInstanceRepository} from '../host/instance-runtime/index.mjs';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {episodeHttp} from './episode-scope-http.mjs';
import {canonicalJson,sha256} from '../host/instance-runtime/bytes.mjs';
import {validateModernEventClosure,frozenEventManifest,digest} from '../host/instance-modern-event-validator.mjs';
import {preserveScopedProductionProjection} from '../host/instance-runtime/scoped-production-projection.mjs';

const api=runtime.api,hash=api.stableObjectHash;
function prepared(){const f=fixture();const spec={profileId:'episode-fixture',criteria:api.expectedEpisodeCriterionIds('template').map(id=>({id,label:id,question:'测试问题'})),legacy:false,configurationHash:hash('configuration')};f.candidate.reviewSpec={...spec,hash:hash(spec)};f.submission.reviewSpecHash=f.candidate.reviewSpec.hash;return f;}
function nextCandidate(candidate){const c=structuredClone(candidate);Object.assign(c,{eventId:'candidate:next',creativeRevisionId:'cr:next',revisionId:'cr:next',eventSequence:20});return c;}
const rehash=c=>(c.contentHash=hash(c.content),c);
test('carry-forward ignores unrelated episode design and whole-plan notes',()=>{const f=prepared(),c=nextCandidate(f.candidate);c.content.changeSummary='仅其他集调整';c.content.episodes[1].coreAdvance='改变第二集设计，首尾承接不变';rehash(c);const option=api.episodeCarryForwardOptions([c,f.candidate],[f.submission],c,c.reviewSpec.hash)[0];assert.equal(option.state,'ELIGIBLE');});
test('own design, adjacent opening and standards invalidate only their evidence closure',()=>{for(const mutate of [c=>c.content.episodes[0].coreAdvance='本集改了',c=>c.content.episodes[1].openingHook='相邻开场改了',c=>c.reviewSpec.hash=hash('new standard')]){const f=prepared(),c=nextCandidate(f.candidate);mutate(c);rehash(c);assert.equal(api.episodeCarryForwardOptions([c,f.candidate],[f.submission],c,c.reviewSpec.hash)[0].state,'CHANGED');}});
test('a display alias cannot become a submission identity',()=>{const f=prepared(),c=nextCandidate(f.candidate);c.content.episodes[0].episodeUid='episode:other';rehash(c);assert.equal(api.episodeCarryForwardOptions([c,f.candidate],[f.submission],c,c.reviewSpec.hash).length,0);});
test('invalid schema 1.1 source is never laundered into eligible carry-forward',()=>{for(const addHash of [false,true]){const f=prepared(),c=rehash(nextCandidate(f.candidate));Object.assign(f.submission,{schemaVersion:'1.1',operation:'CARRY_FORWARD_EPISODE',reviewSpec:f.candidate.reviewSpec,carryForward:{sourceSubmissionEventId:'missing'}});if(addHash)Object.assign(f.submission,{reviewInputVersion:'1.0',reviewInputHash:api.episodeReviewInputHash(f.candidate,f.submission.episodeUid,f.submission.reviewSpecHash)});assert.equal(api.episodeCarryForwardOptions([c,f.candidate],[f.submission],c,c.reviewSpec.hash)[0].state,'UNAVAILABLE');}});
test('carry-forward freezes an exact source chain and refuses changed copied judgment',()=>{const f=prepared(),c=rehash(nextCandidate(f.candidate)),inputHash=api.episodeReviewInputHash(c,f.submission.episodeUid,c.reviewSpec.hash);const e={...structuredClone(f.submission),schemaVersion:'1.1',eventId:'carry:one',eventSequence:21,operation:'CARRY_FORWARD_EPISODE',subjectRevisionId:c.creativeRevisionId,creativeRevisionId:c.creativeRevisionId,subjectRevisionHash:c.contentHash,reviewSpec:c.reviewSpec,reviewInputVersion:'1.0',reviewInputHash:inputHash,carryForward:{sourceSubmissionEventId:f.submission.eventId,sourceRevisionId:f.submission.subjectRevisionId,sourceCandidateHash:f.submission.subjectRevisionHash,sourceReviewSpecHash:f.submission.reviewSpecHash,sourceReviewInputHash:inputHash,targetReviewInputHash:inputHash,sourceEventHash:hash(f.submission)}};api.assertEpisodeSubmissionInput(e,c,[f.candidate,c],[f.submission,e]);e.note='伪造的说明';assert.throws(()=>api.assertEpisodeSubmissionInput(e,c,[f.candidate,c],[f.submission,e]));});
test('causal endpoint source treatment belongs to the review closure',()=>{const f=prepared();const n=f.candidate.content.narrativeRevision;n.causalChains=[{id:'chain:one',title:'来信回收',setupSceneIds:[n.scenes[0].id],payoffSceneIds:[n.scenes[1].id],status:'PAID',mustPreserve:'回收'}];n.sourceNarrationIndex.push({id:'seg:two',sourceSha256:hash('source:two'),summary:'回收',viewpoint:'人物',treatment:'保留',reason:'重要',sceneIds:[n.scenes[1].id]});rehash(f.candidate);const c=nextCandidate(f.candidate);c.content.narrativeRevision.sourceNarrationIndex[1].reason='处理已变';rehash(c);assert.notEqual(api.episodeReviewInputHash(f.candidate,'episode:1',c.reviewSpec.hash),api.episodeReviewInputHash(c,'episode:1',c.reviewSpec.hash));});

export async function exerciseEpisodeScope(planningVersion = '1.0', {afterSync} = {}) {
  const demandBased=planningVersion!=='1.0',requirementSchema=planningVersion==='3.0'?'3.0':'2.0';
  const f=prepared(),profile=blankProfile({title:'单集推进隔离测试',episodePlanId:f.candidate.subjectId});const blank=blankSnapshot(profile);
  const spatialSource=canonicalJson({version:'1.0',locations:[{id:'ROOM-LETTER',name:'Neutral letter room'}],minimal_location_packages:{'ROOM-LETTER':{name:'Neutral letter room',fact_boundary:'Synthetic test geometry',lock_boundary:'Preserve the test door and table',zones:[{id:'ZONE-LETTER'}],cameras:[{id:'CAM-LETTER',zoneId:'ZONE-LETTER',from:'south doorway',looks:'north'}]}}});
  const snapshot={...blank.snapshot,...f.snapshot,instance:profile,scope:{...blank.snapshot.scope,storyScenes:1},productionModel:{...blank.snapshot.productionModel,...f.snapshot.productionModel,instance:profile},sourceHashes:{productionMapSha256:sha256(spatialSource)}};
  snapshot.productionModel.scenes=[{id:'OLD',title:'旧场',shotIds:[]}];snapshot.productionModel.systemModel={stateModel:{reviewContract:{schemaVersion:'2.2',actions:['APPROVE_AND_RELEASE','REQUEST_REVISION','DO_NOT_USE']}}};
  snapshot.productionModel.episodePlanRevisions=[{id:'plan:proposal',planId:f.candidate.subjectId,scopeRole:'PROPOSAL',revisionState:'PROPOSAL',revisionHash:f.candidate.baseRevisionHash,episodes:[{episodeUid:'episode:old',sceneIds:['OLD']}],retiredEpisodeUids:[]}];
  if(process.env.EPISODE_HTTP_QA==='1'){
    for(const episode of f.candidate.content.episodes){const claim=episode.reviewDossier.purpose.episodeTask;episode.reviewQuestion='本集行动是否清楚？';episode.reviewDossier.informationLayers.hiddenTruth.class='U';episode.reviewDossier.informationLayers.characterKnowledge=[{subjectId:'person:one',knowledge:claim}];episode.reviewDossier.progressionSlices=[{sliceId:episode.episodeUid+':seq:one',sequenceId:'seq:one',sequenceTitle:claim,sceneIds:episode.sceneIds,coverageRole:'EPISODE_SLICE',structuralRole:claim,turningPoint:claim,audienceGain:claim,outputState:claim}];}
    f.candidate.content.retiredEpisodeUids=['episode:old'];rehash(f.candidate);f.submission.subjectRevisionHash=f.candidate.contentHash;
    f.candidate.reviewSpec=api.resolveFormalReviewSpec(snapshot,'EPISODE_PLAN',f.candidate.creativeRevisionId);f.submission.reviewSpecHash=f.candidate.reviewSpec.hash;
  }
  if(demandBased){
    snapshot.productionModel.materialRequirements=[{id:'requirement:letter',requirementClass:'REQUIRED',requirementHash:hash('letter-demand'),assetFamilyRefs:['asset:letter'],entityRef:'entity:letter',stateRef:'state:letter',acceptanceCriteria:['可辨认的信件'],authorityClass:'A'}];
    snapshot.productionModel.domainGraph={entities:[{id:'entity:letter',type:'PROP',name:'信件',description:'旧纸来信',authority:'A',evidence:[]}],states:[{id:'state:letter',entityId:'entity:letter',dimensions:{visibility:'UNKNOWN'},authority:'U'}]};
    if(planningVersion==='3.0'){Object.assign(snapshot.productionModel.domainGraph,{schemaVersion:'1.0',representations:[],relations:[],requirements:[]});snapshot.productionModel.domainGraph.states[0].dimensions={};}
  }
  const tempParent=path.resolve('tests/.test-tmp');await mkdir(tempParent,{recursive:true});const root=await mkdtemp(path.join(tempParent,'episode-scope-'));
  const repo=await createInstanceRepository({dbPath:path.join(root,'instance.sqlite'),instanceId:profile.instanceId,profile});const compiler=episodeSourceCompiler(api);
  const append=async(kind,payload)=>{const {eventId,eventKind,eventSequence,recordedAt,requestHash,idempotencyKeyHash,...body}=payload;return repo.writeTransaction(async tx=>(await tx.appendEvent({kind,idempotencyKey:'test-'+eventId,requestHash:hash(body),eventSchemaVersion:body.schemaVersion,authorityDomain:'FORMAL',payload:body})).event);};
  let http;
  try {
    await repo.writeTransaction(async tx=>{
      const map=await tx.putDocument({documentId:'spatial:episode-scope-map',aliases:['data/production_map_spec.json'],expectedRevisionId:null,bytes:spatialSource,metadata:{sourceRole:'MACHINE_MODEL_SOURCE'}});
      assert.equal(map.sha256,snapshot.sourceHashes.productionMapSha256);
      await tx.publishRelease({snapshot,recipes:{...blank.recipes,snapshotId:snapshot.snapshotId},expectedReleaseId:null,sourceRevisionIds:[map.revisionId]});
    });
    let candidate=await append('creative-revision',{...f.candidate,eventId:'test:plan'});
    let submission=await append('episode-plan-submission',{...f.submission,eventId:'test:submission',subjectRevisionId:candidate.creativeRevisionId,creativeRevisionId:candidate.creativeRevisionId});
    if(process.env.EPISODE_HTTP_QA==='1'){
      http=await episodeHttp(repo,root);
      const candidateBody={schemaVersion:'2.0',snapshotId:snapshot.snapshotId,subjectKind:'EPISODE_PLAN',subjectId:candidate.subjectId,content:{...candidate.content,changeSummary:'自动沿用隔离验收'},baseRevisionHash:candidate.baseRevisionHash,basisBindings:candidate.basisBindings,authorityClass:'A',evidenceRefs:[],note:'自动沿用隔离验收'};
      candidate=(await http.post('/api/v8/creative-revisions',candidateBody)).event;
      const desk=await http.get('/api/v8/episode-plan-reviews?subjectRevisionId='+candidate.creativeRevisionId);
      assert.equal(desk.carryForwardOptions[0].state,'ELIGIBLE');
      assert.equal(desk.heads.length,1);assert.equal(desk.heads[0].automaticCarryForward,true);assert.deepEqual(desk.heads[0].criterionFindings,submission.criterionFindings);
      const beforeRead=await repo.readView();await http.get('/api/v8/episode-plan-reviews?subjectRevisionId='+candidate.creativeRevisionId);assert.deepEqual((await repo.readView()).eventsByKind,beforeRead.eventsByKind);
      candidate.reviewSpec=desk.heads[0].reviewSpec;
      const body={schemaVersion:'1.1',operation:'CARRY_FORWARD_EPISODE',snapshotId:snapshot.snapshotId,subjectRevisionId:candidate.creativeRevisionId,subjectRevisionHash:candidate.contentHash,contextHash:candidate.contextHash,criteriaVersion:'2.0',reviewSpecHash:candidate.reviewSpec.hash,episodeUid:submission.episodeUid,sourceSubmissionEventId:submission.eventId,reviewInputHash:desk.carryForwardOptions[0].reviewInputHash,supersedesEpisodeSubmissionEventId:desk.heads[0].eventId};
      await http.post('/api/v8/episode-plan-reviews',{...body,criterionFindings:submission.criterionFindings},400);
      const etag=(await http.get('/api/v8/operations/snapshot')).mutationEtag;
      submission=(await http.post('/api/v8/episode-plan-reviews',body)).event;
      await http.post('/api/v8/episode-plan-reviews',body,412,etag);
      assert.equal(submission.effect,'REVIEW_INPUT_ONLY');assert.equal(submission.operation,'CARRY_FORWARD_EPISODE');
      const releaseBody={schemaVersion:'1.0',operation:'FINALIZE_EPISODE',snapshotId:snapshot.snapshotId,subjectRevisionId:candidate.creativeRevisionId,subjectRevisionHash:candidate.contentHash,episodeUid:submission.episodeUid,episodeSubmissionEventId:submission.eventId,reviewSpecHash:candidate.reviewSpec.hash};
      await http.post('/api/v8/episode-plan-reviews/release',releaseBody,422);
    }
    const inputHash=api.episodeReviewInputHash(candidate,submission.episodeUid,submission.reviewSpecHash);
    const review=http?(await http.post('/api/v8/episode-plan-reviews/release',{schemaVersion:'1.0',operation:'FINALIZE_EPISODE',snapshotId:snapshot.snapshotId,subjectRevisionId:candidate.creativeRevisionId,subjectRevisionHash:candidate.contentHash,episodeUid:submission.episodeUid,episodeSubmissionEventId:submission.eventId,reviewSpecHash:candidate.reviewSpec.hash,confirmSceneScripts:true})).event:await append('review',{eventId:'test:episode-review',schemaVersion:'2.3',snapshotId:snapshot.snapshotId,subjectType:'EPISODE_NARRATIVE',subjectKind:'EPISODE_NARRATIVE',subjectId:submission.episodeUid,episodeUid:submission.episodeUid,scopeType:'EPISODE',scopeId:submission.episodeUid,subjectRevisionId:candidate.creativeRevisionId,creativeRevisionId:candidate.creativeRevisionId,parentCandidateHash:candidate.contentHash,subjectRevisionHash:inputHash,reviewInputHash:inputHash,episodeSubmissionEventId:submission.eventId,reviewSpecHash:submission.reviewSpecHash,criteriaVersion:'2.0',contextHash:hash({episodeUid:submission.episodeUid,reviewInputHash:inputHash,episodeSubmissionEventId:submission.eventId}),criterionFindings:submission.criterionFindings,action:'APPROVE_AND_RELEASE',note:submission.note,confirmSceneScripts:true,applicationStatus:'APPLIED',effect:'APPLIED',canFlowDownstream:false,sourceSyncRequired:true,sourceSyncState:'PENDING'});
    async function sync(reviewId,requestId){const view=await repo.readView(),input={expectedReleaseId:view.releaseId,reviewEventId:reviewId};const preview=await repo.readTransaction(tx=>compiler.preview(tx,input));const manifest={...input,previewHash:preview.previewHash,requestId};await assert.rejects(repo.writeTransaction(tx=>compiler.apply(tx,{...manifest,previewHash:hash('wrong')})));const result=await repo.writeTransaction(tx=>compiler.apply(tx,manifest));assert.deepEqual(await repo.writeTransaction(tx=>compiler.apply(tx,manifest)),result);return result;}
    await sync(review.eventId,'episode-sync-test');
    let view=await repo.readView(),state=compiler.stateFor(view);
    assert.equal(state.episodeNarrativeReleasesByUid['episode:1'].canFlowDownstream,true);
    assert.equal(state.episodeNarrativeReleasesByUid['episode:2'],undefined);
    assert.equal(view.snapshot.productionModel.revisionPointers.currentEpisodePlanRevisionId,undefined);
    assert.equal(view.eventsByKind.review.filter(e=>e.subjectType==='SCRIPT_SCENE').length,0);
    assert.deepEqual(view.snapshot.productionModel.scenes.map(s=>s.id),['OLD']);
    const release=state.episodeNarrativeReleasesByUid['episode:1'],scene=release.reviewInput.scenes[0],script=view.snapshot.productionModel.sceneScriptRevisions.find(r=>r.sceneId===scene.id);
    const coverageContent={sceneId:scene.id,beats:[{beatId:scene.id+'-B001',order:1,narrativeBeat:'读取来信',audienceTakeaway:'得知消息',visualIntent:'展开信件',actionIntent:'读信',soundIntent:'环境静音',dialogueContext:'无对白',materialRequirementRefs:demandBased?['requirement:letter']:[]}]};
    const coverageBindings=[{bindingType:'CONTINUITY_SPEC',bindingId:'PRODUCTION-MAP-SPEC',bindingHash:snapshot.sourceHashes.productionMapSha256},{bindingType:'EPISODE_NARRATIVE_RELEASE',bindingId:release.id,bindingHash:release.contentHash,scopeType:'EPISODE',scopeId:release.episodeUid},{bindingType:'SCENE_SCRIPT_REVISION',bindingId:script.id,bindingHash:script.contentHash,scopeType:'SCENE',scopeId:scene.id}];
    async function planning(kind,content,bindings,id){const v=await repo.readView(),key=kind==='SCENE_COVERAGE'?'sceneCoveragePlanRevisions':'shotPlanSetRevisions',row=v.snapshot.productionModel[key].find(r=>r.scopeId===scene.id);content=api.canonicalSceneScopedContent(v.snapshot,kind,row.planId,content,bindings,kind==='SHOT_PLAN_SET'?planningVersion:undefined);if(http)return (await http.post('/api/v8/creative-revisions',{schemaVersion:'2.0',snapshotId:v.snapshot.snapshotId,subjectKind:kind,subjectId:row.planId,content,baseRevisionHash:row.revisionHash,basisBindings:bindings,...(kind==='SHOT_PLAN_SET'&&planningVersion==='3.0'?{planningContractVersion:planningVersion,materialRequirementSetSchemaVersion:requirementSchema}:{}),authorityClass:'A',evidenceRefs:[],note:'隔离测试候选'})).event;const payload={eventId:id,schemaVersion:'2.0',snapshotId:v.snapshot.snapshotId,creationSnapshotId:v.snapshot.snapshotId,creativeRevisionId:id,revisionId:id,subjectKind:kind,subjectId:row.planId,scopeType:'SCENE',scopeId:scene.id,content,contentHash:hash(content),baseRevisionHash:row.revisionHash,basisBindings:bindings,basisBindingsHash:hash(bindings),revisionState:'CANDIDATE',adoptionPerformed:false,scopedReviewSpec:api.scopedPlanningReviewSpec(kind,kind==='SHOT_PLAN_SET'?planningVersion:'1.0')};if(kind==='SHOT_PLAN_SET'){if(demandBased)Object.assign(payload,{planningContractVersion:planningVersion,materialRequirementSet:api.deriveCurrentMaterialRequirementSet(v.snapshot,scene.id,requirementSchema),adoptedMaterialSet:null});else payload.adoptedMaterialSet=api.deriveCurrentAdoptedMaterialSet(v.snapshot,compiler.stateFor(v),scene.id);}payload.contextHash=hash({subjectKind:kind,subjectId:row.planId,baseRevisionHash:row.revisionHash,basisBindingsHash:payload.basisBindingsHash,...(kind==='SHOT_PLAN_SET'&&planningVersion==='3.0'?{planningContractVersion:planningVersion}:{})});api.assertCreativeRevisionBasisCurrent(v.snapshot,compiler.stateFor(v),payload);return append('creative-revision',payload);}
    async function approve(c){const v=await repo.readView();if(http)return (await http.post('/api/v8/reviews',{schemaVersion:'2.2',snapshotId:v.snapshot.snapshotId,subjectType:'CREATIVE_REVISION',subjectKind:c.subjectKind,subjectId:c.subjectId,subjectRevisionId:c.creativeRevisionId,subjectRevisionHash:c.contentHash,contextHash:c.contextHash,scopeType:'SCENE',scopeId:scene.id,reviewSpecHash:c.scopedReviewSpec.hash,criterionFindings:c.scopedReviewSpec.criteria.map(x=>({criterionId:x.id,verdict:'PASS',note:'隔离测试'})),action:'APPROVE_AND_RELEASE',note:'隔离测试'})).event;return append('review',{eventId:'review:'+c.creativeRevisionId,schemaVersion:'2.2',snapshotId:v.snapshot.snapshotId,subjectType:'CREATIVE_REVISION',subjectKind:c.subjectKind,subjectId:c.subjectId,subjectRevisionId:c.creativeRevisionId,creativeRevisionId:c.creativeRevisionId,subjectRevisionHash:c.contentHash,baseRevisionHash:c.baseRevisionHash,basisBindings:c.basisBindings,basisBindingsHash:c.basisBindingsHash,scopeType:'SCENE',scopeId:scene.id,contextHash:c.contextHash,reviewSpecHash:c.scopedReviewSpec.hash,criterionFindings:c.scopedReviewSpec.criteria.map(x=>({criterionId:x.id,verdict:'PASS',note:'合成隔离验收'})),action:'APPROVE_AND_RELEASE',note:'合成隔离验收',reviewDecision:'RELEASED',lifecycleState:'RELEASED',adoptionIntent:'ADOPT_THIS_REVISION',internalDownstreamEligibility:'INELIGIBLE_PENDING_SOURCE_SYNC',canFlowDownstream:false,sourceSyncRequired:true,sourceSyncState:'PENDING',applicationStatus:'APPLIED',effect:'APPLIED'});}
    const coverage=await planning('SCENE_COVERAGE',coverageContent,coverageBindings,'cr:coverage');const coverageReview=await approve(coverage);
    view=await repo.readView();assert.notEqual(compiler.stateFor(view).scopeLocksById['SCOPE-LOCK:SHOT-PLAN-SET:'+scene.id].lockState,'READY_TO_LOCK');
    await sync(coverageReview.eventId,'coverage-sync-test');
    view=await repo.readView();state=compiler.stateFor(view);assert.equal(state.scopeLocksById['SCOPE-LOCK:SHOT-PLAN-SET:'+scene.id].lockState,'READY_TO_LOCK');
    if(demandBased)assert.throws(()=>api.deriveCurrentAdoptedMaterialSet(view.snapshot,state,scene.id),/素材/);
    const materials=demandBased?api.deriveCurrentMaterialRequirementSet(view.snapshot,scene.id,requirementSchema):api.deriveCurrentAdoptedMaterialSet(view.snapshot,state,scene.id),shotBindings=[{bindingType:demandBased?'MATERIAL_REQUIREMENT_SET':'ADOPTED_MATERIAL_SET',bindingId:materials.id,bindingHash:materials.contentHash,scopeType:'SCENE',scopeId:scene.id},{bindingType:'SCENE_COVERAGE_REVISION',bindingId:coverage.creativeRevisionId,bindingHash:coverage.contentHash,scopeType:'SCENE',scopeId:scene.id}];
    const shotContent={sceneId:scene.id,identityChangeReason:'首个正式镜头',shots:[{shotId:scene.id+'-SH001',sceneId:scene.id,order:1,title:'读信',coverageBeatRefs:[scene.id+'-B001'],narrativeBeat:'读信',audienceTakeaway:'得知消息',visualIntent:'读信',actionIntent:'读信',soundIntent:'静音',dialogueContext:'无对白',materialRequirementRefs:demandBased?['requirement:letter']:[],inputBindings:shotBindings}]};
    if(planningVersion==='3.0')shotContent.shots[0].design={shotSize:'CLOSE_UP',cameraAngle:'EYE_LEVEL',cameraMovement:'STATIC',composition:'旧信纸铺在桌面',performance:'迟疑后读信',lighting:'窗侧自然光',estimatedDurationSeconds:4,subjectIds:['entity:letter'],continuity:{startState:'信纸未展开',endState:'信纸摊平',previousShotId:null,nextShotId:null,transitionIn:'本场开始',transitionOut:'本场结束'},keyframeStrategy:{mode:'START_END',reason:'明确打开信纸的两个状态',intermediateFrameCount:0}};
    if(demandBased){
      const omitted=structuredClone(shotContent);omitted.shots[0].materialRequirementRefs=[];
      assert.throws(()=>api.canonicalSceneScopedContent(view.snapshot,'SHOT_PLAN_SET','SHOT-PLAN-SET:'+scene.id,omitted,shotBindings,planningVersion),/完整覆盖/);
    }
    const shot=await planning('SHOT_PLAN_SET',shotContent,shotBindings,'cr:shot-plan'),shotReview=await approve(shot);await sync(shotReview.eventId,'shot-plan-sync-test');
    view=await repo.readView();state=compiler.stateFor(view);assert.equal(state.scopeLocksById['SCOPE-LOCK:SHOT-PLAN-SET:'+scene.id].lockState,'LOCKED');assert.equal(view.snapshot.productionModel.shots.length,1);assert.equal(state.episodeNarrativeReleasesByUid['episode:2'],undefined);
    const historicalContexts=await repo.readTransaction(tx=>captureHistoricalEventContexts(tx,{events:Object.values(view.eventsByKind).flat(),instanceId:view.instanceId}));
    const frozen=()=>{const events=Object.values(view.eventsByKind).flat();return {events,snapshot:view.snapshot,historicalContexts,binding:{historicalContextsHash:historicalContexts.contextsHash,...{releaseId:view.releaseId,snapshotId:view.snapshot.snapshotId,snapshotSha256:digest(JSON.stringify(view.snapshot)),snapshotCanonicalSha256:digest(view.snapshot),eventManifest:frozenEventManifest(events)}}};};
    validateModernEventClosure(frozen(),runtime);
    await afterSync?.({repo,view,shot,scene,api,compiler,historicalContexts,frozen});
    if(demandBased){
      const liveShot=view.snapshot.productionModel.shots[0];assert.equal(liveShot.canGenerate,false);assert.equal(liveShot.canFlowDownstream,false);assert.deepEqual(liveShot.inputBindings,[]);
      assert.equal(shot.scopedReviewSpec.schemaVersion,planningVersion);
      assert.equal(shot.materialRequirementSet.schemaVersion,requirementSchema);
      if(planningVersion==='3.0')assert.throws(()=>api.assertCreativeRevisionBasisCurrent(view.snapshot,state,{...shot,planningContractVersion:'2.0'},{requireCurrentPredecessor:false}),/语义基线 V3/);
      assert.notEqual(shot.scopedReviewSpec.hash,api.scopedPlanningReviewSpec('SHOT_PLAN_SET','1.0').hash);
      for(const mutate of [
        d=>{d.productionModel.materialRequirements[0].requirementHash=hash('changed requirement');},
        d=>{d.productionModel.domainGraph.states[0].dimensions.visibility='OPEN';},
        d=>{d.productionModel.domainGraph.entities[0].description='更换信纸生产定义';},
        d=>{d.productionModel.materialRequirements[0].requirementClass='EVIDENCE_ONLY';},
      ]){const changed=structuredClone(view.snapshot);mutate(changed);assert.throws(()=>api.assertCreativeRevisionBasisCurrent(changed,state,shot,{requireCurrentPredecessor:false}));}
      const produced=structuredClone(view.snapshot);produced.productionModel.materialRequirements[0].coveredByVersionRefs=['asset:letter@new'];produced.productionModel.materialRequirements[0].coverageSatisfied=true;
      if(planningVersion!=='3.0')produced.productionModel.domainGraph.entities[0].canvasPosition={x:300,y:200};
      assert.deepEqual(api.deriveCurrentMaterialRequirementSet(produced,scene.id,requirementSchema),shot.materialRequirementSet);
    }
    const documents=await repo.readTransaction(async tx=>Promise.all(view.sourceRevisionIds.map(id=>tx.readDocumentRevision(id))));
    const preserved=preserveScopedProductionProjection({snapshot,baseSnapshot:view.snapshot,documents,events:frozen().events});
    assert.deepEqual(preserved.productionModel.episodeNarrativeReleases,view.snapshot.productionModel.episodeNarrativeReleases);
    assert.equal(compiler.stateFor({...view,snapshot:preserved}).episodeNarrativeReleasesByUid['episode:1'].canFlowDownstream,true);
    const forged=structuredClone(view.snapshot);forged.productionModel.shots[0].visualIntent='绕过正式镜头计划修改';
    assert.throws(()=>preserveScopedProductionProjection({snapshot,baseSnapshot:forged,documents,events:frozen().events}));
    assert.throws(()=>preserveScopedProductionProjection({snapshot,baseSnapshot:view.snapshot,documents:[],events:frozen().events}));
    for(const mutate of [e=>{e.operationType='WRONG';},e=>{e.effect='RECORDED';},e=>{e.newBlockHashes={};},e=>{e.transactionProof.snapshotSha256='WRONG';}]){
      const f=frozen(),op=f.events.find(e=>e.protocol==='SCOPED_SCENE_DATABASE_COMPILER_V1');const old=structuredClone(op);mutate(op);f.binding.eventManifest=frozenEventManifest(f.events);assert.throws(()=>validateModernEventClosure(f,runtime));Object.assign(op,old);
    }
    if(http){const ready=await http.get('/api/v8/episode-production?episodeUid=episode:1&sceneId='+scene.id);assert.equal(ready.formalShotCount,1);await http.get('/api/v8/ui/production?scopeType=SCENE&scopeId='+scene.id);}
    const changed=nextCandidate(candidate);changed.content.episodes[0].coreAdvance='本集改写';rehash(changed);await append('creative-revision',{...changed,eventId:'test:changed'});
    view=await repo.readView();state=compiler.stateFor(view);assert.equal(state.episodeNarrativeReleasesByUid['episode:1'].canFlowDownstream,false);assert.equal(state.structuresById['SHOT_PLAN_SET::SHOT-PLAN-SET:'+scene.id],undefined);
  } finally {await http?.stop();await repo.close();await rm(root,{recursive:true,force:true});}
}
test('isolated database: V1 one episode release, coverage sync and shot plan lock without whole-plan adoption',()=>exerciseEpisodeScope('1.0'));
test('isolated database: V2 adopts complete shot design with missing actual media but keeps generation closed',()=>exerciseEpisodeScope('2.0'));

test('isolated database: explicit V3 semantic demand basis survives exact source sync and preserves estimated design boundaries',()=>exerciseEpisodeScope('3.0'));
