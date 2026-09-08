import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, readFile, readdir, stat, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { OrchestrationLedgerClient, OrchestrationRunner, acquireRunnerLock, privateDirectory,
  parseReport, prepareTaskWorkspace, gitArtifactSha256, WORKER_KINDS } from '../host/orchestration-runner.mjs';
import { readOrchestration, writeOrchestration } from '../host/instance-runtime/orchestration-service.mjs';
import { sha256 } from '../host/instance-runtime/bytes.mjs';
import { orchestrationCli } from '../scripts/instance-orchestration.mjs';

const exec = promisify(execFile);
const artifact = { ref: 'artifact:fixture-observed', sha256: 'a'.repeat(64) };
const model = { model: 'fixture-model', id: 'fixture-model', isDefault: true, defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t) {
  const projectRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'story-orchestration-test-')));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const instanceRoot = path.join(projectRoot, 'instance'); await mkdir(instanceRoot, { mode: 0o700 });
  const privateRoot = await privateDirectory(instanceRoot), instanceId = 'fixture-instance', runtimeEpoch = 'fixture-epoch';
  let rows = new Map(), revision = 0, chain = Promise.resolve(); const transportCalls = [];
  const tx = {
    getMetadata: async () => ({ instanceId, runtimeEpoch }),
    getAux: async (namespace, key) => rows.get(namespace + ':' + key),
    listAux: async (namespace, { prefix = '' }) => [...rows.values()].filter(row => row.namespace === namespace && row.key.startsWith(prefix)),
    putAux: async ({ namespace, key, bytes, expectedRevisionId }) => {
      assert.equal(expectedRevisionId, rows.get(namespace + ':' + key)?.revisionId || null);
      const row = { namespace, key, bytes: Buffer.from(bytes), revisionId: 'r-' + (++revision), sha256: sha256(bytes) }; rows.set(namespace + ':' + key, row); return row;
    },
  };
  const transport = (instance, args, { input }) => {
    assert.equal(instance, instanceRoot); transportCalls.push({ args, input });
    const operation = chain.then(async () => {
      const before = new Map(rows);
      try { return args[0] === 'orchestration-read' ? readOrchestration(tx, input) : await writeOrchestration(tx, input); }
      catch (failure) { rows = before; throw failure; }
    });
    chain = operation.catch(() => {}); return operation;
  };
  const ledger = new OrchestrationLedgerClient({ instanceRoot, runtimeEpoch, privateRoot, transport });
  const attached = await ledger.write('attach', { entryId: 'main-fixture' }); const main = { kind: 'MAIN', ...attached.main };
  await ledger.write('activate', { projectRoot, authorization: { source: 'isolated functional test', scope: 'fixture', automaticCompletion: true }, model: 'fixture-model', effort: 'high' }, main);
  const f = { projectRoot, instanceRoot, privateRoot, instanceId, runtimeEpoch, ledger, main, transportCalls, rows: () => [...rows.values()] };
  f.submit = async (kind = 'CREATIVE', fields = {}) => (await ledger.write('submit', { kind, title: 'Fixture task', goal: 'Observe a fixture', scope: 'fixture', acceptance: [{ id: 'observed', text: 'Actual fixture observed' }], inputs: [], ...fields }, main)).task;
  return f;
}

