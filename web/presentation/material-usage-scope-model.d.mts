/** API types only. Runtime validation lives in server/materials/usage-scopes.mjs. */
export type MaterialScopeType = 'PROJECT' | 'EPISODE' | 'SCENE' | 'SHOT';
export type UsageReference = {objectId:string; revisionId:string; expectedVersion:number};
export type UsagePathNode = UsageReference & {kind:Exclude<MaterialScopeType,'PROJECT'>};
export type UsagePath = {nodes:UsagePathNode[]; relations:Array<{ownerId:string;memberId:string;role:Exclude<MaterialScopeType,'PROJECT'>}>};
export type MaterialUsageScopeContent = {
  role:'MATERIAL_USAGE_SCOPE_V1'; familyId:string; familyRevisionId:string; familyExpectedVersion:number;
  purposeNote?:string; sourceBindings?:UsageReference[];
} & (
  {scopeType:'PROJECT';scopeId:string;scopeRevisionId?:never;scopeExpectedVersion?:never;path?:never} |
  {scopeType:Exclude<MaterialScopeType,'PROJECT'>;scopeId:string;scopeRevisionId:string;scopeExpectedVersion:number;path?:UsagePath}
);
export type MaterialUsageScopeTuple = MaterialUsageScopeContent & {
  usageId:string;revisionId:string;objectVersion:number;state:'DRAFT'|'ARCHIVED';historical:boolean;
  freshness:'CURRENT'|'STALE';pathResolution:'EXACT'|'UNKNOWN';issues:Array<{code:string;message:string}>;dependencies:[];
};
export type MaterialUsageScopeChange = {
  type:'UPSERT'|'REMOVE';expectedVersion:number;expectedRevisionId:string|null;content:MaterialUsageScopeContent;
};
export type MaterialUsageScopeAction =
  {action:'save';usageId:string;expectedDraftRevisionId:string|null;change:MaterialUsageScopeChange} |
  {action:'preview';usageId:string;draftRevisionId:string} |
  {action:'publish';usageId:string;draftRevisionId:string;previewHash:string};
export type MaterialUsageScopeTransaction = {
  operationId:string;runtimeEpoch:string;
  commands:[{type:'workspace.change';workspace:'material-usage-scopes';input:MaterialUsageScopeAction}];
};
export type MaterialUsageScopeCatalog = {
  project:{scopeType:'PROJECT';scopeId:string};
  families:Array<UsageReference & {familyId:string;title:string}>;
  scopes:Array<UsageReference & {scopeType:Exclude<MaterialScopeType,'PROJECT'>;scopeId:string;title:string}>;
  relations:Array<{owner:UsagePathNode;member:UsagePathNode;role:Exclude<MaterialScopeType,'PROJECT'>}>;
};
export type MaterialSubjectBinding = {entityId:string;entityType:string;isExtra?:boolean|null;revisionId:string|null;objectVersion:number|null};
export type MaterialUsageScopeList = {tuples:MaterialUsageScopeTuple[];catalog?:MaterialUsageScopeCatalog;formalAdoptionPerformed:false};
export type MaterialUsageScopeMigrationPreview = {
  status:'PREVIEW_ONLY';tuples:Array<{candidateId:string;content:MaterialUsageScopeContent;pathResolution:'UNKNOWN'}>;
  unknown:Array<{source:UsageReference;code:string;fields?:string[];scopeId?:string}>;
  skipped:Array<{source:UsageReference;code:string}>;dependencies:[];writesPerformed:false;formalAdoptionPerformed:false;
};
