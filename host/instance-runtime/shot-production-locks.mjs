import {loadMaterialUsageEvidence} from './material-usage-preservation.mjs';
import {canonicalJson} from './bytes.mjs';
import {createHash} from 'node:crypto';
import {productionHash,productionBindingReasons,resolveShotProductionScope,compileShotProductionPlan,shotProductionVisualInputs,shotProductionVisualInputHash} from './shot-production-model.mjs';
import {PREVIS_FIRST_POLICY,shotProductionPolicy} from './shot-production-stage-policy.mjs';
import {applyAnimaticProjection,lockAnimaticTimeline,assertAnimaticInputs,reconcileAnimaticLocks} from './animatic-service.mjs';
import {mediaRetirementOverlay} from './media-retirement.mjs';
import {productionSpaceReasons} from './shot-production-space.mjs';
import {applyProductionSpatialProjection} from './spatial-production.mjs';
import {episodeSourceCompiler} from './episode-source-sync.mjs';
import {selectAnimaticLockForShot} from './animatic-model.mjs';

export const SHOT_LOCK_NS={records:'shot-production-lock-records',heads:'shot-production-lock-heads'};
const frameKinds=new Set(['START_FRAME','INTERMEDIATE_FRAME','END_FRAME']);
const hashes=['timingHash','visualHash','overlayHash','boundaryHash'];
const fail=message=>{throw Object.assign(new Error(message),{code:'DOMAIN_CONFLICT'});};
const read=r=>r&&!r.deleted?JSON.parse(Buffer.from(r.bytes).toString('utf8')):null;
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const events=view=>view.eventsByKind?.review||[];
const latest=(rows,predicate)=>rows.filter(predicate).sort((a,b)=>Number(b.eventSequence)-Number(a.eventSequence))[0];
const current=row=>row?.scopeRole==='CURRENT'&&row.activeInCurrentProduction===true;
const inputHash=plan=>productionHash(plan.content.shots.map(({shotId,inputs,space})=>({shotId,inputs,space})));
const revision=plan=>plan.sourceRevisionId||plan.revisionId;
const visualLock=plan=>shotProductionPolicy(plan)===PREVIS_FIRST_POLICY;
const localInputBinding=(model,settings)=>({shotId:settings.shotId,inputs:shotProductionVisualInputs(model,settings),space:settings.space,visualRequirementIds:settings.visualRequirementIds});
const localInputHash=(model,plan,settings)=>visualLock(plan)?shotProductionVisualInputHash(model,settings):productionHash({shotId:settings.shotId,inputs:settings.inputs,space:settings.space});
function inputLockEvidence(c){
 if(!visualLock(c.plan))return{...baseEvidence(c,'INPUT_LOCK'),inputHash:inputHash(c.plan)};
 if(c.work.scopeType!=='SHOT'||c.work.scopeId!==c.work.shotId||!c.settings)fail('视觉输入锁必须归属本镜');
 return{...baseEvidence(c,'INPUT_LOCK'),shotId:c.work.shotId,inputHash:localInputHash(c.model,c.plan,c.settings)};
}

