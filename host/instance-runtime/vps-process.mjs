import {spawn} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import path from 'node:path';

export async function command(binary,args,{cwd,input,output,maxOutputBytes=8*1024**2,env=process.env,raw=false}={}){
 const child=spawn(binary,args,{cwd,env,stdio:['pipe','pipe','pipe']});const chunks=[];let total=0,err='',exceeded=false;
 const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>code===0&&!exceeded?resolve():reject(Error(`${path.basename(binary)} ${args[0]} failed (${code}): ${err.slice(-4000)}`)));});done.catch(()=>{});
 child.stderr.on('data',chunk=>{err=(err+chunk).slice(-8000);});
 let reader;
 if(output){reader=pipeline(child.stdout,createWriteStream(output,{flags:'wx',mode:0o600}));reader.catch(()=>child.kill('SIGTERM'));}
 else child.stdout.on('data',chunk=>{if(!exceeded){total+=chunk.length;if(total>maxOutputBytes){exceeded=true;child.kill('SIGTERM');}else chunks.push(chunk);}});
 try{if(input)await pipeline(input,child.stdin);else child.stdin.end();await done;if(reader)await reader;const out=Buffer.concat(chunks);return raw?out:out.toString('utf8').trim();}catch(error){child.kill('SIGTERM');const childError=await done.then(()=>null,reason=>reason);await reader?.catch(()=>{});throw ['EPIPE','ERR_STREAM_PREMATURE_CLOSE'].includes(error.code)&&childError?childError:error;}
}
