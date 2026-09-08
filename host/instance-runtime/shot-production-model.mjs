import {canonicalJson,sha256} from './bytes.mjs';
import {productionSpaceReasons} from './shot-production-space.mjs';
import {selectAnimaticLockForShot} from './animatic-model.mjs';

export const SHOT_PRODUCTION_VERSION='1.0';
export const productionHash=value=>sha256(canonicalJson(value));
const fail=(message,code='DOMAIN_INVALID')=>{throw Object.assign(new Error(message),{code});};
const list=value=>Array.isArray(value)?value:[];
const unique=values=>[...new Set(values)];
const current=row=>row?.scopeRole==='CURRENT'&&row?.activeInCurrentProduction!==false;
const hashPattern=/^[a-f0-9]{64}$/;
const object=(value,keys,label)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))fail(`${label}含不支持的字段`);};
const rows=(value,label,max=1000)=>{if(!Array.isArray(value)||value.length>max)fail(`${label}列表无效`);return value;};
const nonblank=(value,label,max=20000)=>{if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))fail(`${label}文本无效`);return value;};
export function productionId(value,label='身份') {if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9@._:-]{0,299}$/.test(value))fail(`${label}无效`);return value;}
export function exactProductionMedia(value) {
  if(!value||typeof value!=='object'||Array.isArray(value))fail('素材绑定须明确素材族、版本和SHA');
  const familyId=productionId(value.familyId,'素材族'),versionId=productionId(value.versionId,'素材版本');
  if(!hashPattern.test(value.sha256||''))fail('素材SHA无效');
  return {familyId,versionId,sha256:value.sha256};
}

/** A current design does not imply that any production input is locked. */
export function resolveShotProductionScope(model,sceneId) {
  productionId(sceneId,'永久场');
  const plans=list(model.shotPlanSetRevisions).filter(p=>p.scopeId===sceneId&&p.scopeRole==='CURRENT');
  if(plans.length!==1||!plans[0].sourceOperationId||plans[0].sourceSyncState!=='SUCCEEDED')fail('本场尚无唯一已采用且已同步的正式镜头计划','DOMAIN_CONFLICT');
  const plan=plans[0],specs=list(plan.content?.shots);
  if(!specs.length||plan.content.sceneId!==sceneId||!hashPattern.test(plan.contentHash||'')||productionHash(plan.content)!==plan.contentHash)fail('正式镜头计划内容或哈希不完整','DOMAIN_CONFLICT');
  const releases=list(model.episodeNarrativeReleases).filter(r=>r.episodeUid===plan.episodeUid&&r.scopeRole==='CURRENT'),scripts=list(model.sceneScriptRevisions).filter(r=>r.sceneId===sceneId&&r.scopeRole==='CURRENT');
  const episodeRelease=releases[0],script=scripts[0];
  if(releases.length!==1||episodeRelease.id!==plan.episodeNarrativeReleaseId||episodeRelease.sourceSyncState!=='SOURCE_CURRENT'||scripts.length!==1||script.episodeNarrativeReleaseId!==episodeRelease.id||!list(episodeRelease.reviewInput?.scenes).some(s=>s.id===sceneId&&s.contentHash===script.contentHash))fail('本场计划的正文或本集发布已变化','DOMAIN_CONFLICT');
  const locks=list(model.scopeLocks).filter(r=>r.scopeType==='SCENE'&&r.scopeId===sceneId&&r.lockPurpose==='SHOT_PLAN_SET'),scopeLock=locks[0];
  const shotIds=specs.map((s,i)=>{productionId(s?.shotId,'永久镜头');if(s.sceneId!==sceneId||s.order!==i+1)fail('正式镜头归属或顺序无效','DOMAIN_CONFLICT');return s.shotId;});
  if(unique(shotIds).length!==shotIds.length||locks.length!==1||scopeLock.lockState!=='LOCKED'||scopeLock.denominatorState!=='KNOWN'||scopeLock.shotPlanSetRevisionId!==plan.id||scopeLock.shotPlanSetRevisionHash!==plan.contentHash||productionHash(scopeLock.shotIds)!==productionHash(shotIds))fail('本场正式镜头范围未精确锁定','DOMAIN_CONFLICT');
  const shots=specs.map(spec=>{
    const matches=list(model.shots).filter(s=>s.id===spec.shotId&&current(s)),shot=matches[0];
    if(matches.length!==1||shot.sceneId!==sceneId||shot.shotPlanSetRevisionId!==plan.id||shot.shotPlanSetRevisionHash!==plan.contentHash)fail('镜头不属于当前正式计划','DOMAIN_CONFLICT');
    return {...spec,id:spec.shotId};
  });
  return {sceneId,episodeUid:episodeRelease.episodeUid,plan,shots,episodeRelease,scopeLock};
}

