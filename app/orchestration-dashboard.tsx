'use client';


import {runtimePath} from './runtime-path';
import {useCallback, useEffect, useRef, useState} from 'react';
import {useRuntimeMode} from './runtime-mode';
import {useInstanceProfile} from './instance-context';
import type {DashboardTask, OrchestrationDashboard as Dashboard} from '../host/instance-runtime/orchestration-dashboard.mjs';

const INTERVAL_MS = 5000;
const MAX_AUTOMATIC_READS = 60;
const modeLabels:Record<string,string> = {ACTIVE:'运行中',PAUSED:'已暂停',STOPPING:'正在停止',STOPPED:'已停止',UNKNOWN:'状态待核查'};
const hostLabels:Record<string,string> = {RUNNING:'后台正在运行',BLOCKED:'后台已阻塞',STOPPING:'后台正在收尾',STOPPED:'后台已停止',UNKNOWN:'UNKNOWN · 后台状态未确认'};
function Time({value}:{value:string|null}) {
  return value ? <time dateTime={value}>{new Date(value).toLocaleString('zh-CN',{hour12:false})}</time> : <>未记录</>;
}
function TaskList({title, tasks, empty, id}:{title:string; tasks:DashboardTask[]; empty:string; id:string}) {
  return <section className="management-card orchestration-tasks" aria-labelledby={id}>
    <h3 id={id}>{title} <span className="orchestration-count">{tasks.length}</span></h3>
    {!tasks.length ? <p>{empty}</p> : <ul>{tasks.map((task,index) => <li key={task.id || index} id={task.id ? `orchestration-task-${task.id}` : undefined}>
      <div className="orchestration-task-heading"><h4>{task.title}</h4><span className={`orchestration-status is-${task.status.toLowerCase()}`}>{task.statusLabel}</span></div>
      <p className="orchestration-meta">{task.kindLabel}{task.isRework && ' · 返修任务'}{task.qaFailures > 0 && ` · 已有 ${task.qaFailures} 轮质检未通过`}{!task.currentEpoch && ' · 历史运行期，执行资格待核查'}</p>
      {task.progress && <p className="orchestration-progress">{task.progress}</p>}
      {!!task.dependencies.length && <p>前置任务：{task.dependencies.map(item => `${item.title}（${item.completed ? '已完成' : '未完成'}）`).join('；')}</p>}
      <div className="orchestration-times"><span>创建 <Time value={task.createdAt}/></span><span>更新 <Time value={task.updatedAt}/></span>{task.finishedAt && <span>结束 <Time value={task.finishedAt}/></span>}</div>
    </li>)}</ul>}
  </section>;
}