const inPlan=(plan,work)=>Array.isArray(plan.workItemIds)?plan.workItemIds.includes(work.id):work.shotProductionPlanId===plan.id;
function context(model,workItemId,{historical=false}={}){
 const work=(model.workItems||[]).find(w=>w.id===workItemId);if(!work||!historical&&!current(work))fail('锁定对象不是当前制作工作项');
 const plan=historical?(model.shotProductionPlans||[]).find(p=>p.id===work.shotProductionPlanId):(model.shotProductionPlans||[]).find(p=>p.scopeRole==='CURRENT'&&inPlan(p,work));
 if(!plan)fail('镜头制作计划修订已变化');
 const scope=resolveShotProductionScope(model,plan.sceneId);if(plan.content.shotPlanRevisionId!==scope.plan.id||work.shotPlanSetRevisionId!==scope.plan.id)fail('锁定对象未绑定当前正式镜头设计');
 const operational=model.operationalScopeState;if(operational){const release=operational.episodeNarrativeReleasesByUid?.[scope.episodeUid],lock=operational.scopeLocksById?.[scope.scopeLock.id];if(release?.id!==scope.episodeRelease.id||release.canFlowDownstream!==true||lock?.lockState!=='LOCKED'||lock.shotPlanSetRevisionId!==scope.plan.id)fail('本集叙事或正式镜头设计已重新打开');}
 const expectedWork=compileShotProductionPlan(scope,plan.content,{id:plan.id,revisionId:revision(plan),sourceRef:plan.sourcePath||'LOCK_VALIDATION'}).workItems.find(w=>w.scopeId===work.scopeId&&w.deliverableKey===work.deliverableKey&&w.outputSlot===work.outputSlot);
 if(!expectedWork||expectedWork.outputBasisHash!==work.outputBasisHash)fail('制作工作项与当前精确输入闭包不一致');
 const packages=(model.workPackages||[]).filter(p=>(historical||current(p))&&(p.workItemRefs||[]).includes(work.id));
 const reviewContext=(model.reviewContexts||[]).find(c=>c.id===work.reviewContextRef);
 if(packages.length!==1||!reviewContext?.contextHash)fail('缺少唯一工作包及正式审阅上下文');
 const settings=plan.content.shots.find(s=>s.shotId===work.shotId);
 return{model,work,plan,scope,package:packages[0],reviewContext,settings};
}
function bindingFor(state,work,versionId){
 const family=state.assetFamiliesById?.[work.outputAssetRef],version=state.assetVersionsById?.[versionId||family?.currentVersionId];
 if(family?.ownerRef!==work.id)return null;
 if(!family||!version||version.familyId!==family.id||!version.path||!/^[a-f0-9]{64}$/.test(version.sha256||''))return null;
 return{workItemId:work.id,slot:work.outputSlot||'main',familyId:family.id,versionId:version.id,sha256:version.sha256};
}
function assertApproval(view,model,state,event,work,{historical=false,requireAdopted=true}={}){
 const c=context(model,work.id,{historical}),last=latest(events(view),e=>e.subjectType==='WORK_PRODUCT'&&e.workItemId===work.id&&e.applicationStatus==='APPLIED'&&e.effect==='APPLIED');
 if(!event||last?.eventId!==event.eventId||event.schemaVersion!=='2.2'||event.subjectType!=='WORK_PRODUCT'||event.subjectId!==work.id||event.workItemId!==work.id||event.familyId!==work.outputAssetRef||event.productionGateId!==work.gateId||event.productionPhaseId!==work.phaseId||event.workPackageId!==c.package.id||event.scopeType!==work.scopeType||event.scopeId!==work.scopeId||event.contextHash!==c.reviewContext.contextHash||event.reviewContextRef!==c.reviewContext.id||event.action!=='APPROVE_AND_RELEASE'||event.applicationStatus!=='APPLIED'||event.effect!=='APPLIED'||event.adoptionIntent!=='ADOPT_THIS_VERSION'||event.canFlowDownstream!==true)fail('锁定必须来自当前精确工作产物的正式放行事件');
 const binding=bindingFor(state,work,event.versionId);if(!binding||binding.sha256!==event.versionSha256||productionBindingReasons(model,state,binding,{requireAdopted}).length)fail('正式审阅版本尚未按精确 SHA 实际放行');return binding;
}
async function assertRegistered(tx,binding){
 const media=await tx.getMedia(binding.familyId,binding.versionId);
 if(!media||media.sha256!==binding.sha256||media.availability!=='PRESENT'||media.metadata?.sourceRole==='ORIGINAL_SOURCE'||media.metadata?.authorityDomain==='LOCAL_TRIAL'||(await mediaRetirementOverlay(tx,media)).state!=='ACTIVE')fail('锁定输入缺少当前可用的受管实际媒体');
}
function animaticFor(c){
 const selected=selectAnimaticLockForShot(c.model.animaticLocks,{sceneId:c.plan.sceneId,shotPlanRevisionId:c.scope.plan.id,shotId:c.work.shotId});
 if(!selected)fail('需要本镜当前正式放行的 Animatic 锁时');
 const {lock,slice}=selected;
 if(!slice||hashes.some(key=>!/^[a-f0-9]{64}$/.test(slice[key]||'')))fail('本镜 Animatic 时间／画面／叠加／邻接绑定不完整');return{lock,slice};
}
async function assertAnimaticReviewMedia(tx,c,state){
 const {lock}=animaticFor(c),render=(c.model.animaticRenderJobs||[]).find(j=>j.jobId===lock.renderJobId);
 const version=state.assetVersionsById?.[render?.result?.versionId],family=state.assetFamiliesById?.[version?.familyId];
 const work=(c.model.workItems||[]).find(w=>w.id===family?.ownerRef);
 if(render?.status!=='SUCCEEDED'||!work||work.deliverableKey!=='ANIMATIC'||work.scopeType!=='SCENE'||work.scopeId!==c.plan.sceneId||work.shotPlanSetRevisionId!==c.scope.plan.id)fail('单镜审阅缺少本场精确预演产物');
 const binding=bindingFor(state,work,version.id);
 if(!binding||productionBindingReasons(c.model,state,binding,{consumerRole:'PREVIS_TIMING'}).length)fail('单镜审阅预演版本尚未实际放行');
 await assertRegistered(tx,binding);return binding;
}
function frameWorks(c){
 const works=(c.model.workItems||[]).filter(w=>current(w)&&inPlan(c.plan,w)&&w.shotId===c.work.shotId&&frameKinds.has(w.deliverableKey));
 const strategy=c.settings?.keyframeStrategy,count=strategy?.mode==='START_ONLY'?1:strategy?.mode==='START_END'?2:strategy?.mode==='MULTI_KEYFRAME'?2+strategy.intermediateFrameCount:0;
 if(!count||works.length!==count||works.filter(w=>w.deliverableKey==='START_FRAME').length!==1||works.filter(w=>w.deliverableKey==='END_FRAME').length!==(count>1?1:0)||works.filter(w=>w.deliverableKey==='INTERMEDIATE_FRAME').length!==Math.max(0,count-2))fail('关键帧工作项未完整覆盖已确认策略');
 const order={START_FRAME:0,INTERMEDIATE_FRAME:1,END_FRAME:2};return works.sort((a,b)=>order[a.deliverableKey]-order[b.deliverableKey]||String(a.outputSlot).localeCompare(String(b.outputSlot)));
}
function baseEvidence(c,kind){return{schemaVersion:'1.0',kind,productionPlanId:c.plan.id,productionRevisionId:revision(c.plan)};}
function frameEvidence(c){const{slice}=animaticFor(c);return{...baseEvidence(c,'KEYFRAME'),shotId:c.work.shotId,...Object.fromEntries(hashes.map(key=>[key,slice[key]])),strategyHash:productionHash(c.settings.keyframeStrategy)};}
function localEvidence(c){const evidence=frameEvidence(c);return Object.fromEntries(['schemaVersion','shotId',...hashes,'strategyHash'].map(key=>[key,evidence[key]]));}
function assertFields(evidence,expected){if(!evidence||Object.entries(expected).some(([key,value])=>!same(evidence[key],value)))fail('审阅证据与当前制作计划、策略或本镜 Animatic 输入不一致');}
function assertObserved(actual,required){if(!Array.isArray(actual)||new Set(actual).size!==actual.length||required.some(id=>!actual.includes(id)))fail('尚未记录全部精确媒体的实际观察');}
function assertFindings(findings,keys){if(!findings||keys.some(key=>findings[key]?.outcome!=='PASS'||typeof findings[key]?.note!=='string'||!findings[key].note.trim()||findings[key].note.length>4000))fail('缺少逐项实际验收结论及证据说明');}

