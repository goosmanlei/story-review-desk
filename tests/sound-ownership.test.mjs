import test from 'node:test';
import assert from 'node:assert/strict';
import {hash,canonical} from '../server/shared/contracts.mjs';
import {validate} from '../server/settings/service.mjs';
import {validateConfiguration} from '../server/project/service.mjs';
import {currentSystemEntityTypes} from '../server/shared/entity-types.mjs';
import {configurationDefaults} from '../server/presentation/defaults.mjs';
import {defaultDomainConfiguration} from '../web/presentation/domain-defaults.mjs';
import {PresentationRead} from '../server/presentation/read-unit.mjs';
import {execute} from '../server/commands.mjs';
import {catalog} from '../server/repository.mjs';
import {workspaceRead} from '../server/presentation/workspaces.mjs';
import {materialRows,assets,domainWorkspace} from '../server/presentation/materials.mjs';
import {validateReferenceTargets} from '../server/materials/references.mjs';
import {soundMigrationInventory,planSoundOwnershipMigration,validateSoundOwnershipContent,validateSoundOwnershipTargets,soundOwnershipBindings,soundOwnershipDependencies,soundOwnershipLinks,soundResourceScope,validateStoredSoundOwnership} from '../server/settings/sound-ownership.mjs';

// Transaction protocol simulator: no PostgreSQL, instance files, media or model.
// Reject unhandled SQL so a new write cannot silently pass the preservation test.
class Store {
  constructor() {this.data={objects:[],revisions:[],memberships:[],revision_memberships:[],dependencies:[],provenance:[],operations:[],configurations:[]};this.calls=[];this.inject=null;}
  add(id,kind,content={},links=[],historical=false){const revision_id=id+':r1',sha256=hash(content);this.data.objects.push({id,kind,module:{ENTITY:'settings',STATE:'settings',REPRESENTATION:'settings',NOTE:'project'}[kind]||'materials',title:id,version:1,state:'DRAFT',historical,draft_revision_id:revision_id,adopted_revision_id:null});this.data.revisions.push({id:revision_id,object_id:id,content,sha256,number:1});for(const link of links){this.data.memberships.push({owner_id:id,member_id:link.id,role:link.role});this.data.revision_memberships.push({revision_id,member_id:link.id,role:link.role});}return {objectId:id,kind,revisionId:revision_id,sha256,expectedVersion:1};}
  row(id,revisionId){const o=this.data.objects.find(o=>o.id===id),r=this.data.revisions.find(r=>r.object_id===id&&r.id===(revisionId||o?.draft_revision_id||o?.adopted_revision_id));return o&&r?{...o,revision_id:r.id,sha256:r.sha256,content:r.content,head_revision_id:o.draft_revision_id||o.adopted_revision_id}:undefined;}
  resourceIds(id){const ids=new Set([id]);let changed=true;while(changed){changed=false;for(const m of this.data.memberships){for(const [a,b]of [[m.owner_id,m.member_id],[m.member_id,m.owner_id]])if(ids.has(a)&&!ids.has(b)&&['STATE','REPRESENTATION','REQUIREMENT','MATERIAL'].includes(this.row(b)?.kind)&&!this.row(b)?.historical){ids.add(b);changed=true;}}}return [...ids].filter(x=>x!==id).sort();}
  notes(){return this.data.objects.map(o=>this.row(o.id)).filter(r=>r.kind==='NOTE'&&!r.historical&&r.content.role==='SOUND_OWNERSHIP');}
  snapshot(ids,source){const data=this.data;return [
    ...data.objects.filter(o=>ids.includes(o.id)).map(o=>({section:'objects',value:o.id===source?{id:o.id,draft:o.draft_revision_id,adopted:o.adopted_revision_id}:o})),
    ...['revisions','memberships','revision_memberships','dependencies','provenance'].flatMap(section=>data[section].filter(r=>section==='revisions'?ids.includes(r.object_id):section==='memberships'?ids.includes(r.owner_id):section==='provenance'?ids.includes(r.object_id)&&r.kind!=='sound-ownership-migration':data.revisions.some(v=>ids.includes(v.object_id)&&v.id===(r.revision_id||r.consumer_revision_id))).map(value=>({section,value})))];}
  async connect(){return this;}
  release(){}
  async query(sql,args=[]){const q=sql.replace(/\s+/g,' ').trim();this.calls.push({sql:q,args:structuredClone(args)});const rows=value=>({rows:value||[],rowCount:(value||[]).length});
    if(q==='BEGIN'){this.begin=structuredClone(this.data);return rows();}if(q==='SAVEPOINT commands'){this.savepoint=structuredClone(this.data);return rows();}if(q==='ROLLBACK TO SAVEPOINT commands'){this.data=structuredClone(this.savepoint);return rows();}if(q==='ROLLBACK'){this.data=structuredClone(this.begin);return rows();}if(q==='COMMIT'||q.startsWith('SELECT set_config')||q.startsWith('SELECT pg_advisory')||q==='SET CONSTRAINTS ALL IMMEDIATE')return rows();
    if(q==='SELECT runtime_epoch FROM project')return rows([{runtime_epoch:'epoch'}]);if(q.includes("FROM runtime_status WHERE name='maintenance'"))return rows();
    if(q==='SELECT * FROM operations WHERE id=$1')return rows(this.data.operations.filter(r=>r.id===args[0]));
    if(q.startsWith('INSERT INTO operations')){this.data.operations.push({id:args[0],request_hash:args[1],status:'RUNNING'});return rows();}
    if(q.startsWith('UPDATE operations')){const op=this.data.operations.find(r=>r.id===args[0]);if(q.includes("status='SUCCEEDED'")){op.status='SUCCEEDED';op.result=args[1];}else{op.status='FAILED';op.error=args[1];op.result=args[2];}return rows();}
    if(q.startsWith('WITH RECURSIVE edges(a,b)'))return rows(this.resourceIds(args[0]).map(id=>this.row(id)));
    if(q.startsWith('WITH RECURSIVE retained(id)')){const ids=new Set(args[0]);for(const m of this.data.memberships)if(ids.has(m.member_id)&&this.row(m.owner_id)?.content.role!=='SOUND_OWNERSHIP')ids.add(m.owner_id);for(const d of this.data.dependencies){const from=this.data.revisions.find(r=>r.id===d.dependency_revision_id),to=this.data.revisions.find(r=>r.id===d.consumer_revision_id);if(ids.has(from?.object_id)&&to?.content.role!=='SOUND_OWNERSHIP')ids.add(to.object_id);}return rows([...ids].sort().map(id=>({id})));}
    if(q.startsWith('WITH selected AS'))return rows(this.snapshot(args[0],args[1]));
    if(q.startsWith('WITH RECURSIVE inputs(id)'))return rows();
    if(q.includes('ORDER BY id FOR UPDATE')){this.inject?.(this);this.inject=null;return rows();}
    if(q.includes('FROM objects o JOIN revisions r ON r.object_id=o.id WHERE o.id=$1 AND r.id=$2'))return rows([this.row(args[0],args[1])].filter(Boolean));
    if(q.includes('FROM objects o JOIN revisions r ON r.id=COALESCE')&&q.endsWith('WHERE o.id=$1'))return rows([this.row(args[0])].filter(Boolean));
    if(q.startsWith('SELECT o.id,r.content FROM objects'))return rows(this.notes().filter(r=>args[0].includes(r.id)));
    if(q.startsWith('SELECT o.id,o.title,o.version,o.state,r.id AS revision_id')){const [role,owner,source,status,resources,query,limit,offset,objectId]=args;return rows(this.notes().filter(r=>(!owner||r.content.target?.objectId===owner)&&(!source||r.content.source?.objectId===source)&&(!status||(r.content.status==='ASSIGNED'?'ASSIGNED':'UNKNOWN')===status)&&(!resources||r.content.resources.some(x=>resources.includes(x.objectId)))&&(!query||[r.title,r.content.usage,r.content.pending?.reason].join(' ').includes(query.slice(1,-1)))&&(!objectId||[r.content.source,r.content.target,...r.content.resources].some(x=>x?.objectId===objectId))).sort((a,b)=>a.id.localeCompare(b.id)).slice(offset,offset+limit));}
    if(q.includes('IN (SELECT * FROM unnest($1::text[],$2::text[]))'))return rows(args[0].map((id,i)=>this.row(id,args[1][i])).filter(Boolean));
    if(q.startsWith('SELECT o.id,o.title,o.version,o.historical'))return rows(this.data.objects.map(o=>this.row(o.id)).filter(r=>r.kind==='ENTITY'&&r.content.type==='SOUND'&&(!args[0]||r.id===args[0])).map(r=>({...r,revisionId:r.revision_id,revisionSha256:r.sha256})));
    if(q==='SELECT * FROM objects WHERE id=$1')return rows(this.data.objects.filter(r=>r.id===args[0]));
    if(q==='SELECT 1 FROM objects WHERE id=$1')return rows(this.data.objects.filter(r=>r.id===args[0]).map(()=>({exists:1})));
    if(q==='SELECT version FROM objects WHERE id=$1')return rows(this.data.objects.filter(r=>r.id===args[0]).map(r=>({version:r.version})));
    if(q==='SELECT content FROM revisions WHERE id=$1')return rows(this.data.revisions.filter(r=>r.id===args[0]).map(r=>({content:r.content})));
    if(q==='SELECT object_id,sha256 FROM revisions WHERE id=$1'||q==="SELECT object_id,sha256,content->>'role' AS role FROM revisions WHERE id=$1")return rows(this.data.revisions.filter(r=>r.id===args[0]).map(r=>({...r,role:r.content?.role||null})));
    if(q.startsWith('SELECT version,content FROM configurations'))return rows(this.data.configurations.filter(r=>r.scope===(args[0]||'system')));
    if(q.startsWith('INSERT INTO configurations')){this.data.configurations=[{scope:args[0],version:args[1],content:args[2]}];return rows();}
    if(q.startsWith('SELECT member_id AS id,role'))return rows(this.data.revision_memberships.filter(r=>r.revision_id===args[0]).map(r=>({id:r.member_id,role:r.role})));
    if(q.startsWith('SELECT dependency_revision_id AS'))return rows(this.data.dependencies.filter(r=>r.consumer_revision_id===args[0]).map(r=>({revisionId:r.dependency_revision_id,purpose:r.purpose})));
    if(q.startsWith('SELECT COALESCE(max(number),0)+1'))return rows([{n:1+this.data.revisions.filter(r=>r.object_id===args[0]).length}]);
    if(q.startsWith('INSERT INTO objects')){this.data.objects.push({id:args[0],module:args[1],kind:args[2],title:args[3],version:1,state:'DRAFT',historical:false,draft_revision_id:args[5]});return rows();}
    if(q.startsWith('INSERT INTO revisions')){this.data.revisions.push({id:args[0],object_id:args[1],number:args[2],previous_id:args[3],content:args[4],sha256:args[5],author:args[6]});return rows();}
    if(q.startsWith('DELETE FROM memberships')){this.data.memberships=this.data.memberships.filter(r=>r.owner_id!==args[0]);return rows();}
    if(q.startsWith('INSERT INTO revision_memberships')){this.data.revision_memberships.push({revision_id:args[0],member_id:args[1],role:args[2],position:args[3]});return rows();}
    if(q.startsWith('INSERT INTO memberships')){this.data.memberships.push({owner_id:args[0],member_id:args[1],role:args[2]});return rows();}
    if(q.startsWith('INSERT INTO dependencies')){this.data.dependencies.push({consumer_revision_id:args[0],dependency_revision_id:args[1],purpose:args[2]});return rows();}
    if(q.startsWith("UPDATE objects SET state='ARCHIVED'")){const o=this.data.objects.find(r=>r.id===args[0]);o.state='ARCHIVED';o.historical=true;o.version++;return rows();}
    if(q.startsWith('UPDATE objects SET title=')){const o=this.data.objects.find(r=>r.id===args[0]);Object.assign(o,{title:args[1],draft_revision_id:args[3],state:'DRAFT',version:o.version+1});return rows();}
    if(q.startsWith('INSERT INTO asset_media')||q.startsWith('INSERT INTO rights('))return rows();
    if(q.startsWith('INSERT INTO provenance')&&q.includes('retired-entity-configuration')){this.data.provenance.push({id:args[0],kind:'retired-entity-configuration',original_id:args[1],original_sha256:args[2],content:args[3]});return rows();}
    if(q.startsWith('INSERT INTO provenance')){this.data.provenance.push({id:args[0],object_id:args[1],revision_id:args[2],kind:'sound-ownership-migration',original_id:args[3],original_sha256:args[4],content:args[5]});return rows();}
    if(q === "SELECT 1 FROM objects WHERE id=ANY($1::text[]) AND kind='SOURCE' LIMIT 1")return rows(this.data.objects.filter(o=>args[0].includes(o.id)&&o.kind==='SOURCE').slice(0,1).map(()=>({exists:1})));
    if(q === "SELECT 1 FROM revisions WHERE object_id=$1 AND content->>'role'=$2 LIMIT 1")return rows(this.data.revisions.filter(r=>r.object_id===args[0]&&r.content.role===args[1]).slice(0,1).map(()=>({exists:1})));
    throw new Error('Unhandled SQL: '+q);
  }
}
const pending={reason:'UNKNOWN：缺少永久身份与来源修订',missingEvidence:['永久目标身份','对应来源修订'],todo:'按原始证据核对后再确认'};
function fixture(){const store=new Store(),source=store.add('sound:legacy','ENTITY',{type:'SOUND',description:'旧声音'}),state=store.add('state:voice','STATE',{},[{id:source.objectId,role:'ENTITY'}]),rep=store.add('rep:voice','REPRESENTATION',{},[{id:state.objectId,role:'STATE'}]),requirement=store.add('requirement:voice','REQUIREMENT',{mediaType:'AUDIO'},[{id:rep.objectId,role:'REPRESENTATION'}]),family=store.add('family:voice','MATERIAL',{},[{id:requirement.objectId,role:'REQUIREMENT'}]),target=store.add('scene:permanent','SCENE',{text:'合成测试'});store.add('frozen:consumer','INPUT_LOCK',{},[],true);store.data.dependencies.push({consumer_revision_id:'frozen:consumer:r1',dependency_revision_id:source.revisionId,purpose:'ACTUAL_INPUT'});return {store,source,target,resources:[state,rep,requirement,family]};}
async function request(f,{unknown=false,id='op:migrate'}={}){const inventory=await soundMigrationInventory(f.store,f.source.objectId);return {operationId:id,runtimeEpoch:'epoch',actor:{kind:'PROJECT_CODEX',label:'测试'},commands:[{type:'workspace.change',workspace:'sound-ownership',input:{action:'migrate',explicit:true,source:f.source,inventoryHash:inventory.inventoryHash,bindings:[{bindingId:'binding:voice',status:unknown?'UNKNOWN':'ASSIGNED',usage:'声音用途',resources:f.resources,...(unknown?{pending}:{target:f.target})}]}}]};}
const expectCode=code=>error=>error.code===code;

