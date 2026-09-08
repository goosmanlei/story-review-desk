import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {canonicalJson,sha256} from '../host/instance-runtime/bytes.mjs';
import {registeredMaterialCandidateProof,registeredCandidateSupport} from '../host/instance-registered-material-candidates.mjs';
const hash=x=>sha256(canonicalJson(x));
const bytes=Buffer.from('fixture media; not an audio observation');
async function fixture(){
 const compiler={snapshotBuilderPath:'scripts/build_review_site_data.py',snapshotPath:'generated/snapshot.json',eventDirectory:'events'};
 const familyId='AUDIO-EXISTING',versionId=familyId+'@V001',expectedOutputId='EXPECTED_OUTPUT:'+versionId,outputPath='production/generated/05_audio/ORIGINAL_V001.wav';
 const output={id:expectedOutputId,familyId,targetPath:outputPath};
 const definition={upload:{items:[]},id:'CALL:A',definitionHash:'a'.repeat(64),currentRevisionId:'REV:A',materialRequirementRef:'REQ:A',workItemRef:'WORK:A',rawSourceBlock:'An original fictional voice.',source:{path:'prompt.md',blockSha256:sha256('An original fictional voice.')},output:{assetFamilyRef:familyId,expectedOutputRef:expectedOutputId,path:outputPath}};
 const event={eventKind:'asset-version',schemaVersion:'1.1',eventId:'evt-candidate',idempotencyKeyHash:'f'.repeat(64),eventSequence:6,snapshotId:'SNAP:ORIGINAL',familyId,versionId,expectedOutputId,plannedVersionId:versionId,path:outputPath,realizationRelation:'REALIZES',realizes:{relationType:'REALIZES',expectedOutputId,assetVersionId:versionId},sha256:sha256(bytes),byteSize:bytes.length,outputState:'PRESENT',historyRole:'CANDIDATE',lifecycleState:'REVIEW_PENDING',reviewDecision:'PENDING',registrationState:'CANDIDATE_REGISTERED_EXPECTED_OUTPUT_REALIZED',adoptionPerformed:false,inputBindings:[],inputBindingsHash:hash([]),executionRequestId:'XREQ:A',runId:'RUN:A',executionDefinitionId:definition.id,executionDefinitionHash:definition.definitionHash,promptRevisionId:definition.currentRevisionId,callPackageHash:definition.definitionHash};
 const common=Object.fromEntries(['snapshotId','executionRequestId','executionDefinitionId','executionDefinitionHash','promptRevisionId','callPackageHash','inputBindingsHash'].map(k=>[k,event[k]]));
 const chain=['AUTHORIZE','CLAIM','PLANNED','SUBMITTED','SUCCEEDED'].map((state,i)=>({...common,eventId:'evt-'+i,eventSequence:i+1,idempotencyKeyHash:String(i+1).repeat(64),eventKind:i<2?'execution-request':'run',...(i<2?{action:state,authorized:true,inputBindings:[],familyId,workItemId:definition.workItemRef}:{state,runId:event.runId})}));
 const snapshot={snapshotId:'SNAP:CURRENT',productionModel:{assetFamilies:[{id:familyId,currentVersionId:null,currentExpectedOutputId:expectedOutputId,expectedOutputRefs:[expectedOutputId]}],assetVersions:[],expectedOutputs:[output]}};
 const registry={schema_version:'1.1',requirements:[{requirement_id:'REQ:A',asset_family_refs:[familyId]}]};
 const content={'production/00_control/registries/material_requirements.json':canonicalJson(registry),'scripts/asset_cleanup_contract.py':await readFile(new URL('./fixtures/registered-material-candidates/asset_cleanup_contract.py',import.meta.url),'utf8'),'scripts/build_review_site_data.py':await readFile(new URL('./fixtures/registered-material-candidates/builder-family.py',import.meta.url),'utf8'),'prompt.md':definition.rawSourceBlock};
 const documents=Object.entries(content).map(([alias,body],i)=>({documentId:'doc:'+i,revisionId:'revision:'+i,aliases:[alias],sha256:sha256(body),bytes:Buffer.from(body),metadata:{sourceRole:alias.endsWith('.py')?'INSTANCE_EXTENSION':'SOURCE_CURRENT'}}));
 const input={compiler,documents,events:[...chain,event],activeMedia:[{mediaId:familyId,versionId,relativePath:'media/candidate.wav',sha256:event.sha256,byteSize:event.byteSize,availability:'PRESENT',metadata:{authorityDomain:'FORMAL',registrationEventId:event.eventId}}],pinnedMediaHashes:{[outputPath]:event.sha256},baseRelease:{releaseId:'RELEASE:CURRENT',snapshotBytes:Buffer.from(canonicalJson(snapshot)),recipesBytes:Buffer.from(canonicalJson({snapshotId:snapshot.snapshotId,executionDefinitions:[definition]}))}};
 return {input,event,snapshot,definition,registry};
}
async function isolated(f,{mutateFiles,mutateTree,leak=false,native=false,unprovedNative=false}={}){
 const root=await mkdtemp(path.join(tmpdir(),'registered-candidate-'));
 try{
  let nativeProof=null;
  if(native||unprovedNative){
   const e={eventKind:'asset-version',schemaVersion:'1.1',eventId:'evt-native',idempotencyKeyHash:'9'.repeat(64),familyId:'MP-AF-fixture',versionId:'MP-AF-fixture@V001',expectedOutputId:'MP-EO-fixture',path:'media/_review_pending/material-production/MP-AF-fixture/V001.png',sha256:sha256(bytes),byteSize:bytes.length};f.input.events.push(e);f.input.pinnedMediaHashes[e.path]=e.sha256;
   const eventPath=`events/asset-version-${e.idempotencyKeyHash}.json`;const body={schemaVersion:'NATIVE_MATERIAL_CANDIDATE_PROOF_V1',releaseId:f.input.baseRelease.releaseId,records:[{...e,eventPath,eventSha256:hash(e),eventProof:[{eventId:e.eventId,path:eventPath,sha256:hash(e)}],sourceProof:[]}]};
   if(native)nativeProof={...body,proofSha256:hash(body)};
  }
  const proof=registeredMaterialCandidateProof(f.input),docPins=Object.fromEntries(f.input.documents.flatMap(d=>d.aliases.map(a=>[a,d.sha256])));
  for(const doc of f.input.documents){const target=path.join(root,doc.aliases[0]);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,doc.bytes);}
  for(const event of f.input.events){await mkdir(path.join(root,'events'),{recursive:true});await writeFile(path.join(root,`events/${event.eventKind}-${event.idempotencyKeyHash}.json`),canonicalJson(event));}
  await mkdir(path.dirname(path.join(root,f.event.path)),{recursive:true});await writeFile(path.join(root,f.event.path),bytes);
  for(const e of f.input.events.filter(e=>e.eventId==='evt-native')){await mkdir(path.dirname(path.join(root,e.path)),{recursive:true});await writeFile(path.join(root,e.path),bytes);}
  await mkdir(path.join(root,'generated'),{recursive:true});
  if(mutateFiles)await mutateFiles(root);
  const payload={proof,nativeProof,docPins,mediaPins:f.input.pinnedMediaHashes,event:f.event,mutateTree,leak};
  const code=String.raw`import ast,json,sys,types,hashlib
from pathlib import Path
root=Path(sys.argv[1]);payload=json.loads(sys.stdin.read());sys.path.insert(0,str(root/'scripts'))
`+registeredCandidateSupport+String.raw`
original={p:hashlib.sha256((root/p).read_bytes()).hexdigest() for p in payload['docPins']}
tree=ast.parse((root/payload['proof']['builder']['path']).read_text())
if payload.get('mutateTree'):
 next(n for n in tree.body[-1].body if isinstance(n,ast.FunctionDef) and n.name=='add_family').body.insert(0,ast.parse('new_behavior=True').body[0])
transform,install,finish=prepare_registered_material_candidates(root,tree,payload['proof'],payload['docPins'],payload['mediaPins'],payload.get('nativeProof'))
tree=transform(tree)
module=types.ModuleType('builder');module.__file__=str(root/payload['proof']['builder']['path'])
exec(compile(tree,module.__file__,'exec'),module.__dict__);install(module)
import asset_cleanup_contract as cleanup
registry=json.loads((root/payload['proof']['registry']['path']).read_text())
result=cleanup.registered_material_candidate_paths(registry,event_store=root/'events',root=root)
model=module.build_production_model(payload['event'])
if payload['leak']:
 model['assetVersions'].append({'id':payload['event']['versionId']})
(root/payload['proof']['snapshotPath']).write_text(json.dumps({'productionModel':model}))
report=finish()
assert original=={p:hashlib.sha256((root/p).read_bytes()).hexdigest() for p in payload['docPins']}
assert len(result)==1 and model['assetVersions']==[] and model['assetFamilies'][0]['currentVersionId'] is None
print(json.dumps({'report':report,'model':model,'sourceBytesUnchanged':True}))
`;
  return JSON.parse(execFileSync('python3',['-B','-c',code,root],{input:JSON.stringify(payload),encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:30_000}));
 }finally{await rm(root,{recursive:true,force:true});}
}
test('strict proof binds the current source, event, EO, successful Run and formal bytes without mutation',async()=>{const f=await fixture(),before=hash(f.input),proof=registeredMaterialCandidateProof(f.input);assert.equal(proof.records.length,1);assert.equal(proof.records[0].eventProof.length,6);assert.equal(hash(f.input),before);assert.equal(proof.records[0].expectedOutputId,f.event.expectedOutputId);});
for(const [name,mutate]of Object.entries({
 'undeclared requirement':f=>{const r=f.input.documents[0];r.bytes=Buffer.from(canonicalJson({schema_version:'1.1',requirements:[{requirement_id:'WRONG',asset_family_refs:[f.event.familyId]}]}));r.sha256=sha256(r.bytes);},
 'missing source':f=>f.input.documents.pop(),
 'wrong source SHA':f=>f.input.documents[0].sha256='0'.repeat(64),
 'unknown result':f=>f.input.events[4].state='RESULT_UNKNOWN',
 'missing submitted run':f=>f.input.events.splice(3,1),
 'changed run input':f=>f.input.events[3].inputBindingsHash='b'.repeat(64),
 'different request':f=>f.input.events[2].executionRequestId='OTHER',
 'reordered chain':f=>f.input.events[0].eventSequence=10,
 'trial media':f=>f.input.activeMedia[0].metadata.authorityDomain='LOCAL_TRIAL',
 'different media registration':f=>f.input.activeMedia[0].metadata.registrationEventId='OTHER',
 'wrong actual byte pin':f=>f.input.pinnedMediaHashes[f.event.path]='b'.repeat(64),
 'EO differs':f=>{const s=JSON.parse(f.input.baseRelease.snapshotBytes);s.productionModel.expectedOutputs[0].targetPath+='other';f.input.baseRelease.snapshotBytes=Buffer.from(canonicalJson(s));},
 'candidate already in base':f=>{const s=JSON.parse(f.input.baseRelease.snapshotBytes);s.productionModel.assetVersions.push({id:f.event.versionId});f.input.baseRelease.snapshotBytes=Buffer.from(canonicalJson(s));},
 'definition differs':f=>{const r=JSON.parse(f.input.baseRelease.recipesBytes);r.executionDefinitions[0].output.expectedOutputRef='OTHER';f.input.baseRelease.recipesBytes=Buffer.from(canonicalJson(r));}
}))test('rejects '+name,async()=>{const f=await fixture();mutate(f);assert.throws(()=>registeredMaterialCandidateProof(f.input),e=>e.code==='SOURCE_REGISTERED_CANDIDATE_BINDING');});
test('existing planned-family path receives no new exception',async()=>{const f=await fixture();f.registry.requirements[0].planned_family_id=f.event.familyId;f.registry.requirements[0].planned_output_path=f.event.path;f.input.documents[0].bytes=Buffer.from(canonicalJson(f.registry));f.input.documents[0].sha256=sha256(f.input.documents[0].bytes);assert.equal(registeredMaterialCandidateProof(f.input),null);});
test('a self-consistent fabricated candidate/input hash cannot replace the frozen zero-reference call',async()=>{const f=await fixture();f.event.inputBindings=[{order:1,path:'missing.wav',assetFamilyRef:'UNKNOWN',assetVersionRef:'UNKNOWN@V001',sha256:'a'.repeat(64)}];for(const event of f.input.events)event.inputBindingsHash=hash(f.event.inputBindings);assert.throws(()=>registeredMaterialCandidateProof(f.input),/frozen zero-reference/);});
test('legacy compatibility rejects an unproved referenced definition even when its candidate claims no input',async()=>{const f=await fixture();f.definition.upload.items=[{path:'missing.wav'}];f.input.baseRelease.recipesBytes=Buffer.from(canonicalJson({snapshotId:f.snapshot.snapshotId,executionDefinitions:[f.definition]}));assert.throws(()=>registeredMaterialCandidateProof(f.input),/frozen zero-reference/);});
test('claimed input bytes must match the zero-reference definition and candidate',async()=>{const f=await fixture();f.input.events[1].inputBindings=[{path:'other.wav'}];assert.throws(()=>registeredMaterialCandidateProof(f.input),/authorized\/claimed/);});
test('the same exact successful call can include one formally recorded RUNNING state',async()=>{const f=await fixture();for(const e of f.input.events)e.eventSequence*=2;f.input.events.push({...f.input.events[3],eventId:'evt-running',idempotencyKeyHash:'7'.repeat(64),eventSequence:9,state:'RUNNING'});assert.equal(registeredMaterialCandidateProof(f.input).records[0].eventProof.length,7);});
test('isolated audited Python adapter retains EO and event-only candidate, exact original source bytes',async()=>{const result=await isolated(await fixture());assert.equal(result.sourceBytesUnchanged,true);assert.equal(result.report.baseCandidateVersionsCreated,0);assert.equal(result.model.assetVersions.length,0);});
test('isolated adapter rejects changed original function AST',async()=>{await assert.rejects(isolated(await fixture(),{mutateTree:true}),/unrecognized original family constructor AST|unrecognized original/);});
test('isolated adapter rejects event bytes modified after capture',async()=>{const f=await fixture();await assert.rejects(isolated(f,{mutateFiles:root=>writeFile(path.join(root,`events/asset-version-${f.event.idempotencyKeyHash}.json`),'{}')}),/frozen event bytes differ/);});
test('isolated adapter final check rejects candidate leaking into immutable base snapshot',async()=>{await assert.rejects(isolated(await fixture(),{leak:true}),/event candidate leaked/);});

