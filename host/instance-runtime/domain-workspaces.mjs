import {canonicalJson} from './bytes.mjs';
import {readingProjection} from './domain-reading.mjs';
import {domainHash,validateDomainGraph,graphImpact,defaultDomainConfiguration} from './domain-model.mjs';
import {currentGraph,evidenceBindings,verifyQuotes,validateIdentities} from './domain-service.mjs';
import {verifySourceBindings} from './domain-sources.mjs';
import {projectDomainGraph} from './domain-projection.mjs';
import {materialDirectorySource} from './material-directory.mjs';
import {refreshDirectoryProjection} from './directory-projection.mjs';
import {domainOwnership,domainCollections,domainOwners,objectKey,applyDomainChanges} from './domain-ownership.mjs';

const fail=(message,code='DOMAIN_CONFLICT')=>{throw Object.assign(new Error(message),{code});};
const read=record=>record?JSON.parse(record.bytes):null;
const save=(tx,namespace,key,value,expectedRevisionId)=>tx.putAux({namespace,key,bytes:Buffer.from(canonicalJson(value)),expectedRevisionId,mediaType:'application/json'});
const requireOwner=owner=>{if(!domainOwners.includes(owner))fail('请选择故事设定或素材维护范围','DOMAIN_INVALID');};
const configOf=view=>view.snapshot.productionModel.systemConfiguration?.config?.domain||defaultDomainConfiguration();
const requireRelease=(view,id)=>{if(id!==view.releaseId)fail('当前发布已变化；请保留修改，刷新并重新预览');};

export function workspaceProjection(snapshot,graph,owner) {
  requireOwner(owner);
  const model=snapshot.productionModel||{},configuration=model.systemConfiguration?.config?.domain||defaultDomainConfiguration();
  const ownership=domainOwnership(graph,configuration,model.domainOwnership||{});
  const requirements=(model.materialRequirements||[]).filter(r=>r.requirementClass==='REQUIRED').map(r=>({id:r.id,title:r.title,mediaType:r.mediaType,category:r.businessCategoryPrimary||r.category,scopeBindings:r.scopeBindings||[],entityRef:r.entityRef,representationRef:r.representationRef,assetFamilyRefs:r.assetFamilyRefs||[]}));
  const candidate=(model.episodePlanRevisions||[]).find(r=>r.id===model.revisionPointers?.episodePlanProposalRevisionId)||(model.episodePlanRevisions||[]).find(r=>r.isCurrentProposal);
  return {snapshotId:snapshot.snapshotId,graph,ownership,configuration,owner,requirements,...readingProjection(snapshot,graph,configuration),spatial:snapshot.creativeLineage?.spatialEvidence||null,context:{candidateRevisionId:candidate?.id||null,currentEpisodePlanRevisionId:model.revisionPointers?.currentEpisodePlanRevisionId||null},counts:Object.fromEntries(domainCollections.map(c=>[c,graph[c].filter(r=>ownership[objectKey(c,r.id)].owner===owner).length])),uncertainCount:Object.values(ownership).filter(r=>r.owner==='UNCERTAIN').length};
}

export async function getDomainWorkspace(tx,owner) {
  const view=await tx.readView(),current=await currentGraph(tx,view),record=await tx.getAux('domain-workspace-drafts',owner),draft=read(record);
  const receipt=draft&&await tx.getAux('domain-workspace-published',`${owner}:${record.revisionId}`);
  const legacy=await tx.getAux('domain-drafts','relations'),init=await tx.getAux('initialization-drafts','current');
  const suggestions=(await tx.listAux('setting-extraction-results')).map(r=>({kind:'EXTRACTION',revisionId:r.revisionId}));
  return {...workspaceProjection(view.snapshot,current.graph,owner),releaseId:view.releaseId,revisionId:current.revisionId,readOnly:false,draft:record&&!receipt?{...draft,revisionId:record.revisionId}:null,draftHeadRevisionId:record?.revisionId||null,legacyDrafts:[...suggestions,legacy&&{kind:'RELATIONS',revisionId:legacy.revisionId},!view.snapshot.productionModel.initialization&&init&&{kind:'INITIALIZATION',revisionId:init.revisionId}].filter(Boolean)};
}

async function validate(tx,view,graph) {
  const bindings=evidenceBindings(graph);
  validateDomainGraph(graph,{configuration:configOf(view),sourceBindings:bindings,knownFamilyIds:(view.snapshot.productionModel.assetFamilies||[]).map(r=>r.id),knownRequirementIds:(view.snapshot.productionModel.materialRequirements||[]).map(r=>r.id)});
  await verifySourceBindings(tx,bindings,{allowLegacy:true});await verifyQuotes(tx,graph);await validateIdentities(tx,graph,view);
  return bindings;
}

