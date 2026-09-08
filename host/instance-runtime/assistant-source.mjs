import {createHash} from 'node:crypto';

export const SOURCE_CHUNK_BYTES = 12_000;
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value && typeof value === 'object' ? '{' + Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}' : JSON.stringify(value);
const ensure = (ok,code) => { if (!ok) { const error = new Error(code); error.code = code; throw error; } };
const sourceRoles = new Set(['SOURCE_DOCUMENT','AUTHORING_DRAFT']);
export const sourceDocumentResourceId = id => 'source:document:' + hash(id);
const chunkId = (id,index) => id + ':chunk:' + String(index).padStart(5,'0');

/** No document body is read while constructing the frozen catalog. */
export function sourceContextResources(documents,releaseId) {
  const result=[];
  for (const document of documents.filter(item => sourceRoles.has(String(item.metadata.sourceRole)))) {
    ensure(Number.isSafeInteger(document.byteSize) && document.byteSize >= 0,'CONTEXT_SOURCE_SIZE_INVALID');
    ensure(/^[a-f0-9]{64}$/.test(document.sha256),'CONTEXT_SOURCE_HASH_INVALID');
    const id=sourceDocumentResourceId(document.documentId), count=Math.max(1,Math.ceil(document.byteSize/SOURCE_CHUNK_BYTES));
    ensure(count <= 3500,'CONTEXT_SOURCE_CATALOG_TOO_LARGE');
    const title=String(document.metadata.title || document.aliases[0] || '来源资料');
    const href='/?view=story&document='+encodeURIComponent(document.documentId);
    const base={title,href,role:'REFERENCE',versionId:document.revisionId,relations:[]};
    const index={documentId:document.documentId,revisionId:document.revisionId,sourceSha256:document.sha256,byteSize:document.byteSize,chunkCount:count,firstChunkId:chunkId(id,0),lastChunkId:chunkId(id,count-1),boundary:'本资源只有目录，尚未读取正文。search_project可检索全部分块；read_resources使用分块ID读取原文。'};
    const text=JSON.stringify(index);
    result.push({...base,id,kind:'SOURCE_DOCUMENT_INDEX',text,sha256:hash(text)});
    for(let i=0;i<count;i++) {
      const sourceBinding={schemaVersion:'1.0',releaseId,documentId:document.documentId,revisionId:document.revisionId,sha256:document.sha256,byteSize:document.byteSize,byteStart:i*SOURCE_CHUNK_BYTES,byteEnd:Math.min((i+1)*SOURCE_CHUNK_BYTES,document.byteSize)};
      const metadata={sourceBinding,part:i+1,parts:count,previousResourceId:i?chunkId(id,i-1):null,nextResourceId:i+1<count?chunkId(id,i+1):null,boundary:'目录元数据不证明已读原文；实际读取返回sourceText、UTF-8字节范围与sourceTextSha256。'};
      const text=JSON.stringify(metadata);
      result.push({...base,id:chunkId(id,i),title:title+' · 第'+(i+1)+'/'+count+'部分',kind:'SOURCE_DOCUMENT_CHUNK',text,sha256:hash(text),sourceBinding});
    }
  }
  return result;
}

export function validateSourceBinding(binding) {
  const fields=['schemaVersion','releaseId','documentId','revisionId','sha256','byteSize','byteStart','byteEnd'];
  ensure(binding && typeof binding==='object' && Object.keys(binding).sort().join(',')===fields.sort().join(','),'CONTEXT_SOURCE_BINDING_INVALID');
  ensure(binding.schemaVersion==='1.0' && ['releaseId','documentId','revisionId'].every(k=>typeof binding[k]==='string' && binding[k].length>0 && binding[k].length<=2048),'CONTEXT_SOURCE_BINDING_INVALID');
  ensure(/^[a-f0-9]{64}$/.test(binding.sha256),'CONTEXT_SOURCE_BINDING_INVALID');
  ensure(['byteSize','byteStart','byteEnd'].every(k=>Number.isSafeInteger(binding[k]) && binding[k]>=0) && binding.byteStart<=binding.byteEnd && binding.byteEnd<=binding.byteSize && binding.byteEnd-binding.byteStart<=SOURCE_CHUNK_BYTES,'CONTEXT_SOURCE_BINDING_INVALID');
  ensure(binding.byteStart%SOURCE_CHUNK_BYTES===0 && binding.byteEnd===Math.min(binding.byteStart+SOURCE_CHUNK_BYTES,binding.byteSize),'CONTEXT_SOURCE_BINDING_INVALID');
}

