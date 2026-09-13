import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, lstat, readlink, symlink, link, unlink, chmod, rename } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import { mediaName, slug, renderScreenplay } from '../server/library/names.mjs';
import { validateLibrary, libraryPath } from '../server/library/contract.mjs';
import { syncLibrary, readLibrary } from '../server/library/service.mjs';
import { librarySnapshot } from '../server/library/catalog.mjs';
import { validateConfiguration } from '../server/project/service.mjs';
import { createProject } from '../tools/project.mjs';
import { requiredPhase } from '../tools/process-resources.mjs';
import { execute } from '../server/commands.mjs';
import { hash } from '../server/shared/contracts.mjs';
import { enqueue, workOnce } from '../server/jobs.mjs';
import { exportRecords } from '../server/transfer.mjs';
import { dispatch } from '../server/api.mjs';
import { closeDatabase } from '../server/db.mjs';

test('semantic names preserve version, bound length and reject unsafe paths', () => {
  const row = { id: 'same', version_id: 'v1', sha256: 'a'.repeat(64), mime_type: 'image/png', original_path: '../../old/Character_Portrait_V001.png' };
  const first = mediaName(row);
  assert.match(first.path, /character-portrait-v001--[a-f0-9]{12}\.png$/);
  assert.notEqual(first.path, mediaName({ ...row, id: 'SAME' }).path);
  assert.notEqual(first.path, mediaName({ ...row, version_id: 'v2' }).path);
  assert.match(slug('人物·测试甲/../立绘'), /^[a-z0-9-]+$/);
  assert(slug('很长的名称'.repeat(100)).length <= 100);
  for (const p of ['../x','texts/../bad.md','texts//x.md','/texts/a.md','texts/中文.md','texts/a\\b.md']) assert.throws(() => libraryPath(p));
  const config = { texts: [{ kind: 'source', objectId: 'source', path: 'texts/sources/source.md' }] };
  assert.doesNotThrow(() => validateConfiguration('project', { reviewLibrary: config }));
  assert.throws(() => validateLibrary({ texts: [...config.texts, ...config.texts] }));
  assert.throws(() => validateLibrary({ texts: [], directory: '/tmp' }));
});

test('screenplay exports ordered body and performance, without support documents or prompts', () => {
  const plan = { subjectNames: { character: '人物' }, content: { episodes: [{ title: '第二集', sceneIds: ['b','a'] }], narrativeRevision: {
    documents: [{ text: '不得导出的附文' }], scenes: [
      { id: 'a', title: '甲场', scriptBlocks: [{ text: '甲场动作' }] },
      { id: 'b', title: '乙场', scriptBlocks: [{ speaker: 'character', performanceNote: '轻声', text: '乙场对白' }] },
    ],
  } } };
  const text = renderScreenplay(plan).toString();
  assert(text.indexOf('乙场对白') < text.indexOf('甲场动作'));
  assert.match(text, /人物.*轻声/);
  assert(!text.includes('不得导出的附文'));
});