function mockCodex({ gate, failure, closeResult = true } = {}) {
  const threads = [], calls = []; let sequence = 0;
  const factory = options => {
    const adapter = {
      async start() {}, async close() { adapter.closed = true; return closeResult; }, async models() { return [model]; },
      async threadStart(settings) { const id = 'thread-' + (++sequence); threads.push({ id, settings, options }); adapter.id = id; return { id, model: 'fixture-model' }; },
      async threadResume(id, settings) { threads.push({ id, resumed: true, settings, options }); adapter.id = id; return { id }; },
      async threadRead(id) { calls.push({ type: 'read', id }); return { thread: { id, turns: [] } }; },
      async runTurn(threadId, prompt, settings = {}) {
        const turnId = 'turn-' + (++sequence);
        await settings.onStarted?.({ threadId, turnId, model: settings.model, effort: settings.effort });
        if (settings.outputSchema?.properties.model) { calls.push({ type: 'selection', threadId }); return { finalResponse: JSON.stringify({ model: 'fixture-model', effort: 'high', rationale: 'Task accuracy' }) }; }
        if (!settings.outputSchema?.properties.status) { calls.push({ type: 'schedule', threadId }); return { finalResponse: '{"summary":"Dependencies checked"}' }; }
        const context = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1)); const { task, run } = context;
        calls.push({ type: 'execute', threadId, task, run });
        if (failure) { const code = failure(task, run); if (code) throw Object.assign(new Error(code), { code }); }
        if (gate) await gate(task, run);
        if (adapter.interrupted) throw Object.assign(new Error('Cancelled'), { code: adapter.interrupted });
        return { finalResponse: JSON.stringify({ status: run.phase === 'QA' ? 'PASS' : run.phase === 'FINALIZE' ? 'DELIVERED' : 'SUBMITTED', summary: 'Observed fixture complete',
          artifacts: run.phase === 'QA' ? [] : run.phase === 'FINALIZE' ? task.artifacts : [artifact],
          deliveryEvidence: run.phase === 'FINALIZE' ? [{ ref: 'receipt:fixture', sha256: 'b'.repeat(64) }] : [],
          checks: run.phase === 'QA' ? task.acceptance.map(item => ({ criterionId: item.id, status: 'PASS', comment: 'Observed actual fixture', evidenceRefs: [artifact.ref] })) : [],
          artifactHash: task.artifactHash, code: null }) };
      },
      interruptActive(code) { adapter.interrupted = code; },
    }; return adapter;
  };
  return { factory, threads, calls };
}
async function runnerFor(f, t, mock = mockCodex()) {
  const runner = new OrchestrationRunner({ ...f, codexFactory: mock.factory,
    workspaceFactory: async () => ({ cwd: f.projectRoot, worktree: null }), instructions: async () => 'Fixture role instructions', gitToolsFactory: () => ({ specs: [], handlers: {} }) });
  await runner.initialize();
  t.after(async () => { runner.shutdown(); await runner.schedulePromise; await runner.scheduleAdapter?.close(); await runner.lock.release(); });
  return { runner, mock };
}
async function settle(runner) { await Promise.all([...runner.active.values()].map(item => item.promise)); await runner.schedulePromise; }

test('CLI help is available before any project, database, authentication or model call', async () => {
  assert.match((await orchestrationCli(['--help'])).help, /--project ROOT --instance ROOT/);
});

test('role capabilities have private durable idempotency journals and never enter database reads', async t => {
  const f = await fixture(t);
  const files = await readdir(path.join(f.privateRoot, 'requests'));
  assert.equal(files.length, 2);
  for (const file of files) assert.equal((await stat(path.join(f.privateRoot, 'requests', file))).mode & 0o077, 0);
  const request = JSON.parse(await readFile(path.join(f.privateRoot, 'requests', files[0]), 'utf8'));
  assert.equal(request.status, 'CONFIRMED');
  assert.equal(JSON.stringify(await f.ledger.read()).includes(f.main.token), false);
  assert.equal(f.rows().some(row => row.bytes.includes(Buffer.from(f.main.token))), false);
});

test('same request recovery reuses the original capability and does not execute the mutation twice', async t => {
  const f = await fixture(t), requestId = randomUUID();
  const envelope = { schemaVersion: '1.0', requestId, runtimeEpoch: f.runtimeEpoch, command: 'attach', args: { entryId: 'main-fixture', capabilityToken: randomUUID() + randomUUID() } };
  const first = await f.ledger.write('attach', {}, undefined, { envelope });
  const count = f.transportCalls.length;
  assert.deepEqual(await f.ledger.write('attach', {}, undefined, { envelope }), first);
  assert.equal(f.transportCalls.length, count);
});

test('filesystem ownership rejects another live runner and permits exact stale recovery', async t => {
  const f = await fixture(t), first = await acquireRunnerLock(f.privateRoot, { instanceId: f.instanceId });
  await assert.rejects(acquireRunnerLock(f.privateRoot, { instanceId: f.instanceId }), { code: 'ORCHESTRATION_RUNNER_ACTIVE' });
  await first.release();
  const stale = await acquireRunnerLock(f.privateRoot, { instanceId: f.instanceId }, { pid: 999999 });
  const recovered = await acquireRunnerLock(f.privateRoot, { instanceId: f.instanceId }, { isAlive: () => false });
  assert.notEqual(recovered.owner.nonce, stale.owner.nonce);
  assert.equal(await stale.release(), false); assert.equal(await recovered.release(), true);
});

test('real ledger with simulated Codex executes author -> independent QA -> exact delivery for both domains', async t => {
  const f = await fixture(t), { runner, mock } = await runnerFor(f, t);
  const roots = [await f.submit('CREATIVE'), await f.submit('DEVELOP')];
  for (let round = 0; round < 4; round++) { await runner.pump(); await settle(runner); }
  for (const root of roots) assert.equal((await f.ledger.read('task', { taskId: root.id })).task.status, 'DONE');
  const executions = mock.calls.filter(item => item.type === 'execute'); assert.equal(executions.length, 6);
  assert.equal(new Set(executions.map(item => item.threadId)).size, 6, 'each author, QA and finalizer has independent context');
  assert.ok(executions.every(item => ['WORK', 'QA', 'FINALIZE'].includes(item.run.phase)));
  assert.equal(mock.calls.filter(item => item.type === 'selection').length, 6, 'workers actually select then use an available model');
  assert.equal(new Set(mock.calls.filter(item => item.type === 'schedule').map(item => item.threadId)).size, 1, 'ScheduleAgent identity persists');
});