/** Nominal byte windows are advanced to UTF-8 boundaries; adjacent windows meet exactly. */
export function decodeSourceChunk(bytes,binding) {
  validateSourceBinding(binding);
  ensure(bytes.length===binding.byteSize && hash(bytes)===binding.sha256,'CONTEXT_SOURCE_BYTES_INVALID');
  new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
  return sliceVerifiedSourceChunk(bytes,binding);
}

function sliceVerifiedSourceChunk(bytes,binding) {
  const boundary=offset=>{while(offset<bytes.length && (bytes[offset]&0xc0)===0x80)offset++;return offset;};
  const byteStart=boundary(binding.byteStart), byteEnd=boundary(binding.byteEnd);
  const content=bytes.subarray(byteStart,byteEnd), sourceText=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(content);
  return {sourceText,sourceTextSha256:hash(content),sourceSha256:binding.sha256,revisionId:binding.revisionId,byteStart,byteEnd,byteSize:bytes.length};
}

export async function readFrozenSourceCatalog(tx,catalogHash) {
  ensure(/^[a-f0-9]{64}$/.test(catalogHash),'CONTEXT_CATALOG_HASH_INVALID');
  const saved=await tx.getAux('assistant-public','catalogs/'+catalogHash+'.json');
  ensure(saved && !saved.deleted && hash(saved.bytes)===saved.sha256,'CONTEXT_CATALOG_UNAVAILABLE');
  const catalog=JSON.parse(Buffer.from(saved.bytes).toString('utf8'));
  ensure(['1.1','1.2'].includes(catalog.schemaVersion) && hash(canonical(catalog))===catalogHash,'CONTEXT_CATALOG_HASH_INVALID');
  const state=await tx.getMetadata();
  const profileRecord=await tx.getRecord('settings','instance-profile',state.profileRevisionId);
  ensure(profileRecord && hash(profileRecord.bytes)===profileRecord.sha256,'CONTEXT_SCOPE_INVALID');
  const profile=JSON.parse(Buffer.from(profileRecord.bytes).toString('utf8'));
  ensure(profile.instanceId===state.instanceId && catalog.projectId===profile.projectId && catalog.scopeKey===profile.assistant.scopeKey,'CONTEXT_SCOPE_INVALID');
  return catalog;
}

async function exactSourceBytes(tx,binding,cache) {
  validateSourceBinding(binding);
  const key=binding.releaseId+':'+binding.revisionId+':'+binding.sha256;
  if(cache.has(key))return cache.get(key);
  const release=await tx.readRelease(binding.releaseId);
  ensure(release && release.sourceRevisionIds.includes(binding.revisionId),'CONTEXT_SOURCE_NOT_PUBLISHED');
  const document=await tx.readDocumentRevision(binding.revisionId);
  ensure(document && !document.deleted && document.documentId===binding.documentId && document.sha256===binding.sha256 && sourceRoles.has(String(document.metadata.sourceRole)),'CONTEXT_SOURCE_BINDING_INVALID');
  const bytes=Buffer.from(document.bytes);
  ensure(bytes.length===binding.byteSize && hash(bytes)===binding.sha256,'CONTEXT_SOURCE_BYTES_INVALID');
  new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
  cache.set(key,bytes);
  return bytes;
}

export async function readFrozenSourceChunk(tx,catalogHash,resourceId) {
  const catalog=await readFrozenSourceCatalog(tx,catalogHash);
  const resource=resolveCatalogResource(catalog,resourceId);
  ensure(resource,'CONTEXT_SOURCE_RESOURCE_UNAVAILABLE');
  if(resource.bodyBinding){ensure(resource.bodyRange,'CONTEXT_BODY_CHUNK_REQUIRED');return derivedChunk(await exactDerivedBytes(tx,resource),resource);}
  ensure(resource.sourceBinding,'CONTEXT_SOURCE_RESOURCE_UNAVAILABLE');
  const bytes=await exactSourceBytes(tx,resource.sourceBinding,new Map());
  return {resourceId,...sliceVerifiedSourceChunk(bytes,resource.sourceBinding)};
}

