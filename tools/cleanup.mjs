#!/usr/bin/env node
import path from 'node:path';
import {parseArgs} from 'node:util';
import {json,requireValue} from './io.mjs';
import {finishProcessTask,checkProcessTask,reapRetiredProcessImages} from './process-resources.mjs';
import {retireReleases} from './deployment.mjs';
const {values}=parseArgs({options:{root:{type:'string'},task:{type:'string'},manifest:{type:'string'}}}),root=path.resolve(values.root||'.');
try{
 requireValue(values.task,'cleanup:complete 需要父任务编号');
 if(values.manifest){const manifest=await json(path.resolve(values.manifest));requireValue(manifest.taskId===values.task&&Array.isArray(manifest.targets),'清理清单与任务不符');requireValue(manifest.targets.length===0,'此入口只清理任务已登记资源；额外资源必须先由所属执行器精确登记');}
 await finishProcessTask(root,values.task);const released=await retireReleases(root),images=await reapRetiredProcessImages(root),result=await checkProcessTask(root,values.task);console.log(JSON.stringify({...result,released,images}));
}catch(error){console.error(JSON.stringify({status:'CLEANUP_REQUIRED',error:error.message}));process.exitCode=1;}
