import {constants} from 'node:fs';
import {lstat, realpath, mkdir, open, rename, unlink} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

// Only this small public heartbeat crosses the existing runtime/locks mount.
// No private runner files, PID namespace assumptions, credentials or transcripts.
async function heartbeatPath(root, create = false) {
  if (!root) return null;
  root = path.resolve(root);
  if (await realpath(root) !== root) throw new Error('Noncanonical instance root');
  for (const directory of [path.join(root,'runtime'), path.join(root,'runtime','locks')]) {
    if (create) await mkdir(directory, {mode:0o700}).catch(error => {if (error.code !== 'EEXIST') throw error;});
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid heartbeat directory');
  }
  return path.join(root,'runtime','locks','orchestration-health.json');
}
export async function readOrchestrationHeartbeat(root) {
  let handle;
  try {
    const file = await heartbeatPath(root); if (!file) return null;
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat(); if (!info.isFile() || info.size > 65536) return null;
    const value = JSON.parse(await handle.readFile('utf8'));
    if (value?.schemaVersion !== '1.0' || !['instanceId','runtimeEpoch','status','updatedAt'].every(key => typeof value[key] === 'string') || !Array.isArray(value.active)) return null;
    return value;
  } catch { return null; }
  finally { await handle?.close(); }
}
export async function writeOrchestrationHeartbeat(root, {instanceId, runtimeEpoch, status, active = []}) {
  const file = await heartbeatPath(root, true); if (!file) return;
  const temporary = file + '.' + randomUUID() + '.tmp';
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify({schemaVersion:'1.0', instanceId, runtimeEpoch, status,
      updatedAt:new Date().toISOString(), active:active.map(({kind, taskId, runId}) => ({kind, taskId, runId}))}));
    await handle.close(); await rename(temporary, file);
  } catch (error) {await handle.close().catch(() => {}); await unlink(temporary).catch(() => {}); throw error;}
}
