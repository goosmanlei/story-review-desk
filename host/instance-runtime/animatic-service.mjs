import {randomUUID,createHash} from 'node:crypto';
import {canonicalJson} from './bytes.mjs';
import {animaticHash,animaticHashes,animaticImpact,animaticMediaBindings,validateAnimaticTimeline} from './animatic-model.mjs';
import {mediaRetirementOverlay} from './media-retirement.mjs';
import {PREVIS_FIRST_POLICY,shotProductionPolicy,shotProductionPolicyMarkers,resolveShotProductionProducer,shotProductionConsumptionReasons} from './shot-production-stage-policy.mjs';

export const ANIMATIC_NS={heads:'animatic-heads',revisions:'animatic-revisions',jobs:'animatic-render-jobs',requests:'animatic-requests',locks:'animatic-locks',slots:'animatic-output-slots'};
const read=r=>r&&!r.deleted?JSON.parse(Buffer.from(r.bytes).toString('utf8')):null;
const fail=(message,code='DOMAIN_CONFLICT')=>{throw Object.assign(new Error(message),{code});};
const token=id=>'m_'+createHash('sha256').update(id).digest('base64url').slice(0,28);
async function put(tx,namespace,key,value,expectedRevisionId=null){return tx.putAux({namespace,key,bytes:canonicalJson(value),expectedRevisionId,mediaType:'application/json'});}
async function modelFor(tx,options){return options.model||(await tx.readView()).snapshot.productionModel;}
async function basisFor(tx,sceneId,options={}){
 const model=await modelFor(tx,options);const {resolveShotProductionScope}=await import('./shot-production-model.mjs');
 const scope=resolveShotProductionScope(model,sceneId),runtime=model.operationalScopeState;
 if(runtime){const release=runtime.episodeNarrativeReleasesByUid?.[scope.episodeUid],lock=runtime.scopeLocksById?.[scope.scopeLock.id];if(release?.canFlowDownstream!==true||release.id!==scope.episodeRelease.id||lock?.lockState!=='LOCKED'||lock.shotPlanSetRevisionId!==scope.plan.id)fail('本场正式叙事或镜头设计已重开');}
 return{...scope,model,sceneId,shotPlanRevisionId:scope.plan.id,shotIds:scope.shots.map(s=>s.shotId||s.id)};
}
async function requestReplay(tx,input){if(typeof input.requestId!=='string'||!/^[A-Za-z0-9:_.-]{8,160}$/.test(input.requestId))fail('缺少幂等请求身份','DOMAIN_INVALID');const previous=read(await tx.getAux(ANIMATIC_NS.requests,input.requestId));if(previous&&previous.requestHash!==animaticHash(input))fail('请求编号已用于其他时间线操作');return previous?.result;}
async function remember(tx,input,result){await put(tx,ANIMATIC_NS.requests,input.requestId,{requestHash:animaticHash(input),result});return result;}
function mediaView(model){const versions=new Map((model.assetVersions||[]).map(v=>[v.id,v]));return{versions,families:new Map((model.assetFamilies||[]).map(f=>[f.id,f]))};}
function currentAnimaticWorks(model,sceneId){const plan=(model.shotProductionPlans||[]).find(p=>p.sceneId===sceneId&&p.scopeRole==='CURRENT'),ids=Array.isArray(plan?.workItemIds)?new Set(plan.workItemIds):null;return(model.workItems||[]).filter(w=>w.scopeRole==='CURRENT'&&w.activeInCurrentProduction!==false&&(ids?ids.has(w.id):w.sceneId===sceneId||w.scopeId===sceneId));}
function previsPlan(model,sceneId){
 const plans=(model.shotProductionPlans||[]).filter(p=>p.sceneId===sceneId&&p.scopeRole==='CURRENT');
 if(plans.length>1)fail('本场镜头制作计划不唯一');
 if(!plans.length)return null;
 return shotProductionPolicy(plans[0])===PREVIS_FIRST_POLICY?plans[0]:null;
}
function plannedDialogue(plan){return plan.content.shots.flatMap(s=>s.dialogueLines.map(line=>({shotId:s.shotId,...line})));}
function matchingDialogueWork(works,clip){
 if(clip.lineIds.length!==1)return null;
 const matches=works.filter(w=>['DIALOGUE_TEMP','DIALOGUE_DRY'].includes(w.deliverableKey)&&w.lineId===clip.lineIds[0]&&w.outputAssetRef===clip.media.familyId);
 return matches.length===1?matches[0]:null;
}
function assertPrevisDialogue(content,plan,works,{render,model}){
 const lines=plannedDialogue(plan);
 for(const clip of content.audio){
  const isDialogueSource=(model.workItems||[]).some(w=>['DIALOGUE_TEMP','DIALOGUE_DRY'].includes(w.deliverableKey)&&w.outputAssetRef===clip.media.familyId);
  if(clip.role!=='DIALOGUE'){if(isDialogueSource||clip.lineIds.length)fail('临时／正式对白只能作为对应台词音轨');continue;}
  const work=matchingDialogueWork(works,clip),line=work&&lines.find(l=>l.id===work.lineId&&l.shotId===work.shotId);
  if(!line||clip.temporary!==(work.productionPurpose==='TEMPORARY')||!['TEMPORARY','FINAL'].includes(work.productionPurpose))fail('对白音轨必须绑定本场对应台词与实际临时／正式用途');
  if(work.dialogue?.text!==line.text||work.dialogue?.speakerEntityId!==line.speakerEntityId||work.dialogue?.performance!==line.performance)fail('所选对白与当前台词或表演依据不同');
 }
 if(render)for(const line of lines){const selected=content.audio.filter(a=>a.role==='DIALOGUE'&&!a.muted&&a.volume>0&&a.lineIds.includes(line.id));if(selected.length!==1)fail('每句台词必须明确选用一条临时或正式音轨，不能遗漏或重复');}
}
export async function assertAnimaticInputs(tx,content,model,{render=false}={}){
 const plan=previsPlan(model,content.sceneId),works=currentAnimaticWorks(model,content.sceneId);
 if(plan)assertPrevisDialogue(content,plan,works,{render,model});
 const {versions,families}=mediaView(model);if(render&&content.shots.some(s=>!s.panels.length))fail('每个镜头须有粗分镜才能生成审阅预演');
 if(render){const works=currentAnimaticWorks(model,content.sceneId);
  for(const shot of content.shots){const boards=works.filter(w=>w.shotId===shot.shotId&&w.deliverableKey==='STORYBOARD');if(!boards.length||shot.panels.some(p=>!boards.some(w=>w.outputAssetRef===p.media.familyId)))fail('粗分镜必须来自本镜对应的当前 P07 制作工作项');}
  if(!plan){const dialogue=works.filter(w=>w.deliverableKey==='DIALOGUE_DRY');for(const line of dialogue)if(!content.audio.some(a=>a.role==='DIALOGUE'&&!a.muted&&a.volume>0&&a.lineIds.includes(line.lineId)&&a.media.familyId===line.outputAssetRef))fail('本场适用对白必须完整纳入锁时音轨');
  for(const clip of content.audio.filter(a=>a.role==='DIALOGUE'))if(!clip.lineIds.length||clip.lineIds.some(id=>!dialogue.some(w=>w.lineId===id&&w.outputAssetRef===clip.media.familyId&&(!clip.temporary?w.productionPurpose==='FINAL':true))))fail('对白音轨必须绑定对应台词与实际声音用途');}
 }
 if(render){const requiredCards=(model.materialRequirements||[]).filter(r=>r.requirementClass==='REQUIRED'&&r.cardSpec?.role==='INSTANCE'&&r.cardSpec.triggerSceneId===content.sceneId);for(const requirement of requiredCards){const spec=requirement.cardSpec,card=content.cards.find(c=>c.specRevisionId===(spec.revisionId||requirement.id)&&c.specHash===animaticHash(spec));if(!card||canonicalJson(card.textLines)!==canonicalJson([spec.displayName,spec.contextLine]))fail('本场必需人物卡缺少精确已发布文案／规格绑定');}for(const card of content.cards){if(!requiredCards.some(r=>card.specRevisionId===(r.cardSpec.revisionId||r.id)&&card.specHash===animaticHash(r.cardSpec)&&canonicalJson(card.textLines)===canonicalJson([r.cardSpec.displayName,r.cardSpec.contextLine])))fail('人物卡尚未绑定本场已发布规格');}}
 const bindings=[];for(const input of animaticMediaBindings(content)){
  if(plan){const producer=resolveShotProductionProducer(model,input);if(producer.blockers.length||shotProductionConsumptionReasons({...producer,consumerRole:'PREVIS_TIMING'}).length)fail('预演素材的原始工作项或用途闭包已变化');}
  const registered=await tx.getMedia(input.familyId,input.versionId),version=versions.get(input.versionId);
  if(!registered||registered.sha256!==input.sha256||registered.availability!=='PRESENT')fail('素材版本未登记、文件缺失或 SHA 已变化');
  if((await mediaRetirementOverlay(tx,registered)).state!=='ACTIVE')fail('素材正处于清退或维护状态');
  if(registered.metadata?.sourceRole==='ORIGINAL_SOURCE'||registered.metadata?.authorityDomain==='LOCAL_TRIAL')fail('原始来源及独立试制不可作为正式预演输入');
  if(!version||version.familyId!==input.familyId||version.sha256!==input.sha256||families.get(input.familyId)?.currentVersionId!==input.versionId||families.get(input.familyId)?.canFlowDownstream!==true||version.scopeRole==='HISTORICAL'||['DO_NOT_USE','RIGHTS_HOLD','REVISION_REQUIRED'].includes(version.lifecycleState)||version.canFlowDownstream!==true)fail('预演输入必须为项目内已放行的精确素材版本');
  bindings.push({...input,relativePath:registered.relativePath,byteSize:registered.byteSize});
 }
 return [...new Map(bindings.map(b=>[b.versionId,b])).values()];
}
export async function readAnimaticState(tx,{sceneId,...options}={}){
 if(typeof sceneId!=='string'||!sceneId)fail('请选择永久场身份','DOMAIN_INVALID');const view=await tx.readView(),head=await tx.getAux(ANIMATIC_NS.heads,sceneId),pointer=read(head),revision=pointer?read(await tx.getAux(ANIMATIC_NS.revisions,pointer.timelineRevisionId)):null;
 let basis=null,blockers=[];try{basis=await basisFor(tx,sceneId,options);}catch(e){blockers=[e.message];}
 const model=basis?.model||await modelFor(tx,options),media=await tx.listMedia();
 const productionPlan=previsPlan(model,sceneId),productionWorks=currentAnimaticWorks(model,sceneId);
 const availableMedia=(model.assetVersions||[]).filter(v=>v.canFlowDownstream===true&&(model.assetFamilies||[]).some(f=>f.id===v.familyId&&f.currentVersionId===v.id&&f.canFlowDownstream===true)&&v.sha256&&media.some(m=>m.mediaId===v.familyId&&m.versionId===v.id&&m.sha256===v.sha256&&m.availability==='PRESENT'&&m.metadata?.sourceRole!=='ORIGINAL_SOURCE'&&m.metadata?.authorityDomain!=='LOCAL_TRIAL')).map(v=>{const family=(model.assetFamilies||[]).find(f=>f.id===v.familyId);const work=productionPlan?productionWorks.find(w=>w.outputAssetRef===v.familyId):null;return{familyId:v.familyId,versionId:v.id,sha256:v.sha256,label:family?.label||v.label||v.id,kind:family?.kind||'',path:v.path,mediaUrl:'/api/v8/media/'+token(v.id),...(work?{workItemId:work.id,deliverableKey:work.deliverableKey,shotId:work.shotId,...(work.lineId?{lineId:work.lineId}:{}),productionPurpose:work.productionPurpose}:{})};});
 const requiredCards=(model.materialRequirements||[]).filter(r=>r.requirementClass==='REQUIRED'&&r.cardSpec?.role==='INSTANCE'&&r.cardSpec.triggerSceneId===sceneId).map(r=>({requirementId:r.id,specRevisionId:r.cardSpec.revisionId||r.id,specHash:animaticHash(r.cardSpec),textLines:[r.cardSpec.displayName,r.cardSpec.contextLine]}));
 const reconciliations=(await tx.listAux('animatic-reconciliations')).map(read).filter(r=>r?.sceneId===sceneId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
 const jobs=(await tx.listAux(ANIMATIC_NS.jobs)).map(row=>({...read(row),jobRevisionId:row.revisionId})).filter(j=>j.sceneId===sceneId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(job=>({...job,pendingReconciliation:reconciliations.find(r=>r.jobId===job.jobId&&r.status==='QUEUED')||null,lastReconciliation:reconciliations.find(r=>r.jobId===job.jobId)||null}));
 const stale=Boolean(revision&&(!basis||revision.content.shotPlanRevisionId!==basis.shotPlanRevisionId));
 return{sceneId,runtimeEpoch:(await tx.getMetadata()).runtimeEpoch,releaseId:view.releaseId,revisionId:head?.revisionId||null,timelineRevisionId:pointer?.timelineRevisionId||null,content:revision?.content||null,hashes:revision?.hashes||null,impact:revision?.impact||[],stale,blockers,availableMedia,requiredCards,jobs,lock:(model.animaticLocks||[]).find(l=>l.sceneId===sceneId&&l.scopeRole==='CURRENT'&&l.fullSceneCurrent)||null,basis:basis?{sceneId,shotPlanRevisionId:basis.shotPlanRevisionId,...(productionPlan?{stagePolicy:PREVIS_FIRST_POLICY,dialogueLines:plannedDialogue(productionPlan).map(l=>({shotId:l.shotId,lineId:l.id,text:l.text,speakerEntityId:l.speakerEntityId}))}:{}),shots:basis.shots.map(s=>{const seconds=s.design?.estimatedDurationSeconds??s.durationSeconds;return{shotId:s.shotId||s.id,title:s.title||s.narrativePurpose||'',durationFrames:Number.isFinite(seconds)?Math.max(1,Math.round(seconds*24)):72,durationBasis:Number.isFinite(seconds)?'DESIGN_ESTIMATE':'DRAFT_DEFAULT'};})}:null};
}
/** The mirror serves only the sanitized, exact frozen media closure produced by the exporter. */
export function readPublicAnimaticState(model,sceneId){
 if(typeof sceneId!=='string'||!sceneId)fail('请选择永久场身份','DOMAIN_INVALID');
 const timeline=(model.animaticTimelines||[]).find(t=>t.sceneId===sceneId),plan=(model.shotPlanSetRevisions||[]).find(p=>p.scopeRole==='CURRENT'&&p.scopeId===sceneId);
 return{sceneId,releaseId:'HOSTED_READ_ONLY',revisionId:timeline?.revisionId||null,timelineRevisionId:timeline?.timelineRevisionId||null,content:timeline?.content||null,hashes:timeline?.hashes||null,impact:timeline?.impact||[],stale:Boolean(timeline&&plan?.id!==timeline.content.shotPlanRevisionId),readOnly:true,blockers:timeline?[]:['本场尚无可公开播放的已导出预演时间线'],availableMedia:model.publicAnimaticMedia||[],requiredCards:[],jobs:(model.animaticRenderJobs||[]).filter(j=>j.sceneId===sceneId),lock:(model.animaticLocks||[]).find(l=>l.sceneId===sceneId&&l.scopeRole==='CURRENT'&&l.fullSceneCurrent)||null,basis:null};
}
export async function saveAnimaticTimeline(tx,input,options={}){
 const replay=await requestReplay(tx,input);if(replay)return replay;const state=await readAnimaticState(tx,{sceneId:input.sceneId,...options});
 if(input.expectedReleaseId!==state.releaseId||input.expectedRevisionId!==state.revisionId)fail('时间线或发布版本已变化；保留编辑并重新核对');
 const basis=await basisFor(tx,input.sceneId,options),content=validateAnimaticTimeline(input.content,basis);await assertAnimaticInputs(tx,content,basis.model);
 const timelineRevisionId='animatic_'+randomUUID(),hashes=animaticHashes(content),impact=animaticImpact(state.content,content),revision={schemaVersion:'1.0',timelineRevisionId,sceneId:input.sceneId,createdAt:new Date().toISOString(),baseTimelineRevisionId:state.timelineRevisionId,content,hashes,impact};
 await put(tx,ANIMATIC_NS.revisions,timelineRevisionId,revision);const head=await put(tx,ANIMATIC_NS.heads,input.sceneId,{timelineRevisionId},state.revisionId);
 return remember(tx,input,{timelineRevisionId,revisionId:head.revisionId,hashes,impact,locked:false,formalReviewCreated:false});
}
function expectedAnimaticOutput(model,sceneId){
 const works=currentAnimaticWorks(model,sceneId).filter(w=>['ANIMATIC','ANIMATIC_TIMING_LOCK'].includes(w.deliverableKey));
 if(works.length!==1)fail('本场必须有一个当前预演工作项');const family=(model.assetFamilies||[]).find(f=>f.id===works[0].outputAssetRef);
 const outputs=(model.expectedOutputs||[]).filter(o=>o.familyId===works[0].outputAssetRef&&o.scopeRole==='CURRENT'&&(!family?.currentExpectedOutputId||o.id===family.currentExpectedOutputId));
 if(outputs.length!==1)fail('本场必须有一个当前预演 ExpectedOutput');
 const output=outputs[0];if(typeof output.targetPath!=='string'||!output.targetPath.startsWith('media/_review_pending/')||!output.targetPath.endsWith('.mp4')||output.targetPath.split('/').some(p=>!p||p==='.'||p==='..')||/[\\\0]/.test(output.targetPath))fail('预演输出必须使用受管实例中的新 MP4 候选路径');return{expectedOutput:output,workItem:works[0]};
}
export async function enqueueAnimaticRender(tx,input,options={}){
 const replay=await requestReplay(tx,input);if(replay)return replay;const state=await readAnimaticState(tx,{sceneId:input.sceneId,...options});
 if(state.stale||state.timelineRevisionId!==input.timelineRevisionId||state.revisionId!==input.expectedRevisionId||state.releaseId!==input.expectedReleaseId||!state.content)fail('请先保存并核对当前精确时间线修订');
 const basis=await basisFor(tx,input.sceneId,options),bindings=await assertAnimaticInputs(tx,state.content,basis.model,{render:true}),{expectedOutput,workItem}=expectedAnimaticOutput(basis.model,input.sceneId),metadata=await tx.getMetadata();
 if(state.jobs.some(j=>['QUEUED','RUNNING','RESULT_UNKNOWN'].includes(j.status)))fail('本场存在排队、执行或结果待核任务，请先核查');
 const previousSlots=(await tx.listAux(ANIMATIC_NS.slots)).map(read).filter(s=>s?.familyId===expectedOutput.familyId),media=await tx.listMedia(),lastNumber=Math.max(0,...previousSlots.map(s=>s.versionNumber),...media.filter(m=>m.mediaId===expectedOutput.familyId).map(m=>Number(m.versionId.match(/@V(\d+)$/)?.[1]||0))),versionNumber=lastNumber+1,label='V'+String(versionNumber).padStart(3,'0');
 const jobId='animatic_render_'+randomUUID(),baseExpectedOutputId=expectedOutput.baseExpectedOutputId||expectedOutput.id,slotId=versionNumber===1?baseExpectedOutputId:baseExpectedOutputId+':'+label;
 const slot={...expectedOutput,id:slotId,baseExpectedOutputId,familyId:expectedOutput.familyId,targetPath:expectedOutput.targetPath.replace(/\/[^/]+\.mp4$/,'/'+label+'.mp4'),versionNumber,plannedVersionLabel:label,legacyVersionId:expectedOutput.familyId+'@'+label,expectationState:'PLANNED',realizedVersionId:null,scopeRole:'CURRENT',activityRole:'CURRENT_PRODUCTION',sceneId:input.sceneId,workItemId:workItem.id,timelineRevisionId:state.timelineRevisionId,jobId,createdAt:new Date().toISOString()};
 const parent=state.jobs.find(j=>j.status==='SUCCEEDED'&&j.result?.familyId===slot.familyId)?.result||null;
 await put(tx,ANIMATIC_NS.slots,slot.id,slot);
 const job={schemaVersion:'1.0',...(previsPlan(basis.model,input.sceneId)?shotProductionPolicyMarkers('ANIMATIC'):{}),jobId,sceneId:input.sceneId,timelineRevisionId:state.timelineRevisionId,timelineHash:state.hashes.timelineHash,instanceId:metadata.instanceId,runtimeEpoch:metadata.runtimeEpoch,releaseId:metadata.releaseId,snapshotId:(await tx.readView()).snapshot.snapshotId,status:'QUEUED',createdAt:new Date().toISOString(),inputBindings:bindings,expectedOutput:{id:slot.id,familyId:slot.familyId,targetPath:slot.targetPath,versionId:slot.legacyVersionId},parentVersionId:parent?.versionId||null,parentVersionSha256:parent?.sha256||null,workItemId:workItem.id,reviewEventId:null,result:null};
 await put(tx,ANIMATIC_NS.jobs,job.jobId,job);return remember(tx,input,{jobId:job.jobId,status:job.status,formalReviewCreated:false});
}
export async function claimAnimaticRender(tx,jobId,workerId){const record=await tx.getAux(ANIMATIC_NS.jobs,jobId),job=read(record),metadata=await tx.getMetadata();if(!job||job.status!=='QUEUED')return null;
 if(job.instanceId!==metadata.instanceId||job.runtimeEpoch!==metadata.runtimeEpoch||job.releaseId!==metadata.releaseId)fail('任务的实例或发布已变化，不自动执行旧任务');const head=read(await tx.getAux(ANIMATIC_NS.heads,job.sceneId));if(head?.timelineRevisionId!==job.timelineRevisionId)fail('任务排队后时间线已变化');
 const claimed={...job,status:'RUNNING',workerId,startedAt:new Date().toISOString()};const next=await put(tx,ANIMATIC_NS.jobs,jobId,claimed,record.revisionId);return{job:claimed,jobRevisionId:next.revisionId,content:read(await tx.getAux(ANIMATIC_NS.revisions,job.timelineRevisionId)).content};}
export async function finishAnimaticRender(tx,{jobId,jobRevisionId,workerId,result,error},options={}){
 const record=await tx.getAux(ANIMATIC_NS.jobs,jobId),job=read(record);if(!job||record.revisionId!==jobRevisionId||job.status!=='RUNNING'||job.workerId!==workerId)fail('任务已被其他工作器处理');
 let next;if(error){next={...job,status:'FAILED',error:String(error).slice(0,1000),completedAt:new Date().toISOString()};}
 else{const metadata=await tx.getMetadata(),pointer=read(await tx.getAux(ANIMATIC_NS.heads,job.sceneId));if(metadata.runtimeEpoch!==job.runtimeEpoch||metadata.releaseId!==job.releaseId||pointer?.timelineRevisionId!==job.timelineRevisionId)fail('渲染期间精确输入已变化；产物保留待核，不绑定为当前候选');
  const revision=read(await tx.getAux(ANIMATIC_NS.revisions,job.timelineRevisionId)),model=await modelFor(tx,options);await assertAnimaticInputs(tx,revision.content,model,{render:true});
  if(result?.relativePath!==job.expectedOutput.targetPath||!Number.isSafeInteger(result.byteSize)||!/^[a-f0-9]{64}$/.test(result.sha256)||result.frameCount!==revision.hashes.totalFrames||result.fps!==24||result.width!==1920||result.height!==1080)fail('渲染产物缺少精确媒体及帧数验证');
  const output=job.expectedOutput,event=await tx.appendEvent({kind:'asset-version',idempotencyKey:job.jobId,requestHash:animaticHash({jobId,result}),eventSchemaVersion:'2.0',payload:{schemaVersion:'2.0',...(job.productionSchemaVersion==='2.0'?shotProductionPolicyMarkers('ANIMATIC'):{}),snapshotId:job.snapshotId,assetVersionEventId:'ave_'+randomUUID(),familyId:output.familyId,versionId:output.versionId,expectedOutputId:output.id,workItemId:job.workItemId,path:result.relativePath,sha256:result.sha256,byteSize:result.byteSize,mediaToken:token(output.versionId),outputState:'PRESENT',lifecycleState:'REVIEW_PENDING',registrationState:'REGISTERED',inputBindings:job.inputBindings,inputBindingsHash:animaticHash(job.inputBindings),timelineRevisionId:job.timelineRevisionId,timelineHash:job.timelineHash,renderJobId:job.jobId,executorKind:'DETERMINISTIC_RENDER',renderProof:result,observation:'UNOBSERVED',parentVersionId:job.parentVersionId,parentVersionSha256:job.parentVersionSha256,parentBindingState:job.parentVersionId?'BOUND':'EXPLICIT_ROOT'}});
  await tx.registerMedia({mediaId:output.familyId,versionId:output.versionId,relativePath:result.relativePath,sha256:result.sha256,byteSize:result.byteSize,aliases:[output.versionId,result.relativePath],metadata:{authorityDomain:'FORMAL',registrationEventId:event.event.eventId,renderJobId:job.jobId}});
  next={...job,status:'SUCCEEDED',completedAt:new Date().toISOString(),result:{...result,versionId:output.versionId,familyId:output.familyId,registrationEventId:event.event.eventId,mediaUrl:'/api/v8/media/'+token(output.versionId)}};
 }
 await put(tx,ANIMATIC_NS.jobs,jobId,next,record.revisionId);return next;
}
export function animaticCandidateMatchesJob(candidate,jobs){const job=(jobs||[]).find(j=>j.jobId===candidate.renderJobId);return Boolean(job?.status==='SUCCEEDED'&&job.registrationVerified===true&&job.result?.registrationEventId===candidate.eventId&&job.result.versionId===candidate.versionId&&job.result.familyId===candidate.familyId&&job.expectedOutput.id===candidate.expectedOutputId&&job.workItemId===candidate.workItemId&&job.result.relativePath===candidate.path&&job.result.sha256===candidate.sha256&&job.result.byteSize===candidate.byteSize&&job.timelineRevisionId===candidate.timelineRevisionId&&job.timelineHash===candidate.timelineHash&&animaticHash(job.inputBindings)===candidate.inputBindingsHash&&animaticHash(candidate.inputBindings)===candidate.inputBindingsHash);}
export function reconcileAnimaticLocks(model,state){return(model.animaticLocks||[]).map(lock=>{
 const current=lock.shotBindings||[],works=currentAnimaticWorks(model,lock.sceneId),available=(binding)=>{const family=state.assetFamiliesById?.[binding.familyId],version=state.assetVersionsById?.[binding.versionId];return family?.currentVersionId===binding.versionId&&family.canFlowDownstream===true&&version?.sha256===binding.sha256&&version.canFlowDownstream===true;};
 const plan=previsPlan(model,lock.sceneId),v2=lock.productionSchemaVersion==='2.0'&&lock.stagePolicy===PREVIS_FIRST_POLICY;
 const selectedValid=a=>{const work=matchingDialogueWork(works,a);return Boolean(work&&a.temporary===(work.productionPurpose==='TEMPORARY')&&plannedDialogue(plan).some(l=>l.id===work.lineId&&l.shotId===work.shotId&&l.text===work.dialogue?.text&&l.speakerEntityId===work.dialogue?.speakerEntityId&&l.performance===work.dialogue?.performance)&&available(a.media)&&!resolveShotProductionProducer(model,a.media).blockers.length);};
 const applicableShotIds=(lock.renderedVersion&&available(lock.renderedVersion)?lock.applicableShotIds||[]:[]).filter(shotId=>{const row=current.find(s=>s.shotId===shotId);if(!row)return false;const boards=works.filter(w=>w.deliverableKey==='STORYBOARD'&&w.shotId===shotId),lines=works.filter(w=>w.deliverableKey==='DIALOGUE_DRY'&&w.shotId===shotId);
  if(v2){if(!plan)return false;return row.storyboards.length>0&&row.storyboards.every(b=>boards.some(w=>w.outputAssetRef===b.familyId)&&available(b)&&!resolveShotProductionProducer(model,b).blockers.length)&&row.audio.every(a=>available(a.media)&&(!a.lineIds.length||selectedValid(a)))&&plannedDialogue(plan).filter(l=>l.shotId===shotId).every(line=>{const selected=lock.dialogueBindings.filter(a=>a.lineIds.includes(line.id));return selected.length===1&&selectedValid(selected[0]);});}
  return row.storyboards.length>0&&row.storyboards.every(b=>boards.some(w=>w.outputAssetRef===b.familyId)&&available(b))&&row.audio.every(a=>available(a.media)&&a.lineIds.every(id=>works.some(w=>w.deliverableKey==='DIALOGUE_DRY'&&w.lineId===id&&w.outputAssetRef===a.media.familyId)))&&lines.every(w=>lock.dialogueBindings.some(a=>a.lineIds.includes(w.lineId)&&a.media.familyId===w.outputAssetRef&&available(a.media)));
 });return{...lock,applicableShotIds,shotSlices:lock.shotSlices.filter(s=>applicableShotIds.includes(s.shotId)),scopeRole:applicableShotIds.length?'CURRENT':'HISTORICAL',fullSceneCurrent:lock.fullSceneCurrent&&applicableShotIds.length===lock.shotBindings.length};
 });}
export async function applyAnimaticProjection(tx,model){
 const jobs=[];for(const record of await tx.listAux(ANIMATIC_NS.jobs)){const job=read(record);if(!job)continue;let registrationVerified=false;if(job.status==='SUCCEEDED'&&job.result){const media=await tx.getMedia(job.result.familyId,job.result.versionId);registrationVerified=Boolean(media&&media.sha256===job.result.sha256&&media.byteSize===job.result.byteSize&&media.relativePath===job.result.relativePath&&media.metadata?.registrationEventId===job.result.registrationEventId&&(await mediaRetirementOverlay(tx,media)).state==='ACTIVE');}jobs.push({...job,registrationVerified});}
 const timelines=[];for(const row of await tx.listAux(ANIMATIC_NS.heads)){const head=read(row),revision=head&&read(await tx.getAux(ANIMATIC_NS.revisions,head.timelineRevisionId));if(revision)timelines.push({...revision,revisionId:row.revisionId});}
 const view=await tx.readView(),locks=[];for(const row of await tx.listAux(ANIMATIC_NS.locks)){const lock=read(row),timeline=timelines.find(t=>t.sceneId===lock?.sceneId);if(!lock)continue;const revision=read(await tx.getAux(ANIMATIC_NS.revisions,lock.timelineRevisionId));if(!revision)continue;
  let basis=null;try{basis=await basisFor(tx,lock.sceneId,{model});}catch{}
  const job=jobs.find(j=>j.jobId===lock.renderJobId),latest=(view.eventsByKind?.review||[]).filter(e=>e.subjectType==='WORK_PRODUCT'&&e.workItemId===job?.workItemId&&e.versionId===job?.result?.versionId&&e.applicationStatus==='APPLIED').sort((a,b)=>Number(b.eventSequence)-Number(a.eventSequence))[0],reviewCurrent=job?.registrationVerified===true&&latest?.eventId===lock.reviewEventId&&latest.action==='APPROVE_AND_RELEASE'&&latest.effect==='APPLIED'&&latest.canFlowDownstream===true;
  const v2=job?.productionSchemaVersion==='2.0'&&job.stagePolicy===PREVIS_FIRST_POLICY,content=revision.content,schedule=animaticHashes(content),currentSlices=timeline?.hashes.shotSlices||[],applicableShotIds=reviewCurrent&&basis&&basis.shotPlanRevisionId===content.shotPlanRevisionId?schedule.shotSlices.filter(old=>{const next=currentSlices.find(s=>s.shotId===old.shotId);return next&&old.timingHash===next.timingHash&&old.visualHash===next.visualHash&&old.boundaryHash===next.boundaryHash;}).map(s=>s.shotId):[];
  let cursor=0;const intervals=content.shots.map(s=>{const start=cursor;cursor+=s.durationFrames;return{shotId:s.shotId,start,end:cursor};});
  const shotBindings=content.shots.map(s=>{const interval=intervals.find(i=>i.shotId===s.shotId);return{shotId:s.shotId,storyboards:s.panels.map(p=>p.media),audio:content.audio.filter(a=>{const start=intervals.find(i=>i.shotId===a.anchorShotId).start+a.offsetFrames;return !a.muted&&a.volume>0&&start<interval.end&&start+a.durationFrames>interval.start;}).map(a=>({media:a.media,lineIds:a.role==='DIALOGUE'?a.lineIds:[],...(v2?{temporary:a.temporary,role:a.role}: {})}))};});
  locks.push({...lock,...(v2?shotProductionPolicyMarkers('ANIMATIC'):{}),shotPlanRevisionId:content.shotPlanRevisionId,renderedVersion:job?.result?{familyId:job.result.familyId,versionId:job.result.versionId,sha256:job.result.sha256}:null,shotSlices:schedule.shotSlices,shotBindings,dialogueBindings:content.audio.filter(a=>a.role==='DIALOGUE'&&!a.muted&&a.volume>0).map(a=>({media:a.media,lineIds:a.lineIds,...(v2?{temporary:a.temporary}: {})})),applicableShotIds,fullSceneCurrent:reviewCurrent&&timeline?.timelineRevisionId===lock.timelineRevisionId,scopeRole:applicableShotIds.length?'CURRENT':'HISTORICAL'});
 }
 const slots=(await tx.listAux(ANIMATIC_NS.slots)).map(read).filter(Boolean),byFamily=new Map();for(const slot of slots){const prior=byFamily.get(slot.familyId);if(!prior||slot.versionNumber>prior.versionNumber)byFamily.set(slot.familyId,slot);}
 const activeWorks=new Set((model.workItems||[]).filter(w=>w.scopeRole==='CURRENT'&&w.activeInCurrentProduction!==false).map(w=>w.id)),projectedSlots=slots.map(slot=>({...slot,scopeRole:activeWorks.has(slot.workItemId)&&byFamily.get(slot.familyId)?.id===slot.id?'CURRENT':'HISTORICAL'}));
 const slotIds=new Set(slots.map(s=>s.id)),expectedOutputs=[...(model.expectedOutputs||[]).filter(e=>!slotIds.has(e.id)).map(e=>byFamily.has(e.familyId)?{...e,scopeRole:'HISTORICAL'}:e),...projectedSlots];
 const assetFamilies=(model.assetFamilies||[]).map(f=>{const latest=byFamily.get(f.id);return latest&&activeWorks.has(latest.workItemId)?{...f,currentExpectedOutputId:latest.id,expectedOutputRefs:[...new Set([...(f.expectedOutputRefs||[]),...slots.filter(s=>s.familyId===f.id).map(s=>s.id)])]}:f;});
 return{...model,expectedOutputs,assetFamilies,animaticRenderJobs:jobs,animaticTimelines:timelines,animaticLocks:locks};
}
/** Called only by the formal review adapter; never exposed as a browser lock shortcut. */
export async function lockAnimaticTimeline(tx,{sceneId,timelineRevisionId,renderJobId,reviewEventId}){
 const head=read(await tx.getAux(ANIMATIC_NS.heads,sceneId)),job=read(await tx.getAux(ANIMATIC_NS.jobs,renderJobId)),view=await tx.readView(),event=(view.eventsByKind?.review||[]).find(e=>e.eventId===reviewEventId);
 const latest=(view.eventsByKind?.review||[]).filter(e=>e.subjectType==='WORK_PRODUCT'&&e.workItemId===job?.workItemId&&e.versionId===job?.result?.versionId&&e.applicationStatus==='APPLIED').sort((a,b)=>Number(b.eventSequence)-Number(a.eventSequence))[0];
 if(head?.timelineRevisionId!==timelineRevisionId||job?.status!=='SUCCEEDED'||job.timelineRevisionId!==timelineRevisionId||!event||latest?.eventId!==event.eventId||event.schemaVersion!=='2.2'||event.subjectType!=='WORK_PRODUCT'||event.subjectId!==job.workItemId||event.workItemId!==job.workItemId||event.productionGateId!=='ANIMATIC_LOCK'||event.scopeType!=='SCENE'||event.scopeId!==sceneId||event.versionId!==job.result.versionId||event.versionSha256!==job.result.sha256||event.familyId!==job.result.familyId||event.action!=='APPROVE_AND_RELEASE'||event.applicationStatus!=='APPLIED'||event.effect!=='APPLIED'||event.canFlowDownstream!==true||event.adoptionIntent!=='ADOPT_THIS_VERSION'||!event.reviewContextRef||!event.contextHash)fail('锁时必须来自本场精确渲染候选的正式放行事件');
 const record=await tx.getAux(ANIMATIC_NS.locks,sceneId),value={sceneId,timelineRevisionId,renderJobId,reviewEventId,lockedAt:new Date().toISOString()};await put(tx,ANIMATIC_NS.locks,sceneId,value,record?.revisionId||null);return value;
}
