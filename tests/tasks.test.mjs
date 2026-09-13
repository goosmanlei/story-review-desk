import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,readdir,rm,symlink} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {mutate,readLedger,rebuild,audit,startRun,runtimeState} from '../tools/task-ledger.mjs';
import {installTaskSkill} from '../tools/task-skill.mjs';
import {main as tasksMain} from '../tools/tasks.mjs';

const cli=fileURLToPath(new URL('../tools/tasks.mjs',import.meta.url));
const spec=(extra={})=>({clarified:true,discussion:{approved:true,summary:'已讨论并同意修复筛选',feasibility:'已有可控测试输入，可验证',approvedRequirements:['修复并验证筛选']},type:'SYSTEM',title:'修复测试筛选',originalRequest:'发布任务：使筛选符合选择',goal:'筛选显示正确结果',scope:['通用筛选逻辑'],deliverables:['修复及验证结果'],acceptanceCriteria:['筛选结果正确','清空后恢复全部结果'],authorization:'仅测试夹具，不操作真实业务或模型',...extra});
const req=extra=>({operationId:randomUUID(),actor:'FIXTURE',...extra});
const cp=extra=>({summary:'已保存进展',completedSteps:['完成定位'],nextSteps:['验证'],inputs:['fixture@1'],artifacts:[],operations:[],...extra});
async function fixture(t) {
  assert(process.env.REVIEW_TASK_DIR,'测试必须通过受管执行器运行');
  const root=await mkdtemp(path.join(process.env.REVIEW_TASK_DIR,'tasks-'));
  await mkdir(path.join(root,'instance/runtime'),{recursive:true});
  await writeFile(path.join(root,'instance/instance.json'),JSON.stringify({id:randomUUID()}));
  await writeFile(path.join(root,'package.json'),JSON.stringify({scripts:{}}));
  t.after(()=>rm(root,{recursive:true,force:true}));return root;
}
async function run(t,root) {
  const child=spawn(process.execPath,[cli,'run','--project',root],{stdio:['ignore','pipe','pipe']});
  let output='',err='';child.stderr.on('data',x=>err+=x);
  const ready=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('keeper timeout '+err)),10000);
    child.stdout.on('data',x=>{output+=x;const line=output.split('\n')[0];try{const r=JSON.parse(line);clearTimeout(timer);resolve(r);}catch{}});
    child.once('exit',code=>{clearTimeout(timer);reject(Error('keeper exited '+code+' '+err));});
  });
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const done=once(child,'close');child.kill('SIGKILL');await done;}});
  return {id:ready.runId,child};
}
async function call(root,action,body) {
  const child=spawn(process.execPath,[cli,action,'--project',root,'--file','-'],{stdio:['pipe','pipe','pipe']});
  let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);
  const done=once(child,'close');child.stdin.end(JSON.stringify(body));
  const [code]=await done;if(code)throw Error(err);return JSON.parse(out);
}
const publish=(root,s=spec())=>mutate(root,'publish',req({task:s}));
const next=(root,runId)=>mutate(root,'next',req({runId}));
async function change(root,action,id,extra) {const t=(await readLedger(root)).tasks[id];return mutate(root,action,req({taskId:id,expectedVersions:{[id]:t.version},...extra}));}
async function finish(root,id,runId) {
  const t=(await readLedger(root)).tasks[id];
  return change(root,'transition',id,{runId,status:'DONE',reason:'通过验收',result:{summary:'完成',artifacts:['fixture:result'],cleanup:'夹具临时资源已回收',acceptance:t.acceptanceCriteria.map((_,i)=>({criterion:i,evidence:'fixture check passed'}))}});
}

