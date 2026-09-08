import {randomUUID, timingSafeEqual} from 'node:crypto';
import {canonicalJson, sha256} from './bytes.mjs';

export const ORCHESTRATION_PROTOCOL = '1.0';
export const ORCHESTRATION_NAMESPACE = 'assistant-orchestration';
export const WORKER_KINDS = Object.freeze(['CREATIVE', 'CREATIVE_QA', 'DEVELOP', 'DEVELOP_QA']);
const terminal = new Set(['DONE', 'CANCELLED', 'SUPERSEDED']);
const running = new Set(['RUNNING', 'FINALIZING_RUNNING']);
const heldRuns = new Set(['RUNNING', 'RESULT_UNKNOWN', 'CANCEL_REQUESTED']);
const claimResources = task => [...new Set([...task.resources, ...(task.status === 'FINALIZING' ? ['project:formal-delivery'] : [])])];
const fail = (code, message) => {throw Object.assign(new Error(message), {code});};
const requireValue = (ok, message, code = 'ORCHESTRATION_INVALID') => {if (!ok) fail(code, message);};
const text = (value, name, maximum = 16000) => {requireValue(typeof value === 'string' && value.trim() && value.length <= maximum && !value.includes('\0'), name + ' is required'); return value;};
const id = prefix => prefix + '_' + randomUUID();
const stamp = () => new Date().toISOString();
const decode = row => row && !row.deleted ? JSON.parse(Buffer.from(row.bytes).toString('utf8')) : null;
const clean = value => {
  if (Array.isArray(value)) return value.map(clean);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['token', 'tokenHash', 'capabilityToken'].includes(key)).map(([key, item]) => [key, clean(item)]));
};
function matchesToken(value, hash) {
  return typeof value === 'string' && typeof hash === 'string' && hash.length === 64 && timingSafeEqual(Buffer.from(sha256(value)), Buffer.from(hash));
}
function capability(args) {return text(args.capabilityToken, 'capabilityToken', 512).length >= 32 ? args.capabilityToken : fail('ORCHESTRATION_INVALID', 'Capability must have at least 32 characters');}
function reconcile(run, value) {
  requireValue(value?.status === 'CONFIRMED_NOT_RUNNING' && value.runId === run.id && (!run.threadId || value.threadId === run.threadId) && (!run.turnId || value.turnId === run.turnId) && typeof value.evidenceRef === 'string' && value.evidenceRef.trim(), 'Reconcile the exact run/thread/turn with observed evidence before releasing its lease', 'ORCHESTRATION_RECONCILIATION_REQUIRED');
}
function concurrency(current, updates) {
  requireValue(updates && typeof updates === 'object' && !Array.isArray(updates), 'Concurrency must be an object');
  for (const [kind, count] of Object.entries(updates)) requireValue(WORKER_KINDS.includes(kind) && Number.isSafeInteger(count) && count >= 0, 'Invalid concurrency');
  return {...current, ...updates};
}
function artifacts(values, required = true) {
  requireValue(Array.isArray(values) && (!required || values.length > 0) && values.length <= 128, 'Exact artifacts are required');
  for (const artifact of values) {text(artifact.ref, 'artifact.ref', 4096); requireValue(/^[a-f0-9]{64}$/.test(artifact.sha256 || ''), 'Artifact SHA-256 is required');}
  requireValue(new Set(values.map(item => item.ref)).size === values.length, 'Duplicate artifact references');
  return values.map(({ref, sha256: hash}) => ({ref, sha256: hash}));
}
function inputTask(args) {
  requireValue(['CREATIVE', 'DEVELOP'].includes(args.kind), 'Submit only authoring or development tasks');
  for (const field of ['title', 'goal', 'scope']) text(args[field], field);
  requireValue(Array.isArray(args.acceptance) && args.acceptance.length > 0 && args.acceptance.length <= 64, 'Acceptance criteria are required');
  for (const criterion of args.acceptance) {text(criterion.id, 'criterion.id', 100); text(criterion.text, 'criterion.text');}
  requireValue(new Set(args.acceptance.map(item => item.id)).size === args.acceptance.length, 'Duplicate acceptance criteria');
  for (const field of ['dependencies', 'resources']) requireValue(args[field] === undefined || Array.isArray(args[field]) && args[field].length <= 128 && args[field].every(value => typeof value === 'string' && value && value.length <= 4096), 'Invalid ' + field);
  requireValue(args.priority === undefined || Number.isSafeInteger(args.priority), 'Priority must be an integer');
  if (args.execution !== undefined) {
    requireValue(args.execution && typeof args.execution === 'object' && !Array.isArray(args.execution), 'Invalid execution binding');
    for (const key of Object.keys(args.execution)) requireValue(['cwd', 'repository', 'baseCommit'].includes(key), 'Unknown execution binding');
    if (args.execution.baseCommit !== undefined) requireValue(/^[a-f0-9]{40}$/.test(args.execution.baseCommit), 'Exact base commit required');
  }
  return {...args, inputs: artifacts(args.inputs || [], false), resources: [...new Set(args.resources || [])], dependencies: [...new Set(args.dependencies || [])]};
}

