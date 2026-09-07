import { createHash } from 'node:crypto';
import { lstat, realpath, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const applicationRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const repositoryCli = path.join(applicationRoot, 'host', 'instance-runtime', 'cli.mjs');
import { runInstanceCli,resolveStorageOwner } from '../host/instance-runtime/transport.mjs';

export function instanceComposeProject(bootstrap,root) {
  const generation=bootstrap.schemaVersion==='2.0'?'\0postgres:'+bootstrap.database.volume:'';
  return 'review-'+bootstrap.instanceId.toLowerCase().replace(/[^a-z0-9_-]/g,'-').slice(0,32)+'-'+createHash('sha256').update(bootstrap.instanceId+'\0'+root+generation).digest('hex').slice(0,16);
}

export async function loadInstanceRuntime(instancePath = process.env.REVIEW_INSTANCE_ROOT) {
  if (!instancePath) throw new Error('REVIEW_INSTANCE_ROOT or --instance is required; no project-directory fallback exists');
  const root = await realpath(path.resolve(instancePath));
  const bootPath = path.join(root, 'instance.json');
  const info = await lstat(bootPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) throw new Error('Invalid instance bootstrap');
  const bootstrap = JSON.parse(await readFile(bootPath, 'utf8'));
  if (!['1.0','2.0'].includes(bootstrap.schemaVersion) || typeof bootstrap.instanceId !== 'string' || !bootstrap.instanceId) throw new Error('Invalid instance identity');
  let database;
  if(bootstrap.schemaVersion==='2.0'){
    if(bootstrap.database?.kind!=='postgres')throw new Error('Invalid PostgreSQL locator');
    database=bootstrap.database;
  }else{
    if(typeof bootstrap.database!=='string'||path.isAbsolute(bootstrap.database)||bootstrap.database.includes('\\')||bootstrap.database.split('/').some(x=>!x||x==='.'||x==='..'))throw new Error('Database must be instance-relative');
    database=path.resolve(root,bootstrap.database);if(!(await realpath(database)).startsWith(root+path.sep))throw new Error('Database escapes instance');
  }
  const exported = await runInstanceCli(root, ['host-profile'], { allowStoppedReadOnly: true });
  if (exported.instanceId !== bootstrap.instanceId || !exported.releaseId || !Number.isSafeInteger(exported.repositoryRevision) || !exported.profile?.projectId) throw new Error('Host profile is not bound to the current instance/release/revision');
  const assistant = exported.profile.assistant;
  if (!assistant || ['scopeKey', 'schedulerProtocol', 'conversationHashNamespace', 'archiveHashNamespace', 'contextMode'].some((key) => typeof assistant[key] !== 'string' || !assistant[key])) throw new Error('Incomplete assistant protocol configuration');
  const existingOwner=bootstrap.schemaVersion==='2.0'?await resolveStorageOwner(root,{allowStopped:true}):null;
  const composeProject=existingOwner?.composeProject||instanceComposeProject(bootstrap,root);
  if(!/^review-[a-z0-9_-]+$/.test(composeProject))throw new Error('Invalid instance Compose project identity');
  let softwareCommit = process.env.REVIEW_SOFTWARE_COMMIT || 'UNVERSIONED';
  if (!process.env.REVIEW_SOFTWARE_COMMIT) {
    try { softwareCommit = JSON.parse(await readFile(path.join(applicationRoot, 'software-manifest.json'), 'utf8')).softwareCommit || 'UNVERSIONED'; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (softwareCommit !== 'UNVERSIONED' && !/^[a-f0-9]{40,64}$/.test(softwareCommit)) throw new Error('Software commit must be a full commit SHA or UNVERSIONED');
  return { root, database, bootstrap, ...exported, softwareCommit, composeProject };
}

export function instanceEnvironment(runtime, { port = process.env.REVIEW_PORT || 3000, aiEnabled = false } = {}) {
  port = Number(port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Review port must be an integer from 1024 through 65535');
  return {
    REVIEW_INSTANCE_ROOT: runtime.root,
    REVIEW_SOFTWARE_COMMIT: runtime.softwareCommit,
    REVIEW_INSTANCE_ID: runtime.composeProject.slice('review-'.length),
    REVIEW_PROJECT_ID: runtime.profile.projectId,
    REVIEW_PORT: String(port),
    REVIEW_UID: String(process.getuid?.() ?? 1000),
    REVIEW_GID: String(process.getgid?.() ?? 1000),
    REVIEW_COMMENT_WORKER_URL: aiEnabled ? 'http://comment-polish-worker:8787' : '',
    REVIEW_MATERIAL_WORKER_URL: aiEnabled ? 'http://material-review-worker:8788' : '',
  };
}
