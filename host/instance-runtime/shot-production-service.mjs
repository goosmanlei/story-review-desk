import {randomUUID} from 'node:crypto';
import {canonicalJson} from './bytes.mjs';
import {productionHash,productionId,resolveShotProductionScope,defaultShotProductionPlan,validateShotProductionPlan,compileShotProductionPlan,shotProductionReadiness,shotProductionEntryGates,productionBindingReasons} from './shot-production-model.mjs';
import {bindConfiguration} from './configuration-model.mjs';
import {applyAnimaticProjection,reconcileAnimaticLocks} from './animatic-service.mjs';
import {applyShotProductionLocksProjection} from './shot-production-locks.mjs';
import {applyShotProductionManifestProjection} from './shot-production-manifest.mjs';
import {episodeSourceCompiler} from './episode-source-sync.mjs';
import {reuseShotProductionObjects} from './shot-production-reuse.mjs';
import {shotProductionExecutionEntries} from './shot-production-gates.mjs';
import {applyProductionSpatialProjection} from './spatial-production.mjs';

export const SHOT_PRODUCTION_NS={drafts:'shot-production-drafts',requests:'shot-production-requests',jobs:'shot-production-jobs'};
const read=r=>r&&!r.deleted?JSON.parse(r.bytes):null;
const fail=(message,code='DOMAIN_CONFLICT')=>{throw Object.assign(new Error(message),{code});};
const put=(tx,namespace,key,value,expectedRevisionId=null)=>tx.putAux({namespace,key,bytes:canonicalJson(value),mediaType:'application/json',expectedRevisionId});

