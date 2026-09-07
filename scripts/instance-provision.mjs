import path from 'node:path';
import {parseArgs} from 'node:util';
import {readFile} from 'node:fs/promises';
import {createInstanceRepository} from '../host/instance-runtime/index.mjs';
import {blankProfile,blankSnapshot} from '../host/instance-runtime/blank.mjs';
import {initializeConfiguration} from '../host/instance-runtime/configuration-service.mjs';
export async function provisionBlankInstance(root,title,backend='postgres'){
 const bootstrap=JSON.parse(await readFile(path.join(root,'instance.json'),'utf8'));
 const profile=blankProfile({title,instanceId:bootstrap.instanceId});profile.capabilities.landingView='system';
 const options=backend==='postgres'?{root,backend,database:bootstrap.database}:{dbPath:path.join(root,bootstrap.database)};
 const repo=await createInstanceRepository({...options,instanceId:profile.instanceId,profile});
 try{
  await repo.writeTransaction(async tx=>{
   const docs=[['README.md',`# ${title}\n\n一部故事一个审阅台实例。业务资料、版本及审阅记录保存在本实例数据库；媒体保存在 media。请从系统管理开始导入资料与初始化。\n`],['AGENTS.md','# 工作规则\n\n默认中文。先读取当前实例 README、AGENTS、STATE。保留版本、来源、依赖和审阅历史。AI 建议不等于执行授权。结果不明时先核查，不自动重试。新增故事事实明确标注为创作。\n'],['STATE.md','# 当前状态\n\n尚未导入故事资料。初始化未完成。分集、场、镜头及正式制作分母均未锁定。\n']];
   const sources=[];for(const [alias,content]of docs)sources.push(await tx.putDocument({documentId:`document:${alias}`,bytes:content,aliases:[alias],expectedRevisionId:null,mediaType:'text/markdown',metadata:{sourceRole:'INSTANCE_GUIDANCE',title:alias}}));
   await tx.publishRelease({...blankSnapshot(profile),expectedReleaseId:null,sourceRevisionIds:sources.map(r=>r.revisionId)});
  });await repo.writeTransaction(tx=>initializeConfiguration(tx));return {instance:root,instanceId:profile.instanceId,projectId:profile.projectId,backend,integrity:await repo.integrityCheck()};
 }finally{await repo.close();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===new URL(import.meta.url).pathname){const {values}=parseArgs({options:{instance:{type:'string'},title:{type:'string'},backend:{type:'string'}}});if(!values.instance||!values.title)throw new Error('Instance and title required');console.log(JSON.stringify(await provisionBlankInstance(values.instance,values.title,values.backend)));}
