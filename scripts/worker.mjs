#!/usr/bin/env node
import {database,machineConfiguration,closeDatabase} from '../server/db.mjs';
import {workOnce,sweepJobs} from '../server/jobs.mjs';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const {root,machine}=await machineConfiguration(),pool=await database(),workerId=randomUUID();let stopped=false;
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{stopped=true;});
const providers={};
if(machine.assistant?.provider==='codex')providers.suggest=({request,object,onRequestId})=>new Promise((resolve,reject)=>{
 const script=fileURLToPath(new URL('../server/collaboration/codex_suggest.py',import.meta.url)),child=spawn(machine.assistant.python||'python3',[script],{cwd:path.dirname(root),env:process.env,stdio:['pipe','pipe','pipe']});
 let line='',answer='',bytes=0;
 child.stdin.end(JSON.stringify({codexBin:machine.assistant.codexBinary||'codex',model:machine.assistant.model||null,cwd:path.dirname(root),apiUrl:machine.apiUrl,request,object}));
 child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>1024*1024){child.kill();reject(Error('Assistant output exceeds limit'));return;}line+=chunk.toString();let at;while((at=line.indexOf('\n'))>=0){const raw=line.slice(0,at);line=line.slice(at+1);try{const event=JSON.parse(raw);if(event.type==='request')void onRequestId(event.id);if(event.type==='answer')answer=event.value;}catch{child.kill();reject(Error('Invalid assistant protocol'));}}});
 child.stderr.resume();child.on('error',reject);child.on('exit',code=>{if(code===0){try{resolve(typeof answer==='string'?JSON.parse(answer):answer);}catch{reject(Error('Invalid assistant result'));}}else reject(Error('Assistant runtime interrupted'));});
});
const heartbeat=async()=>pool.query("INSERT INTO runtime_status(name,value,updated_at) VALUES('worker',$1,now()) ON CONFLICT(name) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",[{workerId,softwareCommit:process.env.REVIEW_SOFTWARE_COMMIT||'DEVELOPMENT',concurrency:1,capabilities:['IMPORT','MEDIA_REGISTER',...(providers.suggest?['AI_SUGGEST']:[])]}]);
await heartbeat();let lastSweep=0;
try{while(!stopped){
 if(Date.now()-lastSweep>5000){await heartbeat();await sweepJobs(pool);lastSweep=Date.now();}
 const worked=await workOnce(pool,{root,workerId,providers});if(!worked)await new Promise(resolve=>setTimeout(resolve,500));
}}finally{await pool.query("DELETE FROM runtime_status WHERE name='worker' AND value->>'workerId'=$1",[workerId]);await closeDatabase();}
