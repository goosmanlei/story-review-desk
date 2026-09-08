/** MainAgent's explicit project/instance control CLI. No web process or implicit instance fallback. */
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { loadInstanceRuntime, applicationRoot } from './instance-profile.mjs';
import { OrchestrationCodex } from '../host/orchestration-codex.mjs';
import { OrchestrationLedgerClient, OrchestrationRunner, privateDirectory, readPrivateJson, writePrivateJson,
  mainCredentialPath, inspectRunner, DEFAULT_CONCURRENCY } from '../host/orchestration-runner.mjs';

export const ORCHESTRATION_HELP = `Story Review Orchestrator 1.0
Usage: node scripts/instance-orchestration.mjs COMMAND --project ROOT --instance ROOT [options]

Commands:
  attach      Bind current MainAgent (--entry-id ID; --takeover only for explicit takeover).
  activate    Enable the mode with JSON authorization {source,scope,automaticCompletion:true}.
  start       Attach if necessary; start one detached ScheduleAgent runner. Does not invent authorization.
  submit      Submit a CREATIVE or DEVELOP task with exact scope, inputs and acceptance criteria.
  status      Read active tasks, queue counts, decisions and actual host runner status.
  list        Read task history; --after N --limit N --kind KIND --status STATUS.
  task        Read exact task/attempt/child evidence; --task-id ID.
  events      Read events; --after N --limit N; --wait-ms N waits up to 60000 ms.
  decision    Relay the actual user response {decisionId,action,comment,...}.
  scale       Apply a user concurrency decision {concurrency:{CREATIVE:3,...}}.
  pause       Stop new task claims and let active workers finish.
  resume      Resume an already activated queue; use start if the host runner is not running.
  stop        Stop new claims and let the host runner drain its active workers.
  doctor      Verify project binding, managed Skill and live model catalog without model inference.

Options:
  --input FILE|-       JSON command arguments, otherwise read JSON stdin when piped.
  --entry-id ID        Current MainAgent entry identity (or STORY_REVIEW_MAIN_ENTRY_ID).
  --model MODEL       Activation/start model inherited from MainAgent.
  --effort EFFORT      Activation/start effort inherited from MainAgent.
  --codex-binary PATH  Codex executable; defaults to codex.
  --takeover          Explicitly take over MainAgent ownership.
  --help              Show this versioned protocol help without accessing the instance.

Default worker concurrency: CREATIVE=3 CREATIVE_QA=3 DEVELOP=3 DEVELOP_QA=3.
All output is JSON. Role capabilities stay in owner-only instance runtime files.
`;

const error = (code, message) => Object.assign(new Error(message), { code });
const scrub = value => Array.isArray(value) ? value.map(scrub) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([key]) => !['token', 'capabilityToken', 'tokenHash'].includes(key)).map(([key, item]) => [key, scrub(item)])) : value;
const identity = value => { if (typeof value !== 'string' || !value.trim() || value.length > 150) throw error('ORCHESTRATION_MAIN_ENTRY_REQUIRED', 'Pass the current MainAgent --entry-id; use --takeover only after explicit user direction'); return value; };

export async function parseInput(filename, stream = process.stdin) {
  if (filename && filename !== '-') return JSON.parse(await readFile(path.resolve(filename), 'utf8'));
  if (!filename && stream.isTTY) return {};
  const chunks = []; let bytes = 0;
  for await (const chunk of stream) { bytes += chunk.length; if (bytes > 1024 * 1024) throw error('ORCHESTRATION_INPUT_LIMIT', 'Command JSON exceeds 1 MiB'); chunks.push(chunk); }
  const value = Buffer.concat(chunks).toString('utf8').trim(); return value ? JSON.parse(value) : {};
}

export async function loadControl({ project, instance, mutate = false }) {
  if (!project || !instance) throw error('ORCHESTRATION_BINDING_REQUIRED', 'Both --project and --instance are required');
  const projectRoot = await realpath(path.resolve(project));
  const runtime = await loadInstanceRuntime(instance);
  if (runtime.root === projectRoot || !runtime.root.startsWith(projectRoot + path.sep)) throw error('ORCHESTRATION_BINDING_MISMATCH', 'The explicitly selected instance must belong to the selected project directory');
  if (!runtime.runtimeEpoch) throw error('ORCHESTRATION_EPOCH_REQUIRED', 'The selected storage owner must provide a runtime epoch');
  const privateRoot = mutate ? await privateDirectory(runtime.root) : path.join(runtime.root, 'runtime', 'private', 'orchestration');
  return { projectRoot, instanceRoot: runtime.root, instanceId: runtime.instanceId, runtimeEpoch: runtime.runtimeEpoch, privateRoot, runtime,
    ledger: new OrchestrationLedgerClient({ instanceRoot: runtime.root, runtimeEpoch: runtime.runtimeEpoch, privateRoot }) };
}