function enforceNewOwnership(previous,next,changes,owner,configuration,ownership) {
  const inferred=domainOwnership(next,configuration);
  for(const change of changes) {
    if(change.value===null||previous[change.collection].some(r=>r.id===change.id))continue;
    const expected=inferred[objectKey(change.collection,change.id)]?.owner;
    if(expected!=='UNCERTAIN'&&expected!==owner)fail('新增对象不属于本模块，请到其维护入口登记','DOMAIN_INVALID');
    if(change.collection==='entities'&&owner==='MATERIAL'&&expected==='UNCERTAIN')fail('待确认主体请在故事设定登记','DOMAIN_INVALID');
  }
  return ownership;
}

function validateChangedScopes(view,previous,changes) {
  const model=view.snapshot.productionModel;
  for(const change of changes)for(const scope of change.value?.scope||[]) {
    const old=previous[change.collection].find(r=>r.id===change.id);
    if((old?.scope||[]).some(s=>domainHash(s)===domainHash(scope)))continue;
    const known=scope.scopeType==='PROJECT'
      ||scope.scopeType==='SCENE'&&(model.sceneScriptRevisions||[]).some(r=>r.sceneId===scope.scopeId&&r.id===scope.revisionId)
      ||scope.scopeType==='EPISODE'&&(model.episodePlanRevisions||[]).some(r=>r.id===scope.revisionId&&r.episodes?.some(e=>e.episodeUid===scope.scopeId))
      ||scope.scopeType==='SHOT'&&(model.shotPlanSetRevisions||[]).some(r=>r.id===scope.revisionId&&r.shots?.some(s=>s.shotId===scope.scopeId||s.id===scope.scopeId));
    if(!known)fail('新增适用范围无法与永久身份及精确修订对应：'+scope.scopeId,'DOMAIN_INVALID');
  }
}

async function projectedSnapshot(tx,view,previous,next,changes,reference) {
  const base=structuredClone(view.snapshot);
  for(const change of changes)if(change.collection==='relations'&&change.value){const old=previous.relations.find(r=>r.id===change.id);if(old?.referencePolicyId!==change.value.referencePolicyId&&base.productionModel.domainReferencePolicyBindings)delete base.productionModel.domainReferencePolicyBindings[change.id];}
  const directorySource=await materialDirectorySource(tx,base.productionModel);
  const snapshot=projectDomainGraph(base,next.graph,reference,{eventVersions:view.eventsByKind['asset-version']||[],preserveReferencePolicies:true,directorySource:directorySource.content||base.productionModel.materialDirectory?directorySource:undefined});
  snapshot.productionModel.domainOwnership=next.ownership;return snapshot;
}

export async function saveDomainWorkspace(tx,input) {
  requireOwner(input.owner);const view=await tx.readView();requireRelease(view,input.expectedReleaseId);
  const current=await currentGraph(tx,view),ownership=domainOwnership(current.graph,configOf(view),view.snapshot.productionModel.domainOwnership||{});
  const applied=applyDomainChanges(current.graph,input.changes,input.owner,ownership);
  enforceNewOwnership(current.graph,applied.graph,input.changes,input.owner,configOf(view),applied.ownership);
  validateChangedScopes(view,current.graph,input.changes);
  await validate(tx,view,applied.graph);
  const record=await save(tx,'domain-workspace-drafts',input.owner,{schemaVersion:'1.0',owner:input.owner,baseReleaseId:view.releaseId,baseGraphRevisionId:current.revisionId,baseOwnershipHash:domainHash(ownership),changes:input.changes},input.expectedDraftRevisionId);
  return {revisionId:record.revisionId,releaseId:view.releaseId,formalAdoptionPerformed:false};
}

