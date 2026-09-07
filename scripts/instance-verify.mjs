import assert from 'node:assert/strict';
import {parseArgs} from 'node:util';
import {openInstanceRepository,resolveInstance} from '../host/instance-runtime/index.mjs';
import {delegateInstanceMaintenance} from './instance-maintenance.mjs';
if(await delegateInstanceMaintenance('instance-verify.mjs',process.argv.slice(2)))process.exit(0);
const {values}=parseArgs({options:{instance:{type:'string'},url:{type:'string'},'software-commit':{type:'string'}}});
if(!values.instance||!values.url)throw new Error('Explicit --instance and --url required');
const repo=(await openInstanceRepository({...resolveInstance(values.instance),readOnly:true}));
try{
 const view=(await repo.readView());
 const response=await fetch(new URL('/api/instance/runtime',values.url),{cache:'no-store'});assert.equal(response.status,200);const runtime=await response.json();
 for(const field of ['instanceId','releaseId','runtimeEpoch','dataFingerprint','recipeFingerprint'])assert.equal(runtime[field],view[field],`Serving ${field} differs from SQLite`);
 assert.equal(runtime.snapshotId,view.snapshot.snapshotId);assert.equal(runtime.projectId,view.profile.projectId);assert.equal(runtime.legacySourceFallback,false);
 if(values['software-commit'])assert.equal(runtime.softwareCommit,values['software-commit']);
 const expected=Object.fromEntries(Object.entries(view.eventsByKind).map(([kind,events])=>[kind,events.length]));assert.deepEqual(runtime.formalEventCounts,expected);
 const profile=await fetch(new URL('/api/instance/profile',values.url)).then(response=>response.json());assert.equal(profile.instanceId,view.profile.instanceId);assert.equal(profile.title,view.profile.title);
 const bootstrap=await fetch(new URL('/api/v8/ui/bootstrap',values.url)).then(response=>response.json());assert.equal(bootstrap.snapshotId,view.snapshot.snapshotId);assert.equal(bootstrap.data.instance.instanceId,view.instanceId);
 console.log(JSON.stringify({passed:true,url:values.url,instanceId:view.instanceId,releaseId:view.releaseId,runtimeEpoch:view.runtimeEpoch,dataFingerprint:view.dataFingerprint,recipeFingerprint:view.recipeFingerprint,snapshotId:view.snapshot.snapshotId,formalEventCounts:expected,legacySourceFallback:false,integrity:(await repo.integrityCheck())},null,2));
}finally{(await repo.close());}
