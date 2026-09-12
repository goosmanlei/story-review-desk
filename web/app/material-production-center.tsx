'use client';
import {fillUnansweredWithPass} from './review-shortcuts';

import { projectIdFor } from './instance-profile';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {EntityMaterialCatalog,MaterialReviewPoints} from './entity-material-catalog';
import type {MaterialCatalogRead} from './paged-production-data';
import {ProductionMaterialCatalog} from './production-material-catalog';
import {MaterialProgressBadge} from './material-appearance';
import {MaterialProductionSetupEditor} from './material-production-setup-editor';
import {MaterialUsageEditor} from './material-usage-editor';
import {ImageTechnicalSpecPanel} from './image-technical-spec-panel';
import {AssetContextRevalidationEditor} from './asset-context-revalidation-editor';
import {runtimePath} from './runtime-path';
import {currentMaterialDirectoryRow,materialRequirementLink} from './material-requirement-presentation';
import {
  episodePlanIsCurrent,
  mediaKind,
  RecipePanel,
  resolveFamilyVersionSelection,
  resolveAdoptedVersionId,
  useOriginalMediaUrl,
  useExecutionRecipe,
  useReviewOperations,
  type MaterialRequirement,
  type MaterialWorkItem,
  type OperationalStateProjection,
  type ProductionModel,
  type ReviewAction,
  type V7AssetFamily,
  type V7AssetVersion,
} from './production-workbench';
import { materialCriterionDescription, materialDisplayText } from './material-review-display';
import { mergePagedProductionModel, type PagedProductionPayload } from './paged-production-data';
import {
  materialRequirementVisibleInEpisodePlan,
} from './material-episode-scope';
import {
  classifiedMaterial,
  materialMediaTypeOptions,
  projectMaterialCreatorStage,
  type MaterialCreatorStage,
  type MaterialMediaType,
} from './material-taxonomy';
import { latestMaterialVersion } from './material-version-history';
import {dailyMaterialVersionRefs,exactMaterialVersion,isDeletedMaterialVersion,pendingMaterialExpectedOutputs,resolveExactMaterialSelection} from './material-daily-versions';
import { publicRef, visibleText } from './review-semantics';
import { useRuntimeMode } from './runtime-mode';
import { useAssistantFocus } from './assistant/context-provider';
import { useProjectAssistantDraftTargets } from './assistant/project-draft-adapters';
import {waitForOperation} from './operation-client';

export type MaterialCenterViewState = {
  search: string;
  mediaType: '全部' | MaterialMediaType;
  businessPrimary: string;
  category: string;
  episodeScope: string;
  sceneScope: string;
  shotScope: string;
  creatorStage: '全部' | MaterialCreatorStage;
  coverage: '全部' | 'NEEDS_PRODUCTION' | 'NEW_REQUIRED' | 'UNCOVERED' | 'STALE' | 'COVERED' | 'EVIDENCE_ONLY';
  workspaceMode: 'classification' | 'episodes';
  requirementId: string | null;
  familyId: string | null;
  versionId: string | null;
};

export const defaultMaterialCenterState: MaterialCenterViewState = {
  search: '',
  mediaType: '全部',
  businessPrimary: '全部',
  category: '全部',
  episodeScope: '全部',
  sceneScope: '全部',
  shotScope: '全部',
  creatorStage: '全部',
  coverage: '全部',
  workspaceMode: 'classification',
  requirementId: null,
  familyId: null,
  versionId: null,
};

type Props = {
  model: ProductionModel;
  snapshotId?: string;
  catalogLoading?: boolean;
  catalogRead?:MaterialCatalogRead;
  catalogTotal?: number | null;
  stateProjection: OperationalStateProjection | null;
  viewState: MaterialCenterViewState;
  onViewStateChange: (next: MaterialCenterViewState) => void;
  onOpenStoryScene: (sceneId: string) => void;
  onOpenConsumer: (shotId: string) => void;
};

type Finding = { verdict: '' | 'PASS' | 'FAIL' | 'NA'; note: string };

type ReviewCorrectionLockReason = {
  code: string;
  evidenceType: string;
  evidenceId: string;
  recordedAt?: string | null;
  message: string;
};

type ReviewCorrectionView = {
  mode?: 'APPEND_ONLY_SUPERSESSION';
  state: 'OPEN' | 'LOCKED' | 'UNKNOWN';
  headEventId: string;
  headAction?: string;
  lockReasons: ReviewCorrectionLockReason[];
};

type ReviewHeadConflict = {
  expectedHeadEventId: string;
  expectedMutationEtag: string;
  reasonCode: string;
};

function reviewActionLabel(action: ReviewAction | '' | undefined) {
  if (action === 'APPROVE_AND_RELEASE') return '已通过并放行';
  if (action === 'REQUEST_REVISION') return '当前为要求修改';
  if (action === 'DO_NOT_USE') return '当前为禁止使用';
  return '等待裁决';
}

function normalizedLines(value: string) {
  return value.split('\n').map((item) => item.trim()).filter(Boolean);
}

function characterCardTriggerLabel(requirement: MaterialRequirement) {
  const spec = requirement.cardSpec;
  if (!spec || spec.role !== 'INSTANCE') return null;
  return spec.triggerKind === 'FIRST_CLEAR_APPEARANCE' ? '首次清晰出场' : '场内背景补充';
}

function CharacterCardRequirementPreview({ requirement }: { requirement: MaterialRequirement }) {
  const spec = requirement.cardSpec;
  if (!spec) return null;
  if (spec.role === 'TEMPLATE') {
    return <section className="character-card-requirement is-template" data-character-card-role="TEMPLATE">
      <header><div><small>人物信息卡 · 全剧共享模板</small><h3>两行正片叠加卡</h3></div><span>视觉规格 UNKNOWN</span></header>
      <p>本轮只登记模板需求；字体、颜色、尺寸、动效与屏幕位置要等模板候选正式审阅后锁定，当前没有图片文件或可采用版本。</p>
      <div className="character-card-copy is-placeholder" role="group" aria-label="人物信息卡两行文案结构预览，不是视觉模板"><b>人物名</b><span>当前场次需要交代的身份或关系</span></div>
    </section>;
  }
  const triggerLabel = characterCardTriggerLabel(requirement);
  return <section className="character-card-requirement" data-character-card-role="INSTANCE">
    <header><div><small>正片人物信息卡 · 文案结构预览</small><h3>{visibleText(spec.triggerSceneId)} · {triggerLabel}</h3></div><span>镜头／帧点 UNKNOWN</span></header>
    <div className="character-card-copy" role="group" aria-label={`人物信息卡：${visibleText(spec.displayName)}，${visibleText(spec.contextLine)}`}><b>{visibleText(spec.displayName)}</b><span>{visibleText(spec.contextLine)}</span></div>
    <dl><div><dt>出现条件</dt><dd>{visibleText(spec.narrativeCue)}</dd></div><div><dt>防剧透门禁</dt><dd>{spec.spoilerPolicy === 'KNOWN_AT_CUE' ? '只显示触发点当下观众已知的信息' : 'UNKNOWN'}</dd></div></dl>
    <p>这是需求文案预览，不是已生成卡图；待 SceneCoverage、ShotPlanSet 与 Animatic 锁定后再确定镜头、出入点和位置。</p>
  </section>;
}

function coverageLabel(requirement: MaterialRequirement) {
  if (requirement.requirementClass === 'EVIDENCE_ONLY') return '历史关系证据';
  if (requirement.isNewRequirement) return '新增缺口';
  if (requirement.bindingStale) return '需求已变化';
  if (requirement.coverageSatisfied) return '已生成并采用';
  return '尚未覆盖';
}

function coverageTone(requirement: MaterialRequirement) {
  if (requirement.requirementClass === 'EVIDENCE_ONLY') return 'muted';
  if (requirement.bindingStale || requirement.isNewRequirement) return 'warn';
  return requirement.coverageSatisfied ? 'good' : 'pending';
}

function creatorStageFor(
  requirement: MaterialRequirement,
  item: MaterialWorkItem | null | undefined,
  projection: OperationalStateProjection | null,
) {
  const projected = item ? projection?.materialWorkItemsById?.[item.id] || item as unknown as Record<string,unknown> : null;
  const derived = projectMaterialCreatorStage({
    lifecycleState: !item && requirement.requirementClass === 'REQUIRED' && requirement.coverageSatisfied && !requirement.bindingStale
      ? 'SATISFIED_BY_EXISTING' : String(projected?.lifecycleState || item?.lifecycleState || 'UNKNOWN'),
    executionRequestState: typeof projected?.executionRequestState === 'string' ? projected.executionRequestState : null,
    requirementClass: requirement.requirementClass,
    coverageSatisfied:requirement.coverageSatisfied,bindingStale:requirement.bindingStale,
    flowBlockReasons: Array.isArray(projected?.flowBlockReasons) ? projected.flowBlockReasons : item?.flowBlockReasons,
    executionBlockReasons: item?.executionBlockReasons,
    executionGate: typeof projected?.executionGate === 'string' ? projected.executionGate : item?.declaredExecutionGate,
  });
  return derived;
}

