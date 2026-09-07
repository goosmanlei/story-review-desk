import { AsyncLocalStorage } from 'node:async_hooks';
/**
 * PostgreSQL instance media retirement. Consumer overlays preserve immutable history.
 * No I/O occurs at import. Only inspect()/verifyQuarantine()/reconcile() are reads.
 *
 * Instantiate with the real repository and an explicit canonical instanceRoot.
 * Mutation requires BOTH trusted integrationGuard and withExclusiveMediaLease
 * adapters, plus an authorize adapter that validates the user's exact action,
 * manifestHash, targetSetHash and (for purge) quarantine verification hash.
 * Never expose these callbacks or a `true` override to a browser request.
 *
 * The repository's writeTransaction locks repository_meta FOR UPDATE; all normal
 * tx writes therefore serialize with the final reference check and filesystem
 * operation. The external lease MUST additionally cover generators/importers,
 * file readers/exports/backups and other filesystem writers. A DB lock alone
 * cannot exclude a generator that writes bytes before registering its result.
 *
 * An immutable INTENT is committed before filesystem effects. A crash after an
 * effect but before its receipt is NOT retried: replay returns RESULT_UNKNOWN
 * and reconcile() reports the observed locations. Recovery is an explicit
 * operator task, never an inferred successful purge or a blind second unlink.
 *
 * IMPORTANT: existing cleanup-candidates.json is a discovery report, not an
 * authorization. Its exact old audit-reference revisions can be exemptions;
 * new/changed current records, including new preparation/directory auxiliaries,
 * are protecting references by default. All exempted bytes are re-read and
 * SHA-checked. Known active inputs always override an audit exemption.
 */
import path from 'node:path';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import * as nodeFs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';

export const RETIREMENT_NAMESPACES=Object.freeze({
  plans:'media-retirement-plans', requests:'media-retirement-requests',
  journal:'media-retirement-journal', tombstones:'media-retirement-tombstones',
  claims:'media-retirement-claims',
});
const ownNamespaces=new Set(Object.values(RETIREMENT_NAMESPACES).map(n=>'aux:'+n));
const sha=x=>createHash('sha256').update(x).digest('hex');
const canonical=x=>JSON.stringify(normalize(x));
function normalize(x){
  if(Array.isArray(x))return x.map(normalize);
  if(x&&typeof x==='object'&&!Buffer.isBuffer(x))return Object.fromEntries(Object.keys(x).sort().filter(k=>x[k]!==undefined).map(k=>[k,normalize(x[k])]));
  return x;
}
const read=r=>r?JSON.parse(Buffer.from(r.bytes).toString('utf8')):null;
const fail=(code,message,details)=>{throw Object.assign(new Error(message),{code,...(details?{details}:{})});};
const requireThat=(ok,code,message,details)=>{if(!ok)fail(code,message,details);};
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const now=()=>new Date().toISOString();
const reqKey=id=>sha(id);
const targetKey=t=>sha(t.instanceRelativePath);
const phaseRank={QUARANTINE_INTENT:10,QUARANTINED:20,PURGE_INTENT:30,PURGED:40};

