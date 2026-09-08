/** Dedicated, writable-capable orchestration transport. The review Bridge stays read-only. */
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';

export class OrchestrationCodexError extends Error {
  constructor(code, message, details = {}) { super(message); this.code = code; Object.assign(this, details); }
}
const error = (code, message, details) => new OrchestrationCodexError(code, message, details);
const textOutput = (value, success = true) => ({ success, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] });
const nonempty = value => typeof value === 'string' && value.length > 0;

/** A single owned app-server, with one in-flight turn; separate workers use separate owners. */
export class OrchestrationCodex extends EventEmitter {
  constructor({ cwd, binary = 'codex', env = process.env, spawnImpl = spawn, requestTimeoutMs = 30000,
    maxProtocolBytes = 32 * 1024 * 1024, maxAnswerBytes = 1024 * 1024, onIntervention, config = [] } = {}) {
    super();
    if (!nonempty(cwd)) throw error('CODEX_CWD_REQUIRED', 'An explicit working directory is required');
    this.options = { cwd, binary, env, spawnImpl, requestTimeoutMs, maxProtocolBytes, maxAnswerBytes, config };
    this.onIntervention = onIntervention;
    this.pending = new Map(); this.sequence = 0; this.threads = new Map(); this.active = null;
    this.child = null; this.closed = false; this.fatal = null; this.serverCalls = new Set();
  }

