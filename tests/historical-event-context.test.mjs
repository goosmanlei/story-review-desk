import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync,symlinkSync,unlinkSync,linkSync,chmodSync} from 'node:fs';
import path from 'node:path';
import {captureHistoricalEventContexts,verifyHistoricalEventContexts,historicalEventContextReader,historicalEventContextsHash} from '../host/instance-historical-event-context.mjs';
import {canonicalJson,sha256,selectPublishedReleaseAt} from '../host/instance-runtime/index.mjs';
import {exerciseEpisodeScope} from './episode-scope-progress.test.mjs';
import {validateModernEventClosure,digest,frozenEventManifest} from '../host/instance-modern-event-validator.mjs';
import {runtime} from './modern-event-validator.test.mjs';

const hash=value=>sha256(Buffer.from(canonicalJson(value)));
const record=(id,value)=>{const bytes=Buffer.from(' '+JSON.stringify(value)+'\n');return {revisionId:id,bytes,sha256:sha256(bytes),deleted:false};};
function fixture(){
  const instanceId='instance:historical-test',profile={instanceId,episodePlanId:'plan:test',title:'隔离历史测试'};
  const graph={schemaVersion:'1.0',entities:[{id:'entity:letter'}],states:[],representations:[],relations:[],requirements:[]};
  const records=new Map([['profile',record('profile',profile)],['graph',record('graph',graph)],['directory',record('directory',{schemaVersion:'1.0',bindings:[]})],['script',{...record('script',{text:'信件'}),documentId:'script-document'}],['old-source',{...record('old-source',{text:'旧引文'}),documentId:'old-source-document'}]]);
  const snapshot={snapshotId:'snapshot:historical',instance:profile,productionModel:{instance:profile,domainGraph:graph,domainGraphRef:{revisionId:'graph',sha256:records.get('graph').sha256},materialDirectory:{revisionId:'directory',sourceSha256:records.get('directory').sha256},materialRequirements:[{id:'req:letter',requirementHash:hash('before'),evidence:[{sourceId:'source:old',revisionId:'old-source',sha256:records.get('old-source').sha256}]}]}};
  const snapshotBytes=Buffer.from(' '+JSON.stringify(snapshot)+'\n'),recipesBytes=Buffer.from(' '+JSON.stringify({snapshotId:snapshot.snapshotId,executionDefinitions:[]})+'\n');
  const release={releaseId:'release:historical',snapshotId:snapshot.snapshotId,snapshotBytes,snapshotSha256:sha256(snapshotBytes),recipesBytes,recipesSha256:sha256(recipesBytes),sourceRevisionIds:['script'],profileRevisionId:'profile',createdAt:'2026-01-01T00:00:01.000Z'};
  const event={eventId:'event:shot',eventKind:'creative-revision',eventSequence:4,recordedAt:'2026-01-01T00:00:02.000Z',snapshotId:snapshot.snapshotId,creationSnapshotId:snapshot.snapshotId,subjectKind:'SHOT_PLAN_SET',scopedReviewSpec:{schemaVersion:'2.0'},materialRequirementSet:{contentHash:hash('frozen is never authority')}};
  const calls=[];
  const tx={getMetadata:async()=>({instanceId}),readPublishedReleaseAt:async input=>{calls.push(input);return release;},readRelease:async id=>id===release.releaseId?release:null,getRecord:async(_namespace,_key,id)=>records.get(id),readDocumentRevision:async id=>records.get(id),getAux:async(_namespace,_key,{revisionId})=>records.get(revisionId)};
  return {instanceId,profile,graph,snapshot,release,event,events:[event],records,tx,calls};
}
const capture=f=>captureHistoricalEventContexts(f.tx,{events:f.events,instanceId:f.instanceId});
const verify=f=>verifyHistoricalEventContexts(f.tx,{events:f.events,instanceId:f.instanceId});
const reader=(f,bundle)=>historicalEventContextReader(bundle,{events:f.events,expectedHash:bundle.contextsHash,instanceId:f.instanceId});
function rehash(bundle){bundle.contextsHash=historicalEventContextsHash(bundle);return bundle;}
function descriptor(overrides={}){return {release_id:'release:one',snapshot_id:'snapshot:one',snapshot_sha256:hash('snapshot'),recipes_sha256:hash('recipes'),profile_revision_id:'profile',source_revision_ids_json:'["source"]',created_at:'2026-01-01T00:00:01.000Z',...overrides};}
const cutoff={recordedBefore:'2026-01-01T00:00:02.000Z',snapshotId:'snapshot:one'};
test('latest publication selector allows byte-identical ties and never selects an older matching snapshot',()=>{
  const a=descriptor();assert.equal(selectPublishedReleaseAt([a,descriptor({release_id:'release:two'})],cutoff),a.release_id);
  assert.throws(()=>selectPublishedReleaseAt([descriptor({snapshot_id:'snapshot:newer'})],cutoff),/not the latest/);
});
for(const [name,mutate] of Object.entries({
  'same time different snapshot bytes':r=>r.snapshot_sha256=hash('other'),
  'same time different recipe bytes':r=>r.recipes_sha256=hash('other'),
  'same time different source closure':r=>r.source_revision_ids_json='["other"]',
  'same time different profile':r=>r.profile_revision_id='other',
}))test(name+' fails closed',()=>{const changed=descriptor({release_id:'release:two'});mutate(changed);assert.throws(()=>selectPublishedReleaseAt([descriptor(),changed],cutoff),/Simultaneous/);});
test('same millisecond cannot be guessed into a strict predecessor',()=>assert.throws(()=>selectPublishedReleaseAt([descriptor({created_at:cutoff.recordedBefore})],cutoff),/timestamp/));
test('missing and oversized historical descriptor lists fail closed',()=>{assert.throws(()=>selectPublishedReleaseAt([],cutoff));assert.throws(()=>selectPublishedReleaseAt(Array(201).fill(descriptor()),cutoff));});
test('capture reads exact old sources and AUX, preserves original noncanonical bytes and deduplicates releases',async()=>{
  const f=fixture();f.events.push({...f.event,eventId:'event:second',eventSequence:5});const before=canonicalJson(f.snapshot),bundle=await capture(f);
  assert.equal(bundle.contexts.length,2);assert.equal(bundle.releases.length,1);assert.equal(bundle.releases[0].snapshotBytes.byteSize,f.release.snapshotBytes.length);
  assert.deepEqual(bundle.releases[0].sourceProof.map(p=>p.revisionId),['old-source','script']);assert.equal(bundle.releases[0].auxProof.length,2);
  assert.equal(reader(f,bundle)(f.event).productionModel.materialRequirements[0].requirementHash,hash('before'));
  assert.equal(canonicalJson(f.snapshot),before);assert.deepEqual(f.calls[0],{recordedBefore:f.event.recordedAt,snapshotId:f.event.creationSnapshotId});
});
test('candidate frozen requirement values never reconstruct the old source state',async()=>{
  const f=fixture();f.event.materialRequirementSet={contentHash:hash('invented future')};const bundle=await capture(f);
  assert.equal(reader(f,bundle)(f.event).productionModel.materialRequirements[0].requirementHash,hash('before'));
});
test('verification-only reads the complete closure without returning a transport envelope',async()=>{
 const f=fixture(),reads=[],read=f.tx.readDocumentRevision;
 f.tx.readDocumentRevision=async id=>{reads.push(id);return read(id);};
 assert.equal(await verify(f),undefined);assert.deepEqual(reads,['old-source','script']);
});
for(const [name,mutate] of Object.entries({
  'missing published document':f=>f.records.delete('script'),
  'missing historical evidence document':f=>f.records.delete('old-source'),
  'wrong published source bytes':f=>f.records.get('script').bytes=Buffer.from('changed'),
  'wrong fixed evidence SHA':f=>f.records.get('old-source').sha256=hash('changed'),
  'missing original profile':f=>f.records.delete('profile'),
  'foreign original profile':f=>f.records.set('profile',record('profile',{...f.profile,instanceId:'foreign'})),
  'wrong original snapshot bytes':f=>f.release.snapshotBytes=Buffer.from('{}'),
  'wrong original recipes bytes':f=>f.release.recipesBytes=Buffer.from('{}'),
  'missing fixed graph AUX':f=>f.records.delete('graph'),
  'wrong directory AUX bytes':f=>f.records.get('directory').bytes=Buffer.from('{}'),
  'future publication':f=>f.release.createdAt='2026-01-01T00:00:03.000Z',
  'missing creation snapshot':f=>delete f.event.creationSnapshotId,
}))test(name+' rejects capture and verification-only reads',async()=>{const f=fixture();mutate(f);await assert.rejects(capture(f));await assert.rejects(verify(f));});
test('a self-consistent graph replacement still cannot contradict the raw published graph',async()=>{
  const f=fixture(),changed=record('graph',{...f.graph,entities:[]});f.records.set('graph',changed);f.snapshot.productionModel.domainGraphRef.sha256=changed.sha256;
  f.release.snapshotBytes=Buffer.from(canonicalJson(f.snapshot));f.release.snapshotSha256=sha256(f.release.snapshotBytes);
  await assert.rejects(capture(f),/domain graph differs/);
});
for(const [name,mutate] of Object.entries({
  'changed source event':(f)=>f.event.materialRequirementSet.contentHash=hash('other'),
  'omitted context':(_f,b)=>b.contexts=[],
  'duplicate context':(_f,b)=>b.contexts.push(b.contexts[0]),
  'foreign context':(_f,b)=>b.instanceId='foreign',
  'missing source proof':(_f,b)=>b.releases[0].sourceProof=[],
  'unbound release':(_f,b)=>b.releases.push({...b.releases[0],release:{...b.releases[0].release,releaseId:'other'}}),
  'replaced compressed snapshot':(_f,b)=>b.releases[0].snapshotBytes.data=gzipSync(Buffer.from('{}')).toString('base64'),
  'replaced compressed recipe':(_f,b)=>b.releases[0].recipesBytes.data=gzipSync(Buffer.from('{}')).toString('base64'),
}))test(name+' rejects the child boundary even with a recalculated envelope hash',async()=>{const f=fixture(),bundle=await capture(f);mutate(f,bundle);rehash(bundle);assert.throws(()=>reader(f,bundle)(f.event));});
test('SCOPED result uses exact resultReleaseId/source/SHA and permits its documented same-millisecond transaction',async()=>{
  const f=fixture();f.events=[{eventId:'op',eventKind:'source-operation',eventSequence:9,protocol:'SCOPED_SCENE_DATABASE_COMPILER_V1',recordedAt:f.release.createdAt,resultReleaseId:f.release.releaseId,snapshotId:f.release.snapshotId,newSnapshotId:f.release.snapshotId,transactionProof:{snapshotSha256:f.release.snapshotSha256,sourceRevisionId:'script',sourceSha256:f.records.get('script').sha256}}];
  const bundle=await capture(f);assert.equal(bundle.contexts[0].role,'SOURCE_RESULT');assert.equal(reader(f,bundle)(f.events[0]).snapshotId,f.release.snapshotId);
  f.events[0].transactionProof.snapshotSha256=hash('foreign');await assert.rejects(capture(f),/result release differs/);
});
test('scoped events cannot fall back to the current snapshot when history is absent',()=>{
  const f=fixture();assert.throws(()=>historicalEventContextReader(null,{events:f.events,instanceId:f.instanceId}),/independently captured/);
});
async function privateFiles(run){
  const f=fixture(),bundle=await capture(f),parent=path.resolve('tests/.test-tmp');mkdirSync(parent,{recursive:true});
  const directory=realpathSync(mkdtempSync(path.join(parent,'historical-transport-')));chmodSync(directory,0o700);
  try{
    for(const row of bundle.releases)for(const key of ['snapshotBytes','recipesBytes']){const payload=row[key];payload.file=payload.compressedSha256+'.gz';writeFileSync(path.join(directory,payload.file),Buffer.from(payload.data,'base64'),{mode:0o600,flag:'wx'});delete payload.data;}
    await run({f,bundle,directory,read:()=>historicalEventContextReader(bundle,{events:f.events,expectedHash:bundle.contextsHash,instanceId:f.instanceId,directory})(f.event)});
  }finally{rmSync(directory,{recursive:true,force:true});}
}
test('host-private release files preserve the same capture hash without historical payloads on stdin',()=>privateFiles(({f,bundle,read})=>{
  assert.equal(historicalEventContextsHash(bundle),bundle.contextsHash);
  assert.equal(read().productionModel.materialRequirements[0].requirementHash,f.snapshot.productionModel.materialRequirements[0].requirementHash);
  assert.equal(JSON.stringify(bundle).includes('"data":'),false);
}));
for(const [name,mutate] of Object.entries({
  'public directory':({directory})=>chmodSync(directory,0o755),
  'public file':({directory,bundle})=>chmodSync(path.join(directory,bundle.releases[0].snapshotBytes.file),0o644),
  'file traversal':({bundle})=>bundle.releases[0].snapshotBytes.file='../outside.gz',
  'symlink file':({directory,bundle})=>{const name=path.join(directory,bundle.releases[0].snapshotBytes.file),target=path.join(directory,'other');writeFileSync(target,'{}',{mode:0o600});unlinkSync(name);symlinkSync(target,name);},
  'hardlink file':({directory,bundle})=>linkSync(path.join(directory,bundle.releases[0].snapshotBytes.file),path.join(directory,'other')),
  'different compressed bytes':({directory,bundle})=>writeFileSync(path.join(directory,bundle.releases[0].snapshotBytes.file),'{}'),
  'both file and embedded bytes':({bundle})=>bundle.releases[0].snapshotBytes.data='e30=',
}))test(name+' cannot enter the historical child from a recalculated transport envelope',()=>privateFiles(value=>{mutate(value);rehash(value.bundle);assert.throws(value.read);}));
test('stdin cannot nominate its own file directory',()=>privateFiles(({f,bundle})=>assert.throws(()=>reader(f,bundle)(f.event),/host-owned exact directory/)));
test('real SQLite V2 candidate remains valid as historical fact after a later implementation family publication; its current gate stays stale',async()=>{
  await exerciseEpisodeScope('2.0',{afterSync:async({repo,view,shot,api,compiler})=>{
    const before=await repo.readRelease(),snapshot=structuredClone(view.snapshot);
    snapshot.productionModel.materialRequirements[0].requirementHash=hash('family allocated after authoring');
    snapshot.productionModel.materialRequirements[0].assetFamilyRefs.push('asset:late-allocation');
    // This real neutral publication deliberately retains snapshotId, exactly the
    // repository contract that makes snapshotId-only historical lookup unsafe.
    await repo.writeTransaction(tx=>tx.publishRelease({snapshot,recipes:JSON.parse(before.recipesBytes),expectedReleaseId:view.releaseId,sourceRevisionIds:before.sourceRevisionIds}));
    const current=await repo.readView(),events=Object.values(current.eventsByKind).flat(),state=compiler.stateFor(current);
    assert.throws(()=>api.assertCreativeRevisionBasisCurrent(current.snapshot,state,shot,{requireCurrentPredecessor:false}));
    const originalEvents=canonicalJson(events),history=await repo.readTransaction(tx=>captureHistoricalEventContexts(tx,{events,instanceId:current.instanceId}));
    const input={events,snapshot:current.snapshot,historicalContexts:history,binding:{releaseId:current.releaseId,snapshotId:current.snapshot.snapshotId,snapshotSha256:digest(JSON.stringify(current.snapshot)),snapshotCanonicalSha256:digest(current.snapshot),eventManifest:frozenEventManifest(events),historicalContextsHash:history.contextsHash}};
    const result=validateModernEventClosure(input,runtime);assert.equal(result.eventsOmitted,0);assert.equal(canonicalJson(events),originalEvents);
    assert.throws(()=>api.assertCreativeRevisionBasisCurrent(current.snapshot,compiler.stateFor(current),shot,{requireCurrentPredecessor:false}));
    const context=history.contexts.find(c=>c.eventId===shot.eventId);assert.notEqual(context.releaseId,current.releaseId);
    const selected=historicalEventContextReader(history,{events,expectedHash:history.contextsHash,instanceId:current.instanceId})(shot);
    assert.deepEqual(api.deriveCurrentMaterialRequirementSet(selected,shot.scopeId,'2.0'),shot.materialRequirementSet);
    const eventsByKind={};for(const event of events.filter(e=>e.eventSequence<shot.eventSequence))(eventsByKind[event.eventKind]||=[]).push(event);
    const historicalState=compiler.stateFor({snapshot:selected,eventsByKind});
    const forged={...shot,materialRequirementSet:api.deriveCurrentMaterialRequirementSet(current.snapshot,shot.scopeId,'2.0')};
    assert.throws(()=>api.assertCreativeRevisionBasisCurrent(selected,historicalState,forged,{requireCurrentPredecessor:true}),/material basis changed/,'copying today\'s self-consistent frozen demand into an old event is not historical evidence');
    assert.equal((await repo.readRelease(before.releaseId)).snapshotSha256,before.snapshotSha256);
  }});
});
