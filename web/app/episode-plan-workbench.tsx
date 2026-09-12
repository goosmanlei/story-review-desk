'use client';

import {runtimePath} from './runtime-path';
import {StoryObjectEditor} from './story-object-editor';
import {fillUnansweredWithPass} from './review-shortcuts';

import { instanceLocalStorage } from './client-storage';
import { projectIdFor, episodePlanIdFor } from './instance-profile';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ProductionModel } from './production-workbench';
import { publicRef, visibleText } from './review-semantics';
import { useRuntimeMode } from './runtime-mode';
import { useAssistantFocus } from './assistant/context-provider';
import { useProjectAssistantDraftTargets } from './assistant/project-draft-adapters';
import type { EpisodeReviewDossier } from './story-review-types';
import {EpisodeSceneNavigator,type NarrativeSceneLabel,type EpisodeNavigationState} from './episode-scene-navigator';


import { EPISODE_REVIEW_CRITERIA, episodeReviewCriteria, type EpisodeCriterionId } from './episode-review-criteria';
import type { EpisodePlanContext } from './episode-plan-context';
export { EPISODE_REVIEW_CRITERIA, type EpisodeCriterionId } from './episode-review-criteria';

export type EpisodeCriterionState = {
  id: EpisodeCriterionId;
  label: string;
  verdict: FindingVerdict;
  note: string;
};

type FindingVerdict = '' | 'PASS' | 'FAIL';
type DraftFinding = { verdict: FindingVerdict; note: string };

export function episodeCriterionId(episodeUid: string, criterionId: string) {
  return `episode:${episodeUid}:${criterionId}`;
}

export type EpisodeDraft = {
  revisionId?:string;objectVersion?:number;
  episodeUid: string;
  displayId: string;
  title: string;
  sceneIds: string[];
  openingHook: string;
  coreAdvance: string;
  endingCliffhanger: string;
  reviewQuestion: string;
  reviewDossier: EpisodeReviewDossier;
};

type EpisodePlanContent = {
  planId: string;
  episodes: EpisodeDraft[];
  retiredEpisodeUids: string[];
  changeSummary?: string;
  narrativeRevision?: EpisodePlanContext['content']['narrativeRevision'];
};

type CreativeRevision = {
  criteriaVersion?: string;
  eventId?: string;
  creativeRevisionId: string;
  revisionId?: string;
  baseRevisionHash?: string;
  contentHash: string;
  contextHash: string;
  content: EpisodePlanContent;
  basisBindings?: BasisBinding[];
  revisionState?: string;
};

type BasisBinding = {
  bindingType: string;
  bindingId: string;
  bindingHash: string;
  scopeType?: string;
  scopeId?: string;
};

type ReviewEvent = {
  eventId: string;
  subjectRevisionId?: string;
  creativeRevisionId?: string;
  subjectRevisionHash?: string;
  action?: string;
  reviewDecision?: string;
  sourceSyncRequired?: boolean;
  sourceSyncState?: string;
  createdAt?: string;
  criterionFindings?: Array<{ criterionId: string; verdict: 'PASS' | 'FAIL' | 'NA'; note?: string }>;
  note?: string;
};

type EpisodeSubmissionEvent = ReviewEvent & {
  objectRevisionId?:string;objectVersion?:number;
  episodeUid: string;
  displayId?: string;
  recommendation?: Exclude<ReviewAction, ''>;
  supersedesEpisodeSubmissionEventId?: string | null;
  carryForward?: {sourceSubmissionEventId:string;sourceRevisionId:string};
};
type EpisodeNarrativeReview = ReviewEvent & {episodeUid:string};
type EpisodeNarrativeStatus = {episodeUid:string;state:string;canFlowDownstream:boolean;reason:string;reviewEventId:string};



type ReviewAction = '' | 'APPROVE_AND_RELEASE' | 'REQUEST_REVISION' | 'DO_NOT_USE';

export const EPISODE_SUBMISSION_CORRECTION_LABEL = '修改本集提交';

export function episodeSubmissionSupersession(currentHeadEventId?: string | null) {
  const eventId = String(currentHeadEventId || '').trim();
  return eventId ? { supersedesEpisodeSubmissionEventId: eventId } : {};
}

function hashIsValid(value?: string | null) {
  return Boolean(value && /^[a-f0-9]{64}$/i.test(value));
}

async function requestKey(prefix: string, body: unknown) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(body)));
  const value = Array.from(new Uint8Array(digest)).map((item) => item.toString(16).padStart(2, '0')).join('');
  return `${prefix}-${value.slice(0, 40)}`;
}

function normalizedEpisodes(episodes: EpisodeDraft[]) {
  return episodes.map((episode, index) => ({
    ...episode,
    episodeUid: String(episode.episodeUid || ''),
    displayId: `E${String(index + 1).padStart(2, '0')}`,
    title: String(episode.title || '').trim() || 'UNKNOWN',
    openingHook: String(episode.openingHook || '').trim() || 'UNKNOWN',
    coreAdvance: String(episode.coreAdvance || '').trim() || 'UNKNOWN',
    endingCliffhanger: String(episode.endingCliffhanger || '').trim() || 'UNKNOWN',
    reviewQuestion: String(episode.reviewQuestion || '').trim() || 'UNKNOWN',
  }));
}

export type EpisodePlanSeed = {
  sourceRole: 'CURRENT' | 'PROPOSAL' | 'CANDIDATE' | 'UNKNOWN';
  revisionId: string | null;
  episodes: EpisodeDraft[];
  retiredEpisodeUids: string[];
  changeSummary: string;
};

export function episodePlanSeed(model: ProductionModel): EpisodePlanSeed {
  const PLAN_ID = episodePlanIdFor(model);
  const pointers = model.revisionPointers as (NonNullable<ProductionModel['revisionPointers']> & {
    currentEpisodePlanRevisionId?: string | null;
  }) | undefined;
  const records = (model.episodePlanRevisions || []) as Array<NonNullable<ProductionModel['episodePlanRevisions']>[number] & {
    isCurrent?: boolean;
    changeSummary?: string;
  }>;
  const currentPointerId = pointers?.currentEpisodePlanRevisionId;
  const currentRecords = records.filter((item) => (
    item.id === currentPointerId
    && item.planId === PLAN_ID
    && item.scopeRole === 'CURRENT'
    && item.revisionState === 'CURRENT'
    && item.isCurrent === true
  ));
  const proposalPointerId = pointers?.episodePlanProposalRevisionId;
  const proposalRecords = records.filter((item) => (
    item.id === proposalPointerId
    && item.planId === PLAN_ID
    && item.scopeRole === 'PROPOSAL'
    && item.revisionState === 'PROPOSAL'
    && item.isCurrentProposal === true
  ));
  const selected = currentRecords.length === 1
    ? { sourceRole: 'CURRENT' as const, record: currentRecords[0] }
    : proposalRecords.length === 1
      ? { sourceRole: 'PROPOSAL' as const, record: proposalRecords[0] }
      : null;
  if (!selected) return { sourceRole: 'UNKNOWN', revisionId: null, episodes: [], retiredEpisodeUids: [], changeSummary: '' };
  return {
    sourceRole: selected.sourceRole,
    revisionId: selected.record.id,
    episodes: normalizedEpisodes(selected.record.episodes.map((episode) => ({ ...episode, sceneIds: [...episode.sceneIds] }))),
    retiredEpisodeUids: [...new Set(selected.record.retiredEpisodeUids || [])].sort(),
    changeSummary: typeof selected.record.changeSummary === 'string' ? selected.record.changeSummary : '',
  };
}

