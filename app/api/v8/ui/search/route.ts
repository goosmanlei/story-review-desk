import {currentMaterialRequirementRows} from '../../../../../host/instance-runtime/material-requirement-disposition.mjs';
import { resolveEpisodePlan } from '../../_episode-plan';
import {domainOwnership} from '../../../../../host/instance-runtime/domain-ownership.mjs';
import {emptyDomainGraph} from '../../../../../host/instance-runtime/domain-model.mjs';
import { errorResponse, HttpError, jsonResponse, operationalSnapshot, reviewData, sceneReviewDossierTargets } from '../../_store';

export type SearchResult = {
  kind: '故事设定' | '设定关系' | '故事' | '逐字稿' | '故事梗概' | '原文审计' | '因果链' | '空间证据' | '剧本正文' | '分集导航' | '场景包' | '结构卡' | '制作影响' | '素材需求' | '素材' | '资产族' | '镜头' | '目标' | '问题' | '任务' | '后期任务';
  id: string;
  title: string;
  view: 'overview' | 'story' | 'settings' | 'pipeline' | 'materials';
  storyView?: 'source' | 'story-structure' | 'audit' | 'logic';
  structureSection?: 'overview' | 'spine' | 'characters' | 'truth-route' | 'audience' | 'space';
  materialMode?: 'classification' | 'episodes';
  sectionId?: string;
  sceneId?: string;
  episodeId?: string;
  episodeUid?: string;
  episodePlanRevision?: string;
  canonicalScopeId?: string;
  scopeType?: string;
  scopeId?: string;
  episodeIdentityState?: 'CURRENT' | 'CANDIDATE' | 'HISTORICAL_DISPLAY_ONLY';
  anchorId?: string;
  auditBeatId?: string;
  causeChainId?: string;
  mapLocationId?: string;
  structureSceneId?: string;
  actionLabel?: string;
  group?: 'business' | 'evidence' | 'legacy';
  matchTier?: 'exact' | 'prefix' | 'relation' | 'fulltext';
};

type EpisodeRouteRecord = {
  id: string;
  displayId?: string;
  episodeUid?: string;
  canonicalScopeId?: string;
};

type SearchShotRecord = {
  id: string;
  scopeRole?: string;
  activeInCurrentProduction?: boolean;
  shotPlanSetRevisionId?: string;
  shotPlanSetRevisionHash?: string;
};

type RuntimeShotProjection = {
  shotPlanCurrentBindingState?: string;
  activeInCurrentProduction?: boolean;
  scopeRole?: string;
};

export function isFormalCurrentSearchShot(
  shot: SearchShotRecord,
  runtimeShot: RuntimeShotProjection | null | undefined,
) {
  return shot.scopeRole === 'CURRENT'
    && shot.activeInCurrentProduction === true
    && typeof shot.shotPlanSetRevisionId === 'string'
    && Boolean(shot.shotPlanSetRevisionId)
    && typeof shot.shotPlanSetRevisionHash === 'string'
    && /^[a-f0-9]{64}$/.test(shot.shotPlanSetRevisionHash)
    && runtimeShot?.shotPlanCurrentBindingState === 'CURRENT'
    && runtimeShot.activeInCurrentProduction === true
    && runtimeShot.scopeRole === 'CURRENT';
}

type Block = { id: string; text?: string; speaker?: string; performanceNote?: string | null; items?: string[]; headers?: string[]; rows?: string[][] };
type Scene = { id: string; slugline: string; scriptText?: string; scriptBlocks?: Block[]; packageId?: string; primaryLocation?: string; zone?: string; route?: string; keyPropsAndState?: string; continuity?: string; characters?: Array<{ name?: string }> };

function blockText(block: Block) {
  return [block.speaker, block.performanceNote, block.text, ...(block.items ?? []), ...(block.headers ?? []), ...(block.rows ?? []).flat()].filter(Boolean).join(' ');
}

