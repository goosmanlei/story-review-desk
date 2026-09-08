import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { applicationRoot, instanceEnvironment, loadInstanceRuntime } from './instance-profile.mjs';
import { ensurePostgres } from './instance-postgres.mjs';
import { runMaintenanceProcess } from './instance-maintenance.mjs';
import { assertFrozenStart } from './instance-freeze-proof.mjs';
import { dockerHostPath } from '../host/instance-runtime/docker-path.mjs';
import {providerKeyEnvironment} from '../host/instance-runtime/provider-environment.mjs';

export async function publishStorageOwner(runtime, inspection, endpoint) {
  if (!inspection?.State?.Running || inspection.State.Paused || inspection.State.Restarting || !/^[a-f0-9]{64}$/.test(inspection.Id || '') || !/^sha256:[a-f0-9]{64}$/.test(inspection.Image || '')) throw new Error('New storage owner must be one running Docker container');
  const environment = Object.fromEntries((inspection.Config?.Env || []).map(value => { const index = value.indexOf('='); return [value.slice(0, index), value.slice(index + 1)]; }));
  if (environment.REVIEW_INSTANCE_ROOT !== '/instance' || environment.REVIEW_SQLITE_OWNER !== 'CONTAINER' || inspection.Config?.Labels?.['org.opencontainers.image.revision'] !== runtime.softwareCommit || endpoint.instanceId !== runtime.instanceId || endpoint.legacySourceFallback !== false) throw new Error('New storage owner runtime or software identity differs');
  if(runtime.bootstrap.schemaVersion==='2.0'&&(environment.REVIEW_DATABASE_BACKEND!=='postgres'||endpoint.storageMode!=='SINGLE_INSTANCE_POSTGRESQL'))throw new Error('PostgreSQL runtime backend differs from locator');
  for (const [name, destination] of [['instance.json', '/instance/instance.json'], ['data', '/instance/data'], ['media', '/instance/media']]) {
    const matches = (inspection.Mounts || []).filter(value => value.Destination === destination);
    if (matches.length !== 1 || matches[0].Type !== 'bind' || dockerHostPath(matches[0].Source) !== path.join(runtime.root, name)) throw new Error('New storage owner does not bind the exact instance');
  }
  if ((inspection.Mounts || []).some(value => value.Destination === '/app' || value.Destination.startsWith('/app/'))) throw new Error('Storage owner software must come from its immutable image');
  const owner = { schemaVersion: runtime.bootstrap.schemaVersion==='2.0'?'2.0':'1.0', ...(runtime.bootstrap.schemaVersion==='2.0'?{backend:'postgres',database:runtime.bootstrap.database}:{}), instanceId: runtime.instanceId, mode: 'DOCKER', containerId: inspection.Id, containerRoot: '/instance', imageId: inspection.Image, softwareCommit: runtime.softwareCommit, hostRoot: runtime.root, composeProject:runtime.composeProject };
  const directory = path.join(runtime.root, 'runtime');
  if (!(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink()) throw new Error('Storage locator directory is unsafe');
  const temporary = path.join(directory, `.storage-owner-${process.pid}-${Date.now()}.json`);
  await writeFile(temporary, JSON.stringify(owner, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await rename(temporary, path.join(directory, 'storage-owner.json'));
  return owner;
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: applicationRoot, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(command + ' exited with ' + (signal || code || 'UNKNOWN'))));
  });
}

