import {ORCHESTRATION_NAMESPACE, WORKER_KINDS} from './orchestration-service.mjs';

// A separate browser contract: never spread ledger objects into this projection.
export const WORKER_LABELS = Object.freeze({CREATIVE:'创作', CREATIVE_QA:'创作质检', DEVELOP:'开发', DEVELOP_QA:'开发质检'});
export const TASK_STATUS_LABELS = Object.freeze({
  READY:'已排队', WAITING_DEPENDENCIES:'等待依赖', RUNNING:'正在处理', QA_PENDING:'等待独立质检',
  REWORK_PENDING:'等待返修', FINALIZING:'等待交付', FINALIZING_RUNNING:'正在交付',
  BLOCKED:'已阻塞', AWAITING_DECISION:'等待用户决策', RESULT_UNKNOWN:'执行结果待核查',
  CANCEL_REQUESTED:'正在取消 · 执行待核查', DONE:'已完成', CANCELLED:'已取消', SUPERSEDED:'已由返修版本替代',
});
const terminal = new Set(['DONE','CANCELLED','SUPERSEDED']);
const held = new Set(['RUNNING','RESULT_UNKNOWN','CANCEL_REQUESTED']);
const processing = new Set(['RUNNING','FINALIZING_RUNNING','QA_PENDING','REWORK_PENDING','RESULT_UNKNOWN','CANCEL_REQUESTED']);
const identifier = value => typeof value === 'string' && /^[\w-]{1,150}$/.test(value) ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const date = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const decode = row => row && !row.deleted ? JSON.parse(Buffer.from(row.bytes).toString('utf8')) : null;
export function dashboardText(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  // Titles/progress are necessary display text, but can themselves contain diagnostics.
  // Suppress credential-bearing messages altogether; redact paths/URLs before truncating.
  if (/token|capability|credential|authorization|bearer|password|api[ _-]?key|secret|密钥|凭据|私有会话/i.test(value)) return '私有诊断内容已隐藏';
  return value.replace(/(?:https?:\/\/|file:\/\/|[a-z]:[\\/]|~?\/|runtime[\\/]private[\\/])[^\s，。；,;）)]+/gi, '[路径已隐藏]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500) || fallback;
}

function taskProjection(task, runs, tasks, epoch) {
  const status = Object.hasOwn(TASK_STATUS_LABELS, task.status) ? task.status : 'UNKNOWN';
  const lastRun = runs.filter(run => run.taskId === task.id).sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  const result = ['PASS','FAIL','DELIVERED','SUBMITTED','BLOCKED'].includes(task.result?.status) ? task.result.status : null;
  return {
    id:identifier(task.id), title:dashboardText(task.title, '未命名任务'),
    kind:WORKER_KINDS.includes(task.kind) ? task.kind : 'UNKNOWN', kindLabel:WORKER_LABELS[task.kind] || '未知类型',
    status, statusLabel:status === 'DONE' && result === 'FAIL' ? '质检未通过 · 本轮结束' : TASK_STATUS_LABELS[status] || '未知状态',
    progress:dashboardText(task.progress), result, createdAt:date(task.createdAt), updatedAt:date(task.updatedAt),
    finishedAt:terminal.has(status) ? date(lastRun?.finishedAt) || date(task.updatedAt) : null,
    rootId:identifier(task.rootId), parentId:identifier(task.parentId), isRework:Boolean(task.parentId && !task.kind?.endsWith('_QA')),
    qaFailures:count(task.qaFailures), currentEpoch:task.runtimeEpoch === epoch,
    dependencies:(task.dependencies || []).map(id => {
      const dependency = tasks.find(item => item.id === id);
      return {id:identifier(id), title:dashboardText(dependency?.title, '依赖任务暂不可读取'), completed:dependency?.status === 'DONE'};
    }),
  };
}