  async start() {
    if (this.child || this.closed) throw error('CODEX_ALREADY_STARTED', 'An app-server owner cannot be reused');
    const args = ['app-server', '--listen', 'stdio://', '-c', 'features.multi_agent=false'];
    for (const value of this.options.config) args.push('-c', value);
    this.child = this.options.spawnImpl(this.options.binary, args, {
      cwd: this.options.cwd, env: this.options.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
    });
    let buffered = ''; const decoder = new StringDecoder('utf8');
    this.child.stdout.on('data', chunk => {
      buffered += decoder.write(chunk);
      if (Buffer.byteLength(buffered) > this.options.maxProtocolBytes) return this.fail(error('CODEX_PROTOCOL_LIMIT', 'Codex protocol line exceeded the limit'));
      let end;
      while ((end = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
        if (!line.trim()) continue;
        try { this.receive(JSON.parse(line)); }
        catch { this.fail(error('CODEX_PROTOCOL_INVALID', 'Codex emitted an invalid protocol message')); break; }
      }
    });
    // Drain diagnostic output without retaining credentials or prompt contents in host logs.
    this.child.stderr.on('data', () => {});
    this.child.stdin.on('error', () => this.fail(error('RESULT_UNKNOWN', 'Codex input channel closed; inspect the persisted turn before retrying')));
    this.child.once('error', () => this.fail(error('CODEX_UNAVAILABLE', 'The configured Codex executable could not be started')));
    this.child.once('exit', () => this.fail(error('RESULT_UNKNOWN', 'Codex exited; inspect the persisted turn before retrying')));
    try {
      const initialized = await this.request('initialize', {
        clientInfo: { name: 'story-review-orchestrator', title: 'Story Review Orchestrator', version: '1.0' },
        capabilities: { experimentalApi: true },
      });
      this.notify('initialized', {}); return initialized;
    } catch (failure) { await this.close(); throw failure; }
  }

  send(message) {
    if (this.fatal) throw this.fatal;
    if (!this.child || this.closed || this.child.stdin.destroyed) throw error('CODEX_CLOSED', 'Codex transport is closed');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  notify(method, params) { this.send({ method, params }); }
  request(method, params = {}, { timeoutMs = this.options.requestTimeoutMs } = {}) {
    if (this.fatal) return Promise.reject(this.fatal);
    const id = 'orchestration-' + (++this.sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(error(method === 'turn/start' ? 'RESULT_UNKNOWN' : 'CODEX_REQUEST_TIMEOUT', `Codex ${method} did not return a receipt`, { method, requestId: id }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (failure) { clearTimeout(timer); this.pending.delete(id); reject(failure); }
    });
  }

  receive(message) {
    if (Object.hasOwn(message, 'id') && !message.method) {
      const waiter = this.pending.get(String(message.id)); if (!waiter) return;
      this.pending.delete(String(message.id)); clearTimeout(waiter.timer);
      if (message.error) waiter.reject(error('CODEX_REQUEST_REJECTED', 'Codex rejected the request', { rpcCode: message.error.code }));
      else waiter.resolve(message.result);
      return;
    }
    if (Object.hasOwn(message, 'id') && message.method) {
      const call = this.handleServerRequest(message).catch(() => {}).finally(() => this.serverCalls.delete(call));
      this.serverCalls.add(call); return;
    }
    this.emit('notification', message);
    const active = this.active; if (!active) return;
    const p = message.params || {}; const turnId = p.turnId || p.turn?.id;
    if (p.threadId !== active.threadId || !turnId) return;
    // turn/start may emit tool requests and completion before returning its turn id.
    if (active.turnId && active.turnId !== turnId) return;
    if (!active.turnId) active.turnId = turnId;
    if (message.method === 'item/agentMessage/delta' && typeof p.delta === 'string') {
      const id = p.itemId || 'answer'; active.deltas.set(id, (active.deltas.get(id) || '') + p.delta);
      active.answerBytes += Buffer.byteLength(p.delta);
      if (active.answerBytes > this.options.maxAnswerBytes) this.finish(error('CODEX_OUTPUT_LIMIT', 'Codex answer exceeded the limit'));
    } else if (message.method === 'item/completed') {
      const item = p.item || {};
      // Retain evidence of actual tool observation, but never giant tool output payloads.
      active.items.push({ id: item.id, type: item.type, status: item.status, tool: item.tool, path: item.path });
      if (active.items.length > 5000) return this.finish(error('CODEX_OUTPUT_LIMIT', 'Too many Codex items in one turn'));
      if (item.type === 'agentMessage' && typeof item.text === 'string') {
        if (Buffer.byteLength(item.text) > this.options.maxAnswerBytes) return this.finish(error('CODEX_OUTPUT_LIMIT', 'Codex answer exceeded the limit'));
        active.messages.set(item.id || 'answer', item.text);
      }
    } else if (message.method === 'error') {
      const info = p.error?.codexErrorInfo;
      const code = typeof info === 'string' ? info : info && Object.keys(info)[0];
      const failure = error(code === 'usageLimitExceeded' || code === 'sessionBudgetExceeded' ? 'MODEL_CREDIT_ERROR'
        : code === 'rateLimitExceeded' ? 'MODEL_RATE_LIMIT' : code === 'unauthorized' ? 'MODEL_AUTH_ERROR'
          : /responseStream|httpConnection/.test(code || '') ? 'RESULT_UNKNOWN' : 'MODEL_CALL_ERROR',
      'The model call failed; user decision is required before another call', { providerCode: code || 'UNKNOWN', willRetry: p.willRetry === true });
      this.finish(failure);
      // Interrupt even a server-declared retry: the application never retries a failed model call.
      this.request('turn/interrupt', { threadId: active.threadId, turnId }).catch(() => {});
    } else if (message.method === 'turn/completed') {
      if (p.turn.status !== 'completed') return this.finish(error(p.turn.status === 'interrupted' ? 'CODEX_TURN_INTERRUPTED' : 'MODEL_CALL_ERROR', 'Codex did not complete this turn'));
      this.finish(null, { threadId: active.threadId, turnId, status: 'completed',
        finalResponse: [...active.messages.values()].at(-1) || [...active.deltas.values()].at(-1) || '', items: active.items });
    }
  }

  async handleServerRequest(message) {
    const { id, method, params = {} } = message;
    const active = this.active;
    const bound = active && !active.settled && params.threadId === active.threadId && nonempty(params.turnId)
      && (!active.turnId || params.turnId === active.turnId);
    const reply = payload => { try { this.send({ id, result: payload }); } catch {} };
    if (method === 'item/tool/call') {
      if (!bound || !active.handlers.has(params.tool) || params.namespace) {
        reply(textOutput({ error: 'ORCHESTRATION_TOOL_SCOPE', message: 'This tool is not authorized for the active role and turn' }, false)); return;
      }
      if (!active.turnId) active.turnId = params.turnId;
      try {
        const argumentsValue = typeof params.arguments === 'string' ? JSON.parse(params.arguments) : params.arguments;
        const result = await active.handlers.get(params.tool)(argumentsValue, { threadId: params.threadId, turnId: params.turnId, callId: params.callId });
        reply(result?.contentItems ? result : textOutput(result));
      } catch (failure) {
        reply(textOutput({ error: failure.code || 'ORCHESTRATION_TOOL_REJECTED', message: 'The controlled tool rejected the request; report the failure without bypassing it' }, false));
      }
      return;
    }
    // No background role impersonates the user or approves a new permission request.
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') reply({ decision: 'cancel' });
    else if (method === 'item/tool/requestUserInput' || method === 'tool/requestUserInput') reply({ answers: {} });
    else if (method === 'mcpServer/elicitation/request') reply({ action: 'decline', content: null });
    else { try { this.send({ id, error: { code: -32601, message: 'Unsupported background server request' } }); } catch {} }
    if (bound) {
      await this.onIntervention?.({ method, threadId: params.threadId, turnId: params.turnId,
        questions: params.questions, reason: params.reason, command: params.command, serverName: params.serverName });
      this.finish(error('USER_DECISION_REQUIRED', 'A tool requires a user response through MainAgent'));
      this.request('turn/interrupt', { threadId: params.threadId, turnId: params.turnId }).catch(() => {});
    }
  }

  finish(failure, result) {
    const active = this.active; if (!active || active.settled) return;
    active.settled = true; if (active.timer) clearTimeout(active.timer);
    failure ? active.reject(failure) : active.resolve(result);
  }
  fail(failure) {
    if (this.fatal) return;
    this.fatal = failure; this.finish(failure);
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(failure); }
    this.pending.clear();
  }

  async models() {
    const models = []; let cursor; const cursors = new Set();
    do {
      const page = await this.request('model/list', { includeHidden: false, limit: 100, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(page?.data)) throw error('CODEX_MODEL_CATALOG_INVALID', 'Codex returned an invalid model catalog');
      models.push(...page.data); cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw error('CODEX_MODEL_CATALOG_INVALID', 'Codex model pagination did not advance');
      cursors.add(cursor);
    } while (cursor);
    if (!models.length) throw error('CODEX_MODEL_UNAVAILABLE', 'No selectable model is available');
    return models;
  }
  async threadStart({ cwd = this.options.cwd, model, developerInstructions, tools = [], writable = false, writableRoots = [cwd] } = {}) {
    const response = await this.request('thread/start', { cwd, model, developerInstructions, dynamicTools: tools,
      sandbox: writable ? 'workspace-write' : 'read-only', approvalPolicy: 'never', ephemeral: false,
      allowProviderModelFallback: false, serviceName: 'story-review-orchestrator', config: { 'features.multi_agent': false } });
    const id = response?.thread?.id;
    if (!nonempty(id)) throw error('CODEX_THREAD_INVALID', 'Codex did not return a thread identity');
    this.threads.set(id, { cwd, writable, writableRoots, model: response.model || model, tools });
    return { id, model: response.model || model, instructionSources: response.instructionSources || [] };
  }
  async threadResume(threadId, { cwd = this.options.cwd, model, developerInstructions, tools = [], writable = false, writableRoots = [cwd] } = {}) {
    const response = await this.request('thread/resume', { threadId, cwd, model, developerInstructions,
      sandbox: writable ? 'workspace-write' : 'read-only', approvalPolicy: 'never', excludeTurns: true,
      config: { 'features.multi_agent': false } });
    if (response?.thread?.id !== threadId) throw error('CODEX_THREAD_INVALID', 'Resumed Codex identity differs');
    this.threads.set(threadId, { cwd, writable, writableRoots, model: response.model || model, tools });
    return { id: threadId, model: response.model || model, instructionSources: response.instructionSources || [] };
  }
  async threadRead(threadId) { return this.request('thread/read', { threadId, includeTurns: true }); }

  interruptActive(code = 'USER_DECISION_REQUIRED') {
    const active = this.active;
    if (!active) return;
    this.finish(error(code, 'The active role requires a user decision before continuing'));
    if (active.turnId) this.request('turn/interrupt', { threadId: active.threadId, turnId: active.turnId }).catch(() => {});
  }

  async runTurn(threadId, prompt, { model, effort, outputSchema, handlers = {}, onStarted, timeoutMs = 60 * 60 * 1000 } = {}) {
    if (this.active) throw error('CODEX_TURN_BUSY', 'A worker cannot overlap its own turns');
    const thread = this.threads.get(threadId);
    if (!thread) throw error('CODEX_THREAD_UNBOUND', 'The thread is not owned by this adapter');
    let active;
    const finished = new Promise((resolve, reject) => {
      active = { threadId, turnId: null, resolve, reject, settled: false, messages: new Map(), deltas: new Map(), items: [], answerBytes: 0,
        handlers: new Map(Object.entries(handlers).filter(([name]) => thread.tools.some(tool => tool.name === name))) };
    });
    // Early protocol failures must have a rejection observer before turn/start returns.
    finished.catch(() => {}); this.active = active;
    active.timer = setTimeout(() => {
      this.finish(error('RESULT_UNKNOWN', 'The model turn timed out; inspect its persisted result before another call'));
      if (active.turnId) this.request('turn/interrupt', { threadId, turnId: active.turnId }).catch(() => {});
    }, timeoutMs);
    try {
      const response = await this.request('turn/start', { threadId, input: typeof prompt === 'string' ? [{ type: 'text', text: prompt }] : prompt,
        cwd: thread.cwd, model, effort, approvalPolicy: 'never',
        sandboxPolicy: thread.writable ? { type: 'workspaceWrite', writableRoots: thread.writableRoots, networkAccess: true } : { type: 'readOnly', networkAccess: true },
        ...(outputSchema ? { outputSchema } : {}) });
      const turnId = response?.turn?.id;
      if (!nonempty(turnId) || active.turnId && turnId !== active.turnId) throw error('CODEX_TURN_INVALID', 'Codex turn identity differs from its events');
      active.turnId = turnId;
      await onStarted?.({ threadId, turnId, model: model || thread.model, effort });
      return await finished;
    } catch (failure) {
      // A missing turn/start receipt can hide a live turn. Poison this owner instead of reusing it.
      this.finish(failure);
      throw failure;
    } finally {
      clearTimeout(active.timer);
      // Handler completion is part of the execution receipt, not abandoned background work.
      await Promise.allSettled([...this.serverCalls]);
      this.active = null;
    }
  }

  async close() {
    if (this.closed) return true;
    this.closed = true; this.fail(error('CODEX_CLOSED', 'Owned Codex runtime closed'));
    const child = this.child; if (!child) return true;
    const groupOwned = process.platform !== 'win32' && this.options.spawnImpl === spawn && Number.isInteger(child.pid);
    const signal = name => {
      if (groupOwned) { try { process.kill(-child.pid, name); } catch (failure) { if (failure.code !== 'ESRCH') throw failure; } }
      else child.kill(name);
    };
    const groupAlive = () => { if (!groupOwned) return false; try { process.kill(-child.pid, 0); return true; } catch (failure) { return failure.code !== 'ESRCH'; } };
    if (child.exitCode !== null || child.signalCode) { if (groupAlive()) signal('SIGKILL'); return !groupAlive(); }
    let exited = false; const exit = new Promise(resolve => child.once('exit', () => { exited = true; resolve(); }));
    signal('SIGTERM');
    let timer;
    await Promise.race([exit, new Promise(resolve => { timer = setTimeout(resolve, 2000); })]); clearTimeout(timer);
    if (!exited) {
      signal('SIGKILL');
      await Promise.race([exit, new Promise(resolve => { timer = setTimeout(resolve, 2000); })]); clearTimeout(timer);
    }
    if (groupAlive()) signal('SIGKILL');
    return exited && !groupAlive();
  }
}

export function validateModelChoice(models, choice) {
  const item = models.find(row => row.model === choice?.model || row.id === choice?.model);
  if (!item) throw error('CODEX_MODEL_UNAVAILABLE', 'The chosen model is not in the live catalog');
  const efforts = (item.supportedReasoningEfforts || []).map(row => row.reasoningEffort);
  const effort = choice.effort || item.defaultReasoningEffort;
  if (!nonempty(effort) || efforts.length && !efforts.includes(effort)) throw error('CODEX_EFFORT_UNAVAILABLE', 'The selected model does not advertise that reasoning effort');
  return { model: item.model || item.id, effort };
}