async function digest(value: string) {
  const result = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(result)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

type MaterialAIReviewDraft = {
  summary: string;
  criterionFindings: Array<{ criterionId: string; verdict: 'PASS' | 'FAIL' | 'NA' | 'UNKNOWN'; note: string }>;
  qualityRecommendation: 'QUALITY_PASS_ON_OBSERVED_EVIDENCE' | 'REQUEST_REVISION' | 'DO_NOT_USE' | 'INSUFFICIENT_EVIDENCE';
  overallNote: string;
  revisionInstructions: { preserve: string[]; change: string[]; mustNotRegress: string[] } | null;
  observations: string[];
  unobserved: string[];
};

type MaterialCandidateProductionEvent = {
  eventId?: string;
  familyId?: string;
  versionId?: string;
  sha256?: string;
  executionRequestId?: string;
  runId?: string;
  executionDefinitionId?: string;
  executionDefinitionHash?: string;
  callPackageHash?: string;
  promptRevisionId?: string;
  actualPrompt?: unknown;
  actualPromptHash?: string;
  recipePromptHash?: string;
  promptChangedFromCallPackage?: boolean;
  promptSyncRequired?: boolean;
  inputBindings?: unknown[];
  inputBindingsHash?: string;
  parentVersionId?: string | null;
  parentVersionSha256?: string | null;
  parentBindingState?: string;
  productionEvidence?: MaterialProductionEvidenceProjection;
};

type MaterialProductionEvidenceStatus = 'VERIFIED' | 'MISSING' | 'CONFLICT';

type MaterialProductionEvidenceField = {
  status: MaterialProductionEvidenceStatus;
  value?: unknown;
  reason: string;
};

type MaterialProductionEvidenceProjection = {
  projectionVersion: string;
  fields: {
    inputBindings: MaterialProductionEvidenceField;
    actualPrompt: MaterialProductionEvidenceField;
    executionDefinition: MaterialProductionEvidenceField;
    model: MaterialProductionEvidenceField;
    parameters: MaterialProductionEvidenceField;
    run: MaterialProductionEvidenceField;
    output: MaterialProductionEvidenceField;
    parentVersion: MaterialProductionEvidenceField;
  };
  counts: Record<MaterialProductionEvidenceStatus, number>;
};

function MaterialProductionDatum({
  label,
  status = 'VERIFIED',
  children,
}: {
  label: string;
  status?: MaterialProductionEvidenceStatus;
  children: ReactNode;
}) {
  return <section className={`material-production-datum${status === 'MISSING' ? ' is-missing' : status === 'CONFLICT' ? ' is-conflict' : ''}`} data-evidence-status={status}>
    <header><b>{label}</b>{status !== 'VERIFIED' && <span>{status === 'CONFLICT' ? '冲突' : '缺项'}</span>}</header>
    <div>{children}</div>
  </section>;
}

function productionFactText(value: unknown) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return '无法序列化的登记值'; }
}

function productionPromptText(value: unknown) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const prompt = value as Record<string, unknown>;
    const main = typeof prompt.main === 'string' ? prompt.main.trim() : '';
    const negative = typeof prompt.negative === 'string' ? prompt.negative.trim() : '';
    if (main || negative) {
      return [
        main || '不适用（人工剪辑任务）',
        negative ? `【排除要求（生产调用时一并应用）】\n${negative}` : '',
      ].filter(Boolean).join('\n\n');
    }
  }
  return productionFactText(value);
}

function MaterialCandidateProductionFacts({
  family,
  version,
  historical,
}: {
  family: V7AssetFamily;
  version: V7AssetVersion | null;
  historical: boolean;
}) {
  const hasStableVersionIdentity = Boolean(version?.id && /^[a-f0-9]{64}$/i.test(version.sha256 || ''));
  const [candidate, setCandidate] = useState<MaterialCandidateProductionEvent | null>(null);
  const [status, setStatus] = useState<'LOADING' | 'READY' | 'ABSENT' | 'ERROR'>(hasStableVersionIdentity ? 'LOADING' : 'ABSENT');
  const [message, setMessage] = useState(hasStableVersionIdentity
    ? '正在读取该版本的实际生成登记…'
    : '尚无可核验生成登记；制作定义不代表已执行。');

  useEffect(() => {
    const controller = new AbortController();
    if (!hasStableVersionIdentity || !version?.id || !version.sha256) return () => controller.abort();
    const query = new URLSearchParams({ familyId: family.id, versionId: version.id, sha256: version.sha256, limit: '2' });
    if (historical) query.set('productionEvidence', '1');
    void fetch(`/api/v1/workspaces/asset-versions?${query.toString()}`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as { events?: MaterialCandidateProductionEvent[]; error?: string };
        if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
        const matches = (payload.events || []).filter((event) => (
          event.familyId === family.id
          && event.versionId === version.id
          && String(event.sha256 || '').toLowerCase() === String(version.sha256 || '').toLowerCase()
        ));
        if (matches.length > 1) throw new Error('同一版本与SHA出现多条候选生成登记，已失败关闭');
        if (!matches.length) {
          setCandidate(null);
          setStatus('ABSENT');
          setMessage(historical
            ? '该历史版本未找到与版本和SHA完全一致的候选生成事件；生产资料将逐项标记缺项，不借用当前配方。'
            : '未找到与本版本及SHA一致的生成事件；当前配方只作制作定义，不证明实际调用。');
          return;
        }
        setCandidate(matches[0]);
        setStatus('READY');
        const evidence = matches[0].productionEvidence;
        setMessage(historical
          ? !evidence
            ? '服务端未返回历史生产证据投影；全部字段失败关闭，不展示事件中的未核验值。'
            : evidence.counts.CONFLICT
              ? `服务端核验发现 ${evidence.counts.CONFLICT} 项冲突；冲突值不展示，也不会由当前配方补齐。`
              : '以下只展示经服务端逐字段核验、与所选历史版本及SHA精确绑定的生产资料。'
          : '以下出处精确绑定本版本与SHA；AI Review仍需服务端再次核验。');
      })
      .catch((reason) => {
        if (controller.signal.aborted) return;
        setStatus('ERROR');
        setMessage(`实际生成事实读取失败：${visibleText(reason instanceof Error ? reason.message : '未知错误')}`);
      });
    return () => controller.abort();
  }, [family.id, hasStableVersionIdentity, historical, version?.id, version?.sha256]);

  const evidence = candidate?.productionEvidence;
  const missingEvidence = (reason: string): MaterialProductionEvidenceField => ({ status: 'MISSING', reason });
  const historicalFields = evidence?.fields || {
    inputBindings: missingEvidence('没有服务端核验过的输入绑定证据。'),
    actualPrompt: missingEvidence('没有服务端核验过的实际 Prompt 证据。'),
    executionDefinition: missingEvidence('没有服务端核验过的执行定义证据。'),
    model: missingEvidence('没有服务端核验过的模型证据。'),
    parameters: missingEvidence('没有服务端核验过的参数证据。'),
    run: missingEvidence('没有服务端核验过的 Run 证据。'),
    output: missingEvidence('没有服务端核验过的产出文件证据。'),
    parentVersion: missingEvidence('没有服务端核验过的父版本证据。'),
  };
  const historicalCounts = Object.values(historicalFields).reduce<Record<MaterialProductionEvidenceStatus, number>>((result, field) => {
    result[field.status] += 1;
    return result;
  }, { VERIFIED: 0, MISSING: 0, CONFLICT: 0 });
  const verifiedObject = (field: MaterialProductionEvidenceField) => field.status === 'VERIFIED' && field.value && typeof field.value === 'object'
    ? field.value as Record<string, unknown>
    : null;
  const promptEvidence = verifiedObject(historicalFields.actualPrompt);
  const inputEvidence = verifiedObject(historicalFields.inputBindings);
  const definitionEvidence = verifiedObject(historicalFields.executionDefinition);
  const runEvidence = verifiedObject(historicalFields.run);
  const outputEvidence = verifiedObject(historicalFields.output);
  const parentEvidence = verifiedObject(historicalFields.parentVersion);

  if (!historical && status === 'ABSENT') return null;
  return <section className={`material-candidate-facts${historical ? ' is-historical' : ''}`} data-production-material-mode={historical ? 'HISTORICAL' : 'CURRENT'} data-production-material-status={status}>
    <header><b>{historical ? '该历史版本的生产资料' : '生成出处'}</b>{historical && <i>{historicalCounts.CONFLICT ? `${historicalCounts.CONFLICT} 项冲突 · ${historicalCounts.MISSING} 项缺项` : historicalCounts.MISSING ? `${historicalCounts.MISSING} 项缺项` : '资料完整'}</i>}</header>
    <p role="status">{message}</p>
    {!historical && candidate && <div className="material-generation-provenance">
      <p>上方制作定义不替代本版本的实际执行证据。</p>
      <dl>
        <div><dt>登记 / Run</dt><dd><code>{[candidate.eventId,candidate.runId,candidate.executionRequestId].filter(Boolean).map(publicRef).join(' · ') || '缺项'}</code></dd></div>
        <div><dt>实际 Prompt SHA</dt><dd><code>{candidate.actualPromptHash || '缺项'}</code></dd></div>
        {(candidate.callPackageHash||candidate.executionDefinitionHash)&&<div><dt>调用包 SHA</dt><dd><code>{candidate.callPackageHash||candidate.executionDefinitionHash}</code></dd></div>}
        {candidate.parentVersionId&&<div><dt>父版本</dt><dd><code>{publicRef(candidate.parentVersionId)} · {candidate.parentVersionSha256 || 'SHA 缺项'}</code></dd></div>}
      </dl>
      {Array.isArray(candidate.inputBindings)&&candidate.inputBindings.length>0&&<section className="material-input-provenance"><b>实际附件出处（原登记顺序）</b><pre>{visibleText(productionFactText(candidate.inputBindings))}</pre><code>{candidate.inputBindingsHash || '输入绑定 SHA 缺项'}</code></section>}
      {candidate.promptChangedFromCallPackage&&<section className="creator-recipe-section material-prompt-difference"><header><b>本版本实际 Prompt 与当前调用包不同</b></header><p role="status">{candidate.promptSyncRequired ? '获批后仍需受控同步；下方最新定义不是本次实际调用。' : '变化未标记同步，AI Review 将失败关闭。'}</p><pre>{visibleText(productionPromptText(candidate.actualPrompt ?? '实际 Prompt 缺项'))}</pre><code>实际 {candidate.actualPromptHash || '缺项'} · 配方 {candidate.recipePromptHash || '缺项'}</code></section>}
    </div>}
    {historical && <div className="material-historical-production-grid">
      {!(inputEvidence && Array.isArray(inputEvidence.bindings) && inputEvidence.bindings.length === 0) && <MaterialProductionDatum label="参考附件与输入版本" status={historicalFields.inputBindings.status}>
        {inputEvidence
          ? <><pre>{productionFactText(inputEvidence.bindings)}</pre><code>{String(inputEvidence.sha256 || '')}</code></>
          : <p>{visibleText(historicalFields.inputBindings.reason)}</p>}
      </MaterialProductionDatum>}
      <MaterialProductionDatum label="本次实际完整 Prompt" status={historicalFields.actualPrompt.status}>
        {promptEvidence
          ? <><pre>{productionPromptText(promptEvidence.content)}</pre><code>{String(promptEvidence.sha256 || '')}</code></>
          : <p>{visibleText(historicalFields.actualPrompt.reason)}</p>}
      </MaterialProductionDatum>
      <MaterialProductionDatum label="执行定义与配方" status={historicalFields.executionDefinition.status}>
        {definitionEvidence
          ? <p><code>{publicRef(String(definitionEvidence.executionDefinitionId || 'UNKNOWN'))}<br />{String(definitionEvidence.callPackageHash || definitionEvidence.definitionHash || '')}</code></p>
          : <p>{visibleText(historicalFields.executionDefinition.reason)}</p>}
      </MaterialProductionDatum>
      <MaterialProductionDatum label="模型／执行器" status={historicalFields.model.status}>
        {historicalFields.model.status === 'VERIFIED'
          ? <pre>{productionFactText(historicalFields.model.value)}</pre>
          : <p>{visibleText(historicalFields.model.reason)}</p>}
      </MaterialProductionDatum>
      <MaterialProductionDatum label="模型参数" status={historicalFields.parameters.status}>
        {historicalFields.parameters.status === 'VERIFIED'
          ? <pre>{productionFactText(historicalFields.parameters.value)}</pre>
          : <p>{visibleText(historicalFields.parameters.reason)}</p>}
      </MaterialProductionDatum>
      <MaterialProductionDatum label="Run 与调用包" status={historicalFields.run.status}>
        {runEvidence
          ? <p><code>{publicRef(String(runEvidence.executionDefinitionId || 'UNKNOWN'))}<br />{publicRef(String(runEvidence.runId || 'UNKNOWN'))}<br />{publicRef(String(runEvidence.executionRequestId || 'UNKNOWN'))}<br />{String(runEvidence.callPackageHash || '')}</code></p>
          : <p>{visibleText(historicalFields.run.reason)}</p>}
      </MaterialProductionDatum>
      <MaterialProductionDatum label="产出文件" status={historicalFields.output.status}>
        {outputEvidence
          ? <p><code>{visibleText(String(outputEvidence.path || ''))}<br />{String(outputEvidence.sha256 || '')}</code></p>
          : <p>{visibleText(historicalFields.output.reason)}</p>}
      </MaterialProductionDatum>
      <MaterialProductionDatum label="父版本／返修链" status={historicalFields.parentVersion.status}>
        {parentEvidence
          ? <p><code>{publicRef(String(parentEvidence.parentVersionId || 'ROOT'))}<br />{String(parentEvidence.parentVersionSha256 || parentEvidence.parentBindingState || '')}</code></p>
          : <p>{visibleText(historicalFields.parentVersion.reason)}</p>}
      </MaterialProductionDatum>
    </div>}
  </section>;
}