test('list defaults to every unfinished state; all/filter/empty outputs preserve historical queries',async t=>{
 const root=await fixture(t),runner=await run(t,root),done=await publish(root,spec({title:'完成任务'}));await next(root,runner.id);await finish(root,done.taskId,runner.id);
 const cancelled=await publish(root,spec({title:'取消任务'}));await change(root,'transition',cancelled.taskId,{status:'CANCELLED',reason:'夹具取消'});
 const waiting=await publish(root,spec({title:'待验收任务'}));await next(root,runner.id);await change(root,'transition',waiting.taskId,{runId:runner.id,status:'WAITING_REVIEW',reason:'等待验收'});
 const blocked=await publish(root,spec({title:'阻塞创作任务',type:'CREATIVE'}));await next(root,runner.id);await change(root,'transition',blocked.taskId,{runId:runner.id,status:'BLOCKED',reason:'夹具阻塞'});
 const a=await publish(root,spec({title:'合并来源甲'})),b=await publish(root,spec({title:'合并来源乙'}));await mutate(root,'merge',req({taskIds:[a.taskId,b.taskId],expectedVersions:{[a.taskId]:1,[b.taskId]:1},title:'待执行合并目标',reason:'合并夹具'}));
 const active=await publish(root,spec({title:'执行中任务',priority:0}));await next(root,runner.id);
 const before=await readLedger(root),query=(...args)=>tasksMain(['list','--project',root,...args]),pending=await query(),all=await query('--all');
 assert.deepEqual(new Set(pending.map(t=>t.status)),new Set(['READY','RUNNING','BLOCKED','WAITING_REVIEW']));assert.equal(pending.length,4);assert.equal(all.length,8);assert.equal(new Set(all.map(t=>t.status)).size,7);
 assert.deepEqual(await query('--status','DONE'),[]);assert.deepEqual((await query('--all','--status','DONE')).map(t=>t.id),[done.taskId]);
 assert.deepEqual((await query('--type','CREATIVE')).map(t=>t.id),[blocked.taskId]);assert.deepEqual(await query('--task',done.taskId),[]);assert.deepEqual((await query('--all','--task',done.taskId)).map(t=>t.id),[done.taskId]);
 const tableIds=md=>[...md.matchAll(/^\| \[(T-[^\]]+)\]/gm)].map(m=>m[1]);
 for(const flags of [[],['--all'],['--status','DONE'],['--all','--status','DONE'],['--type','CREATIVE'],['--all','--type','SYSTEM']]){
  const rows=await query(...flags),md=await query(...flags,'--format','markdown');assert.deepEqual(tableIds(md),rows.map(t=>t.id));assert.match(md,/\| 任务编号 \| 任务标题 \| 类别 \| 状态 \| 优先级 \| 发布时间 \| 前置依赖 \|/);assert(md.includes(`共 ${rows.length} 项任务`));for(const row of rows)assert(md.includes('| '+row.title+' |'));
 }
 assert.equal((await tasksMain(['show',done.taskId,'--project',root])).status,'DONE');assert.equal((await tasksMain(['audit','--project',root])).tasks.length,8);assert.equal((await tasksMain(['status','--project',root])).run.id,runner.id);
 assert.equal((await readLedger(root)).head,before.head);assert.equal((await readLedger(root)).sequence,before.sequence);
 for(const task of pending)await change(root,'transition',task.id,{runId:runner.id,status:'CANCELLED',reason:'终态空列表夹具'});
 assert.deepEqual(await query(),[]);const empty=await query('--format','markdown');assert.match(empty,/共 0 项任务/);assert.match(empty,/\| 任务编号 \|/);assert.equal((await query('--all')).length,8);
});

test('unclarified ideas produce no task files or audit events',async t=>{
  const root=await fixture(t);
  await assert.rejects(publish(root,spec({clarified:false})),/未澄清/);
  await assert.rejects(publish(root,spec({acceptanceCriteria:[]})),/非空数组/);
  await assert.rejects(readFile(path.join(root,'tasks/project.json')),e=>e.code==='ENOENT');
  assert.deepEqual((await readLedger(root)).tasks,{});
});

test('concurrent CLI publications are durable and a replay does not duplicate',async t=>{
  const root=await fixture(t), r=req({task:spec()});
  const first=await call(root,'publish',r);
  assert.equal((await call(root,'publish',r)).taskId,first.taskId);
  await assert.rejects(call(root,'publish',{...r,task:spec({title:'不同请求'})}),/同一操作/);
  await Promise.all(Array.from({length:8},(_,i)=>call(root,'publish',req({task:spec({title:'并发任务 '+i})}))));
  const ledger=await readLedger(root);assert.equal(ledger.sequence,9);assert.equal(Object.keys(ledger.tasks).length,9);
  await rebuild(root);assert.match(await readFile(path.join(root,'tasks/README.md'),'utf8'),/并发任务 7/);
  assert.equal((await readLedger(root)).sequence,9);
});

test('single executor, atomic next and publication while a task is running',async t=>{
  const root=await fixture(t), runner=await run(t,root), a=await publish(root);
  await assert.rejects(startRun(root),/已有执行/);
  const picked=await Promise.all([call(root,'next',req({runId:runner.id})),call(root,'next',req({runId:runner.id}))]);
  assert.deepEqual(picked.map(x=>x.status).sort(),['CURRENT_TASK','RUNNING']);
  const b=await publish(root,spec({title:'执行中新增',priority:0}));
  assert.equal((await next(root,runner.id)).tasks[0].id,a.taskId);
  await finish(root,a.taskId,runner.id);
  assert.equal((await next(root,runner.id)).taskId,b.taskId);
});

