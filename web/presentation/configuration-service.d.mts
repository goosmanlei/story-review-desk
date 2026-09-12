import type {
  InstanceReadUnit,
  InstanceUnit,
  RepositoryView,
} from "./index.mjs";
import type { Configuration, ReviewSpec } from "./configuration-model.mjs";
export type ConfigurationState = {
  releaseId: string;
  revisionId: string | null;
  sha256: string | null;
  configuration: Configuration;
  defaults: Configuration;
  reviewCatalog?: import("./review-standard-catalog.mjs").ReviewCatalogNode[];
  boundStandards?: ReviewSpec[];
  bindings: Array<{
    key: string;
    title?: string;
    profileLabel?: string;
    kind: string;
    profileId: string;
    defaultProfileId?: string | null;
    reviewSpecHash: string;
    configurationHash: string;
    imageTechnicalUpgradeEligible?: boolean;
    technicalSpec?: import("./image-technical-spec.mjs").ImageTechnicalSpec;
    technicalSpecHash?: string;
  }>;
  history: Array<{
    revisionId: string;
    sha256: string;
    createdAt: string;
    number: number;
  }>;
  initialized: boolean;
};
export type ConfigurationInput = {
  configuration: Configuration;
  expectedReleaseId: string;
  expectedConfigurationRevisionId: string | null;
  upgradeKeys?: string[];
};
export type ConfigurationPreview = ConfigurationInput & {
  previewHash: string;
  semanticChange: boolean;
  changedGroups: string[];
  affectedObjects: string[];
  retainedObjects: string[];
  checks: string[];
  newObjectDefaults: boolean;
};
export function getConfiguration(tx: InstanceReadUnit): Promise<ConfigurationState>;
export function previewConfiguration(
  tx: InstanceReadUnit,
  input: ConfigurationInput,
): Promise<ConfigurationPreview>;
export function publishConfiguration(
  tx: InstanceUnit,
  input: ConfigurationInput & { previewHash: string; requestId: string },
): Promise<{
  revisionId: string;
  sha256: string;
  releaseId: string;
  upgradedObjects: string[];
  changedGroups: string[];
}>;
export function initializeConfiguration(
  tx: InstanceUnit,
  overrides?: Partial<Configuration>,
): Promise<unknown>;
export function migrateConfiguration(
  snapshot: unknown,
  profile: unknown,
  overrides?: unknown,
): Configuration;
export function configurationRecord(
  tx: InstanceReadUnit,
  view?: RepositoryView,
): Promise<{
  value: {
    configuration: Configuration;
    bindings: Record<string, { reviewSpec: ReviewSpec }>;
  };
} | null>;
export { exportConfigurationTemplate } from "./configuration-model.mjs";

export function getConfigurationRevision(
  tx: InstanceReadUnit,
  revisionId: string,
): Promise<{ revisionId: string; sha256: string; configuration: Configuration }>;

export function stageConfiguration(tx: InstanceUnit, input: ConfigurationInput & {previewHash:string}): Promise<{snapshot:NonNullable<RepositoryView["snapshot"]>;recipes:NonNullable<RepositoryView["recipes"]>;sourceRevisionIds:string[];reference:{revisionId:string;sha256:string};profile:RepositoryView["profile"];baseReleaseId:string;result:{revisionId:string;sha256:string;upgradedObjects:string[];changedGroups:string[]}}>;
