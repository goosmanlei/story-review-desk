import {materialUsageFixture} from './material-usage-fixture.mjs';
export function materialUsageClientFixture(){const f=materialUsageFixture(),body=f.body;
 const workspace={...f.target,protocol:'MATERIAL_USAGE_V1',supported:true,readOnly:false,usageId:body.usageId,releaseId:body.baseReleaseId,basisHash:'b'.repeat(64),requirement:body.basis.requirement,sourceVersion:body.basis.source,sourceAdoption:f.adoption,reviewSpec:body.basis.requirement.reviewSpec,head:null,draftHeadRevisionId:null,draft:null,staleDraft:null,blockers:[],jobs:[]};
 const selection={protocol:workspace.protocol,supported:true,readOnly:false,requirementId:f.target.requirementId,releaseId:workspace.releaseId,requirement:workspace.requirement,reviewSpec:workspace.reviewSpec,eligibleSources:[{familyId:f.target.familyId,versionId:f.target.versionId,sha256:f.target.sha256,title:'测试空态原图',sameEntity:true,mediaToken:'m_fixture'}],blockers:[]};
 const draft={...f.target,usageId:body.usageId,revisionId:body.draftRevisionId,baseReleaseId:workspace.releaseId,basisHash:workspace.basisHash,content:body.content};
 const receipt={usage:body,previewHash:'c'.repeat(64),modelCalls:0,formalAdoptionPerformed:false,formalUsageReviewPerformed:false};
 return {...f,workspace,selection,draft,receipt};
}
