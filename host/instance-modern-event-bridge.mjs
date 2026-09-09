import {encodeAssetContextDocuments,assetContextDocumentsHash} from './instance-asset-context-proof.mjs';
import {cancellationMarker} from './instance-runtime/execution-cancellation.mjs';
// Validation delegation only. The original full event directory remains untouched.
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {readFile,mkdtemp,realpath,chmod,writeFile,rm} from 'node:fs/promises';
import {digest,frozenEventManifest} from './instance-modern-event-validator.mjs';
import {historicalEventContextsHash} from './instance-historical-event-context.mjs';
import {encodeMaterialUsageDocuments,materialUsageDocumentsHash} from './instance-material-usage-proof.mjs';

// Historical excerpt hashes use JSON.stringify(scriptBlocks), whose object field
// order is part of the evidence. Canonical hashes still guard the independent
// manifest, but the child transport must retain the captured object order.
export const serializeModernEventInput=input=>JSON.stringify(input);

// Only this host creates the directory. Neither event data nor stdin can choose
// its location. Original release bytes remain independently verified by child.
export async function withHistoricalEventTransport(bundle,callback){
  if(!bundle)return callback({historicalContexts:undefined,directory:undefined});
  if(historicalEventContextsHash(bundle)!==bundle.contextsHash)throw Error('Historical event transport capture hash differs');
  if(bundle.releases.length===0)return callback({historicalContexts:bundle,directory:undefined});
  const scratch=await mkdtemp(path.join(os.tmpdir(),'review-historical-events-'));
  try{
    await chmod(scratch,0o700);const directory=await realpath(scratch),written=new Set();
    const historicalContexts={...bundle,releases:[]};
    for(const row of bundle.releases){
      const transported={...row};
      for(const key of ['snapshotBytes','recipesBytes']){
        const payload=row[key];
        if(payload?.encoding!=='GZIP_BASE64'||typeof payload.data!=='string'||'file'in payload||!/^[a-f0-9]{64}$/.test(payload.compressedSha256)||!Number.isSafeInteger(payload.compressedByteSize)||payload.compressedByteSize<=0||payload.compressedByteSize>128*1024*1024)throw Error('Historical event transport requires bounded captured inline bytes');
        const bytes=Buffer.from(payload.data,'base64');
        if(bytes.toString('base64')!==payload.data||bytes.length!==payload.compressedByteSize||digest(bytes)!==payload.compressedSha256)throw Error('Historical event transport compressed bytes differ');
        const file=payload.compressedSha256+'.gz';
        if(!written.has(file)){await writeFile(path.join(directory,file),bytes,{mode:0o600,flag:'wx'});written.add(file);}
        const descriptor={...payload};delete descriptor.data;transported[key]={...descriptor,file};
      }
      historicalContexts.releases.push(transported);
    }
    if(historicalEventContextsHash(historicalContexts)!==bundle.contextsHash)throw Error('Historical event transport changed capture binding');
    return await callback({historicalContexts,directory});
  }finally{await rm(scratch,{recursive:true,force:true});}
}

