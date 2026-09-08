import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {blankProfile,blankSnapshot} from '../host/instance-runtime/blank.mjs';
import {createInstanceRepository} from '../host/instance-runtime/index.mjs';
import {initializeConfiguration} from '../host/instance-runtime/configuration-service.mjs';
import {domainHash} from '../host/instance-runtime/domain-model.mjs';
import {getDomainWorkspace,saveDomainWorkspace,previewDomainWorkspace,publishDomainWorkspace} from '../host/instance-runtime/domain-workspaces.mjs';

export const imageRequirementId='demand:letter-writer',audioRequirementId='demand:letter-voice';
export const imageRepresentationId='representation:letter-writer',audioRepresentationId='representation:letter-voice';
let sequence=0;
export async function changeDomain(repo,owner,changes){
 const state=await repo.readTransaction(tx=>getDomainWorkspace(tx,owner));
 const draft=await repo.writeTransaction(tx=>saveDomainWorkspace(tx,{owner,expectedReleaseId:state.releaseId,expectedDraftRevisionId:state.draftHeadRevisionId,changes}));
 const preview=await repo.readTransaction(tx=>previewDomainWorkspace(tx,{owner,draftRevisionId:draft.revisionId}));
 return repo.writeTransaction(tx=>publishDomainWorkspace(tx,{owner,draftRevisionId:draft.revisionId,previewHash:preview.previewHash,requestId:'fixture-domain-'+(++sequence)}));
}
export async function materialProductionFixture(t,{repositoryFactory}={}){
 const softwareRoot=path.resolve(import.meta.dirname,'..'),parent=path.join(softwareRoot,'tests/.test-tmp');await mkdir(parent,{recursive:true});const root=await mkdtemp(path.join(parent,'material-production-')),profile=blankProfile({title:'首次素材建档验收'}),dbPath=path.join(root,'review.sqlite'),repo=await (repositoryFactory?repositoryFactory({root,profile,dbPath}):createInstanceRepository({dbPath,instanceId:profile.instanceId,profile}));
 t.after(async()=>{await repo.close();await rm(root,{recursive:true,force:true});});
 await repo.writeTransaction(tx=>tx.publishRelease({...blankSnapshot(profile),expectedReleaseId:null,sourceRevisionIds:[]}));await repo.writeTransaction(tx=>initializeConfiguration(tx));
 const person={id:'character:letter-writer',type:'CHARACTER',name:'写信人',aliases:[],description:'青年女性，行为谨慎',authority:'A',evidence:[]};
 await changeDomain(repo,'SETTINGS',[{collection:'entities',id:person.id,beforeHash:null,value:person}]);
 const makeRepresentation=(id,type,requirementId)=>({id,entityId:person.id,stateId:null,type,label:type==='IDENTITY'?'干净人物母版':'独立声音身份',dimensions:{},assetFamilyIds:[],requirementIds:[requirementId],authority:'A',evidence:[]});
 const image=makeRepresentation(imageRepresentationId,'IDENTITY',imageRequirementId),audio=makeRepresentation(audioRepresentationId,'VOICE_IDENTITY',audioRequirementId);
 const demand=(id,representationId,mediaType,category)=>({id,title:mediaType==='IMAGE'?'写信人人物母版':'写信人声音母版',representationId,mediaType,category,reuseScope:'PROJECT',scope:[],evidence:[],acceptanceCriteria:[mediaType==='IMAGE'?'人物身份与构图可核对':'原音频中的音色和表演可核对']});
 const changes=[['representations',image],['representations',audio],['requirements',demand(imageRequirementId,imageRepresentationId,'IMAGE','identity')],['requirements',demand(audioRequirementId,audioRepresentationId,'AUDIO','voice-identity')]].map(([collection,value])=>({collection,id:value.id,beforeHash:null,value}));
 await changeDomain(repo,'MATERIAL',changes);
 // An unrelated established family, work item and immutable recipe must survive
 // native requirement provisioning unchanged, including their old protocol hash.
 await repo.writeTransaction(async tx=>{
  const view=await tx.readView(),snapshot=structuredClone(view.snapshot),recipes=structuredClone(view.recipes),model=snapshot.productionModel;
  model.materialRequirements.push({id:'legacy-demand',title:'旧道具需求',requirementClass:'REQUIRED',sourceKind:'LEGACY',mediaType:'IMAGE',assetFamilyRefs:['legacy-family'],requirementHash:domainHash('frozen-old-requirement'),acceptanceCriteria:['旧验收规格']});
  model.assetFamilies.push({id:'legacy-family',kind:'IMAGE',label:'旧道具',scopeRole:'CURRENT',reviewOwner:'MATERIAL',versionRefs:[],currentVersionId:null,expectedOutputRefs:['legacy-output'],requirementRefs:['legacy-demand'],domainContext:{hash:domainHash('legacy-v1-context'),hashSchemaVersion:'1.0',representationIds:[],entityIds:[],relationIds:[]}});
  model.expectedOutputs.push({id:'legacy-output',familyId:'legacy-family',mediaType:'IMAGE',plannedVersionLabel:'V001',targetPath:'media/_review_pending/legacy/V001.png',expectationState:'PLANNED',realizedVersionId:null});
  const work={id:'legacy-work',label:'旧道具工作项',outputAssetRef:'legacy-family',inputAssetRefs:[],scopeRole:'CURRENT',activeInCurrentProduction:true,executionDefinitionRef:'legacy-recipe',reviewSpec:{hash:domainHash('frozen-old-review'),criteria:[]}};
  model.workItems.push(work);model.materialWorkItems.push(structuredClone(work));recipes.executionDefinitions.push({id:'legacy-recipe',workItemRef:work.id,definitionHash:domainHash('frozen-old-definition'),model:{branch:'frozen-provider'},prompt:{main:'原始配方，不重写'},output:{expectedOutputRef:'legacy-output',path:'media/_review_pending/legacy/V001.png'}});
  await tx.publishRelease({snapshot,recipes,expectedReleaseId:view.releaseId,sourceRevisionIds:view.sourceRevisionIds});
 });
 return {repo,root,softwareRoot,dbPath,profile};
}

export function legacyObjects(view){const model=view.snapshot.productionModel;return{requirement:model.materialRequirements.find(r=>r.id==='legacy-demand'),family:model.assetFamilies.find(r=>r.id==='legacy-family'),output:model.expectedOutputs.find(r=>r.id==='legacy-output'),work:model.workItems.find(r=>r.id==='legacy-work'),materialWork:model.materialWorkItems.find(r=>r.id==='legacy-work'),recipe:view.recipes.executionDefinitions.find(r=>r.id==='legacy-recipe')};}