test('all four pools can hold three independent workers concurrently and scale-down drains work', async t => {
  const f = await fixture(t); let release;
  const held = new Promise(resolve => { release = resolve; }); const { runner, mock } = await runnerFor(f, t, mockCodex({ gate: () => held }));
  // Prepare three QA tasks of each kind before adding their three author peers.
  for (const kind of ['CREATIVE', 'DEVELOP']) for (let i = 0; i < 3; i++) {
    const root = await f.submit(kind); const author = await f.ledger.write('claim', { kind, taskId: root.id, workerId: randomUUID() }, runner.scheduler);
    await f.ledger.write('report', { runId: author.run.id, result: { status: 'SUBMITTED', summary: 'Fixture candidate', artifacts: [artifact] } }, { kind: 'WORKER', id: author.run.workerId, token: author.run.token });
  }
  for (const kind of ['CREATIVE', 'DEVELOP']) for (let i = 0; i < 3; i++) await f.submit(kind);
  await runner.pump();
  for (let spin = 0; spin < 100 && mock.calls.filter(item => item.type === 'execute').length < 12; spin++) await sleep(5);
  assert.equal(runner.active.size, 12); assert.equal(mock.calls.filter(item => item.type === 'execute').length, 12);
  for (const kind of WORKER_KINDS) assert.equal(runner.observed.peak[kind], 3);
  await f.ledger.write('scale', { concurrency: { CREATIVE: 0, CREATIVE_QA: 0, DEVELOP: 0, DEVELOP_QA: 0 } }, f.main);
  await runner.pump(); assert.equal(runner.active.size, 12);
  release(); await settle(runner); assert.equal(runner.active.size, 0);
});

test('model credit error reports BLOCKED with no QA round consumed and no automatic retry', async t => {
  const f = await fixture(t), { runner, mock } = await runnerFor(f, t, mockCodex({ failure: () => 'MODEL_CREDIT_ERROR' }));
  const root = await f.submit(); await runner.pump(); await settle(runner); await runner.pump(); await settle(runner);
  const task = (await f.ledger.read('task', { taskId: root.id })).task;
  assert.equal(task.status, 'BLOCKED'); assert.equal(task.qaFailures, 0);
  assert.equal(mock.calls.filter(item => item.type === 'execute').length, 1);
  const decision = (await f.ledger.read()).decisions.find(item => item.type === 'MODEL_CREDIT_ERROR');
  assert.match(decision.summary, /四类 Worker 并发/);
});

test('an unconfirmed process close retains the lease and never releases a submitted result to QA', async t => {
  const f = await fixture(t), { runner } = await runnerFor(f, t, mockCodex({ closeResult: false }));
  const root = await f.submit('CREATIVE', { resources: ['object:held'] }); await runner.pump(); await settle(runner);
  const state = await f.ledger.read();
  assert.equal(state.runs.length, 1); assert.equal(state.runs[0].status, 'RESULT_UNKNOWN');
  assert.equal(state.counts.CREATIVE.running, 1); assert.equal(state.tasks.some(task => task.kind === 'CREATIVE_QA'), false);
  assert.equal((await f.ledger.read('task', { taskId: root.id })).task.blockReason, 'RESULT_UNKNOWN');
});

test('stop allows in-flight completion before STOPPED and launches no queued QA', async t => {
  const f = await fixture(t); let release;
  const held = new Promise(resolve => { release = resolve; }); const { runner } = await runnerFor(f, t, mockCodex({ gate: () => held }));
  await f.submit(); await runner.pump();
  await f.ledger.write('stop', {}, f.main); assert.equal((await f.ledger.read()).config.status, 'STOPPING');
  await runner.pump(); assert.equal(runner.shuttingDown, true);
  release(); await settle(runner); await f.ledger.write('tick', {}, runner.scheduler);
  assert.equal((await f.ledger.read()).config.status, 'STOPPED');
  assert.equal(runner.observed.started.CREATIVE_QA, 0);
});

