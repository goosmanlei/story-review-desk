// Host-only capture of immutable published history. Never derive historical
// material/source state from fields supplied by the event being validated.
import {gzipSync,gunzipSync} from 'node:zlib';
import {openSync,closeSync,fstatSync,readFileSync,lstatSync,realpathSync,constants} from 'node:fs';
import path from 'node:path';
import {canonicalJson,sha256} from './instance-runtime/bytes.mjs';

const schemaVersion='HISTORICAL_EVENT_CONTEXTS_V1';
const maxReleaseBytes=128*1024*1024;
const hash=value=>sha256(Buffer.from(canonicalJson(value)));
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const fail=message=>{throw Object.assign(new Error('Historical event context: '+message),{code:'SOURCE_HISTORICAL_EVENT_CONTEXT'});};
const requireThat=(ok,message)=>{if(!ok)fail(message);};
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const selected=events=>events.flatMap(event=>event.eventKind==='creative-revision'&&event.scopedReviewSpec?[{event,role:'CREATION'}]:event.eventKind==='source-operation'&&event.protocol==='SCOPED_SCENE_DATABASE_COMPILER_V1'?[{event,role:'SOURCE_RESULT'}]:event.eventKind==='asset-context-revalidation'?[{event,role:'ASSET_CONTEXT'}]:[]);
const profileKeys=['schemaVersion','instanceId','projectId','title','storyTitle','episodePlanId','locale','branding','assistant','sourceBindings','capabilities','configurationRef'];
function verifiedRecord(row,revisionId,expectedHash,label){
  requireThat(row&&!row.deleted&&row.revisionId===revisionId&&sha(row.sha256)&&sha256(row.bytes)===row.sha256&&(!expectedHash||row.sha256===expectedHash),label+' original revision/bytes are unavailable or changed');
  return {revisionId:row.revisionId,sha256:row.sha256,byteSize:row.bytes.length};
}
function fixedSourceReferences(value,result=new Map()){
  if(!value||typeof value!=='object')return result;
  if(Array.isArray(value)){for(const row of value)fixedSourceReferences(row,result);return result;}
  for(const [id,key] of [['sourceRevisionId','sourceSha256'],['documentRevisionId','documentSha256'],...(value.sourceId?[['revisionId','sha256']]:[])]){
    if(value[id]!=null||value[key]!=null){
      // Some legacy rows have only sourceSha256 and no database revision. They
      // remain covered by the original publication's sourceRevisionIds below.
      if(value[id]==null)continue;
      requireThat(typeof value[id]==='string'&&sha(value[key]),'fixed source reference is incomplete');
      const prior=result.get(value[id]);requireThat(!prior||prior===value[key],'one source revision claims different hashes');result.set(value[id],value[key]);
    }
  }
  for(const row of Object.values(value))fixedSourceReferences(row,result);
  return result;
}
function compressed(bytes){
  requireThat(bytes.length>0&&bytes.length<=maxReleaseBytes,'published release exceeds the byte limit');const data=gzipSync(bytes,{level:6,mtime:0});
  return {encoding:'GZIP_BASE64',data:data.toString('base64'),byteSize:bytes.length,compressedByteSize:data.length,compressedSha256:sha256(data)};
}
function originalBytes(encoded,expectedHash,directory){
  requireThat(encoded?.encoding==='GZIP_BASE64'&&Number.isSafeInteger(encoded.byteSize)&&encoded.byteSize>0&&encoded.byteSize<=maxReleaseBytes&&sha(expectedHash)&&sha(encoded.compressedSha256)&&Number.isSafeInteger(encoded.compressedByteSize)&&encoded.compressedByteSize>0&&encoded.compressedByteSize<=maxReleaseBytes,'compressed release envelope differs');
  requireThat(Object.keys(encoded).every(k=>['encoding','data','file','byteSize','compressedByteSize','compressedSha256'].includes(k))&&(('data'in encoded)!==('file'in encoded)),'release payload transport is ambiguous');
  let data;
  if('data'in encoded){requireThat(typeof encoded.data==='string','release data is not base64');data=Buffer.from(encoded.data,'base64');requireThat(data.toString('base64')===encoded.data,'release base64 is not canonical');}
  else {
    requireThat(typeof directory==='string'&&path.isAbsolute(directory)&&realpathSync(directory)===directory,'release file transport requires the host-owned exact directory');
    const dir=lstatSync(directory);requireThat(dir.isDirectory()&&!dir.isSymbolicLink()&&(dir.mode&0o077)===0&&(!process.getuid||dir.uid===process.getuid()),'release directory is not private to this host');
    requireThat(encoded.file===encoded.compressedSha256+'.gz','release file name is not its exact compressed SHA');
    const fd=openSync(path.join(directory,encoded.file),constants.O_RDONLY|constants.O_NOFOLLOW);
    try{const stat=fstatSync(fd);requireThat(stat.isFile()&&stat.nlink===1&&(stat.mode&0o077)===0&&stat.size===encoded.compressedByteSize,'release file type/size/privacy differs');data=readFileSync(fd);}finally{closeSync(fd);}
  }
  requireThat(data.length===encoded.compressedByteSize&&sha256(data)===encoded.compressedSha256,'compressed release bytes/hash differ');
  const bytes=gunzipSync(data,{maxOutputLength:maxReleaseBytes});requireThat(bytes.length===encoded.byteSize&&sha256(bytes)===expectedHash,'published original bytes/hash differ');return bytes;
}