export function defaultShotProductionPlan(scope) {
  return {schemaVersion:SHOT_PRODUCTION_VERSION,sceneId:scope.sceneId,shotPlanRevisionId:scope.plan.id,shotPlanHash:scope.plan.contentHash,shots:scope.shots.map(s=>({shotId:s.id,keyframeStrategy:s.design?.keyframeStrategy||{mode:'UNDECIDED',reason:'等待确认本镜关键帧策略',intermediateFrameCount:0},dialogueLines:[],inputs:[],space:{loc:'UNKNOWN',state:'UNKNOWN',zone:'UNKNOWN',camera:'UNKNOWN',freeze:'UNKNOWN'},handles:{headFrames:0,tailFrames:0},videoBranch:'UNKNOWN'}))};
}

export function validateShotProductionPlan(content,scope) {
  object(content,['schemaVersion','sceneId','shotPlanRevisionId','shotPlanHash','shots'],'制作计划');
  if(content.schemaVersion!==SHOT_PRODUCTION_VERSION||content.sceneId!==scope.sceneId||content.shotPlanRevisionId!==scope.plan.id||content.shotPlanHash!==scope.plan.contentHash)fail('制作计划须绑定本场精确镜头设计');
  rows(content.shots,'制作镜头',500);
  if(productionHash(content.shots.map(s=>s?.shotId))!==productionHash(scope.shots.map(s=>s.id)))fail('制作计划必须完整保留正式镜头的身份与顺序');
  const lineIds=new Set();
  const shots=content.shots.map((s,i)=>{
    object(s,['shotId','keyframeStrategy','dialogueLines','inputs','space','handles','videoBranch'],'镜头制作设置');
    const strategy=s.keyframeStrategy;
    object(strategy,['mode','reason','intermediateFrameCount'],'关键帧策略');
    if(!['UNDECIDED','START_ONLY','START_END','MULTI_KEYFRAME'].includes(strategy.mode)||!Number.isSafeInteger(strategy.intermediateFrameCount)||strategy.intermediateFrameCount<0||strategy.intermediateFrameCount>100||(strategy.mode==='MULTI_KEYFRAME'?strategy.intermediateFrameCount<1:strategy.intermediateFrameCount!==0))fail('关键帧策略与中间帧数量不一致');
    nonblank(strategy.reason,'关键帧策略依据');
    if(!['UNKNOWN','SILENT','AUDIO_DRIVEN','POST_LIP'].includes(s.videoBranch))fail('请选择镜头声音／口型分支');
    const dialogueLines=rows(s.dialogueLines,'对白',500).map(line=>{
      object(line,['id','text','speakerEntityId','purpose','performance'],'对白');
      productionId(line.id,'对白身份');if(lineIds.has(line.id))fail('对白身份重复');lineIds.add(line.id);
      nonblank(line.text,'实际台词');nonblank(line.performance,'对白表演说明');
      if(!['TEMPORARY','FINAL'].includes(line.purpose))fail('对白用途缺项');
      return {id:line.id,text:line.text,speakerEntityId:line.speakerEntityId===null?null:productionId(line.speakerEntityId,'说话者'),purpose:line.purpose,performance:line.performance};
    });
    if(s.videoBranch==='SILENT'&&dialogueLines.length)fail('无对白分支不能同时登记对白');
    const seen=new Set(),required=new Set(scope.shots[i].materialRequirementRefs||[]);
    const inputs=rows(s.inputs,'素材输入',1000).map(input=>{
      object(input,['requirementId','familyId','versionId','sha256','purpose'],'素材输入');
      const media=exactProductionMedia(input),requirementId=productionId(input.requirementId,'素材需求');
      if(!required.has(requirementId))fail('输入需求不属于本镜已采用设计');
      const key=requirementId+':'+media.familyId;if(seen.has(key))fail('本镜输入绑定重复');seen.add(key);
      return {...media,requirementId,purpose:input.purpose===undefined?'REFERENCE':nonblank(input.purpose,'输入用途',300)};
    });
    object(s.space,['loc','state','zone','camera','freeze'],'空间条件');
    const space={};for(const key of ['loc','state','zone','camera','freeze'])space[key]=nonblank(s.space[key],`空间条件${key}`,300);
    object(s.handles,['headFrames','tailFrames'],'剪辑余量');
    const handles={};for(const key of ['headFrames','tailFrames']){const n=s.handles[key];if(!Number.isSafeInteger(n)||n<0||n>240)fail('剪辑余量必须为0到240的整数帧');handles[key]=n;}
    return {shotId:s.shotId,keyframeStrategy:{mode:strategy.mode,reason:strategy.reason,intermediateFrameCount:strategy.intermediateFrameCount},dialogueLines,inputs,space,handles,videoBranch:s.videoBranch};
  });
  return {...content,shots};
}

