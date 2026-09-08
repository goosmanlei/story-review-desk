import {canonicalJson,sha256} from './bytes.mjs';
import {productionSpaceReasons} from './shot-production-space.mjs';
import {selectAnimaticLockForShot} from './animatic-model.mjs';

import {PREVIS_FIRST_POLICY,shotProductionPolicy,shotProductionPolicyMarkers,resolveShotProductionProducer,shotProductionConsumptionReasons} from './shot-production-stage-policy.mjs';

export const SHOT_PRODUCTION_VERSION='2.0';
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
  return {sceneId,episodeUid:episodeRelease.episodeUid,plan,shots,episodeRelease,scopeLock,materialModel:model};
}

/** Resolve one speaker's selected, exact voice identity without including other audio. */
export function resolveDialogueVoiceBinding(model,line={},inputs=[]){
  const graph=model?.materialDirectory?.graph||model?.domainGraph;
  const speakers=list(graph?.entities).filter(entity=>entity.id===line.speakerEntityId&&entity.type&&entity.type!=='UNRESOLVED'&&['F','A','L'].includes(entity.authority));
  if(!line.speakerEntityId||speakers.length!==1)return {binding:null,blockers:['INPUT_SPEAKER_VOICE_MASTER_NOT_UNIQUE']};
  const representations=list(graph?.representations).filter(r=>r.entityId===line.speakerEntityId&&r.type==='VOICE_IDENTITY'&&['F','A','L'].includes(r.authority));
  const candidates=[];let invalid=false;
  for(const input of list(inputs)){
    if(!input||typeof input!=='object')continue;
    const requirements=list(model?.materialRequirements).filter(r=>r.id===input.requirementId&&r.requirementClass==='REQUIRED'&&list(r.assetFamilyRefs).includes(input.familyId));
    const families=list(model?.assetFamilies).filter(f=>f.id===input.familyId&&f.kind==='AUDIO');
    if(requirements.length!==1||families.length!==1){if(representations.some(r=>list(r.assetFamilyIds).includes(input.familyId)))invalid=true;continue;}
    const requirement=requirements[0],matching=representations.filter(r=>list(r.assetFamilyIds).includes(input.familyId)
      &&(requirement.representationRef===r.id||list(r.requirementIds).includes(requirement.id)||list(graph?.requirements).some(d=>d.id===requirement.id&&d.representationId===r.id)));
    if(matching.length!==1){if(matching.length>1)invalid=true;continue;}
    const representation=matching[0];
    let media;try{media=exactProductionMedia(input);}catch{invalid=true;continue;}
    if(!hashPattern.test(requirement.requirementHash||'')){invalid=true;continue;}
    candidates.push({schemaVersion:'DIALOGUE_VOICE_BINDING_V1',speakerEntityId:line.speakerEntityId,speakerEntityHash:productionHash(speakers[0]),requirementId:requirement.id,requirementHash:requirement.requirementHash,representationId:representation.id,representationHash:productionHash(representation),...media,purpose:input.purpose||'REFERENCE'});
  }
  return {binding:!invalid&&candidates.length===1?candidates[0]:null,blockers:invalid||candidates.length!==1?['INPUT_SPEAKER_VOICE_MASTER_NOT_UNIQUE']:[]};
}
function validateFrozenVoiceBinding(binding,line,inputs){
  object(binding,['schemaVersion','speakerEntityId','speakerEntityHash','requirementId','requirementHash','representationId','representationHash','familyId','versionId','sha256','purpose'],'对白声音基线');
  if(binding.schemaVersion!=='DIALOGUE_VOICE_BINDING_V1'||binding.speakerEntityId!==line.speakerEntityId||!hashPattern.test(binding.speakerEntityHash||'')||!hashPattern.test(binding.requirementHash||'')||!hashPattern.test(binding.representationHash||''))fail('对白声音基线的身份或关系哈希无效');
  productionId(binding.requirementId,'声音需求');productionId(binding.representationId,'声音表现');exactProductionMedia(binding);nonblank(binding.purpose,'声音用途',300);
  if(list(inputs).filter(input=>input.requirementId===binding.requirementId&&input.familyId===binding.familyId&&input.versionId===binding.versionId&&input.sha256===binding.sha256&&input.purpose===binding.purpose).length!==1)fail('对白声音基线不属于本镜精确选用输入');
  return binding;
}
const visualInputs=settings=>settings.inputs.filter(input=>!settings.dialogueLines.some(line=>line.voiceBinding?.requirementId===input.requirementId&&line.voiceBinding?.familyId===input.familyId));