export function OrchestrationDashboard() {
  const {hostedReadOnly} = useRuntimeMode();
  const instance = useInstanceProfile();
  const [value,setValue] = useState<Dashboard|null>(null);
  const [error,setError] = useState('');
  const [busy,setBusy] = useState(false);
  const [page,setPage] = useState(0);
  const [automaticReads,setAutomaticReads] = useState(0);
  const [visible,setVisible] = useState(true);
  const current = useRef<AbortController|null>(null);
  const load = useCallback(async () => {
    if (hostedReadOnly) return;
    current.current?.abort();
    const controller = new AbortController(); current.current = controller;
    setBusy(true); setError('');
    const timeout = window.setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(`/api/instance/orchestration?completedPage=${page}`,{method:'GET',cache:'no-store',signal:controller.signal});
      if (!response.ok) throw new Error('协作状态暂时无法读取，请稍后手动刷新。');
      const next:Dashboard = await response.json();
      if (next.schemaVersion !== '1.0' || next.readOnly !== true || next.instanceId !== instance.instanceId) throw new Error('协作状态与当前实例不一致，请手动刷新。');
      if (!controller.signal.aborted && current.current === controller) setValue(next);
    } catch (failure) {
      if (current.current === controller) setError(controller.signal.aborted ? '读取超时，请手动刷新。' : failure instanceof Error ? failure.message : '协作状态暂时无法读取。');
    } finally {
      clearTimeout(timeout);
      if (current.current === controller) setBusy(false);
    }
  },[hostedReadOnly,instance.instanceId,page]);
  useEffect(() => {
    setValue(null); setAutomaticReads(0); void load();
    return () => {const previous=current.current; current.current=null; previous?.abort();};
  },[load]);
  useEffect(() => {
    const sync = () => setVisible(document.visibilityState === 'visible'); sync();
    document.addEventListener('visibilitychange',sync); return () => document.removeEventListener('visibilitychange',sync);
  },[]);
  useEffect(() => {
    if (hostedReadOnly || !visible || busy || error || !value?.autoRefresh || automaticReads >= MAX_AUTOMATIC_READS) return;
    const timer = window.setTimeout(() => {setAutomaticReads(count => count+1); void load();},INTERVAL_MS);
    return () => clearTimeout(timer);
  },[hostedReadOnly,visible,busy,error,value,automaticReads,load]);
  const manualRefresh = () => {setAutomaticReads(0); void load();};
  if (hostedReadOnly) return <section className="management-card" aria-labelledby="orchestration-title"><h2 id="orchestration-title">多 Agent 协作</h2><p>协作状态仅在本地实例可用。请在本地审阅台查看任务和后台运行状态。</p></section>;
  return <div className="management-stack orchestration-dashboard">
    <section className="management-card" aria-labelledby="orchestration-title">
      <header><div><h2 id="orchestration-title">多 Agent 协作</h2><p>当前实例的任务与后台状态。需要调整或处理决策时，请通过项目主会话提出。</p></div><button onClick={manualRefresh} disabled={busy}>手动刷新</button></header>
      <p role="status" aria-live="polite">{busy ? '正在读取协作状态…' : value ? <>读取于 <Time value={value.observedAt}/></> : '尚未读取协作状态'}</p>
      {error && <p className="management-feedback is-error" role="alert">{error}{value && ' 下方保留上次读取结果，当前状态未确认。'}</p>}
      {value && <>
        <dl className="orchestration-overview">
          <div><dt>协作模式</dt><dd>{value.mode.enabled ? '已启用' : '未启用'} · {modeLabels[value.mode.status] || '未知'} <span>({value.mode.status})</span></dd></div>
          <div><dt>Schedule 后台</dt><dd>{hostLabels[value.scheduler.hostStatus] || hostLabels.UNKNOWN}</dd>{value.scheduler.blocked && <dd>调度受阻，等待主会话处理</dd>}<dd className="orchestration-meta">最近心跳 <Time value={value.scheduler.heartbeatAt}/></dd></div>
        </dl>
        <p className="orchestration-meta">{error ? '读取失败，自动刷新已停止。' : automaticReads >= MAX_AUTOMATIC_READS ? '本轮自动刷新已达上限，请手动刷新。' : !value.autoRefresh ? '当前没有运行中或排队任务，自动刷新已停止。' : !visible ? '页面不可见，自动刷新已暂停。' : '有运行中或排队任务时每 5 秒刷新，最多 60 次；读取失败或离开页面即停止。'}</p>
      </>}
    </section>
    {value && <>
      <section className="management-card" aria-labelledby="orchestration-workers"><h3 id="orchestration-workers">Worker 状态</h3>
        <div className="orchestration-pools">{value.pools.map(pool => <section key={pool.kind} aria-label={`${pool.label} Worker`}>
          <h4>{pool.label} <span>{pool.kind}</span></h4>
          <dl>{[['配置并发',pool.configured],['运行',pool.running],['等待',pool.waiting],['可用名额',pool.available]].map(([label,number]) => <div key={label}><dt>{label}</dt><dd>{number}</dd></div>)}</dl>
          <p>{pool.held > 0 && `${pool.held} 个名额等待执行核查 · `}{pool.dispatching ? '可调度' : '当前不派发新任务'}</p>
          <ul>{value.workers.filter(worker => worker.kind === pool.kind).map((worker,index) => <li key={worker.id || index}>
            <a href={runtimePath(`#orchestration-task-${worker.taskId}`)}>{worker.title}</a>
            <p>{worker.phase === 'QA' ? '独立质检' : worker.phase === 'FINALIZE' ? '交付' : '生产'} · {worker.status === 'RUNNING' ? '运行中' : '执行结果待核查'} · {worker.observed ? '后台已观测' : '后台尚未确认'}</p>
            <p>实际模型：{worker.model || '未记录'} · 推理强度：{worker.effort || '未记录'}</p>
            <p>开始 <Time value={worker.startedAt}/></p>
          </li>)}</ul>
        </section>)}</div>
      </section>
      <TaskList id="orchestration-processing" title="正在处理" tasks={value.processing} empty="当前没有正在处理的任务。"/>
      <TaskList id="orchestration-queue" title="任务队列" tasks={value.queue} empty="任务队列为空。"/>
      <section className="management-card orchestration-decisions" aria-labelledby="orchestration-decisions"><h3 id="orchestration-decisions">待用户决策 <span className="orchestration-count">{value.decisions.length}</span></h3>
        {!value.decisions.length ? <p>没有待用户决策。</p> : <ul>{value.decisions.map((decision,index) => <li key={decision.id || index}><h4>{decision.title}</h4><p>{decision.reason}</p><p>提出 <Time value={decision.createdAt}/></p></li>)}</ul>}
      </section>
      <div><TaskList id="orchestration-completed" title="已完成任务" tasks={value.completed.tasks} empty="尚无已完成任务（含已取消及已替代记录）。"/>
        <nav className="orchestration-pagination" aria-label="已完成任务分页"><button disabled={busy || value.completed.page===0} onClick={() => setPage(value.completed.page-1)}>上一页</button><span>共 {value.completed.total} 项 · 第 {value.completed.page+1} 页</span><button disabled={busy || (value.completed.page+1)*value.completed.pageSize>=value.completed.total} onClick={() => setPage(value.completed.page+1)}>下一页</button></nav>
      </div>
    </>}
  </div>;
}
