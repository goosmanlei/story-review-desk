import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {cp,mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import test from 'node:test';

test('archive validation loads without host dependencies while database clients require pg',async t=>{
 const temporary=await mkdtemp(path.join(os.tmpdir(),'review-no-host-deps-'));
 t.after(()=>rm(temporary,{recursive:true,force:true}));
 await cp(new URL('../host/instance-runtime',import.meta.url),path.join(temporary,'runtime'),{recursive:true});
 const url=pathToFileURL(path.join(temporary,'runtime/postgres.mjs')).href;
 const source=`const {PostgresRepository,validateArchive}=await import(${JSON.stringify(url)});if(typeof validateArchive!=='function')throw Error('No validator');try{new PostgresRepository({instanceId:'fixture',connection:{}});throw Error('Driver unexpectedly available');}catch(e){if(e.code!=='MODULE_NOT_FOUND'||!e.message.includes("'pg'"))throw e;}console.log('PASS');`;
 assert.equal(execFileSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',env:{...process.env,NODE_PATH:''}}).trim(),'PASS');
});

test('installed driver still creates and closes the ordinary connection pool',async()=>{
 const {PostgresRepository}=await import('../host/instance-runtime/postgres.mjs');
 const repository=new PostgresRepository({instanceId:'fixture',connection:{}});
 assert.equal(repository.pool.totalCount,0);
 await repository.close();
});
