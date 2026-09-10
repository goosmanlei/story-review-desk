import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {createDeploymentGateway} from '../host/instance-runtime/deployment-gateway.mjs';
import {remoteBootstrap} from '../scripts/instance-vps.mjs';

test('controller bootstrap preserves non-UTF8 binary frames after JSON control',async()=>{
 const child=spawn(process.execPath,['-e',remoteBootstrap],{stdio:['pipe','pipe','pipe']});
 const done=once(child,'exit');let output='',errors='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>errors+=c);
 const code="import {createHash} from 'node:crypto';process.stdout.write('READ\\n');const h=createHash('sha256');for await(const c of process.stdin)h.update(c);process.stdout.write(h.digest('hex'))";
 child.stdin.write(JSON.stringify({control:{},code:Buffer.from(code).toString('base64')})+'\n');
 while(!output.includes('READ\n'))await once(child.stdout,'data');
 const bytes=Buffer.from(Array.from({length:4096},(_,i)=>i%256));child.stdin.end(bytes);
 const [status]=await done;assert.equal(status,0,errors);assert.equal(output,'READ\n'+createHash('sha256').update(bytes).digest('hex'));
});

test('gateway enforces socket, auth, origin, epoch and maintenance without buffering streams',async t=>{
 const before={...process.env};Object.assign(process.env,{REVIEW_DEPLOYMENT_MODE:'VPS',REVIEW_PUBLIC_URL:'https://review.example.invalid/story/',REVIEW_BASE_PATH:'/story',REVIEW_INTERNAL_GATEWAY_SECRET:'private-fixture',REVIEW_DEPLOYMENT_ID:'fixture_deployment_1'});
 t.after(()=>{for(const key of Object.keys(process.env))if(!(key in before))delete process.env[key];Object.assign(process.env,before);});
 let complete;const upstream=http.createServer((req,res)=>{if(req.url.endsWith('/stream')){res.writeHead(200);res.write('first\n');complete=()=>res.end('last\n');}else{res.writeHead(req.headers.range?206:200,{'content-type':'application/json'});res.end(JSON.stringify({url:req.url}));}});
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');let maintenance=false;
 const gateway=createDeploymentGateway({upstreamPort:upstream.address().port,proxyIp:'127.0.0.1',secret:'private-fixture',basePath:'/story',runtimeEpoch:'epoch_fixture',maintenance:()=>maintenance});gateway.listen(0,'127.0.0.1');await once(gateway,'listening');
 t.after(()=>{gateway.closeAllConnections();gateway.close();upstream.closeAllConnections();upstream.close();});
 const origin='http://127.0.0.1:'+gateway.address().port;
 const headers={'x-review-proxy':'controlled-nginx-v1','x-review-authenticated-user':'fixture','x-forwarded-host':'review.example.invalid','x-forwarded-proto':'https','x-forwarded-port':'443','x-review-internal-gateway':'spoofed','origin':'https://review.example.invalid','x-review-deployment-id':'fixture_deployment_1','x-review-runtime-epoch':'epoch_fixture'};
 assert.equal((await fetch(origin+'/story/api',{headers,method:'POST'})).status,200);
 assert.equal((await fetch(origin+'/story/api',{headers:{...headers,origin:'https://attacker.invalid'},method:'POST'})).status,403);
 const stale=await fetch(origin+'/story/api',{headers:{...headers,'x-review-runtime-epoch':'old'},method:'POST'});assert.equal(stale.status,409);assert.equal(stale.headers.get('x-review-runtime-changed'),'1');
 assert.equal((await fetch(origin+'/story/api',{headers:{...headers,'x-review-authenticated-user':''}})).status,403);
 assert.equal((await fetch(origin+'/other',{headers})).status,404);
 const redirect=await fetch(origin+'/story',{headers,redirect:'manual'});assert.equal(redirect.status,308);assert.equal(redirect.headers.get('location'),'/story/');
 const stream=await fetch(origin+'/story/stream',{headers}),reader=stream.body.getReader();assert.equal(new TextDecoder().decode((await reader.read()).value),'first\n');
 maintenance=true;assert.equal((await fetch(origin+'/story/api',{headers})).status,503);
 assert.equal((await fetch(origin+'/__review_health').then(r=>r.json())).activeRequests,1);complete();while(!(await reader.read()).done){};
 const health=await fetch(origin+'/__review_health').then(r=>r.json());assert.equal(health.activeRequests,0);
});