test('SOUND retirement covers defaults, current configuration, save validation and import normalization',async()=>{
  for(const domain of [defaultDomainConfiguration(),configurationDefaults.domain])assert(!domain.entityTypes.some(t=>t.id==='SOUND'));
  const saved={entityTypes:{entityTypes:[{id:'SOUND'},{id:'LOCATION'},{id:'CUSTOM'}],relationTypes:[]}},before=structuredClone(saved);
  const read=new PresentationRead({query:async()=>({rows:[{scope:'system',version:3,content:saved}]})});
  assert.deepEqual((await read.configuration()).domain.entityTypes.map(t=>t.id),['LOCATION','CUSTOM']);assert.deepEqual(read.systemConfiguration,currentSystemEntityTypes(saved));assert.deepEqual(saved,before);
  for(const type of ['SOUND',' sound '])assert.throws(()=>validate('ENTITY',{type,description:'x'}),expectCode('ENTITY_TYPE_RETIRED'));
  assert.throws(()=>validateConfiguration('system',saved),expectCode('ENTITY_TYPE_RETIRED'));assert.doesNotThrow(()=>validateConfiguration('system',saved,{historicalImport:true}));
  assert.doesNotThrow(()=>validateConfiguration('system',currentSystemEntityTypes(saved)));assert.deepEqual(saved,before);
});