/** Read from a single transaction. AUX render proofs must not be cached with a release. */
export async function readCurrentShotProductionModel(tx,{api}={}) {
  if(!api?.projectOperationalState)fail('缺少正式运行态验证器');
  const view=await tx.readView(),model=await applyProductionSpatialProjection(tx,await applyShotProductionManifestProjection(tx,await applyAnimaticProjection(tx,{...view.snapshot.productionModel,spatialEvidence:view.snapshot.creativeLineage?.spatialEvidence||null,sourceHashes:view.snapshot.sourceHashes||{}})),{view});
  const snapshot={...view.snapshot,productionModel:model};
  const state=episodeSourceCompiler(api).stateFor({...view,snapshot});
  model.animaticLocks=reconcileAnimaticLocks(model,state);
  Object.assign(model,await applyShotProductionLocksProjection(tx,model,{state,view}));
  state.configuredGatesByWorkItem=api.configuredGates?api.configuredGates(model,state,shotProductionExecutionEntries(model,state,view.recipes)):{};
  state.executionGatesByWorkItem={};
  for(const work of model.workItems||[]){
    try{
      if(!api.definitionForWorkItem||!api.assertExecutionEligibility)throw Error('调用包验证器尚未加载');
      const {definition}=api.definitionForWorkItem(snapshot,view.recipes,work.id);
      api.assertCallPackageHash(definition.definitionHash,definition);
      const inputBindings=api.canonicalInputBindings(snapshot,definition,definition.upload?.items||[],view.eventsByKind['asset-version']||[]);
      api.assertExecutionEligibility({stateProjection:state},definition,{workItemId:work.id,familyId:work.outputAssetRef,inputBindings});
      state.executionGatesByWorkItem[work.id]=[];
    }catch(error){state.executionGatesByWorkItem[work.id]=error?.details?.eligibilityReasons||[error.message||'VIDEO_CALL_PACKAGE_REQUIRED'];}
  }
  return {view,model:{...model,operationalScopeState:{episodeNarrativeReleasesByUid:state.episodeNarrativeReleasesByUid,scopeLocksById:state.scopeLocksById},assetFamilies:model.assetFamilies.map(f=>({...f,...state.assetFamiliesById?.[f.id]})),assetVersions:Object.values(state.assetVersionsById||{})},state};
}
function currentScope(model,state,sceneId){
  const scope=resolveShotProductionScope(model,sceneId),release=state.episodeNarrativeReleasesByUid?.[scope.episodeUid];
  if(!release?.canFlowDownstream||release.id!==scope.episodeRelease.id)fail('上游正式叙事结论已变化');
  const lock=state.scopeLocksById?.[scope.scopeLock.id];
  if(!lock||lock.lockState!=='LOCKED'||lock.shotPlanSetRevisionId!==scope.plan.id)fail('正式镜头设计结论已变化');
  return scope;
}
export async function getShotProductionWorkspace(tx,{sceneId,api}) {
  productionId(sceneId);const {view,model,state}=await readCurrentShotProductionModel(tx,{api});
  const record=await tx.getAux(SHOT_PRODUCTION_NS.drafts,sceneId),draft=read(record);
  let basis=null,content=null,blockers=[];try{const scope=currentScope(model,state,sceneId);basis={sceneId,episodeUid:scope.episodeUid,shotPlanRevisionId:scope.plan.id,shotPlanHash:scope.plan.contentHash,shots:scope.shots};content=defaultShotProductionPlan(scope);}catch(e){blockers=[e.message];}
  const plan=(model.shotProductionPlans||[]).find(p=>p.sceneId===sceneId&&p.scopeRole==='CURRENT');
  const jobs=(await tx.listAux(SHOT_PRODUCTION_NS.jobs)).map(read).filter(j=>j?.sceneId===sceneId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,20);
  const availableInputs=(model.materialRequirements||[]).flatMap(r=>(r.assetFamilyRefs||[]).flatMap(familyId=>{const f=state.assetFamiliesById?.[familyId],v=state.assetVersionsById?.[f?.currentVersionId];return v?.sha256&&v.path?[{requirementId:r.id,familyId,versionId:v.id,sha256:v.sha256,label:r.title||f.label,canFlowDownstream:f.canFlowDownstream===true&&v.canFlowDownstream===true}]:[];}));
  const graph=model.materialDirectory?.graph||model.domainGraph||{},availableSpace={sourceSha256:model.spatialEvidence?.sourceSha256||null,version:model.spatialEvidence?.version||null,locations:(model.spatialEvidence?.locationPackages||[]).map(p=>({id:p.id,label:p.name||p.id,zones:(p.zones||[]).map(z=>({id:z.id,label:z.name||z.id})),cameras:(p.cameras||[]).map(c=>({id:c.id,label:[c.from,c.looks,c.use].filter(Boolean).join(' · ')||c.id,zoneIds:c.zoneIds||[c.zoneId].filter(Boolean)}))})),states:(graph.states||[]).filter(s=>(graph.entities||[]).some(e=>e.id===s.entityId&&e.type==='LOCATION')).map(s=>({id:s.id,label:s.label||s.id})),localViews:(model.spatialShotViews||[]).filter(r=>r.scopeRole==='CURRENT'&&r.content?.sceneBinding?.sceneId===sceneId).map(r=>({id:r.id,viewId:r.viewId,label:r.content.camera.purpose,locationId:r.content.base.locationId,zoneId:r.content.base.zoneId,cameraId:r.content.camera.id,sourceRevisionId:r.sourceRevisionId,sourceSha256:r.sourceSha256}))};
  const manifestTargets=(model.workItems||[]).filter(w=>plan&&(plan.workItemIds||[]).includes(w.id)&&['SHOT_INPUT_LOCK','LOCKED_SHOT'].includes(w.deliverableKey)).map(w=>({workItemId:w.id,shotId:w.shotId,gateId:w.gateId,label:w.label}));
  const sceneWorkIds=new Set((model.workItems||[]).filter(w=>w.sceneId===sceneId).map(w=>w.id));
  const manifestJobs=(model.shotProductionManifestJobs||[]).filter(j=>sceneWorkIds.has(j.workItemId)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,20).map(({jobId,workItemId,status,error})=>({jobId,workItemId,status,error}));
  const entryGates=shotProductionEntryGates(model,state),stageEntries=(model.workItems||[]).filter(w=>plan&&(plan.workItemIds||[]).includes(w.id)).map(w=>({id:w.id,shotId:w.shotId,deliverableKey:w.deliverableKey,gateId:w.gateId,label:w.label,blockers:entryGates[w.id]||['PRODUCTION_WORK_CLOSURE_CHANGED']}));
  return {sceneId,releaseId:view.releaseId,basis,blockers,stageEntries,draft:draft?{...draft,revisionId:record.revisionId}:null,draftHeadRevisionId:record?.revisionId||null,defaultContent:content,currentPlan:plan||null,readiness:shotProductionReadiness(model,state,sceneId),availableInputs,availableSpace,manifestTargets,manifestJobs,jobs};
}
export async function saveShotProductionDraft(tx,input,{api}){
  const {view,model,state}=await readCurrentShotProductionModel(tx,{api});if(view.releaseId!==input.expectedReleaseId)fail('发布版本已变化，请重新核对');
  const scope=currentScope(model,state,input.sceneId),content=validateShotProductionPlan(input.content,scope);
  const draft={schemaVersion:'1.0',sceneId:input.sceneId,baseReleaseId:view.releaseId,content,contentHash:productionHash(content),savedAt:new Date().toISOString()};
  const record=await put(tx,SHOT_PRODUCTION_NS.drafts,input.sceneId,draft,input.expectedDraftRevisionId);
  return {revisionId:record.revisionId,contentHash:draft.contentHash,formalAdoptionPerformed:false};
}
export async function previewShotProduction(tx,input,{api}) {
  const {view,model,state}=await readCurrentShotProductionModel(tx,{api}),record=await tx.getAux(SHOT_PRODUCTION_NS.drafts,input.sceneId),draft=read(record);
  if(!draft||record.revisionId!==input.draftRevisionId||view.releaseId!==draft.baseReleaseId)fail('草稿或发布基线已变化，请重新保存核对');
  const scope=currentScope(model,state,input.sceneId),content=validateShotProductionPlan(draft.content,scope);
  // Bindings can be incomplete in a production plan; they cannot claim a lock.
  for(const shot of content.shots){for(const binding of shot.inputs){const reasons=productionBindingReasons(model,state,binding);if(reasons.length)fail('输入绑定不能采用：'+reasons.join('、'));}for(const binding of shot.previsInputs||[]){const reasons=productionBindingReasons(model,state,binding,{consumerRole:'PREVIS_TIMING'});if(reasons.length)fail('预演参考不能采用：'+reasons.join('、'));}}
  const id='SP-PLAN-'+productionHash({sceneId:input.sceneId,draftRevisionId:record.revisionId}).slice(0,24);
  const compiled=compileShotProductionPlan(scope,content,{id,revisionId:record.revisionId,sourceRef:'PREVIEW_ONLY'});
  const old=(model.shotProductionPlans||[]).find(p=>p.sceneId===input.sceneId&&p.scopeRole==='CURRENT');
  const reuse=reuseShotProductionObjects(model,old,compiled);
  const body={schemaVersion:'1.0',sceneId:input.sceneId,expectedReleaseId:view.releaseId,draftRevisionId:record.revisionId,contentHash:productionHash(content),productionPlanId:id,shotPlanRevisionId:scope.plan.id,shotCount:scope.shots.length,workItemCount:reuse.additions.workItems.length,outputCount:reuse.additions.expectedOutputs.length,replacedProductionPlanId:old?.id||null,previousWorkItemIds:reuse.retiredWorkItemIds,reusedWorkItemIds:reuse.reusedWorkItemIds};
  return {...body,previewHash:productionHash(body),checks:['仅建立本场过程素材的制作需求，不伪造实际版本','保留旧计划与素材历史','输入、声音、锁时和关键帧仍须分别验收',...(content.schemaVersion==='2.0'?['粗分镜和临时对白按本镜本句条件并行；正式视觉输入逐镜锁定']:['未就绪镜头保持阻断，尚不调用视频模型'])]};
}
export async function enqueueShotProduction(tx,input,{api}){
  productionId(input.requestId);const previous=read(await tx.getAux(SHOT_PRODUCTION_NS.requests,input.requestId));if(previous){if(previous.requestHash!==productionHash(input))fail('请求编号已用于其他操作');return previous.result;}
  const preview=await previewShotProduction(tx,input,{api});if(preview.previewHash!==input.previewHash)fail('预览已经变化');
  const active=(await tx.listAux(SHOT_PRODUCTION_NS.jobs)).map(read).find(j=>j?.sceneId===input.sceneId&&['QUEUED','RUNNING','RESULT_UNKNOWN'].includes(j.status));if(active)fail('本场已有待处理任务，请先核对该任务');
  const meta=await tx.getMetadata(),job={jobId:'sp_job_'+randomUUID(),sceneId:input.sceneId,status:'QUEUED',createdAt:new Date().toISOString(),instanceId:meta.instanceId,runtimeEpoch:meta.runtimeEpoch,input:{...input,expectedReleaseId:preview.expectedReleaseId},preview};
  await put(tx,SHOT_PRODUCTION_NS.jobs,job.jobId,job);const result={jobId:job.jobId,status:job.status};await put(tx,SHOT_PRODUCTION_NS.requests,input.requestId,{requestHash:productionHash(input),result});return result;
}
/** Controlled worker only: source, graph and completion receipt share one CAS transaction. */
export async function applyShotProductionJob(tx,{jobId,api}){
  const record=await tx.getAux(SHOT_PRODUCTION_NS.jobs,jobId),job=read(record);if(!job)fail('制作任务不存在');if(job.status==='SUCCEEDED')return job.result;if(job.status!=='QUEUED')fail('此任务不能自动重试');
  const metadata=await tx.getMetadata();if(metadata.instanceId!==job.instanceId||metadata.runtimeEpoch!==job.runtimeEpoch)fail('任务实例已变化');
  const preview=await previewShotProduction(tx,job.input,{api});if(preview.previewHash!==job.preview.previewHash)fail('工作器执行前输入已变化');
  const {view,model,state}=await readCurrentShotProductionModel(tx,{api}),scope=currentScope(model,state,job.sceneId),draft=read(await tx.getAux(SHOT_PRODUCTION_NS.drafts,job.sceneId));
  const sourcePath='story/shot-production/'+preview.productionPlanId+'.json';
  const source=await tx.putDocument({documentId:'shot-production:'+preview.productionPlanId,aliases:[sourcePath],expectedRevisionId:null,bytes:canonicalJson({schemaVersion:'1.0',productionPlanId:preview.productionPlanId,content:draft.content,contentHash:draft.contentHash,shotPlanRevisionId:scope.plan.id}),mediaType:'application/json',metadata:{sourceRole:'SHOT_PRODUCTION_PLAN'}});
  const compiled=compileShotProductionPlan(scope,draft.content,{id:preview.productionPlanId,revisionId:source.revisionId,sourceRef:sourcePath});
  const snapshot=structuredClone(view.snapshot),out=snapshot.productionModel;
  const previousPlan=(model.shotProductionPlans||[]).find(p=>p.id===preview.replacedProductionPlanId),reuse=reuseShotProductionObjects(out,previousPlan,compiled);
  const oldWorkIds=new Set(previousPlan?(previousPlan.workItemIds||(out.workItems||[]).filter(w=>w.shotProductionPlanId===previousPlan.id).map(w=>w.id)):[]);
  const oldPackages=new Set((out.workPackages||[]).filter(p=>p.workItemRefs?.some(id=>oldWorkIds.has(id))).map(p=>p.id));
  const oldFamilies=new Set((out.assetFamilies||[]).filter(f=>oldWorkIds.has(f.ownerRef)).map(f=>f.id));
  const oldContexts=new Set((out.workItems||[]).filter(w=>oldWorkIds.has(w.id)).map(w=>w.reviewContextRef));
  for(const key of ['workItems','workPackages','assetFamilies','expectedOutputs','reviewContexts']){
    const belonged=r=>key==='workItems'?oldWorkIds.has(r.id):key==='workPackages'?oldPackages.has(r.id):key==='assetFamilies'?oldFamilies.has(r.id):key==='expectedOutputs'?oldFamilies.has(r.familyId):oldContexts.has(r.id);
    const previous=(out[key]||[]).map(r=>belonged(r)&&!reuse.retained[key].has(r.id)?{...r,scopeRole:'EVIDENCE_ONLY',activeInCurrentProduction:false}:r);
    out[key]=[...previous,...reuse.additions[key]];
  }
  const plan={id:preview.productionPlanId,sceneId:job.sceneId,episodeUid:scope.episodeUid,content:draft.content,contentHash:draft.contentHash,workItemIds:reuse.workItemIds,sourcePath,sourceRevisionId:source.revisionId,sourceSha256:source.sha256,scopeRole:'CURRENT',createdAt:new Date().toISOString()};
  out.shotProductionPlans=[plan,...(out.shotProductionPlans||[]).map(p=>p.sceneId===job.sceneId?{...p,scopeRole:'EVIDENCE_ONLY'}:p)];
  for(const shot of out.shots||[])if(scope.shots.some(s=>s.id===shot.id))shot.workPackageRefs=[...new Set([...(shot.workPackageRefs||[]).filter(id=>!oldPackages.has(id)||reuse.retained.workPackages.has(id)),...reuse.additions.workPackages.filter(p=>p.shotIds.includes(shot.id)).map(p=>p.id)])];
  const stepTexts=[['W01','镜头设计与输入锁定','INPUT_LOCK','确认本镜叙事、动作、资产与空间基线','内容、身份、版本和生成约束','精确输入清单','粗分镜与对白'],['W02','粗分镜／对白并行','P07','验证构图、人物位置与声音节奏','画面表达与对白表演','粗分镜和实际对白','Animatic 预演'],['W03','Animatic 锁时','P09','确认本场镜头顺序和节奏','实际画面、声音与入出点','已审预演与逐镜时间线','正式关键帧'],['W04','正式首尾帧','KFA','制作本镜视觉状态边界','身份、表演、构图与连续性','单首帧、首尾帧或多关键帧集合','镜头视频'],['W05','镜头视频','P11','制作动作、运镜和动态表演','时间、动作、摄影机与一致性','候选镜头视频','单镜验收'],['W06','单镜锁定','SHOT_LOCK_RECORD','在相邻镜头中验收完整镜头','叙事、剪辑、连续性与技术','已验收的视频版本与锁定记录','场景剪辑']];
  for(const [index,[id,label,code,purpose,reviewFocus,output,unlock]] of stepTexts.entries())if(!(out.workflowSteps||[]).some(s=>s.id===id))out.workflowSteps=[...(out.workflowSteps||[]),{id,order:index+1,label,technicalCodes:[code],purpose,reviewFocus,output,unlock}];
  const config=out.systemConfiguration?.config;if(!config)fail('当前实例缺少冻结的制作审阅配置');
  const bindings=bindConfiguration(snapshot,config);
  for(const item of reuse.additions.workItems){const row=out.workItems.find(w=>w.id===item.id);row.configurationBinding=bindings['work:'+item.id];row.reviewSpec=row.configurationBinding?.reviewSpec;if(!row.reviewSpec?.hash)fail('制作项缺少精确审阅标准：'+item.deliverableKey);}
  // These are new production objects. Frozen ShotSpec bytes and old reviews are untouched.
  snapshot.snapshotId='snapshot_'+productionHash({previous:view.snapshot.snapshotId,plan:plan.id,sourceSha256:source.sha256}).slice(0,32);
  const recipes={...view.recipes,snapshotId:snapshot.snapshotId};
  const release=await tx.publishRelease({snapshot,recipes,expectedReleaseId:view.releaseId,sourceRevisionIds:[...view.sourceRevisionIds,source.revisionId]});
  const result={releaseId:release.releaseId,productionPlanId:plan.id,sourceRevisionId:source.revisionId,workItemCount:compiled.workItems.length,actualMediaCreated:false};
  await put(tx,SHOT_PRODUCTION_NS.jobs,jobId,{...job,status:'SUCCEEDED',completedAt:new Date().toISOString(),result},record.revisionId);return result;
}