const stage={
  SHOT_INPUT_LOCK:['SHOT_PLAN_INPUT_LOCK','PREVIS','W01','INPUT_LOCK','TEXT','.json','输入锁定'],
  STORYBOARD:['STORYBOARD_DIALOGUE','PREVIS','W02','P07','IMAGE','.png','粗分镜'],
  DIALOGUE_DRY:['STORYBOARD_DIALOGUE','PREVIS','W02','P08','AUDIO','.wav','对白'],
  ANIMATIC:['ANIMATIC_LOCK','PREVIS','W03','P09','VIDEO','.mp4','场级预演'],
  START_FRAME:['KEYFRAMES','SHOT_FINISH','W04','KFA','IMAGE','.png','首帧'],
  INTERMEDIATE_FRAME:['KEYFRAMES','SHOT_FINISH','W04','KFM','IMAGE','.png','中间关键帧'],
  END_FRAME:['KEYFRAMES','SHOT_FINISH','W04','KFB','IMAGE','.png','尾帧'],
  SHOT_VIDEO:['SHOT_VIDEO','SHOT_FINISH','W05','P11','VIDEO','.mp4','镜头视频'],
  LOCKED_SHOT:['SHOT_LOCK','SHOT_FINISH','W06','SHOT_LOCK_RECORD','TEXT','.json','单镜锁定记录'],
};
export function productionOutputIdentity(planId,scopeId,deliverableKey,slot='main') {
  const key=productionHash({planId,scopeId,deliverableKey,slot}).slice(0,24);
  return {workItemId:`SP-WI-${key}`,familyId:`SP-AF-${key}`,expectedOutputId:`SP-EO-${key}`,slot};
}

