'use client';
import {createContext,useCallback,useContext,useLayoutEffect,useRef,useState,type ReactNode} from 'react';

type ReadState={pending:boolean;error:string;retry:()=>void};
const ReadContext=createContext<((key:symbol,state:ReadState|null)=>void)|null>(null);

/** Keep the mounted editors and their leave guards while necessary reads settle. */
export function WorkspaceReadBoundary({children,preserveLayout=false}:{children:ReactNode;preserveLayout?:boolean}) {
 const [reads,setReads]=useState(new Map<symbol,ReadState>());
 const register=useCallback((key:symbol,state:ReadState|null)=>setReads(previous=>{
  const next=new Map(previous);if(state)next.set(key,state);else next.delete(key);return next;
 }),[]);
 const error=[...reads.values()].find(read=>read.error)?.error;
 const waiting=Boolean(error)||[...reads.values()].some(read=>read.pending);
 const content=useRef<HTMLDivElement>(null),height=useRef(0);
 useLayoutEffect(()=>{
  if(!preserveLayout||waiting||!content.current)return;
  const read=()=>{height.current=content.current?.getBoundingClientRect().height||0;};read();
  const observer=new ResizeObserver(read);observer.observe(content.current);return()=>observer.disconnect();
 },[preserveLayout,waiting]);
 return <ReadContext.Provider value={register}><div className={'workspace-read-boundary'+(preserveLayout?' preserves-layout':'')} aria-busy={waiting} style={preserveLayout?{position:'relative',minHeight:waiting?height.current:undefined}:undefined}>
  {waiting&&<section className="production-preparation-loading"><p role={error?'alert':'status'}>{error||'正在读取完整集场计划与镜头制作资料…'}</p>{error&&<button onClick={()=>{for(const read of reads.values())read.retry();}}>重新完整读取</button>}</section>}
  <div ref={content} hidden={!preserveLayout&&waiting} inert={waiting||undefined} aria-hidden={waiting||undefined} style={preserveLayout?{visibility:waiting?'hidden':undefined}:{display:waiting?'none':'contents'}}>{children}</div>
 </div></ReadContext.Provider>;
}

export function useWorkspaceReadiness(pending:boolean,error:string,retry:()=>void) {
 const register=useContext(ReadContext),[key]=useState(()=>Symbol('workspace-read')),retryRef=useRef(retry);
 retryRef.current=retry;
 // Register before paint so an incomplete child never flashes an empty workspace.
 useLayoutEffect(()=>{register?.(key,{pending,error,retry:()=>retryRef.current()});return()=>register?.(key,null);},[register,key,pending,error]);
}