export async function validateModernEventsInChild({events,baseRelease,eventDirectory,historicalContexts,documents=[]}){
  const materialUsageSources=encodeMaterialUsageDocuments(documents),assetContextSources=encodeAssetContextDocuments(documents);
  const snapshot=JSON.parse(baseRelease.snapshotBytes),materialUsageLedger=snapshot.productionModel?.materialUsageLedger;
  const hasUsage=materialUsageSources.length||events.some(e=>e.eventKind==='material-usage-review'||e.subjectType==='MATERIAL_USAGE'||Object.hasOwn(e,'usageRevisionId'))||materialUsageLedger!==undefined&&(!Array.isArray(materialUsageLedger)||materialUsageLedger.length);
  const contextLedger=snapshot.productionModel?.assetContextRevalidationLedger;
  const hasContext=assetContextSources.length||events.some(e=>e.eventKind==='asset-context-revalidation'||e.subjectType==='ASSET_CONTEXT'||Object.hasOwn(e,'revalidationRevisionId'))||contextLedger!==undefined&&(!Array.isArray(contextLedger)||contextLedger.length);
  const required=hasContext||hasUsage||events.some(cancellationMarker)||events.some(e=>e.eventKind==='script-comment'&&e.schemaVersion==='1.2'||e.eventKind==='creative-revision'&&(e.subjectKind==='EPISODE_PLAN'&&e.content?.narrativeRevision!==undefined||e.scopedReviewSpec)||e.eventKind==='source-operation'&&e.protocol==='SCOPED_SCENE_DATABASE_COMPILER_V1');
  if(!required)return null;
  const validator=new URL('./instance-modern-event-validator.mjs',import.meta.url);
  return withHistoricalEventTransport(historicalContexts,async({historicalContexts:transported,directory})=>{
  const input={events,snapshot,...(hasContext?{assetContextSources}:{}),...(hasUsage?{materialUsageSources}:{}),...(transported?{historicalContexts:transported}:{}),binding:{releaseId:baseRelease.releaseId,snapshotId:snapshot.snapshotId,snapshotSha256:digest(baseRelease.snapshotBytes),snapshotCanonicalSha256:digest(snapshot),...(hasContext?{assetContextSourcesHash:assetContextDocumentsHash(assetContextSources)}:{}),...(hasUsage?{materialUsageSourcesHash:materialUsageDocumentsHash(materialUsageSources)}:{}),...(historicalContexts?{historicalContextsHash:historicalContexts.contextsHash}:{}),eventDirectory,eventManifest:frozenEventManifest(events)}};
  const softwareRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const code=`import {loadModernEventRuntime,validateModernEventClosure,readFrozenModernEventInput} from ${JSON.stringify(validator.href)};const input=await readFrozenModernEventInput(process.stdin);const runtime=loadModernEventRuntime(${JSON.stringify(softwareRoot)});runtime.historicalContextDirectory=${JSON.stringify(directory)};const result=validateModernEventClosure(input,runtime);process.stdout.write(JSON.stringify(result));`;
  const proof=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--input-type=module','-e',code],{cwd:softwareRoot,env:{PATH:process.env.PATH||'/usr/bin:/bin',LANG:'C.UTF-8',REVIEW_INSTANCE_READ_ONLY:'1'},stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='',settled=false;const timer=setTimeout(()=>child.kill('SIGKILL'),120000);
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',bytes=>{stdout+=bytes;if(stdout.length>8*1024*1024)child.kill('SIGKILL');});
    child.stderr.on('data',bytes=>{stderr=(stderr+bytes).slice(-32000);});
    child.on('error',error=>{settled=true;clearTimeout(timer);reject(error);});
    child.on('close',(code,signal)=>{clearTimeout(timer);if(settled)return;if(code!==0)return reject(Error(`Modern immutable-event validator failed (${code??signal}): ${stderr}`));try{resolve(JSON.parse(stdout));}catch(error){reject(error);}});
    child.stdin.on('error',error=>{if(error.code!=='EPIPE')child.kill('SIGKILL');});child.stdin.end(serializeModernEventInput(input));
  });
  proof.validatorSha256=digest(await readFile(validator));
  return {proof,proofSha256:digest(proof)};
  });
}