export function manifestHash(manifest){return sha(canonical(manifest));}
/** Matches the hash schema explicitly recorded in cleanup-candidates.json. */
export function targetSetHash(manifest){
  return sha(JSON.stringify(manifest.targets.map(t=>({path:t.instanceRelativePath,sha256:t.sha256,byteSize:t.byteSize,
    registrations:t.registrations.map(r=>({mediaId:r.mediaId,versionId:r.versionId}))}))));
}
function relative(value,{quarantine=false}={}){
  requireThat(typeof value==='string'&&value.startsWith('media/')&&!path.posix.isAbsolute(value)
    &&!/[\\\u0000-\u001f%?#]/.test(value)&&!value.split('/').some(p=>!p||p==='.'||p==='..'),
  'RETIREMENT_PATH','Only normalized instance media paths are allowed');
  if(!quarantine)requireThat(!value.startsWith('media/.retirement/'),'RETIREMENT_PATH','A quarantine file cannot be a new original target');
  return value;
}
function validateManifest(m,expected){
  requireThat(m?.recordKind==='INSTANCE_PRODUCTION_MEDIA_CLEANUP_CANDIDATES'&&m.schemaVersion==='1.0',
    'RETIREMENT_MANIFEST','Unsupported candidate manifest');
  requireThat(typeof m.instanceId==='string'&&m.instanceId&&typeof m.baseReleaseId==='string'&&m.baseReleaseId,
    'RETIREMENT_MANIFEST','Manifest must bind instance and published release');
  requireThat(Array.isArray(m.targets)&&m.targets.length>0&&m.targets.length<=1000,'RETIREMENT_MANIFEST','Explicit bounded targets required');
  const paths=new Set(),ids=new Set();
  for(const t of m.targets){
    relative(t.instanceRelativePath);
    requireThat(typeof t.targetId==='string'&&!ids.has(t.targetId)&&!paths.has(t.instanceRelativePath),
      'RETIREMENT_MANIFEST','Duplicate or missing target identity');
    ids.add(t.targetId);paths.add(t.instanceRelativePath);
    requireThat(hex(t.sha256)&&Number.isSafeInteger(t.byteSize)&&t.byteSize>=0&&Array.isArray(t.registrations)&&t.registrations.length>0,
      'RETIREMENT_MANIFEST','Every target needs exact SHA, size and complete registrations');
    requireThat(t.proposedAction==='QUARANTINE_CANDIDATE_ONLY'&&t.classification==='FULL_PRODUCTION_HISTORICAL_MEDIA'
      &&Array.isArray(t.protectReasons)&&t.protectReasons.length===0,'RETIREMENT_PROTECTED','Manifest contains a protected or unclassified file');
    requireThat(t.fileIdentity&&t.fileIdentity.sha256===t.sha256&&t.fileIdentity.size===t.byteSize&&t.fileIdentity.nlink===1
      &&Number.isSafeInteger(t.fileIdentity.dev)&&Number.isSafeInteger(t.fileIdentity.ino)&&Number.isFinite(t.fileIdentity.mtimeMs),
      'RETIREMENT_MANIFEST','Manifest file identity must have been verified without hardlinks');
    for(const r of t.registrations)requireThat(typeof r.mediaId==='string'&&r.mediaId&&typeof r.versionId==='string'&&r.versionId
      &&r.sha256===t.sha256&&Array.isArray(r.aliases),'RETIREMENT_MANIFEST','Invalid shared media registration');
  }
  const mh=manifestHash(m),th=targetSetHash(m);
  requireThat(hex(expected?.expectedManifestHash)&&mh===expected.expectedManifestHash,'RETIREMENT_MANIFEST_CAS','Manifest bytes/structure changed');
  requireThat(hex(expected?.expectedTargetSetHash)&&th===expected.expectedTargetSetHash&&m.targetSetHash===th,
    'RETIREMENT_TARGET_CAS','Exact target set changed');
  requireThat(expected?.expectedReleaseId===m.baseReleaseId,'RETIREMENT_RELEASE_CAS','Expected release differs from manifest');
  return {manifestHash:mh,targetSetHash:th,planId:'retirement_'+mh};
}
function registrationIdentity(r){return {mediaId:r.mediaId,versionId:r.versionId,sha256:r.sha256,aliases:[...(r.aliases||[])].sort()};}
function registrationClosure(rows){return rows.map(registrationIdentity).sort((a,b)=>(a.mediaId+'\0'+a.versionId).localeCompare(b.mediaId+'\0'+b.versionId));}
function tokensFor(t){return [...new Set([t.instanceRelativePath,t.sha256,...t.registrations.flatMap(r=>[r.mediaId,r.versionId,...r.aliases])])];}
function isSourceMedia(m){
  const md=m.metadata||{};
  // The migration also registers generated historical outputs as source-artifact.
  // That name does not turn a discarded storyboard into an original recording.
  const importedHistoricalOutput=m.mediaId.startsWith('source-artifact:')&&md.sourceRole==='HISTORICAL_EVIDENCE'
    &&md.role==='HISTORICAL_EVIDENCE'&&md.evidenceOnly===true;
  return Boolean(md.originalMediaId||md.originalVersionId||md.originalSha256||(md.sourceRole&&!importedHistoricalOutput));
}

/** A read-only live closure. Uses current aux heads automatically, not a fixed UI namespace list. */
export async function inspectLiveReferences(tx,manifest){
  requireThat(tx.backend==='postgres'&&typeof tx.all==='function','RETIREMENT_BACKEND','PostgreSQL tx is required');
  const view=await tx.readView(),model=view.snapshot?.productionModel;
  requireThat(view.instanceId===manifest.instanceId&&view.releaseId===manifest.baseReleaseId&&model,
    'RETIREMENT_RELEASE_CAS','Instance or exact published release changed');
  const media=await tx.listMedia(),required=(model.materialRequirements||[]).filter(r=>r.requirementClass==='REQUIRED');
  const reqIds=new Set(required.map(r=>r.id)),retainedFamilies=new Set(required.flatMap(r=>[...(r.assetFamilyRefs||[]),r.plannedAssetFamilyId].filter(Boolean)));
  const targets=manifest.targets,map=new Map(),longTokens=[];
  for(let i=0;i<targets.length;i++)for(const token of tokensFor(targets[i])){const set=map.get(token)||new Set();set.add(i);map.set(token,set);}
  for(const token of map.keys())if(token.length>=8)longTokens.push(token);
  const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const matcher=new RegExp(longTokens.sort((a,b)=>b.length-a.length).map(escape).join('|'),'g');
  const findings=targets.map(()=>[]),auditMap=new Map();
  for(const entry of Object.values(manifest.referenceCatalog||{}))if(entry.protect===false&&hex(entry.sha256))auditMap.set(entry.id,entry);
  let referencesScanned=0,bytesScanned=0;
  function scan(id,value,{protect=true,reason='CURRENT_REFERENCE',revisionId=null,contentHash=null}={}){
    referencesScanned++;const matches=new Map();
    function match(s,pointer){
      const direct=map.get(s);
      // Most fields are labels/booleans, not media identities. Avoid applying a
      // large path/version alternation to every Chinese sentence in the release.
      if(!direct&&!/[\/@]|[a-f0-9]{64}|P07-|EVIDENCE-|source-artifact:/i.test(s))return;
      const indices=new Set(direct||[]);matcher.lastIndex=0;
      for(const hit of s.matchAll(matcher))for(const n of map.get(hit[0])||[])indices.add(n);
      for(const n of indices){const a=matches.get(n)||[];a.push(pointer);matches.set(n,a);}
    }
    function visit(v,pointer='',depth=0){
      requireThat(depth<=64,'RETIREMENT_REFERENCE_LIMIT','Reference nesting exceeds safe scanner limit');
      if(typeof v==='string'){
        bytesScanned+=Buffer.byteLength(v);requireThat(bytesScanned<=256*1024*1024,'RETIREMENT_REFERENCE_LIMIT','Reference scan exceeds bounded limit');
        match(v,pointer);
        if(depth<12&&/^[\[{]/.test(v.trim())){let nested;try{nested=JSON.parse(v);}catch{}if(nested&&typeof nested==='object')visit(nested,pointer+'/$decoded',depth+1);}
      }else if(Array.isArray(v))v.forEach((e,i)=>visit(e,pointer+'/'+i,depth+1));
      else if(v&&typeof v==='object')for(const [k,e]of Object.entries(v))visit(e,pointer+'/'+k.replace(/~/g,'~0').replace(/\//g,'~1'),depth+1);
    }
    visit(value);
    for(const [n,pointers] of matches)findings[n].push({referenceId:id,revisionId,sha256:contentHash,protect,reason,pointerCount:pointers.length,pointers:[...new Set(pointers)].sort()});
  }
  for(const t of targets){
    const current=media.filter(m=>m.relativePath===t.instanceRelativePath);
    requireThat(canonical(registrationClosure(current))===canonical(registrationClosure(t.registrations)),
      'RETIREMENT_REGISTRATION_CAS','Shared registration or aliases changed',{targetId:t.targetId});
    requireThat(current.every(m=>m.sha256===t.sha256&&m.byteSize===t.byteSize&&m.availability==='PRESENT'),
      'RETIREMENT_REGISTRATION_CAS','Immutable media facts differ',{targetId:t.targetId});
    requireThat(current.every(m=>!retainedFamilies.has(m.mediaId)&&m.metadata?.authorityDomain!=='LOCAL_TRIAL'
      &&!isSourceMedia(m)&&!m.metadata?.private),
      'RETIREMENT_PROTECTED','Target is a retained material, trial, source or private media',{targetId:t.targetId});
    const evidence=t.membershipEvidence;
    const familyEvidence=(evidence?.matchedProductionFamilyIds||[]).some(id=>(model.assetFamilies||[]).some(f=>f.id===id
      &&!retainedFamilies.has(id)&&f.historyRole==='EVIDENCE_ONLY'&&f.currentVersionId==null&&(/^D\d+$|^P07-/.test(id)||f.subtype==='STORYBOARD')));
    const aliasEvidence=current.some(m=>m.aliases.some(a=>(evidence?.matchedLogicalAliases||[]).includes(a)
      &&/P07_storyboards|\/storyboards\/|\/storyboard-contact-sheets\/|\/media\/audio\/d\d\d-/.test(a)));
    requireThat(familyEvidence||aliasEvidence,'RETIREMENT_MEMBERSHIP','Production retirement ownership is no longer proved',{targetId:t.targetId});
  }
  // Semantic consumers override any exact historical reference exemption.
  for(const r of required)scan('active-requirement:'+r.id,r,{reason:'REQUIRED_MATERIAL'});
  for(const d of view.recipes?.executionDefinitions||[])if(reqIds.has(d.materialRequirementRef))scan('active-definition:'+d.id,d,{reason:'ACTIVE_MATERIAL_RECIPE'});
  for(const v of model.assetVersions||[])if(retainedFamilies.has(v.familyId))scan('retained-version:'+v.id,v,{reason:'RETAINED_MATERIAL_VERSION'});
  for(const m of media)if(retainedFamilies.has(m.mediaId)||m.metadata?.authorityDomain==='LOCAL_TRIAL'||isSourceMedia(m))
    scan('retained-media:'+m.mediaId+':'+m.versionId,m,{reason:'RETAINED_MEDIA_OR_SOURCE'});
  for(const r of model.productionReferences||[])scan('production-reference:'+r.id,r,{reason:'PRODUCTION_REFERENCE'});
  for(const o of model.expectedOutputs||[])if(!(o.scopeRole==='HISTORICAL'&&o.historyRole==='EVIDENCE_ONLY'
    &&o.activityRole==='HISTORICAL_EVIDENCE'&&o.countsTowardCurrent===false&&o.canFlowDownstream===false
    &&o.executionAllowed===false&&o.generationAllowed===false))scan('active-expected-output:'+o.id,o,{reason:'CURRENT_EXPECTED_OUTPUT'});
  for(const f of model.assetFamilies||[])if(f.currentVersionId&&f.historyRole!=='EVIDENCE_ONLY')scan('active-family:'+f.id,f,{reason:'CURRENT_FAMILY'});
  for(const w of [...(model.workItems||[]),...(model.materialWorkItems||[])])if(w.historyRole!=='EVIDENCE_ONLY'&&w.activityRole!=='HISTORICAL_EVIDENCE'&&w.lifecycleState!=='EVIDENCE_ONLY')
    scan('active-work:'+w.id,w,{reason:'CURRENT_WORK_INPUT'});
  for(const [kind,events] of Object.entries(view.eventsByKind||{}))for(const e of events){
    const state=e.requestState||e.status||e.lifecycleState;
    if(['run','execution-request','asset-version'].includes(kind)&&(retainedFamilies.has(e.familyId||e.assetFamilyId)
      ||['QUEUED','AUTHORIZED','RUNNING','RESULT_UNKNOWN'].includes(state)))scan('active-event:'+e.eventId,e,{reason:'ACTIVE_OR_UNRESOLVED_EXECUTION'});
  }
  const rows=await tx.all(`SELECT r.namespace,r.record_key,r.revision_id,r.content_sha256,r.content_bytes,r.metadata_json
    FROM record_revisions r LEFT JOIN record_heads h ON h.namespace=r.namespace AND h.record_key=r.record_key
    WHERE r.deleted=0 AND (h.revision_id=r.revision_id OR r.revision_id=ANY($1::text[])) ORDER BY r.revision_id`,[view.sourceRevisionIds||[]]);
  for(const r of rows){
    if(ownNamespaces.has(r.namespace))continue;
    requireThat(sha(r.content_bytes)===r.content_sha256,'RETIREMENT_SOURCE_INTEGRITY','Database revision bytes differ from SHA');
    const id='record:'+r.revision_id,exempt=auditMap.get(id),metadata=JSON.parse(r.metadata_json);
    const alwaysProtect=r.namespace.startsWith('aux:production-preparation')||r.namespace.startsWith('aux:material-directory')
      ||r.namespace.startsWith('aux:entity-material')||r.namespace.startsWith('aux:local-trial:')
      ||r.namespace==='aux:domain-sources'||Boolean(metadata.originalMediaId||metadata.originalSha256);
    const isAudit=!alwaysProtect&&exempt?.sha256===r.content_sha256&&exempt.kind==='DATABASE_RECORD_REVISION'
      &&exempt.role?.namespace===r.namespace&&exempt.role?.key===r.record_key&&exempt.role?.classification==='AUDIT_ONLY_REFERENCE';
    let value;try{value=JSON.parse(r.content_bytes);}catch{value=r.content_bytes.toString('utf8');}
    scan(id,value,{protect:!isAudit,reason:isAudit?'EXACT_IMMUTABLE_AUDIT_REVISION':'CURRENT_SOURCE_OR_AUX_HEAD',revisionId:r.revision_id,contentHash:r.content_sha256});
  }
  for(const [key,value] of Object.entries(model)){
    const id='model:'+key,digest=sha(JSON.stringify(value)),exempt=auditMap.get(id);
    scan(id,value,{protect:exempt?.sha256!==digest,reason:exempt?.sha256===digest?'EXACT_COMPATIBILITY_SECTION':'CHANGED_MODEL_REFERENCE',contentHash:digest});
  }
  const targetResults=targets.map((t,i)=>({targetId:t.targetId,references:findings[i].sort((a,b)=>a.referenceId.localeCompare(b.referenceId)),
    protectReasons:[...new Set(findings[i].filter(f=>f.protect).map(f=>f.reason))]}));
  const closure={instanceId:view.instanceId,releaseId:view.releaseId,snapshotId:view.snapshot.snapshotId,
    graphRef:model.domainGraphRef||null,targets:targetResults};
  return {...closure,closureHash:sha(canonical(closure)),referencesScanned,bytesScanned,
    safe:targetResults.every(t=>t.protectReasons.length===0)};
}

async function canonicalRoot(fs,root,instanceId){
  requireThat(typeof root==='string'&&path.isAbsolute(root)&&path.resolve(root)!==path.parse(root).root,'RETIREMENT_ROOT','Explicit non-root instance path required');
  const resolved=path.resolve(root),s=await fs.lstat(resolved);
  requireThat(s.isDirectory()&&!s.isSymbolicLink()&&await fs.realpath(resolved)===resolved,'RETIREMENT_ROOT','Instance root must be canonical');
  const bootstrap=path.join(resolved,'instance.json'),bs=await fs.lstat(bootstrap);
  requireThat(bs.isFile()&&!bs.isSymbolicLink()&&bs.size<65536,'RETIREMENT_ROOT','Invalid instance bootstrap');
  requireThat(JSON.parse(await fs.readFile(bootstrap,'utf8')).instanceId===instanceId,'RETIREMENT_INSTANCE','Instance bootstrap identity differs');
  const ms=await fs.lstat(path.join(resolved,'media'));
  requireThat(ms.isDirectory()&&!ms.isSymbolicLink()&&await fs.realpath(path.join(resolved,'media'))===path.join(resolved,'media'),
    'RETIREMENT_ROOT','Media root must be canonical');
  return resolved;
}
async function safePath(fs,root,name,{mayBeMissing=false}={}){
  relative(name,{quarantine:name.startsWith('media/.retirement/')});let at=root;
  const parts=name.split('/');
  for(let i=0;i<parts.length;i++){
    at=path.join(at,parts[i]);let st;
    try{st=await fs.lstat(at);}catch(e){if(e.code==='ENOENT'&&mayBeMissing&&i===parts.length-1)return at;throw e;}
    requireThat(!st.isSymbolicLink()&&(i===parts.length-1||st.isDirectory()),'RETIREMENT_SYMLINK','Media path contains a symlink or non-directory');
    requireThat(await fs.realpath(at)===at,'RETIREMENT_PATH','Media path resolved outside its canonical identity');
  }
  return at;
}
const statIdentity=s=>({dev:s.dev,ino:s.ino,nlink:s.nlink,size:s.size,mtimeMs:s.mtimeMs});
function sameIdentity(a,b,{links=true}={}){return ['dev','ino','size','mtimeMs',...(links?['nlink']:[])].every(k=>a[k]===b[k]);}
async function hashStableFile(fs,root,name,{expected=null,allowedLinks=1,allowMissing=false}={}){
  let filename;
  try{filename=await safePath(fs,root,name);}catch(e){if(e.code==='ENOENT'&&allowMissing)return null;throw e;}
  let handle;
  try{
    handle=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
    const before=await handle.stat();requireThat(before.isFile()&&before.nlink===allowedLinks,'RETIREMENT_FILE_IDENTITY','Target is not a regular file with expected link count');
    const h=createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024);let offset=0;
    while(true){const {bytesRead}=await handle.read(buffer,0,buffer.length,offset);if(!bytesRead)break;h.update(buffer.subarray(0,bytesRead));offset+=bytesRead;}
    const after=await handle.stat(),entry=await fs.lstat(filename);
    requireThat(!entry.isSymbolicLink()&&sameIdentity(statIdentity(before),statIdentity(after))&&sameIdentity(statIdentity(after),statIdentity(entry)),
      'RETIREMENT_FILE_CHANGED','File changed while hashing');
    const result={relativePath:name,...statIdentity(after),sha256:h.digest('hex')};
    if(expected)requireThat(result.sha256===expected.sha256&&result.size===(expected.size??expected.byteSize)
      &&(expected.dev===undefined||sameIdentity(result,expected,{links:false})),
    'RETIREMENT_FILE_CAS','File identity, size or SHA differs from the exact target',{relativePath:name});
    return result;
  }finally{await handle?.close();}
}
async function assertAbsent(fs,root,name){
  try{await safePath(fs,root,name);fail('RETIREMENT_PATH_OCCUPIED','A path expected to be absent exists',{relativePath:name});}
  catch(e){if(e.code!=='ENOENT')throw e;}
}
async function syncDirectory(fs,directory){const h=await fs.open(directory,constants.O_RDONLY);try{await h.sync();}finally{await h.close();}}
function quarantinePath(plan,t){return 'media/.retirement/'+plan.planId+'/'+targetKey(t)+path.posix.extname(t.instanceRelativePath);}
async function privateDirectory(fs,root,relativeDir){
  let at=root;
  for(const segment of relativeDir.split('/')){
    at=path.join(at,segment);try{await fs.mkdir(at,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
    const st=await fs.lstat(at);requireThat(st.isDirectory()&&!st.isSymbolicLink()&&await fs.realpath(at)===at,'RETIREMENT_PATH','Unsafe quarantine directory');
    if(segment!== 'media')requireThat((st.mode&0o077)===0,'RETIREMENT_PERMISSIONS','Quarantine directory must be private');
  }
  return at;
}
async function append(tx,namespace,key,value){
  const existing=await tx.getAux(namespace,key);
  if(existing){requireThat(canonical(read(existing))===canonical(value),'RETIREMENT_RECORD_CONFLICT','Immutable retirement record has different content');return existing;}
  return tx.putAux({namespace,key,bytes:canonical(value),expectedRevisionId:null,mediaType:'application/json',metadata:{recordRole:'IMMUTABLE_MEDIA_RETIREMENT_EVIDENCE'}});
}
async function loadPlan(tx,planId){
  const record=await tx.getAux(RETIREMENT_NAMESPACES.plans,planId),plan=read(record);
  requireThat(plan&&plan.planId===planId&&manifestHash(plan.manifest)===plan.manifestHash&&targetSetHash(plan.manifest)===plan.targetSetHash,
    'RETIREMENT_PLAN_MISSING','Immutable retirement plan is missing or corrupt');
  return {...plan,recordRevisionId:record.revisionId};
}
async function stateOf(tx,planId){
  const rows=(await tx.listAux(RETIREMENT_NAMESPACES.journal,{prefix:planId+':'})).map(read);
  return rows.sort((a,b)=>a.sequence-b.sequence);
}
async function appendStage(tx,plan,operation,phase,files){
  const journal=await stateOf(tx,plan.planId),sequence=(journal.at(-1)?.sequence||0)+1;
  const event={schemaVersion:'1.0',planId:plan.planId,operationId:operation.operationId,action:operation.action,phase,sequence,
    instanceId:plan.instanceId,manifestHash:plan.manifestHash,targetSetHash:plan.targetSetHash,recordedAt:now(),files};
  await append(tx,RETIREMENT_NAMESPACES.journal,plan.planId+':'+String(sequence).padStart(8,'0'),event);
  if(phaseRank[phase])for(const t of plan.manifest.targets)await append(tx,RETIREMENT_NAMESPACES.tombstones,
    targetKey(t)+':'+String(phaseRank[phase]).padStart(3,'0')+':'+operation.operationId,
    {schemaVersion:'1.0',planId:plan.planId,operationId:operation.operationId,phase,sequence,recordedAt:event.recordedAt,
      originalRelativePath:t.instanceRelativePath,quarantineRelativePath:quarantinePath(plan,t),sha256:t.sha256,byteSize:t.byteSize,
      registrations:t.registrations.map(registrationIdentity),manifestHash:plan.manifestHash,targetSetHash:plan.targetSetHash,
      fileFact:files?.find(f=>f.targetId===t.targetId)||null});
  return event;
}

/** Read overlay: old media_versions/ReviewEvents/SHAs are never overwritten. */
export async function mediaRetirementOverlay(tx,media){
  if(!media?.relativePath)return {state:'ACTIVE',media};
  const rows=(await tx.listAux(RETIREMENT_NAMESPACES.tombstones,{prefix:sha(media.relativePath)+':'})).map(read)
    .filter(r=>r.originalRelativePath===media.relativePath&&r.sha256===media.sha256
      &&r.registrations.some(b=>b.mediaId===media.mediaId&&b.versionId===media.versionId&&b.sha256===media.sha256));
  if(!rows.length)return {state:'ACTIVE',media};
  rows.sort((a,b)=>(phaseRank[b.phase]||0)-(phaseRank[a.phase]||0)||b.sequence-a.sequence);
  const tombstone=rows[0],state=tombstone.phase==='PURGED'?'PURGED':tombstone.phase==='QUARANTINED'?'QUARANTINED':'RESULT_PENDING';
  return {state,media,tombstone,serveOriginal:false};
}
export async function resolveActiveMedia(tx,alias,binding){
  const media=await tx.resolveMedia(alias,binding);if(!media)return null;
  const overlay=await mediaRetirementOverlay(tx,media);
  if(overlay.state!=='ACTIVE')fail(overlay.state==='PURGED'?'MEDIA_PURGED':'MEDIA_RETIRED',
    'This exact media version has been retired; original history is retained',{state:overlay.state,planId:overlay.tombstone.planId,httpStatus:overlay.state==='RESULT_PENDING'?409:410});
  return media;
}
export async function activeMediaForExport(tx,rows=undefined){
  const output=[];for(const m of rows||await tx.listMedia())if((await mediaRetirementOverlay(tx,m)).state==='ACTIVE')output.push(m);return output;
}
/** Backup/restore must retain archive tables unchanged and bind this physical overlay separately. */
export async function retirementAwareMediaManifest(tx,rows=undefined){
  const files=new Map(),retired=[];
  for(const m of rows||await tx.listMedia()){
    const o=await mediaRetirementOverlay(tx,m);
    if(o.state==='RESULT_PENDING')fail('RETIREMENT_RESULT_UNKNOWN','Backup/export must wait for retirement reconciliation');
    if(o.state!=='ACTIVE')retired.push({mediaId:m.mediaId,versionId:m.versionId,sha256:m.sha256,state:o.state,tombstone:o.tombstone});
    if(o.state==='PURGED'||m.availability!=='PRESENT')continue;
    const name=o.state==='QUARANTINED'?o.tombstone.quarantineRelativePath:m.relativePath;
    const file={path:name,sha256:m.sha256,bytes:m.byteSize};
    if(files.has(name))requireThat(canonical(files.get(name))===canonical(file),'RETIREMENT_MANIFEST_CONFLICT','Shared physical backup path differs');
    files.set(name,file);
  }
  return {schemaVersion:'1.0',files:[...files.values()].sort((a,b)=>a.path.localeCompare(b.path)),retired,
    archiveMediaVersionsUnmodified:true,restoreRequiresRetirementOverlay:true};
}

export function createMediaRetirement({repository,instanceRoot,fs=nodeFs,authorize,integrationGuard,withExclusiveMediaLease}={}){
  requireThat(repository?.backend==='postgres','RETIREMENT_BACKEND','PostgreSQL repository required');
  async function inspect(manifest,expected){
    const binding=validateManifest(manifest,expected),root=await canonicalRoot(fs,instanceRoot,manifest.instanceId);
    return repository.readTransaction(async tx=>{
      const closure=await inspectLiveReferences(tx,manifest),files=[];
      for(const t of manifest.targets)files.push({targetId:t.targetId,...await hashStableFile(fs,root,t.instanceRelativePath,{expected:t.fileIdentity})});
      const body={...binding,instanceId:manifest.instanceId,releaseId:manifest.baseReleaseId,closureHash:closure.closureHash,files};
      return {...body,safe:closure.safe,verificationHash:sha(canonical(body)),closure};
    });
  }
  async function registerPlan(manifest,expected){
    const result=await inspect(manifest,expected);requireThat(result.safe,'RETIREMENT_PROTECTED','Current references protect one or more targets',result.closure.targets.filter(t=>t.protectReasons.length));
    return repository.writeTransaction(async tx=>{
      const closure=await inspectLiveReferences(tx,manifest);requireThat(closure.safe&&closure.closureHash===result.closureHash,'RETIREMENT_CLOSURE_CAS','References changed during plan registration');
      const existing=await tx.getAux(RETIREMENT_NAMESPACES.plans,result.planId);if(existing){const saved=read(existing);requireThat(saved.manifestHash===result.manifestHash,'RETIREMENT_PLAN_CAS','Plan identity conflict');return {planId:saved.planId,revisionId:existing.revisionId,replayed:true};}
      const plan={schemaVersion:'1.0',planId:result.planId,instanceId:manifest.instanceId,manifestHash:result.manifestHash,targetSetHash:result.targetSetHash,
        baseReleaseId:manifest.baseReleaseId,initialClosureHash:result.closureHash,initialVerificationHash:result.verificationHash,createdAt:now(),manifest:structuredClone(manifest)};
      const record=await append(tx,RETIREMENT_NAMESPACES.plans,plan.planId,plan);return {planId:plan.planId,revisionId:record.revisionId,replayed:false};
    });
  }
  async function checkPlanBinding(tx,input){
    const plan=await loadPlan(tx,input.planId),meta=await tx.getMetadata();
    requireThat(meta.instanceId===plan.instanceId&&meta.releaseId===input.expectedReleaseId&&meta.releaseId===plan.baseReleaseId,
      'RETIREMENT_RELEASE_CAS','Exact instance release changed');
    requireThat(input.expectedPlanRevisionId===plan.recordRevisionId&&input.expectedManifestHash===plan.manifestHash&&input.expectedTargetSetHash===plan.targetSetHash,
      'RETIREMENT_PLAN_CAS','Immutable plan revision or manifest changed');
    return plan;
  }
  async function quarantineVerification(tx,plan,root){
    const stages=await stateOf(tx,plan.planId);
    requireThat(stages.at(-1)?.phase==='QUARANTINED','RETIREMENT_NOT_QUARANTINED','A committed quarantine receipt is required');
    const closure=await inspectLiveReferences(tx,plan.manifest);requireThat(closure.safe,'RETIREMENT_PROTECTED','New current input protects quarantined media');
    const files=[];
    for(const t of plan.manifest.targets){await assertAbsent(fs,root,t.instanceRelativePath);files.push({targetId:t.targetId,...await hashStableFile(fs,root,quarantinePath(plan,t),{expected:t.fileIdentity})});}
    const body={planId:plan.planId,planRevisionId:plan.recordRevisionId,manifestHash:plan.manifestHash,targetSetHash:plan.targetSetHash,
      releaseId:plan.baseReleaseId,closureHash:closure.closureHash,quarantineReceiptSequence:stages.at(-1).sequence,files};
    return {...body,verificationHash:sha(canonical(body)),safe:true};
  }
  async function verifyQuarantine(input){return repository.readTransaction(async tx=>{const plan=await checkPlanBinding(tx,input),root=await canonicalRoot(fs,instanceRoot,plan.instanceId);return quarantineVerification(tx,plan,root);});}
  async function replay(tx,input,action){
    const previous=read(await tx.getAux(RETIREMENT_NAMESPACES.requests,reqKey(input.requestId)));if(!previous)return null;
    requireThat(previous.requestHash===sha(canonical({action,input})),'RETIREMENT_IDEMPOTENCY','Request ID was used with different content');
    const stages=(await stateOf(tx,previous.planId)).filter(s=>s.operationId===previous.operationId),last=stages.at(-1);
    return {replayed:true,operationId:previous.operationId,planId:previous.planId,
      status:!last||last.phase.endsWith('_INTENT')?'RESULT_UNKNOWN':last.phase,receipt:last||null,retryPerformed:false};
  }
  async function mutate(action,input){
    requireThat(typeof input?.requestId==='string'&&input.requestId.length>=8&&input.requestId.length<=200,'RETIREMENT_REQUEST','Explicit stable request identity required');
    const prior=await repository.readTransaction(tx=>replay(tx,input,action));if(prior)return prior;
    requireThat(typeof authorize==='function'&&typeof integrationGuard==='function'&&typeof withExclusiveMediaLease==='function',
      'RETIREMENT_NOT_INTEGRATED','Mutation requires authorization, integrated consumers and a shared exclusive media lease');
    const readiness=await integrationGuard();
    requireThat(['resolver','hostedExport','backupRestore','writersUseSameLease'].every(k=>readiness?.[k]===true),
      'RETIREMENT_NOT_INTEGRATED','Resolver, exports, backups/restores and writers must support retirement before mutation');
    return withExclusiveMediaLease(async lease=>{
      requireThat(lease?.exclusive===true&&typeof lease.assertHeld==='function','RETIREMENT_LEASE','Exclusive writer lease unavailable');
      await lease.assertHeld();
      const plan=await repository.readTransaction(tx=>checkPlanBinding(tx,input));
      requireThat(lease.instanceId===plan.instanceId,'RETIREMENT_LEASE','Lease belongs to another instance');
      const root=await canonicalRoot(fs,instanceRoot,plan.instanceId);
      const auth=await authorize({action,requestId:input.requestId,instanceId:plan.instanceId,manifestHash:plan.manifestHash,
        targetSetHash:plan.targetSetHash,quarantineVerificationHash:input.expectedQuarantineVerificationHash||null,authorizationRef:input.authorizationRef});
      requireThat(auth?.authorized===true&&typeof auth.actorId==='string'&&typeof auth.authorizationRef==='string'
        &&auth.action===action&&auth.manifestHash===plan.manifestHash&&auth.targetSetHash===plan.targetSetHash,
      'RETIREMENT_AUTHORIZATION','Trusted authorization does not cover this exact destructive action');
      if(action==='PURGE')requireThat(hex(input.expectedQuarantineVerificationHash)&&auth.quarantineVerificationHash===input.expectedQuarantineVerificationHash,
        'RETIREMENT_PURGE_AUTHORIZATION','Purge requires authorization bound to a successful quarantine verification');
      const operation={operationId:'retirement_op_'+sha(input.requestId),planId:plan.planId,action,requestHash:sha(canonical({action,input})),
        actorId:auth.actorId,authorizationRef:auth.authorizationRef,createdAt:now()};
      // This transaction commits the durable intent BEFORE any file operation.
      const intent=await repository.writeTransaction(async tx=>{
        const previous=await replay(tx,input,action);if(previous)return previous;
        await lease.assertHeld();await checkPlanBinding(tx,input);
        const stages=await stateOf(tx,plan.planId);
        requireThat(action==='QUARANTINE'?stages.length===0:stages.at(-1)?.phase==='QUARANTINED',
          'RETIREMENT_PHASE','Previous result needs reconciliation or this phase is already complete');
        const closure=await inspectLiveReferences(tx,plan.manifest);requireThat(closure.safe,'RETIREMENT_PROTECTED','Current references protect target media');
        let verification=null;
        if(action==='PURGE'){verification=await quarantineVerification(tx,plan,root);requireThat(verification.verificationHash===input.expectedQuarantineVerificationHash,
          'RETIREMENT_VERIFICATION_CAS','Quarantine files or references changed since verification');}
        else for(const t of plan.manifest.targets)await hashStableFile(fs,root,t.instanceRelativePath,{expected:t.fileIdentity});
        for(const t of plan.manifest.targets){
          const key=targetKey(t),claim=read(await tx.getAux(RETIREMENT_NAMESPACES.claims,key));
          requireThat(!claim||claim.planId===plan.planId&&claim.sha256===t.sha256,'RETIREMENT_TARGET_CLAIM','Target belongs to another retirement plan');
          if(!claim)await append(tx,RETIREMENT_NAMESPACES.claims,key,{planId:plan.planId,originalRelativePath:t.instanceRelativePath,sha256:t.sha256});
        }
        await append(tx,RETIREMENT_NAMESPACES.requests,reqKey(input.requestId),operation);
        await appendStage(tx,plan,operation,action+'_INTENT',verification?.files||null);
        return {operation,closureHash:closure.closureHash};
      });
      if(intent.replayed)return intent;
      try{
        return await repository.writeTransaction(async tx=>{
          await lease.assertHeld();await checkPlanBinding(tx,input);
          const stages=await stateOf(tx,plan.planId);requireThat(stages.at(-1)?.operationId===operation.operationId&&stages.at(-1).phase===action+'_INTENT',
            'RETIREMENT_PHASE','Committed intent no longer owns the operation');
          const closure=await inspectLiveReferences(tx,plan.manifest);requireThat(closure.safe&&closure.closureHash===intent.closureHash,
            'RETIREMENT_CLOSURE_CAS','References changed after intent; no new filesystem action is permitted');
          const files=[];
          if(action==='QUARANTINE')await privateDirectory(fs,root,'media/.retirement/'+plan.planId);
          for(const t of plan.manifest.targets){
            await lease.assertHeld();const source=path.join(root,t.instanceRelativePath),qrel=quarantinePath(plan,t),dest=path.join(root,qrel);
            if(action==='QUARANTINE'){
              await hashStableFile(fs,root,t.instanceRelativePath,{expected:t.fileIdentity});await assertAbsent(fs,root,qrel);
              // link is exclusive (EEXIST fails) and cannot overwrite a destination.
              // Same-device hardlink + unlink implements a recoverable move; a crash
              // with two links is RESULT_UNKNOWN, never silently retried.
              await fs.link(source,dest);await syncDirectory(fs,path.dirname(dest));
              await hashStableFile(fs,root,t.instanceRelativePath,{expected:t.fileIdentity,allowedLinks:2});
              await hashStableFile(fs,root,qrel,{expected:t.fileIdentity,allowedLinks:2});
              await lease.assertHeld();
              await fs.unlink(source);await syncDirectory(fs,path.dirname(source));await assertAbsent(fs,root,t.instanceRelativePath);
              files.push({targetId:t.targetId,...await hashStableFile(fs,root,qrel,{expected:t.fileIdentity})});
            }else{
              await assertAbsent(fs,root,t.instanceRelativePath);await hashStableFile(fs,root,qrel,{expected:t.fileIdentity});
              await lease.assertHeld();
              await fs.unlink(dest);await syncDirectory(fs,path.dirname(dest));await assertAbsent(fs,root,qrel);
              files.push({targetId:t.targetId,originalAbsent:true,quarantineAbsent:true,sha256:t.sha256,byteSize:t.byteSize});
            }
          }
          const receipt=await appendStage(tx,plan,operation,action==='QUARANTINE'?'QUARANTINED':'PURGED',files);
          return {operationId:operation.operationId,planId:plan.planId,status:receipt.phase,replayed:false,receipt};
        });
      }catch(error){
        // Preserve a durable ambiguity marker even when a receipt commit failed.
        // If the COMMIT actually succeeded, never append an error over that success.
        try{await repository.writeTransaction(async tx=>{const stages=await stateOf(tx,plan.planId),last=stages.at(-1);
          if(last?.operationId===operation.operationId&&last.phase===action+'_INTENT')await appendStage(tx,plan,operation,'RESULT_UNKNOWN',
            [{errorCode:typeof error.code==='string'?error.code:'RETIREMENT_IO_OR_COMMIT_ERROR',automaticRetry:false}]);});}catch{}
        fail('RETIREMENT_RESULT_UNKNOWN','Retirement did not produce a confirmed receipt. Do not retry; inspect the immutable intent and reconcile both locations.',
          {planId:plan.planId,operationId:operation.operationId,causeCode:error.code||'UNKNOWN'});
      }
    });
  }
  async function reconcile(input){return repository.readTransaction(async tx=>{
    const plan=await checkPlanBinding(tx,input),root=await canonicalRoot(fs,instanceRoot,plan.instanceId),stages=await stateOf(tx,plan.planId),files=[];
    for(const t of plan.manifest.targets){
      async function observe(name){try{return await hashStableFile(fs,root,name,{expected:t.fileIdentity,allowMissing:true});}
        catch(e){if(e.code==='RETIREMENT_FILE_IDENTITY'){try{return {...await hashStableFile(fs,root,name,{expected:t.fileIdentity,allowedLinks:2}),sharedLinkObserved:true};}catch(inner){return {errorCode:inner.code||'UNKNOWN'};}}return {errorCode:e.code||'UNKNOWN'};}}
      const original=await observe(t.instanceRelativePath),quarantine=await observe(quarantinePath(plan,t));
      files.push({targetId:t.targetId,original,quarantine,observation:original&&!quarantine?'ORIGINAL_ONLY':!original&&quarantine?'QUARANTINE_ONLY':original&&quarantine?'BOTH_PATHS_REQUIRE_EXPLICIT_RECOVERY':'BOTH_ABSENT_REQUIRE_PURGE_INTENT_RECONCILIATION'});
    }
    return {planId:plan.planId,stages,files,readOnly:true,automaticRetry:false,formalCompletionInferred:false};
  });}
  return Object.freeze({inspect,registerPlan,verifyQuarantine,quarantine:input=>mutate('QUARANTINE',input),purge:input=>mutate('PURGE',input),reconcile});
}

export const integrationPoints=Object.freeze([
  {path:'host/instance-runtime/cli.mjs',symbol:'media-resolve',instruction:'Use resolveActiveMedia; map MEDIA_RETIRED/MEDIA_PURGED to a tombstone response, not a missing-file 500.'},
  {path:'app/api/v8/_store.ts',symbol:'safeGeneratedPath',instruction:'Resolve through the retirement overlay before reading any original, including legacy deep links.'},
  {path:'app/api/v8/media/[token]/route.ts',symbol:'mediaFile/GET/HEAD',instruction:'Do not fall back to old snapshot paths after a retirement response; display the immutable version tombstone.'},
  {path:'scripts/instance-hosted-export.mjs',symbol:'selectHostedMedia/exportHostedInstance',instruction:'Filter rows with activeMediaForExport in the SAME read transaction; export a public retirement projection so old previews disappear without losing audit identity.'},
  {path:'scripts/instance-transfer.mjs',symbol:'presentFiles/backupPostgresInstance/restoreArchiveWithMedia',instruction:'Use retirementAwareMediaManifest for files. Keep archive media_versions and retirement aux evidence unchanged; restore validates the overlay rather than demanding purged original paths.'},
  {path:'host/instance-runtime/maintenance-service.mjs',symbol:'validateMaintenanceRequest/enqueueMaintenance',instruction:'Add explicit inspect/register/quarantine/verify/purge actions with exact manifest/plan/release CAS and separately validated action authorization.'},
  {path:'host/instance-runtime/transport.mjs',symbol:'READ_ONLY_CLI_COMMANDS',instruction:'Only inspect/verify/reconcile are read-only. registerPlan writes aux. quarantine/purge are owner-bound mutation commands, never hosted capabilities.'},
]);
export const testRecommendations=Object.freeze([
  'Happy path with a temporary explicit instance, in-memory tx mock and injected fs: inspect performs zero writes; quarantine creates immutable intent/receipt; verify then purge leaves immutable tombstones and no files.',
  'Use the real PostgreSQL adapter in an isolated disposable instance to verify repository_meta locking, auxiliary CAS and append-only triggers; never use production media for mutation tests.',
  '107-report fixture: target hash and complete alias closure must match; adding an alias or shared retained family blocks the entire batch before filesystem effects.',
  'Add a production-preparation or unknown current aux head containing an exact target SHA/version/family/path; every such new reference blocks quarantine AND purge.',
  'Keep an unchanged historical audit revision exempt, but change its revision/SHA or make it an active material/Run input: exemption cannot authorize deletion.',
  'Release/plan/manifest/target-set/verification hash mismatches fail closed; duplicate request with different content fails; identical replay never performs another link/unlink.',
  'Symlink root/ancestor/file, traversal/absolute target, hash/size/inode changes and pre-existing hardlinks or occupied quarantine destinations all fail closed.',
  'Inject failure after link, after source unlink, after one target, after quarantine unlink and on COMMIT: durable intent remains, RESULT_UNKNOWN is reported, replay is read-only, reconcile never guesses success.',
  'New retained input between inspect, intent and filesystem phase must be detected. Shared media lease loss must stop further effects; all producer file writers must use the same lease.',
  'Resolver GET/HEAD, hosted exported previews and backup/restore all use the same overlay. Pending intent blocks backup; quarantined files are backed up at quarantine paths; purged originals are not resurrected.',
]);

/**
 * Optional owner-bound RPC adapter for HOST filesystem + CONTAINER PostgreSQL.
 * Each callback gets one persistent container transaction: its row lock remains
 * held while the host callback performs fs operations. Never replace this with
 * separate `docker exec` calls per method; those would lose the transaction lock.
 *
 * verifyOwner is trusted host code using resolveStorageOwner; it must return the
 * exact running owner ID, instanceId and containerRoot immediately before every
 * transaction. No transport fallback or automatic transaction retry is allowed.
 * Importing/constructing the adapter does not start a process or modify anything.
 */
export function createContainerTransactionRepository({containerId,instanceId,containerRoot='/instance',verifyOwner,readOnly=false,timeoutMs=120000,spawnProcess=spawn}={}){
  requireThat(typeof containerId==='string'&&/^[a-f0-9]{12,64}$/.test(containerId)&&typeof instanceId==='string'&&instanceId,
    'RETIREMENT_BRIDGE','Exact container and instance identities required');
  requireThat(containerRoot==='/instance'&&typeof verifyOwner==='function'&&typeof spawnProcess==='function','RETIREMENT_BRIDGE','Only verified formal owner transport is supported');
  const bridgeLeases=new AsyncLocalStorage(),namespaces=Object.values(RETIREMENT_NAMESPACES);
  const server=String.raw`
import {createInterface} from 'node:readline';
import {openInstanceRepository,resolveInstance} from '/app/host/instance-runtime/index.mjs';
const namespaces=__NAMESPACES__,expectedInstance=__INSTANCE__,root=__ROOT__;
const encode=v=>Buffer.isBuffer(v)?{$retirementBufferBase64:v.toString('base64')}:Array.isArray(v)?v.map(encode):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,encode(x)])):v;
const decode=v=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===1&&typeof v.$retirementBufferBase64==='string'?Buffer.from(v.$retirementBufferBase64,'base64'):Array.isArray(v)?v.map(decode):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,decode(x)])):v;
const lines=createInterface({input:process.stdin}),queue=[];let waiting=null,closed=false,repo,activeLease=null,outerReplyId=0;
lines.on('line',line=>{try{const m=decode(JSON.parse(line));if(waiting){const w=waiting;waiting=null;w(m);}else queue.push(m);}catch{process.exitCode=1;lines.close();}});
lines.on('close',()=>{closed=true;if(waiting){const w=waiting;waiting=null;w(null);}});
const next=()=>queue.length?Promise.resolve(queue.shift()):closed?Promise.resolve(null):new Promise(resolve=>{waiting=resolve;});
const send=(id,result,error=null)=>process.stdout.write(JSON.stringify(encode({id,result,error}))+'\n');
const reject=(code,replyId)=>Object.assign(new Error(),{code,replyId});
const allowed=new Set(['getMetadata','readView','listMedia','getMedia','resolveMedia','getAux','listAux','all','putAux']);
async function assertion(m){
 if(!activeLease)throw reject('RETIREMENT_BRIDGE_NO_LEASE',m.id);
 await activeLease.assertHeld();send(m.id,{held:true,instanceId:expectedInstance});
}
async function transaction(begin){
 let responseId=begin.id,rollback=false,failedCode=null;
 if(begin.action!=='BEGIN'||!['READ','WRITE'].includes(begin.mode))throw reject('RETIREMENT_BRIDGE_PROTOCOL',begin.id);
 try{
  await repo[begin.mode==='READ'?'readTransaction':'writeTransaction'](async tx=>{
   send(begin.id,{started:true,backend:tx.backend});
   while(true){
    const m=await next();if(!m)throw reject('RETIREMENT_BRIDGE_DISCONNECTED');
    if(m.action==='ASSERT_LEASE'){await assertion(m);continue;}
    if(m.action==='COMMIT'){responseId=m.id;if(failedCode)throw reject(failedCode,m.id);return;}
    if(m.action==='ROLLBACK'){responseId=m.id;rollback=true;throw reject('RETIREMENT_BRIDGE_ROLLBACK',m.id);}
    if(m.action!=='CALL'||!allowed.has(m.method)||!Array.isArray(m.args))throw reject('RETIREMENT_BRIDGE_PROTOCOL',m.id);
    try{
     if(failedCode)throw reject('RETIREMENT_BRIDGE_TRANSACTION_ABORTED');
     if(m.method==='putAux'&&(begin.mode!=='WRITE'||!namespaces.includes(m.args[0]?.namespace)||m.args[0]?.expectedRevisionId!==null))throw reject('RETIREMENT_BRIDGE_WRITE_SCOPE');
     if(m.method==='all'&&(typeof m.args[0]!=='string'||m.args[0].length>8192||!/^\s*SELECT\b/i.test(m.args[0])||/[;]|\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|COPY|CALL|DO|EXECUTE)\b/i.test(m.args[0])))throw reject('RETIREMENT_BRIDGE_SQL_SCOPE');
     send(m.id,await tx[m.method](...m.args));
    }catch(e){failedCode=e.code||'RETIREMENT_BRIDGE_METHOD_FAILED';send(m.id,null,{code:failedCode});}
   }
  });
  send(responseId,{committed:true});
 }catch(e){
  if(rollback){send(responseId,{rolledBack:true});return;}
  send(e.replyId||responseId,null,{code:e.code||'RETIREMENT_BRIDGE_TRANSACTION_FAILED'});
  if(['RETIREMENT_BRIDGE_DISCONNECTED','MEDIA_LEASE_LOST'].includes(e.code))throw e;
 }
}
try{
 const begin=await next();if(!begin||!['BEGIN','BEGIN_LEASE'].includes(begin.action))throw reject('RETIREMENT_BRIDGE_PROTOCOL',begin?.id);
 outerReplyId=begin.id;
 repo=await openInstanceRepository({...resolveInstance(root),readOnly:begin.action==='BEGIN'&&begin.mode==='READ'});
 if(repo.instanceId!==expectedInstance)throw reject('RETIREMENT_INSTANCE',begin.id);
 if(begin.action==='BEGIN_LEASE'){
  if(typeof repo.withExclusiveMediaLease!=='function')throw reject('RETIREMENT_BRIDGE_LEASE_NOT_INSTALLED',begin.id);
  await repo.withExclusiveMediaLease(async lease=>{
   activeLease=lease;send(begin.id,{started:true,exclusive:true,instanceId:expectedInstance});
   while(true){
    const m=await next();if(!m)throw reject('RETIREMENT_BRIDGE_DISCONNECTED');
    if(m.action==='END_LEASE'){outerReplyId=m.id;return;}
    if(m.action==='ASSERT_LEASE'){await assertion(m);continue;}
    await transaction(m);
   }
  });
  activeLease=null;send(outerReplyId,{leaseReleased:true});
 }else await transaction(begin);
}catch(e){send(e.replyId||outerReplyId||0,null,{code:e.code||'RETIREMENT_BRIDGE_FAILED'});process.exitCode=1;}
finally{await repo?.close();lines.close();}
`.replace('__NAMESPACES__',JSON.stringify(namespaces)).replace('__INSTANCE__',JSON.stringify(instanceId)).replace('__ROOT__',JSON.stringify(containerRoot));
  const encode=v=>Buffer.isBuffer(v)?{$retirementBufferBase64:v.toString('base64')}:Array.isArray(v)?v.map(encode):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,encode(x)])):v;
  const decode=v=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===1&&typeof v.$retirementBufferBase64==='string'?Buffer.from(v.$retirementBufferBase64,'base64'):Array.isArray(v)?v.map(decode):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,decode(x)])):v;
  async function assertOwner(){
    const owner=await verifyOwner();
    requireThat(owner?.running===true&&owner.containerId===containerId&&owner.instanceId===instanceId&&owner.containerRoot===containerRoot,
      'RETIREMENT_BRIDGE_OWNER_CHANGED','Formal storage owner changed or stopped');
  }
  async function channel(){
    await assertOwner();
    const child=spawnProcess('docker',['exec','-i',containerId,'node','--input-type=module','-e',server],{stdio:['pipe','pipe','pipe']});
    const lines=createInterface({input:child.stdout}),pending=new Map();let sequence=0,exited=false,lost=false,stderrBytes=0;
    const error=code=>Object.assign(new Error('Container transaction result requires verification; no automatic retry'),{code});
    function rejectAll(code){lost=true;for(const w of pending.values()){clearTimeout(w.timer);w.reject(error(code));}pending.clear();}
    child.stderr.on('data',b=>{stderrBytes+=b.length;if(stderrBytes>1024*1024){rejectAll('RETIREMENT_BRIDGE_DIAGNOSTIC_LIMIT');child.kill('SIGTERM');}});
    child.on('error',()=>rejectAll('RETIREMENT_BRIDGE_UNAVAILABLE'));
    child.stdin.on('error',()=>rejectAll('RETIREMENT_BRIDGE_RESULT_UNKNOWN'));
    child.on('close',()=>{exited=true;rejectAll('RETIREMENT_BRIDGE_RESULT_UNKNOWN');lines.close();});
    lines.on('line',line=>{
      let reply;try{reply=decode(JSON.parse(line));}catch{rejectAll('RETIREMENT_BRIDGE_PROTOCOL');child.kill('SIGTERM');return;}
      const w=pending.get(reply.id);if(!w)return;pending.delete(reply.id);clearTimeout(w.timer);
      if(reply.error)w.reject(error(reply.error.code));else w.resolve(reply.result);
    });
    function rpc(payload){return new Promise((resolve,reject)=>{
      if(exited||lost){reject(error('RETIREMENT_BRIDGE_RESULT_UNKNOWN'));return;}
      const id=++sequence,timer=setTimeout(()=>{pending.delete(id);rejectAll('RETIREMENT_BRIDGE_RESULT_UNKNOWN');child.kill('SIGTERM');reject(error('RETIREMENT_BRIDGE_RESULT_UNKNOWN'));},timeoutMs);
      pending.set(id,{resolve,reject,timer});
      child.stdin.write(JSON.stringify(encode({id,...payload}))+'\n',e=>{if(e){rejectAll('RETIREMENT_BRIDGE_RESULT_UNKNOWN');child.kill('SIGTERM');}});
    });}
    return {rpc,get unavailable(){return exited||lost;},end(){child.stdin.end();},abort(){rejectAll('RETIREMENT_BRIDGE_RESULT_UNKNOWN');child.stdin.end();if(!exited)child.kill('SIGTERM');}};
  }
  async function transaction(mode,callback){
    requireThat(!(readOnly&&mode==='WRITE'),'RETIREMENT_BRIDGE_READ_ONLY','Read-only bridge cannot write');
    const scope=bridgeLeases.getStore();requireThat(!scope?.transactionActive,'RETIREMENT_BRIDGE_PARALLEL_TRANSACTION','Lease transactions must be sequential');
    await assertOwner();const connection=scope?.connection||await channel();let started=false;
    if(scope)scope.transactionActive=true;
    try{
      await connection.rpc({action:'BEGIN',mode});started=true;
      const tx={backend:'postgres'};
      for(const method of ['getMetadata','readView','listMedia','getMedia','resolveMedia','getAux','listAux','all','putAux'])tx[method]=(...args)=>connection.rpc({action:'CALL',method,args});
      const result=await callback(tx);
      // Never attempt ROLLBACK after a COMMIT outcome becomes unknown.
      started=false;await connection.rpc({action:'COMMIT'});return result;
    }catch(e){
      if(started&&!connection.unavailable){try{await connection.rpc({action:'ROLLBACK'});}catch{connection.abort();}}
      throw e;
    }finally{if(scope)scope.transactionActive=false;else connection.end();}
  }
  async function withExclusiveMediaLease(callback){
    requireThat(!readOnly,'RETIREMENT_BRIDGE_READ_ONLY','Read-only bridge cannot own maintenance');
    requireThat(typeof callback==='function'&&!bridgeLeases.getStore(),'RETIREMENT_BRIDGE_LEASE_NESTING','An exclusive lease must be the outermost operation');
    const connection=await channel();let started=false,finished=false;
    try{
      const began=await connection.rpc({action:'BEGIN_LEASE'});started=true;
      requireThat(began.exclusive===true&&began.instanceId===instanceId,'RETIREMENT_BRIDGE_LEASE','Container did not grant the exact instance lease');
      const scope={connection,transactionActive:false};
      const lease=Object.freeze({exclusive:true,instanceId,assertHeld:async()=>{
        await assertOwner();const r=await connection.rpc({action:'ASSERT_LEASE'});requireThat(r?.held===true&&r.instanceId===instanceId,'RETIREMENT_BRIDGE_LEASE_LOST','Exact lease is no longer held');
      }});
      const result=await bridgeLeases.run(scope,()=>callback(lease));
      requireThat(!scope.transactionActive,'RETIREMENT_BRIDGE_ACTIVE_TRANSACTION','Do not release a lease with an unfinished transaction');
      await lease.assertHeld();await connection.rpc({action:'END_LEASE'});finished=true;return result;
    }finally{
      if(started&&!finished&&!connection.unavailable){try{await connection.rpc({action:'END_LEASE'});finished=true;}catch{}}
      if(finished)connection.end();else connection.abort();
    }
  }
  return Object.freeze({backend:'postgres',instanceId,readOnly,readTransaction:callback=>transaction('READ',callback),writeTransaction:callback=>transaction('WRITE',callback),withExclusiveMediaLease});
}
