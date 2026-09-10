'use client';

import {runtimePath} from './runtime-path';
import {useState,useEffect} from 'react';
import type {ActionItem} from './action-queue-contract';
import {WorkCard,collapseWorkUnits,matchesCurrentWorkFilters,type CurrentWorkViewState} from './current-work-shared';
import {WorkflowOverview,useWorkflowProjection,buildWorkflowStages,workflowItemStage,workflowCount} from './workflow-overview';
import './workflow-production.css';
const chains=[{id:'STORY_CREATION',area:'STORY',label:'故事 → 剧本',subtitle:'资料、分集与逐场表达'},{id:'WORLD_AND_MATERIALS',area:'MATERIALS',label:'剧本 → 素材',subtitle:'主体、状态与可用版本'},{id:'FULL_PRODUCTION',area:'PRODUCTION',label:'剧本 + 素材 → 全剧制作',subtitle:'逐场筹备、镜头与成片'}] as const;
const statusLabels:Record<string,string>={ACTIVE:'正在推进',WAITING:'等待上游',BLOCKED:'存在阻断',COMPLETE:'已完成',UNKNOWN:'范围未锁定'};
export function preparationMatchesFilters(preparation:{status:string;capabilities:string[]},value:CurrentWorkViewState){return (value.type==='ALL'||value.type==='AUTHORING')&&(value.state==='ALL'||value.state===preparation.status||value.state==='NOW'&&preparation.status==='READY')&&(value.actor==='ALL'||value.actor==='HUMAN'&&preparation.capabilities.includes('人可推进')||value.actor==='AI'&&preparation.capabilities.includes('AI可推进')||value.actor==='BOTH'&&preparation.capabilities.includes('人可推进')&&preparation.capabilities.includes('AI可推进'));}
export function StandaloneCurrentWorkCenter(){
 const [value,setValue]=useState<CurrentWorkViewState>({area:'ALL',actor:'ALL',state:'NOW',type:'ALL'});
 useEffect(()=>{const restore=()=>{const p=new URL(location.href).searchParams;setValue({area:(p.get('workArea')||'ALL') as CurrentWorkViewState['area'],actor:(p.get('workActor')||'ALL') as CurrentWorkViewState['actor'],state:(p.get('workState')||'NOW') as CurrentWorkViewState['state'],type:'ALL',stage:p.get('workStage')||undefined});};restore();window.addEventListener('popstate',restore);return()=>window.removeEventListener('popstate',restore);},[]);
 const change=(next:CurrentWorkViewState)=>{setValue(next);const u=new URL(location.href);for(const [key,v]of Object.entries({workArea:next.area,workActor:next.actor,workState:next.state,workStage:next.stage})){if(v)u.searchParams.set(key,v);else u.searchParams.delete(key);}history.replaceState(history.state,'',u);};
 return <CurrentWorkCenter value={value} onChange={change} reviewRemaining={0} materialRequirementCount={0}/>;
}
export function CurrentWorkCenter({value,onChange}: {value:CurrentWorkViewState;onChange:(value:CurrentWorkViewState)=>void;reviewRemaining:number;materialRequirementCount:number}){
 const {snapshot,error,refresh}=useWorkflowProjection();
 const owner=chains.find(c=>c.area===value.area)?.id||'STORY_CREATION';
 const queue=snapshot?.queue,workflow=snapshot?.workflow;
 const domain=queue?.workspaceSummary?.domains.find(d=>d.id===owner);
 const linkedModules=workflow?.modules?.filter(module=>module.id===owner||owner==='WORLD_AND_MATERIALS'&&module.id==='STORY_SETTINGS')||[];
 const items=queue?.workUnits||collapseWorkUnits(queue?.items||[]);
 const stages=domain&&workflow?buildWorkflowStages(domain,workflow,items):[];
 const stage=stages.find(s=>s.id===value.stage)||stages.find(s=>s.status==='ACTIVE')||stages[0];
 const exceptions=items.filter(item=>item.ownerModule==='SYSTEM');
 const isException=value.area==='EXCEPTION';
 const exactTasks=isException?exceptions:stage?.items||[];
 const unassigned=items.filter(item=>item.ownerModule===owner&&!stages.some(stage=>stage.id===workflowItemStage(item)));
 const filtered=(rows:ActionItem[])=>rows.filter(item=>matchesCurrentWorkFilters(item,{...value,area:'ALL'}));
 const readyCount=(rows:ActionItem[])=>rows.filter(item=>['READY','IN_PROGRESS'].includes(item.workState)).length;
 const chooseChain=(area:CurrentWorkViewState['area'])=>onChange({...value,area,stage:undefined});
 return <section className="workflow-work-center" aria-label="流程驱动的当前工作">
  <header className="workflow-page-heading"><div><h1 id="overview-title">当前工作</h1><p>选择工作链与阶段，查看可推进的对象和下一步。</p></div><span className="workflow-refresh-time" aria-live="polite">{snapshot?`${workflow?.freshness?.mode==='PUBLISHED_READ_ONLY'?'已发布只读快照':'自动更新'} · ${new Date(snapshot.readAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}`:'正在读取'}</span></header>
  {error&&<div className="workflow-warning" role="alert"><b>当前工作暂不可判断</b><p>{error}。未将读取失败显示为“没有工作”。</p><button onClick={refresh}>重新读取</button></div>}
  <nav className="workflow-chain-switcher" aria-label="三条主体工作链">{chains.map((chain,index)=>{const d=queue?.workspaceSummary?.domains.find(row=>row.id===chain.id);return <button type="button" key={chain.id} aria-pressed={!isException&&chain.id===owner} onClick={()=>chooseChain(chain.area)}><small>0{index+1} · {d?statusLabels[d.status]:'读取中'}</small><strong>{chain.label}</strong><span>{d?.headline||d?.currentGate||chain.subtitle}</span><em>{d?`${d.counts.ready+d.counts.inProgress} 项可推进 · ${d.counts.waiting+d.counts.blocked} 项等待或阻断`:'当前状态待核'}</em></button>;})}</nav>
  {domain&&!isException&&<WorkflowOverview stages={stages} selectedId={stage?.id||''} onSelect={stage=>onChange({...value,stage})} label={domain.label}/>}
  <div className="workflow-stage-workspace"><aside className="workflow-stage-inspector"><small>{isException?'跨对象交接':'所选阶段'}</small><h3>{isException?'异常与交接':stage?.label||'正在读取阶段'}</h3>{stage&&!isException&&<><p className="workflow-scope-count">{workflowCount(stage)}</p><p>{stage.detail}</p><dl><div><dt>真实阶段状态</dt><dd>{statusLabels[stage.status]||stage.status}</dd></div><div><dt>当前可推进任务</dt><dd>{readyCount(stage.items)} 项</dd></div></dl><a href={runtimePath(stage.href)}>打开本阶段工作区 →</a></>}<button type="button" className="workflow-exception-link" aria-pressed={isException} onClick={()=>chooseChain(isException?'STORY':'EXCEPTION')}>{isException?'返回故事工作链':`跨对象异常与交接 · ${exceptions.length}`}</button>{!isException&&linkedModules.length>0&&<details className="workflow-module-status"><summary>相关模块与依据</summary>{linkedModules.map(module=><div key={module.id}><a href={runtimePath(module.href)}>{module.label}</a><p>{module.headline}</p>{module.facts.map(fact=><small key={fact.id} title={fact.boundary}>{fact.label}：{fact.value??'UNKNOWN'}<br/></small>)}</div>)}</details>}<p className="workflow-small-note">对象内的审阅、返修和执行回到所属页面。本页只组织工作，不自动授权或采用。</p></aside>
   <main id="current-work-results" className="workflow-stage-tasks"><header><div><small>本阶段的对象与行动</small><h3>{isException?'处理影响多个对象的交接':'现在看什么，接下来做什么'}</h3></div><div className="workflow-task-filters"><label>状态<select value={value.state} onChange={e=>onChange({...value,state:e.target.value as CurrentWorkViewState['state']})}><option value="NOW">现在可推进</option><option value="ALL">全部状态</option><option value="READY">可立即开展</option><option value="IN_PROGRESS">进行中</option><option value="WAITING">等待依赖</option><option value="BLOCKED">阻断</option></select></label><label>推进主体<select value={value.actor} onChange={e=>onChange({...value,actor:e.target.value as CurrentWorkViewState['actor']})}><option value="ALL">全部主体</option><option value="HUMAN">人可推进</option><option value="AI">AI可推进</option><option value="BOTH">人和AI均可</option><option value="AUTOMATION">自动化</option></select></label></div></header>
    {!isException&&stage?.preparation&&preparationMatchesFilters(stage.preparation,value)&&<article className="workflow-preparation-task"><header><span>第1阶段 · 前置筹备</span><b>{stage.preparation.title}</b><em>{stage.preparation.status==='READY'?'可继续整理':'依据需重核'}</em></header><p>{stage.preparation.sceneCount} 场候选准备内容，独立于正式门禁进度。</p><p>{stage.preparation.reason}</p><div className="current-work-capabilities">{stage.preparation.capabilities.map(c=><span key={c}>{c}</span>)}</div><footer><small>{stage.preparation.boundary}</small><a href={runtimePath(stage.preparation.href)}>进入本场准备 →</a></footer></article>}
    <div className="workflow-task-list">{filtered(exactTasks).map(item=><WorkCard key={item.workUnitKey} item={item} isMainline={item.workUnitKey===queue?.recommendations?.mainline?.workUnitKey}/>)}</div>
    {queue&&!filtered(exactTasks).length&&<p className="workflow-empty">{isException?'当前筛选下没有跨对象异常。':stage?.denominatorState==='UNKNOWN'?'本阶段尚无符合筛选的正式工作单元；正式范围未锁定，不代表已经完成。':'本阶段当前筛选下没有工作单元。'}{value.state==='NOW'&&<button onClick={()=>onChange({...value,state:'ALL'})}>查看等待与阻断</button>}</p>}
    {!isException&&unassigned.length>0&&<section className="workflow-unassigned"><header><h4>本链其他可推进对象</h4><p>这些行动尚未关联具体阶段；保留真实状态，不根据行动名称猜测素材生命周期。</p></header><div className="workflow-task-list">{filtered(unassigned).map(item=><WorkCard key={item.workUnitKey} item={item}/>)}</div>{!filtered(unassigned).length&&<p>当前筛选下没有相关行动。</p>}</section>}
   </main></div>
 </section>;
}
