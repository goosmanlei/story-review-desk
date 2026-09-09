import {isRequirementDrivenPlanningVersion} from './shot-design-contract.mjs';
import {canonicalJson,sha256} from './bytes.mjs';
import {domainHash} from './domain-model.mjs';

const episodeProtocol='EPISODE_DATABASE_COMPILER_V1';
const sceneProtocol='SCOPED_SCENE_DATABASE_COMPILER_V1';
const fail=message=>{throw Object.assign(new Error(message),{code:'DOMAIN_CONFLICT'});};
const decoded=record=>record?JSON.parse(record.bytes):null;
const events=(view,kind)=>view.eventsByKind?.[kind]||[];

/** The installed application's real validators are injected by the host CLI.
 * No web process writes source; the database transaction owns CAS, recovery,
 * immutable source bytes, the published projection and the completion journal.
 */
export function episodeSourceCompiler(api) {
  function stateFor(view) {
    const data=view.snapshot,reviews=events(view,'review'),candidates=events(view,'creative-revision'),ops=events(view,'source-operation');
    const media=api.projectOperationalState(data,reviews,events(view,'asset-version'),events(view,'run'),ops,events(view,'execution-request'),{executionDefinitions:view.recipes?.executionDefinitions||[]});
    const releases=api.projectEpisodeNarrativeReleases(data,candidates,reviews,events(view,'episode-plan-submission'),ops);
    const scriptScenesById=Object.fromEntries(api.projectedReviewIndexes(data,reviews,events(view,'asset-version'),ops).bySubject.filter(r=>r.event.subjectType==='SCRIPT_SCENE').map(({projection,event})=>[String(event.subjectId),{...projection,subjectId:event.subjectId,subjectRevisionHash:event.subjectRevisionHash,contextHash:event.businessContextHash||event.contextHash,source:'APPLIED_SCRIPT_SCENE_REVIEW_EVENT_PROJECTION'}]));
    const base={...media,scriptScenesById,episodeNarrativeReleasesByUid:releases};
    const toMap=index=>Object.fromEntries(index.bySubject.map(r=>[r.aggregateId,{...r.projection,event:r.event}]));
    const prerequisites=toMap(api.projectedStructureReviewIndexes(data,reviews.filter(e=>e.subjectKind!=='SHOT_PLAN_SET'),candidates,ops,base));
    const withCoverage={...base,structuresById:prerequisites,scopeLocksById:api.projectedScopeLocks(data,prerequisites)};
    const structures=toMap(api.projectedStructureReviewIndexes(data,reviews,candidates,ops,withCoverage));
    return {...withCoverage,structuresById:structures,scopeLocksById:api.projectedScopeLocks(data,structures)};
  }

  async function context(tx,input) {
    const view=await tx.readView();
    if(view.releaseId!==input.expectedReleaseId)fail('实例发布版本已变化，请重新预览');
    const candidates=events(view,'creative-revision'),reviews=events(view,'review'),submissions=events(view,'episode-plan-submission');
    const review=reviews.find(e=>e.eventId===input.reviewEventId);
    if(!review||review.action!=='APPROVE_AND_RELEASE'||review.applicationStatus!=='APPLIED'||review.effect!=='APPLIED'||review.sourceSyncRequired!==true||review.sourceSyncState!=='PENDING')fail('必须提供已正式通过且待同步的精确审阅');
    if(events(view,'source-operation').some(e=>e.reviewEventId===review.eventId&&e.operationState==='SUCCEEDED'))fail('本次正式审阅已经完成源同步');
    const candidate=candidates.find(e=>e.creativeRevisionId===review.creativeRevisionId);
    if(!candidate||domainHash(candidate.content)!==candidate.contentHash)fail('受审候选内容不完整');
    const state=stateFor(view);
    if(review.subjectType==='EPISODE_NARRATIVE') {
      const verified=api.assertEpisodeNarrativeReview(review,candidates,submissions);
      const latest=candidates.find(e=>e.subjectKind==='EPISODE_PLAN'&&e.subjectId===candidate.subjectId);
      if(!latest||api.episodeReviewInputHash(latest,review.episodeUid,api.candidateReviewSpec(view.snapshot,latest).hash)!==review.reviewInputHash)fail('当前候选的本集材料已经变化，不能同步旧结论');
      if(reviews.find(e=>e.subjectType==='EPISODE_NARRATIVE'&&e.episodeUid===review.episodeUid)?.eventId!==review.eventId)fail('本集正式结论已经更新');
      api.assertCreativeRevisionBasisCurrent(view.snapshot,state,latest,{requireCurrentPredecessor:true});
      return {view,review,candidate,state,inputContent:verified.input,protocol:episodeProtocol,scopeId:review.episodeUid,subjectKind:'EPISODE_NARRATIVE'};
    }
    if(review.subjectType!=='CREATIVE_REVISION'||!['SCENE_COVERAGE','SHOT_PLAN_SET'].includes(review.subjectKind)||review.scopeType!=='SCENE'||candidate.content.sceneId!==review.scopeId)fail('仅支持本集叙事及其场级镜头意图／镜头计划同步');
    const row=(review.subjectKind==='SCENE_COVERAGE'?view.snapshot.productionModel.sceneCoveragePlanRevisions:view.snapshot.productionModel.shotPlanSetRevisions)?.find(r=>r.planId===review.subjectId);
    const owner=Object.values(state.episodeNarrativeReleasesByUid).find(r=>r.canFlowDownstream&&r.reviewInput.scenes.some(s=>s.id===review.scopeId));
    if(!row||!owner||!row.episodeNarrativeReleaseId)fail('本场不属于当前已发布的独立分集范围');
    if(reviews.find(e=>e.subjectType==='CREATIVE_REVISION'&&e.subjectKind===review.subjectKind&&e.subjectId===review.subjectId)?.eventId!==review.eventId)fail('场级正式结论已经更新');
    if(candidate.contentHash!==review.subjectRevisionHash||candidate.contextHash!==review.contextHash||candidate.basisBindingsHash!==review.basisBindingsHash)fail('场级正式审阅与候选不匹配');
    api.assertScopedPlanningFindings(candidate,review.criterionFindings,review.reviewSpecHash);
    api.assertCreativeRevisionBasisCurrent(view.snapshot,state,candidate,{requireCurrentPredecessor:true});
    return {view,review,candidate,state,inputContent:candidate.content,protocol:sceneProtocol,scopeId:review.scopeId,subjectKind:review.subjectKind,owner};
  }

  async function preview(tx,input) {
    const c=await context(tx,input);
    const body={schemaVersion:'1.0',protocol:c.protocol,expectedReleaseId:c.view.releaseId,reviewEventId:c.review.eventId,creativeRevisionId:c.candidate.creativeRevisionId,candidateContentHash:c.candidate.contentHash,subjectKind:c.subjectKind,scopeId:c.scopeId,inputHash:domainHash(c.inputContent),previousPublishedScopeIds:(c.view.snapshot.productionModel.episodeNarrativeReleases||[]).filter(r=>r.scopeRole==='CURRENT').map(r=>r.id).sort()};
    return {...body,previewHash:domainHash(body),checks:['只同步所审永久集／场的精确内容','其他集不因此采用，旧场号不换绑','素材、镜头生成与各阶段独立门禁保留','数据库原子发布与追加完成记录；不改媒体']};
  }

  async function apply(tx,input) {
    if(typeof input.requestId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(input.requestId))fail('缺少稳定幂等请求身份');
    const requestHash=domainHash(input),prior=decoded(await tx.getAux('episode-source-sync',input.requestId));
    if(prior){if(prior.requestHash!==requestHash)fail('幂等身份已用于其他内容');return prior.result;}
    const planned=await preview(tx,input);if(planned.previewHash!==input.previewHash)fail('同步预览已变化');
    const c=await context(tx,input),{view,review,candidate}=c;
    const operationId=`sop_${domainHash({requestId:input.requestId,previewHash:planned.previewHash}).slice(0,32)}`;
    const sourcePath=`story/scoped-releases/${c.subjectKind.toLowerCase()}/${domainHash(c.scopeId).slice(0,24)}/${operationId}.json`;
    const sourceBody={schemaVersion:'1.0',protocol:c.protocol,scopeId:c.scopeId,subjectKind:c.subjectKind,creativeRevisionId:candidate.creativeRevisionId,candidateContentHash:candidate.contentHash,reviewEventId:review.eventId,content:c.inputContent,contentHash:domainHash(c.inputContent)};
    const source=await tx.putDocument({documentId:`scoped-source:${operationId}`,aliases:[sourcePath],expectedRevisionId:null,bytes:canonicalJson(sourceBody),mediaType:'application/json',metadata:{sourceRole:'ADOPTED_SCOPED_CREATIVE_SOURCE',protocol:c.protocol,sourceOperationId:operationId}});
    const snapshot=structuredClone(view.snapshot),model=snapshot.productionModel;
    let record;
    if(c.protocol===episodeProtocol) {
      const id=`ENR-${domainHash({reviewEventId:review.eventId,inputHash:planned.inputHash}).slice(0,32)}`;
      record={id,episodeUid:review.episodeUid,creativeRevisionId:candidate.creativeRevisionId,candidateContentHash:candidate.contentHash,contentHash:planned.inputHash,reviewInput:c.inputContent,reviewEventId:review.eventId,sourceOperationId:operationId,sourceRevisionId:source.revisionId,sourceSha256:source.sha256,sourcePath,scopeRole:'CURRENT',sourceSyncState:'SOURCE_CURRENT',protocol:c.protocol};
      record.episodeScriptReleaseSnapshot=api.episodeScriptReleaseSnapshot(record);
      model.episodeNarrativeReleases=[record,...(model.episodeNarrativeReleases||[]).map(r=>r.episodeUid===review.episodeUid?{...r,scopeRole:'EVIDENCE_ONLY'}:r)];
      for(const scene of c.inputContent.scenes) {
        const scriptId=`NSR-${domainHash({sceneId:scene.id,contentHash:scene.contentHash,episodeNarrativeReleaseId:id}).slice(0,32)}`;
        model.sceneScriptRevisions=[{id:scriptId,sceneId:scene.id,contentHash:scene.contentHash,revisionHash:scene.contentHash,episodeNarrativeReleaseId:id,scopeRole:'CURRENT',revisionState:'CURRENT',isCurrent:true,sourcePath,sourceRevisionId:source.revisionId,sourceSha256:source.sha256,releaseSource:'EPISODE_NARRATIVE',parentReviewEventId:review.eventId},...(model.sceneScriptRevisions||[]).filter(r=>r.id!==scriptId).map(r=>r.sceneId===scene.id?{...r,scopeRole:'EVIDENCE_ONLY',isCurrent:false}:r)];
        for(const [key,kind,prefix,content] of [['sceneCoveragePlanRevisions','SCENE_COVERAGE','SCENE-COVERAGE-PLAN',{sceneId:scene.id,beats:[]}],['shotPlanSetRevisions','SHOT_PLAN_SET','SHOT-PLAN-SET',{sceneId:scene.id,identityChangeReason:'',shots:[]}]]) {
          const old=(model[key]||[]).find(r=>r.scopeId===scene.id&&r.scopeRole==='CURRENT');
          // Preserve an already synced identical scene's immutable plan. Its
          // exact upstream release binding still controls applicability.
          if(old)continue;
          const baseHash=domainHash(content),planId=`${prefix}:${scene.id}`;
          const seed={id:`BASE-${domainHash({planId,episodeNarrativeReleaseId:id}).slice(0,32)}`,planId,subjectKind:kind,scopeType:'SCENE',scopeId:scene.id,sceneId:scene.id,episodeUid:review.episodeUid,episodeNarrativeReleaseId:id,content,contentHash:baseHash,revisionHash:baseHash,scopeRole:'PROPOSAL',revisionState:'PROPOSAL',isCurrent:false,review:{state:'PENDING'},sourceSyncState:'NOT_REQUIRED'};
          model[key]=[seed,...(model[key]||[]).map(r=>r.planId===planId?{...r,scopeRole:'EVIDENCE_ONLY',isCurrent:false}:r)];
        }
        const lockId=`SCOPE-LOCK:SHOT-PLAN-SET:${scene.id}`;
        if(!(model.scopeLocks||[]).some(r=>r.id===lockId))model.scopeLocks=[...(model.scopeLocks||[]),{id:lockId,scopeType:'SCENE',scopeId:scene.id,episodeUid:review.episodeUid,lockPurpose:'SHOT_PLAN_SET',lockState:'UNKNOWN',scopeLockState:'UNKNOWN',denominatorState:'UNKNOWN',expectedCount:null,discoveredCount:0}];
      }
    } else {
      const id=candidate.creativeRevisionId;
      record={id,revisionId:id,creativeRevisionId:id,adoptedCreativeRevisionId:id,adoptedCreativeRevisionHash:candidate.contentHash,planId:candidate.subjectId,subjectKind:c.subjectKind,scopeType:'SCENE',scopeId:c.scopeId,sceneId:c.scopeId,episodeUid:c.owner.episodeUid,episodeNarrativeReleaseId:c.owner.id,content:candidate.content,contentHash:candidate.contentHash,revisionHash:candidate.contentHash,basisBindings:candidate.basisBindings,basisBindingsHash:candidate.basisBindingsHash,adoptedMaterialSet:candidate.adoptedMaterialSet||null,...(isRequirementDrivenPlanningVersion(candidate.planningContractVersion)?{planningContractVersion:candidate.planningContractVersion,materialRequirementSet:candidate.materialRequirementSet,scopedReviewSpec:candidate.scopedReviewSpec,adoptionScope:'SHOT_DESIGN_ONLY'}:{}),contextHash:candidate.contextHash,reviewEventId:review.eventId,sourceOperationId:operationId,sourceRevisionId:source.revisionId,sourceSha256:source.sha256,sourcePath,protocol:c.protocol,scopeRole:'CURRENT',revisionState:'CURRENT',status:'CURRENT',isCurrent:true,sourceSyncState:'SUCCEEDED',sync:{state:'SUCCEEDED',protocol:c.protocol,sourceOperationId:operationId},review:{state:'ADOPTED',reviewEventId:review.eventId}};
      const key=c.subjectKind==='SCENE_COVERAGE'?'sceneCoveragePlanRevisions':'shotPlanSetRevisions';
      model[key]=[record,...(model[key]||[]).filter(r=>r.id!==id).map(r=>r.planId===candidate.subjectId?{...r,scopeRole:'EVIDENCE_ONLY',isCurrent:false}:r)];
      if(c.subjectKind==='SHOT_PLAN_SET') {
        const shotIds=candidate.content.shots.map(s=>s.shotId);
        const priorRows=(view.snapshot.productionModel.shotPlanSetRevisions||[]).filter(r=>r.scopeId===c.scopeId);
        const retiredShotIds=[...new Set([...priorRows.flatMap(r=>r.retiredShotIds||[]),...priorRows.filter(r=>r.scopeRole==='CURRENT').flatMap(r=>r.shotIds||[]).filter(s=>!shotIds.includes(s))])];
        Object.assign(record,{shotIds,retiredShotIds,denominatorState:'KNOWN',denominator:shotIds.length});
        model.shots=[...(model.shots||[]).filter(s=>!shotIds.includes(s.id)).map(s=>s.sceneId===c.scopeId?{...s,scopeRole:'EVIDENCE_ONLY',activeInCurrentProduction:false}:s),...candidate.content.shots.map(s=>({...s,planningBasisBindings:s.inputBindings,inputBindings:[],inputLockState:'READY_TO_LOCK',...(isRequirementDrivenPlanningVersion(candidate.planningContractVersion)?{planningContractVersion:candidate.planningContractVersion,adoptionScope:'SHOT_DESIGN_ONLY',canGenerate:false}:{}),canFlowDownstream:false,flowBlockReasons:['SHOT_EXACT_INPUT_LOCK_REQUIRED'],locs:[],zones:[],cameras:[],characters:[],stageInstanceRefs:[],issueRefs:[],durationStatus:'UNKNOWN',branch:'UNKNOWN',reviewContext:null,id:s.shotId,episodeUid:c.owner.episodeUid,episodeId:c.owner.episodeUid,shotPlanSetRevisionId:id,shotPlanSetRevisionHash:candidate.contentHash,scopeRole:'CURRENT',activityRole:'SHOT_PLANNING',activeInCurrentProduction:true,workPackageRefs:[]}))];
        model.scopeLocks=(model.scopeLocks||[]).map(lock=>lock.scopeType==='SCENE'&&lock.scopeId===c.scopeId&&lock.lockPurpose==='SHOT_PLAN_SET'?{...lock,lockState:'LOCKED',scopeLockState:'LOCKED',denominatorState:'KNOWN',denominator:shotIds.length,expectedCount:shotIds.length,discoveredCount:shotIds.length,shotIds,shotPlanSetRevisionId:id,shotPlanSetRevisionHash:candidate.contentHash}:lock);
      }
    }
    const proof={protocol:c.protocol,sourceOperationId:operationId,reviewEventId:review.eventId,creativeRevisionId:candidate.creativeRevisionId,reviewInputHash:planned.inputHash,sourceRevisionId:source.revisionId,sourceSha256:source.sha256,releaseRecordHash:domainHash(record)};
    snapshot.snapshotId=`snapshot_${domainHash(proof).slice(0,32)}`;
    const recipes={...view.recipes,snapshotId:snapshot.snapshotId};snapshot.executionRecipeSummary=recipes;
    const release=await tx.publishRelease({snapshot,recipes,sourceRevisionIds:[...view.sourceRevisionIds,source.revisionId],expectedReleaseId:view.releaseId});
    const impact={reviewEventId:review.eventId,creativeRevisionId:candidate.creativeRevisionId,subjectKind:c.subjectKind,subjectRevisionHash:planned.inputHash,basisBindingsHash:candidate.basisBindingsHash};
    const event=await tx.appendEvent({kind:'source-operation',idempotencyKey:input.requestId,requestHash,eventSchemaVersion:'2.0',authorityDomain:'FORMAL',payload:{schemaVersion:'2.0',sourceOperationId:operationId,operationType:'CREATIVE_REVISION_SYNC',operationState:'SUCCEEDED',state:'SUCCEEDED',protocol:c.protocol,snapshotId:snapshot.snapshotId,baseSnapshotId:view.snapshot.snapshotId,newSnapshotId:snapshot.snapshotId,resultReleaseId:release.releaseId,...impact,impact,transactionProof:{...proof,snapshotSha256:sha256(canonicalJson(snapshot))},sourcePaths:[sourcePath],newBlockHashes:{[sourcePath]:source.sha256},applicationStatus:'APPLIED',effect:'APPLIED'}});
    const result={state:'SOURCE_CURRENT',releaseId:release.releaseId,snapshotId:snapshot.snapshotId,sourceOperationId:operationId,sourceOperationEventId:event.event.eventId,subjectKind:c.subjectKind,scopeId:c.scopeId,recordId:record.id,wholePlanAdopted:false,mediaChanged:false};
    await tx.putAux({namespace:'episode-source-sync',key:input.requestId,bytes:canonicalJson({state:'COMPLETED',requestHash,previousReleaseId:view.releaseId,preview:planned,result}),expectedRevisionId:null});
    return result;
  }
  return {preview,apply,stateFor};
}
