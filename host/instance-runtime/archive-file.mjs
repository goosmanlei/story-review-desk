import {createReadStream} from 'node:fs';
import {open,readFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {createHash} from 'node:crypto';
import {canonicalJson} from './bytes.mjs';
import {canonicalSha256} from './archive-integrity.mjs';
export const ARCHIVE_FILE_FORMAT='REVIEW_REPOSITORY_ARCHIVE_NDJSON_1';

/** Each immutable row is a bounded JSON record; never join the entire archive. */
export async function writeArchiveFile(filename,archive){
 const {tables,...header}=archive,tableNames=Object.keys(tables).sort(),handle=await open(filename,'wx',0o600),digest=createHash('sha256');let bytes=0,rows=0;
 async function line(value){const content=Buffer.from(canonicalJson(value)+'\n');let offset=0;while(offset<content.length){const result=await handle.write(content,offset,content.length-offset);if(!result.bytesWritten)throw Error('Archive write made no progress');offset+=result.bytesWritten;}digest.update(content);bytes+=content.length;}
 try{await line({format:ARCHIVE_FILE_FORMAT,header,tableNames});for(const table of tableNames){if(!Array.isArray(tables[table]))throw Error('Invalid archive table');for(const row of tables[table]){await line({table,row});rows++;}}await line({end:true,rows});await handle.sync();}finally{await handle.close();}
 return {format:ARCHIVE_FILE_FORMAT,sha256:digest.digest('hex'),bytes};
}
export async function readArchiveFile(filename,format){
 if(format==='REVIEW_REPOSITORY_ARCHIVE_1')return JSON.parse(await readFile(filename,'utf8'));
 if(format!==ARCHIVE_FILE_FORMAT)throw Error('Unsupported repository archive format');
 const stream=createReadStream(filename),lines=createInterface({input:stream,crlfDelay:Infinity});let archive,tableNames,rows=0,ended=false;
 try{for await(const line of lines){
  if(!line||ended)throw Error('Unexpected archive record');const record=JSON.parse(line);
  if(!archive){
   if(record.format!==ARCHIVE_FILE_FORMAT||!record.header||'tables'in record.header||!Array.isArray(record.tableNames)||new Set(record.tableNames).size!==record.tableNames.length||record.tableNames.some(t=>typeof t!=='string'||!/^[_a-z]+$/.test(t)))throw Error('Invalid archive header');
   tableNames=new Set(record.tableNames);archive={...record.header,tables:Object.fromEntries(record.tableNames.map(t=>[t,[]]))};continue;
  }
  if(record.end===true){if(record.rows!==rows||Object.keys(record).sort().join(',')!=='end,rows')throw Error('Archive row count differs');ended=true;continue;}
  if(Object.keys(record).sort().join(',')!=='row,table'||!tableNames.has(record.table)||!record.row||typeof record.row!=='object'||Array.isArray(record.row))throw Error('Invalid archive row');
  archive.tables[record.table].push(record.row);rows++;
 }}finally{lines.close();stream.destroy();}
 if(!archive||!ended)throw Error('Incomplete archive');const {exportSha256,...body}=archive;if(canonicalSha256(body)!==exportSha256)throw Error('Archive hash differs');return archive;
}