test('native sounds require resources; UNKNOWN never implies a story target; source/role identities are immutable',()=>{
  const f=fixture(),native={role:'SOUND_OWNERSHIP',status:'ASSIGNED',usage:'事件声',target:f.target,resources:[f.resources[2]]};
  assert.doesNotThrow(()=>validateSoundOwnershipContent(native));assert.throws(()=>validateSoundOwnershipContent({...native,resources:[]}),expectCode('SOUND_RESOURCES'));
  const unknown={...native,status:'UNKNOWN',pending};delete unknown.target;assert.doesNotThrow(()=>validateSoundOwnershipContent(unknown));assert.throws(()=>validateSoundOwnershipContent({...unknown,target:f.target}),expectCode('SOUND_PENDING_TARGET'));
  assert.throws(()=>validateSoundOwnershipContent({...unknown,pending:{...pending,missingEvidence:[]}}),expectCode('SOUND_PENDING_EVIDENCE'));
  assert.throws(()=>validateSoundOwnershipContent({role:'OTHER'},unknown),expectCode('SOUND_BINDING_IDENTITY'));
  const legacy={...native,source:f.source};assert.throws(()=>validateSoundOwnershipContent({...legacy,source:{...f.source,revisionId:'other'}},legacy),expectCode('SOUND_BINDING_IDENTITY'));
  assert.deepEqual(soundOwnershipDependencies(native).map(d=>d.revisionId),[f.target.revisionId,f.resources[2].revisionId]);assert.equal(soundOwnershipLinks(native).length,2);
});

