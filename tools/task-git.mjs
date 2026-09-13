import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile,writeFile,lstat,mkdir,readdir,open,rename,unlink,realpath} from 'node:fs/promises';
import {atomic,plainDirectory} from './io.mjs';
import {withRuntime,readLedger,projectionFiles,requireTask} from './task-ledger.mjs';

const hash=b=>createHash('sha256').update(b).digest('hex');
const valid=s=>typeof s==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(s);
const readMaybe=async f=>readFile(f).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
const info=async f=>lstat(f).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
function git(root,args,{input,index}={}) {
  return execFileSync('git',['-C',root,...args],{input,env:{...process.env,...(index?{GIT_INDEX_FILE:index}:{})},encoding:'utf8',timeout:30000,maxBuffer:32*1024*1024,stdio:['pipe','pipe','pipe']});
}
async function regular(root,relative) {
  let p=root;
  const parts=relative.split('/');
  for(const part of parts.slice(0,-1)){p=path.join(p,part);await plainDirectory(p);}
  const file=path.join(root,relative),s=await lstat(file);requireTask(s.isFile()&&!s.isSymbolicLink(),'受管记录不是普通文件：'+relative);
  return readFile(file);
}
async function repository(loc) {
  for(const name of ['GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_COMMON_DIR','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES'])requireTask(!process.env[name],'拒绝外部 Git 路径覆盖：'+name);
  requireTask(await realpath(git(loc.root,['rev-parse','--show-toplevel']).trim())===loc.root,'必须提交当前项目根仓库，不能提交父仓库或核心仓库');
  const ref=git(loc.root,['symbolic-ref','-q','HEAD']).trim();requireTask(ref.startsWith('refs/heads/'),'管理提交需要本地分支');
  const head=git(loc.root,['rev-parse','HEAD']).trim();
  const index=git(loc.root,['rev-parse','--path-format=absolute','--git-path','index']).trim();
  for(const marker of ['MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','rebase-merge','rebase-apply'])requireTask(!await info(git(loc.root,['rev-parse','--path-format=absolute','--git-path',marker]).trim()),'Git 合并或变基未完成，保留现场');
  const st=await info(index);requireTask(st?.isFile()&&!st.isSymbolicLink(),'Git index 不是普通文件');
  requireTask(!git(loc.root,['ls-files','--unmerged']).trim(),'Git 存在未解决冲突');
  requireTask(!git(loc.root,['rev-parse','--shared-index-path']).trim(),'暂不支持 split index，保留原暂存状态');
  return {ref,head,index};
}
function entries(root,tree) {
  return new Map(git(root,['ls-tree','-r','-z',tree]).split('\0').filter(Boolean).map(line=>{const [meta,p]=line.split('\t'),[mode,type,oid]=meta.split(' ');return [p,{mode,type,oid}];}));
}
async function snapshot(loc,request,head) {
  const ledger=await readLedger(loc),publication=ledger.events.find(e=>e.operationId===request.publishOperationId);
  requireTask(publication?.action==='publish','须提供已成功发布的原 publishOperationId；不领取或执行任务');
  requireTask(!ledger.pendingUpgrade,'账本升级未完成');
  const files=new Map(),views=projectionFiles(ledger);
  files.set('tasks/project.json',await regular(loc.root,'tasks/project.json'));
  for(const e of ledger.events){const p=`tasks/events/${String(e.sequence).padStart(10,'0')}-${e.hash}.json`;files.set(p,await regular(loc.root,p));}
  for(const [p,expected]of Object.entries(views)){const bytes=await regular(loc.root,p);requireTask(bytes.toString()===expected,'阅读视图与权威链不一致；核查后运行 tasks rebuild：'+p);files.set(p,bytes);}
  const old=entries(loc.root,head),prefix=[...old.keys()].filter(p=>p.startsWith('tasks/events/')).sort();
  requireTask(prefix.length<=ledger.sequence,'HEAD 账本包含当前工作区缺失的历史');
  for(const [i,p]of prefix.entries()){
    const e=ledger.events[i],expected=`tasks/events/${String(e.sequence).padStart(10,'0')}-${e.hash}.json`;
    requireTask(p===expected&&old.get(p).type==='blob'&&git(loc.root,['show',head+':'+p])===files.get(p).toString(),'HEAD 事件链不是当前完整前序，保留现场');
  }
  if(old.has('tasks/project.json'))requireTask(JSON.parse(git(loc.root,['show',head+':tasks/project.json'])).projectId===loc.projectId,'HEAD 属于其他项目');
  return {files,old,sequence:ledger.sequence,ledgerHead:ledger.head,taskIds:publication.tasks.map(t=>t.id)};
}
async function recovered(loc,journal,file,repo) {
  if(['SUCCEEDED','NO_CHANGES'].includes(journal.status)) {
    requireTask(git(loc.root,['merge-base','--is-ancestor',journal.commit,repo.head])==='','原提交不再位于当前分支历史，保留现场');
    return {...journal,replayed:true};
  }
  if(!journal.commit)return null;
  const current=git(loc.root,['rev-parse',journal.ref]).trim();
  if(current===journal.parent)return null; // No ref mutation happened; retry the verified original request.
  requireTask(current===journal.commit&&repo.ref===journal.ref,'原提交后分支已发生其他变化；先核查原操作与 Git，不自动改写 index');
  const currentBytes=await readFile(repo.index),lock=repo.index+'.lock';
  if(hash(currentBytes)!==journal.nextIndexHash){
    const st=await info(lock),bytes=await readMaybe(lock);
    requireTask(hash(currentBytes)===journal.previousIndexHash&&st?.ino===journal.lockInode&&st?.dev===journal.lockDevice&&bytes&&hash(bytes)===journal.nextIndexHash,'无法证明 index 恢复范围，保留原提交及现场');
    await rename(lock,repo.index);
  }
  journal.status='SUCCEEDED';journal.recovered=true;journal.verifiedAt=new Date().toISOString();await atomic(file,journal);
  return {...journal,replayed:true};
}

