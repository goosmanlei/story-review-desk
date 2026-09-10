import assert from 'node:assert/strict';
import https from 'node:https';
import {readFile,writeFile,lstat} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {chromium} from '@playwright/test';
import {command} from '../host/instance-runtime/vps-process.mjs';
if(process.env.REVIEW_TEST_VPS!=='1')throw Error('Explicit local HTTP rehearsal required');
const fixture=path.resolve(process.argv[2]||'');if(!fixture.startsWith(path.resolve('.test-tmp/vps-rehearsal-')))throw Error('Isolated fixture required');
const target=JSON.parse(await readFile(path.join(fixture,'target.json'))),state=JSON.parse(await readFile(path.join(target.hostRoot,'state.json'))),runtime=state.current.runtime;
assert.equal(target.sshHost,'fixture-only');assert.equal(runtime.targetId,'fixture');const url=new URL(target.publicUrl),base=target.basePath;
const auth='Basic '+Buffer.from('fixture:fixture-password').toString('base64');
const request=(pathname,headers={},method='GET')=>new Promise((resolve,reject)=>{const r=https.request({hostname:'127.0.0.1',port:Number(url.port),path:pathname,method,rejectUnauthorized:false,headers:{Host:url.host,...headers}},response=>{const chunks=[];response.on('data',c=>chunks.push(c));response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,bytes:Buffer.concat(chunks)}));});r.on('error',reject);r.end();});
const result={kind:'LOCAL_NGINX_HTTP_BROWSER_REHEARSAL',realModelCalls:0,sshConnections:0,checks:[],views:[]};
for(const entry of [base,base+'/',base+'/api/instance/profile',base+'/favicon.svg',base+'/api/v8/media/m_unregisteredtesttoken',base+'/api/assistant/v1/events']){
 const response=await request(entry,{'x-review-authenticated-user':'spoofed','x-review-proxy':'controlled-nginx-v1','x-review-internal-gateway':'spoofed'});assert.equal(response.status,401);result.checks.push({path:entry,unauthenticated:401});
}
assert.equal((await request('/other/')).bytes.toString(),'other-site-untouched');
const redirect=await request(base,{Authorization:auth});assert.equal(redirect.status,308);assert.equal(redirect.headers.location,base+'/');
const wrongOrigin=await request(base+'/api/instance/configuration',{Authorization:auth,Origin:'https://attacker.invalid','x-review-deployment-id':runtime.id,'x-review-runtime-epoch':runtime.runtimeEpoch},'PUT');assert.equal(wrongOrigin.status,403);
const direct=await command(target.runtime.dockerBinary,['exec',runtime.web,'node','-e',`fetch('http://127.0.0.1:3000${base}/api/instance/profile',{headers:{'x-review-authenticated-user':'spoofed','x-review-proxy':'controlled-nginx-v1'}}).then(r=>console.log(r.status))`]);assert.equal(direct,'403');
result.checks.push({wrongOrigin:403,directSocketSpoof:403,authenticatedRedirect:308,otherLocation:'UNCHANGED'});
// Generated silence and a one-second blue test card; not story media or a model.
const wav=Buffer.alloc(44+16000);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(16000,40);
await writeFile(path.join(runtime.root,'media/http-probe.wav'),wav,{flag:'wx'});
await command('ffmpeg',['-loglevel','error','-n','-f','lavfi','-i','color=c=blue:s=32x32:d=1','-c:v','libx264','-pix_fmt','yuv420p','-an',path.join(runtime.root,'media/http-probe.mp4')]);
const entries=[];for(const [name,mediaType]of [['http-probe.wav','AUDIO'],['http-probe.mp4','VIDEO']]){const bytes=await readFile(path.join(runtime.root,'media',name));entries.push({id:'fixture-'+mediaType,path:'media/'+name,sha256:createHash('sha256').update(bytes).digest('hex'),byteSize:bytes.length,mediaType,outputState:'PRESENT',familyId:'fixture-'+mediaType});}
const script="import {readFile} from 'node:fs/promises';import {resolveInstance,openInstanceRepository} from './host/instance-runtime/index.mjs';const entries=JSON.parse(process.argv[1]);const r=await openInstanceRepository(resolveInstance('/instance'));try{await r.writeTransaction(async tx=>{const view=await tx.readView();for(const e of entries)await tx.registerMedia({mediaId:e.id,versionId:e.id,relativePath:e.path,sha256:e.sha256,byteSize:e.byteSize,aliases:[e.path],metadata:{synthetic:true}});const snapshot=structuredClone(view.snapshot);snapshot.productionModel.assetVersions.push(...entries);await tx.publishRelease({snapshot,recipes:view.recipes,sourceRevisionIds:view.sourceRevisionIds,expectedReleaseId:view.releaseId})})}finally{await r.close()}";
await command(target.runtime.dockerBinary,['exec',runtime.web,'node','--input-type=module','-e',script,JSON.stringify(entries)]);
for(const entry of entries){const token='m_'+createHash('sha256').update(entry.id).digest('base64url').slice(0,28);entry.url=base+'/api/v8/media/'+token;const response=await request(entry.url,{Authorization:auth});assert.equal(response.status,200);assert.equal(createHash('sha256').update(response.bytes).digest('hex'),entry.sha256);const partial=await request(entry.url,{Authorization:auth,Range:'bytes=0-15'});assert.equal(partial.status,206);assert.equal(partial.bytes.length,16);result.checks.push({mediaType:entry.mediaType,bytes:entry.byteSize,status:200,range:206,sha256:entry.sha256});}
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--host-resolver-rules=MAP review.example.invalid 127.0.0.1','--no-proxy-server']});
try{const context=await browser.newContext({ignoreHTTPSErrors:true,httpCredentials:{username:'fixture',password:'fixture-password'},acceptDownloads:true}),page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 for(const view of ['system','story','settings','materials','pipeline','overview']){await page.goto(target.publicUrl+'?view='+view);await page.getByText('VPS 私有可写审阅台',{exact:true}).waitFor();await page.waitForTimeout(500);await page.reload();await page.waitForTimeout(300);assert(!(await page.locator('body').innerText()).includes('This page couldn’t load'));const escaped=await page.evaluate(()=>performance.getEntriesByType('resource').map(r=>r.name).filter(u=>new URL(u).origin===location.origin&&!new URL(u).pathname.startsWith('/story/')));assert.deepEqual(escaped,[]);result.views.push({view,deepLinkRefresh:'PASS',escapedResources:0});}
 await page.evaluate(entries=>{for(const e of entries){const element=document.createElement(e.mediaType==='VIDEO'?'video':'audio');element.src=e.url;element.preload='auto';document.body.append(element);}},entries);
 await page.waitForFunction(()=>[...document.querySelectorAll('video,audio')].filter(e=>e.src.includes('/api/v8/media/')).every(e=>e.readyState>=2));
 const downloadPromise=page.waitForEvent('download');await page.evaluate(url=>{const a=document.createElement('a');a.href=url;a.download='fixture.wav';document.body.append(a);a.click();},entries[0].url);const download=await downloadPromise;await download.saveAs(path.join(fixture,'browser-download.wav'));assert.equal((await lstat(path.join(fixture,'browser-download.wav'))).size,wav.length);assert.deepEqual(errors,[]);result.status='PASS';
}finally{await browser.close();await writeFile(path.join(fixture,'http-evidence.json'),JSON.stringify(result,null,2)+'\n');}
console.log(JSON.stringify(result));
