import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';

export async function episodeHttp(repo,root){
  const metadata=await repo.getMetadata();
  await writeFile(path.join(root,'instance.json'),JSON.stringify({schemaVersion:'1.0',instanceId:metadata.instanceId,database:'instance.sqlite'}));
  const origin='http://127.0.0.1:3106';let logs='',serial=0;
  const server=spawn(process.execPath,['node_modules/vinext/dist/cli.js','dev','--port','3106','--hostname','127.0.0.1'],{cwd:process.cwd(),env:{...process.env,REVIEW_NODE_DEV:'1',REVIEW_INSTANCE_ROOT:root,REVIEW_INSTANCE_DB:'',REVIEW_INSTANCE_ID:metadata.instanceId,REVIEW_SITE_ROOT:process.cwd(),REVIEW_ALLOWED_ORIGINS:origin,REVIEW_INSTANCE_READ_ONLY:'',REVIEW_REMOTE_READ_ONLY:''},stdio:['ignore','pipe','pipe']});
  server.stdout.on('data',d=>{logs=(logs+d).slice(-10000);});server.stderr.on('data',d=>{logs=(logs+d).slice(-10000);});
  async function stop(){server.kill('SIGTERM');await new Promise(resolve=>{if(server.exitCode!==null)resolve();else{server.once('exit',resolve);setTimeout(()=>{server.kill('SIGKILL');resolve();},5000).unref();}});}
  async function request(route,options={},expected=200){const r=await fetch(origin+route,options);const body=await r.text();assert.equal(r.status,expected,body.slice(0,3000)+'\n'+logs.slice(-2000));return JSON.parse(body);}
  const get=route=>request(route);
  async function post(route,body,status=201,etag){const op=etag?null:await get('/api/v8/operations/snapshot');return request(route,{method:'POST',headers:{origin,'content-type':'application/json','if-match':etag||op.mutationEtag,'idempotency-key':`scoped-http-${++serial}`},body:JSON.stringify(body)},status);}
  try{let ready=false;for(let i=0;i<120;i++){if(server.exitCode!==null)throw new Error(logs);try{await fetch(origin+'/api/instance/runtime');ready=true;break;}catch{}await new Promise(r=>setTimeout(r,250));}assert(ready,logs);return {get,post,stop};}catch(e){await stop();throw e;}
}