test('cancellation retains the lease until its exact owned process is closed and reconciled', async t => {
  const f = await fixture(t); let release;
  const held = new Promise(resolve => { release = resolve; }); const { runner, mock } = await runnerFor(f, t, mockCodex({ gate: () => held }));
  const root = await f.submit(); await runner.pump();
  for (let i = 0; i < 100 && !mock.calls.some(item => item.type === 'execute'); i++) await sleep(5);
  const live = (await f.ledger.read()).runs[0];
  // Inject the ledger's post-decision state; this test covers the host's process acknowledgement.
  for (const row of f.rows()) if (row.key === 'runs/' + live.id || row.key === 'tasks/' + root.id) {
    const value = JSON.parse(row.bytes); value.status = row.key.startsWith('runs/') ? 'CANCEL_REQUESTED' : 'CANCELLED'; row.bytes = Buffer.from(JSON.stringify(value));
  }
  await runner.pump(); assert.equal((await f.ledger.read()).runs[0].status, 'CANCEL_REQUESTED');
  release(); await settle(runner);
  assert.equal((await f.ledger.read('task', { taskId: root.id })).task.status, 'CANCELLED');
  assert.equal((await f.ledger.read('task', { taskId: root.id })).runs[0].status, 'CANCELLED');
});

test('unrelated decisions cannot resume a scheduler blocked by its model provider', async t => {
  const f = await fixture(t), { runner } = await runnerFor(f, t);
  await f.submit();
  const blocked = await f.ledger.write('scheduler-blocked', { code: 'MODEL_CREDIT_ERROR', summary: 'Schedule model credit failure' }, runner.scheduler);
  runner.schedulerSuspended = true; runner.suspendedAfterEvent = (await f.ledger.read()).lastEventSeq;
  await f.ledger.write('scale', { concurrency: { CREATIVE: 0 } }, f.main); await runner.pump();
  assert.equal(runner.schedulerSuspended, true);
  await f.ledger.write('decision', { decisionId: blocked.decision.id, action: 'resume', comment: 'User resolved the actual credit failure' }, f.main);
  await runner.pump(); await settle(runner); assert.equal(runner.schedulerSuspended, false);
});

test('structured QA cannot pass unobserved/changed artifacts and delivery cannot omit receipts', () => {
  const task = { artifactHash: 'a'.repeat(64), acceptance: [{ id: 'one' }] };
  const report = { status: 'PASS', summary: 'Actual check', artifacts: [], checks: [{ criterionId: 'one', status: 'PASS', comment: 'Observed', evidenceRefs: ['artifact:one'] }], artifactHash: task.artifactHash };
  assert.equal(parseReport(JSON.stringify(report), { task, run: { phase: 'QA' } }).status, 'PASS');
  assert.throws(() => parseReport(JSON.stringify({ ...report, artifactHash: 'b'.repeat(64) }), { task, run: { phase: 'QA' } }), { code: 'ORCHESTRATION_ARTIFACT_DRIFT' });
  assert.throws(() => parseReport(JSON.stringify({ ...report, status: 'DELIVERED', artifacts: [artifact], deliveryEvidence: [] }), { task, run: { phase: 'FINALIZE' } }), { code: 'ORCHESTRATION_REPORT_INVALID' });
});

test('development worktrees preserve dirty source and QA starts at the exact submitted commit', async t => {
  const f = await fixture(t), repository = path.join(f.projectRoot, 'repository'); await mkdir(repository);
  await exec('git', ['init', repository]); await exec('git', ['-C', repository, 'config', 'user.name', 'Fixture']); await exec('git', ['-C', repository, 'config', 'user.email', 'fixture@example.invalid']);
  await writeFile(path.join(repository, 'source.txt'), 'base\n'); await exec('git', ['-C', repository, 'add', 'source.txt']); await exec('git', ['-C', repository, 'commit', '-m', 'Fixture base']);
  const baseCommit = (await exec('git', ['-C', repository, 'rev-parse', 'HEAD'])).stdout.trim();
  await writeFile(path.join(repository, 'source.txt'), 'user uncommitted work\n');
  const task = { kind: 'DEVELOP', execution: { repository, baseCommit } };
  const author = await prepareTaskWorkspace({ task, run: { id: 'author-one', phase: 'WORK' }, projectRoot: f.projectRoot, privateRoot: f.privateRoot });
  assert.equal(await readFile(path.join(author.cwd, 'source.txt'), 'utf8'), 'base\n');
  const qa = await prepareTaskWorkspace({ task: { ...task, kind: 'DEVELOP_QA', artifacts: [{ ref: 'git:' + baseCommit, sha256: await gitArtifactSha256(repository, baseCommit) }] }, run: { id: 'qa-one', phase: 'QA' }, projectRoot: f.projectRoot, privateRoot: f.privateRoot });
  assert.notEqual(author.cwd, qa.cwd); assert.equal((await exec('git', ['-C', qa.cwd, 'rev-parse', 'HEAD'])).stdout.trim(), baseCommit);
  assert.equal(await readFile(path.join(repository, 'source.txt'), 'utf8'), 'user uncommitted work\n');
});