test('dependencies override priority, amendments use CAS and cycles are rejected',async t=>{
  const root=await fixture(t), a=await publish(root), b=await publish(root,spec({priority:0,dependencies:[a.taskId]}));
  await assert.rejects(change(root,'amend',a.taskId,{changes:{dependencies:[b.taskId]},reason:'cycle'}),/循环/);
  const version=(await readLedger(root)).tasks[a.taskId].version;
  await change(root,'amend',a.taskId,{changes:{priority:3},reason:'调整顺序'});
  await assert.rejects(mutate(root,'amend',req({taskId:a.taskId,expectedVersions:{[a.taskId]:version},changes:{priority:0},reason:'stale'})),/版本冲突/);
  const runner=await run(t,root);assert.equal((await next(root,runner.id)).taskId,a.taskId);
  await finish(root,a.taskId,runner.id);assert.equal((await next(root,runner.id)).taskId,b.taskId);
});

test('merge preserves originals and redirects downstream dependencies',async t=>{
  const root=await fixture(t), a=await publish(root), b=await publish(root,spec({title:'另一个问题'}));
  const d=await publish(root,spec({dependencies:[a.taskId],priority:0}));
  const before=await readLedger(root), m=await mutate(root,'merge',req({taskIds:[a.taskId,b.taskId],expectedVersions:{[a.taskId]:1,[b.taskId]:1},title:'共同修复',reason:'同一逻辑'}));
  const after=await readLedger(root);
  assert.equal(after.sequence,before.sequence+1);assert.equal(after.tasks[a.taskId].publishedAt,before.tasks[a.taskId].publishedAt);
  assert.equal(after.tasks[a.taskId].originalRequest,before.tasks[a.taskId].originalRequest);
  assert.equal(after.tasks[a.taskId].status,'MERGED');assert.equal(after.tasks[m.taskId].acceptanceCriteria.length,4);
  const runner=await run(t,root);assert.equal((await next(root,runner.id)).taskId,m.taskId);
  await finish(root,m.taskId,runner.id);assert.equal((await next(root,runner.id)).taskId,d.taskId);
});

test('split is atomic, covers all acceptance criteria and rolls up completion',async t=>{
  const root=await fixture(t), parent=await publish(root), before=(await readLedger(root)).head;
  await assert.rejects(change(root,'split',parent.taskId,{reason:'拆解',children:[{title:'a',goal:'a',criterionIndexes:[0]},{title:'b',goal:'b',criterionIndexes:[0]}]}),/遗漏/);
  assert.equal((await readLedger(root)).head,before);
  const s=await change(root,'split',parent.taskId,{reason:'两个验收点',children:[{title:'a',goal:'a',criterionIndexes:[0]},{title:'b',goal:'b',criterionIndexes:[1]}]});
  const runner=await run(t,root);
  for(let i=0;i<2;i++) {const n=await next(root,runner.id);assert(s.children.includes(n.taskId));await finish(root,n.taskId,runner.id);}
  assert.equal((await readLedger(root)).tasks[parent.taskId].status,'DONE');
  assert.equal((await next(root,runner.id)).status,'NO_EXECUTABLE_TASK');
});

test('interrupted external result is reconciled in a new process without re-execution',async t=>{
  const root=await fixture(t), a=await publish(root), one=await run(t,root);await next(root,one.id);
  const pending=cp({operations:[{id:'external-1',kind:'FIXTURE',status:'PENDING'}]});
  await change(root,'checkpoint',a.taskId,{runId:one.id,checkpoint:pending});
  const marker=path.join(root,'external-result');await writeFile(marker,'executed once');
  const exited=once(one.child,'close');one.child.kill('SIGKILL');await exited;
  const two=await run(t,root);assert.equal((await next(root,two.id)).status,'RECOVERY_REQUIRED');
  await assert.rejects(change(root,'checkpoint',a.taskId,{runId:one.id,checkpoint:pending}),/资格失效/);
  const recovery={processes:'原进程已退出',workspace:'已检查 fixture',versions:'fixture@1 未改变',operations:'external-1 原结果文件证明成功'};
  await change(root,'resume',a.taskId,{runId:two.id,reconciliation:recovery,checkpoint:cp({operations:[{id:'external-1',kind:'FIXTURE',status:'SUCCEEDED',evidence:'external-result = executed once'}]})});
  await finish(root,a.taskId,two.id);assert.equal(await readFile(marker,'utf8'),'executed once');
  const report=audit(await readLedger(root),{taskId:a.taskId});
  assert(report.events.some(e=>e.action==='resume'));assert(report.tasks[0].completedAt);
});

