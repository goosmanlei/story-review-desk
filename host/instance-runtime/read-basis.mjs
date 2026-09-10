import {createHash} from 'node:crypto';
/** Opaque identity of one repeatable-read repository snapshot, not a business revision. */
export function readBasis(metadata) {
  return createHash('sha256').update(JSON.stringify([
    metadata.instanceId, metadata.runtimeEpoch, metadata.releaseId,
    metadata.profileRevisionId, metadata.snapshotId,
    metadata.workspaceRevision ?? metadata.repositoryRevision, metadata.eventSequence,
  ])).digest('hex');
}
/** Opt-in for business workspace reads, never runtime/health or mutation CAS. */
export async function workspaceReadMetadata(tx) {
  const [metadata,workspaceRevision]=await Promise.all([tx.getMetadata(),tx.getWorkspaceFingerprint()]);
  return {...metadata,workspaceRevision};
}
