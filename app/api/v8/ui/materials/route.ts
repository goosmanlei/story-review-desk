import {workspaceReadMetadata} from '../../../../../host/instance-runtime/read-basis.mjs';
import {conditionalWorkspaceRead,retainReadValidator} from '../../../../../host/instance-runtime/conditional-read-cache.mjs';
import {ReadTiming} from '../../../_read-timing';
import { postgresMaterialPage, summarizeMaterialPage, materialUsagePageBindings, materialDirectoryProjection } from '../_material-query';
import { projectIdFor } from '../../../../instance-profile';
import { normalizeEmptyProductionFilters } from '../../../../../host/instance-runtime/snapshot-contract.mjs';
import { hostedReadOnlyMode, instanceRepository, assertStableId, errorResponse, HttpError, jsonResponse, operationalSnapshot, reviewData } from '../../_store';
import {
  assertCursorOffset,
  encodeUiCursor,
  jsonByteLength,
  parseUiPageRequest,
  UI_PAGE_MAX_BYTES,
  type UiPageFilters,
} from '../_pagination';

type Row = Record<string, unknown> & { id: string };

export function materialEpisodeAliases(
  requestedScopeId: string | undefined,
  requestedEpisode: Row | null | undefined,
  currentEpisodePlan: boolean,
) {
  const candidates = currentEpisodePlan
    ? [requestedEpisode?.canonicalScopeId, requestedEpisode?.episodeUid]
    : [
        requestedScopeId,
        requestedEpisode?.canonicalScopeId,
        requestedEpisode?.episodeUid,
        requestedEpisode?.id,
        requestedEpisode?.displayId,
      ];
  return new Set(candidates.filter((value): value is string => typeof value === 'string' && Boolean(value)));
}

export function materialEpisodeScopeMatches(row: Row, episodeAliases: Set<string>, currentEpisodePlan: boolean) {
  const uidMatch = episodeAliases.has(String(row.episodeUid || ''))
    || (Array.isArray(row.episodeUids) && row.episodeUids.map(String).some((value) => episodeAliases.has(value)));
  const canonicalScopeMatch = episodeAliases.has(String(row.canonicalScopeId || ''))
    || (row.scopeType === 'EPISODE' && episodeAliases.has(String(row.scopeId || '')));
  if (currentEpisodePlan) return uidMatch || canonicalScopeMatch;
  return uidMatch
    || canonicalScopeMatch
    || episodeAliases.has(String(row.episodeId || ''))
    || (Array.isArray(row.episodeIds) && row.episodeIds.map(String).some((value) => episodeAliases.has(value)));
}

export function materialSecondaryScopeMatches(
  row: Row,
  filters: UiPageFilters,
  episodeAliases: Set<string>,
  currentEpisodePlan: boolean,
) {
  if (!currentEpisodePlan || filters.scopeType !== 'EPISODE' || !filters.scopeId) return true;
  const coordinateRows = [row, row.position, row.episode, row.coordinates]
    .filter((value): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value)))
    .map((value) => ({ id: row.id, ...value } as Row));
  const declaresEpisodeCoordinate = coordinateRows.some((coordinate) => (
    coordinate.scopeType === 'EPISODE'
    || typeof coordinate.episodeUid === 'string'
    || (Array.isArray(coordinate.episodeUids) && coordinate.episodeUids.length > 0)
    || typeof coordinate.canonicalScopeId === 'string'
    || typeof coordinate.episodeId === 'string'
    || (Array.isArray(coordinate.episodeIds) && coordinate.episodeIds.length > 0)
  ));
  return !declaresEpisodeCoordinate
    || coordinateRows.some((coordinate) => materialEpisodeScopeMatches(coordinate, episodeAliases, true));
}

export function requirementMatchesScope(
  row: Row,
  filters: UiPageFilters,
  episodeAliases: Set<string>,
  currentEpisodePlan: boolean,
) {
  if (!filters.scopeType || !filters.scopeId || filters.scopeType === 'PROJECT') return true;
  if (filters.scopeType === 'EPISODE') {
    return materialEpisodeScopeMatches(row, episodeAliases, currentEpisodePlan);
  }
  const field = filters.scopeType === 'SCENE'
    ? 'sceneIds'
    : Array.isArray(row.currentShotIds) ? 'currentShotIds' : 'shotIds';
  return Array.isArray(row[field]) && row[field].map(String).includes(filters.scopeId);
}