export async function previewDomainWorkspace(tx,{owner,draftRevisionId}) {
  requireOwner(owner);const view=await tx.readView(),record=await tx.getAux('domain-workspace-drafts',owner);
  if(!record||record.revisionId!==draftRevisionId)fail('草稿版本已变化');
  if(await tx.getAux('domain-workspace-published',`${owner}:${draftRevisionId}`))fail('这份草稿已经确认，请开始新的修订');
  const draft=read(record);requireRelease(view,draft.baseReleaseId);
  const previous=await currentGraph(tx,view),ownership=domainOwnership(previous.graph,configOf(view),view.snapshot.productionModel.domainOwnership||{});
  if(domainHash(ownership)!==draft.baseOwnershipHash)fail('维护归属已变化，请重新核对');
  const next=applyDomainChanges(previous.graph,draft.changes,owner,ownership);
  enforceNewOwnership(previous.graph,next.graph,draft.changes,owner,configOf(view),next.ownership);
  validateChangedScopes(view,previous.graph,draft.changes);
  const sourceBindings=await validate(tx,view,next.graph);
  const impact=graphImpact(previous.graph,next.graph);
  const projected=await projectedSnapshot(tx,view,previous.graph,next,draft.changes,{revisionId:'PREVIEW_ONLY',sha256:domainHash(next.graph)});
  impact.affectedFamilies=(projected.productionModel.assetFamilies||[]).filter(f=>f.domainContext?.hash!==(view.snapshot.productionModel.assetFamilies||[]).find(old=>old.id===f.id)?.domainContext?.hash).map(f=>({familyId:f.id,representationIds:f.domainContext?.representationIds||[]}));
  impact.affectedRepresentationIds=[...new Set(impact.affectedFamilies.flatMap(f=>f.representationIds))];
  impact.invalidations=(projected.productionModel.domainInvalidations||[]).slice((view.snapshot.productionModel.domainInvalidations||[]).length);
  const directory=projected.productionModel.materialDirectory;
  impact.directory=directory?{revisionId:directory.revisionId,sourceSha256:directory.sourceSha256,projectionBasis:directory.projectionBasis,graphHash:domainHash(directory.graph),bindingCount:directory.bindings.length,staleIds:directory.staleIds}:null;
  const body={owner,draftRevisionId,baseReleaseId:view.releaseId,baseOwnershipHash:draft.baseOwnershipHash,graphHash:domainHash(next.graph),sourceBindings,impact};
  return {...body,previewHash:domainHash(body),checks:['只确认本模块的修改','新增范围须匹配永久身份与精确修订；旧范围保持原证据，不冒充当前场次','其他模块草稿不会随本次确认生效','影响清单来自实际发布投影；下游只按实际版本与 SHA 依赖失效','不采用剧本、不放行素材、不授权生成'],formalAdoptionPerformed:false};
}

export async function rebaseDomainWorkspace(tx,input){
  requireOwner(input.owner);const view=await tx.readView();requireRelease(view,input.expectedReleaseId);
  const record=await tx.getAux('domain-workspace-drafts',input.owner);
  if(!record||record.revisionId!==input.draftRevisionId)fail('草稿版本已变化');
  if(await tx.getAux('domain-workspace-published',input.owner+':'+record.revisionId))fail('该草稿已经确认');
  return saveDomainWorkspace(tx,{owner:input.owner,expectedReleaseId:view.releaseId,expectedDraftRevisionId:record.revisionId,changes:read(record).changes});
}

export async function publishDomainWorkspace(tx,input) {
  const prior=await tx.getAux('domain-workspace-requests',input.requestId);
  if(prior){const receipt=read(prior);if(receipt.hash!==domainHash(input))fail('同一请求编号不能用于不同确认');return receipt.result;}
  const preview=await previewDomainWorkspace(tx,input);if(preview.previewHash!==input.previewHash)fail('预览已变化，请重新核对');
  const view=await tx.readView(),previous=await currentGraph(tx,view),draft=read(await tx.getAux('domain-workspace-drafts',input.owner));
  const ownership=domainOwnership(previous.graph,configOf(view),view.snapshot.productionModel.domainOwnership||{}),next=applyDomainChanges(previous.graph,draft.changes,input.owner,ownership);
  await validateIdentities(tx,next.graph,view,{register:true});
  const head=await tx.getAux('domain-graph','current'),record=await save(tx,'domain-graph','current',next.graph,head?.revisionId||null);
  const snapshot=await projectedSnapshot(tx,view,previous.graph,next,draft.changes,{revisionId:record.revisionId,sha256:record.sha256});
  const release=await tx.publishRelease({snapshot,recipes:view.recipes,expectedReleaseId:view.releaseId,sourceRevisionIds:view.sourceRevisionIds});
  const result={releaseId:release.releaseId,revisionId:record.revisionId,impact:preview.impact,formalAdoptionPerformed:false};
  await save(tx,'domain-workspace-published',`${input.owner}:${input.draftRevisionId}`,result,null);
  await save(tx,'domain-workspace-requests',input.requestId,{hash:domainHash(input),result},null);return result;
}

