import {createHash} from 'node:crypto';
/** Opaque identity of one repeatable-read repository snapshot, not a business revision. */
export function readBasis(metadata) {
  return createHash('sha256').update(JSON.stringify([
    metadata.instanceId, metadata.runtimeEpoch, metadata.releaseId,
    metadata.profileRevisionId, metadata.snapshotId,
    metadata.repositoryRevision, metadata.eventSequence,
  ])).digest('hex');
}
