'use client';


import {runtimePath} from './runtime-path';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { episodePlanIsCurrent, type MaterialRequirement, type ProductionModel } from './production-workbench';
import { classifiedMaterial, materialBusinessPrimaryOrder, materialBusinessSecondaryOrder, materialCategoryPresentation, type ClassifiedMaterial } from './material-taxonomy';
import { materialRequirementMatchesEpisode, materialRequirementVisibleInEpisodePlan } from './material-episode-scope';
import { publicRef, visibleText } from './review-semantics';

type WorldOverview = {
  recordKind: 'PRODUCTION_REFERENCE';
  businessCategoryPrimary: '场景';
  businessCategorySecondary: '空间证据';
  sourceRef: string;
  version: string;
  orientation: string;
  mapCards: Array<{ id: string; locationIds: string[]; label: string; imageUrl?: string; note?: string }>;
  locations: Array<{ id: string; name: string }>;
  locationPackages: Array<{ id: string; name: string; zones?: unknown[]; cameras?: unknown[] }>;
  sceneRouteLocks: Array<{ sceneId: string; locationIds?: string[]; orderedZones?: string[] }>;
};

type MaterialStoryRelationsModel = {
  currentShotState: 'UNKNOWN' | 'DECLARED';
  currentShotCount: number;
  historicalShotCount: number;
  pendingP07ReauthoringSceneCount: number;
  worldOverview: WorldOverview;
};

type Props = {
  model: ProductionModel;
  requirements: MaterialRequirement[];
  selectedRequirementId: string | null;
  episodeScope: string;
  sceneScope: string;
  onSelectRequirement: (requirement: MaterialRequirement) => void;
  onSelectSceneScope: (episodeId: string, sceneId: string) => void;
  onOpenStoryScene: (sceneId: string) => void;
  onOpenConsumer: (shotId: string) => void;
  inspector: ReactNode;
};

function relationModel(model: ProductionModel): MaterialStoryRelationsModel {
  const projected = (model as ProductionModel & { materialStoryRelations?: MaterialStoryRelationsModel }).materialStoryRelations;
  if (projected) return projected;
  const currentShotSpecCount = model.counts.currentShotSpecCount || 0;
  const currentShotCount = Math.max(currentShotSpecCount, model.counts.currentP07ShotPlans || 0);
  return {
    currentShotState: currentShotCount > 0 ? 'DECLARED' : 'UNKNOWN',
    currentShotCount,
    historicalShotCount: model.counts.historicalP07ShotIdentities || model.counts.shots,
    pendingP07ReauthoringSceneCount: model.counts.pendingP07ReauthoringScenes || model.counts.scenes,
    worldOverview: {
      recordKind: 'PRODUCTION_REFERENCE',
      businessCategoryPrimary: '场景',
      businessCategorySecondary: '空间证据',
      sourceRef: 'data/production_map_spec.json',
      version: 'UNKNOWN',
      orientation: '北上东右',
      mapCards: [],
      locations: [],
      locationPackages: [],
      sceneRouteLocks: [],
    },
  };
}

function characterCardSummary(requirement: MaterialRequirement) {
  const spec = requirement.cardSpec;
  if (!spec || spec.role !== 'INSTANCE') return null;
  return {
    displayName: spec.displayName,
    contextLine: spec.contextLine,
    triggerLabel: spec.triggerKind === 'FIRST_CLEAR_APPEARANCE' ? '首次清晰出场' : '场内背景补充',
    narrativeCue: spec.narrativeCue,
  };
}

type SceneMaterialEntry = {
  requirement: MaterialRequirement;
  classification: ClassifiedMaterial;
};

type SceneMaterialGroup = {
  primary: string;
  icon: string;
  tone: string;
  entries: SceneMaterialEntry[];
};

function classifyRequirement(requirement: MaterialRequirement) {
  return classifiedMaterial(requirement as unknown as Record<string, unknown> & { category: string; mediaKind: string; shotIds: string[] });
}

function materialCategoryRank(primary: string, secondary: string) {
  const primaryIndex = materialBusinessPrimaryOrder.findIndex((item) => item === primary);
  const secondaryOrder = materialBusinessSecondaryOrder[primary] || [];
  const secondaryIndex = secondaryOrder.findIndex((item) => item === secondary);
  return [
    primaryIndex < 0 ? materialBusinessPrimaryOrder.length : primaryIndex,
    secondaryIndex < 0 ? secondaryOrder.length : secondaryIndex,
  ];
}

