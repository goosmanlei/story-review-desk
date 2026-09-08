import {createReadStream} from 'node:fs';
import {open,readFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {createHash} from 'node:crypto';
import {canonicalJson} from './bytes.mjs';
import {canonicalSha256} from './archive-integrity.mjs';
export const ARCHIVE_FILE_FORMAT='REVIEW_REPOSITORY_ARCHIVE_NDJSON_1';

/** Canonical archive hash over encoded rows; never materializes a table.
 * The caller owns one frozen read snapshot across both passes. */
export async function hashArchiveRows(header,tableNames,iterate,{onRow,onTableEnd}={}){
 if(!header||typeof header!=='object'||Array.isArray(header)||'tables'in header||'exportSha256'in header)throw Error('Invalid streaming archive header');
 if(!Array.isArray(tableNames)||new Set(tableNames).size!==tableNames.length||tableNames.some(t=>typeof t!=='string'||!/^[_a-z]+$/.test(t)))throw Error('Invalid archive table names');
 const hash=createHash('sha256'),keys=[...Object.keys(header).filter(k=>header[k]!==undefined),'tables'].sort();let rows=0;
 hash.update('{');let firstKey=true;
 for(const key of keys){
  if(!firstKey)hash.update(',');firstKey=false;hash.update(JSON.stringify(key)+':');
  if(key!=='tables'){hash.update(canonicalJson(header[key]));continue;}
  hash.update('{');let firstTable=true;
  for(const table of [...tableNames].sort()){
   if(!firstTable)hash.update(',');firstTable=false;hash.update(JSON.stringify(table)+':[');let firstRow=true;
   for await(const row of iterate(table)){
    if(!row||typeof row!=='object'||Array.isArray(row))throw Error('Invalid archive row');
    if(!firstRow)hash.update(',');firstRow=false;hash.update(canonicalJson(row));
    if(onRow)await onRow(table,row);rows++;
    if(!Number.isSafeInteger(rows))throw Error('Archive row count exceeds safe range');
   }
   if(onTableEnd)await onTableEnd(table);hash.update(']');
  }
  hash.update('}');
 }
 hash.update('}');return{exportSha256:hash.digest('hex'),rows};
}

/** NDJSON_1 byte-compatible second pass, with a fail-closed first-pass binding. */
export async function writeArchiveRowsFile(filename,{header,tableNames,iterate,exportSha256,rows:expectedRows}){
 if(!/^[a-f0-9]{64}$/.test(exportSha256)||!Number.isSafeInteger(expectedRows)||expectedRows<0)throw Error('Invalid frozen archive binding');
 const handle=await open(filename,'wx',0o600),digest=createHash('sha256');let bytes=0,rows=0,failure;
 async function line(value){const content=Buffer.from(canonicalJson(value)+'\n');let offset=0;while(offset<content.length){const result=await handle.write(content,offset,content.length-offset);if(!result.bytesWritten)throw Error('Archive write made no progress');offset+=result.bytesWritten;}digest.update(content);bytes+=content.length;}
 try{
  await line({format:ARCHIVE_FILE_FORMAT,header:{...header,exportSha256},tableNames:[...tableNames].sort()});
  const actual=await hashArchiveRows(header,tableNames,iterate,{onRow:async(table,row)=>{await line({table,row});rows++;}});
  if(actual.exportSha256!==exportSha256||actual.rows!==expectedRows||rows!==expectedRows)throw Error('Frozen archive changed between validation and writing');
  await line({end:true,rows});await handle.sync();
 }catch(error){failure=error;throw error;}
 finally{try{await handle.close();}catch(error){if(!failure)throw error;}}
 return{format:ARCHIVE_FILE_FORMAT,sha256:digest.digest('hex'),bytes};
}

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
