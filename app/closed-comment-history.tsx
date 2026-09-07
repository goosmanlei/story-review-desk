'use client';
import {useEffect,useState,type ReactNode} from 'react';
import type {ClosedHistoryPage,ClosedHistorySummary} from '../host/instance-runtime/comment-pagination.mjs';

export type ClosedCommentHistoryEntry = {
  commentId:string;commentRevisionId:string;latestEventId:string;commentText:string;quote:string;
  createdAt:string;updatedAt:string;resolutionNote:string;resolvedBy:'USER'|'AI'|null;archived:boolean;readOnly:true;
  originalTarget:{kind:string;subjectId:string;label:string;revisionId:string|null;snapshotId:string;contentHash:string};
  resolutionTarget:Record<string,unknown>|null;
};
const time=(value:string)=>Number.isNaN(Date.parse(value))?'时间未记录':new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(value));
const shortTime=(value:string)=>Number.isNaN(Date.parse(value))?'时间未记录':new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit'}).format(new Date(value));

/** Expanding a row is local reading state, never a comment status mutation. */
export function ClosedCommentDisclosure({label,text,updatedAt,children}:{label:string;text:string;updatedAt:string;children:ReactNode}){
  const [expanded,setExpanded]=useState(false);
  return <details className="closed-comment-disclosure" onToggle={event=>setExpanded(event.currentTarget.open)}>
    <summary><span className="closed-comment-row-label" title={label}>{label}</span><span className="closed-comment-row-preview" title={text}>{text||'未填写评论'}</span><time dateTime={updatedAt} title={`关闭时间：${time(updatedAt)}`}>{shortTime(updatedAt)}</time></summary>
    {expanded&&<div className="closed-comment-body">{children}</div>}
  </details>;
}

type HistoryDetail<T>={item:ClosedCommentHistoryEntry;thread:T|null;historyRevision:string};
function HistoryContent({item}:{item:ClosedCommentHistoryEntry}){
  return <><header><b>{item.originalTarget.label}</b><span>已关闭{item.archived?' · 已归档':''}</span></header>
    <blockquote><small>当时圈选的原文</small><p>{item.quote||'未记录原圈选文字'}</p></blockquote>
    <p className="closed-comment-text">{item.commentText}</p>
    <div className="closed-comment-resolution"><b>处理说明</b><p>{item.resolutionNote||'当时未记录处理说明。'}</p></div>
    <footer><time dateTime={item.updatedAt}>{time(item.updatedAt)}</time>{item.resolvedBy&&<span>{item.resolvedBy==='AI'?'AI':'用户'}关闭</span>}</footer>
    <details><summary>原版本与记录依据</summary><dl><dt>原对象身份</dt><dd>{item.originalTarget.subjectId}</dd><dt>原候选／快照</dt><dd>{item.originalTarget.revisionId||item.originalTarget.snapshotId||'未记录'}</dd><dt>原正文哈希</dt><dd>{item.originalTarget.contentHash||'未记录'}</dd><dt>评论版本</dt><dd>{item.commentRevisionId}</dd><dt>关闭记录</dt><dd>{item.latestEventId}</dd></dl>{item.resolutionTarget&&<pre>{JSON.stringify(item.resolutionTarget,null,2)}</pre>}</details>
  </>;
}
function LazyHistoryDetail<T>({endpoint,row,revision,renderActions,onThreadRead,onStale}:{endpoint:string;row:ClosedHistorySummary;revision:string;renderActions?:(thread:T)=>ReactNode;onThreadRead?:(thread:T)=>void;onStale:()=>void}){
  const [detail,setDetail]=useState<HistoryDetail<T>|null>(null),[error,setError]=useState('');
  useEffect(()=>{
    const controller=new AbortController();
    const url=endpoint+'&history=detail&commentId='+encodeURIComponent(row.commentId)+'&historyRevision='+encodeURIComponent(revision);
    void fetch(url,{cache:'no-store',signal:controller.signal}).then(async response=>{
      const value=await response.json() as HistoryDetail<T>&{error?:string};
      if(!response.ok){if(response.status===409&&!controller.signal.aborted)onStale();throw new Error(value.error||'读取完整评论失败');}
      if(value.historyRevision!==revision||value.item.commentId!==row.commentId||value.item.commentRevisionId!==row.commentRevisionId||value.item.latestEventId!==row.latestEventId)throw new Error('评论详情与列表不一致');
      if(!controller.signal.aborted){setDetail(value);if(value.thread)onThreadRead?.(value.thread);}
    }).catch(reason=>{if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'读取完整评论失败');});
    return()=>controller.abort();
  },[endpoint,row.commentId,row.commentRevisionId,row.latestEventId,revision,onThreadRead,onStale]);
  if(error)return <p role="alert">{error}</p>;
  if(!detail)return <p role="status">正在读取完整评论…</p>;
  return <><HistoryContent item={detail.item}/>{detail.thread&&!detail.item.archived&&renderActions?.(detail.thread)}</>;
}

