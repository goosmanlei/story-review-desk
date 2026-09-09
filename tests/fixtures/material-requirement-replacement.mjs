import {domainHash,emptyDomainGraph} from '../../host/instance-runtime/domain-model.mjs';
export const replacementFixture=()=>{
 const before=emptyDomainGraph(),scope=[{scopeType:'SCENE',scopeId:'scene-a',revisionId:'revision-a'},{scopeType:'SCENE',scopeId:'scene-b',revisionId:'revision-b'}];
 before.entities.push({id:'prop',type:'PROP',name:'中性容器',aliases:[],description:'隔离合同试验对象',authority:'A',evidence:[]});
 function append(graph,id,sc,assetFamilyIds=[]){graph.states.push({id:'state:'+id,entityId:'prop',label:id,dimensions:{storyState:id},scope:sc,authority:'A',evidence:[]});const rep={id:'rep:'+id,entityId:'prop',stateId:'state:'+id,type:'PROP_STATE',label:id,dimensions:{storyState:id},assetFamilyIds,requirementIds:[id],authority:'A',evidence:[]};graph.representations.push(rep);const r={id,title:id,representationId:rep.id,mediaType:'IMAGE',category:'prop',reuseScope:'SCENE',scope:sc,evidence:[],acceptanceCriteria:['容器身份与明确状态可辨。']};graph.requirements.push(r);return r;}
 const old=append(before,'old-broad',scope,['original-family']),after=structuredClone(before);
 append(after,'leaf-a',[scope[0]]);append(after,'leaf-b',[scope[1]]);const aggregate=append(after,'complete-new',scope);
 aggregate.composition={schemaVersion:'1.0',mode:'ALL',requiredComponents:[{id:'a',requirementId:'leaf-a'},{id:'b',requirementId:'leaf-b'}]};aggregate.replaces={requirementId:old.id,requirementHash:domainHash({demand:old,representation:before.representations[0]})};
 return {before,after,scope,append,aggregate,old};
};
