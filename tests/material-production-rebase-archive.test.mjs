import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {sha256,canonicalJson} from '../host/instance-runtime/bytes.mjs';
import {materialProductionFixture,imageRequirementId,imageRepresentationId,changeDomain} from './material-production-fixture.mjs';
import {domainHash} from '../host/instance-runtime/domain-model.mjs';
import {getMaterialProductionWorkspace,saveMaterialProductionDraft,previewMaterialProduction,enqueueMaterialProduction,applyMaterialProductionJob} from '../host/instance-runtime/material-production-service.mjs';
import {validateMaterialProductionRebaseArchive,createMaterialProductionRebaseArchiveValidator} from '../host/instance-runtime/material-production-rebase-archive.mjs';
// Real isolated SQLite authoring/source/media/event rows. The tiny bytes and
// narrow approval projection are neutral fixtures, not actual art observation.
const api={projectOperationalState(snapshot,reviews,candidates){
 const model=snapshot.productionModel,versions=[...model.assetVersions,...candidates.map(c=>({...c,id:c.versionId,outputState:'PRESENT'}))],families=model.assetFamilies.map(f=>({...f}));
 for(const f of families){const adopted=reviews.find(e=>e.familyId===f.id&&e.action==='APPROVE_AND_RELEASE'&&e.applicationStatus==='APPLIED');if(adopted){f.currentVersionId=adopted.versionId;const v=versions.find(v=>v.id===adopted.versionId);Object.assign(v,{canFlowDownstream:true,lifecycleState:'RELEASED'});}}
 return {assetFamiliesById:Object.fromEntries(families.map(f=>[f.id,f])),assetVersionsById:Object.fromEntries(versions.map(v=>[v.id,v]))};
}};
const content=prompt=>({model:'codex:gpt-image-2',prompt,negativePrompt:'无不明人物或漂移。',parameters:{width:1024,height:1024},inputBindings:[]});
const workspace=repo=>repo.readTransaction(tx=>getMaterialProductionWorkspace(tx,{requirementId:imageRequirementId,api}));
async function stage(repo,prompt='干净人物母版。'){
 const w=await workspace(repo),saved=await repo.writeTransaction(tx=>saveMaterialProductionDraft(tx,{requirementId:imageRequirementId,expectedReleaseId:w.releaseId,expectedDraftRevisionId:w.draftHeadRevisionId,expectedBasisHash:w.basisHash,content:content(prompt)},{api})),preview=await repo.readTransaction(tx=>previewMaterialProduction(tx,{requirementId:imageRequirementId,draftRevisionId:saved.revisionId},{api}));
 return {w,saved,preview};
}
async function queue(repo,s,key){return repo.writeTransaction(tx=>enqueueMaterialProduction(tx,{requirementId:imageRequirementId,draftRevisionId:s.saved.revisionId,previewHash:s.preview.previewHash,requestId:key},{api}));}
async function provision(repo,prompt,key){const s=await stage(repo,prompt),job=await queue(repo,s,key);return repo.writeTransaction(tx=>applyMaterialProductionJob(tx,{jobId:job.jobId,api}));}
let nextEvent=0;
async function event(repo,kind,payload){const id='rebase-archive-fixture:'+String(++nextEvent);return (await repo.writeTransaction(tx=>tx.appendEvent({kind,idempotencyKey:id,requestHash:sha256(id),eventSchemaVersion:'2.2',payload}))).event;}
async function register(f,{review='REQUEST_REVISION',metadata={authorityDomain:'FORMAL'},label}={}){
 const view=await f.repo.readView(),plan=view.snapshot.productionModel.materialProductionPlans[0],work=view.snapshot.productionModel.materialWorkItems.find(w=>w.id===plan.workItemId),definition=view.recipes.executionDefinitions.find(d=>d.id===work.executionDefinitionRef),output=view.snapshot.productionModel.expectedOutputs.find(o=>o.id===definition.output.expectedOutputRef),versionId=plan.familyId+'@'+(label||output.plannedVersionLabel),bytes=Buffer.from('isolated fixture '+versionId);
 await mkdir(path.dirname(path.join(f.root,output.targetPath)),{recursive:true});await writeFile(path.join(f.root,output.targetPath),bytes,{flag:'wx'});
 const executionRequestId='request:'+versionId,runId='run:'+versionId,runBinding={executionRequestId,executionDefinitionId:definition.id,callPackageHash:definition.definitionHash};
 await event(f.repo,'execution-request',{...runBinding,workItemId:work.id,familyId:plan.familyId,executor:'CODEX',requestState:'CLAIMED',maxOutputs:1,snapshotId:view.snapshot.snapshotId});
 await event(f.repo,'run',{...runBinding,runId,runState:'SUCCEEDED'});
 await f.repo.writeTransaction(tx=>tx.registerMedia({mediaId:plan.familyId,versionId,relativePath:output.targetPath,sha256:sha256(bytes),byteSize:bytes.length,aliases:[],metadata}));
 const candidate=await event(f.repo,'asset-version',{...runBinding,runId,familyId:plan.familyId,versionId,expectedOutputId:output.id,path:output.targetPath,sha256:sha256(bytes),parentVersionId:definition.parentVersionId,inputBindings:[],lifecycleState:'REVIEW_PENDING',projectRightsGate:'UNKNOWN'});
 if(review)await event(f.repo,'review',{subjectType:'ASSET',familyId:plan.familyId,versionId,versionSha256:candidate.sha256,action:review,effect:'APPLIED',applicationStatus:'APPLIED'});
 return {plan,work,definition,output,candidate};
}