class Store {
  constructor(tx) {this.tx = tx; this.cache = new Map(); this.writes = 0;}
  async get(key) {if (!this.cache.has(key)) this.cache.set(key, await this.tx.getAux(ORCHESTRATION_NAMESPACE, key)); return decode(this.cache.get(key));}
  async put(key, value) {
    await this.get(key);
    const prior = this.cache.get(key);
    const row = await this.tx.putAux({namespace: ORCHESTRATION_NAMESPACE, key, bytes: canonicalJson(value), expectedRevisionId: prior?.revisionId || null, mediaType: 'application/json', metadata: {runtimeEpoch: value.runtimeEpoch, status: value.status, kind: value.kind, createdAt: value.createdAt}});
    this.cache.set(key, row); this.writes++; return value;
  }
  async list(prefix) {return (await this.tx.listAux(ORCHESTRATION_NAMESPACE, {prefix})).map(decode).filter(Boolean);}
  async task(taskId) {const task = await this.get('tasks/' + text(taskId, 'taskId', 100)); requireValue(task, 'Task does not exist', 'ORCHESTRATION_NOT_FOUND'); return task;}
  async save(task) {task.updatedAt = stamp(); return this.put('tasks/' + task.id, task);}
  async event(config, kind, data) {
    const sequence = ++config.lastEventSeq;
    const event = {id: id('event'), sequence, kind, recordedAt: stamp(), ...clean(data)};
    await this.put('events/' + String(sequence).padStart(16, '0'), event); return event;
  }
  async decision(config, type, task, summary, extra = {}) {
    const key = sha256(canonicalJson({type, taskId: task?.id || null, ...extra}));
    const existing = (await this.list('decisions/')).find(item => item.dedupKey === key && item.status === 'OPEN');
    if (existing) return existing;
    const decision = {id: id('decision'), dedupKey: key, type, taskId: task?.id || null, status: 'OPEN', summary, createdAt: stamp(), concurrency: config.concurrency, ...extra};
    await this.put('decisions/' + decision.id, decision);
    await this.event(config, 'DECISION_REQUIRED', {decision}); return decision;
  }
  async clearDependencyDecisions(config, taskId) {
    for (const decision of await this.list('decisions/')) if (decision.taskId === taskId && decision.type === 'DEPENDENCY_BLOCKED' && decision.status === 'OPEN') {
      decision.status = 'RESOLVED'; decision.response = {action: 'dependency-completed'}; decision.resolvedAt = stamp(); await this.put('decisions/' + decision.id, decision); await this.event(config, 'DECISION_RESOLVED', {decisionId: decision.id, action: 'dependency-completed'});
    }
  }
}

export async function readOrchestration(tx, input = {}) {
  const store = new Store(tx), metadata = await tx.getMetadata(), config = await store.get('config');
  const result = {schemaVersion: ORCHESTRATION_PROTOCOL, instanceId: metadata.instanceId, runtimeEpoch: metadata.runtimeEpoch, config: clean(config), scheduler: clean(config?.scheduler || null), concurrency: config?.concurrency || Object.fromEntries(WORKER_KINDS.map(kind => [kind, 3])), lastEventSeq: config?.lastEventSeq || 0};
  const query = input.query || 'status';
  if (query === 'events') {
    const after = Number(input.after || 0), limit = Number(input.limit || 100);
    requireValue(Number.isSafeInteger(after) && after >= 0 && Number.isSafeInteger(limit) && limit > 0 && limit <= 500, 'Invalid event cursor');
    // Sequence-addressed reads never materialize the entire event history.
    const events = [];
    for (let seq = after + 1; seq <= result.lastEventSeq && events.length < limit; seq++) {const event = await store.get('events/' + String(seq).padStart(16, '0')); if (event) events.push(event);}
    return {...result, events, after: events.at(-1)?.sequence || after, hasMore: (events.at(-1)?.sequence || after) < result.lastEventSeq};
  }
  if (query === 'task') {
    const task = await store.task(input.taskId);
    return {...result, task: clean(task), runs: clean((await store.list('runs/')).filter(run => run.taskId === task.id)), children: clean((await store.list('tasks/')).filter(child => child.parentId === task.id))};
  }
  const tasks = (await store.list('tasks/')).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  if (query === 'list') {
    const after = Number(input.after || 0), limit = Number(input.limit || 100);
    requireValue(Number.isSafeInteger(after) && after >= 0 && Number.isSafeInteger(limit) && limit > 0 && limit <= 500, 'Invalid task cursor');
    const selected = tasks.filter(task => (!input.kind || task.kind === input.kind) && (!input.status || task.status === input.status));
    return {...result, tasks: clean(selected.slice(after, after + limit)), after: after + Math.max(0, Math.min(limit, selected.length - after)), hasMore: after + limit < selected.length};
  }
  requireValue(query === 'status', 'Unknown query');
  const activeTasks = tasks.filter(task => !terminal.has(task.status));
  const runs = (await store.list('runs/')).filter(run => heldRuns.has(run.status));
  return {...result, tasks: clean(activeTasks), runs: clean(runs), decisions: clean((await store.list('decisions/')).filter(decision => decision.status === 'OPEN')), counts: Object.fromEntries(WORKER_KINDS.map(kind => [kind, {running: runs.filter(run => run.kind === kind).length, waiting: activeTasks.filter(task => task.kind === kind && !running.has(task.status)).length}]))};
}

