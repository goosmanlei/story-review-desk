import {canonicalJson,sha256} from './bytes.mjs';
import {domainHash} from './domain-model.mjs';
import {executionDefinitionHash} from './execution-definition-hash.mjs';
import {materialProductionRebaseIdentity} from './material-production-rebase-identity.mjs';
import {materialProductionRevisionContext,compileMaterialProductionRevision} from './material-production-revision.mjs';
import {materialProductionPlanGraphClosure,materialProductionLegacyRevisionClosures} from './material-production-preservation.mjs';
import {materialProductionRebaseClosures} from './material-production-rebase-preservation.mjs';

export const MATERIAL_REBASE_MODE='REQUIREMENT_REBASE';
export const MATERIAL_REBASE_SCHEMA='MATERIAL_PRODUCTION_REQUIREMENT_REBASE_V1';
export const MATERIAL_REBASE_SOURCE='MATERIAL_PRODUCTION_REQUIREMENT_REBASE';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const fail=message=>{throw Object.assign(Error(message),{code:'DOMAIN_CONFLICT'});};
const check=(ok,message)=>{if(!ok)fail(message);};
const one=(rows,predicate,label)=>{const found=(rows||[]).filter(predicate);check(found.length===1,label+'必须唯一');return found[0];};
const four=body=>({demand:body.basis.demand,representation:body.graphBinding?.afterRepresentation||body.basis.representation,entity:body.basis.entity,state:body.basis.state});

/** The original plan is never edited. Only a separately verified rebase source
 * may establish another effective requirement baseline for later revisions. */
