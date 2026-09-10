import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {assetContextPureFixture} from './fixtures/asset-context-revalidation-pure.mjs';
import {createInstanceRepository,importRepositoryState,restoreInstanceRepository} from '../host/instance-runtime/index.mjs';
import {canonicalJson,sha256} from '../host/instance-runtime/bytes.mjs';
import {contextHash,assetContextEventPayload,assetContextCurrentBasis,assetContextEventManifest} from '../host/instance-runtime/asset-context-revalidation-model.mjs';
import {validateArchive,createArchiveStreamValidator} from '../host/instance-runtime/postgres.mjs';
import {writeArchiveFile} from '../host/instance-runtime/archive-file.mjs';
import {openArchiveRowsWithBinding,validateArchiveRows} from '../host/instance-runtime/archive-stream-validation.mjs';
import {captureHistoricalEventContexts} from '../host/instance-historical-event-context.mjs';
import {validateModernEventsInChild} from '../host/instance-modern-event-bridge.mjs';
import {exportHostedInstance,verifyHostedExport} from '../scripts/instance-hosted-export.mjs';
async function fixture(t,{sameMillisecond=false,eventDomains=false}={}){
 const f=assetContextPureFixture(),parent=path.resolve('tests/.test-tmp');await mkdir(parent,{recursive:true});const directory=await mkdtemp(path.join(parent,'context-compat-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const repo=createInstanceRepository({dbPath:path.join(directory,'instance.sqlite'),instanceId:f.profile.instanceId,profile:f.profile});t.after(()=>repo.close());
 await repo.writeTransaction(async tx=>{
  const producer=await tx.putDocument({documentId:'fixture:producer',aliases:f.producer.aliases,bytes:f.producer.bytes,metadata:f.producer.metadata,expectedRevisionId:null});
  const snapshot=structuredClone(f.baseSnapshot),graph=await tx.putAux({namespace:'domain-graph',key:'current',bytes:canonicalJson(snapshot.productionModel.domainGraph),expectedRevisionId:null});snapshot.productionModel.domainGraphRef={revisionId:graph.revisionId,sha256:graph.sha256};
  f.baseSnapshot=snapshot;f.producer=producer;
  const view=await tx.publishRelease({snapshot,recipes:f.recipes,expectedReleaseId:null,sourceRevisionIds:[producer.revisionId]});f.release=await tx.readRelease(view.releaseId);
 });
 if(eventDomains)await repo.writeTransaction(async tx=>{
  const {event}=await tx.appendEvent({kind:'fixture-history',idempotencyKey:'formal:before',requestHash:contextHash('formal:before'),payload:{note:'Frozen formal history'}});f.priorEvent=event;
  await tx.appendEvent({kind:'fixture-trial',authorityDomain:'LOCAL_TRIAL',idempotencyKey:'trial:before',requestHash:contextHash('trial:before'),payload:{note:'Independent local sequence'}});
 });
 await new Promise(resolve=>setTimeout(resolve,3)); // Ensure this test's actual base publication strictly predates its event.
 const NativeDate=Date,fixedTime=Date.now();if(sameMillisecond)globalThis.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[fixedTime]));}static now(){return fixedTime;}};
 try{await repo.writeTransaction(async tx=>{
  const view=await tx.readView(),body=structuredClone(f.body);body.baseReleaseId=f.release.releaseId;Object.assign(body.basis.legacyAdoptionProof,{releaseId:f.release.releaseId,snapshotId:f.release.snapshotId,snapshotSha256:f.release.snapshotSha256,recipesSha256:f.release.recipesSha256,profileRevisionId:f.release.profileRevisionId,producerSource:{sourceRef:f.producer.aliases[0],sourceRevisionId:f.producer.revisionId,sourceSha256:f.producer.sha256}});body.basis.current=assetContextCurrentBasis(view.snapshot.productionModel,f.target);
  body.basis.consumerProof.eventSetHash=contextHash(assetContextEventManifest(await tx.listEvents()));const {id:previousId,...currentBody}=body;assert.ok(previousId);body.id='ACTX-REV-'+contextHash(currentBody).slice(0,32);
  const sourceRef='story/asset-context-revalidations/'+body.id+'.json',doc=await tx.putDocument({documentId:'fixture:context',aliases:[sourceRef],bytes:' '+JSON.stringify(body,null,2)+'\n',metadata:{sourceRole:'ASSET_CONTEXT_REVALIDATION'},expectedRevisionId:null}),source={sourceRef,sourceRevisionId:doc.revisionId,sourceSha256:doc.sha256};
  const {event}=await tx.appendEvent({kind:'asset-context-revalidation',idempotencyKey:'context:fixture',requestHash:contextHash('fixture-request'),payload:assetContextEventPayload(body,source),eventSchemaVersion:'1.0'}),ref={id:body.id,revalidationId:body.revalidationId,eventId:event.eventId,...source};
  const snapshot=structuredClone(view.snapshot);snapshot.snapshotId='snapshot:context-current';snapshot.productionModel.assetContextRevalidationLedger=[ref];await tx.publishRelease({snapshot,recipes:{...view.recipes,snapshotId:snapshot.snapshotId},expectedReleaseId:view.releaseId,sourceRevisionIds:[...view.sourceRevisionIds,doc.revisionId]});f.event=event;f.doc=doc;
 });}finally{globalThis.Date=NativeDate;}
 if(eventDomains)await repo.writeTransaction(async tx=>{
  await tx.importEvent({authorityDomain:'LOCAL_TRIAL',bytes:JSON.stringify({eventId:'trial:legacy-after',eventType:'fixture-trial',createdAt:new Date().toISOString(),note:'Legacy trial without a formal sequence'})});
 });
 return {...f,repo,directory};
}
test('actual SQLite -> streamed archive -> fresh import and raw restore preserve separate formal and local trial histories',async t=>{
 const f=await fixture(t,{eventDomains:true}),archive=await f.repo.exportState();validateArchive(archive,f.profile.instanceId);
 assert.deepEqual(archive.tables.domain_events.map(r=>r.authority_domain),['FORMAL','LOCAL_TRIAL','FORMAL','LOCAL_TRIAL']);
 const filename=path.join(f.directory,'archive.jsonl'),binding=await writeArchiveFile(filename,archive),reader=await openArchiveRowsWithBinding(filename,binding);try{const result=await validateArchiveRows(reader,{instanceId:f.profile.instanceId,createValidator:createArchiveStreamValidator});assert.equal(result.exportSha256,archive.exportSha256);}finally{await reader.close();}
 const imported=importRepositoryState({dbPath:path.join(f.directory,'import.sqlite'),instanceId:f.profile.instanceId,archive});try{const after=await imported.exportState();for(const table of ['record_revisions','domain_events','releases'])assert.deepEqual(after.tables[table],archive.tables[table]);}finally{imported.close();}
 const backup=await f.repo.backupTo(path.join(f.directory,'backup.sqlite')),restored=await restoreInstanceRepository({dbPath:path.join(f.directory,'restored.sqlite'),backupPath:backup.path,expectedSha256:backup.sha256,instanceId:f.profile.instanceId});try{assert.deepEqual((await restored.readView()).eventsByKind['asset-context-revalidation'],[f.event]);assert.deepEqual((await restored.exportState()).tables.domain_events,archive.tables.domain_events);}finally{await restored.close();}
});
for(const fault of ['changed formal bytes','formal event moved to trial','trial event moved to formal','changed trial bytes without hash'])test('mixed-domain archive still rejects '+fault,async t=>{
 const f=await fixture(t,{eventDomains:true}),archive=structuredClone(await f.repo.exportState());
 const formal=archive.tables.domain_events.find(r=>r.event_id===f.priorEvent.eventId),trial=archive.tables.domain_events.find(r=>r.authority_domain==='LOCAL_TRIAL');
 if(fault==='formal event moved to trial')formal.authority_domain='LOCAL_TRIAL';
 else if(fault==='trial event moved to formal')trial.authority_domain='FORMAL';
 else {const row=fault==='changed formal bytes'?formal:trial,event=JSON.parse(Buffer.from(row.event_bytes.bytes,'base64'));event.note='Changed after the frozen proof';const bytes=Buffer.from(canonicalJson(event));row.event_bytes={encoding:'base64',bytes:bytes.toString('base64')};if(fault==='changed formal bytes')row.event_sha256=sha256(bytes);}
 const {exportSha256:previous,...body}=archive;assert.ok(previous);archive.exportSha256=sha256(canonicalJson(body));assert.throws(()=>validateArchive(archive,f.profile.instanceId),fault==='changed trial bytes without hash'?/Event bytes mismatch/:/复核之前归档事件闭包不符/);
 const filename=path.join(f.directory,'invalid.jsonl'),binding=await writeArchiveFile(filename,archive),reader=await openArchiveRowsWithBinding(filename,binding);try{await assert.rejects(validateArchiveRows(reader,{instanceId:f.profile.instanceId,createValidator:createArchiveStreamValidator}));}finally{await reader.close();}
});
for(const kind of ['wrong historical instance','missing producer','missing ledger','unknown event schema'])test('rehash archive still rejects '+kind,async t=>{
 const f=await fixture(t),archive=structuredClone(await f.repo.exportState());
 if(kind==='wrong historical instance'){const row=archive.tables.releases.find(r=>r.release_id===f.release.releaseId),snapshot=JSON.parse(Buffer.from(row.snapshot_bytes.bytes,'base64'));snapshot.instance.instanceId='instance:other';const bytes=Buffer.from(canonicalJson(snapshot));row.snapshot_bytes={encoding:'base64',bytes:bytes.toString('base64')};row.snapshot_sha256=sha256(bytes);}
 if(kind==='missing producer')archive.tables.record_revisions=archive.tables.record_revisions.filter(r=>r.revision_id!==f.producer.revisionId);
 if(kind==='missing ledger'){const row=archive.tables.releases.find(r=>r.release_id!==f.release.releaseId),snapshot=JSON.parse(Buffer.from(row.snapshot_bytes.bytes,'base64'));delete snapshot.productionModel.assetContextRevalidationLedger;const bytes=Buffer.from(canonicalJson(snapshot));row.snapshot_bytes={encoding:'base64',bytes:bytes.toString('base64')};row.snapshot_sha256=sha256(bytes);}
 if(kind==='unknown event schema'){const row=archive.tables.domain_events[0],event=JSON.parse(Buffer.from(row.event_bytes.bytes,'base64'));event.schemaVersion='9';const bytes=Buffer.from(canonicalJson(event));row.event_bytes={encoding:'base64',bytes:bytes.toString('base64')};row.event_sha256=sha256(bytes);}
 const {exportSha256:previous,...body}=archive;assert.ok(previous);archive.exportSha256=sha256(canonicalJson(body));assert.throws(()=>validateArchive(archive,f.profile.instanceId));
});
test('actual child validator consumes independently captured historical release and original source; current eligibility is not rewritten',async t=>{
 const f=await fixture(t),before=await f.repo.exportState();const proof=await f.repo.readTransaction(async tx=>{const events=await tx.listEvents(),view=await tx.readView(),documents=[];for(const id of view.sourceRevisionIds)documents.push(await tx.readDocumentRevision(id));const historicalContexts=await captureHistoricalEventContexts(tx,{events,instanceId:f.profile.instanceId});return validateModernEventsInChild({events,documents,historicalContexts,baseRelease:await tx.readRelease(view.releaseId),eventDirectory:'events'});});assert.equal(proof.proof.partition.find(p=>p.eventId===f.event.eventId).recordValidator,'RUNTIME_MODERN');assert.deepEqual(await f.repo.exportState(),before);
});
test('actual hosted export preserves context envelopes but does not export historical release bodies or restore authority',async t=>{
 const f=await fixture(t);await writeFile(path.join(f.directory,'instance.json'),JSON.stringify({schemaVersion:'1.0',instanceId:f.profile.instanceId,database:'instance.sqlite'}));const output=f.directory+'-hosted';t.after(()=>rm(output,{recursive:true,force:true}));await exportHostedInstance(f.directory,output);const result=await verifyHostedExport(output);assert.deepEqual(result.events.events['asset-context-revalidation'],[f.event]);const model=result.snapshot.productionModel;assert.equal(model.assetContextRevalidationEvidence[0].mediaCurrent,false);assert.equal(model.assetContextRevalidationHostedProof.effectAvailable,false);assert.equal('historicalContexts'in model,false);
});

