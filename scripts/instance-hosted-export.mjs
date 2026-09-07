import {readMaterialDirectory} from '../host/instance-runtime/material-directory.mjs';
import {activeMediaForExport} from '../host/instance-runtime/media-retirement.mjs';
import {readProductionPreparation} from '../host/instance-runtime/production-preparation.mjs';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, openInstanceRepository, resolveInstance, sha256 } from '../host/instance-runtime/index.mjs';
import { hostedEventProjection } from './export-hosted-material-events.mjs';
import { readSpatialSettings } from '../host/instance-runtime/domain-spatial.mjs';

const JSON_FILES = ['review-data-core.generated.json', 'review-data-production-a.generated.json', 'review-data-production-b.generated.json', 'review-recipes.generated.json', 'hosted-material-events.generated.json'];
const PRODUCTION_A_KEYS = new Set(['schemaVersion','policy','reviewContextCatalog','workflowSteps','continuityGroups','stageDefinitions','episodes','scenes','segments','beats','shots','reviewContexts','structureCards','executionRecipeSummary']);
function snapshotShards(snapshot) {
  const {productionModel,...core}=snapshot;
  const a={},b={};
  for(const [key,value] of Object.entries(productionModel)) (PRODUCTION_A_KEYS.has(key)?a:b)[key]=value;
  return [core,{snapshotId:snapshot.snapshotId,productionModel:a},{snapshotId:snapshot.snapshotId,productionModel:b}];
}
const MEDIA_EXTENSIONS = new Set(['.png','.jpg','.jpeg','.webp','.gif','.avif','.mp3','.wav','.ogg','.m4a','.aac','.mp4','.webm','.mov','.flac']);
const MANIFEST = 'hosted-export-manifest.json';
const LIMIT = 16 * 1024 * 1024;
export function publicMaterialDirectory(directory) {
  const result=structuredClone(directory);
  const privateEntities=new Set((result.trials||[]).map(t=>t.entityId));
  const privateStates=new Set((result.trials||[]).map(t=>t.stateId));
  for(const b of result.bindings||[]){privateEntities.delete(b.entityId);privateStates.delete(b.stateId);}
  result.trials=[];
  if(result.graph){
    result.graph.entities=result.graph.entities.filter(e=>!privateEntities.has(e.id));
    result.graph.states=result.graph.states.filter(s=>!privateStates.has(s.id)&&!privateEntities.has(s.entityId));
    const allowed=new Set([...result.graph.entities,...result.graph.states,...result.graph.representations].map(r=>r.id));
    result.graph.relations=result.graph.relations.filter(r=>allowed.has(r.from.id)&&allowed.has(r.to.id));
  }
  return result;
}
function relative(value) {
  if (typeof value !== 'string' || path.isAbsolute(value) || /[\\%?#\u0000-\u001f]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe hosted export path');
  return value;
}
function publicAlias(alias) {
  if (typeof alias !== 'string' || !alias.startsWith('/media/')) throw new Error('Hosted media must use an explicit /media/ alias');
  relative(alias.slice(1));
  if (alias.split('/').some(part => ['private','trial','review-audio'].includes(part.toLowerCase())) || !MEDIA_EXTENSIONS.has(path.extname(alias).toLowerCase())) throw new Error('Unsupported or private hosted media alias');
  return alias;
}
async function safeFile(root, name) {
  relative(name);
  let current = root;
  for (const component of name.split('/')) { current = path.join(current, component); if ((await lstat(current)).isSymbolicLink()) throw new Error('Hosted export paths cannot contain symlinks'); }
  if (!(await lstat(current)).isFile() || !(await realpath(current)).startsWith(root + path.sep)) throw new Error('Hosted export file escapes its root');
  return current;
}
async function hashFile(filename) { const hash=createHash('sha256'); for await (const chunk of createReadStream(filename)) hash.update(chunk); return hash.digest('hex'); }
async function verifiedFile(root, file) {
  if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid hosted file size or SHA');
  const filename=await safeFile(root,file.path);
  if ((await lstat(filename)).size !== file.bytes || await hashFile(filename) !== file.sha256) throw new Error('Hosted file SHA/size mismatch: '+file.path);
  return filename;
}
const forbiddenMedia = item => item.metadata?.authorityDomain === 'LOCAL_TRIAL' || Boolean(item.metadata?.deliveryScopeId || item.metadata?.sourceRole || item.metadata?.private) || item.aliases.some(alias => /(?:^|\/)(?:review-audio|private|trial)(?:\/|$)/i.test(alias));
export function selectHostedMedia(rows) {
  const blockedHashes = new Set(rows.filter(forbiddenMedia).map(item=>item.sha256));
  const outputs = new Map();
  for (const item of rows) for (const alias of item.aliases.filter(value=>value.startsWith('/media/'))) {
    publicAlias(alias);
    const legacySourcePath = 'review-site/public' + alias;
    if (forbiddenMedia(item) || blockedHashes.has(item.sha256) || item.metadata?.authorityDomain !== 'IMPORTED_EVIDENCE' || item.metadata?.evidenceOnly !== true || item.metadata?.sourcePath !== legacySourcePath || !item.aliases.includes(legacySourcePath)) throw new Error('Public alias lacks an exact imported public-media registration: '+alias);
    if (item.availability !== 'PRESENT') throw new Error('Registered public media is unavailable: '+alias);
    if (!relative(item.relativePath).startsWith('media/') || item.byteSize > LIMIT) throw new Error('Public media location or hosted file limit is invalid: '+alias);
    if (outputs.has(alias)) throw new Error('Ambiguous public-media alias: '+alias);
    outputs.set(alias,{url:alias,path:'public'+alias,sourceRelativePath:item.relativePath,legacySourcePath,mediaId:item.mediaId,versionId:item.versionId,sha256:item.sha256,bytes:item.byteSize});
  }
  return [...outputs.values()].sort((a,b)=>a.url.localeCompare(b.url));
}

export async function exportHostedInstance(instancePath, output) {
  if (!instancePath || !output) throw new Error('Explicit instance and new output directory are required');
  const location=resolveInstance(instancePath);
  const target=path.resolve(output);
  if (target === location.root || target.startsWith(location.root+path.sep)) throw new Error('Hosted output cannot be inside the instance');
  const parent=await realpath(path.dirname(target));
  if (parent !== path.dirname(target)) throw new Error('Hosted output parent must be canonical');
  try { await lstat(target); throw new Error('Hosted output already exists'); } catch(error) { if(error.code!=='ENOENT')throw error; }
  const repo=(await openInstanceRepository({...location,readOnly:true}));
  const run=async()=>{
  let frozen;
    // All logical export inputs share one repository read transaction.
    frozen=await repo.readTransaction(async tx=>{
      const view=(await tx.readView());
      const release=(await tx.readRelease(view.releaseId));
      if(!release || !view.snapshot || !view.recipes)throw new Error('A published instance release is required');
      view.snapshot=structuredClone(view.snapshot);
      view.snapshot.productionModel.productionPreparation=await readProductionPreparation(tx);
      view.snapshot.productionModel.materialDirectory=publicMaterialDirectory(await readMaterialDirectory(tx));
      view.snapshot.creativeLineage={...view.snapshot.creativeLineage,spatialSettings:await readSpatialSettings(tx,view)};
      return {view,release,events:await hostedEventProjection(view),media:selectHostedMedia(await activeMediaForExport(tx,await tx.listMedia()))};
    });
  const pending=await mkdtemp(path.join(parent,'.hosted-export-pending-'));
  try {
    const files=[];
    const values=[...snapshotShards(frozen.view.snapshot),frozen.view.recipes,frozen.events];
    for(const [index,name] of JSON_FILES.entries()) {
      const value=values[index];
      const bytes=Buffer.from(JSON.stringify(value)+'\n');
      if(bytes.length>LIMIT)throw new Error('Hosted JSON shard exceeds the 16 MiB source limit: '+name);
      await writeFile(path.join(pending,name),bytes,{flag:'wx',mode:0o600});
      files.push({path:name,bytes:bytes.length,sha256:sha256(bytes)});
    }
    for(const item of frozen.media) {
      const source=await verifiedFile(location.root,{...item,path:item.sourceRelativePath});
      const destination=path.join(pending,item.path);
      await mkdir(path.dirname(destination),{recursive:true,mode:0o700});
      await copyFile(source,destination,constants.COPYFILE_EXCL);
      await verifiedFile(pending,item);
    }
    const body={schemaVersion:'1.0',kind:'REVIEW_HOSTED_EXPORT',createdAt:new Date().toISOString(),
      instanceId:frozen.view.instanceId,releaseId:frozen.view.releaseId,snapshotId:frozen.view.snapshot.snapshotId,
      runtimeEpoch:frozen.view.runtimeEpoch,repositoryRevision:frozen.view.repositoryRevision,
      releaseSnapshotSha256:frozen.release.snapshotSha256,releaseRecipesSha256:frozen.release.recipesSha256,
      sourceRevisionIds:frozen.view.sourceRevisionIds,profileRevisionId:frozen.release.profileRevisionId,
      captureMode:location.backend==='postgres'?'SINGLE_POSTGRES_REPEATABLE_READ_TRANSACTION':'SINGLE_SQLITE_READ_TRANSACTION',mediaPolicy:'REGISTERED_IMPORTED_PUBLIC_MEDIA_ONLY',
      privateAssistantIncluded:false,trialIncluded:false,originalAudioIncluded:false,files,media:frozen.media};
    const manifest={...body,manifestSha256:sha256(canonicalJson(body))};
    await writeFile(path.join(pending,MANIFEST),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
    await verifyHostedExport(pending);
    try { await lstat(target); throw new Error('Hosted output appeared during export'); } catch(error) { if(error.code!=='ENOENT')throw error; }
    await rename(pending,target);
    return {status:'HOSTED_EXPORT_VERIFIED',output:target,instanceId:body.instanceId,releaseId:body.releaseId,snapshotId:body.snapshotId,mediaFiles:body.media.length,manifestSha256:manifest.manifestSha256,readOnly:true,privateAssistantIncluded:false,trialIncluded:false,originalAudioIncluded:false};
  } catch(error) { await rm(pending,{recursive:true,force:true}); throw error; }
  };
  try{return await (repo.withMediaReadLease?repo.withMediaReadLease(run):run());}
  finally{await repo.close();}
}

export async function verifyHostedExport(directory) {
  const root=await realpath(directory);
  if ((await lstat(directory)).isSymbolicLink()) throw new Error('Hosted export root cannot be a symlink');
  const manifest=JSON.parse(await readFile(await safeFile(root,MANIFEST),'utf8'));
  const {manifestSha256,...body}=manifest;
  if(body.schemaVersion!=='1.0' || body.kind!=='REVIEW_HOSTED_EXPORT' || !['SINGLE_SQLITE_READ_TRANSACTION','SINGLE_POSTGRES_REPEATABLE_READ_TRANSACTION'].includes(body.captureMode) || body.mediaPolicy!=='REGISTERED_IMPORTED_PUBLIC_MEDIA_ONLY' || body.privateAssistantIncluded!==false || body.trialIncluded!==false || body.originalAudioIncluded!==false || sha256(canonicalJson(body))!==manifestSha256) throw new Error('Invalid hosted export manifest');
  if (!Array.isArray(body.files) || JSON.stringify(body.files.map(item=>item.path).sort())!==JSON.stringify([...JSON_FILES].sort()) || !Array.isArray(body.media)) throw new Error('Unexpected hosted export file inventory');
  const expected=new Set([MANIFEST,...body.files.map(item=>item.path)]);
  for(const file of body.files)await verifiedFile(root,file);
  for(const item of body.media) {
    publicAlias(item.url);
    if(item.path!=='public'+item.url || item.legacySourcePath!=='review-site/public'+item.url || !relative(item.sourceRelativePath).startsWith('media/') || !item.mediaId || !item.versionId || item.bytes>LIMIT || expected.has(item.path)) throw new Error('Invalid hosted media index');
    expected.add(item.path);await verifiedFile(root,item);
  }
  async function walk(relativeRoot='') {
    for(const entry of await readdir(path.join(root,relativeRoot),{withFileTypes:true})) {
      const name=relativeRoot?relativeRoot+'/'+entry.name:entry.name;
      if(entry.isSymbolicLink())throw new Error('Unexpected hosted export symlink');
      if(entry.isDirectory())await walk(name);
      else if(!entry.isFile() || !expected.delete(name))throw new Error('Unlisted hosted export file: '+name);
    }
  }
  await walk();if(expected.size)throw new Error('Hosted export is incomplete');
  const [core,productionA,productionB,recipes,events]=await Promise.all(JSON_FILES.map(name=>readFile(path.join(root,name),'utf8').then(JSON.parse)));
  if(core.snapshotId!==productionA.snapshotId || core.snapshotId!==productionB.snapshotId)throw new Error('Hosted snapshot shard identity mismatch');
  const snapshot={...core,productionModel:{...productionA.productionModel,...productionB.productionModel}};
  if(snapshot.snapshotId!==body.snapshotId || snapshot.instance?.instanceId!==body.instanceId || recipes.snapshotId!==body.snapshotId || events.snapshotId!==body.snapshotId || events.mode!=='HOSTED_READ_ONLY_EVENT_PROJECTION')throw new Error('Hosted export snapshot identity mismatch');
  return {root,manifest,snapshot,recipes,events};
}

export async function copyHostedMedia(exported, destination) {
  // Caller supplies a new staging directory; the published software public tree is never scanned.
  await mkdir(destination,{mode:0o755});
  for(const item of exported.manifest.media) {
    const source=await verifiedFile(exported.root,item);
    const name=item.url.slice('/media/'.length);
    const target=path.join(destination,relative(name));
    await mkdir(path.dirname(target),{recursive:true,mode:0o755});
    await copyFile(source,target,constants.COPYFILE_EXCL);
    await verifiedFile(destination,{...item,path:name});
  }
}

export async function installHostedMedia(exported, publicRoot) {
  // Pre-existing files must already belong to this exact export. Nothing unlisted is removed.
  const root=await realpath(publicRoot);
  if ((await lstat(publicRoot)).isSymbolicLink())throw new Error('Public root cannot be a symlink');
  const files=new Map(exported.manifest.media.map(item=>[item.url.slice(1),{...item,path:item.url.slice(1)}]));
  for(const entry of await readdir(root,{withFileTypes:true})) {
    if(!['favicon.svg','runtime','media'].includes(entry.name) || entry.isSymbolicLink())throw new Error('Unlisted public asset blocks hosted build: '+entry.name);
  }
  async function inspect(name) {
    for(const entry of await readdir(path.join(root,name),{withFileTypes:true})) {
      const relativeName=name+'/'+entry.name;
      if(entry.isSymbolicLink())throw new Error('Public media cannot contain symlinks');
      if(entry.isDirectory())await inspect(relativeName);
      else {const item=files.get(relativeName);if(!item || !entry.isFile())throw new Error('Unlisted public media blocks hosted build: '+relativeName);await verifiedFile(root,item);}
    }
  }
  try {await lstat(path.join(root,'media'));await inspect('media');}catch(error){if(error.code!=='ENOENT')throw error;}
  for(const item of exported.manifest.media) {
    const name=item.url.slice(1),destination=path.join(root,name);
    try {await lstat(destination);await verifiedFile(root,{...item,path:name});continue;}catch(error){if(error.code!=='ENOENT')throw error;}
    const source=await verifiedFile(exported.root,item);
    await mkdir(path.dirname(destination),{recursive:true,mode:0o755});
    await copyFile(source,destination,constants.COPYFILE_EXCL);
    await verifiedFile(root,{...item,path:name});
  }
}