export function validateEpisodePlan(episodes: EpisodeDraft[], expectedSceneIds: string[], retiredEpisodeUids: string[] = []) {
  const flat = episodes.flatMap((episode) => episode.sceneIds);
  const counts = new Map<string, number>();
  flat.forEach((sceneId) => counts.set(sceneId, (counts.get(sceneId) || 0) + 1));
  const missing = expectedSceneIds.filter((sceneId) => !counts.has(sceneId));
  const duplicates = [...counts].filter(([, count]) => count > 1).map(([sceneId]) => sceneId);
  const expected = new Set(expectedSceneIds);
  const unknown = flat.filter((sceneId) => !expected.has(sceneId));
  const emptyEpisodes = episodes.filter((episode) => episode.sceneIds.length === 0).map((episode) => episode.displayId);
  const duplicateUids = episodes.map((episode) => episode.episodeUid).filter((value, index, values) => values.indexOf(value) !== index);
  const missingUids = episodes.filter((episode) => !episode.episodeUid.trim()).map((episode) => episode.displayId);
  const reusedRetiredUids = episodes.map((episode) => episode.episodeUid).filter((episodeUid) => retiredEpisodeUids.includes(episodeUid));
  const retiredLedgerInvalid = retiredEpisodeUids.length !== new Set(retiredEpisodeUids).size
    || retiredEpisodeUids.join('|') !== [...retiredEpisodeUids].sort().join('|');
  const orderMatches = flat.length === expectedSceneIds.length && flat.every((sceneId, index) => sceneId === expectedSceneIds[index]);
  const incompleteFields = episodes.flatMap((episode) => [
    ['title', episode.title],
    ['openingHook', episode.openingHook],
    ['coreAdvance', episode.coreAdvance],
    ['endingCliffhanger', episode.endingCliffhanger],
    ['reviewQuestion', episode.reviewQuestion],
  ].filter(([, value]) => !String(value || '').trim()).map(([field]) => `${episode.displayId}.${field}`));
  const missingDossiers = episodes.filter((episode) => (
    !episode.reviewDossier
    || !['1.0', '1.1'].includes(episode.reviewDossier.schemaVersion)
    || !episode.reviewDossier.progressionSlices.length
  )).map((episode) => episode.displayId);
  const issues = [
    !expectedSceneIds.length ? '尚无权威场次，不能提交正式分集方案。' : '',
    missing.length ? `缺少：${missing.join('、')}` : '',
    duplicates.length ? `重复：${duplicates.join('、')}` : '',
    unknown.length ? `未知场次：${[...new Set(unknown)].join('、')}` : '',
    emptyEpisodes.length ? `空分集：${emptyEpisodes.join('、')}` : '',
    missingUids.length ? `episodeUid缺失：${missingUids.join('、')}` : '',
    duplicateUids.length ? `episodeUid重复：${[...new Set(duplicateUids)].join('、')}` : '',
    reusedRetiredUids.length ? `已退休episodeUid不可复用：${[...new Set(reusedRetiredUids)].join('、')}` : '',
    retiredLedgerInvalid ? '已退休episodeUid账本必须唯一并按字典序排列。' : '',
    !orderMatches ? '扁平后的场次顺序不是当前权威场次顺序。' : '',
    incompleteFields.length ? `创作字段留空：${incompleteFields.join('、')}；未知必须显式写UNKNOWN。` : '',
    missingDossiers.length ? `缺少分集审阅档案：${missingDossiers.join('、')}。` : '',
  ].filter(Boolean);
  return { valid: issues.length === 0, issues, missing, duplicates, unknown, orderMatches, flat };
}

function candidateContent(value: unknown, PLAN_ID: string): EpisodePlanContent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.planId !== PLAN_ID || !Array.isArray(record.episodes)) return null;
  const episodes = record.episodes.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const entry = item as Record<string, unknown>;
    if (!Array.isArray(entry.sceneIds)) return null;
    if (!entry.reviewDossier || typeof entry.reviewDossier !== 'object' || Array.isArray(entry.reviewDossier)) return null;
    return {
      episodeUid: String(entry.episodeUid || ''),
      displayId: String(entry.displayId || ''),
      title: String(entry.title || ''),
      sceneIds: entry.sceneIds.map(String),
      openingHook: String(entry.openingHook || ''),
      coreAdvance: String(entry.coreAdvance || ''),
      endingCliffhanger: String(entry.endingCliffhanger || ''),
      reviewQuestion: String(entry.reviewQuestion || ''),
      reviewDossier: entry.reviewDossier as EpisodeReviewDossier,
    } satisfies EpisodeDraft;
  });
  if (episodes.some((item) => !item)) return null;
  const retiredEpisodeUids = Array.isArray(record.retiredEpisodeUids)
    ? record.retiredEpisodeUids.filter((item): item is string => typeof item === 'string')
    : [];
  return {
    planId: PLAN_ID,
    episodes: normalizedEpisodes(episodes as EpisodeDraft[]),
    retiredEpisodeUids,
    changeSummary: typeof record.changeSummary === 'string' ? record.changeSummary : undefined,
  };
}

function actionLabel(value?: string) {
  if (value === 'APPROVE_AND_RELEASE') return '通过并放行';
  if (value === 'REQUEST_REVISION') return '要求修改';
  if (value === 'DO_NOT_USE') return '禁止使用';
  return '待整体审阅';
}

function episodeRecommendationLabel(value?: string) {
  if (value === 'APPROVE_AND_RELEASE') return '本集可通过';
  if (value === 'REQUEST_REVISION') return '本集需修改';
  if (value === 'DO_NOT_USE') return '本集不应采用';
  return '待本集判断';
}

function sourceStateLabel(value?: string) {
  if (value === 'PENDING') return '等待受控同步';
  if (value === 'PENDING_AUTHORIZATION') return '等待同步授权';
  if (['STARTED', 'BUILT', 'DEPLOYED'].includes(value || '')) return '同步处理中';
  if (['SUCCEEDED', 'SOURCE_CURRENT'].includes(value || '')) return '同步完成';
  if (value === 'FAILED') return '同步失败';
  if (value === 'NOT_REQUIRED') return '无需同步';
  return '尚未确认';
}

