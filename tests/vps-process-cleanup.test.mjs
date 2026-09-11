import test from 'node:test';
import assert from 'node:assert/strict';
import {VpsDriver} from '../host/instance-runtime/vps-driver.mjs';
import {sha256} from '../host/instance-runtime/bytes.mjs';
import {processTimerUnits} from '../host/instance-runtime/vps-process-service.mjs';

function fixture(){
 const target={targetId:'fixture',runtime:{nodeBinary:'/usr/bin/node'}},manifest='a'.repeat(64),verifier='review-vps-verify-'+sha256('fixture'+manifest).slice(0,20);
 const runtime={id:'runtime-one',instanceId:'story',appImage:'app',pgImage:'postgres',importer:'importer',volume:'current-volume',root:'/protected/runtime'};
 const state={current:{runtime},pending:null,verifiers:[verifier],verifierOwners:{[verifier]:manifest},imageInventory:['app','unused'],imageOwners:{unused:{id:'unused-id'}}};
 const labels=role=>({'review.vps.target':'fixture','review.vps.runtime':runtime.id,'review.instance':'story','review.vps.role':role});
 const objects={['container:'+verifier]:{Id:verifier,State:{Running:true},Config:{Labels:{'review.vps.target':'fixture','review.vps.manifest':manifest,'review.vps.role':'verifier'}}},'container:importer':{Id:'importer',State:{Running:true},Config:{Labels:labels('importer')}},'container:web':{Id:'web',Image:'app-id',State:{Running:true},Config:{Image:'app',Labels:labels('web')}},'image:app':{Id:'app-id'},'image:unused':{Id:'unused-id'},'volume:current-volume':{Name:'current-volume'}};
 const driver=new VpsDriver(target,state),calls=[];driver.save=async()=>{};driver.object=async(kind,name)=>objects[kind+':'+name]||null;
 driver.docker=async args=>{calls.push(args);if(args[0]==='stop'){objects['container:'+args.at(-1)].State.Running=false;return '';}
  if(args[1]==='rm'){delete objects[args[0]+':'+args.at(-1)];return '';}
  if(args[0]==='container'&&args[1]==='ls')return Object.entries(objects).filter(([key])=>key.startsWith('container:')).map(([,value])=>JSON.stringify({ID:value.Id})).join('\n');throw Error('Unexpected mutation '+args);};
 return {driver,state,objects,calls,verifier,runtime};
}
test('three publisher cleanup cycles reclaim only exact process objects and preserve the live database',async()=>{
 for(let cycle=0;cycle<3;cycle++){
  const {driver,objects,state}=fixture();const receipt=await driver.cleanupProcesses();assert.equal(receipt.status,'CLEANED');
  assert.deepEqual(Object.keys(objects).sort(),['container:web','image:app','volume:current-volume']);assert.equal(state.verifiers.length,0);
  assert.equal((await driver.cleanupProcesses()).status,'CLEANED');
 }
});
test('SAVING and interrupted restore keep their pending runtime, image and clean slots',async()=>{
 for(const phase of ['RESTORING','SAVING']){
  const {driver,state,objects,runtime}=fixture();state.pending={phase,runtime:{...runtime,appImage:'unused'},manifest:{images:[{reference:'unused'}]}};state.backup={slot:'clean-0'};state.current.slot='clean-1';
  const before=JSON.stringify({pending:state.pending,current:state.current,backup:state.backup});assert.equal((await driver.cleanupProcesses()).status,'CLEANED');assert(objects['image:unused']);assert(objects['volume:current-volume']);assert.equal(JSON.stringify({pending:state.pending,current:state.current,backup:state.backup}),before);
 }
});
test('unknown verifier, image digest drift and a new consumer block deletion',async()=>{
 const {driver,state,objects,verifier}=fixture();objects['container:'+verifier].Config.Labels['review.vps.target']='foreign';objects['image:unused'].Id='changed';const result=await driver.cleanupProcesses();assert.equal(result.status,'CLEANUP_REQUIRED');assert(objects['container:'+verifier]);assert(objects['image:unused']);
 const second=fixture();second.objects['container:web'].Image='unused-id';assert.equal((await second.driver.cleanupProcesses()).status,'CLEANED');assert(second.objects['image:unused']);
});
test('systemd timer has a boot trigger, five-minute interval, bounded run and no unbounded journal output',()=>{
 const units=processTimerUnits({targetId:'fixture',runtime:{nodeBinary:'/usr/bin/node'}},'/home/work/project/maintenance/process-cleanup.mjs');assert.match(units.timer,/OnBootSec=1min/);assert.match(units.timer,/OnUnitActiveSec=5min/);assert.match(units.service,/TimeoutStartSec=240/);assert.match(units.service,/StandardOutput=null/);assert.match(units.service,/ExecStart="\/usr\/bin\/node"/);
});
