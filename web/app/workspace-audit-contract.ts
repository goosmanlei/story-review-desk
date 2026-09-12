import type {CurrentWorkCounts,WorkspaceStageSummary} from './action-queue-contract';
import type {CreatorProductionStage} from './creator-production-workflow';
export type WorkspaceFreshness={
 schemaVersion:string;projectionVersion:string;mode:'LIVE_TRANSACTION'|'PUBLISHED_READ_ONLY'|'UNVERIFIED';
 snapshotId:string|null;releaseId:string|null;runtimeEpoch:string|null;repositoryRevision:number|null;eventSequence:number|null;
 operationRevision:string|null;configurationRevisionId:string|null;domainRevisionId:string|null;preparationRevisionId:string|null;
};
export type WorkspaceModule={
 id:string;label:string;href:string;responsibility:string;status:string;headline:string;nextAction:string|null;
 work:CurrentWorkCounts|null;stages:WorkspaceStageSummary[];revisionId:string|null;
 facts:Array<{id:string;label:string;value:number|null;boundary:string}>;
};
export type WorkspaceAudit={
 schemaVersion:string;authority:string;freshness:WorkspaceFreshness;modules:WorkspaceModule[];boundaries:string[];
 operationCounts:Array<{id:string;value:number}>;
 creatorStages:CreatorProductionStage[];
 configuration:{phaseCount:number;gateCount:number;reference:{revisionId?:string;sha256?:string}|null};
 interfaces:Array<{path:string;purpose:string}>;
};
