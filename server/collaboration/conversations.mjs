import {transaction} from '../db.mjs';
import {check,hash,identity} from '../shared/contracts.mjs';
import {mutationGate} from '../runtime-gate.mjs';
import {assistantContext,assertSourceVersions,publicContext} from './assistant-context.mjs';

const namespace=id=>'assistant:conversation:'+id;
const active=['QUEUED','RUNNING','RESULT_UNKNOWN'];
export const turnId=key=>'turn_'+hash('turn\0'+key).slice(0,32);
export const conversationId=key=>'codx_'+hash('conversation\0'+key).slice(0,32);
const headHash=(session,jobs)=>hash({id:session.id,version:session.version,turns:jobs.map(j=>[j.id,j.status])});
async function sessionJobs(tx,id){return (await tx.query("SELECT id,status,request,result,error,created_at FROM operations WHERE kind='AI_SUGGEST' AND request #>> '{assistant,conversationId}'=$1 ORDER BY created_at,id LIMIT 51",[id])).rows;}

export async function bridgeState(tx){
  const row=(await tx.query("SELECT value,updated_at FROM runtime_status WHERE name='worker'")).rows[0],system=(await tx.query("SELECT content FROM configurations WHERE scope='system'")).rows[0];
  const online=!!row&&Date.now()-new Date(row.updated_at).valueOf()<20000&&row.value.capabilities?.includes('AI_SUGGEST')&&system?.content.assistant?.enabled!==false;
  return {online,status:online?'READY':'OFFLINE',model:row?.value.assistantModel||undefined,schedulerProtocol:'REVIEW_SINGLE_WORKER_V1',workContextProtocol:'REVIEW_WORK_CONTEXT_V1',workContextPreflightVerified:online,executionProtocol:'REVIEW_DRAFT_PREVIEW_V1'};
}
export async function readConversation(tx,id){
  identity(id);const row=(await tx.query('SELECT value FROM runtime_status WHERE name=$1',[namespace(id)])).rows[0];check(row,'CONVERSATION_NOT_FOUND','本机对话不存在',404);
  const session=row.value,jobs=await sessionJobs(tx,id),messages=[];
  for(const job of jobs){
    const meta=job.request.assistant,context=publicContext(meta.context),tid=turnId(job.id);
    messages.push({id:tid,role:'user',text:job.request.prompt,status:'SUCCEEDED',mode:meta.mode,context});
    if(job.status==='SUCCEEDED'){
      const suggestion=(await tx.query('SELECT content,expires_at,applied_revision_id FROM suggestions WHERE operation_id=$1 AND (expires_at>now() OR applied_revision_id IS NOT NULL)',[job.id])).rows[0];
      let stale=!suggestion;
      if(suggestion)try{await assertSourceVersions(tx,[...meta.context.sourceVersions,...suggestion.content.sourceVersions||[]]);}catch{stale=true;}
      const changePreview=meta.mode==='EXECUTE'&&suggestion?.content.changePreview?.fields.length?{...suggestion.content.changePreview,suggestionId:job.id,appliedRevisionId:suggestion.applied_revision_id}:undefined;
      messages.push({id:tid+':assistant',role:'assistant',text:suggestion?.content.summary||'本轮建议已超过 10 分钟保留期；执行状态和请求编号仍可核查。',status:job.status,mode:meta.mode,context,changePreview,workContext:{packetId:context.packetId,packetHash:context.packetHash,focusKey:context.focusKey,evidenceIds:[...new Set((suggestion?.content.sourceVersions||[]).map(s=>s.objectId).filter(Boolean))],observedImageIds:suggestion?.content.observedImageIds||[],suggestions:suggestion?.content.draftSuggestions||[],stale}});
    }else if(['FAILED','CANCELLED','RESULT_UNKNOWN'].includes(job.status))messages.push({id:tid+':assistant',role:'assistant',text:job.error?.message||({CANCELLED:'本轮已取消，未调用模型。',RESULT_UNKNOWN:'本轮结果未知，请核查原请求；不会自动重新调用。'}[job.status]||'本轮未完成。'),status:job.status,mode:meta.mode,context});
  }
  const running=jobs.find(j=>active.includes(j.status)),status=running?.status||'READY';
  return {id,assistantProtocol:'REVIEW_WORK_CONTEXT_V1',headHash:headHash(session,jobs),state:status,canSend:!session.archived&&!running&&jobs.length<50,archived:session.archived,activeTurnId:running?turnId(running.id):null,activeTurnStatus:running?.status||null,queuePosition:running?.status==='QUEUED'?Number((await tx.query("SELECT count(*) AS n FROM operations WHERE status='QUEUED' AND created_at<=$1",[running.created_at])).rows[0].n):null,blockedReason:running?.status==='RESULT_UNKNOWN'?'原请求结果未知，先核查后继续。':jobs.length>=50?'本对话达到 50 轮，请新建对话。':null,messages,progress:running?{message:status==='QUEUED'?'等待后台工作器':'后台工作器正在处理本轮'}:null};
}
export async function conversationList(tx,params){
  const bridge=await bridgeState(tx),id=params.get('conversationId');if(id)return {conversation:await readConversation(tx,id),bridge};
  const offset=Number(params.get('cursor')||0);check(Number.isSafeInteger(offset)&&offset>=0&&offset<=10000,'CONVERSATION_CURSOR','对话目录游标无效');
  const rows=(await tx.query("SELECT value FROM runtime_status WHERE name LIKE 'assistant:conversation:%' AND COALESCE((value->>'archived')::boolean,false)=$1 ORDER BY updated_at DESC,name LIMIT 21 OFFSET $2",[params.get('archived')==='only',offset])).rows;
  const conversations=[];
  for(const row of rows.slice(0,20)){const session=row.value,jobs=await sessionJobs(tx,session.id),latest=jobs.at(-1);conversations.push({id:session.id,assistantProtocol:'REVIEW_WORK_CONTEXT_V1',preview:latest?.request.prompt.slice(0,120)||'新对话',state:latest?.status||'READY',messageCount:jobs.length*2,archived:session.archived,activeTurnStatus:active.includes(latest?.status)?latest.status:undefined});}
  return {conversations,bridge,pagination:{nextCursor:rows.length>20?String(offset+20):null}};
}
// Called by the ordinary queue transaction. Session reservation and job enqueue
// either both commit or both roll back, including concurrent browser tabs.
export async function reserveConversation(tx,request){
  const meta=request.assistant;if(!meta)return;
  check(request.kind==='AI_SUGGEST'&&['DISCUSS','EXECUTE'].includes(meta.mode),'ASSISTANT_MODE','对话建议不能直接触发正式采用或生成',409);
  const rebuilt=await assistantContext(tx,{focus:meta.context.focus,draftTargets:meta.context.draftTargets});
  check(rebuilt.packetHash===meta.context.packetHash&&request.objectId===rebuilt.objectId&&request.expectedVersion===rebuilt.objectVersion&&request.revisionId===rebuilt.objectRevisionId,'CONTEXT_STALE','助手上下文在排队前已改变',409);
  identity(meta.conversationId);await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,2))',[namespace(meta.conversationId)]);
  let row=(await tx.query('SELECT value FROM runtime_status WHERE name=$1 FOR UPDATE',[namespace(meta.conversationId)])).rows[0];
  if(meta.action==='START'){
    check(!row&&meta.conversationId===conversationId(request.operationId),'CONVERSATION_CONFLICT','对话身份已存在',409);
    check(Number((await tx.query("SELECT count(*) AS n FROM runtime_status WHERE name LIKE 'assistant:conversation:%'")).rows[0].n)<100,'CONVERSATION_LIMIT','本机对话已达到保留上限');
    row={value:{id:meta.conversationId,archived:false,version:0}};
  }else check(row,'CONVERSATION_NOT_FOUND','本机对话不存在',404);
  const session=row.value,jobs=await sessionJobs(tx,meta.conversationId);
  check(!session.archived&&jobs.length<50&&!jobs.some(j=>active.includes(j.status)),'CONVERSATION_BUSY','当前对话尚有未完成或结果未知的请求',409);
  if(meta.action==='SEND')check(meta.expectedTurnHeadHash===headHash(session,jobs),'CONVERSATION_HEAD','对话状态已改变，原输入仍保留',409);
  await assertSourceVersions(tx,meta.context.sourceVersions);
  for(const [scope,version]of Object.entries(meta.context.configurationVersions)){const row=(await tx.query('SELECT version FROM configurations WHERE scope=$1 FOR SHARE',[scope])).rows[0];check(row?.version===version,'CONTEXT_STALE','配置依据已改变',409);}
  await tx.query('INSERT INTO runtime_status(name,value) VALUES($1,$2) ON CONFLICT(name) DO UPDATE SET value=EXCLUDED.value,updated_at=now()',[namespace(session.id),{...session,version:session.version+1}]);
}
export async function prepareConversation(pool,body,{operationId,runtimeEpoch}){
  identity(operationId);const clientHash=hash({body,runtimeEpoch});
  return transaction(pool,async tx=>{
    const prior=(await tx.query('SELECT request,status FROM operations WHERE id=$1',[operationId])).rows[0];
    if(prior){check(prior.request.assistant?.clientHash===clientHash,'OPERATION_ID_CONFLICT','同一请求编号不能用于不同对话内容',409);return {replayed:true,conversationId:prior.request.assistant.conversationId};}
    check(['START','SEND'].includes(body.action)&&['DISCUSS','EXECUTE'].includes(body.mode||'DISCUSS')&&!body.allowSettingsPublish,'ASSISTANT_MODE','本轮先生成修改预览，由用户确认后保存草稿；正式采用须在原页面提交',409);
    check(typeof body.userMessage==='string'&&body.userMessage.trim()&&body.userMessage.length<=16000,'PROMPT_REQUIRED','请输入本轮问题');
    const context=await assistantContext(tx,body);
    check(context.dependencyHash===body.expectedDependencyHash,'CONTEXT_STALE','讨论对象的依据已改变，请核对后再发送',409);
    const id=body.action==='START'?conversationId(operationId):identity(body.conversationId);
    const history=body.action==='SEND'?(await readConversation(tx,id)).messages.slice(-12).map(({role,text})=>({role,text:text.slice(0,8000)})):[];
    return {request:{operationId,runtimeEpoch,kind:'AI_SUGGEST',objectId:context.objectId,expectedVersion:context.objectVersion,revisionId:context.objectRevisionId,prompt:body.userMessage,assistant:{conversationId:id,clientHash,action:body.action,expectedTurnHeadHash:body.expectedTurnHeadHash||null,mode:body.mode||'DISCUSS',context,history}},conversationId:id};
  },{readOnly:true});
}
export async function archiveConversation(pool,body,{operationId,runtimeEpoch}){
  const fingerprint=hash({body,runtimeEpoch});identity(operationId);identity(body.conversationId);
  return transaction(pool,async tx=>{
    await mutationGate(tx,runtimeEpoch);await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[operationId]);
    const old=(await tx.query('SELECT request_hash,result FROM operations WHERE id=$1',[operationId])).rows[0];if(old){check(old.request_hash===fingerprint,'OPERATION_ID_CONFLICT','同一请求编号不能用于不同动作',409);return old.result;}
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,2))',[namespace(body.conversationId)]);
    const conversation=await readConversation(tx,body.conversationId);
    check(body.expectedTurnHeadHash===conversation.headHash&&!conversation.activeTurnId,'CONVERSATION_HEAD','对话状态已变化或仍有未完成请求',409);
    check(['ARCHIVE','RESTORE'].includes(body.action),'CONVERSATION_ACTION','对话动作无效');
    await tx.query("UPDATE runtime_status SET value=jsonb_set(jsonb_set(value,'{archived}',$2::jsonb),'{version}',to_jsonb((value->>'version')::int+1)),updated_at=now() WHERE name=$1",[namespace(body.conversationId),JSON.stringify(body.action==='ARCHIVE')]);
    const result={operationId,status:'SUCCEEDED',conversationId:body.conversationId};await tx.query("INSERT INTO operations(id,request_hash,kind,status,request,result) VALUES($1,$2,'ASSISTANT_SESSION','SUCCEEDED',$3,$4)",[operationId,fingerprint,body,result]);return result;
  });
}
export async function checkDraftSuggestion(tx,body){
  const jobs=await sessionJobs(tx,body.conversationId),job=jobs.find(j=>turnId(j.id)+':assistant'===body.messageId);check(job?.status==='SUCCEEDED','SUGGESTION_MISSING','原建议不存在',404);
  const context=job.request.assistant.context,target=context.draftTargets.find(t=>t.id===body.targetId);
  check(context.packetId===body.assistantContext?.packetId&&context.packetHash===body.assistantContext?.packetHash&&target?.baseHash===body.expectedDraftHash,'SUGGESTION_BINDING','建议与页面草稿的依据不符',409);
  const value=(await tx.query('SELECT content FROM suggestions WHERE operation_id=$1 AND expires_at>now()',[job.id])).rows[0];check(value?.content.draftSuggestions?.some(s=>s.targetId===body.targetId),'SUGGESTION_EXPIRED','此建议已超过保留期或未绑定该字段',409);
  await assertSourceVersions(tx,[...context.sourceVersions,...value.content.sourceVersions||[]]);return {valid:true,formalAdoptionPerformed:false};
}