type EpisodePlanWorkbenchProps = {
  resolvedPlan: EpisodePlanContext;
  model: ProductionModel;
  snapshotId: string;
  baseRevisionHash: string;
  sceneIds: string[];
  selectedEpisodeId: string;
  onSelectEpisode: (episodeId: string) => void;
  selectedCriterionId: EpisodeCriterionId;
  selectedItemId?: string;
  selectedSceneId?: string | null;
  onSelectScene?: (sceneId: string | null) => void;
  renderSceneReading?: (sceneId: string) => ReactNode;
  sceneLabels?: Record<string,NarrativeSceneLabel>;
  onSelectCriterion: (criterionId: EpisodeCriterionId) => void;
  renderEpisodeSummary?: (context: {criterionStates:EpisodeCriterionState[]}) => ReactNode;
  renderEpisodeLayout?: (context: {criterionStates:EpisodeCriterionState[];navigation:ReactNode;criteria:ReactNode}) => ReactNode;
  children?: ReactNode | ((context: { criterionStates: EpisodeCriterionState[] }) => ReactNode);
};

export function EpisodePlanWorkbench(props: EpisodePlanWorkbenchProps) {
  const seed: EpisodePlanSeed = { sourceRole: props.resolvedPlan.sourceRole, revisionId: props.resolvedPlan.revisionId, episodes: props.resolvedPlan.content.episodes, retiredEpisodeUids: props.resolvedPlan.content.retiredEpisodeUids, changeSummary: props.resolvedPlan.content.changeSummary || '' };
  if (!seed.episodes.length) return <section className="narrative-no-evidence episode-plan-contract-error" role="alert"><b>分集方案暂不可审阅</b><span>当前没有可用的分集方案，请先准备完整方案后进入审阅。</span></section>;
  const seedKey = `${seed.changeSummary}|${seed.retiredEpisodeUids.join(',')}|${seed.episodes.map((episode) => `${episode.episodeUid}:${episode.sceneIds.join(',')}:${episode.title}:${episode.openingHook}:${episode.coreAdvance}:${episode.endingCliffhanger}:${episode.reviewQuestion}:${JSON.stringify(episode.reviewDossier)}`).join('|')}`;
  return <EpisodePlanWorkbenchStateful key={`${props.snapshotId}:${seed.sourceRole}:${seed.revisionId}:${seedKey}`} {...props} seed={seed} />;
}

