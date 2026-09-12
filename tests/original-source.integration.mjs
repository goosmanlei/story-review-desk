import assert from 'node:assert/strict';
import {requiredPhase} from '../tools/process-resources.mjs';
import {database,closeDatabase} from '../server/db.mjs';
import {workOnce} from '../server/jobs.mjs';
import {hash} from '../server/shared/contracts.mjs';
assert.ok(await requiredPhase(process.cwd()),'Use managed runner');
const base=(process.env.REVIEW_UI_BASE||'http://127.0.0.1:3913')+'/api/v1/';
const profile=await fetch(base+'workspaces/profile').then(r=>r.json());assert.match(profile.instanceId,/^ui-fixture-/);
const headers={'Content-Type':'application/json','X-Review-Runtime':profile.deployment.runtimeEpoch};
const pool=await database();assert.equal((await pool.query('SELECT instance_id FROM project')).rows[0].instance_id,profile.instanceId);
try{
 const text='隔离来源原件。\n\n第二段保持原字节。',input={title:'隔离文字来源',role:'AUXILIARY',text},key=crypto.randomUUID();
 async function post(value){return fetch(base+'workspaces/sources',{method:'POST',headers:{...headers,'Idempotency-Key':key},body:JSON.stringify(value)});}
 let response=await post(input);assert.equal(response.status,200,await response.clone().text());const receipt=await response.json();
 assert.equal((await post(input)).status,200);assert.equal((await post({...input,text:'冲突'})).status,409);
 const source=await fetch(base+'workspaces/documents?id='+receipt.source.id).then(r=>r.json());assert.equal(source.text,text);assert.equal(source.sha256,hash(Buffer.from(text)));assert.equal(source.focusId,receipt.source.id);
 const uploadId=crypto.randomUUID(),bytes=Buffer.from(text+'\n原始文件。','utf8'),params=new URLSearchParams({title:'隔离文件来源',role:'PRIMARY',originalFilename:'source.txt',mimeType:'text/plain'});
 response=await fetch(base+'workspaces/sources/file?'+params,{method:'POST',headers:{...headers,'Content-Type':'application/octet-stream','Idempotency-Key':uploadId},body:bytes});assert.equal(response.status,202,await response.clone().text());
 await workOnce(pool,{root:process.env.REVIEW_INSTANCE_ROOT,workerId:'source-fixture'});
 const operation=await fetch(base+'operations/'+uploadId).then(r=>r.json());assert.equal(operation.status,'SUCCEEDED',JSON.stringify(operation));
 const file=await fetch(base+'workspaces/documents?id='+operation.result.sourceId).then(r=>r.json());assert.equal(file.text,bytes.toString());assert.equal(file.sha256,hash(bytes));
 assert.equal(hash(Buffer.from(await fetch(base+'media/'+hash(bytes)).then(r=>r.arrayBuffer()))),hash(bytes));
 const sources=await fetch(base+'workspaces/sources').then(r=>r.json());assert.equal(sources.sources.find(s=>s.id===file.documentId).documentSha256,file.sha256);
 console.log('PASS text and file source registration, original bytes, strict replay, reading context and isolated worker');
}finally{await closeDatabase();}
