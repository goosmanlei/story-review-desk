import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {episodeSpecApiFixture} from './fixtures/episode-review-spec-api.mjs';
import {validateArchive,createArchiveStreamValidator} from '../host/instance-runtime/postgres.mjs';
import {writeArchiveFile} from '../host/instance-runtime/archive-file.mjs';
import {openArchiveRowsWithBinding,validateArchiveRows,decodeArchiveRow} from '../host/instance-runtime/archive-stream-validation.mjs';
import {importRepositoryState,restoreInstanceRepository} from '../host/instance-runtime/index.mjs';
import {captureHistoricalEventContexts} from '../host/instance-historical-event-context.mjs';
import {validateModernEventsInChild} from '../host/instance-modern-event-bridge.mjs';
import {createEpisodeReviewSpecArchiveValidator} from '../host/instance-runtime/episode-review-spec-archive.mjs';
import {canonicalJson,sha256} from '../host/instance-runtime/bytes.mjs';
import {preserveConfigurationProjection} from '../host/instance-runtime/configuration-service.mjs';
const options={skip:process.env.REVIEW_TEST_POSTGRES!=='1'},next=f=>{const c=structuredClone(f.content);c.episodes[0].coreAdvance='得到消息后决定回信';return c;};
async function child(f){return f.repo.readTransaction(async tx=>{const events=await tx.listEvents(),baseRelease=await tx.readRelease(),historicalContexts=await captureHistoricalEventContexts(tx,{events,instanceId:f.profile.instanceId});return validateModernEventsInChild({events,baseRelease,historicalContexts,eventDirectory:'events'});});}
function archiveCheck(archive,mutate=()=>{}){
 const validator=createEpisodeReviewSpecArchiveValidator();
 for(const [table,rows] of Object.entries(archive.tables).sort(([a],[b])=>a.localeCompare(b)))for(const original of rows){const row=decodeArchiveRow(structuredClone(original));mutate(table,row);validator.accept(table,row);}validator.finish();
}
test('PG/API inherits exact old spec, validates historical child, object/stream archive and two restores without rewriting old bytes',options,async t=>{
 const f=await episodeSpecApiFixture(t),old=structuredClone(f.first),before=await f.repo.exportState();await f.publishDefaults(c=>{c.technical.delivery.platform='Neutral production platform';});
 const result=await f.post(next(f),{key:'exact-successor'});assert.equal(result.status,201,JSON.stringify(result.body));const event=result.body.event;
 assert.deepEqual(event.reviewSpec,old.reviewSpec);assert.equal(event.reviewSpecInheritance.parentEventId,old.eventId);assert.equal(event.reviewSpecInheritance.parentEventSha256,sha256(Buffer.from(canonicalJson(old))));
 const replay=await f.post(next(f),{key:'exact-successor'});assert.equal(replay.status,200);assert.deepEqual(replay.body.event,event);
 const view=await f.repo.readView(),preserved=preserveConfigurationProjection({snapshot:view.snapshot,recipes:view.recipes,baseSnapshot:view.snapshot,profile:view.profile,events:await f.repo.listEvents()});assert.deepEqual(preserved.snapshot.productionModel.configurationCandidates.find(c=>c.id===event.creativeRevisionId).reviewSpec,old.reviewSpec);
 assert.ok(await child(f));
 await f.repo.readTransaction(async tx=>{const events=structuredClone(await tx.listEvents());delete events.find(e=>e.eventId===event.eventId).reviewSpecInheritance;const historicalContexts=await captureHistoricalEventContexts(tx,{events,instanceId:f.profile.instanceId});const baseRelease=await tx.readRelease();await assert.rejects(()=>validateModernEventsInChild({events,baseRelease,historicalContexts,eventDirectory:'events'}),/不支持的分集冻结标准继承协议/);});
 const archive=await f.repo.exportState();validateArchive(archive,f.profile.instanceId);archiveCheck(archive);
 for(const row of before.tables.domain_events)assert.deepEqual(archive.tables.domain_events.find(r=>r.event_id===row.event_id),row);
 for(const [name,mutate]of Object.entries({
  missingMarker:e=>{delete e.reviewSpecInheritance;},unknownMarker:e=>{e.reviewSpecInheritance.schemaVersion='NEXT';},wrongParent:e=>{e.reviewSpecInheritance.parentEventSha256='0'.repeat(64);}
 })) {
  const forged=structuredClone(archive),row=forged.tables.domain_events.find(r=>r.event_id===event.eventId),e=JSON.parse(Buffer.from(row.event_bytes.bytes,'base64'));mutate(e);const bytes=Buffer.from(canonicalJson(e));row.event_bytes={encoding:'base64',bytes:bytes.toString('base64')};row.event_sha256=sha256(bytes);const {exportSha256:ignored,...body}=forged;void ignored;forged.exportSha256=sha256(Buffer.from(canonicalJson(body)));
  assert.throws(()=>validateArchive(forged,f.profile.instanceId),name+' full archive with recomputed envelopes');
  assert.throws(()=>archiveCheck(forged),name+' alphabetic compact collector');
 }
 const filename=path.join(f.root,'archive.jsonl'),file=await writeArchiveFile(filename,archive),reader=await openArchiveRowsWithBinding(filename,file);try{assert.equal((await validateArchiveRows(reader,{instanceId:f.profile.instanceId,createValidator:createArchiveStreamValidator})).exportSha256,archive.exportSha256);}finally{await reader.close();}
 const restored=await importRepositoryState({archive,dbPath:path.join(f.root,'restored.sqlite'),instanceId:f.profile.instanceId});t.after(()=>restored.close());const imported=await restored.exportState();assert.notEqual((await restored.getMetadata()).runtimeEpoch,(await f.repo.getMetadata()).runtimeEpoch);for(const table of ['record_revisions','document_aliases','domain_events','releases'])assert.deepEqual(imported.tables[table],archive.tables[table]);validateArchive(imported,f.profile.instanceId);
 const backup=await restored.backupTo(path.join(f.root,'backup.sqlite')),raw=await restoreInstanceRepository({backupPath:backup.path,expectedSha256:backup.sha256,dbPath:path.join(f.root,'raw.sqlite'),instanceId:f.profile.instanceId});t.after(()=>raw.close());validateArchive(await raw.exportState(),f.profile.instanceId);
});
test('PG/API real criteria change blocks normal successor; valid explicit unpublished-object upgrade becomes the effective parent standard',options,async t=>{
 const f=await episodeSpecApiFixture(t);await f.publishDefaults(c=>{c.reviewProfiles.find(p=>p.id==='episode-plan').criteria[0].question='新的实际审阅问题';});const before=await f.repo.exportState(),blocked=await f.post(next(f));assert.equal(blocked.status,409,JSON.stringify(blocked.body));assert.deepEqual(await f.repo.exportState(),before);
 await f.publishDefaults(()=>{},['candidate:'+f.first.creativeRevisionId]);const accepted=await f.post(next(f));assert.equal(accepted.status,201,JSON.stringify(accepted.body));assert.notEqual(accepted.body.event.reviewSpec.hash,f.first.reviewSpec.hash);assert.equal(accepted.body.event.reviewSpec.criteria[0].question,'新的实际审阅问题');assert.ok(await child(f));validateArchive(await f.repo.exportState(),f.profile.instanceId);
});
test('PG/API same-millisecond publication rejects before append, and concurrent candidates share one locked CAS',options,async t=>{
 const f=await episodeSpecApiFixture(t);await f.publishDefaults(c=>{c.technical.delivery.platform='Next';});const before=await f.repo.exportState(),release=await f.repo.readRelease(),request=await f.request(next(f)),RealDate=Date;
 globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[release.createdAt]));}static now(){return RealDate.parse(release.createdAt);}};
 let response;try{response=await f.route.POST(request);}finally{globalThis.Date=RealDate;}assert.equal(response.status,409,await response.clone().text());assert.deepEqual(await f.repo.exportState(),before);
 const a=await f.request(next(f)),other=next(f);other.episodes[0].coreAdvance+='不同后继';const b=await f.request(other),results=await Promise.all([f.route.POST(a),f.route.POST(b)]);assert.deepEqual(results.map(r=>r.status).sort(),[201,412]);validateArchive(await f.repo.exportState(),f.profile.instanceId);
});
test('PG/API refuses author supplied standards and inheritance provenance',options,async t=>{const f=await episodeSpecApiFixture(t);for(const key of ['reviewSpec','configurationBinding','reviewSpecInheritance']){const before=await f.repo.exportState(),result=await f.post(next(f),{extra:{[key]:{}}});assert.equal(result.status,422);assert.deepEqual(await f.repo.exportState(),before);}});
