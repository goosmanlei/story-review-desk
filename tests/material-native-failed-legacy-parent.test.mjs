import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalJson,sha256} from '../host/instance-runtime/bytes.mjs';
import {domainHash} from '../host/instance-runtime/domain-model.mjs';
import {executionDefinitionHash} from '../host/instance-runtime/execution-definition-hash.mjs';
import {failedMaterialParentBinding,assertFailedMaterialAttempt,materialEventBinding} from '../host/instance-runtime/material-production-failed-attempt.mjs';

const fail=message=>{throw Error(message);};
const clone=structuredClone;
function fixture(){
 const parentDefinition={id:'MP-CALL-parent',definitionHash:domainHash('parent-definition')},parentOutput={id:'MP-EO-parent',familyId:'MP-AF-test',targetPath:'media/_review_pending/material-production/MP-AF-test/V001.png',plannedVersionLabel:'V001'};
 const candidate={eventId:'evt-parent',eventSequence:3,familyId:parentOutput.familyId,versionId:'MP-AF-test@V001',sha256:sha256('actual PNG fixture'),executionDefinitionId:parentDefinition.id,expectedOutputId:parentOutput.id,callPackageHash:parentDefinition.definitionHash,path:parentOutput.targetPath,executionRequestId:'xreq-parent',runId:'run-parent'};
 const definition={id:'MP-CALL-second',definitionHashSchemaVersion:'SHOT_PRODUCTION_SOURCE_V1',materialProductionPlanId:'MP-PLAN-test',workItemRef:'MP-WORK-test',parentVersionId:candidate.versionId,upload:{items:[]},output:{assetFamilyRef:'MP-AF-test',expectedOutputRef:'MP-EO-second',path:'media/_review_pending/material-production/MP-AF-test/V002.png'}};
 definition.definitionHash=executionDefinitionHash(definition);
 const output={id:definition.output.expectedOutputRef,familyId:definition.output.assetFamilyRef,targetPath:definition.output.path,plannedVersionLabel:'V002',expectationState:'PLANNED',realizedVersionId:null};
 const body={schemaVersion:'MATERIAL_PRODUCTION_RECIPE_V1',id:'MP-RECIPE-second',sourcePath:'story/material-production/recipes/MP-RECIPE-second.json',materialProductionPlanId:definition.materialProductionPlanId,assetFamily:{id:output.familyId},materialWorkItem:{id:definition.workItemRef},expectedOutput:output,executionDefinition:definition,parentVersionId:candidate.versionId,parentVersionSha256:candidate.sha256,parentCandidate:candidate,previousDefinitionId:parentDefinition.id,previousExpectedOutputId:parentOutput.id,basis:{revision:{materialProductionPlanId:definition.materialProductionPlanId,familyId:output.familyId,workItemId:definition.workItemRef,definitionId:parentDefinition.id,definitionHash:parentDefinition.definitionHash,expectedOutputId:parentOutput.id,parentVersionId:candidate.versionId,parentVersionSha256:candidate.sha256,parentCandidate:materialEventBinding(candidate)}}};
 const seal=()=>{body.basisHash=domainHash(body.basis);const bytes=canonicalJson(body),sourceDocument={revisionId:'irv-second',sha256:sha256(bytes),bytes,aliases:[body.sourcePath],metadata:{sourceRole:'MATERIAL_PRODUCTION_RECIPE'}};return {definition:{...body.executionDefinition,sourceRef:body.sourcePath,sourceRevisionId:sourceDocument.revisionId,sourceSha256:sourceDocument.sha256},sourceDocument};};
 const frozen=seal(),bindings={...frozen,output,parentCandidate:candidate,parentDefinition,parentOutput,fail},request={eventId:'evt-claim',eventSequence:4,executionRequestId:'xreq-second',executionDefinitionId:definition.id,callPackageHash:definition.definitionHash,workItemId:definition.workItemRef,familyId:output.familyId,requestState:'CLAIMED',inputBindings:[],inputBindingsHash:domainHash([])},run={eventId:'evt-failed',eventSequence:5,executionRequestId:request.executionRequestId,executionDefinitionId:definition.id,callPackageHash:definition.definitionHash,runId:'run-second',runState:'FAILED',inputBindingsHash:domainHash([]),note:'Synthetic moderation rejection; no provider call or output.'};
 const proof={schemaVersion:'FAILED_OUTPUT_REMAKE_V1',definitionId:definition.id,definitionHash:definition.definitionHash,expectedOutputId:output.id,expectedOutputHash:domainHash(output),source:{path:frozen.definition.sourceRef,revisionId:frozen.sourceDocument.revisionId,sha256:frozen.sourceDocument.sha256},parentDefinitionId:parentDefinition.id,parentDefinitionHash:parentDefinition.definitionHash,parentExpectedOutputId:parentOutput.id,parentExpectedOutputHash:domainHash(parentOutput),parentSource:{path:'story/material-production/plans/parent.json',revisionId:'irv-parent',sha256:sha256('parent-source')},parentMedia:{mediaId:output.familyId,versionId:candidate.versionId,sha256:candidate.sha256,relativePath:parentOutput.targetPath,byteSize:12,registrationEventId:candidate.eventId},parentRun:{runId:candidate.runId,executionRequestId:candidate.executionRequestId,executionDefinitionId:parentDefinition.id,callPackageHash:parentDefinition.definitionHash,runState:'SUCCEEDED'},absence:{path:output.targetPath,versionId:'MP-AF-test@V002',candidates:0,registeredMedia:0,fileState:'ABSENT'},requests:[request],runs:[run],requestHeads:[materialEventBinding(request)],runHeads:[materialEventBinding(run)]};
 return {body,seal,bindings,proof};
}

