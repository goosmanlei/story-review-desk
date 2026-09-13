import {readFile, writeFile, mkdir, lstat, rename, rm, copyFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {spawn, execFileSync} from 'node:child_process';
import {pipeline} from 'node:stream/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {check} from '../shared/contracts.mjs';
import {fileSha} from '../transport-contract.mjs';
import {verifyPackage} from './package.mjs';

const pointerPattern = /^version https:\/\/git-lfs.github.com\/spec\/v1\noid sha256:([a-f0-9]{64})\nsize (\d+)\n$/;
export const lfsPointer = (sha256, bytes) => `version https://git-lfs.github.com/spec/v1\noid sha256:${sha256}\nsize ${bytes}\n`;
export function parsePointer(bytes) {
  if (bytes.length > 256) return null;
  const m = String(bytes).match(pointerPattern), size = m && Number(m[2]);
  return m && Number.isSafeInteger(size) && size >= 0 ? {sha256:m[1], bytes:size} : null;
}
async function regular(filename) {
  const s = await lstat(filename);
  check(s.isFile() && !s.isSymbolicLink(), 'SNAPSHOT_FILE', '快照内容必须是普通文件', 409);
  return s;
}
const git = (root, args) => execFileSync('git', ['-C',root,...args], {encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
export function snapshotStore(root) {
  root = path.resolve(root);
  check(git(root,['rev-parse','--show-toplevel']) === root, 'SNAPSHOT_REPOSITORY', '引用快照必须属于当前项目仓库');
  const configured = (() => {try{return git(root,['config','--get','lfs.storage']);}catch{return '';}})();
  const gitDir = path.resolve(root,git(root,['rev-parse','--git-common-dir']));
  check(gitDir === path.join(root,'.git') && !configured, 'SNAPSHOT_STORAGE', '引用快照只使用当前项目独立的 LFS 对象库');
  return path.join(gitDir,'lfs/objects');
}
// Reject sibling archives before inspecting any filesystem entry.
async function projectPath(root, target, {missing=false}={}) {
  root = path.resolve(root); target = path.resolve(target);
  const relative = path.relative(root,target);
  check(/^(project-data|\.process\/stages)\//.test(relative) && !relative.split(path.sep).includes('..'), 'SNAPSHOT_SCOPE', '快照只读写当前项目的数据或受管阶段目录');
  await safeParents(root,relative,{missing});
  return target;
}
async function safeParents(root, relative, {missing=false}={}) {
  let cursor = root;
  for (const part of ['',...relative.split(path.sep).slice(0,-1)]) {
    cursor = path.join(cursor,part);
    const s = await lstat(cursor).catch(e => {if(missing && e.code==='ENOENT')return null;throw e;});
    if (!s) break;
    check(s.isDirectory() && !s.isSymbolicLink(), 'SNAPSHOT_PATH', '快照不能穿过符号链接');
  }
}
function relativeFile(value) {
  check(typeof value==='string' && /^(media|originals|data)\//.test(value) && !value.split('/').some(p=>!p||p==='.'||p==='..') && !value.includes('\\'), 'SNAPSHOT_PATH', '快照文件路径无效');
  return value;
}
function entries(manifest) {
  check(manifest?.version===2 && Array.isArray(manifest.chunks) && Array.isArray(manifest.media) && Array.isArray(manifest.originals), 'SNAPSHOT_FORMAT', '项目包版本或清单无效');
  const result = [...manifest.chunks.map(c=>({path:c.path,sha256:c.sha256,bytes:c.bytes})), ...manifest.media.map(m=>({path:'media/'+m.sha256,sha256:m.sha256,bytes:m.bytes})), ...manifest.originals.map(sha256=>({path:'originals/'+sha256,sha256,bytes:null}))];
  check(result.length<=100000 && new Set(result.map(e=>e.path)).size===result.length, 'SNAPSHOT_MANIFEST', '快照清单重复或超过限制');
  for(const e of result){relativeFile(e.path);check(/^[a-f0-9]{64}$/.test(e.sha256) && (e.bytes===null||Number.isSafeInteger(e.bytes)&&e.bytes>=0),'SNAPSHOT_MANIFEST','快照内容标识无效');}
  return result;
}
async function ingest(root, filename) {
  await regular(filename);
  // LFS uses this file's size as an input hint. A destination containing an old
  // short pointer can truncate a larger stdin stream to the 1024-byte probe.
  const child = spawn('git',['-C',root,'lfs','clean','--',path.relative(root,filename)],{stdio:['pipe','pipe','pipe']});
  let output='',error='';
  child.stdout.on('data',b=>{if(output.length<1000)output+=b;});
  child.stderr.on('data',b=>{if(error.length<1000)error+=b;});
  const done = new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error('LFS 写入失败：'+error)));});
  await Promise.all([pipeline(createReadStream(filename),child.stdin),done]);
  const ref=parsePointer(output);check(ref,'SNAPSHOT_POINTER','LFS 未返回有效内容引用');return ref;
}
export async function verifySnapshot(directory,{projectRoot}={}) {
  directory = await projectPath(projectRoot,directory);
  const store=snapshotStore(projectRoot), manifestFile=path.join(directory,'manifest.json');
  await safeParents(projectRoot,path.relative(projectRoot,manifestFile));
  const stat=await regular(manifestFile);check(stat.size<=32*1024*1024,'SNAPSHOT_MANIFEST','快照清单过大');
  const snapshot=JSON.parse(await readFile(manifestFile,'utf8'));
  check(snapshot.format==='review-project-snapshot' && snapshot.version===1 && snapshot.package?.format==='review-project-package','SNAPSHOT_FORMAT','请选择引用快照');
  let total=0;const objects=[],verified=new Map();
  for(const entry of entries(snapshot.package)) {
    await safeParents(directory,entry.path);
    const pointerFile=path.join(directory,entry.path), st=await regular(pointerFile);
    check(st.size<=256,'SNAPSHOT_EXPANDED','快照文件应为内容引用；完整内容存于离线对象库',409,{path:entry.path});
    const pointer=parsePointer(await readFile(pointerFile));
    check(pointer?.sha256===entry.sha256 && (entry.bytes===null||pointer.bytes===entry.bytes),'SNAPSHOT_POINTER','快照引用与清单不符',409,{path:entry.path});
    const file=path.join(store,entry.sha256.slice(0,2),entry.sha256.slice(2,4),entry.sha256);
    if(!verified.has(entry.sha256)){
      await safeParents(projectRoot,path.relative(projectRoot,file));const st=await regular(file);
      check(st.size===pointer.bytes && await fileSha(file)===entry.sha256,'SNAPSHOT_OBJECT','离线恢复对象缺失或损坏',409,{sha256:entry.sha256});
      verified.set(entry.sha256,st.size);total+=st.size;
    }
    check(verified.get(entry.sha256)===pointer.bytes,'SNAPSHOT_OBJECT','相同内容引用的大小不一致');
    objects.push({...entry,bytes:pointer.bytes,file});
  }
  return {snapshot,objects,bytes:total,status:'VERIFIED'};
}
async function materialize(value,destination) {
  check(!await lstat(destination).catch(()=>null),'DESTINATION_EXISTS','恢复目标已存在');await mkdir(destination,{recursive:true});
  try {
    for(const entry of value.objects){const target=path.join(destination,entry.path);await mkdir(path.dirname(target),{recursive:true});await copyFile(entry.file,target);}
    await writeFile(path.join(destination,'manifest.json'),JSON.stringify(value.snapshot.package,null,2)+'\n');
    return await verifyPackage(destination);
  } catch(e) {await rm(destination,{recursive:true,force:true});throw e;}
}
export async function materializeSnapshot(source,destination,{projectRoot,phase}={}) {
  check(phase,'TASK_REQUIRED','展开快照必须由受管任务执行');
  destination=await projectPath(projectRoot,destination,{missing:true});
  const stageRoot=path.resolve((await phase.read()).resources[0].path);
  check(destination.startsWith(stageRoot+path.sep),'SNAPSHOT_DESTINATION','完整项目包只能展开到本阶段临时目录');
  return materialize(await verifySnapshot(source,{projectRoot}),destination);
}
/** Publish one verified reference snapshot, retaining only its immediate predecessor. */
export async function saveSnapshot(source,destination,{projectRoot,phase,expectedPreviousSha256,replacePackage=false,operationId=null}={}) {
  check(phase,'TASK_REQUIRED','快照保存必须由受管任务执行');
  source=await projectPath(projectRoot,source);const manifest=await verifyPackage(source);snapshotStore(projectRoot);
  destination=await projectPath(projectRoot,destination,{missing:true});
  check(destination===path.join(path.resolve(projectRoot),'project-data/current'),'SNAPSHOT_DESTINATION','当前快照固定保存在 project-data/current');
  const taskRoot=path.resolve((await phase.read()).resources[0].path),lock=path.join(projectRoot,'instance/runtime/snapshot.lock');
  const journal=path.join(projectRoot,'instance/runtime/snapshot-operation.json');
  const interrupted=await readFile(journal,'utf8').then(JSON.parse).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  check(!['SWITCHING','RESULT_UNKNOWN'].includes(interrupted?.status),'SNAPSHOT_RESULT_UNKNOWN','原快照切换结果尚未核实，不能发起新保存',409,{operationId:interrupted?.operationId});
  const lockFile=await writeFile(lock,JSON.stringify({operationId,phase:(await phase.read()).phaseId||null,pid:process.pid}),{flag:'wx'}).then(()=>true).catch(e=>{if(e.code==='EEXIST')check(false,'SNAPSHOT_BUSY','已有快照操作正在运行；请查询原操作结果',409);throw e;});
  try {
    const previous=await lstat(destination).catch(()=>null),previousPath=path.join(projectRoot,'project-data/previous');
    let oldManifest;
    if(previous){
      if(replacePackage){check(expectedPreviousSha256,'SNAPSHOT_VERSION','首次转换必须固定现行完整包 SHA');oldManifest=await verifyPackage(destination);}
      else oldManifest=(await verifySnapshot(destination,{projectRoot})).snapshot.package;
      if(expectedPreviousSha256)check(oldManifest.transfer.sha256===expectedPreviousSha256,'VERSION_CONFLICT','现行快照已改变',409);
    }
    const older=await lstat(previousPath).catch(()=>null);
    if(older)await verifySnapshot(previousPath,{projectRoot});
    const staging=path.join(taskRoot,'snapshot-'+randomUUID());await mkdir(staging);
    for(const entry of entries(manifest)){
      await safeParents(source,entry.path);
      const ref=await ingest(projectRoot,path.join(source,entry.path));
      check(ref.sha256===entry.sha256 && (entry.bytes===null||ref.bytes===entry.bytes),'SNAPSHOT_OBJECT','导出内容与 LFS 校验不一致');
      await mkdir(path.dirname(path.join(staging,entry.path)),{recursive:true});await writeFile(path.join(staging,entry.path),lfsPointer(ref.sha256,ref.bytes),{flag:'wx'});
    }
    await writeFile(path.join(staging,'manifest.json'),JSON.stringify({format:'review-project-snapshot',version:1,operationId,createdAt:new Date().toISOString(),package:manifest},null,2)+'\n');
    const verified=await verifySnapshot(staging,{projectRoot});
    // The input package was verified in full. Every byte was independently checked on LFS ingest.
    git(projectRoot,['lfs','install','--local','--skip-smudge']);
    const retired=path.join(taskRoot,'retired-'+randomUUID()),old=path.join(taskRoot,'previous-'+randomUUID());
    const protectedScratch=async keep=>phase.update(record=>{for(const r of record.resources)if(r.kind==='path'&&r.path===taskRoot){r.state=keep?'RETAINED':'TEMPORARY';if(keep)r.reason='快照切换恢复输入：中断或结果未知时保留，先查询原操作';else delete r.reason;}});
    const receipt={operationId,status:'SWITCHING',sha256:manifest.transfer.sha256,staging,destination,previousPath,old,retired};
    await protectedScratch(true);
    try{
    await writeFile(journal,JSON.stringify(receipt));
    }catch(error){await protectedScratch(false);throw error;}
    const moved={older:false,previous:false,current:false};
    try {
      if(older){await rename(previousPath,retired);moved.older=true;}
      if(previous){await rename(destination,old);moved.previous=true;}
      await rename(staging,destination);moved.current=true;
      if(previous&&!replacePackage){await rename(old,previousPath);moved.previous=false;}
      await writeFile(journal,JSON.stringify({...receipt,status:'SUCCEEDED'}));
      await protectedScratch(false);
    } catch(error) {
      try{
        if(moved.current)await rename(destination,staging);
        if(previous&&!replacePackage&&!moved.previous&&moved.current){await rename(previousPath,old);moved.previous=true;}
        if(moved.previous)await rename(old,destination);
        if(moved.older)await rename(retired,previousPath);
        await writeFile(journal,JSON.stringify({...receipt,status:'ROLLED_BACK'}));
        await protectedScratch(false);
      }catch(recoveryError){error.requiresRecovery=true;await writeFile(journal,JSON.stringify({...receipt,status:'RESULT_UNKNOWN',code:recoveryError.code||'SNAPSHOT_RECOVERY'}));}
      throw error;
    }
    return {status:'VERIFIED',format:'review-project-snapshot',sha256:manifest.transfer.sha256,media:manifest.media.length,offlineBytes:verified.bytes,directory:destination,previous:!!previous&&!replacePackage};
  } finally {if(lockFile)await rm(lock);}
}
