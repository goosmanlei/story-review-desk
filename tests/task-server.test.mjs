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
if(process.argv[2]==='--version'){console.log('codex-cli 9.8.7');process.exit(0);}
const args=process.argv.slice(2),listen=args[args.indexOf('--listen')+1];
if(args[0]!=='app-server'||!listen?.startsWith('unix://'))process.exit(64);
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
