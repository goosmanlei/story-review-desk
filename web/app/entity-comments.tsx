'use client';
import {useEffect,useRef,useState} from 'react';
import {useRetainedDraft,readWorkspaceDraft} from './draft-retention';
import {useManagementDraftGuard} from './management-draft-guard';
import {managementMutation,readManagementResponse} from './system-management-client';
import {requestCommentPolish,pollCommentPolish} from './comment-polish-client';

type Target={kind:'ENTITY_SETTING';entityId:string;objectId:string;revisionId:string;expectedVersion:number;contentHash:string;snapshotId:string;label:string;includeDraft:boolean;candidate:boolean;candidateBasisCurrent?:boolean;state:string;basisLabel:string;adopted?:{revisionId:string;content:{description?:string;name?:string}}|null};
type Thread={commentId:string;commentRevisionId:string;expectedVersion:number;text:string;status:string;target:Target;applicability:string};
type Draft={commentId:string;text:string;target:Target;commentRevisionId?:string;expectedVersion?:number;pendingPolish?:string;polishBaseText?:string;suggestion?:string};
const states:Record<string,string>={DRAFT:'草稿',SUBMITTED:'待审阅',ADOPTED:'已采用',CHANGES_REQUESTED:'要求修改',DISABLED:'已停用',ARCHIVED:'历史'};