test('target identity validation accepts all five owner levels and a permanent LOCATION, rejects title-only and wrong SHA',async()=>{
  const f=fixture();for(const kind of ['SPACE','STORY','EPISODE','SCENE','SHOT']){const target=f.store.add('target:'+kind,kind,{});await validateSoundOwnershipTargets(f.store,{role:'SOUND_OWNERSHIP',status:'ASSIGNED',usage:'测试',resources:[f.resources[2]],target});}
  const location=f.store.add('location:permanent','ENTITY',{type:'LOCATION'}),content={role:'SOUND_OWNERSHIP',status:'ASSIGNED',usage:'空间声',resources:[f.resources[2]],target:{...location,kind:'SPACE'}};await validateSoundOwnershipTargets(f.store,content);
  await assert.rejects(validateSoundOwnershipTargets(f.store,{...content,target:{...content.target,sha256:'0'.repeat(64)}}),expectCode('SOUND_TARGET_CHANGED'));
  await assert.rejects(validateSoundOwnershipTargets(f.store,{...content,target:{...content.target,objectId:'old-scene-number'}}),expectCode('SOUND_TARGET_CHANGED'));
});

test('migration requires complete indirect resource coverage and a fresh metadata inventory',async()=>{
  const f=fixture(),req=await request(f),body=req.commands[0].input;assert.equal((await soundMigrationInventory(f.store,f.source.objectId)).resources.length,4);
  await assert.rejects(planSoundOwnershipMigration(f.store,{...body,bindings:[{...body.bindings[0],resources:f.resources.slice(0,1)}]}),expectCode('SOUND_REFERENCES_UNCOVERED'));
  await assert.rejects(planSoundOwnershipMigration(f.store,{...body,inventoryHash:'0'.repeat(64)}),expectCode('SOUND_INVENTORY_CHANGED'));
  assert.equal(f.store.notes().length,0);
});

