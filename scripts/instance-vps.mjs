import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readVpsTarget} from '../host/instance-runtime/vps-target.mjs';
import {readPackage,verifyPackage} from '../host/instance-runtime/vps-package.mjs';
import {emptyVpsState,planVps} from '../host/instance-runtime/vps-journal.mjs';
import {WireInput,writeWire} from '../host/instance-runtime/vps-wire.mjs';
const sourceRoot=fileURLToPath(new URL('..',import.meta.url));
const quote=value=>"'"+String(value).replaceAll("'","'\\''")+"'";
// Never set a string decoder on stdin: subsequent file frames contain arbitrary
// binary image/media bytes. The sender waits for READ_FILE before sending them.
export const remoteBootstrap="let s=Buffer.alloc(0);const read=async c=>{s=Buffer.concat([s,c]);const i=s.indexOf(10);if(i<0){if(s.length>24000000)process.exit(2);return}process.stdin.pause();process.stdin.off('data',read);const v=JSON.parse(s.subarray(0,i).toString('utf8'));if(s.length!==i+1)throw Error('Unexpected bootstrap bytes');globalThis.REVIEW_VPS_CONTROL=v.control;await import('data:text/javascript;base64,'+v.code)};process.stdin.on('data',read);";
export async function remoteVps(control,source){
 if(process.env.REVIEW_VPS_OFFLINE==='1')throw Error('VPS access is explicitly disabled for this local-only implementation/rehearsal');
 const {build}=await import('esbuild');
 const built=await build({entryPoints:[path.join(sourceRoot,'scripts/instance-vps-host.mjs')],bundle:true,platform:'node',format:'esm',target:'node22',write:false,minify:true});
 const code=built.outputFiles[0].text;if(Buffer.byteLength(code)>16*1024**2)throw Error('Publisher control bundle exceeds temporary budget');
 const remote=[control.target.runtime.nodeBinary,'-e',remoteBootstrap].map(quote).join(' ');
 const child=spawn('ssh',['-T','-o','BatchMode=yes','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3',control.target.sshHost,remote],{stdio:['pipe','pipe','pipe']});
 let errorText='';child.stderr.on('data',chunk=>{errorText=(errorText+chunk).slice(-4000);});
 const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>code===0?resolve():reject(Error('SSH publication interrupted or failed: '+errorText)));});done.catch(()=>{});
 try{
  await writeWire(child.stdin,JSON.stringify({code:Buffer.from(code).toString('base64'),control})+'\n');
  const input=new WireInput(child.stdout);let result;
  for(;;){const event=await input.json();if(event.type==='READ_FILE'){
    const descriptor=source?.manifest.files.find(f=>f.path===event.path);if(!descriptor||descriptor.bytes!==event.bytes||descriptor.sha256!==event.sha256)throw Error('Remote requested an unregistered input');
    for await(const chunk of source.open(event.path))await writeWire(child.stdin,chunk);
   }else if(event.type==='RESULT'){result=event.result;break;}else if(event.type==='ERROR')throw Error(event.message);else throw Error('Invalid publisher protocol');}
  child.stdin.end();await done;return result;
 }catch(error){child.stdin.destroy();child.kill('SIGTERM');await done.catch(()=>{});throw error;}
}
export async function main(argv=process.argv.slice(2)){
 const {values,positionals}=parseArgs({args:argv,allowPositionals:true,options:{target:{type:'string'},package:{type:'string'},instance:{type:'string'},output:{type:'string'},inspection:{type:'string'},'expected-current':{type:'string'},'operation-id':{type:'string'},connect:{type:'boolean'},development:{type:'boolean'},'fixture-host':{type:'boolean'},'recover-current':{type:'boolean'},help:{type:'boolean'}}});
 if(values.help||!positionals[0])return {commands:['inspect','plan','pack','verify','prepare-host','deploy','rollback','status'],usage:'instance-vps COMMAND --target CONFIG [--connect] [--package DIR] [--expected-current RELEASE|NONE --operation-id STABLE_ID]',boundary:'pack/verify/offline plan are local; remote commands require --connect; no credentials are copied'};
 const action=positionals[0];if(!['inspect','plan','pack','verify','prepare-host','deploy','rollback','status'].includes(action)||positionals.length!==1||!values.target)throw Error('Explicit supported command and --target are required');
 const target=await readVpsTarget(values.target);
 if(action==='pack'){if(!values.instance||!values.output)throw Error('pack requires --instance and a new --output directory');const {packVps}=await import('./instance-vps-pack.mjs');return packVps({target,instance:values.instance,output:values.output,sourceRoot,development:values.development});}
 if(action==='verify'){if(!values.package)throw Error('verify requires --package');return verifyPackage(values.package,{target,allowDevelopment:values.development});}
 let source;if(values.package)source=await readPackage(values.package,{target,allowDevelopment:values.development});
 if(['deploy','plan'].includes(action)&&!source)throw Error(action+' requires --package');
 if(action==='plan'&&values.inspection){const inspection=JSON.parse(await readFile(values.inspection,'utf8'));return planVps(target,inspection.state||emptyVpsState(target),source.manifest,inspection);}
 const control={action,target,manifest:source?.manifest,expectedCurrent:values['expected-current'],operationId:values['operation-id'],recover:values['recover-current'],fixture:values['fixture-host']};
 if(values['fixture-host']){if(values.connect)throw Error('Fixture mode cannot connect over SSH');const {runHost}=await import('./instance-vps-host.mjs');return runHost(control,source);}
 if(!values.connect)throw Error('Remote access requires explicit --connect; use pack/verify or plan --inspection for offline work');
 if(values.development)throw Error('UNVERSIONED packages cannot be sent to a VPS');
 return remoteVps(control,source);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(JSON.stringify({status:'BLOCKED',error:String(error.message||error)}));process.exitCode=1;});
