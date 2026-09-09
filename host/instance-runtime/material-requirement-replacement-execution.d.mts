import type {InstanceReadUnit,RepositoryView} from './index.mjs';
import type {DomainGraph} from './domain-model.mjs';
export const REPLACEMENT_EXECUTION_JOB_NAMESPACES:string[];
export type ReplacementExecutionImpact={replacementRefs:Array<{requirementId:string;requirementHash:string;replacementRequirementId:string}>;currentWorkIds:string[];historicalWorkIds:string[];historicalReleaseProofs:Array<{releaseId:string;snapshotId:string;createdAt:string;snapshotSha256:string;recipesSha256:string;profileRevisionId:string;profileSha256:string}>;currentPlanIds:string[];currentProductionPlanIds:string[];definitionIds:string[];affectedSceneIds:string[];requestHeads:Array<{eventId:string;eventSequence:number;sha256:string}>;runHeads:Array<{eventId:string;eventSequence:number;sha256:string}>;hostJobs:Array<{namespace:string;jobId:string;status:string;revisionId:string;sha256:string}>;reasons:string[]};
export type ReplacementExecutionInput={nextGraph:DomainGraph;view?:RepositoryView;previousGraph?:DomainGraph};
export function inspectMaterialRequirementReplacementExecution(tx:InstanceReadUnit,input:ReplacementExecutionInput):Promise<ReplacementExecutionImpact>;
export function assertMaterialRequirementReplacementExecution(tx:InstanceReadUnit,input:ReplacementExecutionInput):Promise<ReplacementExecutionImpact>;
