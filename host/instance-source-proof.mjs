import { canonicalJson, sha256 } from './instance-runtime/bytes.mjs';

export class InstanceSourceError extends Error {
  constructor(code, message) { super(message); this.name = 'InstanceSourceError'; this.code = code; }
}
export const requireSource = (condition, code, message) => { if (!condition) throw new InstanceSourceError(code, message); };
export const objectHash = (value) => sha256(canonicalJson(value));
export const HOST_NAMESPACE = 'source-operation-host';

/** Read the exact committed release and source revisions. No legacy path is opened. */
export async function verifyInstanceSourceProof(repository, expected) {
  return repository.readTransaction(async (tx) => {
    const view = (await tx.readView()); const release = (await tx.readRelease()); const endpoint = expected.deployedEndpointProof;
    requireSource(release && ['INSTANCE_SQLITE','INSTANCE_POSTGRES'].includes(endpoint?.authority) && endpoint.instanceId === view.instanceId && endpoint.releaseId === release.releaseId && endpoint.runtimeEpoch === view.runtimeEpoch, 'SOURCE_RUNTIME_MISMATCH', 'Deployment evidence does not bind this instance release and runtime epoch');
    const commitRecord = (await tx.getAux(HOST_NAMESPACE, `commits/${expected.sourceOperationId}.json`));
    const commit = commitRecord && !commitRecord.deleted ? JSON.parse(commitRecord.bytes) : null;
    requireSource(commit?.releaseId === release.releaseId && commit?.runtimeBundleId === expected.runtimeBundleId && commit?.runtimeEpoch === view.runtimeEpoch && commit?.instanceId === view.instanceId, 'SOURCE_COMMIT_MISMATCH', 'Runtime build is not bound to this committed database release');
    requireSource(release.snapshotId === expected.targetSnapshotId && release.snapshotSha256 === expected.reviewDataSha256 && release.recipesSha256 === expected.recipeSha256, 'SOURCE_RELEASE_MISMATCH', 'Current database release differs from the host proof');
    const pinned = new Set(release.sourceRevisionIds);
    requireSource(objectHash(Object.keys(expected.derivedArtifactHashes).sort()) === objectHash([...view.profile.sourceBindings.derivedRegistryPaths].sort()) && !Object.keys(expected.newBlockHashes).some((alias) => Object.hasOwn(expected.derivedArtifactHashes, alias)), 'SOURCE_DERIVED_SET', 'Host proof must contain the exact disjoint source and nine-registry sets');
    for (const [alias, hash] of Object.entries({ ...expected.newBlockHashes, ...expected.derivedArtifactHashes })) {
      const document = (await tx.readDocument(alias));
      requireSource(document && !document.deleted && pinned.has(document.revisionId) && document.sha256 === hash, 'SOURCE_DOCUMENT_MISMATCH', `Committed source revision differs: ${alias}`);
    }
    const ref = `host_proofs/${expected.sourceOperationId}.json`;
    const record = (await tx.getAux(HOST_NAMESPACE, ref));
    requireSource(record && !record.deleted, 'HOST_PROOF_MISSING', 'Host deployment proof has not been recorded');
    const proof = JSON.parse(record.bytes.toString('utf8')); const { proofDigest, ...payload } = proof;
    requireSource(proofDigest === objectHash(payload), 'HOST_PROOF_HASH', 'Host proof bytes do not match their digest');
    const exact = { schemaVersion: '1.1', proofType: 'HOST_WORKER_FORMAL_DEPLOYMENT_QA', apiSourceOperationId: expected.sourceOperationId,
      targetSnapshotId: expected.targetSnapshotId, runtimeBundleId: expected.runtimeBundleId, reviewDataSha256: expected.reviewDataSha256, recipeSha256: expected.recipeSha256,
      derivedArtifactHashes: expected.derivedArtifactHashes, sourceBlockHashes: expected.newBlockHashes, formalUrl: endpoint.url,
      preDeploymentQaStatus: 'PASS', formalRuntimeQaStatus: 'PASS', deployedEndpointProofHash: objectHash(endpoint) };
    for (const [key, value] of Object.entries(exact)) requireSource(key in payload && objectHash(payload[key]) === objectHash(value), 'HOST_PROOF_BINDING', `Host proof binding differs: ${key}`);
    requireSource(typeof payload.workerOperationId === 'string' && payload.workerOperationId && Number.isFinite(Date.parse(payload.verifiedAt)), 'HOST_PROOF_BINDING', 'Host proof lacks its worker and verification time');
    return { ref, digest: proofDigest, verifiedAt: payload.verifiedAt, verificationMode: tx.backend === 'postgres' ? 'INSTANCE_POSTGRES_RELEASE_AND_SOURCE_RECORDS' : 'INSTANCE_SQLITE_RELEASE_AND_SOURCE_RECORDS', proofPayload: payload };
  });
}