function aiRecommendationLabel(value: MaterialAIReviewDraft['qualityRecommendation']) {
  if (value === 'QUALITY_PASS_ON_OBSERVED_EVIDENCE') return '已观察证据支持质量通过，仍需人工裁决';
  if (value === 'REQUEST_REVISION') return '建议返修，仍需人工裁决';
  if (value === 'DO_NOT_USE') return '建议禁用，仍需人工裁决';
  return '证据不足，需要人工判断';
}

function MaterialOutputViewer({
  model,
  family,
  version,
  selectedRecordId,
  outputPath,
  category,
  onSelectVersion,
}: {
  model: ProductionModel;
  family: V7AssetFamily | null;
  version: V7AssetVersion | null;
  selectedRecordId: string | null;
  outputPath?: string;
  category?: string;
  onSelectVersion: (versionId: string | null) => void;
}) {
  const { url: originalMediaUrl, error: originalMediaError } = useOriginalMediaUrl(version);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const lightboxDialog = useRef<HTMLDialogElement>(null);
  const imageOrigin = useRef<HTMLButtonElement>(null);
  const [zoom, setZoom] = useState(100);
  const kind = mediaKind(version?.path || null);
  const deleted = Boolean(version && (version.outputState === 'DELETED' || version.historyRole === 'DELETED_AUDIT'));
  const dailyVersionRefs=dailyMaterialVersionRefs(model,family);
  const expectedOutputs = pendingMaterialExpectedOutputs(model,family);
  const selectedExpected = selectedRecordId
    ? expectedOutputs.find((item) => item?.id === selectedRecordId) || null
    : null;
  const mediaUrl = deleted ? null : originalMediaUrl || (kind === 'IMAGE' ? version?.preview : kind === 'AUDIO' ? version?.audioProxy : null);

  useEffect(() => {
    if (!lightboxOpen) return;
    const dialog = lightboxDialog.current;
    const origin = imageOrigin.current;
    if (!dialog) return;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      if (origin?.isConnected) origin.focus({preventScroll:true});
    };
  }, [lightboxOpen]);

  return <section className="material-output-viewer" data-material-section="output" data-version-id={version?.id||''} data-version-sha256={version?.sha256||''} aria-labelledby="material-output-heading">
    <header>
      <h3 id="material-output-heading">产物与版本</h3><fieldset className="material-version-chips"><legend>查看版本</legend>
          {!dailyVersionRefs.length && !expectedOutputs.length && <span>尚无日常可查看版本</span>}
          {dailyVersionRefs.map((id) => {
            const item = exactMaterialVersion(model,family,id);
            return <button type="button" key={id} aria-pressed={selectedRecordId===id} onClick={()=>onSelectVersion(id)}>{item ? `${visibleText(item.label)} · ${({RELEASED:'已通过',REVIEW_PENDING:'待审阅',REVISION_REQUIRED:'需修改',DO_NOT_USE:'禁止使用'} as Record<string,string>)[item.lifecycleState || ''] || '已登记'}` : publicRef(id)}</button>;
          })}
          {expectedOutputs.map((item) => item && <button type="button" key={item.id} aria-pressed={selectedRecordId===item.id} onClick={()=>onSelectVersion(item.id)}>{visibleText(item.plannedVersionLabel)} · 尚未产出</button>)}
        </fieldset>
      <p className="material-output-summary">{category || '类别待核'}<span>{(version ? version.path || '该版本路径未知' : selectedExpected?.targetPath || outputPath || '尚无固定输出').split('/').at(-1)}</span></p>
    </header>
    <div className="material-output-layout" data-material-output-layout>
      <div className={`material-output-canvas is-${kind.toLowerCase()}`}>
        {selectedExpected ? <div className="material-output-empty"><b>该计划版本尚未产出</b><p>固定产物区域保持在原位；当前只有 ExpectedOutput，没有文件、SHA-256 或可审阅内容。</p><code>{visibleText(selectedExpected.targetPath || '目标路径 UNKNOWN')}</code></div>
          : deleted ? <div className="material-output-empty"><b>该历史版本的文件已删除</b><p>这里只保留最小删除凭据；不能预览、采用或重新进入生产链。</p></div>
            : !version ? <div className="material-output-empty"><b>尚未产出候选</b><p>产物生成并登记实际文件与 SHA-256 后，会在同一区域直接进入详细 Review。</p></div>
              : kind === 'IMAGE' && mediaUrl ? <button ref={imageOrigin} type="button" className="material-output-image" onClick={() => { setZoom(100); setLightboxOpen(true); }}>
                {/* eslint-disable-next-line @next/next/no-img-element -- review must display the exact SHA-bound original without image transformation */}
                <img src={runtimePath(mediaUrl)} alt={`${visibleText(family?.label || version.label)}产物，点击放大审查`} /><span>{originalMediaUrl ? '点击放大审查原图' : '点击放大预览'}</span></button>
                : kind === 'AUDIO' && mediaUrl ? <audio data-review-audio controls preload="metadata" src={runtimePath(mediaUrl)}>你的浏览器不支持音频播放。</audio>
                  : kind === 'VIDEO' && mediaUrl ? <video controls preload="metadata" src={runtimePath(mediaUrl)}>你的浏览器不支持视频播放。</video>
                    : kind === 'UNKNOWN' && mediaUrl ? <a href={runtimePath(mediaUrl)} target="_blank" rel="noreferrer">打开登记文件 →</a>
                      : <div className="material-output-empty"><b>当前文件没有可用审阅代理</b><p>{originalMediaError || '文件事实仍会保留；预览不可用不等于产物不存在。'}</p></div>}
      </div>

    </div>
    {lightboxOpen && mediaUrl && kind === 'IMAGE' && typeof document !== 'undefined' && createPortal(<dialog ref={lightboxDialog} className="material-output-lightbox" aria-label="放大审查素材图片" onCancel={event=>{event.preventDefault();event.stopPropagation();setLightboxOpen(false);}}>
      <header><b>{visibleText(family?.label || version?.label || '素材图片')}</b><div><button type="button" aria-label="缩小素材图片" onClick={() => setZoom((value) => Math.max(40, value - 20))}>−</button><span>{zoom}%</span><button type="button" aria-label="放大素材图片" onClick={() => setZoom((value) => Math.min(300, value + 20))}>＋</button><button type="button" onClick={() => setLightboxOpen(false)}>关闭</button></div></header>
      <div>
        {/* eslint-disable-next-line @next/next/no-img-element -- lightbox must preserve the exact review source */}
        <img src={runtimePath(mediaUrl)} alt={`${visibleText(family?.label || version?.label || '素材图片')}放大审查`} style={{ width: `${zoom}%` }} />
      </div>
    </dialog>, document.body)}
  </section>;
}