// Shared by scope-contract tests and production consumers. It is not an
// alternate asset-ledger read path: the materials endpoint only serves
// requirement-bound records.
export function familyMatchesScope(
  row: Row,
  filters: UiPageFilters,
  episodeAliases: Set<string>,
  currentEpisodePlan: boolean,
) {
  if (!filters.scopeType || !filters.scopeId || filters.scopeType === 'PROJECT') return true;
  if (filters.scopeType === 'EPISODE') {
    return materialEpisodeScopeMatches(row, episodeAliases, currentEpisodePlan);
  }
  const field = filters.scopeType === 'SCENE' ? 'sceneIds' : 'shotIds';
  return Array.isArray(row[field]) && row[field].map(String).includes(filters.scopeId);
}

function validateFilters(data: Awaited<ReturnType<typeof reviewData>>, filters: UiPageFilters) {
  const phase = filters.phaseId
    ? (data.productionModel.productionPhases || []).find((item) => item.id === filters.phaseId)
    : null;
  if (filters.phaseId && !phase) throw new HttpError(422, 'phaseId does not resolve in the current production graph');
  const gate = filters.gateId
    ? (data.productionModel.productionGates || []).find((item) => item.id === filters.gateId)
    : null;
  if (filters.gateId && (!gate || gate.phaseId !== filters.phaseId)) {
    throw new HttpError(422, 'gateId does not belong to phaseId');
  }
  if (!filters.scopeType || !filters.scopeId) return;
  const scopeId = filters.scopeId;
  const currentEpisodePlan = data.creativeLineage?.storyStructure?.planStatus === 'CURRENT';
  const exists = filters.scopeType === 'PROJECT'
    ? scopeId === projectIdFor(data)
    : filters.scopeType === 'EPISODE'
      ? data.productionModel.episodes?.some((item) => (
          currentEpisodePlan
            ? [item.canonicalScopeId, item.episodeUid].includes(scopeId)
            : [item.canonicalScopeId, item.episodeUid, item.id, item.displayId].includes(scopeId)
        ))
      : filters.scopeType === 'SCENE'
        ? data.productionModel.scenes?.some((item) => item.id === scopeId)
        : data.productionModel.shots?.some((item) => item.id === scopeId);
  if (!exists) throw new HttpError(422, 'scope does not resolve in the current production graph');
}

function overlay(rows: Row[], projection: Record<string, Row | undefined>) {
  return rows.map((row) => ({ ...row, ...(projection[row.id] || {}) }));
}

