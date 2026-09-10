import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeCapacity,validateRuntimeCapacity,validateRestoreMeasurement,restoreContractFromFiles,restoreMethodSha256} from '../host/instance-runtime/vps-capacity.mjs';
import {planVps,emptyVpsState} from '../host/instance-runtime/vps-journal.mjs';
import {command} from '../host/instance-runtime/vps-process.mjs';
const GiB=1024**3;
const baseline={manifestSha256:'a'.repeat(64),instanceId:'instance_test',releaseId:'source_test',database:{bytes:16*GiB,sha256:'b'.repeat(64)},files:[{bytes:GiB}]};
const measured=()=>({kind:'REVIEW_VPS_RESTORE_MEASUREMENT',schemaVersion:'1.0',status:'RESTORED_VERIFIED',baselineManifestSha256:baseline.manifestSha256,databaseSha256:baseline.database.sha256,databaseArchiveBytes:baseline.database.bytes,restoreContractSha256:'c'.repeat(64),architecture:'linux/arm64',postgresVersion:'18.6',sampleCount:10,peakDataBytes:15*GiB,peakWalBytes:2*GiB,peakPostgresBytes:16*GiB,maxWalSizeBytes:GiB,scratchArchiveBytes:0,streamPasses:4,instanceId:baseline.instanceId,sourceReleaseId:baseline.releaseId,runtimeEpoch:'restore_v1_00000000-0000-0000-0000-000000000000',originalBytesPreserved:true,businessIdsPreserved:true});
const files=[{path:'software/app',bytes:8192}];
test('capacity is measured data/indexes plus explicit WAL/media/software/headroom, not archive multiples',()=>{
 const result=runtimeCapacity(measured(),baseline,files);
 assert.equal(result.components.databaseDataAndIndexesBytes,15*GiB);
 assert.equal(result.components.databaseLayoutHeadroomBytes,3*GiB);
 assert.equal(result.components.databaseWalBytes,2*GiB);
 assert.equal(result.components.databaseWalHeadroomBytes,GiB);
 assert.equal(result.components.mediaBytes,GiB);
 assert.equal(result.components.softwareBytes,8192);
 assert(result.runtimeBudgetBytes<baseline.database.bytes*2);
 assert.equal(validateRuntimeCapacity(result,baseline,files,result.runtimeBudgetBytes),result);
 assert.throws(()=>validateRuntimeCapacity({...result,components:{...result.components,mediaBytes:0}},baseline,files,result.runtimeBudgetBytes),/differs/);
});
test('capacity proof rejects different baselines, unfinished/partial restores and mismatched contracts',()=>{
 for(const patch of [{status:'RESTORING'},{baselineManifestSha256:'x'},{databaseSha256:'x'},{databaseArchiveBytes:1},{architecture:'darwin/arm64'},{postgresVersion:'19'},{sampleCount:0},{peakWalBytes:0},{peakPostgresBytes:50*GiB},{scratchArchiveBytes:16*GiB},{streamPasses:2},{instanceId:'other'},{sourceReleaseId:'other'},{runtimeEpoch:'old'},{originalBytesPreserved:false},{businessIdsPreserved:false}])assert.throws(()=>validateRestoreMeasurement({...measured(),...patch},baseline));
 assert.throws(()=>validateRestoreMeasurement(measured(),baseline,{restoreContractSha256:'d'.repeat(64)}),/contract/);
 const clean=validateRestoreMeasurement({...measured(),runtime:{root:'/private/local-only'},samples:['verbose']},baseline);assert(!('runtime' in clean));assert(!('samples' in clean));
});
test('restore contract is order stable and binds database code but not UI or publisher bookkeeping',()=>{
 const input=[{path:'scripts/instance-vps-import.mjs',sha256:'a'},{path:'host/instance-runtime/postgres-schema.mjs',sha256:'b'},{path:'host/instance-runtime/postgres.mjs',sha256:'c'}];
 const implementation=restoreMethodSha256('\n async restore(source,runtime){ restore(); }\n async startWeb(){}'),contract=files=>restoreContractFromFiles(files,implementation);
 const hash=contract(input);assert.equal(hash,contract(input.toReversed()));
 assert.equal(hash,contract([...input,{path:'host/instance-runtime/vps-capacity.mjs',sha256:'x'},{path:'src/ui.tsx',sha256:'x'}]));
 assert.notEqual(hash,contract(input.map(f=>({...f,sha256:f.sha256+'x'}))));
 assert.notEqual(hash,restoreContractFromFiles(input,'d'.repeat(64)));
 assert.throws(()=>contract([]),/Missing/);assert.throws(()=>restoreMethodSha256(''),/Cannot/);
});
const target={targetId:'test',retention:{maxTemporaryBytes:100,reserveBytes:200}};
function manifest(){return {releaseId:'new',runtimeBudgetBytes:1000,totalFileBytes:2000,images:[{id:'image',path:'images/app',loadedBytes:50}],files:[{path:'images/app',bytes:30}]};}
test('first deployment counts one runtime, one clean package and image allocations once by category',()=>{
 const m=manifest(),plan=planVps(target,emptyVpsState(target),m,{freeBytes:1e9});
 assert.equal(plan.requiredFreeBytes,1000+plan.packageBytes+50+30+100+200);
 assert.equal(plan.runtimeReclaimBytes,0);assert.equal(plan.oldestCleanReclaimBytes,0);
 assert.equal(plan.phases[0].requiredFreeBytes,380);
 assert.equal(plan.phases[1].requiredFreeBytes,1380);
});
test('phase credits never free a runtime during input verification or an old package before opening',()=>{
 const state={...emptyVpsState(target),current:{releaseId:'current'},backup:{releaseId:'old'}};
 const inspection={freeBytes:500,hostDockerSameFilesystem:true,reclaimableRuntimeBytes:1000,reclaimableOldestCleanBytes:10000};
 const plan=planVps(target,state,manifest(),inspection);
 assert.equal(plan.allowed,true);assert.equal(plan.requiredFreeBytes,380);
 assert.equal(plan.phases[0].requiredFreeBytes,380);assert.equal(plan.phases[1].requiredFreeBytes,380);
 assert.equal(plan.phases[2].requiredFreeBytes,0);
 const cannotVerify=planVps(target,state,manifest(),{...inspection,freeBytes:379});assert.equal(cannotVerify.allowed,false);
 const smallerCurrent=planVps(target,state,manifest(),{...inspection,reclaimableRuntimeBytes:0});assert.equal(smallerCurrent.allowed,false);assert.equal(smallerCurrent.phases[1].requiredFreeBytes,1380);
});
test('rollback swaps existing packages, missing ownership/filesystem evidence receives no credit',()=>{
 const state={...emptyVpsState(target),current:{releaseId:'current'},backup:{releaseId:'old'}},inspection={freeBytes:1e9,reclaimableRuntimeBytes:1000,reclaimableOldestCleanBytes:10000,hostDockerSameFilesystem:true};
 const rollback=planVps(target,state,manifest(),inspection,{action:'rollback'});
 assert.equal(rollback.requiredFreeBytes,380);assert.equal(rollback.oldestCleanReclaimBytes,0);
 const split=planVps(target,state,manifest(),{...inspection,hostDockerSameFilesystem:false});assert.equal(split.runtimeReclaimBytes,0);assert.equal(split.oldestCleanReclaimBytes,0);
 const reused=planVps(target,state,manifest(),{...inspection,images:[{digest:'image'}]});assert.equal(reused.loadedImageBytes,0);assert.equal(reused.imageContentBytes,0);
 const fallback=planVps(target,state,manifest(),{...inspection,fallbackRuntimeBudgetBytes:5000});assert.equal(fallback.requiredFreeBytes,4380);
 assert.throws(()=>planVps(target,state,manifest(),{...inspection,reclaimableRuntimeBytes:-1}),/Invalid/);
});
test('an early child exit preserves actionable diagnostics instead of only EPIPE',async()=>{
 async function* input(){for(let i=0;i<100;i++)yield Buffer.alloc(1024**2);}
 await assert.rejects(command(process.execPath,['-e',"process.stderr.write('controlled startup failure');process.exit(9)"],{input:input()}),/controlled startup failure/);
});
