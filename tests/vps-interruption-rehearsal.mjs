import assert from 'node:assert/strict';
import {readFile,writeFile,readdir,lstat} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import path from 'node:path';
import {build} from 'esbuild';
import {readPackage} from '../host/instance-runtime/vps-package.mjs';
import {WireInput,writeWire} from '../host/instance-runtime/vps-wire.mjs';
import {remoteBootstrap,main} from '../scripts/instance-vps.mjs';
import {applyNginxConfigInPlace,nginxSha} from '../host/instance-runtime/vps-nginx.mjs';
import {command} from '../host/instance-runtime/vps-process.mjs';
if(process.env.REVIEW_TEST_VPS!=='1')throw Error('Explicit local-only failure rehearsal required');
process.env.REVIEW_VPS_OFFLINE='1';
const fixture=path.resolve(process.argv[2]||''),packageRoot=path.resolve(process.argv[3]||'');if(!fixture.startsWith(path.resolve('.test-tmp/vps-rehearsal-')))throw Error('Isolated fixture required');
const config=path.join(fixture,'target.json'),target=JSON.parse(await readFile(config));assert.equal(target.sshHost,'fixture-only');
const stateFile=path.join(target.hostRoot,'state.json'),before=JSON.parse(await readFile(stateFile)),source=await readPackage(packageRoot,{target,allowDevelopment:true});
const operationId='rehearsal_interrupted_save_01',expected=before.current.releaseId;
const result={kind:'LOCAL_BINARY_CONTROLLER_FAILURE_REHEARSAL',sshConnections:0,realModelCalls:0};
const bundled=await build({entryPoints:['scripts/instance-vps-host.mjs'],bundle:true,platform:'node',format:'esm',target:'node22',write:false});
// Same controller/bootstrap and wire protocol as SSH; only the transport is a
// local child process. Terminating stdin simulates loss of the SSH file stream.
const child=spawn(process.execPath,['-e',remoteBootstrap],{stdio:['pipe','pipe','pipe']}),done=once(child,'exit');let stderr='';child.stderr.on('data',b=>stderr=(stderr+b).slice(-3000));
await writeWire(child.stdin,JSON.stringify({code:Buffer.from(bundled.outputFiles[0].text).toString('base64'),control:{action:'deploy',target,fixture:true,manifest:source.manifest,expectedCurrent:expected,operationId}})+'\n');
const wire=new WireInput(child.stdout);let interrupted=false;
try{for(;;){const event=await wire.json();if(event.type==='ERROR'){assert(interrupted,event.message);result.interruptionError=event.message;break;}
 assert.equal(event.type,'READ_FILE');const descriptor=source.manifest.files.find(f=>f.path===event.path);assert(descriptor);assert.equal(event.sha256,descriptor.sha256);
 const state=JSON.parse(await readFile(stateFile));
 if(state.pending?.phase==='SAVING'&&event.path==='images/app.tar'){
  const iterator=source.open(event.path)[Symbol.asyncIterator]();const first=await iterator.next();await writeWire(child.stdin,first.value);await iterator.return();child.stdin.end();interrupted=true;continue;
 }
 for await(const bytes of source.open(event.path))await writeWire(child.stdin,bytes);
}}finally{child.stdin.end();}
const [code]=await done;assert.equal(code,1,stderr);assert(interrupted);
const partial=JSON.parse(await readFile(stateFile));assert.equal(partial.pending.phase,'SAVING');assert.equal(partial.current.releaseId,source.manifest.releaseId);assert.equal(partial.backup.releaseId,expected);
const health=await command(target.runtime.dockerBinary,['exec',partial.current.runtime.web,'node','-e',"fetch('http://127.0.0.1:3000/__review_health').then(r=>r.json()).then(v=>console.log(JSON.stringify(v)))"]);assert.equal(JSON.parse(health).maintenance,false);
await assert.rejects(main(['deploy','--target',config,'--fixture-host','--development','--package',packageRoot,'--expected-current',partial.current.releaseId,'--operation-id','forbidden_next_deployment']),/unfinished/);
result.onlineDuringInterruptedSave=true;result.nextDeploymentBlocked=true;result.partialPackageBytes=(await lstat(path.join(target.hostRoot,partial.current.slot,'images/app.tar'))).size;
result.resumed=await main(['deploy','--target',config,'--fixture-host','--development','--package',packageRoot,'--expected-current',expected,'--operation-id',operationId]);
result.replayed=await main(['deploy','--target',config,'--fixture-host','--development','--package',packageRoot,'--expected-current',expected,'--operation-id',operationId]);assert.equal(result.replayed.replayed,true);
const nginxBefore=await readFile(target.nginx.configPath),inode=(await lstat(target.nginx.configPath)).ino;let validations=0;
await assert.rejects(applyNginxConfigInPlace(target.nginx.configPath,target,{expectedSha256:nginxSha(nginxBefore),maintenance:true,validate:()=>command(target.runtime.dockerBinary,['exec',target.nginx.container,'nginx','-t',...(validations++===0?['-c','/nonexistent-fixture-config']:[])]),reload:()=>command(target.runtime.dockerBinary,['exec',target.nginx.container,'nginx','-s','reload']),readBack:()=>command(target.runtime.dockerBinary,['exec',target.nginx.container,'cat','/etc/nginx/conf.d/default.conf'],{raw:true})}));
assert.equal(nginxSha(await readFile(target.nginx.configPath)),nginxSha(nginxBefore));assert.equal((await lstat(target.nginx.configPath)).ino,inode);result.nginxValidationRollback='ACTUAL_NGINX_FAILURE_RESTORED_BYTES_AND_INODE';
const completed=JSON.parse(await readFile(stateFile));assert.equal((await readdir(path.join(target.hostRoot,'instances'))).length,1);assert.deepEqual(await readdir(path.join(completed.current.runtime.root,'scratch')),[]);
result.maximumCompleteCopies=3;result.completeScratchArchives=0;result.status='PASS';await writeFile(path.join(fixture,'interruption-evidence.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
