import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {compactResourceCatalog,catalogBodyRecords,resolveCatalogResource,bodyChunkId,readFrozenSourceChunk,searchFrozenSourceChunks,sourceContextResources,prepareInitialSourceReadCosts} from '../host/instance-runtime/assistant-source.mjs';
const site=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),require=createRequire(import.meta.url),ts=require('typescript');
const source=readFileSync(path.join(site,'app/assistant/context-catalog.ts'),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const module={exports:{}};new Function('require','module','exports',compiled)(specifier=>specifier.startsWith('.')?require(path.resolve(site,'app/assistant',specifier)):require(specifier),module,module.exports);
const {canonicalContextJson:canonical,contextTextHash:hash,contextObjectHash:digest,validateResourceCatalog,selectInitialResources,contextDependencyHash,sealContextPacket}=module.exports;
const raw=(id,text,extra={})=>({id,title:'合成业务资源 '+id,kind:'MATERIAL_REQUIREMENT',text,sha256:hash(text),href:'/?view=materials',relations:[],role:'REFERENCE',versionId:'revision:one',...extra});
function fixture(resources){
 const catalog=compactResourceCatalog({schemaVersion:'1.0',projectId:'project:test',scopeKey:'local:project:test',snapshotId:'snapshot:one',resources});
 validateResourceCatalog(catalog);
 const bytes=Buffer.from(canonical(catalog)),catalogHash=hash(bytes),bodies=new Map(catalogBodyRecords(catalog).map(r=>['resource-bodies/'+r.sha256+'.txt',{bytes:Buffer.from(r.bytes),sha256:r.sha256}]));
 const profile=Buffer.from(JSON.stringify({instanceId:'instance:test',projectId:catalog.projectId,assistant:{scopeKey:catalog.scopeKey}}));
 const counts={bodyReads:0};
 const tx={getAux:async(ns,key)=>{assert.equal(ns,'assistant-public');if(key==='catalogs/'+catalogHash+'.json')return{bytes,sha256:catalogHash};counts.bodyReads++;return bodies.get(key)||null;},getMetadata:async()=>({instanceId:'instance:test',profileRevisionId:'profile:one'}),getRecord:async()=>({bytes:profile,sha256:hash(profile)})};
 return{catalog,catalogHash,bodies,tx,counts};
}
test('real-sized1944 and future6000 resources retain all IDs with >12MiB bodies but bounded metadata',async()=>{
 for(const count of [1944,6000]){
  const width=count===1944?7100:2500;
  const resources=Array.from({length:count},(_,i)=>raw('resource:'+i,'原文🙂 '+String(i)+' '+'x'.repeat(width)+(i===count-1?' UNIQUE_TAIL_SENTINEL':'')));
  const inputBytes=Buffer.byteLength(canonical(resources));assert(inputBytes>12*1024*1024);
  const f=fixture(resources),size=Buffer.byteLength(canonical(f.catalog));
  assert(size<12*1024*1024);assert.equal(f.catalog.resources.length,count);assert.equal(f.counts.bodyReads,0);
  assert.deepEqual(f.catalog.resources.map(r=>r.id),resources.map(r=>r.id));
  assert(!canonical(f.catalog).includes('UNIQUE_TAIL_SENTINEL'));
  const initial=selectInitialResources(f.catalog,[resources.at(-1).id],[]);
  assert(initial.characters<72000);assert(JSON.parse(f.catalog.resources.at(-1).text).boundary.includes('尚未读取正文'));
  const found=await searchFrozenSourceChunks(f.tx,f.catalogHash,'UNIQUE_TAIL_SENTINEL');
  assert.equal(found.fullTextRead,false);assert(found.matches.length);
  const selected=resolveCatalogResource(f.catalog,found.matches[0].id);
  assert.equal(selected.bodyOf,resources.at(-1).id);assert.equal(selected.role,'REFERENCE');assert.equal(selected.versionId,'revision:one');
  const read=await readFrozenSourceChunk(f.tx,f.catalogHash,selected.id);assert(read.sourceText.includes('UNIQUE_TAIL_SENTINEL'));
  console.log(JSON.stringify({resources:count,inputBytes,catalogBytes:size,tailSearch:true}));
 }
});
test('single >80k business body preserves every UTF8 byte, CRLF, BOM and cross-boundary search',async()=>{
 const text='\ufeff'+'汉字🙂𠀀\r\n'.repeat(23000)+' EXACT_FINAL_MARKER',f=fixture([raw('large:one',text)]);
 const index=f.catalog.resources[0],out=[];let end=0;
 assert(text.length>80000);assert.equal(f.catalog.resources.length,1);
 for(let i=0;i<index.bodyBinding.chunkCount;i++){
  const item=await readFrozenSourceChunk(f.tx,f.catalogHash,bodyChunkId(index,i));
  assert.equal(item.byteStart,end);assert.equal(hash(Buffer.from(item.sourceText)),item.sourceTextSha256);assert.equal(item.bodyOf,index.id);
  assert.equal(item.wholeBodyRead,false);out.push(Buffer.from(item.sourceText));end=item.byteEnd;
 }
 assert.deepEqual(Buffer.concat(out),Buffer.from(text));assert.equal(end,Buffer.byteLength(text));
 assert((await searchFrozenSourceChunks(f.tx,f.catalogHash,'EXACT_FINAL_MARKER')).matches.length);
 const crossing=fixture([raw('boundary','a'.repeat(11997)+'跨页检索标记'+'b'.repeat(90000))]);
 assert((await searchFrozenSourceChunks(crossing.tx,crossing.catalogHash,'跨页检索标记')).matches.length);
});
test('656 and6000 relations are retained in exact deferred tables, without catalog expansion',async()=>{
 for(const count of [656,6000]){
  const relations=Array.from({length:count},(_,i)=>'related:'+String(i).padStart(6,'0')),f=fixture([raw('index','业务总览',{relations})]),index=f.catalog.resources[0];
  assert.equal(f.catalog.resources.length,1);assert.deepEqual(index.relations,[]);assert(index.relationBinding);
  assert.equal(JSON.parse(index.text).relationCount,count);const out=[];
  for(let i=0;i<index.relationBinding.chunkCount;i++){const id=bodyChunkId({...index,bodyBinding:index.relationBinding},i),part=await readFrozenSourceChunk(f.tx,f.catalogHash,id);assert.equal(part.bodySection,'RELATIONS');out.push(Buffer.from(part.sourceText));}
  assert.deepEqual(JSON.parse(Buffer.concat(out).toString()),relations);
  assert((await searchFrozenSourceChunks(f.tx,f.catalogHash,relations.at(-1))).matches.length);
 }
});
test('catalog scope, whole SHA, chunk identity and changed dependencies reject tampering',async()=>{
 const f=fixture([raw('one','safe '.repeat(20000))]),index=f.catalog.resources[0],id=bodyChunkId(index,1),part=resolveCatalogResource(f.catalog,id);
 assert.equal(contextDependencyHash(f.catalog,[id]),contextDependencyHash(f.catalog,[id]));
 for(const invalid of [id.replace(index.bodyBinding.sha256,'0'.repeat(64)),id.replace(':000001',':1'),'outside:resource'])await assert.rejects(readFrozenSourceChunk(f.tx,f.catalogHash,invalid));
 const other=fixture([raw('one','changed '.repeat(15000))]);assert.equal(resolveCatalogResource(other.catalog,id),null);assert.throws(()=>contextDependencyHash(other.catalog,[id]));
 const record=f.bodies.get('resource-bodies/'+part.bodyBinding.sha256+'.txt');record.bytes=Buffer.from('tamper');await assert.rejects(readFrozenSourceChunk(f.tx,f.catalogHash,id),/CONTEXT_BODY_BYTES_INVALID/);
 await assert.rejects(readFrozenSourceChunk(f.tx,'0'.repeat(64),id),/CONTEXT_CATALOG/);
});
test('legacy capacity is unchanged;1.2 has count and whole-byte caps without widening model budgets',()=>{
 const resources=Array.from({length:6000},(_,i)=>raw('x:'+i,'small'));
 assert.throws(()=>validateResourceCatalog({schemaVersion:'1.1',projectId:'p',scopeKey:'s',snapshotId:'x',resources}),/CONTEXT_CATALOG_TOO_LARGE/);
 validateResourceCatalog(compactResourceCatalog({schemaVersion:'1.0',projectId:'p',scopeKey:'s',snapshotId:'x',resources}));
 assert.throws(()=>validateResourceCatalog({schemaVersion:'1.2',projectId:'p',scopeKey:'s',snapshotId:'x',resources:Array(10001).fill(resources[0])}),/CONTEXT_CATALOG_TOO_LARGE/);
 const bulky=resources.map(r=>({...r,title:'x'.repeat(2500)}));
 assert.throws(()=>validateResourceCatalog(compactResourceCatalog({schemaVersion:'1.0',projectId:'p',scopeKey:'s',snapshotId:'x',resources:bulky})),/CONTEXT_CATALOG_TOO_LARGE/);
 const f=fixture([raw('policy','x'.repeat(79000),{kind:'PROJECT_GUIDANCE'})]);assert.throws(()=>selectInitialResources(f.catalog,['policy'],[]),/CONTEXT_REQUIRED_EVIDENCE_TOO_LARGE/);
});
test('host1.2 distinguishes index vs actual blocks and enforces100 reads plus120k text budget',async()=>{
 const resources=Array.from({length:105},(_,i)=>raw('host:'+i,'正文'+i+' '+'x'.repeat(2400))),f=fixture(resources);
 const focus={projectId:'project:test',snapshotId:'snapshot:one',view:'work',subjectType:'PROJECT',subjectId:'project:test',title:'测试'};
 const packet=sealContextPacket({schemaVersion:'1.2',projectId:'project:test',scopeKey:'local:project:test',snapshotId:'snapshot:one',focus,focusKey:'f'.repeat(64),dependencyHash:contextDependencyHash(f.catalog,['host:0']),catalogHash:f.catalogHash,initialResourceIds:['host:0'],draftTargets:[],missing:[]});
 const chunks={};for(const r of f.catalog.resources.slice(0,3))chunks[bodyChunkId(r,0)]=await readFrozenSourceChunk(f.tx,f.catalogHash,bodyChunkId(r,0));
 const python=readFileSync(path.join(site,'host/codex_work_context.py'),'utf8');
 const program=String.raw`
import json,sys,types,pathlib,hashlib
data=json.loads(sys.stdin.buffer.read(int(sys.argv[1])))
sys.path.insert(0,data["host"])
mod=types.ModuleType("catalog_capacity_host");mod.__file__=data["host"]+"/codex_work_context.py";exec(compile(data["python"],mod.__file__,"exec"),mod.__dict__)
mod.check_directory=lambda path:None
records={data["packet"]["packetId"]+".json":data["packet"],data["packet"]["body"]["catalogHash"]+".json":data["catalog"]}
mod.read_json=lambda path,maximum:records[path.name]
turn={"assistantContext":{"packetId":data["packet"]["packetId"],"packetHash":data["packet"]["packetHash"]},"snapshotId":"snapshot:one","userMessage":"核验"}
w=mod.WorkContext(pathlib.Path("/explicit-fixture"),pathlib.Path("/frozen-fixture"),turn,project_id="project:test")
class Fake:
    def source_chunk(self,catalog,resource):
        assert catalog==data["packet"]["body"]["catalogHash"]
        return data["chunks"][resource]
w.instance=Fake()
initial=json.loads(w.initial_prompt([]))
assert initial["currentResources"][0]["bodyState"]=="INDEX_ONLY_BODY_NOT_READ"
assert not initial["currentResources"][0]["wholeBodyRead"]
assert "sourceText" not in initial["currentResources"][0]
assert not w.source_reads
ids=list(data["chunks"])
read=w.read_resources([ids[0]])["resources"][0]
assert read["bodyState"]=="BODY_CHUNK_READ" and read["bodyOf"]=="host:0"
assert read["sourceText"].startswith("正文0")
def with_initial(initial_ids):
    body=dict(data["packet"]["body"]);body["initialResourceIds"]=initial_ids
    packet_hash=mod.digest(body);packet={"packetId":"ctx_"+packet_hash,"packetHash":packet_hash,"body":body}
    records[packet["packetId"]+".json"]=packet
    turn_with={**turn,"assistantContext":{"packetId":packet["packetId"],"packetHash":packet_hash}}
    instance=mod.WorkContext(pathlib.Path("/explicit-fixture"),pathlib.Path("/frozen-fixture"),turn_with,project_id="project:test")
    instance.instance=Fake();return instance
virtual_initial=with_initial([ids[0]])
virtual_prompt=json.loads(virtual_initial.initial_prompt([]))
assert virtual_prompt["currentResources"][0]["sourceText"].startswith("正文0")
assert virtual_prompt["currentResources"][0]["bodyState"]=="BODY_CHUNK_READ"
assert ids[0] in virtual_initial.read_ids and "host:0" not in virtual_initial.read_ids
try:with_initial([ids[0].replace(data["catalog"]["resources"][0]["bodyBinding"]["sha256"],"0"*64)]);raise AssertionError("tampered virtual initial accepted")
except mod.ContextError:pass
try:with_initial([ids[0]]*49);raise AssertionError("48-initial cap missing")
except mod.ContextError:pass
bad=dict(data["chunks"][ids[1]]);bad["byteEnd"]+=1;data["chunks"][ids[1]]=bad
try:w.read_resources([ids[1]]);raise AssertionError("tamper accepted")
except mod.ContextError:pass
w.read_ids=set("unrelated:"+str(i) for i in range(100))
try:w.read_resources([ids[2]]);raise AssertionError("100-read cap missing")
except mod.ContextError as e:assert e.code=="RESOURCE_BUDGET_EXCEEDED"
w.read_ids=set();w.text_chars=119999
try:w.read_resources([ids[2]]);raise AssertionError("120k cap missing")
except mod.ContextError as e:assert e.code=="CONTEXT_BUDGET_EXCEEDED"
print("HOST_INDEX_RANGE_BUDGET_PASS")
`;
 const payload=JSON.stringify({python,host:path.join(site,'host'),packet,catalog:f.catalog,chunks});
 const result=spawnSync('python3',['-c',program,String(Buffer.byteLength(payload))],{input:payload,encoding:'utf8',timeout:10000,maxBuffer:4*1024*1024,env:{...process.env,REVIEW_INSTANCE_ROOT:'',REVIEW_INSTANCE_DB:'',REVIEW_INSTANCE_ID:''}});
 assert.equal(result.status,0,result.stderr||result.stdout);assert.match(result.stdout,/HOST_INDEX_RANGE_BUDGET_PASS/);
});
test('TS initial selection covers host serialized costs for near-boundary ASCII, escaped text and exact source chunks',async()=>{
 const cases=[];
 async function addCase(name,f,ids,expectedCount){
  const selected=selectInitialResources(f.catalog,[ids[0]],ids.slice(1));
  assert.equal(selected.selected.length,expectedCount);assert(selected.characters<=72000);
  const chunks={};for(const id of selected.selected)chunks[id]=await readFrozenSourceChunk(f.tx,f.catalogHash,id);
  const focus={projectId:'project:test',snapshotId:'snapshot:one',view:'work',subjectType:'PROJECT',subjectId:'project:test',title:'预算核验'};
  const packet=sealContextPacket({schemaVersion:'1.2',projectId:'project:test',scopeKey:'local:project:test',snapshotId:'snapshot:one',focus,focusKey:'f'.repeat(64),dependencyHash:contextDependencyHash(f.catalog,selected.selected),catalogHash:f.catalogHash,initialResourceIds:selected.selected,draftTargets:[],missing:[]});
  cases.push({name,catalog:f.catalog,packet,chunks,serverCharacters:selected.characters});
  return selected;
 }
 for(const size of [63000,64000,65000]){
  const f=fixture([raw('budget:ascii','a'.repeat(size))]),index=f.catalog.resources[0],ids=Array.from({length:index.bodyBinding.chunkCount},(_,i)=>bodyChunkId(index,i));
  assert.throws(()=>selectInitialResources(f.catalog,ids,[]),/CONTEXT_REQUIRED_EVIDENCE_TOO_LARGE/);
  assert(selectInitialResources(f.catalog,[ids[0]],[]).characters<15000,'a normal12k explicit block must remain attachable');
  const selected=await addCase('ASCII_'+size,f,ids,5);assert(selected.characters>68000);assert.equal(selected.deferred.length,1);
 }
 const quoted=fixture([raw('budget:quotes','"'.repeat(60000))]),quoteIds=Array.from({length:5},(_,i)=>bodyChunkId(quoted.catalog.resources[0],i));
 assert.throws(()=>selectInitialResources(quoted.catalog,quoteIds,[]),/CONTEXT_REQUIRED_EVIDENCE_TOO_LARGE/);
 assert(selectInitialResources(quoted.catalog,[quoteIds[0]],[]).characters<27000,'JSON escaping is sized exactly, not6x for every character');
 await addCase('QUOTES_60000',quoted,quoteIds,2);
 // Published source chunks stay metadata-only except the exact initial candidates.
 // Sizing verifies the frozen release/revision/SHA but is not a host read receipt.
 const sourceBytes=Buffer.from('a'.repeat(12000)+'"'.repeat(12000)),sourceSha=hash(sourceBytes);
 const document={documentId:'doc:budget',revisionId:'rev:budget',sha256:sourceSha,byteSize:sourceBytes.length,aliases:['source/budget.txt'],metadata:{sourceRole:'SOURCE_DOCUMENT',title:'预算来源'}};
 const sf=fixture(sourceContextResources([document],'release:budget'));
 let documentReads=0;
 sf.tx.readRelease=async id=>id==='release:budget'?{sourceRevisionIds:['rev:budget']}:null;
 sf.tx.readDocumentRevision=async id=>{documentReads++;return id==='rev:budget'?{...document,bytes:sourceBytes}:null;};
 const sourceIds=sf.catalog.resources.filter(r=>r.sourceBinding).map(r=>r.id);
 assert.equal(documentReads,0);assert.equal(sf.counts.bodyReads,0);
 await prepareInitialSourceReadCosts(sf.tx,sf.catalog,sourceIds);assert.equal(documentReads,1);
 assert(selectInitialResources(sf.catalog,[sourceIds[0]],[]).characters<16000);
 assert(selectInitialResources(sf.catalog,[sourceIds[1]],[]).characters<28000);
 await addCase('EXACT_PUBLISHED_SOURCE',sf,sourceIds,2);
 const wrong=structuredClone(sf.catalog);wrong.resources.find(r=>r.sourceBinding).sourceBinding.sha256='0'.repeat(64);
 await assert.rejects(prepareInitialSourceReadCosts(sf.tx,wrong,[sourceIds[0]]),/CONTEXT_SOURCE_BINDING_INVALID/);
 const python=readFileSync(path.join(site,'host/codex_work_context.py'),'utf8');
 const program=String.raw`
import json,sys,types,pathlib
data=json.loads(sys.stdin.buffer.read(int(sys.argv[1])))
sys.path.insert(0,data["host"])
mod=types.ModuleType("catalog_budget_host");mod.__file__=data["host"]+"/codex_work_context.py";exec(compile(data["python"],mod.__file__,"exec"),mod.__dict__)
mod.check_directory=lambda path:None
for case in data["cases"]:
    packet=case["packet"]
    records={packet["packetId"]+".json":packet,packet["body"]["catalogHash"]+".json":case["catalog"]}
    mod.read_json=lambda path,maximum:records[path.name]
    turn={"assistantContext":{"packetId":packet["packetId"],"packetHash":packet["packetHash"]},"snapshotId":"snapshot:one","userMessage":"核验预算"}
    w=mod.WorkContext(pathlib.Path("/explicit-fixture"),pathlib.Path("/frozen-fixture"),turn,project_id="project:test")
    class Fake:
        def source_chunk(self,catalog,resource):
            assert catalog==packet["body"]["catalogHash"]
            return case["chunks"][resource]
    w.instance=Fake()
    assert not w.read_ids and not w.source_reads
    prompt=json.loads(w.initial_prompt([]))
    resources=prompt["currentResources"]
    actual_chars=len(mod.canonical_json(resources))
    assert actual_chars<=case["serverCharacters"]<=72000,(case["name"],actual_chars,case["serverCharacters"])
    assert w.text_chars<=case["serverCharacters"]<=120000,(case["name"],w.text_chars,case["serverCharacters"])
    assert set(w.read_ids)==set(packet["body"]["initialResourceIds"])
    for item in resources:
        assert item["sourceText"]==case["chunks"][item["id"]]["sourceText"]
        if item.get("bodyRange"):
            assert item["bodyState"]=="BODY_CHUNK_READ" and item["bodyOf"] not in w.read_ids
    print(json.dumps({"case":case["name"],"serverCharacters":case["serverCharacters"],"hostChargedCharacters":w.text_chars,"hostInitialCharacters":actual_chars,"readResources":len(w.read_ids)}))
`;
 const payload=JSON.stringify({python,host:path.join(site,'host'),cases});
 const result=spawnSync('python3',['-B','-c',program,String(Buffer.byteLength(payload))],{input:payload,encoding:'utf8',timeout:10000,maxBuffer:4*1024*1024,env:{...process.env,REVIEW_INSTANCE_ROOT:'',REVIEW_INSTANCE_DB:'',REVIEW_INSTANCE_ID:''}});
 assert.equal(result.status,0,result.stderr||result.stdout);console.log(result.stdout.trim());
});
test('real persistence writes bodies,catalog and packet atomically and rejects conflicting frozen bytes',async()=>{
 const f=fixture([raw('persist:one','保留业务正文 '.repeat(9000))]);
 const packet=sealContextPacket({schemaVersion:'1.2',projectId:'project:test',scopeKey:'local:project:test',snapshotId:'snapshot:one',focus:{projectId:'project:test'},focusKey:'f'.repeat(64),dependencyHash:contextDependencyHash(f.catalog,['persist:one']),catalogHash:f.catalogHash,initialResourceIds:['persist:one'],draftTargets:[],missing:[]});
 let records=new Map(),transactions=0;
 const repo={async writeTransaction(fn){transactions++;const pending=new Map(records);await fn({getAux:async(_ns,key)=>pending.get(key)||null,putAux:async input=>{assert.equal(input.namespace,'assistant-public');assert.equal(input.expectedRevisionId,null);pending.set(input.key,{bytes:Buffer.from(input.bytes),sha256:hash(input.bytes)});}});records=pending;}};
 const src=readFileSync(path.join(site,'app/api/assistant/v1/_storage.ts'),'utf8');
 const result={exports:{}};
 new Function('require','module','exports',ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(specifier=>{
  if(specifier.endsWith('/_store'))return{instanceMode:()=>true,instanceRepository:async()=>repo,reviewData:async()=>({}),HttpError:class extends Error{constructor(status,message){super(message);this.status=status;}}};
  if(specifier.endsWith('/_codex-conversation-store'))return{conversationStoreRoot:()=>'/in-memory-context',assistantRecordKey:value=>value};
  if(specifier.endsWith('/instance-profile'))return{instanceProfile:()=>({projectId:'project:test',assistant:{scopeKey:'local:project:test'}})};
  if(specifier.endsWith('/assistant/types'))return{canonicalJson:canonical};
  if(specifier.endsWith('/assistant/context-catalog'))return module.exports;
  return specifier.startsWith('.')?require(path.resolve(site,'app/api/assistant/v1',specifier)):require(specifier);
 },result,result.exports);
 await result.exports.persistAssistantContext(packet,f.catalog);assert.equal(transactions,1);
 const keys=[...records.keys()];assert(keys.some(k=>k.startsWith('resource-bodies/')));assert(records.has('catalogs/'+packet.body.catalogHash+'.json'));assert(records.has('contexts/'+packet.packetId+'.json'));
 const saved=records;await result.exports.persistAssistantContext(packet,f.catalog);assert.equal(records.size,saved.size);
 const bodyKey=keys.find(k=>k.startsWith('resource-bodies/'));records.set(bodyKey,{bytes:Buffer.from('foreign'),sha256:hash('foreign')});const before=[...records].map(([k,r])=>[k,r.bytes.toString('base64')]);
 await assert.rejects(result.exports.persistAssistantContext(packet,f.catalog),/immutable assistant evidence conflicts/);
 assert.deepEqual([...records].map(([k,r])=>[k,r.bytes.toString('base64')]),before);
});
