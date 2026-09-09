import test from 'node:test';
import assert from 'node:assert/strict';
import {api} from './domain-new-production-fixture.mjs';
import {assetContextPureFixture} from './fixtures/asset-context-revalidation-pure.mjs';
import {canonicalJson,sha256} from '../host/instance-runtime/bytes.mjs';
import {recordShotProductionReview} from '../host/instance-runtime/shot-production-locks.mjs';

// Actual lock readContext, historical capture, ledger validator and _store.
// Neutral in-memory read adapter: this is not an actual DB publication, media
// inspection, artistic review or permission to create a formal lock.
function fixture(){
 const f=assetContextPureFixture(),raw=f.snapshot;
 const release={...f.release,snapshotBytes:Buffer.from(canonicalJson(f.baseSnapshot)),recipesBytes:Buffer.from(canonicalJson(f.recipes))};
 const profileBytes=Buffer.from(canonicalJson(f.profile)),graphBytes=Buffer.from(canonicalJson(f.baseSnapshot.productionModel.domainGraph));
 const profile={revisionId:release.profileRevisionId,sha256:sha256(profileBytes),bytes:profileBytes};
 const graph={revisionId:f.baseSnapshot.productionModel.domainGraphRef.revisionId,sha256:sha256(graphBytes),bytes:graphBytes};
 const view={snapshot:raw,recipes:f.recipes,eventsByKind:{review:[],'asset-context-revalidation':f.events},sourceRevisionIds:f.documents.map(d=>d.revisionId)};
 const media={...f.media,availability:'PRESENT',metadata:{authorityDomain:'FORMAL',visibility:'PUBLIC'}};
 let projected=null,documentScans=0;
 const tx={readView:async()=>view,listAux:async()=>[],getAux:async(ns,_key,options)=>ns==='domain-graph'&&options?.revisionId===graph.revisionId?graph:null,getPublishedDocument:async()=>null,
  listEvents:async()=>f.events,listPublishedDocumentMetadata:async()=>{documentScans++;return f.documents;},readDocumentRevision:async id=>f.documents.find(d=>d.revisionId===id)||null,
  readRelease:async id=>id===release.releaseId?release:null,readPublishedReleaseTimeGroup:async()=>[release],readPublishedReleaseAt:async()=>release,
  getMetadata:async()=>({instanceId:f.profile.instanceId,runtimeEpoch:'epoch:test'}),getRecord:async(_ns,_key,id)=>id===profile.revisionId?profile:null,getMedia:async()=>media,resolveMedia:async()=>media};
 const projectionApi={projectOperationalState:(...args)=>{projected=api.projectOperationalState(...args);return projected;}};
 const read=()=>recordShotProductionReview(tx,{reviewEventId:'absent:review',api:projectionApi});
 return {...f,raw,release,view,tx,media,read,state:()=>projected,scans:()=>documentScans};
}

test('context-only publication loads its complete proof before the lock review adapter projects adopted input',async()=>{
 const f=fixture(),before=canonicalJson({snapshot:f.snapshot,documents:f.documents,events:f.events});
 assert.equal(Object.hasOwn(f.raw.productionModel,'materialUsageLedger'),false);
 assert.equal(Object.hasOwn(f.raw.productionModel,'materialUsageEvidence'),false);
 assert.equal(Object.hasOwn(f.raw.productionModel,'assetContextRevalidationLedger'),true);
 assert.equal(api.projectOperationalState(f.raw,[],[],[],[],[],{executionDefinitions:f.recipes.executionDefinitions}).assetVersionsById[f.target.versionId].canFlowDownstream,false);
 // No such review exists, so the real adapter must only read then return null.
 assert.equal(await f.read(),null);assert(f.scans()>0);
 assert.equal(f.state().assetVersionsById[f.target.versionId].canFlowDownstream,true);
 assert.equal(canonicalJson({snapshot:f.snapshot,documents:f.documents,events:f.events}),before);
});
for(const [name,change]of [
 ['missing original producer',f=>f.documents.splice(f.documents.findIndex(d=>d.revisionId===f.producer.revisionId),1)],
 ['changed original source bytes',f=>f.producer.bytes=Buffer.from('changed immutable producer')],
 ['missing original release',f=>f.tx.readRelease=async()=>null],
 ['missing historical publication',f=>f.tx.readPublishedReleaseAt=async()=>null],
 ['missing immutable context event',f=>f.events.length=0],
])test('context-only lock read fails closed for '+name,async()=>{
 const f=fixture();change(f);await assert.rejects(f.read());assert.equal(f.state(),null);
});
for(const [name,change]of [
 ['missing registered media',f=>f.tx.getMedia=async()=>null],
 ['blocked current rights',f=>f.snapshot.productionModel.assetVersions[0].projectRightsGate='BLOCKED'],
 ['later domain occurrence',f=>f.snapshot.productionModel.domainInvalidations.push(structuredClone(f.snapshot.productionModel.domainInvalidations[0]))],
])test('context proof cannot bypass '+name,async()=>{
 const f=fixture();change(f);assert.equal(await f.read(),null);assert.equal(f.state().assetVersionsById[f.target.versionId].canFlowDownstream,false);
});