/** Syntax only. Semantic/observation closure is verified inside the review transaction. */
export function validateShotProductionEvidence(value){
 if(value==null)return null;
 const allowed=['schemaVersion','kind','productionPlanId','productionRevisionId','inputHash','shotId',...hashes,'strategyHash','members','observedImageIds','jointFindings','observedVideoIds','videoFindings','keyframeSetId','adjacentShotIds'];
 if(typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k))||value.schemaVersion!=='1.0'||!['INPUT_LOCK','KEYFRAME','SHOT_LOCK'].includes(value.kind)||canonicalJson(value).length>60000)fail('镜头制作审阅证据结构无效');
 return structuredClone(value);
}
async function readContext(tx,options={}){
 const view=await tx.readView();let model=options.model||await applyAnimaticProjection(tx,{...view.snapshot.productionModel,spatialEvidence:view.snapshot.creativeLineage?.spatialEvidence||null,sourceHashes:view.snapshot.sourceHashes||{}});
 if(!options.model){const{applyShotProductionManifestProjection}=await import('./shot-production-manifest.mjs');model=await applyShotProductionManifestProjection(tx,model);}
 model=await applyProductionSpatialProjection(tx,model,{view});
 if(Object.hasOwn(model,'materialUsageLedger')||Object.hasOwn(model,'materialUsageEvidence'))model=await loadMaterialUsageEvidence(tx,model,{view});
 const state=options.state||(options.api?.projectEpisodeNarrativeReleases?episodeSourceCompiler(options.api).stateFor({...view,snapshot:{...view.snapshot,productionModel:model}}):options.api?.projectOperationalState({...view.snapshot,productionModel:model},events(view),view.eventsByKind?.['asset-version']||[],view.eventsByKind?.run||[],view.eventsByKind?.['source-operation']||[],view.eventsByKind?.['execution-request']||[]));
 if(!state)fail('缺少正式媒体运行态校验器');if(!options.model)model={...model,...(state.episodeNarrativeReleasesByUid?{operationalScopeState:{episodeNarrativeReleasesByUid:state.episodeNarrativeReleasesByUid,scopeLocksById:state.scopeLocksById}}:{}),animaticLocks:reconcileAnimaticLocks(model,state)};return{view,model,state};
}
async function saveRecord(tx,payload){
 const recordHash=productionHash(payload),id='SP-LOCK-'+recordHash.slice(0,32),existing=read(await tx.getAux(SHOT_LOCK_NS.records,id));
 const record={...payload,id,recordHash};if(existing&&!same(existing,record))fail('不可变锁定历史冲突');
 if(!existing)await tx.putAux({namespace:SHOT_LOCK_NS.records,key:id,bytes:canonicalJson(record),mediaType:'application/json',expectedRevisionId:null});
 const key=payload.kind+':'+(payload.shotId||payload.sceneId),head=await tx.getAux(SHOT_LOCK_NS.heads,key);
 if(read(head)?.recordId!==id)await tx.putAux({namespace:SHOT_LOCK_NS.heads,key,bytes:canonicalJson({recordId:id}),mediaType:'application/json',expectedRevisionId:head?.revisionId||null});return record;
}
async function validateInputLock(tx,c,state,evidence){
 if(visualLock(c.plan)){
  assertFields(evidence,inputLockEvidence(c));const settings=c.settings,binding=localInputBinding(c.model,settings);
  if(settings.visualRequirementIds.some(id=>!binding.inputs.some(b=>b.requirementId===id)))fail('本镜视觉输入锁尚缺实际素材');
  const reasons=productionSpaceReasons(c.model,{...settings,inputs:binding.inputs},state);if(reasons.length)fail(reasons.join('、'));
  const doc=await tx.getPublishedDocument(c.model.spatialEvidence.sourceRef);if(!doc||doc.sha256!==c.model.spatialEvidence.sourceSha256)fail('空间冻结源字节尚未核验');
  for(const input of binding.inputs){if(productionBindingReasons(c.model,state,input,{consumerRole:'VISUAL_PRODUCTION'}).length)fail('输入绑定必须实际采用已放行的精确版本 SHA');await assertRegistered(tx,input);}
  const hash=localInputHash(c.model,c.plan,settings);return{inputHash:hash,perShotHashes:[{shotId:settings.shotId,inputHash:hash}],inputBindings:[binding]};
 }
 assertFields(evidence,{...baseEvidence(c,'INPUT_LOCK'),inputHash:inputHash(c.plan)});
 for(const settings of c.plan.content.shots){const shot=c.scope.shots.find(s=>(s.shotId||s.id)===settings.shotId);
  if((shot.materialRequirementRefs||[]).some(id=>!settings.inputs.some(b=>b.requirementId===id))||Object.values(settings.space||{}).some(v=>!v||v==='UNKNOWN'))fail('输入锁定尚缺需求、空间或机位绑定');
  const spaceReasons=productionSpaceReasons(c.model,settings,state);if(spaceReasons.length)fail(spaceReasons.join('、'));
  const doc=await tx.getPublishedDocument(c.model.spatialEvidence.sourceRef);if(!doc||doc.sha256!==c.model.spatialEvidence.sourceSha256)fail('空间冻结源字节尚未核验');
  for(const binding of settings.inputs){if(productionBindingReasons(c.model,state,binding).length)fail('输入绑定必须实际采用已放行的精确版本 SHA');await assertRegistered(tx,binding);}
 }
 return{inputHash:inputHash(c.plan),perShotHashes:c.plan.content.shots.map(s=>({shotId:s.shotId,inputHash:productionHash({shotId:s.shotId,inputs:s.inputs,space:s.space})})),inputBindings:c.plan.content.shots.map(({shotId,inputs,space})=>({shotId,inputs,space}))};
}
async function keyframeClosure(tx,c,state,view,evidence){
 const expected=frameEvidence(c);assertFields(evidence,localEvidence(c));const members=[],memberReviewEventIds=[];
 for(const work of frameWorks(c)){
  const event=latest(events(view),e=>e.subjectType==='WORK_PRODUCT'&&e.workItemId===work.id&&e.applicationStatus==='APPLIED'&&e.effect==='APPLIED');
  if(event?.action!=='APPROVE_AND_RELEASE'||event.canFlowDownstream!==true)return null;
  const binding=assertApproval(view,c.model,state,event,work);assertFields(event.shotProductionEvidence,localEvidence(c));await assertRegistered(tx,binding);members.push(binding);memberReviewEventIds.push(event.eventId);
 }
 if(!same(evidence.members,members))fail('联合审阅须绑定策略所需全部关键帧的工作项、槽及精确版本 SHA');
 assertObserved(evidence.observedImageIds,members.map(m=>m.versionId));assertFindings(evidence.jointFindings,['continuity','composition']);
 return{...expected,members,memberReviewEventIds,jointReviewEventId:latest(events(view),e=>e.shotProductionEvidence===evidence)?.eventId||null,jointFindings:evidence.jointFindings,observedImageIds:evidence.observedImageIds};
}