test('mixed native/legacy reader delegates only proved exact native events while retaining original bytes',async()=>{const r=await isolated(await fixture(),{native:true});assert.deepEqual(r.report.nativeCandidateDelegation.eventIds,['evt-native']);assert.equal(r.report.nativeCandidateDelegation.originalEventFilesPreserved,true);assert.equal(r.model.assetVersions.length,0);});
test('native-looking event without independent proof still reaches the original rejection',async()=>{await assert.rejects(isolated(await fixture(),{unprovedNative:true}),/not a registered material plan/);});
test('native event file changed after capture is rejected before delegation',async()=>{await assert.rejects(isolated(await fixture(),{native:true,mutateFiles:root=>writeFile(path.join(root,'events/asset-version-'+('9'.repeat(64))+'.json'),'{}')}),/frozen event bytes differ/);});

async function historicalFixture(){
 const f=await fixture(),familyId='CARD-A',versionId=familyId+'@V001',outputPath='production/generated/02_characters/CARD_A_V001.png';
 const event={...f.event,eventId:'evt-historical',idempotencyKeyHash:'8'.repeat(64),familyId,versionId,path:outputPath,expectedOutputId:'EXPECTED_OUTPUT:'+versionId,plannedVersionId:versionId,realizes:{relationType:'REALIZES',expectedOutputId:'EXPECTED_OUTPUT:'+versionId,assetVersionId:versionId}};
 const current={id:'EXPECTED_OUTPUT:'+familyId+'@V002',familyId,targetPath:outputPath.replace('V001','V002'),legacyVersionId:familyId+'@V002'};
 f.registry.requirements.push({requirement_id:'REQ:CARD',asset_family_refs:[familyId],planned_family_id:familyId,planned_output_path:current.targetPath});
 f.input.documents[0].bytes=Buffer.from(canonicalJson(f.registry));f.input.documents[0].sha256=sha256(f.input.documents[0].bytes);
 f.snapshot.productionModel.assetFamilies.push({id:familyId,versionRefs:[versionId],expectedOutputRefs:[current.id],currentExpectedOutputId:current.id,currentVersionId:null});
 f.snapshot.productionModel.assetVersions.push({id:versionId,familyId,path:outputPath,sha256:event.sha256,historyStatus:'CANDIDATE'});
 f.snapshot.productionModel.expectedOutputs[0].legacyVersionId=f.event.versionId;f.snapshot.productionModel.expectedOutputs.push(current);
 f.input.baseRelease.snapshotBytes=Buffer.from(canonicalJson(f.snapshot));f.input.events.push(event);
 f.input.activeMedia.push({mediaId:familyId,versionId,sha256:event.sha256,byteSize:event.byteSize,availability:'PRESENT',metadata:{authorityDomain:'FORMAL',registrationEventId:event.eventId}});f.input.pinnedMediaHashes[outputPath]=event.sha256;
 const builder=f.input.documents.find(d=>d.aliases.includes(f.input.compiler.snapshotBuilderPath));
 builder.bytes=Buffer.from(builder.bytes.toString()+`\ndef main():
    production_model=__instance_fixture_projection
    retained_projection_counts = {
        "assetFamilies": len(production_model.get("assetFamilies", [])),
        "assetVersions": len(production_model.get("assetVersions", [])),
        "expectedOutputs": len(production_model.get("expectedOutputs", [])),
    }
    if retained_projection_counts != {
        "assetFamilies": 384,
        "assetVersions": 368,
        "expectedOutputs": 81,
    }:
        raise ValueError(
            "cleanup planning must not mutate the retained compatibility projection: "
            f"{retained_projection_counts}"
        )
    return production_model
`);builder.sha256=sha256(builder.bytes);
 return {...f,historicalEvent:event};
}
async function isolatedHistorical(f,{mutateProjection,mutateGuard}={}){
 const root=await mkdtemp(path.join(tmpdir(),'historical-expectation-'));
 try{
  const proof=registeredMaterialCandidateProof(f.input),history=proof.historicalExpectations;
  for(const d of f.input.documents){const p=path.join(root,d.aliases[0]);await mkdir(path.dirname(p),{recursive:true});await writeFile(p,d.bytes);}
  for(const e of f.input.events){const p=path.join(root,`events/${e.eventKind}-${e.idempotencyKeyHash}.json`);await mkdir(path.dirname(p),{recursive:true});await writeFile(p,canonicalJson(e));}
  for(const e of [f.event,f.historicalEvent]){const p=path.join(root,e.path);await mkdir(path.dirname(p),{recursive:true});await writeFile(p,bytes);}
  await mkdir(path.join(root,'generated'),{recursive:true});
  const projection={assetFamilies:[...f.snapshot.productionModel.assetFamilies,...Array.from({length:382},(_,i)=>({id:'UNRELATED-'+i}))],assetVersions:Array.from({length:368},(_,i)=>({id:'EXISTING-'+i})),expectedOutputs:[...f.snapshot.productionModel.expectedOutputs,...history.records.map(r=>r.expectedOutput)]};
  if(mutateProjection)mutateProjection(projection);
  const payload={proof,projection,mutateGuard,docPins:Object.fromEntries(f.input.documents.map(d=>[d.aliases[0],d.sha256])),mediaPins:f.input.pinnedMediaHashes};
  const code=String.raw`import ast,json,sys,types
from pathlib import Path
root=Path(sys.argv[1]);payload=json.loads(sys.stdin.read());sys.path.insert(0,str(root/'scripts'))
`+registeredCandidateSupport+String.raw`
tree=ast.parse((root/payload['proof']['builder']['path']).read_text())
if payload.get('mutateGuard'):
 main=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='main')
 next(n for n in main.body if isinstance(n,ast.If)).test.comparators[0].values[-1].value=82
transform,install,finish=prepare_registered_material_candidates(root,tree,payload['proof'],payload['docPins'],payload['mediaPins'])
module=types.ModuleType('builder');module.__file__=str(root/payload['proof']['builder']['path'])
exec(compile(transform(tree),module.__file__,'exec'),module.__dict__);install(module)
import asset_cleanup_contract as cleanup
cleanup.registered_material_candidate_paths(json.loads((root/payload['proof']['registry']['path']).read_text()),event_store=root/'events',root=root)
module.__instance_fixture_projection=payload['projection'];model=module.main()
(root/payload['proof']['snapshotPath']).write_text(json.dumps({'productionModel':model}))
print(json.dumps(finish()))
`;
  return JSON.parse(execFileSync('python3',['-B','-c',code,root],{input:JSON.stringify(payload),encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:30_000}));
 }finally{await rm(root,{recursive:true,force:true});}
}
test('historical ExpectedOutput proof binds prior base version and actual registered bytes without a fabricated model Run',async()=>{const f=await historicalFixture(),before=hash(f.input),proof=registeredMaterialCandidateProof(f.input);assert.equal(proof.historicalExpectations.records.length,1);assert.equal(proof.historicalExpectations.currentOutputs.length,2);assert.equal(hash(f.input),before);assert.equal(proof.historicalExpectations.records[0].expectedOutput.countsTowardCurrent,false);});
test('imported historical media must retain every original immutable event field, not merely the same filename',async()=>{const f=await historicalFixture();f.input.activeMedia[1].metadata={authorityDomain:'FORMAL',legacyVersion:{...f.historicalEvent,id:f.historicalEvent.versionId}};assert.equal(registeredMaterialCandidateProof(f.input).historicalExpectations.records.length,1);f.input.activeMedia[1].metadata.legacyVersion.expectedOutputId='OTHER';assert.throws(()=>registeredMaterialCandidateProof(f.input),e=>e.code==='SOURCE_REGISTERED_CANDIDATE_BINDING');});
for(const [name,mutate]of Object.entries({
 'unbacked historical event':f=>{f.snapshot.productionModel.assetVersions=[];},
 'retargeted historical base path':f=>{f.snapshot.productionModel.assetVersions[0].path+='x';},
 'historical base bytes changed':f=>{f.snapshot.productionModel.assetVersions[0].sha256='0'.repeat(64);},
 'historical media is trial':f=>{f.input.activeMedia[1].metadata.authorityDomain='LOCAL_TRIAL';},
 'historical actual file SHA differs':f=>{f.input.pinnedMediaHashes[f.historicalEvent.path]='0'.repeat(64);},
 'duplicate historical event':f=>{f.input.events.push({...f.historicalEvent,eventId:'DUP'});}
}))test('historical closure rejects '+name,async()=>{const f=await historicalFixture();mutate(f);f.input.baseRelease.snapshotBytes=Buffer.from(canonicalJson(f.snapshot));assert.throws(()=>registeredMaterialCandidateProof(f.input),e=>e.code==='SOURCE_REGISTERED_CANDIDATE_BINDING');});
test('historical expectation adapter proves exact sets and retains original family/version cardinality gate',async()=>{const result=await isolatedHistorical(await historicalFixture());assert.equal(result.historicalExpectations.declaredCounts.expectedOutputs,81);assert.equal(result.historicalExpectations.verifiedCounts.expectedOutputs,3);assert.equal(result.historicalExpectations.unprovedOutputsAccepted,0);assert.equal(result.baseCandidateVersionsCreated,0);});
for(const [name,mutateProjection]of Object.entries({
 'same-count current output retarget':m=>{m.expectedOutputs[0].targetPath+='x';},
 'same-count historical output retarget':m=>{m.expectedOutputs[2].targetPath+='x';},
 'extra unproved historical output':m=>{m.expectedOutputs.push({...m.expectedOutputs[2],id:'UNPROVED'});},
 'dropped current output':m=>{m.expectedOutputs.splice(0,1);},
 'changed family count':m=>{m.assetFamilies.pop();},
 'created base version':m=>{m.assetVersions.push({id:'INVENTED'});}
}))test('isolated historical count adapter rejects '+name,async()=>{await assert.rejects(isolatedHistorical(await historicalFixture(),{mutateProjection}),/REGISTERED_MATERIAL_CANDIDATE/);});
test('historical count adapter rejects a changed fixed source guard instead of accepting a new number',async()=>{await assert.rejects(isolatedHistorical(await historicalFixture(),{mutateGuard:true}),/unrecognized original retained-count guard AST/);});
test('historical-only compatibility remains proved without granting any declared-family membership exception',async()=>{const f=await historicalFixture();f.input.events=[f.historicalEvent];const result=await isolatedHistorical(f);assert.deepEqual(result.candidateVersionIds,[]);assert.equal(result.historicalExpectations.historicalExpectedOutputIds.length,1);});
test('subsequent compile can retain an already proved historical EO after the event-only projection replaced imported base evidence',async()=>{const f=await historicalFixture(),prior=registeredMaterialCandidateProof(f.input).historicalExpectations.records[0].expectedOutput;f.snapshot.productionModel.assetVersions=[];f.snapshot.productionModel.expectedOutputs.push(prior);f.snapshot.productionModel.assetFamilies[1].expectedOutputRefs.push(prior.id);f.input.baseRelease.snapshotBytes=Buffer.from(canonicalJson(f.snapshot));assert.equal(registeredMaterialCandidateProof(f.input).historicalExpectations.records[0].baseVersionHash,null);});
