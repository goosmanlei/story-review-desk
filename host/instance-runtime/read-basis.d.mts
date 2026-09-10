export function readBasis(metadata: object): string;
import type {InstanceReadUnit} from './index.mjs';
export function workspaceReadMetadata(tx:Pick<InstanceReadUnit,'getMetadata'|'getWorkspaceFingerprint'>):Promise<Awaited<ReturnType<InstanceReadUnit['getMetadata']>>&{workspaceRevision:string}>;
