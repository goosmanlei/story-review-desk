import {check,hash,identity} from '../shared/contracts.mjs';
import {PresentationRead,idFor,idsFor} from '../presentation/read-unit.mjs';
import {assets,materialRows} from '../presentation/materials.mjs';
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const text=(v,max)=>typeof v==='string'&&v.trim()&&v.length<=max;
const ref=v=>({familyId:v.familyId,versionId:v.id,sha256:v.sha256});
export async function materialProductionWorkspace(unit,input){
 identity(input.requirementId);
 const requirement=await unit.detail(input.requirementId);check(requirement.kind==='REQUIREMENT','REQUIREMENT_REQUIRED','请选择素材需求');
 const projected=(await materialRows(unit,{requirementId:requirement.id}))[0],media=await assets(unit);
 const old=(await unit.rows(['NOTE'],{ids:['material-production:'+requirement.id]}))[0];
 const families=media.assetFamilies.filter(f=>idsFor(requirement,'FAMILY').includes(f.id));
 check(families.length<=1,'MATERIAL_FAMILY_CHOICE','此需求有多个素材族，请先明确要修订的素材族',409);
 const family=families[0],versions=media.assetVersions.filter(v=>v.familyId===family?.id);
 const parent=versions.find(v=>v.id===family?.currentVersionRef)||null;
 const callRows=(await unit.rows(['CALL'])).filter(c=>idsFor(c,'REQUIREMENT').includes(requirement.id));
 const call=callRows.find(c=>c.id===old?.content.currentCallId)||callRows.filter(c=>!c.content.materialSettings).at(-1)||null;
 const value=call?.content||{},frozenRequirement=value.materialRequirementHash||null;
 const rebase=!!frozenRequirement&&frozenRequirement!==projected.requirementHash;
 const mode=input.mode==='REQUIREMENT_REBASE'?'REQUIREMENT_REBASE':parent?'REVISION':'FIRST_SETUP';
 const availableInputs=media.assetVersions.filter(v=>v.canFlowDownstream&&v.outputState==='PRESENT'&&v.familyId!==family?.id).map(v=>({...ref(v),label:v.title||media.assetFamilies.find(f=>f.id===v.familyId)?.title||v.id,kind:v.mediaKind,objectVersion:v.objectVersion,revisionId:v.revisionId}));
 const defaults=old?.content.currentContent||{model:typeof value.model==='string'?value.model:value.model?.id||value.model?.branch||'',prompt:typeof value.prompt==='string'?value.prompt:value.prompt?.main||'',negativePrompt:value.negativePrompt||value.prompt?.negative||'',parameters:object(value.parameters)?value.parameters:value.parametersRaw?{originalSpecification:value.parametersRaw}:{},inputBindings:value.inputBindings||[]};
 const basis={requirementId:requirement.id,requirementRevisionId:requirement.revision.id,requirementHash:projected.requirementHash,familyId:family?.id||null,parentVersionId:parent?.id||null,parentVersionSha256:parent?.sha256||null,callId:call?.id||null,callRevisionId:call?.revisionId||null,mode},basisHash=hash(basis);
 const draft=old?.content.status==='DRAFT'?{revisionId:old.revisionId,content:old.content.author,mode:old.content.mode,basisHash:old.content.basisHash,baseReleaseId:old.content.baseReleaseId,acknowledgement:old.content.acknowledgement}:null;
 const stale=draft&&draft.basisHash!==basisHash;
 const blockers=[];
 if(rebase&&mode!=='REQUIREMENT_REBASE')blockers.push('当前需求已偏离首次制作建档闭包，请核对差异并明确建立新制作基线。');
 if(mode==='REQUIREMENT_REBASE'&&!rebase)blockers.push('当前需求没有需要重设的基线差异。');
 if(parent&&!call)blockers.push('原素材缺少精确调用定义，请先补全调用依据。');
 if(requirement.historical)blockers.push('历史素材需求只读保留。');
 const count=Math.max(0,...versions.map(v=>Number(v.id.match(/@V(\d+)$/)?.[1]||v.versionLabel?.match(/V(\d+)$/)?.[1]||0)));
 return {requirement,projected,old,call,family,parent,availableInputs,basis,value:{requirementId:requirement.id,releaseId:basisHash,basisHash,mode,familyId:family?.id||null,parentVersionId:parent?.id||null,parentVersionSha256:parent?.sha256||null,plannedVersionLabel:'V'+String(count+1).padStart(3,'0'),currentDefinitionId:call?.id||null,currentRegistration:family?{familyId:family.id}:null,readOnly:requirement.historical,draftHeadRevisionId:draft?.revisionId||null,draft:stale?null:draft,staleDraft:stale?{...draft,reason:'需求、原版本或调用依据已改变'}:null,defaults,availableInputs,blockers,jobs:[],...(rebase?{rebase:{beforeHash:frozenRequirement,afterHash:projected.requirementHash,changes:[{path:'requirement',before:value.requirementBasis||{requirementHash:frozenRequirement},after:requirement.revision.content}]}}:{})}};
}
function validateContent(content,state){
 check(object(content)&&Object.keys(content).every(k=>['model','prompt','negativePrompt','parameters','inputBindings'].includes(k))&&text(content.model,300)&&text(content.prompt,48000)&&typeof content.negativePrompt==='string'&&content.negativePrompt.length<=16000&&object(content.parameters)&&JSON.stringify(content.parameters).length<=32000,'MATERIAL_CALL_CONTENT','请填写完整模型、提示词与参数');
 check(Array.isArray(content.inputBindings)&&content.inputBindings.length<=24&&new Set(content.inputBindings.map(b=>b.familyId)).size===content.inputBindings.length,'MATERIAL_INPUTS','参考素材重复或超过 24 项');
 const inputs=content.inputBindings.map(b=>state.availableInputs.find(v=>v.familyId===b.familyId&&v.versionId===b.versionId&&v.sha256===b.sha256));check(inputs.every(Boolean),'MATERIAL_INPUT_CHANGED','参考素材尚未采用、已失效或权利不满足，请核对原图版本',409);
 return inputs;
}
export async function planMaterialProductionChange(tx,input){
 const unit=new PresentationRead(tx),state=await materialProductionWorkspace(unit,input),{value,old,requirement}=state;
 check(!value.readOnly,'HISTORICAL_READ_ONLY','历史需求不能修改',409);
 const assertions=[requirement,state.call].filter(Boolean).map(r=>({type:'assert',id:r.id,expectedVersion:r.version}));
 if(input.action==='save'){
  check(input.expectedReleaseId===value.releaseId&&(input.expectedDraftRevisionId||null)===value.draftHeadRevisionId&&(!input.expectedBasisHash||input.expectedBasisHash===value.basisHash),'VERSION_CONFLICT','素材制作依据或草稿已改变，未覆盖本次编辑',409);
  const inputs=validateContent(input.content,state);assertions.push(...inputs.map(v=>({type:'assert',id:v.versionId,expectedVersion:v.objectVersion})));
  if(value.mode==='REQUIREMENT_REBASE')check(input.acknowledgement?.confirmed===true&&input.acknowledgement.beforeHash===value.rebase.beforeHash&&input.acknowledgement.afterHash===value.rebase.afterHash&&text(input.acknowledgement.note,2000),'REBASE_ACKNOWLEDGEMENT','请明确核对新旧需求差异',409);
  return {commands:[...assertions,{type:'save',id:'material-production:'+requirement.id,kind:'NOTE',title:'素材制作资料 · '+requirement.title,expectedVersion:old?.version||0,content:{role:'MATERIAL_PRODUCTION',status:'DRAFT',requirementId:requirement.id,mode:value.mode,author:input.content,basisHash:value.basisHash,baseReleaseId:value.releaseId,currentCallId:old?.content.currentCallId||null,currentContent:old?.content.currentContent||null,acknowledgement:input.acknowledgement||null},links:[{id:requirement.id,role:'REQUIREMENT'}]}],response:results=>({revisionId:results.at(-1).revisionId,modelCalls:0,formalAdoptionPerformed:false})};
 }
 check(['preview','publish'].includes(input.action)&&value.draft&&value.draft.revisionId===input.draftRevisionId&&!value.blockers.length,'MATERIAL_DRAFT_REQUIRED','草稿或依据已改变，请核对并重新保存',409);
 const inputs=validateContent(value.draft.content,state);assertions.push(...inputs.map(v=>({type:'assert',id:v.versionId,expectedVersion:v.objectVersion})));
 const familyId=state.family?.id||'material:'+hash(requirement.id).slice(0,24),suffix=hash({requirementId:requirement.id,draftRevisionId:old.revisionId}).slice(0,32),callId='material-call:'+suffix,promptId='material-prompt:'+suffix,expectedOutputId='material-output:'+suffix;
 const plan={schemaVersion:value.mode==='REQUIREMENT_REBASE'?'MATERIAL_PRODUCTION_REQUIREMENT_REBASE_V1':'MATERIAL_PRODUCTION_PLAN_V2',requirementId:requirement.id,basisHash:value.basisHash,mode:value.mode,familyId,parentVersionId:value.parentVersionId,plannedVersionLabel:value.plannedVersionLabel,content:value.draft.content,callId,promptId,expectedOutputId},previewHash=hash(plan);
 if(input.action==='preview')return {commands:[...assertions,{type:'assert',id:old.id,expectedVersion:old.version}],response:()=>({plan,previewHash,modelCalls:0,formalAdoptionPerformed:false})};
 check(input.previewHash===previewHash,'PREVIEW_STALE','制作资料预览已改变',409);
 const commands=[...assertions],author=value.draft.content;
 if(!state.family){commands.push({type:'save',id:familyId,kind:'MATERIAL',title:requirement.title,expectedVersion:0,content:{mediaKind:state.projected.mediaKind},links:[{id:requirement.id,role:'REQUIREMENT'}]});commands.push({type:'save',id:requirement.id,expectedVersion:requirement.version,content:requirement.revision.content,links:[...requirement.links,{id:familyId,role:'FAMILY'}]});}
 commands.push({type:'save',id:promptId,kind:'PROMPT',title:requirement.title+' · 制作提示词',expectedVersion:0,content:{text:author.prompt,negativePrompt:author.negativePrompt},dependencies:[{revisionId:requirement.revision.id,purpose:'DEFINITION'}]});
 const promptIndex=commands.length-1;
 commands.push({type:'save',id:callId,kind:'CALL',title:requirement.title+' · '+value.plannedVersionLabel,expectedVersion:0,content:{...author,materialSettings:true,workItemRef:state.call?.content.workItemRef||'material:'+requirement.id,materialRequirementHash:state.projected.requirementHash,requirementBasis:requirement.revision.content,parentVersionId:value.parentVersionId,plannedVersionLabel:value.plannedVersionLabel,output:{assetFamilyRef:familyId,mediaType:state.projected.mediaKind,expectedOutputRef:expectedOutputId},definitionStatus:'DRAFT',definitionHash:hash(plan)},links:[{id:familyId,role:'FAMILY'},{id:requirement.id,role:'REQUIREMENT'}],dependencies:[{revisionId:requirement.revision.id,purpose:'DEFINITION'},{revisionIdFrom:promptIndex,objectId:promptId,purpose:'CONTENT'},...inputs.map(v=>({revisionId:v.revisionId,purpose:'ACTUAL_INPUT'}))]});
 const callIndex=commands.length-1;
 commands.push({type:'save',id:expectedOutputId,kind:'EXPECTED_OUTPUT',expectedVersion:0,title:requirement.title+' · '+value.plannedVersionLabel,content:{callId,workItemId:state.call?.content.workItemRef||'material:'+requirement.id,expectationState:'PLANNED',plannedVersionLabel:value.plannedVersionLabel,parentVersionId:value.parentVersionId,mediaType:state.projected.mediaKind},links:[{id:familyId,role:'FAMILY'},{id:requirement.id,role:'REQUIREMENT'}],dependencies:[{revisionIdFrom:callIndex,objectId:callId,purpose:'DEFINITION'}]});
 for(const prior of (await unit.rows(['EXPECTED_OUTPUT'])).filter(r=>r.content.callId===state.call?.id&&r.content.expectationState==='PLANNED'))commands.push({type:'save',id:prior.id,expectedVersion:prior.version,content:{...prior.content,expectationState:'RETIRED',supersededBy:expectedOutputId}});
 commands.push({type:'save',id:old.id,expectedVersion:old.version,content:{...old.content,status:'PUBLISHED',currentCallId:callId,currentContent:author}});
 return {commands,response:results=>({revisionId:results.at(-1).revisionId,status:'SUCCEEDED',callId,promptId,familyId,expectedOutputId,modelCalls:0,formalAdoptionPerformed:false,generationAuthorized:false})};
}