/** Formal review adapter only. No browser endpoint can directly create a lock. */
export async function recordShotProductionReview(tx,{reviewEventId,...options}){
 const {view,model,state}=await readContext(tx,options),event=events(view).find(e=>e.eventId===reviewEventId);
 if(!event||event.subjectType!=='WORK_PRODUCT'||event.action!=='APPROVE_AND_RELEASE')return null;
 const work=(model.workItems||[]).find(w=>w.id===event.workItemId);if(!work)return null;
 if(work.gateId==='ANIMATIC_LOCK'){
  const candidate=(view.eventsByKind?.['asset-version']||[]).find(v=>v.versionId===event.versionId&&v.familyId===event.familyId&&v.sha256===event.versionSha256&&v.renderJobId);
  if(!candidate)fail('预演锁定缺少精确渲染候选');
  const revision=read(await tx.getAux('animatic-revisions',candidate.timelineRevisionId));if(!revision)fail('预演修订不存在');await assertAnimaticInputs(tx,revision.content,{...model,assetFamilies:Object.values(state.assetFamiliesById||{}),assetVersions:Object.values(state.assetVersionsById||{})},{render:true});
  return lockAnimaticTimeline(tx,{sceneId:work.scopeId,timelineRevisionId:candidate.timelineRevisionId,renderJobId:candidate.renderJobId,reviewEventId});
 }
 if(!work.shotProductionPlanId||!['SHOT_INPUT_LOCK','LOCKED_SHOT',...frameKinds].includes(work.deliverableKey))return null;
 const c=context(model,work.id),output=assertApproval(view,model,state,event,work);await assertRegistered(tx,output);
 const evidence=validateShotProductionEvidence(event.shotProductionEvidence);assertFields(evidence,baseEvidence(c,work.deliverableKey==='SHOT_INPUT_LOCK'?'INPUT_LOCK':work.deliverableKey==='LOCKED_SHOT'?'SHOT_LOCK':'KEYFRAME'));const base={schemaVersion:'1.0',sceneId:c.plan.sceneId,shotId:work.shotId||null,shotProductionPlanId:c.plan.id,shotProductionRevisionId:revision(c.plan),shotPlanRevisionId:c.scope.plan.id,reviewEventId,reviewContextRef:event.reviewContextRef,contextHash:event.contextHash,output,recordedAt:event.recordedAt};
 if(work.deliverableKey==='SHOT_INPUT_LOCK')return saveRecord(tx,{...base,kind:'INPUT_LOCK',...await validateInputLock(tx,c,state,evidence)});
 if(frameKinds.has(work.deliverableKey)){
  const projections=await applyShotProductionLocksProjection(tx,model,{state,view}),hash=localInputHash(model,c.plan,c.settings);
  if(!projections.shotInputLocks.some(l=>l.scopeRole==='CURRENT'&&l.sceneId===c.plan.sceneId&&(l.perShotHashes||[]).some(s=>s.shotId===work.shotId&&s.inputHash===hash)))fail('本镜实际输入尚未正式锁定');
  assertObserved(evidence?.observedImageIds,[output.versionId]);
  const closure=await keyframeClosure(tx,c,state,view,evidence);if(!closure)return{pending:true,reason:'AWAITING_ALL_KEYFRAME_REVIEWS'};
  return saveRecord(tx,{...base,...closure,kind:'KEYFRAME_SET',jointReviewEventId:reviewEventId});
 }
 const projected=await applyShotProductionLocksProjection(tx,model,{state,view}),keyframeSet=projected.shotKeyframeSets.find(s=>s.scopeRole==='CURRENT'&&s.shotId===work.shotId&&s.sceneId===c.plan.sceneId);
 if(!keyframeSet)fail('单镜锁定需要当前完整关键帧集合');
 const expected={...frameEvidence(c),kind:'SHOT_LOCK',keyframeSetId:keyframeSet.id};assertFields(evidence,expected);
 const videos=(model.workItems||[]).filter(w=>current(w)&&inPlan(c.plan,w)&&w.shotId===work.shotId&&w.deliverableKey==='SHOT_VIDEO');if(videos.length!==1)fail('单镜缺少唯一正式视频工作项');
 const videoReview=latest(events(view),e=>e.subjectType==='WORK_PRODUCT'&&e.workItemId===videos[0].id&&e.applicationStatus==='APPLIED'&&e.effect==='APPLIED'),video=assertApproval(view,model,state,videoReview,videos[0]);await assertRegistered(tx,video);
 if(!same(evidence.members,[video]))fail('单镜验收未绑定当前正式视频 SHA');
 const {lock}=animaticFor(c),render=(model.animaticRenderJobs||[]).find(j=>j.jobId===lock.renderJobId),timeline=(model.animaticTimelines||[]).find(t=>t.timelineRevisionId===lock.timelineRevisionId);
 if(visualLock(c.plan))await assertAnimaticReviewMedia(tx,c,state);
 const ordered=timeline?.content.shots.map(s=>s.shotId)||[],at=ordered.indexOf(work.shotId),adjacentShotIds=[ordered[at-1],ordered[at+1]].filter(Boolean);
 if(!render?.result?.versionId||!same(evidence.adjacentShotIds,adjacentShotIds))fail('单镜验收的邻接镜头已变化');
 assertObserved(evidence.observedVideoIds,[video.versionId,render.result.versionId]);assertFindings(evidence.videoFindings,['action','camera','consistency','timing','adjacency']);
 return saveRecord(tx,{...base,...expected,kind:'SHOT_LOCK',members:[video],videoReviewEventId:videoReview.eventId,keyframeSetId:keyframeSet.id,adjacentShotIds,observedVideoIds:evidence.observedVideoIds,videoFindings:evidence.videoFindings,animaticReviewEventId:lock.reviewEventId});
}

