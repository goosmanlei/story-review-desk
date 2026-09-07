'use client';

import { instanceLocalStorage } from './client-storage';
import { useInstanceProfile } from './instance-context';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { visibleText } from './review-semantics';
import { handleReviewAudioPlay, stopSeamAudition } from './review-components';
import { DocumentBlocks, type DocumentBlock, type DocumentTextAnnotation } from './document-blocks';
import { useRuntimeMode } from './runtime-mode';
import { useAssistantFocus } from './assistant/context-provider';
import { useProjectAssistantDraftTargets } from './assistant/project-draft-adapters';
import { SceneScriptCommentsPanel, sceneCommentAnchorSegments, useSceneScriptComments, type SceneCommentAnchor, type SceneCommentAnchorSegment } from './scene-script-comments';

const COMMENT_DRAFT_SELECTION_ID = '__COMMENT_DRAFT_SELECTION__';

export type AdaptationCoverage = 'FULL' | 'PARTIAL' | 'ABSENT' | 'DISTORTED' | 'CONTRADICTED' | 'NOT_APPLICABLE' | 'UNVERIFIABLE';
export type AdaptationPriority = 'MUST' | 'SHOULD' | 'OPTIONAL' | 'OMIT';

export type AdaptationAuditBeat = {
  beat_id: string;
  canonical_id?: string;
  occurrence_role?: string;
  source: {
    transcript_path: string;
    line_start: number;
    line_end: number;
    timecode_start: string;
    timecode_end: string;
    audio_path: string;
    content_sha256: string;
  };
  summary: string;
  source_kind?: string[];
  priority: AdaptationPriority;
  authority: 'F' | 'A' | 'U';
  asr_status: 'OK' | 'AUDIO_VERIFIED' | 'AUDIO_VERIFY_REQUIRED';
  story_order?: number;
  audience_knowledge?: { before?: string; after?: string; withheld?: string };
  current_mapping: {
    scene_ids?: string[];
    script_refs?: string[];
    coverage: AdaptationCoverage;
    shootability?: string;
    notes?: string;
  };
  adaptation_decision: {
    action: 'PRESERVE' | 'COMPRESS' | 'REORDER' | 'OMIT' | 'VERIFY';
    target_scene_ids?: string[];
    screen_expression?: string;
    reason?: string;
  };
  micro_beats?: Array<{ id?: string; summary?: string; function?: string; priority?: string }>;
};

export type AdaptationSceneAudit = {
  scene_id: string;
  source_beat_ids?: string[];
  must_missing_before?: string[];
  coverage_before?: string;
  coverage_after?: string;
  rewrite_summary?: string;
  new_requirements?: string[];
  status?: string;
};

export type AdaptationAudit = {
  schema_version: string;
  dataset_id: string;
  title: string;
  audit_status: string;
  summary: Record<string, unknown>;
  source_authority?: Record<string, unknown> | string[];
  classification_contract?: Record<string, unknown>;
  coverage_contract?: Record<string, unknown>;
  beats: AdaptationAuditBeat[];
  canonicalStories?: Array<Record<string, unknown>>;
  setupPayoffChains?: Array<Record<string, unknown>>;
  sceneAudits?: AdaptationSceneAudit[];
  asrIssues?: Array<Record<string, unknown>>;
  productionImpacts?: Array<Record<string, unknown>>;
  selfChecks?: Array<{ check_id?: string; name?: string; status?: string; result?: unknown; note?: string }>;
};

export type StoryConfirmationTarget = {
  reviewSpec?: import("../host/instance-runtime/configuration-model.mjs").ReviewSpec;
  sceneId: string;
  title?: string;
  scriptPath?: string;
  scriptSha256?: string;
  sceneContentHash: string;
  businessContextHash: string;
  sourceBeatIds?: string[];
  affectedDownstreamRefs?: unknown[] | Record<string, unknown>;
};

export type AudioVerificationTarget = {
  issueId: string;
  subjectId?: string;
  beatId?: string;
  beatIds?: string[];
  audioSha256: string;
  timecodeStart: string;
  timecodeEnd: string;
  currentText?: string;
  transcriptText?: string;
  safeRendering?: string;
  currentTextHash: string;
  question?: string;
  businessContextHash: string;
  primaryReviewSceneId?: string;
  affectedSceneIds?: string[];
  sceneApprovalPolicy?: string;
};

export type SceneBeatBinding = {
  beatId: string;
  relationRole: string;
  perspectiveTags: string[];
};

export type SceneReviewDossier = {
  reviewSpec?: StoryConfirmationTarget["reviewSpec"];
  sceneId: string;
  directBeatIds: string[];
  relatedBeatIds: string[];
  bindings?: SceneBeatBinding[];
  beatBindings?: SceneBeatBinding[];
  perspectiveCounts?: Record<string, number>;
  asrIssueIds: string[];
  primaryAsrIssueIds: string[];
  hardBlockers: unknown[];
  dossierHash: string;
};

type TranscriptSegment = { id: string; timecode: string; seconds: number; sourceLine: number; text: string };
type ScriptScene = {
  id: string;
  number: number;
  act: string;
  actTitle: string;
  storySequenceId: string;
  slugline: string;
  scriptExcerpt: string;
  scriptBlocks: DocumentBlock[];
  scriptCharacterCount: number;
  sourceLineStart: number;
  sourceLineEnd: number;
  sourceRef: string;
  episodeAssignment: { episodeId: string };
};

const coverageLabels: Record<AdaptationCoverage, string> = {
  FULL: '已完整表达',
  PARTIAL: '部分保留／有意压缩',
  ABSENT: '剧本缺失',
  DISTORTED: '表达失真',
  CONTRADICTED: '与原文冲突',
  NOT_APPLICABLE: '明确不采用',
  UNVERIFIABLE: '尚无法核实',
};

const filterOptions = [
  ['ALL', '全部原文'],
  ['MUST', '必须保留'],
  ['GAP', '遗漏／失真'],
  ['MISDIRECTION', '误导／揭晓'],
  ['GAG', '笑点'],
  ['UNFILMABLE', '不可拍'],
  ['VERIFY', '原音疑点'],
] as const;

type AuditLens = (typeof filterOptions)[number][0];

function hardBlockerText(value: unknown) {
  if (typeof value === 'string') return visibleText(value);
  if (!value || typeof value !== 'object') return visibleText(String(value || 'UNKNOWN'));
  const record = value as Record<string, unknown>;
  const label = String(record.message || record.reason || record.reasonCode || record.code || record.id || 'UNKNOWN');
  const subject = record.beatId || record.issueId;
  return visibleText(subject ? `${label} · ${String(subject)}` : label);
}

function relationIsDirect(value: string | undefined) {
  return String(value || '').toUpperCase().startsWith('DIRECT');
}

function beatMatchesLens(beat: AdaptationAuditBeat, lens: AuditLens) {
  const kinds = (beat.source_kind || []).join(' ').toUpperCase();
  const shootability = String(beat.current_mapping.shootability || '').toUpperCase();
  return lens === 'ALL'
    || (lens === 'MUST' && beat.priority === 'MUST')
    || (lens === 'GAP' && ['ABSENT', 'DISTORTED', 'CONTRADICTED', 'UNVERIFIABLE'].includes(beat.current_mapping.coverage))
    || (lens === 'MISDIRECTION' && /(MISDIRECTION|REVEAL|SETUP|PAYOFF)/.test(kinds))
    || (lens === 'GAG' && /(JOKE|GAG|COMEDY|HUMOR)/.test(kinds))
    || (lens === 'UNFILMABLE' && /(UNFILMABLE|NOT_FILMABLE|摘要|概括)/i.test(shootability))
    || (lens === 'VERIFY' && beat.asr_status === 'AUDIO_VERIFY_REQUIRED');
}

function inferredPerspectiveTags(beat: AdaptationAuditBeat): string[] {
  return filterOptions.map(([lens]) => lens).filter((lens) => lens !== 'ALL' && beatMatchesLens(beat, lens));
}

function bindingMatchesLens(binding: SceneBeatBinding, lens: AuditLens) {
  if (lens === 'ALL') return true;
  const aliases: Record<Exclude<AuditLens, 'ALL'>, string[]> = {
    MUST: ['MUST'],
    GAP: ['GAP'],
    MISDIRECTION: ['MISDIRECTION', 'MISDIRECTION_REVEAL'],
    GAG: ['GAG', 'JOKE'],
    UNFILMABLE: ['UNFILMABLE'],
    VERIFY: ['VERIFY', 'AUDIO_UNCERTAINTY'],
  };
  const tags = binding.perspectiveTags.map((tag) => tag.toUpperCase());
  return aliases[lens].some((tag) => tags.includes(tag));
}

function parseTimecode(value: string) {
  const parts = value.split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

type FormalAction = 'APPROVE_AND_RELEASE' | 'REQUEST_REVISION' | 'DO_NOT_USE';
type FindingVerdict = 'PASS' | 'FAIL' | 'NA' | '';
type SceneReviewDraft = {
  action: FormalAction | '';
  note: string;
  findings: Record<string, { verdict: FindingVerdict; note: string }>;
};

const legacySceneCriteria = [
  { id: 'source-fidelity', label: '原文与改编边界', question: '事实、人物关系、案件因果和明确标注的改编边界是否正确？' },
  { id: 'story-function', label: '叙事功能', question: '本场是否把对应原文节拍转成观众可理解的行动、信息或悬念？' },
  { id: 'shootability-continuity', label: '可拍性与连续性', question: '动作、空间、道具状态及前后场承接是否可直接进入后续制作？' },
] as const;

function emptySceneDraft(criteria: readonly {id:string}[] = legacySceneCriteria): SceneReviewDraft {
  return {
    action: '',
    note: '',
    findings: Object.fromEntries(criteria.map((item) => [item.id, { verdict: '', note: '' }])),
  };
}

function formalActionLabel(action: FormalAction | '') {
  return action === 'APPROVE_AND_RELEASE' ? '通过并放行' : action === 'REQUEST_REVISION' ? '要求修改' : action === 'DO_NOT_USE' ? '禁止使用' : '未选择';
}

function findingVerdictLabel(verdict: FindingVerdict) {
  return verdict === 'PASS' ? '通过' : verdict === 'FAIL' ? '有问题' : verdict === 'NA' ? '不适用' : '未判断';
}

async function digest(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes)).map((item) => item.toString(16).padStart(2, '0')).join('');
}

