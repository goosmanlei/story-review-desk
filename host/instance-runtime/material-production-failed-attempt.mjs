import {canonicalJson,sha256} from './bytes.mjs';
import {domainHash} from './domain-model.mjs';
import {inspectExecutionDefinitionHash} from './execution-definition-hash.mjs';

export const FAILED_OUTPUT_REMAKE_SCHEMA='FAILED_OUTPUT_REMAKE_V1';
export const materialEventBinding=e=>e?{eventId:e.eventId,eventSequence:e.eventSequence||null,sha256:domainHash(e)}:null;
export const materialEventHeads=(rows,key)=>[...new Set(rows.map(r=>r[key]).filter(Boolean))].map(id=>[...rows.filter(r=>r[key]===id)].sort((a,b)=>(Number(b.eventSequence)||0)-(Number(a.eventSequence)||0)||String(b.recordedAt||b.createdAt||'').localeCompare(String(a.recordedAt||a.createdAt||''))||String(b.eventId||'').localeCompare(String(a.eventId||'')))[0]);
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const state=r=>String(r?.runState||r?.state||'RESULT_UNKNOWN');
const hash=/^[a-f0-9]{64}$/;

/** Old native revision sources froze the parent SHA before the definition did.
 * Read that exact historical source; never fill in or rehash the old definition.
 */
export function failedMaterialParentBinding(definition,{sourceDocument,fail}){
 const reject=()=>fail('失败调用定义缺少可验证的历史父版本 SHA 固定源');
 if(!definition.parentVersionId)return null;
 if(Object.hasOwn(definition,'parentVersionSha256')){
  if(!hash.test(definition.parentVersionSha256||''))reject();
  return {versionId:definition.parentVersionId,sha256:definition.parentVersionSha256};
 }
 const doc=sourceDocument;
 if(!doc||doc.deleted||doc.revisionId!==definition.sourceRevisionId||doc.sha256!==definition.sourceSha256||!hash.test(doc.sha256||'')||sha256(doc.bytes)!==doc.sha256||doc.metadata?.sourceRole!=='MATERIAL_PRODUCTION_RECIPE'||!doc.aliases?.includes(definition.sourceRef)||!inspectExecutionDefinitionHash(definition).valid)reject();
 let body;try{body=JSON.parse(Buffer.from(doc.bytes).toString('utf8'));}catch{reject();}
 const rb=body?.basis?.revision,candidate=body?.parentCandidate;
 if(body?.schemaVersion!=='MATERIAL_PRODUCTION_RECIPE_V1'||body.sourcePath!==definition.sourceRef||body.sourcePath!=='story/material-production/recipes/'+body.id+'.json'||body.materialProductionPlanId!==definition.materialProductionPlanId||body.assetFamily?.id!==definition.output?.assetFamilyRef||body.materialWorkItem?.id!==definition.workItemRef||body.expectedOutput?.id!==definition.output?.expectedOutputRef||body.expectedOutput?.targetPath!==definition.output?.path||!same(definition,{...body.executionDefinition,sourceRef:doc.aliases.find(a=>a===body.sourcePath),sourceRevisionId:doc.revisionId,sourceSha256:doc.sha256})||!rb||rb.failedAttempt||domainHash(body.basis)!==body.basisHash||rb.materialProductionPlanId!==body.materialProductionPlanId||rb.familyId!==body.assetFamily.id||rb.workItemId!==definition.workItemRef||rb.definitionId!==body.previousDefinitionId||rb.expectedOutputId!==body.previousExpectedOutputId||body.parentVersionId!==definition.parentVersionId||rb.parentVersionId!==body.parentVersionId||rb.parentVersionSha256!==body.parentVersionSha256||!hash.test(body.parentVersionSha256||'')||candidate?.familyId!==rb.familyId||candidate.versionId!==body.parentVersionId||candidate.sha256!==body.parentVersionSha256||candidate.executionDefinitionId!==rb.definitionId||candidate.expectedOutputId!==rb.expectedOutputId||candidate.callPackageHash!==rb.definitionHash||!candidate.eventId||!Number.isSafeInteger(candidate.eventSequence)||candidate.eventSequence<=0||!same(rb.parentCandidate,materialEventBinding(candidate)))reject();
 return {versionId:body.parentVersionId,sha256:body.parentVersionSha256,sourceParentCandidate:candidate};
}