function AssetReviewForm({
  requirement,
  family,
  version,
  operations,
}: {
  requirement: MaterialRequirement;
  family: V7AssetFamily;
  version: V7AssetVersion | null;
  operations: ReturnType<typeof useReviewOperations>;
}) {
  const { hostedReadOnly } = useRuntimeMode();
  const criteria = useMemo(() => requirement.reviewSpec?.criteria || requirement.acceptanceCriteria.map((label, index) => ({ id: `material-${String(index + 1).padStart(2, '0')}`, label })), [requirement.acceptanceCriteria,requirement.reviewSpec]);
  const [action, setAction] = useState<ReviewAction | ''>('');
  const [findings, setFindings] = useState<Record<string, Finding>>(() => Object.fromEntries(criteria.map((criterion) => [criterion.id, { verdict: '', note: '' }])));
  const [note, setNote] = useState('');
  const [preserve, setPreserve] = useState('');
  const [change, setChange] = useState('');
  const [mustNotRegress, setMustNotRegress] = useState('');
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiDraft, setAiDraft] = useState<MaterialAIReviewDraft | null>(null);
  const [aiMessage, setAiMessage] = useState('');
  const [message, setMessage] = useState('');
  const [headConflict, setHeadConflict] = useState<ReviewHeadConflict | null>(null);
  const [hydrationRevision, setHydrationRevision] = useState(0);
  const hydratedReviewKeyRef = useRef('');
  const reviewTargetKey = `${family.id}::${version?.id || 'NO_VERSION'}::${requirement.reviewSpec?.hash || 'LEGACY'}`;
  const previousReviewTargetKeyRef = useRef(reviewTargetKey);
  const versionProjection = version ? operations.stateProjection?.assetVersionsById[version.id] : null;
  const contextHash = typeof versionProjection?.reviewContextHash === 'string' ? versionProjection.reviewContextHash : '';
  const outputState = String(versionProjection?.outputState || version?.outputState || 'UNKNOWN');
  const lifecycleState = String(versionProjection?.lifecycleState || version?.lifecycleState || 'UNKNOWN');
  const correctionProjection = versionProjection?.reviewCorrection && typeof versionProjection.reviewCorrection === 'object'
    ? versionProjection.reviewCorrection as unknown as ReviewCorrectionView
    : null;
  const hasDecisionProjection = Boolean(correctionProjection);
  const projectedHeadEventId = correctionProjection?.headEventId || '';
  const decisionApplied = Boolean(
    projectedHeadEventId
    && operations.effective?.eventId === projectedHeadEventId
    && operations.effective.subjectType === 'ASSET'
    && operations.effective.subjectId === family.id
    && operations.effective.familyId === family.id
    && operations.effective.versionId === version?.id
    && operations.effective.versionSha256?.toLowerCase() === version?.sha256?.toLowerCase(),
  );
  const correctionState: ReviewCorrectionView['state'] = !hasDecisionProjection
    ? 'OPEN'
    : decisionApplied
      ? correctionProjection?.state || 'UNKNOWN'
      : 'UNKNOWN';
  const correctionLocked = hasDecisionProjection && correctionState !== 'OPEN';
  const reviewRightsFact = String(
    decisionApplied
      ? operations.effective?.projectRightsGateAtReview || version?.projectRightsGate || 'UNKNOWN'
      : version?.projectRightsGate || versionProjection?.projectRightsGate || 'UNKNOWN',
  );
  const hasArtifact = Boolean(
    version?.path
    && /^[a-f0-9]{64}$/i.test(version.sha256 || '')
    && outputState !== 'DELETED'
    && lifecycleState !== 'DELETED_AUDIT',
  );
  const isPresent = hasArtifact && outputState === 'PRESENT';
  const reviewEligible = Boolean(version && (lifecycleState === 'REVIEW_PENDING' || (!hasDecisionProjection&&versionProjection?.adoptionFact) || (decisionApplied && correctionState === 'OPEN')));

  useEffect(() => {
    if (previousReviewTargetKeyRef.current === reviewTargetKey) return;
    previousReviewTargetKeyRef.current = reviewTargetKey;
    hydratedReviewKeyRef.current = '';
    setHeadConflict(null);
  }, [reviewTargetKey]);

  const hydrationKey = `${version?.id || 'NO_VERSION'}::${operations.effective?.eventId || 'NO_DECISION'}::${contextHash || 'NO_CONTEXT'}::${criteria.map((criterion) => criterion.id).join(',')}::${hydrationRevision}`;
  useEffect(() => {
    if (headConflict) return;
    if (hydratedReviewKeyRef.current === hydrationKey) return;
    hydratedReviewKeyRef.current = hydrationKey;
    const effective = decisionApplied ? operations.effective : null;
    const priorFindings = new Map((effective?.criterionFindings || []).map((finding) => [finding.criterionId, finding]));
    setAction(effective?.action || '');
    setFindings(Object.fromEntries(criteria.map((criterion) => {
      const prior = priorFindings.get(criterion.id);
      return [criterion.id, {
        verdict: prior?.verdict || '',
        note: prior?.note || '',
      }];
    })));
    setNote(effective?.note || '');
    setPreserve((effective?.revisionInstructions?.preserve || []).join('\n'));
    setChange((effective?.revisionInstructions?.change || []).join('\n'));
    setMustNotRegress((effective?.revisionInstructions?.mustNotRegress || []).join('\n'));
    setRightsConfirmed(false);
    setAiDraft(null);
    setAiMessage('');
    setMessage('');
  }, [criteria, decisionApplied, headConflict, hydrationKey, operations.effective]);

  const allJudged = criteria.every((criterion) => Boolean(findings[criterion.id]?.verdict));
  const revisionChanges = normalizedLines(change);
  const currentDecisionSignature = JSON.stringify({
    action: action || '',
    criterionFindings: criteria.map((criterion) => ({
      criterionId: criterion.id,
      verdict: findings[criterion.id]?.verdict || '',
      note: findings[criterion.id]?.note.trim() || '',
    })),
    revisionInstructions: action === 'REQUEST_REVISION' ? {
      preserve: normalizedLines(preserve),
      change: revisionChanges,
      mustNotRegress: normalizedLines(mustNotRegress),
    } : null,
    note: note.trim(),
  });
  const effectiveFindingById = new Map((operations.effective?.criterionFindings || []).map((finding) => [finding.criterionId, finding]));
  const effectiveDecisionSignature = JSON.stringify({
    action: decisionApplied ? operations.effective?.action || '' : '',
    criterionFindings: criteria.map((criterion) => {
      const finding = effectiveFindingById.get(criterion.id);
      return {
        criterionId: criterion.id,
        verdict: finding?.verdict || '',
        note: finding?.note?.trim() || '',
      };
    }),
    revisionInstructions: decisionApplied && operations.effective?.action === 'REQUEST_REVISION' ? {
      preserve: operations.effective.revisionInstructions?.preserve || [],
      change: operations.effective.revisionInstructions?.change || [],
      mustNotRegress: operations.effective.revisionInstructions?.mustNotRegress || [],
    } : null,
    note: decisionApplied ? operations.effective?.note?.trim() || '' : '',
  });
  const hasDecisionChanges = !decisionApplied || currentDecisionSignature !== effectiveDecisionSignature;
  const canSubmit = Boolean(
    !correctionLocked
    && !headConflict
    && reviewEligible
    && isPresent
    && contextHash
    && operations.snapshotId
    && operations.mutationEtag
    && action
    && allJudged
    && hasDecisionChanges
    && (action !== 'APPROVE_AND_RELEASE' || criteria.every((criterion) => findings[criterion.id]?.verdict !== 'FAIL'))
    && (action !== 'APPROVE_AND_RELEASE' || reviewRightsFact !== 'UNKNOWN' || rightsConfirmed)
  );

  const assistantDrafts = useProjectAssistantDraftTargets({
    identity: `material:${operations.snapshotId || 'LOADING'}:${requirement.id}:${version?.id || 'NO_VERSION'}:${version?.sha256 || 'NO_SHA'}:${contextHash}:${requirement.reviewSpec?.hash || 'LEGACY'}:${projectedHeadEventId || 'NO_DECISION'}`,
    subjectId: requirement.id, versionId: version?.id, defaultFieldId: 'note',
    fields: version ? [
      ...criteria.map((criterion) => ({ fieldId: `criterion:${criterion.id}`, label: `${requirement.title} · ${criterion.label}意见`, value: findings[criterion.id]?.note || '' })),
      { fieldId: 'note', label: `${requirement.title} · 总体说明`, value: note },
      ...(action === 'REQUEST_REVISION' ? [
        { fieldId: 'preserve', label: `${requirement.title} · 必须保留`, value: preserve },
        { fieldId: 'change', label: `${requirement.title} · 必须修改`, value: change },
        { fieldId: 'mustNotRegress', label: `${requirement.title} · 不得退化`, value: mustNotRegress },
      ] : []),
    ] : [],
    canAdopt: Boolean(version && !hostedReadOnly && !busy && !aiBusy && !operations.loading && !operations.error
      && !correctionLocked && !headConflict && contextHash),
    disabledReason: '当前版本审阅草稿已锁定或绑定正在更新；建议仍可复制。',
    applyField: (fieldId, nextValue) => {
      if (fieldId === 'note') setNote(nextValue);
      else if (fieldId === 'preserve') setPreserve(nextValue);
      else if (fieldId === 'change') setChange(nextValue);
      else if (fieldId === 'mustNotRegress') setMustNotRegress(nextValue);
      else updateFinding(fieldId.slice('criterion:'.length), { note: nextValue });
    },
  });

  function chooseAction(value: ReviewAction | '') {
    setAction(value);
    if (value === 'APPROVE_AND_RELEASE') setFindings(current => fillUnansweredWithPass(current,criteria.map(criterion=>criterion.id)));
  }

  function updateFinding(id: string, patch: Partial<Finding>) {
    setFindings((current) => ({ ...current, [id]: { ...(current[id] || { verdict: '', note: '' }), ...patch } }));
  }

  async function requestAIReview() {
    if (!version || !hasArtifact || !operations.snapshotId || !operations.mutationEtag || !contextHash) return;
    const body = {
      schemaVersion: '1.0',
      snapshotId: operations.snapshotId,
      requirementId: requirement.id,
      reviewSpecHash:requirement.reviewSpec?.hash,
      familyId: family.id,
      versionId: version.id,
      versionSha256: version.sha256,
      contextHash,
    };
    try {
      setAiBusy(true);
      setAiDraft(null);
      setAiMessage('正在让 AI 基于当前产物、全部生产资料、验收口径与依赖上下文生成参考意见…');
      const key = crypto.randomUUID();
      const response = await fetch('/api/v1/workspaces/material-review-drafts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
          'If-Match': operations.mutationEtag,
        },
        body: JSON.stringify(body),
      });
      const receipt = await response.json() as {operationId?:string;error?:string};
      if (!response.ok || !receipt.operationId) throw new Error(receipt.error || `HTTP ${response.status}`);
      setAiMessage(`AI 正在分析此版本；操作 ${receipt.operationId}。`);
      await waitForOperation(receipt.operationId);
      const result=await fetch('/api/v1/workspaces/material-review-drafts?operationId='+encodeURIComponent(receipt.operationId),{cache:'no-store'});
      const payload = await result.json() as { draft?: MaterialAIReviewDraft; error?: string; requestId?: string; evidenceBoundary?: string };
      if (!result.ok || !payload.draft) throw new Error(`${payload.error || `HTTP ${result.status}`}（请求 ${receipt.operationId}）`);
      setAiDraft(payload.draft);
      setAiMessage(payload.evidenceBoundary || 'AI意见已生成，但尚未写入正式审阅表单。');
    } catch (reason) {
      setAiMessage(`AI辅助 Review 未完成：${visibleText(reason instanceof Error ? reason.message : '未知错误')}。本次没有自动重试，也没有产生正式审阅事件。`);
    } finally {
      setAiBusy(false);
    }
  }

  function applyAIDraft() {
    if (!aiDraft || correctionLocked) return;
    setFindings((current) => {
      const next = { ...current };
      for (const finding of aiDraft.criterionFindings) {
        if (!next[finding.criterionId]) continue;
        next[finding.criterionId] = {
          verdict: finding.verdict === 'UNKNOWN' ? '' : finding.verdict,
          note: finding.note,
        };
      }
      return next;
    });
    setNote(aiDraft.overallNote);
    setPreserve((aiDraft.revisionInstructions?.preserve || []).join('\n'));
    setChange((aiDraft.revisionInstructions?.change || []).join('\n'));
    setMustNotRegress((aiDraft.revisionInstructions?.mustNotRegress || []).join('\n'));
    setAction('');
    setAiMessage('参考意见已填入可编辑字段；正式动作仍未选择，请人工复核、修改后再决定。');
  }

  function loadLatestDecision() {
    if (!decisionApplied) return;
    hydratedReviewKeyRef.current = '';
    setHeadConflict(null);
    setHydrationRevision((value) => value + 1);
  }

  async function submit() {
    if (!version || !canSubmit || !operations.snapshotId || !operations.mutationEtag) return;
    try {
      setBusy(true);
      setMessage('正在核验当前素材版本并写入正式裁决…');
      const body = {
        schemaVersion: '2.2',
        snapshotId: operations.snapshotId,
        subjectType: 'ASSET',
        objectRevisionId: versionProjection?.revisionId,
        expectedVersion: versionProjection?.objectVersion,
        requirementId: requirement.id,
        requirementRevisionId: (requirement as unknown as {revisionId:string}).revisionId,
        requirementVersion: (requirement as unknown as {objectVersion:number}).objectVersion,
          reviewSpecHash: requirement.reviewSpec?.hash,
        subjectId: family.id,
        familyId: family.id,
        versionId: version.id,
        versionSha256: version.sha256,
        contextHash,
        action,
        criterionFindings: criteria.map((criterion) => ({
          criterionId: criterion.id,
          verdict: findings[criterion.id].verdict,
          note: findings[criterion.id].note.trim(),
        })),
        revisionInstructions: action === 'REQUEST_REVISION' ? {
          preserve: normalizedLines(preserve),
          change: revisionChanges,
          mustNotRegress: normalizedLines(mustNotRegress),
        } : null,
        rightsUnknownConfirmation: action === 'APPROVE_AND_RELEASE' && reviewRightsFact === 'UNKNOWN'
          ? { confirmed: rightsConfirmed, scope: 'PROJECT_INTERNAL_ONLY', basis: note.trim() || '用户在本次审阅中明确确认仅限项目内部生产；未填写补充说明。' }
          : null,
        supersedesReviewEventId: decisionApplied ? operations.effective?.eventId : null,
        note: note.trim() || undefined,
      };
      const key = await digest(JSON.stringify(body));
      const response = await fetch('/api/v1/workspaces/reviews', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `material-review-${key}`,
          'If-Match': operations.mutationEtag,
        },
        body: JSON.stringify(body),
      });
      const payload = await response.json() as {
        eventId?: string;
        error?: string;
        reasonCode?: string;
        reviewCorrectionState?: string;
        lockReasons?: ReviewCorrectionLockReason[];
      };
      if (!response.ok) {
        const correctionConflict = response.status === 409 || response.status === 412 || [
          'REVIEW_CORRECTION_LOCKED',
          'REVIEW_CORRECTION_STATE_UNKNOWN',
          'REVIEW_CORRECTION_HEAD_CHANGED',
          'REVIEW_CORRECTION_REQUIRES_HEAD',
        ].includes(String(payload.reasonCode || ''));
        if (correctionConflict) {
          setHeadConflict({
            expectedHeadEventId: projectedHeadEventId || operations.effective?.eventId || '',
            expectedMutationEtag: operations.mutationEtag,
            reasonCode: String(payload.reasonCode || `HTTP_${response.status}`),
          });
          operations.refresh();
          window.dispatchEvent(new CustomEvent('review:operations-updated'));
        }
        const lockEvidence = (payload.lockReasons || []).map((reason) => visibleText(reason.message)).filter(Boolean).join('；');
        const conflictMessage = response.status === 412
          ? '页面所依据的运行快照已经变化，已自动刷新；请核对最新裁决后再提交'
          : payload.reasonCode === 'REVIEW_CORRECTION_LOCKED'
            ? `素材已经进入下一状态，本次纠错未写入${lockEvidence ? `：${lockEvidence}` : ''}`
            : payload.reasonCode === 'REVIEW_CORRECTION_STATE_UNKNOWN'
              ? `当前裁决头或下游绑定无法可靠确认，已安全锁定并刷新${lockEvidence ? `：${lockEvidence}` : ''}`
              : ['REVIEW_CORRECTION_HEAD_CHANGED', 'REVIEW_CORRECTION_REQUIRES_HEAD'].includes(String(payload.reasonCode || ''))
                ? '当前裁决已被更新，已自动刷新；请基于最新内容重新修改'
                : payload.error || `HTTP ${response.status}`;
        throw new Error(conflictMessage);
      }
      setMessage(`正式裁决已应用：${payload.eventId || '成功'}。素材需求覆盖与消费者资格已按同一资产生命周期重算。`);
      operations.refresh();
      window.dispatchEvent(new CustomEvent('review:operations-updated'));
    } catch (reason) {
      setMessage(`正式裁决失败：${visibleText(reason instanceof Error ? reason.message : '未知错误')}`);
    } finally {
      setBusy(false);
    }
  }

  return <section className="material-review-form">
    <header><h3>审阅当前素材版本</h3><span className={decisionApplied && operations.effective?.action === 'APPROVE_AND_RELEASE' ? 'tone-good' : undefined}>{hasDecisionProjection && !decisionApplied ? '裁决状态 UNKNOWN' : reviewActionLabel(decisionApplied ? operations.effective?.action : '')}</span></header>
    <section className="material-ai-review" aria-label="AI辅助 Review">

      {!hasArtifact && version && <small>暂无可核验产物。</small>}
      {aiDraft && <article className="material-ai-draft">
        <header><b>AI参考结论：{aiRecommendationLabel(aiDraft.qualityRecommendation)}</b><span>未保存</span></header>
        <p>{visibleText(aiDraft.summary)}</p>
        <ul>{aiDraft.observations.map((item) => <li key={`observed-${item}`}>{visibleText(item)}</li>)}</ul>
        {aiDraft.unobserved.length > 0 && <details><summary>未观察或仍为 UNKNOWN 的证据</summary><ul>{aiDraft.unobserved.map((item) => <li key={`unobserved-${item}`}>{visibleText(item)}</li>)}</ul></details>}
        <button type="button" disabled={correctionLocked} onClick={applyAIDraft}>填入下方可编辑表单</button>
      </article>}
      {aiMessage && <p role="status" aria-live="polite">{aiMessage}</p>}
    </section>
    {decisionApplied && correctionState === 'OPEN' && <div className="creator-mobile-review-block material-review-correctable" role="status"><b>当前裁决仍可纠正</b><span>修改后提交会追加一条新的 ReviewEvent，取代当前投影；旧裁决 {publicRef(operations.effective?.eventId || '')} 仍保留作审计。登记后继版本、启动下游执行或源同步后会自动锁定。</span>{!hasDecisionChanges && <small>当前表单与既有裁决相同；至少修改一项后才可提交。</small>}</div>}
    {hasDecisionProjection && correctionLocked && <div className="creator-mobile-review-block material-review-immutable" role="status"><b>{correctionState === 'LOCKED' ? '当前裁决已经进入下一状态，不能再纠正' : '当前裁决的纠错状态无法确认，已安全锁定'}</b>{correctionProjection?.lockReasons?.length
      ? <ul className="material-review-lock-reasons">{correctionProjection.lockReasons.map((reason) => <li key={`${reason.code}-${reason.evidenceId}`}>{visibleText(reason.message)}（{publicRef(reason.evidenceId)}）</li>)}</ul>
      : <span>请刷新运行快照；在服务端确认当前裁决头与下游绑定前，不会覆盖现有结果。</span>}</div>}
    {headConflict && <div className="creator-mobile-review-block material-review-immutable" role="alert"><b>检测到并发变化，当前未提交草稿已保留</b><span>{headConflict.expectedHeadEventId && projectedHeadEventId !== headConflict.expectedHeadEventId
      ? `提交时依据的裁决 ${publicRef(headConflict.expectedHeadEventId)} 已不是当前头；当前头为 ${projectedHeadEventId ? publicRef(projectedHeadEventId) : 'UNKNOWN'}。`
      : `提交时依据的运行状态已经变化（${publicRef(headConflict.expectedMutationEtag)}）；当前草稿没有被自动覆盖。`}</span><button type="button" disabled={!decisionApplied || operations.loading} onClick={loadLatestDecision}>载入最新裁决（覆盖当前未提交内容）</button>{!decisionApplied && <small>最新裁决头尚无法可靠读取，当前保持安全锁定。</small>}</div>}
    {!version && <p className="v6-empty-note">当前需求还没有资产版本，先完成执行定义与候选登记。</p>}
    {version && !hasArtifact && <p className="v6-empty-note">当前版本没有可核验的文件与SHA-256，不能提交正式裁决。</p>}
    {version && <>
      <div className="material-criteria-list">{criteria.map((criterion) => <article key={criterion.id} data-criterion-id={criterion.id}><div className="material-criterion-copy"><b>{criterion.label}</b>{"question" in criterion&&materialCriterionDescription(criterion.label,criterion.question)&&<p>{materialCriterionDescription(criterion.label,criterion.question)}</p>}</div><div role="group" aria-label={`${criterion.label}判断`}>{(['PASS', 'FAIL', 'NA'] as const).filter(v=>v!=='NA'||!("allowNA" in criterion)||criterion.allowNA!==false).map((verdict) => {
        const selected = findings[criterion.id]?.verdict === verdict;
        return <button type="button" disabled={correctionLocked} key={verdict} aria-pressed={selected} className={selected ? 'active' : ''} onClick={() => updateFinding(criterion.id, { verdict: selected ? '' : verdict })}>{verdict === 'PASS' ? '符合' : verdict === 'FAIL' ? '不符合' : '不适用'}</button>;
      })}</div><textarea rows={2} disabled={correctionLocked} value={findings[criterion.id]?.note || ''} onFocus={() => assistantDrafts.activateField(`criterion:${criterion.id}`)} onChange={(event) => updateFinding(criterion.id, { note: event.target.value })} placeholder={findings[criterion.id]?.verdict === 'FAIL' ? '可选：写明可复现的具体问题' : '可选：补充证据或观察'} /></article>)}</div>
      {action === 'APPROVE_AND_RELEASE' && reviewRightsFact === 'UNKNOWN' && <label className="material-rights-confirm"><input disabled={correctionLocked} type="checkbox" checked={rightsConfirmed} onChange={(event) => setRightsConfirmed(event.target.checked)} />我确认本次仅按 PROJECT_INTERNAL_ONLY 在项目内部下传；原始权利事实仍为 UNKNOWN。</label>}
      <label className="material-review-note">总体说明（可选）<textarea rows={2} disabled={correctionLocked} value={note} onFocus={() => assistantDrafts.activateField('note')} onChange={(event) => setNote(event.target.value)} placeholder="可选：补充本次裁决依据" /></label>

      {action === 'REQUEST_REVISION' && <div className="material-revision-grid"><label>必须保留（可选）<textarea rows={2} disabled={correctionLocked} value={preserve} onFocus={() => assistantDrafts.activateField('preserve')} onChange={(event) => setPreserve(event.target.value)} placeholder="可选；每行一条" /></label><label>必须修改（可选）<textarea rows={2} disabled={correctionLocked} value={change} onFocus={() => assistantDrafts.activateField('change')} onChange={(event) => setChange(event.target.value)} placeholder="可选；每行一条" /></label><label>不得退化（可选）<textarea rows={2} disabled={correctionLocked} value={mustNotRegress} onFocus={() => assistantDrafts.activateField('mustNotRegress')} onChange={(event) => setMustNotRegress(event.target.value)} placeholder="可选；每行一条" /></label></div>}
      {action === 'APPROVE_AND_RELEASE' && criteria.some(c=>findings[c.id]?.verdict==='FAIL') && <p role="alert">已有“不符合”判断已保留，请先核对冲突项或选择“要求修改”。</p>}
      <div className="material-review-submit-bar">
      <div className="material-review-actions is-submit-adjacent" role="group" aria-label="正式审阅动作（可再次点击取消）">{([
        ['APPROVE_AND_RELEASE', '通过并放行'],
        ['REQUEST_REVISION', '要求修改'],
        ['DO_NOT_USE', '禁止使用'],
      ] as Array<[ReviewAction, string]>).map(([value, label]) => {
        const selected = action === value;
        return <button type="button" disabled={correctionLocked} key={value} aria-pressed={selected} className={selected ? 'active' : ''} onClick={() => chooseAction(selected ? '' : value)}>{label}</button>;
      })}</div>
      <div className="material-review-assist-actions"><button type="button" className="material-ai-review-action" disabled={hostedReadOnly || aiBusy || !hasArtifact} onClick={() => void requestAIReview()}>{aiBusy ? '正在分析…' : 'AI 辅助审阅'}</button><button className="material-draft-assistant-action" type="button" disabled={hostedReadOnly || !assistantDrafts.hasTargets} onClick={assistantDrafts.askAboutActiveDraft}>结合这条意见问助手</button></div>
      <button className="creator-authorize-button" disabled={busy || !canSubmit || hostedReadOnly} onClick={() => void submit()}>{busy ? '正在提交…' : hostedReadOnly ? '远端镜像不可正式提交' : decisionApplied ? '提交纠错并取代旧裁决' : '提交正式裁决'}</button>
      </div>
    </>}
    {message && <p role="status" aria-live="polite">{message}</p>}
  </section>;
}

