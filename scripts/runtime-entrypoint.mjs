import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {existsSync} from 'node:fs';
import {configuredBasePath,deploymentMode} from '../host/instance-runtime/deployment-http.mjs';
import {createDeploymentGateway} from '../host/instance-runtime/deployment-gateway.mjs';

const contract=JSON.parse(await readFile(path.resolve('.review-build-contract.json'),'utf8'));
const expected={basePath:configuredBasePath(),deploymentMode:deploymentMode(),softwareCommit:process.env.REVIEW_SOFTWARE_COMMIT||'UNVERSIONED'};
for(const key of Object.keys(expected))if(contract[key]!==expected[key])throw Error(`Runtime ${key} differs from the immutable build contract`);
if(expected.deploymentMode==='VPS'){
  if(!process.env.REVIEW_PUBLIC_URL||!process.env.REVIEW_DEPLOYMENT_ID)throw Error('VPS runtime requires REVIEW_PUBLIC_URL and REVIEW_DEPLOYMENT_ID');
  if(process.env.REVIEW_REMOTE_READ_ONLY==='1')throw Error('VPS writable and hosted read-only modes are mutually exclusive');
}
const vps=expected.deploymentMode==='VPS';
if(vps)process.env.REVIEW_INTERNAL_GATEWAY_SECRET=randomBytes(32).toString('hex');
const gateway=vps?createDeploymentGateway({upstreamPort:3001,proxyIp:process.env.REVIEW_TRUSTED_PROXY_IP,secret:process.env.REVIEW_INTERNAL_GATEWAY_SECRET,basePath:expected.basePath,runtimeEpoch:process.env.REVIEW_RUNTIME_EPOCH,maintenance:()=>existsSync('/instance/runtime/vps-maintenance')}):null;
const child=spawn(process.execPath,['node_modules/vinext/dist/cli.js','start','--hostname',vps?'127.0.0.1':'0.0.0.0','--port',vps?'3001':process.env.PORT||'3000'],{stdio:'inherit',env:process.env});
if(gateway)gateway.listen(Number(process.env.PORT||3000),'0.0.0.0');
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.once('error',error=>{throw error;});
child.once('exit',(code,signal)=>{gateway?.close();process.exitCode=code??(signal?1:0);});