/** Frozen failure evidence supplements, and never replaces, the actual parent. */
export function assertFailedMaterialAttempt(p,{definition,output,parentCandidate,parentDefinition,parentOutput,sourceDocument,fail}){
 const reject=()=>fail('未实现预期产物的失败记录、实际父版本或固定源闭包不完整');
 const parent=failedMaterialParentBinding(definition,{sourceDocument,fail});
 if(!p||p.schemaVersion!==FAILED_OUTPUT_REMAKE_SCHEMA||p.definitionId!==definition.id||p.definitionHash!==definition.definitionHash||p.expectedOutputId!==output.id||p.expectedOutputHash!==domainHash(output)||output.expectationState!=='PLANNED'||output.realizedVersionId!=null||!same(p.absence,{path:output.targetPath,versionId:output.familyId+'@'+output.plannedVersionLabel,candidates:0,registeredMedia:0,fileState:'ABSENT'})||parent?.versionId!==parentCandidate.versionId||parent?.sha256!==parentCandidate.sha256||p.parentDefinitionId!==parentDefinition.id||p.parentDefinitionHash!==parentDefinition.definitionHash||p.parentExpectedOutputId!==parentOutput.id||p.parentExpectedOutputHash!==domainHash(parentOutput)||parentCandidate.executionDefinitionId!==parentDefinition.id||parentCandidate.expectedOutputId!==parentOutput.id||parentCandidate.callPackageHash!==parentDefinition.definitionHash||parentCandidate.versionId!==output.familyId+'@'+parentOutput.plannedVersionLabel||parentCandidate.familyId!==output.familyId||parentCandidate.path!==parentOutput.targetPath)reject();
 if(parent.sourceParentCandidate&&(!same(parent.sourceParentCandidate,parentCandidate)||!same(p.source,{path:definition.sourceRef,revisionId:definition.sourceRevisionId,sha256:definition.sourceSha256})))reject();
 for(const s of [p.source,p.parentSource])if(!s||!s.path||!s.revisionId||!hash.test(s.sha256||''))reject();
 const m=p.parentMedia;if(!m||m.mediaId!==parentCandidate.familyId||m.versionId!==parentCandidate.versionId||m.sha256!==parentCandidate.sha256||m.relativePath!==parentOutput.targetPath||!Number.isSafeInteger(m.byteSize)||m.byteSize<=0||m.registrationEventId&&m.registrationEventId!==parentCandidate.eventId)reject();
 const actual=p.parentRun;if(!actual||state(actual)!=='SUCCEEDED'||actual.runId!==parentCandidate.runId||actual.executionRequestId!==parentCandidate.executionRequestId||actual.executionDefinitionId!==parentDefinition.id||actual.callPackageHash!==parentDefinition.definitionHash)reject();
 if(!Array.isArray(p.requests)||!p.requests.length||!Array.isArray(p.runs)||!p.runs.length||new Set([...p.requests,...p.runs].map(e=>e.eventId)).size!==p.requests.length+p.runs.length||[...p.requests,...p.runs].some(e=>!e.eventId||!Number.isSafeInteger(e.eventSequence)||e.eventSequence<=0||e.executionDefinitionId!==definition.id||e.callPackageHash!==definition.definitionHash))reject();
 const requests=materialEventHeads(p.requests,'executionRequestId'),runs=materialEventHeads(p.runs,'runId'),bindings=(definition.upload?.items||[]).map((b,index)=>({order:Number(b.order??index+1),path:String(b.path||''),assetFamilyRef:String(b.assetFamilyRef||''),assetVersionRef:String(b.assetVersionRef||''),sha256:String(b.sha256||'')}));
 for(const request of p.requests)if(request.workItemId!==definition.workItemRef||request.familyId!==output.familyId||!same(request.inputBindings||[],bindings)||request.inputBindingsHash!==domainHash(bindings))reject();
 for(const request of requests){const attempted=runs.filter(r=>r.executionRequestId===request.executionRequestId);if(!['CLAIMED','CANCELLED'].includes(request.requestState||request.status)||!attempted.length&&request.requestState!=='CANCELLED')reject();}
 for(const run of runs){if(!['FAILED','CANCELLED'].includes(state(run))||!String(run.note||'').trim()||!requests.some(q=>q.executionRequestId===run.executionRequestId))reject();}
 for(const run of p.runs){if(!run.runId||!requests.some(q=>q.executionRequestId===run.executionRequestId)||run.inputBindingsHash!==domainHash(bindings))reject();}
 if(!same(p.requestHeads,requests.map(materialEventBinding))||!same(p.runHeads,runs.map(materialEventBinding)))reject();
}
