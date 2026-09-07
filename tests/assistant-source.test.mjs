import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {SOURCE_CHUNK_BYTES,sourceContextResources,decodeSourceChunk,readFrozenSourceChunk,searchFrozenSourceChunks} from '../host/instance-runtime/assistant-source.mjs';

const hash=x=>createHash('sha256').update(x).digest('hex');
const canonical=x=>Array.isArray(x)?'['+x.map(canonical).join(',')+']':x&&typeof x==='object'?'{'+Object.entries(x).filter(([,v])=>v!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}':JSON.stringify(x);
function fixture(content) {
 const bytes=Buffer.from(content), document={documentId:'source:test',revisionId:'revision:test',sha256:hash(bytes),byteSize:bytes.length,aliases:['test.md'],metadata:{sourceRole:'SOURCE_DOCUMENT',title:'来源测试'}};
 Object.defineProperty(document,'bytes',{get(){throw new Error('Catalog must not read source bodies');}});
 const resources=sourceContextResources([document],'release:one');
 const catalog={schemaVersion:'1.1',projectId:'project:test',scopeKey:'local:project:test',snapshotId:'snapshot:one',resources},catalogBytes=Buffer.from(canonical(catalog)),catalogHash=hash(catalogBytes);
 const profile=Buffer.from(JSON.stringify({instanceId:'instance:test',projectId:catalog.projectId,assistant:{scopeKey:catalog.scopeKey}}));
 const calls={sourceReads:0}, tx={
  async getAux(namespace,key){assert.equal(namespace,'assistant-public');assert.equal(key,'catalogs/'+catalogHash+'.json');return {bytes:catalogBytes,sha256:catalogHash};},
  async getMetadata(){return {instanceId:'instance:test',profileRevisionId:'profile:test'};},
  async getRecord(){return {bytes:profile,sha256:hash(profile)};},
  async readRelease(releaseId){assert.equal(releaseId,'release:one');return {sourceRevisionIds:[document.revisionId]};},
  async readDocumentRevision(revisionId){calls.sourceReads++;assert.equal(revisionId,document.revisionId);return {...document,bytes};},
 };
 return {bytes,document,resources,catalog,catalogHash,calls,tx};
}

test('catalog construction is metadata-only and does not contain the source body',()=>{
 const f=fixture('不可注入正文'.repeat(30000));
 assert.equal(f.calls.sourceReads,0);
 assert(!canonical(f.catalog).includes('不可注入正文'));
 assert.equal(f.resources[0].kind,'SOURCE_DOCUMENT_INDEX');
 assert(f.resources.length>2);
});

for(const [label,content] of [
 ['current-length Chinese','正文。'.repeat(37454)+'终点'],
 ['over-200k single line','a'.repeat(220001)+'ONLY_AT_THE_END'],
 ['unicode CRLF BOM','\ufeff'+('汉字🙂𠀀\r\n').repeat(15000)],
 ['escaped controls','\u0000\u0001"\\\t'.repeat(20000)],
 ['empty',''],
])test('exact complete source reconstruction: '+label,async()=>{
 const f=fixture(content),chunks=f.resources.filter(r=>r.sourceBinding),parts=[];
 let offset=0;
 for(const resource of chunks){
  const chunk=await readFrozenSourceChunk(f.tx,f.catalogHash,resource.id);
  assert.equal(chunk.byteStart,offset);
  assert.equal(hash(Buffer.from(chunk.sourceText)),chunk.sourceTextSha256);
  assert(chunk.sourceText.length<=16000);
  assert(canonical({...resource,...chunk}).length<=80000);
  parts.push(Buffer.from(chunk.sourceText));offset=chunk.byteEnd;
 }
 assert.equal(offset,f.bytes.length);
 assert.deepEqual(Buffer.concat(parts),f.bytes);
 assert.equal(hash(Buffer.concat(parts)),f.document.sha256);
});

test('search discovers text after 200k and across chunk boundaries without returning body',async()=>{
 const content='a'.repeat(SOURCE_CHUNK_BYTES-3)+'跨边界检索标记'+'b'.repeat(230000)+'ONLY_AT_THE_END';
 const f=fixture(content);
 for(const query of ['ONLY_AT_THE_END','跨边界检索标记']){
  const result=await searchFrozenSourceChunks(f.tx,f.catalogHash,query);
  assert(result.matches.length>0);
  assert.equal(result.fullTextRead,false);
  assert(result.matches.every(match=>Object.keys(match).sort().join(',')==='id,score'));
  const read=await readFrozenSourceChunk(f.tx,f.catalogHash,result.matches[0].id);
  assert(read.sourceText.length>0);
 }
});

test('exact revision is read even if a newer document head exists; tampering is rejected',async()=>{
 const f=fixture('精确旧修订'.repeat(10000)),resource=f.resources.find(r=>r.sourceBinding);
 f.tx.readDocument=()=>{throw new Error('must not read current head');};
 assert((await readFrozenSourceChunk(f.tx,f.catalogHash,resource.id)).sourceText.includes('精确旧修订'));
 const original=f.tx.readDocumentRevision;
 f.tx.readDocumentRevision=async revisionId=>({...await original(revisionId),bytes:Buffer.from('corrupt')});
 await assert.rejects(readFrozenSourceChunk(f.tx,f.catalogHash,resource.id),/CONTEXT_SOURCE_BYTES_INVALID/);
 await assert.rejects(readFrozenSourceChunk(f.tx,f.catalogHash,'outside:source'),/CONTEXT_SOURCE_RESOURCE_UNAVAILABLE/);
});

test('invalid UTF-8 and unpublished bindings fail closed',async()=>{
 const f=fixture('x'),resource=f.resources.find(r=>r.sourceBinding);
 assert.throws(()=>decodeSourceChunk(Buffer.from([0xff]),{...resource.sourceBinding,sha256:hash(Buffer.from([0xff]))}));
 f.tx.readRelease=async()=>({sourceRevisionIds:[]});
 await assert.rejects(readFrozenSourceChunk(f.tx,f.catalogHash,resource.id),/CONTEXT_SOURCE_NOT_PUBLISHED/);
});

test('optional exact published transcript file reconstructs without truncation',{skip:!process.env.REVIEW_ASSISTANT_SOURCE_TEST_FILE},async()=>{
 const bytes=await readFile(process.env.REVIEW_ASSISTANT_SOURCE_TEST_FILE);
 assert.match(process.env.REVIEW_ASSISTANT_SOURCE_TEST_SHA256||'',/^[a-f0-9]{64}$/);
 assert.equal(hash(bytes),process.env.REVIEW_ASSISTANT_SOURCE_TEST_SHA256);
 const f=fixture(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)),parts=[];
 for(const resource of f.resources.filter(r=>r.sourceBinding))parts.push(Buffer.from((await readFrozenSourceChunk(f.tx,f.catalogHash,resource.id)).sourceText));
 assert.deepEqual(Buffer.concat(parts),bytes);
});
