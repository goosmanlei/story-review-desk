import {committedWorkspaceGet} from '../../../instance/_committed-get';
import {instanceRepository,hostedReadOnlyMode} from '../../_store';
import { projectIdFor } from '../../../../instance-profile';
import {productionDirectory} from '../../_production-directory';
import { normalizeEmptyProductionFilters } from '../../../../../host/instance-runtime/snapshot-contract.mjs';
import { errorResponse, HttpError, jsonResponse, operationalSnapshot, reviewData } from '../../_store';
import {
  assertCursorOffset,
  encodeUiCursor,
  jsonByteLength,
  parseUiPageRequest,
  UI_PAGE_MAX_BYTES,
  type UiPageFilters,
} from '../_pagination';

type Row = Record<string, unknown> & { id: string };

export function productionEpisodeAliases(
  requestedScopeId: string | undefined,
  requestedEpisode: Row | null | undefined,
  currentEpisodePlan: boolean,
) {
  const candidates = currentEpisodePlan || requestedEpisode?.identityMode==='PERMANENT_ONLY'
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

export function productionScopeMatches(
  row: Row,
  filters: UiPageFilters,
  episodeAliases: Set<string>,
  currentEpisodePlan: boolean,
) {
  if (!filters.scopeType || !filters.scopeId || filters.scopeType === 'PROJECT') return true;
  if (filters.scopeType === 'EPISODE') {
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
  if (row.scopeType === filters.scopeType && row.scopeId === filters.scopeId) return true;
  if (filters.scopeType === 'SCENE') return row.sceneId === filters.scopeId;
  return row.shotId === filters.scopeId;
}

export function productionSecondaryScopeMatches(
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
    || coordinateRows.some((coordinate) => productionScopeMatches(coordinate, filters, episodeAliases, true));
}

function validateFilters(data: Awaited<ReturnType<typeof reviewData>>, filters: UiPageFilters, directory:ReturnType<typeof productionDirectory>) {
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
      ? directory.episodes.some((item) => (
          currentEpisodePlan || item.identityMode==='PERMANENT_ONLY'
            ? [item.canonicalScopeId, item.episodeUid].includes(scopeId)
            : [item.canonicalScopeId, item.episodeUid, item.id, item.displayId].includes(scopeId)
        ))
      : filters.scopeType === 'SCENE'
        ? directory.scenes.some((item) => item.id === scopeId)
        : data.productionModel.shots?.some((item) => item.id === scopeId);
  if (!exists) throw new HttpError(422, 'scope does not resolve in the current production graph');
}

function overlay(rows: Row[], projection: Record<string, Row | undefined>) {
  return rows.map((row) => ({ ...row, ...(projection[row.id] || {}) }));
}

async function readResponse(request: Request) {
  try {
    const [data, operations] = await Promise.all([reviewData(), operationalSnapshot()]);
    if (operations.snapshotId !== data.snapshotId) throw new HttpError(409, 'production projection snapshot changed during read');
    const parsed = parseUiPageRequest(request, 'production', data.snapshotId, (filters) => normalizeEmptyProductionFilters(data, filters));
    const directory=productionDirectory(data,operations.creativeRevisions.events);
    validateFilters(data, parsed.filters,directory);
    const requestedScopeId = parsed.filters.scopeId || undefined;
    const currentEpisodePlan = data.creativeLineage?.storyStructure?.planStatus === 'CURRENT';
    const requestedEpisode = parsed.filters.scopeType === 'EPISODE'
      ? directory.episodes.find((item) => (
          currentEpisodePlan || item.identityMode==='PERMANENT_ONLY'
            ? [item.canonicalScopeId, item.episodeUid].includes(requestedScopeId)
            : [item.canonicalScopeId, item.episodeUid, item.id, item.displayId].includes(requestedScopeId)
        ))
      : null;
    const episodeAliases = productionEpisodeAliases(requestedScopeId, requestedEpisode as Row | null, currentEpisodePlan);
    const state = operations.stateProjection as unknown as {
      workItemsById: Record<string, Row | undefined>;
      workPackagesById: Record<string, Row | undefined>;
      assetFamiliesById: Record<string, Row | undefined>;
      assetVersionsById: Record<string, Row | undefined>;
      expectedOutputsById: Record<string, Row | undefined>;
      shotsById: Record<string, Row | undefined>;
    };
    const primary = (data.productionModel.workItems as unknown as Row[])
      .filter((item) => !['PLANNING_SKELETON','MATERIAL_COMPATIBILITY','HISTORICAL_EVIDENCE'].includes(String(item.activityRole)) && item.activeInCurrentProduction !== false && item.historyRole !== 'EVIDENCE_ONLY' && item.templateOnly !== true)
      .filter((item) => !parsed.filters.phaseId || item.phaseId === parsed.filters.phaseId)
      .filter((item) => !parsed.filters.gateId || item.gateId === parsed.filters.gateId)
      .filter((item) => productionScopeMatches(item, parsed.filters, episodeAliases, currentEpisodePlan))
      .sort((left, right) => String(left.id || '').localeCompare(String(right.id || '')));
    assertCursorOffset(parsed.offset, primary.length);

    const buildPage = (count: number) => {
      const workItems = overlay(primary.slice(parsed.offset, parsed.offset + count), state.workItemsById);
      const workItemIds = new Set(workItems.map((item) => item.id));
      const workPackages = overlay(
        (data.productionModel.workPackages as unknown as Row[])
          .filter((item) => Array.isArray(item.workItemRefs) && item.workItemRefs.some((id) => workItemIds.has(String(id))))
          .sort((left, right) => String(left.id || '').localeCompare(String(right.id || ''))),
        state.workPackagesById,
      ).filter((item) => productionSecondaryScopeMatches(item, parsed.filters, episodeAliases, currentEpisodePlan));
      const candidateFamilyIds = new Set(workItems.flatMap((item) => [
        ...(typeof item.outputAssetRef === 'string' ? [item.outputAssetRef] : []),
        ...(Array.isArray(item.additionalOutputAssetRefs) ? item.additionalOutputAssetRefs.map(String) : []),
        ...(Array.isArray(item.inputAssetRefs) ? item.inputAssetRefs.map(String) : []),
      ]));
      const assetFamilies = overlay(
        (data.productionModel.assetFamilies as unknown as Row[])
          .filter((item) => candidateFamilyIds.has(item.id))
          .sort((left, right) => String(left.id || '').localeCompare(String(right.id || ''))),
        state.assetFamiliesById,
      ).filter((item) => productionSecondaryScopeMatches(item, parsed.filters, episodeAliases, currentEpisodePlan));
      const familyIds = new Set(assetFamilies.map((item) => item.id));
      const baseVersions = overlay(
        (data.productionModel.assetVersions as unknown as Row[])
          .filter((item) => familyIds.has(String(item.familyId || ''))),
        state.assetVersionsById,
      ).filter((item) => productionSecondaryScopeMatches(item, parsed.filters, episodeAliases, currentEpisodePlan));
      const baseVersionIds = new Set(baseVersions.map((item) => item.id));
      const projectedVersions = Object.entries(state.assetVersionsById)
        .map(([id, item]) => item ? { ...item, id: String(item.id || id) } as Row : null)
        .filter((item): item is Row => Boolean(
          item
          && !baseVersionIds.has(item.id)
          && familyIds.has(String(item.familyId || ''))
          && productionSecondaryScopeMatches(item, parsed.filters, episodeAliases, currentEpisodePlan),
        ));
      const assetVersions = [...baseVersions, ...projectedVersions].sort((left, right) => String(left.id || '').localeCompare(String(right.id || '')));
      const expectedOutputs = overlay(
        ((data.productionModel.expectedOutputs || []) as unknown as Row[])
          .filter((item) => familyIds.has(String(item.familyId || '')))
          .sort((left, right) => String(left.id || '').localeCompare(String(right.id || ''))),
        state.expectedOutputsById,
      ).filter((item) => productionSecondaryScopeMatches(item, parsed.filters, episodeAliases, currentEpisodePlan));
      const reviewContextIds = new Set([
        ...workItems.map((item) => item.reviewContextRef),
        ...workPackages.map((item) => item.reviewContextRef),
      ].filter((id): id is string => typeof id === 'string' && Boolean(id)));
      const reviewContexts = ((data.productionModel.reviewContexts || []) as unknown as Row[])
        .filter((item) => reviewContextIds.has(item.id))
        .filter((item) => productionSecondaryScopeMatches(item, parsed.filters, episodeAliases, currentEpisodePlan))
        .sort((left, right) => String(left.id || '').localeCompare(String(right.id || '')));
      const shotIds = new Set([
        ...(parsed.filters.scopeType === 'SHOT' && parsed.filters.scopeId ? [parsed.filters.scopeId] : []),
        ...workItems.map((item) => item.shotId),
        ...workPackages.flatMap((item) => Array.isArray(item.shotIds) ? item.shotIds : []),
      ].filter((id): id is string => typeof id === 'string' && Boolean(id)));
      const shots = overlay(
        ((data.productionModel.shots || []) as unknown as Row[])
          .filter((item) => shotIds.has(item.id)),
        state.shotsById,
      )
        .filter((item) => productionSecondaryScopeMatches(item, parsed.filters, episodeAliases, currentEpisodePlan))
        .map((item) => ({
          id: item.id,
          sceneId: item.sceneId,
          episodeId: item.episodeId,
          episodeUid: item.episodeUid,
          title: item.title,
          sourceContent: item.sourceContent,
          durationSeconds: item.durationSeconds,
          durationStatus: item.durationStatus,
          locs: item.locs,
          zones: item.zones,
          cameras: item.cameras,
          sourceRef: item.sourceRef,
          issueRefs: item.issueRefs,
          branch: item.branch,
          scopeRole: item.scopeRole,
          activityRole: item.activityRole,
          activeInCurrentProduction: item.activeInCurrentProduction,
          shotPlanSetRevisionId: item.shotPlanSetRevisionId,
          shotPlanSetRevisionHash: item.shotPlanSetRevisionHash,
          shotPlanCurrentBindingState: item.shotPlanCurrentBindingState,
          storyHandoff: item.storyHandoff,
          workPackageRefs: item.workPackageRefs,
          defaultWorkPackageId: item.defaultWorkPackageId,
          lifecycleState: item.lifecycleState,
          canFlowDownstream: item.canFlowDownstream,
          flowBlockReasons: item.flowBlockReasons,
        }))
        .sort((left, right) => String(left.id || '').localeCompare(String(right.id || '')));
      const sceneIds = new Set([
        ...workItems.map((item) => item.sceneId),
        ...workPackages.map((item) => item.sceneId),
        ...shots.map((item) => item.sceneId),
      ].filter((id): id is string => typeof id === 'string' && Boolean(id)));
      const scenes = (directory.scenes as unknown as Row[])
        .filter((item) => sceneIds.has(item.id))
        .filter((item) => productionSecondaryScopeMatches(item, parsed.filters, episodeAliases, currentEpisodePlan))
        .map((item) => ({ id: item.id, episodeId: item.episodeId, episodeUid: item.episodeUid, canonicalScopeId: item.canonicalScopeId, title: item.title, shotIds: item.shotIds, scopeRole: item.scopeRole, activityRole: item.activityRole, storyHandoff: item.storyHandoff }))
        .sort((left, right) => String(left.id || '').localeCompare(String(right.id || '')));
      const episodeIds = new Set([
        ...workItems.map((item) => item.episodeId),
        ...workPackages.map((item) => item.episodeId),
        ...shots.map((item) => item.episodeId),
        ...scenes.map((item) => item.episodeId),
      ].filter((id): id is string => typeof id === 'string' && Boolean(id)));
      const episodes = (directory.episodes as unknown as Row[])
        .filter((item) => (
          currentEpisodePlan && parsed.filters.scopeType === 'EPISODE'
            ? productionSecondaryScopeMatches(item, parsed.filters, episodeAliases, true)
            : episodeIds.has(item.id)
        ))
        .map((item) => ({ id: item.id, displayId: item.displayId, episodeUid: item.episodeUid, canonicalScopeId: item.canonicalScopeId, sceneIds: item.sceneIds, scopeRole: item.scopeRole, activityRole: item.activityRole, storyHandoff: item.storyHandoff }))
        .sort((left, right) => String(left.id || '').localeCompare(String(right.id || '')));
      const hasMore = parsed.offset + count < primary.length;
      return {
        schemaVersion: '1.0',
        snapshotId: data.snapshotId,
        operationRevision: operations.operationRevision,
        page: { workItems, workPackages, assetFamilies, assetVersions, expectedOutputs, reviewContexts, shots, scenes, episodes },
        count,
        total: primary.length,
        nextCursor: hasMore ? encodeUiCursor('production', data.snapshotId, parsed.filterHash, parsed.offset + count) : null,
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
      throw new HttpError(413, 'one production page item exceeds the 2 MiB response budget');
    }
    return jsonResponse(payload, { headers: { ETag: operations.etag } });
  } catch (reason) {
    return errorResponse(reason, 'production page failed to load');
  }
}

export async function GET(request:Request) {
 try {
  const repo=hostedReadOnlyMode()?null:await instanceRepository();
  if(!repo)return readResponse(request);
  return await committedWorkspaceGet(repo,`production:${new URL(request.url).search}`,async()=>{const response=await readResponse(request);const value=await response.json() as {error?:string;message?:string};if(!response.ok)throw new HttpError(response.status,value.error||value.message||"读取失败");return value;},request);
 } catch(error){return errorResponse(error,"工作区读取失败");}
}
