import {once} from 'node:events';
import {createHash} from 'node:crypto';
export class WireInput{
 constructor(stream){this.iterator=stream[Symbol.asyncIterator]();this.pending=Buffer.alloc(0);this.busy=false;}
 async more(){if(this.pending.length)return;const value=await this.iterator.next();if(value.done)throw Error('Transfer interrupted');this.pending=Buffer.from(value.value);}
 async json(limit=32*1024**2){
  if(this.busy)throw Error('Concurrent input read');let bytes=0,parts=[];
  for(;;){await this.more();const end=this.pending.indexOf(10),size=end<0?this.pending.length:end;bytes+=size;if(bytes>limit)throw Error('Control message exceeds bound');parts.push(this.pending.subarray(0,size));this.pending=this.pending.subarray(size+(end<0?0:1));if(end>=0)return JSON.parse(Buffer.concat(parts,bytes).toString('utf8'));}
 }
 async *take(bytes){
  if(this.busy||!Number.isSafeInteger(bytes)||bytes<=0)throw Error('Invalid framed input length');this.busy=true;
  try{let remaining=bytes;while(remaining){await this.more();const size=Math.min(remaining,this.pending.length);yield this.pending.subarray(0,size);this.pending=this.pending.subarray(size);remaining-=size;}}finally{this.busy=false;}
 }
}
export async function writeWire(stream,bytes){if(!stream.write(bytes))await once(stream,'drain');}
export function rpcSource(manifest,input,output){
 let busy=false;
 return {manifest,async *open(filename){
  if(busy)throw Error('Concurrent source streams are forbidden');
  const file=manifest.files.find(f=>f.path===filename);if(!file)throw Error('Unregistered source path');busy=true;
  try{
   await writeWire(output,JSON.stringify({type:'READ_FILE',path:filename,bytes:file.bytes,sha256:file.sha256})+'\n');
   const hash=createHash('sha256');if(file.bytes)for await(const chunk of input.take(file.bytes)){hash.update(chunk);yield chunk;}if(hash.digest('hex')!==file.sha256)throw Error('Stream checksum differs');
  }finally{busy=false;}
 }};
}
