import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {canonicalJson,sha256} from '../host/instance-runtime/bytes.mjs';
import {nativeMaterialCandidateProof,assertNativeCandidatePreservation} from '../host/instance-native-candidate-proof.mjs';
import {failedRemakeApiCase} from './fixtures/material-native-failed-remake.mjs';

test('native proof retains actual ancestor and successor across a failed slot, base version and input evidence',
 {skip:process.env.REVIEW_TEST_POSTGRES!=='1',timeout:180000},t=>failedRemakeApiCase(t,{referenceInput:true,verifyNativeProof:async({f,end,state,documents,preserved,v1,v3,missingVersionId,referenceInput})=>{
 const events=Object.values(end.eventsByKind).flat(),pinnedMediaHashes={};
 for(const event of end.eventsByKind['asset-version']){
  const digest=sha256(await readFile(path.join(f.root,event.path)));
  assert.equal(digest,event.sha256);pinnedMediaHashes[event.path]=digest;
 }
 const nativeInput={documents,events,activeMedia:await f.repo.listMedia(),pinnedMediaHashes,baseRelease:await f.repo.readRelease(),compiler:{eventDirectory:'events'}};
 const nativeProof=nativeMaterialCandidateProof(nativeInput);
 assert.deepEqual(nativeProof.records.map(row=>row.versionId).sort(),[v1.versionId,v3.versionId].sort());
 assert.equal(nativeProof.records.some(row=>row.versionId===missingVersionId),false,'a failed empty output cannot be promoted to candidate proof');
 const nativePreserved=assertNativeCandidatePreservation({proof:nativeProof,snapshot:preserved.snapshot,recipes:preserved.recipes,events});
 assert.equal(nativePreserved.eventsPreserved,true);assert.equal(nativePreserved.baseCandidateVersionsCreated,0);
 if(referenceInput){
  // An in-memory compiler fixture only: no base candidate projection is published.
  // The real historical version also appears as an actual V003 input and parent.
  const projectedSnapshot=structuredClone(end.snapshot);
  projectedSnapshot.productionModel.assetVersions.push(structuredClone(state.assetVersionsById[v1.versionId]));
  const projectedInput={...nativeInput,baseRelease:{...nativeInput.baseRelease,snapshotBytes:Buffer.from(canonicalJson(projectedSnapshot))}};
  const projectedProof=nativeMaterialCandidateProof(projectedInput);
  assert.match(projectedProof.records.find(row=>row.versionId===v1.versionId).baseVersionHash,/^[a-f0-9]{64}$/);
  assert.equal(assertNativeCandidatePreservation({proof:projectedProof,snapshot:projectedSnapshot,recipes:end.recipes,events}).baseCandidateVersionsCreated,0);
  const wrongSha=structuredClone(projectedSnapshot);
  wrongSha.productionModel.assetVersions.find(v=>v.id===v1.versionId).sha256='0'.repeat(64);
  assert.throws(()=>nativeMaterialCandidateProof({...projectedInput,baseRelease:{...projectedInput.baseRelease,snapshotBytes:Buffer.from(canonicalJson(wrongSha))}}),{code:'SOURCE_NATIVE_CANDIDATE_BINDING'});
  const changedState=structuredClone(projectedSnapshot);
  changedState.productionModel.assetVersions.find(v=>v.id===v1.versionId).reviewDecision='DO_NOT_USE';
  assert.throws(()=>assertNativeCandidatePreservation({proof:projectedProof,snapshot:changedState,recipes:end.recipes,events}),{code:'SOURCE_NATIVE_CANDIDATE_BINDING'});
 }
}}));