export function MaterialProductionCenter(props:Props) {
  const [catalog,setCatalog]=useState<'basic'|'production'>('basic');
  useEffect(()=>{const read=()=>setCatalog(new URL(window.location.href).searchParams.get('materialCatalog')==='production'?'production':'basic');read();window.addEventListener('popstate',read);window.addEventListener('review:material-catalog-location',read);return()=>{window.removeEventListener('popstate',read);window.removeEventListener('review:material-catalog-location',read);};},[]);
  function selectCatalog(next:'basic'|'production'){
    const url=new URL(window.location.href);url.searchParams.set('materialCatalog',next);
    for(const key of ['material','family','version','asset','materialPanel','productionMaterial','productionMaterialVersion'])url.searchParams.delete(key);
    window.history.replaceState(window.history.state,'',url);setCatalog(next);
    props.onViewStateChange({...props.viewState,requirementId:null,familyId:null,versionId:null});
    window.dispatchEvent(new Event('review:material-catalog-location'));
  }
  return <><div className="material-catalog-tabs" role="tablist" aria-label="素材目录视图"><button type="button" role="tab" aria-selected={catalog==='basic'} onClick={()=>selectCatalog('basic')}>基础素材</button><button type="button" role="tab" aria-selected={catalog==='production'} onClick={()=>selectCatalog('production')}>制作过程素材</button></div>{catalog==='production'?<ProductionMaterialCatalog model={props.model} snapshotId={props.snapshotId}/>:<BasicMaterialProductionCenter {...props}/>}</>;
}