/** Planned targets are never materialized asset versions. */
export function compileShotProductionPlan(scope,content,{id,revisionId,sourceRef}) {
  content=validateShotProductionPlan(content,scope);
  const workItems=[],workPackages=[],assetFamilies=[],expectedOutputs=[],contexts=[],packageMap=new Map();
  function output(scopeType,scopeId,shotIds,deliverableKey,slot='main',extra={}) {
    const [gateId,phaseId,workflowStepId,pipelineStageCode,kind,extension,label]=stage[deliverableKey],identity=productionOutputIdentity(id,scopeId,deliverableKey,slot);
    const packageId=`SP-WP-${productionHash({id,scopeId,gateId,deliverableKey,slot}).slice(0,24)}`,reviewContextRef=`SP-CTX-${productionHash({id,scopeId,gateId,deliverableKey,slot}).slice(0,24)}`;
    if(!packageMap.has(packageId)){
      const p={id:packageId,label:`${scopeId} · ${label}`,stepId:workflowStepId,phaseId,gateId,scopeType,scopeId,episodeId:scope.episodeUid,episodeUid:scope.episodeUid,sceneId:scope.sceneId,segmentId:null,shotIds,workItemRefs:[],applicable:true,applicabilityState:'REQUIRED',notApplicableReason:null,isShared:scopeType==='SCENE',reviewContextRef,scopeRole:'CURRENT',activityRole:'CURRENT_PRODUCTION',activeInCurrentProduction:true,shotPlanSetRevisionId:scope.plan.id,shotPlanSetRevisionHash:scope.plan.contentHash,shotProductionPlanId:id,shotProductionRevisionId:revisionId};
      packageMap.set(packageId,p);workPackages.push(p);
      const spec=scope.shots.find(s=>s.id===scopeId);
      const context={id:reviewContextRef,shotProductionPlanId:id,shotProductionRevisionId:revisionId,schemaVersion:'2.0',scopeType,scopeId,semanticStatus:'AUTHORED_DRAFT',reviewable:true,position:{episodeUid:scope.episodeUid,sceneId:scope.sceneId,shotId:scopeType==='SHOT'?scopeId:null},scene:{id:scope.sceneId,shotIds:scope.shots.map(s=>s.id)},judgment:{purpose:{class:'A',text:spec?.narrativeBeat||'确认本场有序镜头的制作输入、表达与节奏',evidenceRefs:[sourceRef]},audienceTakeaway:{class:'A',text:spec?.audienceTakeaway||'完整呈现本场已采用表达',evidenceRefs:[sourceRef]}},sourceRefs:[sourceRef],binding:{shotPlanRevisionId:scope.plan.id,shotDefinitionHash:productionHash(spec||scope.plan.content),bindingStatus:'CURRENT',mismatchReasons:[]}};
      context.contextHash=productionHash(context);contexts.push(context);
    }
    const targetPath=`media/_review_pending/shot-production/${identity.familyId}/V001${extension}`;
    const lifecycle={lifecycleState:'WAITING_UPSTREAM',outputState:'NOT_PRODUCED',reviewDecision:null,projectRightsGate:'UNKNOWN',canFlowDownstream:false,flowBlockReasons:['OUTPUT_NOT_PRESENT']};
    const item={id:identity.workItemId,label:`${label}${slot==='main'?'':` · ${slot}`}`,legacyStageId:identity.workItemId,stageKey:pipelineStageCode,pipelineStageCode,workflowStepId,deliverableKey,scopeType,scopeId,episodeId:scope.episodeUid,episodeUid:scope.episodeUid,sceneId:scope.sceneId,segmentId:null,shotId:scopeType==='SHOT'?scopeId:null,lineId:extra.lineId||null,inputAssetRefs:[],outputAssetRef:identity.familyId,additionalOutputAssetRefs:[],promptRef:null,sourceRef,executionDefinitionRef:null,reviewContextRef,phaseId,gateId,scopeRole:'CURRENT',activityRole:'CURRENT_PRODUCTION',activeInCurrentProduction:true,definitionStatus:'REQUIRED',shotPlanSetRevisionId:scope.plan.id,shotPlanSetRevisionHash:scope.plan.contentHash,shotProductionPlanId:id,shotProductionRevisionId:revisionId,outputSlot:slot,...lifecycle,...extra};
    const family={id:identity.familyId,label:item.label,kind,subtype:deliverableKey,episodeIds:[scope.episodeUid],episodeUids:[scope.episodeUid],sceneIds:[scope.sceneId],segmentIds:[],shotIds,ownerRef:item.id,usedByRefs:[],materialRequirementRefs:[],currentVersionId:null,versionRefs:[],currentExpectedOutputId:identity.expectedOutputId,expectedOutputRefs:[identity.expectedOutputId],sourceRef,scopeRole:'CURRENT',activityRole:'CURRENT_PRODUCTION',shotProductionPlanId:id,shotProductionRevisionId:revisionId,...lifecycle};
    workItems.push(item);assetFamilies.push(family);expectedOutputs.push({id:identity.expectedOutputId,shotProductionPlanId:id,shotProductionRevisionId:revisionId,familyId:identity.familyId,label:item.label,targetPath,plannedVersionLabel:'V001',legacyVersionId:identity.expectedOutputId,expectationState:'PLANNED',realizedVersionId:null,sourceRef,executionDefinitionRef:null,scopeRole:'CURRENT',activityRole:'CURRENT_PRODUCTION'});packageMap.get(packageId).workItemRefs.push(item.id);return item;
  }
  const inputLock=output('SCENE',scope.sceneId,scope.shots.map(s=>s.id),'SHOT_INPUT_LOCK');
  for(const shot of content.shots){
    const board=output('SHOT',shot.shotId,[shot.shotId],'STORYBOARD');board.inputAssetRefs=unique(shot.inputs.map(i=>i.familyId));
    for(const line of shot.dialogueLines)output('SHOT',shot.shotId,[shot.shotId],'DIALOGUE_DRY',line.id,{lineId:line.id,dialogue:line,productionPurpose:line.purpose});
    if(shot.keyframeStrategy.mode!=='UNDECIDED'){
      output('SHOT',shot.shotId,[shot.shotId],'START_FRAME');
      if(['START_END','MULTI_KEYFRAME'].includes(shot.keyframeStrategy.mode))output('SHOT',shot.shotId,[shot.shotId],'END_FRAME');
      for(let i=0;i<shot.keyframeStrategy.intermediateFrameCount;i++)output('SHOT',shot.shotId,[shot.shotId],'INTERMEDIATE_FRAME',String(i+1));
    }
    output('SHOT',shot.shotId,[shot.shotId],'SHOT_VIDEO');output('SHOT',shot.shotId,[shot.shotId],'LOCKED_SHOT');
  }
  const animatic=output('SCENE',scope.sceneId,scope.shots.map(s=>s.id),'ANIMATIC');
  animatic.inputAssetRefs=workItems.filter(w=>['STORYBOARD','DIALOGUE_DRY'].includes(w.deliverableKey)).map(w=>w.outputAssetRef);
  for(const item of workItems){
    if(['START_FRAME','END_FRAME','INTERMEDIATE_FRAME'].includes(item.deliverableKey))item.inputAssetRefs=unique([...(content.shots.find(s=>s.shotId===item.shotId)?.inputs||[]).map(i=>i.familyId)]);
    if(item.deliverableKey==='SHOT_VIDEO')item.inputAssetRefs=workItems.filter(w=>w.shotId===item.shotId&&['START_FRAME','END_FRAME','INTERMEDIATE_FRAME','DIALOGUE_DRY'].includes(w.deliverableKey)).map(w=>w.outputAssetRef);
    if(item.deliverableKey==='LOCKED_SHOT')item.inputAssetRefs=workItems.filter(w=>w.shotId===item.shotId&&w.deliverableKey==='SHOT_VIDEO').map(w=>w.outputAssetRef);
  }
  // Compare local semantic inputs before assigning or reusing permanent output IDs.
  // New plan IDs must not make unchanged downstream targets appear different.
  const signature=item=>({scopeId:item.scopeId,deliverableKey:item.deliverableKey,slot:item.outputSlot,basisHash:item.outputBasisHash});
  for(const item of workItems.filter(w=>!['ANIMATIC','SHOT_VIDEO','LOCKED_SHOT'].includes(w.deliverableKey))){
    const settings=content.shots.find(s=>s.shotId===item.shotId),spec=scope.shots.find(s=>s.id===item.shotId);
    const basis=item.deliverableKey==='SHOT_INPUT_LOCK'?content.shots.map(s=>({shotId:s.shotId,inputs:s.inputs,space:s.space})):item.deliverableKey==='DIALOGUE_DRY'?item.dialogue:{spec,inputs:settings.inputs,space:settings.space,...(item.gateId==='KEYFRAMES'?{strategy:settings.keyframeStrategy}:{}),slot:item.outputSlot};
    item.outputBasisHash=productionHash(basis);
  }
  animatic.outputBasisHash=productionHash({shotIds:scope.shots.map(s=>s.id),inputs:workItems.filter(w=>['STORYBOARD','DIALOGUE_DRY'].includes(w.deliverableKey)).map(signature)});
  for(const item of workItems.filter(w=>w.deliverableKey==='SHOT_VIDEO')){const settings=content.shots.find(s=>s.shotId===item.shotId);item.outputBasisHash=productionHash({spec:scope.shots.find(s=>s.id===item.shotId),strategy:settings.keyframeStrategy,branch:settings.videoBranch,handles:settings.handles,inputs:workItems.filter(w=>w.shotId===item.shotId&&['START_FRAME','END_FRAME','INTERMEDIATE_FRAME','DIALOGUE_DRY'].includes(w.deliverableKey)).map(signature)});}
  for(const item of workItems.filter(w=>w.deliverableKey==='LOCKED_SHOT'))item.outputBasisHash=productionHash({spec:scope.shots.find(s=>s.id===item.shotId),inputs:workItems.filter(w=>w.shotId===item.shotId&&w.deliverableKey==='SHOT_VIDEO').map(signature)});
  for(const family of assetFamilies)family.usedByRefs=workItems.filter(w=>w.inputAssetRefs.includes(family.id)).map(w=>w.id);
  return {workItems,workPackages,assetFamilies,expectedOutputs,reviewContexts:contexts,inputLockWorkItemId:inputLock.id,animaticWorkItemId:animatic.id};
}

