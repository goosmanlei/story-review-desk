import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile,access} from 'node:fs/promises';
import path from 'node:path';
import {createInstanceRepository,canonicalJson} from '../host/instance-runtime/index.mjs';
import {blankProfile,blankSnapshot} from '../host/instance-runtime/blank.mjs';
import {enqueueMaintenance,maintenanceState,claimMaintenance,finishMaintenance,validateMaintenanceRequest,MAINTENANCE_NAMESPACE} from '../host/instance-runtime/maintenance-service.mjs';
import {runMaintenanceIteration,resolveRestoreTarget,startMaintenanceWorker,maintenanceEnvironment} from '../scripts/instance-maintenance-worker.mjs';
import {readMaintenanceHeartbeat,writeMaintenanceHeartbeat,clearMaintenanceHeartbeat} from '../host/instance-runtime/maintenance-runtime.mjs';
import {maintenanceUploadDirectory,maintenanceImportSource} from '../host/instance-runtime/maintenance-files.mjs';
import {copyFile} from 'node:fs/promises';
test('imported portable backup is independently verified before listing and restore',async t=>{
 const {root,repo,call}=await fixture(t);
 await repo.writeTransaction(tx=>enqueueMaintenance(tx,{action:'backup'},{requestId:'request_import_origin'}));
 assert.equal((await runMaintenanceIteration({root,url:'http://127.0.0.1:4293',workerId:'import-worker',call})).status,'SUCCEEDED');
 const original=(await repo.readTransaction(maintenanceState)).backups[0];
 const op=await repo.getAux(MAINTENANCE_NAMESPACE,original.id),saved=JSON.parse(Buffer.from(op.bytes).toString());
 const uploadId='upload_00000000-0000-0000-0000-000000000001';await copyFile(saved.result.archivePath,path.join(await maintenanceUploadDirectory(root),uploadId+'.review-backup.gz'));
 await repo.writeTransaction(tx=>enqueueMaintenance(tx,{action:'import',uploadId},{requestId:'request_import_portable'}));
 assert.equal((await runMaintenanceIteration({root,url:'http://127.0.0.1:4293',workerId:'import-worker',call})).status,'SUCCEEDED');
 const state=await repo.readTransaction(maintenanceState);assert.equal(state.backups.length,2);assert.ok(state.backups.every(b=>b.downloadUrl));assert.equal(state.backups[0].manifestSha256,original.manifestSha256);
 const imported=state.operations.find(o=>o.action==='import');assert.equal(imported.result.imported,true);
 await repo.writeTransaction(tx=>enqueueMaintenance(tx,{action:'restore',backupId:imported.operationId,target:'imported-restore'},{requestId:'request_import_restore'}));
 assert.equal((await runMaintenanceIteration({root,url:'http://127.0.0.1:4293',workerId:'import-worker',call})).status,'SUCCEEDED');
});
test('import rejects ambiguous sources, injected fields and paths outside the project',async t=>{
 for(const input of [{action:'import'},{action:'import',uploadId:'bad'},{action:'import',sourcePath:'/a',uploadId:'upload_00000000-0000-0000-0000-000000000001'},{action:'backup',sourcePath:'/a'},{action:'import',sourcePath:'/a',status:'VERIFIED'}])assert.throws(()=>validateMaintenanceRequest(input));
 const {root}=await fixture(t);await assert.rejects(maintenanceImportSource(root,{sourcePath:'/'}),/项目内/);
});
test('idle heartbeat never appends business revisions and invalid epochs fail closed',async t=>{
 const {root,repo,call}=await fixture(t),before=await repo.readView();
 await runMaintenanceIteration({root,url:'http://127.0.0.1:4293',workerId:'idle-worker',call});
 await runMaintenanceIteration({root,url:'http://127.0.0.1:4293',workerId:'idle-worker',call});
 assert.equal((await repo.readView()).repositoryRevision,before.repositoryRevision);
 const worker=await readMaintenanceHeartbeat(root);
 assert.equal((await repo.readTransaction(tx=>maintenanceState(tx,{worker}))).capabilities.workerOnline,true);
 for(const bad of [null,{...worker,runtimeEpoch:'old'},{...worker,heartbeatAt:new Date(Date.now()+60000).toISOString()},{...worker,heartbeatAt:new Date(Date.now()-60000).toISOString()}]){
  assert.equal((await repo.readTransaction(tx=>maintenanceState(tx,{worker:bad}))).capabilities.workerOnline,false);
 }
 await clearMaintenanceHeartbeat(root,'not-the-owner');assert.ok(await readMaintenanceHeartbeat(root));
 await clearMaintenanceHeartbeat(root,'idle-worker');assert.equal(await readMaintenanceHeartbeat(root),null);
 assert.equal((await repo.readView()).repositoryRevision,before.repositoryRevision);
});

