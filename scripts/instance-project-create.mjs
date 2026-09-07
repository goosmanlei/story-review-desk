/** Create one self-contained project with neutral software and a fresh database. */
import {mkdir,readFile,writeFile,lstat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
import {applicationRoot} from './instance-profile.mjs';
import {runMaintenanceProcess} from './instance-maintenance.mjs';
import {sha256} from '../host/instance-runtime/bytes.mjs';

export async function createStoryProject(project,title){
 if(typeof project!=='string'||!project||typeof title!=='string'||!title.trim()||title.length>200||/[\r\n\0]/.test(title))throw new Error('Explicit new project directory and a single-line title are required');
 const root=path.resolve(project),parent=await realpath(path.dirname(root));
 if(parent!==path.dirname(root)||root===applicationRoot||root.startsWith(applicationRoot+path.sep))throw new Error('Project must be a new canonical directory outside the source software');
 await mkdir(root,{mode:0o700}); // exclusive: existing directories are never adopted
 const software=path.join(root,'review-software'),instance=path.join(root,'instance'),statusPath=path.join(root,'project-creation.json');
 let stage='PACKAGE';
 const save=async(status,details={})=>writeFile(statusPath,JSON.stringify({schemaVersion:'1.0',status,stage,title:title.trim(),projectRoot:root,software:'review-software',instance:'instance',at:new Date().toISOString(),...details},null,2)+'\n',{mode:0o600});
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>['PATH','HOME','LANG','LC_ALL','TMPDIR','TZ','DOCKER_HOST','DOCKER_CONTEXT','DOCKER_CONFIG','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH','REVIEW_SOFTWARE_COMMIT'].includes(key)));
 const run=async(command,args,log)=>{try{const result=await runMaintenanceProcess(command,args,{env});await writeFile(path.join(root,log),result.stdout+result.stderr,{flag:'wx',mode:0o600});return result;}catch(error){await writeFile(path.join(root,log),String(error?.message||error)+'\n',{flag:'wx',mode:0o600});throw error;}};
 try{
  await save('CREATING');
  await run(process.execPath,[path.join(applicationRoot,'scripts/instance-package.mjs'),'--output',software],'.project-package.log');
  const manifest=JSON.parse(await readFile(path.join(software,'software-manifest.json'),'utf8'));
  if(manifest.kind!=='STORY_NEUTRAL_SOFTWARE'||manifest.copiedBusinessData!==false||manifest.copiedCredentials!==false||manifest.productionStorySpecificHits?.length||!Array.isArray(manifest.files))throw new Error('The software package did not pass story isolation checks');
  for(const item of manifest.files){
   if(typeof item.path!=='string'||path.isAbsolute(item.path)||item.path.split('/').some(x=>!x||x==='.'||x==='..'))throw new Error('Unsafe software manifest path');
   const filename=path.join(software,item.path),info=await lstat(filename);if(!info.isFile()||info.isSymbolicLink()||await realpath(filename)!==filename||sha256(await readFile(filename))!==item.sha256)throw new Error('Packaged software checksum mismatch');
  }
  stage='DEPENDENCIES';await save('CREATING');
  await run('npm',['ci','--ignore-scripts','--prefix',software],'.project-install.log');
  stage='INSTANCE';await save('CREATING');
  const created=JSON.parse((await run(process.execPath,[path.join(software,'scripts/instance-create.mjs'),'--instance',instance,'--title',title.trim()],'.project-instance.log')).stdout);
  if(created.backend!=='postgres'||created.integrity?.ok!==true)throw new Error('Fresh PostgreSQL instance integrity proof is missing');
  stage='GUIDANCE';
  await writeFile(path.join(root,'README.md'),`# ${title.trim()}\n\n本目录是本故事的项目根目录，也是 Codex 的工作目录。先读取 README.md、AGENTS.md 和 STATE.md。\n\nreview-software/ 是可更新的软件；instance/instance.json 定位本故事独立的 PostgreSQL 数据库；instance/media/ 保存登记媒体。故事业务内容、配置、关系、版本与审阅记录以数据库当前已发布版本为准。\n\n从项目根目录启动：\n\n    node review-software/scripts/instance-start.mjs --instance ./instance --offline --port 3000\n\n打开 http://localhost:3000，先在系统管理确认规则。在故事创作的来源资料导入原文，再在故事设定整理主体、空间与关系；素材定义在素材管理独立确认。AI 只回交待核建议稿，系统初始化不采用剧本或生成媒体。\n\n外部 Codex 导入与网页上传使用同一服务。先用 list 读取当前 releaseId，将下面的 CURRENT_RELEASE_ID 替换为该值：\n\n    node review-software/scripts/instance-sources.mjs list --instance ./instance\n    node review-software/scripts/instance-sources.mjs import --instance ./instance --source /absolute/path/story.txt --filename story.txt --title 故事原文 --role PRIMARY --expected-release CURRENT_RELEASE_ID\n\n详细命令与流程见 review-software/docs/system-management.md。复制项目文件夹不能备份正在运行的 PostgreSQL，请使用完整备份命令；恢复写入新目录与新数据卷。\n`,{flag:'wx'});
  await writeFile(path.join(root,'AGENTS.md'),'# 项目工作规则\n\n默认中文。Codex 的 cwd 使用本目录。先读本目录 README、AGENTS、STATE，再通过 review-software 的 instance CLI 读取 instance 当前发布的逻辑 README/AGENTS/STATE。\n\n本故事业务权威只在 ./instance 的数据库及登记媒体。不读取父项目故事作为后备，不修改 review-software 中的通用代码来存储故事内容。所有资料导入、关系修改、配置发布和创作采用通过同一实例服务完成；原始字节和版本 SHA 不变。\n\n系统管理仅维护初始化、配置、审核标准与运行。资料导入归故事创作，主体与空间归故事设定，表现、需求与制作参考归素材管理；三个模块分别确认，不得把 AI 建议冒充正式剧本、审阅放行或生成授权。未确认信息保留 UNKNOWN。模型调用与制作按用户实际授权执行，结果不明先核查，不自动重试。\n',{flag:'wx'});
  await writeFile(path.join(root,'STATE.md'),`# 当前项目状态\n\nPROJECT_CREATED。实例身份：${created.instanceId}。数据库：独立 PostgreSQL；定位：instance/instance.json。尚未导入故事资料，初始化未完成，正式分集、场、镜头与素材分母未锁定。\n\n软件已通过干净包清单与 SHA 检查，依赖已安装；新实例数据库完整性校验通过。网页服务尚未启动，应用构建及实际端口验收尚未执行。没有模型调用或媒体生成。下一步启动实例，确认系统规则后在故事创作导入来源资料。\n`,{flag:'wx'});
  stage='COMPLETE';const result={status:'PROJECT_CREATED',projectRoot:root,softwareRoot:software,instanceRoot:instance,instanceId:created.instanceId,backend:'postgres',softwareFiles:manifest.files.length,integrity:created.integrity,modelCalls:0,runtimeStarted:false};await save(result.status,result);return result;
 }catch(error){await save('FAILED',{error:String(error?.message||error),diagnostic:'Created files and any newly created database remain for inspection; the source project was not changed.'});throw error;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){const{values}=parseArgs({options:{project:{type:'string'},title:{type:'string'}}});console.log(JSON.stringify(await createStoryProject(values.project,values.title),null,2));}
