import {domainHash} from '../../host/instance-runtime/domain-model.mjs';
import {domainProductionSlice} from '../../host/instance-runtime/domain-projection.mjs';
import {domainProductionCompatibilityProofHash} from '../../host/instance-runtime/domain-production-compatibility.mjs';
export const copy=structuredClone;
export function sealCompatibility(record){record.proofHash=domainProductionCompatibilityProofHash(record);return record;}
export function makeCompatibilityFixture({scopeExtension=false,requirementOnly=false,includeChild=true}={}){
 const entity=id=>({id,type:'CHARACTER',name:id,aliases:[],description:'original narrative summary',authority:'A',evidence:[]});
 const scope={scopeType:'SCENE',scopeId:'scene:old',revisionId:'scene-revision:old'};
 const evidence={sourceId:'source:old',revisionId:'document:old',sha256:'1'.repeat(64),locator:'scene:old/block:1',quote:'original condition'};
 const state=id=>({id:'state:'+id,entityId:id,label:'unchanged appearance',dimensions:{appearance:'unchanged'},scope:[copy(scope)],authority:'A',evidence:[copy(evidence)]});
 const rep=(id,family)=>({id:'rep:'+id,entityId:id,stateId:'state:'+id,type:'PROP_STATE',label:'stable representation',dimensions:{appearance:'unchanged'},assetFamilyIds:[family],requirementIds:['requirement:'+id],authority:'A',evidence:[copy(evidence)]});
 const demand=id=>({id:'requirement:'+id,title:'fixed requirement',representationId:'rep:'+id,category:'prop',mediaType:'IMAGE',reuseScope:'SCENE',scope:[copy(scope)],acceptanceCriteria:['fixed criterion'],evidence:[copy(evidence)]});
 const beforeGraph={schemaVersion:'1.0',entities:[entity('root'),entity('child')],states:[state('root'),state('child')],representations:[rep('root','family:root'),rep('child','family:child')],requirements:[demand('root'),demand('child')],relations:[]};
 const afterGraph=copy(beforeGraph),metadataApprovals=[];
 if(scopeExtension){
  const added={scopeType:'SCENE',scopeId:'scene:new',revisionId:'scene-revision:new'},support={sourceId:'source:new',revisionId:'document:new',sha256:'2'.repeat(64),locator:'scene:new/block:1',quote:'same production condition'};
  for(const target of [afterGraph.requirements[0],...(requirementOnly?[]:[afterGraph.states[0]])]){target.scope.push(copy(added));target.evidence.push(copy(support));}
 }else{
  afterGraph.entities[0].description='corrected narrative summary';
  metadataApprovals.push({entityId:'root',beforeRecordHash:domainHash(beforeGraph.entities[0]),afterRecordHash:domainHash(afterGraph.entities[0]),confirmed:true,reason:'authorized narrative-only correction; production traits unchanged',authorizationRef:'user-approval:fixture',scope:'NARRATIVE_DESCRIPTION_ONLY'});
 }
 const slice=g=>copy(domainProductionSlice(g,['rep:root','rep:child']));
 const context=(g,id)=>{const {requirements,...body}=domainProductionSlice(g,['rep:'+id]);return domainHash(body);};
 const beforeHash=domainHash({demand:beforeGraph.requirements[0],representation:beforeGraph.representations[0]}),afterHash=domainHash({demand:afterGraph.requirements[0],representation:afterGraph.representations[0]});
 const root={id:'version:root',familyId:'family:root',sha256:'a'.repeat(64),inputVersionBindings:[],lifecycleState:'RELEASED',canFlowDownstream:true,reviewDecision:'RELEASED',flowBlockReasons:[]};
 const child={id:'version:child',familyId:'family:child',sha256:'b'.repeat(64),inputVersionBindings:[{familyId:root.familyId,versionId:root.id,sha256:root.sha256}],lifecycleState:'RELEASED',canFlowDownstream:true,reviewDecision:'RELEASED',flowBlockReasons:[]};
 const versions=new Map([root,child].map(v=>[v.id,v]));
 const invalidations=requirementOnly?[]:[{familyId:root.familyId,previousHash:context(beforeGraph,'root'),currentHash:context(afterGraph,'root'),versionIds:[root.id]}];
 const model={instanceId:'instance:fixture',domainGraph:afterGraph,domainInvalidations:invalidations,domainReferencePolicyBindings:{},domainRepresentationPolicyBindings:{},assetFamilies:[{id:root.familyId,domainContext:{hash:context(afterGraph,'root')}},{id:child.familyId,domainContext:{hash:context(afterGraph,'child')}}],assetVersions:[copy(root),copy(child)],materialRequirements:afterGraph.requirements.map((d,i)=>({id:d.id,requirementClass:'REQUIRED',requirementHash:domainHash({demand:d,representation:afterGraph.representations[i]})}))};
 const versionBinding=v=>({familyId:v.familyId,versionId:v.id,sha256:v.sha256,domainContextHash:model.assetFamilies.find(f=>f.id===v.familyId).domainContext.hash,occurrenceIndexes:[0],inputBindings:copy(v.inputVersionBindings),reviewEventId:'review:'+v.id,reviewContextHash:'c'.repeat(64),reviewEventHash:'d'.repeat(64)});
 const record=sealCompatibility({schemaVersion:'DOMAIN_PRODUCTION_COMPATIBILITY_V1',compatibilityId:'compatibility:one',instanceId:model.instanceId,runtimeEpoch:'epoch:original',beforeGraphRef:{revisionId:'graph:before',sha256:domainHash(beforeGraph)},afterGraphRef:{revisionId:'graph:after',sha256:domainHash(afterGraph)},beforeSlice:slice(beforeGraph),afterSlice:slice(afterGraph),metadataApprovals,occurrences:invalidations.map((o,index)=>({index,hash:domainHash(o),familyId:o.familyId,previousHash:o.previousHash,currentHash:o.currentHash})),requirementBindings:scopeExtension?[{requirementId:'requirement:root',beforeHash,afterHash,representationId:'rep:root',representationHash:domainHash(afterGraph.representations[0]),beforeDemand:copy(beforeGraph.requirements[0]),afterDemand:copy(afterGraph.requirements[0])}]:[],versionBindings:requirementOnly?[]:[versionBinding(root),...(includeChild?[versionBinding(child)]:[])],approval:{confirmed:true,reason:'host independently verified original bytes, contracts, and exact history'}});
 model.domainProductionCompatibilities=[record];
 const options={instanceId:model.instanceId,runtimeEpoch:'epoch:original',versions};
 const query={requirementId:'requirement:root',beforeHash,afterHash,representationId:'rep:root',representationHash:domainHash(afterGraph.representations[0]),instanceId:model.instanceId,runtimeEpoch:'epoch:original'};
 return {beforeGraph,afterGraph,record,model,versions,options,query};
}
