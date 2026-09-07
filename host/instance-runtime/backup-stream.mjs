import {createReadStream,createWriteStream} from 'node:fs';
import {mkdir,readFile,realpath,lstat,open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createGzip,createGunzip} from 'node:zlib';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import path from 'node:path';
import {canonicalJson,sha256} from './bytes.mjs';

export const BACKUP_STREAM_FORMAT='REVIEW_BACKUP_STREAM_1';
const MAX_LINE=4*1024*1024,CHUNK=48*1024;
function entries(manifest){
  const {manifestSha256,...body}=manifest;
  if(body.kind!=='REVIEW_INSTANCE_BACKUP'||!['1.0','2.0'].includes(body.schemaVersion)||sha256(canonicalJson(body))!==manifestSha256)throw Error('备份清单无效');
  const rows=[body.database,...body.files],seen=new Set();
  for(const row of rows){
    if(!row||typeof row.path!=='string'||row.path.includes('\\')||row.path.startsWith('/')||row.path.split('/').some(part=>!part||part==='.'||part==='..')||seen.has(row.path)||row.path==='backup-manifest.json'||!Number.isSafeInteger(row.bytes)||row.bytes<0||!/^([a-f0-9]{64})$/.test(row.sha256))throw Error('备份文件身份或路径无效');
    seen.add(row.path);
  }
  return rows;
}
async function checkedFile(root,relative){const file=path.join(root,relative),stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||await realpath(file)!==file)throw Error('备份文件不能经由符号链接');return file;}
export async function packBackup(root,destination){
  root=await realpath(root);const manifest=JSON.parse(await readFile(await checkedFile(root,'backup-manifest.json'),'utf8')),files=entries(manifest);
  async function* lines(){
    yield JSON.stringify({format:BACKUP_STREAM_FORMAT,manifest})+'\n';
    for(const file of files){
      const input=await checkedFile(root,file.path),digest=createHash('sha256');let offset=0;
      for await(const bytes of createReadStream(input,{highWaterMark:CHUNK})){digest.update(bytes);yield JSON.stringify({file:file.path,offset,data:bytes.toString('base64')})+'\n';offset+=bytes.length;}
      if(offset!==file.bytes||digest.digest('hex')!==file.sha256)throw Error('备份文件校验失败：'+file.path);
      yield JSON.stringify({end:file.path,bytes:offset,sha256:file.sha256})+'\n';
    }
    yield JSON.stringify({complete:manifest.manifestSha256,files:files.length})+'\n';
  }
  await pipeline(Readable.from(lines()),createGzip(),createWriteStream(destination,{flags:'wx',mode:0o600}));
  return {format:BACKUP_STREAM_FORMAT,path:destination,manifestSha256:manifest.manifestSha256};
}
async function* boundedLines(stream){
  let buffered=Buffer.alloc(0);
  for await(const chunk of stream){
    buffered=Buffer.concat([buffered,chunk]);let newline;
    while((newline=buffered.indexOf(10))>=0){if(newline>MAX_LINE)throw Error('备份记录过长');yield buffered.subarray(0,newline).toString('utf8');buffered=buffered.subarray(newline+1);}
    if(buffered.length>MAX_LINE)throw Error('备份记录过长');
  }
  if(buffered.length)throw Error('备份文件被截断');
}
export async function unpackBackup(archive,destination){
  const stat=await lstat(archive);if(!stat.isFile()||stat.isSymbolicLink())throw Error('导入文件必须是普通文件');
  archive=await realpath(archive);
  await mkdir(destination,{mode:0o700});
  const source=createReadStream(archive),decoded=createGunzip();source.on('error',error=>decoded.destroy(error));source.pipe(decoded);
  let manifest,files=[],index=0,handle=null,digest,offset=0,completed=false;
  try{
    for await(const line of boundedLines(decoded)){
      const record=JSON.parse(line);
      if(!manifest){if(record.format!==BACKUP_STREAM_FORMAT)throw Error('不是审阅台完整备份文件');manifest=record.manifest;files=entries(manifest);continue;}
      if(completed)throw Error('备份结束后仍含记录');
      if(record.complete){if(record.complete!==manifest.manifestSha256||record.files!==files.length||index!==files.length||handle)throw Error('备份尚不完整');completed=true;continue;}
      const expected=files[index];if(!expected)throw Error('备份包含额外文件');
      if(!handle){const output=path.join(destination,expected.path);await mkdir(path.dirname(output),{recursive:true,mode:0o700});handle=await open(output,'wx',0o600);digest=createHash('sha256');offset=0;}
      if(record.end){
        if(record.end!==expected.path||record.bytes!==offset||offset!==expected.bytes||record.sha256!==expected.sha256||digest.digest('hex')!==expected.sha256)throw Error('导入文件校验失败：'+expected.path);
        await handle.sync();await handle.close();handle=null;index++;continue;
      }
      if(record.file!==expected.path||record.offset!==offset||typeof record.data!=='string'||record.data.length>CHUNK*4/3||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(record.data))throw Error('备份块顺序或内容无效');
      const bytes=Buffer.from(record.data,'base64');if(offset+bytes.length>expected.bytes)throw Error('备份文件超过声明长度');
      await handle.writeFile(bytes);digest.update(bytes);offset+=bytes.length;
    }
    if(!completed)throw Error('备份缺少完成标记');
    const output=await open(path.join(destination,'backup-manifest.json'),'wx',0o600);try{await output.writeFile(JSON.stringify(manifest,null,2)+'\n');await output.sync();}finally{await output.close();}
    return {output:destination,manifestSha256:manifest.manifestSha256,instanceId:manifest.instanceId};
  }finally{await handle?.close();source.destroy();decoded.destroy();}
}