function BasicMaterialProductionCenter({ model: summaryModel, snapshotId, catalogLoading=false, catalogRead, stateProjection: liveProjection, viewState, onViewStateChange, onOpenStoryScene, onOpenConsumer }: Props) {
  const [detail, setDetail] = useState<{id:string;snapshotId:string;page:PagedProductionPayload['page']} | null>(null);
  const [detailFailure,setDetailFailure]=useState<{id:string;snapshotId?:string;attempt:number;message:string}|null>(null);
  const [detailAttempt, setDetailAttempt] = useState(0);
  const model = useMemo(() => detail && detail.snapshotId === snapshotId ? mergePagedProductionModel(summaryModel, detail.page) : summaryModel, [detail, snapshotId, summaryModel]);
  const currentEpisodePlan = episodePlanIsCurrent(model);
  const requirements = useMemo(() => (model.materialRequirements || []).filter((requirement) => (
    requirement.requirementClass === 'REQUIRED'
    &&
    (requirement.id === viewState.requirementId || materialRequirementVisibleInEpisodePlan(requirement, model.episodes, currentEpisodePlan))
  )), [currentEpisodePlan, model.episodes, model.materialRequirements, viewState.requirementId]);
  const materialItems = useMemo(() => model.materialWorkItems || [], [model.materialWorkItems]);
  const mediaType = viewState.mediaType;
  const episodeScope = viewState.episodeScope;
  const sceneScope = viewState.sceneScope;
  const creatorStage = viewState.creatorStage;
  // The former episode view is a URL compatibility alias, not a second workspace.
  const workspaceMode = 'classification' as const;
  const classificationById = useMemo(() => new Map(requirements.map((item) => [
    item.id,
    classifiedMaterial(item as unknown as Record<string, unknown> & { category: string; mediaKind: string; shotIds: string[] }),
  ])), [requirements]);
  // Catalog facets never silently substitute a different requirement/version deep link.
  const requestedRequirementPool = requirements;
  const familyRequirements = requestedRequirementPool.filter((item) => item.assetFamilyRefs.includes(viewState.familyId || ''));
  const requestedRequirement = viewState.requirementId
    ? requestedRequirementPool.find((item) => item.id === viewState.requirementId) || null
    : familyRequirements.length === 1 ? familyRequirements[0] : null;
  const selectedRequirement = requestedRequirement
    || (!viewState.requirementId ? requirements.find(currentMaterialDirectoryRow) : null)
    || null;
  // A deep link may precede its summary page. Fetch that exact requirement,
  // rather than displaying or requesting the first catalog row while it loads.
  const selectedDetailId = viewState.requirementId || ((viewState.familyId || viewState.versionId) ? selectedRequirement?.id : null) || null;
  const detailError=detailFailure?.id===selectedDetailId&&detailFailure?.snapshotId===snapshotId&&detailFailure?.attempt===detailAttempt?detailFailure.message:'';
  const detailReady = Boolean(selectedDetailId && selectedRequirement?.id === selectedDetailId && detail?.id === selectedDetailId && detail.snapshotId === snapshotId);
  useEffect(() => {
    if (!selectedDetailId) return;
    const controller = new AbortController();
    void fetch(`/api/v1/workspaces/views/materials?requirementId=${encodeURIComponent(selectedDetailId)}`, {cache:'no-store',signal:controller.signal})
      .then(async response => {const body=await response.json() as PagedProductionPayload & {error?:string;detailState?:string};if(!response.ok)throw new Error(body.error || '素材详情暂时无法读取');if(body.detailState && body.detailState!=='COMPLETE')throw new Error('当前返回的是素材摘要，完整详情暂不可用。');return body;})
      .then(body=>{if(controller.signal.aborted)return;if(body.snapshotId!==snapshotId)throw new Error('素材详情与当前快照不一致，请刷新页面。');if(!body.page.materialRequirements?.some(r=>r.id===selectedDetailId))throw new Error('返回的详情没有精确绑定当前素材。');for(const rows of [body.page.assetFamilies,body.page.assetVersions,body.page.expectedOutputs])if(rows&&new Set(rows.map(row=>row.id)).size!==rows.length)throw new Error('素材详情包含重复身份，已拒绝合并或回退其他版本。');setDetail({id:selectedDetailId,snapshotId:body.snapshotId,page:body.page});})
      .catch(e=>{if(!controller.signal.aborted)setDetailFailure({id:selectedDetailId,snapshotId,attempt:detailAttempt,message:e instanceof Error?e.message:'素材详情暂时无法读取'});});
    return ()=>controller.abort();
  }, [selectedDetailId,snapshotId,detailAttempt]);
  const selectedItem = selectedRequirement?.materialWorkItemRef
    ? materialItems.find((item) => item.id === selectedRequirement.materialWorkItemRef) || null
    : null;
  const familySelectionMismatch = Boolean(
    selectedRequirement
    && viewState.familyId
    && !selectedRequirement.assetFamilyRefs.includes(viewState.familyId),
  );
  const selectedFamilyId = selectedRequirement && !familySelectionMismatch
    ? viewState.familyId || selectedRequirement.assetFamilyRefs[0] || null
    : null;
  const selectedFamily = selectedFamilyId
    ? model.assetFamilies.find((family) => family.id === selectedFamilyId) || null
    : null;
  const latestVersion = latestMaterialVersion(model, selectedFamily);
  const explicitSelection = selectedFamily && viewState.versionId
    ? resolveExactMaterialSelection(model,selectedFamily,viewState.versionId)
    : null;
  const explicitSelectedVersion = explicitSelection?.version || null;
  const deletedVersionSelection=isDeletedMaterialVersion(explicitSelectedVersion);
  const explicitSelectedExpected = explicitSelection?.expected || null;
  const versionSelectionMismatch = Boolean(selectedFamily && viewState.versionId && !explicitSelectedVersion && !explicitSelectedExpected);
  const selectedVersion = selectedFamily && !versionSelectionMismatch && !deletedVersionSelection
    ? (viewState.versionId ? explicitSelectedVersion : latestVersion)
    : null;
  const isHistoricalVersion = Boolean(selectedVersion && latestVersion && selectedVersion.id !== latestVersion.id);
  const { recipe, error: recipeError } = useExecutionRecipe(selectedDetailId ? selectedItem?.executionDefinitionRef : null);
  const operations = useReviewOperations(selectedDetailId && selectedFamily ? {
    subjectType: 'ASSET',

    subjectId: selectedFamily.id,
    versionId: selectedVersion?.id || null,
  } : null);
  const assistantMaterialSnapshotId = snapshotId || operations.snapshotId || model.snapshotManifest?.snapshotId || '';
  useAssistantFocus(selectedRequirement && assistantMaterialSnapshotId ? {
    projectId: projectIdFor(model), snapshotId: assistantMaterialSnapshotId, view: 'materials',
    subjectType: 'MATERIAL', subjectId: selectedRequirement.id, title: `素材管理 · ${visibleText(selectedRequirement.title)}`,
    versionId: selectedVersion?.id || explicitSelectedExpected?.id || viewState.versionId || undefined,
    references: selectedFamily ? [`family:${selectedFamily.id}`] : [],
    filters: { mode: workspaceMode || 'classification', episode: episodeScope, scene: sceneScope, media:mediaType, primary:viewState.businessPrimary, category:viewState.category, search:viewState.search },
  } : null, 10);
  const effectiveProjection = operations.stateProjection || liveProjection;


  const projectedItem = selectedItem
    ? { ...selectedItem, ...(operations.stateProjection?.materialWorkItemsById?.[selectedItem.id] || liveProjection?.materialWorkItemsById?.[selectedItem.id] || {}) } as MaterialWorkItem
    : null;
  const catalogStageFor=useCallback((requirement:MaterialRequirement)=>creatorStageFor(requirement,materialItems.find(item=>item.id===requirement.materialWorkItemRef),liveProjection),[materialItems,liveProjection]);
  const selectedCreatorStage = selectedRequirement
    ? creatorStageFor(selectedRequirement, projectedItem, operations.stateProjection || liveProjection)
    : null;

  function patch(patchValue: Partial<MaterialCenterViewState>) {
    onViewStateChange({ ...viewState, ...patchValue });
  }

  useEffect(() => {
    const nextShotScope = workspaceMode === 'classification' ? '全部' : viewState.shotScope;
    const shouldNormalizeDetail = workspaceMode === 'classification'
      && Boolean(viewState.requirementId || viewState.familyId || viewState.versionId)
      && Boolean(requestedRequirement);
    const nextRequirementId = shouldNormalizeDetail ? selectedRequirement?.id || null : viewState.requirementId;
    const nextFamilyId = shouldNormalizeDetail && !viewState.familyId ? selectedFamily?.id || null : viewState.familyId;
    const nextVersionId = shouldNormalizeDetail && !viewState.versionId ? selectedVersion?.id || null : viewState.versionId;
    if (
      viewState.shotScope === nextShotScope
      && viewState.requirementId === nextRequirementId
      && viewState.familyId === nextFamilyId
      && viewState.versionId === nextVersionId
    ) return;
    onViewStateChange({
      ...viewState,
      shotScope: nextShotScope,
      requirementId: nextRequirementId,
      familyId: nextFamilyId,
      versionId: nextVersionId,
    });
  }, [onViewStateChange, requestedRequirement, selectedFamily?.id, selectedRequirement, selectedVersion?.id, viewState, workspaceMode]);

  // Selecting material cards does not scroll, collapse or filter the entity directory.

  function select(requirement: MaterialRequirement) {
    const familyId = requirement.assetFamilyRefs[0] || null;
    const family = model.assetFamilies.find((item) => item.id === familyId);
    patch({
      requirementId: requirement.id,
      familyId,
      versionId: latestMaterialVersion(model, family || null)?.id || resolveFamilyVersionSelection(model, family),
    });
  }
  const selectedClassification = selectedRequirement ? classificationById.get(selectedRequirement.id) || null : null;
  const selectedMediaLabel = materialMediaTypeOptions.find((item) => item.id === selectedClassification?.mediaType)?.label || 'UNKNOWN';
  const storyBasis = selectedRequirement?.storyBasis;
  const storyEvidenceRefs = storyBasis?.evidenceRefs || [storyBasis?.sourceRef];
  const composition = selectedRequirement?.composition;
  const currentProductionTarget = Boolean(selectedRequirement && currentMaterialDirectoryRow(selectedRequirement));
  const replacement = selectedRequirement?.requirementReplacement;
  const usageOnlyLeaf = currentProductionTarget && selectedRequirement?.sourceKind === 'DOMAIN_GRAPH' && selectedRequirement.requirementClass === 'REQUIRED' && !selectedRequirement.assetFamilyRefs.length && !selectedRequirement.plannedAssetFamilyId && !composition && selectedClassification?.mediaType === 'IMAGE';
  const hasUsageBindings = !!selectedRequirement?.materialUsageBindings?.length;
  const hasEligibleUsage = selectedRequirement?.materialUsageBindings?.some(binding=>binding.eligible) === true;
  const materialInfoCard = selectedDetailId && !detailReady
    ? <section className="material-info-card material-detail-loading" aria-busy={!detailError}><p role={detailError?'alert':'status'}>{detailError || '正在读取这项素材的产物、版本、审阅与完整生产资料…'}</p>{detailError&&<button onClick={()=>setDetailAttempt(v=>v+1)}>重新读取素材详情</button>}</section>
    : !selectedRequirement ? <section className="material-info-card is-empty"><p className="v6-empty-note">选择一项素材，查看固定产物区、Review、生产资料、用途与版本血缘。</p></section>
    : <article className="material-info-card" data-material-info-id={publicRef(selectedRequirement.id)} data-family-id={selectedFamily?.id || ''}>
      <header className="material-info-header"><span>{selectedMediaLabel} · {selectedClassification?.businessCategoryPrimary} / {selectedClassification?.businessCategorySecondary}</span>{currentProductionTarget?<MaterialProgressBadge stage={selectedCreatorStage?.creatorStage||'INITIAL'}/>:<span>历史需求</span>}</header>
      {!currentProductionTarget&&<section className="material-production-materials" aria-label="素材需求替代关系" role={selectedRequirement.currentDisposition==='INVALID_REPLACEMENT'?'alert':'status'}><h3>{selectedRequirement.currentDisposition==='REPLACED'?'原综合需求，已拆分':'素材替代关系暂不可用'}</h3><p>保留这项原需求、原版本和审阅历史；不计当前需求完成度，不在这里建立新候选或编辑新用途。</p>{replacement?.replacedByRequirementId&&<a href={runtimePath(materialRequirementLink(replacement.replacedByRequirementId))}>查看新的整套需求</a>}{replacement?.reasons.map(reason=><p key={reason}>{visibleText(reason)}</p>)}</section>}
      {currentProductionTarget&&!!selectedCreatorStage?.creatorStageReasons.length && <section className="material-blocking-explanation" aria-label="当前素材阻断说明">
        <header><div><small>BLOCKING REASON</small><h3>为什么现在被阻断</h3></div><span>{selectedCreatorStage.creatorStageShortReason || '原因待补齐'}</span></header>
        <div>
          <section><h4>阻断原因</h4><ol>{(selectedCreatorStage.creatorStageReasons.length
            ? selectedCreatorStage.creatorStageReasons
            : [selectedCreatorStage.creatorStageDetail || '系统尚未登记可供判断的具体原因。']).map((reason) => <li key={reason}>{visibleText(reason)}</li>)}</ol></section>
          <aside><h4>怎样解除</h4><p><b>适用场次：</b>{selectedRequirement.sceneIds.length ? selectedRequirement.sceneIds.join('、') : '全剧范围'}</p><p>{visibleText(selectedCreatorStage.creatorStageNextStep || '先补齐可核验的阻断原因；原因不明时不能开始生产。')}</p></aside>
        </div>
      </section>}
      {(familySelectionMismatch || (selectedFamilyId && !selectedFamily) || versionSelectionMismatch) && <section className="material-selection-error" role="alert"><b>素材深链与当前权威关系不一致</b><p>{familySelectionMismatch
        ? `资产族 ${publicRef(viewState.familyId)} 不属于素材 ${publicRef(selectedRequirement.id)}，已拒绝回退到其他资产族。`
        : !selectedFamily
          ? `资产族 ${publicRef(selectedFamilyId)} 在当前快照中不存在，已失败关闭。`
          : `版本 ${publicRef(viewState.versionId)} 不属于资产族 ${publicRef(selectedFamily.id)}，已拒绝静默显示最新版本。`}</p></section>}
      {deletedVersionSelection&&<section className="material-selection-error" role="alert" data-deleted-material-version={explicitSelectedVersion?.id}><b>该版本已登记为删除审计</b><p>不在日常素材工作区展示。原历史记录未改写，未切换到其他版本；这次界面整理没有执行物理删除。</p></section>}
      {!familySelectionMismatch && !versionSelectionMismatch && !deletedVersionSelection && <>
        {composition&&<section className="material-production-materials" aria-label="素材组成与就绪情况"><header><h3>需要全部就绪的素材</h3><span>{selectedRequirement.compositionCoverage?.coveredCount||0} / {composition.requiredComponents.length} 项已就绪</span></header>{composition.requiredComponents.map(component=>{const requirement=model.materialRequirements?.find(r=>r.id===component.requirementId),coverage=selectedRequirement.compositionCoverage?.components.find(c=>c.id===component.id);return <section key={component.id}><p><b>{requirement?.title||component.id}</b> · {coverage?.coverageSatisfied?'已就绪':'待完成'}</p><a href={runtimePath(materialRequirementLink(component.requirementId))}>查看这项素材</a>{coverage?.reasons.map(reason=><p key={reason}>{visibleText(reason)}</p>)}</section>;})}</section>}
        {hasUsageBindings&&<section className="material-production-materials" aria-label="已登记的图片用途"><header><h3>已登记的图片用途</h3><span>{selectedRequirement.coverageSatisfied?'本需求已覆盖':'本需求待完成'}</span></header>{selectedRequirement.materialUsageBindings!.map(binding=>{const version=model.assetVersions.find(v=>v.id===binding.versionId&&v.sha256===binding.sha256),url=version?.mediaToken?runtimePath('/api/v1/media/'+version.mediaToken):null;return <section key={binding.usageId}><p>{binding.eligible?'当前用途可用':'当前用途不可用'} · {binding.versionId}</p>{url&&<a href={runtimePath(url)} target="_blank" rel="noreferrer">查看绑定原图</a>}{!binding.eligible&&binding.reasons.map(reason=><p key={reason}>{visibleText(reason)}</p>)}</section>;})}{usageOnlyLeaf&&<MaterialUsageEditor requirementId={selectedRequirement.id}/>}</section>}
        {!composition&&!usageOnlyLeaf&&<div className="material-review-focus">
          <div className="material-output-zone">
            <MaterialOutputViewer outputPath={recipe?.output?.path} category={selectedClassification?.businessCategorySecondary || selectedClassification?.businessCategoryPrimary} model={model} family={selectedFamily} version={selectedVersion} selectedRecordId={selectedVersion?.id || explicitSelectedExpected?.id || viewState.versionId || null} onSelectVersion={(versionId) => patch({ familyId: selectedFamily?.id || null, versionId })} />
          </div>
          <section className="material-review-zone" data-material-section="review">
            <MaterialReviewPoints requirement={selectedRequirement} version={selectedVersion} historical={isHistoricalVersion}/>
            {currentProductionTarget && !isHistoricalVersion && selectedFamily && (selectedFamily.kind==='IMAGE'||selectedFamily.kind==='VISUAL'&&selectedRequirement.mediaType==='IMAGE') && selectedVersion?.sha256 && selectedVersion.reviewDecision==='RELEASED' && selectedVersion.legacyState?.approvalStatus==='APPROVED' && !selectedVersion.canFlowDownstream && <AssetContextRevalidationEditor target={{familyId:selectedFamily.id,versionId:selectedVersion.id,sha256:selectedVersion.sha256}} mediaToken={selectedVersion.mediaToken || undefined}/>}
            {selectedFamily
              ? <AssetReviewForm key={`${selectedRequirement.requirementHash}:${selectedRequirement.reviewSpec?.hash || 'LEGACY'}:${selectedVersion?.id || viewState.versionId || 'NO_VERSION'}`} requirement={selectedRequirement} family={selectedFamily} version={selectedVersion} operations={operations} />
              : <div className="v6-empty-note"><b>Review 区已保留</b><p>当前还没有资产族或候选文件；登记文件与 SHA-256 后在这里进行 AI 辅助与正式人工 Review。</p></div>}
          </section>
        </div>}
        <section className="material-production-materials" data-material-section="production" data-production-version-id={selectedVersion?.id || explicitSelectedExpected?.id || 'NO_VERSION'}>
          <header><h3>全部生产资料</h3><span>{isHistoricalVersion ? `${visibleText(selectedVersion?.label || '历史版本')} · 版本绑定资料` : selectedVersion ? `${visibleText(selectedVersion.label)} · 最新生产资料` : composition ? '由各项素材共同满足' : hasUsageBindings ? '已有图片用途审阅记录' : '尚未产出 · 最新生产资料'}</span></header>
          <CharacterCardRequirementPreview requirement={selectedRequirement} />
          {!isHistoricalVersion && <ImageTechnicalSpecPanel spec={selectedRequirement.configurationBinding?.technicalSpec} hash={selectedRequirement.configurationBinding?.technicalSpecHash} facts={selectedVersion?.imageTechnicalSpecHash===selectedRequirement.configurationBinding?.technicalSpecHash?selectedVersion?.imageTechnicalFacts:undefined} versionSha256={selectedVersion?.sha256} />}
          {selectedFamily
            ? <>{!isHistoricalVersion && <RecipePanel expanded compact definitionRef={selectedItem?.executionDefinitionRef} recipe={recipe} error={recipeError} title="" defaultOpen reviewerView />}<MaterialCandidateProductionFacts key={`${selectedFamily.id}:${selectedVersion?.id || 'NO_VERSION'}:${selectedVersion?.sha256 || 'NO_SHA'}:${selectedVersion?.outputState || 'NO_OUTPUT'}`} family={selectedFamily} version={selectedVersion} historical={isHistoricalVersion} /></>
            : composition ? <p>逐项完成上方素材后，这项组合需求才会就绪。</p> : <>{currentProductionTarget&&!hasUsageBindings&&<p className="v6-empty-note">{usageOnlyLeaf?'这项需求尚未绑定产物，可制作新图或审阅已有图片的新用途。':'这项需求尚未绑定产物，可建立制作资料并生成候选。'}</p>}{usageOnlyLeaf&&!hasUsageBindings&&<MaterialUsageEditor requirementId={selectedRequirement.id}/>} {currentProductionTarget&&!hasEligibleUsage&&selectedRequirement.sourceKind === 'DOMAIN_GRAPH' && !selectedRequirement.assetFamilyRefs.length && !selectedRequirement.plannedAssetFamilyId && <MaterialProductionSetupEditor requirementId={selectedRequirement.id} />}</>}
          {currentProductionTarget && selectedFamily && !isHistoricalVersion && (selectedItem?.materialProductionPlanId || selectedFamily.materialProductionPlanId || selectedFamily.kind === 'AUDIO' && selectedVersion?.sha256 && recipe?.model?.branch === 'seed-audio-1.0' && selectedItem?.executionDefinitionRef) && <MaterialProductionSetupEditor requirementId={selectedRequirement.id} revision />}
        </section>
        <section className="material-purpose-usage" data-material-section="purpose-usage">
          <header><h3>用途与使用位置</h3></header>
          <div className="material-purpose-grid">
            <section><h4>为什么需要</h4>{[
              ['故事需要',storyBasis?.whyNeeded],
              ['观众必须看见／听见',storyBasis?.onScreenRequirement],
              ['依据说明',storyBasis?.evidenceSpecificity],
              ['全剧适用依据',selectedRequirement.storyApplicability?.kind==='PROJECT_LEVEL' ? selectedRequirement.projectScopeReason||selectedRequirement.storyApplicability.reason : ''],
            ].filter(([,text])=>materialDisplayText(text)).map(([label,text])=><p key={label}><b>{label}：</b>{visibleText(text!)}</p>)}{!storyBasis ? <p role="status">当前详情未提供用途上下文，暂不可用。</p> : materialDisplayText(storyBasis.whyNeeded)||materialDisplayText(storyBasis.onScreenRequirement)?null:<p>当前详情没有可用的用途说明。</p>}{storyEvidenceRefs.some(ref=>materialDisplayText(ref))&&<code>{storyEvidenceRefs.map(materialDisplayText).filter(Boolean).join('；')}</code>}</section>
            <section><h4>会在哪里使用</h4><div className="material-use-links">{currentEpisodePlan ? selectedRequirement.sceneIds.filter(id=>model.scenes.some(s=>s.id===id&&s.scopeRole==='CURRENT')).map((sceneId) => <button key={sceneId} onClick={() => onOpenStoryScene(sceneId)}>阅读对应场剧本 →</button>) : <p>候选集场关联见目录集、场筛选，尚未绑定为正式输入；旧用途只作历史证据。</p>}{(selectedClassification?.currentShotIds || []).map((shotId) => <button key={shotId} onClick={() => onOpenConsumer(shotId)}>{shotId} →</button>)}</div>{!(selectedClassification?.currentShotIds || []).length && <p>尚无正式镜头绑定。</p>}</section>
          </div>
        </section>

      </>}
    </article>;

  return <div className="material-center"><section id="material-workspace-panel" className="material-workspace-panel" aria-label="素材分类管理"><h2>素材分类管理</h2><EntityMaterialCatalog initialRead={catalogRead} model={model} requirements={requirements} catalogLoading={catalogLoading} selectedRequirement={selectedRequirement} mode={workspaceMode} onSelect={select} stageFor={catalogStageFor} inspector={materialInfoCard} inspectorReady={detailReady} episodeScope={episodeScope} sceneScope={sceneScope} mediaFilter={mediaType} stageFilter={creatorStage} search={viewState.search} onFiltersChange={next=>patch({...next,businessPrimary:'全部',category:'全部',coverage:'全部'})}/></section></div>;
}