export function productionBindingReasons(model,state,binding,{requireAdopted=true}={}) {
  const family=state.assetFamiliesById?.[binding.familyId],version=state.assetVersionsById?.[binding.versionId];
  if(!family||!version||version.familyId!==binding.familyId||version.sha256!==binding.sha256||!hashPattern.test(binding.sha256||'')||typeof version.path!=='string'||!version.path.trim())return ['INPUT_FILE_OR_SHA_MISSING'];
  const reasons=[];
  if(requireAdopted&&(family.currentVersionId!==version.id||version.canFlowDownstream!==true||family.canFlowDownstream!==true))reasons.push('INPUT_VERSION_NOT_CURRENT_RELEASED');
  if(binding.requirementId){const requirement=list(model.materialRequirements).find(r=>r.id===binding.requirementId&&r.requirementClass==='REQUIRED');if(!requirement||!list(requirement.assetFamilyRefs).includes(binding.familyId))reasons.push('INPUT_REQUIREMENT_BINDING_CHANGED');}
  return reasons;
}

export function shotProductionReadiness(model,state,sceneId) {
  let scope;try{scope=resolveShotProductionScope(model,sceneId);}catch(e){return {sceneId,denominatorState:'UNKNOWN',shotCount:null,readyCount:0,ready:false,blockers:[e.message],shots:[]};}
  const blocked=reason=>({sceneId,episodeUid:scope.episodeUid,denominatorState:'KNOWN',shotCount:scope.shots.length,readyCount:0,ready:false,blockers:[reason],shots:scope.shots.map(s=>({shotId:s.id,ready:false,blockers:[reason]}))});
  if(state.episodeNarrativeReleasesByUid){const release=state.episodeNarrativeReleasesByUid[scope.episodeUid];if(release?.id!==scope.episodeRelease.id||release.canFlowDownstream!==true)return blocked('NARRATIVE_RELEASE_REOPENED');}
  if(state.scopeLocksById){const lock=state.scopeLocksById[scope.scopeLock.id];if(lock?.lockState!=='LOCKED'||lock.shotPlanSetRevisionId!==scope.plan.id||lock.shotPlanSetRevisionHash!==scope.plan.contentHash)return blocked('SHOT_DESIGN_REOPENED');}
  const plans=list(model.shotProductionPlans).filter(p=>p.sceneId===sceneId&&p.scopeRole==='CURRENT');
  if(!plans.length)return blocked('PRODUCTION_PLAN_REQUIRED');
  if(plans.length!==1)return blocked('PRODUCTION_PLAN_AMBIGUOUS');
  const plan=plans[0];let content;try{content=validateShotProductionPlan(plan.content,scope);if(plan.contentHash!==productionHash(plan.content))return blocked('PRODUCTION_PLAN_HASH_CHANGED');}catch{return blocked('PRODUCTION_PLAN_INVALID');}
  const byId=new Map(list(model.workItems).filter(current).map(w=>[w.id,w]));
  if(plan.workItemIds!==undefined&&(!Array.isArray(plan.workItemIds)||new Set(plan.workItemIds).size!==plan.workItemIds.length||plan.workItemIds.some(id=>!byId.has(id))))return blocked('PRODUCTION_WORK_CLOSURE_CHANGED');
  const works=plan.workItemIds?plan.workItemIds.map(id=>byId.get(id)):list(model.workItems).filter(w=>w.shotProductionPlanId===plan.id&&current(w));
  if(works.some(w=>w.sceneId!==sceneId||w.shotPlanSetRevisionId!==scope.plan.id||w.shotPlanSetRevisionHash!==scope.plan.contentHash))return blocked('PRODUCTION_WORK_CLOSURE_CHANGED');
  const expectedWorks=compileShotProductionPlan(scope,content,{id:plan.id,revisionId:plan.sourceRevisionId||'READINESS',sourceRef:plan.sourcePath||'READINESS'}).workItems;
  const expectedBasis=work=>expectedWorks.find(w=>w.scopeId===work.scopeId&&w.deliverableKey===work.deliverableKey&&w.outputSlot===work.outputSlot)?.outputBasisHash;
  const released=item=>{const f=state.assetFamiliesById?.[item?.outputAssetRef],v=state.assetVersionsById?.[f?.currentVersionId];return Boolean(item&&f?.ownerRef===item.id&&v&&!productionBindingReasons(model,state,{familyId:f.id,versionId:v.id,sha256:v.sha256}).length);};
  const uniqueWork=(shotId,key)=>{const rows=works.filter(w=>w.shotId===shotId&&w.deliverableKey===key);return rows.length===1?rows[0]:null;};
  const inputLocks=list(model.shotInputLocks).filter(l=>l.sceneId===sceneId&&l.scopeRole==='CURRENT');
  const allInputsHash=productionHash(content.shots.map(s=>({shotId:s.shotId,inputs:s.inputs,space:s.space})));
  const shots=scope.shots.map(spec=>{
    const settings=content.shots.find(s=>s.shotId===spec.id),blockers=[],inputs=settings.inputs;
    const localWorks=works.filter(w=>w.shotId===spec.id);
    if(new Set(localWorks.map(w=>w.deliverableKey+':'+w.outputSlot)).size!==localWorks.length||localWorks.some(w=>w.outputBasisHash!==expectedBasis(w)))blockers.push('PRODUCTION_WORK_INPUTS_CHANGED');
    const missing=list(spec.materialRequirementRefs).filter(id=>!inputs.some(b=>b.requirementId===id));
    if(missing.length)blockers.push(...missing.map(id=>'MATERIAL_INPUT_MISSING:'+id));
    for(const b of inputs)blockers.push(...productionBindingReasons(model,state,b).map(reason=>reason+':'+b.familyId));
    blockers.push(...productionSpaceReasons(model,settings));
    const localInputHash=productionHash({shotId:spec.id,inputs:settings.inputs,space:settings.space});
    if(!inputLocks.some(lock=>lock.inputHash===allInputsHash||list(lock.perShotHashes).some(row=>row.shotId===spec.id&&row.inputHash===localInputHash)))blockers.push('INPUT_LOCK_REQUIRED');
    if(settings.keyframeStrategy.mode==='UNDECIDED')blockers.push('KEYFRAME_STRATEGY_REQUIRED');
    if(settings.videoBranch==='UNKNOWN')blockers.push('VIDEO_BRANCH_REQUIRED');
    const board=uniqueWork(spec.id,'STORYBOARD');if(!released(board))blockers.push('STORYBOARD_NOT_RELEASED');
    const lines=works.filter(w=>w.shotId===spec.id&&w.deliverableKey==='DIALOGUE_DRY');
    if(lines.length!==settings.dialogueLines.length||settings.dialogueLines.some(line=>{const matches=lines.filter(w=>w.lineId===line.id);return matches.length!==1||productionHash(matches[0].dialogue)!==productionHash(line)||!released(matches[0]);}))blockers.push('DIALOGUE_NOT_RELEASED');
    if(['AUDIO_DRIVEN','POST_LIP'].includes(settings.videoBranch)&&(!settings.dialogueLines.length||settings.dialogueLines.some(l=>l.purpose!=='FINAL')))blockers.push('FINAL_DIALOGUE_REQUIRED');
    const timing=selectAnimaticLockForShot(model.animaticLocks,{sceneId,shotPlanRevisionId:scope.plan.id,shotId:spec.id}),slice=timing?.slice;
    const sliceKeys=['timingHash','visualHash','overlayHash','boundaryHash'];
    if(!timing||!slice||sliceKeys.some(key=>!hashPattern.test(slice[key]||'')))blockers.push('ANIMATIC_TIMING_LOCK_REQUIRED');
    const frames=works.filter(w=>w.shotId===spec.id&&['START_FRAME','END_FRAME','INTERMEDIATE_FRAME'].includes(w.deliverableKey));
    const requiredFrames=settings.keyframeStrategy.mode==='START_ONLY'?1:settings.keyframeStrategy.mode==='START_END'?2:settings.keyframeStrategy.mode==='MULTI_KEYFRAME'?2+settings.keyframeStrategy.intermediateFrameCount:0;
    const expectedKeys=['START_FRAME',...(['START_END','MULTI_KEYFRAME'].includes(settings.keyframeStrategy.mode)?['END_FRAME']:[]),...Array(settings.keyframeStrategy.intermediateFrameCount).fill('INTERMEDIATE_FRAME')].sort();
    if(!requiredFrames||productionHash(frames.map(w=>w.deliverableKey).sort())!==productionHash(expectedKeys)||frames.some(w=>!released(w)))blockers.push('KEYFRAMES_NOT_RELEASED');
    const frameSet=list(model.shotKeyframeSets).find(r=>r.shotId===spec.id&&r.scopeRole==='CURRENT'&&slice&&sliceKeys.every(key=>r[key]===slice[key])&&r.strategyHash===productionHash(settings.keyframeStrategy)&&Array.isArray(r.members)&&r.members.length===requiredFrames&&new Set(r.members.map(m=>m.workItemId)).size===requiredFrames&&frames.length===requiredFrames&&r.members.every(m=>frames.some(w=>w.id===m.workItemId&&w.outputSlot===m.slot&&w.outputAssetRef===m.familyId)&&!productionBindingReasons(model,state,m).length));
    if(!frameSet)blockers.push('KEYFRAME_SET_REVIEW_REQUIRED');
    const video=uniqueWork(spec.id,'SHOT_VIDEO');
    if(!video?.executionDefinitionRef||!Array.isArray(state.executionGatesByWorkItem?.[video.id])||state.executionGatesByWorkItem[video.id].length)blockers.push('VIDEO_CALL_PACKAGE_REQUIRED');
    return {shotId:spec.id,title:spec.title,ready:!blockers.length,blockers:unique(blockers),timing:slice||null,requiredFrameCount:requiredFrames,workItemIds:works.filter(w=>w.shotId===spec.id).map(w=>w.id),videoWorkItemId:video?.id||null};
  });
  return {sceneId,episodeUid:scope.episodeUid,productionPlanId:plan.id,denominatorState:'KNOWN',shotCount:shots.length,readyCount:shots.filter(s=>s.ready).length,ready:shots.length>0&&shots.every(s=>s.ready),blockers:unique(shots.flatMap(s=>s.blockers)),shots};
}

