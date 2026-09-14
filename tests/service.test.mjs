import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,rm,lstat} from 'node:fs/promises';
import {once} from 'node:events';
import {treeManifest} from '../tools/io.mjs';
import {beginPhase,phaseRecords,processAlive} from '../tools/process-resources.mjs';

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const read=async file=>JSON.parse(await readFile(file,'utf8'));
const exists=async file=>Boolean(await lstat(file).catch(error=>{if(error.code==='ENOENT')return null;throw error;}));
async function until(predicate){for(let i=0;i<60;i++){const value=await predicate();if(value)return value;await wait(100);}throw Error('fixture condition timed out');}

test('startup and periodic cleanup uncertainty keep the real supervisor and both fixture children alive',async t=>{
 assert(process.env.REVIEW_TASK_DIR,'Use the managed process runner');
 const root=await mkdtemp(path.join(process.env.REVIEW_TASK_DIR,'service-unknown-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const runtime=path.join(root,'instance/runtime'),commit='a'.repeat(40),release=path.join(runtime,'releases',commit);
 await mkdir(path.join(release,'web'),{recursive:true});await mkdir(path.join(release,'scripts'));await mkdir(path.join(root,'output'));
 const docker=path.join(root,'docker.mjs');
 await writeFile(docker,'#!/usr/bin/env node\nprocess.exit(0);\n',{mode:0o700});
 await writeFile(path.join(runtime,'process-policy.json'),JSON.stringify({schemaVersion:'1.0',enabled:true,projectId:'service-fixture',host:'fixture',registry:'receipts',parentTasks:'tasks',workspace:'scratch',temporaryRoots:['output'],protectedPaths:['instance'],maxTemporaryBytes:1e8,reserveBytes:0,dockerBinary:docker}));
 await writeFile(path.join(root,'instance/instance.json'),JSON.stringify({id:'service-fixture'}));
 await writeFile(path.join(runtime,'active.json'),JSON.stringify({instanceId:'service-fixture',commit,release:path.relative(root,release)}));
 await writeFile(path.join(runtime,'machine.json'),JSON.stringify({nodeBinary:process.execPath,port:30001}));
 for(const [file,label] of [['web/server.js','web'],['scripts/worker.mjs','worker']])await writeFile(path.join(release,file),`import('node:fs').then(fs=>{fs.writeFileSync(process.env.REVIEW_INSTANCE_ROOT+'/../${label}-ready',String(process.pid));process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);});`);
 await writeFile(path.join(release,'release.json'),JSON.stringify({instanceId:'service-fixture',commit,files:await treeManifest(release)}));
 const phase=await beginPhase(root,'unknown','old'),kept=await phase.directory(path.join(root,'output/kept'));
 const old=(await phaseRecords(root,'unknown'))[0];old.record.owner={pid:process.pid,birth:'unmarked legacy display mismatch',bootId:old.record.owner.bootId,bootSource:old.record.owner.bootSource};
 await writeFile(old.file,JSON.stringify(old.record));
 const module=new URL('../tools/service.mjs',import.meta.url).href;
 // Advance only the clock used to decide when to sweep. Native processes,
 // timers, service startup, and process ownership checks remain real.
 const child=spawn(process.execPath,['--input-type=module','-e',`import {serve} from ${JSON.stringify(module)};const realNow=Date.now;let offset=0;Date.now=()=>realNow()+offset;setInterval(()=>offset+=300001,1100).unref();await serve(${JSON.stringify(root)});`],{stdio:['ignore','pipe','pipe']});
 let stderr='';child.stderr.on('data',x=>stderr+=x);child.stdout.resume();const done=once(child,'close');
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await Promise.race([done,wait(12000)]);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await done;}}});
 await until(async()=>await exists(path.join(root,'web-ready'))&&await exists(path.join(root,'worker-ready'))&&await exists(path.join(runtime,'service.json')));
 await wait(300);const service=await read(path.join(runtime,'service.json'));
 for(const owner of [service.owner,service.web,service.worker])assert.equal(processAlive(owner),true,stderr);
 const independent=await beginPhase(root,'independent','later'),removed=await independent.directory(path.join(root,'output/removed'));
 const later=(await phaseRecords(root,'independent'))[0];later.record.owner={...later.record.owner,birthId:later.record.owner.birthId+'9'};await writeFile(later.file,JSON.stringify(later.record));
 await until(async()=>!await exists(removed));
 assert(await exists(kept));assert.equal((await read(old.file)).status,'RUNNING');
 for(const owner of [service.owner,service.web,service.worker])assert.equal(processAlive(owner),true,stderr);
 child.kill('SIGTERM');const [code]=await done;assert.equal(code,0,stderr);
 for(const owner of [service.owner,service.web,service.worker])assert.equal(processAlive(owner),false);
 assert(await exists(kept),'shutdown also retains the unresolved phase');
});