for(const unknown of [false,true])test(`migration transaction preserves original revisions and frozen inputs (${unknown?'UNKNOWN':'ASSIGNED'}), replays exactly once`,async()=>{
  const f=fixture(),req=await request(f,{unknown}),before=structuredClone(f.store.data),result=await execute(f.store,req);
  assert.equal(result.status,'SUCCEEDED',JSON.stringify(result));assert.equal(result.workspace.sourceHistorical,true);assert.equal(f.store.row(f.source.objectId).version,2);
  assert.deepEqual(f.store.data.revisions.filter(r=>r.object_id!=='binding:voice'),before.revisions);assert.deepEqual(f.store.data.dependencies.filter(d=>before.revisions.some(r=>r.id===d.consumer_revision_id)),before.dependencies);
  assert.deepEqual(f.store.data.memberships.filter(m=>m.owner_id!=='binding:voice'),before.memberships);
  const note=f.store.notes()[0];assert.equal(note.content.source.revisionId,f.source.revisionId);assert.equal(Boolean(note.content.target),!unknown);assert.equal(f.store.data.provenance.length,1);
  const lockIds=f.store.calls.filter(c=>c.sql.includes('hashtextextended($1,1)')).map(c=>c.args[0]);for(const id of [f.source.objectId,...f.resources.map(r=>r.objectId),'frozen:consumer',...(unknown?[]:[f.target.objectId])])assert(lockIds.includes(id),id+' must be locked');
  const replay=await execute(f.store,req);assert.deepEqual(replay,result);assert.equal(f.store.notes().length,1);
  await assert.rejects(execute(f.store,{...req,actor:{kind:'HUMAN',label:'changed'}}),expectCode('OPERATION_ID_CONFLICT'));
});

test('late conflict rolls back every appended record, and raw retirement/assistant inference are rejected',async()=>{
  const f=fixture(),req=await request(f),before=structuredClone(f.store.data);
  f.store.inject=s=>s.data.objects.find(o=>o.id===f.target.objectId).version++;
  const result=await execute(f.store,req);assert.equal(result.status,'FAILED');assert.equal(result.error.code,'SOUND_TARGET_CHANGED');assert.equal(f.store.notes().length,0);assert.equal(f.store.row(f.source.objectId).historical,false);assert.deepEqual(f.store.data.revisions,before.revisions);
  const raw=await execute(f.store,{operationId:'raw',commands:[{type:'sound.retire',id:f.source.objectId,expectedVersion:1}]});assert.equal(raw.error.code,'EXPLICIT_SOUND_MIGRATION_REQUIRED');
  const other=fixture(),r=await request(other);r.actor={kind:'ASSISTANT',label:'AI'};const denied=await execute(other.store,r);assert.equal(denied.status,'FAILED');assert.equal(other.store.notes().length,0);
});

test('UNKNOWN can be resolved after source retirement, retaining old note revision and exact source',async()=>{
  const f=fixture(),first=await execute(f.store,await request(f,{unknown:true}));assert.equal(first.status,'SUCCEEDED');const old=f.store.notes()[0],content={...old.content,status:'ASSIGNED',source:{...old.content.source,expectedVersion:2},target:f.target};delete content.pending;
  const result=await execute(f.store,{operationId:'resolve',commands:[{type:'workspace.change',workspace:'sound-ownership',input:{action:'save',bindingId:old.id,expectedVersion:old.version,title:'确认归属',content}}]});assert.equal(result.status,'SUCCEEDED',JSON.stringify(result));assert.equal(f.store.data.revisions.filter(r=>r.object_id===old.id).length,2);assert.equal(f.store.row(old.id).content.source.revisionId,f.source.revisionId);
});