export const modernEventSemanticSupport=String.raw`
MODERN_EVENT_QA_AST_GUARDS={
 'event_record_errors':'b49ff73c7be7454b524c9470670e6a4d189099e26cd15fd9de0e9950e69c9cb8',
 'event_relation_errors':'1554d3ab15af985d44c26d6283e02b9174ceb74b277e4f28eef72e64c8595317',
 'load_operation_events':'11732e194405c57d52921e45382d72e5e0eaef1043f5114318ebfdf5f77d1df4',
}
def guard_modern_event_delegation_ast(tree):
 for name,expected in MODERN_EVENT_QA_AST_GUARDS.items():
  nodes=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name==name]
  if len(nodes)!=1 or hashlib.sha256(ast.dump(nodes[0],include_attributes=False).encode()).hexdigest()!=expected:raise ValueError('Modern event delegation: legacy '+name+' AST changed')

def prepare_modern_event_delegation(root,envelope,published):
 def require(ok,message):
  if not ok:raise ValueError('Modern event delegation: '+message)
 def stable(value):return json.dumps(value,sort_keys=True,ensure_ascii=False,separators=(',',':'))
 def sha(value):return hashlib.sha256((value if isinstance(value,str) else stable(value)).encode()).hexdigest()
 proof=envelope.get('proof') or {};binding=proof.get('binding') or {};manifest=proof.get('manifest') or {};partition=proof.get('partition') or []
 require(sha(proof)==envelope.get('proofSha256'),'runtime proof digest differs')
 require(proof.get('schemaVersion')=='1.0' and proof.get('mode')=='VALIDATION_DELEGATION_ONLY' and proof.get('originalEventsUnchanged') is True and proof.get('eventsOmitted')==0,'runtime proof contract unsupported')
 require(proof.get('formalModernReviewSupported') is False and proof.get('formalModernSourceSyncSupported') is False,'unsupported formal capabilities')
 require(binding.get('releaseId')==published.get('releaseId') and binding.get('snapshotSha256')==published.get('snapshotSha256'),'runtime proof is not bound to this pinned release')
 require(binding.get('eventManifest')==manifest and sha(partition)==proof.get('partitionHash'),'complete manifest/partition hash differs')
 require(isinstance(manifest.get('events'),list) and manifest.get('count')==len(manifest['events']) and sha(manifest['events'])==manifest.get('eventsHash'),'frozen manifest count/hash invalid')
 expected={row['eventId']:row for row in manifest['events']}
 require(len(expected)==manifest['count'] and len(partition)==len(expected),'duplicate/missing event identities')
 dispatch={row['eventId']:row for row in partition}
 require(len(dispatch)==len(expected) and set(dispatch)==set(expected),'partition does not conserve full event identity set')
 for identity,row in dispatch.items():
  require({k:v for k,v in row.items() if k not in ('recordValidator','relationValidator')}==expected[identity],'partition changed event bytes/identity')
  require(row.get('recordValidator') in ('LEGACY','RUNTIME_MODERN') and row.get('relationValidator') in ('LEGACY','RUNTIME_MODERN'),'unknown validation delegate')
 alias=binding.get('eventDirectory');parts=Path(alias).parts if isinstance(alias,str) else ()
 require(bool(parts) and not Path(alias).is_absolute() and all(p not in ('.','..','') for p in parts) and '\\' not in alias,'unsafe event directory')
 event_dir=root
 for part in parts:
  event_dir=event_dir/part;require(not event_dir.is_symlink(),'event directory symlink')
 require(event_dir.is_dir(),'frozen event directory missing')
 seen_records=set();seen_relations=0;seen_loads=0
 def verify_event(event):
  identity=event.get('eventId');row=expected.get(identity)
  require(row is not None and row['eventKind']==event.get('eventKind') and row['sha256']==sha(event),'unproved/changed immutable event')
  return identity
 def verify_full(rows):
  require(isinstance(rows,list) and len(rows)==len(expected),'full event set cardinality changed')
  identities=[verify_event(row) for row in rows]
  require(len(set(identities))==len(identities) and set(identities)==set(expected),'full event set omitted/duplicated identities')
 def verify_directory():
  rows=[]
  for file in sorted(event_dir.iterdir()):
   require(file.is_file() and not file.is_symlink() and file.suffix=='.json','unexpected file/directory in frozen event store')
   event=json.loads(file.read_text(encoding='utf-8'));identity=verify_event(event)
   require(file.name==event.get('eventKind','')+'-'+event.get('idempotencyKeyHash','')+'.json','event filename no longer binds its original idempotency identity')
   require(hashlib.sha256(file.read_bytes()).hexdigest()==expected[identity]['sha256'],'original canonical event bytes changed')
   rows.append(event)
  verify_full(rows)
 verify_directory()
 def install(module):
  original_record=module.event_record_errors;original_relation=module.event_relation_errors;original_load=module.load_operation_events
  def record(kind,event,label):
   identity=verify_event(event);require(kind==event['eventKind'],'record kind differs');seen_records.add(identity)
   return [] if dispatch[identity]['recordValidator']=='RUNTIME_MODERN' else original_record(kind,event,label)
  def relation(events):
   nonlocal seen_relations
   verify_full([row for rows in events.values() for row in rows]);seen_relations+=1
   legacy={kind:[row for row in rows if dispatch[row['eventId']]['relationValidator']=='LEGACY'] for kind,rows in events.items()}
   return original_relation(legacy)
  def load(*args,**kwargs):
   nonlocal seen_loads
   verify_directory();result=original_load(*args,**kwargs);verify_full([row for rows in result.values() for row in rows]);verify_directory();seen_loads+=1
   return result
  module.event_record_errors=record;module.event_relation_errors=relation;module.load_operation_events=load
 def finish():
  verify_directory();require(seen_records==set(expected) and seen_relations>0 and seen_loads>0,'legacy QA did not visit every immutable record and full relation set')
  return {'mode':'FULL_EVENT_SET_RUNTIME_AND_LEGACY_VALIDATION','proofSha256':envelope['proofSha256'],'guardAstSha256':MODERN_EVENT_QA_AST_GUARDS,'manifest':manifest,'partitionHash':proof['partitionHash'],'runtimeRecordCount':sum(row['recordValidator']=='RUNTIME_MODERN' for row in partition),'legacyRecordCount':sum(row['recordValidator']=='LEGACY' for row in partition),'runtimeRelationCount':sum(row['relationValidator']=='RUNTIME_MODERN' for row in partition),'legacyRelationCount':sum(row['relationValidator']=='LEGACY' for row in partition),'originalEventBytesPreserved':True,'modernRuntimeProof':proof}
 return install,finish
`;