/** Head pointers select immutable proofs; invalidation never edits review/media history. */
export async function applyShotProductionLocksProjection(tx,model,{state,view}={}){
 view??=await tx.readView();const result={...model,shotInputLocks:[],shotKeyframeSets:[],shotLocks:[]},heads=new Set((await tx.listAux(SHOT_LOCK_NS.heads)).map(read).filter(Boolean).map(h=>h.recordId));
 for(const row of await tx.listAux(SHOT_LOCK_NS.records)){
  const record=read(row);if(!record)continue;const reasons=[];let c,applicableShotIds=[];
  try{
   const {id,recordHash,...payload}=record;if(productionHash(payload)!==recordHash||id!=='SP-LOCK-'+recordHash.slice(0,32))fail('LOCK_PROOF_HASH_MISMATCH');
   if(record.kind!=='INPUT_LOCK'&&!heads.has(record.id))fail('SUPERSEDED_LOCK');c=context(model,record.output.workItemId,{historical:record.kind==='INPUT_LOCK'});
   if(!state)fail('MEDIA_STATE_UNKNOWN');
   const event=events(view).find(e=>e.eventId===record.reviewEventId);assertApproval(view,model,state,event,c.work,{historical:record.kind==='INPUT_LOCK',requireAdopted:record.kind!=='INPUT_LOCK'});await assertRegistered(tx,record.output);
   if(record.kind==='INPUT_LOCK'){
    const currentPlan=(model.shotProductionPlans||[]).find(p=>p.sceneId===record.sceneId&&p.scopeRole==='CURRENT');if(!currentPlan)fail('PRODUCTION_PLAN_CHANGED');
    assertFields(event.shotProductionEvidence,inputLockEvidence(c));
    const v2=visualLock(c.plan);if(v2!==visualLock(currentPlan))fail('INPUT_LOCK_POLICY_CHANGED');
    if(v2&&(!same(record.inputBindings,[localInputBinding(model,c.settings)])||!same(record.perShotHashes,[{shotId:c.settings.shotId,inputHash:localInputHash(model,c.plan,c.settings)}])||record.inputHash!==localInputHash(model,c.plan,c.settings)||record.shotId!==c.settings.shotId))fail('VISUAL_INPUT_LOCK_CLOSURE_CHANGED');
    for(const original of record.inputBindings||[]){const next=currentPlan.content.shots.find(s=>s.shotId===original.shotId);if(!next||!same(original,v2?localInputBinding(model,next):{shotId:next.shotId,inputs:next.inputs,space:next.space}))continue;
     let valid=productionSpaceReasons(model,v2?{...next,inputs:original.inputs}:next,state).length===0;for(const binding of original.inputs){if(productionBindingReasons(model,state,binding,v2?{consumerRole:'VISUAL_PRODUCTION'}:{}).length){valid=false;break;}try{await assertRegistered(tx,binding);}catch{valid=false;break;}}
     if(valid)applicableShotIds.push(original.shotId);
    }
    if(!applicableShotIds.length)fail('ALL_SHOT_INPUTS_CHANGED');
   }
   else{
    assertFields(record,localEvidence(c));for(const member of record.members||[]){if(productionBindingReasons(model,state,member).length)fail('MEMBER_VERSION_CHANGED');await assertRegistered(tx,member);}
    if(record.kind==='KEYFRAME_SET'){const closure=await keyframeClosure(tx,c,state,view,event.shotProductionEvidence);if(!closure||!same(closure.memberReviewEventIds,record.memberReviewEventIds)||!same(closure.members,record.members))fail('KEYFRAME_REVIEW_CLOSURE_CHANGED');}
    else{const videoWork=(model.workItems||[]).find(w=>w.id===record.members?.[0]?.workItemId);if(!videoWork)fail('VIDEO_WORK_CHANGED');assertApproval(view,model,state,events(view).find(e=>e.eventId===record.videoReviewEventId),videoWork);if(visualLock(c.plan)){const animatic=await assertAnimaticReviewMedia(tx,c,state);assertObserved(record.observedVideoIds,[record.members[0].versionId,animatic.versionId]);}}
   }
  }catch(e){reasons.push(e.message);}
  const key=record.kind==='INPUT_LOCK'?'shotInputLocks':record.kind==='KEYFRAME_SET'?'shotKeyframeSets':'shotLocks';result[key].push({...record,...(record.kind==='INPUT_LOCK'?{applicableShotIds,perShotHashes:(record.perShotHashes||[]).filter(s=>applicableShotIds.includes(s.shotId))}:{}),scopeRole:reasons.length?'EVIDENCE_ONLY':'CURRENT',lockState:reasons.length?'REOPENED':'LOCKED',staleReasons:reasons});
 }
 for(const set of result.shotKeyframeSets)if(set.scopeRole==='CURRENT'){
  const plan=(model.shotProductionPlans||[]).find(p=>p.sceneId===set.sceneId&&p.scopeRole==='CURRENT'),settings=plan?.content.shots.find(s=>s.shotId===set.shotId),hash=settings&&localInputHash(model,plan,settings);
  if(!result.shotInputLocks.some(l=>l.scopeRole==='CURRENT'&&l.sceneId===set.sceneId&&(l.perShotHashes||[]).some(s=>s.shotId===set.shotId&&s.inputHash===hash))){set.scopeRole='EVIDENCE_ONLY';set.lockState='REOPENED';set.staleReasons.push('SHOT_INPUT_LOCK_CHANGED');}
 }
 for(const lock of result.shotLocks)if(lock.scopeRole==='CURRENT'&&!result.shotKeyframeSets.some(s=>s.id===lock.keyframeSetId&&s.scopeRole==='CURRENT')){lock.scopeRole='EVIDENCE_ONLY';lock.lockState='REOPENED';lock.staleReasons.push('KEYFRAME_SET_CHANGED');}
 return result;
}

