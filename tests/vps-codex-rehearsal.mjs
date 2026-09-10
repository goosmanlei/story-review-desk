import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import path from 'node:path';
import {chromium} from '@playwright/test';
if(process.env.REVIEW_TEST_VPS!=='1')throw Error('Explicit local mock opt-in required');
const fixture=path.resolve(process.argv[2]||'');if(!fixture.startsWith(path.resolve('.test-tmp/vps-rehearsal-')))throw Error('Isolated fixture required');
const target=JSON.parse(await readFile(path.join(fixture,'target.json'))),state=JSON.parse(await readFile(path.join(target.hostRoot,'state.json'))),runtime=state.current.runtime;
assert.equal(target.sshHost,'fixture-only');assert.equal(runtime.targetId,'fixture');
const result={kind:'MOCK_CODEX_BROWSER_REHEARSAL',runtimeEpoch:runtime.runtimeEpoch,realModelCalls:0,credentialFilesRead:0,requests:[]};
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--host-resolver-rules=MAP review.example.invalid 127.0.0.1','--no-proxy-server']});
const context=await browser.newContext({ignoreHTTPSErrors:true,httpCredentials:{username:'fixture',password:'fixture-password'}}),page=await context.newPage();let child,done,logs='';
try{
 await page.goto(target.publicUrl);await page.getByRole('button',{name:'项目 Codex',exact:true}).click();await page.getByText('未连接',{exact:true}).waitFor();result.missingCredentialUi='OBSERVED_NOT_CONNECTED';
 child=spawn(process.env.REVIEW_TEST_PYTHON||'python3',['host/codex_conversation_bridge.py','serve','--project-root',runtime.root,'--store',path.join(runtime.root,'runtime/assistant/public'),'--private-state',path.join(runtime.root,'runtime/assistant/private'),'--mock-response','模拟提供方完成：{message}','--concurrency','1','--poll-seconds','0.3'],{stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,HOME:process.env.HOME,REVIEW_NODE_BINARY:process.execPath,REVIEW_INSTANCE_ROOT:runtime.root,REVIEW_DEPLOYMENT_MODE:'VPS',REVIEW_CODEX_AUTH_HOME:path.join(fixture,'missing-codex')}});
 done=once(child,'exit');child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
 // Reload fetches the newly started mock bridge; no cached live-auth claim.
 let ready=false;for(let n=0;n<40;n++){const response=await page.evaluate(async()=>fetch('/api/assistant/v1/conversations').then(r=>r.json()));if(response.bridge?.online){ready=true;break;}await new Promise(r=>setTimeout(r,500));if(child.exitCode!==null)break;}
 assert(ready,'Mock bridge failed to become ready: '+logs);
 await page.reload();await page.getByRole('button',{name:'项目 Codex',exact:true}).click();await page.getByText('已连接',{exact:true}).waitFor();
 page.on('response',response=>{if(response.url().includes('/api/assistant/'))result.requests.push({url:new URL(response.url()).pathname,status:response.status(),contentType:response.headers()['content-type']});});
 await page.getByLabel('想结合当前工作讨论什么？').fill('这是一条本机隔离验证消息，不调用真实模型。');
 await page.getByRole('button',{name:'发送',exact:true}).click();
 await page.getByText('模拟提供方完成：这是一条本机隔离验证消息，不调用真实模型。',{exact:true}).waitFor({timeout:60000});
 assert(result.requests.some(r=>r.url.endsWith('/events')&&r.status===200&&r.contentType.startsWith('text/event-stream')));
 await page.screenshot({path:path.join(fixture,'mock-codex-browser.png'),fullPage:true});result.status='PASS';
}catch(error){result.status='FAIL';result.error=String(error.stack||error);throw error;}
finally{
 await browser.close();if(child&&child.exitCode===null){child.kill('SIGTERM');await Promise.race([done,new Promise((_,reject)=>setTimeout(()=>reject(Error('Owned mock bridge failed graceful shutdown')),15000))]);}
 result.logTail=logs.slice(-3000);await writeFile(path.join(fixture,'mock-codex-evidence.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}
