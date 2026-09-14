import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import pg from 'pg';
import {openPhase} from '../tools/process-resources.mjs';
import {execute,operation} from '../server/commands.mjs';
import {transaction,closeDatabase} from '../server/db.mjs';
import {dispatch} from '../server/api.mjs';
import {readObject} from '../server/repository.mjs';
import {workspaceRead} from '../server/presentation/workspaces.mjs';
import {MATERIAL_USAGE_SCOPE_ROLE as role,validateMaterialUsageScopeContent,validateMaterialUsageScopeTargets,
  planMaterialUsageScopeChange,validateStoredMaterialUsageScope} from '../server/materials/usage-scopes.mjs';

const runtimeEpoch = '00000000-0000-4000-8000-000000000041';
const runtime = {runtimeEpoch};
const bare = () => ({role,familyId:'family',familyRevisionId:'family-r1',familyExpectedVersion:1,scopeType:'PROJECT',scopeId:'instance-fixture'});

test('usage contract rejects Cartesian arrays, asset/review bindings and role/family substitution', () => {
  const content = bare(); assert.doesNotThrow(()=>validateMaterialUsageScopeContent(content));
  for (const key of ['scopeIds','episodeIds','familyIds','versionId','sha256','requirementHash','rightsFact','reviewSpec','dependencies']) {
    assert.throws(()=>validateMaterialUsageScopeContent({...content,[key]:['forged']}));
  }
  assert.throws(()=>validateMaterialUsageScopeContent({...content,familyId:'other'},content),{code:'USAGE_SCOPE_FAMILY_IMMUTABLE'});
  assert.throws(()=>validateMaterialUsageScopeContent({role:'OTHER'},content),{code:'USAGE_SCOPE_IDENTITY'});
  assert.throws(()=>validateMaterialUsageScopeContent(content,{role:'OTHER'}),{code:'USAGE_SCOPE_IDENTITY'});
  for (const v of [-1,0,1.2,'1',Number.MAX_SAFE_INTEGER+1]) assert.throws(()=>validateMaterialUsageScopeContent({...content,familyExpectedVersion:v}));
});

test('an explicit path validates one registered direction and all versions without choosing another parent',async()=>{
  const nodes = [
    {kind:'EPISODE',objectId:'ep',revisionId:'ep-r',expectedVersion:2},
    {kind:'SCENE',objectId:'sc',revisionId:'sc-r',expectedVersion:1},
    {kind:'SHOT',objectId:'sh',revisionId:'sh-r',expectedVersion:3},
  ];
  const content = {...bare(),scopeType:'SHOT',scopeId:'sh',scopeRevisionId:'sh-r',scopeExpectedVersion:3,
    path:{nodes,relations:[{ownerId:'ep',memberId:'sc',role:'SCENE'},{ownerId:'sh',memberId:'sc',role:'SCENE'}]}};
  const tx = {query:async(sql,params)=>{
    if(sql.includes('revision_memberships'))return {rows:[{}],rowCount:1};
    const node = params[0]==='family'?{kind:'MATERIAL',revisionId:'family-r1',expectedVersion:1}:nodes.find(n=>n.objectId===params[0]);
    return {rows:node?[{kind:node.kind,version:node.expectedVersion,headRevisionId:node.revisionId,state:'DRAFT',historical:false}]:[]};
  }};
  await validateMaterialUsageScopeTargets(tx,content);
  await assert.rejects(validateMaterialUsageScopeTargets({query:async(sql,p)=>sql.includes('revision_memberships')?{rows:[],rowCount:0}:tx.query(sql,p)},content),{code:'USAGE_SCOPE_PATH'});
  await assert.rejects(validateMaterialUsageScopeTargets(tx,{...content,scopeExpectedVersion:2,path:undefined}),{code:'USAGE_SCOPE_STALE'});
  const broken = structuredClone(content); broken.path.nodes.reverse(); assert.throws(()=>validateMaterialUsageScopeContent(broken),{code:'USAGE_SCOPE_PATH'});
  const crossed = structuredClone(content); crossed.path.relations[1].memberId = 'another-scene'; assert.throws(()=>validateMaterialUsageScopeContent(crossed),{code:'USAGE_SCOPE_PATH'});
});

