import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const stable=x=>Array.isArray(x)?x.map(stable):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,stable(x[k])])):x;
const hash=x=>createHash('sha256').update(JSON.stringify(stable(x))).digest('hex');
const legacy=x=>{
  if(Array.isArray(x))return x.map(legacy);
  if(!x||typeof x!=='object')return x;
  const result=Object.fromEntries(Object.entries(x).map(([k,v])=>[k,legacy(v)]));
  if(typeof result.id==='string'&&result.id.startsWith('A-'))for(const key of ['role','parentAssignmentId','rootAssignmentId'])delete result[key];
  return result;
};

// Materialize historical input before a test starts observing immutable bytes.
// This helper is deliberately unavailable outside an isolated managed fixture.
export async function materializeLegacyFixture(root,schemaVersion=2) {
  assert(process.env.REVIEW_TASK_DIR&&path.resolve(root).startsWith(path.resolve(process.env.REVIEW_TASK_DIR)+path.sep));
  assert([1,2].includes(schemaVersion));
  const directory=path.join(root,'tasks/events'),bindingFile=path.join(root,'tasks/project.json');
  const binding=JSON.parse(await readFile(bindingFile,'utf8'));
  let previousHash=null;
  for(const name of (await readdir(directory)).sort()){
    const file=path.join(directory,name),event=legacy(JSON.parse(await readFile(file,'utf8')));
    delete event.hash;event.schemaVersion=schemaVersion;event.previousHash=previousHash;event.hash=hash(event);previousHash=event.hash;
    await rm(file);await writeFile(path.join(directory,String(event.sequence).padStart(10,'0')+'-'+event.hash+'.json'),JSON.stringify(event,null,2)+'\n');
  }
  await writeFile(bindingFile,JSON.stringify({schemaVersion,projectId:binding.projectId})+'\n');
  const runtimeFile=path.join(root,'instance/runtime/task-execution/bindings.json');
  const runtime=JSON.parse(await readFile(runtimeFile,'utf8'));
  for(const assignment of Object.values(runtime.assignments))delete assignment.executionAuthority;
  await writeFile(runtimeFile,JSON.stringify(runtime,null,2)+'\n');
}