export function EntityComments({entityId,includeDraft,basisRevisionId,uncommitted=false,readOnly=false,onRefresh}:{entityId:string;includeDraft:boolean;basisRevisionId?:string;uncommitted?:boolean;readOnly?:boolean;onRefresh:()=>void}){
 const key='entity-comment:'+entityId;
 const [draft,setDraft,retained]=useRetainedDraft<Draft>(key);
 const [data,setData]=useState<{target:Target;threads:Thread[]}|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[attempt,setAttempt]=useState(0),[busy,setBusy]=useState(false);
 const live=useRef(true),polishAbort=useRef<AbortController|null>(null);
 useManagementDraftGuard(Boolean(draft)&&!retained,'实体评论草稿');
 useEffect(()=>{live.current=true;return()=>{live.current=false;polishAbort.current?.abort();};},[]);
 useEffect(()=>{const controller=new AbortController();setData(null);setError('');void fetch('/api/v1/workspaces/entity-comments?entityId='+encodeURIComponent(entityId)+'&draft='+(includeDraft?'1':'0'),{cache:'no-store',signal:controller.signal}).then(readManagementResponse<{target:Target;threads:Thread[]}>).then(value=>{if(!controller.signal.aborted)setData(value)}).catch(e=>{if(!controller.signal.aborted)setError(e.message)});return()=>controller.abort();},[entityId,includeDraft,basisRevisionId,attempt]);
 const basisMatches=Boolean(data&&data.target.revisionId===basisRevisionId),canWrite=Boolean(data&&basisMatches&&!uncommitted&&!readOnly&&!busy);
 const staleDraft=Boolean(draft&&data&&draft.target.revisionId!==data.target.revisionId);
 const changeText=(text:string)=>{if(!data)return;setDraft(previous=>previous?{...previous,text,suggestion:undefined}:{commentId:'entity-comment:'+crypto.randomUUID(),text,target:data.target});};
 async function mutate(action:'CREATE'|'EDIT'|'CLOSE',thread?:Thread){
  if(!data||busy||readOnly||(!thread&&!canWrite))return;
  const input=draft,existing=thread||(input?data.threads.find(t=>t.commentId===input.commentId):undefined);
  setBusy(true);setError('');setNotice('');
  try{
   await managementMutation('/api/v1/workspaces/entity-comments',{action:action==='CREATE'&&existing?'EDIT':action,entityId,objectId:entityId,
    commentId:existing?.commentId||input?.commentId,target:input?.target,text:input?.text,
    ...(existing?{commentRevisionId:input?.commentRevisionId||existing.commentRevisionId,expectedVersion:input?.expectedVersion||existing.expectedVersion}:{})});
   if(action!=='CLOSE'&&input){const latest=readWorkspaceDraft<Draft>(key);if(latest?.commentId===input.commentId&&latest.text===input.text)setDraft(null);}
   if(live.current){setAttempt(value=>value+1);setNotice(action==='CLOSE'?'评论已关闭，可在下方历史查看。':'评论已保存。');}
  }catch(e){if(live.current)setError(e instanceof Error?e.message:'评论未保存，输入仍保留');}finally{if(live.current)setBusy(false);}
 }
 async function polish(){
  if(!draft?.text.trim()||!canWrite||staleDraft)return;
  const input=draft,operationId=input.pendingPolish||crypto.randomUUID(),controller=new AbortController();polishAbort.current=controller;setBusy(true);setError('');
  if(!input.pendingPolish)setDraft({...input,pendingPolish:operationId,polishBaseText:input.text,suggestion:undefined});
  try{
   if(input.pendingPolish){const response=await fetch('/api/v1/operations/'+encodeURIComponent(operationId),{cache:'no-store',signal:controller.signal});const operation=await readManagementResponse<{status:string;error?:{message?:string}}>(response);if(['FAILED','CANCELLED'].includes(operation.status)){setDraft(previous=>previous?{...previous,pendingPolish:undefined}:previous);throw Error(operation.error?.message||'原润色请求已结束，可以核对后重新请求');}}
   const result=input.pendingPolish?await pollCommentPolish(operationId,controller.signal):await requestCommentPolish({snapshotId:input.target.snapshotId,target:input.target,commentDraft:input.text},operationId,controller.signal);
   if(live.current&&result.sourceContext?.missing?.length)setNotice('润色依据说明：'+result.sourceContext.missing.join('；'));
   const latest=readWorkspaceDraft<Draft>(key);if(latest?.commentId===input.commentId){const same=latest.text===(input.polishBaseText||input.text);setDraft({...latest,pendingPolish:undefined,suggestion:same?result.polishedComment:undefined});if(live.current&&!same)setNotice('原建议基于先前草稿，当前输入已改变，未覆盖。操作编号：'+operationId);}
  }catch(e){if(controller.signal.aborted)return;const httpStatus=(e as {httpStatus?:number}).httpStatus;if(httpStatus&&httpStatus>=400&&httpStatus<500)setDraft(previous=>previous?{...previous,pendingPolish:undefined}:previous);if(live.current)setError((e instanceof Error?e.message:'润色尚未完成')+'；原操作编号：'+operationId);}finally{if(live.current)setBusy(false);}
 }
 return <section className="entity-comments management-card" aria-label="实体评论">
  <h3>实体评论</h3>
  {data&&<><p>{data.target.basisLabel} · {states[data.target.state]||'状态待核'}。意见只针对当前实体，不改变设定或采用状态。</p>{data.target.candidateBasisCurrent===false&&<p>已保存设定草稿的依据已变化，润色前需重新核对草稿。</p>}<details><summary>评论依据与已采用稿</summary><p>实体：{entityId}</p><p>原修订：{data.target.revisionId}</p>{data.target.candidate&&<p>此实体内容由已保存模块草稿承载，草稿载体：{data.target.objectId}。</p>}{data.target.adopted?<><p>已采用修订：{data.target.adopted.revisionId}</p><p>{data.target.adopted.content.description||'已采用稿未登记说明。'}</p></>:<p>尚无已采用稿。</p>}</details></>}
  {(!data||!basisMatches||uncommitted)&&<p role="status">{uncommitted?'先保存设定草稿，再按保存后的版本评论。':!data?'正在读取实体评论…':'画板与评论依据版本不同，请重新读取设定；评论草稿仍保留。'}{data&&!basisMatches&&<button onClick={onRefresh}>重新读取设定</button>}</p>}
  {error&&<p role="alert">{error}<button onClick={()=>setAttempt(value=>value+1)}>重新读取评论</button></p>}{notice&&<p role="status">{notice}</p>}
  <label>{draft?.commentRevisionId?'编辑原评论':'实体修改意见'}<textarea aria-label="实体修改意见" rows={4} value={draft?.text||''} disabled={!canWrite} onChange={event=>changeText(event.target.value)}/></label>
  {staleDraft&&<p>这份输入保留原修订依据，尚未换绑当前稿。{!draft?.commentRevisionId&&<button disabled={!canWrite} onClick={()=>setDraft(previous=>previous&&data?{...previous,target:data.target,pendingPolish:undefined,suggestion:undefined}:previous)}>按当前稿重新核对这份未提交意见</button>}</p>}
  <div className="entity-comment-actions"><button disabled={!canWrite||!draft?.text.trim()||staleDraft&&!draft?.commentRevisionId} onClick={()=>void mutate(draft?.commentRevisionId?'EDIT':'CREATE')}>{draft?.commentRevisionId?'保存评论修改':'提交实体评论'}</button><button disabled={!canWrite||!draft?.text.trim()||staleDraft} onClick={()=>void polish()}>{draft?.pendingPolish?'查询原润色请求':'AI 润色修改意见'}</button>{draft&&<button disabled={busy} onClick={()=>setDraft(null)}>放弃评论草稿</button>}</div>
  {draft?.pendingPolish&&<small>原润色操作：{draft.pendingPolish}。未确认原结果前不重复发起。</small>}
  {draft?.suggestion&&<section className="entity-comment-suggestion"><h4>润色建议预览</h4><p>{draft.suggestion}</p><button disabled={!canWrite} onClick={()=>setDraft(previous=>previous?{...previous,text:previous.suggestion||previous.text,suggestion:undefined}:previous)}>应用到评论草稿</button><button onClick={()=>setDraft(previous=>previous?{...previous,suggestion:undefined}:previous)}>放弃润色建议</button></section>}
  <div aria-label="未关闭实体评论">{data?.threads.filter(t=>t.status==='OPEN').map(thread=><article key={thread.commentId}><p>{thread.text}</p><small>{thread.applicability==='HISTORICAL'?'历史依据 · ':'当前依据 · '}{thread.target.revisionId}</small><div className="entity-comment-actions"><button disabled={busy||readOnly} onClick={()=>{if(draft?.text&&draft.commentId!==thread.commentId&&!window.confirm('当前有评论草稿，改为编辑这条意见？'))return;setDraft({commentId:thread.commentId,commentRevisionId:thread.commentRevisionId,expectedVersion:thread.expectedVersion,text:thread.text,target:thread.target});}}>编辑评论</button><button disabled={busy||readOnly} onClick={()=>void mutate('CLOSE',thread)}>关闭评论</button></div></article>)}</div>
  <details className="entity-comment-history"><summary>已关闭评论 · {data?.threads.filter(t=>t.status!=='OPEN').length||0}</summary>{data?.threads.filter(t=>t.status!=='OPEN').map(thread=><article key={thread.commentId}><p>{thread.text}</p><small>已关闭 · 原修订 {thread.target.revisionId}</small></article>)}</details>
 </section>;
}
