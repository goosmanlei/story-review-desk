import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,unlink} from 'node:fs/promises';
import {execFileSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {mutate,readLedger,rebuild,runtimeState} from '../tools/task-ledger.mjs';
import {commitTaskRecords,taskCommitStatus} from '../tools/task-git.mjs';
const cli=fileURLToPath(new URL('../tools/tasks.mjs',import.meta.url)),moduleUrl=new URL('../tools/task-git.mjs',import.meta.url).href;
const git=(root,...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',stdio:['pipe','pipe','pipe']});
const spec=title=>({clarified:true,discussion:{approved:true,summary:'测试讨论通过',feasibility:'隔离验证',approvedRequirements:['记录任务']},type:'SYSTEM',title,originalRequest:title,goal:title,scope:['测试'],deliverables:['结果'],acceptanceCriteria:['验证通过'],authorization:'测试夹具授权'});
const pub=(root,title='发布任务')=>{const request={operationId:randomUUID(),actor:'FIXTURE',task:spec(title)};return mutate(root,'publish',request).then(result=>({request,result}));};
const commitRequest=p=>({operationId:randomUUID(),actor:'FIXTURE',publishOperationId:p.request.operationId});
async function fixture(t){
  assert(process.env.REVIEW_TASK_DIR,'须通过受管阶段运行');const root=await mkdtemp(path.join(process.env.REVIEW_TASK_DIR,'task-git-'));
  await mkdir(path.join(root,'instance/runtime'),{recursive:true});await writeFile(path.join(root,'instance/instance.json'),JSON.stringify({id:randomUUID()}));
  await writeFile(path.join(root,'.gitignore'),'instance/runtime/\n');await writeFile(path.join(root,'other.txt'),'base\n');
  git(root,'init','-b','main');git(root,'config','user.name','Fixture');git(root,'config','user.email','fixture@example.invalid');git(root,'add','.');git(root,'commit','-m','fixture base');
  t.after(()=>rm(root,{recursive:true,force:true}));return root;
}
async function cliCall(root,action,request){const child=spawn(process.execPath,[cli,action,'--project',root,'--file','-'],{stdio:['pipe','pipe','pipe']});let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);const done=once(child,'close');child.stdin.end(JSON.stringify(request));const [code]=await done;assert.equal(code,0,err);return JSON.parse(out);}
async function verifyCommitted(root){
  const target=await mkdtemp(path.join(process.env.REVIEW_TASK_DIR,'task-tree-'));
  try{
    for(const p of git(root,'ls-tree','-r','--name-only','HEAD','tasks').trim().split('\n').filter(Boolean)){
      if(!/^tasks\/(project\.json|README\.md|events\/|items\/)/.test(p))continue;
      await mkdir(path.dirname(path.join(target,p)),{recursive:true});await writeFile(path.join(target,p),git(root,'show','HEAD:'+p));
    }
    await mkdir(path.join(target,'instance'),{recursive:true});await writeFile(path.join(target,'instance/instance.json'),await readFile(path.join(root,'instance/instance.json')));
    const ledger=await readLedger(target),before=await readFile(path.join(target,'tasks/README.md'),'utf8');await rebuild(target);assert.equal(await readFile(path.join(target,'tasks/README.md'),'utf8'),before);return ledger;
  }finally{await rm(target,{recursive:true,force:true});}
}

test('READY publication commits only exact managed records and preserves unrelated index/worktree',async t=>{
  const root=await fixture(t),p=await pub(root),request=commitRequest(p),parent=git(root,'rev-parse','HEAD').trim();
  await writeFile(path.join(root,'other.txt'),'staged\n');git(root,'add','other.txt');await writeFile(path.join(root,'other.txt'),'unstaged\n');
  await writeFile(path.join(root,'staged-new.txt'),'new staged');git(root,'add','staged-new.txt');await writeFile(path.join(root,'untracked.txt'),'untouched');
  await mkdir(path.join(root,'tasks/artifacts'),{recursive:true});await writeFile(path.join(root,'tasks/artifacts/unknown.txt'),'not managed');await writeFile(path.join(root,'tasks/items/unknown.md'),'not managed either');
  const beforeStage=git(root,'ls-files','--stage','--','other.txt','staged-new.txt'),beforeStatus=git(root,'status','--porcelain','--','other.txt','staged-new.txt','untracked.txt');
  const result=await cliCall(root,'commit',request);assert.equal(result.status,'SUCCEEDED');assert.equal(result.sequence,1);assert.deepEqual(result.taskIds,[p.result.taskId]);
  assert.equal(git(root,'ls-files','--stage','--','other.txt','staged-new.txt'),beforeStage);assert.equal(git(root,'status','--porcelain','--','other.txt','staged-new.txt','untracked.txt'),beforeStatus);
  assert.equal(await readFile(path.join(root,'other.txt'),'utf8'),'unstaged\n');assert.equal(git(root,'show','HEAD:other.txt'),'base\n');
  const changed=git(root,'diff','--name-only',parent,'HEAD').trim().split('\n');assert(changed.every(p=>result.paths.includes(p)));assert(!changed.some(p=>p.includes('unknown')||p.includes('artifacts')));
  assert.equal((await verifyCommitted(root)).tasks[p.result.taskId].status,'READY');assert.equal((await runtimeState(root)).run,null);assert.equal(git(root,'remote').trim(),'');
});

test('complete uncommitted prefix, deterministic views, replay and no empty commits',async t=>{
  const root=await fixture(t);await pub(root,'前序一');await pub(root,'前序二');const p=await pub(root,'当前'),request=commitRequest(p);
  const first=await commitTaskRecords(root,request);assert.equal((await verifyCommitted(root)).sequence,3);
  await rebuild(root);assert.equal(git(root,'status','--porcelain','--','tasks').trim(),'');
  assert.equal((await commitTaskRecords(root,request)).commit,first.commit);assert.equal((await commitTaskRecords(root,commitRequest(p))).status,'NO_CHANGES');assert.equal(git(root,'rev-list','--count','HEAD').trim(),'2');
  await assert.rejects(commitTaskRecords(root,{...request,actor:'CHANGED'}),/同一管理提交/);
});

test('concurrent publication and independent management commits retain consistent complete chains',async t=>{
  const root=await fixture(t),p=await pub(root);
  const published=await Promise.all(Array.from({length:4},async(_,i)=>{const request={operationId:randomUUID(),actor:'FIXTURE',task:spec('并发 '+i)};const result=await cliCall(root,'publish',request);await cliCall(root,'commit',commitRequest({request}));return result.taskId;}));
  await cliCall(root,'commit',commitRequest(p));const ledger=await verifyCommitted(root);assert.equal(ledger.sequence,5);assert.equal(Object.keys(ledger.tasks).length,5);assert(published.every(id=>ledger.tasks[id]));assert(Object.values(ledger.tasks).every(t=>t.status==='READY'));
});

test('Git ref failure preserves publication and exact index, and original request retries safely',async t=>{
  const root=await fixture(t),p=await pub(root),request=commitRequest(p),index=await readFile(path.join(root,'.git/index')),head=git(root,'rev-parse','HEAD');
  await writeFile(path.join(root,'.git/refs/heads/main.lock'),'external owner');
  await assert.rejects(commitTaskRecords(root,request),/任务已发布.*提交失败/);assert.equal(git(root,'rev-parse','HEAD'),head);assert.deepEqual(await readFile(path.join(root,'.git/index')),index);assert.equal((await taskCommitStatus(root,request.operationId)).status,'FAILED');assert.equal((await readLedger(root)).sequence,1);
  await unlink(path.join(root,'.git/refs/heads/main.lock'));assert.equal((await commitTaskRecords(root,request)).status,'SUCCEEDED');assert.equal((await readLedger(root)).sequence,1);assert.equal(git(root,'rev-list','--count','HEAD').trim(),'2');
});

test('real process interruption after ref update is queried and recovered without duplicate commit',async t=>{
  const root=await fixture(t),p=await pub(root),request=commitRequest(p);
  await writeFile(path.join(root,'other.txt'),'staged after base');git(root,'add','other.txt');const unrelated=git(root,'ls-files','--stage','other.txt');
  const child=spawn(process.execPath,['--input-type=module','-e',`import {commitTaskRecords} from ${JSON.stringify(moduleUrl)};await commitTaskRecords(process.argv[1],JSON.parse(process.argv[2]),{afterRef:()=>process.kill(process.pid,'SIGKILL')});`,root,JSON.stringify(request)],{stdio:['ignore','pipe','pipe']});
  let err='';child.stderr.on('data',x=>err+=x);const [,signal]=await once(child,'close');assert.equal(signal,'SIGKILL',err);
  const status=await taskCommitStatus(root,request.operationId);assert.equal(status.status,'PREPARED');assert.equal(status.commitInHistory,true);assert.equal(status.indexMatchesPrepared,false);
  const count=git(root,'rev-list','--count','HEAD');const recovered=await commitTaskRecords(root,request);assert.equal(recovered.status,'SUCCEEDED');assert.equal(recovered.recovered,true);assert.equal(git(root,'rev-list','--count','HEAD'),count);assert.equal(git(root,'ls-files','--stage','other.txt'),unrelated);assert.equal(git(root,'status','--porcelain','--','tasks').trim(),'');await verifyCommitted(root);
});

test('unknown index lock, hand edited view, staged managed edits and symlinks fail closed',async t=>{
  const root=await fixture(t),p=await pub(root),request=commitRequest(p),readme=path.join(root,'tasks/README.md'),index=await readFile(path.join(root,'.git/index'));
  await writeFile(path.join(root,'.git/index.lock'),'unknown');await assert.rejects(commitTaskRecords(root,request),/EEXIST/);assert.equal(await readFile(path.join(root,'.git/index.lock'),'utf8'),'unknown');await unlink(path.join(root,'.git/index.lock'));
  await writeFile(readme,'hand edit');await assert.rejects(commitTaskRecords(root,request),/阅读视图/);await rebuild(root);
  const saved=await readFile(readme);await writeFile(readme,'staged edit');git(root,'add','tasks/README.md');await writeFile(readme,saved);await assert.rejects(commitTaskRecords(root,request),/不同的已暂存内容/);assert.equal(git(root,'show',':tasks/README.md'),'staged edit');
  await writeFile(path.join(root,'.git/index'),index);await unlink(readme);await symlink('../other.txt',readme);await assert.rejects(commitTaskRecords(root,request),/普通文件/);assert.equal(git(root,'rev-list','--count','HEAD').trim(),'1');
});

test('later events are explicit and require a new management operation',async t=>{
  const root=await fixture(t),p=await pub(root),r=commitRequest(p),first=await commitTaskRecords(root,r);const later=await pub(root,'后发');
  const replay=await commitTaskRecords(root,r);assert.equal(replay.sequence,1);assert.equal(replay.commit,first.commit);assert.equal((await readLedger(root)).sequence,2);
  const second=await commitTaskRecords(root,commitRequest(later));assert.equal(second.sequence,2);assert.equal((await verifyCommitted(root)).sequence,2);
});