export function sourceSearchScore(resource,text,query) {
  const terms=(query.match(/[a-z0-9_-]+|[\u3400-\u9fff]+/g)||[query]).slice(0,20);
  const title=resource.title.toLocaleLowerCase(),id=resource.id.toLocaleLowerCase(),lower=text.toLocaleLowerCase();
  let score=terms.reduce((sum,term)=>sum+8*Number(title.includes(term))+2*Number(id.includes(term))+Number(lower.includes(term)),0);
  if(!score){const pairs=[];for(let i=0;i<query.length-1;i++)if(/^[\u3400-\u9fff]{2}$/.test(query.slice(i,i+2)))pairs.push(query.slice(i,i+2));score=pairs.slice(0,30).reduce((sum,term)=>sum+2*Number(title.includes(term))+Number(lower.includes(term)),0)/100;}
  return score;
}

/** Search original bytes without returning them or marking any evidence as read. */
export async function searchFrozenSourceChunks(tx,catalogHash,query) {
  ensure(typeof query==='string' && query.trim() && query.length<=240,'CONTEXT_SOURCE_QUERY_INVALID');
  const catalog=await readFrozenSourceCatalog(tx,catalogHash), cache=new Map(), matches=[];
  for(const resource of catalog.resources) {
    if(resource.role==='HISTORICAL')continue;
    if(resource.bodyBinding){
      for(const binding of [resource.bodyBinding,resource.relationBinding].filter(Boolean)){
      const indexed={...resource,bodyBinding:binding};
      const bytes=await exactDerivedBytes(tx,indexed);
      for(let i=0;i<binding.chunkCount;i++){
        const part=resolveCatalogResource(catalog,bodyChunkId(indexed,i)),chunk=derivedChunk(bytes,part);
        let end=Math.min(bytes.length,chunk.byteEnd+1024);while(end<bytes.length&&(bytes[end]&0xc0)===0x80)end++;
        const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes.subarray(chunk.byteStart,end));
        const score=sourceSearchScore(part,text,query.trim().toLocaleLowerCase());if(score)matches.push({id:part.id,score});
      }
      }
      continue;
    }
    if(!resource.sourceBinding)continue;
    const bytes=await exactSourceBytes(tx,resource.sourceBinding,cache);
    const chunk=sliceVerifiedSourceChunk(bytes,resource.sourceBinding);
    // Search includes bounded neighbouring text, so a phrase crossing a page boundary is discoverable.
    const overlapEnd=Math.min(bytes.length,chunk.byteEnd+1024);
    let end=overlapEnd;while(end<bytes.length && (bytes[end]&0xc0)===0x80)end++;
    const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes.subarray(chunk.byteStart,end));
    const score=sourceSearchScore(resource,text,query.trim().toLocaleLowerCase());
    if(score)matches.push({id:resource.id,score});
  }
  return {matches,fullTextRead:false};
}

