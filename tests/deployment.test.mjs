import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,rm,rename} from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {requiredPhase,beginPhase,releaseConsumer} from '../tools/process-resources.mjs';
import {createProject} from '../tools/project.mjs';
import {resolveSource,snapshotSource,installSoftware,verifyInstalledSoftware,reconcileSoftware} from '../tools/deployment.mjs';
import {parseDeploymentArgs,deploymentExit} from '../tools/deploy.mjs';
import {checkRemoteConnection} from '../tools/remote.mjs';
import {json,atomic} from '../tools/io.mjs';

test('deployment targets and outcomes are explicit',()=>{
 assert.equal(parseDeploymentArgs([]).target,'local');
 for(const target of ['local','vps-bj','all'])assert.equal(parseDeploymentArgs(['--target',target]).target,target);
 assert(parseDeploymentArgs(['--dry-run'])['dry-run']);
 assert.equal(deploymentExit({cleanup:'CLEANED',targets:{local:{status:'SUCCEEDED'},'vps-bj':{status:'SKIPPED'}}}),2);
 assert.equal(deploymentExit({cleanup:'CLEANED',targets:{local:{status:'RESULT_UNKNOWN'}}}),1);
 assert.equal(deploymentExit({cleanup:'CLEANED',targets:{local:{status:'SUCCEEDED'}}}),0);
 assert.equal(checkRemoteConnection('unreachable',{execute:()=>{throw Error('fixture timeout');}}).connected,false);
});

test('clean Git snapshot stays fixed; owned software swaps recover and protect user changes',async t=>{
 const outer=await requiredPhase(process.cwd());assert(outer);const scratch=(await outer.read()).resources[0].path;
 const source=path.join(scratch,'source');await mkdir(source);const git=(...args)=>execFileSync('git',['-C',source,...args],{encoding:'utf8'}).trim();
 git('init','-b','main');git('config','user.name','Fixture');git('config','user.email','fixture@invalid');
 for(const dir of ['server','tools'])await mkdir(path.join(source,dir));
 await writeFile(path.join(source,'package.json'),'{"name":"story-review-desk"}');await writeFile(path.join(source,'server/schema.sql'),'-- fixture');await writeFile(path.join(source,'tools/deploy.mjs'),'// fixture');await writeFile(path.join(source,'file.txt'),'one');
 git('add','.');git('commit','-m','fixture one');const selected=await resolveSource(source);
 await writeFile(path.join(source,'file.txt'),'two');git('add','.');git('commit','-m','fixture two');
 await writeFile(path.join(source,'file.txt'),'dirty');await writeFile(path.join(source,'unknown.txt'),'untracked');
 const frozen=path.join(scratch,'frozen'),manifest=await snapshotSource(selected,frozen);assert.equal(await readFile(path.join(frozen,'file.txt'),'utf8'),'one');await assert.rejects(readFile(path.join(frozen,'unknown.txt')));
 assert.notEqual((await resolveSource(source)).commit,manifest.commit);assert((await resolveSource(source)).dirty);
 const root=path.join(scratch,'project');await createProject(root,{initializeGit:false,host:'fixture'});
 const first=await beginPhase(root,'test','install');
 await installSoftware(root,frozen,manifest,{operationId:'first',phase:first,updatePin:true});await releaseConsumer(root,'test','activation');assert.equal((await first.finish()).status,'CLEANED');
 const second=await beginPhase(root,'test','second');
 await installSoftware(root,frozen,manifest,{operationId:'second',phase:second});
 let journal=await json(path.join(root,'instance/runtime/software-switch.json'));
 await rename(journal.target,journal.candidate);await atomic(path.join(root,'instance/runtime/software-switch.json'),{...journal,status:'PREPARED'});
 await reconcileSoftware(root);assert.equal((await verifyInstalledSoftware(root)).commit,manifest.commit);
 await releaseConsumer(root,'test','activation');assert.equal((await second.finish()).status,'CLEANED');
 await writeFile(path.join(root,'review-software/file.txt'),'user edit');await assert.rejects(verifyInstalledSoftware(root),/无法确认归属/);
 // This Git repository was created by this fixture and has no external work.
 assert.equal(git('remote'), '');await rm(path.join(source,'.git'),{recursive:true});
});
