import assert from 'node:assert/strict';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {chromium} from '@playwright/test';
import {requiredPhase} from '../tools/process-resources.mjs';
import {originalReady} from './original-readiness.mjs';
import {assertFreePort} from '../tools/io.mjs';
const phase=await requiredPhase(process.cwd());assert(phase);
const source=process.env.REVIEW_STANDALONE_SERVER,root=process.env.REVIEW_INSTANCE_ROOT,port=3930;
assert(source?.includes('/.process/stages/')&&root?.includes('/.process/stages/'),'Use an owned standalone fixture');
await assertFreePort(port,'127.0.0.1');
const browser=await chromium.launch({channel:'chrome'}),measurements=[];let child;
async function stop(){if(!child)return;const p=child;child=null;if(p.exitCode!==null)return;p.kill('SIGTERM');await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{p.kill('SIGKILL');reject(Error('Owned preview did not stop'));},5000);p.once('exit',()=>{clearTimeout(timer);resolve();});});}
try{
 for(let i=0;i<5;i++){
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),session=await context.newCDPSession(page);await session.send('Network.enable');await session.send('Network.setCacheDisabled',{cacheDisabled:true});
  const start=performance.now();child=spawn(process.execPath,[source],{cwd:path.dirname(source),env:{...process.env,REVIEW_INSTANCE_ROOT:root,PORT:String(port),HOSTNAME:'127.0.0.1'},stdio:'ignore'});
  for(let attempt=0;;attempt++){assert(attempt<100,'Cold process failed to start');try{await page.goto('http://127.0.0.1:'+port+'/?view=overview',{waitUntil:'domcontentloaded'});break;}catch{await new Promise(r=>setTimeout(r,25));}}
  await originalReady(page,'overview');measurements.push(Math.round(performance.now()-start));await context.close();await stop();
 }
 assert(measurements.every(ms=>ms<=3000),JSON.stringify(measurements));const report={status:'PASSED',milliseconds:measurements,scope:'Five new Web processes, empty frontend/backend caches, fresh browser contexts, existing independent database and worker'};
 const directory=path.resolve('.process/stages/original-cold-process-'+Date.now());await phase.directory(directory);await writeFile(path.join(directory,'cold-process.json'),JSON.stringify(report,null,2));await phase.transfer('path',directory,'local-delivery');console.log(JSON.stringify({...report,directory}));
}finally{await stop();await browser.close();}