/** Derived business bodies are frozen separately; catalog cardinality never grows with chunks. */
const derivedBodies = new WeakMap();
const initialSourceCosts = new WeakMap();
export const DERIVED_BODY_MAX_BYTES = 32 * 1024 * 1024;
export function bodyChunkId(resource,index) {
  return resource.id+':body:'+resource.bodyBinding.sha256+':'+String(index).padStart(6,'0');
}
export function validateBodyBinding(binding) {
  const keys=['schemaVersion','sha256','byteSize','characterCount','chunkCount'];
  ensure(binding&&typeof binding==='object'&&Object.keys(binding).sort().join(',')===keys.sort().join(','),'CONTEXT_BODY_BINDING_INVALID');
  ensure(binding.schemaVersion==='1.0'&&/^[a-f0-9]{64}$/.test(binding.sha256),'CONTEXT_BODY_BINDING_INVALID');
  ensure(['byteSize','characterCount','chunkCount'].every(k=>Number.isSafeInteger(binding[k])&&binding[k]>=0)
    &&binding.byteSize<=DERIVED_BODY_MAX_BYTES&&binding.characterCount<=binding.byteSize
    &&binding.chunkCount===Math.max(1,Math.ceil(binding.byteSize/SOURCE_CHUNK_BYTES)),'CONTEXT_BODY_BINDING_INVALID');
}
export function compactResourceCatalog(catalog) {
  const bodies=new Map(),resources=catalog.resources.map(resource=>{
    if(resource.bodyBinding){validateBodyBinding(resource.bodyBinding);return resource;}
    if(resource.sourceBinding||resource.kind==='PROJECT_GUIDANCE'||resource.text.length<=2048&&resource.relations.length<=128)return resource;
    const bytes=Buffer.from(resource.text,'utf8'),sha256=hash(bytes);
    ensure(bytes.length<=DERIVED_BODY_MAX_BYTES,'CONTEXT_BODY_STORAGE_CAPACITY');
    ensure(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)===resource.text,'CONTEXT_BODY_UTF8_INVALID');
    const bodyBinding={schemaVersion:'1.0',sha256,byteSize:bytes.length,characterCount:[...resource.text].length,chunkCount:Math.max(1,Math.ceil(bytes.length/SOURCE_CHUNK_BYTES))};
    let relationBinding;
    if(resource.relations.length>128){
      ensure(resource.relations.length<=10000&&new Set(resource.relations).size===resource.relations.length,'CONTEXT_RELATION_CAPACITY');
      const relationText=JSON.stringify(resource.relations),relationBytes=Buffer.from(relationText),relationSha=hash(relationBytes);
      relationBinding={schemaVersion:'1.0',sha256:relationSha,byteSize:relationBytes.length,characterCount:[...relationText].length,chunkCount:Math.max(1,Math.ceil(relationBytes.length/SOURCE_CHUNK_BYTES))};
      bodies.set(relationSha,relationBytes);
    }
    const value={...resource,bodyBinding,...(relationBinding?{relations:[],relationBinding}:{})};
    const text=JSON.stringify({resourceId:resource.id,bodyBinding,...(relationBinding?{relationBinding,relationCount:resource.relations.length,firstRelationChunkId:bodyChunkId({...value,bodyBinding:relationBinding},0)}:{}),firstChunkId:bodyChunkId(value,0),lastChunkId:bodyChunkId(value,bodyBinding.chunkCount-1),
      boundary:'仅正文索引，尚未读取正文。read_resources按分块ID读取精确UTF-8范围；search_project检索全部正文。索引不证明已读任何正文块。'});
    bodies.set(sha256,bytes);return {...value,text,sha256:hash(text)};
  });
  const result={...catalog,schemaVersion:'1.2',resources};
  derivedBodies.set(result,bodies);return result;
}
export function catalogBodyRecords(catalog) {
  return [...(derivedBodies.get(catalog)||new Map())].map(([sha256,bytes])=>({sha256,bytes}));
}
export function resolveCatalogResource(catalog,resourceId) {
  const direct=catalog.resources.filter(r=>r.id===resourceId);
  if(direct.length)return direct.length===1?direct[0]:null;
  if(catalog.schemaVersion!=='1.2'||typeof resourceId!=='string')return null;
  const marker=resourceId.lastIndexOf(':body:');if(marker<0)return null;
  const baseId=resourceId.slice(0,marker),parts=resourceId.slice(marker+6).split(':');
  const bases=catalog.resources.filter(r=>r.id===baseId&&(r.bodyBinding?.sha256===parts[0]||r.relationBinding?.sha256===parts[0]));if(bases.length!==1||parts.length!==2||!/^\d{6}$/.test(parts[1]))return null;
  const original=bases[0],section=original.bodyBinding?.sha256===parts[0]?'TEXT':'RELATIONS';
  const base={...original,bodyBinding:section==='TEXT'?original.bodyBinding:original.relationBinding};validateBodyBinding(base.bodyBinding);const index=Number(parts[1]);
  if(index>=base.bodyBinding.chunkCount||bodyChunkId(base,index)!==resourceId)return null;
  const bodyRange={byteStart:index*SOURCE_CHUNK_BYTES,byteEnd:Math.min((index+1)*SOURCE_CHUNK_BYTES,base.bodyBinding.byteSize)};
  const text=JSON.stringify({resourceId:base.id,bodySha256:base.bodyBinding.sha256,...bodyRange,byteSize:base.bodyBinding.byteSize,part:index+1,parts:base.bodyBinding.chunkCount,
    previousResourceId:index?bodyChunkId(base,index-1):null,nextResourceId:index+1<base.bodyBinding.chunkCount?bodyChunkId(base,index+1):null,
    boundary:'本条元数据未包含正文；实际读取返回sourceText、sourceTextSha256和精确字节范围，不代表其他块已读。'});
  const {media,relationBinding,...metadata}=base;
  return {...metadata,relations:[],id:resourceId,title:base.title+' · 正文第'+(index+1)+'/'+base.bodyBinding.chunkCount+'部分',text,sha256:hash(text),bodyRange,bodyOf:base.id,bodySection:section};
}
async function exactDerivedBytes(tx,resource) {
  validateBodyBinding(resource.bodyBinding);
  const record=await tx.getAux('assistant-public','resource-bodies/'+resource.bodyBinding.sha256+'.txt');
  ensure(record&&!record.deleted&&record.sha256===resource.bodyBinding.sha256,'CONTEXT_BODY_UNAVAILABLE');
  const bytes=Buffer.from(record.bytes);
  ensure(bytes.length===resource.bodyBinding.byteSize&&hash(bytes)===resource.bodyBinding.sha256,'CONTEXT_BODY_BYTES_INVALID');
  const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
  ensure([...text].length===resource.bodyBinding.characterCount,'CONTEXT_BODY_BYTES_INVALID');return bytes;
}
function derivedChunk(bytes,resource) {
  const chunk=sliceVerifiedSourceChunk(bytes,{...resource.bodyRange,sha256:resource.bodyBinding.sha256,revisionId:resource.versionId||resource.bodyBinding.sha256});
  return {resourceId:resource.id,bodyOf:resource.bodyOf,bodySection:resource.bodySection,bodySha256:resource.bodyBinding.sha256,...chunk,wholeBodyRead:chunk.byteStart===0&&chunk.byteEnd===bytes.length};
}