/** The content hash signs exact compressed-byte hashes, not their temporary
 * transport location. Large captures can therefore use private host files. */
export function historicalEventContextsHash(bundle){
  const body={...bundle};delete body.contextsHash;
  body.releases=body.releases.map(row=>({...row,...Object.fromEntries(['snapshotBytes','recipesBytes'].map(key=>{const payload={...row[key]};delete payload.data;delete payload.file;return [key,payload];}))}));
  return hash(body);
}

export function isAssetContextResultRelease(snapshot,release,event){
 const refs=snapshot.productionModel?.assetContextRevalidationLedger;
 return Array.isArray(refs)&&refs.some(r=>r.id===event.revalidationRevisionId&&r.revalidationId===event.revalidationId&&r.eventId===event.eventId&&r.sourceRef===event.sourceRef&&r.sourceRevisionId===event.sourceRevisionId&&r.sourceSha256===event.sourceSha256)&&release.sourceRevisionIds.includes(event.sourceRevisionId);
}
export async function assetContextBaseRelease(tx,event){
 const sameTime=await tx.readPublishedReleaseTimeGroup({recordedBefore:event.recordedAt});
 if(sameTime[0]?.createdAt===event.recordedAt){
  for(const row of sameTime){const release=await tx.readRelease(row.releaseId);requireThat(sha256(release.snapshotBytes)===release.snapshotSha256&&sha256(release.recipesBytes)===release.recipesSha256&&isAssetContextResultRelease(JSON.parse(release.snapshotBytes),release,event),'simultaneous publication is not this exact context event result');}
  const previous=await tx.readPublishedReleaseTimeGroup({recordedBefore:event.recordedAt,inclusive:false});
  requireThat(previous.length>0&&previous.every(r=>r.createdAt<event.recordedAt&&r.createdAt===previous[0].createdAt),'context has no strictly prior actual publication');
  const signatures=new Set(previous.map(r=>hash({snapshotId:r.snapshotId,snapshotSha256:r.snapshotSha256,recipesSha256:r.recipesSha256,profileRevisionId:r.profileRevisionId,sourceRevisionIds:r.sourceRevisionIds})));requireThat(signatures.size===1,'context prior publication is ambiguous');
  const exact=previous.find(r=>r.releaseId===event.baseReleaseId);requireThat(exact&&exact.snapshotId===event.creationSnapshotId,'context base was not the last prior publication');return tx.readRelease(exact.releaseId);
 }
 return tx.readPublishedReleaseAt({recordedBefore:event.recordedAt,snapshotId:event.creationSnapshotId});
}
export async function captureHistoricalEventContexts(tx,{events,instanceId}){
  const metadata=await tx.getMetadata();requireThat(metadata.instanceId===instanceId,'repository instance differs');
  const contexts=[],releases=new Map(),documents=new Map();
  async function document(id,expectedHash){
    if(!documents.has(id)){
      const row=await tx.readDocumentRevision(id);
      documents.set(id,{...verifiedRecord(row,id,expectedHash,'Source '+id),documentId:row.documentId});
    }
    const proof=documents.get(id);requireThat(!expectedHash||proof.sha256===expectedHash,'Source '+id+' fixed reference SHA differs');return proof;
  }
  async function captureRelease(release){
    requireThat(release&&sha(release.snapshotSha256)&&sha(release.recipesSha256)&&sha256(release.snapshotBytes)===release.snapshotSha256&&sha256(release.recipesBytes)===release.recipesSha256,'published snapshot/recipes original hash differs');
    const prior=releases.get(release.releaseId);if(prior){requireThat(same(prior.release,descriptor(release)),'release identity changed within capture');return;}
    const snapshot=JSON.parse(release.snapshotBytes),recipes=JSON.parse(release.recipesBytes);
    requireThat(snapshot.snapshotId===release.snapshotId&&recipes.snapshotId===release.snapshotId,'published snapshot/recipes identity differs');
    const row=await tx.getRecord('settings','instance-profile',release.profileRevisionId),profileProof=verifiedRecord(row,release.profileRevisionId,null,'Profile'),profile=JSON.parse(row.bytes);
    requireThat(profile.instanceId===instanceId&&(!snapshot.instance?.instanceId||snapshot.instance.instanceId===instanceId)&&(!snapshot.productionModel?.instance?.instanceId||snapshot.productionModel.instance.instanceId===instanceId),'historical publication belongs to another instance');
    const publicProfile=Object.fromEntries(profileKeys.filter(key=>profile[key]!==undefined).map(key=>[key,profile[key]]));
    requireThat(Array.isArray(release.sourceRevisionIds)&&new Set(release.sourceRevisionIds).size===release.sourceRevisionIds.length,'published source revision closure differs');
    const refs=fixedSourceReferences(snapshot.productionModel),sourceProof=[];
    for(const id of release.sourceRevisionIds)refs.set(id,refs.get(id)||null);
    for(const [id,expectedHash] of [...refs].sort(([a],[b])=>a.localeCompare(b)))sourceProof.push(await document(id,expectedHash));
    const model=snapshot.productionModel||{},auxProof=[];
    for(const [namespace,revisionId,expectedHash] of [['domain-graph',model.domainGraphRef?.revisionId,model.domainGraphRef?.sha256],['material-directory',model.materialDirectory?.revisionId,model.materialDirectory?.sourceSha256]]){
      if(!revisionId&&!expectedHash)continue;
      requireThat(typeof revisionId==='string'&&sha(expectedHash),'historical AUX reference is incomplete');
      const aux=await tx.getAux(namespace,'current',{revisionId});auxProof.push({namespace,key:'current',...verifiedRecord(aux,revisionId,expectedHash,namespace)});
      if(namespace==='domain-graph')requireThat(same(JSON.parse(aux.bytes),model.domainGraph),'historical domain graph differs from its pinned AUX bytes');
    }
    if(profile.configurationRef){
      const ref=profile.configurationRef,config=await tx.getRecord('settings','system-configuration',ref.revisionId);
      auxProof.push({namespace:'settings',key:'system-configuration',...verifiedRecord(config,ref.revisionId,ref.sha256,'Configuration')});
      requireThat(same(model.systemConfiguration?.reference,ref)&&same(recipes.configurationRef,ref)&&same(model.systemConfiguration.config,JSON.parse(config.bytes).configuration),'historical configuration projection differs');
    }
    releases.set(release.releaseId,{release:descriptor(release),snapshotBytes:compressed(release.snapshotBytes),recipesBytes:compressed(release.recipesBytes),publicProfile,profileProof,sourceProof,auxProof});
  }
  for(const {event,role} of selected(events)){
    requireThat(Number.isSafeInteger(event.eventSequence)&&event.eventSequence>0&&Number.isFinite(Date.parse(event.recordedAt)),'historical event lacks a real sequence/timestamp');
    let release;
    if(role==='CREATION'||role==='ASSET_CONTEXT'){
      requireThat(typeof event.creationSnapshotId==='string'&&event.creationSnapshotId===event.snapshotId,'candidate creation snapshot differs');
      release=role==='ASSET_CONTEXT'?await assetContextBaseRelease(tx,event):await tx.readPublishedReleaseAt({recordedBefore:event.recordedAt,snapshotId:event.creationSnapshotId});
      requireThat(release&&Date.parse(release.createdAt)<Date.parse(event.recordedAt)&&release.snapshotId===event.creationSnapshotId,'candidate has no exact prior publication');
      if(role==='ASSET_CONTEXT')requireThat(release.releaseId===event.baseReleaseId&&release.snapshotSha256===event.baseSnapshotSha256&&release.recipesSha256===event.baseRecipesSha256,'asset context original publication differs');
    }else{
      requireThat(typeof event.resultReleaseId==='string'&&sha(event.transactionProof?.snapshotSha256),'source operation lacks a result release proof');
      release=await tx.readRelease(event.resultReleaseId);
      requireThat(release&&release.snapshotId===event.newSnapshotId&&release.snapshotId===event.snapshotId&&release.snapshotSha256===event.transactionProof.snapshotSha256&&Date.parse(release.createdAt)<=Date.parse(event.recordedAt),'source operation result release differs');
    }
    await captureRelease(release);
    if(role==='SOURCE_RESULT'){
      const proof=event.transactionProof;
      requireThat(release.sourceRevisionIds.includes(proof.sourceRevisionId),'source operation document is absent from its actual publication');
      await document(proof.sourceRevisionId,proof.sourceSha256);
    }
    contexts.push({eventId:event.eventId,eventSha256:hash(event),role,releaseId:release.releaseId});
  }
  const body={schemaVersion,instanceId,contexts:contexts.sort((a,b)=>a.eventId.localeCompare(b.eventId)),releases:[...releases.values()].sort((a,b)=>a.release.releaseId.localeCompare(b.release.releaseId))};
  return {...body,contextsHash:historicalEventContextsHash(body)};
}
function descriptor(release){return Object.fromEntries(['releaseId','snapshotId','createdAt','snapshotSha256','recipesSha256','profileRevisionId','sourceRevisionIds'].map(key=>[key,release[key]]));}