export async function startInstance(argv, { forceRecreate = false, noCache = false } = {}) {
  const { values } = parseArgs({ args: argv, options: { instance: { type: 'string' }, port: { type: 'string' }, check: { type: 'boolean' }, offline: { type: 'boolean' }, 'build-only': { type: 'boolean' }, 'no-build': { type: 'boolean' }, 'ca-file': { type: 'string' }, freeze: { type: 'string' } } });
  if (values['build-only'] && values['no-build']) throw new Error('--build-only and --no-build are mutually exclusive');
  // An explicit start also starts this instance's existing database owner before
  // loading its profile. PLAN_ONLY never starts a stopped database.
  const instancePath = values.instance || process.env.REVIEW_INSTANCE_ROOT;
  if (instancePath) await assertFrozenStart(instancePath,{freezeSha:values.freeze,port:values.port,softwareCommit:process.env.REVIEW_SOFTWARE_COMMIT});
  if (!values.check && instancePath) {
    const bootstrap = JSON.parse(await readFile(path.join(path.resolve(instancePath), 'instance.json'), 'utf8'));
    if (bootstrap.schemaVersion === '2.0') await ensurePostgres(instancePath);
  }
  const runtime = await loadInstanceRuntime(values.instance);
  const isPostgres=runtime.bootstrap.schemaVersion==='2.0';
  const keyEnvironment=providerKeyEnvironment(runtime.profile);
  let key = values.offline ? '' : String(process.env[keyEnvironment] || '').trim();
  const configuredKeyFile = process.env.REVIEW_OPENAI_API_KEY_FILE;
  if (!key && !values.offline && configuredKeyFile) {
    const info = await lstat(configuredKeyFile);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) || info.size > 65536) throw new Error('Provider secret must be a small private regular file');
    key = (await readFile(configuredKeyFile, 'utf8')).trim();
  }
  const aiEnabled = Boolean(key);
  const env = { ...process.env, ...instanceEnvironment(runtime, { port: values.port, aiEnabled }), OPENAI_API_KEY: '', [keyEnvironment]:'', REVIEW_OPENAI_API_KEY_FILE: '/dev/null' };
  const services = aiEnabled ? ['review-site', 'shot-production-worker', 'comment-polish-worker', 'material-review-worker'] : ['review-site', 'shot-production-worker'];
  const baseArgs = ['compose', '--project-name', runtime.composeProject, '--file', path.join(applicationRoot, 'compose.yaml')];
  if (aiEnabled) baseArgs.push('--profile', 'assistant-ai');
  if (values.check) {
    process.stdout.write(JSON.stringify({ mode: 'PLAN_ONLY', action: values['build-only'] ? 'BUILD_ONLY' : 'START', instanceId: runtime.instanceId, projectId: runtime.profile.projectId, releaseId: runtime.releaseId, repositoryRevision: runtime.repositoryRevision, instanceRoot: runtime.root, composeProject: runtime.composeProject, url: 'http://localhost:' + env.REVIEW_PORT, services, credentialsIncluded: false, parentProjectRequired: false }, null, 2) + '\n');
    return;
  }
  for (const directory of ['data', 'media', 'scratch', 'backups', 'runtime', 'runtime/locks', 'runtime/logs', 'runtime/assistant', 'runtime/assistant/public', 'runtime/private', 'runtime/private/provider']) {
    const destination = path.join(runtime.root, directory);
    try { const info = await lstat(destination); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Instance runtime path is not a safe directory'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; await mkdir(destination, { mode: 0o700 }); }
    if (!(await realpath(destination)).startsWith(runtime.root + path.sep)) throw new Error('Runtime path escapes instance');
  }
  const secretDirectory = await mkdtemp(path.join(runtime.root, 'runtime', '.compose-secret-'));
  await chmod(secretDirectory, 0o700);
  try {
    if(isPostgres){const pg=await ensurePostgres(runtime.root);const envPatch={REVIEW_DATABASE_BACKEND:'postgres',REVIEW_POSTGRES_HOST:'postgres',REVIEW_POSTGRES_PASSWORD_FILE:'/run/secrets/postgres-password'};const service={environment:envPatch,networks:['default','story-database'],volumes:[{type:'bind',source:path.join(runtime.root,'runtime/private/postgres-password'),target:'/run/secrets/postgres-password',read_only:true}]};const override=path.join(secretDirectory,'postgres.override.json');await writeFile(override,JSON.stringify({services:{'review-site':service,'shot-production-worker':service,'comment-polish-worker':service,'material-review-worker':service},networks:{'story-database':{external:true,name:pg.network}}}),{flag:'wx',mode:0o600});baseArgs.push('--file',override);}
    if (key) {
      // Local credentials are outside the business repository and excluded from backups.
      // A stable private mount also allows Docker's restart policy to work.
      const secretPath = path.join(runtime.root, 'runtime/private/provider/openai_api_key');
      const pendingSecret = path.join(secretDirectory, 'openai_api_key');
      await writeFile(pendingSecret, key, { flag: 'wx', mode: 0o600 });
      await rename(pendingSecret, secretPath);
      env.REVIEW_OPENAI_API_KEY_FILE = secretPath;
      key = '';
    }
    if (values['ca-file'] && aiEnabled) {
      const ca = await realpath(values['ca-file']);
      if (!(await lstat(ca)).isFile()) throw new Error('Configured CA must be a regular file');
      const service = { environment: { NODE_EXTRA_CA_CERTS: '/run/certs/provider-ca.pem' }, volumes: [{ type: 'bind', source: ca, target: '/run/certs/provider-ca.pem', read_only: true, bind: { create_host_path: false } }] };
      const override = path.join(secretDirectory, 'ca.override.json');
      await writeFile(override, JSON.stringify({ services: { 'comment-polish-worker': service, 'material-review-worker': service } }), { flag: 'wx', mode: 0o600 });
      baseArgs.push('--file', override);
    }
    await assertFrozenStart(runtime.root,{freezeSha:values.freeze,port:env.REVIEW_PORT,softwareCommit:runtime.softwareCommit});
    if (!aiEnabled && !values['build-only']) await run('docker', [...baseArgs, '--profile', 'assistant-ai', 'stop', 'comment-polish-worker', 'material-review-worker'], env);
    if (!values['no-build']) await run('docker', [...baseArgs, 'build', ...(noCache ? ['--no-cache'] : []), ...services], env);
    if (values['build-only']) {
      process.stdout.write(JSON.stringify({ status: 'BUILT_NOT_STARTED', instanceId: runtime.instanceId, composeProject: runtime.composeProject, softwareCommit: runtime.softwareCommit, services, containersStarted: false, containersStopped: false, modelCalls: 0 }, null, 2) + '\n');
      return;
    }
    await assertFrozenStart(runtime.root,{freezeSha:values.freeze,port:env.REVIEW_PORT,softwareCommit:runtime.softwareCommit});
    await run('docker', [...baseArgs, 'up', '-d', ...(forceRecreate || aiEnabled ? ['--force-recreate'] : []), '--wait', '--wait-timeout', '120', ...services], env);
    const response = await fetch('http://127.0.0.1:' + env.REVIEW_PORT + '/api/v8/snapshot');
    if (!response.ok) throw new Error('Deployed instance snapshot did not become healthy');
    const snapshot = await response.json();
    if (snapshot.instanceId !== runtime.instanceId && snapshot.instance?.instanceId !== runtime.instanceId) throw new Error('Runtime snapshot belongs to another instance');
    const containerId = (await runMaintenanceProcess('docker', [...baseArgs, 'ps', '-q', 'review-site'], { env })).stdout.trim();
    if (!containerId || containerId.includes('\n')) throw new Error('Expected exactly one web storage owner');
    const inspection = JSON.parse((await runMaintenanceProcess('docker', ['inspect', containerId], { env })).stdout)[0];
    const endpointResponse = await fetch('http://127.0.0.1:' + env.REVIEW_PORT + '/api/instance/runtime', { cache: 'no-store' });
    if (!endpointResponse.ok) throw new Error('New owner runtime identity cannot be read'); const endpoint = await endpointResponse.json();
    const database = JSON.parse((await runMaintenanceProcess('docker', ['exec', '-i', '-e', 'REVIEW_SQLITE_OWNER=CONTAINER', inspection.Id, 'node', '/app/host/instance-runtime/cli.mjs', 'host-profile', '--instance', '/instance'], { env })).stdout);
    for (const field of ['instanceId', 'releaseId', 'runtimeEpoch']) if (database[field] !== endpoint[field]) throw new Error('New owner endpoint differs from its database: ' + field);
    const owner = await publishStorageOwner(runtime, inspection, endpoint);
    const {startMaintenanceWorker}=await import('./instance-maintenance-worker.mjs');
    await startMaintenanceWorker(runtime.root,'http://127.0.0.1:'+env.REVIEW_PORT);
    const {startGitCheckpointWorker}=await import('./instance-git-checkpoint.mjs');
    const gitCheckpoint=await startGitCheckpointWorker(runtime.root);
    process.stdout.write(JSON.stringify({ gitCheckpoint,status: 'STARTED', instanceId: runtime.instanceId, url: 'http://localhost:' + env.REVIEW_PORT, backend: isPostgres ? 'postgres' : 'sqlite', storageOwner: owner.mode, ...(isPostgres ? {} : {sqliteOwner: owner.mode}), containerId: owner.containerId, assistantWorkers: aiEnabled ? 'ENABLED' : 'DISABLED_NO_KEY', bridge: 'HOST_START_REQUIRED' }, null, 2) + '\n');
  } finally {
    await rm(secretDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await startInstance(process.argv.slice(2));
