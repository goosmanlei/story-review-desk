import {canonicalJson,sha256} from './bytes.mjs';
import {domainHash} from './domain-model.mjs';
const fail=message=>{throw Object.assign(new Error(message),{code:'SCOPED_SOURCE_CONFLICT'});};

export function assertScopedShotProjections(model){
  const releases=model.episodeNarrativeReleases||[],parents=new Map(releases.map(r=>[r.id,r]));
  for(const script of (model.sceneScriptRevisions||[]).filter(r=>r.episodeNarrativeReleaseId)){
    const parent=parents.get(script.episodeNarrativeReleaseId),binding=parent?.episodeScriptReleaseSnapshot?.orderedSceneBindings.find(s=>s.sceneId===script.sceneId);
    if(!parent||!binding||binding.sceneScriptRevisionId!==script.id||binding.sceneContentHash!==script.contentHash||script.revisionHash!==script.contentHash
      ||script.sourcePath!==parent.sourcePath||script.sourceRevisionId!==parent.sourceRevisionId||script.sourceSha256!==parent.sourceSha256||script.parentReviewEventId!==parent.reviewEventId||script.releaseSource!=='EPISODE_NARRATIVE')fail('场正文发布行与本集精确清单不一致');
  }
  for(const plan of [...(model.sceneCoveragePlanRevisions||[]),...(model.shotPlanSetRevisions||[])].filter(r=>r.episodeNarrativeReleaseId)){
    const parent=parents.get(plan.episodeNarrativeReleaseId);
    if(!parent||!parent.reviewInput.scenes.some(s=>s.id===plan.sceneId)||plan.scopeId!==plan.sceneId||plan.scopeType!=='SCENE'||plan.episodeUid!==parent.episodeUid)fail('场计划归属未绑定精确集发布');
    if(!plan.sourceOperationId){
      const content=plan.subjectKind==='SCENE_COVERAGE'?{sceneId:plan.sceneId,beats:[]}:{sceneId:plan.sceneId,identityChangeReason:'',shots:[]};
      if(plan.id!=='BASE-'+domainHash({planId:plan.planId,episodeNarrativeReleaseId:parent.id}).slice(0,32)||domainHash(plan.content)!==domainHash(content)||plan.revisionHash!==domainHash(content)||plan.isCurrent!==false)fail('空场计划种子不是精确派生记录');
    }
  }
  for(const plan of (model.shotPlanSetRevisions||[]).filter(r=>r.episodeNarrativeReleaseId&&r.sourceOperationId)){
    const actual=(model.shots||[]).filter(s=>s.shotPlanSetRevisionId===plan.id);
    // Superseded shots may have a successor with the same permanent identity;
    // current plans, however, must retain their exact full set.
    if(plan.scopeRole==='CURRENT'&&domainHash(actual.map(s=>s.id).sort())!==domainHash(plan.content.shots.map(s=>s.shotId).sort()))fail('当前镜头计划与运行镜头集合不一致');
    for(const shot of actual){
      const spec=plan.content.shots.find(s=>s.shotId===shot.id);if(!spec)fail('运行镜头不属于其精确计划');
      if(plan.planningContractVersion==='2.0'&&(shot.planningContractVersion!=='2.0'||shot.adoptionScope!=='SHOT_DESIGN_ONLY'||shot.canGenerate!==false||shot.canFlowDownstream!==false||shot.inputBindings?.length!==0))fail('镜头设计采用不可冒充实际输入锁或生成就绪');
      const fields=Object.keys(spec).filter(k=>k!=='inputBindings'),pick=x=>Object.fromEntries(fields.map(k=>[k,x[k]]));
      if(domainHash(pick(shot))!==domainHash(pick(spec))||domainHash(shot.planningBasisBindings)!==domainHash(spec.inputBindings)||shot.shotPlanSetRevisionHash!==plan.contentHash||shot.episodeUid!==plan.episodeUid)fail('运行镜头表达与已审精确 ShotSpec 不一致');
    }
  }
}

