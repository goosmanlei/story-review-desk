import type {ImagePurposeProfiles,ImageTechnicalSpec} from './image-technical-spec.mjs';
export type Criterion = {
  id: string;
  label: string;
  question: string;
  required: boolean;
  allowNA: boolean;
  noteRequiredOnFail: boolean;
};
export type ReviewSpec = {
  legacy?: boolean;
  technicalSpec?: ImageTechnicalSpec;
  technicalSpecHash?: string;
  profileId: string;
  criteria: Criterion[];
  configurationHash: string;
  hash: string;
  firstQuestion?: string;
  lastQuestion?: string;
};
export type ReviewProfile = {
  id: string;
  label: string;
  subjectKind: "EPISODE_PLAN" | "SCRIPT_SCENE" | "ASSET" | "WORK_PRODUCT";
  criteria: Criterion[];
  firstQuestion?: string;
  lastQuestion?: string;
  deliverableKey?: string;
};
export type MaterialType = {
  id: string;
  label: string;
  aliases: string[];
  mediaType: "IMAGE" | "AUDIO" | "VIDEO" | "TEXT";
  reviewProfileId: string;
  productionLane: string;
};
export type Category = {
  id: string;
  label: string;
  aliases: string[];
  icon: string;
  tone: string;
  types: MaterialType[];
};
export type Configuration = {
  schemaVersion: "1.0" | "2.0" | "2.1";
  domain?: import("./domain-model.mjs").DomainConfiguration;
  template: { id: string; version: string };
  reviewProfiles: ReviewProfile[];
  taxonomy: { categories: Category[] };
  workflow: {
    phases: Array<{ id: string; label: string; purpose: string }>;
    gates: Array<{
      id: string;
      label: string;
      phaseId: string;
      scopeType: string;
      purpose: string;
      extraPrerequisites: string[];
      additionalOutputTypes: string[];
    }>;
    materialPrerequisites?: Array<{
      id: string;
      label: string;
      requirementIds: string[];
      requiredSceneIds: string[];
    }>;
    lipSync: "WHEN_REQUIRED";
    earlyAmbience: boolean;
  };
  technical: {
    imagePurposeProfiles?: ImagePurposeProfiles;
    picture: {
      aspectRatio: string;
      width: number | "UNKNOWN";
      height: number | "UNKNOWN";
      fps: number | "UNKNOWN";
      confirmation: string;
    };
    delivery: {
      platform: string;
      audience: string;
      codec: string;
      color: string;
      loudness: string;
      confirmation: string;
    };
  };
  sources: {
    order: Array<{ id: string; label: string; role: string }>;
    continuity: {
      specAlias: string;
      requiredCoordinates: string[];
      themes: Array<{ id: string; label: string }>;
    };
  };
  collaboration: {
    apiKeyEnvName?: string;
    assistantEnabled: boolean;
    preferredCollaborator: string;
    defaultExecutor: string;
    codexBridge: {
      autoStart: boolean;
      model: string;
      maxConcurrent: number;
      idleTtlSeconds: number;
    };
  };
  presentation: {
    storyTitle: string;
    title: string;
    mark: string;
    description: string;
    landingView: string;
    trialEnabled: boolean;
    trialLabel: string;
  };
};
export type ConfigurationRef = { revisionId: string; sha256: string };
export type ConfigurationBinding = {
  key: string;
  kind: string;
  technicalSpec?: ImageTechnicalSpec;
  technicalSpecHash?: string;
  reviewSpec: ReviewSpec;
  productionLane?: string;
  defaultExecutor?: string;
  technical: Configuration["technical"];
  workflow: Configuration["workflow"];
  sources: Configuration["sources"];
  configurationHash: string;
  createdBy?: string;
};
export function defaultConfiguration(profile?: unknown): Configuration;
export const DEFAULT_CODEX_BRIDGE_CONFIGURATION: Readonly<Configuration["collaboration"]["codexBridge"]>;
export function normalizeCodexBridgeConfiguration(value?: unknown): Configuration["collaboration"]["codexBridge"];
export function normalizeConfiguration(config: Configuration): Configuration;
export function validateConfiguration(
  config: unknown,
  previous?: Configuration,
): Configuration;
export function configHash(value: unknown): string;
export function semanticConfiguration(config: Configuration): unknown;
export function categoryFor(
  config: Configuration,
  primary: string,
  secondary: string,
): { category?: Category; type?: MaterialType };
export function reviewSpec(
  config: Configuration,
  kind: string,
  object: unknown,
  options?: unknown,
): ReviewSpec;
export const sceneCriteria: Criterion[];
export function exportConfigurationTemplate(config: Configuration): {
  schemaVersion: string;
  kind: string;
  configuration: Configuration;
};
export function profileFor(config:Configuration, kind:string, object:Record<string,unknown>):string;
export function configurationObjects(snapshot:unknown):Array<{key:string;kind:string;object:Record<string,unknown> & {configurationBinding?:ConfigurationBinding;title?:string;sceneTitle?:string;sceneId?:string}}>;
