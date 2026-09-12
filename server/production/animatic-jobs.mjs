import {check,hash} from '../shared/contracts.mjs';
import {PresentationRead} from '../presentation/read-unit.mjs';
import {animaticWorkspace} from '../presentation/animatics.mjs';
import {validateAnimaticTimeline,animaticMediaBindings} from './animatic-model.mjs';
import {transaction} from '../db.mjs';
export async function prepareAnimaticRender(pool,input,{operationId,runtimeEpoch}){
 check(input.action==='render','ANIMATIC_ACTION','请选择保存或生成预演；运行中的任务通过原操作编号核查',409);
 return transaction(pool,async tx=>{
  const clientHash=hash({input,runtimeEpoch}),prior=(await tx.query('SELECT request FROM operations WHERE id=$1',[operationId])).rows[0];
  if(prior){check(prior.request.kind==='ANIMATIC_RENDER'&&prior.request.clientHash===clientHash,'OPERATION_ID_CONFLICT','同一编号不能用于不同的预演请求',409);return prior.request;}
  const state=await animaticWorkspace(new PresentationRead(tx),input.sceneId);
  check(input.expectedReleaseId===state.releaseId&&input.expectedRevisionId===state.revisionId&&input.timelineRevisionId===state.timelineRevisionId,'VERSION_CONFLICT','时间线或镜头依据已改变，请保留草稿并重新核对',409);
  return {kind:'ANIMATIC_RENDER',operationId,runtimeEpoch,clientHash,objectId:state.objectId,revisionId:state.revisionId,expectedVersion:state.expectedVersion,sceneId:input.sceneId,authorized:true};
 },{readOnly:true});
}
export async function validateAnimaticRender(tx,request,{running=false}={}){
 check(request.authorized===true,'RENDER_AUTHORIZATION','生成预演须由用户明确操作',403);
 const state=await animaticWorkspace(new PresentationRead(tx),request.sceneId);
 check(state.objectId===request.objectId&&state.revisionId===request.revisionId&&state.expectedVersion===request.expectedVersion&&!state.readOnly&&!state.stale&&state.basis,'VERSION_CONFLICT','预演时间线或镜头依据已变化',409);
 const timeline=validateAnimaticTimeline(state.content);
 check(timeline.shots.every(s=>s.panels.length),'ANIMATIC_PANELS','每个镜头均须选择已审阅的粗分镜',409);
 for(const binding of animaticMediaBindings(timeline))check(state.availableMedia.some(m=>m.id===binding.versionId&&m.familyId===binding.familyId&&m.sha256===binding.sha256),'ANIMATIC_MEDIA','预演的精确输入已变化或尚未放行',409);
 const conflicts=await tx.query("SELECT id FROM operations WHERE kind='ANIMATIC_RENDER' AND request->>'objectId'=$1 AND status IN('QUEUED','RUNNING','RESULT_UNKNOWN') AND id<>$2 LIMIT 1",[request.objectId,request.operationId]);
 check(!conflicts.rowCount,'ANIMATIC_PENDING','本时间线已有未结束任务，先核查原操作：'+(conflicts.rows[0]?.id||''),409);
}