test('unknown external result blocks only its task and cannot be dropped or completed',async t=>{
  const root=await fixture(t), a=await publish(root), one=await run(t,root);await next(root,one.id);
  const pending=cp({operations:[{id:'unknown-1',kind:'FIXTURE',status:'RESULT_UNKNOWN'}]});
  await change(root,'checkpoint',a.taskId,{runId:one.id,checkpoint:pending});
  await assert.rejects(change(root,'checkpoint',a.taskId,{runId:one.id,checkpoint:cp()}),/不能丢弃/);
  await assert.rejects(finish(root,a.taskId,one.id),/未核查/);
  const exited=once(one.child,'close');one.child.kill('SIGKILL');await exited;
  const two=await run(t,root);
  const r=await change(root,'resume',a.taskId,{runId:two.id,reconciliation:{processes:'已退出',workspace:'已核查',versions:'未变',operations:'服务暂不可查，结果未知'},checkpoint:pending});
  assert.equal(r.status,'BLOCKED');
  const b=await publish(root);assert.equal((await next(root,two.id)).taskId,b.taskId);
  await assert.rejects(change(root,'transition',a.taskId,{status:'READY',reason:'try again'}),/未知/);
});

test('guard registers a live command and prevents takeover after keeper death',async t=>{
  const root=await fixture(t), a=await publish(root), one=await run(t,root);await next(root,one.id);
  const child=spawn(process.execPath,[cli,'guard','--project',root,'--run',one.id,'--task',a.taskId,'--',process.execPath,'-e','setTimeout(()=>{},30000)'],{stdio:['ignore','pipe','pipe']});
  let observed;
  for(let i=0;i<100;i++){observed=(await runtimeState(root)).activity;if(observed?.child)break;await new Promise(r=>setTimeout(r,30));}
  assert(observed?.child);
  await assert.rejects(finish(root,a.taskId,one.id),/命令仍在运行/);
  t.after(async()=>{try{process.kill(-observed.child.pid,'SIGKILL');}catch{}if(child.exitCode===null&&child.signalCode===null){const done=once(child,'close');child.kill('SIGKILL');await done;}});
  const exited=once(one.child,'close');one.child.kill('SIGKILL');await exited;
  await assert.rejects(startRun(root),/原执行命令仍在运行/);
  const ended=once(child,'close');process.kill(-observed.child.pid,'SIGTERM');await ended;
  const two=await run(t,root);assert.equal((await next(root,two.id)).status,'RECOVERY_REQUIRED');
});

test('ledger detects tampering, rejects changed instance and rebuilds stale views',async t=>{
  const root=await fixture(t), a=await publish(root);
  await writeFile(path.join(root,'tasks/items',a.taskId+'.md'),'stale');await rebuild(root);
  assert.match(await readFile(path.join(root,'tasks/items',a.taskId+'.md'),'utf8'),/正式要求/);
  const files=await readdir(path.join(root,'tasks/events')), file=path.join(root,'tasks/events',files[0]);
  const body=await readFile(file,'utf8');await writeFile(file,body.replace('修复测试筛选','tampered'));
  await assert.rejects(readLedger(root),/校验失败/);await writeFile(file,body);
  await writeFile(path.join(root,'instance/instance.json'),JSON.stringify({id:'different'}));
  await assert.rejects(readLedger(root),/其他实例/);
});

test('managed skill installation protects local changes and supports source upgrades',async t=>{
  const root=await fixture(t), software=path.resolve(path.dirname(cli),'..');
  assert.equal((await installTaskSkill(root,software)).status,'INSTALLED');
  assert.equal((await installTaskSkill(root,software)).status,'INSTALLED');
  const skill=path.join(root,'.agents/skills/review-tasks/SKILL.md');
  const original=await readFile(skill,'utf8');assert.match(original,/未澄清完成前/);
  await writeFile(skill,original+'\nlocal edit');
  await assert.rejects(installTaskSkill(root,software),/本地修改/);
  assert.match(await readFile(skill,'utf8'),/local edit/);
});

test('symlinked task cards are never overwritten',async t=>{
  const root=await fixture(t), a=await publish(root), target=path.join(root,'protected');await writeFile(target,'keep');
  const card=path.join(root,'tasks/items',a.taskId+'.md');await rm(card);await symlink(target,card);
  await assert.rejects(rebuild(root),/不安全/);assert.equal(await readFile(target,'utf8'),'keep');
});
