import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {mkdtemp,mkdir,copyFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {decisionChannelSources} from '../tools/task-decision-channel.mjs';

test('the shipped decision receiver bundle loads independently with task numbering',async t=>{
  assert(process.env.REVIEW_TASK_DIR,'测试须经受管 process');
  const root=await mkdtemp(path.join(process.env.REVIEW_TASK_DIR,'receiver-bundle-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const source=fileURLToPath(new URL('../',import.meta.url));
  for(const name of decisionChannelSources){
    const target=path.join(root,name);
    await mkdir(path.dirname(target),{recursive:true});
    await copyFile(path.join(source,name),target);
  }
  const entry=pathToFileURL(path.join(root,'tools/task-decision-channel.mjs')).href;
  const result=execFileSync(process.execPath,['--input-type=module','-e',`const receiver=await import(${JSON.stringify(entry)});if(typeof receiver.runDecisionChannel!=='function')throw Error('Missing receiver');console.log('loaded');`],{cwd:root,encoding:'utf8'});
  assert.equal(result.trim(),'loaded');
});
