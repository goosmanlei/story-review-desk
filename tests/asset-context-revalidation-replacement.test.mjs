import test from 'node:test';
import assert from 'node:assert/strict';
import {domainHash} from '../host/instance-runtime/domain-model.mjs';
import {projectDomainGraph} from '../host/instance-runtime/domain-projection.mjs';
import {inspectMaterialRequirementReplacementExecution as inspect} from '../host/instance-runtime/material-requirement-replacement-execution.mjs';
import {assertAssetContextSource,contextHash} from '../host/instance-runtime/asset-context-revalidation-model.mjs';
import {replacementFixture} from './fixtures/material-requirement-replacement.mjs';
import {assetContextPureFixture} from './fixtures/asset-context-revalidation-pure.mjs';

function fixture({requirementId='old-broad',status='QUEUED'}={}){
 const f=replacementFixture(),snapshot=projectDomainGraph({productionModel:{assetFamilies:[],materialRequirements:[]}},f.before,{revisionId:'graph-r1',sha256:domainHash(f.before)}),body=structuredClone(assetContextPureFixture().body);
 body.basis.current.requirementId=requirementId;delete body.id;body.id='ACTX-REV-'+contextHash(body).slice(0,32);assertAssetContextSource(body);
 const job={jobId:'context:job',revalidationId:body.revalidationId,requirementId,status,instanceId:body.basis.instanceId,runtimeEpoch:body.basis.runtimeEpoch,input:{familyId:body.basis.source.familyId,versionId:body.basis.source.versionId,sha256:body.basis.source.sha256,previewHash:contextHash(body)},preview:{revalidation:body,previewHash:contextHash(body)}};
 const tx={readView:async()=>({snapshot,recipes:{executionDefinitions:[]}}),getMetadata:async()=>({instanceId:body.basis.instanceId,runtimeEpoch:body.basis.runtimeEpoch}),listEvents:async()=>[],listAux:async namespace=>namespace==='asset-context-revalidation-jobs'?[{key:job.jobId,revisionId:'aux:1',bytes:Buffer.from(JSON.stringify(job))}]:[]};
 return {job,run:()=>inspect(tx,{nextGraph:f.after})};
}
for(const status of ['QUEUED','RUNNING','RESULT_UNKNOWN'])test('context '+status+' fences its exact replaced requirement',async()=>{const f=fixture({status}),result=await f.run();assert.deepEqual(result.hostJobs.map(j=>j.jobId),['context:job']);assert(result.reasons.some(r=>r.startsWith('REPLACEMENT_HOST_JOB_PENDING')));assert(!result.reasons.some(r=>r.includes('UNKNOWN')),JSON.stringify(result));});
test('valid context on an unrelated requirement does not impose a global replacement gate',async()=>{const f=fixture({requirementId:'unrelated-leaf'});assert.deepEqual((await f.run()).reasons,[]);});
for(const status of ['SUCCEEDED','FAILED','CANCELLED'])test('terminal context '+status+' preserves history without blocking replacement',async()=>{const f=fixture({status});assert.deepEqual((await f.run()).reasons,[]);});
for(const [name,mutate]of [['missing frozen source',j=>delete j.preview.revalidation],['misdeclared requirement',j=>j.requirementId='unrelated-leaf'],['tampered source',j=>j.preview.revalidation.basis.current.requirementId='unrelated-leaf'],['wrong preview',j=>j.input.previewHash='0'.repeat(64)],['wrong instance',j=>j.instanceId='another-instance'],['wrong version',j=>j.input.versionId='other@V001']])test('context '+name+' cannot evade the replacement fence',async()=>{const f=fixture();mutate(f.job);assert((await f.run()).reasons.some(r=>r.startsWith('REPLACEMENT_HOST_JOB_SCOPE_UNKNOWN')));});