test('same millisecond own ledger result is provably after its event; unrelated same-time publication stays rejected',async t=>{
 const f=await fixture(t,{sameMillisecond:true});
 const capture=()=>f.repo.readTransaction(async tx=>captureHistoricalEventContexts(tx,{events:await tx.listEvents(),instanceId:f.profile.instanceId}));
 assert.equal((await capture()).contexts[0].releaseId,f.release.releaseId);validateArchive(await f.repo.exportState(),f.profile.instanceId);
 const NativeDate=Date,fixedTime=Date.parse(f.event.recordedAt);globalThis.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[fixedTime]));}static now(){return fixedTime;}};
 try{await f.repo.writeTransaction(async tx=>{const view=await tx.readView(),snapshot=structuredClone(view.snapshot);delete snapshot.productionModel.assetContextRevalidationLedger;snapshot.snapshotId='snapshot:unrelated-time';await tx.publishRelease({snapshot,recipes:{...view.recipes,snapshotId:snapshot.snapshotId},expectedReleaseId:view.releaseId,sourceRevisionIds:view.sourceRevisionIds});});}finally{globalThis.Date=NativeDate;}
 await assert.rejects(capture(),/simultaneous publication/);const invalid=await f.repo.exportState();assert.throws(()=>validateArchive(invalid,f.profile.instanceId));
});