/** Pure child-side reader. Only the host's same-transaction capture may supply
 * this envelope; this is never a public authoring/API input or a current gate. */
export function historicalEventContextReader(bundle,{events,expectedHash,instanceId,directory}){
  const required=selected(events),cache=new Map();
  if(!bundle){requireThat(required.length===0&&!expectedHash,'scoped history requires independently captured publication bytes');return ()=>fail('no captured scoped context');}
  const {contextsHash}=bundle;
  requireThat(Array.isArray(bundle.contexts)&&Array.isArray(bundle.releases),'captured history lists are missing');
  requireThat(bundle.schemaVersion===schemaVersion&&bundle.instanceId===instanceId&&contextsHash===expectedHash&&historicalEventContextsHash(bundle)===contextsHash,'captured history envelope/hash/instance differs');
  const contextMap=new Map(bundle.contexts.map(row=>[row.eventId,row])),releaseMap=new Map(bundle.releases.map(row=>[row.release?.releaseId,row]));
  requireThat(contextMap.size===bundle.contexts.length&&releaseMap.size===bundle.releases.length&&contextMap.size===required.length,'captured history omits or duplicates event/release identities');
  const used=new Set();
  for(const {event,role} of required){
    const c=contextMap.get(event.eventId),r=releaseMap.get(c?.releaseId),release=r?.release;
    requireThat(c&&c.role===role&&c.eventSha256===hash(event)&&release,'captured historical event differs');used.add(c.releaseId);
    requireThat(r.publicProfile?.instanceId===instanceId&&r.profileProof?.revisionId===release.profileRevisionId&&sha(r.profileProof?.sha256),'captured profile proof differs');
    requireThat(Array.isArray(r.sourceProof)&&Array.isArray(release.sourceRevisionIds)&&new Set(r.sourceProof.map(p=>p.revisionId)).size===r.sourceProof.length&&r.sourceProof.every(p=>typeof p.documentId==='string'&&sha(p.sha256))&&release.sourceRevisionIds.every(id=>r.sourceProof.some(p=>p.revisionId===id)),'captured source closure differs');
    if(role==='CREATION'||role==='ASSET_CONTEXT')requireThat(release.snapshotId===event.creationSnapshotId&&event.snapshotId===event.creationSnapshotId&&Date.parse(release.createdAt)<Date.parse(event.recordedAt),'captured creation publication differs');
    else requireThat(release.releaseId===event.resultReleaseId&&release.snapshotId===event.snapshotId&&release.snapshotId===event.newSnapshotId&&release.snapshotSha256===event.transactionProof?.snapshotSha256&&Date.parse(release.createdAt)<=Date.parse(event.recordedAt)&&r.sourceProof.some(p=>p.revisionId===event.transactionProof.sourceRevisionId&&p.sha256===event.transactionProof.sourceSha256),'captured source result proof differs');
  }
  requireThat(used.size===releaseMap.size,'unused historical release injected');
  const reader=event=>{
    const c=contextMap.get(event.eventId);requireThat(c&&c.eventSha256===hash(event),'event changed after historical capture');
    if(!cache.has(c.releaseId)){
      const row=releaseMap.get(c.releaseId),snapshot=JSON.parse(originalBytes(row.snapshotBytes,row.release.snapshotSha256,directory)),recipes=JSON.parse(originalBytes(row.recipesBytes,row.release.recipesSha256,directory));
      requireThat(snapshot.snapshotId===row.release.snapshotId&&recipes.snapshotId===row.release.snapshotId,'decoded historical identity differs');
      requireThat((!snapshot.instance?.instanceId||snapshot.instance.instanceId===instanceId)&&(!snapshot.productionModel?.instance?.instanceId||snapshot.productionModel.instance.instanceId===instanceId),'decoded historical instance differs');
      // Match repository readView's release-bound public profile injection.
      snapshot.instance=structuredClone(row.publicProfile);snapshot.productionModel={...snapshot.productionModel,instance:structuredClone(row.publicProfile)};
      cache.set(c.releaseId,snapshot);while(cache.size>3)cache.delete(cache.keys().next().value);
    }
    return structuredClone(cache.get(c.releaseId));
  };
  reader.releaseContext=event=>{const snapshot=reader(event),c=contextMap.get(event.eventId),row=releaseMap.get(c.releaseId);return {release:structuredClone(row.release),snapshot,recipes:JSON.parse(originalBytes(row.recipesBytes,row.release.recipesSha256,directory))};};
  return reader;
}