test('library shares media bytes with typed hard links, migrates old trees and detects drift', async t => {
  const outer = await requiredPhase(process.cwd()); assert(outer);
  const project = path.join(process.env.REVIEW_TASK_DIR, 'library-fixture'), root = path.join(project, 'instance');
  const container = 'review-library-fixture-' + randomUUID(), labels = await outer.expect('container', container);
  execFileSync('docker', ['run','-d','--name',container,...labels,'--tmpfs','/var/lib/postgresql:rw,size=256m','-e','POSTGRES_USER=review','-e','POSTGRES_DB=review','-e','POSTGRES_HOST_AUTH_METHOD=trust','-p','127.0.0.1::5432','postgres:18.6'], { stdio: 'pipe' });
  await outer.capture('container', container);
  const details = JSON.parse(execFileSync('docker',['inspect',container],{encoding:'utf8'}))[0];
  const database = { host: '127.0.0.1', port: Number(details.NetworkSettings.Ports['5432/tcp'][0].HostPort), user: 'review', database: 'review' };
  const pool = new pg.Pool({ ...database, max: 4 }); t.after(() => pool.end());
  for (let i = 0; ; i++) { try { await pool.query('SELECT 1'); break; } catch(e) { if (i > 100) throw e; await new Promise(r => setTimeout(r,100)); } }
  await createProject(project, { title:'隔离审阅测试', instanceId:'library-fixture', source:fileURLToPath(new URL('..',import.meta.url)), database, initializeGit:false, host:'fixture' });
  const oldInstance = process.env.REVIEW_INSTANCE_ROOT;
  process.env.REVIEW_INSTANCE_ROOT = root;
  t.after(async () => { await closeDatabase(); if(oldInstance === undefined) delete process.env.REVIEW_INSTANCE_ROOT; else process.env.REVIEW_INSTANCE_ROOT=oldInstance; });
  await pool.query(await readFile(new URL('../server/schema.sql',import.meta.url),'utf8'));
  const epoch = randomUUID();
  await pool.query("INSERT INTO project(instance_id,runtime_epoch,title) VALUES('library-fixture',$1,'隔离审阅测试')",[epoch]);
  const commands = async commands => {
    const result = await execute(pool,{operationId:randomUUID(),runtimeEpoch:epoch,commands});
    assert.equal(result.status,'SUCCEEDED',JSON.stringify(result)); return result.results;
  };
  const create = async (id,kind,content,links=[]) => (await commands([{type:'save',id,kind,title:id,content,links,expectedVersion:0}]))[0];
  const original = Buffer.from('\ufeff# 来源\r\n\r\n原文保持字节。\r\n');
  const source = await create('original','SOURCE',{text:original.toString(),sha256:hash(original),role:'PRIMARY'});
  await pool.query('INSERT INTO source_documents(revision_id,original_revision_id,original_sha256,mime_type,content_bytes,logical_path,role) VALUES($1,$1,$2,$3,$4,$5,$6)',[source.revisionId,hash(original),'text/markdown',original,'原件.md','PRIMARY']);
  const scene = await create('scene','SCENE',{blocks:[{id:'block',type:'action',text:'第一版正文'}]});
  await create('episode','EPISODE',{},[{id:'scene',role:'SCENE'}]);
  await create('story','STORY',{},[{id:'episode',role:'EPISODE'}]);
  const config = { reviewLibrary: { enabled:true,texts:[{kind:'source',objectId:'original',revisionId:source.revisionId,path:'texts/sources/original.md'},{kind:'screenplay',objectId:'story',path:'texts/screenplays/current.md'}] } };
  await commands([{type:'configuration.save',scope:'project',content:config,expectedVersion:0}]);
  const media = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=', 'base64'), sha = hash(media);
  await writeFile(path.join(root,'media',sha),media);
  for (const id of ['portrait','portrait-copy']) await pool.query("INSERT INTO media(id,version_id,sha256,byte_size,mime_type,availability,original_path) VALUES($1,'v1',$2,$3,'image/png','PRESENT','Character_Portrait_V001.png')",[id,sha,media.length]);
  await pool.query("INSERT INTO media(id,version_id,sha256,byte_size,mime_type,availability) VALUES('gone','v1',$1,0,'video/mp4','RETIRED')",['b'.repeat(64)]);
  await mkdir(path.join(project,'review-library'));
  await assert.rejects(syncLibrary(pool,root),{code:'LIBRARY_ROOT_OCCUPIED'});
  assert((await lstat(path.join(project,'review-library'))).isDirectory());
  await (await import('node:fs/promises')).rmdir(path.join(project,'review-library'));
  let result = await syncLibrary(pool,root,{full:true});
  assert.equal(result.status,'CURRENT'); assert.equal(result.counts.files,4); assert.equal(result.counts.unavailable,1);
  // Recreate a valid format-1 generation to exercise the real upgrade path,
  // including unchanged database contents and later retirement of old symlinks.
  const stateFile = path.join(root,'runtime/review-library/state.json');
  const legacyState = JSON.parse(await readFile(stateFile,'utf8'));
  const legacyDirectory = path.join(project,legacyState.current.directory);
  const legacyFile = path.join(legacyDirectory,'manifest.json');
  const legacyManifest = JSON.parse(await readFile(legacyFile,'utf8'));
  for (const e of legacyManifest.entries.filter(e=>e.path)) {
    const file=path.join(legacyDirectory,'tree',e.path);
    const target=e.kind==='media'?path.join(root,'media',e.sha256):path.join(legacyDirectory,'text-blobs',e.sha256);
    await chmod(path.dirname(file),0o700); await unlink(file); await symlink(path.relative(path.dirname(file),target),file);
    delete e.fileIdentity;
  }
  legacyManifest.formatVersion=1;
  const legacyBytes=Buffer.from(JSON.stringify(legacyManifest)+'\n');
  await chmod(legacyFile,0o600); await writeFile(legacyFile,legacyBytes); await chmod(legacyFile,0o400);
  legacyState.current.manifestSha256=hash(legacyBytes); await writeFile(stateFile,JSON.stringify(legacyState));
  assert.equal((await readLibrary(pool,root)).status,'STALE');
  result=await syncLibrary(pool,root); assert.equal(result.status,'CURRENT');
  assert.notEqual((await readlink(path.join(project,'review-library'))),legacyState.current.directory+'/tree');
  const firstPointer = await readlink(path.join(project,'review-library'));
  assert.equal((await lstat(path.join(project,firstPointer))).mode&0o222,0);
  let catalog = await readLibrary(pool,root,{entries:true});
  const images = catalog.entries.filter(e=>e.kind==='media'&&e.path);
  assert.equal(images.length,2); assert.notEqual(images[0].path,images[1].path);
  const originalStat=await lstat(path.join(root,'media',sha));
  for (const e of images) {
    const file=path.join(project,'review-library',e.path), st=await lstat(file);
    assert(st.isFile()); assert(!st.isSymbolicLink());
    assert.equal(st.dev,originalStat.dev); assert.equal(st.ino,originalStat.ino);
    assert.equal(hash(await readFile(file)),sha);
  }
  assert.equal(Number((await lstat(path.join(root,'media',sha))).mode)&0o222,0);
  assert.deepEqual(await readFile(path.join(project,'review-library/texts/sources/original.md')),original);
  assert((await lstat(path.join(project,'review-library/texts/sources/original.md'))).isFile());
  assert.match(await readFile(path.join(project,'review-library/texts/screenplays/current.md'),'utf8'),/第一版正文/);
  if (process.platform==='darwin') {
    const probe=path.join(process.env.REVIEW_TASK_DIR,'library-file-type');
    execFileSync('clang',['-framework','Foundation','-framework','AppKit',fileURLToPath(new URL('fixtures/library-file-type.m',import.meta.url)),'-o',probe],{stdio:'pipe'});
    const types=JSON.parse(execFileSync(probe,[path.join(project,'review-library',images[0].path),path.join(project,'review-library/texts/sources/original.md')],{encoding:'utf8'}));
    assert.equal(types[0].type,'public.png'); assert(types[0].application);
    assert.notEqual(types[1].type,'public.data'); assert.notEqual(types[1].type,'public.symlink');
    t.diagnostic('macOS identifies the media entry as '+types[0].type+'; default application: '+types[0].application);
  }
  const resolved = await readLibrary(pool,root,{entryPath:'review-library/'+images[0].path});
  assert.equal(resolved.entry.mediaId,images[0].mediaId); assert.equal(resolved.exactPath,'instance/media/'+sha);
  for (const kind of ['REVIEW_LIBRARY_SYNC','REVIEW_LIBRARY_VERIFY']) {
    const operationId=randomUUID();
    const response=await dispatch(new Request('http://localhost/api/v1/jobs',{method:'POST',headers:{'Content-Type':'application/json','x-review-runtime':epoch},body:JSON.stringify({operationId,kind})}));
    assert.equal(response.status,202,await response.clone().text());
    await workOnce(pool,{root,workerId:'library-api-test',providers:{}});
    const receipt=await dispatch(new Request('http://localhost/api/v1/operations/'+operationId));
    assert.equal((await receipt.json()).status,'SUCCEEDED');
  }
  const apiResolved=await dispatch(new Request('http://localhost/api/v1/review-library?path='+encodeURIComponent(images[0].path)));
  assert.equal(apiResolved.status,200); assert.equal((await apiResolved.json()).entry.sha256,sha);
  await syncLibrary(pool,root); assert.equal(await readlink(path.join(project,'review-library')),firstPointer);
  await commands([{type:'save',id:'scene',kind:'SCENE',expectedVersion:scene.version,content:{blocks:[{id:'block',type:'action',text:'第二版正文'}]}}]);
  assert.equal((await readLibrary(pool,root)).status,'STALE');
  await Promise.all([syncLibrary(pool,root),syncLibrary(pool,root)]);
  assert.notEqual(await readlink(path.join(project,'review-library')),firstPointer);
  assert.match(await readFile(path.join(project,'review-library/texts/screenplays/current.md'),'utf8'),/第二版正文/);
  assert.match(await readFile(path.join(project,firstPointer,'texts/screenplays/current.md'),'utf8'),/第一版正文/);
  assert.equal((await readLibrary(pool,root,{entries:true})).entries.find(e=>e.key===images[0].key).path,images[0].path);
  // Relocating the whole project preserves the root pointer and shared media inodes.
  const moved = project+'-moved'; await rename(project,moved);
  assert.equal(hash(await readFile(path.join(moved,'review-library',images[0].path))),sha);
  await rename(moved,project);
  // Explicit job uses the same service and operation idempotency.
  const request = {operationId:randomUUID(),runtimeEpoch:epoch,kind:'REVIEW_LIBRARY_VERIFY'};
  await enqueue(pool,request); assert.equal((await enqueue(pool,request)).replayed,true);
  await workOnce(pool,{root,workerId:'library-test',providers:{}});
  assert.equal((await pool.query('SELECT status FROM operations WHERE id=$1',[request.operationId])).rows[0].status,'SUCCEEDED');
  // A failed SHA check cannot publish a new generation or alter the registered bytes.
  const pointer = await readlink(path.join(project,'review-library'));
  await chmod(path.join(root,'media',sha),0o600); await writeFile(path.join(root,'media',sha),Buffer.alloc(media.length,65));
  await assert.rejects(syncLibrary(pool,root),{code:'LIBRARY_BLOB_HASH'});
  assert.equal(await readlink(path.join(project,'review-library')),pointer);
  assert.equal((await readLibrary(pool,root)).status,'ERROR');
  await writeFile(path.join(root,'media',sha),media); await syncLibrary(pool,root);
  const alias = path.join(project,'review-library',images[0].path), target = path.join(root,'media',sha);
  assert.equal((await lstat(path.dirname(alias))).mode&0o222,0);
  await chmod(path.dirname(alias),0o700); // Deliberate tampering must opt out of the read-only directory first.
  await unlink(alias); await symlink(target,alias);
  await assert.rejects(syncLibrary(pool,root),{code:'LIBRARY_LINK_CHANGED'});
  await assert.rejects(readLibrary(pool,root,{entryPath:images[0].path}),{code:'LIBRARY_LINK_CHANGED'});
  // An identical-byte copy is still a second file and must not be accepted.
  await unlink(alias); await writeFile(alias,media,{mode:0o400});
  await assert.rejects(syncLibrary(pool,root),{code:'LIBRARY_LINK_CHANGED'});
  await assert.rejects(readLibrary(pool,root,{entryPath:images[0].path}),{code:'LIBRARY_LINK_CHANGED'});
  await unlink(alias); await link(target,alias); await syncLibrary(pool,root);
  // A third generation retires exactly the oldest owned tree.
  await commands([{type:'save',id:'scene',kind:'SCENE',expectedVersion:scene.version+1,content:{text:'第三版正文'}}]);
  result = await syncLibrary(pool,root); assert.equal(result.cleanupPending,0);
  await assert.rejects(lstat(path.join(project,firstPointer)),{code:'ENOENT'});
  await assert.rejects(lstat(legacyDirectory),{code:'ENOENT'});
  assert.equal((await lstat(target)).ino,originalStat.ino);
  assert.equal(hash(await readFile(target)),sha);
  let exportedConfig;
  for await (const line of exportRecords(pool)) { const r=JSON.parse(line); if(r.table==='configurations'&&r.row.scope==='project') exportedConfig=r.row.content; }
  assert.deepEqual(exportedConfig.reviewLibrary,config.reviewLibrary);
  const snapshot = await librarySnapshot(pool);
  assert.equal(snapshot.entries.filter(e=>e.kind==='source').length,1);
  assert.equal(snapshot.entries.find(e=>e.kind==='screenplay').basis.find(b=>b.objectId==='scene').expectedVersion,3);
  // Recover a crash after the root swap but before the state pointer was committed.
  const state = JSON.parse(await readFile(stateFile,'utf8'));
  state.pending=state.current; state.current=state.previous; state.previous=null; state.counts={};
  await writeFile(stateFile,JSON.stringify(state));
  result=await syncLibrary(pool,root); assert.equal(result.status,'CURRENT'); assert.equal(result.counts.files,4);
  assert.equal(JSON.parse(await readFile(stateFile,'utf8')).pending,undefined);
  // Registered retirement must remove links even when the old physical media no longer exists.
  await pool.query("UPDATE media SET availability='RETIRED' WHERE id IN ('portrait','portrait-copy')");
  await unlink(path.join(root,'media',sha));
  result=await syncLibrary(pool,root); assert.equal(result.status,'CURRENT'); assert.equal(result.counts.media,0); assert.equal(result.cleanupPending,0);
  const retiredPointer=await readlink(path.join(project,'review-library'));
  await pool.query("UPDATE media SET availability='PRESENT' WHERE id='gone'");
  await assert.rejects(syncLibrary(pool,root),{code:'LIBRARY_BLOB_MISSING'});
  assert.equal(await readlink(path.join(project,'review-library')),retiredPointer);
});