// The runtime receipt records intent before changing the branch. The standard
// index.lock excludes regular Git writers; update-ref also compares the parent.
// Only managed entries are replaced in a copy of the original index. No checkout,
// reset, stash, hooks, filters, push or task execution are involved.
export async function commitTaskRecords(project,request,{afterRef}={}) {
  requireTask(valid(request.operationId)&&valid(request.publishOperationId)&&typeof request.actor==='string'&&request.actor.trim(),'commit 需要 operationId、actor 和原 publishOperationId');
  return withRuntime(project,async loc=>{
    const dir=path.join(loc.runtime,'git-commits');await mkdir(dir,{recursive:true,mode:0o700});await plainDirectory(dir);
    const file=path.join(dir,request.operationId+'.json'),requestHash=hash(JSON.stringify({operationId:request.operationId,publishOperationId:request.publishOperationId,actor:request.actor}));
    let journal=JSON.parse((await readMaybe(file))?.toString()||'null');
    requireTask(!journal||journal.requestHash===requestHash,'同一管理提交编号不能用于不同请求');
    const repo=await repository(loc);
    if(journal){const result=await recovered(loc,journal,file,repo);if(result)return result;}
    for(const name of await readdir(dir)){
      if(!name.endsWith('.json')||name===path.basename(file))continue;
      const other=JSON.parse(await readFile(path.join(dir,name),'utf8'));
      requireTask(!['PREPARED','RESULT_UNKNOWN'].includes(other.status),'先核查未结束管理提交：'+other.operationId);
    }
    const snap=await snapshot(loc,request,repo.head),lock=repo.index+'.lock';
    // A prior attempt that never changed HEAD may leave its own prepared lock.
    if(journal?.nextIndexHash&&await info(lock)){
      const st=await info(lock),b=await readFile(lock);
      requireTask(st.ino===journal.lockInode&&st.dev===journal.lockDevice&&hash(b)===journal.nextIndexHash&&hash(await readFile(repo.index))===journal.previousIndexHash,'未知 index.lock，保留现场');await unlink(lock);
    }
    const handle=await open(lock,'wx',0o600),temp=path.join(dir,request.operationId+'.index');let changedRef=false,refAttempted=false,finished=false;
    try {
      const original=await readFile(repo.index);
      const staged=new Map(git(loc.root,['ls-files','--stage','-z']).split('\0').filter(Boolean).map(line=>{const [m,p]=line.split('\t');return [p,m.split(' ')[1]];}));
      const updates=[];
      for(const [p,bytes]of snap.files){
        const oid=git(loc.root,['hash-object','-w','--stdin'],{input:bytes}).trim(),old=snap.old.get(p)?.oid,indexOid=staged.get(p);
        requireTask((indexOid||!old)&&(!indexOid||indexOid===old||indexOid===oid),'受管文件含不同的已暂存内容，保留现场：'+p);
        updates.push(`100644 ${oid}\t${p}\0`);
      }
      await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});
      git(loc.root,['read-tree',repo.head],{index:temp});
      git(loc.root,['update-index','-z','--index-info'],{index:temp,input:updates.join('')});
      const tree=git(loc.root,['write-tree'],{index:temp}).trim(),oldTree=git(loc.root,['rev-parse',repo.head+'^{tree}']).trim();
      journal={operationId:request.operationId,publishOperationId:request.publishOperationId,requestHash,projectId:loc.projectId,status:'PREPARED',parent:repo.head,ref:repo.ref,tree,sequence:snap.sequence,ledgerHead:snap.ledgerHead,taskIds:snap.taskIds,paths:[...snap.files.keys()],createdAt:new Date().toISOString()};
      if(tree===oldTree){journal.status='NO_CHANGES';journal.commit=repo.head;await atomic(file,journal);finished=true;return journal;}
      // Verify every difference against the exact managed set before commit-tree.
      const differences=git(loc.root,['diff-tree','--no-commit-id','--name-only','-r','-z',repo.head,tree]).split('\0').filter(Boolean);
      requireTask(differences.length&&differences.every(p=>snap.files.has(p)),'提交树超出受管清单');
      await writeFile(temp,original);git(loc.root,['update-index','-z','--index-info'],{index:temp,input:updates.join('')});
      const nextIndex=await readFile(temp);await handle.writeFile(nextIndex);await handle.sync();
      const stat=await handle.stat();Object.assign(journal,{previousIndexHash:hash(original),nextIndexHash:hash(nextIndex),lockInode:stat.ino,lockDevice:stat.dev});
      const message=`docs: record published tasks through event ${snap.sequence}\n\nTask-Management-Operation: ${request.operationId}\nTask-Ledger-Head: ${snap.ledgerHead}\n`;
      journal.commit=git(loc.root,['commit-tree',tree,'-p',repo.head],{input:message}).trim();await atomic(file,journal);
      for(const [p,bytes]of snap.files)requireTask((await regular(loc.root,p)).equals(bytes),'受管文件在提交前变化，保留现场：'+p);
      requireTask(git(loc.root,['symbolic-ref','-q','HEAD']).trim()===repo.ref,'当前分支已变化，保留现场');
      refAttempted=true;git(loc.root,['update-ref','-m','tasks commit '+request.operationId,repo.ref,journal.commit,repo.head]);changedRef=true;
      if(afterRef)await afterRef(journal);
      requireTask(git(loc.root,['symbolic-ref','-q','HEAD']).trim()===repo.ref&&git(loc.root,['rev-parse',repo.ref]).trim()===journal.commit&&hash(await readFile(repo.index))===journal.previousIndexHash,'提交后分支或 index 已变化；保留恢复证据');
      await handle.close();await rename(lock,repo.index);
      journal.status='SUCCEEDED';journal.verifiedAt=new Date().toISOString();await atomic(file,journal);finished=true;
      return journal;
    } catch(e) {
      if(refAttempted&&!changedRef){try{changedRef=git(loc.root,['rev-parse',repo.ref]).trim()!==repo.head;}catch{changedRef=true;}}
      if(journal){journal.status=changedRef?'RESULT_UNKNOWN':'FAILED';journal.error=e.message;await atomic(file,journal);}
      throw Error(`任务已发布；本地提交${changedRef?'结果待核查':'失败'}（${request.operationId}）：${e.message}`);
    } finally {
      await handle.close().catch(()=>{});
      if(!changedRef||finished)await unlink(lock).catch(e=>{if(e.code!=='ENOENT')throw e;});
      await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});
    }
  });
}

export async function taskCommitStatus(project,operationId) {
  requireTask(valid(operationId),'需要原管理提交 operationId');
  return withRuntime(project,async loc=>{
    const bytes=await readMaybe(path.join(loc.runtime,'git-commits',operationId+'.json'));if(!bytes)return {operationId,status:'NOT_FOUND'};
    const record=JSON.parse(bytes),repo=await repository(loc);
    let commitInHistory=false;
    if(record.commit)try{git(loc.root,['merge-base','--is-ancestor',record.commit,repo.head]);commitInHistory=true;}catch{}
    return {...record,currentHead:repo.head,commitInHistory,indexMatchesPrepared:record.nextIndexHash?hash(await readFile(repo.index))===record.nextIndexHash:null,instruction:['PREPARED','RESULT_UNKNOWN'].includes(record.status)?'核对原操作；相同请求可恢复已证明的提交及 index，不重新发布':undefined};
  });
}