/** Legacy compilers own their original namespace, never independently released
 * episode sources. Preserve exact pinned scoped records; runtime still derives
 * currentness from the current narrative/material inputs and immutable events.
 */
export function preserveScopedProductionProjection({snapshot,baseSnapshot,documents,events}){
  const prior=baseSnapshot.productionModel||{},releases=prior.episodeNarrativeReleases||[];
  if(!releases.length)return snapshot;
  assertScopedShotProjections(prior);
  const plans=[...(prior.sceneCoveragePlanRevisions||[]),...(prior.shotPlanSetRevisions||[])].filter(r=>r.episodeNarrativeReleaseId);
  for(const row of [...releases,...plans.filter(r=>r.sourceOperationId)]){
    const doc=documents.find(d=>d.revisionId===row.sourceRevisionId&&d.sha256===row.sourceSha256&&d.aliases.includes(row.sourcePath));
    const op=events.find(e=>e.sourceOperationId===row.sourceOperationId&&e.operationState==='SUCCEEDED');
    const review=events.find(e=>e.eventId===row.reviewEventId&&e.eventKind==='review');
    const original={...row,scopeRole:'CURRENT',...(row.protocol==='SCOPED_SCENE_DATABASE_COMPILER_V1'?{isCurrent:true}:{})};
    if(!doc||sha256(doc.bytes)!==doc.sha256||doc.metadata?.sourceRole!=='ADOPTED_SCOPED_CREATIVE_SOURCE'||doc.metadata.sourceOperationId!==row.sourceOperationId
      ||!op||!review||op.reviewEventId!==review.eventId||op.transactionProof?.releaseRecordHash!==domainHash(original))fail('独立分集源缺少精确固定文档／审阅／事务证明');
    const body=JSON.parse(doc.bytes);
    if(body.schemaVersion!=='1.0'||body.protocol!==row.protocol||doc.metadata.protocol!==row.protocol||body.subjectKind!==(row.subjectKind||'EPISODE_NARRATIVE')||body.scopeId!==(row.sceneId||row.episodeUid)||body.candidateContentHash!==(row.candidateContentHash||row.contentHash)
      ||body.reviewEventId!==row.reviewEventId||body.creativeRevisionId!==row.creativeRevisionId||body.contentHash!==row.contentHash
      ||domainHash(body.content)!==row.contentHash||domainHash(row.reviewInput||row.content)!==row.contentHash)fail('独立分集源字节与发布记录不一致');
  }
  const next=structuredClone(snapshot),model=next.productionModel;
  const merge=(key,rows)=>{for(const row of rows){const collision=(model[key]||[]).find(r=>r.id===row.id);if(collision&&canonicalJson(collision)!==canonicalJson(row))fail('旧编译器试图覆盖独立永久身份 '+row.id);}model[key]=[...(model[key]||[]).filter(r=>!rows.some(x=>x.id===r.id)),...structuredClone(rows)];};
  merge('episodeNarrativeReleases',releases);
  merge('sceneScriptRevisions',(prior.sceneScriptRevisions||[]).filter(r=>r.episodeNarrativeReleaseId));
  for(const key of ['sceneCoveragePlanRevisions','shotPlanSetRevisions'])merge(key,(prior[key]||[]).filter(r=>r.episodeNarrativeReleaseId));
  const planIds=new Set(plans.filter(r=>r.subjectKind==='SHOT_PLAN_SET').map(r=>r.id)),sceneIds=new Set(plans.map(r=>r.sceneId));
  merge('shots',(prior.shots||[]).filter(r=>planIds.has(r.shotPlanSetRevisionId)));
  merge('scopeLocks',(prior.scopeLocks||[]).filter(r=>r.lockPurpose==='SHOT_PLAN_SET'&&sceneIds.has(r.scopeId)));
  return next;
}