export async function GET(request: Request) {
  try {
    const timing=new ReadTiming();
    const repo=hostedReadOnlyMode()?null:await instanceRepository();
    if(repo){const cached=await timing.measure('version',()=>conditionalWorkspaceRead(repo,request));if(cached){for(const [key,value]of Object.entries(timing.headers()))cached.headers.set(key,value);return cached;}}
    const read=async()=>{const [data,operations]=await Promise.all([reviewData(),operationalSnapshot()]);return {data,operations,basis:repo?await workspaceReadMetadata(repo):undefined};};
    const {data,operations,basis}=await timing.measure('read',()=>repo?repo.readTransaction(read):read());
    if (operations.snapshotId !== data.snapshotId) throw new HttpError(409, 'material projection snapshot changed during read');
    if (!process.env.REVIEW_REMOTE_READ_ONLY) {
      const response = await timing.measure('directory',()=>postgresMaterialPage(request,data,operations,validateFilters,basis));
      if(response){if(repo)retainReadValidator(repo,request,response);for(const [key,value]of Object.entries(timing.headers()))response.headers.set(key,value);return response;}
    }
    const detailUrl=new URL(request.url);
    const requestedRequirementId=detailUrl.searchParams.get('requirementId');
    const requestedMode = new URL(request.url).searchParams.get('mode') || 'requirements';
    if (!['requirements', 'ledger'].includes(requestedMode)) throw new HttpError(400, 'mode must be requirements');
    if (requestedMode === 'ledger') throw new HttpError(410, 'the standalone asset ledger has been retired; reusable materials are served by requirements mode and production outputs remain in Full Production');
    const requestedFamilyId = new URL(request.url).searchParams.get('familyId');
    if (requestedFamilyId) assertStableId(requestedFamilyId, 'familyId');
    if (requestedFamilyId) throw new HttpError(400, 'familyId is no longer supported by the material directory; open the bound material requirement instead');
    const cursorResource = 'materials:requirements';
    const parsed = parseUiPageRequest(request, cursorResource, data.snapshotId, (filters) => normalizeEmptyProductionFilters(data, filters));
    validateFilters(data, parsed.filters);
    const requestedScopeId = parsed.filters.scopeId || undefined;
    const currentEpisodePlan = data.creativeLineage?.storyStructure?.planStatus === 'CURRENT';
    const requestedEpisode = parsed.filters.scopeType === 'EPISODE'
      ? data.productionModel.episodes?.find((item) => (
          currentEpisodePlan
            ? [item.canonicalScopeId, item.episodeUid].includes(requestedScopeId)
            : [item.canonicalScopeId, item.episodeUid, item.id, item.displayId].includes(requestedScopeId)
        ))
      : null;
    const episodeAliases = materialEpisodeAliases(requestedScopeId, requestedEpisode as Row | null, currentEpisodePlan);
    const state = operations.stateProjection as unknown as {
      materialRequirementsById: Record<string, Row | undefined>;
      materialWorkItemsById: Record<string, Row | undefined>;
      workItemsById: Record<string, Row | undefined>;
      workPackagesById: Record<string, Row | undefined>;
      assetFamiliesById: Record<string, Row | undefined>;
      assetVersionsById: Record<string, Row | undefined>;
      expectedOutputsById: Record<string, Row | undefined>;
    };
    const workItemsById = new Map((data.productionModel.workItems as unknown as Row[]).map((item) => [item.id, item]));
    const consumerMatchesProductionFilter = (requirement: Row) => {
      if (!parsed.filters.phaseId && !parsed.filters.gateId) return true;
      return Array.isArray(requirement.consumerWorkItemRefs) && requirement.consumerWorkItemRefs.some((id) => {
        const work = workItemsById.get(String(id));
        return Boolean(
          work
          && work.activeInCurrentProduction === true
          && (!parsed.filters.phaseId || work.phaseId === parsed.filters.phaseId)
          && (!parsed.filters.gateId || work.gateId === parsed.filters.gateId),
        );
      });
    };
    const directory = materialDirectoryProjection(data.productionModel,state);
    const currentIds = new Set(directory.currentRows.map(row=>row.id));
    const atomicIds = new Set(directory.atomicRows.map(row=>row.id));
    const primary = (directory.rows as Row[])
      .filter(item=>requestedRequirementId || currentIds.has(item.id))
      .filter((item) => item.requirementClass === 'REQUIRED')
      .filter((item) => !requestedRequirementId || item.id === requestedRequirementId)
      .filter((item) => consumerMatchesProductionFilter(item))
      .filter((item) => requirementMatchesScope(item, parsed.filters, episodeAliases, currentEpisodePlan))
      .sort((left, right) => String(left.id || '').localeCompare(String(right.id || '')));
    if(requestedRequirementId&&!primary.length)throw new HttpError(404,'当前素材需求不存在');
    assertCursorOffset(parsed.offset, primary.length);

    const buildPage = (count: number) => {
      const materialRequirements = primary.slice(parsed.offset, parsed.offset + count);
      const requirementIds = new Set(materialRequirements.map((item) => item.id));
      const materialWorkItems = overlay(
        ((data.productionModel.materialWorkItems || []) as unknown as Row[])
          .filter((item) => requirementIds.has(String(item.requirementRef || '')))
          .sort((left, right) => String(left.id || '').localeCompare(String(right.id || ''))),
        state.materialWorkItemsById,
      ).filter((item) => materialSecondaryScopeMatches(item, parsed.filters, episodeAliases, currentEpisodePlan));
      const usageBindings=materialUsagePageBindings(materialRequirements),usageFamilyIds=new Set(usageBindings.map(b=>b.familyId)),usageVersionIds=new Set(usageBindings.map(b=>b.versionId));
      const candidateFamilyIds = new Set([
        ...usageFamilyIds,
        ...materialRequirements.flatMap((item) => [
          ...(Array.isArray(item.assetFamilyRefs) ? item.assetFamilyRefs.map(String) : []),
          ...(Array.isArray(item.coveredByFamilyRefs) ? item.coveredByFamilyRefs.map(String) : []),
          ...(typeof item.plannedAssetFamilyId === 'string' ? [item.plannedAssetFamilyId] : []),
        ]),
        ...materialWorkItems.flatMap((item) => [
          ...(typeof item.outputAssetRef === 'string' ? [item.outputAssetRef] : []),
          ...(Array.isArray(item.additionalOutputAssetRefs) ? item.additionalOutputAssetRefs.map(String) : []),
          ...(Array.isArray(item.inputAssetRefs) ? item.inputAssetRefs.map(String) : []),
        ]),
      ]);
      const assetFamilies = overlay(
        (data.productionModel.assetFamilies as unknown as Row[])
          .filter((item) => candidateFamilyIds.has(item.id))
          .sort((left, right) => String(left.id || '').localeCompare(String(right.id || ''))),
        state.assetFamiliesById,
      ).filter((item) => usageFamilyIds.has(item.id)||materialSecondaryScopeMatches(item, parsed.filters, episodeAliases, currentEpisodePlan));
      const familyIds = new Set(assetFamilies.map((item) => item.id));
      const baseVersions = overlay(
        (data.productionModel.assetVersions as unknown as Row[])
          .filter((item) => familyIds.has(String(item.familyId || ''))),
        state.assetVersionsById,
      ).filter((item) => usageVersionIds.has(item.id)||materialSecondaryScopeMatches(item, parsed.filters, episodeAliases, currentEpisodePlan));
      const baseVersionIds = new Set(baseVersions.map((item) => item.id));
      const projectedVersions = Object.entries(state.assetVersionsById)
        .map(([id, item]) => item ? { ...item, id: String(item.id || id) } as Row : null)
        .filter((item): item is Row => Boolean(
          item
          && !baseVersionIds.has(item.id)
          && familyIds.has(String(item.familyId || ''))
          && (usageVersionIds.has(item.id)||materialSecondaryScopeMatches(item, parsed.filters, episodeAliases, currentEpisodePlan)),
        ));
      const assetVersions = [...baseVersions, ...projectedVersions].sort((left, right) => String(left.id || '').localeCompare(String(right.id || '')));
      const expectedOutputs = overlay(
        ((data.productionModel.expectedOutputs || []) as unknown as Row[])
          .filter((item) => familyIds.has(String(item.familyId || '')))
          .sort((left, right) => String(left.id || '').localeCompare(String(right.id || ''))),
        state.expectedOutputsById,
      ).filter((item) => materialSecondaryScopeMatches(item, parsed.filters, episodeAliases, currentEpisodePlan));
      const hasMore = parsed.offset + count < primary.length;
      return {
        schemaVersion: '1.0',
        snapshotId: data.snapshotId,
        operationRevision: operations.operationRevision,
        appliedMode: 'requirements',
        page: { materialRequirements, materialWorkItems, assetFamilies, assetVersions, expectedOutputs },
        count,
        total: primary.length,
        atomicTotal: primary.filter(row=>atomicIds.has(row.id)).length,
        aggregateTotal: primary.filter(row=>currentIds.has(row.id)&&(row.currentDisposition==='CURRENT_AGGREGATE' || row.composition)).length,
        nextCursor: hasMore ? encodeUiCursor('materials:requirements', data.snapshotId, parsed.filterHash, parsed.offset + count) : null,
        hasMore,
        appliedFilters: parsed.filters,
      };
    };

    let count = Math.min(parsed.limit, primary.length - parsed.offset);
    let payload = buildPage(count);
    while (jsonByteLength(payload) > UI_PAGE_MAX_BYTES && count > 1) {
      count -= 1;
      payload = buildPage(count);
    }
    if (jsonByteLength(payload) > UI_PAGE_MAX_BYTES) {
      throw new HttpError(413, 'one material page item exceeds the 2 MiB response budget');
    }
    if(detailUrl.searchParams.get('detail')==='summary') payload=summarizeMaterialPage(payload);
    return jsonResponse({...payload,detailState:detailUrl.searchParams.get('detail')==='summary'?'SUMMARY':'COMPLETE'}, { headers: { ETag: operations.etag } });
  } catch (reason) {
    return errorResponse(reason, 'material page failed to load');
  }
}
