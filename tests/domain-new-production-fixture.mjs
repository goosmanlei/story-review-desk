import {blankProfile,blankSnapshot} from '../host/instance-runtime/blank.mjs';
import {loadModernEventRuntime} from '../host/instance-modern-event-validator.mjs';
import {domainHash} from '../host/instance-runtime/domain-model.mjs';
import {fileURLToPath} from 'node:url';
export const {api}=loadModernEventRuntime(fileURLToPath(new URL('..',import.meta.url)));
export const h=domainHash;
export function fixture(){
 const {snapshot:data}=blankSnapshot(blankProfile({title:'Memory-only domain producer fixture',instanceId:'instance:domain-test'}));
 data.snapshotId='snapshot:domain-test';
 const f={data,reviews:[],requests:[],runs:[],candidates:[]};
 f.runtime={instanceId:'instance:domain-test',runtimeEpoch:'epoch:initial'};
 f.addFamily=(id,sha,inputs=[],versionLabel='V001')=>{
  const versionId=id+'@'+versionLabel,model=data.productionModel,path='media/_review_pending/'+id+'/'+versionLabel+'.png',definitionId='def:'+versionId,expectedOutputId='output:'+versionId;
  model.assetFamilies.push({id,label:id,kind:'IMAGE',ownerRef:'work:'+id,reviewOwner:'MATERIAL',versionRefs:[],expectedOutputRefs:[expectedOutputId],currentVersionId:null,currentExpectedOutputId:expectedOutputId,domainContext:{hash:h('domain:'+id)}});
  model.expectedOutputs.push({id:expectedOutputId,familyId:id,targetPath:path,plannedVersionLabel:versionLabel,executionDefinitionRef:definitionId,expectationState:'PLANNED',realizedVersionId:null});
  model.materialWorkItems.push({id:'work:'+id,label:id,outputAssetRef:id,inputAssetRefs:inputs.map(b=>b.familyId),additionalOutputAssetRefs:[],scopeRole:'CURRENT',activeInCurrentProduction:true,requirementRef:'requirement:'+id,executionDefinitionRef:definitionId});
  model.materialRequirements.push({id:'requirement:'+id,requirementHash:h('requirement:'+id),requirementClass:'REQUIRED',sourceKind:'LEGACY',assetFamilyRefs:[id],acceptanceCriteria:[]});
  return {familyId:id,versionId,sha256:sha,path,definitionId,expectedOutputId};
 };
 f.review=(v,seq)=>{
  const r={eventId:'review:'+v.versionId+':'+seq,eventKind:'review',schemaVersion:'2.2',eventSequence:seq,recordedAt:'2026-09-08T00:00:00.000Z',snapshotId:data.snapshotId,subjectType:'ASSET',subjectId:v.familyId,familyId:v.familyId,versionId:v.versionId,versionSha256:v.sha256,contextHash:api.assetReviewContextHash(data,v.familyId,v.versionId,v.sha256),action:'APPROVE_AND_RELEASE',reviewEventRole:'INITIAL_DECISION',projectRightsGateAtReview:'CLEAR',appliedProjectRightsGate:'CLEAR',reviewDecision:'RELEASED',lifecycleState:'RELEASED',canFlowDownstream:true,adoptionIntent:'ADOPT_THIS_VERSION',internalDownstreamEligibility:'ELIGIBLE',sourceSyncRequired:false,sourceSyncState:'NOT_REQUIRED',applicationStatus:'APPLIED',effect:'APPLIED',rightsUnknownConfirmation:null};f.reviews.push(r);return r;
 };
 f.addRoot=(id='root',reviewSequence=10)=>{
  const r=f.addFamily(id,h('bytes:'+id)),model=data.productionModel;
  model.assetVersions.push({id:r.versionId,familyId:id,label:r.versionId,path:r.path,sha256:r.sha256,byteSize:1,expectedOutputId:r.expectedOutputId,outputState:'PRESENT',projectRightsGate:'CLEAR',historyRole:'CANDIDATE',lifecycleState:'REVIEW_PENDING',canFlowDownstream:false,inputVersionBindings:[]});
  model.assetFamilies.find(x=>x.id===id).currentExpectedOutputId=null;
  (model.domainInvalidations||=[]).push({familyId:id,previousHash:h('old:'+id),currentHash:h('domain:'+id),versionIds:[r.versionId]});
  r.review=f.review(r,reviewSequence);return r;
 };
 f.produce=(id,parents,{start=11,executor='CODEX',review=true}={})=>{
  const v=f.addFamily(id,h('bytes:'+id),parents),inputBindings=parents.map((p,i)=>({order:i+1,path:p.path,assetFamilyRef:p.familyId,assetVersionRef:p.versionId,sha256:p.sha256})),callPackageHash=h({id:v.definitionId,inputBindings}),inputBindingsHash=h(inputBindings),executionRequestId='xreq_'+h(v.versionId).slice(0,32),runId='run_'+h(v.versionId).slice(0,24);
  const common={snapshotId:data.snapshotId,executionRequestId,executionDefinitionId:v.definitionId,executionDefinitionHash:callPackageHash,callPackageHash,inputBindingsHash,promptRevisionId:v.definitionId+':r1'};
  const auth={...common,eventKind:'execution-request',schemaVersion:'1.0',eventId:'authorize:'+v.versionId,eventSequence:start,action:'AUTHORIZE',requestState:'AUTHORIZED',status:'AUTHORIZED',familyId:v.familyId,workItemId:'work:'+v.familyId,authorized:true,executor,maxOutputs:1,inputBindings:structuredClone(inputBindings),authorizationRuntime:{...f.runtime}};
  f.requests.push(auth);
  let claim=null;if(executor==='CODEX'){claim={...structuredClone(auth),eventId:'claim:'+v.versionId,eventSequence:start+1,action:'CLAIM',requestState:'CLAIMED',status:'CLAIMED',claimedBy:'pure-test'};f.requests.push(claim);}
  const submitted={...common,eventKind:'run',schemaVersion:'2.0',eventId:'submitted:'+v.versionId,eventSequence:start+2,runId,runState:'SUBMITTED',state:'SUBMITTED',reconciliationEvidence:null};
  const success={...submitted,eventId:'success:'+v.versionId,eventSequence:start+3,runState:'SUCCEEDED',state:'SUCCEEDED'};f.runs.push(submitted,success);
  const candidate={...common,eventKind:'asset-version',schemaVersion:'1.1',eventId:'candidate:'+v.versionId,eventSequence:start+4,familyId:v.familyId,versionId:v.versionId,sha256:v.sha256,path:v.path,byteSize:1,expectedOutputId:v.expectedOutputId,runId,inputBindings,outputState:'PRESENT',projectRightsGate:'CLEAR',registrationState:'CANDIDATE_REGISTERED_EXPECTED_OUTPUT_REALIZED',expectationState:'REALIZED',adoptionPerformed:false};f.candidates.push(candidate);
  if(review)v.review=f.review(v,start+5);
  return {...v,auth,claim,submitted,success,candidate};
 };
 f.project=()=>api.projectOperationalState(data,f.reviews,f.candidates,f.runs,[],f.requests);
 return f;
}