/** Server-side sizing is not a model read receipt. Only initial source candidates are verified here. */
export async function prepareInitialSourceReadCosts(tx,catalog,resourceIds) {
  const costs=new Map(),cache=new Map();
  for(const id of [...new Set(resourceIds)].slice(0,48)){
    const resource=resolveCatalogResource(catalog,id);if(!resource?.sourceBinding)continue;
    const bytes=await exactSourceBytes(tx,resource.sourceBinding,cache);
    const result={resourceId:id,...sliceVerifiedSourceChunk(bytes,resource.sourceBinding)};
    costs.set(id,{bindingHash:hash(canonical(resource.sourceBinding)),characters:canonical(result).length});
  }
  initialSourceCosts.set(catalog,costs);
}

/** Same envelope as host read_resources: canonical resource + source result + 256.
 * JS UTF-16 length is >= Python Unicode length. The 256 allowance covers observation,
 * index/read state and array punctuation; it never claims that the body was read.
 */
export function catalogResourceReadCharacters(catalog,resource) {
  let sourceCharacters=2; // The host returns {} when there is no deferred text read.
  if(resource.bodyRange){
    const bytes=derivedBodies.get(catalog)?.get(resource.bodyBinding.sha256);
    if(bytes)sourceCharacters=canonical(derivedChunk(bytes,resource)).length;
    else sourceCharacters=unknownSourceReadCharacters(resource);
  } else if(resource.sourceBinding){
    const cost=initialSourceCosts.get(catalog)?.get(resource.id);
    sourceCharacters=cost?.bindingHash===hash(canonical(resource.sourceBinding))?cost.characters:unknownSourceReadCharacters(resource);
  }
  return canonical(resource).length+sourceCharacters+256;
}
function unknownSourceReadCharacters(resource) {
  const binding=resource.sourceBinding||resource.bodyBinding,range=resource.sourceBinding||resource.bodyRange;
  const byteEnd=Math.min(binding.byteSize,range.byteEnd+3),byteStart=Math.min(binding.byteSize,range.byteStart+3);
  const envelope={resourceId:resource.id,sourceText:'',sourceTextSha256:'0'.repeat(64),sourceSha256:binding.sha256,
    revisionId:resource.sourceBinding?binding.revisionId:resource.versionId||binding.sha256,byteStart,byteEnd,byteSize:binding.byteSize,
    ...(resource.bodyRange?{bodyOf:resource.bodyOf,bodySection:resource.bodySection,bodySha256:binding.sha256,wholeBodyRead:false}:{})};
  // Only deserialized/unprepared catalogs use this safe bound. Live initial candidates
  // use exact JSON escaped costs, so ordinary 12k chunks remain attachable.
  return canonical(envelope).length+6*(byteEnd-range.byteStart);
}
