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
  ensure(catalog.schemaVersion==='1.1' && hash(canonical(catalog))===catalogHash,'CONTEXT_CATALOG_HASH_INVALID');
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
  const matches=catalog.resources.filter(resource=>resource.id===resourceId);
  ensure(matches.length===1 && matches[0].sourceBinding,'CONTEXT_SOURCE_RESOURCE_UNAVAILABLE');
  const resource=matches[0], bytes=await exactSourceBytes(tx,resource.sourceBinding,new Map());
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
    if(!resource.sourceBinding || resource.role==='HISTORICAL')continue;
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
