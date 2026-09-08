export type CreatorProductionStageId = 'SHOT_PRODUCTION' | 'SCENE_EDIT' | 'EPISODE_EDIT';
export type CreatorProductionGateScope = 'SHOT' | 'SCENE' | 'EPISODE' | 'PROJECT';
export type CreatorProductionSubarea = 'WORKSPACE' | 'EXPORT_CHECKS';
export type CreatorProductionStage = Readonly<{
  id: CreatorProductionStageId; label: string; order: number; purpose: string;
  /** Navigation only. Use the gate's scopeType for actual business subjects. */
  scope: 'SCENE' | 'EPISODE';
  gateIds: readonly string[]; defaultGateId: string; exportGateIds: readonly string[];
}>;
export type CreatorProductionGate = Readonly<{
  gateId: string; creatorStageId: CreatorProductionStageId;
  phaseId: 'PREVIS' | 'SHOT_FINISH' | 'SCENE_FINISH' | 'EPISODE_FINISH' | 'SERIES_DELIVERY';
  scopeType: CreatorProductionGateScope; subarea: CreatorProductionSubarea;
}>;
export const CREATOR_PRODUCTION_STAGES: readonly CreatorProductionStage[];
export function creatorProductionGateDefinition(gateId: unknown): CreatorProductionGate | null;
export function creatorProductionStageForGate(gateId: unknown): CreatorProductionStageId | null;
export function creatorProductionStageDefinition(id: unknown): CreatorProductionStage | null;
export function creatorProductionScopeForGate(gateId: unknown): CreatorProductionGateScope | null;

export function resolveCreatorProductionStage(value:unknown):{stageId:CreatorProductionStageId;defaultGateId:string}|null;
