import {canonicalJson,sha256} from '../../host/instance-runtime/bytes.mjs';
import {usageHash,materialUsageId,materialUsageRequirementBasis,materialUsageEventPayload,MATERIAL_USAGE_SCHEMA,MATERIAL_USAGE_SOURCE} from '../../host/instance-runtime/material-usage-model.mjs';

export function materialUsageCompatibilityFixture(){
  const instanceId='instance:usage-compatibility',profile={instanceId,projectId:'project:usage',episodePlanId:'plan:usage',title:'中性用途兼容测试'};
  const representation={id:'representation:empty-box',entityId:'entity:box',stateId:null,type:'PROP_STATE',assetFamilyIds:[],requirementIds:['requirement:empty-box']};
  const demand={id:'requirement:empty-box',representationId:representation.id,title:'空木箱',mediaType:'IMAGE',scope:[],acceptanceCriteria:['完整空木箱，无内容物。']};
  const reviewSpecBody={profileId:'fixture:prop',criteria:[{id:'material-01',label:'空箱形态',required:true,allowNA:false,noteRequiredOnFail:true}]},reviewSpec={...reviewSpecBody,hash:usageHash(reviewSpecBody)};
  const model={domainGraph:{entities:[{id:'entity:box',type:'PROP',name:'木箱'}],states:[],relations:[],representations:[representation],requirements:[demand]},materialRequirements:[{id:demand.id,requirementClass:'REQUIRED',sourceKind:'DOMAIN_GRAPH',representationRef:representation.id,requirementHash:usageHash({demand,representation}),assetFamilyRefs:[],reviewSpec}],assetFamilies:[],assetVersions:[],materialWorkItems:[],workItems:[],expectedOutputs:[]};
  const source={familyId:'family:box',versionId:'family:box@V001',sha256:usageHash('fixture-original-image'),path:'media/box.png',media:{mediaId:'family:box',versionId:'family:box@V001',sha256:usageHash('fixture-original-image'),relativePath:'media/box.png',byteSize:123},adoption:null,projectRightsGate:'CLEAR_BY_USER_ATTESTATION',domainContextHash:null};
  const adoption={eventId:'event:asset-adoption',eventKind:'review',eventSequence:1,schemaVersion:'2.2',snapshotId:'snapshot:base',recordedAt:'2026-01-01T00:00:01Z',idempotencyKeyHash:usageHash('adoption-key'),requestHash:usageHash('adoption-request'),subjectType:'ASSET',familyId:source.familyId,versionId:source.versionId,versionSha256:source.sha256,action:'APPROVE_AND_RELEASE',effect:'APPLIED',applicationStatus:'APPLIED'};
  source.adoption={eventId:adoption.eventId,sha256:usageHash(adoption)};
  const basis={requirement:materialUsageRequirementBasis(model,demand.id),source,previousHead:null,instanceId,runtimeEpoch:'epoch:fixture'};
  const content={purposeNote:'复用原空木箱图用于新的精确空箱需求。',authorization:{scope:'PROJECT_INTERNAL_ONLY',basis:'中性测试授权声明；非真实业务。'},observation:{versionId:source.versionId,sha256:source.sha256,originalViewed:true,note:'合成测试观察声明，未声称观察真实原图。'},decision:{action:'APPROVE_AND_RELEASE',reviewSpecHash:reviewSpec.hash,criterionFindings:[{criterionId:'material-01',verdict:'PASS',note:'中性测试判断。'}],note:'合成测试用途判断。'}};
  const body={schemaVersion:MATERIAL_USAGE_SCHEMA,usageId:materialUsageId(demand.id,source.familyId),baseReleaseId:'release:base',draftRevisionId:'draft:usage',basis,content};body.id='MUSE-REV-'+usageHash(body).slice(0,32);
  // Deliberately noncanonical source whitespace proves exact source transport.
  const bytes=Buffer.from('  '+JSON.stringify(body,null,2)+'\r\n'),document={documentId:'document:usage',revisionId:'revision:usage',sha256:sha256(bytes),bytes,metadata:{sourceRole:MATERIAL_USAGE_SOURCE},deleted:false,aliases:['story/material-usages/'+body.id+'.json']};
  const ref={id:body.id,usageId:body.usageId,eventId:'event:usage',sourceRef:document.aliases[0],sourceRevisionId:document.revisionId,sourceSha256:document.sha256};
  const event={...materialUsageEventPayload(body,ref),eventId:ref.eventId,eventKind:'material-usage-review',eventSequence:2,recordedAt:'2026-01-01T00:00:02Z',requestHash:usageHash('usage-request'),idempotencyKeyHash:usageHash('usage-key')};
  const snapshot={snapshotId:'snapshot:usage',instance:profile,productionModel:{...model,materialUsageLedger:[ref]}};
  const recipes={snapshotId:snapshot.snapshotId,executionDefinitions:[]},baseRelease={releaseId:'release:usage',snapshotBytes:Buffer.from(canonicalJson(snapshot)),recipesBytes:Buffer.from(canonicalJson(recipes))};
  return {instanceId,profile,model,body,document,documents:[document],ref,event,adoption,events:[adoption,event],snapshot,recipes,baseRelease};
}