async function rebase(repo){
 const mode='REQUIREMENT_REBASE',w=await repo.readTransaction(tx=>getMaterialProductionWorkspace(tx,{requirementId:imageRequirementId,mode,api}));
 const saved=await repo.writeTransaction(tx=>saveMaterialProductionDraft(tx,{requirementId:imageRequirementId,mode,expectedReleaseId:w.releaseId,expectedDraftRevisionId:w.draftHeadRevisionId,expectedBasisHash:w.basisHash,content:content('Explicitly revised fixture state.'),acknowledgement:{confirmed:true,beforeHash:w.rebase.beforeHash,afterHash:w.rebase.afterHash,note:'Same permanent identity and scope; explicit changed state.'}},{api}));
 const preview=await repo.readTransaction(tx=>previewMaterialProduction(tx,{requirementId:imageRequirementId,mode,draftRevisionId:saved.revisionId},{api}));
 const job=await repo.writeTransaction(tx=>enqueueMaterialProduction(tx,{requirementId:imageRequirementId,mode,draftRevisionId:saved.revisionId,previewHash:preview.previewHash,requestId:'archive-rebase-'+(++nextEvent)},{api}));
 return repo.writeTransaction(tx=>applyMaterialProductionJob(tx,{jobId:job.jobId,api}));
}
async function fixture(t,{eventDomains=false}={}){
 const f=await materialProductionFixture(t);api.safeGeneratedPath=async(relative,binding)=>{const file=path.resolve(f.root,relative);assert.ok(file.startsWith(f.root+path.sep));assert.equal(sha256(await readFile(file)),binding.sha256);return file;};api.hashStableFile=async file=>sha256(await readFile(file));await provision(f.repo,'Original fixed fixture state.','archive-initial');const first=await register(f);await event(f.repo,'review',{subjectType:'ASSET',familyId:first.plan.familyId,versionId:first.candidate.versionId,versionSha256:first.candidate.sha256,action:'REQUEST_REVISION',effect:'APPLIED',applicationStatus:'APPLIED',note:'A second exact formal head supersedes the earlier observation.'});
 if(eventDomains)await f.repo.writeTransaction(async tx=>{
  await tx.importEvent({authorityDomain:'LOCAL_TRIAL',bytes:JSON.stringify({eventId:'trial:legacy-before',eventType:'fixture-trial',createdAt:Date.now()})});
  await tx.appendEvent({authorityDomain:'LOCAL_TRIAL',kind:'execution-request',idempotencyKey:'trial:request',requestHash:sha256('trial:request'),payload:{executionRequestId:'trial:unfinished',workItemId:first.work.id,familyId:first.plan.familyId,requestState:'CLAIMED',maxOutputs:1}});
 });
 const view=await f.repo.readView(),rep=view.snapshot.productionModel.domainGraph.representations.find(r=>r.id===imageRepresentationId);
 await changeDomain(f.repo,'MATERIAL',[{collection:'representations',id:rep.id,beforeHash:domainHash(rep),value:{...rep,label:'Changed exact authored fixture state'}}]);
 const result=await rebase(f.repo);await register(f);await provision(f.repo,'Ordinary successor retains rebase.','archive-successor');
 if(eventDomains)await f.repo.writeTransaction(tx=>tx.importEvent({authorityDomain:'LOCAL_TRIAL',bytes:JSON.stringify({eventId:'trial:legacy-after',eventType:'fixture-trial',createdAt:new Date().toISOString()})}));
 const archive=await f.repo.exportState();return {f,result,archive};
}
const decode=b=>Buffer.from(b.bytes,'base64');
const json=b=>JSON.parse(decode(b).toString());
const replace=(row,key,value)=>{const bytes=Buffer.from(canonicalJson(value));row[key]={encoding:'base64',bytes:bytes.toString('base64')};row[key.replace('_bytes','_sha256')]=sha256(bytes);};
const current=a=>a.tables.releases.find(r=>r.release_id===a.tables.repository_meta[0].current_release_id);
const rbSource=a=>a.tables.record_revisions.find(r=>r.namespace==='documents'&&JSON.parse(r.metadata_json).sourceRole==='MATERIAL_PRODUCTION_REQUIREMENT_REBASE');
function streaming(archive,order=Object.keys(archive.tables).sort()){
 const collector=createMaterialProductionRebaseArchiveValidator();
 for(const table of order)for(const raw of archive.tables[table]||[]){const row=Object.fromEntries(Object.entries(raw).map(([k,v])=>[k,v?.encoding==='base64'?decode(v):v]));collector.accept(table,row,table==='releases'?JSON.parse(row.snapshot_bytes.toString()):undefined);}
 collector.finish();
}
function both(archive){validateMaterialProductionRebaseArchive(archive);streaming(archive);streaming(archive,Object.keys(archive.tables).sort().reverse());}
function rejectBoth(archive,predicate){assert.throws(()=>validateMaterialProductionRebaseArchive(archive),predicate);assert.throws(()=>streaming(archive),predicate);}