test('import validates pinned revisions despite later heads/counters and rejects missing dependency projection',async()=>{
  const f=fixture();await execute(f.store,await request(f));const note=f.store.notes()[0];f.store.data.objects.find(o=>o.id===f.target.objectId).version=8;
  await validateReferenceTargets(f.store,'NOTE',note.content,undefined,{historicalImport:true});await validateStoredSoundOwnership(f.store,note.revision_id,note.content);
  await assert.rejects(validateSoundOwnershipTargets(f.store,note.content),expectCode('SOUND_SOURCE_CHANGED'));
  f.store.data.dependencies=f.store.data.dependencies.filter(d=>d.dependency_revision_id!==f.target.revisionId);await assert.rejects(validateStoredSoundOwnership(f.store,note.revision_id,note.content),expectCode('SOUND_STORED_DEPENDENCIES'));
});

test('owner/resource/UNKNOWN search filters precede limit and expose exact references without changing frozen heads',async()=>{
  const f=fixture();await execute(f.store,await request(f));for(let i=0;i<5;i++)f.store.add('unrelated:'+i,'NOTE',{role:'SOUND_OWNERSHIP',status:'UNKNOWN',usage:'other',resources:[],source:f.source,pending});
  const bindings=await soundOwnershipBindings(f.store,{ownerId:f.target.objectId,limit:1,query:'用途'});assert.equal(bindings.length,1);assert.equal(bindings[0].exactReferences.source,true);assert.equal(bindings[0].target.revisionId,f.target.revisionId);
  const scope=soundResourceScope(bindings,f.resources[2].objectId);assert.deepEqual(scope.soundSceneIds,[f.target.objectId]);assert.equal(scope.soundOwnershipPending,false);
  assert.equal((await soundOwnershipBindings(f.store,{resourceIds:[f.resources[2].objectId]})).length,1);
  const query=f.store.calls.find(c=>c.sql.includes('LIMIT $7 OFFSET $8'));assert(query.sql.indexOf("'{target,objectId}'")<query.sql.indexOf('LIMIT'));
});

test('workspace routes expose inventory and owner-scoped sounds; catalog owner search follows sound resources',async()=>{
  const f=fixture(),inventory=await workspaceRead(f.store,['sound-ownership','inventory'],new URLSearchParams({sourceId:f.source.objectId}));assert.equal(inventory.resources.length,4);
  const statements=[],tx={query:async(sql,args)=>{statements.push({sql,args});return {rows:sql.includes('count(*) AS n')?[{n:0}]:[]};}};
  await catalog(tx,{kind:'REQUIREMENT',owner:f.target.objectId,query:'audio'});assert(statements.every(s=>s.sql.includes('SOUND_OWNERSHIP')));assert(statements[0].sql.includes("NOT(o.kind='ENTITY'"));assert(statements[0].args.includes(f.target.objectId));
});

function projectionUnit(f){const unit=new PresentationRead(f.store);unit.namespace=async()=> 'synthetic:epoch';unit.configuration=async()=>configurationDefaults;unit.configurationVersions={};unit.rows=async(kinds,{ids,roles,historical=false}={})=>f.store.data.objects.map(o=>f.store.row(o.id)).filter(r=>kinds.includes(r.kind)&&(historical||!r.historical)&&(!ids||ids.includes(r.id))&&(!roles||roles.includes(r.content.role))).map(r=>({...r,revisionId:r.revision_id,sha256:r.sha256,links:f.store.data.memberships.filter(m=>m.owner_id===r.id).map(m=>({id:m.member_id,role:m.role}))}));const query=f.store.query.bind(f.store);unit.tx={query:async(sql,args=[])=>{
  if(sql.includes('FROM objects o JOIN revisions r ON r.id=COALESCE')&&sql.includes("o.kind='NOTE'")&&sql.includes('LIMIT $7'))return query(sql,args);
  if(sql.includes('IN (SELECT * FROM unnest')||sql.startsWith('SELECT o.id,o.title,o.version,o.historical'))return query(sql,args);
  if(sql.includes("FROM objects WHERE id=$1"))return {rows:[]};
  return {rows:[]};
}};return unit;}

