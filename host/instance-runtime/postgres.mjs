import {restoredRuntimeEpoch} from './execution-epoch.mjs';
import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { RepositoryError, canonicalJson, sha256, projectionFingerprintNamespaces, projectionFingerprintRows } from './index.mjs';
import { APPLICATION_ID, SCHEMA_VERSION } from './schema.mjs';
import { installQueryModel, rebuildQueryModel } from './query-model.mjs';
import { BUSINESS_TABLES, POSTGRES_SCHEMA, POSTGRES_SCHEMA_VERSION } from './postgres-schema.mjs';
import {mediaRetirementOverlay} from './media-retirement.mjs';
import {canonicalSha256,archiveRowHashes,assertArchiveRowHashes} from './archive-integrity.mjs';
import {writeArchiveFile} from './archive-file.mjs';
const contexts = new AsyncLocalStorage();
const mediaLeaseContexts = new AsyncLocalStorage();
const MEDIA_GATE_NAMESPACE = 'media-maintenance-gates';
function mediaLockKeys(instanceId) {
 const value=Buffer.from(sha256(Buffer.from('review-media-lease:'+instanceId)).slice(0,16),'hex');
 return [value.readInt32BE(0),value.readInt32BE(4)];
}
async function assertMediaGateClosed(unit) {
 const record=await unit.getAux(MEDIA_GATE_NAMESPACE,'current');ensure(!record||parse(record.bytes).phase==='CLOSED','MEDIA_MAINTENANCE_ACTIVE','Media maintenance requires explicit completion or recovery');
 // Existing immutable intents are a crash-persistent gate; no new business write point is needed.
 const latest=new Map();
 for(const row of await unit.listAux('media-retirement-journal')){const event=parse(row.bytes),old=latest.get(event.planId);if(!old||event.sequence>old.sequence)latest.set(event.planId,event);}
 ensure(![...latest.values()].some(event=>['QUARANTINE_INTENT','PURGE_INTENT','RESULT_UNKNOWN'].includes(event.phase)),
  'MEDIA_MAINTENANCE_ACTIVE','An immutable retirement intent still requires completion or explicit recovery');
}
const releaseCaches = new WeakMap();
const ensure = (ok, code, message, details) => { if (!ok) throw new RepositoryError(code,message,details); };
const text = (x,name) => {ensure(typeof x==='string'&&x.length>0&&x.length<=4096&&!x.includes('\0'),'INVALID_INPUT',`${name} must be a bounded nonempty string`);return x;};
const digest = x => {ensure(typeof x==='string'&&/^[a-f0-9]{64}$/.test(x),'INVALID_SHA256','Expected SHA-256');return x;};
const bytes = x => {ensure(typeof x==='string'||x instanceof Uint8Array,'INVALID_BYTES','Original UTF-8 string or bytes required');return Buffer.from(x);};
const json = x => Buffer.from(canonicalJson(x));
const parse = x => JSON.parse(Buffer.from(x).toString('utf8'));
const now = () => new Date().toISOString();
const readOnlyProcess = () => process.env.REVIEW_INSTANCE_READ_ONLY==='1'||process.env.REVIEW_REMOTE_READ_ONLY==='1';
const number = x => {const n=Number(x);ensure(Number.isSafeInteger(n),'INTEGER_RANGE','Database integer exceeds safe range');return n;};
const rowRecord = r => r ? {namespace:r.namespace,key:r.record_key,revisionId:r.revision_id,revision:number(r.revision_number),previousRevisionId:r.previous_revision_id,bytes:Buffer.from(r.content_bytes),sha256:r.content_sha256,mediaType:r.media_type,metadata:JSON.parse(r.metadata_json),deleted:Boolean(r.deleted),createdAt:r.created_at}:null;
const orderedEvents = rows => rows.map(r=>parse(r.event_bytes)).sort((a,b)=>{const l=Number.isSafeInteger(a.eventSequence)&&a.eventSequence>0?a.eventSequence:null,r=Number.isSafeInteger(b.eventSequence)&&b.eventSequence>0?b.eventSequence:null;return l!==null&&r!==null&&l!==r?r-l:l!==null&&r===null?-1:l===null&&r!==null?1:String(b.recordedAt).localeCompare(String(a.recordedAt))||String(b.eventId).localeCompare(String(a.eventId));});
async function configurationProjection(unit,profile,snapshot,recipes){
 const ref=profile.configurationRef;
 if(!ref){ensure(!snapshot?.productionModel?.systemConfiguration&&!recipes?.configurationRef,'CONFIGURATION_BINDING','Configuration projection requires a bound reference');return;}
 const record=await unit.getRecord('settings','system-configuration',ref.revisionId);
 ensure(record&&!record.deleted&&record.sha256===ref.sha256&&sha256(record.bytes)===ref.sha256,'CONFIGURATION_BINDING','Configuration reference is invalid');
 const value=parse(record.bytes), projected=snapshot?.productionModel?.systemConfiguration;
 ensure(projected&&canonicalJson(projected.reference)===canonicalJson(ref)&&canonicalJson(recipes?.configurationRef)===canonicalJson(ref)&&canonicalJson(projected.config)===canonicalJson(value.configuration),'CONFIGURATION_BINDING','Snapshot, recipes and profile must bind one configuration');
 for(const row of [...(snapshot.productionModel.materialRequirements||[]),...(snapshot.productionModel.workItems||[]),...(snapshot.productionModel.episodePlanRevisions||[]),...(snapshot.productionModel.configurationCandidates||[]),...(snapshot.actionQueueInputs?.sceneReviewDossiers||[])]){
  const binding=row.configurationBinding;if(!binding)continue;
  const {hash,...standard}=binding.reviewSpec;ensure(sha256(json(standard))===hash,'CONFIGURATION_BINDING','Review standard hash is invalid');
  const saved=value.bindings[binding.key];ensure(!saved||canonicalJson(saved)===canonicalJson(binding),'CONFIGURATION_BINDING','Existing object was silently rebound');
  ensure(canonicalJson(row.reviewSpec)===canonicalJson(binding.reviewSpec),'CONFIGURATION_BINDING','Object standard differs from binding');
 }
}
export async function postgresConnection(options={}){
 if(options.connection)return options.connection;
 const locator=options.database||{};
 let password=process.env.REVIEW_POSTGRES_PASSWORD;
 const passwordFile=process.env.REVIEW_POSTGRES_PASSWORD_FILE|| (options.root&&path.join(options.root,'runtime/private/postgres-password'));
 if(!password&&passwordFile){const s=await lstat(passwordFile);ensure(s.isFile()&&!s.isSymbolicLink()&&(s.mode&0o077)===0,'POSTGRES_SECRET','Database secret must be a private regular file');password=(await readFile(passwordFile,'utf8')).trim();}
 ensure(password,'POSTGRES_CONFIGURATION','PostgreSQL credentials are unavailable');
 return {host:process.env.REVIEW_POSTGRES_HOST||locator.service||'postgres',port:Number(process.env.REVIEW_POSTGRES_PORT||5432),database:locator.database||'review',user:process.env.REVIEW_POSTGRES_USER||'review',password,connectionTimeoutMillis:5000,statement_timeout:30000,application_name:'story-review'};
}
class PgUnit {
 constructor(client,repository,writable=false){this.client=client;this.repository=repository;this.writable=writable;this.backend='postgres';this.localReleases=new Map();}
 async query(sql,params=[]){return this.client.query(sql,params);}
 async getMetadata(){const state=await this.repositoryState(),e=await this.one('SELECT COALESCE(max(storage_sequence),0) AS seq FROM domain_events');return {...state,eventSequence:number(e.seq)};}
 async getProjectionFingerprint(namespaces){
  const selected=projectionFingerprintNamespaces(namespaces),parameters=selected.map(value=>'aux:'+value);
  const heads=parameters.length?await this.all('SELECT namespace,record_key,revision_id FROM record_heads WHERE namespace = ANY($1::text[])',[parameters]):[];
  const mediaRows=await this.all('SELECT media_id,version_id,relative_path,sha256,byte_size,availability,metadata_json FROM media_versions');
  const aliases=await this.all('SELECT alias,media_id,version_id FROM media_aliases');
  return projectionFingerprintRows(selected,heads,mediaRows,aliases);
 }
 async listRecordRevisions(namespace,key){return (await this.all('SELECT * FROM record_revisions WHERE namespace=$1 AND record_key=$2 ORDER BY revision_number',[namespace,key])).map(rowRecord);}
 async listPublishedDocumentMetadata(){const r=await this.one('SELECT source_revision_ids_json FROM releases WHERE release_id=(SELECT current_release_id FROM repository_meta WHERE singleton=1)');if(!r)return [];return (await this.all("SELECT r.revision_id,r.record_key,r.content_sha256,octet_length(r.content_bytes) AS byte_size,r.metadata_json,r.media_type,COALESCE(array_agg(a.alias ORDER BY a.alias) FILTER(WHERE a.alias IS NOT NULL),'{}') AS aliases FROM record_revisions r LEFT JOIN document_aliases a ON a.document_id=r.record_key WHERE r.namespace='documents' AND r.revision_id=ANY($1::text[]) AND r.deleted=0 GROUP BY r.revision_id",[JSON.parse(r.source_revision_ids_json)])).map(r=>({documentId:r.record_key,revisionId:r.revision_id,sha256:r.content_sha256,byteSize:number(r.byte_size),aliases:r.aliases,metadata:JSON.parse(r.metadata_json),mediaType:r.media_type}));}
 async getPublishedDocument(alias){const rows=(await this.listPublishedDocumentMetadata()).filter(r=>r.documentId===alias||r.aliases.includes(alias));ensure(rows.length<=1,'SOURCE_ALIAS_AMBIGUOUS','Published document alias is ambiguous');return rows[0]?this.readDocumentRevision(rows[0].revisionId):null;}
 async all(sql,args=[]){return (await this.client.query(sql,args)).rows;}
 async one(sql,args=[]){return (await this.all(sql,args))[0];}
 async run(sql,args=[]){return this.client.query(sql,args);}
 async meta(){return this.one('SELECT * FROM repository_meta WHERE singleton=1');}
 async bump(){await this.run('UPDATE repository_meta SET repository_revision=repository_revision+1 WHERE singleton=1');}
 assertWrite(){ensure(this.writable&&!readOnlyProcess(),'READ_ONLY_TRANSACTION','Cannot mutate a read-only transaction');}
 async repositoryState(){const m=await this.meta(),r=m.current_release_id?await this.one('SELECT profile_revision_id,snapshot_id FROM releases WHERE release_id=$1',[m.current_release_id]):null;return {instanceId:m.instance_id,runtimeEpoch:m.runtime_epoch,repositoryRevision:number(m.repository_revision),releaseId:m.current_release_id,profileRevisionId:r?.profile_revision_id||null,snapshotId:r?.snapshot_id||null};}
 async getRecord(namespace,key,revisionId){return rowRecord(revisionId?await this.one('SELECT * FROM record_revisions WHERE revision_id=$1 AND namespace=$2 AND record_key=$3',[revisionId,namespace,key]):await this.one('SELECT r.* FROM record_heads h JOIN record_revisions r ON r.revision_id=h.revision_id WHERE h.namespace=$1 AND h.record_key=$2',[namespace,key]));}
 async readDocument(idOrAlias,{revisionId}={}){const id=(await this.one('SELECT document_id FROM document_aliases WHERE alias=$1',[idOrAlias]))?.document_id||idOrAlias,item=await this.getRecord('documents',id,revisionId);return item?{...item,documentId:id,aliases:(await this.all('SELECT alias FROM document_aliases WHERE document_id=$1 ORDER BY alias',[id])).map(r=>r.alias)}:null;}
 async listDocuments(){return Promise.all((await this.all("SELECT record_key FROM record_heads WHERE namespace='documents' ORDER BY record_key")).map(r=>this.readDocument(r.record_key)));}
 async readDocumentRevision(id){const r=await this.one("SELECT record_key FROM record_revisions WHERE revision_id=$1 AND namespace='documents'",[text(id,'revisionId')]);return r?this.readDocument(r.record_key,{revisionId:id}):null;}
 async cachedRelease(id){
  if(id===undefined)id=(await this.meta()).current_release_id;if(!id)return null;
  // Read a small descriptor in this transaction before consulting the cache. The
  // exact ID and both original-byte hashes bind every cached immutable value.
  const h=await this.one('SELECT release_id,snapshot_id,snapshot_sha256,recipes_sha256,source_revision_ids_json,profile_revision_id,created_at FROM releases WHERE release_id=$1',[text(id,'releaseId')]);if(!h)return null;
  const key=`${id}:${h.snapshot_sha256}:${h.recipes_sha256}`;
  // A write callback may see an unpublished release. Never let that value escape
  // into the repository cache before COMMIT (including through nested reads).
  let cache=this.localReleases;if(!this.writable&&this.repository){cache=releaseCaches.get(this.repository);if(!cache){cache=new Map();releaseCaches.set(this.repository,cache);}}
  let entry=cache.get(key);if(entry){cache.delete(key);cache.set(key,entry);return entry;}
  const r=await this.one('SELECT snapshot_bytes,recipes_bytes FROM releases WHERE release_id=$1',[id]);
  ensure(sha256(r.snapshot_bytes)===h.snapshot_sha256&&sha256(r.recipes_bytes)===h.recipes_sha256,'INTEGRITY_FAILED','Release original bytes differ from their hashes');
  entry={release:{releaseId:h.release_id,snapshotId:h.snapshot_id,snapshotBytes:Buffer.from(r.snapshot_bytes),snapshotSha256:h.snapshot_sha256,recipesBytes:Buffer.from(r.recipes_bytes),recipesSha256:h.recipes_sha256,sourceRevisionIds:JSON.parse(h.source_revision_ids_json),profileRevisionId:h.profile_revision_id,createdAt:h.created_at},parsed:null,configurationValidated:false};
  cache.set(key,entry);while(cache.size>3)cache.delete(cache.keys().next().value);return entry;
 }
 async readRelease(id){const entry=await this.cachedRelease(id);if(!entry)return null;const r=entry.release;return {...r,snapshotBytes:Buffer.from(r.snapshotBytes),recipesBytes:Buffer.from(r.recipesBytes),sourceRevisionIds:[...r.sourceRevisionIds]};}
 async getConfig(id){const r=await this.getRecord('settings',id);return r?{...r,configId:id,value:parse(r.bytes)}:null;}
 async getProfile(){const c=await this.getConfig('instance-profile');ensure(c&&!c.deleted,'PROFILE_MISSING','Instance profile required');ensure(c.value.instanceId===(await this.meta()).instance_id,'INSTANCE_MISMATCH','Profile identity mismatch');return c.value;}
 async getAux(namespace,key,options={}){return this.getRecord(`aux:${text(namespace,'namespace')}`,text(key,'key'),options.revisionId);}
 async listAux(namespace,{prefix='',includeDeleted=false}={}){return (await this.all('SELECT r.* FROM record_heads h JOIN record_revisions r ON r.revision_id=h.revision_id WHERE h.namespace=$1 ORDER BY r.record_key',[`aux:${text(namespace,'namespace')}`])).filter(r=>r.record_key.startsWith(prefix)&&(includeDeleted||!r.deleted)).map(rowRecord);}
 async listEvents(kind,{authorityDomain='FORMAL'}={}){return orderedEvents(await this.all(`SELECT event_bytes FROM domain_events WHERE authority_domain=$1${kind?' AND event_kind=$2':''}`,kind?[authorityDomain,kind]:[authorityDomain]));}
 async findIdempotentEvent(kind,key,{authorityDomain='FORMAL'}={}){const r=await this.one('SELECT event_bytes FROM domain_events WHERE authority_domain=$1 AND event_kind=$2 AND idempotency_key_hash=$3',[authorityDomain,kind,sha256(`${kind}:${key}`)]);return r?parse(r.event_bytes):null;}
 async media(r){return r?{mediaId:r.media_id,versionId:r.version_id,relativePath:r.relative_path,sha256:r.sha256,byteSize:number(r.byte_size),availability:r.availability,metadata:JSON.parse(r.metadata_json),aliases:(await this.all('SELECT alias FROM media_aliases WHERE media_id=$1 AND version_id=$2 ORDER BY alias',[r.media_id,r.version_id])).map(x=>x.alias)}:null;}
 async getMedia(id,version){return this.media(await this.one('SELECT * FROM media_versions WHERE media_id=$1 AND version_id=$2',[id,version]));}
 async listMedia(){return Promise.all((await this.all('SELECT * FROM media_versions ORDER BY media_id,version_id')).map(r=>this.media(r)));}
 async resolveMedia(alias,{versionId,sha256:hash}={}){const rows=(await this.all('SELECT m.* FROM media_versions m WHERE m.version_id=$1 OR EXISTS(SELECT 1 FROM media_aliases a WHERE a.media_id=m.media_id AND a.version_id=m.version_id AND a.alias=$1)',[alias])).filter(r=>(!versionId||r.version_id===versionId)&&(!hash||r.sha256===hash));ensure(rows.length<=1,'AMBIGUOUS_MEDIA_ALIAS','Historical media requires exact version and SHA');const media=await this.media(rows[0]);if(!media)return null;const retirement=await mediaRetirementOverlay(this,media);ensure(retirement.state==='ACTIVE',retirement.state==='PURGED'?'MEDIA_PURGED':'MEDIA_RETIRED','该历史媒体已清理，原版本与审计记录保留',{httpStatus:retirement.state==='PURGED'?410:409,retirement});return media;}
 async readView(){
  const state=await this.repositoryState(),entry=await this.cachedRelease(state.releaseId),release=entry?.release,p=release?await this.getRecord('settings','instance-profile',release.profileRevisionId):null;
  ensure(!state.releaseId||release&&p,'RELEASE_MISSING','Active release or profile missing');const profile=p?parse(p.bytes):await this.getProfile();ensure(profile.instanceId===state.instanceId,'INSTANCE_MISMATCH','Published profile identity mismatch');
  if(entry&&!entry.parsed){entry.parsed={snapshot:parse(release.snapshotBytes),recipes:parse(release.recipesBytes)};ensure(entry.parsed.snapshot.snapshotId===release.snapshotId&&entry.parsed.recipes.snapshotId===release.snapshotId,'RELEASE_MISMATCH','Release identity differs from its original bytes');}
  if(entry&&!entry.configurationValidated){await configurationProjection(this,profile,entry.parsed.snapshot,entry.parsed.recipes);entry.configurationValidated=true;}
  // Callers receive private mutable trees. Domain/configuration publication can
  // edit them without poisoning another request or changing the archived bytes.
  const {snapshot,recipes}=entry?structuredClone(entry.parsed):{snapshot:null,recipes:null};
  const publicProfile=Object.fromEntries(['schemaVersion','instanceId','projectId','title','storyTitle','episodePlanId','locale','branding','assistant','sourceBindings','capabilities','configurationRef','foundationRef','compilerBinding'].filter(k=>profile[k]!==undefined).map(k=>[k,profile[k]]));
  if(snapshot){snapshot.instance=publicProfile;snapshot.productionModel={...snapshot.productionModel,instance:publicProfile};}
  const eventsByKind={};for(const event of await this.listEvents())(eventsByKind[event.eventKind]||=[]).push(event);
  return {...state,profile,snapshot,recipes,eventsByKind,sourceRevisionIds:release?[...release.sourceRevisionIds]:[],dataFingerprint:release?`${state.runtimeEpoch}:${release.releaseId}:${release.snapshotSha256}`:'',recipeFingerprint:release?`${state.runtimeEpoch}:${release.releaseId}:${release.recipesSha256}`:''};
 }
 async putRecord(namespace,key,input,{expectedRevisionId,mediaType='application/octet-stream',metadata={},deleted=false}={}){
  this.assertWrite();text(namespace,'namespace');text(key,'key');ensure(expectedRevisionId===null||typeof expectedRevisionId==='string','CAS_REQUIRED','Explicit expectedRevisionId required');
  const old=await this.getRecord(namespace,key);ensure((old?.revisionId??null)===expectedRevisionId,'HEAD_CONFLICT','Record head changed',{currentRevisionId:old?.revisionId??null});const content=bytes(input),hash=sha256(content),meta=canonicalJson(metadata);
  if(old&&old.sha256===hash&&canonicalJson(old.metadata)===meta&&old.mediaType===mediaType&&old.deleted===deleted)return old;
  const id=`irv_${randomUUID()}`;await this.run('INSERT INTO record_revisions VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[id,namespace,key,(old?.revision??0)+1,old?.revisionId??null,content,hash,mediaType,meta,Number(deleted),now()]);
  await this.run('INSERT INTO record_heads VALUES($1,$2,$3) ON CONFLICT(namespace,record_key) DO UPDATE SET revision_id=excluded.revision_id',[namespace,key,id]);await this.bump();return this.getRecord(namespace,key);
 }
 async putDocument({documentId,bytes:input,aliases=[],...options}){const item=await this.putRecord('documents',documentId,input,options);for(const alias of aliases){text(alias,'alias');const old=await this.one('SELECT document_id FROM document_aliases WHERE alias=$1',[alias]);ensure(!old||old.document_id===documentId,'ALIAS_CONFLICT','Alias belongs to another identity');if(!old){await this.run('INSERT INTO document_aliases VALUES($1,$2)',[alias,documentId]);await this.bump();}}return this.readDocument(item.key);}
 async putConfig({configId,value,bytes:input,...options}){const content=input===undefined?json(value):bytes(input);if(value!==undefined)ensure(canonicalJson(parse(content))===canonicalJson(value),'CONFIG_BYTES_MISMATCH','Configuration bytes differ');if(configId==='instance-profile'){const next=parse(content),old=(await this.getConfig(configId))?.value;ensure(next.instanceId===(await this.meta()).instance_id,'INSTANCE_MISMATCH','Cannot replace identity');if(old)for(const key of ['instanceId','projectId','episodePlanId'])ensure(next[key]===old[key],'INSTANCE_IDENTITY_IMMUTABLE',`${key} is immutable`);}return this.putRecord('settings',configId,content,{...options,mediaType:'application/json'});}
 async putAux({namespace,key,bytes:input,...options}){return this.putRecord(`aux:${text(namespace,'namespace')}`,key,input,options);}
 async deleteAux({namespace,key,expectedRevisionId,metadata={}}){const old=await this.getAux(namespace,key);ensure(old,'RECORD_NOT_FOUND','Aux record missing');return this.putAux({namespace,key,bytes:old.bytes,expectedRevisionId,mediaType:old.mediaType,metadata:{...old.metadata,...metadata},deleted:true});}
 async moveAux({fromNamespace,fromKey,fromRevisionId,toNamespace,toKey}){const old=await this.getAux(fromNamespace,fromKey);ensure(old&&!old.deleted&&old.revisionId===fromRevisionId,'HEAD_CONFLICT','Move source changed');const destination=await this.putAux({namespace:toNamespace,key:toKey,bytes:old.bytes,expectedRevisionId:null,mediaType:old.mediaType,metadata:{...old.metadata,movedFrom:{namespace:fromNamespace,key:fromKey,revisionId:fromRevisionId}}}),source=await this.deleteAux({namespace:fromNamespace,key:fromKey,expectedRevisionId:fromRevisionId,metadata:{movedTo:{namespace:toNamespace,key:toKey,revisionId:destination.revisionId}}});return {source,destination};}
 async publishRelease({snapshot,recipes,snapshotBytes,recipesBytes,expectedReleaseId,sourceRevisionIds=[]}){
  this.assertWrite();ensure(expectedReleaseId===null||typeof expectedReleaseId==='string','CAS_REQUIRED','Expected release required');const state=await this.meta();ensure(state.current_release_id===expectedReleaseId,'RELEASE_CONFLICT','Current release changed');const data=snapshotBytes===undefined?json(snapshot):bytes(snapshotBytes),recipe=recipesBytes===undefined?json(recipes):bytes(recipesBytes),parsed=parse(data),catalog=parse(recipe);
  ensure(parsed.snapshotId&&parsed.snapshotId===catalog.snapshotId,'RELEASE_MISMATCH','Snapshot and recipes must form one release');if(snapshot!==undefined)ensure(canonicalJson(parsed)===canonicalJson(snapshot),'RELEASE_BYTES_MISMATCH','Snapshot bytes differ');if(recipes!==undefined)ensure(canonicalJson(catalog)===canonicalJson(recipes),'RELEASE_BYTES_MISMATCH','Recipe bytes differ');if(parsed.instance)ensure(parsed.instance.instanceId===state.instance_id,'INSTANCE_MISMATCH','Snapshot identity differs');
  const profile=await this.getConfig('instance-profile');await this.getProfile();await configurationProjection(this,profile.value,parsed,catalog);for(const id of sourceRevisionIds)ensure(await this.one('SELECT 1 FROM record_revisions WHERE revision_id=$1',[id]),'SOURCE_REVISION_MISSING','Release source missing');
  const id=`release_${randomUUID()}`;await this.run('INSERT INTO releases VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,parsed.snapshotId,data,sha256(data),recipe,sha256(recipe),canonicalJson(sourceRevisionIds),profile.revisionId,now()]);await this.run('UPDATE repository_meta SET current_release_id=$1 WHERE singleton=1',[id]);await rebuildQueryModel(this,{releaseId:id,snapshot:parsed,recipes:catalog});await this.bump();return this.readView();
 }
 async importEvent({bytes:input,sourceRef=null,authorityDomain='FORMAL'}){
  this.assertWrite();const content=bytes(input),event=parse(content),kind=event.eventKind||event.eventType,recordedAt=event.recordedAt||(Number.isSafeInteger(event.createdAt)?new Date(event.createdAt).toISOString():event.createdAt);text(event.eventId,'eventId');text(kind,'eventKind');text(recordedAt,'recordedAt');text(authorityDomain,'authorityDomain');ensure(authorityDomain!=='FORMAL'||event.eventKind&&event.recordedAt,'EVENT_DOMAIN_MISMATCH','Formal protocol missing');
  const old=await this.one('SELECT event_sha256,authority_domain FROM domain_events WHERE event_id=$1',[event.eventId]);if(old){ensure(old.event_sha256===sha256(content)&&old.authority_domain===authorityDomain,'EVENT_CONFLICT','Event bytes differ');return event;}
  if(event.idempotencyKeyHash){digest(event.idempotencyKeyHash);ensure(!await this.one('SELECT 1 FROM domain_events WHERE authority_domain=$1 AND event_kind=$2 AND idempotency_key_hash=$3',[authorityDomain,kind,event.idempotencyKeyHash]),'IDEMPOTENCY_CONFLICT','Imported idempotency collision');}
  const sequence=Number.isSafeInteger(event.eventSequence)&&event.eventSequence>0?event.eventSequence:null;
  await this.run('INSERT INTO domain_events(event_id,authority_domain,event_kind,original_sequence,recorded_at,event_bytes,event_sha256,idempotency_key_hash,request_hash,raw_request_hash,source_ref_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[event.eventId,authorityDomain,kind,sequence,recordedAt,content,sha256(content),event.idempotencyKeyHash||null,event.requestHash||null,event.rawRequestHash||null,canonicalJson(sourceRef)]);await this.bump();return event;
 }
 async appendEvent({kind,idempotencyKey,requestHash,payload,eventSchemaVersion='1.1',authorityDomain='FORMAL'}){
  this.assertWrite();text(kind,'event kind');text(idempotencyKey,'idempotency key');digest(requestHash);const old=await this.findIdempotentEvent(kind,idempotencyKey,{authorityDomain});if(old){ensure(old.requestHash===requestHash,'IDEMPOTENCY_CONFLICT','Idempotency key used with different content');return {event:old,replayed:true};}
  for(const key of ['eventId','eventKind','idempotencyKeyHash','requestHash','recordedAt','eventSequence'])ensure(!Object.hasOwn(payload,key),'RESERVED_EVENT_FIELD',`Reserved event field ${key}`);ensure(!Object.hasOwn(payload,'schemaVersion')||payload.schemaVersion===eventSchemaVersion,'RESERVED_EVENT_FIELD','Event version differs');
  const count=await this.one('SELECT count(*) AS n,max(original_sequence) AS seq FROM domain_events WHERE authority_domain=$1',[authorityDomain]);const event={schemaVersion:eventSchemaVersion,eventId:`evt_${randomUUID()}`,eventKind:kind,idempotencyKeyHash:sha256(`${kind}:${idempotencyKey}`),requestHash,recordedAt:now(),...payload,eventSequence:Math.max(number(count.n),number(count.seq||0))+1};await this.importEvent({bytes:Buffer.from(JSON.stringify(event,null,2)+'\n'),authorityDomain});return {event,replayed:false};
 }
 async registerMedia({mediaId,versionId,relativePath,sha256:hash,byteSize,aliases=[],metadata={},availability='PRESENT'}){
  this.assertWrite();text(mediaId,'mediaId');text(versionId,'versionId');digest(hash);ensure(Number.isSafeInteger(byteSize)&&byteSize>=0,'INVALID_SIZE','Invalid media size');ensure(['PRESENT','MISSING_HISTORY'].includes(availability),'INVALID_AVAILABILITY','Invalid availability');
  if(relativePath!==null&&relativePath!==undefined){text(relativePath,'relativePath');ensure(relativePath.startsWith('media/')&&!path.posix.isAbsolute(relativePath)&&!relativePath.includes('\\')&&!relativePath.split('/').some(x=>!x||x==='.'||x==='..'),'PATH_ESCAPE','Media must be inside instance media');}else ensure(availability==='MISSING_HISTORY','MEDIA_PATH_REQUIRED','Present media requires path');
  const old=await this.getMedia(mediaId,versionId);if(old)ensure(canonicalJson({relativePath:old.relativePath,sha256:old.sha256,byteSize:old.byteSize,availability:old.availability,metadata:old.metadata})===canonicalJson({relativePath:relativePath??null,sha256:hash,byteSize,availability,metadata}),'MEDIA_CONFLICT','Media cannot be overwritten');else{if(relativePath)ensure(!await this.one('SELECT 1 FROM media_versions WHERE relative_path=$1 AND sha256!=$2',[relativePath,hash]),'MEDIA_PATH_CONFLICT','Immutable path contains another hash');await this.run('INSERT INTO media_versions VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[mediaId,versionId,relativePath??null,hash,byteSize,availability,canonicalJson(metadata),now()]);await this.bump();}
  for(const alias of aliases){const r=await this.run('INSERT INTO media_aliases VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[text(alias,'alias'),mediaId,versionId]);if(r.rowCount)await this.bump();}return this.getMedia(mediaId,versionId);
 }
 async resetRuntimeEpoch(){this.assertWrite();await this.run('UPDATE repository_meta SET runtime_epoch=$1,repository_revision=repository_revision+1 WHERE singleton=1',[restoredRuntimeEpoch(randomUUID())]);return this.repositoryState();}
 async exportState(){
  const tables={};const order={repository_meta:'singleton',record_revisions:'namespace,record_key,revision_number',record_heads:'namespace,record_key',document_aliases:'alias',releases:'release_id',domain_events:'storage_sequence',media_versions:'media_id,version_id',media_aliases:'alias,media_id,version_id'};
  for(const table of BUSINESS_TABLES)tables[table]=(await this.all(`SELECT * FROM ${table} ORDER BY ${order[table]}`)).map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,Buffer.isBuffer(v)?{encoding:'base64',bytes:v.toString('base64')}:['repository_revision','storage_sequence','original_sequence','byte_size'].includes(k)&&v!==null?number(v):v])));
  const seq=await this.one('SELECT COALESCE(max(storage_sequence),0) AS n FROM domain_events');const body={schemaVersion:SCHEMA_VERSION,applicationId:APPLICATION_ID,instanceId:(await this.meta()).instance_id,tables,sequence:[{name:'domain_events',seq:number(seq.n)}],mediaIncluded:false};return {...body,exportSha256:canonicalSha256(body)};
 }
}
export class PostgresRepository {
 constructor(options){this.backend='postgres';this.instanceId=options.instanceId;this.options=options;this.readOnly=Boolean(options.readOnly||readOnlyProcess());this.pool=new pg.Pool({...options.connection,max:options.poolSize||8,idleTimeoutMillis:30000});this.pool.on('error',()=>{});}
 get inTransaction(){return contexts.getStore()?.repository===this;}
 get transactionMode(){const c=contexts.getStore();return c?.repository===this?(c.unit.writable?'WRITE':'READ'):null;}
 async _transaction(writable,callback){
  if(writable)ensure(!this.readOnly&&!readOnlyProcess(),'READ_ONLY','Repository cannot mutate');const current=contexts.getStore();if(current?.repository===this){ensure(!writable||current.unit.writable,'READ_ONLY_TRANSACTION','Cannot promote a read transaction');return callback(current.unit);}
  const context=mediaLeaseContexts.getStore(),lease=context?.repository===this?context:null;
  ensure(!lease?.transactionActive,'MEDIA_LEASE_PARALLEL_TRANSACTION','A leased connection permits only sequential top-level transactions');
  const client=lease?.client||await this.pool.connect();let failed=false;if(lease)lease.transactionActive=true;
  try{
   if(lease)await lease.assertHeld();
   await client.query(writable?'BEGIN ISOLATION LEVEL READ COMMITTED':'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   // Fail fast: a waiting SELECT in REPEATABLE READ could retain a pre-maintenance snapshot.
   if(!lease){const lock=await client.query('SELECT pg_try_advisory_xact_lock_shared($1::integer,$2::integer) AS held',mediaLockKeys(this.instanceId));ensure(lock.rows[0]?.held===true,'MEDIA_MAINTENANCE_BUSY','Media maintenance holds the instance lease');}
   if(writable)await client.query('SELECT singleton FROM repository_meta WHERE singleton=1 FOR UPDATE');
   const unit=new PgUnit(client,this,writable),m=await unit.meta();ensure(m?.instance_id===this.instanceId,'INSTANCE_MISMATCH','Database belongs to another instance');
   if(writable&&!lease?.exclusive)await assertMediaGateClosed(unit);
   const result=await contexts.run({repository:this,unit},()=>callback(unit));
   if(writable)ensure(!readOnlyProcess(),'READ_ONLY','Runtime became read-only');
   if(lease)await lease.assertHeld();await client.query('COMMIT');return result;
  }catch(error){try{await client.query('ROLLBACK');}catch{failed=true;if(lease)lease.lost=true;}throw error;}
  finally{if(lease)lease.transactionActive=false;else client.release(failed);}
 }
 async readTransaction(callback){return this._transaction(false,callback);}
 async writeTransaction(callback){return this._transaction(true,callback);}
 /** Host-only capability. A lease is NOT authorization to retire files. */
 async withMediaSessionLease(mode,callback){
  ensure(['SHARED','EXCLUSIVE'].includes(mode)&&typeof callback==='function','MEDIA_LEASE_INVALID','Explicit media lease mode and callback required');
  ensure(!this.inTransaction&&!mediaLeaseContexts.getStore(),'MEDIA_LEASE_NESTING','Acquire the media lease before any repository transaction');
  if(mode==='EXCLUSIVE')ensure(!this.readOnly&&!readOnlyProcess(),'READ_ONLY','Read-only repository cannot maintain media');
  const client=await this.pool.connect(),keys=mediaLockKeys(this.instanceId),exclusive=mode==='EXCLUSIVE';
  let acquired=false,failed=false;
  const lease={repository:this,client,exclusive,instanceId:this.instanceId,keys,transactionActive:false,lost:false,closed:false,assertHeld:null};
  const onError=()=>{lease.lost=true;};client.on('error',onError);
  lease.assertHeld=async()=>{
   ensure(acquired&&!lease.lost&&!lease.closed,'MEDIA_LEASE_LOST','Media lease connection was lost');
   const result=await client.query("SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted AND mode=$1 AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND classid::bigint=$2::bigint AND objid::bigint=$3::bigint AND objsubid=2) AS held",[exclusive?'ExclusiveLock':'ShareLock',keys[0]>>>0,keys[1]>>>0]);
   ensure(result.rows[0]?.held===true,'MEDIA_LEASE_LOST','Exact session advisory lease is no longer held');
  };
  try{
   const acquire=exclusive?'pg_try_advisory_lock':'pg_try_advisory_lock_shared';
   const result=await client.query(`SELECT ${acquire}($1::integer,$2::integer) AS held`,keys);
   acquired=result.rows[0]?.held===true;ensure(acquired,'MEDIA_MAINTENANCE_BUSY','Another media operation owns the lease');
   return await mediaLeaseContexts.run(lease,async()=>{
    if(!exclusive)await this.readTransaction(assertMediaGateClosed);
    // Callback may run several sequential BEGIN/COMMIT phases on this SAME client.
    const result=await callback(Object.freeze({exclusive,instanceId:this.instanceId,assertHeld:lease.assertHeld}));
    ensure(!lease.transactionActive,'MEDIA_LEASE_ACTIVE_TRANSACTION','Do not return with an unfinished transaction');
    await lease.assertHeld();return result;
   });
  }finally{
   if(lease.transactionActive){failed=true;try{await client.query('ROLLBACK');}catch{}}
   if(acquired&&!lease.lost){try{const unlock=exclusive?'pg_advisory_unlock':'pg_advisory_unlock_shared';const r=await client.query(`SELECT ${unlock}($1::integer,$2::integer) AS released`,keys);if(r.rows[0]?.released!==true)failed=true;}catch{failed=true;}}
   lease.closed=true;client.removeListener('error',onError);client.release(failed||lease.lost);
  }
 }
 async withMediaReadLease(callback){return this.withMediaSessionLease('SHARED',callback);}
 async withExclusiveMediaLease(callback){return this.withMediaSessionLease('EXCLUSIVE',callback);}
 async validateSchema(){const c=await this.pool.connect();try{const r=(await c.query('SELECT * FROM repository_schema WHERE singleton=1')).rows[0];ensure(r?.version===POSTGRES_SCHEMA_VERSION&&r?.application_id===APPLICATION_ID&&r.schema_sha256===sha256(POSTGRES_SCHEMA),'SCHEMA_MISMATCH','Unsupported PostgreSQL repository schema');const triggers=(await c.query("SELECT tgname,tgenabled FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace)")).rows;for(const name of [...['record_revisions','domain_events','releases','media_versions','document_aliases','media_aliases'].map(t=>`${t}_immutable`),'instance_identity_immutable'])ensure(triggers.some(t=>t.tgname===name&&t.tgenabled==='O'),'SCHEMA_DEFINITION_MISMATCH','Immutable guard missing');}finally{c.release();}}
 async integrityCheck(){await this.validateSchema();return this.readTransaction(async tx=>{const archive=await tx.exportState();validateArchive(archive,this.instanceId);await tx.readView();return {ok:true,instanceId:this.instanceId,schemaVersion:SCHEMA_VERSION,backend:'postgres'};});}
 async backupTo(target){ensure(!this.inTransaction,'ACTIVE_TRANSACTION','Backup must run outside transaction');const archive=await this.exportState();validateArchive(archive,this.instanceId);await mkdir(path.dirname(target),{recursive:true});const file=await writeArchiveFile(target,archive);return {path:target,...file,instanceId:this.instanceId,integrity:{ok:true,instanceId:this.instanceId,schemaVersion:SCHEMA_VERSION},mediaIncluded:false};}
 async close(){await this.pool.end();}
}
for(const method of ['getMetadata','getProjectionFingerprint','listRecordRevisions','getPublishedDocument','listPublishedDocumentMetadata','repositoryState','readView','getRecord','readDocument','readDocumentRevision','readRelease','listDocuments','getConfig','getProfile','getAux','listAux','listEvents','findIdempotentEvent','getMedia','listMedia','resolveMedia','exportState'])PostgresRepository.prototype[method]=async function(...args){return this.readTransaction(tx=>tx[method](...args));};
export async function openPostgresRepository(options){const repo=new PostgresRepository({...options,connection:await postgresConnection(options)});try{await repo.validateSchema();await repo.repositoryState();return repo;}catch(error){await repo.close();throw error;}}
async function emptySchema(connection,callback){const pool=new pg.Pool({...connection,max:1});const c=await pool.connect();try{await c.query('BEGIN');ensure(!(await c.query("SELECT 1 FROM pg_tables WHERE schemaname='public' LIMIT 1")).rowCount,'RESTORE_TARGET_EXISTS','Target PostgreSQL database must be empty');await c.query(POSTGRES_SCHEMA);await c.query('INSERT INTO repository_schema VALUES(1,$1,$2,$3)',[POSTGRES_SCHEMA_VERSION,APPLICATION_ID,sha256(POSTGRES_SCHEMA)]);await installQueryModel(new PgUnit(c,null,true));await callback(c);await c.query('COMMIT');}catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}finally{c.release();await pool.end();}}
export async function createPostgresRepository(options){ensure(!readOnlyProcess(),'READ_ONLY','Cannot create read-only repository');const connection=await postgresConnection(options);await emptySchema(connection,async c=>{await c.query('INSERT INTO repository_meta VALUES(1,$1,$2,0,NULL,$3)',[text(options.instanceId,'instanceId'),randomUUID(),now()]);const unit=new PgUnit(c,null,true);await unit.putConfig({configId:'instance-profile',value:options.profile,bytes:options.profileBytes,expectedRevisionId:null});});return openPostgresRepository({...options,connection});}
export function validateArchive(archive,instanceId){
 const {exportSha256,...body}=archive;ensure(digest(exportSha256)===canonicalSha256(body),'EXPORT_HASH_MISMATCH','Business archive changed');ensure(body.schemaVersion===SCHEMA_VERSION&&body.applicationId===APPLICATION_ID&&body.instanceId===instanceId,'INSTANCE_MISMATCH','Archive identity/schema mismatch');ensure(Object.keys(body.tables).sort().join(',')===[...BUSINESS_TABLES].sort().join(','),'EXPORT_TABLES_MISMATCH','Archive business table set differs');
 const decoded={};for(const table of BUSINESS_TABLES){ensure(Array.isArray(body.tables[table]),'EXPORT_TABLES_MISMATCH','Table must be array');decoded[table]=body.tables[table].map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>{if(v===null||typeof v!=='object')return [k,v];ensure(v.encoding==='base64'&&typeof v.bytes==='string'&&Buffer.from(v.bytes,'base64').toString('base64')===v.bytes,'EXPORT_BYTES_MISMATCH','Invalid base64');return [k,Buffer.from(v.bytes,'base64')];})));}
 const revisions=new Map(),heads=new Map();for(const r of [...decoded.record_revisions].sort((a,b)=>a.namespace.localeCompare(b.namespace)||a.record_key.localeCompare(b.record_key)||a.revision_number-b.revision_number)){ensure(sha256(r.content_bytes)===r.content_sha256,'INTEGRITY_FAILED','Record bytes mismatch');const key=canonicalJson([r.namespace,r.record_key]),p=heads.get(key);ensure(r.revision_number===(p?.revision_number??0)+1&&r.previous_revision_id===(p?.revision_id??null),'INTEGRITY_FAILED','Revision chain mismatch');heads.set(key,r);revisions.set(r.revision_id,r);}
 for(const h of decoded.record_heads){const key=canonicalJson([h.namespace,h.record_key]);ensure(heads.get(key)?.revision_id===h.revision_id,'INTEGRITY_FAILED','Head mismatch');heads.delete(key);}ensure(heads.size===0,'INTEGRITY_FAILED','Missing head');
 for(const e of decoded.domain_events){const p=parse(e.event_bytes);ensure(sha256(e.event_bytes)===e.event_sha256&&p.eventId===e.event_id&&(p.eventKind||p.eventType)===e.event_kind&&(p.idempotencyKeyHash||null)===e.idempotency_key_hash,'INTEGRITY_FAILED','Event bytes mismatch');}
 for(const r of decoded.releases){ensure(sha256(r.snapshot_bytes)===r.snapshot_sha256&&sha256(r.recipes_bytes)===r.recipes_sha256&&parse(r.snapshot_bytes).snapshotId===parse(r.recipes_bytes).snapshotId,'INTEGRITY_FAILED','Release bytes mismatch');ensure(revisions.has(r.profile_revision_id)&&JSON.parse(r.source_revision_ids_json).every(id=>revisions.has(id)),'INTEGRITY_FAILED','Release source binding missing');}
 ensure(decoded.repository_meta.length===1&&decoded.repository_meta[0].instance_id===instanceId,'INSTANCE_MISMATCH','Metadata identity mismatch');return decoded;
}
async function verifyImportedRepository(repo,expectedRowHashes){
 await repo.validateSchema();
 return repo.readTransaction(async tx=>{
  let restored=await tx.exportState();
  // All former final checks share ONE restored database snapshot and ONE export.
  validateArchive(restored,repo.instanceId);
  assertArchiveRowHashes(restored,expectedRowHashes);
  restored=null;
  await tx.readView();
  return Object.freeze({
   status:'POSTGRES_IMPORT_VERIFIED',metadata:Object.freeze(await tx.getMetadata()),
   originalBytesPreserved:true,businessIdsPreserved:true,
   integrity:Object.freeze({ok:true,instanceId:repo.instanceId,schemaVersion:SCHEMA_VERSION,backend:'postgres'})
  });
 });
}
export async function importPostgresState({archive,...options}){
 if(options.resetEpoch===false)throw new RepositoryError('RESTORE_EPOCH_REQUIRED','Archive import always requires a fresh restoration epoch');
 ensure(!readOnlyProcess(),'READ_ONLY','Cannot import read-only repository');
 let tables=validateArchive(archive,options.instanceId);
 const expectedRowHashes=archiveRowHashes(archive),connection=await postgresConnection(options);
 const high=Math.max(...(archive.sequence||[]).map(r=>number(r.seq)),...tables.domain_events.map(r=>number(r.storage_sequence)),0);
 // Neither the repository options nor an await-spanning closure retain the archive.
 archive=null;
 await emptySchema(connection,async c=>{
  for(const table of BUSINESS_TABLES){
   const allowed=(await c.query('SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position',['public',table])).rows.map(r=>r.column_name);
   for(const row of tables[table]){
    ensure(Object.keys(row).sort().join(',')===[...allowed].sort().join(','),'EXPORT_ROW_MISMATCH','Archive columns differ');
    await c.query(`INSERT INTO ${table}(${allowed.join(',')}) VALUES(${allowed.map((_,i)=>`$${i+1}`).join(',')})`,allowed.map(k=>row[k]));
   }
  }
  await c.query("SELECT setval(pg_get_serial_sequence('domain_events','storage_sequence'),$1,$2)",[Math.max(high,1),high>0]);
  await c.query('UPDATE repository_meta SET runtime_epoch=$1,repository_revision=repository_revision+1 WHERE singleton=1',[restoredRuntimeEpoch(randomUUID())]);
 });
 tables=null;
 const repo=await openPostgresRepository({...options,connection});
 try{
  await repo.writeTransaction(async tx=>{const release=await tx.readRelease();if(release)await rebuildQueryModel(tx,{releaseId:release.releaseId,snapshot:parse(release.snapshotBytes),recipes:parse(release.recipesBytes)});});
  const proof=await verifyImportedRepository(repo,expectedRowHashes);
  Object.defineProperty(repo,'importVerification',{value:proof,enumerable:false,writable:false,configurable:false});
  return repo;
 }catch(error){await repo.close().catch(()=>{});throw error;}
}
