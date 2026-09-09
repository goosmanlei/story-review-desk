import {domainHash,validateRequirementReplacementTransition} from './domain-model.mjs';
import {canonicalJson,sha256} from './bytes.mjs';
import {inspectExecutionDefinitionHash} from './execution-definition-hash.mjs';
import {assertAssetContextSource} from './asset-context-revalidation-model.mjs';

export const REPLACEMENT_EXECUTION_JOB_NAMESPACES=['material-production-jobs','material-usage-jobs','asset-context-revalidation-jobs','shot-production-jobs','shot-production-recipe-jobs','shot-production-manifest-jobs','animatic-render-jobs','animatic-reconciliations','spatial-shot-view-jobs'];
const list=v=>Array.isArray(v)?v:[];
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const current=w=>w?.scopeRole!=='EVIDENCE_ONLY'&&w?.scopeRole!=='HISTORICAL'&&w?.activeInCurrentProduction!==false;
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const runState=r=>String(r.runState||r.state||'RESULT_UNKNOWN');
const requestState=r=>String(r.requestState||r.status||'UNKNOWN');
const binding=e=>({eventId:e.eventId,eventSequence:e.eventSequence,sha256:domainHash(e)});
const newClaims=(old,next)=>list(next?.requirements).filter(r=>Object.hasOwn(r,'replaces')&&!list(old?.requirements).some(p=>p.id===r.id&&Object.hasOwn(p,'replaces')));
function semanticBinding(frozen,requirement,graph){
 const search=rows=>list(rows).flatMap(b=>[b,...search(list(b.requiredComponents).map(c=>c.binding))]);
 const bindings=[...new Map(search(frozen?.bindings).filter(b=>b.requirementId===requirement.id).map(b=>[domainHash(b),b])).values()];if(bindings.length!==1)return false;
 const b=bindings[0];if(frozen.schemaVersion==='2.0')return b.requirementHash===requirement.requirementHash;
 if(frozen.schemaVersion!=='3.0'||frozen.semanticPolicy!=='SHOT_DESIGN_REQUIREMENT_SEMANTICS_V1')return false;
 const demand=list(graph?.requirements).find(r=>r.id===requirement.id),rep=list(graph?.representations).find(r=>r.id===demand?.representationId);
 return !!demand&&!!rep&&same(b.demand,demand)&&b.requirement?.id===requirement.id&&same(b.conditions?.representation?.value,Object.fromEntries(Object.entries(rep).filter(([k])=>k!=='assetFamilyIds')));
}

