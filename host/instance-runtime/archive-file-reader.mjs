import {constants} from 'node:fs';
import {open,lstat,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {ARCHIVE_FILE_FORMAT} from './archive-file.mjs';

export const DEFAULT_ARCHIVE_MAX_BYTES=4*1024**3;
export const DEFAULT_ARCHIVE_MAX_ROW_BYTES=128*1024**2;
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const check=(ok,code,message)=>{if(!ok)fail(code,message);};
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>plain(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const identity=stat=>['dev','ino','size','mtimeNs','ctimeNs'].map(key=>String(stat[key])).join(':');
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
const parseLine=bytes=>{
 check(bytes.length>0,'ARCHIVE_STRUCTURE','Empty archive record');
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
 catch{fail('ARCHIVE_STRUCTURE','Archive record is not complete UTF-8 JSON');}
};

/** Bounded indexed NDJSON reader. The index contains only byte offsets/lengths,
 * never encoded or decoded row bodies. Indexing preserves the permissive table
 * interleaving of readArchiveFile; iterate(table) retains original within-table
 * order. Structural/file validation is NOT semantic validation or exportSha
 * verification: callers must run the complete archive validator and logical
 * hasher before import, then compare a new pass before committing any writes. */
export async function openArchiveRowsFile(filename,options={}){
 const {maxBytes=DEFAULT_ARCHIVE_MAX_BYTES,maxRowBytes=DEFAULT_ARCHIVE_MAX_ROW_BYTES,maxRows=1000000,expectedFileSha256,signal}=options;
 for(const [name,value] of Object.entries({maxBytes,maxRowBytes,maxRows}))check(Number.isSafeInteger(value)&&value>0,'ARCHIVE_LIMIT','Explicit positive safe '+name+' required');
 if(expectedFileSha256!==undefined)check(/^[a-f0-9]{64}$/.test(expectedFileSha256),'ARCHIVE_HASH','Expected a complete file SHA');
 const resolved=path.resolve(filename),initial=await lstat(resolved,{bigint:true});
 check(initial.isFile()&&!initial.isSymbolicLink()&&await realpath(resolved)===resolved,'ARCHIVE_PATH','Archive must be a canonical regular file');
 check(initial.size<=BigInt(maxBytes),'ARCHIVE_LIMIT','Archive exceeds the explicit complete-read capacity');
 signal?.throwIfAborted();
 const handle=await open(resolved,constants.O_RDONLY|(constants.O_NOFOLLOW||0));let closed=false,busy=false;
 const frozenIdentity=identity(initial),index=new Map(),fileHash=createHash('sha256');let header,tableNames,rows=0,ended=false,position=0,totalBytes=0;
 const assertUnchanged=async()=>{
  check(!closed,'ARCHIVE_CLOSED','Archive reader is closed');signal?.throwIfAborted();
  const [current,opened]=await Promise.all([lstat(resolved,{bigint:true}),handle.stat({bigint:true})]);
  check(current.isFile()&&!current.isSymbolicLink()&&await realpath(resolved)===resolved&&identity(current)===frozenIdentity&&identity(opened)===frozenIdentity,'ARCHIVE_CHANGED','Archive file changed during complete reading');
 };
 const acceptLine=(bytes,start,length)=>{
  const record=parseLine(bytes);check(!ended,'ARCHIVE_STRUCTURE','Unexpected record after archive end');
  if(!header){
   check(exact(record,['format','header','tableNames'])&&record.format===ARCHIVE_FILE_FORMAT&&plain(record.header)&&!Object.hasOwn(record.header,'tables')&&Array.isArray(record.tableNames)&&record.tableNames.length>0&&record.tableNames.length<=64&&new Set(record.tableNames).size===record.tableNames.length&&record.tableNames.every(t=>typeof t==='string'&&/^[_a-z]+$/.test(t)),'ARCHIVE_STRUCTURE','Invalid archive header');
   header=freeze(record.header);tableNames=Object.freeze([...record.tableNames]);for(const table of tableNames)index.set(table,[]);return;
  }
  if(record?.end===true){check(exact(record,['end','rows'])&&record.rows===rows,'ARCHIVE_STRUCTURE','Archive row count differs');ended=true;return;}
  check(exact(record,['row','table'])&&index.has(record.table)&&plain(record.row),'ARCHIVE_STRUCTURE','Invalid archive row');
  check(rows<maxRows,'ARCHIVE_LIMIT','Archive row index exceeds the explicit capacity');
  index.get(record.table).push([start,length]);rows++;
 };
 try{
  await assertUnchanged();
  let parts=[],pendingBytes=0;
  // Read from the retained descriptor explicitly. Destroying a FileHandle-backed
  // stream can close it despite autoClose=false; later passes need this inode.
  for(;;){
   signal?.throwIfAborted();const buffer=Buffer.allocUnsafe(256*1024),read=await handle.read(buffer,0,buffer.length,totalBytes);if(!read.bytesRead)break;const chunk=buffer.subarray(0,read.bytesRead);
   signal?.throwIfAborted();totalBytes+=chunk.length;check(totalBytes<=maxBytes,'ARCHIVE_LIMIT','Archive grew beyond complete-read capacity');fileHash.update(chunk);
   let start=0;
   for(let end=chunk.indexOf(10,start);end!==-1;end=chunk.indexOf(10,start)){
    const fragment=chunk.subarray(start,end),limit=header?maxRowBytes:Math.min(maxRowBytes,1024*1024);check(pendingBytes+fragment.length<=limit,'ARCHIVE_LIMIT','Archive row exceeds complete-read capacity');
    if(fragment.length)parts.push(fragment);const length=pendingBytes+fragment.length,line=parts.length===1?parts[0]:Buffer.concat(parts,length);
    acceptLine(line,position,length);position+=length+1;parts=[];pendingBytes=0;start=end+1;
   }
   if(start<chunk.length){const fragment=chunk.subarray(start),limit=header?maxRowBytes:Math.min(maxRowBytes,1024*1024);check(pendingBytes+fragment.length<=limit,'ARCHIVE_LIMIT','Archive row exceeds complete-read capacity');parts.push(fragment);pendingBytes+=fragment.length;}
  }
  if(pendingBytes){acceptLine(parts.length===1?parts[0]:Buffer.concat(parts,pendingBytes),position,pendingBytes);position+=pendingBytes;}
  check(header&&ended&&position===totalBytes&&BigInt(totalBytes)===initial.size,'ARCHIVE_STRUCTURE','Incomplete archive');
  await assertUnchanged();const sha256=fileHash.digest('hex');
  if(expectedFileSha256!==undefined)check(sha256===expectedFileSha256,'ARCHIVE_HASH','Archive file SHA differs');
  const iterate=async function*(table){
   check(index.has(table),'ARCHIVE_STRUCTURE','Unknown archive table');check(!busy,'ARCHIVE_READ_BUSY','Archive row iterators must be sequential');busy=true;
   try{
    await assertUnchanged();
    for(const [offset,length] of index.get(table)){
     signal?.throwIfAborted();const bytes=Buffer.allocUnsafe(length);let read=0;
     while(read<length){const result=await handle.read(bytes,read,length-read,offset+read);signal?.throwIfAborted();check(result.bytesRead>0,'ARCHIVE_CHANGED','Archive row was truncated');read+=result.bytesRead;}
     const record=parseLine(bytes);check(exact(record,['row','table'])&&record.table===table&&plain(record.row),'ARCHIVE_CHANGED','Indexed archive row changed');
     yield record.row;
    }
    await assertUnchanged();
   }finally{busy=false;}
  };
  return Object.freeze({format:ARCHIVE_FILE_FORMAT,header,tableNames,rows,file:Object.freeze({sha256,bytes:totalBytes}),iterate,assertUnchanged,close:async()=>{check(!busy,'ARCHIVE_READ_BUSY','Finish the row iterator before closing');if(!closed){closed=true;await handle.close();}}});
 }catch(error){closed=true;await handle.close().catch(()=>{});throw error;}
}
