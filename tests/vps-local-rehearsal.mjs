// Opt-in real Docker/PostgreSQL/Nginx/browser rehearsal. Never contacts SSH.
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {chromium} from '@playwright/test';
import {main} from '../scripts/instance-vps.mjs';
import {runPostgresMaintenance} from '../scripts/instance-postgres.mjs';
import {command} from '../host/instance-runtime/vps-process.mjs';
if(process.env.REVIEW_TEST_VPS!=='1')throw Error('Explicit local rehearsal opt-in required');
process.env.REVIEW_VPS_OFFLINE='1';
const fixture=path.resolve(process.argv[2]||''),output=path.resolve(process.argv[3]||'');
if(!fixture.startsWith(path.resolve('.test-tmp/vps-rehearsal-'))||output===path.resolve(''))throw Error('Explicit isolated fixture/output required');
const config=path.join(fixture,'target.json'),target=JSON.parse(await readFile(config)),stateFile=path.join(target.hostRoot,'state.json'),source=path.join(fixture,'source');
assert.equal(target.sshHost,'fixture-only');await mkdir(output,{recursive:true});
const state=async()=>JSON.parse(await readFile(stateFile));
const run=async(action,args=[])=>main([action,'--target',config,'--fixture-host','--development',...args]);
const evidence={kind:'LOCAL_ONLY_VPS_REHEARSAL',realModelCalls:0,sshConnections:0,phases:[],http:[],startedAt:new Date().toISOString()};
const persist=()=>writeFile(path.join(output,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--host-resolver-rules=MAP review.example.invalid 127.0.0.1','--no-proxy-server']});
const context=await browser.newContext({ignoreHTTPSErrors:true,httpCredentials:{username:'fixture',password:'fixture-password'}}),page=await context.newPage();
const pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));
const origin=new URL(target.publicUrl).origin,base=target.basePath;
async function loaded(){await page.goto(target.publicUrl);await page.getByText('VPS 私有可写审阅台',{exact:true}).waitFor();await page.getByText('数据与运行',{exact:true}).waitFor();}
async function api(url,options={}){return page.evaluate(async({url,options})=>{const r=await fetch(url,options);return {status:r.status,headers:Object.fromEntries(r.headers),text:await r.text()};},{url,options});}
async function baseline(runtime,label){
 assert.equal(runtime.targetId,'fixture');
 const value=JSON.parse(await command(target.runtime.dockerBinary,['exec',runtime.web,'node','--input-type=module','-e',"import {resolveInstance,openInstanceRepository} from './host/instance-runtime/index.mjs';const r=await openInstanceRepository(resolveInstance('/instance'));try{console.log((await r.readTransaction(tx=>tx.getAux('vps-rehearsal','baseline'))).bytes.toString())}finally{await r.close()}"]));
 assert.equal(value.label,label);assert.equal(value.frozenUrl,'/api/v8/media/original-identity');assert.equal(value.unicode,'历史字节');return value;
}
async function dirty(runtime){
 assert.equal(runtime.targetId,'fixture');
 await command(target.runtime.dockerBinary,['exec',runtime.web,'node','--input-type=module','-e',"import {resolveInstance,openInstanceRepository} from './host/instance-runtime/index.mjs';const r=await openInstanceRepository(resolveInstance('/instance'));try{await r.writeTransaction(async tx=>{const a=await tx.getAux('vps-rehearsal','baseline');await tx.putAux({namespace:'vps-rehearsal',key:'baseline',expectedRevisionId:a.revisionId,bytes:JSON.stringify({...JSON.parse(a.bytes),label:'REMOTE_DIRT'})})})}finally{await r.close()}"]);
 await baseline(runtime,'REMOTE_DIRT');
}
try{
 await loaded();let current=await state();await baseline(current.current.runtime,'A');
 const initial=await api('/api/instance/profile');assert.equal(initial.status,200);const binding=JSON.parse(initial.text).deployment;
 const request={method:'PUT',headers:{'Content-Type':'application/json','Idempotency-Key':'fixture_http_write_01'},body:'{}'};
 const precondition=await api('/api/instance/configuration',request);assert.equal(precondition.status,428);const etag=JSON.parse(precondition.text).mutationEtag;
 const configuration=JSON.parse((await api('/api/instance/configuration')).text);
 const mutation=await api('/api/instance/configuration',{...request,headers:{...request.headers,'If-Match':etag},body:JSON.stringify({configuration:configuration.configuration,expectedDraftRevision:configuration.draft?.revisionId||null,expectedReleaseId:configuration.releaseId,expectedConfigurationRevisionId:configuration.revisionId})});
 assert.equal(mutation.status,200,mutation.text);evidence.http.push({check:'authenticated-business-draft-write',status:mutation.status});
 const token='m_'+createHash('sha256').update('synthetic-version').digest('base64url').slice(0,28);
 const media=await api('/api/v8/media/'+token,{headers:{Range:'bytes=0-7'}});assert.equal(media.status,206,media.text);assert.equal(media.headers['content-range'],'bytes 0-7/68');evidence.http.push({check:'registered-media-range',status:206});
 const escaped=await page.evaluate(()=>performance.getEntriesByType('resource').map(r=>r.name).filter(u=>new URL(u).origin===location.origin&&!new URL(u).pathname.startsWith('/story/')));assert.deepEqual(escaped,[]);
 await page.screenshot({path:path.join(output,'A-browser.png'),fullPage:true});
 await dirty(current.current.runtime);await persist();
 for(const letter of ['B','C']){
  console.log('PACK '+letter);await runPostgresMaintenance(source,['tests/vps-seed.mjs','/instance',letter]);
  const packed=await main(['pack','--target',config,'--instance',source,'--output',path.join(output,letter),'--development']);
  console.log('DEPLOY '+letter);const before=await state(),receipt=await run('deploy',['--package',packed.output,'--expected-current',before.current.releaseId,'--operation-id','rehearsal_deploy_'+letter+'_01']);
  current=await state();await baseline(current.current.runtime,letter);assert.notEqual(current.current.runtime.runtimeEpoch,before.current.runtime.runtimeEpoch);assert.equal(current.backup.releaseId,before.current.releaseId);
  if(letter==='B'){
   // The old document retains its accepted binding; the new gateway rejects it.
   const stale=await api('/api/instance/configuration',request);assert.equal(stale.status,409);await page.getByRole('heading',{name:'审阅台已更新',exact:true}).waitFor();
   evidence.http.push({check:'old-browser-write-and-refresh-fence',status:409,oldBinding:binding});
  }
  await loaded();await page.reload();await page.getByText('VPS 私有可写审阅台',{exact:true}).waitFor();
  evidence.phases.push({letter,receipt,baseline:await baseline(current.current.runtime,letter),samples:current.samples.filter(s=>s.operationId===receipt.operationId)});await persist();
  await dirty(current.current.runtime);
 }
 console.log('ROLLBACK CLEAN B');const before=await state(),receipt=await run('rollback',['--expected-current',before.current.releaseId,'--operation-id','rehearsal_rollback_B_01']);
 current=await state();await baseline(current.current.runtime,'B');assert.notEqual(current.current.runtime.runtimeEpoch,before.current.runtime.runtimeEpoch);await loaded();
 await page.screenshot({path:path.join(output,'rollback-B-browser.png'),fullPage:true});
 const configAfter=JSON.parse((await api('/api/instance/configuration')).text);assert.equal(configAfter.draft,null);
 assert.deepEqual(pageErrors,[]);evidence.phases.push({letter:'rollback-B',receipt,samples:current.samples.filter(s=>s.operationId===receipt.operationId)});evidence.status='PASS';evidence.finishedAt=new Date().toISOString();await persist();console.log(JSON.stringify({status:'PASS',evidence:path.join(output,'evidence.json')}));
}catch(error){evidence.status='FAIL';evidence.error=String(error.stack||error);await persist();throw error;}finally{await browser.close();}
