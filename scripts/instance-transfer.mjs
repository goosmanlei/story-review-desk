import {isRestoredRuntime} from '../host/instance-runtime/execution-epoch.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, realpath, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import {postgresNames,ensurePostgres,runPostgresMaintenance} from './instance-postgres.mjs';
import { openInstanceRepository, resolveInstance, restoreInstanceRepository, canonicalJson, sha256 } from '../host/instance-runtime/index.mjs';
import { freezeRetirementBackup, validateRetirementBackupManifest } from '../host/instance-runtime/media-retirement-transfer.mjs';
import {writeArchiveFile,readArchiveFile,ARCHIVE_FILE_FORMAT} from '../host/instance-runtime/archive-file.mjs';

const relativePath = (value) => {
  if (typeof value !== 'string' || path.isAbsolute(value) || value.includes('\\') || value.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('Unsafe package relative path');
  return value;
};
async function digestFile(filename) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filename)) digest.update(chunk);
  return digest.digest('hex');
}
async function safeFile(root, relative) {
  const destination = path.join(root, relativePath(relative));
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Package files and parent directories may not be symlinks');
  }
  if (!(await lstat(destination)).isFile() || !(await realpath(destination)).startsWith(root + path.sep)) throw new Error('Package file is not a safe regular file');
  return destination;
}
async function verifyFile(root, file) {
  const filename = await safeFile(root, file.path);
  if ((await lstat(filename)).size !== file.bytes || await digestFile(filename) !== file.sha256) throw new Error('File size or SHA does not match the immutable registration: ' + file.path);
  return filename;
}
async function copyVerified(source, target, file) {
  const sourceFile = await verifyFile(source, file);
  const destination = path.join(target, file.path);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(sourceFile, destination, constants.COPYFILE_EXCL);
  await verifyFile(target, file);
}
async function newTarget(destination, source) {
  if (!destination) throw new Error('An explicit --output new directory is required');
  const target = path.resolve(destination);
  if (target === source || target.startsWith(source + path.sep)) throw new Error('Output must be outside the source instance/backup');
  await mkdir(target, { mode: 0o700 });
  return await realpath(target);
}
export async function backupInstance(instancePath, output) {
  const instance = resolveInstance(instancePath || process.env.REVIEW_INSTANCE_ROOT);
  if(instance.backend==='postgres')return backupPostgresInstance(instancePath,output);
  const target = await newTarget(output, instance.root);
  const repo = await openInstanceRepository(instance);
  const backup = await repo.backupTo(path.join(target, 'data/review.sqlite'));
  const copiedRepo = await openInstanceRepository({ dbPath: backup.path, instanceId: instance.instanceId, readOnly: true });
  const { validateArchive } = await import('../host/instance-runtime/postgres.mjs');
  let frozen;
  try { frozen = await freezeRetirementBackup(copiedRepo, instance.instanceId, validateArchive); }
  finally { await copiedRepo.close(); await repo.close(); }
  const view = frozen.metadata, media = frozen.media, mediaRetirement = frozen.mediaRetirement;
  const files = mediaRetirement.files;
  for (const file of files) await copyVerified(instance.root, target, file);
  await mkdir(path.join(target, 'media'), { recursive: true, mode: 0o700 });
  const body = { schemaVersion: '1.0', kind: 'REVIEW_INSTANCE_BACKUP', instanceId: instance.instanceId,
    releaseId: view.releaseId, repositoryRevision: view.repositoryRevision, createdAt: new Date().toISOString(),
    database: { path: 'data/review.sqlite', sha256: backup.sha256, bytes: (await lstat(backup.path)).size },
    media, files, mediaRetirement, runtimeIncluded: false, providerCredentialsIncluded: false,
    privateConversationHistoryIncluded: true };
  const manifest = { ...body, manifestSha256: sha256(canonicalJson(body)) };
  await writeFile(path.join(target, 'backup-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { status: 'BACKUP_VERIFIED', output: target, instanceId: instance.instanceId, releaseId: view.releaseId, mediaFiles: files.length,
    missingHistoricalVersions: media.filter((item) => item.availability !== 'PRESENT').length, manifestSha256: manifest.manifestSha256 };
}
export async function restoreInstance(backupPath, output) {
  if (!backupPath) throw new Error('--backup is required');
  const source = await realpath(backupPath);
  const manifest = JSON.parse(await readFile(await safeFile(source, 'backup-manifest.json'), 'utf8'));
  const { manifestSha256, ...body } = manifest;
  if(body.schemaVersion==='2.0')return restorePostgresBackup(source,output);
  if (body.kind !== 'REVIEW_INSTANCE_BACKUP' || body.schemaVersion !== '1.0' || sha256(canonicalJson(body)) !== manifestSha256) throw new Error('Invalid backup manifest');
  const database = await verifyFile(source, manifest.database);
  const repo = await openInstanceRepository({ dbPath: database, instanceId: manifest.instanceId, readOnly: true });
  let archive;
  try { await repo.integrityCheck(); archive = await repo.readTransaction(tx => tx.exportState()); }
  finally { await repo.close(); }
  const { validateArchive } = await import('../host/instance-runtime/postgres.mjs');
  validateArchive(archive, manifest.instanceId);
  await validateRetirementBackupManifest(archive, manifest);
  for (const file of manifest.files) await verifyFile(source, file);
  const target = await newTarget(output, source);
  for (const file of manifest.files) await copyVerified(source, target, file);
  await mkdir(path.join(target, 'media'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(target, 'runtime'), { mode: 0o700 });
  const restored = await restoreInstanceRepository({ backupPath: database, dbPath: path.join(target, 'data/review.sqlite'), instanceId: manifest.instanceId, expectedSha256: manifest.database.sha256 });
  const bootstrap = { schemaVersion: '1.0', instanceId: manifest.instanceId, database: 'data/review.sqlite' };
  await writeFile(path.join(target, 'instance.json'), JSON.stringify(bootstrap, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const view = await restored.readView();
  if(!isRestoredRuntime(view.runtimeEpoch))throw new Error('Restore did not fence old execution authorizations');
  return { status: 'RESTORED_VERIFIED', output: target, instanceId: view.instanceId, releaseId: view.releaseId,
    runtimeEpoch: view.runtimeEpoch, oldPendingRequests: 'INELIGIBLE_REQUIRES_RESULT_CHECK', productionAuthorization: 'OLD_REQUESTS_BLOCKED_NEW_AUTHORIZATION_REQUIRED', providerCredentialsRestored: false,
    mediaFiles: manifest.files.length, integrity: await restored.integrityCheck() };
}


export async function backupPostgresInstance(instancePath,output){
 const instance=resolveInstance(instancePath);
 if(instance.backend!=='postgres')throw new Error('PostgreSQL instance required');
 if(process.env.REVIEW_DATABASE_BACKEND!=='postgres'){
  const absolute=path.resolve(output),parent=await realpath(path.dirname(absolute));if(parent!==path.dirname(absolute))throw new Error('Backup parent must be canonical');
  const result=await runPostgresMaintenance(instance.root,['scripts/instance-pg-transfer.mjs','backup','--instance','/instance','--output','/export/'+path.basename(absolute)],{readOnly:true,nodeHeapMiB:4096,timeout:600000,mounts:[{source:parent,target:'/export',readOnly:false}]});
  return {...JSON.parse(result),output:absolute};
 }
 const repo=await openInstanceRepository(instance);
 const run=async()=>{
  const {validateArchive}=await import('../host/instance-runtime/postgres.mjs');
  // Archive, aux retirement heads and media registrations share ONE read-only snapshot.
  const frozen=await freezeRetirementBackup(repo,instance.instanceId,validateArchive);
  // Pending retirement fails before creating an output directory or reading media files.
  const target=await newTarget(output,instance.root);
  await mkdir(path.join(target,'data'),{mode:0o700});const archiveFile=await writeArchiveFile(path.join(target,'data/repository.jsonl'),frozen.archive);
  const media=frozen.media,mediaRetirement=frozen.mediaRetirement,files=mediaRetirement.files;for(const file of files)await copyVerified(instance.root,target,file);await mkdir(path.join(target,'media'),{recursive:true,mode:0o700});
  const body={schemaVersion:'2.0',kind:'REVIEW_INSTANCE_BACKUP',instanceId:instance.instanceId,releaseId:frozen.metadata.releaseId,repositoryRevision:frozen.metadata.repositoryRevision,createdAt:new Date().toISOString(),database:{path:'data/repository.jsonl',...archiveFile},media,files,mediaRetirement,runtimeIncluded:false,providerCredentialsIncluded:false,privateConversationHistoryIncluded:true};
  const manifest={...body,manifestSha256:sha256(canonicalJson(body))};await writeFile(path.join(target,'backup-manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
  return {status:'BACKUP_VERIFIED',backend:'postgres',output:target,instanceId:instance.instanceId,releaseId:body.releaseId,mediaFiles:files.length,missingHistoricalVersions:media.filter(r=>r.availability!=='PRESENT').length,manifestSha256:manifest.manifestSha256};
 };
 try{return await repo.withMediaReadLease(run);}finally{await repo.close();}
}
async function validatedBackup(source){
 const manifest=JSON.parse(await readFile(await safeFile(source,'backup-manifest.json'),'utf8')),{manifestSha256,...body}=manifest;
 if(body.kind!=='REVIEW_INSTANCE_BACKUP'||!['1.0','2.0'].includes(body.schemaVersion)||sha256(canonicalJson(body))!==manifestSha256)throw new Error('Invalid backup manifest');
 // Validate physical media only after recomputing the authority from this database/archive.
 const database=await verifyFile(source,manifest.database);return {manifest,database};
}
export async function verifyBackup(source){
 source=await realpath(source);const {manifest,database}=await validatedBackup(source);
 let archive;
 if(manifest.schemaVersion==='2.0')archive=await readArchiveFile(database,manifest.database.format);
 else {const repo=await openInstanceRepository({dbPath:database,instanceId:manifest.instanceId,readOnly:true});try{await repo.integrityCheck();archive=await repo.readTransaction(tx=>tx.exportState());}finally{await repo.close();}}
 const {validateArchive}=await import('../host/instance-runtime/postgres.mjs');validateArchive(archive,manifest.instanceId);
 await validateRetirementBackupManifest(archive,manifest);
 for(const file of manifest.files)await verifyFile(source,file);
 return {status:'BACKUP_VERIFIED',output:source,instanceId:manifest.instanceId,releaseId:manifest.releaseId,mediaFiles:manifest.files.length,manifestSha256:manifest.manifestSha256};
}
export async function restoreArchiveWithMedia(source,output,manifest,archive){
 const {validateArchive}=await import('../host/instance-runtime/postgres.mjs');validateArchive(archive,manifest.instanceId);
 await validateRetirementBackupManifest(archive,manifest);
 for(const file of manifest.files)await verifyFile(source,file);
 const target=await newTarget(output,source);for(const name of ['data','media','scratch','backups','runtime'])await mkdir(path.join(target,name),{mode:0o700});
 for(const file of manifest.files)await copyVerified(source,target,file);
 const storage=postgresNames(manifest.instanceId+randomUUID()),bootstrap={schemaVersion:'2.0',instanceId:manifest.instanceId,database:{kind:'postgres',database:'review',service:'postgres',volume:storage.volume}};
  await writeFile(path.join(target,'instance.json'),JSON.stringify(bootstrap,null,2)+'\n',{flag:'wx',mode:0o600});await writeArchiveFile(path.join(target,'scratch/restore-archive.jsonl'),archive);
  await ensurePostgres(target,{create:true});const outputBytes=await runPostgresMaintenance(target,['scripts/instance-pg-transfer.mjs','import','--instance','/instance','--file','/instance/scratch/restore-archive.jsonl','--format',ARCHIVE_FILE_FORMAT,'--output','/instance/data/restore-proof.json'],{nodeHeapMiB:4096,timeout:600000});
  const proof=JSON.parse(outputBytes);await unlink(path.join(target,'scratch/restore-archive.jsonl'));return {...proof,output:target,backend:'postgres',mediaFiles:manifest.files.length};
}
export async function restorePostgresBackup(source,output){
  const {manifest,database}=await validatedBackup(source);if(manifest.schemaVersion!=='2.0'||!['REVIEW_REPOSITORY_ARCHIVE_1',ARCHIVE_FILE_FORMAT].includes(manifest.database.format))throw new Error('PostgreSQL repository archive required');return restoreArchiveWithMedia(source,output,manifest,await readArchiveFile(database,manifest.database.format));
}
export async function migrateSQLiteBackup(backupPath,output){
 const source=await realpath(backupPath),{manifest,database}=await validatedBackup(source);if(manifest.schemaVersion!=='1.0')throw new Error('Frozen SQLite backup required');
 const repo=await openInstanceRepository({dbPath:database,instanceId:manifest.instanceId,readOnly:true});let archive;try{await repo.integrityCheck();archive=await repo.exportState();}finally{await repo.close();}
 const result=await restoreArchiveWithMedia(source,output,manifest,archive);return {...result,status:'MIGRATED_VERIFIED',sourceBackend:'sqlite',sourceDatabaseSha256:manifest.database.sha256,sourceManifestSha256:manifest.manifestSha256,sourceUnchanged:true,originalAuthoritySwitchPerformed:false};
}
