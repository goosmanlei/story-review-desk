import {selectShotRecipeInputFamilies,shotRecipeProductionBasis} from './shot-production-recipe-basis.mjs';
export {selectShotRecipeInputFamilies,shotRecipeProductionBasis,shotRecipeDefinitionBindingReasons} from './shot-production-recipe-basis.mjs';
import {randomUUID} from 'node:crypto';
import {canonicalJson} from './bytes.mjs';
import {executionDefinitionHash,SHOT_PRODUCTION_DEFINITION_HASH_SCHEMA} from './execution-definition-hash.mjs';
import {productionHash,productionId,productionBindingReasons,shotProductionEntryGates} from './shot-production-model.mjs';
import {readCurrentShotProductionModel} from './shot-production-service.mjs';
import {selectAnimaticLockForShot} from './animatic-model.mjs';
import {shotProductionConsumerRole,shotProductionInputConsumptionReasons} from './shot-production-stage-policy.mjs';

export const SHOT_RECIPE_NS={drafts:'shot-production-recipe-drafts',jobs:'shot-production-recipe-jobs',requests:'shot-production-recipe-requests'};
const read=r=>r&&!r.deleted?JSON.parse(r.bytes):null;
const fail=(message,code='DOMAIN_CONFLICT')=>{throw Object.assign(new Error(message),{code});};
const put=(tx,namespace,key,value,expectedRevisionId=null)=>tx.putAux({namespace,key,bytes:canonicalJson(value),mediaType:'application/json',expectedRevisionId});
const kinds=new Set(['STORYBOARD','DIALOGUE_TEMP','DIALOGUE_DRY','START_FRAME','END_FRAME','INTERMEDIATE_FRAME','SHOT_VIDEO']);
export function validateShotRecipeContent(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='model,negativePrompt,parameters,prompt')fail('调用包作者内容须为模型、提示词、负面提示和参数','DOMAIN_INVALID');
 productionId(value.model,'模型');if(value.model==='UNKNOWN')fail('调用包需明确模型','DOMAIN_INVALID');
 if(typeof value.prompt!=='string'||!value.prompt.trim()||value.prompt.length>80000||typeof value.negativePrompt!=='string'||value.negativePrompt.length>20000)fail('请填写完整实际提示词','DOMAIN_INVALID');
 if(!value.parameters||typeof value.parameters!=='object'||Array.isArray(value.parameters)||canonicalJson(value.parameters).length>20000)fail('参数必须是有限的JSON对象','DOMAIN_INVALID');
 const check=(v,depth=0)=>{if(depth>8)fail('参数嵌套过深','DOMAIN_INVALID');if(typeof v==='number'&&!Number.isFinite(v))fail('参数数字必须有限','DOMAIN_INVALID');if(v&&typeof v==='object')for(const [k,x] of Object.entries(v)){if(/^(api.?key|authorization|token|secret|password|headers|url|endpoint|base.?url|command|script|path|file|output|input)$/i.test(k)||['__proto__','prototype','constructor'].includes(k))fail('调用参数不得包含凭证、路径或执行指令','DOMAIN_INVALID');check(x,depth+1);}};check(value.parameters);
 return JSON.parse(canonicalJson(value));
}
export function shotRecipeExpectedOutput(model,sourceModel,familyId){
 const family=(model.assetFamilies||[]).find(f=>f.id===familyId),source=(sourceModel.assetFamilies||[]).find(f=>f.id===familyId),id=family?.currentExpectedOutputId||source?.currentExpectedOutputId;
 const rows=(model.expectedOutputs||[]).filter(o=>o.id===id&&o.familyId===familyId&&(source?.expectedOutputRefs||[]).includes(o.id));return rows.length===1?rows[0]:null;
}
async function context(tx,workItemId,api){
 const {view,model,state}=await readCurrentShotProductionModel(tx,{api}),work=(model.workItems||[]).find(w=>w.id===workItemId&&w.scopeRole==='CURRENT'&&w.activeInCurrentProduction===true),plan=work&&(model.shotProductionPlans||[]).find(p=>p.scopeRole==='CURRENT'&&(p.workItemIds||[]).includes(work.id));
 if(!work||!plan||!kinds.has(work.deliverableKey))fail('仅可编写当前镜头制作中的图像、对白或视频调用包');
 const family=(model.assetFamilies||[]).find(f=>f.id===work.outputAssetRef),settings=plan.content.shots.find(s=>s.shotId===work.shotId),spec=model.shots.find(s=>s.id===work.shotId);
 if(!family||!settings||!spec)fail('本镜制作定义缺项');
 const selectedInputs=selectShotRecipeInputFamilies(model,work,settings),inputFamilies=new Set(selectedInputs.familyIds);
 const inputs=[],blockers=[...(shotProductionEntryGates(model,state)[work.id]||[]),...selectedInputs.blockers];
 for(const familyId of inputFamilies){
  const f=state.assetFamiliesById[familyId],v=state.assetVersionsById[f?.currentVersionId];
  if(family.kind==='IMAGE'&&f?.kind==='AUDIO')continue;
  const binding={familyId,versionId:v?.id,sha256:v?.sha256};const reasons=[...productionBindingReasons(model,state,binding,{consumerRole:shotProductionConsumerRole(work,plan)}),...shotProductionInputConsumptionReasons(model,work,binding)];if(reasons.length){blockers.push(...reasons.map(r=>r+':'+familyId));continue;}
  const registered=await tx.getMedia(familyId,v.id);if(!registered||registered.sha256!==v.sha256||registered.availability!=='PRESENT')blockers.push('INPUT_REGISTRATION_NOT_CURRENT:'+familyId);
  inputs.push({order:inputs.length+1,path:v.path,assetFamilyRef:familyId,assetVersionRef:v.id,sha256:v.sha256,label:f.label||v.id});
 }
 if(work.deliverableKey==='DIALOGUE_DRY'&&!inputs.length)blockers.push('角色声音母版尚未就绪');
 const output=shotRecipeExpectedOutput(model,view.snapshot.productionModel,family.id);if(!output)blockers.push('当前预期产物未登记');
 const selectedLock=selectAnimaticLockForShot(model.animaticLocks,{sceneId:plan.sceneId,shotPlanRevisionId:plan.content.shotPlanRevisionId,shotId:work.shotId});
 const timing=selectedLock?.slice||null;
 const frameSet=(model.shotKeyframeSets||[]).find(s=>s.scopeRole==='CURRENT'&&s.shotId===work.shotId)||null;
 const basis=shotRecipeProductionBasis(model,work,plan,inputs);
 return {view,model,state,work,plan,family,settings,spec,inputs,output,timing,frameSet,basis,basisHash:productionHash(basis),blockers:[...new Set(blockers)]};
}
export async function getShotRecipeWorkspace(tx,{workItemId,api}){
 const c=await context(tx,workItemId,api),record=await tx.getAux(SHOT_RECIPE_NS.drafts,workItemId),draft=read(record),definition=c.view.recipes.executionDefinitions.find(d=>d.id===c.work.executionDefinitionRef);
 const defaults={model:'',prompt:[c.spec.visualIntent,c.spec.actionIntent,c.spec.soundIntent,c.work.dialogue?.text,c.work.dialogue?.performance].filter(Boolean).join('\n'),negativePrompt:'',parameters:{}};
 const current=definition?{definitionId:definition.id,content:definition.authoringContent||{model:definition.model?.branch||'',prompt:definition.prompt?.main||'',negativePrompt:definition.prompt?.negative||'',parameters:definition.parameters||{}}}:null;
 return {workItemId,deliverableKey:c.work.deliverableKey,productionPurpose:c.work.productionPurpose||null,allowedUse:c.work.allowedUse||null,releaseId:c.view.releaseId,draftHeadRevisionId:record?.revisionId||null,draft:draft?{...draft,revisionId:record.revisionId}:null,current,defaults,inputs:c.inputs,output:c.output,blockers:c.blockers,basis:c.basis,basisHash:c.basisHash,readOnly:false,jobs:(await tx.listAux(SHOT_RECIPE_NS.jobs)).map(read).filter(j=>j?.workItemId===workItemId).map(({jobId,status,error})=>({jobId,status,error}))};
}
export async function saveShotRecipeDraft(tx,input,{api}){
 const c=await context(tx,input.workItemId,api);if(c.view.releaseId!==input.expectedReleaseId)fail('发布版本已变化');const content=validateShotRecipeContent(input.content);
 const value={workItemId:input.workItemId,content,baseReleaseId:c.view.releaseId,basisHash:c.basisHash},record=await put(tx,SHOT_RECIPE_NS.drafts,input.workItemId,value,input.expectedDraftRevisionId);return {revisionId:record.revisionId,formalAdoptionPerformed:false};
}
export async function previewShotRecipe(tx,input,{api}){
 const c=await context(tx,input.workItemId,api),record=await tx.getAux(SHOT_RECIPE_NS.drafts,input.workItemId),draft=read(record);
 if(!draft||record.revisionId!==input.draftRevisionId||draft.baseReleaseId!==c.view.releaseId||draft.basisHash!==c.basisHash)fail('调用包草稿或实际输入闭包已变化');if(c.blockers.length)fail('调用包前置条件未就绪：'+c.blockers.join('、'));
 return compileShotRecipePreview(c,draft.content,{draftRevisionId:record.revisionId});
}
/** Pure compilation after the transactional source and entry gates have passed. */
export function compileShotRecipePreview(c,content,{draftRevisionId}){
 content=validateShotRecipeContent(content);
 if(c.family.kind==='VIDEO'){
  const frames=Number(c.timing?.durationFrames??c.timing?.localDurationFrames),minimum=frames+Number(c.settings.handles.headFrames)+Number(c.settings.handles.tailFrames);
  if(!Number.isSafeInteger(frames)||frames<=0||content.parameters.fps!==24||!Number.isFinite(content.parameters.durationSeconds)||content.parameters.durationSeconds*24<minimum)fail('视频参数须明确24fps，并覆盖锁定时长和前后剪辑余量');
 }
 const currentVersion=c.state.assetVersionsById[c.state.assetFamiliesById[c.family.id]?.currentVersionId];
 const nextNumber=Math.max(0,...(c.model.expectedOutputs||[]).filter(o=>o.familyId===c.family.id).map(o=>Number(String(o.plannedVersionLabel||'').replace(/^V/,''))||0))+1;
 const versionLabel='V'+String(nextNumber).padStart(3,'0'),extension=c.family.kind==='IMAGE'?'.png':c.family.kind==='AUDIO'?'.wav':'.mp4';
 const needsNewOutput=Boolean(currentVersion||c.output.expectationState==='REALIZED'||(c.model.assetVersions||[]).some(v=>v.familyId===c.family.id));
 const output=needsNewOutput?{...c.output,id:'SP-EO-'+productionHash({workItemId:c.work.id,draftRevisionId:draftRevisionId}).slice(0,24),targetPath:'media/_review_pending/shot-production/'+c.family.id+'/'+versionLabel+extension,plannedVersionLabel:versionLabel,expectationState:'PLANNED',realizedVersionId:null}:c.output;
 const id='SP-CALL-'+productionHash({workItemId:c.work.id,draftRevisionId:draftRevisionId}).slice(0,24),revisionId=id+':r1';
 const definition={id,title:c.work.label,pipelineStageCode:c.work.pipelineStageCode,executorKind:'MODEL_CALL',definitionStatus:'DEFINED',workItemRef:c.work.id,currentRevisionId:revisionId,upload:{rawText:c.inputs.map(i=>i.label).join('\n'),items:c.inputs.map(({label,...b})=>b)},model:{branch:content.model,rawRule:content.model,resolution:String(content.parameters.resolution||'EXPLICIT_PARAMETERS')},parameters:content.parameters,parametersRaw:canonicalJson(content.parameters),prompt:{main:content.prompt,negative:content.negativePrompt,negativeApplication:content.negativePrompt?'APPLY_WITH_MAIN_PROMPT':'NONE'},output:{path:output.targetPath,mediaType:c.family.kind,assetFamilyRef:c.family.id,expectedOutputRef:output.id},declaredGate:'READY_TO_START',rawSourceBlock:canonicalJson(content),authoringContent:content,productionBasis:c.basis,productionBasisHash:c.basisHash,parentVersionId:currentVersion?.id||null};
 if(c.work.productionSchemaVersion==='2.0')Object.assign(definition,{productionSchemaVersion:'2.0',stagePolicy:c.work.stagePolicy,productionPurpose:c.work.productionPurpose,allowedUse:c.work.allowedUse});
 definition.definitionHashSchemaVersion=SHOT_PRODUCTION_DEFINITION_HASH_SCHEMA;
 definition.definitionHash=executionDefinitionHash(definition);
 const body={workItemId:c.work.id,draftRevisionId:draftRevisionId,expectedReleaseId:c.view.releaseId,basisHash:c.basisHash,definition,expectedOutput:output,previousDefinitionId:c.work.executionDefinitionRef||null};return {...body,previewHash:productionHash(body),modelCalls:0};
}
export async function enqueueShotRecipe(tx,input,{api}){
 const old=read(await tx.getAux(SHOT_RECIPE_NS.requests,input.requestId));if(old){if(old.requestHash!==productionHash(input))fail('请求编号已经用于其他调用包');return old.result;}
 productionId(input.requestId);const preview=await previewShotRecipe(tx,input,{api});if(input.previewHash!==preview.previewHash)fail('调用包预览已变化');
 if((await tx.listAux(SHOT_RECIPE_NS.jobs)).map(read).some(j=>j?.workItemId===input.workItemId&&j.status==='QUEUED'))fail('此调用包已有排队任务');
 const meta=await tx.getMetadata(),job={jobId:'sp_recipe_'+randomUUID(),workItemId:input.workItemId,createdAt:new Date().toISOString(),status:'QUEUED',instanceId:meta.instanceId,runtimeEpoch:meta.runtimeEpoch,input,preview};await put(tx,SHOT_RECIPE_NS.jobs,job.jobId,job);const result={jobId:job.jobId,status:job.status,modelCalls:0};await put(tx,SHOT_RECIPE_NS.requests,input.requestId,{requestHash:productionHash(input),result});return result;
}
export async function applyShotRecipeJob(tx,{jobId,api}){
 const record=await tx.getAux(SHOT_RECIPE_NS.jobs,jobId),job=read(record);if(job?.status==='SUCCEEDED')return job.result;if(job?.status!=='QUEUED')fail('调用包任务不能自动重试');
 const meta=await tx.getMetadata();if(meta.instanceId!==job.instanceId||meta.runtimeEpoch!==job.runtimeEpoch)fail('调用包任务实例已变化');
 const preview=await previewShotRecipe(tx,job.input,{api});if(preview.previewHash!==job.preview.previewHash)fail('工作器执行前调用包已变化');
 const view=await tx.readView(),snapshot=structuredClone(view.snapshot),recipes=structuredClone(view.recipes),model=snapshot.productionModel,definition=preview.definition,sourcePath='story/shot-production/recipes/'+definition.id+'.json';
 const source=await tx.putDocument({documentId:'shot-call:'+definition.id,aliases:[sourcePath],expectedRevisionId:null,bytes:canonicalJson(definition),mediaType:'application/json',metadata:{sourceRole:'SHOT_EXECUTION_DEFINITION'}});
 recipes.executionDefinitions=[...recipes.executionDefinitions,{...definition,sourceRef:sourcePath,sourceRevisionId:source.revisionId,sourceSha256:source.sha256}];
 recipes.promptRevisions=[...(recipes.promptRevisions||[]),{id:definition.currentRevisionId,executionDefinitionId:definition.id,definitionHash:definition.definitionHash,prompt:definition.prompt,sourceRef:sourcePath,sourceRevisionId:source.revisionId,sourceSha256:source.sha256}];
 const work=model.workItems.find(w=>w.id===preview.workItemId);work.executionDefinitionRef=definition.id;work.promptRef=definition.currentRevisionId;work.definitionStatus='DEFINED';
 const family=model.assetFamilies.find(f=>f.id===work.outputAssetRef),output=preview.expectedOutput;
 if(!model.expectedOutputs.some(o=>o.id===output.id))model.expectedOutputs.push(output);
 const expected=model.expectedOutputs.find(o=>o.id===output.id);expected.executionDefinitionRef=definition.id;
 family.currentExpectedOutputId=output.id;family.expectedOutputRefs=[...new Set([...(family.expectedOutputRefs||[]),output.id])];
 model.shotProductionRecipeRevisions=[...(model.shotProductionRecipeRevisions||[]),{id:definition.id,workItemId:work.id,sourcePath,sourceRevisionId:source.revisionId,sourceSha256:source.sha256,definitionHash:definition.definitionHash}];
 snapshot.snapshotId='snapshot_'+productionHash({previous:view.snapshot.snapshotId,definitionHash:definition.definitionHash}).slice(0,32);recipes.snapshotId=snapshot.snapshotId;
 const release=await tx.publishRelease({snapshot,recipes,sourceRevisionIds:[...view.sourceRevisionIds,source.revisionId],expectedReleaseId:view.releaseId}),result={releaseId:release.releaseId,definitionId:definition.id,definitionHash:definition.definitionHash,modelCalls:0};
 await put(tx,SHOT_RECIPE_NS.jobs,jobId,{...job,status:'SUCCEEDED',completedAt:new Date().toISOString(),result},record.revisionId);return result;
}
export async function runShotRecipeIteration({repository,api}){
 if(repository.readOnly||process.env.REVIEW_INSTANCE_READ_ONLY==='1'||process.env.REVIEW_REMOTE_READ_ONLY==='1')throw Error('只读实例不能发布调用包');
 const job=await repository.readTransaction(async tx=>(await tx.listAux(SHOT_RECIPE_NS.jobs)).map(read).filter(j=>j?.status==='QUEUED').sort((a,b)=>a.createdAt.localeCompare(b.createdAt))[0]);if(!job)return {processed:false};
 try{return {processed:true,status:'SUCCEEDED',...await repository.writeTransaction(tx=>applyShotRecipeJob(tx,{jobId:job.jobId,api}))};}catch(e){await repository.writeTransaction(async tx=>{const record=await tx.getAux(SHOT_RECIPE_NS.jobs,job.jobId),current=read(record);if(current.status==='QUEUED')await put(tx,SHOT_RECIPE_NS.jobs,job.jobId,{...current,status:'FAILED',error:String(e.message||e).slice(0,1500)},record.revisionId);});return {processed:true,jobId:job.jobId,status:'FAILED'};}
}
