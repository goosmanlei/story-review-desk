import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile,lstat} from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {beginPhase,releaseConsumer,phaseRecords} from '../host/instance-runtime/process-resources.mjs';

test('three real build, QA and deployment cycles leave no owned files, containers, volumes, networks, images or builders',{skip:process.env.REVIEW_PROCESS_DOCKER_TEST!=='1',timeout:600000},async()=>{
 const root=process.env.REVIEW_PROCESS_TEST_ROOT,task=process.env.REVIEW_PROCESS_TEST_TASK;if(!root||!task)throw Error('Explicit registered test root/task required');
 const docker=args=>execFileSync('docker',args,{encoding:'utf8',timeout:180000,maxBuffer:4*1024**2,stdio:['ignore','pipe','pipe']}).trim();
 for(let cycle=1;cycle<=3;cycle++){
  const build=await beginPhase(root,task,'docker-build-'+cycle),record=await build.read(),workspace=(await build.environment()).REVIEW_TASK_DIR,tag='review-process:'+record.token+'-fixture';
  const output=await build.directory(path.join(root,'output/process',record.token));
  try{
   await writeFile(path.join(workspace,'payload'),'process-fixture-'+cycle);await writeFile(path.join(workspace,'Dockerfile'),'FROM busybox:1.37.0\nCOPY payload /payload\nCMD ["sleep","300"]\n');
   const builder=await build.builder(),labels=await build.expect('image',tag);
   docker(['buildx','build','--builder',builder,'--load',...labels,'-t',tag,workspace]);await build.capture('image',tag);
   docker(['image','save','-o',path.join(output,'image.tar'),tag]);
   for(const consumer of ['docker-qa-'+cycle,'docker-deploy-'+cycle]){await build.transfer('image',tag,consumer);await build.transfer('path',output,consumer);}
  }finally{await build.finish();}
  const qa=await beginPhase(root,task,'docker-qa-'+cycle);try{const name='review-process-qa-'+record.token,labels=await qa.expect('container',name);assert.equal(docker(['run','--rm','--name',name,...labels,'--network','none',tag,'cat','/payload']),'process-fixture-'+cycle);}finally{assert.equal((await qa.finish()).status,'CLEANED');await releaseConsumer(root,task,'docker-qa-'+cycle);}
  const deploy=await beginPhase(root,task,'docker-deploy-'+cycle);try{
   const volume='review-process-volume-'+record.token,network='review-process-net-'+record.token,container='review-process-deploy-'+record.token;
   docker(['volume','create',...await deploy.expect('volume',volume),volume]);await deploy.capture('volume',volume);
   docker(['network','create',...await deploy.expect('network',network),network]);await deploy.capture('network',network);
   docker(['run','-d','--name',container,...await deploy.expect('container',container),'--network',network,'--mount','type=volume,source='+volume+',target=/data',tag]);await deploy.capture('container',container);
   assert.equal(docker(['exec',container,'sh','-c','cp /payload /data/proof; cat /data/proof']),'process-fixture-'+cycle);
  }finally{assert.equal((await deploy.finish()).status,'CLEANED');await releaseConsumer(root,task,'docker-deploy-'+cycle);}
  for(const {record:row} of (await phaseRecords(root,task)).filter(({record:r})=>r.phaseId.endsWith('-'+cycle))){assert.equal(row.status,'CLEANED');assert(row.resources.every(r=>r.state==='REMOVED'));for(const resource of row.resources.filter(r=>r.kind==='path'))await assert.rejects(lstat(resource.path),{code:'ENOENT'});}
 }
});
