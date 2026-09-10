import {createHash} from 'node:crypto';
import {ARCHIVE_FILE_FORMAT} from './archive-file.mjs';
import {assertArchiveFileBinding} from './archive-stream-validation.mjs';

const ensure=(ok,message)=>{if(!ok)throw Error(message);};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===keys;
const freeze=value=>{if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;};

/** Re-openable, bounded, zero-scratch reader for the canonical sorted-table
 * NDJSON produced by writeArchiveRowsFile. Each complete pass checks the raw
 * file SHA as well as structure. The existing semantic validator/importer is
 * unchanged. Interleaved legacy archives retain their indexed-file path. */
export async function openRepeatableArchive(openSource,binding,{maxRowBytes=128*1024**2,maxRows=1000000}={}){
 assertArchiveFileBinding(binding);
 let closed=false,poisoned=false,busy=false,active=null,next=null,tableIndex=0,passes=0;
 let frozenHeader,frozenTables,frozenRows;
 async function* records(){
  const source=await openSource(),hash=createHash('sha256');let size=0,pending=[],pendingBytes=0,header,rows=0,end=false,last='';
  const accept=bytes=>{
   ensure(bytes.length>0,'Empty archive line');
   const record=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
   ensure(!end,'Record after archive end');
   if(!header){
    ensure(exact(record,'format,header,tableNames')&&record.format===ARCHIVE_FILE_FORMAT&&record.header&&typeof record.header==='object'&&!Array.isArray(record.header)&&!('tables' in record.header),'Invalid archive header');
    ensure(Array.isArray(record.tableNames)&&record.tableNames.length>0&&record.tableNames.length<=64&&record.tableNames.every(t=>typeof t==='string'&&/^[_a-z]+$/.test(t))&&new Set(record.tableNames).size===record.tableNames.length&&JSON.stringify(record.tableNames)===JSON.stringify([...record.tableNames].sort()),'Streaming archive must use canonical sorted tables');
    header=record;
    if(frozenHeader)ensure(JSON.stringify(record)===JSON.stringify({format:ARCHIVE_FILE_FORMAT,header:frozenHeader,tableNames:frozenTables}),'Stream header changed');
   }else if(record.end===true){ensure(exact(record,'end,rows')&&record.rows===rows,'Archive end count mismatch');end=true;}
   else{
    ensure(exact(record,'row,table')&&header.tableNames.includes(record.table)&&record.table>=last&&record.row&&typeof record.row==='object'&&!Array.isArray(record.row),'Invalid or interleaved archive row');
    last=record.table;ensure(++rows<=maxRows,'Archive row limit exceeded');
   }
   return record;
  };
  try{
   for await(const value of source){
    const chunk=Buffer.from(value);size+=chunk.length;ensure(size<=binding.bytes,'Stream exceeds frozen byte size');hash.update(chunk);
    let start=0;
    for(let endIndex=chunk.indexOf(10,start);endIndex>=0;endIndex=chunk.indexOf(10,start)){
     const fragment=chunk.subarray(start,endIndex);ensure(pendingBytes+fragment.length<=maxRowBytes,'Archive row exceeds limit');
     pending.push(fragment);yield accept(Buffer.concat(pending,pendingBytes+fragment.length));pending=[];pendingBytes=0;start=endIndex+1;
    }
    if(start<chunk.length){pending.push(chunk.subarray(start));pendingBytes+=chunk.length-start;ensure(pendingBytes<=maxRowBytes,'Archive row exceeds limit');}
   }
   ensure(!pendingBytes&&end&&size===binding.bytes,'Truncated archive stream');
   ensure(hash.digest('hex')===binding.sha256,'Archive stream SHA mismatch');
   if(frozenRows!==undefined)ensure(rows===frozenRows,'Archive stream row count changed');
   passes++;
  }catch(error){poisoned=true;throw error;}
 }
 // Initial full structural/hash pass establishes the immutable reader binding.
 for await(const record of records()){
  if(record.format){frozenHeader=freeze(record.header);frozenTables=freeze(record.tableNames);}
  if(record.end)frozenRows=record.rows;
 }
 const assertUnchanged=async()=>ensure(!closed&&!poisoned&&!active,'Archive stream is closed, failed or not completely validated');
 const iterate=async function*(table){
  ensure(!closed&&!poisoned&&!busy,'Concurrent or failed archive reader');busy=true;let finished=false;
  try{
   ensure(table===frozenTables[tableIndex],'Archive streaming tables must be read once each in canonical order');
   if(!active){active=records()[Symbol.asyncIterator]();await active.next();next=await active.next();}
   while(!next.done&&next.value.table===table){yield next.value.row;next=await active.next();}
   tableIndex++;
   if(tableIndex===frozenTables.length){ensure(next.value?.end===true,'Missing archive terminal record');ensure((await active.next()).done,'Unexpected archive trailer');active=null;next=null;tableIndex=0;}
   finished=true;
  }finally{busy=false;if(!finished)poisoned=true;}
 };
 return Object.freeze({format:ARCHIVE_FILE_FORMAT,header:frozenHeader,tableNames:frozenTables,rows:frozenRows,file:Object.freeze({...binding}),iterate,assertUnchanged,get passes(){return passes;},close:async()=>{closed=true;await active?.return?.();}});
}

/** Length-delimited reads share one iterator. No read-ahead bytes are lost and
 * no complete input is buffered. Used over SSH and docker exec stdin. */
export class ExactStreamInput{
 constructor(input){this.iterator=input[Symbol.asyncIterator]();this.pending=Buffer.alloc(0);this.busy=false;}
 async *take(bytes){
  ensure(!this.busy&&Number.isSafeInteger(bytes)&&bytes>0,'Invalid concurrent framed read');this.busy=true;
  try{let remaining=bytes;while(remaining){if(!this.pending.length){const item=await this.iterator.next();ensure(!item.done,'Transfer interrupted');this.pending=Buffer.from(item.value);}const size=Math.min(remaining,this.pending.length);yield this.pending.subarray(0,size);this.pending=this.pending.subarray(size);remaining-=size;}}
  finally{this.busy=false;}
 }
}
