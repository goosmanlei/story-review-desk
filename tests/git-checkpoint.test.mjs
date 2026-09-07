import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat,rename,realpath} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {canonicalJson,sha256} from '../host/instance-runtime/bytes.mjs';
import {validateCheckpointBinding,verifyCheckpointRemote,checkpointNeeded,checkpointOnce} from '../scripts/instance-git-checkpoint.mjs';
import {installCheckpointSnapshot,recoverCheckpointInstall} from '../scripts/instance-git-snapshot-install.mjs';
function binding(root='/explicit-project'){
 return{schemaVersion:'1.0',enabled:true,instanceId:'instance-fixture',instanceRoot:root+'/instances/story',repositoryRoot:root,githubRepository:'owner/story',remote:'origin',remoteUrl:'https://github.com/owner/story.git',branch:'main',snapshotPath:'project-data',mediaPrefix:'instances/story/media',core:{repository:'owner/core',commit:'c'.repeat(40),packageRoot:root+'/review-software',packageManifestSha256:'d'.repeat(64)},pollSeconds:30};
}
function fakeGit(b,{privateRepo=true,remote=b.remoteUrl}={}){
 const calls=[];let head='1'.repeat(40),remoteHead=head,staged=false,committedManifest=null;
 const run=async(command,args)=>{
  calls.push([command,...args]);if(command==='gh')return{code:0,stdout:JSON.stringify({id:1,full_name:b.githubRepository,private:privateRepo,archived:false,permissions:{push:true}})};
  const git=args.slice(3),name=git[0];let stdout='';
  if(name==='rev-parse')stdout=git[1]==='--show-toplevel'?b.repositoryRoot:head;
  else if(name==='branch')stdout=b.branch;
  else if(name==='remote')stdout=remote;
  else if(name==='config')return{code:1,stdout:''};
  else if(name==='check-attr'){const paths=git.slice(git.indexOf('--')+1);stdout=paths.flatMap(file=>[file,'filter','lfs']).join('\0')+'\0';}
  else if(name==='add')staged=true;
  else if(name==='diff'&&git.includes('--cached'))stdout=staged&&!committedManifest?b.snapshotPath+'/manifest.json\0':'';
  else if(name==='commit'){head='2'.repeat(40);staged=false;committedManifest=await readFile(path.join(b.repositoryRoot,b.snapshotPath,'manifest.json'),'utf8');}
  else if(name==='show')stdout=committedManifest;
  else if(name==='ls-remote')stdout=remoteHead+'\trefs/heads/'+b.branch;
  else if(name==='push')remoteHead=head;
  return{code:0,stdout};
 };
 return{calls,run};
}
async function snapshot(folder,b,fingerprint){
 await mkdir(folder);const archive=Buffer.from('synthetic compressed artifact'),doc=Buffer.from('synthetic restore instructions');await writeFile(path.join(folder,'repository.jsonl.gz'),archive);await writeFile(path.join(folder,'RESTORE.md'),doc);
 const body={schemaVersion:'1.0',kind:'REVIEW_GIT_BUSINESS_SNAPSHOT_1',instanceId:b.instanceId,businessFingerprint:fingerprint,core:{repository:b.core.repository,commit:b.core.commit,packageManifestSha256:b.core.packageManifestSha256},database:{path:'repository.jsonl.gz',bytes:archive.length,sha256:sha256(archive)},documentation:{path:'RESTORE.md',sha256:sha256(doc)},files:[]};
 const manifest={...body,manifestSha256:sha256(canonicalJson(body))};await writeFile(path.join(folder,'manifest.json'),canonicalJson(manifest));return manifest;
}
test('binding never discovers parent roots and requires an exact distinct pinned core and private remote',()=>{
 const b=binding();assert.equal(validateCheckpointBinding(b,{instanceRoot:b.instanceRoot,softwareRoot:b.core.packageRoot}),b);
 for(const change of [{enabled:false},{instanceRoot:'/other'},{remoteUrl:'https://attacker.invalid/repo.git'},{core:{...b.core,commit:'main'}},{snapshotPath:'../outside'},{branch:'main..other'}])assert.throws(()=>validateCheckpointBinding({...b,...change},{instanceRoot:b.instanceRoot,softwareRoot:b.core.packageRoot}));
});
test('public repositories and rewritten remotes are rejected without commit or push',async()=>{
 for(const config of [{privateRepo:false},{remote:'https://github.com/other/wrong.git'}]){
  const b=binding(),git=fakeGit(b,config);await assert.rejects(verifyCheckpointRemote(b,git.run));assert.ok(git.calls.every(call=>!call.includes('commit')&&!call.includes('push')));
 }
});
test('unchanged fingerprint and core pin need no history export; changes to either do',()=>{
 const b=binding(),manifest={businessFingerprint:'same',core:{repository:b.core.repository,commit:b.core.commit,packageManifestSha256:b.core.packageManifestSha256}};
 assert.equal(checkpointNeeded({fingerprint:'same'},manifest,b),false);
 assert.equal(checkpointNeeded({fingerprint:'draft-changed'},manifest,b),true);
 assert.equal(checkpointNeeded({fingerprint:'same'},manifest,{...b,core:{...b.core,commit:'a'.repeat(40)}}),true);
});
test('checkpoint uses simulated Git, exports once for repeated light state and verifies exact remote SHA',async()=>{
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'review-git-checkpoint-'))),b=binding(root);
 try{
  await mkdir(path.join(b.instanceRoot,'runtime'),{recursive:true});const git=fakeGit(b);let exports=0;
  const exporter=async(_instance,folder,args)=>{exports++;assert.equal(args.expectedFingerprint,'fingerprint-one');return snapshot(folder,b,'fingerprint-one');};
  const call=async(_root,args)=>{assert.deepEqual(args,['git-business-state']);return{instanceId:b.instanceId,fingerprint:'fingerprint-one'};};
  const first=await checkpointOnce(b.instanceRoot,{binding:b,call,run:git.run,exporter});
  const second=await checkpointOnce(b.instanceRoot,{binding:b,call,run:git.run,exporter});
  assert.equal(exports,1);assert.equal(first.status,'CHECKPOINT_PUSHED');assert.equal(second.status,'UNCHANGED_VERIFIED');assert.equal(first.localCommit,first.remoteCommit);
  assert.equal(git.calls.filter(call=>call.includes('commit')).length,1);assert.equal(git.calls.filter(call=>call.includes('push')).length,1);
  assert.ok(git.calls.every(call=>!call.includes('--force')&&!call.includes('reset')&&!call.includes('merge')));
 }finally{await rm(root,{recursive:true,force:true});}
});
test('snapshot installation preserves unknown/user-modified files and can recover the exact crash journal',async()=>{
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'review-git-install-'))),b=binding(root);
 try{
  await mkdir(path.join(b.instanceRoot,'runtime'),{recursive:true});const old=await snapshot(path.join(root,b.snapshotPath),b,'before');
  const staging=path.join(root,b.snapshotPath+'-staging-12345678-1234-1234-1234-123456789abc');const next=await snapshot(staging,b,'after');
  await writeFile(path.join(root,b.snapshotPath,'user-note.md'),'preserve me');
  await assert.rejects(installCheckpointSnapshot(b.instanceRoot,b,staging),/unknown/);assert.equal(await readFile(path.join(root,b.snapshotPath,'user-note.md'),'utf8'),'preserve me');
  await rm(path.join(root,b.snapshotPath,'user-note.md'));
  await installCheckpointSnapshot(b.instanceRoot,b,staging);
  assert.equal(JSON.parse(await readFile(path.join(root,b.snapshotPath,'manifest.json'),'utf8')).manifestSha256,next.manifestSha256);
  assert.equal(await recoverCheckpointInstall(b.instanceRoot,b),false);
  await writeFile(path.join(root,b.snapshotPath,'RESTORE.md'),'user edited instructions');
  const another=path.join(root,b.snapshotPath+'-staging-22345678-1234-1234-1234-123456789abc');await snapshot(another,b,'another');
  await assert.rejects(installCheckpointSnapshot(b.instanceRoot,b,another),/modified/);assert.equal(await readFile(path.join(root,b.snapshotPath,'RESTORE.md'),'utf8'),'user edited instructions');
  assert.ok(old.manifestSha256);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('interrupted directory replacement resumes only from the exact recorded old and new manifests',async()=>{
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'review-git-recover-'))),b=binding(root);
 try{
  const work=path.join(b.instanceRoot,'runtime','git-checkpoint');await mkdir(work,{recursive:true});
  const target=path.join(root,b.snapshotPath),old=await snapshot(target,b,'old');
  const staging=path.join(root,b.snapshotPath+'-staging-12345678-1234-1234-1234-123456789abc'),next=await snapshot(staging,b,'new');
  const previous=path.join(work,'replaced-12345678-1234-1234-1234-123456789abc'),body={instanceId:b.instanceId,target,staging,previous,newManifestSha:next.manifestSha256,previousManifestSha:old.manifestSha256};
  await writeFile(path.join(work,'pending-install.json'),canonicalJson({...body,sha256:sha256(canonicalJson(body))}));
  await rename(target,previous); // Simulated interruption between the two renames.
  assert.equal(await recoverCheckpointInstall(b.instanceRoot,b),true);
  assert.equal(JSON.parse(await readFile(path.join(target,'manifest.json'),'utf8')).manifestSha256,next.manifestSha256);
  await assert.rejects(stat(previous),{code:'ENOENT'});assert.equal(await recoverCheckpointInstall(b.instanceRoot,b),false);
 }finally{await rm(root,{recursive:true,force:true});}
});