export async function readOrchestrationDashboard(tx, {heartbeat = null, now = Date.now(), completedPage = 0} = {}) {
  if (!Number.isSafeInteger(completedPage) || completedPage < 0 || completedPage > 1000000) throw new Error('Invalid completed page');
  const metadata = await tx.getMetadata();
  const config = decode(await tx.getAux(ORCHESTRATION_NAMESPACE, 'config'));
  const list = async prefix => (await tx.listAux(ORCHESTRATION_NAMESPACE, {prefix})).map(decode).filter(Boolean);
  const tasks = await list('tasks/'), runs = await list('runs/'), decisions = await list('decisions/');
  const activeRuns = runs.filter(run => held.has(run.status));
  const configCurrent = config?.runtimeEpoch === metadata.runtimeEpoch;
  const mode = configCurrent && ['ACTIVE','PAUSED','STOPPING','STOPPED'].includes(config?.status) ? config.status : config ? 'UNKNOWN' : 'STOPPED';
  const modeEnabled = Boolean(configCurrent && config?.enabled);
  const heartbeatAt = date(heartbeat?.updatedAt);
  const fresh = Boolean(heartbeatAt && heartbeat.instanceId === metadata.instanceId && heartbeat.runtimeEpoch === metadata.runtimeEpoch && now - Date.parse(heartbeatAt) >= 0 && now - Date.parse(heartbeatAt) <= 30000);
  const hostStatus = fresh && ['RUNNING','BLOCKED','STOPPING','STOPPED'].includes(heartbeat.status) ? heartbeat.status : 'UNKNOWN';
  const schedulerBlocked = Boolean(configCurrent && config?.scheduler?.blocked);
  const all = tasks.map(task => taskProjection(task, runs, tasks, metadata.runtimeEpoch));
  const active = all.filter(task => !terminal.has(task.status));
  const completed = all.filter(task => terminal.has(task.status)).sort((a,b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || String(b.id).localeCompare(String(a.id)));
  const pageSize = 20, page = Math.min(completedPage, Math.max(0, Math.ceil(completed.length / pageSize) - 1));
  const workers = activeRuns.map(run => ({
    id:identifier(run.id), workerId:identifier(run.workerId), taskId:identifier(run.taskId),
    title:dashboardText(tasks.find(task => task.id === run.taskId)?.title, '关联任务暂不可读取'),
    kind:WORKER_KINDS.includes(run.kind) ? run.kind : 'UNKNOWN', status:run.status,
    phase:['WORK','QA','FINALIZE'].includes(run.phase) ? run.phase : 'UNKNOWN',
    model:typeof run.model === 'string' && /^[a-zA-Z0-9._:-]{1,150}$/.test(run.model) ? run.model : null,
    effort:['low','medium','high','xhigh','max','ultra'].includes(run.effort) ? run.effort : null,
    startedAt:date(run.createdAt), observed:fresh && (heartbeat.active || []).some(item => item.runId === run.id && item.taskId === run.taskId && item.kind === run.kind),
  }));
  return {
    schemaVersion:'1.0', readOnly:true, instanceId:identifier(metadata.instanceId), observedAt:new Date(now).toISOString(),
    mode:{enabled:modeEnabled, status:mode},
    scheduler:{hostStatus, heartbeatAt:fresh ? heartbeatAt : null, blocked:schedulerBlocked || hostStatus === 'BLOCKED'},
    pools:WORKER_KINDS.map(kind => {
      const occupied = workers.filter(run => run.kind === kind), configured = config ? count(config.concurrency?.[kind]) : 3;
      return {kind, label:WORKER_LABELS[kind], configured, running:occupied.filter(run => run.status === 'RUNNING').length,
        held:occupied.filter(run => run.status !== 'RUNNING').length, waiting:active.filter(task => task.kind === kind && !occupied.some(run => run.taskId === task.id)).length,
        available:Math.max(0, configured - occupied.length), dispatching:configured > occupied.length && modeEnabled && mode === 'ACTIVE' && hostStatus === 'RUNNING' && !schedulerBlocked};
    }),
    workers, processing:active.filter(task => processing.has(task.status)), queue:active.filter(task => !processing.has(task.status)),
    completed:{tasks:completed.slice(page * pageSize, (page + 1) * pageSize), total:completed.length, page, pageSize},
    decisions:decisions.filter(decision => decision.status === 'OPEN').map(decision => ({
      id:identifier(decision.id), taskId:identifier(decision.taskId),
      title:dashboardText(tasks.find(task => task.id === decision.taskId)?.title, '协作模式'),
      reason:({CONCURRENCY:'等待并发配置决策', QA_LIMIT:'质检轮数已达上限', DEPENDENCY_BLOCKED:'前置任务受阻', EPOCH_REAUTHORIZE:'恢复后等待重新授权', RESULT_UNKNOWN:'执行结果待核查', SCHEDULER_BLOCKED:'调度器受阻'})[decision.type] || '任务受阻，等待用户决策',
      createdAt:date(decision.createdAt),
    })),
    // Only execution or work that is actually queued causes background GETs.
    autoRefresh:activeRuns.length > 0 || active.some(task => ['READY','WAITING_DEPENDENCIES','FINALIZING'].includes(task.status)),
  };
}