async function currentMutation(snapshotId: string) {
  const response = await fetch('/api/v8/operations/snapshot', { cache: 'no-store' });
  const payload = await response.json() as { snapshotId?: string; mutationEtag?: string; etag?: string; error?: string };
  if (!response.ok) throw new Error(payload.error || `运行快照 HTTP ${response.status}`);
  if (payload.snapshotId !== snapshotId) throw new Error('基础快照已变化，请刷新后重新核对');
  const etag = payload.mutationEtag || payload.etag;
  if (!etag) throw new Error('运行快照缺少安全写入ETag');
  return etag;
}

function useSmallScreen() {
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 639px)');
    const update = () => setBlocked(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return blocked;
}

export function CurrentSceneConfirmationReview({target,snapshotId}:{target:StoryConfirmationTarget;snapshotId:string}) {
  const journeyResult=useSceneJourney(target.sceneId,snapshotId);
  return <SceneConfirmationReview key={`${target.sceneId}:${target.businessContextHash}`} target={target} snapshotId={snapshotId} journeyResult={journeyResult}/>;
}

function SceneConfirmationReview({ target, snapshotId, hardBlockers = [], journeyResult }: { target: StoryConfirmationTarget; snapshotId: string; hardBlockers?: unknown[]; journeyResult: SceneJourneyResult }) {
  const sceneCriteria = useMemo(()=>target.reviewSpec?.criteria || legacySceneCriteria,[target.reviewSpec]);
  const instance = useInstanceProfile();
  const { hostedReadOnly } = useRuntimeMode();
  const legacyStorageKey = `review.sceneReviewDraft.v1:${target.sceneId}:${target.sceneContentHash}`;
  const storageKey = `review.sceneReviewDraft.v2:${target.sceneId}:${target.sceneContentHash}:${target.businessContextHash}:${target.reviewSpec?.hash||'legacy'}`;
  const [draft, setDraft] = useState<SceneReviewDraft>(()=>emptySceneDraft(sceneCriteria));
  const latestDraftRef = useRef<SceneReviewDraft>(draft);
  const [hydrated, setHydrated] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState('草稿只保存在本机；正式提交后才改变场次采用状态。');
  const [effective, setEffective] = useState<Record<string, unknown> | null>(null);
  const mobileBlocked = useSmallScreen();
  const effectiveForCurrentHash = effective
    && String(effective.subjectRevisionHash || '').toLowerCase() === target.sceneContentHash.toLowerCase()
    && String(effective.contextHash || '').toLowerCase() === target.businessContextHash.toLowerCase()
    ? effective
    : null;
  const effectiveAction = String(effectiveForCurrentHash?.action || effectiveForCurrentHash?.reviewAction || '') as FormalAction | '';

  function updateDraft(updater: (value: SceneReviewDraft) => SceneReviewDraft) {
    setDraft((value) => {
      const next = updater(value);
      latestDraftRef.current = next;
      return next;
    });
  }

  function persistDraft(value: SceneReviewDraft) {
    try {
      instanceLocalStorage.setItem(storageKey, JSON.stringify(value));
      document.documentElement.dataset.reviewDraftUnsaved = 'false';
      return true;
    } catch {
      document.documentElement.dataset.reviewDraftUnsaved = 'true';
      setMessage('本机草稿保存失败，请提交前复制备注。');
      return false;
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const currentSaved = instanceLocalStorage.getItem(storageKey);
        const legacySaved = currentSaved || target.reviewSpec && !target.reviewSpec.legacy ? null : instanceLocalStorage.getItem(legacyStorageKey);
        const saved = currentSaved || legacySaved;
        const loaded = saved ? { ...emptySceneDraft(sceneCriteria), ...JSON.parse(saved) as SceneReviewDraft } : emptySceneDraft(sceneCriteria);
        latestDraftRef.current = loaded;
        setDraft(loaded);
        document.documentElement.dataset.reviewDraftUnsaved = 'false';
        if (legacySaved) {
          instanceLocalStorage.setItem(storageKey, JSON.stringify(loaded));
          setMessage('已载入并迁移本机场次草稿；正式提交前不会改变项目状态。');
        }
      } catch {
        document.documentElement.dataset.reviewDraftUnsaved = 'true';
        setMessage('本机草稿读取失败，请提交前复制备注。');
      }
      setHydrated(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [legacyStorageKey, storageKey, sceneCriteria, target.reviewSpec]);

  useEffect(() => {
    if (!hydrated) return;
    const timer = window.setTimeout(() => { persistDraft(draft); }, 350);
    return () => window.clearTimeout(timer);
    // persistDraft writes the current scene-and-context-bound local key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, hydrated, storageKey]);

  useEffect(() => {
    if (!hydrated) return;
    const flush = () => { persistDraft(latestDraftRef.current); };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      flush();
      if (document.documentElement.dataset.reviewDraftUnsaved === 'true') event.preventDefault();
    };
    window.addEventListener('review:flush-review-draft', flush);
    window.addEventListener('popstate', flush);
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      flush();
      window.removeEventListener('review:flush-review-draft', flush);
      window.removeEventListener('popstate', flush);
      window.removeEventListener('beforeunload', beforeUnload);
    };
    // persistDraft writes synchronously to the current scene-and-context key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, storageKey]);

  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => fetch('/api/v8/operations/snapshot', { cache: 'no-store', signal: controller.signal })
      .then((response) => response.ok ? response.json() : null)
      .then((value) => {
        const payload = value as { stateProjection?: { scriptScenesById?: Record<string, Record<string, unknown>> } } | null;
        setEffective(payload?.stateProjection?.scriptScenesById?.[target.sceneId] || null);
      })
      .catch(() => undefined);
    void refresh();
    window.addEventListener('review:operations-updated', refresh);
    return () => { controller.abort(); window.removeEventListener('review:operations-updated', refresh); };
  }, [target.sceneId]);

  const missingCriteria = sceneCriteria.filter((criterion) => !draft.findings[criterion.id]?.verdict);
  const failedCriteria = sceneCriteria.filter((criterion) => draft.findings[criterion.id]?.verdict === 'FAIL');
  const projectHandoff = journeyResult.projectJourney?.storyHandoff;
  const journeyReasons = [...new Set([
    ...sceneHandoffReasons(journeyResult.journey?.storyHandoff),
    ...sceneHandoffReasons(projectHandoff),
  ])];
  const episodePlanUnavailable = journeyReasons.some((reason) => [
    'CURRENT_EPISODE_PLAN_UNAVAILABLE',
    'CURRENT_SYNCED_EPISODE_PLAN_REQUIRED',
    'EPISODE_PLAN_NOT_ADOPTED',
    'EPISODE_PLAN_SOURCE_SYNC_REQUIRED',
  ].includes(reason)) || !projectHandoff?.currentEpisodePlanRevisionId || !['SOURCE_CURRENT', 'SUCCEEDED'].includes(String(projectHandoff.episodePlanSourceSyncState || 'UNKNOWN'));
  const submitIssues: string[] = [];
  if (hostedReadOnly) submitIssues.push('远端为只读同步镜像；请在本地 localhost:3000 完成正式提交。');
  if (!hydrated) submitIssues.push('正在读取本机草稿，请稍候。');
  if (journeyResult.loading) submitIssues.push('正在通过Journey 1.2核对全剧分集方案交接，请稍候。');
  else if (journeyResult.error || !journeyResult.journey?.storyHandoff) submitIssues.push(`分集方案交接为UNKNOWN：${journeyResult.error || 'Journey 1.2缺少storyHandoff'}。`);
  else if (episodePlanUnavailable) submitIssues.push('请先完成全剧分集方案的整体确认与受控源同步，再提交本场正文审阅。');
  if (mobileBlocked) submitIssues.push('小屏只允许保存草稿；请在宽度至少640px的屏幕正式提交。');
  if (!draft.action) submitIssues.push('请选择一个正式结论。');
  if (missingCriteria.length) submitIssues.push(`请完成${missingCriteria.map((criterion) => `“${criterion.label}”`).join('、')}的判断。`);
  if (draft.action === 'APPROVE_AND_RELEASE' && failedCriteria.length) {
    submitIssues.push(`“通过并放行”不能包含“有问题”项；请修正${failedCriteria.map((criterion) => `“${criterion.label}”`).join('、')}的判断，或改选“要求修改／禁止使用”。`);
  }
  if (draft.action === 'APPROVE_AND_RELEASE' && hardBlockers.length) {
    submitIssues.push(`“通过并放行”被${hardBlockers.length}项场次硬阻断关闭；可改选“要求修改／禁止使用”，或先更新权威数据。`);
  }
  if (draft.action === 'REQUEST_REVISION' && !failedCriteria.length) submitIssues.push('“要求修改”至少需要一项判断为“有问题”。');
  const canSubmit = Boolean(!effectiveForCurrentHash && submitIssues.length === 0 && !submitting);

  async function submit() {
    if (!canSubmit) return;
    try {
      setSubmitting(true);
      setMessage('正在提交并应用场次审阅结论…');
      const criterionFindings = sceneCriteria.map((criterion) => ({
        criterionId: criterion.id,
        verdict: draft.findings[criterion.id].verdict,
        note: draft.findings[criterion.id].note.trim() || undefined,
      }));
      const request = {
        schemaVersion: '2.2', snapshotId, reviewSpecHash: target.reviewSpec?.hash, subjectType: 'SCRIPT_SCENE', subjectId: target.sceneId,
        subjectRevisionId: target.sceneId, scopeType: 'SCENE', scopeId: target.sceneId,
        subjectRevisionHash: target.sceneContentHash, contextHash: target.businessContextHash,
        criterionFindings, action: draft.action,
        revisionInstructions: draft.action === 'REQUEST_REVISION' && draft.note.trim()
          ? { preserve: [], change: [draft.note.trim()], mustNotRegress: [] }
          : null,
        note: draft.note.trim() || undefined,
      };
      const [etag, key] = await Promise.all([currentMutation(snapshotId), digest(JSON.stringify(request))]);
      const response = await fetch('/api/v8/reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'If-Match': etag, 'Idempotency-Key': `scene-review-${key}` },
        body: JSON.stringify(request),
      });
      const payload = await response.json() as { eventId?: string; error?: string };
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      instanceLocalStorage.removeItem(storageKey);
      instanceLocalStorage.removeItem(legacyStorageKey);
      document.documentElement.dataset.reviewDraftUnsaved = 'false';
      setMessage(`正式结论已原子应用：${payload.eventId || '已提交'}。通过会立即成为当前采用结论；修改／禁用会立即阻断下游。`);
      window.dispatchEvent(new CustomEvent('review:operations-updated'));
    } catch (reason) {
      setMessage(`提交失败：${reason instanceof Error ? reason.message : 'UNKNOWN'}`);
    } finally { setSubmitting(false); }
  }

  useAssistantFocus({
    projectId: instance.projectId, snapshotId, view: 'audit', subjectType: 'SCENE',
    subjectId: target.sceneId, title: `场级拆解 · ${target.sceneId} · 场正文审阅`, versionId: target.sceneContentHash,
    references: [`business-context:${target.businessContextHash}:${target.reviewSpec?.hash||'legacy'}`],
  }, 10);
  const assistantDrafts = useProjectAssistantDraftTargets({
    identity: `scene:${snapshotId}:${target.sceneId}:${target.sceneContentHash}:${target.businessContextHash}:${target.reviewSpec?.hash||'legacy'}`,
    subjectId: target.sceneId, versionId: target.sceneContentHash, defaultFieldId: 'note',
    fields: [
      ...sceneCriteria.map((criterion) => ({ fieldId: `criterion:${criterion.id}`, label: `${target.sceneId} · ${criterion.label}意见`, value: draft.findings[criterion.id]?.note || '' })),
      { fieldId: 'note', label: `${target.sceneId} · 场正文总体说明`, value: draft.note },
    ],
    canAdopt: hydrated && !hostedReadOnly && !submitting && !effectiveForCurrentHash,
    disabledReason: '当前场正文已裁决或草稿暂不可编辑；建议仍可复制。',
    applyField: (fieldId, nextValue) => updateDraft((current) => fieldId === 'note'
      ? { ...current, note: nextValue }
      : { ...current, findings: { ...current.findings, [fieldId.slice('criterion:'.length)]: {
        ...(current.findings[fieldId.slice('criterion:'.length)] || { verdict: '', note: '' }), note: nextValue,
      } } }),
  });
  return <section className="adaptation-formal-review" aria-labelledby={`scene-review-${target.sceneId}`}>
    <header><div><small>FORMAL SCRIPT SCENE REVIEW</small><h3 id={`scene-review-${target.sceneId}`}>{target.sceneId} · 全剧场正文确认</h3><p>对象绑定场次内容哈希与审计上下文；不是泛化的“剧本已看”。</p></div><span>{effectiveForCurrentHash ? formalActionLabel(effectiveAction) : '待正式结论'}</span></header>
    {mobileBlocked && <p className="creator-mobile-review-block"><b>小屏草稿模式</b>可以完成全部判断并自动保存；最终提交需在宽度至少640px的屏幕再次核对。</p>}
    <div className="adaptation-binding"><span>场次内容</span><code>{target.sceneContentHash}</code><span>审计上下文</span><code>{target.businessContextHash}</code></div>
    {hardBlockers.length > 0 && <section className="adaptation-hard-blockers" role="alert"><b>场次硬阻断 · {hardBlockers.length}项</b><p>下列问题只阻止“通过并放行”；仍可提交“要求修改”或“禁止使用”。原音核验处于UNKNOWN本身不是硬阻断。</p><ul>{hardBlockers.map((item, index) => <li key={`${index}:${hardBlockerText(item)}`}>{hardBlockerText(item)}</li>)}</ul></section>}
    {effectiveForCurrentHash && <p className="creator-mobile-review-block scene-review-immutable" role="status"><b>这一正文哈希已经完成正式裁决</b>{effectiveAction === 'REQUEST_REVISION'
      ? '当前结论是“要求修改”。请先修改权威剧本并形成新的场次内容哈希，再对新哈希提交审阅；同一哈希不能反向改判为通过。'
      : effectiveAction === 'DO_NOT_USE'
        ? '“禁止使用”是这一正文哈希的终态；只能以权威源的新哈希创建下一轮审阅。'
        : '当前正文已经通过并放行；如需改变内容，应先形成新的权威源哈希再审。'}</p>}
    <div className="adaptation-form-criteria">{sceneCriteria.map((criterion) => {
      const finding = draft.findings[criterion.id] || { verdict: '', note: '' };
      return <article className={finding.verdict ? `is-${finding.verdict.toLowerCase()}` : ''} key={criterion.id}><div><b>{criterion.label}</b><p>{criterion.question}</p><small className="adaptation-finding-state">当前判断：{findingVerdictLabel(finding.verdict)}</small></div><div role="radiogroup" aria-label={criterion.label}>{([['PASS', '通过'], ['FAIL', '有问题'], ['NA', '不适用']] as const).filter(([v])=>v!=='NA'||!("allowNA" in criterion)||criterion.allowNA!==false).map(([verdict, label]) => <button type="button" role="radio" aria-checked={finding.verdict === verdict} disabled={!hydrated || Boolean(effectiveForCurrentHash)} className={finding.verdict === verdict ? 'active' : ''} key={verdict} onClick={() => updateDraft((value) => ({ ...value, findings: { ...value.findings, [criterion.id]: { ...(value.findings[criterion.id] || { verdict: '', note: '' }), verdict: value.findings[criterion.id]?.verdict === verdict ? '' : verdict } } }))}>{label}</button>)}</div><label><span>{finding.verdict === 'FAIL' ? '问题与修改方向（可选）' : '说明（可选）'}</span><input disabled={!hydrated || Boolean(effectiveForCurrentHash)} value={finding.note} onFocus={() => assistantDrafts.activateField(`criterion:${criterion.id}`)} onChange={(event) => updateDraft((value) => ({ ...value, findings: { ...value.findings, [criterion.id]: { ...(value.findings[criterion.id] || { verdict: '', note: '' }), note: event.target.value } } }))} placeholder={finding.verdict === 'FAIL' ? '可选：补充问题与修改方向' : '可选'} /></label></article>;
    })}</div>
    <fieldset disabled={!hydrated || Boolean(effectiveForCurrentHash)}><legend>正式结论（需与上方判断一致）</legend>{(['APPROVE_AND_RELEASE', 'REQUEST_REVISION', 'DO_NOT_USE'] as const).map((action) => <button type="button" aria-pressed={draft.action === action} className={draft.action === action ? 'active' : ''} key={action} onClick={() => updateDraft((value) => ({ ...value, action: value.action === action ? '' : action }))}>{formalActionLabel(action)}</button>)}</fieldset>
    <label className="adaptation-form-note"><span>总体说明（可选）</span><textarea disabled={!hydrated || Boolean(effectiveForCurrentHash)} value={draft.note} onFocus={() => assistantDrafts.activateField('note')} onChange={(event) => updateDraft((value) => ({ ...value, note: event.target.value }))} placeholder="可选：补充通过依据、修改方向或禁用原因…" /></label>
    <button type="button" disabled={hostedReadOnly || !assistantDrafts.hasTargets} onClick={assistantDrafts.askAboutActiveDraft}>结合这条意见问助手</button>
    {!effectiveForCurrentHash && <div className={`adaptation-submit-check ${canSubmit ? 'is-ready' : 'is-blocked'}`} role="status" aria-live="polite"><b>{canSubmit ? '已满足正式提交条件' : `还不能正式提交（${submitIssues.length}项）`}</b>{canSubmit ? <p>当前判断与“{formalActionLabel(draft.action)}”一致；提交后将写入不可变审阅事件并立即应用场次采用状态。</p> : <ul>{submitIssues.map((issue) => <li key={issue}>{issue}</li>)}</ul>}</div>}
    <footer><button type="button" disabled={!canSubmit} onClick={() => void submit()}>{submitting ? '提交中…' : effectiveForCurrentHash ? '本正文已完成正式裁决' : canSubmit ? `正式提交：${formalActionLabel(draft.action)}` : `尚有${submitIssues.length}项待完成`}</button><p role="status" aria-live="polite">{message}</p></footer>
  </section>;
}

