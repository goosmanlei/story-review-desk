import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,stat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {writeArchiveFile,readArchiveFile,ARCHIVE_FILE_FORMAT} from '../host/instance-runtime/archive-file.mjs';
import {canonicalSha256} from '../host/instance-runtime/archive-integrity.mjs';
function fixture(){const body={schemaVersion:1,instanceId:'fixture',tables:{releases:[{id:'r1',bytes:'中文🙂\n原始字节'}],domain_events:[]}};return {...body,exportSha256:canonicalSha256(body)};}
async function file(){return path.join(await mkdtemp(path.join(os.tmpdir(),'review-archive-test-')),'archive.jsonl');}
test('row-streamed archive preserves exact canonical object, private mode and file digest',async()=>{
 const filename=await file(),archive=fixture(),result=await writeArchiveFile(filename,archive),bytes=await readFile(filename);
 assert.deepEqual(await readArchiveFile(filename,result.format),archive);
 assert.equal(result.bytes,bytes.length);assert.equal(result.sha256,createHash('sha256').update(bytes).digest('hex'));
 assert.equal((await stat(filename)).mode&0o777,0o600);await assert.rejects(writeArchiveFile(filename,archive),{code:'EEXIST'});
});
test('archive never serializes the complete archive or table array into one string',async()=>{
 const archive=fixture(),original=JSON.stringify;let calls=0;
 JSON.stringify=function(value,...args){assert.notEqual(value,archive);assert.notEqual(value,archive.tables);assert(!Object.values(archive.tables).includes(value));calls++;return original.call(this,value,...args);};
 try{await writeArchiveFile(await file(),archive);}finally{JSON.stringify=original;}
 assert(calls>0);
});
test('legacy repository JSON archives remain readable without rewriting bytes',async()=>{
 const filename=await file(),archive=fixture(),content=JSON.stringify(archive);await writeFile(filename,content);
 assert.deepEqual(await readArchiveFile(filename,'REVIEW_REPOSITORY_ARCHIVE_1'),archive);assert.equal(await readFile(filename,'utf8'),content);
});
test('tampered, truncated, extra, unknown-table and malformed archive records fail closed',async()=>{
 const filename=await file();await writeArchiveFile(filename,fixture());const original=await readFile(filename,'utf8'),lines=original.trimEnd().split('\n');
 const variants=[original.replace('原始字节','更改字节'),lines.slice(0,-1).join('\n')+'\n',original+'{}\n',original.replace('"table":"releases"','"table":"unknown"'),original.replace('"rows":1','"rows":2'),original.replace('"tableNames":["domain_events","releases"]','"tableNames":["releases","releases"]')];
 for(const content of variants){const target=await file();await writeFile(target,content);await assert.rejects(readArchiveFile(target,ARCHIVE_FILE_FORMAT));}
 await assert.rejects(readArchiveFile(filename,'unknown'));
});