/** Frozen stage classification avoids re-reading today's graph while replaying old sources. */
export function shotProductionVisualRequirementIds(model,spec){
 const graph=model?.materialDirectory?.graph||model?.domainGraph||{};
 return list(spec?.materialRequirementRefs).filter(id=>{
  const req=list(model?.materialRequirements).find(r=>r.id===id);
  const representations=list(graph.representations).filter(r=>r.id===req?.representationRef||list(r.requirementIds).includes(id));
  const families=list(req?.assetFamilyRefs).map(id=>list(model?.assetFamilies).find(f=>f.id===id));
  return !(req?.mediaType==='AUDIO'||representations.some(r=>r.type==='VOICE_IDENTITY')||(families.length>0&&families.every(f=>f?.kind==='AUDIO')));
 });
}
export function shotProductionVisualInputs(model,settings){
 const ids=settings?.visualRequirementIds;
 return Array.isArray(ids)?list(settings.inputs).filter(i=>ids.includes(i.requirementId)):visualInputs(settings);
}
export function shotProductionVisualInputHash(model,settings){return productionHash({shotId:settings.shotId,inputs:shotProductionVisualInputs(model,settings),space:settings.space,...(Array.isArray(settings.visualRequirementIds)?{visualRequirementIds:settings.visualRequirementIds}:{})});}
export function defaultShotProductionPlan(scope,{schemaVersion=SHOT_PRODUCTION_VERSION}={}) {
 const v2=schemaVersion==='2.0';if(!v2&&schemaVersion!=='1.0')fail('镜头制作阶段合同版本无效');
 return {schemaVersion,...(v2?{stagePolicy:PREVIS_FIRST_POLICY}:{}),sceneId:scope.sceneId,shotPlanRevisionId:scope.plan.id,shotPlanHash:scope.plan.contentHash,shots:scope.shots.map(s=>({shotId:s.id,keyframeStrategy:s.design?.keyframeStrategy||{mode:'UNDECIDED',reason:'等待确认本镜关键帧策略',intermediateFrameCount:0},dialogueLines:[],inputs:[],...(v2?{previsInputs:[],visualRequirementIds:shotProductionVisualRequirementIds(scope.materialModel,s)}:{}),space:{loc:'UNKNOWN',state:'UNKNOWN',zone:'UNKNOWN',camera:'UNKNOWN',freeze:'UNKNOWN'},handles:{headFrames:0,tailFrames:0},videoBranch:'UNKNOWN'}))};
}

