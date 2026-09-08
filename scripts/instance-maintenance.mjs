import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const allowed = new Set(['instance-entity-migration.mjs','instance-material-directory.mjs','instance-production-preparation.mjs','instance-media-retirement.mjs','instance-guidance.mjs','instance-sources.mjs','instance-initialize.mjs','instance-relations.mjs','instance-authoring.mjs','instance-source.mjs', 'instance-extension.mjs', 'instance-configuration.mjs', 'instance-document.mjs', 'instance-backup.mjs', 'instance-copy.mjs', 'instance-restore.mjs', 'instance-export-hosted.mjs', 'instance-verify.mjs', 'instance-stage-media.mjs']);
const sha = value => createHash('sha256').update(value).digest('hex');
allowed.add('instance-episode-source.mjs');
allowed.add('instance-trial-worker.mjs');
const inContainer = () => process.platform === 'linux' && (process.env.REVIEW_SQLITE_OWNER === 'CONTAINER'||process.env.REVIEW_DATABASE_BACKEND==='postgres') && existsSync('/.dockerenv');
const json = value => JSON.stringify(value);
export function flagValue(argv, name) {
  const matches = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === name) matches.push(argv[index + 1]);
    else if (argv[index].startsWith(name + '=')) matches.push(argv[index].slice(name.length + 1));
  }
  if (matches.length > 1 || matches.some(value => !value || value.startsWith('--'))) throw new Error('Duplicate or invalid maintenance argument: ' + name);
  return matches[0];
}
export function replaceFlag(argv, name, value) {
  flagValue(argv, name); const result = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === name) { index++; continue; }
    if (argv[index].startsWith(name + '=')) continue;
    result.push(argv[index]);
  }
  result.push(name, value); return result;
}
export function runMaintenanceProcess(command, args, { input, maxBytes = 128 * 1024 * 1024, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env }); let stdout = ''; let stderr = ''; let size = 0; let failed = false;
    const stdoutDecoder = new StringDecoder('utf8'); const stderrDecoder = new StringDecoder('utf8');
    child.on('error', error => { failed = true; reject(error); });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') { failed = true; reject(error); } });
    child.stdout.on('data', value => { size += value.length; if (size > maxBytes) { failed = true; child.kill('SIGKILL'); reject(new Error('Maintenance output limit exceeded')); } else stdout += stdoutDecoder.write(value); });
    child.stderr.on('data', value => { stderr = (stderr + stderrDecoder.write(value)).slice(-64_000); });
    child.on('close', (code, signal) => { if (failed) return; stdout += stdoutDecoder.end(); stderr = (stderr + stderrDecoder.end()).slice(-64_000); if (code !== 0) reject(new Error(`Container maintenance failed (${code ?? signal}): ${stderr}`)); else resolve({ stdout, stderr }); });
    child.stdin.end(input);
  });
}
async function regularFile(filename) {
  const absolute = path.resolve(filename); const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Maintenance input must be a regular file');
  return await realpath(absolute);
}
async function originFromBackup(directory, run) {
  const root = await realpath(directory); let bytes;
  try { bytes = await readFile(path.join(root, 'storage-origin.json')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const { locatorSha256, ...origin } = JSON.parse(bytes);
  if (origin.schemaVersion !== '1.0' || origin.mode !== 'DOCKER' || !/^sha256:[a-f0-9]{64}$/.test(origin.imageId) || sha(json(origin)) !== locatorSha256) throw new Error('Backup storage origin is invalid');
  const inspected = JSON.parse((await run('docker', ['image', 'inspect', origin.imageId])).stdout)[0];
  if (inspected?.Id !== origin.imageId || (inspected.Config?.Labels?.['org.opencontainers.image.revision'] || 'UNVERSIONED') !== origin.softwareCommit) throw new Error('Backup software image is unavailable or differs from its exact origin');
  return { ...origin, owner: origin, hostRoot: root, containerRoot: '/instance', running: false, backupOnly: true };
}
async function prepareOutput(target) {
  const absolute = path.resolve(target); const parent = await realpath(path.dirname(absolute));
  if (parent !== path.dirname(absolute)) throw new Error('Maintenance output parent must be canonical');
  try { await lstat(absolute); throw new Error('Maintenance output must be a new path'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const staging = await mkdtemp(path.join(parent, '.instance-maintenance-'));
  return { target: absolute, staging, name: path.basename(absolute) };
}
function bind(source, target, readOnly = false) {
  if ([source, target].some(value => value.includes(',') || value.includes('\0'))) throw new Error('Unsupported Docker bind path');
  return ['--mount', `type=bind,source=${source},target=${target}${readOnly ? ',readonly' : ''}`];
}
async function writeBackupOrigin(target, owner) {
  const origin = { schemaVersion: '1.0', mode: 'DOCKER', imageId: owner.imageId, softwareCommit: owner.owner.softwareCommit, sourceInstanceId: owner.owner.instanceId };
  await writeFile(path.join(target, 'storage-origin.json'), json({ ...origin, locatorSha256: sha(json(origin)) }) + '\n', { flag: 'wx', mode: 0o600 });
}

/** A marker never authorizes a native SQLite fallback, including read-only work. */
export async function delegateInstanceMaintenance(script, argv, { resolveOwner, run = runMaintenanceProcess, emit = true } = {}) {
  if (!allowed.has(script)) throw new Error('Unsupported maintenance command');
  if (inContainer()) return false;
  const instance = flagValue(argv, '--instance') || process.env.REVIEW_INSTANCE_ROOT;
  if(instance){
    const boot=JSON.parse(await readFile(path.join(instance,'instance.json'),'utf8'));
    if(boot.schemaVersion==='2.0'){
      // Full backup/copy orchestration owns exact external output roots itself.
      if(['instance-backup.mjs','instance-copy.mjs'].includes(script))return false;
      if(script==='instance-export-hosted.mjs'){
        const output=flagValue(argv,'--output');if(!output)throw new Error('Explicit maintenance output is required');
        const item=await prepareOutput(output),containerTarget='/maintenance/output/'+item.name;
        try{
          const {runPostgresMaintenance}=await import('./instance-postgres.mjs');
          const forwarded=replaceFlag(replaceFlag(argv,'--instance','/instance'),'--output',containerTarget);
          const result=await runPostgresMaintenance(instance,['scripts/'+script,...forwarded],{readOnly:true,mounts:[{source:item.staging,target:'/maintenance/output'}]});
          const staged=path.join(item.staging,item.name);if(!(await lstat(staged)).isDirectory())throw new Error('Maintenance output was not created');
          try{await lstat(item.target);throw new Error('Maintenance target appeared during execution');}catch(error){if(error.code!=='ENOENT')throw error;}
          await rename(staged,item.target);const stdout=result.toString().split(containerTarget).join(item.target);if(emit)process.stdout.write(stdout);return {delegated:true,stdout,stderr:''};
        }finally{await rm(item.staging,{recursive:true,force:true});}
      }
      if(!['instance-source.mjs','instance-extension.mjs','instance-verify.mjs','instance-export-hosted.mjs'].includes(script)){
        const {runPostgresMaintenance}=await import('./instance-postgres.mjs');let forwarded=replaceFlag(argv,'--instance','/instance');const mounts=[];
        for(const name of ['--file','--manifest','--source']){const input=flagValue(argv,name);if(!input)continue;const source=await regularFile(input),target='/maintenance/input-'+mounts.length;mounts.push({source,target,readOnly:true});forwarded=replaceFlag(forwarded,name,target);}
        const stdout=(await runPostgresMaintenance(instance,['scripts/'+script,...forwarded],{mounts})).toString();if(emit)process.stdout.write(stdout);return {delegated:true,stdout,stderr:''};
      }
    }
  }
  const resolve = resolveOwner || (await import('../host/instance-runtime/transport.mjs')).resolveStorageOwner;
  let owner;
  if (script === 'instance-restore.mjs') {
    const backup = flagValue(argv, '--backup'); if (!backup) return false;
    owner = await originFromBackup(backup, run);
  } else {
    if (!instance) return false;
    // Native offline instances may use any safe bootstrap database path. Only
    // a real owner marker activates the stricter Docker transport contract.
    try { await lstat(path.join(await realpath(instance), 'runtime/storage-owner.json')); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    owner = await resolve(instance, { allowStopped: true });
  }
  if (!owner) return false;
  owner.readOnly = owner.readOnly || process.env.REVIEW_INSTANCE_READ_ONLY === '1' || process.env.REVIEW_REMOTE_READ_ONLY === '1';
  let command;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index].startsWith('--')) { if (!argv[index].includes('=')) index++; }
    else { command = argv[index]; break; }
  }
  if (['instance-source.mjs', 'instance-extension.mjs'].includes(script) && ['apply', 'resume'].includes(command) && !owner.running) throw new Error('Source apply/resume requires its verified running Docker owner');
  if (owner.readOnly && (script === 'instance-document.mjs' && command === 'put' || ['instance-source.mjs', 'instance-extension.mjs'].includes(script) && ['apply', 'resume'].includes(command) || script === 'instance-stage-media.mjs'||script==='instance-configuration.mjs'&&command==='initialize'||script==='instance-guidance.mjs'&&command==='apply')) throw new Error('The Docker instance is read-only');
  let forwarded = instance && !owner.backupOnly ? replaceFlag(argv, '--instance', '/instance') : [...argv];
  const inputs = []; const outputs = []; const mounts = [];
  const useExec = owner.running && ['instance-source.mjs', 'instance-extension.mjs', 'instance-configuration.mjs', 'instance-document.mjs', 'instance-guidance.mjs', 'instance-verify.mjs'].includes(script);
  try {
    for (const name of ['instance-source.mjs', 'instance-extension.mjs'].includes(script) ? ['--manifest'] : ['instance-document.mjs','instance-configuration.mjs','instance-guidance.mjs'].includes(script) ? ['--file'] : script === 'instance-stage-media.mjs' ? ['--source'] : []) {
      const filename = flagValue(argv, name); if (!filename) continue;
      const source = await regularFile(filename);
      if (useExec || ['instance-source.mjs', 'instance-extension.mjs', 'instance-configuration.mjs', 'instance-document.mjs', 'instance-guidance.mjs'].includes(script)) {
        const bytes = await readFile(source); if (bytes.length > 32 * 1024 * 1024) throw new Error('Maintenance inline input exceeds 32 MiB');
        inputs.push({ flag: name, bytesBase64: bytes.toString('base64'), sha256: sha(bytes) });
      } else { const target = `/maintenance/input-${mounts.length}`; mounts.push(...bind(source, target, true)); forwarded = replaceFlag(forwarded, name, target); }
    }
    if (script === 'instance-restore.mjs') { const source = await realpath(flagValue(argv, '--backup')); mounts.push(...bind(source, '/maintenance/backup', true)); forwarded = replaceFlag(forwarded, '--backup', '/maintenance/backup'); }
    for (const name of script === 'instance-copy.mjs' ? ['--backup', '--output'] : ['instance-backup.mjs', 'instance-restore.mjs', 'instance-export-hosted.mjs'].includes(script) ? ['--output'] : []) {
      const target = flagValue(argv, name); if (!target) throw new Error('Explicit maintenance output is required');
      const item = await prepareOutput(target); item.flag = name; item.containerParent = `/maintenance/output-${outputs.length}`; item.containerTarget = item.containerParent + '/' + item.name; outputs.push(item);
      mounts.push(...bind(item.staging, item.containerParent)); forwarded = replaceFlag(forwarded, name, item.containerTarget);
    }
    let requestedVerifyUrl;
    if (['instance-source.mjs', 'instance-extension.mjs'].includes(script) && ['apply', 'resume'].includes(command)) {
      const requested = new URL(flagValue(argv, '--url') || 'http://localhost:3000');
      if (requested.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(requested.hostname) || requested.username || requested.password) throw new Error('Source maintenance requires an explicit local runtime URL');
      const response = await fetch(new URL('/api/instance/runtime', requested), { cache: 'no-store', signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error('Requested source runtime is unavailable');
      const runtime = await response.json();
      const { runInstanceCli } = await import('../host/instance-runtime/transport.mjs');
      const current = await runInstanceCli(owner.hostRoot, ['host-profile'], { expectedOwnerHash: owner.markerSha256 });
      for (const field of ['instanceId', 'releaseId', 'runtimeEpoch']) if (runtime[field] !== current[field]) throw new Error('Requested source runtime differs from Docker authority: ' + field);
      forwarded = replaceFlag(forwarded, '--url', 'http://localhost:3000');
    }
    if (script === 'instance-verify.mjs') {
      requestedVerifyUrl = flagValue(argv, '--url'); const value = new URL(requestedVerifyUrl);
      if (value.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(value.hostname) || value.username || value.password) throw new Error('Instance verification requires an explicit local runtime URL');
      if (!owner.running) throw new Error('Runtime verification requires the running Docker owner');
      forwarded = replaceFlag(forwarded, '--url', 'http://localhost:3000');
    }
    const envelope = { schemaVersion: '1.0', script, argv: forwarded, inputs };
    let dockerArgs;
    if (useExec) dockerArgs = ['exec', '-i', '--env', 'REVIEW_SQLITE_OWNER=CONTAINER', '--env', 'REVIEW_INSTANCE_ROOT=/instance', '--env', 'REVIEW_INSTANCE_ID=' + owner.owner.instanceId, ...(owner.readOnly ? ['--env', 'REVIEW_INSTANCE_READ_ONLY=1'] : []), owner.containerId, 'node', '/app/scripts/instance-maintenance.mjs', 'dispatch'];
    else {
      dockerArgs = ['run', '--rm', '-i', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--network', owner.backend==='postgres'?(await import('./instance-postgres.mjs')).postgresNames(owner.owner.instanceId,owner.owner.database.volume).network:'none', '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, '--env', 'REVIEW_SQLITE_OWNER=CONTAINER', '--env', 'REVIEW_INSTANCE_ROOT=/instance', '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m'];
      if(owner.backend==='postgres')dockerArgs.push('--env','REVIEW_DATABASE_BACKEND=postgres','--env','REVIEW_POSTGRES_HOST=postgres','--env','REVIEW_POSTGRES_PASSWORD_FILE=/run/secrets/postgres-password',...bind(path.join(owner.hostRoot,'runtime/private/postgres-password'),'/run/secrets/postgres-password',true));
      if (owner.readOnly) dockerArgs.push('--env', 'REVIEW_INSTANCE_READ_ONLY=1');
      if (!owner.backupOnly) {
        for (const directory of ['scratch', 'backups', 'runtime/locks']) { const name = path.join(owner.hostRoot, directory); await mkdir(name, { recursive: true, mode: 0o700 }); if ((await lstat(name)).isSymbolicLink()) throw new Error('Unsafe instance maintenance directory'); }
        dockerArgs.push('--env', 'REVIEW_INSTANCE_ID=' + owner.owner.instanceId, ...bind(path.join(owner.hostRoot, 'instance.json'), '/instance/instance.json', true), ...bind(path.join(owner.hostRoot, 'data'), '/instance/data', owner.dataWritable !== true), ...bind(path.join(owner.hostRoot, 'media'), '/instance/media', script !== 'instance-stage-media.mjs'), ...bind(path.join(owner.hostRoot, 'scratch'), '/instance/scratch'), ...bind(path.join(owner.hostRoot, 'backups'), '/instance/backups'), ...bind(path.join(owner.hostRoot, 'runtime/locks'), '/instance/runtime/locks'));
      }
      dockerArgs.push(...mounts, owner.imageId, 'node', '/app/scripts/instance-maintenance.mjs', 'dispatch');
    }
    if (!owner.backupOnly) {
      const current = await resolve(owner.hostRoot, { allowStopped: true });
      if (current?.markerSha256 !== owner.markerSha256 || current?.containerId !== owner.containerId || current?.running !== owner.running) throw new Error('Storage owner changed during maintenance preparation; retry the explicit command');
    }
    const result = await run('docker', dockerArgs, { input: json(envelope) });
    for (const item of outputs) {
      const staged = path.join(item.staging, item.name); if (!(await lstat(staged)).isDirectory()) throw new Error('Maintenance output was not created');
      if (script === 'instance-backup.mjs' || script === 'instance-copy.mjs' && item.flag === '--backup') await writeBackupOrigin(staged, owner);
      try { await lstat(item.target); throw new Error('Maintenance target appeared during execution'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await rename(staged, item.target);
    }
    let stdout = result.stdout;
    for (const item of outputs) stdout = stdout.split(item.containerTarget).join(item.target);
    if (requestedVerifyUrl) {
      const proof = JSON.parse(stdout); const response = await fetch(new URL('/api/instance/runtime', requestedVerifyUrl), { cache: 'no-store', signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error('Requested host runtime URL is unavailable'); const runtime = await response.json();
      for (const field of ['instanceId', 'releaseId', 'runtimeEpoch', 'dataFingerprint', 'recipeFingerprint']) if (runtime[field] !== proof[field]) throw new Error('Requested host runtime URL differs from Docker authority: ' + field);
      stdout = json({ ...proof, url: requestedVerifyUrl, sqliteOwner: 'DOCKER' }) + '\n';
    }
    if (emit) { process.stdout.write(stdout); if (result.stderr) process.stderr.write(result.stderr); }
    return { delegated: true, stdout, stderr: result.stderr };
  } finally { for (const item of outputs) await rm(item.staging, { recursive: true, force: true }); }
}

async function dispatch() {
  if (!inContainer()) throw new Error('Maintenance dispatch only runs inside the Docker storage owner');
  const chunks = []; let length = 0; for await (const value of process.stdin) { length += value.length; if (length > 64 * 1024 * 1024) throw new Error('Maintenance envelope is too large'); chunks.push(value); }
  const envelope = JSON.parse(Buffer.concat(chunks));
  if (envelope.schemaVersion !== '1.0' || !allowed.has(envelope.script) || !Array.isArray(envelope.argv) || !envelope.argv.every(value => typeof value === 'string') || !Array.isArray(envelope.inputs)) throw new Error('Invalid maintenance envelope');
  const parent = process.env.REVIEW_INSTANCE_ROOT && envelope.script !== 'instance-restore.mjs' ? '/instance/scratch' : '/tmp';
  await mkdir(parent, { recursive: true }); const scratch = await mkdtemp(path.join(parent, 'maintenance-')); let argv = envelope.argv;
  try {
    for (const [index, item] of envelope.inputs.entries()) {
      if (!['--manifest', '--file'].includes(item.flag)) throw new Error('Unsupported maintenance inline input');
      const bytes = Buffer.from(item.bytesBase64, 'base64'); if (bytes.toString('base64') !== item.bytesBase64 || sha(bytes) !== item.sha256) throw new Error('Maintenance input checksum mismatch');
      const target = path.join(scratch, String(index)); await writeFile(target, bytes, { flag: 'wx', mode: 0o600 }); argv = replaceFlag(argv, item.flag, target);
    }
    await new Promise((resolve, reject) => { const child = spawn(process.execPath, ['/app/scripts/' + envelope.script, ...argv], { cwd: '/app', stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, REVIEW_SQLITE_OWNER: 'CONTAINER' } }); child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error('Maintenance command exited with ' + code))); });
    // Newly restored targets leave this VM only after their writer has exited
    // and every WAL frame has been incorporated into the main database.
    if (['instance-restore.mjs', 'instance-copy.mjs'].includes(envelope.script) && process.env.REVIEW_DATABASE_BACKEND!=='postgres') {
      const target = flagValue(argv, '--output'); const database = path.join(target, 'data/review.sqlite');
      const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(database);
      try {
        const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
        if (checkpoint.busy !== 0 || Object.values(db.prepare('PRAGMA integrity_check').get())[0] !== 'ok') throw new Error('Restored database cannot leave the storage VM before a clean checkpoint');
      } finally { db.close(); }
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv[2] !== 'dispatch') throw new Error('Use the explicit instance maintenance commands');
  await dispatch();
}
