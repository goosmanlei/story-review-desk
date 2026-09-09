import {canonicalJson,sha256} from './bytes.mjs';
export const UNSTARTED_CANCELLATION_SCHEMA='UNSTARTED_REQUEST_CANCELLATION_V1';
const hash=value=>sha256(canonicalJson(value)),same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const fail=message=>{throw Object.assign(Error(message),{code:'EXECUTION_CANCELLATION_CONFLICT'});};
const check=(ok,message)=>{if(!ok)fail(message);};
const text=v=>typeof v==='string'&&v.trim().length>0;
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
// Recognize complete executor declarations, never ID/token co-occurrence in free prose.
// The legacy continuation sentence remains byte-preserved in its original CLAIM.
const notCalledDeclaration=(note,id)=>{
 if(note===`Execution request ${id} NOT_CALLED: no Run, no candidate, zero provider calls.`)return true;
 const prefix=`Continuation of ${id} after snapshot change. Prior allocation NOT_CALLED: no Run, no candidate, zero provider calls; evidence `,suffix='. First actual provider attempt only; no retry.';
 if(!note.startsWith(prefix)||!note.endsWith(suffix))return false;
 const evidence=note.slice(prefix.length,-suffix.length);
 return /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)+\.json$/.test(evidence)&&!evidence.split('/').some(part=>part==='.'||part==='..');
};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const fields=['authorizationRuntime','snapshotId','executionRequestId','workItemId','familyId','executionDefinitionId','executionDefinitionHash','promptRevisionId','callPackageHash','executor','authorized','maxOutputs','inputBindings','inputBindingsHash'];
const binding=q=>Object.fromEntries(fields.filter(k=>q[k]!==undefined).map(k=>[k,q[k]]));
export const cancellationMarker=e=>Object.hasOwn(e,'cancellationReceipt')||e.action==='CANCEL_UNSTARTED'||e.eventKind==='execution-request'&&e.schemaVersion==='1.1';
export const cancellationHeadProof=e=>({eventId:e.eventId,eventSequence:e.eventSequence,sha256:hash(e)});
export function unstartedRequestHistory(events,executionRequestId,runtime){
 check(Array.isArray(events)&&text(executionRequestId),'取消必须有完整原事件历史和请求身份');
 const rows=events.filter(e=>e.eventKind==='execution-request'&&e.executionRequestId===executionRequestId).sort((a,b)=>a.eventSequence-b.eventSequence);
 check(rows.length>0&&rows.every(e=>Number.isSafeInteger(e.eventSequence)&&e.eventSequence>0&&text(e.eventId))&&new Set(rows.map(e=>e.eventSequence)).size===rows.length&&new Set(rows.map(e=>e.eventId)).size===rows.length,'原授权/领取历史缺失或不唯一');
 const first=rows[0],head=rows.at(-1);check(first.action==='AUTHORIZE'&&first.requestState==='AUTHORIZED'&&first.schemaVersion==='1.0','原请求必须由真实旧版 AUTHORIZE 开始');
 check(exact(first.authorizationRuntime,['instanceId','runtimeEpoch'])&&same(first.authorizationRuntime,runtime),'未启动撤销必须保持同一实例和运行代次');
 check(['snapshotId','workItemId','familyId','executionDefinitionId','executor'].every(k=>text(first[k]))&&first.authorized===true&&first.maxOutputs===1&&digest(first.callPackageHash)&&Array.isArray(first.inputBindings)&&first.inputBindingsHash===hash(first.inputBindings),'原请求调用/输入闭包不可核');
 for(let i=0;i<rows.length;i++){const q=rows[i];check(q.schemaVersion==='1.0'&&same(binding(q),binding(first))&&q.status===q.requestState,'原请求冻结绑定改变');check(i===0||i===1&&q.action==='CLAIM'&&q.requestState==='CLAIMED','原请求已经终态或历史转换不明');}
 check(['AUTHORIZED','CLAIMED'].includes(head.requestState),'仅未启动授权/领取可撤销');
 const related=e=>e.executionRequestId===executionRequestId||!text(e.executionRequestId)&&(e.workItemId===head.workItemId||e.familyId===head.familyId||e.executionDefinitionId===head.executionDefinitionId);
 check(!events.some(e=>['run','asset-version'].includes(e.eventKind)&&related(e)),'该请求已有 Run、候选或归属不明的执行证据；不能按未启动撤销');
 const notCalledEvidence=events.filter(e=>e.eventKind==='execution-request'&&e.schemaVersion==='1.0'&&e.action==='CLAIM'&&e.requestState==='CLAIMED'&&e.status==='CLAIMED'&&Number.isSafeInteger(e.eventSequence)&&e.eventSequence>0&&e.workItemId===head.workItemId&&e.familyId===head.familyId&&e.callPackageHash===head.callPackageHash&&same(e.authorizationRuntime,runtime)&&typeof e.note==='string'&&notCalledDeclaration(e.note,executionRequestId)).filter(e=>{
  const before=events.filter(q=>q.eventKind==='execution-request'&&q.executionRequestId===e.executionRequestId&&q.eventSequence<=e.eventSequence).sort((a,b)=>a.eventSequence-b.eventSequence),a=before[0];
  return before.length===2&&before[1].eventId===e.eventId&&a.schemaVersion==='1.0'&&a.action==='AUTHORIZE'&&a.requestState==='AUTHORIZED'&&a.status==='AUTHORIZED'&&Number.isSafeInteger(a.eventSequence)&&a.eventSequence>0&&a.eventSequence<e.eventSequence&&same(binding(a),binding(e));
 }).map(e=>({eventId:e.eventId,sha256:hash(e)}));
 return {head,history:rows.map(cancellationHeadProof),historyHash:hash(rows.map(cancellationHeadProof)),notCalledEvidence};
}
export function cancellationPublication(release){
 check(release&&text(release.releaseId)&&text(release.snapshotId)&&digest(release.snapshotSha256)&&digest(release.recipesSha256)&&text(release.profileRevisionId)&&Array.isArray(release.sourceRevisionIds),'取消时的实际发布闭包不可核');
 return {releaseId:release.releaseId,snapshotId:release.snapshotId,snapshotSha256:release.snapshotSha256,recipesSha256:release.recipesSha256,profileRevisionId:release.profileRevisionId,sourceRevisionIdsHash:hash(release.sourceRevisionIds)};
}
export async function readUnstartedCancellationBasis(tx,{executionRequestId}){
 const meta=await tx.getMetadata(),runtime={instanceId:meta.instanceId,runtimeEpoch:meta.runtimeEpoch},events=await tx.listEvents(),proof=unstartedRequestHistory(events,executionRequestId,runtime),release=await tx.readRelease();
 check(sha256(release.snapshotBytes)===release.snapshotSha256&&sha256(release.recipesBytes)===release.recipesSha256,'取消时实际发布字节SHA不符');
 const now=Date.now();check(Number.isFinite(Date.parse(release.createdAt))&&Date.parse(release.createdAt)<now,'当前发布与取消同毫秒或时间不可核，请重新读取后提交；不得追加无法保全的回执');
 const group=await tx.readPublishedReleaseTimeGroup({recordedBefore:new Date(now).toISOString()});
 check(group.length===1&&group[0].createdAt===release.createdAt&&same(cancellationPublication(group[0]),cancellationPublication(release)),'取消并非唯一最新先前实际发布；不得追加无法保全的回执');
 return {...proof,runtime,publication:cancellationPublication(release)};
}
export function buildUnstartedCancellation(basis,input,{snapshotId,expectedEtag,note}){
 check(exact(input,['schemaVersion','purpose','requestSnapshotId','expectedHead','historyHash','notCalledAttestation'])&&input.schemaVersion===UNSTARTED_CANCELLATION_SCHEMA&&input.purpose==='CANCEL_UNSTARTED_ALLOCATION','未启动取消协议或字段不完整');
 check(input.requestSnapshotId===basis.head.snapshotId&&same(input.expectedHead,cancellationHeadProof(basis.head))&&input.historyHash===basis.historyHash,'旧请求头或完整历史已变化');
 check(snapshotId===basis.publication.snapshotId&&text(expectedEtag),'当前取消CAS与实际发布不符');
 check(exact(input.notCalledAttestation,['confirmed','basis','evidenceRefs'])&&input.notCalledAttestation.confirmed===true&&text(input.notCalledAttestation.basis)&&input.notCalledAttestation.basis.length<=20000&&text(note)&&note.length<=20000,'取消需要明确未调用声明与原因；零Run本身不冒充提供商查证');
 const evidence=input.notCalledAttestation.evidenceRefs;check(Array.isArray(evidence)&&evidence.length>0&&evidence.length<=20&&new Set(evidence.map(e=>e?.eventId)).size===evidence.length&&evidence.every(e=>exact(e,['eventId','sha256'])&&basis.notCalledEvidence.some(p=>same(p,e))),'未调用声明必须引用同一旧请求、调用包和运行代次的实际 NOT_CALLED 记录及原SHA');
 const receipt={schemaVersion:UNSTARTED_CANCELLATION_SCHEMA,purpose:input.purpose,priorHead:cancellationHeadProof(basis.head),requestHistoryHash:basis.historyHash,mutation:{...basis.publication,runtime:basis.runtime,expectedEtag},recordedRunCount:0,recordedCandidateCount:0,notCalledAttestation:input.notCalledAttestation};
 return {...binding(basis.head),action:'CANCEL_UNSTARTED',requestState:'CANCELLED',status:'CANCELLED',note,cancellationReceipt:receipt};
}
export function validateUnstartedCancellationEvents({events,instanceId,releaseContext}){
 check(Array.isArray(events),'取消历史必须完整');const selected=events.filter(cancellationMarker),result=[];
 for(const event of selected){
  const r=event.cancellationReceipt;check(event.eventKind==='execution-request'&&event.schemaVersion==='1.1'&&event.action==='CANCEL_UNSTARTED'&&event.requestState==='CANCELLED'&&event.status==='CANCELLED','新取消回执只能用于 schema1.1 CANCEL_UNSTARTED');
  check(exact(r,['schemaVersion','purpose','priorHead','requestHistoryHash','mutation','recordedRunCount','recordedCandidateCount','notCalledAttestation'])&&r.schemaVersion===UNSTARTED_CANCELLATION_SCHEMA&&r.purpose==='CANCEL_UNSTARTED_ALLOCATION','新取消回执缺失、损坏或未知');
  check(Number.isSafeInteger(event.eventSequence)&&event.eventSequence>0&&text(event.eventId)&&Number.isFinite(Date.parse(event.recordedAt)),'取消事件序列/时间缺失');
  check(exact(r.mutation,['releaseId','snapshotId','snapshotSha256','recipesSha256','profileRevisionId','sourceRevisionIdsHash','runtime','expectedEtag'])&&exact(r.mutation.runtime,['instanceId','runtimeEpoch'])&&r.mutation.runtime.instanceId===instanceId,'取消当前运行绑定无效');
  const before=events.filter(e=>e.eventSequence<event.eventSequence||e.eventSequence==null),proof=unstartedRequestHistory(before,event.executionRequestId,r.mutation.runtime);
  check(same(binding(event),binding(proof.head))&&same(r.priorHead,cancellationHeadProof(proof.head))&&r.requestHistoryHash===proof.historyHash&&r.recordedRunCount===0&&r.recordedCandidateCount===0,'取消原请求/零执行历史不符');
  const publication=releaseContext?.(event);check(publication&&same(cancellationPublication(publication),Object.fromEntries(Object.keys(cancellationPublication(publication)).map(k=>[k,r.mutation[k]])))&&Date.parse(publication.createdAt)<Date.parse(event.recordedAt),'取消没有精确先前实际发布证明');
  const rebuilt=buildUnstartedCancellation({...proof,runtime:r.mutation.runtime,publication:cancellationPublication(publication)},{schemaVersion:r.schemaVersion,purpose:r.purpose,requestSnapshotId:event.snapshotId,expectedHead:r.priorHead,historyHash:r.requestHistoryHash,notCalledAttestation:r.notCalledAttestation},{snapshotId:r.mutation.snapshotId,expectedEtag:r.mutation.expectedEtag,note:event.note});
  check(same(rebuilt.cancellationReceipt,r),'取消回执重算不一致');
  check(!events.some(e=>e.eventSequence>=event.eventSequence&&e.eventId!==event.eventId&&(['run','asset-version','execution-request'].includes(e.eventKind))&&e.executionRequestId===event.executionRequestId),'撤销后旧请求仍被再次执行或改写');
  result.push({eventId:event.eventId,executionRequestId:event.executionRequestId,receiptHash:hash(r)});
 }
 return result;
}