test('legacy parent SHA is read only from the exact immutable recipe and does not change definition bytes or hash',()=>{
 const f=fixture(),before=canonicalJson(f);
 const binding=failedMaterialParentBinding(f.bindings.definition,f.bindings);
 assert.equal(binding.sha256,f.bindings.parentCandidate.sha256);
 assert.deepEqual(binding.sourceParentCandidate,f.bindings.parentCandidate);
 assertFailedMaterialAttempt(f.proof,f.bindings);
 assert.equal(canonicalJson(f),before);
 assert.equal(Object.hasOwn(f.bindings.definition,'parentVersionSha256'),false);
});

for(const [name,mutate] of [
 ['source missing',f=>{f.bindings.sourceDocument=null;}],
 ['source bytes changed',f=>{f.bindings.sourceDocument.bytes+=' ';}],
 ['stored SHA changed',f=>{f.bindings.sourceDocument.sha256='0'.repeat(64);}],
 ['source revision changed',f=>{f.bindings.sourceDocument.revisionId='irv-other';}],
 ['source deleted',f=>{f.bindings.sourceDocument.deleted=true;}],
 ['source role changed',f=>{f.bindings.sourceDocument.metadata.sourceRole='MATERIAL_PRODUCTION_PLAN';}],
 ['source alias missing',f=>{f.bindings.sourceDocument.aliases=[];}],
 ['definition hash changed',f=>{f.bindings.definition.definitionHash='0'.repeat(64);}],
 ['definition parent changed',f=>{f.bindings.definition.parentVersionId='MP-AF-other@V001';}],
 ['explicit empty SHA is not legacy omission',f=>{f.bindings.definition.parentVersionSha256='';}],
 ['explicit null SHA is not legacy omission',f=>{f.bindings.definition.parentVersionSha256=null;}],
 ])test('legacy recovery rejects '+name,()=>{const f=fixture();mutate(f);assert.throws(()=>failedMaterialParentBinding(f.bindings.definition,f.bindings));});

for(const [name,mutate] of [
 ['unknown source schema',b=>{b.schemaVersion='UNKNOWN';}],
 ['top-level parent SHA differs',b=>{b.parentVersionSha256='0'.repeat(64);}],
 ['revision parent SHA differs',b=>{b.basis.revision.parentVersionSha256='0'.repeat(64);}],
 ['source parent candidate differs',b=>{b.parentCandidate.sha256='0'.repeat(64);}],
 ['cross-family source parent',b=>{b.parentCandidate.familyId='other-family';}],
 ['source candidate event hash differs',b=>{b.basis.revision.parentCandidate.sha256='0'.repeat(64);}],
 ['source work differs',b=>{b.materialWorkItem.id='other-work';}],
 ['source plan differs',b=>{b.materialProductionPlanId='other-plan';}],
 ['source output differs',b=>{b.expectedOutput={...b.expectedOutput,id:'other-output'};}],
 ['nested unverified failed ancestry',b=>{b.basis.revision.failedAttempt={schemaVersion:'FAILED_OUTPUT_REMAKE_V1'};}],
 ])test('even self-hashed legacy source rejects '+name,()=>{const f=fixture();mutate(f.body);Object.assign(f.bindings,f.seal());assert.throws(()=>failedMaterialParentBinding(f.bindings.definition,f.bindings));});

for(const [name,mutate] of [
 ['actual parent SHA changed',f=>{f.bindings.parentCandidate={...f.bindings.parentCandidate,sha256:'0'.repeat(64)};}],
 ['actual parent event changed',f=>{f.bindings.parentCandidate={...f.bindings.parentCandidate,eventId:'another-event'};}],
 ['actual parent media SHA changed',f=>{f.proof.parentMedia.sha256='0'.repeat(64);}],
 ['failed source binding changed',f=>{f.proof.source.sha256='0'.repeat(64);}],
 ['unknown Run is not terminal',f=>{f.proof.runs[0].runState='RESULT_UNKNOWN';f.proof.runHeads=[materialEventBinding(f.proof.runs[0])];}],
 ['authorized unused request is not settled',f=>{f.proof.requests[0].requestState='AUTHORIZED';f.proof.requestHeads=[materialEventBinding(f.proof.requests[0])];}],
 ['output file is present',f=>{f.proof.absence.fileState='PRESENT';}],
 ['registered output exists',f=>{f.proof.absence.registeredMedia=1;}],
 ['failed parent Run',f=>{f.proof.parentRun.runState='FAILED';}],
 ])test('legacy source does not override '+name,()=>{const f=fixture();mutate(f);assert.throws(()=>assertFailedMaterialAttempt(f.proof,f.bindings));});

test('modern explicit parent SHA follows the unchanged contract without a historical fallback',()=>{
 const f=fixture(),definition={...f.bindings.definition,parentVersionSha256:f.bindings.parentCandidate.sha256};
 assert.deepEqual(failedMaterialParentBinding(definition,{fail}),{versionId:definition.parentVersionId,sha256:definition.parentVersionSha256});
 const broken={...definition,parentVersionSha256:'0'.repeat(64)};
 assert.throws(()=>assertFailedMaterialAttempt(f.proof,{...f.bindings,definition:broken}));
 assert.deepEqual(failedMaterialParentBinding({...definition,parentVersionId:null},{fail}),null);
 assert.deepEqual(clone(f.bindings.definition),f.bindings.definition);
});
