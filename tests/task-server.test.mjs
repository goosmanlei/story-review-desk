import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import {once} from 'node:events';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {chmod,lstat,mkdir,mkdtemp,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {ensureTaskServer,serverPaths,verifyTaskServer} from '../tools/task-server.mjs';
import {processAlive,processIdentity} from '../tools/process-resources.mjs';
import {stopAppService,verifyAppServiceRecovery} from '../tools/app-service.mjs';
import {bootIdentity,durableExecutionFile} from '../tools/execution-runtime.mjs';

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const missing=error=>error.code==='ENOENT';

function commandFor(pid) {
  try{return execFileSync('ps',['-p',String(pid),'-o','command='],{encoding:'utf8'}).trim();}
  catch(error){if(error.status===1)return '';throw error;}
}

async function terminateFixtureServer(record,root) {
  if(!record?.binary?.startsWith(root+path.sep))return;
  if(processAlive(record.supervisor)) {
    assert.match(commandFor(record.supervisor.pid),new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),'只停止本 fixture 的 supervisor');
    process.kill(record.supervisor.pid,'SIGTERM');
  }
  for(let i=0;i<60&&(processAlive(record.supervisor)||processAlive(record.process));i++)await wait(50);
  for(const owner of [record.process,record.supervisor]) {
    if(!processAlive(owner))continue;
    assert.match(commandFor(owner.pid),new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),'只清退本 fixture 的进程');
    process.kill(owner.pid,'SIGKILL');
  }
  for(let i=0;i<20&&(processAlive(record.supervisor)||processAlive(record.process));i++)await wait(50);
  assert.equal(processAlive(record.supervisor),false);
  assert.equal(processAlive(record.process),false);
}