function includes(value: unknown, needle: string) {
  const haystack = JSON.stringify(value).toLocaleLowerCase();
  if (!/^[a-z]+(?:-[a-z0-9]+)+$|^[es]\d{2}$/i.test(needle)) return haystack.includes(needle);
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}(?![a-z0-9])`, 'i').test(haystack);
}

export function guardSearchEpisodeIdentity(
  result: SearchResult,
  episodes: EpisodeRouteRecord[],
  currentEpisodePlan: boolean,
): SearchResult {
  if (!currentEpisodePlan) return result;
  const stableIdentities = [
    result.episodeUid,
    result.canonicalScopeId,
    result.scopeType === 'EPISODE' ? result.scopeId : undefined,
  ].filter((value): value is string => typeof value === 'string' && Boolean(value));
  const episode = episodes.find((item) => stableIdentities.some((identity) => (
    identity === item.episodeUid || identity === item.canonicalScopeId
  )));
  if (episode) {
    return {
      ...result,
      episodeUid: episode.canonicalScopeId || episode.episodeUid,
      episodeIdentityState: 'CURRENT',
    };
  }
  const withoutUnverifiedUid = { ...result, episodeUid: undefined };
  return result.episodeId || stableIdentities.length > 0
    ? { ...withoutUnverifiedUid, episodeIdentityState: 'HISTORICAL_DISPLAY_ONLY' }
    : withoutUnverifiedUid;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const query = url.searchParams.get('q')?.trim() ?? '';
    if (!query || query.length > 120) throw new HttpError(400, 'q is invalid');
    const requestedLimit = Number(url.searchParams.get('limit') ?? '12');
    const limit = Number.isFinite(requestedLimit) ? Math.min(30, Math.max(1, Math.trunc(requestedLimit))) : 12;
    const needle = query.toLocaleLowerCase();
    const [rawData, operations] = await Promise.all([reviewData(), operationalSnapshot()]);
    const data = rawData as unknown as {
      schemaVersion: string;
      snapshotId: string;
      storySources: {
        transcript: { segments: Array<{ id: string; sectionId: string; timecode: string; text: string }> };
        outline: { blocks: Block[] };
      };
      creativeLineage: {
        scenes: Scene[];
        episodes: Array<{ id: string; displayId?: string; episodeUid?: string; canonicalScopeId?: string; sceneStart: string; sceneEnd: string; sceneCount: number; sceneIds: string[]; acts: string[] }>;
        storyStructure: { planStatus?: string; sequences: Array<{ id: string; sceneStart: string; sceneEnd: string; title: { text: string }; [key: string]: unknown }> };
        causalChains?: Array<{ id: string; title: string; setupBeatIds: string[]; payoffBeatIds: string[]; setupSceneIds: string[]; payoffSceneIds: string[]; status: string; mustPreserve: string; sourceRef: string }>;
        spatialEvidence?: {
          mapCards: Array<{ id: string; locationIds: string[]; label: string; note: string }>;
          locations: Array<{ id: string; name: string; fact: string; lock: string; [key: string]: unknown }>;
          locationPackages: Array<{ id: string; name: string; factBoundary: string; lockBoundary: string; zones: unknown[]; cameras: unknown[] }>;
          sceneRouteLocks: Array<{ sceneId: string; locationIds: string[]; orderedZones: string[]; [key: string]: unknown }>;
        };
      };
      adaptationAudit?: {
        beats?: Array<{ beat_id: string; summary: string; source_kind?: string[]; current_mapping?: { scene_ids?: string[]; [key: string]: unknown }; adaptation_decision?: { target_scene_ids?: string[]; [key: string]: unknown }; [key: string]: unknown }>;
        productionImpacts?: Array<{ impact_id: string; scene_ids?: string[]; trigger_beat_ids?: string[]; change_type?: string; [key: string]: unknown }>;
      };
      visualAssets: Array<{ id: string; title: string; [key: string]: unknown }>;
      audioAssets: Array<{ id: string; title: string; [key: string]: unknown }>;
      workItems: Array<{ id: string; title: string; sceneId?: string; episodeId?: string; episodeUid?: string; canonicalScopeId?: string; scopeType?: string; scopeId?: string; [key: string]: unknown }>;
      productionModel: {
        counts?: { currentP07ShotPlans?: number; currentShotSpecCount?: number };
        assetFamilies: Array<{ id: string; label: string; kind: string; subtype: string; versionRefs: string[]; [key: string]: unknown }>;
        assetVersions: Array<{ id: string; familyId: string; outputState?: string | null; historyRole?: string | null; [key: string]: unknown }>;
        materialRequirements?: Array<{ id: string; title: string; category: string; assetFamilyRefs: string[]; [key: string]: unknown }>;
        structureCards?: Array<{ id: string; sceneId: string; episodeId: string; sourceContent: string; [key: string]: unknown }>;
        shots: Array<{ id: string; title: string; sceneId: string; episodeId?: string; episodeUid?: string; scopeRole?: string; activeInCurrentProduction?: boolean; shotPlanSetRevisionId?: string; shotPlanSetRevisionHash?: string; [key: string]: unknown }>;
        issues?: Array<{ id: string; title: string; sceneIds?: string[]; episodeIds?: string[]; episodeUid?: string; episodeUids?: string[]; canonicalScopeId?: string; scopeType?: string; scopeId?: string; [key: string]: unknown }>;
        executionRecipeSummary?: { postProductionTasks?: Array<{ id: string; label: string; sceneId?: string; episodeId?: string; episodeUid?: string; canonicalScopeId?: string; scopeType?: string; scopeId?: string; [key: string]: unknown }> };
      };
    };
    if (operations.snapshotId !== data.snapshotId) {
      throw new HttpError(503, 'search base snapshot changed while runtime state was assembled');
    }
    const runtimeShotsById = operations.stateProjection.shotsById as unknown as Record<
      string,
      RuntimeShotProjection | undefined
    >;
    const narrativePlan = resolveEpisodePlan(rawData, operations);
    const narrative = narrativePlan?.content.narrativeRevision;
    if (!narrative && /^e\d{2}$/i.test(needle) && !data.creativeLineage.episodes.some((episode) => episode.id.toLocaleLowerCase() === needle)) {
      return jsonResponse({ schemaVersion: data.schemaVersion, snapshotId: data.snapshotId, query, total: 0, data: [] });
    }
    const results: SearchResult[] = [];
    const domainModel=rawData.productionModel as typeof rawData.productionModel&{domainOwnership?:Record<string,unknown>};
    const graph=domainModel.domainGraph||emptyDomainGraph(),ownership=domainOwnership(graph,domainModel.systemConfiguration?.config?.domain,domainModel.domainOwnership||{});
    for(const entity of graph.entities)if(ownership['entities:'+entity.id]?.owner!=='MATERIAL'&&includes(entity,needle))results.push({kind:entity.type==='LOCATION'?'空间证据':'故事设定',id:entity.id,title:entity.name,view:'settings'});
    for(const relation of graph.relations)if(ownership['relations:'+relation.id]?.owner==='SETTINGS'&&includes(relation,needle))results.push({kind:'设定关系',id:relation.id,title:relation.label,view:'settings'});
    const currentEpisodePlan = data.creativeLineage.storyStructure.planStatus === 'CURRENT';
    const currentEpisodeUids = new Set(data.creativeLineage.episodes.flatMap((episode) => (
      [episode.canonicalScopeId, episode.episodeUid]
        .filter((value): value is string => typeof value === 'string' && Boolean(value))
    )));
    const formalCurrentShot = (shot: (typeof data.productionModel.shots)[number]) => (
      isFormalCurrentSearchShot(shot, runtimeShotsById[shot.id])
      && (!currentEpisodePlan || (
        typeof shot.episodeUid === 'string'
        && currentEpisodeUids.has(shot.episodeUid)
      ))
    );
    const directSceneIdsByBeat = new Map<string, string[]>();
    for (const dossier of sceneReviewDossierTargets(rawData)) {
      for (const beatId of dossier.directBeatIds) {
        const owners = directSceneIdsByBeat.get(beatId) || [];
        if (!owners.includes(dossier.sceneId)) owners.push(dossier.sceneId);
        directSceneIdsByBeat.set(beatId, owners);
      }
    }
    const transcriptById = new Map(data.storySources.transcript.segments.map((segment) => [segment.id, segment]));
    const currentShotSceneIds = new Set(data.productionModel.shots.filter(formalCurrentShot).map((shot) => shot.sceneId));
    for (const item of data.storySources.transcript.segments) {
      if (`${item.timecode} ${item.text}`.toLocaleLowerCase().includes(needle)) results.push({ kind: '逐字稿', id: item.id, title: `${item.timecode} · ${item.text.slice(0, 52)}${item.text.length > 52 ? '…' : ''}`, view: 'story', storyView: 'source', sectionId: item.sectionId, anchorId: item.id });
    }
    for (const block of data.storySources.outline.blocks) {
      const text = blockText(block);
      if (text.toLocaleLowerCase().includes(needle)) results.push({ kind: '故事梗概', id: block.id, title: `网友故事梗概 · ${text.slice(0, 52)}`, view: 'story', storyView: 'source', anchorId: block.id });
    }
    if (narrative && narrativePlan) {
      for (const scene of narrative.scenes) {
        if (includes({displayId:scene.displayId,title:scene.title,slugline:scene.slugline,storyTime:scene.storyTime,viewpoint:scene.viewpoint,purpose:scene.purpose,audienceKnown:scene.audienceKnown,audienceWithheld:scene.audienceWithheld,transition:scene.transition,scriptBlocks:scene.scriptBlocks,runtime:scene.runtime}, needle)) results.push({kind: '剧本正文', id: scene.id, title: `${scene.displayId} ${scene.title}`, view: 'story', storyView: 'audit', sceneId: scene.id, episodePlanRevision:narrativePlan.revisionId});
      }
      for (const episode of narrativePlan.content.episodes) {
        if (includes(episode, needle)) results.push({kind:'分集导航', id:episode.episodeUid, title:`${episode.displayId} ${episode.title}`, view:'story', storyView:'logic', episodeId:episode.displayId, episodeUid:episode.episodeUid, sceneId:episode.sceneIds[0], episodePlanRevision:narrativePlan.revisionId});
      }
    }
    for (const scene of narrative ? [] : data.creativeLineage.scenes) {
      for (const block of scene.scriptBlocks ?? []) {
        const text = blockText(block);
        if (text.toLocaleLowerCase().includes(needle)) results.push({ kind: '剧本正文', id: scene.id, title: `${scene.id} ${scene.slugline} · ${block.speaker ? `${block.speaker}：` : ''}${text.slice(0, 48)}`, view: 'story', storyView: 'audit', sceneId: scene.id, anchorId: block.id });
      }
      const lineageText = [scene.id, scene.slugline, scene.packageId, scene.primaryLocation, scene.zone, scene.route, scene.keyPropsAndState, scene.continuity, ...(scene.characters ?? []).map((item) => item.name)].filter(Boolean).join(' ');
      if (lineageText.toLocaleLowerCase().includes(needle)) {
        results.push({ kind: '剧本正文', id: scene.id, title: `${scene.id} · ${scene.slugline}`, view: 'story', storyView: 'audit', sceneId: scene.id });
        if (currentShotSceneIds.has(scene.id)) {
          results.push({ kind: '场景包', id: scene.id, title: `${scene.slugline} · ${scene.packageId ?? ''}`, view: 'pipeline', sceneId: scene.id, actionLabel: '进入本场制作链路', group: 'business' });
        }
      }
    }
    for (const episode of narrative ? [] : data.creativeLineage.episodes) {
      if (`${episode.id} ${episode.sceneStart} ${episode.sceneEnd} ${episode.acts.join(' ')}`.toLocaleLowerCase().includes(needle)) results.push({ kind: '分集导航', id: episode.id, title: `${episode.id} · ${episode.sceneStart}–${episode.sceneEnd} · ${episode.sceneCount}场`, view: 'story', storyView: 'logic', episodeId: episode.displayId || episode.id, episodeUid: episode.episodeUid, sceneId: episode.sceneIds[0] });
    }
    for (const sequence of narrative ? [] : data.creativeLineage.storyStructure.sequences) {
      if (includes(sequence, needle)) results.push({ kind: '故事', id: sequence.id, title: `${sequence.id} · ${sequence.sceneStart}–${sequence.sceneEnd} · ${sequence.title.text}`, view: 'story', storyView: 'story-structure', structureSection: 'spine' });
    }
    for (const beat of narrative ? [] : data.adaptationAudit?.beats ?? []) {
      if (!includes(beat, needle)) continue;
      const mappedSceneId = beat.current_mapping?.scene_ids?.[0] || beat.adaptation_decision?.target_scene_ids?.[0];
      const directSceneIds = directSceneIdsByBeat.get(beat.beat_id) || [];
      const sceneId = mappedSceneId || (directSceneIds.length === 1 ? directSceneIds[0] : undefined);
      const transcript = transcriptById.get(beat.beat_id);
      results.push(sceneId
        ? { kind: '原文审计', id: beat.beat_id, title: `${beat.beat_id} · ${beat.summary}`, view: 'story', storyView: 'audit', auditBeatId: beat.beat_id, sceneId }
        : { kind: '原文审计', id: beat.beat_id, title: `${beat.beat_id} · ${beat.summary}`, view: 'story', storyView: 'source', auditBeatId: beat.beat_id, sectionId: transcript?.sectionId, anchorId: transcript?.id, actionLabel: '定位来源资料并回听' });
    }
    for (const chain of narrative?.causalChains || data.creativeLineage.causalChains || []) {
      if (includes(chain, needle)) results.push({ kind: '因果链', id: chain.id, title: `${chain.id} · ${chain.title}`, view: 'story', storyView: 'story-structure', structureSection: 'audience', causeChainId: chain.id, sceneId: chain.setupSceneIds[0] || chain.payoffSceneIds[0] });
    }
    const spatial = data.creativeLineage.spatialEvidence;
    for (const location of narrative ? [] : spatial?.locations ?? []) {
      const locationPackage = spatial?.locationPackages.find((item) => item.id === location.id);
      const relatedMaps = spatial?.mapCards.filter((card) => card.locationIds.includes(location.id)) ?? [];
      const relatedRoutes = spatial?.sceneRouteLocks.filter((route) => route.locationIds.includes(location.id)) ?? [];
      if (includes({ location, locationPackage, relatedMaps, relatedRoutes }, needle)) results.push({ kind: '空间证据', id: location.id, title: `${location.id} · ${location.name}`, view: 'story', storyView: 'story-structure', structureSection: 'space', mapLocationId: location.id, sceneId: relatedRoutes[0]?.sceneId });
    }
    for (const impact of narrative ? [] : data.adaptationAudit?.productionImpacts ?? []) {
      if (includes(impact, needle)) results.push({ kind: '制作影响', id: impact.impact_id, title: `${impact.impact_id} · ${impact.change_type || '原文改编下游影响'}`, view: 'story', storyView: 'audit', auditBeatId: impact.trigger_beat_ids?.[0], sceneId: impact.scene_ids?.[0] });
    }
    for (const item of currentMaterialRequirementRows(data.productionModel)) {
      if (item.requirementClass !== 'REQUIRED') continue;
      const families = data.productionModel.assetFamilies.filter((family) => item.assetFamilyRefs.includes(family.id));
      const familyIds = new Set(families.map((family) => family.id));
      const versions = data.productionModel.assetVersions.filter((version) => (
        familyIds.has(version.familyId)
        && version.outputState !== 'DELETED'
        && version.historyRole !== 'DELETED_AUDIT'
      ));
      const cardSpec = item.cardSpec && typeof item.cardSpec === 'object' && !Array.isArray(item.cardSpec)
        ? item.cardSpec as Record<string, unknown>
        : null;
      const cardTitle = cardSpec?.role === 'INSTANCE'
        ? `${String(cardSpec.displayName || '人物 UNKNOWN')} · ${String(cardSpec.contextLine || '信息 UNKNOWN')} · ${cardSpec.triggerKind === 'FIRST_CLEAR_APPEARANCE' ? '首次清晰出场' : '场内背景补充'}`
        : null;
      if (includes({ item, families, versions }, needle) || (cardTitle && includes(cardTitle, needle))) {
        results.push({
          kind: '素材需求',
          id: item.id,
          title: cardTitle || `${item.title} · ${item.category}`,
          view: 'materials',
          materialMode: 'classification',
          anchorId: item.id,
        });
      }
    }
    for (const item of data.productionModel.shots) {
      const current = formalCurrentShot(item);
      if (current && includes(item, needle)) {
        results.push({
          kind: '镜头',
          id: item.id,
          title: `${item.title} · ${item.sceneId} · 当前正式ShotSpec，待输入锁定`,
          view: 'pipeline',
          sceneId: item.sceneId,
          episodeId: item.episodeId,
          episodeUid: item.episodeUid,
          actionLabel: '打开本镜输入锁定',
          group: 'business',
        });
      }
    }
    for (const item of data.productionModel.issues ?? []) {
      if (includes(item, needle)) results.push({ kind: '问题', id: item.id, title: item.title, view: 'overview', sceneId: item.sceneIds?.[0], episodeId: item.episodeIds?.[0], episodeUid: item.episodeUid || item.episodeUids?.[0], canonicalScopeId: item.canonicalScopeId, scopeType: item.scopeType, scopeId: item.scopeId });
    }
    for (const item of data.workItems) {
      if (includes(item, needle)) results.push({ kind: '任务', id: item.id, title: item.title, view: 'overview', sceneId: item.sceneId, episodeId: item.episodeId, episodeUid: item.episodeUid, canonicalScopeId: item.canonicalScopeId, scopeType: item.scopeType, scopeId: item.scopeId });
    }
    for (const item of data.productionModel.executionRecipeSummary?.postProductionTasks ?? []) {
      if (includes(item, needle)) results.push({ kind: '后期任务', id: item.id, title: item.label, view: 'overview', sceneId: item.sceneId, episodeId: item.episodeId, episodeUid: item.episodeUid, canonicalScopeId: item.canonicalScopeId, scopeType: item.scopeType, scopeId: item.scopeId });
    }
    const actionLabels: Record<SearchResult['kind'], string> = {
      故事设定:'查看主体档案',设定关系:'查看设定关系',
      故事: '查看故事结构', 逐字稿: '定位原文并回听', 故事梗概: '定位辅助梗概', 原文审计: '打开场级拆解', 因果链: '查看观众叙事与线索', 空间证据: '查看故事空间关系', 剧本正文: '打开本场创作档案', 分集导航: '在叙事拆解审阅本集', 场景包: '进入本场制作链路', 结构卡: '查看历史结构证据', 制作影响: '回到触发原文', 素材需求: '打开素材信息卡', 素材: '打开素材信息卡', 资产族: '查看素材内版本', 镜头: '打开本镜阶段门禁', 目标: '查看本场制作范围', 问题: '转到异常与交接', 任务: '转到异常与交接', 后期任务: '转到异常与交接',
    };
    const evidenceKinds = new Set<SearchResult['kind']>(['故事', '逐字稿', '故事梗概', '原文审计', '因果链', '空间证据', '剧本正文', '分集导航', '制作影响']);
    const decorated = results.map((result) => {
      const id = result.id.toLocaleLowerCase();
      const title = result.title.toLocaleLowerCase();
      const matchTier: SearchResult['matchTier'] = id === needle
        ? 'exact'
        : id.startsWith(needle)
          ? 'prefix'
          : title.includes(needle)
            ? 'relation'
            : 'fulltext';
      const group: SearchResult['group'] = result.group || (result.kind === '素材' ? 'legacy' : evidenceKinds.has(result.kind) ? 'evidence' : 'business');
      const identityGuarded: SearchResult = result.episodePlanRevision === narrativePlan?.revisionId ? {...result, episodeIdentityState:'CANDIDATE'} : guardSearchEpisodeIdentity(result, data.creativeLineage.episodes, currentEpisodePlan);
      const baseActionLabel = result.actionLabel || actionLabels[result.kind];
      const actionLabel = identityGuarded.episodeIdentityState === 'HISTORICAL_DISPLAY_ONLY'
        ? `${baseActionLabel}（分集位置仅作历史证据）`
        : baseActionLabel;
      return { ...identityGuarded, actionLabel, group, matchTier };
    });
    const tierRank = { exact: 0, prefix: 1, relation: 2, fulltext: 3 } as const;
    const groupRank = { business: 0, evidence: 1, legacy: 2 } as const;
    const seen = new Set<string>();
    const ranked = decorated
      .sort((left, right) => tierRank[left.matchTier || 'fulltext'] - tierRank[right.matchTier || 'fulltext'] || groupRank[left.group || 'business'] - groupRank[right.group || 'business'] || left.id.localeCompare(right.id))
      .filter((result) => {
        const key = [result.kind, result.id, result.anchorId || ''].join(':');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    return jsonResponse({ schemaVersion: data.schemaVersion, snapshotId: data.snapshotId, query, total: ranked.length, data: ranked.slice(0, limit) });
  } catch (reason) {
    return errorResponse(reason, 'review UI search failed');
  }
}