function groupSceneMaterials(requirements: MaterialRequirement[]): SceneMaterialGroup[] {
  const entries = requirements.map((requirement) => ({ requirement, classification: classifyRequirement(requirement) }));
  entries.sort((left, right) => {
    const lp=left.classification.presentation;const leftRank = lp?[lp.primaryOrder,lp.secondaryOrder]:materialCategoryRank(left.classification.businessCategoryPrimary,left.classification.businessCategorySecondary);
    const rp=right.classification.presentation;const rightRank = rp?[rp.primaryOrder,rp.secondaryOrder]:materialCategoryRank(right.classification.businessCategoryPrimary,right.classification.businessCategorySecondary);
    return leftRank[0] - rightRank[0]
      || leftRank[1] - rightRank[1]
      || visibleText(left.requirement.title).localeCompare(visibleText(right.requirement.title), 'zh-CN')
      || left.requirement.id.localeCompare(right.requirement.id, 'zh-CN');
  });

  const groups = new Map<string, SceneMaterialGroup>();
  for (const entry of entries) {
    const sourcePrimary = entry.classification.businessCategoryPrimary;
    const primary = !sourcePrimary || sourcePrimary === 'UNKNOWN' ? '分类待确认' : sourcePrimary;
    const presentation = entry.classification.presentation || materialCategoryPresentation[primary] || { icon: '❔', tone: 'unknown' };
    const group = groups.get(primary) || { primary, ...presentation, entries: [] };
    group.entries.push(entry);
    groups.set(primary, group);
  }
  return [...groups.values()];
}