async function fixture(t) {
  assert(process.env.REVIEW_TASK_DIR,'测试必须由受管 process runner 提供隔离目录');
  const base=await mkdtemp(path.join(process.env.REVIEW_TASK_DIR,'task-server-'));
  const previousCwd=process.cwd(),previousCodexHome=process.env.CODEX_HOME,projects=[];
  process.chdir(base);
  process.env.CODEX_HOME='codex-home';
  await mkdir('codex-home',{mode:0o700});
  t.after(async()=>{
    for(const root of projects) {
      const record=await readFile(path.join(root,'instance/runtime/task-execution/server/server.json'),'utf8').then(JSON.parse).catch(error=>missing(error)?null:Promise.reject(error));
      await terminateFixtureServer(record,root);
    }
    process.chdir(previousCwd);
    if(previousCodexHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previousCodexHome;
    await rm(base,{recursive:true,force:true});
  });
  return {base,async project({id=randomUUID(),name='project-'+randomUUID()}={}) {
    const root=path.join(base,name);projects.push(root);
    await mkdir(path.join(root,'instance/runtime'),{recursive:true,mode:0o700});
    await writeFile(path.join(root,'instance/instance.json'),JSON.stringify({id})+'\n',{mode:0o600});
    return root;
  }};
}

async function fakeBinary(root) {
  const file=path.join(root,'fake-codex.mjs');
  await writeFile(file,`#!/usr/bin/env node
import net from 'node:net';
import {readFileSync,writeFileSync} from 'node:fs';
if(process.argv[2]==='--version'){console.log('codex-cli 9.8.7');process.exit(0);}
const args=process.argv.slice(2),listen=args[args.indexOf('--listen')+1];
if(args[0]!=='app-server'||!listen?.startsWith('unix://'))process.exit(64);
let starts=0;try{starts=JSON.parse(readFileSync('fixture-starts.json','utf8'));}catch{}
writeFileSync('fixture-starts.json',JSON.stringify(starts+1));
const server=net.createServer(socket=>socket.end());
server.listen(listen.slice('unix://'.length));
const stop=()=>server.close(()=>process.exit(0));
process.on('SIGTERM',stop);process.on('SIGINT',stop);
` ,{mode:0o700});
  await chmod(file,0o700);
  return file;
}

function fakeConnect(paths,{sqliteHome=path.join(paths.directory,'state')}={}) {
  return ({socket})=>{
    assert.equal(socket,paths.socket);
    return {close(){},async initialize(){return {userAgent:'fixture/9.8.7 controlled'};},async call(method) {
      if(method==='thread/loaded/list')return {data:[]};
      assert.equal(method,'config/read');
      return {config:{sqlite_home:sqliteHome,agents:{max_threads:3}}};
    }};
  };
}

test('project service identity uses canonical root and rejects a record copied from another root',{concurrency:false},async t=>{
  const f=await fixture(t),projectId=randomUUID();
  const first=await f.project({id:projectId,name:'first'}),second=await f.project({id:projectId,name:'second'});
  const alias=path.join(f.base,'first-alias');await symlink(first,alias,'dir');
  const a=await serverPaths(first),same=await serverPaths(alias),b=await serverPaths(second);
  assert.equal(same.root,a.root);assert.equal(same.serviceId,a.serviceId);assert.equal(same.socket,a.socket);
  assert.notEqual(b.serviceId,a.serviceId);assert.notEqual(b.socket,a.socket);
  assert.match(a.serviceId,/^review-tasks-[a-f0-9]{20}$/);
  await writeFile(b.record,JSON.stringify({schemaVersion:1,projectId,root:a.root,serviceId:a.serviceId,socket:a.socket})+'\n');
  let connected=false;
  await assert.rejects(verifyTaskServer(second,{connect(){connected=true;throw Error('must not connect');}}),/SERVER_IDENTITY/);
  assert.equal(connected,false,'身份不符时不得接触任何 socket client');
});

test('unknown socket, aliased control path and ambiguous recovery are preserved and rejected',{concurrency:false},async t=>{
  const f=await fixture(t),root=await f.project({name:'refusal'}),paths=await serverPaths(root);
  const foreign=net.createServer();foreign.listen(paths.socket);await once(foreign,'listening');
  await assert.rejects(ensureTaskServer(root,{binary:'/fixture/binary-must-not-run'}),/SERVER_SOCKET_OCCUPIED/);
  assert.equal((await lstat(paths.socket)).isSocket(),true,'未知 socket 必须保留现场');
  await new Promise(resolve=>foreign.close(resolve));
  await assert.rejects(readFile(paths.record),missing);

  const recovery={schemaVersion:1,serviceId:paths.serviceId,projectId:paths.projectId,root:paths.root,generation:randomUUID(),socket:paths.socket,binary:'/fixture/no-such-child',version:'9.8.7',sqliteHome:path.join(paths.directory,'state'),supervisor:processIdentity()};
  await writeFile(paths.record,JSON.stringify(recovery)+'\n');
  await assert.rejects(ensureTaskServer(root,{binary:'/fixture/binary-must-not-run'}),/SERVER_START_UNKNOWN/);
  await assert.rejects(readFile(path.join(paths.directory,'launch.json')),missing);

  const control=path.join(f.base,'codex-home/app-server-control'),redirect=path.join(f.base,'redirected-control');
  await rm(control,{recursive:true,force:true});await mkdir(redirect,{mode:0o700});await symlink(redirect,control,'dir');
  await assert.rejects(serverPaths(root),/符号链接|EEXIST/);
});

test('legacy macOS startup hash drift cannot authorize another server launch',{concurrency:false,skip:process.platform!=='darwin'},async t=>{
 const f=await fixture(t),root=await f.project({name:'legacy-starting'}),p=await serverPaths(root);
 const original={schemaVersion:2,serviceId:p.serviceId,projectId:p.projectId,root:p.root,generation:randomUUID(),socket:p.socket,status:'STARTING',bootId:'controlled-legacy-boottime-hash',binary:'/fixture/must-not-start',sqliteHome:path.join(p.directory,'state')};
 await durableExecutionFile(p.record,original);const bytes=await readFile(p.record,'utf8');
 await assert.rejects(ensureTaskServer(root,{binary:'/fixture/must-not-start',connect:()=>{throw Error('must not connect');}}),/SERVER_START_UNKNOWN/);
 assert.equal(await readFile(p.record,'utf8'),bytes);await assert.rejects(readFile(path.join(root,'fixture-starts.json')),missing);
});

test('isolated fake App Server starts once, reuses, and reconciles its recorded child',{concurrency:false},async t=>{
  const f=await fixture(t),root=await f.project({name:'lifecycle'});process.chdir(root);process.env.CODEX_HOME='codex-home';await mkdir('codex-home',{mode:0o700});
  const paths=await serverPaths(root),binary=await fakeBinary(root),connect=fakeConnect(paths);
  const starts=await Promise.all([ensureTaskServer(root,{binary,connect}),ensureTaskServer(root,{binary,connect})]);
  assert.equal(new Set(starts.map(r=>r.generation)).size,1);assert.equal(starts.filter(r=>!r.reused).length,1);
  const first=starts.find(r=>!r.reused);
  assert.equal(first.reused,false);assert.equal(first.status,'READY');assert.equal(first.binary,binary);
  assert.equal(processAlive(first.supervisor),true);assert.equal(processAlive(first.process),true);
  const reused=await ensureTaskServer(root,{binary,connect});
  assert.equal(reused.reused,true);assert.equal(reused.generation,first.generation);
  assert.deepEqual(reused.supervisor,first.supervisor);assert.deepEqual(reused.process,first.process);

  const stored=JSON.parse(await readFile(paths.record,'utf8'));delete stored.process;delete stored.reconciledAt;
  await writeFile(paths.record,JSON.stringify(stored,null,2)+'\n',{mode:0o600});
  const recovered=await ensureTaskServer(root,{binary,connect});
  assert.equal(recovered.reused,true);assert.equal(recovered.generation,first.generation);
  assert.deepEqual(recovered.process,first.process);assert.ok(recovered.reconciledAt);
  const launch=JSON.parse(await readFile(path.join(paths.directory,'launch.json'),'utf8'));
  assert.equal(launch.root,root);assert.equal(launch.binary,binary);
  assert.ok(launch.args.includes('unix://'+paths.socket));assert.ok(launch.args.includes('sqlite_home='+JSON.stringify(path.join(paths.directory,'state'))));

  await assert.rejects(verifyTaskServer(root,{connect:fakeConnect(paths,{sqliteHome:path.join(root,'foreign-state')})}),/SERVER_CONFIGURATION/);
});

test('service crash and controlled reboot preserve generations and isolate another running instance',{concurrency:false},async t=>{
 const f=await fixture(t),a=await f.project({name:'instance-a'}),b=await f.project({name:'instance-b'});
 const enter=async root=>{process.chdir(root);await mkdir('codex-home',{recursive:true});const paths=await serverPaths(root);return {paths,binary:await fakeBinary(root),connect:fakeConnect(paths)};};
 const first=await enter(a),original=await ensureTaskServer(a,first);
 const second=await enter(b),unrelated=await ensureTaskServer(b,second);
 assert.notEqual(original.serviceId,unrelated.serviceId);assert.notEqual(original.sqliteHome,unrelated.sqliteHome);
 process.chdir(a);
 const progress=path.join(first.paths.directory,'state/original-operation.json');
 await durableExecutionFile(progress,{operationId:'original-operation',status:'COMPLETED',result:'executed once'});
 // Actual SIGKILL of the isolated fake child, never a real App Server.
 process.kill(original.process.pid,'SIGKILL');
 for(let i=0;i<100&&(processAlive(original.process)||processAlive(original.supervisor));i++)await wait(25);
 assert.equal(processAlive(original.process)||processAlive(original.supervisor),false);
 const restored=await ensureTaskServer(a,first);
 assert.notEqual(restored.generation,original.generation);assert.equal(restored.sqliteHome,original.sqliteHome);
 assert.equal(JSON.parse(await readFile(path.join(first.paths.directory,'generations',original.generation+'.json'),'utf8')).generation,original.generation);
 assert.equal(processAlive(unrelated.process),true);assert.equal(processAlive(unrelated.supervisor),true);
 // Controlled reboot simulation: both fixture processes have really exited;
 // only their persisted boot identity is changed. No host reboot occurs.
 await stopAppService(a,{connect:first.connect,assertIdle:async()=>{}});
 const old=JSON.parse(await readFile(first.paths.record,'utf8'));
 old.bootId='controlled-previous-boot';old.process.bootId=old.bootId;old.supervisor.bootId=old.bootId;
 await durableExecutionFile(first.paths.record,old);
 const rebooted=await ensureTaskServer(a,first);
 assert.equal(rebooted.bootId,bootIdentity());assert.notEqual(rebooted.generation,restored.generation);
 assert.equal(JSON.parse(await readFile(progress,'utf8')).operationId,'original-operation');
 assert.equal(JSON.parse(await readFile(progress,'utf8')).result,'executed once');
 assert.equal(JSON.parse(await readFile(path.join(a,'fixture-starts.json'),'utf8')),3);
 assert.equal((await ensureTaskServer(a,first)).reused,true);
 process.chdir(b);assert.equal((await ensureTaskServer(b,second)).generation,unrelated.generation);
 assert.equal(JSON.parse(await readFile(path.join(b,'fixture-starts.json'),'utf8')),1);
});

test('orphaned service stays unique and a lost child creation receipt remains UNKNOWN',{concurrency:false},async t=>{
 const f=await fixture(t),root=await f.project({name:'orphan'});process.chdir(root);await mkdir('codex-home');
 const paths=await serverPaths(root),binary=await fakeBinary(root),connect=fakeConnect(paths);
 const original=await ensureTaskServer(root,{binary,connect});
 process.kill(original.supervisor.pid,'SIGKILL');
 for(let i=0;i<100&&processAlive(original.supervisor);i++)await wait(25);
 assert.equal(processAlive(original.process),true);
 assert.equal((await ensureTaskServer(root,{binary,connect})).generation,original.generation);
 await stopAppService(root,{connect,assertIdle:async()=>{}});
 const before=await readFile(path.join(root,'fixture-starts.json'),'utf8');
 await durableExecutionFile(paths.record,{...original,status:'STARTING',process:null,supervisor:null,launchOwner:{...original.supervisor,birth:'exited'}});
 await rm(path.join(paths.directory,'launch-process.json'));
 await assert.rejects(ensureTaskServer(root,{binary,connect}),/SERVER_START_UNKNOWN/);
 await durableExecutionFile(paths.record,{...original,status:'STARTING',process:null});
 await assert.rejects(ensureTaskServer(root,{binary,connect}),/SERVER_START_UNKNOWN/);
 assert.equal(await readFile(path.join(root,'fixture-starts.json'),'utf8'),before);
});

test('legacy live recovery preserves UNKNOWN and only converges exact original threads',{concurrency:false,skip:process.platform!=='darwin'},async t=>{
 const f=await fixture(t),root=await f.project({name:'legacy-live'});process.chdir(root);await mkdir('codex-home');
 const paths=await serverPaths(root),binary=await fakeBinary(root),base=fakeConnect(paths),original=await ensureTaskServer(root,{binary,connect:base});
 const live=processIdentity(original.process.pid,{includeLegacy:true});
 const legacy={...original,process:{pid:live.pid,birth:live.legacyBirth,bootId:'earlier-boottime-drift'}};
 await durableExecutionFile(paths.record,legacy);const bytes=await readFile(paths.record,'utf8');
 const scope={threadId:'original-thread',turnId:'original-turn',workspace:path.join(root,'.process/shared/original')},calls=[];
 const connect=options=>{const client=base(options);return {...client,async flush(){},async call(method,params){
  if(method==='config/read')return client.call(method,params);
  calls.push({method,params});return method==='thread/backgroundTerminals/list'?{data:[{processId:'owned-terminal'}]}:{};
 }};};
 let v;
 try {
  await assert.rejects(verifyTaskServer(root,{connect}),/EXECUTION_BOOT_UNKNOWN/);
  v=await verifyAppServiceRecovery(root,{threads:[scope],connect});
  assert.equal(v.recoveryIdentity.bootComparison,'UNKNOWN');assert.equal(processAlive(v.recoveryIdentity.observedProcess),true);
  await v.client.call('thread/read',{threadId:scope.threadId,includeTurns:false});
  for(const [method,params] of [
   ['turn/start',{threadId:scope.threadId}],['thread/start',{cwd:scope.workspace}],
   ['thread/read',{threadId:'foreign'}],['turn/interrupt',{threadId:scope.threadId,turnId:'foreign'}],
   ['thread/resume',{threadId:scope.threadId,cwd:scope.workspace,excludeTurns:true,approvalPolicy:'never',env:{EXTRA:'value'}}],
   ['thread/goal/set',{threadId:scope.threadId,status:'complete'}],
   ['thread/backgroundTerminals/terminate',{threadId:scope.threadId,processId:'unseen'}],
  ])await assert.rejects(v.client.call(method,params),/SERVER_RECOVERY_SCOPE|SERVER_RECOVERY_METHOD/);
  assert.equal(calls.length,1,'rejected operations never reach the service');
  await v.client.call('thread/backgroundTerminals/list',{threadId:scope.threadId});
  await v.client.call('thread/backgroundTerminals/terminate',{threadId:scope.threadId,processId:'owned-terminal'});
  await v.client.call('turn/interrupt',{threadId:scope.threadId,turnId:scope.turnId});
  await v.client.call('thread/archive',{threadId:scope.threadId});
  assert.equal(await readFile(paths.record,'utf8'),bytes,'recovery does not relabel the old boot or overwrite its identity');
  assert.equal(JSON.parse(await readFile(path.join(root,'fixture-starts.json'),'utf8')),1);
 } finally {v?.client.close();await durableExecutionFile(paths.record,original);}
});
