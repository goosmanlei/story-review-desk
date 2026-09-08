import {canonicalJson,sha256} from '../host/instance-runtime/bytes.mjs';
import {blankProfile,blankSnapshot} from '../host/instance-runtime/blank.mjs';
import {projectDomainGraph} from '../host/instance-runtime/domain-projection.mjs';
import {emptyDomainGraph} from '../host/instance-runtime/domain-model.mjs';
import {MATERIAL_USAGE_SOURCE,MATERIAL_USAGE_SCHEMA,usageHash,materialUsageRequirementBasis,materialUsageId,materialUsageEventPayload} from '../host/instance-runtime/material-usage-model.mjs';

/** Neutral integrity fixture, not an actual production/generation receipt. */
export function materialUsageFixture(){
 const profile=blankProfile({instanceId:'instance:usage-test',title:'Neutral image usage test'}),base=blankSnapshot(profile),graph=emptyDomainGraph();
 graph.entities=[{id:'PROP-NEUTRAL',name:'同一测试道具',type:'PROP',aliases:[],description:'',authority:'A',evidence:[]}];
 graph.states=[{id:'STATE-EMPTY',entityId:'PROP-NEUTRAL',label:'明确空态',dimensions:{},scope:[],authority:'A',evidence:[]}];
 graph.representations=[{id:'REP-EMPTY',entityId:'PROP-NEUTRAL',stateId:'STATE-EMPTY',type:'PROP_STATE',label:'空态图片',dimensions:{},assetFamilyIds:[],requirementIds:[],authority:'A',evidence:[]}];
 graph.requirements=[{id:'REQ-EMPTY',title:'空态用途',representationId:'REP-EMPTY',mediaType:'IMAGE',category:'道具',scope:[],evidence:[],acceptanceCriteria:['仅当前明确空态'],reuseScope:'PROJECT'}];
 const snapshot=projectDomainGraph(base.snapshot,graph,{revisionId:'graph:test',sha256:usageHash(graph)}),model=snapshot.productionModel;
 const standard={profileId:'material-image',legacy:false,criteria:[{id:'purpose',label:'用途',question:'满足当前明确用途？',required:true,allowNA:false,noteRequiredOnFail:true},{id:'continuity',label:'连续性',question:'原件连续？',required:true,allowNA:false,noteRequiredOnFail:true}]};
 model.materialRequirements[0].reviewSpec={...standard,hash:usageHash(standard)};
 const image=Buffer.from('neutral immutable image bytes'),imageSha=sha256(image),familyId='IMAGE-TEST',versionId=familyId+'@V001',path='media/blobs/test.png';
 model.assetFamilies.push({id:familyId,label:'原已采用图片',kind:'IMAGE',ownerRef:'work:original',versionRefs:[versionId],currentVersionId:versionId,expectedOutputRefs:[],domainContext:{hash:usageHash('source-domain')}});
 model.assetVersions.push({id:versionId,familyId,path,sha256:imageSha,byteSize:image.length});
 const adoption={schemaVersion:'2.2',eventKind:'review',eventId:'review:original',eventSequence:1,recordedAt:'2026-09-08T00:00:00.000Z',idempotencyKeyHash:usageHash('original-request'),requestHash:usageHash('original-body'),subjectType:'ASSET',subjectId:familyId,familyId,versionId,versionSha256:imageSha,action:'APPROVE_AND_RELEASE',effect:'APPLIED',applicationStatus:'APPLIED',reviewDecision:'RELEASED',lifecycleState:'RELEASED',canFlowDownstream:true,projectRightsGateAtReview:'CLEAR',appliedProjectRightsGate:'CLEAR'};
 const media={mediaId:familyId,versionId,sha256:imageSha,relativePath:path,byteSize:image.length},target={requirementId:'REQ-EMPTY',familyId,versionId,sha256:imageSha};
 const requirement=materialUsageRequirementBasis(model,target.requirementId),source={familyId,versionId,sha256:imageSha,path,media,adoption:{eventId:adoption.eventId,sha256:usageHash(adoption)},projectRightsGate:'CLEAR',domainContextHash:usageHash('source-domain')};
 const basis={requirement,source,previousHead:null,instanceId:profile.instanceId,runtimeEpoch:'epoch:test'},content={purposeNote:'精确复用该图片仅满足新空态需求',authorization:{scope:'PROJECT_INTERNAL_ONLY',basis:'测试fixture中显式授权新用途审阅，不变更原图片权利'},observation:{versionId,sha256:imageSha,originalViewed:true,note:'测试观察记录；不是实际业务原图观察'},decision:{action:'APPROVE_AND_RELEASE',reviewSpecHash:requirement.reviewSpec.hash,criterionFindings:requirement.reviewSpec.criteria.map(c=>({criterionId:c.id,verdict:'PASS',note:'fixture finding'})),note:'限定新空态用途通过'}};
 const withoutId={schemaVersion:MATERIAL_USAGE_SCHEMA,usageId:materialUsageId(target.requirementId,familyId),baseReleaseId:'release:before',draftRevisionId:'draft:one',basis,content},body={...withoutId,id:'MUSE-REV-'+usageHash(withoutId).slice(0,32)};
 const sourceRef='story/material-usages/'+body.id+'.json',doc={documentId:'material-usage:'+body.id,revisionId:'source:usage:one',sha256:sha256(canonicalJson(body)),bytes:Buffer.from(canonicalJson(body)),aliases:[sourceRef],metadata:{sourceRole:MATERIAL_USAGE_SOURCE},deleted:false};
 const ref={id:body.id,usageId:body.usageId,eventId:'usage:event:one',sourceRef,sourceRevisionId:doc.revisionId,sourceSha256:doc.sha256};
 const event={...materialUsageEventPayload(body,ref),eventId:ref.eventId,eventKind:'material-usage-review',idempotencyKeyHash:usageHash('usage-key'),requestHash:usageHash('usage-input'),recordedAt:'2026-09-08T00:01:00.000Z',eventSequence:2};
 model.materialUsageLedger=[ref];
 const state={assetFamiliesById:{[familyId]:{id:familyId,kind:'IMAGE',currentVersionId:versionId,canFlowDownstream:true}},assetVersionsById:{[versionId]:{id:versionId,familyId,path,sha256:imageSha,lifecycleState:'RELEASED',projectRightsGate:'CLEAR',canFlowDownstream:true,reviewCorrection:{headEventId:adoption.eventId}}}};
 return {profile,snapshot,recipes:base.recipes,graph,model,image,target,media,adoption,body,ref,event,documents:[doc],events:[adoption,event],state};
}