async function fixture(t){const parent=path.resolve('tests/.test-tmp');await mkdir(parent,{recursive:true});const outer=await mkdtemp(path.join(parent,'maintenance-')),root=path.join(outer,'story');await mkdir(path.join(root,'data'),{recursive:true});await mkdir(path.join(root,'media'));await mkdir(path.join(root,'runtime'));const profile=blankProfile({title:'维护隔离测试'}),repo=await createInstanceRepository({dbPath:path.join(root,'data/review.sqlite'),instanceId:profile.instanceId,profile});await repo.writeTransaction(tx=>tx.publishRelease({...blankSnapshot(profile),expectedReleaseId:null,sourceRevisionIds:[]}));await writeFile(path.join(root,'instance.json'),canonicalJson({schemaVersion:'1.0',instanceId:profile.instanceId,database:'data/review.sqlite'}));t.after(async()=>{await repo.close();await rm(outer,{recursive:true,force:true});});const external=r=>r?{...r,bytes:undefined,bytesBase64:Buffer.from(r.bytes).toString('base64')}:null;const call=async(_root,args,{input}={})=>{const command=args[0],flags=Object.fromEntries(Array.from({length:(args.length-1)/2},(_,i)=>[args[1+i*2].slice(2),args[2+i*2]]));if(command==='host-profile'){const v=await repo.readView();return{...v,profile:v.profile};}if(command==='aux-list')return(await repo.listAux(flags.namespace)).map(external);if(command==='aux-get')return external(await repo.getAux(flags.namespace,flags.key));if(command==='aux-put')return external(await repo.writeTransaction(async tx=>{const m=await tx.getMetadata();assert.equal(flags['expected-runtime-epoch'],m.runtimeEpoch);return tx.putAux({namespace:flags.namespace,key:flags.key,bytes:Buffer.from(input.bytesBase64,'base64'),expectedRevisionId:flags['expected-revision']==='NULL'?null:flags['expected-revision'],mediaType:input.mediaType});}));throw new Error(command);};return{outer,root,repo,call};}

test('maintenance queue is durable, idempotent, and rejects unverified success',async t=>{const{repo}=await fixture(t);const op=await repo.writeTransaction(tx=>enqueueMaintenance(tx,{action:'backup'},{requestId:'request_backup_1'}));assert.equal(op.status,'QUEUED');const repeat=await repo.writeTransaction(tx=>enqueueMaintenance(tx,{action:'backup'},{requestId:'request_backup_1'}));assert.equal(repeat.operationId,op.operationId);await assert.rejects(repo.writeTransaction(tx=>enqueueMaintenance(tx,{action:'verify'},{requestId:'request_backup_1'})),/其他维护任务/);const active=claimMaintenance(op,{instanceId:op.instanceId,runtimeEpoch:op.runtimeEpoch,workerId:'worker'});assert.throws(()=>finishMaintenance(active,{workerId:'worker',status:'SUCCEEDED',result:{status:'BACKUP_VERIFIED'}}),/完成证据/);assert.throws(()=>finishMaintenance(active,{workerId:'other',status:'FAILED'}),/不属于/);assert.equal((await repo.readTransaction(maintenanceState)).operations.length,1);});

test('worker executes a real isolated backup and only lists the verified artifact',async t=>{const{root,repo,call}=await fixture(t);const op=await repo.writeTransaction(tx=>enqueueMaintenance(tx,{action:'backup'},{requestId:'request_actual_backup'}));const result=await runMaintenanceIteration({root,url:'http://127.0.0.1:4293',workerId:'test-worker',call});assert.equal(result.status,'SUCCEEDED');const state=await repo.readTransaction(maintenanceState);assert.equal(state.backups.length,1);const manifest=JSON.parse(await readFile(path.join(state.backups[0].output,'backup-manifest.json'),'utf8'));assert.equal(manifest.manifestSha256,state.backups[0].manifestSha256);assert.equal(manifest.instanceId,op.instanceId);assert.equal(manifest.providerCredentialsIncluded,false);});