test('material/domain projections retain requirements after retiring SOUND and attach permanent scene ownership',async()=>{
  const f=fixture();await execute(f.store,await request(f));const unit=projectionUnit(f),requirements=await materialRows(unit),r=requirements.find(r=>r.id===f.resources[2].objectId);assert.deepEqual(r.sceneIds,[f.target.objectId]);assert.equal(r.soundOwnership[0].resources.find(x=>x.objectId===r.id).revisionId,r.revisionId);
  const media=await assets(unit);assert.deepEqual(media.assetFamilies[0].sceneIds,[f.target.objectId]);
  const domain=await domainWorkspace(unit);assert.equal(domain.graph.entities.length,0);assert.equal(domain.graph.requirements.length,1);assert.equal(domain.legacySoundSources[0].id,f.source.objectId);assert.equal(domain.soundOwnership.length,1);
});

test('current resource heads never inherit ownership pinned to an older revision',async()=>{
  const f=fixture();await execute(f.store,await request(f));const r=f.store.data.objects.find(o=>o.id===f.resources[2].objectId);f.store.data.revisions.push({...f.store.data.revisions.find(x=>x.id===r.draft_revision_id),id:'changed:requirement',sha256:hash('changed')});r.draft_revision_id='changed:requirement';r.version++;
  const bindings=await soundOwnershipBindings(f.store,{resourceIds:[r.id]}),scope=soundResourceScope(bindings,r.id);assert.equal(bindings[0].exactReferences.resources[r.id],true);assert.equal(bindings[0].currentReferences.resources[r.id],false);assert.deepEqual(scope.soundSceneIds,[]);assert.equal(scope.soundOwnershipStale,true);assert.equal(scope.soundOwnership[0].resources.find(x=>x.objectId===r.id).revisionId,f.resources[2].revisionId);
});

test('paginated UNKNOWN workspace exposes records beyond the first page without silent truncation',async()=>{
  const f=fixture();for(let i=0;i<3;i++)f.store.add('pending:'+i,'NOTE',{role:'SOUND_OWNERSHIP',status:'UNKNOWN',usage:'needs evidence',resources:[],source:f.source,pending});
  const {soundOwnershipWorkspace}=await import('../server/settings/sound-ownership.mjs');const unit=new PresentationRead(f.store);unit.namespace=async()=> 'synthetic';
  const first=await soundOwnershipWorkspace(unit,{status:'UNKNOWN',limit:2});assert.equal(first.bindings.length,2);assert.equal(first.hasMore,true);assert.equal(first.nextOffset,2);
  const last=await soundOwnershipWorkspace(unit,{status:'UNKNOWN',limit:2,offset:first.nextOffset});assert.equal(last.bindings.length,1);assert.equal(last.hasMore,false);assert.equal(new Set([...first.bindings,...last.bindings].map(b=>b.id)).size,3);
});

test('import persists a retired configuration and retains its original content and hash as provenance',async()=>{
  const {retireImportedEntityConfiguration}=await import('../server/project/service.mjs');const legacy={scope:'system',version:8,content:{entityTypes:{entityTypes:[{id:'SOUND'},{id:'LOCATION'}]}}},before=structuredClone(legacy),calls=[];
  assert.equal(await retireImportedEntityConfiguration({query:async(sql,args)=>{calls.push({sql,args});return {rows:[]};}},legacy),true);
  assert.equal(calls.length,2);assert.deepEqual(calls[0].args[3],before);assert.equal(calls[0].args[2],hash(before.content));assert.deepEqual(calls[1].args[0].entityTypes.entityTypes,[{id:'LOCATION'}]);assert(calls[1].sql.includes('version=version+1'));assert.deepEqual(legacy,before);
});

test('orphan legacy sounds can be explicitly UNKNOWN and new sounds save without a legacy entity',async()=>{
  const store=new Store(),source=store.add('orphan','ENTITY',{type:'SOUND',description:'orphan'}),f={store,source,resources:[]};const result=await execute(store,await request(f,{unknown:true}));assert.equal(result.status,'SUCCEEDED',JSON.stringify(result));assert.equal(store.notes()[0].content.resources.length,0);
  const fresh=fixture(),content={role:'SOUND_OWNERSHIP',status:'ASSIGNED',usage:'new sound',resources:[fresh.resources[2]],target:fresh.target};const saved=await execute(fresh.store,{operationId:'native',commands:[{type:'workspace.change',workspace:'sound-ownership',input:{action:'save',bindingId:'native:sound',expectedVersion:0,title:'新声音',content}}]});assert.equal(saved.status,'SUCCEEDED',JSON.stringify(saved));assert.equal(fresh.store.row('native:sound').content.source,undefined);assert.equal(fresh.store.row(fresh.source.objectId).historical,false);
});

