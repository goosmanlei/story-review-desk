import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { applicationRoot, loadInstanceRuntime } from './instance-profile.mjs';
import { resolveStorageOwner } from '../host/instance-runtime/transport.mjs';

const { values } = parseArgs({ options: { instance: { type: 'string' }, command: { type: 'string', default: 'serve' }, check: { type: 'boolean' }, model: { type: 'string' }, concurrency: { type: 'string', default: '1' }, 'codex-binary': { type: 'string' } } });
if (!['serve', 'doctor'].includes(values.command)) throw new Error('Bridge command must be serve or doctor');
const runtime = await loadInstanceRuntime(values.instance);
const concurrency = Number(values.concurrency);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('Concurrency must be 1 through 8');
if (values.check) {
  process.stdout.write(JSON.stringify({ mode: 'PLAN_ONLY', instanceId: runtime.instanceId, projectId: runtime.profile.projectId,
    releaseId: runtime.releaseId, capabilityProfile: 'READ_ONLY_ADVICE', contextMode: runtime.profile.assistant.contextMode,
    schedulerProtocol: runtime.profile.assistant.schedulerProtocol, conversationAuthority: 'INSTANCE_AUX_RECORDS', storageBackend: runtime.bootstrap.schemaVersion === '2.0' ? 'postgres' : 'sqlite', storageTransport: 'VERIFIED_OWNER_CLI', runtimeEpoch: runtime.runtimeEpoch, profileRevisionId: runtime.profileRevisionId,
    modelCalls: 0, requiresHostCodexLogin: true, concurrency }, null, 2) + '\n');
} else {
  // A stopped owner may supply startup metadata, but cannot serve Bridge work.
  await resolveStorageOwner(runtime.root);
  if (!runtime.runtimeEpoch || !runtime.profileRevisionId) throw new Error('Bridge requires an epoch-bound, release-bound runtime CLI');
  const args = ['run', path.join(applicationRoot, 'host/codex_conversation_bridge.py'), values.command, '--concurrency', String(concurrency)];
  if (values.model) args.push('--model', values.model);
  if (values['codex-binary']) args.push('--codex-bin', values['codex-binary']);
  const child = spawn(process.env.REVIEW_UV_BINARY || 'uv', args, { cwd: applicationRoot, stdio: 'inherit',
    env: { ...process.env, REVIEW_INSTANCE_ROOT: runtime.root, REVIEW_NODE_BINARY: process.execPath, PYTHONDONTWRITEBYTECODE: '1' } });
  child.once('error', (error) => { console.error(error.message); process.exitCode = 1; });
  child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
}
