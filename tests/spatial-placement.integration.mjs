// Managed PostgreSQL / API fixture. All records below are synthetic; never mirrors
// a story or reads a configured instance. Also exports the fixture for browser QA.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import pg from 'pg';
import {requiredPhase} from '../tools/process-resources.mjs';
import {moduleFor} from '../server/modules.mjs';
import {execute} from '../server/commands.mjs';
import {hash} from '../server/shared/contracts.mjs';
import {transaction,closeDatabase} from '../server/db.mjs';
import {workspaceRead} from '../server/presentation/workspaces.mjs';
import {spatialBaseline} from '../server/workspaces.mjs';
import {objectDetail} from '../server/repository.mjs';
import {dispatch} from '../server/api.mjs';
import {SPATIAL_PLACEMENT_CATALOG_LOCK} from '../server/settings/spatial-placement.mjs';

export async function createSpatialFixture() {
  const phase=await requiredPhase();assert(phase,'Use the task guard and managed process');
  const container='review-placement-'+randomUUID(),labels=await phase.expect('container',container);
  execFileSync('docker',['run','-d','--name',container,...labels,'--tmpfs','/var/lib/postgresql:rw,size=512m','-e','POSTGRES_USER=review','-e','POSTGRES_DB=review','-e','POSTGRES_HOST_AUTH_METHOD=trust','-p','127.0.0.1::5432','postgres:18.6'],{stdio:'pipe'});
  await phase.capture('container',container);
  const info=JSON.parse(execFileSync('docker',['inspect',container],{encoding:'utf8'}))[0];
  const connection={host:'127.0.0.1',port:Number(info.NetworkSettings.Ports['5432/tcp'][0].HostPort),user:'review',database:'review'};
  const pool=new pg.Pool({...connection,max:8});
  for(let i=0;;i++){try{await pool.query('SELECT 1');break;}catch(e){if(i>100){await pool.end();throw e;}await new Promise(r=>setTimeout(r,100));}}
  await pool.query(await readFile(new URL('../server/schema.sql',import.meta.url),'utf8'));
  const epoch=randomUUID(),instanceId='ui-fixture-placement-'+randomUUID();
  await pool.query('INSERT INTO project(instance_id,runtime_epoch,title) VALUES($1,$2,$3)',[instanceId,epoch,'合成空间验证']);
  // The default NOTE review standard must be stored outside the strict placement.
  await pool.query("INSERT INTO configurations(scope,version,content) VALUES('system',1,$1)",[{reviewStandards:[{id:'fixture-note',subjectKind:'NOTE',default:true,criteria:[]}]}]);
  const seed=async(id,kind,content,{historical=false,state='ADOPTED',links=[]}={})=>{
    const revisionId=id+':r1',sha256=hash(content);
    await transaction(pool,async tx=>{
      await tx.query('INSERT INTO objects(id,module,kind,title,state,draft_revision_id,adopted_revision_id,historical) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,moduleFor(kind).name,kind,content.name||id,state,revisionId,state==='ADOPTED'?revisionId:null,historical]);
      await tx.query('INSERT INTO revisions(id,object_id,number,content,sha256,author) VALUES($1,$2,1,$3,$4,$5)',[revisionId,id,content,sha256,'synthetic fixture']);
      for(const [position,link]of links.entries()){
        await tx.query('INSERT INTO memberships(owner_id,member_id,role) VALUES($1,$2,$3)',[id,link.id,link.role]);
        await tx.query('INSERT INTO revision_memberships(revision_id,member_id,role,position) VALUES($1,$2,$3,$4)',[revisionId,link.id,link.role,position]);
      }
    });
    return {id,revisionId,sha256,expectedVersion:1};
  };
  const anchors=[];
  for(let i=0;i<14;i++){
    const id='fixture-anchor-'+i;await seed(id,'ENTITY',{name:'已登记地点 '+i,type:'LOCATION',description:'合成已登记地点'});
    anchors.push({id,name:'已登记地点 '+i,pos:[(i%7)*25,Math.floor(i/7)*30],entrance:i%2?'朝北':'朝东',status:'LOCKED'});
  }
  const locations=[];
  for(let i=0;i<12;i++)locations.push(await seed('fixture-location-'+i,'ENTITY',{name:'待核地点 '+i,type:'LOCATION',description:'合成地点永久档案 '+i}));
  const scene=await seed('fixture-scene','SCENE',{title:'合成场',blocks:[{id:'fixture-block',type:'action',text:'合成证据。'}]});
  const spatial={version:'fixture-1',orientation:'北上东右',locations:anchors,scene_route_locks:[]};
  const bytes=Buffer.from(JSON.stringify(spatial,null,2));
  const source=await seed('fixture-spatial-source','SOURCE',{role:'SPATIAL_SPECIFICATION',text:bytes.toString()},{historical:true});
  source.sourceSha256=hash(bytes);assert.notEqual(source.sha256,source.sourceSha256);
  await pool.query("INSERT INTO source_documents(revision_id,original_revision_id,original_sha256,mime_type,content_bytes,logical_path,role) VALUES($1,$1,$2,'application/json',$3,'fixture-spatial.json','SPATIAL_SPECIFICATION')",[source.revisionId,source.sourceSha256,bytes]);
  const draft=(i,{exact=i%2===0,noteId='fixture-note-'+i}={})=>({noteId,expectedVersion:0,expectedDraftRevisionId:null,title:'待确认地点 '+i,content:{schemaVersion:'1.0',role:'SPATIAL_PLACEMENT_DRAFT',status:'PENDING_CONFIRMATION',location:{...locations[i]},spatialSource:{...source},coordinateSpace:'CANVAS_ONLY',proposedSlot:[120+i*260,900],authority:'UNKNOWN',entrance:'UNKNOWN',sceneEvidence:exact?{status:'EXACT',references:[{...scene,locator:'fixture-block'}]}:{status:'UNKNOWN',reason:'尚无可核对的场依据'},unknowns:['精确位置 UNKNOWN','朝向与距离 UNKNOWN'],note:'合成待确认方案，需人工核对。'}});
  const request=(drafts,operationId=randomUUID())=>({operationId,runtimeEpoch:epoch,actor:{kind:'HUMAN',label:'isolated placement QA'},commands:[{type:'workspace.change',workspace:'spatial-settings/placements',input:{action:'save',drafts}}]});
  const save=drafts=>execute(pool,request(drafts));
  const read=name=>transaction(pool,tx=>workspaceRead(tx,name.split('/'),new URLSearchParams({owner:'SETTINGS'})),{readOnly:true});
  const detail=id=>transaction(pool,tx=>objectDetail(tx,id),{readOnly:true});
  const instanceRoot=path.join(process.env.REVIEW_TASK_DIR,'placement-instance');
  await mkdir(path.join(instanceRoot,'runtime'),{recursive:true});
  await writeFile(path.join(instanceRoot,'instance.json'),JSON.stringify({schemaVersion:'3.0',instanceId,title:'合成空间验证'}));
  await writeFile(path.join(instanceRoot,'runtime/machine.json'),JSON.stringify({database:connection}));
  return {phase,pool,epoch,instanceId,instanceRoot,seed,source,spatial,bytes,scene,locations,draft,request,save,read,detail};
}

async function integration() {
 const f=await createSpatialFixture(),{pool,draft,request,read,detail}=f,passed=[];
 const ok=value=>{assert.equal(value.status,'SUCCEEDED',JSON.stringify(value));return value;};
 const fails=(value,code)=>{assert.equal(value.status,'FAILED',JSON.stringify(value));if(code)assert.equal(value.error.code,code,JSON.stringify(value));return value;};
 const edit=async(i,changes={})=>{const old=await detail('fixture-note-'+i);return {...draft(i),expectedVersion:old.version,expectedDraftRevisionId:old.draftRevisionId,...changes};};
 const generic=commands=>execute(pool,{operationId:randomUUID(),runtimeEpoch:f.epoch,actor:{kind:'HUMAN',label:'generic bypass QA'},commands});
 const originalEnv=process.env.REVIEW_INSTANCE_ROOT;
 try {
  const before=(await pool.query("SELECT * FROM objects ORDER BY id")).rows;
  const sourceBytes=(await pool.query('SELECT * FROM source_documents')).rows;
  const baseline=await transaction(pool,tx=>spatialBaseline(tx));
  assert.equal(baseline.sourceBinding.historical,true);assert.equal(baseline.sourceBinding.state,'ADOPTED');
  assert.equal(baseline.sourceBinding.revisionSha256,f.source.sha256);assert.equal(baseline.sourceBinding.sourceSha256,f.source.sourceSha256);
  const req=request(Array.from({length:5},(_,i)=>draft(i)));
  const saved=ok(await execute(pool,req));assert.equal(saved.workspace.drafts.length,5);
  assert.equal(saved.workspace.formalAdoptionPerformed,false);
  assert.deepEqual(await execute(pool,req),saved);
  await assert.rejects(execute(pool,{...req,actor:{...req.actor,label:'different request'}}),{code:'OPERATION_ID_CONFLICT'});
  assert.deepEqual((await pool.query("SELECT * FROM objects WHERE kind<>'NOTE' ORDER BY id")).rows,before);
  assert.deepEqual((await pool.query('SELECT * FROM source_documents')).rows,sourceBytes);
  for(let i=0;i<5;i++){
    const note=await detail('fixture-note-'+i);assert.equal(note.state,'DRAFT');assert.equal(note.adoptedRevisionId,null);
    assert(note.revision.content.reviewSpec);assert(!note.revision.content.placement.reviewSpec);
    const dependencies=(await pool.query('SELECT d.dependency_revision_id,r.sha256 FROM dependencies d JOIN revisions r ON r.id=d.dependency_revision_id WHERE d.consumer_revision_id=$1',[note.revision.id])).rows;
    assert.equal(dependencies.find(v=>v.dependency_revision_id===f.source.revisionId).sha256,f.source.sha256);
  }
  const projected=await read('domain-workspaces');assert.equal(projected.spatialPlacements.pendingOverlays.length,5);
  assert.deepEqual(projected.spatial.locations.map(({id,pos,entrance,status})=>({id,pos,entrance,status})),f.spatial.locations.map(({id,pos,entrance,status})=>({id,pos,entrance,status})));
  assert.equal(projected.spatial.orientation,'北上东右');assert.equal((await read('spatial-settings')).specification.locations.length,14);
  passed.push('five NOTE drafts only; 14 anchors, original SOURCE bytes/history and all adopted heads unchanged; exact revision SHA differs from original byte SHA; idempotency');

  const old=await detail('fixture-note-0'),edited=await edit(0);edited.content.note='合成显示说明更新';
  ok(await f.save([edited]));assert.equal((await detail(old.id)).revision.number,2);
  assert.deepEqual((await transaction(pool,tx=>objectDetail(tx,old.id,{revisionId:old.revision.id}))).revision.content,old.revision.content);
  fails(await f.save([edited]),'VERSION_CONFLICT');
  fails(await f.save([{...await edit(0),expectedDraftRevisionId:old.revision.id}]),'VERSION_CONFLICT');
  const rebind=await edit(0);rebind.content.location={...f.locations[8]};fails(await f.save([rebind]),'SPATIAL_PLACEMENT_BINDING_IMMUTABLE');
  const n=await detail(old.id);
  for(const content of [n.revision.content,{role:'ordinary-note',text:'strip reserved role'}])fails(await generic([{type:'save',id:n.id,expectedVersion:n.version,content}]),'SPATIAL_PLACEMENT_PLANNER_REQUIRED');
  fails(await generic([{type:'save',id:'bypass-create',kind:'NOTE',expectedVersion:0,title:'bypass',content:{role:'SPATIAL_PLACEMENT_DRAFT',placement:draft(7).content}}]),'SPATIAL_PLACEMENT_PLANNER_REQUIRED');
  for(const type of ['submit','review','archive'])fails(await generic([{type,id:n.id,expectedVersion:n.version,revisionId:n.revision.id,decision:'ADOPT',explicit:true,findings:[]}]),'SPATIAL_PLACEMENT_DRAFT_ONLY');
  const ai=request([draft(7)]);ai.actor={kind:'ASSISTANT',label:'fixture assistant'};fails(await execute(pool,ai),'SPATIAL_PLACEMENT_PLANNER_REQUIRED');
  const noEpoch=request([draft(7)]);delete noEpoch.runtimeEpoch;fails(await execute(pool,noEpoch),'RUNTIME_REQUIRED');
  await assert.rejects(execute(pool,{...request([draft(7)]),runtimeEpoch:randomUUID()}),{code:'RUNTIME_CHANGED'});
  const metadata=draft(7);metadata.content.reviewSpec={};fails(await f.save([metadata]),'SPATIAL_PLACEMENT_INVALID');
  passed.push('append-only edits; NOTE version and draft-head CAS; no rebinding; generic save, role stripping, submit, review/adopt, archive and assistant bypasses rejected');

  fails(await f.save([draft(5),{...draft(6),title:'x'.repeat(501)}]),'TITLE_REQUIRED');
  assert.equal((await pool.query("SELECT 1 FROM objects WHERE id IN ('fixture-note-5','fixture-note-6')")).rowCount,0);
  const races=await Promise.all(['race-a','race-b'].map(noteId=>f.save([draft(5,{noteId})])));
  assert.equal(races.filter(v=>v.status==='SUCCEEDED').length,1);assert.equal(races.find(v=>v.status==='FAILED').error.code,'SPATIAL_PLACEMENT_DUPLICATE');
  const idem=request([draft(6)]),duplicates=await Promise.all([execute(pool,idem),execute(pool,idem)]);ok(duplicates[0]);assert.deepEqual(...duplicates);
  passed.push('late failure rolls back entire batch; concurrent unique active NOTE per location; concurrent operation replay');

  for(const [field,value]of [['sha256','0'.repeat(64)],['sourceSha256','1'.repeat(64)],['revisionId','missing-revision'],['expectedVersion',999]]){
    const input=draft(7);input.content.spatialSource[field]=value;fails(await f.save([input]),'SPATIAL_PLACEMENT_STALE');
  }
  await pool.query('UPDATE objects SET historical=true WHERE id=$1',[f.scene.id]);
  fails(await f.save([await edit(0)]),'SPATIAL_PLACEMENT_STALE');
  const stale=await read('spatial-settings/placements');assert(stale.staleDrafts.some(v=>v.note.id==='fixture-note-0'));assert(stale.pendingOverlays.some(v=>v.targetEntityId===f.locations[1].id));
  await pool.query('UPDATE objects SET historical=false WHERE id=$1',[f.scene.id]);
  await pool.query('UPDATE objects SET historical=true WHERE id=$1',[f.locations[7].id]);
  fails(await f.save([draft(7)]),'SPATIAL_PLACEMENT_STALE');
  await pool.query('UPDATE objects SET historical=false WHERE id=$1',[f.locations[7].id]);
  for(const state of ['DISABLED','ARCHIVED','DRAFT']){
    await pool.query('UPDATE objects SET state=$2 WHERE id=$1',[f.source.id,state]);fails(await f.save([draft(7)]),'SPATIAL_PLACEMENT_SOURCE');
  }
  await pool.query("UPDATE objects SET state='ADOPTED' WHERE id=$1",[f.source.id]);
  await pool.query('UPDATE objects SET adopted_revision_id=NULL WHERE id=$1',[f.source.id]);
  fails(await f.save([draft(7)]),'SPATIAL_PLACEMENT_SOURCE');
  await pool.query('UPDATE objects SET adopted_revision_id=$2 WHERE id=$1',[f.source.id,f.source.revisionId]);
  const anchored=draft(7);anchored.content.location={id:'fixture-anchor-0',revisionId:'fixture-anchor-0:r1',sha256:hash({name:'已登记地点 0',type:'LOCATION',description:'合成已登记地点'}),expectedVersion:1};
  fails(await f.save([anchored]),'SPATIAL_PLACEMENT_ANCHOR_EXISTS');
  await pool.query("UPDATE objects SET state='SUBMITTED' WHERE id='fixture-note-1'");fails(await f.save([await edit(1)]),'SPATIAL_PLACEMENT_READ_ONLY');
  await pool.query("UPDATE objects SET state='DRAFT',historical=true WHERE id='fixture-note-1'");fails(await f.save([await edit(1)]),'SPATIAL_PLACEMENT_READ_ONLY');
  await pool.query("UPDATE objects SET historical=false WHERE id='fixture-note-1'");
  passed.push('stale SOURCE identity/version/both SHAs, historical scene/location, retired or unadopted source, locked anchor and read-only NOTE rejected without changing stored bindings');

  // Pause immediately before the first shared catalog lock. A second real
  // transaction changes an input after the planner read, before locks/recheck.
  async function afterInitialRead(input,mutate){
    let reached,resume;const atLock=new Promise(r=>reached=r),go=new Promise(r=>resume=r);let held=false;
    const gated={connect:async()=>{const client=await pool.connect();return {release:()=>client.release(),query:async(sql,args)=>{
      if(!held&&String(sql).includes('pg_advisory_xact_lock(hashtextextended($1,1))')&&args?.[0]===SPATIAL_PLACEMENT_CATALOG_LOCK){held=true;reached();await go;}
      return client.query(sql,args);
    }};}};
    const pending=execute(gated,request([input]));
    await Promise.race([atLock,pending.then(()=>{throw Error('planner did not reach lock');}),new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('lock barrier timed out')),10000);t.unref();})]);
    try{await mutate();}finally{resume();}
    return pending;
  }
  const loc=await detail(f.locations[8].id);
  fails(await afterInitialRead(draft(8),async()=>ok(await generic([{type:'save',id:loc.id,expectedVersion:loc.version,title:loc.title,content:{...loc.revision.content,description:'changed under planner read'}}]))),'SPATIAL_PLACEMENT_STALE');
  fails(await afterInitialRead(draft(9),async()=>ok(await generic([{type:'save',id:'new-spatial-source',kind:'SOURCE',expectedVersion:0,title:'new synthetic source',content:{role:'SPATIAL_SPECIFICATION',text:'{}'}}]))),'SPATIAL_PLACEMENT_SOURCE');
  assert.equal((await pool.query("SELECT 1 FROM objects WHERE id IN ('fixture-note-8','fixture-note-9')")).rowCount,0);
  await pool.query("UPDATE objects SET state='DISABLED' WHERE id='new-spatial-source'");
  passed.push('real concurrent location mutation and phantom SOURCE creation are caught by post-lock validation');

  const conflict=draft(2).content;await f.seed('legacy-duplicate','NOTE',{role:'SPATIAL_PLACEMENT_DRAFT',placement:conflict},{state:'DRAFT'});
  await f.seed('legacy-invalid','NOTE',{role:'SPATIAL_PLACEMENT_DRAFT',placement:'broken legacy payload'},{state:'DRAFT'});
  const conflicts=await read('spatial-settings/placements');assert.equal(conflicts.conflicts.length,2);assert(conflicts.staleDrafts.some(v=>v.note.id==='legacy-invalid'&&v.content===null));
  assert(!conflicts.pendingOverlays.some(v=>v.targetEntityId===f.locations[2].id));
  passed.push('duplicate and malformed legacy NOTE records stay readable with explicit conflict/stale status');

  // A corrupt imported source must fail its raw-byte check without modifying
  // any original row or disabling immutable-history triggers.
  const corrupt=await f.seed('corrupt-source','SOURCE',{role:'SPATIAL_SPECIFICATION',text:'{}'});
  await pool.query("INSERT INTO source_documents(revision_id,original_revision_id,original_sha256,mime_type,content_bytes,logical_path,role) VALUES($1,$1,$2,'application/json',$3,'corrupt-fixture.json','SPATIAL_SPECIFICATION')",[corrupt.revisionId,'0'.repeat(64),Buffer.from('{}')]);
  await pool.query("UPDATE objects SET state='DISABLED' WHERE id=$1",[f.source.id]);
  assert.equal((await read('spatial-settings/placements')).status,'INVALID');
  fails(await f.save([draft(11)]),'SPATIAL_PLACEMENT_SOURCE');
  await pool.query("UPDATE objects SET state='DISABLED' WHERE id=$1",[corrupt.id]);
  await pool.query("UPDATE objects SET state='ADOPTED' WHERE id=$1",[f.source.id]);
  passed.push('missing effective adopted SOURCE head and corrupted imported raw SHA fail closed with immutable source rows retained');

  process.env.REVIEW_INSTANCE_ROOT=f.instanceRoot;
  const api=async(method,pathname,body)=>{const operationId=randomUUID();const response=await dispatch(new Request('http://fixture/api/v1/'+pathname,{method,headers:method==='GET'?{}:{'Content-Type':'application/json','X-Review-Runtime':f.epoch,'Idempotency-Key':operationId},...(body?{body:JSON.stringify(body)}:{})}));return {status:response.status,data:await response.json()};};
  const actual=await api('GET','workspaces/spatial-settings/placements');assert.equal(actual.status,200);
  const posted=await api('POST','workspaces/spatial-settings/placements',{action:'save',drafts:[draft(10)]});assert.equal(posted.status,200,JSON.stringify(posted));assert.equal(posted.data.formalAdoptionPerformed,false);
  const sourceRead=await api('GET','workspaces/spatial-settings');assert.deepEqual(sourceRead.data.specification,f.spatial);
  const noteRead=await api('GET','objects/fixture-note-10?revisionId='+encodeURIComponent(posted.data.drafts[0].revisionId));assert.equal(noteRead.status,200);assert.equal(noteRead.data.revision.content.placement.status,'PENDING_CONFIRMATION');
  const submitRead=await api('POST','workspaces/reviews',{subjectId:'fixture-note-10',subjectType:'NOTE',expectedVersion:1,objectRevisionId:noteRead.data.revision.id,reviewSpecHash:hash(noteRead.data.revision.content.reviewSpec),action:'APPROVE_AND_RELEASE',criterionFindings:[]});
  assert.equal(submitRead.status,409);assert.equal(submitRead.data.code,'SPATIAL_PLACEMENT_DRAFT_ONLY');
  passed.push('existing API workspace.change save and exact NOTE readback; raw spatial-settings specification unchanged');
  const result={status:'PASSED',checks:passed,realModelCalls:0,syntheticOnly:true};
  console.log(JSON.stringify(result,null,2));
  await writeFile(path.join(process.env.REVIEW_TASK_DIR,'spatial-placement-integration.json'),JSON.stringify(result,null,2));
 } finally {await closeDatabase();if(originalEnv===undefined)delete process.env.REVIEW_INSTANCE_ROOT;else process.env.REVIEW_INSTANCE_ROOT=originalEnv;await pool.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await integration();
