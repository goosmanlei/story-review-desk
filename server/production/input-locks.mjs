import {productionRecipeInputs} from './review-evidence.mjs';
import {check,hash,identity} from '../shared/contracts.mjs';
import {PresentationRead,idsFor} from '../presentation/read-unit.mjs';
import {presentRecipe} from '../presentation/recipe.mjs';

export async function inputLockWorkspace(unit,input) {
 identity(input.callId);
 const call=await unit.detail(input.callId),c=call.revision.content;
 check(call.kind==='CALL'&&!call.historical&&!['DISABLED','ARCHIVED'].includes(call.state),'CALL_REQUIRED','请选择当前调用定义',409);
 const outputs=(await unit.rows(['EXPECTED_OUTPUT'])).filter(o=>o.content.expectationState==='PLANNED'&&(o.id===c.output?.expectedOutputRef||o.content.callId===call.id));
 check(outputs.length===1,'EXPECTED_OUTPUT_REQUIRED','调用包须有一个精确预期产物',409);
 const output=outputs[0],familyIds=idsFor(output,'FAMILY');check(familyIds.length===1,'OUTPUT_FAMILY','请明确唯一输出素材族',409);
 const notes=(await unit.rows(['NOTE'])).filter(n=>['MATERIAL_PRODUCTION','SHOT_RECIPE'].includes(n.content.role)&&n.content.currentCallId&&((n.content.workItemId===c.workItemRef)||idsFor(call,'REQUIREMENT').includes(n.content.requirementId)));
 check(notes.every(n=>n.content.currentCallId===call.id),'CALL_SUPERSEDED','调用包已有新版本，请重新核对',409);
 const dependencies=(await unit.tx.query("SELECT d.purpose,o.id,o.kind,o.version,o.state,o.adopted_revision_id,r.id AS revision_id,r.content FROM dependencies d JOIN revisions r ON r.id=d.dependency_revision_id JOIN objects o ON o.id=r.object_id WHERE d.consumer_revision_id=$1 AND (d.purpose='ACTUAL_INPUT' OR o.kind='PROMPT') ORDER BY o.id",[call.revision.id])).rows;
 const blockers=[],inputs=[],reviewObjects=[call];
 if(c.basis?.productionBasis)try{const needed=await productionRecipeInputs(unit,c.workItemRef);if(hash(needed.basis)!==hash(c.basis.productionBasis))blockers.push('本镜锁时、关键帧或声音输入已变化，请更新调用包');}catch(e){if(!e.code)throw e;blockers.push(e.message);}
 for(const d of dependencies){
  const detail=await unit.detail(d.id);
  if(detail.revision.id!==d.revision_id)blockers.push('输入 '+d.id+' 已换版，请先更新调用包');
  if(d.kind==='PROMPT'){reviewObjects.push(detail);continue;}
  if(d.kind!=='ASSET'||d.adopted_revision_id!==d.revision_id||d.state==='DISABLED'){blockers.push('输入 '+d.id+' 尚未采用或已禁用');continue;}
  const media=(await unit.tx.query("SELECT m.* FROM asset_media a JOIN media m ON (m.id,m.version_id)=(a.media_id,a.media_version_id) WHERE a.revision_id=$1 AND a.role='OUTPUT'",[d.revision_id])).rows;
  const rights=detail.rights;
  if(rights?.fact==='BLOCKED'||rights?.fact!=='CLEAR'&&!rights?.internal_attestation&&!rights?.internalAttestation)blockers.push('输入 '+d.id+' 缺少适用的权利依据');
  if(media.length!==1||media[0].availability!=='PRESENT')blockers.push('输入 '+d.id+' 原件缺失、退役或身份不唯一');
  inputs.push({id:d.id,version:d.version,revisionId:d.revision_id,familyId:idsFor(detail,'FAMILY')[0],sha256:media[0]?.sha256||null,mediaUrl:media[0]?.availability==='PRESENT'?'/api/v1/media/'+media[0].sha256:null});
 }
 const declared=c.upload?.items||c.inputBindings||[];
 if(declared.length!==inputs.length||declared.some(i=>!inputs.some(actual=>actual.id===(i.assetVersionRef||i.versionId)&&actual.familyId===(i.assetFamilyRef||i.familyId)&&(!i.sha256||i.sha256===actual.sha256))))blockers.push('调用包附件列表与精确素材依赖不一致，请先在制作资料中重新核对。');
 const stale=(await unit.tx.query('SELECT 1 FROM invalidations WHERE consumer_revision_id=ANY($1::text[]) LIMIT 1',[[call.revision.id,output.revisionId,...dependencies.map(d=>d.revision_id)]])).rowCount;
 if(stale)blockers.push('调用包或输入的精确依据已失效，请先核对新版本');
 await unit.configuration();const defaults=(unit.systemConfiguration.reviewStandards||[]).filter(s=>s.subjectKind==='INPUT_LOCK'&&s.default!==false&&!s.mediaType),lockSpec=defaults.length===1?{...defaults[0],configurationVersion:unit.configurationVersions.system}:null;
 const reviewRequired=reviewObjects.filter(r=>r.adoptedRevisionId!==r.revision.id).map(r=>({id:r.id,kind:r.kind,title:r.title,revisionId:r.revision.id,version:r.version,criteria:r.revision.content.reviewSpec?.criteria||[]}));
 const basis={callId:call.id,callRevisionId:call.revision.id,callVersion:call.version,outputId:output.id,outputRevisionId:output.revisionId,outputVersion:output.version,familyId:familyIds[0],inputs,reviewRequired,lockSpec};
 const lockId='input-lock:'+hash({call:call.revision.id,output:output.revisionId,inputs}).slice(0,32),lock=(await unit.rows(['INPUT_LOCK'],{ids:[lockId]}))[0];
 return {call,output,reviewObjects,dependencies,inputs,lock,basis,lockSpec,value:{snapshotId:await unit.namespace(),basisHash:hash(basis),recipe:presentRecipe(call),inputs,reviewRequired,lockCriteria:lockSpec?.criteria||[],blockers,lock:lock?{id:lock.id,revisionId:lock.revisionId,version:lock.version,state:lock.state}:null}};
}
export async function planInputLockChange(tx,input) {
 const state=await inputLockWorkspace(new PresentationRead(tx),input);
 check(input.action==='confirm'&&input.explicit===true&&input.basisHash===state.value.basisHash,'INPUT_LOCK_CONFIRMATION','请核对并明确确认当前调用包与实际输入',409);
 check(!state.value.blockers.length,'INPUT_LOCK_BLOCKED',state.value.blockers.join('；'),409);
 check(typeof input.note==='string'&&input.note.trim(),'INPUT_LOCK_NOTE','请说明本次核对依据');
 check(!state.lock,'INPUT_LOCK_EXISTS','本次输入已建立锁定，请查询原锁定',409);
 const commands=[...(state.lockSpec?[{type:'configuration.assert',scope:'system',expectedVersion:state.lockSpec.configurationVersion}]:[]),{type:'assert',id:state.output.id,expectedVersion:state.output.version},...state.inputs.map(i=>({type:'assert',id:i.id,expectedVersion:i.version}))];
 for(const row of state.reviewObjects){
  if(row.adoptedRevisionId===row.revision.id){commands.push({type:'assert',id:row.id,expectedVersion:row.version});continue;}
  const findings=(row.revision.content.reviewSpec?.criteria||[]).map(c=>({criterionId:c.id,verdict:input.confirmedCriteria?.includes(row.id+'|'+c.id)?'PASS':'UNKNOWN',note:input.note}));
  check(input.confirmedRevisionIds?.includes(row.revision.id),'INPUT_REVIEW_REQUIRED','请逐项确认调用包及提示词版本',409);
  if(row.state!=='SUBMITTED')commands.push({type:'submit',id:row.id,expectedVersion:row.version});
  commands.push({type:'review',id:row.id,expectedVersion:row.version+(row.state==='SUBMITTED'?0:1),revisionId:row.revision.id,explicit:true,decision:'ADOPT',findings,note:input.note});
 }
 const lockId='input-lock:'+hash({call:state.call.revision.id,output:state.output.revisionId,inputs:state.inputs}).slice(0,32),saveIndex=commands.length;
 commands.push({type:'save',id:lockId,kind:'INPUT_LOCK',expectedVersion:0,title:state.call.title+' · 实际输入',content:{role:'CALL_INPUT_LOCK',basis:state.basis,description:input.note,...(state.lockSpec?{reviewSpec:state.lockSpec}:{})},links:[{id:state.basis.familyId,role:'FAMILY'}],dependencies:[{revisionId:state.call.revision.id,purpose:'ACTUAL_INPUT'},...state.dependencies.map(d=>({revisionId:d.revision_id,purpose:'ACTUAL_INPUT'})),{revisionId:state.output.revisionId,purpose:'DEFINITION'}]});
 commands.push({type:'submit',id:lockId,expectedVersion:1},{type:'review',id:lockId,expectedVersion:2,revisionIdFrom:saveIndex,explicit:true,decision:'ADOPT',note:input.note,findings:(state.lockSpec?.criteria||[]).map(c=>({criterionId:c.id,verdict:input.confirmedCriteria?.includes('lock|'+c.id)?'PASS':'UNKNOWN',note:input.note}))});
 return {commands,response:r=>({id:lockId,revisionId:r[saveIndex].revisionId,version:3,state:'ADOPTED',generationAuthorized:false,modelCalls:0})};
}
