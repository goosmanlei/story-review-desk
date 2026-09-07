import {canonicalJson,sha256} from './bytes.mjs';
import {currentGraph} from './domain-service.mjs';
import {domainHash} from './domain-model.mjs';
import {directoryProjection,refreshDirectoryProjection} from './directory-projection.mjs';
import {domainOwnership,objectKey} from './domain-ownership.mjs';
const read=r=>r?JSON.parse(Buffer.from(r.bytes).toString('utf8')):null;
const fail=(message)=>{throw Object.assign(new Error(message),{code:'DOMAIN_CONFLICT'});};
export {directoryProjection} from './directory-projection.mjs';

export async function materialDirectorySource(tx,model){
 const record=await tx.getAux('material-directory','current');
 if(!record){if(model.materialDirectory?.revisionId)fail('已发布目录缺少原始定义，不能沿用陈旧投影');return {content:null,revisionId:null,sha256:null};}
 if(sha256(record.bytes)!==record.sha256)fail('素材目录原始定义SHA不一致');
 return {content:read(record),revisionId:record.revisionId,sha256:record.sha256};
}
export async function readMaterialDirectory(tx){const view=await tx.readView(),current=await currentGraph(tx,view),model={...view.snapshot.productionModel,domainGraph:current.graph},source=await materialDirectorySource(tx,model);return {...refreshDirectoryProjection(model,source),releaseId:view.releaseId};}
export async function applyMaterialDirectory(tx,input){
 const requestHash=sha256(canonicalJson(input)),prior=read(await tx.getAux('material-directory-requests',input.requestId));if(prior){if(prior.requestHash!==requestHash)fail('目录请求身份冲突');return prior.result;}
 const view=await tx.readView(),head=await tx.getAux('material-directory','current'),current=await currentGraph(tx,view),content=input.content;
 if(input.expectedReleaseId!==view.releaseId||input.expectedRevisionId!==(head?.revisionId||null)||content.baseReleaseId!==view.releaseId)fail('目录迁移基线已变化');
 if(content.graphRef?.revisionId!==current.revisionId||content.graphRef?.sha256!==domainHash(current.graph))fail('实体关系基线已变化');
 for(const b of content.sourceBindings||[]){const doc=await tx.getPublishedDocument(b.alias);if(!doc||doc.revisionId!==b.revisionId||doc.sha256!==b.sha256)fail('目录来源已变化：'+b.alias);}
 const required=(view.snapshot.productionModel.materialRequirements||[]).filter(r=>r.requirementClass==='REQUIRED'),projected=directoryProjection({...view.snapshot.productionModel,domainGraph:current.graph},content);
 if(projected.staleIds.length||projected.bindings.length!==required.length||new Set(projected.bindings.map(b=>b.requirementId)).size!==required.length)fail('目录必须精确覆盖全部当前素材需求');
 for(const b of projected.bindings)if(!projected.graph.entities.some(e=>e.id===b.entityId)||!projected.graph.states.some(s=>s.id===b.stateId&&s.entityId===b.entityId))fail('实体状态归属不完整：'+b.requirementId);
 const record=await tx.putAux({namespace:'material-directory',key:'current',bytes:canonicalJson(content),expectedRevisionId:head?.revisionId||null,mediaType:'application/json'});
 const snapshot=structuredClone(view.snapshot),ownership=domainOwnership(current.graph,snapshot.productionModel.systemConfiguration?.config?.domain,snapshot.productionModel.domainOwnership||{});
 for(const s of current.graph.states)ownership[objectKey('states',s.id)]={owner:'MATERIAL',recordHash:domainHash(s),reason:'实体状态与连续性按用户确认迁移至素材管理；仅调整维护入口，不改变业务内容或生成输入'};
 snapshot.productionModel.domainOwnership=ownership;snapshot.productionModel.materialDirectory=refreshDirectoryProjection({...snapshot.productionModel,domainGraph:current.graph},{content,revisionId:record.revisionId,sha256:record.sha256});
 snapshot.productionModel.productionReset={schemaVersion:'1.0',reason:'ENTITY_STATE_WORKFLOW_REDESIGN',previousSnapshotId:view.snapshot.snapshotId,formalAdoptionPerformed:false,legacyOutputsRole:'EVIDENCE_ONLY'};
 const release=await tx.publishRelease({snapshot,recipes:view.recipes,sourceRevisionIds:view.sourceRevisionIds,expectedReleaseId:view.releaseId});
 const result={releaseId:release.releaseId,revisionId:record.revisionId,requirementCount:projected.bindings.length,trialCount:projected.trials.length,formalReviewMutation:false,mediaMutation:false};
 await tx.putAux({namespace:'material-directory-requests',key:input.requestId,bytes:canonicalJson({requestHash,result}),expectedRevisionId:null});return result;
}
export async function stageDirectoryDefinition(tx,input){
 const view=await tx.readView(),directory=await readMaterialDirectory(tx);if(input.expectedReleaseId!==view.releaseId||input.expectedRevisionId!==directory.revisionId)fail('目录依据已变化');
 const state=directory.graph.states.find(s=>s.id===input.stateId),current=await currentGraph(tx,view);if(!state)fail('状态不在当前目录');
 const entity=directory.graph.entities.find(e=>e.id===state.entityId);if(!entity)fail('实体归属待核');
 const hasEntity=current.graph.entities.some(e=>e.id===entity.id),owner=hasEntity?'MATERIAL':'SETTINGS';
 const {getDomainWorkspace,saveDomainWorkspace}=await import('./domain-workspaces.mjs');const workspace=await getDomainWorkspace(tx,owner);if(workspace.draft)fail('本模块已有草稿，请先处理，目录转交不会覆盖它');
 const changes=[];
 if(!hasEntity)changes.push({collection:'entities',id:entity.id,beforeHash:null,value:{id:entity.id,type:entity.type,name:entity.name,aliases:entity.aliases||[],description:entity.description||'',authority:entity.authority,evidence:entity.evidence}});
 else{
 if(!current.graph.states.some(s=>s.id===state.id))changes.push({collection:'states',id:state.id,beforeHash:null,value:{id:state.id,entityId:state.entityId,label:state.label,dimensions:state.dimensions||{},scope:state.scope||[],authority:state.authority,evidence:state.evidence}});
 for(const b of directory.bindings.filter(b=>b.stateId===state.id)){const r=current.graph.representations.find(r=>r.id===b.representationId);if(r&&(r.entityId!==b.entityId||r.stateId!==b.stateId))changes.push({collection:'representations',id:r.id,beforeHash:domainHash(r),value:{...r,entityId:b.entityId,stateId:b.stateId}});}
 }
 if(!changes.length)return {owner,focus:{collection:'states',id:state.id},alreadyDefined:true};
 const result=await saveDomainWorkspace(tx,{owner,expectedReleaseId:view.releaseId,expectedDraftRevisionId:workspace.draftHeadRevisionId,changes});return {...result,owner,focus:{collection:hasEntity?'states':'entities',id:hasEntity?state.id:entity.id},notice:'已转为所属模块草稿；须预览输入影响并单独确认，现有生成资料与审阅未改变'};
}
