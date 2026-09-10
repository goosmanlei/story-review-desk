import {lstat,readFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import {normalizeBasePath} from './deployment-http.mjs';

const text=(value,name,pattern,max=500)=>{if(typeof value!=='string'||!value||value.length>max||!pattern.test(value))throw Error(`Invalid VPS target ${name}`);return value;};
const exact=(value,keys,name)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==[...keys].sort().join(','))throw Error(`Unexpected VPS target ${name} fields`);return value;};
export const EXISTING_NGINX_AUTH='FROM_EXISTING_HTTPS_SERVER';
const absolute=(value,name)=>{
 text(value,name,/^\/[A-Za-z0-9._/-]+$/);
 if(value==='/'||value.endsWith('/')||value.split('/').slice(1).some(part=>!part||part==='.'||part==='..'))throw Error(`Unsafe VPS target ${name}`);
 return value;
};

export function validateVpsTarget(input){
 const value=exact(input,['schemaVersion','kind','targetId','sshHost','publicUrl','basePath','hostRoot','nginx','runtime','credentials','retention','capacity',...(Object.hasOwn(input||{},'accessMode')?['accessMode']:[])],'root');
 const accessMode=value.accessMode??'BASIC_AUTH';
 if(!['BASIC_AUTH','PUBLIC_DEMO'].includes(accessMode))throw Error('Invalid VPS target accessMode');
 if(value.schemaVersion!=='1.0'||value.kind!=='REVIEW_VPS_TARGET')throw Error('Unsupported VPS target schema');
 const basePath=normalizeBasePath(value.basePath);
 let publicUrl;try{publicUrl=new URL(value.publicUrl);}catch{throw Error('Invalid VPS target publicUrl');}
 if(publicUrl.protocol!=='https:'||publicUrl.username||publicUrl.password||publicUrl.search||publicUrl.hash||publicUrl.pathname.replace(/\/$/,'')!==basePath)throw Error('VPS publicUrl must be HTTPS and match basePath');
 const nginx=exact(value.nginx,['container','configPath','network','serverName','authBasicRealm','authBasicUserFile'],'nginx');
 if((nginx.authBasicRealm===EXISTING_NGINX_AUTH)!==(nginx.authBasicUserFile===EXISTING_NGINX_AUTH))throw Error('Both Basic Auth fields must resolve together from the existing server');
 if(nginx.serverName!==publicUrl.hostname)throw Error('Nginx serverName differs from publicUrl');
 const runtime=exact(value.runtime,['architecture','dockerBinary','bashBinary','nodeBinary','codexBinary','uvBinary','pythonBinary'],'runtime');
 if(runtime.architecture!=='linux/amd64')throw Error('VPS package target architecture must be linux/amd64');
 const credentials=exact(value.credentials,['codexHome','providerKeyFile'],'credentials');
 const retention=exact(value.retention,['cleanPackages','maxTemporaryBytes','reserveBytes'],'retention');
 const capacity=exact(value.capacity,['recommendedVcpu','recommendedMemoryBytes','recommendedDiskBytes'],'capacity');
 for(const [name,number] of Object.entries({...retention,...capacity}))if(!Number.isSafeInteger(number)||number<=0)throw Error(`Invalid VPS target ${name}`);
 if(retention.cleanPackages!==2||retention.maxTemporaryBytes>=retention.reserveBytes)throw Error('VPS retention must keep two clean packages and bound temporary bytes below reserve');
 const forbidden=JSON.stringify(value);if(/(?:api[_-]?key|password|secret|token)"\s*:\s*"(?!\/)/i.test(forbidden))throw Error('VPS target contains credential material instead of a path reference');
 if(value.hostRoot.split('/').filter(Boolean).length<4||path.posix.basename(value.hostRoot)!==value.targetId)throw Error('hostRoot must be a dedicated deep directory ending in targetId');
 return Object.freeze({schemaVersion:'1.0',kind:'REVIEW_VPS_TARGET',accessMode,targetId:text(value.targetId,'targetId',/^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/),sshHost:text(value.sshHost,'sshHost',/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/),publicUrl:publicUrl.href,basePath,hostRoot:absolute(value.hostRoot,'hostRoot'),nginx:{container:text(nginx.container,'nginx.container',/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/),configPath:absolute(nginx.configPath,'nginx.configPath'),network:text(nginx.network,'nginx.network',/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/),serverName:nginx.serverName,authBasicRealm:text(nginx.authBasicRealm,'nginx.authBasicRealm',/^[A-Za-z0-9 _.-]{1,100}$/),authBasicUserFile:nginx.authBasicUserFile===EXISTING_NGINX_AUTH?EXISTING_NGINX_AUTH:absolute(nginx.authBasicUserFile,'nginx.authBasicUserFile')},runtime:{architecture:runtime.architecture,...Object.fromEntries(['dockerBinary','bashBinary','nodeBinary','codexBinary','uvBinary','pythonBinary'].map(key=>[key,absolute(runtime[key],`runtime.${key}`)]))},credentials:{codexHome:absolute(credentials.codexHome,'credentials.codexHome'),providerKeyFile:absolute(credentials.providerKeyFile,'credentials.providerKeyFile')},retention:{...retention},capacity:{...capacity}});
}

export async function readVpsTarget(filename){
 const resolved=path.resolve(filename),info=await lstat(resolved);if(!info.isFile()||info.isSymbolicLink()||await realpath(resolved)!==resolved)throw Error('VPS target must be a canonical regular JSON file');
 return validateVpsTarget(JSON.parse(await readFile(resolved,'utf8')));
}