export async function readMaterialProductionRebaseAnchor(tx,{model,recipes,plan}){
 const rows=(model.materialProductionRecipeRevisions||[]).filter(r=>r.materialProductionPlanId===plan.id),work=(model.materialWorkItems||[]).find(w=>w.id===plan.workItemId);
 if(!rows.some(r=>r.schemaVersion===MATERIAL_REBASE_SCHEMA||Object.hasOwn(r,'rebaseId'))&&!Object.hasOwn(work||{},'materialProductionRequirementRebaseId'))return null;
 const ids=[plan,...rows].flatMap(r=>[r.sourceRevisionId,...Object.values(r.domainSources||{}).map(s=>s.revisionId)]),documents=await Promise.all([...new Set(ids)].map(id=>tx.readDocumentRevision(id))),initial=materialProductionPlanGraphClosure({plan,document:documents.find(d=>d?.revisionId===plan.sourceRevisionId)});
 const proof=materialProductionRebaseClosures({model:{...model,materialProductionPlans:[plan],materialProductionRecipeRevisions:rows},recipes,documents,initialClosures:[{plan,...initial}],validateLegacySegment:materialProductionLegacyRevisionClosures});
 const id=work?.materialProductionRequirementRebaseId,closure=one(proof.revisions,r=>r.row.id===id&&r.body.schemaVersion===MATERIAL_REBASE_SCHEMA,'当前需求基线修订');
 return {id,body:closure.body,row:closure.row,requirementHash:closure.row.requirementHash,requirementAfter:closure.body.requirementAfter,authority:closure.body.rebase.after,source:{sourcePath:closure.row.sourcePath,sourceRevisionId:closure.row.sourceRevisionId,sourceSha256:closure.row.sourceSha256,requirementHash:closure.row.requirementHash}};
}
export async function materialProductionRebaseContext(tx,c){
 const plan=one(c.model.materialProductionPlans,p=>p.requirementId===c.requirement.id,'原生素材初始计划');
 const family=one(c.model.assetFamilies,f=>f.id===plan.familyId,'原生素材族'),work=one(c.model.materialWorkItems,w=>w.id===plan.workItemId,'原生素材工作项');
 const initial=materialProductionPlanGraphClosure({plan,document:await tx.readDocumentRevision(plan.sourceRevisionId)}),anchor=await readMaterialProductionRebaseAnchor(tx,{model:c.model,recipes:c.view.recipes,plan});
 const before=anchor?.authority||four(initial.body),after={demand:c.demand,representation:c.representation,entity:c.graph.entities.find(e=>e.id===c.representation.entityId)||null,state:c.representation.stateId?c.graph.states.find(s=>s.id===c.representation.stateId)||null:null},diff=materialProductionRebaseIdentity({before,after});
 check(family.id===c.representation.assetFamilyIds[0]&&family.ownerRef===work.id&&family.reviewOwner==='MATERIAL'&&family.materialProductionPlanId===plan.id&&work.materialProductionPlanId===plan.id&&work.requirementRef===c.requirement.id&&work.outputAssetRef===family.id,'需求基线修订不能改变素材族或制作所有者');
 const priorRequirement=anchor?.requirementAfter||initial.body.requirementAfter;
 check(same(priorRequirement.configurationBinding,c.requirement.configurationBinding)&&same(priorRequirement.reviewSpec,c.requirement.reviewSpec),'需求基线修订不能改写原冻结配置或审阅标准');
 const oldContext={...c,demand:before.demand,representation:before.representation,requirement:priorRequirement,graph:{...c.graph,entities:c.graph.entities.map(e=>e.id===before.entity.id?before.entity:e),states:c.graph.states.map(s=>s.id===before.state?.id?before.state:s)}};
 const revision=await materialProductionRevisionContext(tx,oldContext);
 check(revision&&revision.plan.id===plan.id&&revision.family.id===family.id&&revision.work.id===work.id,'原制作闭包无法精确核实');
 if(revision.parent){check(typeof c.api?.safeGeneratedPath==='function','需求基线修订缺少父版本实际原件核查器');await c.api.safeGeneratedPath(revision.parent.path,{versionId:revision.parent.versionId,sha256:revision.parent.sha256});}
 const previousBaseline=anchor?.source||{sourcePath:plan.sourcePath,sourceRevisionId:plan.sourceRevisionId,sourceSha256:plan.sourceSha256,requirementHash:plan.requirementHash};
 return {...revision,previousGraphInstanceId:anchor?.body.basis.revision.instanceId||initial.body.workContext.scopeId,previousGraphRef:anchor?.body.rebase.graphRef||{revisionId:plan.graphRevisionId,sha256:plan.graphSha256},rebase:{...diff,before,after,previousBaseline},defaults:{...revision.definition.authoringContent,inputBindings:(revision.definition.upload?.items||[]).map(b=>({familyId:b.assetFamilyRef,versionId:b.assetVersionRef,sha256:b.sha256}))}};
}
export function validateRebaseAcknowledgement(value,c){
 check(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')==='afterHash,beforeHash,confirmed,note'&&value.confirmed===true&&value.beforeHash===c.revision.rebase.beforeHash&&value.afterHash===c.revision.rebase.afterHash&&typeof value.note==='string'&&value.note.trim().length>0&&value.note.length<=20000,'须明确确认当前新旧需求差异并说明采用新制作基线的原因');
 return structuredClone(value);
}
export async function compileMaterialProductionRebase(tx,c,content,draftRevisionId,registeredInput,acknowledgement){
 const compiled=await compileMaterialProductionRevision(tx,c,content,draftRevisionId,registeredInput),body=compiled.plan,oldId=body.id,id=oldId.replace('MP-RECIPE-','MP-REBASE-'),sourcePath='story/material-production/requirement-rebases/'+id+'.json',r=c.revision;
 check(id!==oldId,'需求基线修订身份无效');delete body.rebaseId;
 const graph=await tx.getAux('domain-graph','current');check(graph&&!graph.deleted&&graph.revisionId===c.basis.graphRef.revisionId&&graph.sha256===c.basis.graphRef.sha256&&sha256(graph.bytes)===graph.sha256,'新需求必须绑定当前实际已发布领域源');
 const requirementAfter={...structuredClone(c.requirement),materialWorkItemRef:r.work.id,plannedAssetFamilyId:r.family.id};
 const workContext={id:'MP-CTX-'+domainHash({rebaseId:id}).slice(0,24),schemaVersion:'2.0',scopeType:'PROJECT',scopeId:c.view.profile.instanceId,semanticStatus:'AUTHORED_DRAFT',reviewable:true,requirementId:c.requirement.id,requirementHash:c.requirement.requirementHash,representationId:c.representation.id,sourceRefs:[sourcePath],binding:{requirementId:c.requirement.id,requirementHash:c.requirement.requirementHash,domainContextHash:r.family.domainContext.hash,bindingStatus:'CURRENT',mismatchReasons:[]},judgment:{purpose:{class:'A',text:c.requirement.title,evidenceRefs:[sourcePath]},acceptanceCriteria:c.requirement.acceptanceCriteria||[]},materialProductionRequirementRebaseId:id};workContext.contextHash=domainHash(workContext);
 const materialWorkItem={...body.materialWorkItem,requirementHash:c.requirement.requirementHash,reviewContextRef:workContext.id,materialProductionRequirementRebaseId:id};
 const executionDefinition={...body.executionDefinition,materialRequirementHash:c.requirement.requirementHash,materialProductionRequirementRebaseId:id};executionDefinition.definitionHash=executionDefinitionHash(executionDefinition);
 const promptRevision={...body.promptRevision,definitionHash:executionDefinition.definitionHash};
 const domainSources={},domainEvidenceDocuments=[],meta=await tx.getMetadata();check(Number.isSafeInteger(meta.eventSequence)&&meta.eventSequence>=0,'需求基线修订缺少实际事件存储水位');
 for(const [name,ref]of Object.entries({before:r.previousGraphRef,after:c.basis.graphRef})){
  const record=await tx.getAux('domain-graph','current',{revisionId:ref.revisionId});check(record&&!record.deleted&&record.revisionId===ref.revisionId&&record.sha256===ref.sha256&&sha256(record.bytes)===ref.sha256,'需求基线缺少实际原领域图修订');
  const path='story/material-production/domain-bases/'+ref.revisionId+'.json';domainSources[name]={path,sha256:record.sha256,graphRevisionId:record.revisionId,graphSha256:record.sha256};domainEvidenceDocuments.push({path,bytes:record.bytes,sha256:record.sha256,graphRevisionId:record.revisionId,metadata:{sourceRole:'MATERIAL_PRODUCTION_DOMAIN_BASIS',graphRevisionId:record.revisionId,graphSha256:record.sha256,instanceId:name==='before'?r.previousGraphInstanceId:meta.instanceId}});
 }
 const rebase={...r.rebase,graphRef:c.basis.graphRef,domainSources,acknowledgement:validateRebaseAcknowledgement(acknowledgement,c)};
 return {domainEvidenceDocuments,plan:{...body,id,operationEventSequence:meta.eventSequence,schemaVersion:MATERIAL_REBASE_SCHEMA,mode:MATERIAL_REBASE_MODE,sourcePath,rebase,requirementBefore:r.requirement,requirementAfter,workContext,materialWorkItem,expectedOutput:{...body.expectedOutput,sourceRef:sourcePath},executionDefinition,promptRevision}};
}