function useVerificationProjection(target: AudioVerificationTarget) {
  const [effective, setEffective] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => fetch('/api/v8/operations/snapshot', { cache: 'no-store', signal: controller.signal })
      .then((response) => response.ok ? response.json() : null)
      .then((value) => {
        const payload = value as { stateProjection?: { verificationsByIssue?: Record<string, Record<string, unknown>> } } | null;
        setEffective(payload?.stateProjection?.verificationsByIssue?.[target.issueId] || null);
      })
      .catch(() => undefined);
    void refresh();
    window.addEventListener('review:operations-updated', refresh);
    return () => { controller.abort(); window.removeEventListener('review:operations-updated', refresh); };
  }, [target.issueId]);
  return effective
    && String(effective.audioSha256 || '').toLowerCase() === target.audioSha256.toLowerCase()
    && String(effective.currentTextHash || '').toLowerCase() === target.currentTextHash.toLowerCase()
    && String(effective.businessContextHash || '').toLowerCase() === target.businessContextHash.toLowerCase()
    && String(effective.timecodeStart || '') === target.timecodeStart
    && String(effective.timecodeEnd || '') === target.timecodeEnd
    ? effective
    : null;
}

function AudioVerificationReview({ target, snapshotId }: { target: AudioVerificationTarget; snapshotId: string }) {
  const { hostedReadOnly } = useRuntimeMode();
  const storageKey = `review.audioVerificationDraft.v1:${target.issueId}:${target.businessContextHash}`;
  const [outcome, setOutcome] = useState<'CONFIRMED_CURRENT' | 'CORRECTED' | 'UNRESOLVED_AFTER_LISTENING' | ''>('');
  const [correctedText, setCorrectedText] = useState('');
  const [note, setNote] = useState('');
  const [hydrated, setHydrated] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState('回听结论是独立事实事件；“修正”不会由网页直接改写逐字稿。');
  const mobileBlocked = useSmallScreen();
  const effectiveForCurrentBinding = useVerificationProjection(target);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const saved = JSON.parse(instanceLocalStorage.getItem(storageKey) || 'null') as { outcome?: typeof outcome; correctedText?: string; note?: string } | null;
        if (saved) { setOutcome(saved.outcome || ''); setCorrectedText(saved.correctedText || ''); setNote(saved.note || ''); }
      } catch { setMessage('本机草稿读取失败，请提交前复制记录。'); }
      setHydrated(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [storageKey]);
  useEffect(() => {
    if (!hydrated) return;
    const timer = window.setTimeout(() => {
      try { instanceLocalStorage.setItem(storageKey, JSON.stringify({ outcome, correctedText, note })); }
      catch { setMessage('本机草稿保存失败，请提交前复制记录。'); }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [correctedText, hydrated, note, outcome, storageKey]);

  const canSubmit = Boolean(!hostedReadOnly && !effectiveForCurrentBinding && !mobileBlocked && outcome && !submitting
    && (outcome !== 'CORRECTED' || correctedText.trim())
    && (outcome !== 'UNRESOLVED_AFTER_LISTENING' || note.trim()));
  async function submit() {
    if (!canSubmit) return;
    try {
      setSubmitting(true);
      setMessage('正在登记原音核实结论…');
      const request = {
        schemaVersion: '1.0', snapshotId, issueId: target.issueId, outcome,
        audioSha256: target.audioSha256, timecodeStart: target.timecodeStart, timecodeEnd: target.timecodeEnd,
        currentTextHash: target.currentTextHash, businessContextHash: target.businessContextHash,
        correctedText: outcome === 'CORRECTED' ? correctedText.trim() : null,
        note: note.trim(),
      };
      const [etag, key] = await Promise.all([currentMutation(snapshotId), digest(JSON.stringify(request))]);
      const response = await fetch('/api/v8/verifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'If-Match': etag, 'Idempotency-Key': `audio-verify-${key}` },
        body: JSON.stringify(request),
      });
      const payload = await response.json() as { eventId?: string; error?: string };
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      instanceLocalStorage.removeItem(storageKey);
      setMessage(outcome === 'CORRECTED'
        ? `核实事件已登记：${payload.eventId || '已提交'}。修正文本仍等待显式授权受控源同步。`
        : `核实事件已登记并应用：${payload.eventId || '已提交'}。`);
      window.dispatchEvent(new CustomEvent('review:operations-updated'));
    } catch (reason) { setMessage(`提交失败：${reason instanceof Error ? reason.message : 'UNKNOWN'}`); }
    finally { setSubmitting(false); }
  }

  return <section className="adaptation-formal-review audio-verification-review" aria-labelledby={`audio-review-${target.issueId}`}>
    <header><div><small>OPTIONAL VERIFICATION EVENT</small><h3 id={`audio-review-${target.issueId}`}>{target.issueId} · 场内核对原音疑点</h3><p>{visibleText(target.question || '关键词句仍可回听原始录音核对')}</p></div><span>{effectiveForCurrentBinding ? '已登记' : `${target.timecodeStart}–${target.timecodeEnd}`}</span></header>
    <p className="audio-verification-policy"><b>与场次审批互不代替。</b>本表单只登记VerificationEvent；即使结论为“已回听仍无法辨明”，也不会自动阻止场次批准。场次批准也不会自动提交本表单。{target.sceneApprovalPolicy ? ` 当前策略：${visibleText(target.sceneApprovalPolicy)}` : ''}</p>
    {mobileBlocked && <p className="creator-mobile-review-block"><b>小屏草稿模式</b>可以记录核实草稿；正式提交需在宽度至少640px的屏幕完成。</p>}
    {effectiveForCurrentBinding && <p className="creator-mobile-review-block scene-review-immutable" role="status"><b>这一原音、文本与上下文绑定已经完成核验</b>
      当前结论：{String(effectiveForCurrentBinding.outcome || 'UNKNOWN')}；事件 {String(effectiveForCurrentBinding.eventId || 'UNKNOWN')}。如需重新判断，必须先由权威源形成新的音频、文本、时间窗或业务上下文哈希，不能用新事件静默覆盖当前事实。
    </p>}
    <section className="audio-verification-transcript"><b>当前逐字稿（本事件校验对象）</b><blockquote>{visibleText(target.transcriptText || target.currentText || 'UNKNOWN')}</blockquote><code>SHA-256 {target.currentTextHash}</code></section>
    <section className="audio-verification-safe-rendering"><b>当前安全改编（不等于原音文本）</b><p>{visibleText(target.safeRendering || 'UNKNOWN')}</p></section>
    <fieldset disabled={Boolean(effectiveForCurrentBinding)}><legend>回听结论</legend>{([['CONFIRMED_CURRENT', '原音与当前逐字稿一致'], ['CORRECTED', '记录听到的准确文本'], ['UNRESOLVED_AFTER_LISTENING', '已回听仍无法辨明']] as const).map(([value, label]) => <button type="button" aria-pressed={outcome === value} className={outcome === value ? 'active' : ''} key={value} onClick={() => setOutcome(previous => previous === value ? '' : value)}>{label}</button>)}</fieldset>
    {outcome === 'CORRECTED' && <label className="adaptation-form-note"><span>修正后的精确文本（必填）</span><textarea disabled={Boolean(effectiveForCurrentBinding)} value={correctedText} onChange={(event) => setCorrectedText(event.target.value)} placeholder="只记录能够从指定原音时段确认的文本…" /></label>}
    <label className="adaptation-form-note"><span>{outcome === 'UNRESOLVED_AFTER_LISTENING' ? '回听说明（必填）' : '回听说明（可选）'}</span><textarea disabled={Boolean(effectiveForCurrentBinding)} value={note} onChange={(event) => setNote(event.target.value)} placeholder="听辨依据、仍不确定的部分或修正理由…" /></label>
    <div className="adaptation-binding"><span>原音SHA</span><code>{target.audioSha256}</code><span>业务上下文</span><code>{target.businessContextHash}</code></div>
    <footer><button type="button" disabled={!canSubmit} onClick={() => void submit()}>{submitting ? '提交中…' : '正式登记回听结论'}</button><p role="status" aria-live="polite">{message}</p></footer>
  </section>;
}

function SharedAudioVerificationState({ target, currentSceneId, onOpenOwner }: { target: AudioVerificationTarget; currentSceneId: string; onOpenOwner: () => void }) {
  const effective = useVerificationProjection(target);
  const owner = target.primaryReviewSceneId || target.affectedSceneIds?.[0] || 'UNKNOWN';
  return <section className="audio-verification-shared" aria-label={`${target.issueId}共享原音核验状态`}>
    <header><div><small>SHARED VERIFICATION STATE</small><h3>{target.issueId} · {currentSceneId}是关联场</h3></div><span>{effective ? '已登记' : '待可选回听'}</span></header>
    <p>这是跨场共享的同一项原音事实，不在{currentSceneId}重复创建表单。主审场为<b>{owner}</b>；当前共享结论为<b>{effective ? String(effective.outcome || 'UNKNOWN') : 'UNKNOWN'}</b>。</p>
    <div><code>{target.timecodeStart}–{target.timecodeEnd}</code><button type="button" onClick={onOpenOwner}>到{owner}查看可选核验</button></div>
  </section>;
}

function SceneEvidenceCard({ beat, binding, transcript, onPlay }: {
  beat: AdaptationAuditBeat;
  binding: SceneBeatBinding;
  transcript?: TranscriptSegment;
  onPlay: () => void;
}) {
  return <article className="adaptation-scene-evidence-card" data-relation={relationIsDirect(binding.relationRole) ? 'DIRECT' : 'RELATED'} data-beat-id={beat.beat_id}>
    <header><div><small>{relationIsDirect(binding.relationRole) ? '本场直接依据' : '跨场上下文'}</small><h4>{beat.beat_id}{beat.canonical_id ? ` · ${beat.canonical_id}` : ''}</h4></div><button type="button" onClick={onPlay}>{beat.source.timecode_start}起播放</button></header>
    <blockquote>{visibleText(transcript?.text || beat.summary)}</blockquote>
    <div className="adaptation-scene-evidence-tags"><span data-priority={beat.priority}>{beat.priority}</span><span>{coverageLabels[beat.current_mapping.coverage]}</span><span>{beat.adaptation_decision.action}</span>{beat.asr_status === 'AUDIO_VERIFY_REQUIRED' && <span>原音疑点</span>}</div>
    <dl><div><dt>对本场的要求</dt><dd>{visibleText(beat.adaptation_decision.screen_expression || beat.current_mapping.notes || 'UNKNOWN')}</dd></div><div><dt>观众所得</dt><dd>{visibleText(beat.audience_knowledge?.after || 'UNKNOWN')}</dd></div></dl>
  </article>;
}

type SceneJourney = {
  schemaVersion: string;
  projectionSource?: string;
  snapshotId: string;
  scope: {
    scopeType: string;
    scopeId: string;
    label?: string;
    episodeId?: string | null;
    scopeRole?: string;
  };
  storyHandoff?: {
    state?: 'READY' | 'WAITING' | 'BLOCKED' | 'UNKNOWN';
    status?: string;
    canEnterProduction?: boolean;
    nextGateId?: string | null;
    basisSnapshotId?: string | null;
    screenplayReleaseSnapshotId?: string | null;
    episodePlanRevisionId?: string | null;
    currentEpisodePlanRevisionId?: string | null;
    episodePlanSourceSyncState?: string | null;
    sceneCoveragePlanRevisionId?: string | null;
    shotPlanSetRevisionId?: string | null;
    scopeLockId?: string | null;
    reasons?: string[];
    reasonCodes?: string[];
    blockingReasons?: string[];
    blockReasons?: string[];
  };
  summary?: {
    currentProductionPhaseId?: string | null;
    currentProductionGateId?: string | null;
    actionCount?: number;
    actionable?: number;
    waiting?: number;
    blocked?: number;
    workItemCount?: number;
  };
  programs?: Array<{ id: string; label?: string; openCount?: number; actionableCount?: number; waitingCount?: number; blockedCount?: number }>;
  phases?: Array<{ id: string; label?: string; gates?: Array<{ id: string; label?: string }> }>;
};

type SceneJourneyResult = { requestKey: string; journey: SceneJourney | null; projectJourney: SceneJourney | null; error: string; loading: boolean };

function sceneHandoffReasons(handoff?: SceneJourney['storyHandoff']) {
  return [...new Set([
    ...(handoff?.reasons || []),
    ...(handoff?.reasonCodes || []),
    ...(handoff?.blockingReasons || []),
    ...(handoff?.blockReasons || []),
  ])];
}

function useSceneJourney(sceneId: string | null, snapshotId: string): SceneJourneyResult {
  const instance = useInstanceProfile();
  const requestKey = `${instance.projectId}:${snapshotId}:${sceneId || 'NO_SCENE'}`;
  const [result, setResult] = useState<SceneJourneyResult>({ requestKey: '', journey: null, projectJourney: null, error: '', loading: false });

  useEffect(() => {
    if (!sceneId) return;
    const controller = new AbortController();
    const readJourney = async (scopeType: 'SCENE' | 'PROJECT', scopeId: string) => {
      const response = await fetch(`/api/v8/journeys?scopeType=${scopeType}&scopeId=${encodeURIComponent(scopeId)}`, { cache: 'no-store', signal: controller.signal });
      const payload = await response.json() as SceneJourney & { error?: string };
      if (!response.ok) throw new Error(payload.error || `${scopeType} Journey HTTP ${response.status}`);
      if (payload.schemaVersion !== '1.2') throw new Error(`需要Journey 1.2，实际为${payload.schemaVersion || 'UNKNOWN'}`);
      if (payload.snapshotId !== snapshotId || payload.scope?.scopeType !== scopeType || payload.scope?.scopeId !== scopeId) {
        throw new Error(`${scopeType} Journey与当前业务范围或基础快照不一致`);
      }
      if (!payload.storyHandoff) throw new Error(`${scopeType} Journey 1.2缺少storyHandoff`);
      return payload;
    };
    Promise.all([readJourney('SCENE', sceneId), readJourney('PROJECT', instance.projectId)])
      .then(([journey, projectJourney]) => {
        setResult({ requestKey, journey, projectJourney, error: '', loading: false });
      })
      .catch((reason: unknown) => {
        if ((reason as { name?: string }).name !== 'AbortError') setResult({ requestKey, journey: null, projectJourney: null, error: reason instanceof Error ? reason.message : 'UNKNOWN', loading: false });
      });
    return () => controller.abort();
  }, [instance.projectId, requestKey, sceneId, snapshotId]);

  return result.requestKey === requestKey
    ? result
    : { requestKey, journey: null, projectJourney: null, error: '', loading: Boolean(sceneId) };
}

export function AdaptationAuditWorkbench({
  audit,
  transcriptSegments,
  scenes,
  onSelectReviewScene,
  initialBeatId,
  selectedSceneId,
  selectedVerificationIssueId,
  highlightedAnchor,
  snapshotId,
  storyConfirmations,
  audioVerifications,
  sceneReviewDossiers,
}: {
  audit: AdaptationAudit;
  transcriptSegments: TranscriptSegment[];
  scenes: ScriptScene[];
  onSelectReviewScene: (sceneId: string, beatId: string, originLabel?: string, verificationIssueId?: string) => void;
  initialBeatId?: string | null;
  selectedSceneId?: string | null;
  selectedVerificationIssueId?: string | null;
  highlightedAnchor?: string | null;
  snapshotId: string;
  storyConfirmations: StoryConfirmationTarget[];
  audioVerifications: AudioVerificationTarget[];
  sceneReviewDossiers: SceneReviewDossier[];
}) {
  const [sceneLens, setSceneLens] = useState<AuditLens>('ALL');
  const [sceneReviewStates, setSceneReviewStates] = useState<Record<string, string>>({});
  const [activeAudioBeatId, setActiveAudioBeatId] = useState<string | null>(null);
  const [commentSelection, setCommentSelection] = useState<SceneCommentAnchor | null>(null);
  const [commentSelectionSceneId, setCommentSelectionSceneId] = useState<string | null>(null);
  const [commentSelectionMessage, setCommentSelectionMessage] = useState('圈选正文中的连续文字，可跨段落或对白；修改意见入口位于右侧审阅区下方。');
  const [selectedCommentId, setSelectedCommentId] = useState<string | null>(null);
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const sceneWorkbenchRef = useRef<HTMLElement | null>(null);
  const sceneSelectionScrollModeRef = useRef<{ sceneId: string; mode: 'WORKBENCH' | 'PRESERVE_PAGE_POSITION' } | null>(null);
  const sceneReaderScrollRef = useRef<HTMLDivElement | null>(null);
  const sceneDecisionPaneRef = useRef<HTMLElement | null>(null);
  const transcriptById = useMemo(() => new Map(transcriptSegments.map((segment) => [segment.id, segment])), [transcriptSegments]);
  const sceneById = useMemo(() => new Map(scenes.map((scene) => [scene.id, scene])), [scenes]);
  const beatById = useMemo(() => new Map(audit.beats.map((beat) => [beat.beat_id, beat])), [audit.beats]);
  const requestedAudioVerification = selectedVerificationIssueId
    ? audioVerifications.find((item) => item.issueId === selectedVerificationIssueId) || null
    : null;
  const effectiveDossiers = useMemo<SceneReviewDossier[]>(() => {
    if (sceneReviewDossiers.length) return sceneReviewDossiers;
    return scenes.map((scene) => {
      const mappedBeatIds = audit.beats
        .filter((beat) => [...(beat.current_mapping.scene_ids || []), ...(beat.adaptation_decision.target_scene_ids || [])].includes(scene.id))
        .map((beat) => beat.beat_id);
      const declaredDirectBeatIds = audit.sceneAudits?.find((item) => item.scene_id === scene.id)?.source_beat_ids || [];
      const directBeatIds = declaredDirectBeatIds.filter((beatId) => beatById.has(beatId));
      const relatedBeatIds = mappedBeatIds.filter((beatId) => !directBeatIds.includes(beatId));
      const bindings = [...directBeatIds.map((beatId) => ({ beatId, relationRole: 'DIRECT_SOURCE', perspectiveTags: inferredPerspectiveTags(beatById.get(beatId) as AdaptationAuditBeat) })), ...relatedBeatIds.map((beatId) => ({ beatId, relationRole: 'RELATED_CONTEXT', perspectiveTags: inferredPerspectiveTags(beatById.get(beatId) as AdaptationAuditBeat) }))];
      const asrTargets = audioVerifications.filter((item) => item.affectedSceneIds?.includes(scene.id));
      return {
        sceneId: scene.id,
        directBeatIds,
        relatedBeatIds,
        bindings,
        perspectiveCounts: {},
        asrIssueIds: asrTargets.map((item) => item.issueId),
        primaryAsrIssueIds: asrTargets.filter((item) => item.primaryReviewSceneId === scene.id).map((item) => item.issueId),
        hardBlockers: [],
        dossierHash: 'UNKNOWN',
      } satisfies SceneReviewDossier;
    });
  }, [audit.beats, audit.sceneAudits, audioVerifications, beatById, sceneReviewDossiers, scenes]);
  const initialBeat = initialBeatId ? beatById.get(initialBeatId) : null;
  const initialBeatSceneId = initialBeat
    ? [...(initialBeat.current_mapping.scene_ids || []), ...(initialBeat.adaptation_decision.target_scene_ids || [])][0]
      || effectiveDossiers.find((item) => item.directBeatIds.includes(initialBeat.beat_id))?.sceneId
      || null
    : null;
  const defaultSceneId = initialBeatId
    ? null
    : effectiveDossiers.find((item) => storyConfirmations.some((target) => target.sceneId === item.sceneId))?.sceneId
      || effectiveDossiers[0]?.sceneId
      || null;
  const requestedSceneId = selectedSceneId
    || requestedAudioVerification?.primaryReviewSceneId
    || initialBeatSceneId
    || defaultSceneId
    || null;
  const selectedDossier = requestedSceneId ? effectiveDossiers.find((item) => item.sceneId === requestedSceneId) || null : null;
  const selectedReviewScene = requestedSceneId ? sceneById.get(requestedSceneId) || null : null;
  const sceneJourneyResult = useSceneJourney(selectedReviewScene?.id || null, snapshotId);
  const confirmationBeatId = selectedDossier?.directBeatIds.find((beatId) => beatById.has(beatId))
    || selectedDossier?.relatedBeatIds.find((beatId) => beatById.has(beatId))
    || (selectedReviewScene ? storyConfirmations.find((item) => item.sceneId === selectedReviewScene.id)?.sourceBeatIds?.find((beatId) => beatById.has(beatId)) : null);
  const selectedBeatId = initialBeatId && beatById.has(initialBeatId)
    ? initialBeatId
    : (selectedSceneId || requestedAudioVerification)
      ? confirmationBeatId || audit.beats.find((beat) => beat.beat_id === 'TR-011')?.beat_id || audit.beats[0]?.beat_id || ''
      : audit.beats.find((beat) => beat.beat_id === 'TR-011')?.beat_id || confirmationBeatId || audit.beats[0]?.beat_id || '';

  const selectedBeat = audit.beats.find((beat) => beat.beat_id === selectedBeatId) || audit.beats[0];
  const selectedStoryConfirmation = selectedReviewScene
    ? storyConfirmations.find((item) => item.sceneId === selectedReviewScene.id) || null
    : null;
  const sceneComments = useSceneScriptComments(selectedStoryConfirmation?.sceneId || null, snapshotId);
  const commentSelectionForCurrentScene = commentSelectionSceneId === selectedReviewScene?.id ? commentSelection : null;
  const selectedSceneIndex = selectedReviewScene ? scenes.findIndex((scene) => scene.id === selectedReviewScene.id) : -1;
  const previousScene = selectedSceneIndex > 0 ? scenes[selectedSceneIndex - 1] : null;
  const nextScene = selectedSceneIndex >= 0 && selectedSceneIndex < scenes.length - 1 ? scenes[selectedSceneIndex + 1] : null;
  const sceneGroups = useMemo(() => {
    const episodes = new Map<string, Map<string, ScriptScene[]>>();
    for (const scene of scenes) {
      const episodeId = scene.episodeAssignment.episodeId || 'UNKNOWN';
      const actLabel = `${scene.act}：${scene.actTitle}`;
      const acts = episodes.get(episodeId) || new Map<string, ScriptScene[]>();
      const actScenes = acts.get(actLabel) || [];
      actScenes.push(scene);
      acts.set(actLabel, actScenes);
      episodes.set(episodeId, acts);
    }
    return Array.from(episodes, ([episodeId, acts]) => ({
      episodeId,
      sceneCount: Array.from(acts.values()).reduce((total, values) => total + values.length, 0),
      acts: Array.from(acts, ([label, values]) => ({ label, scenes: values })),
    }));
  }, [scenes]);
  const dossierBindings = useMemo(() => {
    const values = new Map<string, SceneBeatBinding>();
    const sourceBindings = selectedDossier?.bindings || selectedDossier?.beatBindings || [];
    for (const beatId of selectedDossier?.directBeatIds || []) {
      const binding = sourceBindings.find((item) => item.beatId === beatId);
      if (binding) values.set(beatId, { ...binding, relationRole: 'DIRECT' });
    }
    for (const binding of sourceBindings) {
      const current = values.get(binding.beatId);
      if (!current || (!relationIsDirect(current.relationRole) && relationIsDirect(binding.relationRole))) values.set(binding.beatId, binding);
    }
    for (const beatId of selectedDossier?.relatedBeatIds || []) {
      if (!values.has(beatId)) values.set(beatId, { beatId, relationRole: 'RELATED', perspectiveTags: [] });
    }
    return Array.from(values.values());
  }, [selectedDossier]);
  const evidenceForLens = useMemo(() => dossierBindings
    .map((binding) => ({ binding, beat: beatById.get(binding.beatId) }))
    .filter((item): item is { binding: SceneBeatBinding; beat: AdaptationAuditBeat } => Boolean(item.beat))
    .filter(({ binding, beat }) => sceneLens === 'ALL'
      || bindingMatchesLens(binding, sceneLens)
      || beatMatchesLens(beat, sceneLens)), [beatById, dossierBindings, sceneLens]);
  const directEvidence = evidenceForLens.filter(({ binding }) => relationIsDirect(binding.relationRole));
  const relatedEvidence = evidenceForLens.filter(({ binding }) => !relationIsDirect(binding.relationRole));
  const dossierAudioVerifications = (selectedDossier?.asrIssueIds || [])
    .map((issueId) => audioVerifications.find((item) => item.issueId === issueId))
    .filter((item): item is AudioVerificationTarget => Boolean(item));
  const activeAudioBeat = (activeAudioBeatId ? beatById.get(activeAudioBeatId) : null) || selectedBeat || null;
  const commentAnnotations = useMemo<DocumentTextAnnotation[]>(() => [
    ...sceneComments.threads
      .filter((thread) => thread.anchorMatchesCurrentText)
      .flatMap((thread) => sceneCommentAnchorSegments(thread.anchor).map((segment) => ({
        id: thread.commentId,
        blockId: segment.blockId,
        startOffset: segment.startOffset,
        endOffset: segment.endOffset,
        state: thread.status,
      }))),
    ...(commentSelectionForCurrentScene
      ? sceneCommentAnchorSegments(commentSelectionForCurrentScene).map((segment) => ({
        id: COMMENT_DRAFT_SELECTION_ID,
        blockId: segment.blockId,
        startOffset: segment.startOffset,
        endOffset: segment.endOffset,
        state: 'DRAFT',
      }))
      : []),
  ], [commentSelectionForCurrentScene, sceneComments.threads]);
  const activeCommentAnnotationId = editingCommentId
    || (commentSelectionForCurrentScene ? COMMENT_DRAFT_SELECTION_ID : selectedCommentId);
  const handleEditingCommentChange = useCallback((commentId: string | null) => {
    setEditingCommentId(commentId);
  }, []);

  function selectCommentAnnotation(commentId: string) {
    if (commentId === COMMENT_DRAFT_SELECTION_ID) {
      setCommentSelectionMessage('当前圈选已固定；请在右侧填写修改意见，或取消圈选后重新选择。');
      return;
    }
    if (editingCommentId && editingCommentId !== commentId) {
      setSelectedCommentId(editingCommentId);
      locateScriptComment(editingCommentId);
      setCommentSelectionMessage('正在编辑另一条评论；请先保存或取消编辑，再切换评论。');
      return;
    }
    setSelectedCommentId(commentId);
  }

  function locateScriptComment(commentId: string) {
    const container = sceneReaderScrollRef.current;
    const target = container?.querySelector<HTMLElement>(`[data-script-comment-ids~="${CSS.escape(commentId)}"]`) || null;
    if (!container || !target) return false;
    const containerRect = container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const top = container.scrollTop
      + targetRect.top
      - containerRect.top
      - Math.max(16, (container.clientHeight - targetRect.height) / 2);
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    container.scrollTo({ top: Math.max(0, top), behavior: reduceMotion ? 'auto' : 'smooth' });
    return true;
  }

  function playAudioBeat(beat: AdaptationAuditBeat) {
    if (!audioRef.current) return;
    setActiveAudioBeatId(beat.beat_id);
    audioRef.current.currentTime = parseTimecode(beat.source.timecode_start);
    void audioRef.current.play();
  }

  function playEvidenceBeat(beat: AdaptationAuditBeat) {
    playAudioBeat(beat);
  }

  function captureCommentSelection() {
    if (editingCommentId) {
      window.getSelection()?.removeAllRanges();
      setSelectedCommentId(editingCommentId);
      locateScriptComment(editingCommentId);
      setCommentSelectionMessage('正在编辑评论；原圈选范围已固定，请先保存或取消编辑。');
      return;
    }
    const container = sceneReaderScrollRef.current;
    const selection = window.getSelection();
    if (!container || !selection || selection.rangeCount < 1 || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    const parentElement = (node: Node) => node instanceof Element ? node : node.parentElement;
    const startElement = parentElement(range.startContainer)?.closest<HTMLElement>('[data-reader-block-id]') || null;
    const endElement = parentElement(range.endContainer)?.closest<HTMLElement>('[data-reader-block-id]') || null;
    if (!startElement || !endElement || !container.contains(startElement) || !container.contains(endElement)) {
      setCommentSelection(null);
      setCommentSelectionMessage('选区必须从本场正文文字开始并在本场正文文字内结束。');
      return;
    }
    const startBlockId = startElement.dataset.readerBlockId || '';
    const endBlockId = endElement.dataset.readerBlockId || '';
    const blocks = selectedReviewScene?.scriptBlocks || [];
    const startBlockIndex = blocks.findIndex((item) => item.id === startBlockId);
    const endBlockIndex = blocks.findIndex((item) => item.id === endBlockId);
    if (startBlockIndex < 0 || endBlockIndex < startBlockIndex) {
      setCommentSelection(null);
      setCommentSelectionMessage('无法按当前正文顺序解析这段选区，请重新圈选。');
      return;
    }
    const selectedBlocks = blocks.slice(startBlockIndex, endBlockIndex + 1);
    const elementsByBlockId = new Map(Array.from(container.querySelectorAll<HTMLElement>('[data-reader-block-id]'))
      .map((element) => [element.dataset.readerBlockId || '', element] as const));
    if (selectedBlocks.some((block) => typeof block.text !== 'string' || !elementsByBlockId.has(block.id))) {
      setCommentSelection(null);
      setCommentSelectionMessage('选区经过了暂不支持精确锚定的结构块，请缩小到连续的正文、对白或标题文字。');
      return;
    }
    const offsetWithin = (element: HTMLElement, node: Node, offset: number) => {
      const prefix = document.createRange();
      prefix.selectNodeContents(element);
      prefix.setEnd(node, offset);
      return prefix.toString().length;
    };
    const firstText = selectedBlocks[0].text || '';
    const lastText = selectedBlocks[selectedBlocks.length - 1].text || '';
    const startOffset = Math.min(firstText.length, offsetWithin(startElement, range.startContainer, range.startOffset));
    const endOffset = Math.min(lastText.length, offsetWithin(endElement, range.endContainer, range.endOffset));
    const rawSegments: SceneCommentAnchorSegment[] = selectedBlocks.map((block, index) => ({
      blockId: block.id,
      startOffset: index === 0 ? startOffset : 0,
      endOffset: index === selectedBlocks.length - 1 ? endOffset : (block.text || '').length,
      quote: '',
      sourceLineStart: block.sourceLineStart,
      sourceLineEnd: block.sourceLineEnd,
    })).map((segment, index) => ({
      ...segment,
      quote: (selectedBlocks[index].text || '').slice(segment.startOffset, segment.endOffset),
    })).filter((segment) => segment.endOffset > segment.startOffset);
    const segments = rawSegments.map((segment, index) => {
      const sourceText = selectedBlocks.find((block) => block.id === segment.blockId)?.text || '';
      const leadingWhitespace = index === 0 ? segment.quote.length - segment.quote.trimStart().length : 0;
      const trailingWhitespace = index === rawSegments.length - 1 ? segment.quote.length - segment.quote.trimEnd().length : 0;
      const trimmedStart = segment.startOffset + leadingWhitespace;
      const trimmedEnd = segment.endOffset - trailingWhitespace;
      return {
        ...segment,
        startOffset: trimmedStart,
        endOffset: trimmedEnd,
        quote: sourceText.slice(trimmedStart, trimmedEnd),
      };
    }).filter((segment) => segment.endOffset > segment.startOffset && Boolean(segment.quote));
    const quote = segments.map((segment) => segment.quote).join('\n\n');
    if (!quote || quote.length > 20_000) {
      setCommentSelection(null);
      setCommentSelectionMessage(quote.length > 20_000 ? '单条评论最多圈选20,000字，请缩小范围。' : '没有选中可评论的正文文字。');
      return;
    }
    const firstSegment = segments[0];
    const lastSegment = segments[segments.length - 1];
    const firstBlock = blocks.find((block) => block.id === firstSegment.blockId)!;
    const lastBlock = blocks.find((block) => block.id === lastSegment.blockId)!;
    setSelectedCommentId(null);
    setCommentSelectionSceneId(selectedReviewScene?.id || null);
    setCommentSelection({
      blockId: firstSegment.blockId,
      startOffset: firstSegment.startOffset,
      endOffset: firstSegment.endOffset,
      endBlockId: lastSegment.blockId,
      endBlockOffset: lastSegment.endOffset,
      quote,
      prefix: (firstBlock.text || '').slice(Math.max(0, firstSegment.startOffset - 48), firstSegment.startOffset),
      suffix: (lastBlock.text || '').slice(lastSegment.endOffset, Math.min((lastBlock.text || '').length, lastSegment.endOffset + 48)),
      sourceLineStart: firstBlock.sourceLineStart,
      sourceLineEnd: lastBlock.sourceLineEnd,
      segments,
    });
    setCommentSelectionMessage(`已圈选${segments.length}个正文块、${quote.length.toLocaleString()}字；修改意见已在右侧审阅区下方打开。`);
    window.setTimeout(() => {
      document.getElementById(`scene-script-comments-${selectedReviewScene?.id || ''}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 0);
  }

  function focusDossierScene(
    scene: ScriptScene,
    verificationIssueId?: string,
    scrollMode: 'WORKBENCH' | 'PRESERVE_PAGE_POSITION' = 'WORKBENCH',
  ) {
    const dossier = effectiveDossiers.find((item) => item.sceneId === scene.id);
    const beatId = dossier?.directBeatIds.find((item) => beatById.has(item))
      || dossier?.relatedBeatIds.find((item) => beatById.has(item))
      || selectedBeat?.beat_id
      || audit.beats[0]?.beat_id;
    if (!beatId) return;
    sceneSelectionScrollModeRef.current = { sceneId: scene.id, mode: scrollMode };
    onSelectReviewScene(scene.id, beatId, undefined, verificationIssueId);
  }

  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => fetch('/api/v8/operations/snapshot', { cache: 'no-store', signal: controller.signal })
      .then((response) => response.ok ? response.json() : null)
      .then((value) => {
        const payload = value as { stateProjection?: { scriptScenesById?: Record<string, { reviewDecision?: string }> } } | null;
        const states = Object.fromEntries(Object.entries(payload?.stateProjection?.scriptScenesById || {}).map(([sceneId, state]) => [sceneId, String(state.reviewDecision || 'REVIEW_PENDING')]));
        setSceneReviewStates(states);
      })
      .catch(() => undefined);
    void refresh();
    window.addEventListener('review:operations-updated', refresh);
    return () => { controller.abort(); window.removeEventListener('review:operations-updated', refresh); };
  }, []);

  useEffect(() => {
    const selectionScrollMode = sceneSelectionScrollModeRef.current;
    sceneSelectionScrollModeRef.current = null;
    const preservePagePosition = selectionScrollMode?.sceneId === selectedReviewScene?.id
      && selectionScrollMode?.mode === 'PRESERVE_PAGE_POSITION';
    sceneReaderScrollRef.current?.scrollTo({ top: 0, behavior: 'auto' });
    sceneDecisionPaneRef.current?.scrollTo({ top: 0, behavior: 'auto' });
    if (!selectedSceneId || selectedReviewScene?.id !== selectedSceneId || preservePagePosition) return;
    const timer = window.setTimeout(() => {
      const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (activeElement?.closest('[role="tablist"][aria-label="故事创作方式"]')) return;
      sceneWorkbenchRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      sceneWorkbenchRef.current?.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [selectedReviewScene?.id, selectedSceneId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setCommentSelection(null);
      setSelectedCommentId(null);
      setCommentSelectionMessage('圈选正文中的一句或一小段，右侧即可添加评论。');
    }, 0);
    return () => window.clearTimeout(timer);
  }, [selectedReviewScene?.id]);

  useEffect(() => {
    if (!highlightedAnchor || !selectedReviewScene?.id) return;
    const timer = window.setTimeout(() => {
      const container = sceneReaderScrollRef.current;
      const target = document.getElementById(highlightedAnchor);
      if (!container || !target || !container.contains(target)) return;
      const containerRect = container.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      container.scrollTo({ top: container.scrollTop + targetRect.top - containerRect.top - container.clientHeight * .24, behavior: 'smooth' });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [highlightedAnchor, selectedReviewScene?.id]);

  return <section className="adaptation-audit" aria-labelledby="adaptation-audit-title">
    <header className="adaptation-audit-heading">
      <div><small>SCENE-CENTERED CREATION REVIEW</small><h2 id="adaptation-audit-title">场级拆解与正式审阅</h2><p>以Sxx场次为唯一审阅档案：阅读完整正文，结合本场直接依据完成创作判断与可选原音核验。</p></div>
      <div className="adaptation-audit-scope"><b>{scenes.length}</b><span>场正文逐场审阅</span><small>原文分类只在所选场次内解释</small></div>
    </header>

    <section className="adaptation-global-audio" aria-label="全局原音播放器">
      <div><small>GLOBAL SOURCE AUDIO</small><b>全局原音播放器</b><span>{activeAudioBeat ? `${activeAudioBeat.beat_id} · ${activeAudioBeat.source.timecode_start}–${activeAudioBeat.source.timecode_end} · ${visibleText(activeAudioBeat.summary)}` : '点击任一原文依据的播放按钮，从对应时间码开始。'}</span></div>
      <audio ref={audioRef} data-review-audio controls preload="metadata" src="/review-audio/story-source.mp3" onPointerDown={stopSeamAudition} onPlay={(event) => handleReviewAudioPlay(event.currentTarget)}>浏览器不支持音频播放。</audio>
    </section>

    <section className="adaptation-scene-directory" aria-labelledby="adaptation-scene-directory-title">
      <header><div><small>SCENE CREATION INDEX</small><h2 id="adaptation-scene-directory-title">按集与幕定位场级拆解</h2><p>这里是当前剧本唯一的场次阅读与审阅目录；分集只用于导航，不形成第二份正文。</p></div><span>{scenes.length}场 · {sceneGroups.length}集</span></header>
      <div>{sceneGroups.map((episode) => <section key={episode.episodeId} data-episode={episode.episodeId}>
        <header><b>{episode.episodeId}</b><span>{episode.sceneCount}场</span></header>
        {episode.acts.map((act) => <div key={`${episode.episodeId}:${act.label}`}><h3>{act.label}</h3><nav aria-label={`${episode.episodeId} ${act.label}场次`}>
          {act.scenes.map((scene) => {
            const state = sceneReviewStates[scene.id] || (storyConfirmations.some((target) => target.sceneId === scene.id) ? 'REVIEW_PENDING' : 'READ_ONLY');
            const stateLabel = state === 'RELEASED' ? '已通过' : state === 'REVISION_REQUIRED' ? '需修改' : state === 'DO_NOT_USE' ? '禁用' : state === 'READ_ONLY' ? '只读' : '待审阅';
            return <button type="button" key={scene.id} className={selectedReviewScene?.id === scene.id ? 'active' : ''} aria-current={selectedReviewScene?.id === scene.id ? 'location' : undefined} data-scene-id={scene.id} data-review-state={state} onClick={() => focusDossierScene(scene, undefined, 'PRESERVE_PAGE_POSITION')}><span><b>{scene.id}</b><small>{stateLabel}</small></span><em>{visibleText(scene.slugline)}</em></button>;
          })}
        </nav></div>)}
      </section>)}</div>
    </section>

    {selectedReviewScene && <section ref={sceneWorkbenchRef} tabIndex={-1} className="adaptation-scene-review-workbench" aria-labelledby="adaptation-scene-review-title">
      <header><div><small>SCENE REVIEW DOSSIER</small><h2 id="adaptation-scene-review-title">{selectedReviewScene.id}场次中心审阅档案</h2><p>本场完整正文是唯一正式审阅对象；全部原文、必须保留、遗漏失真、误导揭晓、笑点、不可拍与原音疑点只是本场的证据视角。</p></div><span>{selectedStoryConfirmation ? '全剧场正文确认' : '未登记确认对象'}</span></header>
      <div className="adaptation-scene-review-layout">
        <article className="adaptation-scene-reader" aria-labelledby={`adaptation-scene-reader-${selectedReviewScene.id}`}>
          <header><div><small>{selectedReviewScene.episodeAssignment.episodeId} → {selectedReviewScene.storySequenceId} → {selectedReviewScene.id}</small><h3 id={`adaptation-scene-reader-${selectedReviewScene.id}`}>{selectedReviewScene.id} · {visibleText(selectedReviewScene.slugline)}</h3><p>{selectedReviewScene.act}：{visibleText(selectedReviewScene.actTitle)} · 母本源行{selectedReviewScene.sourceLineStart}–{selectedReviewScene.sourceLineEnd} · {selectedReviewScene.scriptCharacterCount.toLocaleString()}字符</p></div>{directEvidence[0] ? <button type="button" onClick={() => playEvidenceBeat(directEvidence[0].beat)}>播放本场首条原文</button> : <span>当前母本完整正文</span>}</header>
          <nav className="adaptation-scene-neighbours" aria-label={`${selectedReviewScene.id}前后场位置`}>
            {previousScene ? <button type="button" onClick={() => focusDossierScene(previousScene)}><span>前一场</span><b>← {previousScene.id} · {visibleText(previousScene.slugline)}</b></button> : <span><small>前一场</small><b>全剧开场</b></span>}
            {nextScene ? <button type="button" onClick={() => focusDossierScene(nextScene)}><span>后一场</span><b>{nextScene.id} · {visibleText(nextScene.slugline)} →</b></button> : <span><small>后一场</small><b>全剧结束</b></span>}
          </nav>
          <p className="scene-comment-reader-tip" role="status">{commentSelection && !commentSelectionForCurrentScene ? '圈选正文中的连续文字，可跨段落或对白；修改意见入口位于右侧审阅区下方。' : commentSelectionMessage}</p>
          <div ref={sceneReaderScrollRef} className="adaptation-scene-reader-scroll" role="region" tabIndex={0} aria-labelledby={`adaptation-scene-reader-${selectedReviewScene.id}`} onPointerUp={captureCommentSelection} onKeyUp={captureCommentSelection}><div className="text-reader-body screenplay-body"><DocumentBlocks blocks={selectedReviewScene.scriptBlocks} highlightedAnchor={highlightedAnchor} textAnnotations={commentAnnotations} selectedAnnotationId={activeCommentAnnotationId} onAnnotationClick={selectCommentAnnotation} /></div></div>
        </article>
        <aside ref={sceneDecisionPaneRef} className="adaptation-scene-decision-pane" aria-label={`${selectedReviewScene.id}审阅回填`}>
          {selectedStoryConfirmation
            ? <SceneConfirmationReview key={`${selectedStoryConfirmation.sceneId}:${selectedStoryConfirmation.sceneContentHash}:${selectedStoryConfirmation.businessContextHash}`} target={{...selectedStoryConfirmation,reviewSpec:selectedDossier?.reviewSpec as StoryConfirmationTarget["reviewSpec"]}} snapshotId={snapshotId} hardBlockers={selectedDossier?.hardBlockers || []} journeyResult={sceneJourneyResult} />
            : <section className="adaptation-scene-review-unavailable"><small>READ ONLY</small><h3>{selectedReviewScene.id}当前没有可提交的场次确认对象</h3><p>这里仍呈现完整正文和本场所有视角证据；当前快照没有为该场登记SCRIPT_SCENE确认对象，因此不生成泛化表单、不写入ReviewEvent。</p></section>}
          {selectedStoryConfirmation && <SceneScriptCommentsPanel key={`${selectedStoryConfirmation.sceneId}:${selectedStoryConfirmation.sceneContentHash}`} target={selectedStoryConfirmation} snapshotId={snapshotId} selection={commentSelectionForCurrentScene} threads={sceneComments.threads} closedHistory={sceneComments.closedHistory} loading={sceneComments.loading} error={sceneComments.error} selectedCommentId={selectedCommentId} onSelectComment={setSelectedCommentId} onLocateComment={locateScriptComment} onReadClosedComment={sceneComments.rememberClosed} onEditingCommentChange={handleEditingCommentChange} onClearSelection={() => { window.getSelection()?.removeAllRanges(); setCommentSelection(null); setCommentSelectionSceneId(null); setCommentSelectionMessage('圈选正文中的连续文字，可跨段落或对白；修改意见入口位于右侧审阅区下方。'); }} onRefresh={sceneComments.refresh} />}
        </aside>
      </div>
      <section className="adaptation-scene-perspectives" aria-labelledby={`scene-perspectives-${selectedReviewScene.id}`}>
        <header><div><small>IN-SCENE EVIDENCE LENSES</small><h3 id={`scene-perspectives-${selectedReviewScene.id}`}>{selectedReviewScene.id}的七个场内视角</h3><p>标签只筛选本场档案，不会跳到另一个队列或创建独立收口。各视角可以重叠，数量不可相加当作原文总数；直接依据先展示，关联内容收纳为跨场上下文。</p></div><span>{directEvidence.length}直接 · {relatedEvidence.length}关联</span></header>
        <div className="adaptation-scene-lens-tabs" role="toolbar" aria-label={`${selectedReviewScene.id}场内证据视角`}>{filterOptions.map(([value, label]) => {
          const count = value === 'ALL'
            ? dossierBindings.length
            : dossierBindings.filter((binding) => bindingMatchesLens(binding, value) || Boolean(beatById.get(binding.beatId) && beatMatchesLens(beatById.get(binding.beatId) as AdaptationAuditBeat, value))).length;
          return <button key={value} type="button" className={sceneLens === value ? 'active' : ''} aria-pressed={sceneLens === value} onClick={() => setSceneLens(previous => previous === value ? 'ALL' : value)}><span>{label}</span><b>{count}</b></button>;
        })}</div>
        <div className="adaptation-scene-evidence-list" aria-label="本场直接原文证据">
          {directEvidence.map(({ binding, beat }) => <SceneEvidenceCard key={beat.beat_id} beat={beat} binding={binding} transcript={transcriptById.get(beat.beat_id)} onPlay={() => playEvidenceBeat(beat)} />)}
          {!directEvidence.length && <p className="adaptation-empty">当前视角没有本场直接原文证据。</p>}
        </div>
        {relatedEvidence.length > 0 && <details className="adaptation-related-evidence"><summary>展开{relatedEvidence.length}项跨场上下文（不是本场直接承载）</summary><div>{relatedEvidence.map(({ binding, beat }) => <SceneEvidenceCard key={beat.beat_id} beat={beat} binding={binding} transcript={transcriptById.get(beat.beat_id)} onPlay={() => playEvidenceBeat(beat)} />)}</div></details>}
        {(sceneLens === 'ALL' || sceneLens === 'VERIFY') && dossierAudioVerifications.length > 0 && <section className="adaptation-scene-audio-issues" aria-label={`${selectedReviewScene.id}原音疑点`}>
          <header><div><small>ORIGINAL AUDIO QUESTIONS</small><h3>原音疑点是本场的可选事实核验</h3></div><span>{dossierAudioVerifications.length}项</span></header>
          <p>它们用于区分“逐字稿究竟听到什么”与“剧本应如何安全呈现”。场次通过不会代你提交回听，回听UNKNOWN也不自动否决场次。</p>
          {dossierAudioVerifications.map((target) => {
            const ownerSceneId = target.primaryReviewSceneId || target.affectedSceneIds?.[0] || selectedReviewScene.id;
            const owner = ownerSceneId === selectedReviewScene.id;
            const highlighted = target.issueId === selectedVerificationIssueId;
            const ownerScene = sceneById.get(ownerSceneId);
            return <div id={`verification-${target.issueId}`} className={`adaptation-scene-audio-issue ${highlighted ? 'is-highlighted' : ''}`} key={target.issueId} data-verification-issue={target.issueId}>
              {owner
                ? <AudioVerificationReview target={target} snapshotId={snapshotId} />
                : <SharedAudioVerificationState target={target} currentSceneId={selectedReviewScene.id} onOpenOwner={() => { if (ownerScene) focusDossierScene(ownerScene, target.issueId); }} />}
            </div>;
          })}
        </section>}
      </section>
    </section>}
  </section>;
}
