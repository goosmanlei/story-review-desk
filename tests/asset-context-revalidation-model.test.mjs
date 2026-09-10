import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalJson} from '../host/instance-runtime/bytes.mjs';
import {assetContextCurrentBasis,assetContextRuntimeHash,validateAssetContextLedger,assetContextPublicationFacts,assertAssetContextPublicationFacts} from '../host/instance-runtime/asset-context-revalidation-model.mjs';
import {preserveAssetContextRevalidations,assetContextReviewedBindings} from '../host/instance-runtime/asset-context-revalidation-preservation.mjs';
import {encodeAssetContextDocuments,decodeAssetContextDocuments,validateHostedAssetContexts} from '../host/instance-asset-context-proof.mjs';
import {assetContextPureFixture as fixture} from './fixtures/asset-context-revalidation-pure.mjs';
test('real publication facts bind source/producer/current domain and preserve old asset/recipe bytes',()=>{
 const f=fixture(),before=canonicalJson(f.baseSnapshot),rows=validateAssetContextLedger(f);assert.equal(rows.length,1);
 const next=structuredClone(f.baseSnapshot),result=preserveAssetContextRevalidations({...f,snapshot:next,baseSnapshot:f.snapshot});assert.deepEqual(result.snapshot.productionModel.assetContextRevalidationLedger,[f.ref]);assert.equal(canonicalJson(f.baseSnapshot),before);assert.strictEqual(result.recipes,f.recipes);assert.deepEqual(decodeAssetContextDocuments(encodeAssetContextDocuments(f.documents)).map(d=>d.bytes),f.documents.map(d=>d.bytes));
});
for(const [label,change] of Object.entries({
 'missing historical publication':f=>f.releaseContext=()=>null,
 'changed historical version':f=>f.baseSnapshot.productionModel.assetVersions[0].sha256='a'.repeat(64),
 'changed historical domain':f=>f.baseSnapshot.productionModel.assetFamilies[0].domainContext.hash='a'.repeat(64),
 'changed actual definition':f=>f.recipes.executionDefinitions[0].prompt='other',
 'unpinned producer':f=>f.release.sourceRevisionIds=[],
 'wrong actual producer source':f=>f.producer.bytes=Buffer.from('changed'),
 'future historical publication':f=>f.release.createdAt='2026-01-01T00:00:02Z',
 'foreign instance':f=>f.baseSnapshot.instance.instanceId='instance:other',
 'missing source':f=>f.documents.pop(),
 'missing ledger':f=>f.snapshot.productionModel.assetContextRevalidationLedger=[],
 'missing event':f=>f.events=[],
 'unknown schema':f=>f.event.schemaVersion='9',
 'unknown event kind retains marker':f=>f.event.eventKind='unknown',
 'orphan wrong-role source':f=>f.document.metadata.sourceRole='UNKNOWN',
 'forged review head':f=>f.event.previousRevalidationEventId='invented',
 'omitted prior events':f=>f.events.unshift({eventId:'old:actual',eventSequence:0,eventKind:'run'}),
 'old adoption synthesized as modern review':f=>f.events.unshift({eventId:'old:asset',eventSequence:0,eventKind:'review',subjectType:'ASSET',familyId:f.target.familyId,versionId:f.target.versionId}),
 'nonarray ledger':f=>f.snapshot.productionModel.assetContextRevalidationLedger={},
}))test(label+' is rejected by exact closure',()=>{const f=fixture();change(f);assert.throws(()=>validateAssetContextLedger(f));});
test('projection recovers only exact root with actual media; changed domain/history or rights stay held',()=>{
 const f=fixture(),rows=validateAssetContextLedger(f),model={...f.snapshot.productionModel,assetContextRevalidationEvidence:rows.map(r=>({...r,mediaCurrent:true}))},versions=new Map(model.assetVersions.map(v=>[v.id,structuredClone(v)])),options={contextHashForVersion:target=>assetContextRuntimeHash(model,target)};
 assert.equal(assetContextReviewedBindings(model,versions,options).size,1);versions.get(f.target.versionId).projectRightsGate='BLOCKED';assert.equal(assetContextReviewedBindings(model,versions,options).size,0);versions.get(f.target.versionId).projectRightsGate='CLEAR';model.domainInvalidations.push({...model.domainInvalidations[0]});assert.equal(assetContextReviewedBindings(model,versions,options).size,0);
});
test('hosted retains original envelopes but cannot restore eligibility without full history',()=>{
 const f=fixture(),model=f.snapshot.productionModel;model.assetContextRevalidationSources=encodeAssetContextDocuments(f.documents);model.assetContextRevalidationEvidence=validateAssetContextLedger(f).map(r=>({...r,mediaCurrent:false}));model.assetContextRevalidationHostedProof={schemaVersion:'ASSET_CONTEXT_HOSTED_ENVELOPES_V1',effectAvailable:false,eventManifests:[{eventId:f.event.eventId,manifest:[]}]};const bundle={events:{'asset-context-revalidation':f.events}};
 assert.equal(validateHostedAssetContexts(f.snapshot,bundle).length,1);model.assetContextRevalidationEvidence[0].mediaCurrent=true;assert.throws(()=>validateHostedAssetContexts(f.snapshot,bundle));
});
test('archive fact extraction does not retain full historical snapshots',()=>{const f=fixture(),facts=assetContextPublicationFacts(f.releaseContext());assert.equal(facts.versions.length,1);assert.equal('snapshot'in facts,false);assert.equal(assertAssetContextPublicationFacts(f.body,f.release,facts,f.documents),true);facts.versions[0].versionHash='f'.repeat(64);assert.throws(()=>assertAssetContextPublicationFacts(f.body,f.release,facts,f.documents));});
test('legacy VISUAL image kind remains eligible for exact current-domain revalidation',()=>{
 const f=fixture(),model=f.baseSnapshot.productionModel,family=model.assetFamilies.find(item=>item.id===f.target.familyId);family.kind='VISUAL';
 assert.equal(assetContextCurrentBasis(model,f.target).requirementId,model.materialRequirements[0].id);
 assert.equal(assetContextPublicationFacts({snapshot:f.baseSnapshot,recipes:f.recipes}).versions.length,1);
 model.materialRequirements[0].mediaType='VIDEO';assert.throws(()=>assetContextCurrentBasis(model,f.target));
 model.materialRequirements[0].mediaType='IMAGE';
 family.kind='AUDIO';assert.throws(()=>assetContextCurrentBasis(model,f.target));
});