const run = promisify(execFile);
async function isolatedPool(t) {
  assert.ok(process.env.REVIEW_PROCESS_CONTEXT,'Tests require a registered process phase');
  const phase = await openPhase(JSON.parse(process.env.REVIEW_PROCESS_CONTEXT));
  await phase.assertRunning();
  const container = 'review-usage-test-' + randomUUID();
  const labels = await phase.expect('container',container);
  await run('docker',['run','--pull=never','-d','--name',container,...labels,'--tmpfs','/var/lib/postgresql:rw',
    '-e','POSTGRES_HOST_AUTH_METHOD=trust','-p','127.0.0.1::5432','postgres:18.6'],{timeout:30000});
  await phase.capture('container',container);
  const {stdout} = await run('docker',['port',container,'5432/tcp']);
  const pool = new pg.Pool({host:'127.0.0.1',port:Number(stdout.trim().split(':').at(-1)),database:'postgres',user:'postgres',connectionTimeoutMillis:1000});
  t.after(()=>pool.end());
  const instanceRoot=path.join(process.env.REVIEW_TASK_DIR,'usage-fixture-instance');
  await mkdir(path.join(instanceRoot,'runtime'),{recursive:true});
  await writeFile(path.join(instanceRoot,'instance.json'),JSON.stringify({schemaVersion:'3.0'}));
  await writeFile(path.join(instanceRoot,'runtime','machine.json'),JSON.stringify({database:{host:'127.0.0.1',port:pool.options.port,database:'postgres',user:'postgres'}}));
  const previousInstanceRoot=process.env.REVIEW_INSTANCE_ROOT;
  process.env.REVIEW_INSTANCE_ROOT=instanceRoot;
  t.after(async()=>{await closeDatabase();if(previousInstanceRoot===undefined)delete process.env.REVIEW_INSTANCE_ROOT;else process.env.REVIEW_INSTANCE_ROOT=previousInstanceRoot;});
  let ready = false;
  for(let i=0;i<60;i++) {
    try {await pool.query('SELECT 1');ready=true;break;} catch {await new Promise(resolve=>setTimeout(resolve,250));}
  }
  assert.ok(ready,'Isolated PostgreSQL did not become ready');
  await pool.query(await readFile(new URL('../server/schema.sql',import.meta.url),'utf8'));
  await pool.query('INSERT INTO project(instance_id,runtime_epoch,title) VALUES($1,$2,$3)',['instance-fixture',runtimeEpoch,'Synthetic fixture']);
  return pool;
}