test('restore paths and interrupted work fail closed without automatic replay',async t=>{const{root,repo,call}=await fixture(t);for(const target of ['../outside','/tmp/test','existing/file','.','..'])assert.throws(()=>validateMaintenanceRequest({action:'restore',backupId:'maintenance_00000000-0000-0000-0000-000000000000',target}));await assert.rejects(resolveRestoreTarget(root,'story'),/当前实例/);const op=await repo.writeTransaction(tx=>enqueueMaintenance(tx,{action:'export'},{requestId:'request_interrupted'}));await repo.writeTransaction(async tx=>{const record=await tx.getAux(MAINTENANCE_NAMESPACE,op.operationId);return tx.putAux({namespace:MAINTENANCE_NAMESPACE,key:op.operationId,bytes:canonicalJson(claimMaintenance(op,{instanceId:op.instanceId,runtimeEpoch:op.runtimeEpoch,workerId:'old-worker'})),expectedRevisionId:record.revisionId});});let runs=0;await runMaintenanceIteration({root,url:'http://127.0.0.1:4293',workerId:'replacement-worker',call,recover:true,run:async()=>{runs++;throw new Error('should not run');}});assert.equal(runs,0);const state=await repo.readTransaction(maintenanceState);assert.equal(state.operations[0].status,'FAILED');assert.equal(state.operations[0].resultUnknown,true);});

test('worker creates a real read-only export and restores a verified backup into a new epoch',async t=>{const{root,outer,repo,call}=await fixture(t);const before=await repo.readView();await repo.writeTransaction(tx=>enqueueMaintenance(tx,{action:'export'},{requestId:'request_actual_export'}));assert.equal((await runMaintenanceIteration({root,url:'http://127.0.0.1:4293',workerId:'worker',call})).status,'SUCCEEDED');const backup=await repo.writeTransaction(tx=>enqueueMaintenance(tx,{action:'backup'},{requestId:'request_restore_backup'}));assert.equal((await runMaintenanceIteration({root,url:'http://127.0.0.1:4293',workerId:'worker',call})).status,'SUCCEEDED');await repo.writeTransaction(tx=>enqueueMaintenance(tx,{action:'restore',backupId:backup.operationId,target:'restored-story'},{requestId:'request_actual_restore'}));assert.equal((await runMaintenanceIteration({root,url:'http://127.0.0.1:4293',workerId:'worker',call})).status,'SUCCEEDED');const state=await repo.readTransaction(maintenanceState),restored=state.operations.find(o=>o.action==='restore');assert.notEqual(restored.result.runtimeEpoch,before.runtimeEpoch);assert.equal(restored.result.instanceId,before.instanceId);assert.equal(restored.result.output,path.join(outer,'restored-story'));assert.equal((await repo.readView()).runtimeEpoch,before.runtimeEpoch);});


test('host worker starts with a transient heartbeat without duplicate workers',async t=>{
 const {root,repo}=await fixture(t);let pid;
 try{
  const started=await startMaintenanceWorker(root,'http://127.0.0.1:4293');pid=started.pid;assert.equal(started.status,'STARTED');
  let state;for(let attempt=0;attempt<60;attempt++){const worker=await readMaintenanceHeartbeat(root);state=await repo.readTransaction(tx=>maintenanceState(tx,{worker}));if(state.capabilities.workerOnline)break;await new Promise(resolve=>setTimeout(resolve,100));}
  assert.equal(state.capabilities.workerOnline,true);
  const repeated=await startMaintenanceWorker(root,'http://127.0.0.1:4293');assert.equal(repeated.status,'ALREADY_RUNNING');assert.equal(repeated.pid,pid);
 }finally{
  if(pid){try{process.kill(pid,'SIGTERM');}catch(e){if(e.code!=='ESRCH')throw e;}
   const lock=path.join(root,'runtime/locks/maintenance-host.json');let stopped=false;
   for(let attempt=0;attempt<80;attempt++){try{await access(lock);}catch(e){if(e.code==='ENOENT'){stopped=true;break;}throw e;}await new Promise(resolve=>setTimeout(resolve,100));}
   assert.equal(stopped,true,'owned worker must stop before isolated fixture cleanup');
  }
 }
});


test('maintenance process environment excludes provider keys and Node injection options',()=>{
 const previous={OPENAI_API_KEY:process.env.OPENAI_API_KEY,NODE_OPTIONS:process.env.NODE_OPTIONS,OTHER_PROVIDER_KEY:process.env.OTHER_PROVIDER_KEY};
 try{process.env.OPENAI_API_KEY='test-only-secret';process.env.NODE_OPTIONS='--test';process.env.OTHER_PROVIDER_KEY='test-only-provider';const safe=maintenanceEnvironment();assert.equal(safe.OPENAI_API_KEY,undefined);assert.equal(safe.NODE_OPTIONS,undefined);assert.equal(safe.OTHER_PROVIDER_KEY,undefined);assert.equal(safe.PATH,process.env.PATH);}
 finally{for(const[key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
