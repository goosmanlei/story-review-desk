import {check,hash,identity} from '../shared/contracts.mjs';
import {PresentationRead,idsFor} from '../presentation/read-unit.mjs';
import {verifyAdoption} from './service.mjs';

const inputOf=row=>row.request.commands[0].input;
export async function executionRecord(tx,id){
 identity(id);
 const row=(await tx.query("SELECT id,request,result FROM operations WHERE status='SUCCEEDED' AND result#>>'{workspace,executionRequestId}'=$1 AND request#>>'{commands,0,workspace}'='execution-requests' ORDER BY created_at LIMIT 1",[id])).rows[0];
 check(row,'EXECUTION_REQUEST','本运行期没有此执行授权',404);return row;
}
async function executionBasis(unit,input){
 check(input.snapshotId===await unit.namespace(),'CONTEXT_INSTANCE','执行请求不属于当前运行期',409);
 const calls=(await unit.rows(['CALL'])).filter(r=>r.content.workItemRef===input.workItemId||r.id===input.executionDefinitionId);
 const call=calls.find(c=>c.content.definitionHash===input.callPackageHash);
 check(call&&(!input.executionDefinitionId||call.id===input.executionDefinitionId),'CALL_CHANGED','调用包版本或工作项已改变',409);
 check(!input.callRevisionId||input.callRevisionId===call.revisionId,'CALL_CHANGED','调用包修订已改变',409);
 const expectedBindings=(call.content.upload?.items||call.content.inputBindings||[]).map((i,index)=>({order:i.order||index+1,assetFamilyRef:i.assetFamilyRef||i.familyId||'',assetVersionRef:i.assetVersionRef||i.versionId||'',sha256:i.sha256||null}));
 const actualBindings=(input.inputBindings||[]).map(i=>({order:i.order,assetFamilyRef:i.assetFamilyRef,assetVersionRef:i.assetVersionRef,sha256:i.sha256||null}));
 check(hash(expectedBindings)===hash(actualBindings),'INPUT_BINDINGS_CHANGED','实际附件与所核对调用包不一致',409);
 const notes=(await unit.rows(['NOTE'])).filter(n=>['MATERIAL_PRODUCTION','SHOT_RECIPE'].includes(n.content.role)&&n.content.currentCallId&&((n.content.workItemId===input.workItemId)||idsFor(call,'REQUIREMENT').includes(n.content.requirementId)));check(notes.every(n=>n.content.currentCallId===call.id),'CALL_SUPERSEDED','本工作项已有新的调用包，请核对当前版本',409);
 const expected=(await unit.rows(['EXPECTED_OUTPUT'])).filter(o=>o.content.expectationState==='PLANNED'&&(o.id===call.content.output?.expectedOutputRef||o.content.callId===call.id));
 check(expected.length===1,'EXPECTED_OUTPUT_REQUIRED','请先登记精确预期产物',409);
 const family=idsFor(expected[0],'FAMILY');check(family.length===1&&family[0]===(input.familyId||family[0]),'OUTPUT_FAMILY','输出素材族不一致',409);
 const locks=(await unit.rows(['INPUT_LOCK'])).filter(l=>l.state==='ADOPTED'&&idsFor(l,'FAMILY').includes(family[0]));
 let lock;
 for(const candidate of locks){const deps=(await unit.tx.query("SELECT dependency_revision_id FROM dependencies WHERE consumer_revision_id=$1 AND purpose='ACTUAL_INPUT'",[candidate.adoptedRevisionId])).rows;if(deps.some(d=>d.dependency_revision_id===call.revisionId)){check(!lock,'INPUT_LOCK_AMBIGUOUS','有多个符合条件的输入锁定，请指定精确锁定');lock=candidate;}}
 check(lock,'INPUT_LOCK_REQUIRED','请先核对并采用本次调用包的实际输入锁定；制作设置不等同输入锁定',409);
 const detail=await unit.detail(lock.id);await verifyAdoption(unit.tx,detail,lock.adoptedRevisionId);
 check(!(await unit.tx.query('SELECT 1 FROM invalidations WHERE consumer_revision_id=$1 LIMIT 1',[lock.adoptedRevisionId])).rowCount,'INPUT_LOCK_STALE','实际输入已失效，请核对原操作与新版本',409);
 const basis={callId:call.id,callRevisionId:call.revisionId,callPackageHash:input.callPackageHash,workItemId:call.content.workItemRef,familyId:family[0],expectedOutputId:expected[0].id,expectedOutputRevisionId:expected[0].revisionId,inputLockId:lock.id,inputLockRevisionId:lock.adoptedRevisionId,inputBindings:expectedBindings};
 return {basis,lock,commands:[call,expected[0],lock].map(r=>({type:'assert',id:r.id,expectedVersion:r.version}))};
}
export async function planExecutionChange(tx,workspace,input,context){
 const unit=new PresentationRead(tx);
 check(context.runtimeEpoch,'EXECUTION_EPOCH','执行操作必须绑定当前运行期',409);
 if(workspace==='execution-requests'){
  check(input.action==='AUTHORIZE'&&input.authorized===true&&input.maxOutputs===1&&['CODEX','USER_EXTERNAL'].includes(input.executor),'EXECUTION_AUTHORIZATION','请明确本次执行者和单个产物范围');
  const state=await executionBasis(unit,input);
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,3))',[state.basis.inputLockRevisionId]);
  const active=(await tx.query("SELECT result#>>'{workspace,executionRequestId}' AS id FROM operations WHERE status='SUCCEEDED' AND request#>>'{commands,0,workspace}'='execution-requests' AND result#>>'{workspace,basis,inputLockRevisionId}'=$1 AND request->>'runtimeEpoch'=$2 LIMIT 1",[state.basis.inputLockRevisionId,context.runtimeEpoch])).rows[0];
  check(!active,'EXECUTION_ALREADY_AUTHORIZED','此精确输入已有本轮授权，请查询原请求：'+(active?.id||''),409);
  return {commands:state.commands,response:()=>({executionRequestId:'xreq_'+hash(context.operationId).slice(0,32),basis:state.basis,executor:input.executor,maxOutputs:1,state:'AUTHORIZED',runtimeEpoch:context.runtimeEpoch,modelCalls:0,...(input.executor==='CODEX'?{generationRequest:{operationId:'generation:'+hash(context.operationId).slice(0,32),kind:'GENERATE',runtimeEpoch:context.runtimeEpoch,objectId:state.lock.id,revisionId:state.lock.adoptedRevisionId,expectedVersion:state.lock.version,authorized:true,authorization:{objectId:state.lock.id,revisionId:state.lock.adoptedRevisionId},executionRequestId:'xreq_'+hash(context.operationId).slice(0,32)}}:{})})};
 }
 const authorization=await executionRecord(tx,input.executionRequestId),grant=authorization.result.workspace;
 check(authorization.request.runtimeEpoch===context.runtimeEpoch,'EXECUTION_EPOCH','旧运行期授权不能恢复或重用',409);
 await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,3))',[input.executionRequestId]);
 const state=await executionBasis(unit,{...inputOf(authorization),...input,workItemId:grant.basis.workItemId,familyId:grant.basis.familyId});
 check(hash(state.basis)===hash(grant.basis),'EXECUTION_BASIS_CHANGED','本次实际调用依据已变化，旧授权已失效',409);
 const runs=(await tx.query("SELECT id,result FROM operations WHERE status='SUCCEEDED' AND request#>>'{commands,0,workspace}'='runs' AND result#>>'{workspace,executionRequestId}'=$1 ORDER BY created_at DESC,id DESC",[input.executionRequestId])).rows.map(r=>({...r.result.workspace,eventId:r.id}));
 if(workspace==='runs'){
  check(grant.executor==='USER_EXTERNAL','EXTERNAL_EXECUTOR','仅用户外部执行可人工登记平台事实');
  check(['SUBMITTED','SUCCEEDED','FAILED','RESULT_UNKNOWN'].includes(input.state),'RUN_STATE','运行状态无效');
  const head=runs[0];
  if(input.state==='SUBMITTED')check(!head&&!input.runId,'RUN_ALREADY_EXISTS','此授权已有运行记录，请查询原运行，不得重复提交',409);
  else {check(head&&head.runId===input.runId&&['SUBMITTED','RESULT_UNKNOWN'].includes(head.state),'RUN_STATE_CONFLICT','原运行已改变或已有最终结果',409);check(input.expectedRunEventId===head.eventId,'RUN_VERSION_CONFLICT','请先回读运行版本，未覆盖已有事实',409);}
  check(typeof input.providerRunId==='string'&&input.providerRunId.trim()&&input.providerRunId.length<=500,'PROVIDER_RUN_REQUIRED','请填写外部平台的实际任务编号');
  if(['FAILED','RESULT_UNKNOWN'].includes(input.state))check(typeof input.note==='string'&&input.note.trim(),'RUN_NOTE_REQUIRED','请说明可核查的结果情况');
  return {commands:state.commands,response:()=>({eventId:context.operationId,runId:head?.runId||'run_'+hash(context.operationId).slice(0,32),state:input.state,executionRequestId:input.executionRequestId,providerRunId:input.providerRunId,note:input.note||'',modelCalls:0})};
 }
 check(workspace==='imports'&&runs[0]?.runId===input.runId&&runs[0].state==='SUCCEEDED','RUN_NOT_SUCCEEDED','仅已登记成功的精确运行可以接收候选',409);
 check(input.expectedRunEventId===runs[0].eventId,'RUN_VERSION_CONFLICT','运行记录已改变',409);
 check(input.expectedOutputId===grant.basis.expectedOutputId&&input.executionDefinitionId===grant.basis.callId,'OUTPUT_BINDING','候选预期产物或调用身份不一致',409);
 const prior=(await tx.query("SELECT id FROM operations WHERE status='SUCCEEDED' AND request#>>'{commands,0,workspace}'='imports' AND request#>>'{commands,0,input,executionRequestId}'=$1 LIMIT 1",[input.executionRequestId])).rows[0];check(!prior,'OUTPUT_ALREADY_REGISTERED','本次单产物授权已有候选，请查询原登记',409);
 const media=(await tx.query("SELECT * FROM media WHERE id=$1 AND version_id=$2 AND sha256=$3 AND availability='PRESENT'",[input.mediaId,input.mediaVersionId,input.sha256])).rows[0];check(media,'CANDIDATE_MEDIA','请先通过受控媒体上传接口登记实际文件与 SHA',409);
 check(input.actualPrompt&&typeof input.actualPrompt.main==='string'&&input.actualPrompt.main.trim(),'ACTUAL_PROMPT_REQUIRED','请登记实际执行的完整提示词');
 if(input.parentVersionId){const parent=await unit.detail(input.parentVersionId);check(parent.kind==='ASSET'&&idsFor(parent,'FAMILY').includes(grant.basis.familyId),'PARENT_FAMILY','父版本不属于本次素材族',409);state.commands.push({type:'assert',id:parent.id,expectedVersion:parent.version});}
 const versionId='asset:'+hash(context.operationId).slice(0,32);
 return {commands:[...state.commands,{type:'save',id:versionId,kind:'ASSET',expectedVersion:0,title:input.label||'外部执行候选',content:{role:'EXECUTION_OUTPUT',label:input.label||'外部执行候选',executionRequestId:input.executionRequestId,runId:input.runId,providerRunId:runs[0].providerRunId,parentVersionId:input.parentVersionId||null,actualPrompt:input.actualPrompt,basis:grant.basis,authority:'L'},links:[{id:grant.basis.familyId,role:'FAMILY'}],dependencies:[{revisionId:grant.basis.inputLockRevisionId,purpose:'ACTUAL_INPUT'}],media:[{id:media.id,versionId:media.version_id,sha256:media.sha256,role:'OUTPUT'}]}],response:r=>({versionId,revisionId:r.at(-1).revisionId,state:'DRAFT',formalAdoptionPerformed:false,modelCalls:0})};
}
export async function executionState(tx,id){const record=await executionRecord(tx,id);const epoch=(await tx.query('SELECT runtime_epoch FROM project')).rows[0].runtime_epoch;check(record.request.runtimeEpoch===epoch,'EXECUTION_EPOCH','旧运行期授权只读留存，不能恢复',409);const runs=(await tx.query("SELECT id,result FROM operations WHERE status='SUCCEEDED' AND request#>>'{commands,0,workspace}'='runs' AND result#>>'{workspace,executionRequestId}'=$1 ORDER BY created_at DESC,id DESC",[id])).rows;return {...record.result.workspace,runs:runs.map(r=>({...r.result.workspace,eventId:r.id})),latestRun:runs[0]?{...runs[0].result.workspace,eventId:runs[0].id}:null};}
