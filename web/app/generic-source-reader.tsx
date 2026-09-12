'use client';
import {useEffect,useState,type ReactNode} from 'react';
import {readManagementResponse} from './system-management-client';
import {SourceImport} from './system-management';
import {useRuntimeMode} from './runtime-mode';
import type {SourceSummary} from '../presentation/domain-sources.mjs';
type Source=SourceSummary&{documentId?:string};
type Document={documentId:string;revisionId:string;sha256:string;focusId:string;text:string;truncated?:boolean};
export type GenericSourceFocus={id:string;title:string;revisionId:string};
export function GenericSourceReader({onDocumentChange,builtin}:{onDocumentChange?:(value:GenericSourceFocus|null)=>void;builtin?:{navigation:ReactNode;content:ReactNode;documentIds:string[]}}){
 const {hostedReadOnly}=useRuntimeMode();
 const [importing,setImporting]=useState(false),[instanceReadOnly,setInstanceReadOnly]=useState(false);
 const readOnly=hostedReadOnly||instanceReadOnly;
 function mayLeaveImport(){return !importing||window.dispatchEvent(new Event('review:configuration-before-leave',{cancelable:true}));}
 const [sources,setSources]=useState<Source[]|null>(null),[selected,setSelected]=useState<string|null>(null),[attempt,setAttempt]=useState(0),[error,setError]=useState('');
 const [result,setResult]=useState<{sourceId:string;document?:Document;error?:string}|null>(null);
 const source=sources?.find(item=>item.id===selected),document=result?.sourceId===selected?result.document:null,documentError=result?.sourceId===selected?result.error:null;
 useEffect(()=>{const controller=new AbortController();void fetch('/api/v1/workspaces/sources',{signal:controller.signal,cache:'no-store'}).then(readManagementResponse<{sources:Source[];readOnly?:boolean}>).then(value=>{if(!controller.signal.aborted)setInstanceReadOnly(value.readOnly===true);if(!controller.signal.aborted)setSources(previous=>{const fresh=value.sources.find(s=>!previous?.some(p=>p.id===s.id));if(previous&&fresh)setSelected(fresh.id);return value.sources;});}).catch(e=>{if(!controller.signal.aborted)setError(e.message);});return()=>controller.abort();},[attempt]);
 useEffect(()=>{const refresh=()=>setAttempt(v=>v+1);window.addEventListener('review:sources-updated',refresh);return()=>window.removeEventListener('review:sources-updated',refresh);},[]);
 useEffect(()=>{if(!source?.textAvailable||!source.documentId||hostedReadOnly||importing)return;const controller=new AbortController();void fetch(`/api/v1/workspaces/documents?id=${encodeURIComponent(source.documentId)}`,{signal:controller.signal,cache:'no-store'}).then(readManagementResponse<Document>).then(value=>{if(value.documentId!==source.documentId||value.revisionId!==source.documentRevisionId||value.sha256!==source.documentSha256||!value.focusId)throw new Error('来源正文与当前登记版本不一致，请重新读取目录。');if(!controller.signal.aborted){setResult({sourceId:source.id,document:value});onDocumentChange?.({id:value.focusId,title:source.title,revisionId:value.revisionId});}}).catch(e=>{if(!controller.signal.aborted)setResult({sourceId:source.id,error:e.message});});return()=>{controller.abort();onDocumentChange?.(null);};},[source,hostedReadOnly,importing,attempt,onDocumentChange]);
 return <div className="text-reader story-source-reader unified-source-workspace">
  <aside className="text-reader-index">
   <header><small>SOURCE EVIDENCE</small><h3>来源资料</h3>{!readOnly&&<button onClick={()=>setImporting(true)}>＋ 补充来源</button>}</header>
   {builtin&&<div onClickCapture={event=>{if(event.defaultPrevented||!mayLeaveImport()){event.preventDefault();event.stopPropagation();}}} onClick={()=>{setSelected(null);setImporting(false);}}>{builtin.navigation}</div>}
   <nav className="source-evidence-tree" aria-label="实例来源目录">{(['PRIMARY','DERIVED','AUXILIARY'] as const).map(role=><section key={role}><h4>{({PRIMARY:'原始资料',DERIVED:'整理文本',AUXILIARY:'辅助资料'})[role]}</h4>{sources?.filter(item=>item.role===role&&!builtin?.documentIds.includes(item.documentId||'')).map(item=><section key={item.id} className={`source-tree-branch ${selected===item.id?'active':''}`}><button aria-pressed={selected===item.id&&!importing} onClick={()=>{if(!mayLeaveImport())return;setSelected(item.id);setImporting(false);}}><b>{item.title}</b><small>{item.format}</small></button></section>)}</section>)}</nav>
  </aside>
  {importing&&!readOnly?<article className="text-reader-document source-import-editor"><header className="text-reader-head"><h3>补充来源</h3><button onClick={()=>{if(mayLeaveImport())setImporting(false);}}>返回阅读</button></header><SourceImport compact onChanged={()=>{setImporting(false);setAttempt(v=>v+1);}}/></article>:!selected&&builtin?builtin.content:<article className="text-reader-document"><header className="text-reader-head"><h3>{source?.title||'选择一份来源资料'}</h3></header><div className="text-reader-scroll"><div className="text-reader-body">{!sources&&!error&&<p role="status">正在读取来源目录…</p>}{(error||documentError)&&<><p role="alert">{error||documentError}</p><button onClick={()=>{setError('');setResult(null);setAttempt(value=>value+1);}}>重新读取资料</button></>}{sources&&!sources.length&&<p>尚未导入来源。使用左侧“补充来源”登记最初的故事资料。</p>}{source&&(hostedReadOnly?<p>此镜像展示来源名称与版本信息。原件和逐字内容请回本地核对。</p>:!source.textAvailable?<p>{source.observation==='ORIGINAL_UNOBSERVED'?'原件已保存，尚未观察或转写。':'这份原件尚无可读取文字。'}</p>:document?<><pre className="empty-source-text">{document.text}</pre>{document.truncated&&<p>当前展示前二十万字；完整原文保留在实例中。</p>}</>:!documentError&&<p role="status">正在读取来源正文…</p>)}</div></div></article>}
 </div>;
}