test('real workspace and generic transactions preserve loose usage history and all frozen business facts', {timeout:120000}, async t => {
  const pool = await isolatedPool(t);
  const request = (commands,operationId=randomUUID()) => ({...runtime,operationId,commands});
  const ok = async commands => {const result=await execute(pool,request(commands));assert.equal(result.status,'SUCCEEDED',JSON.stringify(result));return result;};
  const fail = async (commands,code) => {const result=await execute(pool,request(commands));assert.equal(result.status,'FAILED',JSON.stringify(result));assert.equal(result.error.code,code,JSON.stringify(result));return result;};
  const saved = {};
  const create = async(id,kind,content,links=[])=>{const r=await ok([{type:'save',id,kind,title:id,expectedVersion:0,content,links}]);saved[id]=r.results[0];return saved[id];};
  const read = (path,params={})=>transaction(pool,tx=>workspaceRead(tx,path.split('/'),new URLSearchParams(params)),{readOnly:true});
  const action = (input)=>[{type:'workspace.change',workspace:'material-usage-scopes',input}];
  const stages = new Map();
  const upsert = (content,old) => ({type:'UPSERT',expectedVersion:old?.version||0,expectedRevisionId:old?.revisionId||null,content});
  const stage = async(usageId,change)=>{
    const input={action:'save',usageId,expectedDraftRevisionId:stages.get(usageId)||null,change};
    const result=await ok(action(input));stages.set(usageId,result.workspace.draftRevisionId);return result;
  };
  const preview = async usageId => (await ok(action({action:'preview',usageId,draftRevisionId:stages.get(usageId)}))).workspace;
  const publish = async(usageId,view=undefined)=>{
    const plan=view||await preview(usageId);
    const result=await ok(action({action:'publish',usageId,draftRevisionId:stages.get(usageId),previewHash:plan.previewHash}));
    stages.set(usageId,result.workspace.draftRevisionId);return result.results.at(-1);
  };
  const ref = id=>({objectId:id,revisionId:saved[id].revisionId,expectedVersion:saved[id].version});
  const content = (type='PROJECT',id='instance-fixture')=>({role,familyId:'family',familyRevisionId:saved.family.revisionId,familyExpectedVersion:saved.family.version,
    scopeType:type,scopeId:id,...(type==='PROJECT'?{}:{scopeRevisionId:saved[id].revisionId,scopeExpectedVersion:saved[id].version})});
  await create('family','MATERIAL',{label:'Loose-only family',kind:'IMAGE'});
  await create('other-family','MATERIAL',{label:'Other family',kind:'IMAGE'});
  await create('person','ENTITY',{type:'CHARACTER',description:'independent person'});
  await create('legacy-group','ENTITY',{type:'GROUP',description:'existing group'});
  await create('scene-a','SCENE',{text:'fixture scene a'});
  await create('scene-b','SCENE',{text:'fixture scene b'});
  await create('episode-a','EPISODE',{},[{id:'scene-a',role:'SCENE'}]);
  await create('episode-b','EPISODE',{},[{id:'scene-b',role:'SCENE'}]);
  await create('shot','SHOT',{description:'shared shot'},[{id:'scene-a',role:'SCENE'},{id:'scene-b',role:'SCENE'}]);
  await create('req','REQUIREMENT',{acceptanceCriteria:['no single entity']},[{id:'family',role:'FAMILY'}]);
  await create('composition','REQUIREMENT',{acceptanceCriteria:['two components'],composition:{schemaVersion:'1.0',mode:'ALL',requiredComponents:[{id:'component',requirementId:'req'}]}});
  await create('asset','ASSET',{},[{id:'family',role:'FAMILY'}]);
  await create('lock','INPUT_LOCK',{},[]);
  // Synthetic fixture facts only: production state never connects to this database.
  await pool.query("UPDATE objects SET state='ADOPTED',adopted_revision_id=draft_revision_id WHERE id IN ('asset','lock')");
  await pool.query("UPDATE material_families SET adopted_asset_id='asset' WHERE object_id='family'");
  await pool.query("UPDATE rights SET fact='CLEAR' WHERE revision_id=$1",[saved.asset.revisionId]);
  await pool.query("INSERT INTO dependencies(consumer_revision_id,dependency_revision_id,purpose) VALUES($1,$2,'ACTUAL_INPUT')",[saved.lock.revisionId,saved.asset.revisionId]);
  await pool.query("INSERT INTO invalidations(consumer_revision_id,changed_revision_id,replacement_revision_id,operation_id) VALUES($1,$2,$2,'fixture-existing')",[saved.lock.revisionId,saved.req.revisionId]);
  const frozen = async()=>{
    const output={};for(const table of ['material_families','asset_versions','rights','rights_events','reviews','dependencies','invalidations'])output[table]=(await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
    output.objects=(await pool.query("SELECT to_jsonb(o) AS row FROM objects o WHERE id IN ('family','asset','lock') ORDER BY id")).rows;
    return output;
  };
  const before = await frozen();

  await t.test('four independent notes, original operation replay and no Cartesian expansion',async()=>{
    const rows=[['project-use','PROJECT','instance-fixture'],['episode-use','EPISODE','episode-a'],['scene-use','SCENE','scene-b'],['shot-use','SHOT','shot']];
    for(const [id,type,scopeId] of rows){await stage(id,upsert(content(type,scopeId)));saved[id]=await publish(id);}
    const sameScope='shot-second-purpose';await stage(sameScope,upsert({...content('SHOT','shot'),purposeNote:'independent purpose'}));saved[sameScope]=await publish(sameScope);
    const value=await read('material-usage-scopes',{familyId:'family',catalog:'1'});
    assert.equal(value.tuples.length,5);assert.equal(value.catalog.project.scopeId,'instance-fixture');assert.equal(value.catalog.relations.filter(e=>e.owner.objectId==='shot').length,2);
    assert.equal(value.tuples.find(v=>v.usageId==='shot-use').pathResolution,'UNKNOWN');
    assert.ok(value.tuples.every(v=>v.dependencies.length===0));
    const req=request(action({action:'preview',usageId:'project-use',draftRevisionId:stages.get('project-use')}));
    const failed=await execute(pool,req);assert.equal(failed.status,'FAILED');assert.equal(failed.error.code,'DRAFT_REQUIRED');assert.deepEqual(await execute(pool,req),failed);
    const command=request([{type:'save',id:'direct-use',kind:'NOTE',title:'Direct validated usage',expectedVersion:0,content:content()}]);
    const first=await execute(pool,command);assert.equal(first.status,'SUCCEEDED');assert.deepEqual(await execute(pool,command),first);
    assert.deepEqual((await operation(pool,command.operationId)).result,first);
    await assert.rejects(execute(pool,{...command,commands:[{...command.commands[0],title:'different'}]}),{code:'OPERATION_ID_CONFLICT'});
    saved['direct-use']=first.results[0];
  });

  await t.test('wrong project/kind/revision/path and generic ASSET/dependency/role bypasses fail',async()=>{
    const command=c=>[{type:'save',id:'bad-use',kind:'NOTE',title:'bad',expectedVersion:0,content:c}];
    await fail(command({...content(),scopeId:'other-instance'}),'USAGE_SCOPE_PROJECT');
    await fail(command({...content('SHOT','shot'),scopeId:'person',scopeRevisionId:saved.person.revisionId}),'USAGE_SCOPE_REFERENCE');
    await fail(command({...content('SCENE','scene-a'),scopeRevisionId:saved['scene-b'].revisionId}),'USAGE_SCOPE_REFERENCE');
    await fail(command({...content('SCENE','scene-b'),path:{nodes:[{...ref('episode-a'),kind:'EPISODE'},{...ref('scene-b'),kind:'SCENE'}],relations:[{ownerId:'episode-a',memberId:'scene-b',role:'SCENE'}]}}),'USAGE_SCOPE_PATH');
    await fail([{...command(content())[0],links:[{id:'asset',role:'SOURCE'}]}],'USAGE_SCOPE_ISOLATION');
    await fail([{...command(content())[0],dependencies:[{revisionId:saved.asset.revisionId,purpose:'ACTUAL_INPUT'}]}],'USAGE_SCOPE_ISOLATION');
    await fail(command({...content(),reviewSpec:{criteria:[]}}),'USAGE_SCOPE_CONTENT');
    await fail([{type:'save',id:'direct-use',expectedVersion:1,content:{role:'OTHER'}}],'USAGE_SCOPE_IDENTITY');
    await fail([{type:'save',id:'ordinary',kind:'NOTE',title:'not input',expectedVersion:0,content:{},dependencies:[{revisionId:saved['direct-use'].revisionId,purpose:'DEFINITION'}]}],'USAGE_SCOPE_ISOLATION');
    for(const type of ['submit','review'])await fail([{type,id:'direct-use',expectedVersion:1,revisionId:saved['direct-use'].revisionId,decision:'ADOPT',explicit:true}],'USAGE_SCOPE_DRAFT_ONLY');
    await fail([{type:'archive',id:'direct-use',expectedVersion:1}],'USAGE_SCOPE_REMOVE_BASIS');
    await fail(command({...content(),sourceBindings:[ref('asset')]}),'USAGE_SCOPE_REFERENCE');
    await fail([{type:'save',id:'workspace-draft:material-usage-scope:forged',kind:'NOTE',title:'forged receipt',expectedVersion:0,
      content:{role:'MATERIAL_USAGE_SCOPE_EDIT_V1',usageId:'forged',status:'PUBLISHED',change:upsert(content())}}],'USAGE_SCOPE_PLANNER_REQUIRED');
    const noEpoch=await execute(pool,{operationId:randomUUID(),commands:command(content())});assert.equal(noEpoch.error.code,'RUNTIME_REQUIRED');
  });

  await t.test('chosen path, range update and historic read retain the original tuple',async()=>{
    const path={nodes:[{...ref('episode-a'),kind:'EPISODE'},{...ref('scene-a'),kind:'SCENE'},{...ref('shot'),kind:'SHOT'}],
      relations:[{ownerId:'episode-a',memberId:'scene-a',role:'SCENE'},{ownerId:'shot',memberId:'scene-a',role:'SCENE'}]};
    await stage('shot-use',upsert({...content('SHOT','shot'),path,purposeNote:'chosen first path'},saved['shot-use']));
    saved['shot-use']=await publish('shot-use');
    const chosen=await read('material-usage-scopes',{usageId:'shot-use'});assert.equal(chosen.detail.tuple.pathResolution,'EXACT');
    const oldRevision=saved['shot-use'].revisionId;
    await stage('shot-use',upsert(content('SCENE','scene-b'),saved['shot-use']));saved['shot-use']=await publish('shot-use');
    const history=await read('material-usage-scopes',{usageId:'shot-use',revisionId:oldRevision});assert.equal(history.detail.tuple.scopeId,'shot');assert.deepEqual(history.detail.tuple.path,path);
    assert.equal(history.detail.versions.length,3);
    await assert.rejects(pool.query('UPDATE revisions SET content=$1 WHERE id=$2',[{},oldRevision]),/Immutable record/);
    await fail(action({action:'save',usageId:'shot-use',expectedDraftRevisionId:stages.get('shot-use'),change:upsert({...content('SCENE','scene-b'),familyId:'other-family',familyRevisionId:saved['other-family'].revisionId},saved['shot-use'])}),'USAGE_SCOPE_FAMILY_IMMUTABLE');
  });

  await t.test('stale reference CAS, stale preview and concurrent usage writers never overwrite',async()=>{
    await stage('episode-use',upsert({...content('EPISODE','episode-a'),purposeNote:'before edit'},saved['episode-use']));const stale=await preview('episode-use');
    await stage('episode-use',upsert({...content('EPISODE','episode-a'),purposeNote:'after edit'},saved['episode-use']));
    await fail(action({action:'publish',usageId:'episode-use',draftRevisionId:stages.get('episode-use'),previewHash:stale.previewHash}),'PREVIEW_STALE');
    saved['episode-use']=await publish('episode-use');
    await stage('scene-use',upsert({...content('SCENE','scene-b'),purposeNote:'staged'},saved['scene-use']));const p=await preview('scene-use');
    saved['scene-b']=(await ok([{type:'save',id:'scene-b',expectedVersion:1,content:{text:'new fixture scene revision'}}])).results[0];
    await fail(action({action:'publish',usageId:'scene-use',draftRevisionId:stages.get('scene-use'),previewHash:p.previewHash}),'USAGE_SCOPE_STALE');
    const a=request([{type:'save',id:'project-use',expectedVersion:saved['project-use'].version,content:{...content(),purposeNote:'writer a'}}]);
    const b=request([{type:'save',id:'project-use',expectedVersion:saved['project-use'].version,content:{...content(),purposeNote:'writer b'}}]);
    const results=await Promise.all([execute(pool,a),execute(pool,b)]);assert.deepEqual(results.map(r=>r.status).sort(),['FAILED','SUCCEEDED']);assert.equal(results.find(r=>r.status==='FAILED').error.code,'VERSION_CONFLICT');
    saved['project-use']=results.find(r=>r.status==='SUCCEEDED').results[0];
    // A relation owner mutation changes its version even if the target scope stays the same.
    const old=await readObject(pool,'episode-a');const original=ref('episode-a');
    await stage('path-race',upsert({...content('SCENE','scene-a'),path:{nodes:[{...original,kind:'EPISODE'},{...ref('scene-a'),kind:'SCENE'}],relations:[{ownerId:'episode-a',memberId:'scene-a',role:'SCENE'}]}}));const pathPreview=await preview('path-race');
    saved['episode-a']=(await ok([{type:'save',id:'episode-a',expectedVersion:old.version,content:old.revision.content,links:[]}])).results[0];
    await fail(action({action:'publish',usageId:'path-race',draftRevisionId:stages.get('path-race'),previewHash:pathPreview.previewHash}),'USAGE_SCOPE_STALE');
    const familyContent={...content(),familyId:'other-family',familyRevisionId:saved['other-family'].revisionId,familyExpectedVersion:saved['other-family'].version};
    await stage('family-stale',upsert(familyContent));const familyPreview=await preview('family-stale');
    await transaction(pool,async tx=>{
      const planned=await planMaterialUsageScopeChange(tx,{action:'publish',usageId:'family-stale',draftRevisionId:stages.get('family-stale'),previewHash:familyPreview.previewHash},runtime);
      saved['other-family']=(await ok([{type:'save',id:'other-family',expectedVersion:1,content:{label:'changed fixture family',kind:'IMAGE'}}])).results[0];
      await assert.rejects(planned.validateAfterLock(),{code:'USAGE_SCOPE_STALE'});
    });
    await fail(action({action:'publish',usageId:'family-stale',draftRevisionId:stages.get('family-stale'),previewHash:familyPreview.previewHash}),'USAGE_SCOPE_STALE');
  });

  await t.test('versioned removal archives only the selected note and keeps exact history readable',async()=>{
    const old=saved['scene-use'];const originalRevision=old.revisionId;
    const oldScopeRevision=(await readObject(pool,'scene-use')).revision.content.scopeRevisionId;
    await stage('scene-use',{type:'REMOVE',expectedVersion:old.version,expectedRevisionId:old.revisionId,content:content('SCENE','scene-b')});
    const result=await publish('scene-use');assert.equal(result.state,'ARCHIVED');assert.equal(result.version,old.version+1);
    const listed=await read('material-usage-scopes',{familyId:'family'});assert.ok(!listed.tuples.some(v=>v.usageId==='scene-use'));assert.ok(listed.tuples.some(v=>v.usageId==='shot-second-purpose'));
    const history=await read('material-usage-scopes',{usageId:'scene-use',revisionId:originalRevision});assert.equal(history.detail.tuple.scopeRevisionId,oldScopeRevision);assert.equal(history.detail.tuple.historical,true);
    assert.equal(history.detail.revision.id,originalRevision);assert.equal(history.detail.tuple.scopeId,'scene-b');
    await fail([{type:'archive',id:'scene-use',expectedVersion:result.version,usageScopeBasis:content('SCENE','scene-b')}],'USAGE_SCOPE_DRAFT_ONLY');
    assert.deepEqual(await frozen(),before);
    const stored=(await pool.query("SELECT r.id,r.content,p.content AS previous FROM revisions r JOIN objects o ON o.id=r.object_id LEFT JOIN revisions p ON p.id=r.previous_id WHERE o.kind='NOTE' AND r.content->>'role'=$1",[role])).rows;
    for(const value of stored)await validateStoredMaterialUsageScope(pool,value.id,value.content,value.previous);
  });

  await t.test('migration preview recognizes exact rows, flags unpaired arrays and multiple families, and writes nothing',async()=>{
    await create('migration-exact','REQUIREMENT',{description:'explicit pair'},[{id:'other-family',role:'FAMILY'},{id:'scene-a',role:'SCENE'}]);
    await create('migration-arrays','REQUIREMENT',{description:'ambiguous',episodeIds:['display-1','display-2'],sceneIds:['scene-a','scene-b']},[{id:'other-family',role:'FAMILY'}]);
    await create('migration-nested','REQUIREMENT',{description:'ambiguous nested scope',storyApplicability:{episodeIds:['display-1'],sceneIds:['scene-a']}},[{id:'other-family',role:'FAMILY'},{id:'scene-a',role:'SCENE'}]);
    await create('migration-multi','REQUIREMENT',{description:'multiple families'},[{id:'family',role:'FAMILY'},{id:'other-family',role:'FAMILY'},{id:'scene-a',role:'SCENE'}]);
    const count=async()=>Number((await pool.query('SELECT count(*) AS n FROM revisions')).rows[0].n);const n=await count();
    const result=await read('material-usage-scopes/migration-preview');assert.equal(result.status,'PREVIEW_ONLY');assert.equal(result.writesPerformed,false);assert.equal(result.tuples.length,1);
    assert.equal(result.tuples[0].content.scopeId,'scene-a');assert.equal(result.tuples[0].content.familyId,'other-family');
    assert.ok(result.unknown.some(r=>r.code==='UNPAIRED_LEGACY_ARRAYS'));assert.ok(result.unknown.some(r=>r.code==='MULTIPLE_FAMILIES'));assert.equal(await count(),n);
    assert.ok(result.unknown.some(r=>r.fields?.includes('storyApplicability.episodeIds')));
  });

  await t.test('isExtra uses the live domain workspace and retains old ENTITY revision; materials need no GROUP',async()=>{
    const state=await read('domain-workspaces',{owner:'SETTINGS'});const person=state.graph.entities.find(e=>e.id==='person');assert.equal(person.isExtra,null);
    const input={action:'save',owner:'SETTINGS',expectedDraftRevisionId:state.draftHeadRevisionId,changes:[{collection:'entities',id:'person',beforeHash:state.ownership['entities:person'].recordHash,value:{...person,isExtra:true}}]};
    const domain=input=>[{type:'workspace.change',workspace:'domain-workspaces',input}];
    const savedDraft=await ok(domain(input));const revisionId=savedDraft.workspace.revisionId;
    const p=await ok(domain({action:'preview',owner:'SETTINGS',draftRevisionId:revisionId}));
    await ok(domain({action:'publish',owner:'SETTINGS',draftRevisionId:revisionId,previewHash:p.workspace.previewHash}));
    assert.equal((await read('domain-workspaces',{owner:'SETTINGS'})).graph.entities.find(e=>e.id==='person').isExtra,true);
    assert.equal((await readObject(pool,'person',{revisionId:saved.person.revisionId})).revision.content.isExtra,undefined);
    const catalog=await read('material-directory');assert.ok(catalog.graph.requirements.some(r=>r.id==='composition'&&r.representationId===null));
    assert.equal(Number((await pool.query("SELECT count(*) AS n FROM objects o JOIN revisions r ON r.id=o.draft_revision_id WHERE o.kind='ENTITY' AND r.content->>'type'='GROUP'")).rows[0].n),1);
  });

  await t.test('HTTP workspace routes expose the same preview, draft receipt, read and original operation contract',async()=>{
    const send=async input=>{
      const id=randomUUID();
      const response=await dispatch(new Request('http://fixture/api/v1/workspaces/material-usage-scopes',{method:'POST',headers:{'content-type':'application/json','x-review-runtime':runtimeEpoch,'idempotency-key':id},body:JSON.stringify(input)}));
      const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return {...value,operationId:id};
    };
    const s=await send({action:'save',usageId:'http-use',expectedDraftRevisionId:null,change:upsert(content())});
    const p=await send({action:'preview',usageId:'http-use',draftRevisionId:s.draftRevisionId});assert.equal(p.dependencies.length,0);
    const committed=await send({action:'publish',usageId:'http-use',draftRevisionId:s.draftRevisionId,previewHash:p.previewHash});
    assert.equal(committed.state,'DRAFT');assert.equal(committed.formalAdoptionPerformed,false);
    const get=await dispatch(new Request('http://fixture/api/v1/workspaces/material-usage-scopes?usageId=http-use'));assert.equal(get.status,200);assert.equal((await get.json()).detail.tuple.scopeId,'instance-fixture');
    const original=await dispatch(new Request('http://fixture/api/v1/operations/'+committed.operationId));assert.equal((await original.json()).result.workspace.usageId,'http-use');
  });
});