function EpisodePlanWorkbenchStateful({ resolvedPlan, model, snapshotId, baseRevisionHash, sceneIds, selectedEpisodeId, onSelectEpisode, selectedCriterionId, selectedItemId, onSelectCriterion, selectedSceneId, onSelectScene, renderSceneReading, sceneLabels, renderEpisodeSummary, renderEpisodeLayout, children, seed }: EpisodePlanWorkbenchProps & { seed: EpisodePlanSeed }) {
  const PLAN_ID = episodePlanIdFor(model);
  const { hostedReadOnly } = useRuntimeMode();
  const [candidate, setCandidate] = useState<CreativeRevision | null>(null);
  const [review, setReview] = useState<ReviewEvent | null>(null);
  const [latestEpisodeHeads,setLatestEpisodeHeads]=useState<EpisodeSubmissionEvent[]>([]);
  const [episodeSubmissions, setEpisodeSubmissions] = useState<EpisodeSubmissionEvent[]>([]);
  const [episodeReviews,setEpisodeReviews] = useState<EpisodeNarrativeReview[]>([]);
  const [episodeReleases,setEpisodeReleases] = useState<EpisodeNarrativeStatus[]>([]);
  const [episodeActions, setEpisodeActions] = useState<Record<string, ReviewAction>>({});
  const [episodeNotes, setEpisodeNotes] = useState<Record<string, string>>({});
  const [findings, setFindings] = useState<Record<string, DraftFinding>>({});
  const [draftHydrated, setDraftHydrated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadingState, setLoadingState] = useState(true);
  const [message, setMessage] = useState('');
  const [contractError, setContractError] = useState('');
  const [editingEpisodeUid, setEditingEpisodeUid] = useState<string | null>(null);
  const validation = useMemo(() => validateEpisodePlan(seed.episodes, sceneIds, seed.retiredEpisodeUids), [sceneIds, seed]);
  const content = useMemo<EpisodePlanContent>(() => resolvedPlan.content, [resolvedPlan.content]);
  const contentKey = useMemo(() => JSON.stringify(content), [content]);
  const candidateMatchesPlan = Boolean(candidate && candidate.creativeRevisionId === resolvedPlan.revisionId && candidate.contentHash === resolvedPlan.contentHash);
  const historicalReadOnly = resolvedPlan.readOnly === true;
  const draftKey = `review.episodePlanReviewDraft.v2:${resolvedPlan.revisionId}:${resolvedPlan.contentHash}:${resolvedPlan.criteriaVersion}:${resolvedPlan.reviewSpec?.hash||'legacy'}`;
  const selectedEpisode = seed.episodes.find((episode) => episode.episodeUid === selectedEpisodeId || episode.displayId === selectedEpisodeId) || seed.episodes[0];
  const readingSceneId=selectedSceneId||selectedEpisode.sceneIds[0];
  const selectedSceneMatchesEpisode=Boolean(readingSceneId&&selectedEpisode.sceneIds.includes(readingSceneId));
  const navigationSceneLabels:Record<string,NarrativeSceneLabel>={...Object.fromEntries((resolvedPlan.content.narrativeRevision?.scenes||[]).map(scene=>[scene.id,{displayId:scene.displayId,title:scene.title}])),...sceneLabels};
  const allCriterionIds = useMemo(() => seed.episodes.flatMap((episode) => (
    EPISODE_REVIEW_CRITERIA.map((criterion) => episodeCriterionId(episode.episodeUid, criterion.id))
  )), [seed.episodes]);
  const submissionByEpisode = useMemo(() => new Map(episodeSubmissions.map((event) => [event.episodeUid, event])), [episodeSubmissions]);
  const recordedFindings = useMemo<Record<string, DraftFinding>>(() => Object.fromEntries((review?.criterionFindings || [])
    .filter((finding) => allCriterionIds.includes(finding.criterionId))
    .map((finding) => [finding.criterionId, { verdict: finding.verdict === 'NA' ? '' : finding.verdict, note: finding.note || '' }])), [allCriterionIds, review]);
  const submittedFindings = useMemo<Record<string, DraftFinding>>(() => Object.fromEntries(episodeSubmissions.flatMap((event) => (
    (event.criterionFindings || []).filter((finding) => finding.verdict !== 'NA').map((finding) => [
      finding.criterionId,
      { verdict: finding.verdict as FindingVerdict, note: finding.note || '' },
    ])
  ))), [episodeSubmissions]);
  const visibleSubmittedFindings = useMemo(() => {
    if (!editingEpisodeUid) return submittedFindings;
    const editingCriterionIds = new Set(EPISODE_REVIEW_CRITERIA.map((criterion) => episodeCriterionId(editingEpisodeUid, criterion.id)));
    return Object.fromEntries(Object.entries(submittedFindings).filter(([criterionId]) => !editingCriterionIds.has(criterionId)));
  }, [editingEpisodeUid, submittedFindings]);
  const effectiveFindings = review ? recordedFindings : { ...findings, ...visibleSubmittedFindings };
  const selectedSubmission = submissionByEpisode.get(selectedEpisode.episodeUid) || null;
  const selectedEpisodeReview = episodeReviews.find(event => event.episodeUid === selectedEpisode.episodeUid);
  const selectedEpisodeRelease = episodeReleases.find(row => row.episodeUid === selectedEpisode.episodeUid);
  const editingSelectedSubmission = Boolean(selectedSubmission && editingEpisodeUid === selectedEpisode.episodeUid);
  const reviewAction = episodeActions[selectedEpisode.episodeUid] || '';
  const note = episodeNotes[selectedEpisode.episodeUid] || '';
  const selectedCriteria = useMemo(()=>episodeReviewCriteria(seed.episodes.indexOf(selectedEpisode),seed.episodes.length,resolvedPlan.criteriaVersion,resolvedPlan.reviewSpec),[seed.episodes,selectedEpisode,resolvedPlan.criteriaVersion,resolvedPlan.reviewSpec]);
  const criterionStates: EpisodeCriterionState[] = selectedCriteria.map((criterion) => {
    const finding = effectiveFindings[episodeCriterionId(selectedEpisode.episodeUid, criterion.id)] || { verdict: '' as const, note: '' };
    return { id: criterion.id as EpisodeCriterionState["id"], label: criterion.label, verdict: finding.verdict, note: finding.note };
  });
  const activeCriterionIndex = Math.max(0, EPISODE_REVIEW_CRITERIA.findIndex((criterion) => criterion.id === selectedCriterionId));
  const activeCriterion = selectedCriteria.find(c=>c.id===EPISODE_REVIEW_CRITERIA[activeCriterionIndex].id)!;
  const selectedCriterionFindings = useMemo(() => selectedCriteria.map((criterion) => {
    const criterionId = episodeCriterionId(selectedEpisode.episodeUid, criterion.id);
    const finding = findings[criterionId] || { verdict: '' as const, note: '' };
    return { episode: selectedEpisode, criterion, criterionId, finding };
  }), [findings, selectedEpisode, selectedCriteria]);
  const allJudged = selectedCriterionFindings.every(({ finding }) => Boolean(finding.verdict));
  const failedFindings = selectedCriterionFindings.filter(({ finding }) => finding.verdict === 'FAIL');
  const failedFindingsExplained = failedFindings.every(({ finding }) => Boolean(finding.note.trim()));
  const actionCompatible = reviewAction === 'APPROVE_AND_RELEASE'
    ? failedFindings.length === 0
    : reviewAction === 'REQUEST_REVISION' || reviewAction === 'DO_NOT_USE'
      ? failedFindings.length > 0
      : false;

  function selectEpisodeAction(action: ReviewAction) {
    setEpisodeActions(current => ({ ...current, [selectedEpisode.episodeUid]: action }));
    if (action === 'APPROVE_AND_RELEASE') setFindings(current => fillUnansweredWithPass(current,selectedCriteria.map(criterion=>episodeCriterionId(selectedEpisode.episodeUid,criterion.id))));
  }

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (hostedReadOnly || historicalReadOnly) {
        setDraftHydrated(true);
        return;
      }
      try {
        const saved = JSON.parse(instanceLocalStorage.getItem(draftKey) || 'null') as {
          findings?: Record<string, DraftFinding>;
          episodeActions?: Record<string, ReviewAction>;
          episodeNotes?: Record<string, string>;
        } | null;
        if (saved?.findings) {
          const allowed = new Set(allCriterionIds);
          setFindings(Object.fromEntries(Object.entries(saved.findings).filter(([key, value]) => (
            allowed.has(key)
            && (value.verdict === '' || value.verdict === 'PASS' || value.verdict === 'FAIL')
            && typeof value.note === 'string'
          ))));
        }
        if (saved?.episodeActions) {
          const episodeUids = new Set(seed.episodes.map((episode) => episode.episodeUid));
          setEpisodeActions(Object.fromEntries(Object.entries(saved.episodeActions).filter(([episodeUid, action]) => (
            episodeUids.has(episodeUid)
            && ['', 'APPROVE_AND_RELEASE', 'REQUEST_REVISION', 'DO_NOT_USE'].includes(action)
          ))));
        }
        if (saved?.episodeNotes) {
          const episodeUids = new Set(seed.episodes.map((episode) => episode.episodeUid));
          setEpisodeNotes(Object.fromEntries(Object.entries(saved.episodeNotes).filter(([episodeUid, value]) => (
            episodeUids.has(episodeUid) && typeof value === 'string'
          ))));
        }
      } catch {
        instanceLocalStorage.removeItem(draftKey);
      } finally {
        setDraftHydrated(true);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [allCriterionIds, draftKey, hostedReadOnly, seed.episodes, seed.sourceRole]);

  useEffect(() => {
    if (!draftHydrated || hostedReadOnly || review || historicalReadOnly) return;
    instanceLocalStorage.setItem(draftKey, JSON.stringify({ findings, episodeActions, episodeNotes }));
  }, [draftHydrated, draftKey, episodeActions, episodeNotes, findings, hostedReadOnly, review, seed.sourceRole]);

  function updateFinding(criterionId: string, patch: Partial<DraftFinding>) {
    setFindings((current) => ({
      ...current,
      [criterionId]: { ...(current[criterionId] || { verdict: '', note: '' }), ...patch },
    }));
  }

  function editSelectedSubmission() {
    if (!selectedSubmission || review || hostedReadOnly || historicalReadOnly) return;
    const expectedCriterionIds = new Set(EPISODE_REVIEW_CRITERIA.map((criterion) => episodeCriterionId(selectedEpisode.episodeUid, criterion.id)));
    const restoredFindings = Object.fromEntries((selectedSubmission.criterionFindings || [])
      .filter((finding) => expectedCriterionIds.has(finding.criterionId) && (finding.verdict === 'PASS' || finding.verdict === 'FAIL'))
      .map((finding) => [finding.criterionId, { verdict: finding.verdict as FindingVerdict, note: finding.note || '' }]));
    setFindings((current) => ({ ...current, ...restoredFindings }));
    setEpisodeActions((current) => ({ ...current, [selectedEpisode.episodeUid]: selectedSubmission.recommendation || '' }));
    setEpisodeNotes((current) => ({ ...current, [selectedEpisode.episodeUid]: selectedSubmission.note || '' }));
    setEditingEpisodeUid(selectedEpisode.episodeUid);
    setMessage(`${selectedEpisode.displayId}已进入修改状态；再次提交会显式取代当前本集提交头。`);
  }

  function cancelSelectedSubmissionEdit() {
    setEditingEpisodeUid(null);
    setMessage(`${selectedEpisode.displayId}修改已取消，当前已提交版本保持不变。`);
  }

  const refreshCandidate = useCallback(async (preferRevision?: CreativeRevision | null) => {
    setContractError('');
    setLoadingState(true);
    try {
      let latest: CreativeRevision | null = preferRevision || null;
      if (!latest) {
        const response = await fetch(`/api/v1/workspaces/creative-revisions?subjectKind=EPISODE_PLAN&subjectId=${PLAN_ID}&revisionId=${encodeURIComponent(resolvedPlan.revisionId)}&archive=${historicalReadOnly?'1':'0'}&limit=5000`, { cache: 'no-store' });
        const payload = await response.json() as { events?: CreativeRevision[]; error?: string };
        if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
        if (resolvedPlan.sourceRole === 'CANDIDATE') {
          latest = payload.events?.find((event) => event.creativeRevisionId === resolvedPlan.revisionId && event.contentHash === resolvedPlan.contentHash) || null;
          if (!latest) throw new Error('页面绑定的分集候选不可用，请重新选择方案');
        } else {
          latest = payload.events?.find((event) => event.baseRevisionHash === baseRevisionHash && JSON.stringify(candidateContent(event.content, PLAN_ID)) === contentKey) || null;
        }
      }
      if (!latest) {
        setCandidate(null);
        setReview(null);
        setEpisodeSubmissions([]);
        return;
      }
      const parsed = candidateContent(latest.content, PLAN_ID);
      if (!parsed) throw new Error('当前候选不符合EPISODE_PLAN canonical内容契约');
      const normalized = { ...latest, content: parsed };
      setCandidate(normalized);
      const [reviewResponse, episodeSubmissionResponse] = await Promise.all([
        fetch(`/api/v1/workspaces/reviews?subjectKind=EPISODE_PLAN&subjectId=${PLAN_ID}&archive=${historicalReadOnly?'1':'0'}&subjectRevisionId=${encodeURIComponent(normalized.creativeRevisionId)}&contextHash=${normalized.contextHash}&limit=5000`, { cache: 'no-store' }),
        fetch(`/api/v1/workspaces/episode-plan-reviews?subjectRevisionId=${encodeURIComponent(normalized.creativeRevisionId)}&archive=${historicalReadOnly?'1':'0'}&subjectRevisionId=${encodeURIComponent(normalized.creativeRevisionId)}&contextHash=${normalized.contextHash}&limit=5000`, { cache: 'no-store' }),
      ]);
      const reviewPayload = await reviewResponse.json() as { events?: ReviewEvent[]; error?: string };
      if (!reviewResponse.ok) throw new Error(reviewPayload.error || `HTTP ${reviewResponse.status}`);
      const episodeSubmissionPayload = await episodeSubmissionResponse.json() as { heads?: EpisodeSubmissionEvent[];latestHeads?:EpisodeSubmissionEvent[];episodeReviews?:EpisodeNarrativeReview[];episodeReleases?:EpisodeNarrativeStatus[]; error?: string };
      if (!episodeSubmissionResponse.ok) throw new Error(episodeSubmissionPayload.error || `HTTP ${episodeSubmissionResponse.status}`);
      const heads = (episodeSubmissionPayload.heads || []).filter((event) => event.subjectRevisionId === normalized.creativeRevisionId);
      setEpisodeSubmissions(heads);setLatestEpisodeHeads(episodeSubmissionPayload.latestHeads||heads);
      setEpisodeReviews(episodeSubmissionPayload.episodeReviews || []);
      setEpisodeReleases(episodeSubmissionPayload.episodeReleases || []);
      const latestReview = reviewPayload.events?.find((event) => (event.subjectRevisionId || event.creativeRevisionId) === normalized.creativeRevisionId) || null;
      setReview(historicalReadOnly ? latestReview : null);

    } catch (reason) {
      setContractError(reason instanceof Error ? reason.message : 'UNKNOWN');
    } finally {
      setLoadingState(false);
    }
  }, [PLAN_ID, baseRevisionHash, contentKey, resolvedPlan]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshCandidate(), 0);
    const refresh = () => void refreshCandidate();
    window.addEventListener('review:operations-updated', refresh);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('review:operations-updated', refresh);
    };
  }, [refreshCandidate, snapshotId]);

  async function submitReview() {
    const noteRequired = reviewAction === 'REQUEST_REVISION' || reviewAction === 'DO_NOT_USE';
    if (!validation.valid || !reviewAction || !allJudged || !failedFindingsExplained || !actionCompatible || (noteRequired && !note.trim()) || hostedReadOnly || busy || loadingState || contractError || review || (selectedSubmission && !editingSelectedSubmission) || historicalReadOnly) return;
    const isCorrection = editingSelectedSubmission;
    const target = candidateMatchesPlan ? candidate : null;
    try {
      setBusy(true);
      setMessage(`正在核对当前分集版本并提交${selectedEpisode.displayId}本集审阅…`);
      if (!target) throw new Error('当前分集依据尚未读取完整，请保留判断并重新读取');
      const body = {
        schemaVersion: '1.1',
        operation: 'SUBMIT_EPISODE',
        snapshotId,
        subjectRevisionId: target.creativeRevisionId,
        subjectRevisionHash: target.contentHash,
        contextHash: target.contextHash,
      ...(target.criteriaVersion ? { criteriaVersion: target.criteriaVersion } : {}),
      reviewSpecHash: resolvedPlan.reviewSpec?.hash,
        episodeUid: selectedEpisode.episodeUid,
        objectRevisionId:latestEpisodeHeads.find(e=>e.episodeUid===selectedEpisode.episodeUid)?.objectRevisionId||selectedEpisode.revisionId,expectedVersion:latestEpisodeHeads.find(e=>e.episodeUid===selectedEpisode.episodeUid)?.objectVersion??selectedEpisode.objectVersion,
        criterionFindings: selectedCriterionFindings.map(({ criterionId, finding }) => ({
          criterionId,
          verdict: finding.verdict,
          ...(finding.note.trim() ? { note: finding.note.trim() } : {}),
        })),
        reviewAction,
        note: note.trim() || undefined,
        ...episodeSubmissionSupersession(latestEpisodeHeads.find(e=>e.episodeUid===selectedEpisode.episodeUid)?.eventId|| (isCorrection ? selectedSubmission?.eventId : null)),
      };
      const response = await fetch('/api/v1/workspaces/episode-plan-reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': await requestKey(`episode-plan-${selectedEpisode.episodeUid}`, body) },
        body: JSON.stringify(body),
      });
      const payload = await response.json() as { eventId?: string; event?: EpisodeSubmissionEvent; allEpisodesSubmitted?: boolean; completedEpisodeCount?: number; totalEpisodeCount?: number; error?: string };
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      setEditingEpisodeUid(null);
      setMessage(reviewAction==='APPROVE_AND_RELEASE'?`${selectedEpisode.displayId}已采用，判断与本集采用版本已同时生效。`:`${selectedEpisode.displayId}正式结论已记录：${actionLabel(reviewAction)}。`);
      await refreshCandidate(target);
      window.dispatchEvent(new CustomEvent('review:operations-updated'));
    } catch (reason) {
      const detail = visibleText(reason instanceof Error ? reason.message : 'UNKNOWN');
      setMessage(`${selectedEpisode.displayId}本集审阅${isCorrection ? '修正' : ''}提交失败：${detail}`);
    } finally {
      setBusy(false);
    }
  }

  const blockers = [
    !selectedEpisode.revisionId || !Number.isSafeInteger(selectedEpisode.objectVersion) ? '本集版本尚未读取完整' : '',
    !hashIsValid(resolvedPlan.contentHash) ? '当前分集依据校验值缺失' : '',
    !candidateMatchesPlan ? '当前分集依据尚未读取完整' : '',
    ...validation.issues,
  ].filter(Boolean);
  const noteRequired = reviewAction === 'REQUEST_REVISION' || reviewAction === 'DO_NOT_USE';
  const completedEpisodeCount = review ? seed.episodes.length : episodeSubmissions.length;
  const firstIncompleteEpisode = seed.episodes.find((episode) => !submissionByEpisode.has(episode.episodeUid));
  const canSubmit = selectedSceneMatchesEpisode && !hostedReadOnly
    && !busy
    && !loadingState
    && !contractError
    && !review
    && (!selectedSubmission || editingSelectedSubmission)
    && !historicalReadOnly
    && blockers.length === 0
    && Boolean(reviewAction)
    && allJudged
    && failedFindingsExplained
    && actionCompatible
    && (!noteRequired || Boolean(note.trim()));
  const assistantEpisodeVersionId = candidateMatchesPlan
    ? candidate?.creativeRevisionId || candidate?.revisionId || seed.revisionId || undefined
    : seed.revisionId || undefined;
  useAssistantFocus(!selectedSceneMatchesEpisode ? null : {
    projectId: projectIdFor(model), snapshotId, view: 'logic', subjectType: 'EPISODE',
    subjectId: selectedEpisode.episodeUid, title: `叙事拆解 · ${selectedEpisode.displayId} · ${activeCriterion.label}`,
    versionId: assistantEpisodeVersionId, criterionId: activeCriterion.id, itemId: selectedItemId,
  }, 10);
  const assistantEpisodeCriterionId = episodeCriterionId(selectedEpisode.episodeUid, activeCriterion.id);
  const assistantDrafts = useProjectAssistantDraftTargets({
    identity: `episode:${snapshotId}:${selectedEpisode.episodeUid}:${assistantEpisodeVersionId || baseRevisionHash}:${selectedSubmission?.eventId || 'DRAFT'}`,
    subjectId: selectedEpisode.episodeUid, versionId: assistantEpisodeVersionId,
    defaultFieldId: `criterion:${assistantEpisodeCriterionId}`,
    fields: [
      ...selectedCriteria.map(criterion => { const id=episodeCriterionId(selectedEpisode.episodeUid,criterion.id); return {fieldId:`criterion:${id}`,label:`${selectedEpisode.displayId} · ${criterion.label}意见`,value:effectiveFindings[id]?.note || ''}; }),
      { fieldId: 'episodeNote', label: `${selectedEpisode.displayId} · 本集审阅意见`, value: note },
    ],
    canAdopt: selectedSceneMatchesEpisode && draftHydrated && !hostedReadOnly && !busy && !loadingState && !contractError && !review
      && (!selectedSubmission || editingSelectedSubmission) && !historicalReadOnly,
    disabledReason: '当前集或该修订不可编辑；建议仍可复制。',
    applyField: (fieldId, nextValue) => {
      if (fieldId === 'episodeNote') setEpisodeNotes((current) => ({ ...current, [selectedEpisode.episodeUid]: nextValue }));
      else if(fieldId.startsWith('criterion:')) updateFinding(fieldId.slice('criterion:'.length), { note: nextValue });
    },
  });
  const sourceState = 'NOT_REQUIRED';
  const submitLabel = reviewAction === 'APPROVE_AND_RELEASE'
    ? `${editingSelectedSubmission ? '提交修正：' : '提交'}${selectedEpisode.displayId}可通过结论`
    : reviewAction === 'REQUEST_REVISION'
      ? `${editingSelectedSubmission ? '提交修正：' : '提交'}${selectedEpisode.displayId}修改意见`
      : reviewAction === 'DO_NOT_USE'
        ? `${editingSelectedSubmission ? '提交修正：' : '提交'}${selectedEpisode.displayId}不采用结论`
        : '请选择本集结论';

  const sceneReading=!selectedSceneMatchesEpisode?<div className="episode-scene-slot-error" role="alert"><h3>此场不属于当前集</h3><p>永久集场身份不匹配，请从本集目录重新选择；未显示另一场正文。</p></div>:renderSceneReading?renderSceneReading(readingSceneId):<p role="status">当前候选尚未提供本场完整正文。</p>;
  const navigation=<EpisodeSceneNavigator episodes={seed.episodes} selectedEpisodeUid={selectedEpisode.episodeUid} selectedSceneId={readingSceneId} sceneLabels={navigationSceneLabels} sceneReading={sceneReading} states={Object.fromEntries(seed.episodes.map(episode=>{
      const episodeFindings = EPISODE_REVIEW_CRITERIA.map((criterion) => effectiveFindings[episodeCriterionId(episode.episodeUid, criterion.id)]);
      const failed = episodeFindings.some((finding) => finding?.verdict === 'FAIL');
      const submitted = Boolean(review || submissionByEpisode.has(episode.episodeUid));
      const editing = editingEpisodeUid === episode.episodeUid;
      const released=episodeReleases.find(r=>r.episodeUid===episode.episodeUid);
      const formal=episodeReviews.find(r=>r.episodeUid===episode.episodeUid);
      const state = released?.canFlowDownstream ? '本集已生效' : formal?.action==='APPROVE_AND_RELEASE' ? '本集已采用' : historicalReadOnly && !review ? '历史只读' : editing ? '修改中' : submitted && failed ? '已提交·有问题' : submitted ? '已提交' : failed ? '草稿有问题' : '未提交';
      return [episode.episodeUid,{label:state,failed,submitted} satisfies EpisodeNavigationState];
    }))} lockedEpisodeUid={editingEpisodeUid} onSelectEpisode={onSelectEpisode} onSelectScene={onSelectScene} summary={renderEpisodeSummary?.({criterionStates})} sceneRuntimes={Object.fromEntries((resolvedPlan.content.narrativeRevision?.scenes||[]).map(scene=>[scene.id,scene.runtime]))}/>;
  const reviewCriteria=<aside className="episode-review-criteria" aria-label={`${selectedEpisode.displayId}集级判断`}>
        <header><div><small>{selectedEpisode.displayId} · 六项判断</small><h3>本集审阅</h3></div><span>{EPISODE_REVIEW_CRITERIA.filter((criterion) => effectiveFindings[episodeCriterionId(selectedEpisode.episodeUid, criterion.id)]?.verdict).length}/{EPISODE_REVIEW_CRITERIA.length}</span></header>
        <div>{selectedCriteria.map((criterion,index) => {
          const criterionId = episodeCriterionId(selectedEpisode.episodeUid, criterion.id);
          const finding = effectiveFindings[criterionId] || { verdict: '', note: '' };
          const locked = Boolean(review) || Boolean(selectedSubmission && !editingSelectedSubmission) || historicalReadOnly || hostedReadOnly;
          return <article data-criterion-id={criterion.id} className={`${activeCriterion.id===criterion.id?'is-reading ':''}${finding.verdict ? `is-${finding.verdict.toLowerCase()}` : ''}`} key={criterion.id}>
            <div><button type="button" className="episode-criterion-title" aria-pressed={activeCriterion.id===criterion.id} onClick={()=>onSelectCriterion(criterion.id)}>{String(index+1).padStart(2,'0')} · {criterion.label}</button><p>{criterion.question}</p></div>
            <div role="radiogroup" aria-label={`${selectedEpisode.displayId} ${criterion.label}`}>
              {([['PASS', '通过'], ['FAIL', '有问题']] as const).map(([verdict, label]) => <button type="button" role="radio" aria-checked={finding.verdict === verdict} disabled={locked || busy || loadingState} className={finding.verdict === verdict ? 'active' : ''} key={verdict} onClick={() => updateFinding(criterionId, { verdict: finding.verdict === verdict ? '' : verdict })}>{label}</button>)}
            </div>
            <label><span>{finding.verdict === 'FAIL' ? '问题与修改方向（必填）' : '说明（可选）'}</span><textarea disabled={locked} aria-invalid={finding.verdict === 'FAIL' && !finding.note.trim()} value={finding.note} onFocus={() => assistantDrafts.activateField(`criterion:${criterionId}`)} onChange={(event) => updateFinding(criterionId, { note: event.target.value })} placeholder={finding.verdict === 'FAIL' ? '指出本集的具体问题和可执行修改方向' : '可补充判断依据'} /></label>
            <button type="button" disabled={hostedReadOnly || !assistantDrafts.hasTargets} onClick={()=>{assistantDrafts.activateField(`criterion:${criterionId}`);assistantDrafts.askAboutField(`criterion:${criterionId}`);}}>结合这条意见问助手</button>
          </article>;
        })}</div>
        {!review && !historicalReadOnly && <footer><span>{editingSelectedSubmission ? `正在修改${selectedEpisode.displayId}当前提交` : selectedSubmission ? `${selectedEpisode.displayId}六项判断已提交` : draftHydrated ? '本页判断自动保存在当前设备' : '正在恢复本机草稿…'}</span>{!editingSelectedSubmission && firstIncompleteEpisode && firstIncompleteEpisode.episodeUid !== selectedEpisode.episodeUid && <button type="button" onClick={() => onSelectEpisode(firstIncompleteEpisode.episodeUid)}>前往未提交集：{firstIncompleteEpisode.displayId} →</button>}</footer>}
      </aside>;

  if(selectedSceneId&&!selectedSceneMatchesEpisode)return <section className="episode-plan-workbench"><div className="episode-scene-slot-error" role="alert"><h2>此场不属于当前集</h2><p>永久集场身份不匹配，未展示其他场正文或集级提交表。</p>{onSelectScene&&<button type="button" onClick={()=>onSelectScene(null)}>返回当前集目录</button>}</div></section>;
  return <section className="episode-plan-workbench episode-plan-overall-review" aria-label="分集方案逐集审阅">
    <header className="episode-plan-review-heading">
      <div><small>集与场 · {historicalReadOnly ? '历史方案' : seed.sourceRole === 'CURRENT' ? '当前方案' : '待审候选'}</small><h2>叙事拆解与审阅</h2><p>逐场阅读正文、圈选评论，完成本集六项判断。确认通过后，本集的判断与采用版本同时生效，即可独立推进制作。</p></div>
      <span data-review-state>{loadingState ? '读取审阅状态…' : review ? actionLabel(review.action) : episodeSubmissions.length === seed.episodes.length ? '分集审阅已完成' : episodeSubmissions.length > 0 ? '审阅进行中' : '待逐集审阅'}</span>
    </header>

    {contractError && <p className="v8-inline-error" role="alert">审阅状态暂不可用：{visibleText(contractError)}。读取失败期间不接受提交。</p>}

    <section className={`episode-review-integrity ${validation.valid ? 'is-ready' : 'is-blocked'}`} role="status">
      <b>{historicalReadOnly ? `历史方案 · ${seed.episodes.length} 集` : validation.valid ? `已提交 ${completedEpisodeCount}/${seed.episodes.length} 集` : '当前方案不能提交'}</b>
      {!historicalReadOnly && !validation.valid && <span>{validation.issues.length}项结构问题需要先修复。</span>}
    </section>

    {!selectedSceneId&&<StoryObjectEditor objectId={selectedEpisode.episodeUid} readOnly={historicalReadOnly} sceneNames={Object.fromEntries(Object.entries(navigationSceneLabels).map(([id,s])=>[id,s.displayId+' '+s.title]))}/>}
    {renderEpisodeLayout?renderEpisodeLayout({criterionStates,navigation,criteria:reviewCriteria}):<>{navigation}<div className="episode-review-workspace">
      <div className="episode-review-reading">{typeof children === 'function' ? children({ criterionStates }) : children}</div>
      {reviewCriteria}
    </div></>}

    {review ? <section className="episode-review-receipt" aria-label="整体审阅结果">
      <div><small>全部分集已汇总</small><b>{actionLabel(review.action)}</b></div>
      <p>{review.action === 'APPROVE_AND_RELEASE'
        ? `审阅已经登记；历史汇总结论保留。各集当前采用状态以其独立判断为准。`
        : '全部分集提交已汇总为整套结论；该候选不会进入当前分集方案，后续修改应形成新的完整候选。'}</p>
      {Object.keys(recordedFindings).length !== allCriterionIds.length && <p className="episode-plan-submit-check">该结论缺少完整的逐集判断，当前无法确认各集审阅结果。</p>}
    </section> : historicalReadOnly ? <section className="episode-review-receipt" aria-label="整体审阅结果">
      <div><small>历史方案</small><b>只读</b></div>
      <p>当前页面展示历史版本，原判断与正文只读保留。</p>
    </section> : selectedSubmission && !editingSelectedSubmission ? <section className="episode-review-receipt episode-review-submission-receipt" aria-label={`${selectedEpisode.displayId}本集提交结果`}>
      <div><small>{selectedEpisode.displayId}已提交</small><b>{episodeRecommendationLabel(selectedSubmission.recommendation)}</b></div>
      <p><span>本集判断已登记；修改会保留原结论并核对当前版本。</span>{!hostedReadOnly && <button type="button" onClick={editSelectedSubmission}>{EPISODE_SUBMISSION_CORRECTION_LABEL}</button>}</p>
    </section> : <form className="episode-plan-review episode-review-per-episode" aria-label={`${selectedEpisode.displayId}本集审阅提交`} onSubmit={(event) => { event.preventDefault(); void submitReview(); }}>
      <header className="episode-plan-final-summary"><div><small>{selectedEpisode.displayId} · 本集结论</small><h3>{editingSelectedSubmission ? `修正${selectedEpisode.displayId}本集提交` : `提交${selectedEpisode.displayId}本集结论`}</h3></div><span>{failedFindings.length ? `${failedFindings.length}项有问题` : allJudged ? '六项判断已完成' : `还差${selectedCriterionFindings.filter(({ finding }) => !finding.verdict).length}项判断`}</span></header>
      {editingSelectedSubmission && <p className="episode-plan-correction-note" role="status">提交后将更新本集的六项判断与意见。</p>}
      {failedFindings.length > 0 && <section className="episode-plan-failure-summary" aria-label={`${selectedEpisode.displayId}问题汇总`}><b>本集需要处理的问题</b><ul>{failedFindings.map(({ episode, criterion, finding }) => <li key={episodeCriterionId(episode.episodeUid, criterion.id)}><span>{episode.displayId} · {criterion.label}</span><p>{finding.note.trim() || '尚未填写修改方向'}</p></li>)}</ul></section>}
      <fieldset disabled={busy || loadingState || hostedReadOnly}>
        <legend>本集判断</legend>
        {([
          ['APPROVE_AND_RELEASE', '本集可通过', '六项均通过，确认后采用本集当前版本'],
          ['REQUEST_REVISION', '本集需修改', '记录本集的修改要求，保留原有判断与版本'],
          ['DO_NOT_USE', '本集不应采用', '禁用本集当前版本，并标记实际引用它的下游'],
        ] as Array<[Exclude<ReviewAction, ''>, string, string]>).map(([value, label, description]) => <label className={reviewAction === value ? 'selected' : ''} key={value}>
          <input type="radio" name={`episode-plan-action-${selectedEpisode.episodeUid}`} value={value} checked={reviewAction === value} onClick={() => { if (reviewAction === value) selectEpisodeAction(''); }} onChange={() => selectEpisodeAction(value)} />
          <span><b>{label}</b><small>{description}</small></span>
        </label>)}
      </fieldset>
      <label className="episode-review-note"><span>本集审阅意见{noteRequired ? '（必填）' : '（可选）'}</span><textarea aria-label={`${selectedEpisode.displayId}本集审阅意见`} value={note} onFocus={() => assistantDrafts.activateField('episodeNote')} onChange={(event) => setEpisodeNotes((current) => ({ ...current, [selectedEpisode.episodeUid]: event.target.value }))} placeholder="说明本集为什么通过，或概括需要修改、禁止使用的原因" /></label>
      {!allJudged && <p className="episode-plan-submit-check" role="status">请先完成{selectedEpisode.displayId}全部{selectedCriterionFindings.length}项判断。</p>}
      {allJudged && !failedFindingsExplained && <p className="episode-plan-submit-check" role="alert">每个“有问题”项都必须写明具体问题和修改方向。</p>}
      {reviewAction && !actionCompatible && <p className="episode-plan-submit-check" role="alert">“本集可通过”不能包含失败项；“本集需修改”或“本集不应采用”至少需要一项“有问题”。</p>}
      {blockers.length > 0 && <section className="adaptation-hard-blockers" role="alert"><b>当前审阅失败关闭</b><ul>{blockers.map((item) => <li key={item}>{item}</li>)}</ul></section>}
      <footer><p>{hostedReadOnly ? '远端镜像只读；请回到本地正式审阅入口。' : editingSelectedSubmission ? `修改${selectedEpisode.displayId}当前结论，保留原判断记录。` : `确认后同时记录${selectedEpisode.displayId}的判断与采用状态。`}</p>{editingSelectedSubmission && <button type="button" className="is-secondary" disabled={busy} onClick={cancelSelectedSubmissionEdit}>取消修改</button>}<button type="submit" disabled={!canSubmit}>{busy ? '正在提交…' : hostedReadOnly ? '远端镜像不可提交' : submitLabel}</button></footer>
    </form>}

    {selectedSubmission && !editingSelectedSubmission && <section className="episode-review-receipt" aria-label="本集独立推进">
      <div><small>{selectedEpisode.displayId} · 本集独立推进</small><b>{selectedEpisodeRelease?.canFlowDownstream?'本集已采用，可独立制作':actionLabel(selectedEpisodeReview?.action||selectedSubmission.recommendation)}</b></div>
      <p>{selectedEpisodeRelease?.canFlowDownstream?'本集采用版本与判断已同时生效。各场的镜头设计、实际输入和后续产物继续分别核对；其他集未完成不会阻断本集。':'当前结论已生效，原判断记录完整保留。'}</p>
      {selectedEpisodeRelease?.state==='STALE'&&<p role="alert">{selectedEpisodeRelease.reason}</p>}
      {selectedEpisodeRelease?.canFlowDownstream&&<a href={runtimePath(`?view=pipeline&creatorStage=shot-production&preparationEpisode=${encodeURIComponent(selectedEpisode.episodeUid)}&preparationScene=${encodeURIComponent(selectedEpisode.sceneIds[0])}`)}>进入本集镜头制作 →</a>}
    </section>}


    {message && <p className="creative-operation-message" role="status" aria-live="polite">{message}</p>}
  </section>;
}
