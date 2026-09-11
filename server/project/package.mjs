import {createReadStream,createWriteStream} from 'node:fs';
import {mkdir,readFile,writeFile,lstat,open} from 'node:fs/promises';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';
import {Readable} from 'node:stream';
import {createInterface} from 'node:readline';
import {createHash,randomUUID} from 'node:crypto';
import {check} from '../shared/contracts.mjs';
import {fileSha,TABLES} from '../transport-contract.mjs';

const exists=async p=>Boolean(await lstat(p).catch(()=>null));
async function fetchOk(url,options){const response=await fetch(url,options);if(!response.ok){const error=await response.json().catch(()=>null);check(false,'TRANSFER_HTTP',error?.error?.message||`传输失败：HTTP ${response.status}`,response.status);}return response;}
export async function waitOperation(base,id,{timeoutMs=20*60*1000}={}){
  const deadline=Date.now()+timeoutMs;
  for(;;){const value=await (await fetchOk(new URL('api/v1/operations/'+encodeURIComponent(id),base))).json();
    if(value.status==='SUCCEEDED')return value.result||value;
    check(!['FAILED','CANCELLED','RESULT_UNKNOWN'].includes(value.status),'OPERATION_'+value.status,value.error?.message||value.status,409,{operationId:id});
    check(Date.now()<deadline,'RESULT_UNKNOWN','等待超时；请使用原操作编号查询，不能直接重发',409,{operationId:id});
    await new Promise(resolve=>setTimeout(resolve,200));
  }
}
export async function* packageStream(directory,manifest){
  yield Buffer.from(JSON.stringify(manifest.project)+'\n');
  for(const chunk of manifest.chunks)for await(const bytes of createReadStream(path.join(directory,chunk.path)))yield bytes;
}
export async function writePackageRecords(input,destination,{copyMedia}={}){
  check(!await exists(destination),'DESTINATION_EXISTS','导出目录已存在；不覆盖未知文件',409);
  await mkdir(destination,{recursive:true,mode:0o700});await mkdir(path.join(destination,'media'));await mkdir(path.join(destination,'originals'));
  const objectModules=new Map(),revisionModules=new Map(),media=new Map(),originals=new Set(),chunks=new Map(),currentChunks=new Map(),counts={};let header;
  const moduleOf=e=>objectModules.get(e.row.object_id||e.row.owner_id||e.row.episode_id)||revisionModules.get(e.row.revision_id||e.row.consumer_revision_id)||'project';
  try{for await(const line of createInterface({input,crlfDelay:Infinity})){
    const e=JSON.parse(line);if(!header){check(e.type==='manifest'&&e.format==='review-project'&&e.version===1,'PACKAGE_FORMAT','导出数据格式无效');header=e;continue;}
    check(e.type==='row'&&Object.hasOwn(TABLES,e.table),'PACKAGE_TABLE','数据包含未知模块');
    if(e.table==='objects')objectModules.set(e.row.id,e.row.module);
    if(e.table==='revisions')revisionModules.set(e.row.id,objectModules.get(e.row.object_id));
    const module=e.table==='objects'?e.row.module:moduleOf(e);check(['story','settings','materials','production','collaboration','project'].includes(module),'PACKAGE_MODULE','业务模块无效');
    const family=module+'/'+e.table,bytes=Buffer.byteLength(line)+1;let chunk=currentChunks.get(family);
    if(!chunk||chunk.count>0&&chunk.bytes+bytes>16*1024*1024){const part=(chunk?.part??-1)+1,relative=`data/${module}/${e.table}-${String(part).padStart(4,'0')}.ndjson`;await mkdir(path.dirname(path.join(destination,relative)),{recursive:true});chunk={path:relative,table:e.table,module,part,bytes:0,count:0,handle:await open(path.join(destination,relative),'wx',0o600)};chunks.set(relative,chunk);currentChunks.set(family,chunk);}
    await chunk.handle.writeFile(line+'\n');chunk.count++;chunk.bytes+=bytes;counts[e.table]=(counts[e.table]||0)+1;
    if(e.table==='media'&&e.row.availability==='PRESENT')media.set(e.row.sha256,{sha256:e.row.sha256,bytes:Number(e.row.byte_size)});
    if(e.table==='source_documents'&&!originals.has(e.row.original_sha256)){
      const content=Buffer.from(e.row.content_bytes,'base64'),sha=e.row.original_sha256;
      check(createHash('sha256').update(content).digest('hex')===sha,'SOURCE_HASH','原始资料 SHA 不符');
      await writeFile(path.join(destination,'originals',sha),content,{flag:'wx',mode:0o600});originals.add(sha);
    }
  }}finally{for(const chunk of chunks.values())await chunk.handle.close();}
  check(header,'PACKAGE_EMPTY','导出内容为空');
  const tableOrder=Object.keys(TABLES),parts=[];
  for(const chunk of [...chunks.values()].sort((a,b)=>tableOrder.indexOf(a.table)-tableOrder.indexOf(b.table)||a.path.localeCompare(b.path))){
    const {handle,...part}=chunk;part.sha256=await fileSha(path.join(destination,chunk.path));part.bytes=(await lstat(path.join(destination,chunk.path))).size;parts.push(part);
  }
  for(const m of media.values()){
    check(typeof copyMedia==='function','MEDIA_PROVIDER_REQUIRED','导出需要登记媒体');
    const filename=path.join(destination,'media',m.sha256);await copyMedia(m,filename);
    check((await lstat(filename)).size===m.bytes&&await fileSha(filename)===m.sha256,'MEDIA_HASH','导出媒体 SHA 不符',409);
  }
  const manifest={format:'review-project-package',version:2,project:header,chunks:parts,counts,media:[...media.values()],originals:[...originals].sort()};
  let bytes=0;const digest=createHash('sha256');for await(const chunk of packageStream(destination,manifest)){bytes+=chunk.length;digest.update(chunk);}manifest.transfer={sha256:digest.digest('hex'),bytes};
  await writeFile(path.join(destination,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});return manifest;
}
export async function exportPackage(base,destination){
  const response=await fetchOk(new URL('api/v1/export',base));
  return writePackageRecords(Readable.fromWeb(response.body),destination,{copyMedia:async(m,file)=>{
    const r=await fetchOk(new URL('api/v1/media/'+m.sha256,base));await pipeline(Readable.fromWeb(r.body),createWriteStream(file,{flags:'wx',mode:0o600}));
  }});
}
export async function verifyPackage(directory){
  const info=await lstat(directory);check(info.isDirectory()&&!info.isSymbolicLink(),'PACKAGE_DIRECTORY','项目包必须是普通目录');
  const manifestInfo=await lstat(path.join(directory,'manifest.json'));check(manifestInfo.isFile()&&!manifestInfo.isSymbolicLink()&&manifestInfo.size<=8*1024*1024,'PACKAGE_MANIFEST','项目包清单无效');
  const manifest=JSON.parse(await readFile(path.join(directory,'manifest.json'),'utf8'));
  check(manifest.format==='review-project-package'&&manifest.version===2&&Array.isArray(manifest.chunks),'PACKAGE_FORMAT','项目包格式无效');
  const checkedDirectories=new Set();
  async function verify(relative,sha,bytes){
    check(/^[a-f0-9]{64}$/.test(sha)&&!path.isAbsolute(relative)&&relative.split('/').every(p=>p&&p!=='.'&&p!=='..'),'PACKAGE_HASH','包内路径或 SHA 无效');
    const parents=relative.split('/').slice(0,-1);let parent=directory;
    for(const part of parents){parent=path.join(parent,part);if(!checkedDirectories.has(parent)){const s=await lstat(parent);check(s.isDirectory()&&!s.isSymbolicLink(),'PACKAGE_DIRECTORY','包内目录不能使用符号链接');checkedDirectories.add(parent);}}
    const file=path.join(directory,relative),s=await lstat(file);check(s.isFile()&&!s.isSymbolicLink()&&(bytes===undefined||s.size===bytes)&&await fileSha(file)===sha,'PACKAGE_INTEGRITY','项目包文件缺失或内容改变',409,{path:relative});
  }
  const seen=new Set();for(const chunk of manifest.chunks){check(Object.hasOwn(TABLES,chunk.table)&&['story','settings','materials','production','collaboration','project'].includes(chunk.module)&&chunk.path===`data/${chunk.module}/${chunk.table}-${String(chunk.part).padStart(4,'0')}.ndjson`&&!seen.has(chunk.path),'PACKAGE_CHUNK','项目数据分块无效');seen.add(chunk.path);await verify(chunk.path,chunk.sha256,chunk.bytes);}
  for(const media of manifest.media)await verify('media/'+media.sha256,media.sha256,media.bytes);
  for(const sha of manifest.originals)await verify('originals/'+sha,sha);
  const digest=createHash('sha256');let bytes=0;for await(const chunk of packageStream(directory,manifest)){digest.update(chunk);bytes+=chunk.length;}
  check(digest.digest('hex')===manifest.transfer.sha256&&bytes===manifest.transfer.bytes,'PACKAGE_TRANSFER_HASH','项目分块组合 SHA 不符');return manifest;
}
export async function importPackage(base,directory,{operationId=randomUUID()}={}){
  const runtimeEpoch=(await (await fetchOk(new URL('api/v1/health',base))).json()).project.runtimeEpoch;
  const manifest=await verifyPackage(directory);
  const upload=async(route,body,bytes,query)=>{
    const url=new URL('api/v1/'+route,base);for(const [key,value] of Object.entries(query))url.searchParams.set(key,String(value));
    const response=await fetchOk(url,{method:'POST',headers:{'x-review-runtime':runtimeEpoch,'Content-Type':'application/octet-stream','Content-Length':String(bytes)},body,duplex:'half'});const receipt=await response.json();return waitOperation(base,receipt.operationId);
  };
  let index=0;await Promise.all(Array.from({length:Math.min(4,manifest.media.length)},async()=>{while(index<manifest.media.length){const media=manifest.media[index++],id='blob-'+createHash('sha256').update(operationId+'\0'+media.sha256).digest('hex');await upload('upload',createReadStream(path.join(directory,'media',media.sha256)),media.bytes,{sha256:media.sha256,operationId:id,forImport:true});}}));
  return upload('import',Readable.from(packageStream(directory,manifest)),manifest.transfer.bytes,{sha256:manifest.transfer.sha256,operationId});
}
