import {spawn} from 'node:child_process';
import {readFile,mkdir,lstat,realpath,readdir} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {VpsDriver} from '../host/instance-runtime/vps-driver.mjs';
import {validateVpsTarget} from '../host/instance-runtime/vps-target.mjs';
import {emptyVpsState,executeVps,planVps} from '../host/instance-runtime/vps-journal.mjs';
import {validatePackageManifest} from '../host/instance-runtime/vps-package.mjs';
import {WireInput,rpcSource,writeWire} from '../host/instance-runtime/vps-wire.mjs';

async function withLock(root,pythonBinary,run){
 const child=spawn(pythonBinary,['-u','-c',"import fcntl,sys; f=open(sys.argv[1],'a'); fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB); print('LOCKED',flush=True); sys.stdin.read()",path.join(root,'.publisher.lock')],{stdio:['pipe','pipe','pipe']});
 const acquired=new Promise((resolve,reject)=>{child.once('error',reject);child.stdout.once('data',bytes=>bytes.toString()==='LOCKED\n'?resolve():reject(Error('Unexpected publisher lock response')));child.once('exit',code=>reject(Error('Publisher is already locked or flock unavailable: '+code)));});
 try{await acquired;return await run();}finally{child.stdin.end();}
}
export async function runHost(control,sourceOverride){
 const target=validateVpsTarget(control.target),root=target.hostRoot,allowDevelopment=control.fixture===true;
 if(allowDevelopment&&(target.sshHost!=='fixture-only'||!root.includes('/.test-tmp/')))throw Error('Fixture mode requires an isolated .test-tmp path and fixture-only target');
 let state;try{state=JSON.parse(await readFile(path.join(root,'state.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;state=emptyVpsState(target);}
 if(state.targetSha256!==emptyVpsState(target).targetSha256)throw Error('Prepared target configuration changed');
 const driver=new VpsDriver(target,state,{allowDevelopment});
 const publicState=()=>{const result=structuredClone(state);if(result.nginxIntent)delete result.nginxIntent.beforeContents;return result;};
 if(control.action==='inspect')return {...await driver.inspect(),state:publicState()};
 if(control.action==='status')return {state:publicState(),actual:await driver.inspect()};
 if(control.action==='plan')return planVps(target,state,validatePackageManifest(control.manifest,{target,allowDevelopment}),await driver.inspect());
 if(!control.expectedCurrent||!control.operationId)throw Error('Mutations require expectedCurrent and operationId');
 if(control.action==='prepare-host'){
  if(control.expectedCurrent!==(state.current?.releaseId||'NONE'))throw Error('Host preparation release CAS mismatch');
  try{const info=await lstat(root);if(!info.isDirectory()||info.isSymbolicLink()||await realpath(root)!==root)throw Error('Unsafe deployment root');if(!state.prepared&&(await readdir(root)).some(n=>!['state.json','.publisher.lock'].includes(n)))throw Error('Unowned files exist in target root');}catch(error){if(error.code!=='ENOENT')throw error;await mkdir(root,{recursive:true,mode:0o700});}
  return withLock(root,target.runtime.pythonBinary,async()=>{
   try{state=JSON.parse(await readFile(path.join(root,'state.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;state=emptyVpsState(target);}
   if(state.targetSha256!==emptyVpsState(target).targetSha256||control.expectedCurrent!==(state.current?.releaseId||'NONE')||state.pending)throw Error('Host preparation state changed or publication is unfinished');
   driver.state=state;
   const inspection=await driver.inspect();
   for(const key of ['nodeBinary','dockerBinary','bashBinary','compose'])if(inspection.dependencies[key]?.status!=='AVAILABLE')throw Error('Install/repair host dependency before preparation: '+key);
   if(!inspection.nginxRunning||!inspection.nginxMount)throw Error('Existing Nginx HTTPS single-file mount was not found');
   const network=await driver.object('network',target.nginx.network);
   if(network&&network.Labels?.['review.vps.target']!==target.targetId)throw Error('Ingress network belongs to another owner');
   if(!network)await driver.docker(['network','create','--label','review.vps.target='+target.targetId,target.nginx.network]);
   const nginx=await driver.object('container',target.nginx.container);if(!nginx.NetworkSettings.Networks[target.nginx.network])await driver.docker(['network','connect',target.nginx.network,target.nginx.container]);
   state.nginxSha256||=inspection.nginxSha256;await driver.save(state);
   // Preparing an already published host never moves its location to maintenance.
   if(!state.prepared)await driver.nginx({maintenance:true});
   state.prepared=true;await driver.save(state);return {status:'HOST_PREPARED',targetId:target.targetId,requiresFreshInspect:true,credentials:inspection.credentials};
  });
 }
 if(!state.prepared)throw Error('Run prepare-host and inspect before publication');
 return withLock(root,target.runtime.pythonBinary,async()=>{
  // Re-read inside the exclusive lock; pre-lock state is diagnostic only.
  state=JSON.parse(await readFile(path.join(root,'state.json'),'utf8'));driver.state=state;
  let source=sourceOverride;
  if(control.action==='rollback'){
   const wanted=state.pending?.manifest?.releaseId;
   const clean=wanted?[state.current,state.backup].find(r=>r?.releaseId===wanted):state.backup;
   if(!clean)throw Error('Previous clean release is not available');source=await driver.cleanSource(clean);
  }else if(!source){const manifest=validatePackageManifest(control.manifest,{target,allowDevelopment});source=rpcSource(manifest,new WireInput(process.stdin),process.stdout);}
  return executeVps({target,state,source,driver,expectedCurrent:control.expectedCurrent,operationId:control.operationId,action:control.action,recover:control.recover===true});
 });
}
if(globalThis.REVIEW_VPS_CONTROL){
 try{const result=await runHost(globalThis.REVIEW_VPS_CONTROL);await writeWire(process.stdout,JSON.stringify({type:'RESULT',result})+'\n');}
 catch(error){await writeWire(process.stdout,JSON.stringify({type:'ERROR',message:String(error.message||error)})+'\n');process.exitCode=1;}
}