/** Templates contain exact bindings; observation and PASS findings are never prefilled. */
async function evidenceTemplate(tx,{workItemId,versionId,...options}){
 const {view,model,state}=await readContext(tx,options),c=context(model,workItemId),kind=c.work.deliverableKey;
 if(!['SHOT_INPUT_LOCK','LOCKED_SHOT',...frameKinds].includes(kind))return{required:false,evidence:null};
 if(kind==='SHOT_INPUT_LOCK')return{required:true,evidence:inputLockEvidence(c),requiredObservedImageIds:[],requiredObservedVideoIds:[],requiresJointReview:false};
 const evidence=frameEvidence(c),members=frameWorks(c).map(w=>bindingFor(state,w,w.id===workItemId?versionId:undefined)).filter(Boolean);
 if(kind!=='LOCKED_SHOT')return{required:true,evidence:{...evidence,members,observedImageIds:[],jointFindings:{}},requiredObservedImageIds:members.map(m=>m.versionId),requiredObservedVideoIds:[],requiresJointReview:members.length===frameWorks(c).length};
 const projected=await applyShotProductionLocksProjection(tx,model,{state,view}),set=projected.shotKeyframeSets.find(s=>s.scopeRole==='CURRENT'&&s.shotId===c.work.shotId&&s.sceneId===c.plan.sceneId);if(!set)fail('当前完整关键帧集合尚未锁定');
 const videoWork=(model.workItems||[]).find(w=>current(w)&&inPlan(c.plan,w)&&w.shotId===c.work.shotId&&w.deliverableKey==='SHOT_VIDEO'),video=videoWork&&bindingFor(state,videoWork),{lock}=animaticFor(c),render=(model.animaticRenderJobs||[]).find(j=>j.jobId===lock.renderJobId),timeline=(model.animaticTimelines||[]).find(t=>t.timelineRevisionId===lock.timelineRevisionId),ordered=timeline?.content.shots.map(s=>s.shotId)||[],at=ordered.indexOf(c.work.shotId);
 if(!video||!render?.result?.versionId)fail('单镜正式视频或预演尚未放行');
 if(visualLock(c.plan))await assertAnimaticReviewMedia(tx,c,state);
 return{required:true,evidence:{...evidence,kind:'SHOT_LOCK',keyframeSetId:set.id,members:[video],adjacentShotIds:[ordered[at-1],ordered[at+1]].filter(Boolean),observedVideoIds:[],videoFindings:{}},requiredObservedImageIds:[],requiredObservedVideoIds:[video.versionId,render.result.versionId],requiresJointReview:false};
}

