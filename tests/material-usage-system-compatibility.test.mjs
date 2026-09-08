import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {materialUsageCompatibilityFixture as fixture} from './fixtures/material-usage-compatibility.mjs';
import {canonicalJson,sha256,createInstanceRepository,importRepositoryState,restoreInstanceRepository} from '../host/instance-runtime/index.mjs';
import {validateArchive,createArchiveStreamValidator} from '../host/instance-runtime/postgres.mjs';
import {validateMaterialUsageLedger,usageHash,materialUsageEventPayload} from '../host/instance-runtime/material-usage-model.mjs';
import {preserveMaterialUsageProjection} from '../host/instance-runtime/material-usage-preservation.mjs';
import {encodeMaterialUsageDocuments,decodeMaterialUsageDocuments,validateHostedMaterialUsages} from '../host/instance-material-usage-proof.mjs';
import {validateModernEventsInChild} from '../host/instance-modern-event-bridge.mjs';
import {hostedEventProjection} from '../scripts/export-hosted-material-events.mjs';
import {exportHostedInstance,verifyHostedExport} from '../scripts/instance-hosted-export.mjs';
import {writeArchiveFile,ARCHIVE_FILE_FORMAT} from '../host/instance-runtime/archive-file.mjs';
import {openArchiveRowsWithBinding,validateArchiveRows} from '../host/instance-runtime/archive-stream-validation.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'.test-tmp');
const clone=f=>structuredClone(f);
test('compiler preservation retains exact source bytes, ledger, old ASSET and recipes without creating adoption',()=>{
  const f=fixture(),before=canonicalJson(f),target=clone(f.snapshot);delete target.productionModel.materialUsageLedger;
  const result=preserveMaterialUsageProjection({snapshot:target,recipes:f.recipes,baseSnapshot:f.snapshot,documents:f.documents,events:f.events});
  assert.deepEqual(result.snapshot.productionModel.materialUsageLedger,[f.ref]);assert.equal(canonicalJson(f),before);assert.strictEqual(result.recipes,f.recipes);
  const transport=encodeMaterialUsageDocuments(f.documents);assert.deepEqual(decodeMaterialUsageDocuments(transport)[0].bytes,f.document.bytes);
});
const mutations={
  'missing source':f=>{f.documents=[];},'missing event':f=>{f.events.pop();},'lost ledger':f=>{f.snapshot.productionModel.materialUsageLedger=[];},
  'changed original bytes':f=>{f.document.bytes=Buffer.from('{}');},'unknown schema':f=>{f.event.schemaVersion='9.0';},
  'foreign original adoption SHA':f=>{f.adoption.versionSha256='a'.repeat(64);},'duplicate source':f=>{f.documents.push(f.document);},
  'orphan source with wrong role':f=>{f.snapshot.productionModel.materialUsageLedger=[];f.events.pop();f.document.metadata.sourceRole='UNKNOWN';},
  'changed event kind':f=>{f.event.eventKind='review';},'manufactured old ASSET adoption':f=>{f.event.originalAssetAdoptionPerformed=true;},
};
for(const [name,mutate] of Object.entries(mutations))test(name+' fails before compiler preservation',()=>{const f=fixture();mutate(f);assert.throws(()=>preserveMaterialUsageProjection({snapshot:clone(f.snapshot),recipes:f.recipes,baseSnapshot:f.snapshot,documents:f.documents,events:f.events}));});
test('actual child validator delegates only the independently proved usage event; no snapshotId is invented',async()=>{
  const f=fixture(),before=canonicalJson(f.events),result=await validateModernEventsInChild({...f,eventDirectory:'events'});
  assert.equal(result.proof.partition.find(r=>r.eventId===f.event.eventId).recordValidator,'RUNTIME_MODERN');
  assert.equal(result.proof.partition.find(r=>r.eventId===f.adoption.eventId).recordValidator,'LEGACY');
  assert.equal(result.proof.eventsOmitted,0);assert.equal(canonicalJson(f.events),before);assert.equal('snapshotId'in f.event,false);
  await assert.rejects(validateModernEventsInChild({...f,documents:[],eventDirectory:'events'}));
});
test('malformed explicit ledger cannot evade the bridge empty fast path',async()=>{
  const f=fixture();f.snapshot.productionModel.materialUsageLedger={schemaVersion:'UNKNOWN'};
  f.baseRelease.snapshotBytes=Buffer.from(canonicalJson(f.snapshot));
  await assert.rejects(validateModernEventsInChild({...f,events:[],documents:[],eventDirectory:'events'}),/ledger|用途/);
});
test('hosted export carries all usage source bytes and source adoption events, with independent readback validation',async()=>{
  const f=fixture();f.snapshot.productionModel.materialUsageSources=encodeMaterialUsageDocuments(f.documents);
  f.snapshot.productionModel.materialUsageEvidence=validateMaterialUsageLedger(f).map(r=>({...r,mediaCurrent:true}));
  f.snapshot.productionModel.publicExportMediaBindings=[{familyId:f.body.basis.source.familyId,versionId:f.body.basis.source.versionId,sha256:f.body.basis.source.sha256}];
  const bundle=await hostedEventProjection({snapshot:f.snapshot,profile:f.profile,releaseId:'release:usage',eventsByKind:{review:[f.adoption],'material-usage-review':[f.event]}});
  assert.deepEqual(bundle.events['material-usage-review'],[f.event]);assert.deepEqual(bundle.events.review,[f.adoption]);
  assert.equal(bundle.counts.materialUsageReviewEvents,1);assert.equal(bundle.counts.materialReviewEvents,1);
  assert.equal(validateHostedMaterialUsages(f.snapshot,bundle).length,1);
  const changed=clone(f.snapshot);changed.productionModel.materialUsageEvidence[0].body.content.purposeNote='forged';assert.throws(()=>validateHostedMaterialUsages(changed,bundle));
  const missing=clone(bundle);missing.events['material-usage-review']=[];assert.throws(()=>validateHostedMaterialUsages(f.snapshot,missing));
  assert.throws(()=>validateHostedMaterialUsages(f.snapshot,bundle,{mediaBindings:[]}),/公共媒体/);
});

