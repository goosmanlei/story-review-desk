'use client';

import {runtimePath} from './runtime-path';
import {useEffect,useState} from 'react';

type Segment={id:string;sectionId:string;text:string};
type Result={issueId:string;status:'LOCATED'|'UNKNOWN'|'ERROR';beatId?:string;sectionId?:string;message?:string};

/** Read historical evidence only. Never map a historical scene alias to a new scene. */
export function HistoricalVerificationSource({issueId,snapshotId,segments,sectionIds,defaultSectionId}:{issueId:string;snapshotId:string;segments:Segment[];sectionIds:string[];defaultSectionId:string}) {
  const [result,setResult]=useState<Result|null>(null);
  const [attempt,setAttempt]=useState(0);
  const current=result?.issueId===issueId?result:null;
  // Primitive dependency avoids re-reading when the caller renders the same IDs.
  const sectionKey=JSON.stringify(sectionIds);
  useEffect(()=>{
    const controller=new AbortController();
    const origin=new URL(window.location.href);
    const initialSection=origin.searchParams.get('transcript')||defaultSectionId;
    const initialAnchor=origin.searchParams.get('readerAnchor');
    void fetch('/api/v8/ui/adaptation-audit',{cache:'no-store',signal:controller.signal}).then(async response=>{
      if(!response.ok)throw Error('历史核验资料暂时无法读取。');
      const payload=await response.json() as {snapshotId?:string;audioVerifications?:Array<{issueId:string;beatId?:string;beatIds?:string[]}>};
      if(payload.snapshotId!==snapshotId)throw Error('历史核验与来源快照不一致，未定位任何段落。');
      const matches=(payload.audioVerifications||[]).filter(item=>item.issueId===issueId);
      const issue=matches.length===1?matches[0]:null;
      const knownSections=new Set(JSON.parse(sectionKey) as string[]);
      const reference=issue?[...(issue.beatIds||[]),...(issue.beatId?[issue.beatId]:[])].map(id=>{
        const exact=segments.filter(segment=>segment.id===id&&knownSections.has(segment.sectionId)&&Boolean(segment.text.trim()));
        return exact.length===1?exact[0]:null;
      }).find(Boolean):null;
      if(controller.signal.aborted)return;
      if(!reference){setResult({issueId,status:'UNKNOWN'});return;}
      setResult({issueId,status:'LOCATED',beatId:reference.id,sectionId:reference.sectionId});
      const url=new URL(window.location.href);
      // A late read must not replace a newer source selection or another page.
      if(url.searchParams.get('view')!=='story'||url.searchParams.get('storyMode')!=='source'||url.searchParams.get('verifyIssue')!==issueId||url.searchParams.get('readerAnchor')!==initialAnchor||(url.searchParams.get('transcript')||defaultSectionId)!==initialSection)return;
      url.searchParams.set('source','transcript');url.searchParams.set('transcript',reference.sectionId);url.searchParams.set('readerAnchor',reference.id);
      if(url.href!==window.location.href){window.history.replaceState(window.history.state,'',url);window.dispatchEvent(new PopStateEvent('popstate',{state:window.history.state}));}
    }).catch((error:unknown)=>{if(!controller.signal.aborted)setResult({issueId,status:'ERROR',message:error instanceof Error?error.message:'历史核验资料暂时无法读取。'});});
    return()=>controller.abort();
  },[issueId,snapshotId,segments,sectionKey,defaultSectionId,attempt]);
  const exactHref=current?.status==='LOCATED'?'?'+new URLSearchParams({view:'story',storyMode:'source',source:'transcript',transcript:current.sectionId!,readerAnchor:current.beatId!,verifyIssue:issueId}).toString():null;
  return <aside className="authority-note" role="note" aria-label="历史原音核验说明">
    <b>历史原音核验 · {issueId}</b>
    <p>此核验仅作历史证据；尚无到当前新版场次的永久身份映射，不进入新版首场或恢复旧场正式审阅。</p>
    {!current?<p role="status">正在核对历史核验的精确来源引用…</p>:current.status==='LOCATED'?<p>已找到可读来源引用：<a href={runtimePath(exactHref!)}>{current.beatId} · 打开原文段落</a>。这不代表原音已听辨或核验结论已更新。</p>:<p role={current.status==='ERROR'?'alert':undefined}>{current.status==='ERROR'?current.message:'UNKNOWN：未找到唯一可读的原引用，仅保留来源资料入口，不补猜场次或段落。'}</p>}
    {current?.status==='ERROR'&&<button type="button" onClick={()=>setAttempt(value=>value+1)}>重新读取历史核验</button>}
  </aside>;
}
