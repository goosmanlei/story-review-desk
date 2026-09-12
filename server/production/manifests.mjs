import {check,hash} from '../shared/contracts.mjs';
import {PresentationRead,idFor} from '../presentation/read-unit.mjs';
import {transaction} from '../db.mjs';
import {productionContext,productionEvidenceTemplate,productionVersion,visualInputs} from './review-evidence.mjs';
import {shotSettingsBasis} from './shot-settings.mjs';

export async function productionManifest(unit,workItemId){
 const c=await productionContext(unit,workItemId);
 check(['SHOT_INPUT_LOCK','LOCKED_SHOT'].includes(c.value.deliverableKey),'MANIFEST_KIND','此工作项不使用制作清单',409);
 const template=await productionEvidenceTemplate(unit,workItemId),inputBindings=[],dependencies=[{revisionId:c.settings.revision.id,purpose:'DESIGN'},{revisionId:c.design.revisionId,purpose:'DESIGN'}];
 if(c.value.deliverableKey==='SHOT_INPUT_LOCK'){
  const visual=await visualInputs(c);inputBindings.push(...visual.inputs);
  dependencies.push(...visual.inputs.flatMap(v=>[{revisionId:v.revisionId,purpose:'ACTUAL_INPUT'},{revisionId:v.requirementRevisionId,purpose:'DEFINITION'},...(v.usageRevisionId?[{revisionId:v.usageRevisionId,purpose:'DEFINITION'}]:[])]),{revisionId:visual.sourceBinding.revisionId,purpose:'DESIGN'},...(visual.localView?[{revisionId:visual.localView.revisionId,purpose:'DESIGN'}]:[]));
 }else for(const media of template.observationMedia){
  const output=(await unit.rows(['EXPECTED_OUTPUT'])).find(o=>idFor(o,'FAMILY')===media.familyId&&o.content.expectationState==='PLANNED');check(output,'MANIFEST_INPUT','验收媒体的原预期产物缺失',409);
  const version=await productionVersion(unit,output,{versionId:media.versionId});inputBindings.push({familyId:version.familyId,versionId:version.versionId,sha256:version.sha256,revisionId:version.revisionId});dependencies.push({revisionId:version.revisionId,purpose:'ACTUAL_INPUT'});
 }
 const familyId=idFor(c.output,'FAMILY'),content={schemaVersion:'2.0',protocol:'SHOT_PRODUCTION_MANIFEST_V2',stagePolicy:'PREVIS_FIRST_V1',workItemId,familyId,deliverableKey:c.value.deliverableKey,productionPlanId:c.value.productionPlanId,productionRevisionId:c.settings.revision.id,sceneId:c.scene.id,shotId:c.shot?.id||null,shotPlanRevisionId:c.design.revisionId,reviewBinding:template.evidence,inputBindings,formalReviewCreated:false,lockState:'REVIEW_REQUIRED'};
 return {content,manifestHash:hash(content),workItemId,familyId,expectedOutputId:c.output.id,outputRevisionId:c.output.revisionId,expectedVersion:c.output.version,inputBindings,dependencies:[...new Map(dependencies.map(d=>[d.revisionId+':'+d.purpose,d])).values()],expectedReleaseId:(await shotSettingsBasis(unit,c.scene.id)).releaseId};
}
export async function planManifestPreview(tx,input){
 const unit=new PresentationRead(tx),manifest=await productionManifest(unit,input.workItemId);check(manifest.content.sceneId===input.sceneId,'MANIFEST_SCENE','清单不能换绑其他场',409);
 const commands=[...unit.productionProofIds].filter(Boolean).map(id=>unit.basis.get(id)).filter(Boolean).map(r=>({type:'assert',id:r.objectId,expectedVersion:r.expectedVersion}));
 return {commands,response:()=>manifest};
}
export async function prepareManifestRender(pool,input,{operationId,runtimeEpoch}){
 return transaction(pool,async tx=>{
  const clientHash=hash({input,runtimeEpoch}),prior=(await tx.query('SELECT request FROM operations WHERE id=$1',[operationId])).rows[0];
  if(prior){check(prior.request.kind==='PRODUCTION_MANIFEST_RENDER'&&prior.request.clientHash===clientHash,'OPERATION_ID_CONFLICT','同一编号不能用于不同的清单请求',409);return prior.request;}
  const manifest=await productionManifest(new PresentationRead(tx),input.workItemId);
  check(manifest.manifestHash===input.manifestHash&&manifest.expectedReleaseId===input.expectedReleaseId&&manifest.content.sceneId===input.sceneId,'MANIFEST_CHANGED','清单或本场制作依据已变化，请重新预览',409);
  return {kind:'PRODUCTION_MANIFEST_RENDER',operationId,runtimeEpoch,clientHash,objectId:manifest.expectedOutputId,revisionId:manifest.outputRevisionId,expectedVersion:manifest.expectedVersion,sceneId:input.sceneId,workItemId:input.workItemId,manifest,dependencies:manifest.dependencies,authorized:true};
 },{readOnly:true});
}
export async function validateManifestRender(tx,request){
 check(request.authorized===true,'MANIFEST_AUTHORIZATION','生成制作清单须由用户明确操作',403);
 const current=await productionManifest(new PresentationRead(tx),request.workItemId);
 check(hash(current)===hash(request.manifest)&&hash(current.dependencies)===hash(request.dependencies)&&current.expectedOutputId===request.objectId&&current.outputRevisionId===request.revisionId&&current.expectedVersion===request.expectedVersion,'MANIFEST_CHANGED','排队期间清单的实际输入已变化',409);
 const pending=(await tx.query("SELECT id FROM operations WHERE kind='PRODUCTION_MANIFEST_RENDER' AND request->>'objectId'=$1 AND status IN ('QUEUED','RUNNING','RESULT_UNKNOWN') AND id<>$2 LIMIT 1",[request.objectId,request.operationId])).rows[0];
 check(!pending,'MANIFEST_PENDING','此清单已有未结束的操作，请先核查 '+(pending?.id||''),409);
}
