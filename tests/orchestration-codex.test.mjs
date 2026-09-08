import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { OrchestrationCodex, validateModelChoice } from '../host/orchestration-codex.mjs';

const model = { id: 'model-test', model: 'model-test', isDefault: true, defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'medium' }] };
function server(override = () => {}) {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
  child.kill = signal => { if (child.exitCode === null) { child.exitCode = 0; child.signalCode = signal; queueMicrotask(() => child.emit('exit', 0, signal)); } };
  const requests = [], results = [];
  const send = message => child.stdout.write(JSON.stringify(message) + '\n');
  let buffer = '';
  child.stdin.on('data', chunk => {
    buffer += chunk; let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
      if (!message.method) { results.push(message); continue; }
      requests.push(message);
      if (override(message, { send, child, requests, results }) === true) continue;
      const response = message.method === 'initialize' ? { userAgent: 'mock' } : message.method === 'model/list' ? { data: [model], nextCursor: null }
        : message.method === 'thread/start' || message.method === 'thread/resume' ? { thread: { id: message.params.threadId || 'thread-one' }, model: 'model-test' }
          : message.method === 'thread/read' ? { thread: { id: message.params.threadId, turns: [] } } : {};
      if (message.id) queueMicrotask(() => send({ id: message.id, result: response }));
    }
  });
  const adapter = new OrchestrationCodex({ cwd: '/mock/project', spawnImpl: () => child, requestTimeoutMs: 1000 });
  return { adapter, child, send, requests, results };
}
const complete = (send, text, id = 'turn-one') => {
  send({ method: 'item/completed', params: { threadId: 'thread-one', turnId: id, item: { id: 'answer', type: 'agentMessage', text } } });
  send({ method: 'turn/completed', params: { threadId: 'thread-one', turn: { id, status: 'completed' } } });
};

test('initialization/model catalog is inference-free and writable thread is distinct from read-only Bridge', async () => {
  const mock = server(); await mock.adapter.start();
  assert.deepEqual(await mock.adapter.models(), [model]);
  await mock.adapter.threadStart({ model: 'model-test', writable: true });
  const args = mock.requests.find(row => row.method === 'thread/start').params;
  assert.equal(args.sandbox, 'workspace-write'); assert.equal(args.approvalPolicy, 'never'); assert.equal(args.allowProviderModelFallback, false);
  assert.equal(mock.requests.some(row => /account\/rate|turn\/start/.test(row.method)), false);
  assert.equal(await mock.adapter.close(), true);
});

test('early UTF-8 events, interleaved tool calls and exact turn binding preserve the result', async () => {
  const mock = server((message, { send }) => {
    if (message.method !== 'turn/start') return;
    send({ id: 'dynamic-one', method: 'item/tool/call', params: { threadId: 'thread-one', turnId: 'turn-one', callId: 'call-one', tool: 'report_progress', arguments: { summary: '正在核验' } } });
    complete(send, '{"summary":"独立线程完成"}');
    setTimeout(() => send({ id: message.id, result: { turn: { id: 'turn-one' } } }), 10); return true;
  });
  await mock.adapter.start(); await mock.adapter.threadStart({ tools: [{ type: 'function', name: 'report_progress', description: 'Report', inputSchema: { type: 'object' } }] });
  const called = [], started = [];
  const result = await mock.adapter.runTurn('thread-one', 'Test', { handlers: { report_progress: async args => { called.push(args.summary); await new Promise(resolve => setTimeout(resolve, 20)); return { ok: true }; } }, onStarted: value => started.push(value) });
  assert.deepEqual(called, ['正在核验']); assert.equal(result.finalResponse, '{"summary":"独立线程完成"}');
  assert.equal(started[0].turnId, 'turn-one'); assert.equal(mock.results[0].result.success, true);
  await mock.adapter.close();
});

test('unregistered tool or a request from another thread cannot invoke a role capability', async () => {
  const mock = server((message, { send }) => {
    if (message.method !== 'turn/start') return;
    send({ id: 'forged', method: 'item/tool/call', params: { threadId: 'another-thread', turnId: 'turn-one', callId: 'foreign', tool: 'report_progress', arguments: {} } });
    send({ id: 'unknown', method: 'item/tool/call', params: { threadId: 'thread-one', turnId: 'turn-one', callId: 'bad', tool: 'not_registered', arguments: {} } });
    send({ id: message.id, result: { turn: { id: 'turn-one' } } }); complete(send, '{}'); return true;
  });
  await mock.adapter.start(); await mock.adapter.threadStart({ tools: [{ type: 'function', name: 'report_progress', description: 'Report', inputSchema: {} }] });
  let invoked = 0;
  await mock.adapter.runTurn('thread-one', 'Test', { handlers: { report_progress: () => invoked++, not_registered: () => invoked++ } });
  assert.equal(invoked, 0); assert.equal(mock.results.filter(row => row.result.success === false).length, 2);
  await mock.adapter.close();
});

test('quota notification blocks immediately and interrupts server retry without starting another call', async () => {
  const mock = server((message, { send }) => {
    if (message.method !== 'turn/start') return;
    send({ id: message.id, result: { turn: { id: 'turn-one' } } });
    send({ method: 'error', params: { threadId: 'thread-one', turnId: 'turn-one', willRetry: true, error: { message: 'Quota depleted', codexErrorInfo: 'usageLimitExceeded' } } }); return true;
  });
  await mock.adapter.start(); await mock.adapter.threadStart();
  await assert.rejects(mock.adapter.runTurn('thread-one', 'Test'), { code: 'MODEL_CREDIT_ERROR' });
  assert.equal(mock.requests.filter(row => row.method === 'turn/start').length, 1);
  assert.equal(mock.requests.filter(row => row.method === 'turn/interrupt').length, 1);
  await mock.adapter.close();
});

test('approval requests are declined and forwarded as a decision, never auto-approved', async () => {
  const mock = server((message, { send }) => {
    if (message.method !== 'turn/start') return;
    send({ id: message.id, result: { turn: { id: 'turn-one' } } });
    send({ id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-one', turnId: 'turn-one', command: 'outside scope', reason: 'additional access' } }); return true;
  });
  const decisions = []; mock.adapter.onIntervention = async value => decisions.push(value);
  await mock.adapter.start(); await mock.adapter.threadStart();
  await assert.rejects(mock.adapter.runTurn('thread-one', 'Test'), { code: 'USER_DECISION_REQUIRED' });
  assert.equal(decisions[0].reason, 'additional access'); assert.equal(mock.results[0].result.decision, 'cancel'); await mock.adapter.close();
});

test('a lost turn receipt is RESULT_UNKNOWN and no automatic turn retry occurs', async () => {
  const mock = server((message) => message.method === 'turn/start'); mock.adapter.options.requestTimeoutMs = 15;
  await mock.adapter.start(); await mock.adapter.threadStart();
  await assert.rejects(mock.adapter.runTurn('thread-one', 'Test'), { code: 'RESULT_UNKNOWN' });
  assert.equal(mock.requests.filter(row => row.method === 'turn/start').length, 1); await mock.adapter.close();
});

test('model selection validates the exact live model and its reasoning effort', () => {
  assert.deepEqual(validateModelChoice([model], { model: 'model-test', effort: 'high' }), { model: 'model-test', effort: 'high' });
  assert.throws(() => validateModelChoice([model], { model: 'invented' }), { code: 'CODEX_MODEL_UNAVAILABLE' });
  assert.throws(() => validateModelChoice([model], { model: 'model-test', effort: 'ultra' }), { code: 'CODEX_EFFORT_UNAVAILABLE' });
});
