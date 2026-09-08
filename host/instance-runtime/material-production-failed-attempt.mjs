import {canonicalJson} from './bytes.mjs';
import {domainHash} from './domain-model.mjs';

export const FAILED_OUTPUT_REMAKE_SCHEMA='FAILED_OUTPUT_REMAKE_V1';
export const materialEventBinding=e=>e?{eventId:e.eventId,eventSequence:e.eventSequence||null,sha256:domainHash(e)}:null;
export const materialEventHeads=(rows,key)=>[...new Set(rows.map(r=>r[key]).filter(Boolean))].map(id=>[...rows.filter(r=>r[key]===id)].sort((a,b)=>(Number(b.eventSequence)||0)-(Number(a.eventSequence)||0)||String(b.recordedAt||b.createdAt||'').localeCompare(String(a.recordedAt||a.createdAt||''))||String(b.eventId||'').localeCompare(String(a.eventId||'')))[0]);
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const state=r=>String(r?.runState||r?.state||'RESULT_UNKNOWN');
const hash=/^[a-f0-9]{64}$/;

/** Frozen failure evidence supplements, and never replaces, the actual parent. */
export function assertFailedMaterialAttempt(p,{definition,output,parentCandidate,parentDefinition,parentOutput,fail}){
 const reject=()=>fail('未实现预期产物的失败记录、实际父版本或固定源闭包不完整');
 if(!p||p.schemaVersion!==FAILED_OUTPUT_REMAKE_SCHEMA||p.definitionId!==definition.id||p.definitionHash!==definition.definitionHash||p.expectedOutputId!==output.id||p.expectedOutputHash!==domainHash(output)||output.expectationState!=='PLANNED'||output.realizedVersionId!=null||!same(p.absence,{path:output.targetPath,versionId:output.familyId+'@'+output.plannedVersionLabel,candidates:0,registeredMedia:0,fileState:'ABSENT'})||definition.parentVersionId!==parentCandidate.versionId||definition.parentVersionSha256!==parentCandidate.sha256||p.parentDefinitionId!==parentDefinition.id||p.parentDefinitionHash!==parentDefinition.definitionHash||p.parentExpectedOutputId!==parentOutput.id||p.parentExpectedOutputHash!==domainHash(parentOutput)||parentCandidate.executionDefinitionId!==parentDefinition.id||parentCandidate.expectedOutputId!==parentOutput.id||parentCandidate.callPackageHash!==parentDefinition.definitionHash||parentCandidate.versionId!==output.familyId+'@'+parentOutput.plannedVersionLabel||parentCandidate.familyId!==output.familyId||parentCandidate.path!==parentOutput.targetPath)reject();
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
