import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {runMaintenanceProcess} from '../scripts/instance-maintenance.mjs';
import {runInstanceCli} from '../host/instance-runtime/transport.mjs';
import {pgBootstrap,docker} from '../scripts/instance-postgres.mjs';
import {verifyHostedExport} from '../scripts/instance-hosted-export.mjs';

test('host CLI exports an unowned PostgreSQL instance through its private network without writes or overwrite', {skip:process.env.REVIEW_POSTGRES_EXPORT_TEST!=='1',timeout:180000},async()=>{
 const parent=path.resolve('.test-tmp');await mkdir(parent,{recursive:true});const suite=await mkdtemp(path.join(parent,'pg-export-')),root=path.join(suite,'instance'),output=path.join(suite,'export');let pg;
 const cli=(script,args)=>runMaintenanceProcess(process.execPath,[path.resolve('scripts',script),...args]);
 try{
  await cli('instance-create.mjs',['--instance',root,'--title','导出回归']);pg=await pgBootstrap(root);
  const before=await runInstanceCli(root,['host-profile']);
  const result=JSON.parse((await cli('instance-export-hosted.mjs',['--instance',root,'--output',output])).stdout);
  assert.equal(result.status,'HOSTED_EXPORT_VERIFIED');assert.equal(result.output,output);assert.equal(result.instanceId,before.instanceId);assert.equal(result.mediaFiles,0);assert.equal(result.originalAudioIncluded,false);
  await verifyHostedExport(output);const original=await readFile(path.join(output,'hosted-export-manifest.json'));
  assert.equal(JSON.parse(original).captureMode,'SINGLE_POSTGRES_REPEATABLE_READ_TRANSACTION');
  await assert.rejects(cli('instance-export-hosted.mjs',['--instance',root,'--output',output]),/new path/);
  assert.deepEqual(await readFile(path.join(output,'hosted-export-manifest.json')),original);
  const after=await runInstanceCli(root,['host-profile']);for(const key of ['instanceId','runtimeEpoch','repositoryRevision','releaseId'])assert.equal(after[key],before[key]);
 }finally{
  if(pg){await docker(['rm','-f',pg.container]);await docker(['volume','rm',pg.volume]);await docker(['network','rm',pg.network]);}
  await rm(suite,{recursive:true,force:true});
 }
});