async function verifyInstalledSkill(control) {
  const { verifyProjectSkill } = await import('./instance-skills.mjs');
  const result = await verifyProjectSkill({ project: control.projectRoot, software: applicationRoot });
  if (!result?.coreCommit) throw error('ORCHESTRATION_SKILL_UNVERIFIED', 'The installed Skill must match the pinned software package');
  return result;
}

export async function attachMain(control, entryId, takeover = false) {
  entryId = identity(entryId);
  const attached = await control.ledger.write('attach', { entryId, ...(takeover ? { takeover: true } : {}) });
  const main = { kind: 'MAIN', ...attached.main };
  await writePrivateJson(mainCredentialPath(control.privateRoot, entryId), {
    schemaVersion: '1.0', projectRoot: control.projectRoot, instanceId: control.instanceId, runtimeEpoch: control.runtimeEpoch, main,
  });
  return { main, config: attached.config };
}

export async function currentMain(control, entryId) {
  entryId = identity(entryId);
  const credentials = await readPrivateJson(mainCredentialPath(control.privateRoot, entryId), { optional: true });
  if (!credentials) throw error('ORCHESTRATION_MAIN_NOT_ATTACHED', 'Attach this MainAgent entry before mutating the queue');
  if (credentials.instanceId !== control.instanceId || credentials.projectRoot !== control.projectRoot || credentials.runtimeEpoch !== control.runtimeEpoch
    || credentials.main?.id !== entryId) throw error('ORCHESTRATION_MAIN_BINDING', 'Stored MainAgent capability belongs to another project or runtime epoch');
  return credentials.main;
}

export async function startDetached(control, entryId, { codexBinary = 'codex' } = {}) {
  const existing = await inspectRunner(control.privateRoot);
  if (existing.running) return { status: 'ALREADY_RUNNING', ...existing };
  const args = [fileURLToPath(import.meta.url), 'serve', '--project', control.projectRoot, '--instance', control.instanceRoot,
    '--entry-id', entryId, '--codex-binary', codexBinary];
  const child = spawn(process.execPath, args, { cwd: control.projectRoot, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: process.env });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (failure, result) => {
      if (settled) return; settled = true; clearTimeout(timer);
      child.removeAllListeners('message'); child.removeAllListeners('error'); child.removeAllListeners('exit');
      if (child.connected) child.disconnect(); child.unref(); failure ? reject(failure) : resolve(result);
    };
    const timer = setTimeout(() => finish(null, { status: 'STARTING', pid: child.pid, message: 'Runner is reconciling previous work; inspect status for the readiness receipt' }), 30000);
    child.on('message', message => {
      if (message?.status === 'RUNNING') finish(null, { status: 'RUNNING', pid: child.pid, instanceId: control.instanceId, concurrency: message.concurrency });
      else if (message?.status === 'BLOCKED') finish(error(message.error || 'ORCHESTRATION_START_FAILED', 'Background runner initialization failed; inspect status'));
    });
    child.once('error', () => finish(error('ORCHESTRATION_START_FAILED', 'The background Node process could not be started')));
    child.once('exit', () => finish(error('ORCHESTRATION_START_FAILED', 'The runner exited before its readiness receipt')));
  });
}

