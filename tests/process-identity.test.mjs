import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {readKernelProcess,processIdentity,processAlive} from '../tools/process-identity.mjs';
import {startRun} from '../tools/task-ledger.mjs';

test('kernel stat parsing preserves large ticks and parenthesized command names',()=>{
 const stat='42 (command with ) brackets) S '+Array(18).fill('0').join(' ')+' 9007199254740993123 0';
 assert.deepEqual(readKernelProcess(42,{platform:'linux',read:()=>stat}),{birthSource:'linux-proc-stat-v1',birthId:'9007199254740993123'});
 assert.equal(readKernelProcess(42,{platform:'linux',read:()=>stat.replace(') S ',') Z ')}),null);
 assert.equal(readKernelProcess(42,{platform:'linux',read:()=>{throw Object.assign(Error(),{code:'ENOENT'});}}),null);
 for(const read of [()=>stat.replace('42 (','41 ('),()=>'',()=>{throw Object.assign(Error(),{code:'EACCES'});}])assert.throws(()=>readKernelProcess(42,{platform:'linux',read}),/EXECUTION_PROCESS_UNKNOWN/);
});

test('macOS bridge validates kernel results and fails closed on probe failure',()=>{
 assert.deepEqual(readKernelProcess(42,{platform:'darwin',exec:()=>JSON.stringify({birthId:'123.000456',birthSource:'darwin-proc-bsdinfo-v1'})}),{birthId:'123.000456',birthSource:'darwin-proc-bsdinfo-v1'});
 assert.equal(readKernelProcess(42,{platform:'darwin',exec:()=> 'null'}),null);
 for(const exec of [()=> '{}',()=> 'invalid',()=>{throw Error('unavailable');}])assert.throws(()=>readKernelProcess(42,{platform:'darwin',exec}),/EXECUTION_PROCESS_UNKNOWN/);
});

test('the same real PID has identical kernel identity in UTC and Tokyo',()=>{
 const module=new URL('../tools/process-identity.mjs',import.meta.url).href;
 const inspect=TZ=>JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',`import {processIdentity} from ${JSON.stringify(module)};console.log(JSON.stringify(processIdentity(${process.pid})));`],{encoding:'utf8',env:{...process.env,TZ}}));
 const utc=inspect('UTC'),tokyo=inspect('Asia/Tokyo');
 assert.deepEqual(utc,tokyo);assert(utc.birthId);assert.equal(processAlive(utc),true);
 assert.equal(processAlive({...utc,birth:'unrelated display text'}),true,'kernel ID is authoritative for marked records');
});

test('legacy display mismatch and unknown birth sources never prove process death',()=>{
 const now=processIdentity(),legacy={pid:now.pid,birth:'different timezone display',bootId:now.bootId,bootSource:now.bootSource};
 assert.throws(()=>processAlive(legacy),/EXECUTION_PROCESS_UNKNOWN/);
 assert.throws(()=>processAlive({...now,birthSource:'future-format'}),/EXECUTION_PROCESS_UNKNOWN/);
 assert.equal(processAlive(legacy,{compareBoot:()=> 'DIFFERENT'}),false);
 assert.equal(processAlive(legacy,{inspect:()=>null}),false);
 assert.throws(()=>processAlive(legacy,{inspect:()=>undefined}),/EXECUTION_PROCESS_UNKNOWN/);
});

test('timezone changes cannot take over an expired live legacy coordinator',async t=>{
 assert(process.env.REVIEW_TASK_DIR,'Use the managed process runner');
 const root=await mkdtemp(path.join(process.env.REVIEW_TASK_DIR,'timezone-coordinator-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(path.join(root,'instance'));await writeFile(path.join(root,'instance/instance.json'),JSON.stringify({id:randomUUID()}));
 const original=await startRun(root),file=path.join(root,'instance/runtime/task-execution/run.json');
 const birth=execFileSync('ps',['-p',String(process.pid),'-o','lstart='],{encoding:'utf8',env:{...process.env,TZ:'UTC'}}).trim();
 const legacy={...original,expiresAt:'2000-01-01T00:00:00.000Z',owner:{pid:process.pid,birth,bootId:original.owner.bootId,bootSource:original.owner.bootSource}};
 const bytes=JSON.stringify(legacy);await writeFile(file,bytes);
 const module=new URL('../tools/task-ledger.mjs',import.meta.url).href;
 const output=execFileSync(process.execPath,['--input-type=module','-e',`import {startRun} from ${JSON.stringify(module)};try{await startRun(${JSON.stringify(root)});console.log('UNSAFE_TAKEOVER');}catch(error){console.log(error.message);}`],{encoding:'utf8',env:{...process.env,TZ:'Asia/Tokyo'}});
 assert.match(output,/EXECUTION_PROCESS_UNKNOWN|已有执行会话/);assert.doesNotMatch(output,/UNSAFE_TAKEOVER/);
 assert.equal(await readFile(file,'utf8'),bytes);
});
