import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {mkdtemp,mkdir,readFile,writeFile,cp,rm,readdir} from 'node:fs/promises';
import {createProject} from '../tools/project.mjs';
import {installSoftware,verifyInstalledSoftware} from '../tools/deployment.mjs';
import {treeManifest} from '../tools/io.mjs';
import {beginPhase,releaseConsumer,processAlive,processIdentity} from '../tools/process-resources.mjs';
import {bootIdentity,durableExecutionFile} from '../tools/execution-runtime.mjs';
import {location,startRun,mutate,readLedger,readBindings,runtimeState,updateBinding} from '../tools/task-ledger.mjs';

const source=fileURLToPath(new URL('../',import.meta.url));
const read=async file=>JSON.parse(await readFile(file,'utf8'));
const req=x=>({operationId:randomUUID(),actor:'SERVICE_FIXTURE',...x});
const caps={delegation:true,closeVerified:true,availableSlots:3,models:[{model:'gpt-5.6-sol',efforts:['xhigh']}]};
const spec={clarified:true,discussion:{approved:true,summary:'受控恢复测试',feasibility:'仅隔离文件与协议',approvedRequirements:['防重复恢复']},title:'通用服务恢复',type:'SYSTEM',originalRequest:'fixture',goal:'核查原执行',scope:['fixture'],deliverables:['proof'],acceptanceCriteria:['pass'],authorization:'仅受管隔离测试'};
async function scratch(t){assert(process.env.REVIEW_TASK_DIR);const root=await mkdtemp(path.join(process.env.REVIEW_TASK_DIR,'foundation-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}

// A source-tree installation fixture, not a release/commit or actual project
// upgrade. installSoftware and createProject are the production entry points.
test('standard installation and upgrade deliver one generic implementation without copying execution eligibility',async t=>{
 const base=await scratch(t),software=path.join(base,'source-tree');await mkdir(software);
 for(const name of ['tools','server/transport-contract.mjs','skills/review-tasks']){await mkdir(path.dirname(path.join(software,name)),{recursive:true});await cp(path.join(source,name),path.join(software,name),{recursive:true});}
 await writeFile(path.join(software,'package.json'),JSON.stringify({type:'module'}));
 const roots=[path.join(base,'standard-one'),path.join(base,'standard-two')];
 for(const root of roots)await createProject(root,{source,initializeGit:false,host:'fixture'});
 const install=async(root,label)=>{
  const phase=await beginPhase(root,'service-install',label);
  try{await installSoftware(root,software,{commit:'f'.repeat(40),files:await treeManifest(software)},{operationId:label,phase,updatePin:true});await releaseConsumer(root,'service-install','activation');assert.equal((await phase.finish()).status,'CLEANED');}
  catch(error){await releaseConsumer(root,'service-install','activation');await phase.finish({outcome:'FAILED'});throw error;}
 };
 await install(roots[0],'initial');
 const one=await startRun(roots[0]),loc=await location(roots[0]);
 const originalRun=await readFile(path.join(loc.runtime,'run.json'));
 await durableExecutionFile(path.join(loc.runtime,'private-receipt.json'),{operationId:'private-original',runId:one.id});
 await install(roots[0],'upgrade');await install(roots[1],'initial');
 assert.deepEqual(await readFile(path.join(loc.runtime,'run.json')),originalRun,'升级不得启动/替换协调执行');
 assert.equal((await read(path.join(loc.runtime,'private-receipt.json'))).operationId,'private-original');
 for(const root of roots){
  const manifest=await verifyInstalledSoftware(root);
  assert(manifest.files.some(f=>f.path==='tools/app-service.mjs'));assert(manifest.files.some(f=>f.path==='tools/execution-runtime.mjs'));
  assert(!manifest.files.some(f=>/instance\/runtime|scope\.json|bindings\.json/.test(f.path)));
  assert.equal(await readFile(path.join(root,'.agents/skills/review-tasks/SKILL.md'),'utf8'),await readFile(path.join(source,'skills/review-tasks/SKILL.md'),'utf8'));
  assert.equal((await read(path.join(root,'package.json'))).scripts.tasks,'node review-software/tools/tasks.mjs');
  // An independent ESM load from each installed package cannot reach source.
  const code=`const {ensureAppService}=await import(${JSON.stringify(pathToFileURL(path.join(root,'review-software/tools/app-service.mjs')).href)});if(typeof ensureAppService!=='function')throw Error('missing service');console.log('installed');`;
  assert.equal(execFileSync(process.execPath,['--input-type=module','-e',code],{cwd:root,encoding:'utf8'}).trim(),'installed');
 }
 assert.deepEqual((await verifyInstalledSoftware(roots[0])).files,(await verifyInstalledSoftware(roots[1])).files);
 const two=await startRun(roots[1]);assert.notEqual(one.id,two.id);
 assert.notEqual((await read(path.join(loc.runtime,'scope.json'))).projectId,(await read(path.join(roots[1],'instance/runtime/task-execution/scope.json'))).projectId);
 await assert.rejects(readFile(path.join(roots[1],'instance/runtime/task-execution/private-receipt.json')),e=>e.code==='ENOENT');
 const copy=path.join(base,'copied-runtime');await cp(roots[0],copy,{recursive:true});
 await assert.rejects(startRun(copy),/EXECUTION_SCOPE/);
});

test('controlled reboot archives the original run and stale activity, CAS recovery retains UNKNOWN operations',async t=>{
 const root=path.join(await scratch(t),'instance');await createProject(root,{source,initializeGit:false,host:'fixture'});
 const taskId=(await mutate(root,'publish',req({task:spec}))).taskId,first=await startRun(root,{capabilities:caps});
 const scheduled=await mutate(root,'schedule',req({runId:first.id,expectedVersions:{[taskId]:1},assignments:[{taskId,key:'work',goal:'recover once',deliverables:['proof'],acceptanceCriteria:['pass'],resources:[{kind:'OBJECT',key:'isolated-operation',access:'WRITE'}],execution:{rationale:'fixture'}}]}));
 const assignmentId=scheduled.assignments[0].id,loc=await location(root),runFile=path.join(loc.runtime,'run.json');
 const cpValue={summary:'原进度',completedSteps:['saved input'],nextSteps:['reconcile result'],operations:[{id:'original-operation',kind:'FIXTURE',status:'RESULT_UNKNOWN'}]};
 await updateBinding(root,first.id,assignmentId,b=>{b.backendRequest={operationId:'original-operation',state:'RESULT_UNKNOWN'};});
 const originalFiles=await readdir(loc.events),eventBytes=await Promise.all(originalFiles.map(f=>readFile(path.join(loc.events,f))));
 const live=await read(runFile);live.expiresAt='2000-01-01T00:00:00.000Z';await durableExecutionFile(runFile,live);
 await assert.rejects(startRun(root),/即使租约超时/);
 await durableExecutionFile(runFile,{...live,owner:null});await assert.rejects(startRun(root),/RECOVERY_OWNER_UNKNOWN/);
 const previousBoot='controlled-previous-boot',oldOwner={...live.owner,bootId:previousBoot};
 assert.equal(processAlive(oldOwner),false);assert.equal(processAlive(processIdentity()),true);assert.notEqual(previousBoot,bootIdentity());
 await durableExecutionFile(runFile,{...live,owner:oldOwner});
 await durableExecutionFile(path.join(loc.runtime,'activities',assignmentId+'.json'),{root,host:live.host,runId:first.id,assignmentId,owner:oldOwner,child:oldOwner});
 const second=await startRun(root,{capabilities:caps});
 assert.equal(second.recoveryKind,'MACHINE_RESTART');assert.equal(second.previousRunId,first.id);
 assert.equal((await read(path.join(loc.runtime,'runs',first.id+'.json'))).owner.bootId,previousBoot);
 assert.equal((await runtimeState(root)).activities[0].live,false,'过期占用仍有记录，但不误认重用 PID 为活进程');
 for(let i=0;i<originalFiles.length;i++)assert.deepEqual(await readFile(path.join(loc.events,originalFiles[i])),eventBytes[i]);
 const task=(await readLedger(root)).tasks[taskId];
 const request=req({runId:second.id,expectedRunId:first.id,taskId,assignmentId,expectedVersions:{[taskId]:task.version},expectedAssignmentVersion:task.assignments[0].version,checkpoint:cpValue,reconciliation:{processes:'controlled reboot: original boot ended',workspace:'fixture unchanged',versions:'same source',operations:'original result unknown; no retry',agent:'original identity only'}});
 await assert.rejects(mutate(root,'assignment:reconcile',{...request,expectedRunId:'wrong-run'}),/RECOVERY_CAS/);
 await assert.rejects(mutate(root,'assignment:reconcile',{...request,noAgentCreated:true,noAgentEvidence:'PID expired'}),/原服务调用意图/);
 const historyFile=path.join(loc.runtime,'runs',first.id+'.json'),originalHistory=await read(historyFile);
 await durableExecutionFile(historyFile,{...originalHistory,owner:processIdentity()});
 await assert.rejects(mutate(root,'assignment:reconcile',request),/RECOVERY_OWNER_UNKNOWN/);
 await durableExecutionFile(historyFile,originalHistory);
 await mutate(root,'assignment:reconcile',request);assert.equal((await mutate(root,'assignment:reconcile',request)).replayed,true);
 const binding=(await readBindings(loc)).assignments[assignmentId];
 assert.equal(binding.runId,second.id);assert.equal(binding.originRunId,first.id);assert.equal(binding.ownershipHistory.length,1);
 assert.equal(binding.ownershipHistory[0].backendOperationId,'original-operation');assert.deepEqual(binding.ownershipHistory[0].checkpointOperationIds,['original-operation']);
 assert.equal((await readLedger(root)).tasks[taskId].assignments[0].checkpoint.operations[0].status,'RESULT_UNKNOWN');
 assert.equal(binding.backendRequest.operationId,'original-operation');
});
