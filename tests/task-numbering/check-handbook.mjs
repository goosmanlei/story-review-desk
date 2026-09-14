// Verify the integration-ready handbook in managed scratch. The coordinating
// agent owns the real manifest refresh; no repository manifest or .git is copied.
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdtemp,cp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {buildHandbook} from '../../tools/handbook.mjs';
import {digest} from '../../tools/handbook-diagrams.mjs';

assert(process.env.REVIEW_TASK_DIR,'须经受管阶段执行');
const source=fileURLToPath(new URL('../../',import.meta.url));
const root=await mkdtemp(path.join(process.env.REVIEW_TASK_DIR,'numbering-handbook-'));
try {
  const manifestPath='docs/handbook/manifest.json',original=await readFile(path.join(source,manifestPath),'utf8'),manifest=JSON.parse(original);
  const operations=manifest.chapters.find(c=>c.id==='operations');
  if(!operations.sources.includes('tools/task-numbering.mjs'))operations.sources.push('tools/task-numbering.mjs');
  const sources=new Set([...manifest.chapters.flatMap(c=>c.sources),'server/schema.sql','server/api.mjs',...['story','settings','materials','production','collaboration','project'].map(domain=>`server/${domain}/service.mjs`)]);
  await cp(path.join(source,'docs/handbook'),path.join(root,'docs/handbook'),{recursive:true});
  for(const file of sources) {
    assert(!path.isAbsolute(file)&&!file.split('/').includes('..'));
    await mkdir(path.dirname(path.join(root,file)),{recursive:true});
    await cp(path.join(source,file),path.join(root,file));
  }
  const references=[];
  for(const file of operations.sources)references.push({path:file,sha256:digest(await readFile(path.join(root,file)))});
  operations.sourceDigest=digest(JSON.stringify(references));
  await writeFile(path.join(root,manifestPath),JSON.stringify(manifest,null,2)+'\n');
  const result=await buildHandbook({root,mode:'check'});
  assert.equal(await readFile(path.join(source,manifestPath),'utf8'),original);
  console.log(JSON.stringify({...result,scope:'managed scratch; repository manifest unchanged',requiredSource:'tools/task-numbering.mjs',operationsSourceDigest:operations.sourceDigest}));
} finally {await rm(root,{recursive:true,force:true});}
