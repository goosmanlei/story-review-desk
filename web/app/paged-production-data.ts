import type { ProductionModel } from './production-workbench';

export type UiScopeType = 'SHOT' | 'SCENE' | 'EPISODE' | 'PROJECT';
export type PagedProductionResource = 'production' | 'materials';

export type PagedProductionFilters = {
  phaseId?: string | null;
  gateId?: string | null;
  scopeType?: UiScopeType | null;
  scopeId?: string | null;
};

type ProductionPage = Partial<Pick<ProductionModel,
  | 'workItems'
  | 'workPackages'
  | 'assetFamilies'
  | 'assetVersions'
  | 'expectedOutputs'
  | 'reviewContexts'
  | 'shots'
  | 'scenes'
  | 'episodes'
  | 'shotPlanSetRevisions'
  | 'episodePlanRevisions'
  | 'revisionPointers'
>>;

type MaterialsPage = Partial<Pick<ProductionModel,
  | 'materialRequirements'
  | 'materialWorkItems'
  | 'assetFamilies'
  | 'assetVersions'
  | 'expectedOutputs'
>>;

export type PagedProductionPayload = {
  schemaVersion: string;
  snapshotId: string;
  operationRevision?: number | string;
  readVersion?: string;
  page: ProductionPage & MaterialsPage;
  count: number;
  total: number;
  nextCursor: string | null;
  hasMore: boolean;
  appliedMode?: 'requirements';
  appliedFilters: {
    phaseId: string | null;
    gateId: string | null;
    scopeType: UiScopeType | null;
    scopeId: string | null;
    familyId?: string | null;
  };
};

export type MaterialCatalogRead = {scope:string;values:unknown[];trials:unknown[]};
export type PagedProductionWindow = {
  key: string;
  resource: PagedProductionResource;
  filters: PagedProductionFilters;
  initialized: boolean;
  loading: boolean;
  error: string;
  loaded: number;
  total: number | null;
  hasMore: boolean;
  nextCursor: string | null;
  materialCatalog?: MaterialCatalogRead;
};

const productionArrayKeys = [
  'workItems',
  'workPackages',
  'assetFamilies',
  'assetVersions',
  'expectedOutputs',
  'reviewContexts',
  'materialRequirements',
  'materialWorkItems',
  'shots',
  'scenes',
  'episodes',
  'shotPlanSetRevisions',
  'episodePlanRevisions',
] as const;

function mergeRows<T extends { id: string }>(current: T[] | undefined, incoming: T[] | undefined) {
  if (!incoming?.length) return current || [];
  const rows = new Map<string, T>();
  for (const row of current || []) rows.set(row.id, row);
  for (const row of incoming) {
    const existing = rows.get(row.id);
    rows.set(row.id, existing ? { ...existing, ...row } : row);
  }
  return [...rows.values()];
}

export function normalizeProductionModel(model: ProductionModel): ProductionModel {
  return {
    ...model,
    stageDefinitions: model.stageDefinitions || [],
    workflowSteps: model.workflowSteps || [],
    continuityGroups: model.continuityGroups || [],
    workItems: model.workItems || [],
    workPackages: model.workPackages || [],
    materialRequirements: model.materialRequirements || [],
    materialWorkItems: model.materialWorkItems || [],
    structureCards: model.structureCards || [],
    episodes: model.episodes || [],
    scenes: model.scenes || [],
    segments: model.segments || [],
    beats: model.beats || [],
    shots: model.shots || [],
    assetFamilies: model.assetFamilies || [],
    assetVersions: model.assetVersions || [],
    expectedOutputs: model.expectedOutputs || [],
    reviewContexts: model.reviewContexts || [],
    issues: model.issues || [],
    counts: model.counts || ({} as ProductionModel['counts']),
  };
}

export function mergePagedProductionModel(model: ProductionModel, page: PagedProductionPayload['page']): ProductionModel {
  const next = { ...normalizeProductionModel(model) } as unknown as Record<string, unknown>;
  const incoming = page as Record<string, Array<{ id: string }> | undefined>;
  for (const key of productionArrayKeys) {
    const rows = incoming[key];
    if (!rows) continue;
    next[key] = mergeRows(
      next[key] as Array<{ id: string }> | undefined,
      rows,
    );
  }
  if(page.revisionPointers)next.revisionPointers={...model.revisionPointers,...page.revisionPointers};
  return normalizeProductionModel(next as unknown as ProductionModel);
}

export function pagedProductionWindowKey(resource: PagedProductionResource, filters: PagedProductionFilters = {}) {
  return JSON.stringify({
    resource,
    phaseId: filters.phaseId || null,
    gateId: filters.gateId || null,
    scopeType: filters.scopeType || null,
    scopeId: filters.scopeId || null,
  });
}

export function pagedProductionUrl(
  resource: PagedProductionResource,
  filters: PagedProductionFilters,
  cursor: string | null,
) {
  const endpoint = `/api/v1/workspaces/views/${resource}`;
  const params = new URLSearchParams({ limit: '100' });
  if (resource === 'materials') params.set('detail', 'summary');
  if (filters.phaseId) params.set('phaseId', filters.phaseId);
  if (filters.gateId) params.set('gateId', filters.gateId);
  if (filters.scopeType && filters.scopeId) {
    params.set('scopeType', filters.scopeType);
    params.set('scopeId', filters.scopeId);
  }
  if (cursor) params.set('cursor', cursor);
  return `${endpoint}?${params.toString()}`;
}

export function emptyPagedProductionWindow(
  resource: PagedProductionResource,
  filters: PagedProductionFilters,
): PagedProductionWindow {
  return {
    key: pagedProductionWindowKey(resource, filters),
    resource,
    filters,
    initialized: false,
    loading: false,
    error: '',
    loaded: 0,
    total: null,
    hasMore: false,
    nextCursor: null,
  };
}
