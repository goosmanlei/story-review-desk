import path from 'node:path';
import {readFile,writeFile,mkdir,lstat,readdir,rename,unlink} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {atomic,plainDirectory,exists} from './io.mjs';
import {processLock} from './process-resources.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function installTaskSkill(root,software) {
  const template=path.join(software,'skills/review-tasks');
  if(!await exists(template)) return {status:'NOT_INCLUDED'}; // Older immutable releases/fixtures.
  await plainDirectory(root);
  const runtime=path.join(root,'instance/runtime/task-execution');
  await mkdir(runtime,{recursive:true,mode:0o700}); await plainDirectory(runtime);
  return processLock(path.join(runtime,'install.lock'),async()=>{
    const target=path.join(root,'.agents/skills/review-tasks');
    await mkdir(target,{recursive:true,mode:0o700});await plainDirectory(target);
    const marker=path.join(target,'.review-managed.json');
    if(await exists(marker)) {const st=await lstat(marker);if(!st.isFile()||st.isSymbolicLink())throw Error('Skill 归属记录不安全');}
    const old=await exists(marker)?JSON.parse(await readFile(marker,'utf8')):{files:{}};
    const files={};
    for(const name of ['SKILL.md']) files[name]=await readFile(path.join(template,name));
    for(const name of await readdir(target)) if(name!=='.review-managed.json' && !(name in files)) throw Error('任务 Skill 含非受管文件；保留并停止更新');
    for(const [name,bytes] of Object.entries(files)) if(await exists(path.join(target,name))) {
      const file=path.join(target,name), st=await lstat(file), actual=hash(await readFile(file));
      if(!st.isFile()||st.isSymbolicLink()||actual!==old.files[name]&&actual!==hash(bytes)) throw Error('任务 Skill 存在本地修改；不覆盖');
    }
    const pkgFile=path.join(root,'package.json'), pkg=JSON.parse(await readFile(pkgFile,'utf8'));
    const script='node review-software/tools/tasks.mjs';
    if(pkg.scripts?.tasks && pkg.scripts.tasks!==script) throw Error('已有自定义 tasks 命令；不覆盖');
    for(const [name,bytes] of Object.entries(files)) {
      const tmp=path.join(runtime,randomUUID()+'.tmp');
      try {await writeFile(tmp,bytes,{flag:'wx',mode:0o600});await rename(tmp,path.join(target,name));}
      finally {await unlink(tmp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
    }
    await atomic(marker,{schemaVersion:1,files:Object.fromEntries(Object.entries(files).map(([k,v])=>[k,hash(v)]))});
    pkg.scripts ||= {};pkg.scripts.tasks=script;await atomic(pkgFile,pkg);
    const policyFile=path.join(root,'instance/runtime/process-policy.json');
    if(await exists(policyFile)) {
      const policy=JSON.parse(await readFile(policyFile,'utf8'));
      policy.protectedPaths=[...new Set([...(policy.protectedPaths||[]),'tasks','.agents/skills/review-tasks','instance/runtime/task-execution'])];
      await atomic(policyFile,policy);
    }
    return {status:'INSTALLED',skill:'.agents/skills/review-tasks',command:'npm run tasks --'};
  });
}
