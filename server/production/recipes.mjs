import {productionRecipeInputs} from './review-evidence.mjs';
import {check,hash,identity} from '../shared/contracts.mjs';
import {PresentationRead,idFor} from '../presentation/read-unit.mjs';
import {assets,materialRows} from '../presentation/materials.mjs';

const supported=['STORYBOARD','DIALOGUE_TEMP','DIALOGUE_DRY','START_FRAME','END_FRAME','INTERMEDIATE_FRAME','SHOT_VIDEO'];
const noteId=id=>'shot-recipe:'+hash(id).slice(0,32);
const ref=v=>({familyId:v.familyId,versionId:v.id,sha256:v.sha256,revisionId:v.revisionId,objectVersion:v.objectVersion,path:v.path});
export async function shotRecipeWorkspace(unit,workItemId){
 identity(workItemId);
 const rows=(await unit.rows(['EXPECTED_OUTPUT'])).filter(r=>r.content.workItemId===workItemId&&r.content.expectationState==='PLANNED');
 check(rows.length===1,'OUTPUT_IDENTITY','工作项须有唯一的当前预期产物',409);
 const output=await unit.detail(rows[0].id),c=output.revision.content;
 check(supported.includes(c.deliverableKey),'RECIPE_DELIVERABLE','此产物由对应锁定或预演流程处理',409);
 const settingsRows=(await unit.tx.query("SELECT r.id,r.object_id,r.content FROM dependencies d JOIN revisions r ON r.id=d.dependency_revision_id WHERE d.consumer_revision_id=$1 AND r.content->>'role'='SHOT_PRODUCTION_SETTINGS'",[output.revision.id])).rows;
 check(settingsRows.length===1,'RECIPE_BASIS','预期产物缺少唯一制作设置',409);
 const settings=await unit.detail(settingsRows[0].object_id),settingsRevision=settingsRows[0].id;
 const scene=await unit.detail(c.sceneId),shot=c.shotId?await unit.detail(c.shotId):null;
 const media=await assets(unit),requirements=await materialRows(unit),planned=settingsRows[0].content.settings;
 const selected=c.deliverableKey==='STORYBOARD'?planned.previsInputs||[]:c.deliverableKey==='DIALOGUE_TEMP'?[]:planned.inputs||[];
 const inputs=[],usageRevisions=[],blockers=[];let productionBasis=null;
 if(['START_FRAME','END_FRAME','INTERMEDIATE_FRAME','SHOT_VIDEO'].includes(c.deliverableKey))try{const needed=await productionRecipeInputs(unit,workItemId);productionBasis=needed.basis;inputs.push(...needed.inputs.map(v=>({...ref({...v,id:v.versionId}),workItemId:v.workItemId,slot:v.slot})));}catch(e){if(!e.code)throw e;blockers.push(e.message);}
 for(const binding of selected){
  const v=media.assetVersions.find(v=>v.id===binding.versionId&&v.familyId===binding.familyId&&v.sha256===binding.sha256&&v.canFlowDownstream);
  const req=requirements.find(r=>r.id===binding.requirementId),usage=req?.materialUsageBindings?.find(b=>b.eligible&&b.familyId===binding.familyId&&b.versionId===binding.versionId&&b.sha256===binding.sha256);
  if(!v||!req||!req.assetFamilyRefs.includes(binding.familyId)&&!usage){blockers.push('附件 '+binding.versionId+' 的采用、用途或权利已改变');continue;}
  inputs.push({...ref(v),requirementId:req.id,requirementRevisionId:req.revisionId,requirementVersion:req.objectVersion});if(usage)usageRevisions.push(usage.usageRevisionId);
 }
 if(settings.revision.id!==settingsRevision)blockers.push('镜头制作设置已换版，请先更新预期产物。');
 if(scene.historical||shot?.historical||['DISABLED','ARCHIVED'].includes(scene.state))blockers.push('历史或停用场次只读保留。');
 if((await unit.tx.query('SELECT 1 FROM invalidations WHERE consumer_revision_id=$1 LIMIT 1',[output.revision.id])).rowCount)blockers.push('预期产物的精确依据已改变，请先核对制作设置。');
 const old=(await unit.rows(['NOTE'],{ids:[noteId(workItemId)]}))[0],calls=(await unit.rows(['CALL'])).filter(r=>r.content.workItemRef===workItemId);
 const current=calls.find(r=>r.id===old?.content.currentCallId)||calls.at(-1)||null;
 const defaults=current?.content.authorContent||{model:'',prompt:shot?.revision.content.design?.visualIntent||shot?.revision.content.visualIntent||'',negativePrompt:'',parameters:{}};
 const basis={outputId:output.id,outputRevisionId:output.revision.id,settingsRevisionId:settingsRevision,sceneRevisionId:scene.revision.id,shotRevisionId:shot?.revision.id||null,inputs,usageRevisions,productionBasis};
 const releaseId=hash(basis),draft=old?.content.status==='DRAFT'?{revisionId:old.revisionId,content:old.content.authorContent,basisHash:old.content.basisHash}:null;
 if(draft&&draft.basisHash!==releaseId)blockers.push('草稿所据版本已改变；保留原编辑，重新核对后保存。');
 return {output,settings,scene,shot,old,current,basis,inputs,value:{releaseId,draftHeadRevisionId:old?.revisionId||null,draft,current:current?{...current.content,revisionId:current.revisionId}:null,defaults,inputs:inputs.map((v,i)=>({...v,order:i+1})),output:{...c,assetFamilyRef:idFor(output,'FAMILY'),expectedOutputRef:output.id},readOnly:scene.historical||shot?.historical||false,blockers,deliverableKey:c.deliverableKey,productionPurpose:c.deliverableKey==='DIALOGUE_TEMP'?'TEMPORARY':'PRODUCTION',allowedUse:['STORYBOARD','DIALOGUE_TEMP'].includes(c.deliverableKey)?'PREVIS_TIMING':'PRODUCTION',jobs:[]}};
}
function content(value){
 check(value&&Object.keys(value).every(k=>['model','prompt','negativePrompt','parameters'].includes(k))&&typeof value.model==='string'&&value.model.trim()&&value.model.length<=300&&typeof value.prompt==='string'&&value.prompt.trim()&&value.prompt.length<=48000&&typeof value.negativePrompt==='string'&&value.negativePrompt.length<=16000&&value.parameters&&typeof value.parameters==='object'&&!Array.isArray(value.parameters)&&JSON.stringify(value.parameters).length<=32000,'RECIPE_CONTENT','请填写完整模型、提示词及有界参数');return value;
}
export async function planShotRecipeChange(tx,input){
 const state=await shotRecipeWorkspace(new PresentationRead(tx),input.workItemId),{value,old,basis}=state;
 check(!value.readOnly,'HISTORICAL_READ_ONLY','历史工作项不能修改',409);
 const assertions=[state.output,state.settings,state.scene,state.shot].filter(Boolean).map(r=>({type:'assert',id:r.id,expectedVersion:r.version}));
 assertions.push(...state.inputs.flatMap(i=>[{type:'assert',id:i.versionId,expectedVersion:i.objectVersion},...(i.requirementId?[{type:'assert',id:i.requirementId,expectedVersion:i.requirementVersion}]:[])]));
 if(input.action==='save'){
  check(input.expectedReleaseId===value.releaseId&&(input.expectedDraftRevisionId||null)===value.draftHeadRevisionId,'VERSION_CONFLICT','调用包或制作依据已改变，未覆盖原编辑',409);
  const authorContent=content(input.content);
  return {commands:[...assertions,{type:'save',id:noteId(input.workItemId),kind:'NOTE',expectedVersion:old?.version||0,title:'镜头调用包草稿',content:{role:'SHOT_RECIPE',workItemId:input.workItemId,status:'DRAFT',authorContent,basisHash:value.releaseId,currentCallId:old?.content.currentCallId||null},links:state.output.links}],response:r=>({revisionId:r.at(-1).revisionId,modelCalls:0,generationAuthorized:false})};
 }
 check(['preview','publish'].includes(input.action)&&value.draft&&value.draft.revisionId===input.draftRevisionId&&!value.blockers.length,'RECIPE_DRAFT','请先保存并核对当前调用包及附件',409);
 const authorContent=content(value.draft.content),suffix=hash(old.revisionId).slice(0,32),callId='shot-call:'+suffix,promptId='shot-prompt:'+suffix;
 const definition={authorContent,workItemRef:input.workItemId,output:value.output,upload:{items:value.inputs.map(i=>({...i,assetFamilyRef:i.familyId,assetVersionRef:i.versionId}))},model:{branch:authorContent.model},prompt:{main:authorContent.prompt,negative:authorContent.negativePrompt},parametersRaw:JSON.stringify(authorContent.parameters),executorKind:'MODEL',definitionStatus:'DRAFT',basis,allowedUse:value.allowedUse};
 const previewHash=hash({draft:old.revisionId,definition});assertions.push({type:'assert',id:old.id,expectedVersion:old.version});
 if(input.action==='preview')return {commands:assertions,response:()=>({previewHash,definition,modelCalls:0,generationAuthorized:false})};
 check(input.previewHash===previewHash,'PREVIEW_STALE','调用包预览依据已改变',409);
 const commands=[...assertions,{type:'save',id:promptId,kind:'PROMPT',expectedVersion:0,title:'镜头制作提示词',content:{text:authorContent.prompt,negativePrompt:authorContent.negativePrompt},dependencies:[{revisionId:basis.outputRevisionId,purpose:'DEFINITION'}]}],promptIndex=commands.length-1;
 commands.push({type:'save',id:callId,kind:'CALL',expectedVersion:0,title:state.output.title+' · 调用包',content:{...definition,id:callId,title:state.output.title,definitionHash:previewHash},links:state.output.links,dependencies:[{revisionId:basis.outputRevisionId,purpose:'DEFINITION'},{revisionIdFrom:promptIndex,objectId:promptId,purpose:'CONTENT'},...state.inputs.map(i=>({revisionId:i.revisionId,purpose:'ACTUAL_INPUT'})),...basis.usageRevisions.map(revisionId=>({revisionId,purpose:'DEFINITION'}))]});
 commands.push({type:'save',id:old.id,expectedVersion:old.version,content:{...old.content,status:'PUBLISHED',currentCallId:callId}});
 return {commands,response:r=>({revisionId:r.at(-1).revisionId,callId,promptId,status:'SUCCEEDED',modelCalls:0,generationAuthorized:false,formalAdoptionPerformed:false})};
}