test('real SQLite initial -> rebase -> ordinary source chain survives both object and streaming archive validation',async t=>{
 const {f,archive}=await fixture(t);both(archive);assert.deepEqual(await f.repo.exportState(),archive);
 const restoredEpoch=structuredClone(archive);restoredEpoch.tables.repository_meta[0].runtime_epoch='fresh-restored-epoch';both(restoredEpoch);
});

test('rebase keeps all storage positions while formal heads exclude independent trials',async t=>{
 const {f,archive}=await fixture(t,{eventDomains:true});both(archive);
 assert.equal(archive.tables.domain_events.filter(r=>r.authority_domain==='LOCAL_TRIAL').length,3);
 assert.deepEqual(await f.repo.exportState(),archive);
 const wrongTime=structuredClone(archive);wrongTime.tables.domain_events.find(r=>r.event_id==='trial:legacy-before').recorded_at='2000-01-01T00:00:00.000Z';rejectBoth(wrongTime,/存储事件序列或时间无效/);
 const moved=structuredClone(archive);moved.tables.domain_events.find(r=>r.authority_domain==='LOCAL_TRIAL'&&r.event_kind==='execution-request').authority_domain='FORMAL';rejectBoth(moved,/请求或Run头/);
 const lost=structuredClone(archive),source=json(rbSource(lost).content_bytes),parent=source.parentCandidate.eventId;lost.tables.domain_events.find(r=>r.event_id===parent).authority_domain='LOCAL_TRIAL';rejectBoth(lost,/真实事件缺失|父候选|未登记的成功结果/);
});

