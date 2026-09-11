import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import {requiredPhase} from '../tools/process-resources.mjs';
import {execute} from '../server/commands.mjs';
import {readObject} from '../server/repository.mjs';
import {BoundedCache} from '../server/shared/cache.mjs';
import {enqueue,workOnce,suggestion,sweepJobs,cancelJob} from '../server/jobs.mjs';
import {operation} from '../server/commands.mjs';

test('bounded cache evicts by bytes and idle time',()=>{
  let clock=0;const cache=new BoundedCache({maxBytes:30,idleMs:10,now:()=>clock});
  cache.set('a','1234567890');cache.set('b','1234567890');cache.get('a');cache.set('c','1234567890');assert.equal(cache.get('b'),undefined);assert(cache.bytes<=30);
  clock=9;assert(cache.get('a'));clock=11;cache.sweep();assert.equal(cache.get('c'),undefined);assert(cache.get('a'));clock=22;cache.sweep();assert.equal(cache.bytes,0);
});

test('object transactions, concurrency, adoption and exact dependency invalidation',async t=>{
  const root=process.env.REVIEW_PROJECT_ROOT||process.cwd(),phase=await requiredPhase(root);
  assert(phase,'Run this integration test through the project task executor');
  const name='review-refactor-test-'+Date.now(),labels=await phase.expect('container',name);
  execFileSync('docker',['run','-d','--name',name,...labels,'--tmpfs','/var/lib/postgresql:rw,size=512m','-e','POSTGRES_USER=review','-e','POSTGRES_DB=review','-e','POSTGRES_HOST_AUTH_METHOD=trust','-p','127.0.0.1::5432','postgres:18.6'],{stdio:'pipe'});
  await phase.capture('container',name);
  const info=JSON.parse(execFileSync('docker',['inspect',name],{encoding:'utf8'}))[0],port=Number(info.NetworkSettings.Ports['5432/tcp'][0].HostPort);
  const pool=new pg.Pool({host:'127.0.0.1',port,user:'review',database:'review',max:8});t.after(()=>pool.end());
  for(let attempt=0;;attempt++){try{await pool.query('SELECT 1');break;}catch(error){if(attempt>100)throw error;await new Promise(resolve=>setTimeout(resolve,100));}}
  await pool.query(await readFile(new URL('../server/schema.sql',import.meta.url),'utf8'));
  await pool.query("INSERT INTO project(instance_id,runtime_epoch,title) VALUES('fixture','d0fab4b5-0c84-4bc1-acb2-01a015fdfcdb','空白故事')");
  let sequence=0;
  const run=commands=>execute(pool,{operationId:'test-'+(++sequence),commands});
  const save=(id,kind,expectedVersion=0,content={},extra={})=>({type:'save',id,kind,title:id,expectedVersion,content,...extra});
  const create=async(id,kind='SCENE',content={text:'原稿'},extra={})=>{const r=await run([save(id,kind,0,content,extra)]);assert.equal(r.status,'SUCCEEDED',JSON.stringify(r));return r.results[0];};
  const adopt=async id=>{const o=await readObject(pool,id);let r=await run([{type:'submit',id,expectedVersion:o.version}]);assert.equal(r.status,'SUCCEEDED');r=await run([{type:'review',id,expectedVersion:o.version+1,revisionId:o.revision.id,decision:'ADOPT',explicit:true,note:'已核对',findings:[]}]);assert.equal(r.status,'SUCCEEDED',JSON.stringify(r));return r.results[0];};
  await t.test('unrelated saves and retries do not depend on a global revision',async()=>{
    await create('scene-a');await create('scene-b');
    const request={operationId:'retry',commands:[save('scene-a','SCENE',1,{text:'新稿'})]};
    const [a,b]=await Promise.all([execute(pool,request),execute(pool,request)]);assert.deepEqual(a,b);assert.equal(a.status,'SUCCEEDED');
    assert.equal((await run([save('scene-b','SCENE',1,{text:'另一场'})])).status,'SUCCEEDED');
    await assert.rejects(execute(pool,{...request,commands:[save('scene-a','SCENE',1,{text:'不同请求'})]}),{code:'OPERATION_ID_CONFLICT'});
    const races=await Promise.all([run([save('scene-a','SCENE',2,{text:'竞态1'})]),run([save('scene-a','SCENE',2,{text:'竞态2'})])]);assert.deepEqual(races.map(r=>r.status).sort(),['FAILED','SUCCEEDED']);
    const before=await readObject(pool,'scene-b'),failed=await run([save('scene-b','SCENE',before.version,{text:'不会保存'}),save('scene-a','SCENE',1,{text:'过期'})]);assert.equal(failed.status,'FAILED');assert.equal((await readObject(pool,'scene-b')).version,before.version);
  });
  await t.test('adoption preserves immutable history and only invalidates exact dependencies',async()=>{
    await create('requirement','REQUIREMENT',{description:'人物身份'});const requirement=await adopt('requirement');
    await create('design','SHOT_DESIGN',{description:'只依赖需求定义'},{dependencies:[{revisionId:requirement.revisionId,purpose:'DEFINITION'}]});await adopt('design');
    await create('unrelated','SHOT_DESIGN',{description:'无依赖'});await adopt('unrelated');
    const prior=await readObject(pool,'requirement');await run([save('requirement','REQUIREMENT',prior.version,{description:'身份条件改变'})]);const result=await adopt('requirement');assert.equal(result.affected.length,1);
    assert.equal((await readObject(pool,'design')).invalidations.length,1);assert.equal((await readObject(pool,'unrelated')).invalidations.length,0);
    await assert.rejects(pool.query("UPDATE revisions SET content='{}' WHERE id=$1",[prior.revision.id]),/Immutable/);
    const historical=await readObject(pool,'requirement',{revisionId:prior.revision.id});assert.equal(historical.revision.content.description,'人物身份');
  });
  await t.test('AI cannot adopt; missing media and unknown rights fail closed',async()=>{
    await create('family','MATERIAL',{description:'人物素材'});
    await create('asset','ASSET',{description:'待核原图'},{links:[{id:'family',role:'FAMILY'}]});
    const asset=await readObject(pool,'asset');assert.equal((await run([{type:'submit',id:'asset',expectedVersion:asset.version}])).status,'SUCCEEDED');
    const command={type:'review',id:'asset',expectedVersion:2,revisionId:asset.revision.id,decision:'ADOPT',explicit:true,note:'测试'};
    assert.equal((await run([command])).error.code,'MEDIA_UNAVAILABLE');
    const ai=await execute(pool,{operationId:'ai-review',actor:{kind:'ASSISTANT',label:'AI'},commands:[command]});assert.equal(ai.error.code,'ASSISTANT_DRAFT_ONLY');
    await pool.query("INSERT INTO media(id,version_id,sha256,byte_size,mime_type,availability) VALUES('image','v1',$1,4,'image/png','PRESENT')",['a'.repeat(64)]);
    await pool.query("INSERT INTO asset_media(revision_id,media_id,media_version_id,sha256) VALUES($1,'image','v1',$2)",[asset.revision.id,'a'.repeat(64)]);
    assert.equal((await run([command])).error.code,'RIGHTS_UNKNOWN');
    assert.equal((await run([{...command,internalAttestation:true}])).status,'SUCCEEDED');
    const after=await readObject(pool,'asset');assert.equal(after.rights.fact,'UNKNOWN');assert.equal(after.rights.internalAttestation,true);
  });
  await t.test('configuration ownership and round trips are explicit',async()=>{
    const c={title:'新故事',locale:'zh-CN'};
    assert.equal((await run([{type:'configuration.save',scope:'project',expectedVersion:0,content:c}])).status,'SUCCEEDED');
    assert.deepEqual((await pool.query("SELECT content FROM configurations WHERE scope='project'")).rows[0].content,c);
    assert.equal((await run([{type:'configuration.save',scope:'system',expectedVersion:0,content:c}])).error.code,'CONFIGURATION_FIELD');
    assert.equal((await run([{type:'configuration.save',scope:'system',expectedVersion:0,content:{assistant:{apiKey:'secret'}}}])).error.code,'PRIVATE_CONFIGURATION');
  });
  await t.test('obsolete inputs remain invalid in a copied draft; rebasing only exact inputs clears them',async()=>{
    const before=await readObject(pool,'design');
    await run([save('design','SHOT_DESIGN',before.version,{description:'只改说明，仍使用旧依据'})]);
    const copied=await readObject(pool,'design');assert.equal(copied.invalidations.length,1);
    const basis=await readObject(pool,'requirement');
    await run([save('design','SHOT_DESIGN',copied.version,{description:'已核对新的明确依据'},{dependencies:[{revisionId:basis.adoptedRevisionId,purpose:'DEFINITION'}]})]);
    assert.equal((await readObject(pool,'design')).invalidations.length,0);
  });
  await t.test('mock assistant is invoked once, preview applies atomically and expired duplicate bodies disappear',async()=>{
    await create('suggest-scene');const object=await readObject(pool,'suggest-scene');let calls=0;
    const request={operationId:'mock-suggest',kind:'AI_SUGGEST',objectId:object.id,expectedVersion:object.version,revisionId:object.revision.id,prompt:'受控模拟建议'};
    await Promise.all([enqueue(pool,request),enqueue(pool,request)]);
    const providers={suggest:async({onRequestId})=>{calls++;await onRequestId('mock-provider-request');return {summary:'模拟返回',patch:{text:'模拟草稿'}};}};
    assert(await workOnce(pool,{root,workerId:'fixture-worker',providers}));assert(!await workOnce(pool,{root,workerId:'fixture-worker',providers}));assert.equal(calls,1);
    assert.equal((await suggestion(pool,request.operationId)).revisionId,object.revision.id);
    const apply={operationId:'apply-mock',commands:[{type:'suggestion.apply',id:object.id,expectedVersion:object.version,suggestionId:request.operationId}]};
    const [first,replay]=await Promise.all([execute(pool,apply),execute(pool,apply)]);assert.deepEqual(first,replay);assert.equal(first.status,'SUCCEEDED');assert.equal((await readObject(pool,object.id)).revision.content.text,'模拟草稿');
    await pool.query("UPDATE suggestions SET expires_at=now()-interval '1 second'");await sweepJobs(pool);await assert.rejects(suggestion(pool,request.operationId),{code:'SUGGESTION_EXPIRED'});assert.equal((await readObject(pool,object.id)).revision.content.text,'模拟草稿');
  });
  await t.test('unknown provider results never requeue; queued cancellation does not invoke a provider',async()=>{
    const object=await readObject(pool,'suggest-scene'),request={operationId:'unknown-suggest',kind:'AI_SUGGEST',objectId:object.id,expectedVersion:object.version,revisionId:object.revision.id,prompt:'受控中断'};let calls=0;
    await enqueue(pool,request);await workOnce(pool,{root,workerId:'fixture-worker',providers:{suggest:async({onRequestId})=>{calls++;await onRequestId('known-request-to-reconcile');throw Error('mock connection lost');}}});
    const receipt=await operation(pool,request.operationId);assert.equal(receipt.status,'RESULT_UNKNOWN');assert.equal(receipt.providerRequestId,'known-request-to-reconcile');assert.equal((await enqueue(pool,request)).status,'RESULT_UNKNOWN');assert(!await workOnce(pool,{root,workerId:'fixture-worker'}));assert.equal(calls,1);
    await enqueue(pool,{...request,operationId:'cancel-suggest'});await cancelJob(pool,'cancel-suggest');assert(!await workOnce(pool,{root,workerId:'fixture-worker'}));
  });
  await t.test('family identity and rights changes are explicit even when display names match',async()=>{
    await create('other-family','MATERIAL',{description:'同名素材族'});await create('another-asset','ASSET',{description:'同名候选'},{links:[{id:'other-family',role:'FAMILY'}]});
    assert.equal((await pool.query("SELECT family_id FROM asset_versions WHERE object_id='another-asset'")).rows[0].family_id,'other-family');
    const asset=await readObject(pool,'asset'),result=await run([{type:'rights.record',id:asset.id,revisionId:asset.revision.id,expectedVersion:asset.version,explicit:true,fact:'BLOCKED',evidence:{note:'模拟权利阻断'}}]);assert.equal(result.status,'SUCCEEDED');assert.equal((await readObject(pool,'asset')).rights.fact,'BLOCKED');
    await assert.rejects(pool.query("UPDATE rights_events SET fact='CLEAR'"),/Immutable/);
  });
});
