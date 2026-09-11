import {createReadStream} from 'node:fs';
import {readFile,open,lstat} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {check,hash,canonical} from './shared/contracts.mjs';
import {transaction} from './db.mjs';
import {validateConfiguration} from './project/service.mjs';
import {moduleFor} from './modules.mjs';

import {TABLES,fileSha,ORDER_KEYS} from './transport-contract.mjs';
export {TABLES,fileSha,ORDER_KEYS} from './transport-contract.mjs';
const jsonColumns=new Set(['content','evidence','findings']);
export async function* exportRecords(pool){
  const tx=await pool.connect();let complete=false;
  try{
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const project=(await tx.query('SELECT instance_id,title FROM project')).rows[0];
    yield JSON.stringify({type:'manifest',format:'review-project',version:1,originInstanceId:project.instance_id,title:project.title})+'\n';
    for(const [table,columns] of Object.entries(TABLES)){
      const selected=columns.map(c=>c==='content_bytes'?"encode(content_bytes,'base64') AS content_bytes":'"'+c+'"').join(',');
      await tx.query(`DECLARE transfer_cursor NO SCROLL CURSOR FOR SELECT ${selected} FROM ${table} ORDER BY ${(ORDER_KEYS[table]||columns.slice(0,table==='objects'||table==='revisions'?1:2)).map(c=>'"'+c+'"').join(',')}`);
      for(;;){const rows=(await tx.query('FETCH FORWARD 100 FROM transfer_cursor')).rows;if(!rows.length)break;for(const row of rows)yield JSON.stringify({type:'row',table,row})+'\n';}
      await tx.query('CLOSE transfer_cursor');
    }
    await tx.query('COMMIT');complete=true;
  }finally{if(!complete)await tx.query('ROLLBACK').catch(()=>{});tx.release();}
}

export async function importRecords(pool,filename,{expectedSha256,mediaRoot,operationId}={}){
  check(await fileSha(filename)===expectedSha256,'PACKAGE_HASH','项目数据 SHA 不符',409);
  return transaction(pool,async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(890670314)');
    await tx.query('SELECT pg_advisory_xact_lock(890670312)');
    check((await tx.query('SELECT 1 FROM objects LIMIT 1')).rowCount===0,'IMPORT_TARGET_NOT_EMPTY','普通导入只写入空白项目，请在独立新项目中恢复',409);
    await tx.query('SET CONSTRAINTS ALL DEFERRED');
    // Existing blank defaults belong to the empty target and are replaced by the package.
    await tx.query('DELETE FROM configurations');
    let manifest=null;const counts={},media=[];
    const input=createInterface({input:createReadStream(filename),crlfDelay:Infinity});
    try{for await(const line of input){
      check(Buffer.byteLength(line)<=64*1024*1024,'RECORD_TOO_LARGE','单条传输记录超过 64 MiB；请将来源分块',413);
      const entry=JSON.parse(line);
      if(!manifest){check(entry.type==='manifest'&&entry.format==='review-project'&&entry.version===1,'PACKAGE_FORMAT','项目包格式或版本无效');manifest=entry;continue;}
      check(entry.type==='row'&&Object.hasOwn(TABLES,entry.table),'PACKAGE_TABLE','项目包包含未知模块');
      const columns=TABLES[entry.table],row=entry.row;
      check(row&&Object.keys(row).every(c=>columns.includes(c)),'PACKAGE_COLUMNS','项目包包含未声明字段');
      if(entry.table==='objects')check(moduleFor(row.kind).name===row.module,'OBJECT_MODULE','对象类型与所属模块不符');
      if(entry.table==='revisions')check(hash(row.content)===row.sha256,'REVISION_HASH','修订正文 SHA 不符',409,{id:row.id});
      if(entry.table==='configurations')validateConfiguration(row.scope,row.content);
      if(entry.table==='source_documents')check(hash(Buffer.from(row.content_bytes,'base64'))===row.original_sha256,'SOURCE_HASH','原始来源字节 SHA 不符',409,{id:row.original_revision_id});
      if(entry.table==='media'&&row.availability==='PRESENT')media.push(row);
      const fields=columns.filter(c=>Object.hasOwn(row,c));
      await tx.query(`INSERT INTO ${entry.table}(${fields.map(c=>'"'+c+'"').join(',')}) VALUES(${fields.map((c,i)=>'$'+(i+1)).join(',')})`,fields.map(c=>c==='content_bytes'?Buffer.from(row[c],'base64'):jsonColumns.has(c)?JSON.stringify(row[c]):row[c]));
      counts[entry.table]=(counts[entry.table]||0)+1;
    }}finally{input.close();}
    check(manifest,'PACKAGE_EMPTY','项目包为空');
    const checked=new Set();for(const row of media){
      if(checked.has(row.sha256))continue;checked.add(row.sha256);
      check(/^[a-f0-9]{64}$/.test(row.sha256),'MEDIA_HASH','媒体 SHA 无效');
      const filename=path.join(mediaRoot,row.sha256),info=await lstat(filename).catch(()=>null);
      check(info?.isFile()&&!info.isSymbolicLink()&&info.size===Number(row.byte_size)&&await fileSha(filename)===row.sha256,'MEDIA_INTEGRITY','媒体文件缺失或 SHA 不符',409,{id:row.id,versionId:row.version_id});
    }
    await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
    await tx.query('UPDATE project SET title=$1',[manifest.title]);
    const result={operationId,status:'SUCCEEDED',formatVersion:1,originInstanceId:manifest.originInstanceId,counts,verifiedMedia:checked.size};
    if(operationId)await tx.query("UPDATE operations SET status='SUCCEEDED',result=$2,updated_at=now() WHERE id=$1",[operationId,result]);
    return result;
  },{timeoutMs:120000});
}