test('real archive outer SHA recomputation cannot erase or rebind domain, baseline, producer or original-event history',async t=>{
 const {archive}=await fixture(t);
 both(archive);
 const cases=[
  ['missing original AUX',a=>{const ref=json(rbSource(a).content_bytes).rebase.domainSources.before.graphRevisionId;a.tables.record_revisions=a.tables.record_revisions.filter(r=>r.revision_id!==ref);}],
  ['changed actual AUX bytes',a=>{const ref=json(rbSource(a).content_bytes).rebase.domainSources.after.graphRevisionId,r=a.tables.record_revisions.find(r=>r.revision_id===ref),g=json(r.content_bytes);g.auditFixture='changed original';replace(r,'content_bytes',g);}],
  ['foreign domain copy instance',a=>{const d=a.tables.record_revisions.find(r=>r.namespace==='documents'&&JSON.parse(r.metadata_json).sourceRole==='MATERIAL_PRODUCTION_DOMAIN_BASIS');d.metadata_json=JSON.stringify({...JSON.parse(d.metadata_json),instanceId:'other-instance'});}],
  ['copy source role downgrade',a=>{const d=a.tables.record_revisions.find(r=>r.namespace==='documents'&&JSON.parse(r.metadata_json).sourceRole==='MATERIAL_PRODUCTION_DOMAIN_BASIS');d.metadata_json=JSON.stringify({...JSON.parse(d.metadata_json),sourceRole:'SOURCE_DOCUMENT'});}],
  ['missing exact base release',a=>{const id=json(rbSource(a).content_bytes).baseReleaseId;a.tables.releases=a.tables.releases.filter(r=>r.release_id!==id);}],
  ['different after graph on actual base',a=>{const id=json(rbSource(a).content_bytes).baseReleaseId,r=a.tables.releases.find(r=>r.release_id===id),s=json(r.snapshot_bytes);s.productionModel.domainGraphRef.sha256='0'.repeat(64);replace(r,'snapshot_bytes',s);}],
  ['foreign explicit base instance',a=>{const id=json(rbSource(a).content_bytes).baseReleaseId,r=a.tables.releases.find(r=>r.release_id===id),s=json(r.snapshot_bytes);s.instance={...s.instance,instanceId:'other-instance'};replace(r,'snapshot_bytes',s);}],
  ['removed current ledger',a=>{const r=current(a),s=json(r.snapshot_bytes);s.productionModel.materialProductionRecipeRevisions=[];replace(r,'snapshot_bytes',s);}],
  ['removed both row markers',a=>{const r=current(a),s=json(r.snapshot_bytes);for(const x of s.productionModel.materialProductionRecipeRevisions){delete x.schemaVersion;delete x.rebaseId;}replace(r,'snapshot_bytes',s);}],
  ['removed copied source pin',a=>{const r=current(a),ref=json(rbSource(a).content_bytes).rebase.domainSources.after.path,id=a.tables.document_aliases.find(x=>x.alias===ref).document_id,doc=a.tables.record_revisions.find(x=>x.record_key===id);r.source_revision_ids_json=JSON.stringify(JSON.parse(r.source_revision_ids_json).filter(x=>x!==doc.revision_id));}],
  ['missing actual parent event',a=>{const id=json(rbSource(a).content_bytes).parentCandidate.eventId;a.tables.domain_events=a.tables.domain_events.filter(r=>r.event_id!==id);}],
  ['changed actual event and rehashed container',a=>{const id=json(rbSource(a).content_bytes).parentCandidate.eventId,r=a.tables.domain_events.find(r=>r.event_id===id),e=json(r.event_bytes);e.note='changed evidence';replace(r,'event_bytes',e);}],
  ['unbound source path',a=>{a.tables.document_aliases=a.tables.document_aliases.filter(r=>!r.alias.startsWith('story/material-production/requirement-rebases/'));}],
 ];
 for(const [label,mutate]of cases)await t.test(label,()=>{const changed=structuredClone(archive);mutate(changed);rejectBoth(changed,e=>['MATERIAL_PRODUCTION_REBASE_ARCHIVE','MATERIAL_PRODUCTION_SOURCE_CONFLICT'].includes(e.code));});
});

test('no-rebase legacy archive receives no new model contract',()=>{both({tables:{repository_meta:[{instance_id:'legacy',current_release_id:'r'}],document_aliases:[],record_revisions:[],domain_events:[],releases:[]}});});

