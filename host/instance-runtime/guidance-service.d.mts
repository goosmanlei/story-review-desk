import type {InstanceReadUnit,InstanceUnit} from './index.mjs';
export const GUIDANCE_NAMESPACE:string;
type RootAlias='README.md'|'AGENTS.md'|'STATE.md';
type TopicAlias='guidance/story-review.md'|'guidance/materials.md'|'guidance/production.md'|'guidance/review-ui.md'|'guidance/operations.md';
export type GuidanceChange={alias:RootAlias;expectedRevisionId:string;expectedSha256:string;newSha256:string;contentBase64:string};
type TopicChange={alias:TopicAlias;newSha256:string;contentBase64:string}&({expectedRevisionId:string;expectedSha256:string}|{expectedRevisionId:null;expectedSha256:null});
export type GuidanceManifest=({schemaVersion:'1.0';changes:GuidanceChange[]}|{schemaVersion:'1.1';changes:(GuidanceChange|TopicChange)[]})&{operationId:string;expectedReleaseId:string};
export function inspectGuidance(tx:InstanceReadUnit,options?:{includeTopics?:boolean}):Promise<{instanceId:string;releaseId:string|null;runtimeEpoch:string;documents:Array<{alias:string;documentId:string|null;revisionId:string|null;sha256:string|null;headRevisionId:string|null;headMatchesPublished:boolean;sourceRole:string|null;legacyExpectedSha256:string|null;eligible:boolean;creatable?:boolean}>}>;
export function updateGuidance(tx:InstanceUnit,input:GuidanceManifest):Promise<{schemaVersion:string;operationType:'GUIDANCE_UPDATE';operationId:string;requestHash:string;instanceId:string;runtimeEpoch:string;baseReleaseId:string;releaseId:string;documents:unknown[];snapshotSha256:string;recipesSha256:string;originalSnapshotBytesPreserved:true;originalRecipesBytesPreserved:true;formalAdoptionPerformed:false;productionAuthorizationCreated:false;recordedAt:string;replayed?:boolean}>;
