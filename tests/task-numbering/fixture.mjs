import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const cliPath=fileURLToPath(new URL('../../tools/tasks.mjs',import.meta.url));
const clockPath=fileURLToPath(new URL('./clock.mjs',import.meta.url));
export const request=extra=>({operationId:randomUUID(),actor:'NUMBERING_FIXTURE',...extra});
export const spec=(extra={})=>({clarified:true,title:'编号验收正式标题',type:'SYSTEM',originalRequest:'独立夹具原话',goal:'核验稳定编号',scope:['隔离任务夹具'],deliverables:['验证证据'],acceptanceCriteria:['编号正确','身份稳定'],authorization:'仅受管 fixture；不操作实际项目任务',discussion:{approved:true,summary:'已认可测试',feasibility:'受控输入',approvedRequirements:['稳定编号']},...extra});
export const task=(id,at,extra={})=>({ ...spec(),id,projectId:'numbering-fixture',version:1,status:'READY',priority:2,dependencies:[],references:[],publishedAt:at,updatedAt:at,startedAt:null,completedAt:null,checkpoint:null,result:null,...extra});
const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
export const hash=v=>createHash('sha256').update(JSON.stringify(stable(v))).digest('hex');
export async function fixture(t) {
  assert(process.env.REVIEW_TASK_DIR,'测试必须通过受管执行器运行');
  const root=await mkdtemp(path.join(process.env.REVIEW_TASK_DIR,'numbering-'));
  await mkdir(path.join(root,'instance/runtime'),{recursive:true});
  await writeFile(path.join(root,'instance/instance.json'),JSON.stringify({id:'numbering-fixture'}));
  t.after(()=>rm(root,{recursive:true,force:true}));
  return root;
}
export async function legacy(root,groups,{version=2}={}) {
  assert(root.startsWith(process.env.REVIEW_TASK_DIR+path.sep));
  await mkdir(path.join(root,'tasks/events'),{recursive:true});
  await writeFile(path.join(root,'tasks/project.json'),JSON.stringify({schemaVersion:version,projectId:'numbering-fixture'}));
  let previousHash=null,sequence=0;
  for(const group of groups) {
    const action=group.action||'publish',r=group.request||request({tasks:group.tasks.map(t=>spec({title:t.title}))});
    const body={schemaVersion:group.schemaVersion||version,projectId:'numbering-fixture',sequence:++sequence,previousHash,operationId:r.operationId,requestHash:hash({action,request:r}),action,actor:r.actor,reason:r.reason||null,at:group.at||group.tasks[0].updatedAt,tasks:group.tasks,result:{status:group.tasks[0].status,taskIds:group.tasks.map(t=>t.id),...(group.tasks.length===1?{taskId:group.tasks[0].id}:{}),tasks:group.tasks}};
    previousHash=hash(body);
    await writeFile(path.join(root,'tasks/events',String(sequence).padStart(10,'0')+'-'+previousHash+'.json'),JSON.stringify({...body,hash:previousHash},null,2)+'\n');
  }
}
export async function eventBytes(root) {
  const dir=path.join(root,'tasks/events');
  const names=await readdir(dir).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
  return Object.fromEntries(await Promise.all(names.sort().map(async n=>[n,await readFile(path.join(dir,n),'utf8')])));
}
export async function call(root,args,{body,at,env={}}={}) {
  const child=spawn(process.execPath,['--import',clockPath,cliPath,...args,'--project',root,...(body?['--file','-']:[])],{env:{...process.env,...env,...(at?{TASK_NUMBERING_NOW:at}:{})},stdio:['pipe','pipe','pipe']});
  let output='',error='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>error+=b);
  const done=once(child,'close');child.stdin.end(body?JSON.stringify(body):'');
  const [code]=await done;
  if(code)throw Error(error||output);
  return args.includes('markdown')?output:JSON.parse(output);
}
