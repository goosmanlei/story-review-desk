// The browser and host consume one pure map. Do not duplicate business grouping.
export {
  CREATOR_PRODUCTION_STAGES,
  creatorProductionGateDefinition,
  creatorProductionStageForGate,
  creatorProductionStageDefinition,
  creatorProductionScopeForGate,
  resolveCreatorProductionStage,
} from '../presentation/creator-production-workflow.mjs';
export type {
  CreatorProductionStageId,
  CreatorProductionGateScope,
  CreatorProductionSubarea,
  CreatorProductionStage,
  CreatorProductionGate,
} from '../presentation/creator-production-workflow.mjs';
