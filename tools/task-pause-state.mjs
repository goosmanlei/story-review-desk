import path from 'node:path';
import {createHash} from 'node:crypto';
import {readFile,lstat,realpath} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {durableExecutionFile} from './execution-runtime.mjs';

const stable=x=>Array.isArray(x)?x.map(stable):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,stable(x[k])])):x;
export const pauseHash=x=>createHash('sha256').update(JSON.stringify(stable(x))).digest('hex');
export const pauseBlocks=p=>!!p&&!['RESUMED'].includes(p.status);
export const pauseFile=loc=>path.join(loc.runtime,'pause.json');
export async function readPauseFile(file) {
  try {const st=await lstat(file);if(!st.isFile()||st.isSymbolicLink())throw Error('PAUSE_FILE_IDENTITY');return JSON.parse(await readFile(file,'utf8'));}
  catch(e){if(e.code==='ENOENT')return null;throw e;}
}
export const readPause=loc=>readPauseFile(pauseFile(loc));
export const writePause=(loc,p)=>durableExecutionFile(pauseFile(loc),p);
export function pauseScope(tasks,bindings,runId) {
  return Object.values(tasks).filter(t=>!['DONE','CANCELLED','MERGED'].includes(t.status)&&
    ((bindings.tasks[t.id]||t.runId)===runId||t.assignments?.some(a=>a.status!=='CLOSED'&&bindings.assignments[a.id]?.runId===runId)))
    .map(t=>({taskId:t.id,assignmentIds:(t.assignments||[]).filter(a=>a.status!=='CLOSED').map(a=>a.id)}));
}
export function assertPauseTarget(p,taskId,assignmentId) {
  if(!pauseBlocks(p)||!p.targets.some(t=>t.taskId===taskId&&(!assignmentId||t.assignmentIds.includes(assignmentId))))throw Error('PAUSE_TARGET_CHANGED：暂停目标或周期已改变');
}

// Capture only explicitly declared software files. Paths/contents/identities
// remain in runtime; the durable ledger contains logical checkpoint references.
export async function capturePauseWorkspace(spec) {
  if(!spec||typeof spec.path!=='string'||!Array.isArray(spec.files)||spec.files.length>2000)throw Error('PAUSE_WORKSPACE_REQUIRED：需要显式工作区及恢复文件清单');
  const root=await realpath(spec.path),st=await lstat(spec.path);
  if(!st.isDirectory()||st.isSymbolicLink()||root!==path.resolve(spec.path))throw Error('PAUSE_WORKSPACE_IDENTITY');
  if(await lstat(path.join(root,'.git')).catch(e=>{if(e.code==='ENOENT')return null;throw e;})){
    if(!spec.baseCommit)throw Error('PAUSE_BASE_COMMIT：Git 工作区必须提供完整基准提交');
  }
  const files=[...new Set(spec.files)].sort(),captured=[];
  for(const name of files){
    if(typeof name!=='string'||path.isAbsolute(name)||name.includes('\\')||name.split('/').some(x=>!x||x==='.'||x==='..'||x==='.git'))throw Error('PAUSE_WORKSPACE_FILE：只接受工作区内明确文件');
    const file=path.join(root,name),info=await lstat(file).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(!info){captured.push({name,missing:true});continue;}
    if(!info.isFile()||info.isSymbolicLink()||await realpath(file)!==file||info.size>32*1024*1024)throw Error('PAUSE_WORKSPACE_FILE_IDENTITY');
    captured.push({name,sha256:createHash('sha256').update(await readFile(file)).digest('hex'),size:info.size});
  }
  let git=null;
  if(spec.baseCommit){
    if(!/^[a-f0-9]{40}$/.test(spec.baseCommit))throw Error('PAUSE_BASE_COMMIT');
    const read=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',timeout:10000,maxBuffer:32*1024*1024});
    const head=read('rev-parse','HEAD').trim();
    if(head!==spec.baseCommit)throw Error('PAUSE_VERSION_DRIFT：工作区基准已改变');
    git={head,common:await realpath(read('rev-parse','--path-format=absolute','--git-common-dir').trim()),diffHash:pauseHash(read('diff','--binary','HEAD','--'))};
    const dirty=read('ls-files','--modified','--others','--exclude-standard','-z').split('\0').filter(Boolean);
    if(dirty.some(f=>!files.includes(f)))throw Error('PAUSE_FILES_INCOMPLETE：恢复清单须包含全部已修改和未跟踪文件');
  }
  return {spec:{path:root,files, ...(spec.baseCommit?{baseCommit:spec.baseCommit}:{})},dev:st.dev,ino:st.ino,git,files:captured};
}
export async function verifyPauseWorkspace(saved) {
  if(!saved||pauseHash(await capturePauseWorkspace(saved.spec))!==pauseHash(saved))throw Error('PAUSE_WORKSPACE_DRIFT：恢复文件、版本或目录身份已改变');
  return saved;
}