export async function readShotProductionReviewEvidence(tx,input){
 const result=await evidenceTemplate(tx,input),{state}=await readContext(tx,input),required=[...(result.requiredObservedImageIds||[]),...(result.requiredObservedVideoIds||[])];
 const observationMedia=[];for(const versionId of required){const version=state.assetVersionsById?.[versionId];if(!version)fail('待观察版本已变化');const binding={versionId,familyId:version.familyId,sha256:version.sha256};await assertRegistered(tx,binding);observationMedia.push({...binding,kind:(result.requiredObservedVideoIds||[]).includes(versionId)?'VIDEO':'IMAGE',mediaUrl:'/api/v8/media/m_'+createHash('sha256').update(versionId).digest('base64url').slice(0,28)});}
 return{...result,observationMedia};
}

/** A deterministic candidate manifest describes review inputs; it makes no approval claim. */
export async function buildShotProductionManifest(tx,{workItemId,...options}){
 const {model,state}=await readContext(tx,options),c=context(model,workItemId);if(!['SHOT_INPUT_LOCK','LOCKED_SHOT'].includes(c.work.deliverableKey))fail('此工作项不使用制作清单生成器');
 const template=await evidenceTemplate(tx,{workItemId,...options}),closure=c.work.deliverableKey==='SHOT_INPUT_LOCK'?await validateInputLock(tx,c,state,template.evidence):{members:template.evidence.members,keyframeSetId:template.evidence.keyframeSetId};
 const inputBindings=c.work.deliverableKey==='SHOT_INPUT_LOCK'?(visualLock(c.plan)?closure.inputBindings.flatMap(s=>s.inputs):c.plan.content.shots.flatMap(s=>s.inputs)):[...template.evidence.members,...(template.requiredObservedVideoIds||[]).map(versionId=>{const version=state.assetVersionsById?.[versionId];if(!version)fail('单镜清单预演版本已变化');return{familyId:version.familyId,versionId,sha256:version.sha256};})];
 const reviewEvidenceBindings=[];
 for(const input of inputBindings){const timingEvidence=c.work.deliverableKey==='LOCKED_SHOT'&&!template.evidence.members.some(m=>m.versionId===input.versionId)&&(template.requiredObservedVideoIds||[]).includes(input.versionId);if(productionBindingReasons(model,state,input,timingEvidence?{consumerRole:'PREVIS_TIMING'}:{}).length)fail('制作清单输入尚未实际放行');await assertRegistered(tx,input);if(visualLock(c.plan)&&timingEvidence)reviewEvidenceBindings.push({familyId:input.familyId,versionId:input.versionId,sha256:input.sha256,consumerRole:'PREVIS_TIMING'});}
 const family=(model.assetFamilies||[]).find(f=>f.id===c.work.outputAssetRef),expected=(model.expectedOutputs||[]).filter(e=>(family?.expectedOutputRefs||[]).includes(e.id)&&e.familyId===family.id);
 if(!family||family.ownerRef!==workItemId||expected.length!==1)fail('制作清单缺少唯一计划输出');
 return{content:{schemaVersion:visualLock(c.plan)?'2.0':'1.0',protocol:visualLock(c.plan)?'SHOT_PRODUCTION_MANIFEST_V2':'SHOT_PRODUCTION_MANIFEST_V1',...(visualLock(c.plan)?{stagePolicy:PREVIS_FIRST_POLICY,reviewEvidenceBindings}:{}),workItemId,familyId:family.id,deliverableKey:c.work.deliverableKey,productionPlanId:c.plan.id,productionRevisionId:revision(c.plan),sceneId:c.plan.sceneId,shotId:c.work.shotId||null,shotPlanRevisionId:c.scope.plan.id,reviewBinding:template.evidence,...closure,formalReviewCreated:false,lockState:'REVIEW_REQUIRED'},workItemId,familyId:family.id,expectedOutputId:expected[0].id,inputBindings:[...new Map(inputBindings.map(b=>[b.versionId,b])).values()]};
}