async function repositoryFixture(t){
  await mkdir(root,{recursive:true});const directory=await mkdtemp(path.join(root,'usage-compat-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const f=fixture(),repo=createInstanceRepository({dbPath:path.join(directory,'source.sqlite'),instanceId:f.instanceId,profile:f.profile});t.after(()=>repo.close());
  await repo.writeTransaction(tx=>{
    const original=clone(f.snapshot);original.snapshotId='snapshot:base';delete original.productionModel.materialUsageLedger;
    const base=tx.publishRelease({snapshot:original,recipes:{...f.recipes,snapshotId:original.snapshotId},expectedReleaseId:null});
    f.body.baseReleaseId=base.releaseId;const {id:old,...body}=f.body;assert.ok(old);f.body.id='MUSE-REV-'+usageHash(body).slice(0,32);
    f.document.bytes=Buffer.from('  '+JSON.stringify(f.body,null,2)+'\r\n');f.document.aliases=['story/material-usages/'+f.body.id+'.json'];
    Object.assign(f.ref,{id:f.body.id,sourceRef:f.document.aliases[0]});
    const doc=tx.putDocument({documentId:f.document.documentId,aliases:f.document.aliases,bytes:f.document.bytes,metadata:f.document.metadata,mediaType:'application/json',expectedRevisionId:null});
    f.document={...doc,aliases:f.document.aliases};f.documents=[f.document];Object.assign(f.ref,{sourceRevisionId:doc.revisionId,sourceSha256:doc.sha256});Object.assign(f.event,materialUsageEventPayload(f.body,f.ref));
    tx.importEvent({bytes:canonicalJson(f.adoption)});tx.importEvent({bytes:canonicalJson(f.event)});
    tx.publishRelease({snapshot:f.snapshot,recipes:f.recipes,expectedReleaseId:base.releaseId,sourceRevisionIds:[doc.revisionId]});
  });
  return {...f,directory,repo};
}
test('actual isolated SQLite storage -> streamed archive -> fresh import retains original sources/events byte for byte',async t=>{
  const f=await repositoryFixture(t),archive=await f.repo.exportState();validateArchive(archive,f.instanceId);
  const filename=path.join(f.directory,'archive.jsonl'),binding=await writeArchiveFile(filename,archive),reader=await openArchiveRowsWithBinding(filename,binding);
  try{const scan=await validateArchiveRows(reader,{instanceId:f.instanceId,createValidator:createArchiveStreamValidator});assert.equal(scan.exportSha256,archive.exportSha256);}finally{await reader.close();}
  assert.equal(binding.format,ARCHIVE_FILE_FORMAT);
  const restored=importRepositoryState({dbPath:path.join(f.directory,'restored.sqlite'),instanceId:f.instanceId,archive});
  try{const after=await restored.exportState();for(const table of ['record_revisions','domain_events','releases','document_aliases'])assert.deepEqual(after.tables[table],archive.tables[table]);}finally{restored.close();}
  const bad=clone(archive);bad.tables.domain_events=bad.tables.domain_events.filter(r=>r.event_id!==f.event.eventId);const {exportSha256:ignored,...body}=bad;assert.ok(ignored);bad.exportSha256=sha256(canonicalJson(body));
  assert.throws(()=>validateArchive(bad,f.instanceId),/用途/);
  assert.throws(()=>importRepositoryState({dbPath:path.join(f.directory,'rejected.sqlite'),instanceId:f.instanceId,archive:bad}),/用途/);
});
test('actual hosted export and physical readback preserve source bytes and detect self-rehashed semantic tampering',async t=>{
  const f=await repositoryFixture(t),output=f.directory+'-hosted';t.after(()=>rm(output,{recursive:true,force:true}));
  await writeFile(path.join(f.directory,'instance.json'),JSON.stringify({schemaVersion:'1.0',instanceId:f.instanceId,database:'source.sqlite'}));
  const before=await f.repo.exportState();await exportHostedInstance(f.directory,output);
  const exported=await verifyHostedExport(output);assert.equal(validateHostedMaterialUsages(exported.snapshot,exported.events).length,1);
  assert.deepEqual(decodeMaterialUsageDocuments(exported.snapshot.productionModel.materialUsageSources)[0].bytes,f.document.bytes);
  assert.deepEqual(await f.repo.exportState(),before);
  // Recalculate outer file+manifest hashes so rejection must be semantic.
  const eventPath=path.join(output,'hosted-material-events.generated.json'),eventBundle=JSON.parse(await readFile(eventPath,'utf8'));
  eventBundle.events['material-usage-review'][0].originalRightsChanged=true;const bytes=Buffer.from(JSON.stringify(eventBundle)+'\n');await writeFile(eventPath,bytes);
  const manifestPath=path.join(output,'hosted-export-manifest.json'),manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  Object.assign(manifest.files.find(r=>r.path==='hosted-material-events.generated.json'),{sha256:sha256(bytes),bytes:bytes.length});
  const {manifestSha256:old,...body}=manifest;assert.ok(old);manifest.manifestSha256=sha256(canonicalJson(body));await writeFile(manifestPath,JSON.stringify(manifest)+'\n');
  await assert.rejects(verifyHostedExport(output),/用途/);
});
test('raw SQLite restore preserves exact usage history and refuses an explicitly foreign historical base before target creation',async t=>{
  const f=await repositoryFixture(t),before=await f.repo.exportState(),backup=f.repo.backupTo(path.join(f.directory,'usage-backup.sqlite'));
  const restored=await restoreInstanceRepository({backupPath:backup.path,dbPath:path.join(f.directory,'raw-restored.sqlite'),instanceId:f.instanceId,expectedSha256:backup.sha256});
  try{const after=await restored.exportState();for(const table of ['record_revisions','domain_events','releases','document_aliases'])assert.deepEqual(after.tables[table],before.tables[table]);}finally{restored.close();}
  const changed=new DatabaseSync(backup.path);
  try{
    // Adversarial test fixture only: simulate an externally rehashed backup,
    // restoring the original immutable trigger before exercising import.
    const trigger=changed.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='releases_no_update'").get().sql;
    changed.exec('DROP TRIGGER releases_no_update');
    const row=changed.prepare('SELECT snapshot_bytes FROM releases WHERE release_id=?').get(f.body.baseReleaseId),snapshot=JSON.parse(Buffer.from(row.snapshot_bytes));
    snapshot.instance={instanceId:'instance:OTHER'};const bytes=Buffer.from(canonicalJson(snapshot));
    changed.prepare('UPDATE releases SET snapshot_bytes=?,snapshot_sha256=? WHERE release_id=?').run(bytes,sha256(bytes),f.body.baseReleaseId);
    changed.exec(trigger);
  }finally{changed.close();}
  const rejected=path.join(f.directory,'raw-rejected.sqlite');
  await assert.rejects(restoreInstanceRepository({backupPath:backup.path,dbPath:rejected,instanceId:f.instanceId,expectedSha256:sha256(await readFile(backup.path))}),/用途/);
  await assert.rejects(readFile(rejected),{code:'ENOENT'});
});
for(const kind of ['lost current ledger','unpublished usage source','missing actual base release','foreign base snapshot instance','foreign base model instance','foreign current snapshot instance','unknown event schema'])test('archive semantic closure rejects '+kind+' even with recalculated archive SHA',async t=>{
  const f=await repositoryFixture(t),archive=await f.repo.exportState(),current=archive.tables.repository_meta[0].current_release_id;
  const release=archive.tables.releases.find(r=>r.release_id===current);
  if(kind==='lost current ledger'){
    const snapshot=JSON.parse(Buffer.from(release.snapshot_bytes.bytes,'base64'));snapshot.productionModel.materialUsageLedger=[];
    const bytes=Buffer.from(canonicalJson(snapshot));release.snapshot_bytes={encoding:'base64',bytes:bytes.toString('base64')};release.snapshot_sha256=sha256(bytes);
  }else if(kind==='unpublished usage source')release.source_revision_ids_json='[]';
  else if(kind==='missing actual base release')archive.tables.releases=archive.tables.releases.filter(r=>r.release_id!==f.body.baseReleaseId);
  else if(kind.startsWith('foreign ')){
    const actual=kind.includes('current')?release:archive.tables.releases.find(r=>r.release_id===f.body.baseReleaseId);
    const snapshot=JSON.parse(Buffer.from(actual.snapshot_bytes.bytes,'base64'));
    if(kind.includes('model'))snapshot.productionModel.instance={instanceId:'instance:OTHER'};
    else snapshot.instance={instanceId:'instance:OTHER'};
    const bytes=Buffer.from(canonicalJson(snapshot));actual.snapshot_bytes={encoding:'base64',bytes:bytes.toString('base64')};actual.snapshot_sha256=sha256(bytes);
  }
  else {const row=archive.tables.domain_events.find(r=>r.event_id===f.event.eventId),event=JSON.parse(Buffer.from(row.event_bytes.bytes,'base64'));event.schemaVersion='9.0';const bytes=Buffer.from(canonicalJson(event));row.event_bytes={encoding:'base64',bytes:bytes.toString('base64')};row.event_sha256=sha256(bytes);}
  const {exportSha256:old,...body}=archive;assert.ok(old);archive.exportSha256=sha256(canonicalJson(body));
  assert.throws(()=>validateArchive(archive,f.instanceId),/用途/);
  const {tables,...header}=archive,validator=createArchiveStreamValidator(header,Object.keys(tables),f.instanceId);
  assert.throws(()=>{for(const [table,rows]of Object.entries(tables)){for(const row of rows)validator.accept(table,row);validator.finishTable(table);}validator.finish();},/用途/);
});