export async function orchestrationCli(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    project: { type: 'string' }, instance: { type: 'string' }, input: { type: 'string' }, 'entry-id': { type: 'string' },
    model: { type: 'string' }, effort: { type: 'string' }, 'codex-binary': { type: 'string' }, takeover: { type: 'boolean' }, help: { type: 'boolean' },
    'task-id': { type: 'string' }, after: { type: 'string' }, limit: { type: 'string' }, kind: { type: 'string' }, status: { type: 'string' }, 'wait-ms': { type: 'string' },
  } });
  if (values.help || positionals[0] === 'help') return { help: ORCHESTRATION_HELP };
  const command = positionals[0] || 'status';
  const commands = ['attach', 'activate', 'start', 'submit', 'status', 'list', 'task', 'events', 'decision', 'scale', 'pause', 'resume', 'stop', 'doctor', 'serve'];
  if (!commands.includes(command) || positionals.length > 1) throw error('ORCHESTRATION_COMMAND', 'Unknown command; use --help');
  const readOnly = ['status', 'list', 'task', 'events', 'doctor'].includes(command);
  const control = await loadControl({ ...values, mutate: !readOnly });
  const input = command === 'serve' ? {} : await parseInput(values.input);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw error('ORCHESTRATION_INPUT_INVALID', 'Command arguments must be a JSON object');
  const entryId = values['entry-id'] || input.entryId || process.env.STORY_REVIEW_MAIN_ENTRY_ID;
  if (['list', 'task', 'events', 'status'].includes(command)) {
    const fields = { ...input, ...(values['task-id'] ? { taskId: values['task-id'] } : {}),
      ...(values.after ? { after: Number(values.after) } : {}), ...(values.limit ? { limit: Number(values.limit) } : {}),
      ...(values.kind ? { kind: values.kind } : {}), ...(values.status ? { status: values.status } : {}) };
    let result = await control.ledger.read(command, fields);
    if (command === 'events' && values['wait-ms']) {
      const duration = Number(values['wait-ms']);
      if (!Number.isSafeInteger(duration) || duration < 0 || duration > 60000) throw error('ORCHESTRATION_WAIT_INVALID', '--wait-ms must be 0 through 60000');
      const end = Date.now() + duration;
      while (!result.events?.length && Date.now() < end) { await new Promise(resolve => setTimeout(resolve, Math.min(1000, end - Date.now()))); result = await control.ledger.read(command, fields); }
    }
    if (command === 'status') result.host = await inspectRunner(control.privateRoot);
    return scrub(result);
  }
  if (command === 'doctor') {
    const installedSkill = await verifyInstalledSkill(control);
    const adapter = new OrchestrationCodex({ cwd: control.projectRoot, binary: values['codex-binary'] || 'codex' });
    try {
      const initialized = await adapter.start(); const models = await adapter.models();
      return { status: 'ORCHESTRATION_CAPABILITIES_VERIFIED', instanceId: control.instanceId, projectId: control.runtime.profile.projectId,
        installedSkill, codex: initialized.userAgent || null, models: models.map(item => ({ model: item.model, efforts: item.supportedReasoningEfforts, inputModalities: item.inputModalities })),
        inferenceCalls: 0, creditPreflight: false, workerConcurrencyConfigured: DEFAULT_CONCURRENCY, actualWorkerConcurrency: 'UNKNOWN_UNTIL_TASKS_RUN', host: await inspectRunner(control.privateRoot) };
    } finally { await adapter.close(); }
  }
  if (command === 'attach') return scrub(await attachMain(control, entryId, values.takeover || input.takeover));
  let main;
  if (command === 'start') {
    await verifyInstalledSkill(control);
    try { main = await currentMain(control, entryId); }
    catch (failure) { if (failure.code !== 'ORCHESTRATION_MAIN_NOT_ATTACHED') throw failure; main = (await attachMain(control, entryId, values.takeover || input.takeover)).main; }
    if (values.takeover || input.takeover) main = (await attachMain(control, entryId, true)).main;
    const state = await control.ledger.read();
    if (input.authorization) await control.ledger.write('activate', { ...input, projectRoot: control.projectRoot, model: values.model || input.model, effort: values.effort || input.effort }, main);
    else if (!state.config?.enabled || state.config?.status !== 'ACTIVE') throw error('ORCHESTRATION_NOT_ACTIVATED', 'Activate with explicit authorization, or resume an already activated mode before start');
    return startDetached(control, identity(entryId), { codexBinary: values['codex-binary'] || 'codex' });
  }
  main = await currentMain(control, entryId);
  if (command === 'serve') {
    await verifyInstalledSkill(control);
    const runner = new OrchestrationRunner({ ...control, main, codexBinary: values['codex-binary'] || 'codex' });
    const stop = () => runner.shutdown(); process.on('SIGTERM', stop); process.on('SIGINT', stop);
    try {
      await runner.initialize();
      if (process.connected) { process.send({ status: 'RUNNING', concurrency: (await control.ledger.read()).concurrency }); process.disconnect(); }
      await runner.run(); return { status: 'STOPPED' };
    } finally { process.off('SIGTERM', stop); process.off('SIGINT', stop); }
  }
  if (command === 'activate') {
    await verifyInstalledSkill(control);
    return scrub(await control.ledger.write(command, { ...input, projectRoot: control.projectRoot, model: values.model || input.model, effort: values.effort || input.effort }, main));
  }
  return scrub(await control.ledger.write(command, input, main));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await orchestrationCli();
    process.stdout.write(result.help ? result.help : JSON.stringify(result) + '\n');
  } catch (failure) {
    const payload = { status: 'BLOCKED', error: failure.repositoryCode || failure.code || 'ORCHESTRATION_COMMAND_FAILED',
      message: 'Command did not complete. Inspect exact task/runner state and any pending user decision before retrying.' };
    if (process.connected) { process.send(payload); process.disconnect(); }
    process.stderr.write(JSON.stringify(payload) + '\n'); process.exitCode = 1;
  }
}