export function MaterialStoryRelations({
  model,
  requirements,
  selectedRequirementId,
  episodeScope,
  sceneScope,
  onSelectRequirement,
  onSelectSceneScope,
  onOpenStoryScene,
  onOpenConsumer,
  inspector,
}: Props) {
  const relations = relationModel(model);
  const currentEpisodePlan = episodePlanIsCurrent(model);
  const scopedRequirements = useMemo(() => requirements.filter((requirement) => (
    materialRequirementVisibleInEpisodePlan(requirement, model.episodes, currentEpisodePlan)
  )), [currentEpisodePlan, model.episodes, requirements]);
  const selectedEpisode = model.episodes.find((item) => (
    item.id === episodeScope
    || item.displayId === episodeScope
    || item.episodeUid === episodeScope
    || item.canonicalScopeId === episodeScope
  ));
  const initialEpisodeId = episodeScope !== '全部' ? selectedEpisode?.id : model.episodes[0]?.id;
  const [expandedEpisodeIds, setExpandedEpisodeIds] = useState<string[]>(initialEpisodeId ? [initialEpisodeId] : []);
  const inspectorRef = useRef<HTMLElement | null>(null);
  const previousSelectionRef = useRef(selectedRequirementId);
  const requirementsByScene = useMemo(() => {
    const result = new Map<string, MaterialRequirement[]>();
    for (const requirement of scopedRequirements) {
      for (const sceneId of requirement.sceneIds) {
        result.set(sceneId, [...(result.get(sceneId) || []), requirement]);
      }
    }
    return result;
  }, [scopedRequirements]);

  useEffect(() => {
    if (previousSelectionRef.current === selectedRequirementId) return;
    previousSelectionRef.current = selectedRequirementId;
    if (window.matchMedia('(max-width: 1000px)').matches) {
      window.requestAnimationFrame(() => inspectorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    }
  }, [selectedRequirementId]);

  function toggleEpisode(episodeId: string) {
    setExpandedEpisodeIds((current) => current.includes(episodeId)
      ? current.filter((item) => item !== episodeId)
      : [...current, episodeId]);
  }

  return <section className="material-story-relations" aria-label="剧集视角管理">
    <header>
      <div>
        <small>STORY RELATIONS · EPISODE → SCENE → CURRENT SHOT</small>
        <h2>剧集视角管理</h2>
        <p>这里按集、场和当前有效镜头组织同一批素材需求；历史镜头坐标只作证据，不进入当前生产结构。</p>
      </div>
      <b>{relations.currentShotState === 'UNKNOWN' ? '当前镜 UNKNOWN' : `${relations.currentShotCount}个当前镜`}</b>
    </header>
    {relations.currentShotState === 'UNKNOWN' && <p className="v6-empty-note" role="status">
      当前粗分镜为 0；{relations.pendingP07ReauthoringSceneCount} 场等待正文确认后重新拆镜，未来镜数保持 UNKNOWN。历史 {relations.historicalShotCount} 个镜头坐标不作为当前消费者。
    </p>}
    <div className="material-relations-layout">
      <section className="material-relation-tree">
        <h3>集 → 场 → 当前镜</h3>
        {model.episodes.map((episode) => {
          const episodeRequirements = scopedRequirements.filter((item) => materialRequirementMatchesEpisode(item, episode, currentEpisodePlan));
          const expanded = expandedEpisodeIds.includes(episode.id);
          const panelId = `material-episode-${episode.id}`;
          return <section className="material-episode-group" key={episode.id}>
            <button type="button" className="material-episode-toggle" aria-expanded={expanded} aria-controls={panelId} onClick={() => toggleEpisode(episode.id)}><span><b>{episode.id}</b><small>{episode.sceneIds.length} 场 · {episodeRequirements.length} 项素材</small></span><i>{expanded ? '收起' : '展开'}</i></button>
            <div id={panelId} className="material-episode-scenes" hidden={!expanded}>
              {episode.sceneIds.map((sceneId) => {
                const scene = model.scenes.find((item) => item.id === sceneId);
                const sceneRequirements = (requirementsByScene.get(sceneId) || [])
                  .filter((item) => materialRequirementMatchesEpisode(item, episode, currentEpisodePlan));
                const materialGroups = groupSceneMaterials(sceneRequirements);
                const orderedEntries = materialGroups.flatMap((group) => group.entries);
                const currentShots = [...new Set(orderedEntries.flatMap((entry) => entry.classification.currentShotIds))];
                return <article className="material-relation-scene" data-material-scene-id={sceneId} key={sceneId}>
                  <header>
                    <button type="button" aria-pressed={sceneScope === sceneId} className={sceneScope === sceneId ? 'active' : ''} onClick={() => {
                      setExpandedEpisodeIds((current) => current.includes(episode.id) ? current : [...current, episode.id]);
                      onSelectSceneScope(episode.id, sceneId);
                    }}><b>{sceneId}</b> · {visibleText(scene?.title || '场名 UNKNOWN')}</button>
                    <span>{sceneRequirements.length} 项素材 · {currentShots.length ? `${currentShots.length} 个当前镜` : '当前镜 UNKNOWN'}</span>
                  </header>
                  <div className="material-relation-assets">
                    <div className="material-relation-scene-entry"><button type="button" className="material-relation-script" onClick={() => onOpenStoryScene(sceneId)}>阅读 {sceneId} 剧本 →</button></div>
                    {materialGroups.map((group) => {
                      const headingId = `material-category-${episode.id}-${sceneId}-${group.tone}`;
                      return <section className={`material-relation-category tone-${group.tone}`} data-material-category={group.primary} aria-labelledby={headingId} key={group.primary}>
                        <header id={headingId}>
                          <span className="material-relation-category-icon" data-material-category-icon={group.tone} aria-hidden="true">{group.icon}</span>
                          <span><b>{group.primary}</b><small>{[...new Set(group.entries.map((entry) => entry.classification.businessCategorySecondary))].join(' · ')}</small></span>
                          <em>{group.entries.length} 项</em>
                        </header>
                        <div className="material-relation-category-assets">
                          {group.entries.map(({ requirement, classification }) => {
                            const card = characterCardSummary(requirement);
                            const ariaLabel = card
                              ? `查看人物信息卡：${visibleText(card.displayName)}，${visibleText(card.contextLine)}，${card.triggerLabel}`
                              : `查看${classification.businessCategorySecondary}素材：${visibleText(requirement.title)}`;
                            return <button type="button" key={requirement.id} data-material-id={requirement.id} data-material-secondary={classification.businessCategorySecondary} aria-label={ariaLabel} aria-pressed={requirement.id === selectedRequirementId} title="查看素材预览与版本信息" className={`material-relation-asset${card ? ' is-character-card' : ''}${requirement.id === selectedRequirementId ? ' active' : ''}`} onClick={() => onSelectRequirement(requirement)}>
                              <span><small className="material-relation-asset-kind">{classification.businessCategorySecondary}</small>{card ? <><b>{visibleText(card.displayName)}</b><small className="material-relation-asset-context">{visibleText(card.contextLine)} · {card.triggerLabel}</small></> : <b>{visibleText(requirement.title)}</b>}</span><i>查看 →</i>
                            </button>;
                          })}
                        </div>
                      </section>;
                    })}
                    {currentShots.length > 0 && <section className="material-relation-current-shots" aria-label={`${sceneId} 当前镜头`}><header><b>当前镜头</b><span>{currentShots.length} 个</span></header><div>{currentShots.map((shotId) => <button type="button" className="material-relation-shot" key={shotId} onClick={() => onOpenConsumer(shotId)}>{publicRef(shotId)} →</button>)}</div></section>}
                  </div>
                </article>;
              })}
            </div>
          </section>;
        })}
      </section>
      <aside className="material-relation-sidebar">
        <section ref={inspectorRef} className="material-relation-inspector" aria-label="统一素材信息卡">
          {inspector}
        </section>
        <section className="material-world-overview material-story-basis">
          <h3>共用空间设定</h3>
          <p>地点、平面、区域、机位和状态路线在故事设定统一查阅；此处只管理需要制作的素材及实际版本。</p>
          <a href={runtimePath("?view=settings&settingsSection=space")}>查看故事设定中的空间依据 →</a>
        </section>
      </aside>
    </div>
  </section>;
}
