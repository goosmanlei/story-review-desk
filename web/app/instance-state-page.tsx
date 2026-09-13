'use client';
import {useState} from 'react';
import './instance-state-page.css';

type State='loading'|'updated'|'error';
const copy={
 loading:{title:'正在连接审阅台',description:'正在读取当前工作区，请稍候。',action:''},
 updated:{title:'审阅台已更新',description:'当前页面已暂停写入。刷新后，即可在最新版本中继续工作。',action:'刷新页面'},
 error:{title:'暂时无法打开审阅台',description:'未能读取当前工作区。请稍后重新加载，再继续工作。',action:'重新加载'},
};
export function InstanceStatePage({state,error}:{state:State;error?:string}){
 const [refreshing,setRefreshing]=useState(false),content=copy[state],waiting=state==='loading'||refreshing;
 function reload(){if(refreshing)return;setRefreshing(true);requestAnimationFrame(()=>requestAnimationFrame(()=>window.location.reload()));}
 return <main className={'instance-state-page is-'+state} aria-labelledby="instance-state-title" role={state==='loading'?'status':'alert'} aria-busy={waiting}>
  <section className="instance-state-card">
   <div className="instance-state-brand"><span aria-hidden="true">阅</span>审阅台</div>
   <div className={'instance-state-icon'+(waiting?' is-waiting':'')} aria-hidden="true">
    <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
     {waiting?<><circle className="instance-state-spinner" cx="16" cy="16" r="10" strokeDasharray="44 19"/><circle cx="16" cy="16" r="2" fill="currentColor" stroke="none"/></>:state==='updated'?<><path d="M25 12a10 10 0 1 0 1 8M25 5v7h-7"/><path d="m12 16 3 3 6-7"/></>:<><path d="m16 5 12 21H4L16 5Z"/><path d="M16 12v6m0 4v.1"/></>}
    </svg>
   </div>
   <h1 id="instance-state-title">{content.title}</h1>
   <p className="instance-state-description">{content.description}</p>
   {state==='updated'&&<p className="instance-state-note">若工作区已重新载入，旧页面的草稿不会自动带入。</p>}
   {state==='error'&&error&&<details className="instance-state-detail"><summary>查看原因</summary><p>{error}</p></details>}
   {content.action?<button className="instance-state-action" type="button" disabled={refreshing} onClick={reload}>{refreshing?'正在重新加载…':content.action}<span aria-hidden="true">↻</span></button>:<p className="instance-state-wait">连接就绪后会自动进入</p>}
  </section>
 </main>;
}
