import type {InstanceReadUnit} from './index.mjs';
export type SpatialSettings={status:'AVAILABLE'|'NOT_CONFIGURED';snapshotId:string;sourceBinding:{documentId:string;revisionId:string;sha256:string;logicalPath:string}|null;sourceText?:string;specification:Record<string,unknown>|null};
export function readSpatialSettings(tx:InstanceReadUnit,view:Awaited<ReturnType<InstanceReadUnit['readView']>>):Promise<SpatialSettings>;
export const spatialLogicalPath:string;
