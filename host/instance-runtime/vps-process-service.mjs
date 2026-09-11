import {lstat,mkdir,readFile,writeFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {sha256} from './bytes.mjs';
import {command} from './vps-process.mjs';
import {writeJsonAtomic} from './vps-package.mjs';

const absent=e=>e.code==='ENOENT';
export function processTimerUnits(target,script){
 const quote=s=>'"'+s.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('%','%%')+'"';
 const marker='# review-process-target='+target.targetId+'\n';
 return {service:marker+'[Unit]\nDescription=Review project process cleanup\n[Service]\nType=oneshot\nExecStart='+[target.runtime.nodeBinary,script].map(quote).join(' ')+'\nTimeoutStartSec=240\nUMask=0077\nStandardOutput=null\nStandardError=null\n',
 timer:marker+'[Unit]\nDescription=Review project process cleanup timer\n[Timer]\nOnBootSec=1min\nOnUnitActiveSec=5min\nPersistent=true\n[Install]\nWantedBy=timers.target\n'};
}
export async function installProcessTimer(target,bundle,{fixture=false}={}){
 if(typeof bundle!=='string'||Buffer.byteLength(bundle)>16*1024**2)throw Error('Invalid cleanup service bundle');
 const directory=path.join(target.hostRoot,'maintenance');await mkdir(directory,{recursive:true,mode:0o700});
 if(await realpath(directory)!==directory)throw Error('Cleanup service directory is aliased');
 const filename=path.join(directory,'process-cleanup.mjs'),ownerPath=path.join(directory,'process-cleanup-owner.json');
 let owner;try{owner=JSON.parse(await readFile(ownerPath));}catch(e){if(!absent(e))throw e;}
 try{const info=await lstat(filename),bytes=await readFile(filename);if(!info.isFile()||info.isSymbolicLink()||owner?.targetId!==target.targetId||owner.sha256!==sha256(bytes))throw Error('Cleanup service has unowned modifications');}catch(e){if(!absent(e))throw e;}
 const source="const {runHost}=await import('data:text/javascript;base64,"+Buffer.from(bundle).toString('base64')+"');\nconst receipt=await runHost("+JSON.stringify({action:'cleanup',target,fixture})+");if(receipt.status!=='CLEANED')process.exitCode=1;\n";
 await writeFile(filename,source,{mode:0o600});await writeJsonAtomic(ownerPath,{targetId:target.targetId,sha256:sha256(Buffer.from(source))});
 const system=process.getuid()===0,unitRoot=fixture?path.join(directory,'fixture-units'):system?'/etc/systemd/system':path.join(os.homedir(),'.config/systemd/user');
 const prefix=system?[]:['--user'],name='review-process-'+target.targetId,units=processTimerUnits(target,filename);
 await mkdir(unitRoot,{recursive:true});if(await realpath(unitRoot)!==unitRoot)throw Error('Service unit root is aliased');
 for(const [kind,contents] of Object.entries(units)){
  const file=path.join(unitRoot,name+'.'+kind);
  try{const st=await lstat(file),before=await readFile(file,'utf8');if(!st.isFile()||st.isSymbolicLink()||!before.startsWith('# review-process-target='+target.targetId+'\n'))throw Error('Existing unit belongs to another owner');}catch(e){if(!absent(e))throw e;}
  await writeFile(file,contents,{mode:0o644});
 }
 if(!fixture){
  const uid=String(process.getuid()),environment=system?process.env:{...process.env,XDG_RUNTIME_DIR:'/run/user/'+uid,DBUS_SESSION_BUS_ADDRESS:'unix:path=/run/user/'+uid+'/bus'};
  if(!system){
   const linger=await command('loginctl',['show-user',uid,'--property=Linger','--value']);
   if(linger.trim()!=='yes')await command('loginctl',['enable-linger',uid]);
   if((await command('loginctl',['show-user',uid,'--property=Linger','--value'])).trim()!=='yes')throw Error('User cleanup timer needs verified lingering across logout and reboot');
  }
  const ctl=args=>command('systemctl',[...prefix,...args],{env:environment});
  await ctl(['daemon-reload']);await ctl(['enable','--now',name+'.timer']);await ctl(['is-active',name+'.timer']);
 }
 return {status:fixture?'TIMER_FIXTURE_WRITTEN':'TIMER_INSTALLED',name,intervalSeconds:300,startup:true,sha256:sha256(Buffer.from(source)),unitRoot};
}
