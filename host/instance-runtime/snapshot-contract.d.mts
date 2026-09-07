export const blankModelArrayKeys: readonly string[];
type ProductionDefinition = {
  id: string; slug: string; order: number; label: string; purpose: string;
  denominatorState: 'UNKNOWN'; denominator: null;
  [key: string]: unknown;
};
export function blankProductionGraph(): {
  productionPhases: Array<ProductionDefinition & { gateIds: string[]; entryGateId: string; exitGateId: string }>;
  productionGates: Array<ProductionDefinition & { phaseId: string; scopeType: string }>;
};
export function isLegacyBlankSnapshot(snapshot: unknown): boolean;
export function normalizeReviewSnapshot<T>(snapshot: T): T;
export function normalizeEmptyProductionFilters<T extends { phaseId: string | null; gateId: string | null }>(snapshot: unknown, filters: T): T;