/** Stage entry is independent of an output's own completion and of authorization. */
export function shotProductionEntryGates(model,state){
  const result={},readiness=new Map();
  const early=reason=>/^(MATERIAL_INPUT_MISSING|INPUT_|SPACE_|SPATIAL_|PRODUCTION_|NARRATIVE_RELEASE_|SHOT_DESIGN_|上游|本场|正式)/.test(reason);
  for(const plan of list(model.shotProductionPlans).filter(p=>p.scopeRole==='CURRENT')){
    let r=readiness.get(plan.sceneId);if(!r){r=shotProductionReadiness(model,state,plan.sceneId);readiness.set(plan.sceneId,r);}
    const workIds=new Set(plan.workItemIds||list(model.workItems).filter(w=>w.shotProductionPlanId===plan.id).map(w=>w.id));
    for(const work of list(model.workItems).filter(w=>workIds.has(w.id)&&current(w))){
      const shot=r.shots.find(s=>s.shotId===work.shotId),issues=shot?.blockers||r.blockers;
      let reasons=[];
      if(work.deliverableKey==='SHOT_INPUT_LOCK')reasons=issues.filter(reason=>early(reason)&&reason!=='INPUT_LOCK_REQUIRED');
      else if(['STORYBOARD','DIALOGUE_DRY'].includes(work.deliverableKey))reasons=issues.filter(early);
      else if(work.deliverableKey==='ANIMATIC')reasons=r.blockers.filter(reason=>early(reason)||['STORYBOARD_NOT_RELEASED','DIALOGUE_NOT_RELEASED'].includes(reason));
      else if(['START_FRAME','END_FRAME','INTERMEDIATE_FRAME'].includes(work.deliverableKey))reasons=issues.filter(reason=>!['KEYFRAMES_NOT_RELEASED','KEYFRAME_SET_REVIEW_REQUIRED','VIDEO_CALL_PACKAGE_REQUIRED'].includes(reason));
      else if(work.deliverableKey==='SHOT_VIDEO')reasons=issues.filter(reason=>reason!=='VIDEO_CALL_PACKAGE_REQUIRED');
      else if(work.deliverableKey==='LOCKED_SHOT'){
        reasons=issues.filter(reason=>reason!=='VIDEO_CALL_PACKAGE_REQUIRED');
        const video=list(model.workItems).find(w=>workIds.has(w.id)&&w.shotId===work.shotId&&w.deliverableKey==='SHOT_VIDEO');
        if(state.workItemsById?.[video?.id]?.canFlowDownstream!==true)reasons.push('SHOT_VIDEO_NOT_RELEASED');
      }
      result[work.id]=unique(reasons);
    }
  }
  return result;
}