/** Must run in the caller's CAS transaction; reads every historical event, never a snapshot-filtered projection. */
export async function inspectMaterialRequirementReplacementExecution(tx,{nextGraph,view:providedView,previousGraph}={}){
 const view=providedView||await tx.readView(),model=view.snapshot.productionModel,old=previousGraph||model.domainGraph;
 validateRequirementReplacementTransition(old,nextGraph);
 const claims=newClaims(old,nextGraph),impact={replacementRefs:claims.map(c=>({...c.replaces,replacementRequirementId:c.id})),currentWorkIds:[],historicalWorkIds:[],historicalReleaseProofs:[],currentPlanIds:[],currentProductionPlanIds:[],definitionIds:[],affectedSceneIds:[],requestHeads:[],runHeads:[],hostJobs:[],reasons:[]};
 if(!claims.length)return impact;
 const reason=(code,id)=>impact.reasons.push(code+(id?':'+id:''));
 const meta=await tx.getMetadata();
 const exact=(rows,id,label)=>{const found=list(rows).filter(r=>r.id===id);if(found.length!==1){reason('REPLACEMENT_'+label+'_CLOSURE_INVALID',id);return null;}return found[0];};
 const requirements=claims.map(c=>{const r=exact(model.materialRequirements,c.replaces.requirementId,'REQUIREMENT');if(r&&(r.requirementClass!=='REQUIRED'||r.sourceKind!=='DOMAIN_GRAPH'||r.requirementHash!==c.replaces.requirementHash))reason('REPLACEMENT_REQUIREMENT_BASIS_CHANGED',r.id);return r;}).filter(Boolean);
 const requirementIds=new Set(requirements.map(r=>r.id)),works=new Map(),currentWorkIds=new Set(),scenes=new Set(),designIds=new Set(),currentDesignIds=new Set(),productionIds=new Set();
 const allWorks=[...list(model.materialWorkItems),...list(model.workItems)].filter((w,i,rows)=>rows.findIndex(x=>x.id===w.id)===i);
 function addWork(work,active=current(work)){if(!work?.id)return;const versions=[...list(model.materialWorkItems),...list(model.workItems)].filter(w=>w.id===work.id);if(versions.length&&new Set(versions.map(domainHash)).size!==1)reason('REPLACEMENT_WORK_IDENTITY_AMBIGUOUS',work.id);works.set(work.id,work);if(active)currentWorkIds.add(work.id);if(work.sceneId)scenes.add(work.sceneId);}
 for(const r of requirements){
  const owned=list(model.materialWorkItems).filter(w=>w.requirementRef===r.id&&(current(w)||w.requirementHash===r.requirementHash));
  for(const w of owned){if(w.requirementHash!==r.requirementHash){reason('REPLACEMENT_MATERIAL_WORK_HASH_CHANGED',w.id);continue;}const family=exact(model.assetFamilies,w.outputAssetRef,'OUTPUT_FAMILY');if(family?.ownerRef!==w.id)reason('REPLACEMENT_MATERIAL_WORK_OWNER_CHANGED',w.id);addWork(w);}
  if(r.materialWorkItemRef&&!owned.some(w=>w.id===r.materialWorkItemRef))reason('REPLACEMENT_MATERIAL_WORK_MISSING',r.materialWorkItemRef);
 }
 const affectedShots=new Set();
 function usesRoot(id,path=[],targets=requirementIds){if(targets.has(id))return true;if(path.includes(id))return false;const r=list(model.materialRequirements).find(r=>r.id===id);return list(r?.composition?.requiredComponents).some(c=>usesRoot(c.requirementId,[...path,id],targets));}
 for(const plan of list(model.shotPlanSetRevisions)){
  const specs=list(plan.content?.shots),used=specs.filter(s=>list(s.materialRequirementRefs).some(id=>usesRoot(id)));if(!used.length)continue;
  const consumed=requirements.filter(r=>used.some(s=>list(s.materialRequirementRefs).some(id=>usesRoot(id,[],new Set([r.id])))));
  if(plan.scopeRole!=='CURRENT'&&!consumed.some(r=>semanticBinding(plan.materialRequirementSet,r,old)))continue;
  designIds.add(plan.id);if(plan.scopeRole==='CURRENT')currentDesignIds.add(plan.id);const sceneId=plan.scopeId||plan.sceneId;if(sceneId)scenes.add(sceneId);
  if(!plan.id||!sceneId||plan.content?.sceneId!==sceneId||!hash(plan.contentHash)||domainHash(plan.content)!==plan.contentHash)reason('REPLACEMENT_SHOT_PLAN_CLOSURE_INVALID',plan.id);
  for(const r of consumed)if(!semanticBinding(plan.materialRequirementSet,r,old))reason('REPLACEMENT_SHOT_PLAN_REQUIREMENT_BASIS_UNKNOWN',plan.id+'/'+r.id);
  for(const spec of used){if(!spec.shotId||spec.sceneId!==sceneId)reason('REPLACEMENT_SHOT_IDENTITY_INVALID',plan.id);else affectedShots.add(spec.shotId);}
 }
 // Production plans can retain a reused work's earlier producer ID; the current explicit membership wins.
 for(const plan of list(model.shotProductionPlans)){
  const named=list(plan.content?.shots).some(s=>list(s.inputs).concat(list(s.previsInputs)).some(b=>usesRoot(b.requirementId)));
  if(!designIds.has(plan.content?.shotPlanRevisionId)&&!named)continue;
  if(plan.scopeRole==='CURRENT')productionIds.add(plan.id);if(plan.sceneId)scenes.add(plan.sceneId);
  if(!plan.id||!plan.sceneId||!hash(plan.contentHash)||domainHash(plan.content)!==plan.contentHash)reason('REPLACEMENT_PRODUCTION_PLAN_CLOSURE_INVALID',plan.id);
  if(named&&!designIds.has(plan.content?.shotPlanRevisionId))reason('REPLACEMENT_PRODUCTION_DESIGN_BINDING_UNKNOWN',plan.id);
  const memberIds=Array.isArray(plan.workItemIds)?plan.workItemIds:list(model.workItems).filter(w=>w.shotProductionPlanId===plan.id).map(w=>w.id);
  for(const id of memberIds){const work=exact(model.workItems,id,'SHOT_WORK');if(!work)continue;if(plan.scopeRole==='CURRENT'&&!current(work)||work.sceneId!==plan.sceneId){reason('REPLACEMENT_SHOT_WORK_OWNER_CHANGED',id);continue;}if(!work.shotId||affectedShots.has(work.shotId))addWork(work,plan.scopeRole==='CURRENT'&&current(work));}
 }
 // A current, explicitly linked downstream work is affected; a base image used as a mother alone is not.
 for(let changed=true;changed;){changed=false;const outputs=new Set([...works.values()].filter(w=>w.shotProductionPlanId).map(w=>w.outputAssetRef));for(const work of allWorks){if(works.has(work.id)||!list(work.inputAssetRefs).some(id=>outputs.has(id)))continue;addWork(work);changed=true;}}
 const defs=list(view.recipes?.executionDefinitions),definitions=new Map(),outputs=new Map(list(model.expectedOutputs).map(o=>[o.id,o]));
 function addDefinition(d,sourceModel=model){
  if(!inspectExecutionDefinitionHash(d).valid){reason('REPLACEMENT_DEFINITION_HASH_OR_ID_INVALID',d.id);return;}
  const prior=definitions.get(d.id);if(prior&&prior.definitionHash!==d.definitionHash){reason('REPLACEMENT_DEFINITION_IDENTITY_CHANGED',d.id);return;}
  const w=works.get(d.workItemRef);if(!w||d.output?.assetFamilyRef!==w.outputAssetRef){reason('REPLACEMENT_DEFINITION_OUTPUT_OWNER_CHANGED',d.id);return;}
  const owned=list(sourceModel.expectedOutputs).filter(o=>o.id===d.output?.expectedOutputRef);if(owned.length===1){const output=owned[0];if(output.familyId!==d.output.assetFamilyRef||output.targetPath!==d.output.path)reason('REPLACEMENT_EXPECTED_OUTPUT_BINDING_CHANGED',d.id);else outputs.set(output.id,output);}else if(owned.length>1)reason('REPLACEMENT_EXPECTED_OUTPUT_CLOSURE_INVALID',d.id);
  definitions.set(d.id,d);
 }
 for(const d of defs.filter(d=>works.has(d.workItemRef)))addDefinition(d);
 const events=await tx.listEvents();
 if(!Array.isArray(events))reason('REPLACEMENT_FULL_EVENT_COLLECTION_UNAVAILABLE');
 const requests=list(events).filter(e=>e.eventKind==='execution-request'),runs=list(events).filter(e=>e.eventKind==='run'),candidates=list(events).filter(e=>e.eventKind==='asset-version');
 // Read one exact historical publication at a time. Keep only bound works,
 // definitions and small proof descriptors, never a pile of old snapshots.
 const historySeen=new Set();
 async function historical(q,required){
  try{
   if(!q.snapshotId||!Number.isFinite(Date.parse(q.recordedAt)))throw Error('request timestamp/snapshot missing');
   const release=await tx.readPublishedReleaseAt({recordedBefore:q.recordedAt,snapshotId:q.snapshotId});
   if(!release||release.snapshotId!==q.snapshotId||!(Date.parse(release.createdAt)<Date.parse(q.recordedAt))||sha256(release.snapshotBytes)!==release.snapshotSha256||sha256(release.recipesBytes)!==release.recipesSha256)throw Error('original release hash/time differs');
   const snapshot=JSON.parse(release.snapshotBytes),recipes=JSON.parse(release.recipesBytes),hm=snapshot.productionModel;
   if(snapshot.snapshotId!==release.snapshotId||recipes.snapshotId!==release.snapshotId||!hm||[snapshot.instance?.instanceId,hm.instance?.instanceId].some(id=>id&&id!==meta.instanceId))throw Error('release identity differs');
   const profile=await tx.getRecord('settings','instance-profile',release.profileRevisionId);
   if(!profile||profile.deleted||profile.revisionId!==release.profileRevisionId||sha256(profile.bytes)!==profile.sha256||JSON.parse(profile.bytes).instanceId!==meta.instanceId)throw Error('historical profile differs');
   if(hm.domainGraphRef){const ref=hm.domainGraphRef,aux=await tx.getAux('domain-graph','current',{revisionId:ref.revisionId});if(!aux||aux.deleted||aux.revisionId!==ref.revisionId||aux.sha256!==ref.sha256||sha256(aux.bytes)!==ref.sha256||!same(JSON.parse(aux.bytes),hm.domainGraph))throw Error('historical domain source differs');}
   const candidatesWorks=[...list(hm.materialWorkItems),...list(hm.workItems)].filter(w=>w.id===q.workItemId),uniqueWorks=[...new Map(candidatesWorks.map(w=>[domainHash(w),w])).values()];
   if(uniqueWorks.length!==1)throw Error('historical work unavailable');const w=uniqueWorks[0];
   const historicalRequirements=requirements.filter(r=>{const projected=list(hm.materialRequirements).filter(v=>v.id===r.id),demand=list(hm.domainGraph?.requirements).find(v=>v.id===r.id),rep=list(hm.domainGraph?.representations).find(v=>v.id===demand?.representationId);return projected.length===1&&projected[0].requirementHash===r.requirementHash&&demand&&rep&&domainHash({demand,representation:rep})===r.requirementHash;});
   let associated=historicalRequirements.some(r=>w.requirementRef===r.id&&w.requirementHash===r.requirementHash);
   if(!associated){
    const plans=list(hm.shotProductionPlans).filter(p=>list(p.workItemIds).includes(w.id)||!Array.isArray(p.workItemIds)&&w.shotProductionPlanId===p.id);
    associated=plans.some(p=>{
     if(p.sceneId!==w.sceneId||!hash(p.contentHash)||domainHash(p.content)!==p.contentHash)return false;
     const design=list(hm.shotPlanSetRevisions).find(d=>d.id===p.content?.shotPlanRevisionId);if(!design||!hash(design.contentHash)||domainHash(design.content)!==design.contentHash)return false;
     return historicalRequirements.some(r=>semanticBinding(design.materialRequirementSet,r,old)&&list(design.content?.shots).some(s=>(!w.shotId||s.shotId===w.shotId)&&list(s.materialRequirementRefs).some(id=>{const walk=(key,path=[])=>key===r.id||!path.includes(key)&&list(list(hm.materialRequirements).find(v=>v.id===key)?.composition?.requiredComponents).some(c=>walk(c.requirementId,[...path,key]));return walk(id);})));
    });
   }
   if(!associated){if(required)throw Error('historical work does not consume exact old demand');return;}
   const prior=works.get(w.id);if(prior&&prior.outputAssetRef!==w.outputAssetRef)throw Error('work output identity changed');if(!prior)addWork(w,false);
   const found=list(recipes.executionDefinitions).filter(d=>d.id===q.executionDefinitionId);if(found.length!==1||found[0].workItemRef!==w.id||found[0].definitionHash!==q.callPackageHash)throw Error('historical definition differs');
   const d=found[0];
   if(d.sourceRevisionId||d.sourceSha256){const doc=await tx.readDocumentRevision(d.sourceRevisionId);if(!doc||doc.deleted||doc.revisionId!==d.sourceRevisionId||doc.sha256!==d.sourceSha256||sha256(doc.bytes)!==d.sourceSha256||!list(release.sourceRevisionIds).includes(d.sourceRevisionId))throw Error('definition source differs');}
   addDefinition(d,hm);
   if(!historySeen.has(release.releaseId)){historySeen.add(release.releaseId);impact.historicalReleaseProofs.push({releaseId:release.releaseId,snapshotId:release.snapshotId,createdAt:release.createdAt,snapshotSha256:release.snapshotSha256,recipesSha256:release.recipesSha256,profileRevisionId:release.profileRevisionId,profileSha256:profile.sha256});}
  }catch{reason('REPLACEMENT_HISTORICAL_CONTEXT_UNKNOWN',q.executionRequestId);}
 }
 // An old work may have left today's catalogue entirely. A real request's
 // publication is the attribution proof; self-declared work text is not one.
 function provenUnrelated(q){
  const rows=allWorks.filter(w=>w.id===q.workItemId&&current(w));if(rows.length!==1)return false;const w=rows[0];
  const definition=defs.find(d=>d.id===q.executionDefinitionId);if(!definition||!inspectExecutionDefinitionHash(definition).valid||definition.workItemRef!==w.id||definition.definitionHash!==q.callPackageHash||definition.output?.assetFamilyRef!==w.outputAssetRef||q.familyId!==w.outputAssetRef)return false;
  if(w.requirementRef){const demand=list(model.materialRequirements).filter(r=>r.id===w.requirementRef);return demand.length===1&&!usesRoot(w.requirementRef)&&!!w.requirementHash&&w.requirementHash===demand[0].requirementHash;}
  const plans=list(model.shotProductionPlans).filter(p=>p.scopeRole==='CURRENT'&&list(p.workItemIds).includes(w.id));if(plans.length!==1)return false;const p=plans[0],design=list(model.shotPlanSetRevisions).find(d=>d.id===p.content?.shotPlanRevisionId);
  return !!design&&domainHash(p.content)===p.contentHash&&domainHash(design.content)===design.contentHash&&p.sceneId===w.sceneId&&!list(design.content?.shots).filter(s=>!w.shotId||s.shotId===w.shotId).some(s=>list(s.materialRequirementRefs).some(id=>usesRoot(id)))&&!list(p.content?.shots).some(s=>list(s.inputs).concat(list(s.previsInputs)).some(b=>usesRoot(b.requirementId)));
 }
 const latestRequests=[...new Map([...requests].sort((a,b)=>a.eventSequence-b.eventSequence).map(q=>[q.executionRequestId,q])).values()];
 for(const q of latestRequests){const d=definitions.get(q.executionDefinitionId),related=works.has(q.workItemId)||!!d;if(related&&(!d||!outputs.has(d.output.expectedOutputRef))||!related&&!provenUnrelated(q)){const origin=requests.filter(e=>e.executionRequestId===q.executionRequestId).sort((a,b)=>a.eventSequence-b.eventSequence)[0];if(!origin||origin.executionDefinitionId!==q.executionDefinitionId||origin.callPackageHash!==q.callPackageHash||origin.workItemId!==q.workItemId)reason('REPLACEMENT_REQUEST_HISTORY_CHANGED',q.executionRequestId);else await historical(origin,related);}}
 for(const w of works.values())if(w.executionDefinitionRef&&!definitions.has(w.executionDefinitionRef)&&currentWorkIds.has(w.id))reason('REPLACEMENT_CURRENT_DEFINITION_MISSING',w.id);
 for(const d of definitions.values()){const output=outputs.get(d.output?.expectedOutputRef);if(!output||output.familyId!==d.output.assetFamilyRef||output.targetPath!==d.output.path)reason('REPLACEMENT_EXPECTED_OUTPUT_CLOSURE_INVALID',d.id);}
 const outputFamilies=new Set([...works.values()].map(w=>w.outputAssetRef).filter(Boolean));
 const requestIds=new Set(requests.filter(e=>works.has(e.workItemId)||definitions.has(e.executionDefinitionId)||outputFamilies.has(e.familyId)).map(e=>e.executionRequestId));
 const runIds=new Set(runs.filter(e=>definitions.has(e.executionDefinitionId)||requestIds.has(e.executionRequestId)||works.has(e.workItemId)).map(e=>e.runId));
 for(const e of runs.filter(e=>runIds.has(e.runId)))if(e.executionRequestId)requestIds.add(e.executionRequestId);
 function heads(rows,ids,key){const out=[];for(const id of ids){const matches=rows.filter(e=>e[key]===id);if(!id||!matches.length||matches.some(e=>!e.eventId||!Number.isSafeInteger(e.eventSequence)||e.eventSequence<1)||new Set(matches.map(e=>e.eventSequence)).size!==matches.length){reason('REPLACEMENT_EVENT_HEAD_UNKNOWN',id||key);continue;}out.push([...matches].sort((a,b)=>b.eventSequence-a.eventSequence)[0]);}return out;}
 const qHeads=heads(requests,requestIds,'executionRequestId'),rHeads=heads(runs,runIds,'runId');
 for(const e of [...qHeads,...rHeads]){const explicit=e.instanceId||e.authorizationRuntime?.instanceId||e.claimRuntime?.instanceId;if(explicit&&explicit!==meta.instanceId)reason('REPLACEMENT_EVENT_INSTANCE_UNKNOWN',e.eventId);}
 const canonicalInputs=d=>list(d.upload?.items).map((b,i)=>({order:Number(b.order??i+1),path:String(b.path||''),assetFamilyRef:String(b.assetFamilyRef||''),assetVersionRef:String(b.assetVersionRef||''),sha256:String(b.sha256||'')}));
 for(const q of qHeads){const d=definitions.get(q.executionDefinitionId);if(!d||d.workItemRef!==q.workItemId||d.output.assetFamilyRef!==q.familyId||q.callPackageHash!==d.definitionHash)reason('REPLACEMENT_REQUEST_OWNERSHIP_UNKNOWN',q.executionRequestId);else if(!same(q.inputBindings,canonicalInputs(d))||q.inputBindingsHash!==domainHash(canonicalInputs(d)))reason('REPLACEMENT_REQUEST_INPUTS_UNKNOWN',q.executionRequestId);}
 const registered=new Map();
 for(const run of rHeads){
  const d=definitions.get(run.executionDefinitionId),q=qHeads.find(e=>e.executionRequestId===run.executionRequestId);
  if(!d||!q||q.executionDefinitionId!==d.id||q.callPackageHash!==d.definitionHash||run.callPackageHash!==d.definitionHash||run.inputBindingsHash!==domainHash(canonicalInputs(d))){reason('REPLACEMENT_RUN_OWNERSHIP_UNKNOWN',run.runId);continue;}
  let count=0;const seenVersions=new Set();
  for(const c of candidates.filter(c=>c.runId===run.runId)){
   if(!c.eventId||!Number.isSafeInteger(c.eventSequence)||c.eventSequence<1||seenVersions.has(c.versionId)||c.executionRequestId!==q.executionRequestId||c.executionDefinitionId!==d.id||c.callPackageHash!==d.definitionHash||c.familyId!==d.output.assetFamilyRef||c.expectedOutputId!==d.output.expectedOutputRef||c.path!==d.output.path||!c.versionId||!hash(c.sha256)){reason('REPLACEMENT_CANDIDATE_BINDING_UNKNOWN',c.eventId);continue;}
   const media=await tx.getMedia(c.familyId,c.versionId),resolved=await tx.resolveMedia(c.path,{versionId:c.versionId,sha256:c.sha256});
   if(!media||!resolved||media.mediaId!==c.familyId||media.versionId!==c.versionId||media.sha256!==c.sha256||resolved.mediaId!==media.mediaId||resolved.versionId!==media.versionId||resolved.sha256!==media.sha256||resolved.relativePath!==media.relativePath||media.metadata?.registrationEventId&&media.metadata.registrationEventId!==c.eventId){reason('REPLACEMENT_CANDIDATE_REGISTRATION_UNKNOWN',c.eventId);continue;}seenVersions.add(c.versionId);count++;
  }
  registered.set(run.runId,count);
  const status=runState(run);
  if(['PLANNED','SUBMITTED','RUNNING','RESULT_UNKNOWN'].includes(status)||!['FAILED','CANCELLED','SUCCEEDED'].includes(status)||status==='SUCCEEDED'&&!count)reason('REPLACEMENT_RUN_PENDING',run.runId);
  if(count&&status!=='SUCCEEDED')reason('REPLACEMENT_RUN_RESULT_CONFLICT',run.runId);
 }
 for(const q of qHeads){
  const status=requestState(q),ownedRuns=rHeads.filter(r=>r.executionRequestId===q.executionRequestId),count=ownedRuns.reduce((n,r)=>n+(registered.get(r.runId)||0),0);
  if(!['AUTHORIZED','CLAIMED','CANCELLED'].includes(status)){reason('REPLACEMENT_REQUEST_STATE_UNKNOWN',q.executionRequestId);continue;}
  if(status==='CANCELLED')continue;
  if(!Number.isSafeInteger(q.maxOutputs)||q.maxOutputs<1){reason('REPLACEMENT_REQUEST_CAPACITY_UNKNOWN',q.executionRequestId);continue;}
  if(count>=q.maxOutputs)continue;
  if(!ownedRuns.length||ownedRuns.some(r=>!['FAILED','CANCELLED'].includes(runState(r))))reason('REPLACEMENT_AUTHORIZATION_UNCONSUMED',q.executionRequestId);
 }
 for(const namespace of REPLACEMENT_EXECUTION_JOB_NAMESPACES){
  for(const record of await tx.listAux(namespace)){
   if(record.deleted)continue;let job;try{job=JSON.parse(Buffer.from(record.bytes).toString('utf8'));}catch{reason('REPLACEMENT_HOST_JOB_SCOPE_UNKNOWN',namespace+'/'+record.key);continue;}
   if(!job||typeof job!=='object'||Array.isArray(job)){reason('REPLACEMENT_HOST_JOB_SCOPE_UNKNOWN',namespace+'/'+record.key);continue;}
   let contextRequirementId;
   if(namespace==='asset-context-revalidation-jobs'&&!['SUCCEEDED','FAILED','CANCELLED','RECONCILED_UNREGISTERED'].includes(job.status)){
    try{
     const body=assertAssetContextSource(job.preview?.revalidation);contextRequirementId=body.basis.current.requirementId;
     if(job.requirementId!==contextRequirementId||job.revalidationId!==body.revalidationId||job.instanceId!==body.basis.instanceId||job.runtimeEpoch!==body.basis.runtimeEpoch||job.preview.previewHash!==domainHash(body)||job.input?.previewHash!==job.preview.previewHash||['familyId','versionId','sha256'].some(k=>job.input?.[k]!==body.basis.source[k]))throw Error('Context job differs from its frozen preview');
    }catch{reason('REPLACEMENT_HOST_JOB_SCOPE_UNKNOWN',namespace+'/'+record.key);}
   }
   const jobRequirementId=contextRequirementId||job.requirementId||job.input?.requirementId||job.preview?.plan?.requirementId,jobWorkId=job.workItemId||job.input?.workItemId||job.preview?.workItemId,jobSceneId=job.sceneId||job.input?.sceneId||job.preview?.sceneId,jobWork=allWorks.find(w=>w.id===jobWorkId);
   const related=requirementIds.has(jobRequirementId)||works.has(jobWorkId)||scenes.has(jobSceneId)||scenes.has(jobWork?.sceneId)||designIds.has(job.preview?.definition?.productionBasis?.shotPlanRevisionId);
   if(!jobRequirementId&&!jobWorkId&&!jobSceneId&&!['SUCCEEDED','FAILED','CANCELLED','RECONCILED_UNREGISTERED'].includes(job.status))reason('REPLACEMENT_HOST_JOB_SCOPE_UNKNOWN',namespace+'/'+record.key);
   if(!related)continue;
   const id=job.reconciliationId||job.jobId||record.key;impact.hostJobs.push({namespace,jobId:id,status:job.status,revisionId:record.revisionId,sha256:record.sha256||domainHash(job)});
   if(job.instanceId&&job.instanceId!==meta.instanceId)reason('REPLACEMENT_HOST_JOB_INSTANCE_UNKNOWN',id);
   if(!['SUCCEEDED','FAILED','CANCELLED','RECONCILED_UNREGISTERED'].includes(job.status))reason('REPLACEMENT_HOST_JOB_PENDING',id);
  }
 }
 Object.assign(impact,{currentWorkIds:[...currentWorkIds].sort(),historicalWorkIds:[...works.keys()].filter(id=>!currentWorkIds.has(id)).sort(),currentPlanIds:[...currentDesignIds].sort(),currentProductionPlanIds:[...productionIds].sort(),definitionIds:[...definitions.keys()].sort(),affectedSceneIds:[...scenes].sort(),requestHeads:qHeads.map(binding),runHeads:rHeads.map(binding),reasons:[...new Set(impact.reasons)].sort()});return impact;
}
export async function assertMaterialRequirementReplacementExecution(tx,input){const impact=await inspectMaterialRequirementReplacementExecution(tx,input);if(impact.reasons.length)throw Object.assign(new Error('需求替代仍有执行中、未核清结果或归属不完整的受影响任务：'+impact.reasons.join('、')),{code:'DOMAIN_CONFLICT',impact});return impact;}