export async function writeOrchestration(tx, input) {
  requireValue(input?.schemaVersion === ORCHESTRATION_PROTOCOL, 'Protocol version required');
  text(input.requestId, 'requestId', 150); text(input.command, 'command', 50);
  const args = input.args || {}, actor = input.actor || {}, store = new Store(tx), metadata = await tx.getMetadata();
  requireValue(input.runtimeEpoch === metadata.runtimeEpoch, 'Runtime epoch changed', 'ORCHESTRATION_EPOCH');
  let config = await store.get('config');
  if (input.command !== 'attach') {
    requireValue(config && config.runtimeEpoch === metadata.runtimeEpoch, 'Attach to the current runtime first', 'ORCHESTRATION_EPOCH');
    if (actor.kind === 'MAIN') requireValue(actor.id === config.main?.id && matchesToken(actor.token, config.main?.tokenHash), 'Main ownership changed', 'ORCHESTRATION_MAIN_LOST');
    else if (actor.kind === 'SCHEDULER') requireValue(actor.id === config.scheduler?.id && matchesToken(actor.token, config.scheduler?.tokenHash) && config.status !== 'STOPPED', 'Scheduler ownership changed', 'ORCHESTRATION_SCHEDULER_LOST');
    else if (actor.kind === 'WORKER') {
      const run = await store.get('runs/' + text(args.runId, 'runId', 100));
      requireValue(run && actor.id === run.workerId && matchesToken(actor.token, run.tokenHash) && run.generation === config.scheduler?.generation && run.runtimeEpoch === metadata.runtimeEpoch, 'Worker lease changed', 'ORCHESTRATION_LEASE_LOST');
    } else fail('ORCHESTRATION_ROLE', 'Explicit actor required');
  }
  const requestHash = sha256(canonicalJson(input)), receiptKey = 'receipts/' + sha256(input.requestId), receipt = await store.get(receiptKey);
  const withCapability = value => {
    const result = structuredClone(value);
    if (args.capabilityToken) for (const key of ['main', 'scheduler', 'run']) if (result?.[key]) result[key].token = args.capabilityToken;
    return result;
  };
  if (receipt) {requireValue(receipt.requestHash === requestHash, 'Request id reused with different content', 'ORCHESTRATION_CONFLICT'); return withCapability(receipt.result);}
  const only = (...roles) => requireValue(roles.includes(actor.kind), 'Action is not allowed for this role', 'ORCHESTRATION_ROLE');
  const saveConfig = async () => {await store.put('config', config);};
  let output;
  if (input.command === 'attach') {
    const token = capability(args), entryId = text(args.entryId, 'entryId', 150);
    if (!config) config = {schemaVersion: ORCHESTRATION_PROTOCOL, instanceId: metadata.instanceId, runtimeEpoch: metadata.runtimeEpoch, status: 'PAUSED', enabled: false, lastEventSeq: 0, concurrency: Object.fromEntries(WORKER_KINDS.map(kind => [kind, 3])), scheduler: null};
    requireValue(config.main?.id === entryId || !config.main || args.takeover === true, 'Another Main owns this project; explicit takeover required', 'ORCHESTRATION_MAIN_EXISTS');
    if (config.runtimeEpoch !== metadata.runtimeEpoch) {
      config.runtimeEpoch = metadata.runtimeEpoch; config.enabled = false; config.status = 'PAUSED'; config.authorization = null;
      config.scheduler = {...config.scheduler, generation: (config.scheduler?.generation || 0) + 1, tokenHash: null, threadId: null};
      for (const task of await store.list('tasks/')) if (!terminal.has(task.status)) {
        task.preRestoreStatus = task.status; task.status = 'BLOCKED'; task.blockReason = 'EPOCH_REAUTHORIZE'; await store.save(task);
        if (task.id === task.rootId) await store.decision(config, 'EPOCH_REAUTHORIZE', task, 'Restored tasks require fresh user authority and exact input revalidation', {runtimeEpoch: metadata.runtimeEpoch});
      }
      for (const run of await store.list('runs/')) if (heldRuns.has(run.status)) {
        run.status = 'RESULT_UNKNOWN'; await store.put('runs/' + run.id, run);
        await store.decision(config, 'RESULT_UNKNOWN', await store.task(run.taskId), 'Restored execution must be reconciled before any retry', {runId: run.id});
      }
    }
    config.main = {id: entryId, tokenHash: sha256(token), attachedAt: stamp()};
    await store.event(config, 'MAIN_ATTACHED', {entryId});
    output = {main: {id: entryId, token}, config: clean(config)};
  } else if (input.command === 'activate') {
    only('MAIN'); text(args.projectRoot, 'projectRoot', 4096);
    requireValue(args.authorization?.automaticCompletion === true, 'Task-scoped execution authority must be explicit');
    text(args.authorization.source, 'authorization.source'); text(args.authorization.scope, 'authorization.scope');
    config.authorization = {...args.authorization, id: id('authorization'), runtimeEpoch: metadata.runtimeEpoch, grantedAt: stamp()};
    config.projectRoot = args.projectRoot; config.model = args.model || null; config.effort = args.effort || null;
    config.enabled = true; config.status = 'ACTIVE'; config.concurrency = concurrency(config.concurrency, args.concurrency || {});
    await store.event(config, 'MODE_ACTIVATED', {authorization: config.authorization}); output = {config: clean(config)};
  } else if (input.command === 'scheduler-open') {
    only('MAIN'); requireValue(config.enabled && config.status === 'ACTIVE', 'Mode is not active');
    const token = capability(args), schedulerId = text(args.schedulerId, 'schedulerId', 150), old = config.scheduler;
    config.scheduler = {id: schedulerId, tokenHash: sha256(token), generation: (old?.generation || 0) + 1, threadId: old?.threadId || null, lastEventSeq: old?.lastEventSeq || 0, blocked: old?.blocked || null};
    for (const run of await store.list('runs/')) if (run.status === 'RUNNING') {
      run.status = 'RESULT_UNKNOWN'; await store.put('runs/' + run.id, run);
      const task = await store.task(run.taskId); task.status = 'BLOCKED'; task.blockReason = 'RESULT_UNKNOWN'; await store.save(task);
      await store.decision(config, 'RESULT_UNKNOWN', task, 'Previous execution must be reconciled before retry', {runId: run.id});
    }
    await store.event(config, 'SCHEDULER_OPENED', {scheduler: config.scheduler}); output = {scheduler: {...clean(config.scheduler), token}, config: clean(config)};
  } else if (input.command === 'scheduler-state') {
    only('SCHEDULER'); text(args.threadId, 'threadId', 150); requireValue(Number.isSafeInteger(args.lastEventSeq) && args.lastEventSeq >= 0 && args.lastEventSeq <= config.lastEventSeq, 'Invalid scheduler event cursor');
    config.scheduler.threadId = args.threadId; config.scheduler.lastEventSeq = args.lastEventSeq; output = {scheduler: clean(config.scheduler)};
  } else if (input.command === 'scheduler-blocked') {
    only('SCHEDULER'); text(args.code, 'code', 150); text(args.summary, 'summary');
    const decision = await store.decision(config, 'SCHEDULER_BLOCKED', null, args.summary, {code: args.code, threadId: args.threadId || null, turnId: args.turnId || null});
    config.scheduler.blocked = {code: args.code, summary: args.summary, threadId: args.threadId || null, turnId: args.turnId || null, decisionId: decision.id};
    output = {decision};
  } else if (input.command === 'submit') {
    only('MAIN'); requireValue(config.enabled && config.authorization, 'Mode authorization required');
    requireValue(!args.parentId, 'Only the scheduler state machine may derive QA and rework children');
    const value = inputTask(args);
    const authorization = config.authorization;
    for (const dependency of value.dependencies) await store.task(dependency);
    const taskId = id('task'), task = {id: taskId, rootId: taskId, parentId: null, kind: value.kind, title: value.title, goal: value.goal, scope: value.scope, acceptance: value.acceptance, dependencies: value.dependencies, inputs: value.inputs, resources: value.resources, execution: value.execution || {}, priority: value.priority || 0, status: 'READY', qaFailures: 0, qaLimit: 3, artifacts: [], artifactHash: null, authorization, createdAt: stamp(), queuedSeq: config.lastEventSeq + 1, runtimeEpoch: metadata.runtimeEpoch};
    for (const dependency of task.dependencies) if ((await store.task(dependency)).status !== 'DONE') task.status = 'WAITING_DEPENDENCIES';
    await store.save(task); await store.event(config, 'TASK_SUBMITTED', {taskId, kind: task.kind}); output = {task: clean(task)};
  } else if (input.command === 'claim') {
    only('SCHEDULER'); requireValue(WORKER_KINDS.includes(args.kind), 'Invalid worker kind');
    const token = capability(args), workerId = text(args.workerId, 'workerId', 150);
    if (config.status !== 'ACTIVE' || config.scheduler.blocked) output = null;
    else {
      const tasks = await store.list('tasks/'), allRuns = await store.list('runs/'), activeRuns = allRuns.filter(run => heldRuns.has(run.status));
      const used = activeRuns.filter(run => run.kind === args.kind).length;
      const occupied = new Set(activeRuns.flatMap(run => run.resources || []));
      const eligible = [];
      if (used < config.concurrency[args.kind] && !activeRuns.some(run => run.workerId === workerId)) for (const task of tasks) {
        if (task.kind !== args.kind || !['READY', 'WAITING_DEPENDENCIES', 'FINALIZING'].includes(task.status) || args.taskId && args.taskId !== task.id || task.runtimeEpoch !== metadata.runtimeEpoch) continue;
        if (task.dependencies.some(dependency => tasks.find(item => item.id === dependency)?.status !== 'DONE')) continue;
        if (claimResources(task).some(resource => occupied.has(resource))) continue;
        if (task.kind.endsWith('_QA') && allRuns.some(run => run.rootId === task.rootId && run.phase === 'WORK' && run.workerId === workerId)) continue;
        eligible.push(task);
      }
      eligible.sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt) || (a.queuedSeq || 0) - (b.queuedSeq || 0) || a.id.localeCompare(b.id));
      const task = eligible[0];
      if (!task) output = null;
      else {
        await store.clearDependencyDecisions(config, task.id);
        const phase = task.status === 'FINALIZING' ? 'FINALIZE' : task.kind.endsWith('_QA') ? 'QA' : 'WORK';
        const run = {id: id('run'), taskId: task.id, rootId: task.rootId, workerId, tokenHash: sha256(token), generation: config.scheduler.generation, runtimeEpoch: metadata.runtimeEpoch, kind: task.kind, phase, status: 'RUNNING', resources: claimResources(task), createdAt: stamp()};
        task.status = phase === 'FINALIZE' ? 'FINALIZING_RUNNING' : 'RUNNING'; task.currentRunId = run.id;
        await store.save(task); await store.put('runs/' + run.id, run); await store.event(config, 'TASK_CLAIMED', {taskId: task.id, runId: run.id, workerId, phase});
        output = {task: clean(task), run: {...clean(run), token}};
      }
    }
  } else if (['progress', 'run-context', 'report'].includes(input.command)) {
    only('WORKER'); const run = await store.get('runs/' + args.runId), task = await store.task(run.taskId);
    requireValue(run.status === 'RUNNING' && task.currentRunId === run.id && running.has(task.status), 'Run already closed', 'ORCHESTRATION_RUN_CLOSED');
    requireValue(config.status !== 'STOPPED', 'Runner is stopped', 'ORCHESTRATION_LEASE_LOST');
    if (input.command === 'run-context') {
      if (run.phase === 'QA' && args.threadId) requireValue(!(await store.list('runs/')).some(prior => prior.rootId === run.rootId && prior.phase === 'WORK' && prior.threadId === args.threadId), 'Author thread cannot review its own task', 'ORCHESTRATION_QA_IDENTITY');
      for (const field of ['threadId', 'turnId', 'worktree', 'model', 'effort']) if (args[field] !== undefined) run[field] = text(args[field], field, 4096);
      await store.put('runs/' + run.id, run); output = {run: clean(run)};
    } else if (input.command === 'progress') {
      task.progress = text(args.summary, 'summary'); for (const field of ['model', 'effort']) if (args[field]) run[field] = text(args[field], field, 150);
      await store.save(task); await store.put('runs/' + run.id, run); await store.event(config, 'PROGRESS', {taskId: task.id, summary: task.progress}); output = {task: clean(task)};
    } else {
      const result = args.result; text(result?.summary, 'result.summary');
      requireValue(['SUBMITTED', 'PASS', 'FAIL', 'BLOCKED', 'DELIVERED'].includes(result.status), 'Unknown result status');
      const root = task.rootId === task.id ? task : await store.task(task.rootId);
      if (result.status === 'BLOCKED') {
        task.status = 'BLOCKED'; task.blockReason = text(result.code || 'EXECUTION_BLOCKED', 'code', 150);
        await store.decision(config, task.blockReason, task, result.summary, {runId: run.id});
      } else if (run.phase === 'WORK') {
        requireValue(result.status === 'SUBMITTED', 'Author must submit artifacts for independent QA');
        const produced = artifacts(result.artifacts);
        root.artifacts = produced; root.artifactHash = sha256(canonicalJson(produced)); root.status = 'QA_PENDING';
        task.artifacts = produced; task.artifactHash = root.artifactHash; task.status = 'QA_PENDING';
        const qa = {...structuredClone(root), id: id('task'), parentId: task.id, rootId: root.id, kind: root.kind + '_QA', title: 'QA: ' + root.title, status: 'READY', dependencies: [], resources: root.resources, currentRunId: null, createdAt: stamp(), queuedSeq: config.lastEventSeq + 1, reviewedTaskId: task.id};
        await store.save(qa); if (root.id !== task.id) await store.save(root);
        await store.event(config, 'QA_QUEUED', {taskId: root.id, qaTaskId: qa.id, artifactHash: root.artifactHash});
      } else if (run.phase === 'QA') {
        requireValue(['PASS', 'FAIL'].includes(result.status), 'QA must pass, fail, or report blocked');
        requireValue(result.artifactHash === task.artifactHash && result.artifactHash === root.artifactHash, 'Reviewed artifact changed', 'ORCHESTRATION_ARTIFACT_CHANGED');
        requireValue(Array.isArray(result.checks) && result.checks.length === root.acceptance.length, 'QA must cover every acceptance criterion');
        const checks = new Map(result.checks.map(check => [check.criterionId, check]));
        requireValue(checks.size === root.acceptance.length && root.acceptance.every(criterion => checks.has(criterion.id)), 'QA criterion identity mismatch');
        for (const check of checks.values()) {requireValue(['PASS', 'FAIL'].includes(check.status), 'Incomplete QA must report BLOCKED'); text(check.comment, 'QA comment'); requireValue(Array.isArray(check.evidenceRefs) && check.evidenceRefs.length > 0 && check.evidenceRefs.every(ref => typeof ref === 'string' && ref), 'QA observation evidence required');}
        requireValue((result.status === 'PASS') === [...checks.values()].every(check => check.status === 'PASS'), 'QA verdict disagrees with criteria');
        task.status = 'DONE'; task.result = result;
        root.lastQA = {taskId: task.id, artifactHash: task.artifactHash, status: result.status, checks: result.checks};
        if (result.status === 'PASS') {
          root.status = 'FINALIZING';
          for (const child of await store.list('tasks/')) if (child.rootId === root.id && child.id !== root.id && child.kind === root.kind && child.status === 'QA_PENDING') {child.status = 'DONE'; child.result = {status: 'PASS', qaTaskId: task.id}; await store.save(child);}
        } else {
          root.qaFailures += 1;
          const reviewed = await store.task(task.reviewedTaskId);
          if (reviewed.id !== root.id) {reviewed.status = 'SUPERSEDED'; await store.save(reviewed);}
          if (root.qaFailures >= root.qaLimit) {root.status = 'AWAITING_DECISION'; await store.decision(config, 'QA_LIMIT', root, 'Three failed quality rounds require a user decision', {qaFailures: root.qaFailures});}
          else {
            root.status = 'REWORK_PENDING';
            const rework = {...structuredClone(root), id: id('task'), parentId: root.id, rootId: root.id, title: 'Rework: ' + root.title, status: 'READY', dependencies: [], currentRunId: null, createdAt: stamp(), queuedSeq: config.lastEventSeq + 1, repairInstructions: result};
            await store.save(rework); await store.event(config, 'REWORK_QUEUED', {taskId: root.id, reworkTaskId: rework.id, qaFailures: root.qaFailures});
          }
        }
        await store.save(root);
      } else {
        requireValue(result.status === 'DELIVERED' && root.lastQA?.status === 'PASS' && result.artifactHash === root.artifactHash, 'Final delivery requires the exact passed QA');
        artifacts(result.artifacts);
        requireValue(Array.isArray(result.deliveryEvidence) && result.deliveryEvidence.length > 0, 'Final delivery evidence required');
        artifacts(result.deliveryEvidence);
        requireValue(sha256(canonicalJson(artifacts(result.artifacts))) === root.artifactHash, 'Finalization changed the reviewed artifacts', 'ORCHESTRATION_ARTIFACT_CHANGED');
        task.status = 'DONE'; task.result = result;
      }
      task.progress = result.summary; run.status = result.status === 'BLOCKED' ? result.code === 'RESULT_UNKNOWN' ? 'RESULT_UNKNOWN' : 'BLOCKED' : 'COMPLETED'; run.result = result; run.finishedAt = stamp();
      await store.save(task); await store.put('runs/' + run.id, run); await store.event(config, 'RUN_REPORTED', {taskId: task.id, runId: run.id, result: result.status, taskStatus: task.status}); output = {task: clean(task), root: clean(await store.task(root.id))};
    }
  } else if (input.command === 'tick') {
    only('SCHEDULER');
    const tasks = await store.list('tasks/');
    for (const task of tasks) if (task.status === 'WAITING_DEPENDENCIES') {
      const deps = task.dependencies.map(dependency => tasks.find(item => item.id === dependency));
      if (deps.every(dependency => dependency?.status === 'DONE')) {
        task.status = 'READY'; await store.save(task);
        await store.clearDependencyDecisions(config, task.id);
      }
      else if (deps.some(dependency => !dependency || dependency.status === 'CANCELLED' || dependency.status === 'BLOCKED' || dependency.status === 'AWAITING_DECISION')) await store.decision(config, 'DEPENDENCY_BLOCKED', task, 'Dependency requires a decision', {dependencies: task.dependencies});
    }
    for (const kind of WORKER_KINDS) {
      const waiting = tasks.filter(task => task.kind === kind && task.status === 'READY'), count = tasks.filter(task => task.kind === kind && running.has(task.status)).length;
      if (waiting.length && (config.concurrency[kind] === 0 || count >= config.concurrency[kind] && waiting.some(task => Date.now() - Date.parse(task.createdAt) >= 300000))) await store.decision(config, 'CONCURRENCY', null, 'Review worker concurrency for the waiting queue', {kind, configured: config.concurrency[kind], running: count, waiting: waiting.length});
    }
    if (config.status === 'STOPPING' && !(await store.list('runs/')).some(run => ['RUNNING', 'CANCEL_REQUESTED'].includes(run.status))) {config.status = 'STOPPED'; await store.event(config, 'MODE_STOPPED', {});}
    output = {config: clean(config)};
    // Idle maintenance is a read-equivalent operation; do not append heartbeat history.
    if (!store.writes) return output;
  } else if (input.command === 'reconcile-run') {
    only('SCHEDULER'); const run = await store.get('runs/' + text(args.runId, 'runId', 100));
    requireValue(run?.status === 'CANCEL_REQUESTED', 'Only a requested cancellation may be acknowledged'); reconcile(run, args.reconciliation);
    run.status = 'CANCELLED'; run.reconciliation = clean(args.reconciliation); run.finishedAt = stamp(); await store.put('runs/' + run.id, run); await store.event(config, 'RUN_CANCELLED', {runId: run.id}); output = {run: clean(run)};
  } else if (input.command === 'scale') {
    only('MAIN'); config.concurrency = concurrency(config.concurrency, args.concurrency); await store.event(config, 'CONCURRENCY_CHANGED', {concurrency: config.concurrency}); output = {config: clean(config)};
  } else if (input.command === 'decision') {
    only('MAIN'); const decision = await store.get('decisions/' + text(args.decisionId, 'decisionId', 100));
    requireValue(decision?.status === 'OPEN', 'Decision already resolved', 'ORCHESTRATION_DECISION_CLOSED'); text(args.comment, 'decision comment');
    requireValue(['resume', 'retry', 'cancel', 'scale'].includes(args.action), 'Invalid decision action');
    if (args.action === 'scale') {requireValue(decision.type === 'CONCURRENCY', 'Scale separately without consuming a task or scheduler decision'); config.concurrency = concurrency(config.concurrency, args.concurrency);}
    else if (decision.taskId) {
      const task = await store.task(decision.taskId), root = task.id === task.rootId ? task : await store.task(task.rootId);
      if (decision.type === 'RESULT_UNKNOWN') {
        const run = await store.get('runs/' + decision.runId); reconcile(run, args.reconciliation);
        run.status = args.action === 'cancel' ? 'CANCELLED' : 'RECONCILED'; run.reconciliation = clean(args.reconciliation); await store.put('runs/' + run.id, run);
      }
      if (args.action === 'cancel') {
        for (const member of await store.list('tasks/')) if ((member.id === root.id || member.rootId === root.id) && !terminal.has(member.status)) {member.status = 'CANCELLED'; await store.save(member);}
        for (const run of await store.list('runs/')) if (run.rootId === root.id && run.status === 'RUNNING') {run.status = 'CANCEL_REQUESTED'; await store.put('runs/' + run.id, run);}
        for (const open of await store.list('decisions/')) if (open.id !== decision.id && open.status === 'OPEN' && open.type !== 'RESULT_UNKNOWN' && (await store.task(open.taskId).catch(() => null))?.rootId === root.id) {open.status = 'RESOLVED'; open.response = {action: 'family-cancelled'}; open.resolvedAt = stamp(); await store.put('decisions/' + open.id, open);}
      } else {
        requireValue(['BLOCKED', 'AWAITING_DECISION', 'WAITING_DEPENDENCIES'].includes(task.status), 'Task is not awaiting a decision');
        if (decision.type === 'EPOCH_REAUTHORIZE') {
          requireValue(config.enabled && config.authorization?.runtimeEpoch === metadata.runtimeEpoch && args.reconciliation?.status === 'INPUTS_REVALIDATED' && args.reconciliation?.evidenceRef, 'Fresh authority and exact input revalidation are required', 'ORCHESTRATION_RECONCILIATION_REQUIRED');
          for (const member of await store.list('tasks/')) if (member.rootId === root.id && !terminal.has(member.status)) {
            const prior = member.currentRunId && await store.get('runs/' + member.currentRunId);
            member.runtimeEpoch = metadata.runtimeEpoch; member.authorization = config.authorization; member.status = prior && heldRuns.has(prior.status) ? 'BLOCKED' : member.preRestoreStatus || 'READY'; member.blockReason = prior && heldRuns.has(prior.status) ? 'RESULT_UNKNOWN' : null; delete member.preRestoreStatus; await store.save(member);
          }
        } else if (decision.type === 'QA_LIMIT') {
          requireValue(Number.isSafeInteger(args.additionalRounds) && args.additionalRounds > 0, 'Explicit additional QA rounds required'); root.qaLimit += args.additionalRounds; root.status = 'REWORK_PENDING'; await store.save(root);
          const rework = {...structuredClone(root), id: id('task'), rootId: root.id, parentId: root.id, status: 'READY', currentRunId: null, dependencies: [], createdAt: stamp(), queuedSeq: config.lastEventSeq + 1, repairInstructions: root.lastQA}; await store.save(rework);
        } else {
          requireValue(task.runtimeEpoch === metadata.runtimeEpoch, 'Reauthorize restored task inputs first', 'ORCHESTRATION_EPOCH');
          if (decision.type === 'RESULT_UNKNOWN') requireValue(args.action === 'retry', 'Unknown output requires explicit retry after reconciliation');
          const prior = task.currentRunId ? await store.get('runs/' + task.currentRunId) : null;
          task.status = prior?.phase === 'FINALIZE' ? 'FINALIZING' : task.dependencies.length ? 'WAITING_DEPENDENCIES' : 'READY'; task.currentRunId = null; task.blockReason = null; await store.save(task);
        }
      }
    } else if (decision.type === 'SCHEDULER_BLOCKED') {
      requireValue(['resume', 'retry'].includes(args.action), 'Scheduler retry needs an explicit resume or retry decision');
      requireValue(config.scheduler.blocked?.decisionId === decision.id, 'A different scheduler decision is current'); config.scheduler.blocked = null;
    }
    decision.status = 'RESOLVED'; decision.response = clean(args); decision.resolvedAt = stamp(); await store.put('decisions/' + decision.id, decision); await store.event(config, 'DECISION_RESOLVED', {decisionId: decision.id, action: args.action}); output = {decision, config: clean(config)};
  } else if (['pause', 'resume', 'stop'].includes(input.command)) {
    only('MAIN'); requireValue(config.enabled, 'Mode has not been activated'); config.status = input.command === 'resume' ? 'ACTIVE' : input.command === 'pause' ? 'PAUSED' : (await store.list('runs/')).some(run => ['RUNNING', 'CANCEL_REQUESTED'].includes(run.status)) ? 'STOPPING' : 'STOPPED';
    await store.event(config, 'MODE_' + config.status, {}); output = {config: clean(config)};
  } else fail('ORCHESTRATION_INVALID', 'Unknown command');
  await saveConfig();
  await store.put(receiptKey, {requestHash, command: input.command, result: clean(output), recordedAt: stamp()});
  return output;
}