export function validateShotProductionPlan(content,scope) {
  const v2=shotProductionPolicy(content)===PREVIS_FIRST_POLICY;
  object(content,['schemaVersion','sceneId','shotPlanRevisionId','shotPlanHash','shots',...(v2?['stagePolicy']:[])],'制作计划');
  if(content.sceneId!==scope.sceneId||content.shotPlanRevisionId!==scope.plan.id||content.shotPlanHash!==scope.plan.contentHash)fail('制作计划须绑定本场精确镜头设计');
  rows(content.shots,'制作镜头',500);
  if(productionHash(content.shots.map(s=>s?.shotId))!==productionHash(scope.shots.map(s=>s.id)))fail('制作计划必须完整保留正式镜头的身份与顺序');
  const lineIds=new Set();
  const shots=content.shots.map((s,i)=>{
    object(s,['shotId','keyframeStrategy','dialogueLines','inputs','space','handles','videoBranch',...(v2?['previsInputs','visualRequirementIds']:[])],'镜头制作设置');
    const strategy=s.keyframeStrategy;
    object(strategy,['mode','reason','intermediateFrameCount'],'关键帧策略');
    if(!['UNDECIDED','START_ONLY','START_END','MULTI_KEYFRAME'].includes(strategy.mode)||!Number.isSafeInteger(strategy.intermediateFrameCount)||strategy.intermediateFrameCount<0||strategy.intermediateFrameCount>100||(strategy.mode==='MULTI_KEYFRAME'?strategy.intermediateFrameCount<1:strategy.intermediateFrameCount!==0))fail('关键帧策略与中间帧数量不一致');
    nonblank(strategy.reason,'关键帧策略依据');
    if(!['UNKNOWN','SILENT','AUDIO_DRIVEN','POST_LIP'].includes(s.videoBranch))fail('请选择镜头声音／口型分支');
    const dialogueLines=rows(s.dialogueLines,'对白',500).map(line=>{
      object(line,['id','text','speakerEntityId','purpose','performance','voiceBinding'],'对白');
      productionId(line.id,'对白身份');if(lineIds.has(line.id))fail('对白身份重复');lineIds.add(line.id);
      nonblank(line.text,'实际台词');nonblank(line.performance,'对白表演说明');
      if(!['TEMPORARY','FINAL'].includes(line.purpose))fail('对白用途缺项');
      return {id:line.id,text:line.text,speakerEntityId:line.speakerEntityId===null?null:productionId(line.speakerEntityId,'说话者'),purpose:line.purpose,performance:line.performance,...(line.voiceBinding!==undefined?{voiceBinding:line.voiceBinding}:{})};
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
    let previsInputs,visualRequirementIds;
    if(v2){
      const used=new Set();previsInputs=rows(s.previsInputs,'预演参考输入',1000).map(input=>{
        object(input,['requirementId','familyId','versionId','sha256','purpose'],'预演参考');const media=exactProductionMedia(input),requirementId=productionId(input.requirementId,'素材需求');
        if(!required.has(requirementId))fail('预演参考需求不属于本镜已采用设计');const key=requirementId+':'+media.familyId;if(used.has(key))fail('预演参考重复');used.add(key);
        return {...media,requirementId,purpose:input.purpose===undefined?'REFERENCE':nonblank(input.purpose,'输入用途',300)};
      });
      visualRequirementIds=rows(s.visualRequirementIds,'冻结视觉需求',1000).map(id=>productionId(id,'视觉需求'));
      if(new Set(visualRequirementIds).size!==visualRequirementIds.length||visualRequirementIds.some(id=>!required.has(id)))fail('冻结视觉需求不属于本镜设计');
      if(scope.materialModel&&productionHash(visualRequirementIds)!==productionHash(shotProductionVisualRequirementIds(scope.materialModel,scope.shots[i])))fail('本镜视觉需求分类已变化，请基于当前设计重新核对');
    }
    for(const line of dialogueLines){
      if(v2&&line.purpose==='TEMPORARY'){delete line.voiceBinding;continue;}
      if(scope.materialModel){
        // Normalization is saved by the existing draft writer. Historical plan
        // compilation uses this frozen baseline without consulting today's graph.
        const {binding}=resolveDialogueVoiceBinding(scope.materialModel,line,inputs);
        if(binding)line.voiceBinding=binding;else delete line.voiceBinding;
      }else if(line.voiceBinding)validateFrozenVoiceBinding(line.voiceBinding,line,inputs);
    }
    object(s.space,['loc','state','zone','camera','freeze'],'空间条件');
    const space={};for(const key of ['loc','state','zone','camera','freeze'])space[key]=nonblank(s.space[key],`空间条件${key}`,300);
    object(s.handles,['headFrames','tailFrames'],'剪辑余量');
    const handles={};for(const key of ['headFrames','tailFrames']){const n=s.handles[key];if(!Number.isSafeInteger(n)||n<0||n>240)fail('剪辑余量必须为0到240的整数帧');handles[key]=n;}
    return {shotId:s.shotId,keyframeStrategy:{mode:strategy.mode,reason:strategy.reason,intermediateFrameCount:strategy.intermediateFrameCount},dialogueLines,inputs,...(v2?{previsInputs,visualRequirementIds}:{}),space,handles,videoBranch:s.videoBranch};
  });
  return {...content,shots};
}

const stage={
  SHOT_INPUT_LOCK:['SHOT_PLAN_INPUT_LOCK','PREVIS','W01','INPUT_LOCK','TEXT','.json','输入锁定'],
  STORYBOARD:['STORYBOARD_DIALOGUE','PREVIS','W02','P07','IMAGE','.png','粗分镜'],
  DIALOGUE_TEMP:['STORYBOARD_DIALOGUE','PREVIS','W02','P08','AUDIO','.wav','临时对白'],
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
  content=validateShotProductionPlan(content,scope);const v2=shotProductionPolicy(content)===PREVIS_FIRST_POLICY,contract=v2?{schemaVersion:'2.0',stagePolicy:PREVIS_FIRST_POLICY}:{};
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
    const markers=v2?shotProductionPolicyMarkers(deliverableKey):{};Object.assign(item,markers);Object.assign(family,markers);
    workItems.push(item);assetFamilies.push(family);expectedOutputs.push({...markers,id:identity.expectedOutputId,shotProductionPlanId:id,shotProductionRevisionId:revisionId,familyId:identity.familyId,label:item.label,targetPath,plannedVersionLabel:'V001',legacyVersionId:identity.expectedOutputId,expectationState:'PLANNED',realizedVersionId:null,sourceRef,executionDefinitionRef:null,scopeRole:'CURRENT',activityRole:'CURRENT_PRODUCTION'});packageMap.get(packageId).workItemRefs.push(item.id);return item;
  }
  const inputLocks=v2?[]:[output('SCENE',scope.sceneId,scope.shots.map(s=>s.id),'SHOT_INPUT_LOCK')];
  for(const shot of content.shots){
    if(v2)inputLocks.push(output('SHOT',shot.shotId,[shot.shotId],'SHOT_INPUT_LOCK'));
    const board=output('SHOT',shot.shotId,[shot.shotId],'STORYBOARD');board.inputAssetRefs=unique((v2?shot.previsInputs:visualInputs(shot)).map(i=>i.familyId));
    for(const line of shot.dialogueLines){
      if(v2){const temporary={id:line.id,text:line.text,speakerEntityId:line.speakerEntityId,purpose:'TEMPORARY',performance:line.performance};output('SHOT',shot.shotId,[shot.shotId],'DIALOGUE_TEMP',line.id,{lineId:line.id,dialogue:temporary});}
      if(!v2||line.purpose==='FINAL'){const dialogue=output('SHOT',shot.shotId,[shot.shotId],'DIALOGUE_DRY',line.id,{lineId:line.id,dialogue:line,productionPurpose:line.purpose});dialogue.inputAssetRefs=line.voiceBinding?[line.voiceBinding.familyId]:[];}
    }
    if(shot.keyframeStrategy.mode!=='UNDECIDED'){
      output('SHOT',shot.shotId,[shot.shotId],'START_FRAME');
      if(['START_END','MULTI_KEYFRAME'].includes(shot.keyframeStrategy.mode))output('SHOT',shot.shotId,[shot.shotId],'END_FRAME');
      for(let i=0;i<shot.keyframeStrategy.intermediateFrameCount;i++)output('SHOT',shot.shotId,[shot.shotId],'INTERMEDIATE_FRAME',String(i+1));
    }
    output('SHOT',shot.shotId,[shot.shotId],'SHOT_VIDEO');output('SHOT',shot.shotId,[shot.shotId],'LOCKED_SHOT');
  }
  const animatic=output('SCENE',scope.sceneId,scope.shots.map(s=>s.id),'ANIMATIC');
  animatic.inputAssetRefs=workItems.filter(w=>(v2?['STORYBOARD']:['STORYBOARD','DIALOGUE_DRY']).includes(w.deliverableKey)).map(w=>w.outputAssetRef);
  if(v2)animatic.dialogueLineRefs=content.shots.flatMap(s=>s.dialogueLines.map(line=>({shotId:s.shotId,lineId:line.id})));
  for(const item of workItems){
    if(['START_FRAME','END_FRAME','INTERMEDIATE_FRAME'].includes(item.deliverableKey))item.inputAssetRefs=unique((v2?shotProductionVisualInputs(scope.materialModel,content.shots.find(s=>s.shotId===item.shotId)):visualInputs(content.shots.find(s=>s.shotId===item.shotId))).map(i=>i.familyId));
    if(item.deliverableKey==='SHOT_VIDEO')item.inputAssetRefs=workItems.filter(w=>w.shotId===item.shotId&&['START_FRAME','END_FRAME','INTERMEDIATE_FRAME','DIALOGUE_DRY'].includes(w.deliverableKey)).map(w=>w.outputAssetRef);
    if(item.deliverableKey==='LOCKED_SHOT')item.inputAssetRefs=workItems.filter(w=>w.shotId===item.shotId&&w.deliverableKey==='SHOT_VIDEO').map(w=>w.outputAssetRef);
  }
  // Compare local semantic inputs before assigning or reusing permanent output IDs.
  // New plan IDs must not make unchanged downstream targets appear different.
  const signature=item=>({scopeId:item.scopeId,deliverableKey:item.deliverableKey,slot:item.outputSlot,basisHash:item.outputBasisHash});
  for(const item of workItems.filter(w=>!['ANIMATIC','SHOT_VIDEO','LOCKED_SHOT'].includes(w.deliverableKey))){
    const settings=content.shots.find(s=>s.shotId===item.shotId),spec=scope.shots.find(s=>s.id===item.shotId);
    const basis=v2?null:item.deliverableKey==='SHOT_INPUT_LOCK'?content.shots.map(s=>({shotId:s.shotId,inputs:s.inputs,space:s.space})):item.deliverableKey==='DIALOGUE_DRY'?item.dialogue:{spec,inputs:visualInputs(settings),space:settings.space,...(item.gateId==='KEYFRAMES'?{strategy:settings.keyframeStrategy}:{}),slot:item.outputSlot};
    let stageBasis=basis;
    if(v2){
      if(item.deliverableKey==='SHOT_INPUT_LOCK')stageBasis={shotId:item.shotId,inputs:shotProductionVisualInputs(scope.materialModel,settings),space:settings.space,visualRequirementIds:settings.visualRequirementIds};
      else if(['DIALOGUE_TEMP','DIALOGUE_DRY'].includes(item.deliverableKey))stageBasis=item.dialogue;
      else if(item.deliverableKey==='STORYBOARD')stageBasis={spec,inputs:settings.previsInputs,slot:item.outputSlot};
      else stageBasis={spec,inputs:shotProductionVisualInputs(scope.materialModel,settings),space:settings.space,strategy:settings.keyframeStrategy,slot:item.outputSlot};
    }
    item.outputBasisHash=productionHash(v2?{...contract,basis:stageBasis}:stageBasis);
  }
  animatic.outputBasisHash=productionHash({...contract,shotIds:scope.shots.map(s=>s.id),inputs:workItems.filter(w=>(v2?['STORYBOARD','DIALOGUE_TEMP']:['STORYBOARD','DIALOGUE_DRY']).includes(w.deliverableKey)).map(signature)});
  for(const item of workItems.filter(w=>w.deliverableKey==='SHOT_VIDEO')){const settings=content.shots.find(s=>s.shotId===item.shotId);item.outputBasisHash=productionHash({...contract,spec:scope.shots.find(s=>s.id===item.shotId),strategy:settings.keyframeStrategy,branch:settings.videoBranch,handles:settings.handles,inputs:workItems.filter(w=>w.shotId===item.shotId&&['START_FRAME','END_FRAME','INTERMEDIATE_FRAME','DIALOGUE_DRY'].includes(w.deliverableKey)).map(signature)});}
  for(const item of workItems.filter(w=>w.deliverableKey==='LOCKED_SHOT'))item.outputBasisHash=productionHash({...contract,spec:scope.shots.find(s=>s.id===item.shotId),inputs:workItems.filter(w=>w.shotId===item.shotId&&w.deliverableKey==='SHOT_VIDEO').map(signature)});
  for(const family of assetFamilies)family.usedByRefs=workItems.filter(w=>w.inputAssetRefs.includes(family.id)).map(w=>w.id);
  return {workItems,workPackages,assetFamilies,expectedOutputs,reviewContexts:contexts,inputLockWorkItemId:inputLocks[0].id,...(v2?{inputLockWorkItemIds:inputLocks.map(w=>w.id)}:{}),animaticWorkItemId:animatic.id};
}

export function productionBindingReasons(model,state,binding,{requireAdopted=true,consumerRole}={}) {
  const family=state.assetFamiliesById?.[binding.familyId],version=state.assetVersionsById?.[binding.versionId];
  if(!family||!version||version.familyId!==binding.familyId||version.sha256!==binding.sha256||!hashPattern.test(binding.sha256||'')||typeof version.path!=='string'||!version.path.trim())return ['INPUT_FILE_OR_SHA_MISSING'];
  const reasons=[];
  if(requireAdopted&&(family.currentVersionId!==version.id||version.canFlowDownstream!==true||family.canFlowDownstream!==true))reasons.push('INPUT_VERSION_NOT_CURRENT_RELEASED');
  if(binding.requirementId){const requirement=list(model.materialRequirements).find(r=>r.id===binding.requirementId&&r.requirementClass==='REQUIRED');if(!requirement||!list(requirement.assetFamilyRefs).includes(binding.familyId))reasons.push('INPUT_REQUIREMENT_BINDING_CHANGED');}
  const producer=resolveShotProductionProducer(model,binding);reasons.push(...producer.blockers,...shotProductionConsumptionReasons({...producer,consumerRole}));
  return unique(reasons);
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
  if(shotProductionPolicy(content)===PREVIS_FIRST_POLICY)return previsReadiness(model,state,{scope,plan,content,works,expectedWorks});
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
    for(const line of settings.dialogueLines)blockers.push(...resolveDialogueVoiceBinding(model,line,inputs).blockers);
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

/** V2 computes independent stage prerequisites, never slices final readiness by a regex. */
function previsReadiness(model,state,{scope,plan,content,works,expectedWorks}){
 const stages={},graph=model.materialDirectory?.graph||model.domainGraph||{},byKey=(shotId,key,lineId)=>works.filter(w=>w.shotId===shotId&&w.deliverableKey===key&&(lineId===undefined||w.lineId===lineId));
 const basisReasons=work=>{
  const expected=expectedWorks.filter(w=>w.scopeType===work.scopeType&&w.scopeId===work.scopeId&&w.deliverableKey===work.deliverableKey&&w.outputSlot===work.outputSlot);
  const markers=shotProductionPolicyMarkers(work.deliverableKey);
  return expected.length!==1||work.outputBasisHash!==expected[0].outputBasisHash||(['DIALOGUE_TEMP','DIALOGUE_DRY'].includes(work.deliverableKey)&&productionHash(work.dialogue)!==productionHash(expected[0].dialogue))||Object.entries(markers).some(([k,v])=>work[k]!==v)?['PRODUCTION_WORK_INPUTS_CHANGED']:[];
 };
 const released=(work,consumerRole)=>{const f=state.assetFamiliesById?.[work?.outputAssetRef],v=state.assetVersionsById?.[f?.currentVersionId];return Boolean(work&&f?.ownerRef===work.id&&v&&!productionBindingReasons(model,state,{familyId:f.id,versionId:v.id,sha256:v.sha256},{consumerRole}).length);};
 const refs=(bindings,consumerRole)=>bindings.flatMap(b=>productionBindingReasons(model,state,b,{consumerRole}).map(reason=>reason+':'+b.familyId));
 const report=scope.shots.map(spec=>{
  const settings=content.shots.find(s=>s.shotId===spec.id),local=works.filter(w=>w.shotId===spec.id),visual=shotProductionVisualInputs(model,settings);
  const visualReasons=[...settings.visualRequirementIds.filter(id=>!visual.some(i=>i.requirementId===id)).map(id=>'MATERIAL_INPUT_MISSING:'+id),...refs(visual,'VISUAL_PRODUCTION'),...productionSpaceReasons(model,settings)];
  const inputHash=shotProductionVisualInputHash(model,settings);
  const locked=list(model.shotInputLocks).some(l=>l.scopeRole==='CURRENT'&&l.sceneId===scope.sceneId&&(l.shotId===spec.id||list(l.perShotHashes).some(r=>r.shotId===spec.id))&&(l.inputHash===inputHash||list(l.perShotHashes).some(r=>r.shotId===spec.id&&r.inputHash===inputHash)));
  const visualLockReasons=locked?[]:['INPUT_LOCK_REQUIRED'];
  const boardReasons=refs(settings.previsInputs,'PREVIS_TIMING');
  const lineReasons=new Map();for(const line of settings.dialogueLines){
   const speakers=list(graph.entities).filter(e=>e.id===line.speakerEntityId&&e.type&&e.type!=='UNRESOLVED'&&['F','A','L'].includes(e.authority));
   const speaker=speakers.length===1?[]:['INPUT_SPEAKER_IDENTITY_REQUIRED'];
   const resolution=resolveDialogueVoiceBinding(model,line,settings.inputs),voice=[...speaker,...resolution.blockers];
   if(!line.voiceBinding||!resolution.binding||productionHash(line.voiceBinding)!==productionHash(resolution.binding))voice.push('INPUT_SPEAKER_VOICE_BINDING_CHANGED');
   if(resolution.binding)voice.push(...refs([resolution.binding],'FINAL_DIALOGUE'));
   lineReasons.set(line.id,{temporary:speaker,final:unique(voice)});
  }
  const selected=selectAnimaticLockForShot(model.animaticLocks,{sceneId:scope.sceneId,shotPlanRevisionId:scope.plan.id,shotId:spec.id}),slice=selected?.slice,sliceKeys=['timingHash','visualHash','overlayHash','boundaryHash'];
  const timingReasons=!slice||sliceKeys.some(k=>!hashPattern.test(slice[k]||''))?['ANIMATIC_TIMING_LOCK_REQUIRED']:[];
  const strategyReasons=settings.keyframeStrategy.mode==='UNDECIDED'?['KEYFRAME_STRATEGY_REQUIRED']:[];
  const requiredFrames=settings.keyframeStrategy.mode==='START_ONLY'?1:settings.keyframeStrategy.mode==='START_END'?2:settings.keyframeStrategy.mode==='MULTI_KEYFRAME'?2+settings.keyframeStrategy.intermediateFrameCount:0;
  const frames=local.filter(w=>['START_FRAME','END_FRAME','INTERMEDIATE_FRAME'].includes(w.deliverableKey));
  const expectedKeys=['START_FRAME',...(['START_END','MULTI_KEYFRAME'].includes(settings.keyframeStrategy.mode)?['END_FRAME']:[]),...Array(settings.keyframeStrategy.intermediateFrameCount).fill('INTERMEDIATE_FRAME')].sort();
  const framesReleased=requiredFrames>0&&productionHash(frames.map(w=>w.deliverableKey).sort())===productionHash(expectedKeys)&&frames.every(w=>!basisReasons(w).length&&released(w,'SHOT_VIDEO'));
  const frameSet=list(model.shotKeyframeSets).find(set=>set.scopeRole==='CURRENT'&&set.shotId===spec.id&&set.sceneId===scope.sceneId&&slice&&sliceKeys.every(k=>set[k]===slice[k])&&set.strategyHash===productionHash(settings.keyframeStrategy)&&list(set.members).length===requiredFrames&&new Set(list(set.members).map(m=>m.workItemId)).size===requiredFrames&&set.members.every(m=>frames.some(w=>w.id===m.workItemId&&w.outputSlot===m.slot&&w.outputAssetRef===m.familyId)&&!productionBindingReasons(model,state,m,{consumerRole:'SHOT_VIDEO'}).length));
  const finalReasons=[];
  if(['AUDIO_DRIVEN','POST_LIP'].includes(settings.videoBranch)){
   if(!settings.dialogueLines.length||settings.dialogueLines.some(l=>l.purpose!=='FINAL'))finalReasons.push('FINAL_DIALOGUE_REQUIRED');
   for(const line of settings.dialogueLines){const matches=byKey(spec.id,'DIALOGUE_DRY',line.id);finalReasons.push(...lineReasons.get(line.id).final);if(matches.length!==1||basisReasons(matches[0]).length||!released(matches[0],'SHOT_VIDEO'))finalReasons.push('FINAL_DIALOGUE_NOT_RELEASED:'+line.id);}
  }
  const framePrereqs=[...visualReasons,...visualLockReasons,...timingReasons,...strategyReasons];
  const videoPrereqs=[...framePrereqs,...(framesReleased?[]:['KEYFRAMES_NOT_RELEASED']),...(frameSet?[]:['KEYFRAME_SET_REVIEW_REQUIRED']),...(settings.videoBranch==='UNKNOWN'?['VIDEO_BRANCH_REQUIRED']:[]),...finalReasons];
  for(const work of local){
   const base=basisReasons(work);let required;
   if(work.deliverableKey==='STORYBOARD')required=boardReasons;
   else if(work.deliverableKey==='DIALOGUE_TEMP')required=lineReasons.get(work.lineId)?.temporary||['DIALOGUE_LINE_BINDING_CHANGED'];
   else if(work.deliverableKey==='DIALOGUE_DRY')required=lineReasons.get(work.lineId)?.final||['DIALOGUE_LINE_BINDING_CHANGED'];
   else if(work.deliverableKey==='SHOT_INPUT_LOCK')required=visualReasons;
   else if(['START_FRAME','END_FRAME','INTERMEDIATE_FRAME'].includes(work.deliverableKey))required=framePrereqs;
   else if(work.deliverableKey==='SHOT_VIDEO')required=videoPrereqs;
   else if(work.deliverableKey==='LOCKED_SHOT'){const video=byKey(spec.id,'SHOT_VIDEO');required=[...videoPrereqs,...(video.length===1&&released(video[0],'LOCKED_SHOT')?[]:['SHOT_VIDEO_NOT_RELEASED'])];}
   else required=['PRODUCTION_STAGE_CONTRACT_UNKNOWN'];
   stages[work.id]=unique([...base,...required]);
  }
  const boards=byKey(spec.id,'STORYBOARD'),timingInputReasons=[];
  if(boards.length!==1||stages[boards[0].id]?.length||!released(boards[0],'PREVIS_TIMING'))timingInputReasons.push('STORYBOARD_NOT_RELEASED:'+spec.id);
  for(const line of settings.dialogueLines){const alternatives=local.filter(w=>w.lineId===line.id&&['DIALOGUE_TEMP','DIALOGUE_DRY'].includes(w.deliverableKey));if(!alternatives.some(w=>!stages[w.id]?.length&&released(w,'PREVIS_TIMING')))timingInputReasons.push('DIALOGUE_TIMING_NOT_RELEASED:'+line.id);}
  const videos=byKey(spec.id,'SHOT_VIDEO'),video=videos.length===1?videos[0]:null;
  const packageReasons=!video?.executionDefinitionRef||!Array.isArray(state.executionGatesByWorkItem?.[video.id])||state.executionGatesByWorkItem[video.id].length?['VIDEO_CALL_PACKAGE_REQUIRED']:[];
  const blockers=unique([...videoPrereqs,...packageReasons]);
  return {shotId:spec.id,title:spec.title,ready:!blockers.length,blockers,timing:slice||null,requiredFrameCount:requiredFrames,workItemIds:local.map(w=>w.id),videoWorkItemId:video?.id||null,timingInputReasons,stageBlockers:Object.fromEntries(unique(local.map(w=>w.gateId)).map(gate=>[gate,unique(local.filter(w=>w.gateId===gate).flatMap(w=>stages[w.id]))]))};
 });
 for(const work of works.filter(w=>w.deliverableKey==='ANIMATIC'))stages[work.id]=unique([...basisReasons(work),...report.flatMap(s=>s.timingInputReasons)]);
 return {sceneId:scope.sceneId,episodeUid:scope.episodeUid,productionPlanId:plan.id,denominatorState:'KNOWN',shotCount:report.length,readyCount:report.filter(s=>s.ready).length,ready:report.length>0&&report.every(s=>s.ready),blockers:unique(report.flatMap(s=>s.blockers)),shots:report,entryGatesByWorkItem:stages};
}

/** Stage entry is independent of an output's own completion and of authorization. */
export function shotProductionEntryGates(model,state){
  const result={},readiness=new Map();
  const early=reason=>/^(MATERIAL_INPUT_MISSING|INPUT_|SPACE_|SPATIAL_|PRODUCTION_|NARRATIVE_RELEASE_|SHOT_DESIGN_|上游|本场|正式)/.test(reason);
  for(const plan of list(model.shotProductionPlans).filter(p=>p.scopeRole==='CURRENT')){
    let r=readiness.get(plan.sceneId);if(!r){r=shotProductionReadiness(model,state,plan.sceneId);readiness.set(plan.sceneId,r);}
    const workIds=new Set(plan.workItemIds||list(model.workItems).filter(w=>w.shotProductionPlanId===plan.id).map(w=>w.id));
    for(const work of list(model.workItems).filter(w=>workIds.has(w.id)&&current(w))){
      if(r.entryGatesByWorkItem){result[work.id]=r.entryGatesByWorkItem[work.id]||['PRODUCTION_WORK_CLOSURE_CHANGED'];continue;}
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