test('duplicate binding IDs and stale resource revisions fail without retiring source or losing candidates',async()=>{
  const f=fixture(),req=await request(f);f.store.add('binding:voice','NOTE',{role:'OTHER'});const before=structuredClone(f.store.data);const result=await execute(f.store,req);assert.equal(result.status,'FAILED');assert.equal(result.error.code,'VERSION_CONFLICT');assert.deepEqual(f.store.data.revisions,before.revisions);assert.equal(f.store.row(f.source.objectId).historical,false);
  const other=fixture(),r=await request(other);r.commands[0].input.bindings[0].resources=other.resources.map((ref,i)=>i===0?{...ref,sha256:'0'.repeat(64)}:ref);const failed=await execute(other.store,r);assert.equal(failed.status,'FAILED');assert.equal(failed.error.code,'SOUND_RESOURCE_CHANGED');assert.equal(other.store.notes().length,0);
});

test('persistent retirement uses configuration CAS, preserves unrelated settings, and rejects stale attempts',async()=>{
  const {presentConfiguration}=await import('../server/project/service.mjs');const f=fixture();f.store.data.configurations=[{scope:'system',version:4,content:{entityTypes:{entityTypes:[{id:'SOUND'},{id:'LOCATION'}],relationTypes:[{id:'RELATED'}]},assistant:{enabled:false}}}];const before=structuredClone(f.store.data.configurations[0]);
  const presented=presentConfiguration(before);assert.deepEqual(presented.retiredEntityTypes,['SOUND']);assert.deepEqual(presented.content.entityTypes.entityTypes,[{id:'LOCATION'}]);assert.equal(presented.storedContentHash,hash(before.content));
  const req={operationId:'config-retire',commands:[{type:'workspace.change',workspace:'sound-ownership',input:{action:'retire-configuration',expectedVersion:4}}]};const result=await execute(f.store,req);assert.equal(result.status,'SUCCEEDED',JSON.stringify(result));assert.equal(f.store.data.configurations[0].version,5);assert.deepEqual(f.store.data.configurations[0].content.assistant,before.content.assistant);assert.deepEqual(f.store.data.provenance[0].content,before);
  const rejected=await execute(f.store,{...req,operationId:'config-stale'});assert.equal(rejected.error.code,'VERSION_CONFLICT');assert.equal(f.store.data.configurations[0].version,5);
});

test('retirement preserves candidate metadata, media SHA, review history and original immutable relations',async()=>{
  const f=fixture();f.store.data.asset_versions=[{object_id:'asset:candidate',family_id:f.resources[3].objectId,parent_asset_id:'asset:original'}];f.store.data.asset_media=[{revision_id:'asset:candidate:r1',media_id:'media:audio',media_version_id:'media:v3',sha256:'a'.repeat(64),role:'OUTPUT'}];f.store.data.reviews=[{id:'review:original',object_id:'asset:candidate',revision_id:'asset:candidate:r1',decision:'ADOPT'}];
  const before=structuredClone(f.store.data),result=await execute(f.store,await request(f));assert.equal(result.status,'SUCCEEDED');for(const key of ['asset_versions','asset_media','reviews'])assert.deepEqual(f.store.data[key],before[key]);assert.deepEqual(f.store.data.revision_memberships.filter(r=>before.revisions.some(old=>old.id===r.revision_id)),before.revision_memberships);
  const legacyWrite=await execute(f.store,{operationId:'legacy-rewrite',commands:[{type:'save',id:f.source.objectId,expectedVersion:2,title:'overwrite',content:{type:'LOCATION',description:'changed'}}]});assert.equal(legacyWrite.error.code,'HISTORICAL_READ_ONLY');assert.equal(f.store.row(f.source.objectId).content.type,'SOUND');
});

test('sound workspace GET filters owner with a full PresentationRead and binds note revisions into its read basis',async()=>{
  const f=fixture();await execute(f.store,await request(f));const base=f.store.query.bind(f.store),tx={query:async(sql,args=[])=>{
    if(sql.includes('SELECT instance_id AS "instanceId",runtime_epoch'))return {rows:[{instanceId:'synthetic',runtimeEpoch:'epoch',title:'Fixture'}]};
    if(sql==='SELECT scope,version,content FROM configurations ORDER BY scope')return {rows:[]};
    if(sql.includes('o.kind=ANY($1::text[])')&&args[0]?.[0]==='STORY')return {rows:[]};
    return base(sql,args);
  }};
  const result=await workspaceRead(tx,['sound-ownership'],new URLSearchParams({ownerId:f.target.objectId}));assert.equal(result.bindings.length,1);assert.equal(result.bindings[0].target.objectId,f.target.objectId);assert(result._basis.some(r=>r.objectId==='binding:voice'));
});
