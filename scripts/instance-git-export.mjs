import {createReadStream,createWriteStream} from 'node:fs';
import {readFile,writeFile,mkdir,lstat,realpath,unlink,mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createGzip,createGunzip} from 'node:zlib';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
import {resolveInstance,openInstanceRepository} from '../host/instance-runtime/index.mjs';
import {canonicalJson,sha256} from '../host/instance-runtime/bytes.mjs';
import {canonicalSha256,archiveRowHashes} from '../host/instance-runtime/archive-integrity.mjs';
import {writeArchiveFile,readArchiveFile,ARCHIVE_FILE_FORMAT} from '../host/instance-runtime/archive-file.mjs';
import {retirementManifestFromArchive,validateRetirementBackupManifest} from '../host/instance-runtime/media-retirement-transfer.mjs';
import {GIT_BUSINESS_PROTOCOL,gitBusinessState,projectGitBusinessArchive} from '../host/instance-runtime/git-business-archive.mjs';
import {validateArchive} from '../host/instance-runtime/postgres.mjs';
import {runPostgresMaintenance} from './instance-postgres.mjs';
import {restoreArchiveWithMedia} from './instance-transfer.mjs';
const RESTORE_TEXT='# 可恢复业务快照\n\n这不是完整实例备份，也不是只读网站导出。保留正式业务历史、文档原始字节和有效媒体；不保留助手会话、运行任务、凭证和心跳。完整备份应另外保存。\n\n先取得清单 core 指定的干净软件精确提交及发行包，核验 packageManifestSha256；执行 git lfs pull 取得归档和有效媒体。不要把 LFS 指针当作媒体文件。\n\n在该软件包中执行：\n\n    node --max-old-space-size=4096 scripts/instance-git-export.mjs verify --snapshot /仓库/业务快照目录 --repository /仓库\n    node --max-old-space-size=4096 scripts/instance-git-export.mjs restore --snapshot /仓库/业务快照目录 --repository /仓库 --output /全新实例目录\n\n恢复会创建独立 PostgreSQL 实例和新运行期，不覆盖当前实例，私人助手任务不恢复，旧生产授权在新运行期不可执行；已提交／运行中／结果不明请求须先核查真实终态，新执行须明确重新授权。API 密钥和 Git/Codex 本机认证须独立配置。正式行 SHA 与表行摘要以 manifest.json 为准；只归一化运行 epoch 和仓库计数。\n';
const relative=value=>{if(typeof value!=='string'||path.isAbsolute(value)||/[\\\0]/.test(value)||value.split('/').some(part=>!part||part==='.'||part==='..'))throw Error('Explicit safe project-relative path required');return value;};
const digest=async filename=>{const hash=createHash('sha256');for await(const chunk of createReadStream(filename))hash.update(chunk);return hash.digest('hex');};
async function regular(root,name){name=relative(name);const filename=path.join(root,name),info=await lstat(filename);if(!info.isFile()||info.isSymbolicLink()||await realpath(filename)!==filename)throw Error('Snapshot/media must be canonical regular files');return filename;}
async function verifyFiles(mediaRoot,files){for(const file of files){const filename=await regular(mediaRoot,file.path);if((await lstat(filename)).size!==file.bytes||await digest(filename)!==file.sha256)throw Error('Registered media hash/size differs: '+file.path);}}
function coreBinding(core){if(!core||!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(core.repository)||!(/^[a-f0-9]{40}$/).test(core.commit)||!(/^[a-f0-9]{64}$/).test(core.packageManifestSha256))throw Error('Exact clean core repository/commit/package SHA required');return {repository:core.repository,commit:core.commit,packageManifestSha256:core.packageManifestSha256};}
export async function exportGitSnapshot(instancePath,output,{expectedFingerprint,mediaPrefix,core}){
 core=coreBinding(core);mediaPrefix=relative(mediaPrefix);const instance=resolveInstance(instancePath);
 if(instance.backend!=='postgres')throw Error('Git business snapshot requires PostgreSQL');
 if(process.env.REVIEW_DATABASE_BACKEND!=='postgres'){
  const target=path.resolve(output),parent=await realpath(path.dirname(target));if(parent!==path.dirname(target))throw Error('Export parent must be canonical');
  const args=['scripts/instance-git-export.mjs','export','--instance','/instance','--output','/export/'+path.basename(target),'--expected-fingerprint',expectedFingerprint,'--media-prefix',mediaPrefix,'--core-repository',core.repository,'--core-commit',core.commit,'--package-sha',core.packageManifestSha256];
  const result=await runPostgresMaintenance(instance.root,args,{readOnly:true,nodeHeapMiB:4096,timeout:600000,mounts:[{source:parent,target:'/export',readOnly:false}]});
  return {...JSON.parse(result),output:target};
 }
 const repo=await openInstanceRepository(instance);
 try{return await repo.withMediaReadLease(async()=>{
  const frozen=await repo.readTransaction(async tx=>{
   const light=await gitBusinessState(tx);if(light.fingerprint!==expectedFingerprint)throw Error('Content changed before freeze; retry after a new lightweight read');
   const source=await tx.exportState();validateArchive(source,instance.instanceId);
   const projected=projectGitBusinessArchive(source);validateArchive(projected.archive,instance.instanceId);
   if(projected.business.fingerprint!==light.fingerprint)throw Error('Lightweight and complete business fingerprint differ');
   const retirement=await retirementManifestFromArchive(projected.archive);
   return {...projected,retirement};
  });
  const target=path.resolve(output);if(target===instance.root||target.startsWith(instance.root+path.sep))throw Error('Snapshot output must be outside the live instance');
  await mkdir(target,{mode:0o700});if(await realpath(target)!==target)throw Error('Snapshot output must be canonical');
  const raw=path.join(target,'repository.jsonl'),archiveFile=await writeArchiveFile(raw,frozen.archive),gzip=path.join(target,'repository.jsonl.gz');
  await pipeline(createReadStream(raw),createGzip({level:6}),createWriteStream(gzip,{flags:'wx',mode:0o600}));
  await verifyFiles(instance.root,frozen.retirement.files);
  const metadata=frozen.archive.tables.repository_meta[0],body={schemaVersion:'1.0',kind:GIT_BUSINESS_PROTOCOL,instanceId:instance.instanceId,releaseId:metadata.current_release_id,repositoryRevision:metadata.repository_revision,
   businessFingerprint:frozen.business.fingerprint,schemaHash:frozen.business.schemaHash,core,mediaPrefix,
   database:{path:'repository.jsonl.gz',format:ARCHIVE_FILE_FORMAT,sha256:await digest(gzip),bytes:(await lstat(gzip)).size,uncompressedBytes:archiveFile.bytes,archiveSha256:frozen.archive.exportSha256},
   documentation:{path:'RESTORE.md',sha256:sha256(RESTORE_TEXT)},tableDigests:frozen.tableDigests,media:frozen.archive.tables.media_versions,files:frozen.retirement.files,mediaRetirement:frozen.retirement,
   excludedNamespaces:frozen.excludedNamespaces,originalRetainedRowBytesPreserved:true,normalizedRuntimeMetadata:true,
   privateConversationHistoryIncluded:false,providerCredentialsIncluded:false,runtimeIncluded:false,fullBackup:false};
  const manifest={...body,manifestSha256:sha256(canonicalJson(body))};
  await writeFile(path.join(target,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
  await writeFile(path.join(target,'RESTORE.md'),RESTORE_TEXT,{flag:'wx',mode:0o600});
  await unlink(raw);
  return {status:'GIT_BUSINESS_EXPORTED_VERIFIED',output:target,instanceId:instance.instanceId,releaseId:body.releaseId,businessFingerprint:body.businessFingerprint,manifestSha256:manifest.manifestSha256,mediaFiles:body.files.length,fullBackup:false};
 });}finally{await repo.close();}
}
async function readGitSnapshot(snapshot,repository){
 snapshot=await realpath(snapshot);repository=await realpath(repository);
 const manifest=JSON.parse(await readFile(await regular(snapshot,'manifest.json'),'utf8')),{manifestSha256,...body}=manifest;
 if(body.kind!==GIT_BUSINESS_PROTOCOL||body.schemaVersion!=='1.0'||sha256(canonicalJson(body))!==manifestSha256||body.fullBackup!==false||body.privateConversationHistoryIncluded!==false||body.providerCredentialsIncluded!==false)throw Error('Invalid Git business manifest');
 coreBinding(body.core);relative(body.mediaPrefix);
 if(body.documentation?.path!=='RESTORE.md'||await digest(await regular(snapshot,'RESTORE.md'))!==body.documentation.sha256)throw Error('Restore instructions SHA differs from the immutable snapshot manifest');
 const mediaDirectory=await realpath(path.join(repository,body.mediaPrefix));if(!mediaDirectory.startsWith(repository+path.sep)||path.basename(mediaDirectory)!=='media')throw Error('Manifest media prefix escapes the explicit Git checkout');
 const mediaRoot=path.dirname(mediaDirectory),gzip=await regular(snapshot,body.database.path);
 if((await lstat(gzip)).size!==body.database.bytes||await digest(gzip)!==body.database.sha256)throw Error('Git archive bytes or LFS materialization differ');
 if(!Number.isSafeInteger(body.database.uncompressedBytes)||body.database.uncompressedBytes<=0||body.database.uncompressedBytes>4*1024**3)throw Error('Git archive exceeds supported complete restore capacity');
 const temp=await mkdtemp(path.join(snapshot,'.verify-')),raw=path.join(temp,'repository.jsonl');let bytes=0;
 try{
  await pipeline(createReadStream(gzip),createGunzip(),new Transform({transform(chunk,_encoding,callback){bytes+=chunk.length;callback(bytes>body.database.uncompressedBytes?Error('Decompressed size exceeds manifest'):null,chunk);}}),createWriteStream(raw,{flags:'wx',mode:0o600}));
  if(bytes!==body.database.uncompressedBytes)throw Error('Decompressed size differs');
  const archive=await readArchiveFile(raw,body.database.format);validateArchive(archive,manifest.instanceId);
  const projected=projectGitBusinessArchive(archive);
  if(archive.exportSha256!==body.database.archiveSha256||projected.business.fingerprint!==body.businessFingerprint||projected.business.schemaHash!==body.schemaHash||canonicalJson(projected.tableDigests)!==canonicalJson(body.tableDigests)||projected.archive.exportSha256!==archive.exportSha256)throw Error('Git archive schema, exclusions or retained row digests differ');
  await validateRetirementBackupManifest(archive,manifest);await verifyFiles(mediaRoot,manifest.files);
  return {manifest,archive,mediaRoot};
 }finally{await rm(temp,{recursive:true,force:true});}
}
export async function verifyGitSnapshot(snapshot,repository){const {manifest}=await readGitSnapshot(snapshot,repository);return {status:'GIT_BUSINESS_VERIFIED',instanceId:manifest.instanceId,businessFingerprint:manifest.businessFingerprint,manifestSha256:manifest.manifestSha256,mediaFiles:manifest.files.length,fullBackup:false};}
export async function restoreGitSnapshot(snapshot,repository,output){const {manifest,archive,mediaRoot}=await readGitSnapshot(snapshot,repository);const proof=await restoreArchiveWithMedia(mediaRoot,output,manifest,archive);return {...proof,status:'GIT_BUSINESS_RESTORED_VERIFIED',privateConversationHistoryRestored:false,oldPendingRequests:'INELIGIBLE_REQUIRES_RESULT_CHECK',productionAuthorization:'OLD_REQUESTS_BLOCKED_NEW_AUTHORIZATION_REQUIRED',fullBackup:false,core:manifest.core};}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 try{
  const {values,positionals}=parseArgs({allowPositionals:true,options:{instance:{type:'string'},output:{type:'string'},snapshot:{type:'string'},repository:{type:'string'},'expected-fingerprint':{type:'string'},'media-prefix':{type:'string'},'core-repository':{type:'string'},'core-commit':{type:'string'},'package-sha':{type:'string'}}});
  const result=positionals[0]==='export'?await exportGitSnapshot(values.instance,values.output,{expectedFingerprint:values['expected-fingerprint'],mediaPrefix:values['media-prefix'],core:{repository:values['core-repository'],commit:values['core-commit'],packageManifestSha256:values['package-sha']}}):positionals[0]==='verify'?await verifyGitSnapshot(values.snapshot,values.repository):positionals[0]==='restore'?await restoreGitSnapshot(values.snapshot,values.repository,values.output):(()=>{throw Error('Expected export, verify or restore');})();
  process.stdout.write(JSON.stringify(result)+'\n');
 }catch(error){process.stderr.write(JSON.stringify({status:'GIT_BUSINESS_FAILED',message:error instanceof Error?error.message:'Snapshot failed',...(error?.code==='POSTGRES_DOCKER_FAILED'?{code:error.code,detail:error.diagnostics}:{})})+'\n');process.exitCode=1;}
}
