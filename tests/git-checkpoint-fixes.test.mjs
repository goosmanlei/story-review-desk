import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {sha256,canonicalJson} from '../host/instance-runtime/bytes.mjs';
import {checkpointPollDelay,loadCheckpointBinding} from '../scripts/instance-git-checkpoint.mjs';
import {verifyGitSnapshot} from '../scripts/instance-git-export.mjs';
test('poll seconds are converted to milliseconds, including the default',()=>{
 assert.equal(checkpointPollDelay({}),30000);assert.equal(checkpointPollDelay({pollSeconds:10}),10000);assert.equal(checkpointPollDelay({pollSeconds:3600}),3600000);
});
test('loading checkpoint binding verifies every pinned source file, not just the manifest',async()=>{
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'review-git-pin-'))),instance=path.join(root,'instances/story'),software=path.join(root,'review-software');
 try{
  await mkdir(path.join(instance,'runtime'),{recursive:true});await mkdir(path.join(instance,'media'));await mkdir(path.join(software,'scripts'),{recursive:true});
  const code=Buffer.from('original source'),entry={path:'scripts/worker.mjs',sha256:sha256(code),bytes:code.length};await writeFile(path.join(software,entry.path),code);
  const manifest={kind:'STORY_NEUTRAL_SOFTWARE',softwareCommit:'c'.repeat(40),copiedBusinessData:false,copiedCredentials:false,productionStorySpecificHits:[],files:[entry]},manifestBytes=Buffer.from(canonicalJson(manifest));await writeFile(path.join(software,'software-manifest.json'),manifestBytes);
  const pin={schemaVersion:'1.0',kind:'CORE_SOFTWARE_PIN',packagePath:'review-software',commit:manifest.softwareCommit,softwareManifestSha256:sha256(manifestBytes),repository:'https://github.com/owner/core.git'};await writeFile(path.join(root,'core-lock.json'),canonicalJson(pin));
  const binding={schemaVersion:'1.0',enabled:true,instanceId:'instance-fixture',instanceRoot:instance,repositoryRoot:root,githubRepository:'owner/story',remote:'origin',remoteUrl:'https://github.com/owner/story.git',branch:'main',snapshotPath:'project-data',mediaPrefix:'instances/story/media',core:{repository:'owner/core',commit:pin.commit,packageRoot:software,packageManifestSha256:pin.softwareManifestSha256}};
  await writeFile(path.join(instance,'instance.json'),canonicalJson({schemaVersion:'2.0',instanceId:binding.instanceId}));await writeFile(path.join(instance,'runtime/git-checkpoint.json'),canonicalJson(binding));
  assert.deepEqual(await loadCheckpointBinding(instance,{softwareRoot:software}),binding);
  await writeFile(path.join(software,entry.path),'tampered source');
  await assert.rejects(loadCheckpointBinding(instance,{softwareRoot:software}),/Managed software changed/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('Git snapshot verification rejects modified restore instructions before archive/decompression work',async()=>{
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'review-git-restore-doc-')));
 try{
  const folder=path.join(root,'snapshot');await mkdir(folder);await writeFile(path.join(folder,'RESTORE.md'),'modified instructions');
  const body={kind:'REVIEW_GIT_BUSINESS_SNAPSHOT_1',schemaVersion:'1.0',fullBackup:false,privateConversationHistoryIncluded:false,providerCredentialsIncluded:false,core:{repository:'owner/core',commit:'c'.repeat(40),packageManifestSha256:'d'.repeat(64)},mediaPrefix:'instances/story/media',documentation:{path:'RESTORE.md',sha256:sha256('original instructions')}};
  await writeFile(path.join(folder,'manifest.json'),canonicalJson({...body,manifestSha256:sha256(canonicalJson(body))}));
  await assert.rejects(verifyGitSnapshot(folder,root),/Restore instructions SHA/);
 }finally{await rm(root,{recursive:true,force:true});}
});
