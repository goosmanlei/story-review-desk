import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {detectBootIdentity,bootStamp,compareBootIdentity} from '../tools/execution-runtime.mjs';
import {processAlive,processIdentity} from '../tools/process-resources.mjs';
import {startRun} from '../tools/task-ledger.mjs';

const hash=x=>createHash('sha256').update(x).digest('hex');
const uuid='F9D8566F-2039-49EF-9CBA-87C9CA4EA6A3';
const current={bootId:hash(uuid),bootSource:'darwin-boot-session-uuid-v1'};

test('macOS boot identity uses a session UUID and never the moving boottime',()=>{
 const calls=[],exec=(_binary,args)=>{calls.push(args);assert.deepEqual(args,['-n','kern.bootsessionuuid']);return uuid+'\n';};
 assert.deepEqual(detectBootIdentity({platform:'darwin',exec}),current);
 assert.deepEqual(detectBootIdentity({platform:'darwin',exec:()=>uuid.toLowerCase()}),current);
 assert.equal(calls.length,1);
 assert.throws(()=>detectBootIdentity({platform:'darwin',exec:()=>'{ sec = 1, usec = 2 }'}),/EXECUTION_BOOT_UNKNOWN/);
 assert.throws(()=>detectBootIdentity({platform:'darwin',exec:()=>{throw Error('no UUID');}}),/EXECUTION_BOOT_UNKNOWN/);
});

test('stable IDs distinguish a real boot change while old macOS hash drift stays UNKNOWN',()=>{
 const same=(previous,extra={})=>compareBootIdentity(previous,{platform:'darwin',current,legacyId:hash('{ sec = 1, usec = 2 }'),...extra});
 assert.equal(same(current),'SAME');
 assert.equal(same({...current,bootId:hash(randomUUID())}),'DIFFERENT');
 assert.equal(same({bootId:hash('{ sec = 1, usec = 2 }')}),'SAME');
 assert.equal(same({bootId:hash('{ sec = 1, usec = 1 }')}),'UNKNOWN');
 assert.equal(same({bootId:current.bootId,bootSource:'unknown-format'}),'UNKNOWN');
 assert.equal(same({}),'UNKNOWN');
});

test('Linux identity remains compatible with the original boot_id hash',()=>{
 const value=uuid.toLowerCase(),stamp=detectBootIdentity({platform:'linux',read:(file,encoding)=>{assert.equal(file,'/proc/sys/kernel/random/boot_id');assert.equal(encoding,'utf8');return value+'\n';}});
 assert.equal(stamp.bootId,hash(value));
 assert.equal(compareBootIdentity({bootId:hash(value)},{platform:'linux',current:stamp}),'SAME');
 assert.equal(compareBootIdentity({bootId:hash('previous boot')},{platform:'linux',current:stamp}),'DIFFERENT');
});

test('an ambiguous legacy hash can never release a live PID with matching birth',()=>{
 const owner={pid:42,birth:'same birth',bootId:'old-macOS-hash'},inspect=()=>({pid:42,birth:'same birth',...current});
 assert.throws(()=>processAlive(owner,{inspect,compareBoot:()=> 'UNKNOWN'}),/EXECUTION_BOOT_UNKNOWN/);
 assert.equal(processAlive(owner,{inspect,compareBoot:()=> 'SAME'}),true);
 assert.equal(processAlive(owner,{inspect,compareBoot:()=> 'DIFFERENT'}),false);
});

test('actual process absence or PID reuse resolves the old process without guessing its boot',()=>{
 const owner={pid:42,birth:'old birth',birthSource:'linux-proc-stat-v1',birthId:'10',bootId:'legacy'};
 const compareBoot=()=>{throw Error('unnecessary boot comparison');};
 assert.equal(processAlive(owner,{inspect:()=>null,compareBoot}),false);
 assert.equal(processAlive(owner,{inspect:()=>({pid:42,birth:'new birth',birthSource:owner.birthSource,birthId:'20'}),compareBoot}),false);
 assert.equal(processAlive(null),false);
 assert.throws(()=>processAlive({pid:42}),/EXECUTION_PROCESS_UNKNOWN/);
});

test('live process stamps carry the stable boot source and survive exact readback',()=>{
 const owner=processIdentity();assert.equal(owner.bootSource,bootStamp().bootSource);assert.equal(owner.bootId,bootStamp().bootId);assert.equal(processAlive(owner),true);
});

test('legacy drift cannot take over a live coordinator even after its lease expires',{skip:process.platform!=='darwin'},async t=>{
 assert(process.env.REVIEW_TASK_DIR,'Use the managed process runner');
 const root=await mkdtemp(path.join(process.env.REVIEW_TASK_DIR,'legacy-coordinator-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(path.join(root,'instance'),{recursive:true});await writeFile(path.join(root,'instance/instance.json'),JSON.stringify({id:randomUUID()}));
 const original=await startRun(root),file=path.join(root,'instance/runtime/task-execution/run.json');
 const legacy={...original,expiresAt:'2000-01-01T00:00:00.000Z',owner:{pid:original.owner.pid,birth:execFileSync('ps',['-p',String(process.pid),'-o','lstart='],{encoding:'utf8'}).trim(),bootId:hash('controlled earlier boottime microseconds')}};
 const bytes=JSON.stringify(legacy);await writeFile(file,bytes);
 await assert.rejects(startRun(root),/EXECUTION_BOOT_UNKNOWN/);
 assert.equal(await readFile(file,'utf8'),bytes,'refusal must preserve the original run record');
});