export async function confirmDomainOwnership(tx,input) {
  const prior=await tx.getAux('domain-workspace-requests',input.requestId);
  if(prior){const receipt=read(prior);if(receipt.hash!==domainHash(input))fail('同一请求编号不能用于不同归属确认');return receipt.result;}
  requireOwner(input.owner);const view=await tx.readView();requireRelease(view,input.expectedReleaseId);
  const current=await currentGraph(tx,view),row=current.graph[input.collection]?.find(r=>r.id===input.id);
  if(!row||domainHash(row)!==input.recordHash||typeof input.reason!=='string'||!input.reason.trim())fail('归属确认须绑定精确对象并说明依据','DOMAIN_INVALID');
  const ownership=domainOwnership(current.graph,configOf(view),view.snapshot.productionModel.domainOwnership||{}),key=objectKey(input.collection,input.id);
  if(ownership[key].owner!=='UNCERTAIN')fail('已有维护归属不能通过待核确认换绑');
  ownership[key]={owner:input.owner,recordHash:domainHash(row),reason:input.reason.trim()};
  const snapshot=structuredClone(view.snapshot);snapshot.productionModel.domainOwnership=ownership;
  snapshot.productionModel.materialDirectory=refreshDirectoryProjection({...snapshot.productionModel,domainGraph:current.graph},await materialDirectorySource(tx,snapshot.productionModel));
  const release=await tx.publishRelease({snapshot,recipes:view.recipes,expectedReleaseId:view.releaseId,sourceRevisionIds:view.sourceRevisionIds});
  const result={releaseId:release.releaseId,contentChanged:false,formalAdoptionPerformed:false};
  await save(tx,'domain-workspace-requests',input.requestId,{hash:domainHash(input),result},null);return result;
}

export async function transferLegacyDraft(tx,input) {
  requireOwner(input.owner);const view=await tx.readView();requireRelease(view,input.expectedReleaseId);
  const existing=await tx.getAux('domain-workspace-drafts',input.owner);
  if(existing&&!await tx.getAux('domain-workspace-published',input.owner+':'+existing.revisionId))fail('本模块已有未确认草稿，请先处理，不能用转交替换');
  const record=input.kind==='EXTRACTION'?(await tx.listAux('setting-extraction-results')).find(r=>r.revisionId===input.legacyRevisionId):await tx.getAux(input.kind==='INITIALIZATION'?'initialization-drafts':'domain-drafts',input.kind==='INITIALIZATION'?'current':'relations');
  if(!record||record.revisionId!==input.legacyRevisionId)fail('旧草稿版本已变化');
  if(!['INITIALIZATION','RELATIONS','EXTRACTION'].includes(input.kind))fail('转交来源无效','DOMAIN_INVALID');
  const value=read(record),legacy=input.kind==='INITIALIZATION'?value.content.graph:value.graph;
  const baseRelease=await tx.readRelease(value.baseReleaseId);
  if(!baseRelease)fail('旧草稿基线无法读取，不能转交');
  const base=(await currentGraph(tx,{snapshot:JSON.parse(baseRelease.snapshotBytes)})).graph;
  const current=await currentGraph(tx,view),ownership=domainOwnership(current.graph,configOf(view),view.snapshot.productionModel.domainOwnership||{}),incoming=domainOwnership(legacy,configOf(view));
  const changes=[];
  for(const collection of domainCollections)for(const row of legacy[collection]){
    const previous=current.graph[collection].find(r=>r.id===row.id),key=objectKey(collection,row.id);
    if((previous?ownership[key]:incoming[key])?.owner!==input.owner)continue;
    const original=base[collection].find(r=>r.id===row.id);
    if(original&&domainHash(original)===domainHash(row))continue;
    if(previous&&domainHash(previous)===domainHash(row))continue;
    if((original?domainHash(original):null)!==(previous?domainHash(previous):null))fail('当前对象在旧草稿之后已变化，不能转交覆盖：'+row.id);
    changes.push({collection,id:row.id,beforeHash:previous?domainHash(previous):null,value:row});
  }
  if(!changes.length)fail('旧草稿没有可转交的本域新增或修改；原稿仍保留');
  const result=await saveDomainWorkspace(tx,{...input,changes});
  await save(tx,'domain-workspace-transfers',result.revisionId,{legacyRevisionId:record.revisionId,kind:input.kind,owner:input.owner,deletionsTransferred:false},null);
  return {...result,notice:'仅转交新增和修改；删除及归属不明项仍留在原稿，需逐项核对'};
}