/** One server-paged union of current closures and immutable full-project history. */
export function PaginatedClosedCommentHistory<T>({endpoint,refreshKey=0,renderActions,onThreadRead}:{endpoint:string;refreshKey?:string|number;renderActions?:(thread:T)=>ReactNode;onThreadRead?:(thread:T)=>void}){
  const [query,setQuery]=useState(''),[cursors,setCursors]=useState<string[]>(['']),[reload,setReload]=useState(0);
  const [result,setResult]=useState<{identity:string;page:ClosedHistoryPage}|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  const cursor=cursors.at(-1)||'',identity=JSON.stringify([endpoint,refreshKey,query,cursor,reload]);
  const page=result?.identity===identity?result.page:null;
  // A stable callback prevents every parent render from restarting an expanded read.
  const [stale]=useState(()=>()=>{setNotice('评论已更新，已返回第一页。');setCursors(['']);setReload(n=>n+1);});
  useEffect(()=>{
    const controller=new AbortController();
    const timer=window.setTimeout(()=>{
      setBusy(true);setError('');
      void fetch(endpoint+'&history=page&limit=20&q='+encodeURIComponent(query)+'&cursor='+encodeURIComponent(cursor),{cache:'no-store',signal:controller.signal}).then(async response=>{
        const value=await response.json() as {closedPage:ClosedHistoryPage;error?:string};
        if(!response.ok){if(response.status===409&&!controller.signal.aborted){stale();return;}throw new Error(value.error||'读取评论历史失败');}
        if(!controller.signal.aborted)setResult({identity,page:value.closedPage});
      }).catch(reason=>{if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'读取评论历史失败');}).finally(()=>{if(!controller.signal.aborted)setBusy(false);});
    },query?200:0);
    return()=>{window.clearTimeout(timer);controller.abort();};
  },[identity,endpoint,query,cursor,stale]);
  return <section className="closed-comment-history" aria-label="全剧已关闭评论历史" aria-busy={busy}>
    <header><h4>已关闭评论历史{page&&<span>{page.total}</span>}</h4><small>当前对象与全剧历史 · 每页 20 条</small></header>
    <p>仅展开时读取完整原圈选、处理说明和版本；历史场号不会重绑到当前同号场次。</p>
    <label className="closed-comment-search">查找已关闭评论<input type="search" maxLength={500} value={query} onChange={event=>{setQuery(event.target.value);setCursors(['']);setNotice('');}} placeholder="集、场、原文、意见或处理说明"/></label>
    {notice&&<p role="status">{notice}</p>}
    {error&&<p role="alert">{error}<button type="button" onClick={()=>setReload(n=>n+1)}>重新读取</button></p>}
    {!page&&!error&&<p role="status">正在读取评论历史…</p>}
    {page&&<><p role="status">{query.trim()?`匹配 ${page.matched} / ${page.total} 条已关闭评论`:`共 ${page.total} 条已关闭评论`}{page.matched>0&&` · 第 ${page.offset+1}–${page.offset+page.items.length} 条`}</p>
      {page.items.map(row=><article key={page.historyRevision+':'+row.commentId} data-comment-id={row.commentId} data-comment-status="RESOLVED" data-history-only={row.isCurrent?'false':'true'}>
        <ClosedCommentDisclosure label={(row.isCurrent?'当前对象 · ':'')+row.label} text={row.preview} updatedAt={row.updatedAt}>
          <LazyHistoryDetail endpoint={endpoint} row={row} revision={page.historyRevision} renderActions={renderActions} onThreadRead={onThreadRead} onStale={stale}/>
        </ClosedCommentDisclosure>
      </article>)}
      {!page.matched&&<p>{query.trim()?'没有匹配的已关闭评论。':'暂无已关闭评论。'}</p>}
      {page.matched>20&&<nav aria-label="已关闭评论分页"><button type="button" disabled={busy||cursors.length===1} onClick={()=>setCursors(values=>values.slice(0,-1))}>上一页</button><span>第 {cursors.length} 页</span><button type="button" disabled={busy||!page.nextCursor} onClick={()=>{if(page.nextCursor)setCursors(values=>[...values,page.nextCursor!]);}}>下一页</button></nav>}
    </>}
  </section>;
}