test('two actual SQLite rebases retain the original plan, each semantic source and all intermediate releases',async t=>{
 const {f}=await fixture(t);await register(f);
 const view=await f.repo.readView(),rep=view.snapshot.productionModel.domainGraph.representations.find(r=>r.id===imageRepresentationId);
 await changeDomain(f.repo,'MATERIAL',[{collection:'representations',id:rep.id,beforeHash:domainHash(rep),value:{...rep,label:'Second explicitly revised fixture state'}}]);
 await rebase(f.repo);const archive=await f.repo.exportState();both(archive);
 assert.equal(json(current(archive).snapshot_bytes).productionModel.materialProductionRecipeRevisions.filter(r=>r.schemaVersion==='MATERIAL_PRODUCTION_REQUIREMENT_REBASE_V1').length,2);
 const changed=structuredClone(archive),middle=changed.tables.releases.find(r=>r.release_id!==current(changed).release_id&&json(r.snapshot_bytes).productionModel.materialProductionRecipeRevisions?.length===2);assert.ok(middle);
 const snapshot=json(middle.snapshot_bytes);snapshot.productionModel.materialProductionRecipeRevisions=[];replace(middle,'snapshot_bytes',snapshot);
 rejectBoth(changed,/历史发布丢失/);
});

function rehashRebase(archive,mutate){
 const source=rbSource(archive),body=json(source.content_bytes),oldSha=source.content_sha256,oldBasis=body.basisHash;
 mutate(body);body.basisHash=domainHash(body.basis);replace(source,'content_bytes',body);
 const replacements=new Map([[oldSha,source.content_sha256],[oldBasis,body.basisHash]]);
 function walk(v){if(typeof v==='string')return replacements.get(v)||v;if(Array.isArray(v))return v.map(walk);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,walk(x)]));return v;}
 for(const r of archive.tables.releases)for(const field of ['snapshot_bytes','recipes_bytes'])replace(r,field,walk(json(r[field])));
}

test('real SQLite fixed storage watermark rejects stale review and missing heads even after all source/catalog/release envelopes are rehashed',async t=>{
 const {archive}=await fixture(t);both(archive);
 const parent=json(rbSource(archive).content_bytes).parentCandidate;
 const oldReview=archive.tables.domain_events.map(r=>json(r.event_bytes)).find(e=>e.eventKind==='review'&&e.versionId===parent.versionId);
 for(const [label,mutate,reason]of[
  ['superseded exact review',b=>{const ref={eventId:oldReview.eventId,eventSequence:oldReview.eventSequence,sha256:domainHash(oldReview)};b.basis.revision.parentReview=ref;b.basis.revision.familyReviewHead=ref;},/审阅头被旧结论/],
  ['omitted request head',b=>{b.basis.revision.requestHeads=[];},/请求或Run头/],
  ['omitted run head',b=>{b.basis.revision.runHeads=[];},/请求或Run头/],
  ['earlier incomplete storage watermark',b=>{b.operationEventSequence=0;},/水位遗漏|请求或Run头|审阅头/],
  ['nonexistent watermark',b=>{b.operationEventSequence=Number.MAX_SAFE_INTEGER;},/没有真实存储事件/],
 ])await t.test(label,()=>{const changed=structuredClone(archive);rehashRebase(changed,mutate);rejectBoth(changed,reason);});
});

test('source capacity guard applies only to archives containing the new protocol, without retaining bytes past the bound',()=>{
 const bytes=Buffer.alloc(1024*1024,32),digest=sha256(bytes);
 const feed=()=>{const v=createMaterialProductionRebaseArchiveValidator();for(let i=0;i<65;i++)v.accept('record_revisions',{namespace:'documents',record_key:'legacy-'+i,revision_id:'legacy-revision-'+i,content_bytes:bytes,content_sha256:digest,metadata_json:JSON.stringify({sourceRole:'MATERIAL_PRODUCTION_PLAN'}),deleted:0});return v;};
 assert.doesNotThrow(()=>feed().finish());
 const marked=feed();marked.accept('document_aliases',{document_id:'new-source',alias:'story/material-production/requirement-rebases/new-source.json'});assert.throws(()=>marked.finish(),/容量/);
});
