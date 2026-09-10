'use client';

import {runtimePath} from './runtime-path';
/* eslint-disable @next/next/no-img-element -- Review displays the exact registered media bytes. */


import { useEffect, useRef, useState } from 'react';
import { materialCriterionDescription } from './material-review-display';
import { useRuntimeMode } from './runtime-mode';
import './trial/trial.css';

type Criterion = { id: string; label: string; description: string };
export type TrialAsset = {
  id: string; mediaId: string; versionId: string; sha256: string;
  scopeId?: string; sourceRequirementId?: string;
  mediaKind: 'IMAGE' | 'AUDIO' | 'VIDEO'; mediaUrl: string; version: number;
  lifecycle: string; title?: string; label?: string; recipeId?: string; metadata: Record<string, unknown>;
  prompt: string | { main?: string; negative?: string; full?: string; model?: string; parameters?: Record<string, unknown>; inputs?: unknown[] };
  qa: Record<string, unknown>; reviewCriteria: Criterion[]; reviewHeadId?: string;
  qualityBlocked?: boolean;
  qualityBlockReason?: string; nonWaivableBlocked?: boolean;
  reviewLock?: { locked: boolean; reason: string };
  qaObservations?: Array<{ observations: { summary?: string; technicalStatus?: string; auditoryStatus?: string; findings?: Array<string | { observation?: string }> }; sourceSHA: string }>;
  latestReview?: { payload: { decision: string; comment?: string; criteria?: Array<{ id: string; result: string; comment?: string }> } };
};
export type TrialSnapshot = {
  mode: 'LOCAL_TRIAL'; mutationEtag: string;
  scope: { id: string; title: string; projectTitle: string; countsTowardFormalProject: false };
  checkpoint: Record<string, unknown>;
  recipes: Array<{ id: string; subjectId: string; originalSubjectId?: string; sourceRequirementId?: string; sourceRequirementHash?: string; sourceTrialThemeId?: string; label: string; model: string; mediaKind?: string; outputPath?: string; fullPrompt?: string; blockedBy?: string[] }>;
  story?: {
    episodes: Array<{ episodeUid: string; displayLabel: string; title: string; goal: string; audienceKnowsAtEnd: string; endingHook: string; sourceSceneId: string }>;
    sourceScenes: Array<{ sceneId: string; exactSourceText: string }>;
    shotProposals: Array<{ id: string; episodeUid: string; displayLabel: string; title: string; visualIntent: string; continuityIntent: string; audienceGain: string; proposedDurationSeconds: number }>;
    dialogue: Array<{ id: string; speaker: string; text: string; shotProposalId: string }>;
  };
  assets: TrialAsset[];
  budgets: Record<string, unknown> | Array<Record<string, unknown>>;
  executions: Array<Record<string, unknown>>;
};
const labels: Record<string, string> = {
  REVIEW_PENDING: '待你审阅', RELEASED: '已通过并放行', REVISION_REQUIRED: '需要修改', DO_NOT_USE: '禁止使用',
};
function readablePrompt(value: TrialAsset['prompt']) {
  return typeof value === 'string' ? value : value.full || [value.main, value.negative].filter(Boolean).join('\n\n');
}

export type TrialScopeIndex = { scopes: TrialSnapshot['scope'][]; defaultScopeId: string | null };
export async function loadTrialScopes(signal: AbortSignal): Promise<TrialScopeIndex> {
  const response = await fetch('/api/trial/scopes', { cache: 'no-store', signal });
  const data = await response.json() as TrialScopeIndex & { message?: string };
  if (!response.ok) throw new Error(data.message || '试制范围暂时无法读取。');
  if (!Array.isArray(data.scopes)) throw new Error('试制范围格式不匹配。');
  return data;
}
export async function loadTrialSnapshots(signal: AbortSignal): Promise<TrialSnapshot[]> {
  const index = await loadTrialScopes(signal);
  const snapshots = await Promise.all(index.scopes.map((scope) => loadTrialSnapshot(signal, scope.id)));
  return snapshots.filter((snapshot): snapshot is TrialSnapshot => snapshot !== null);
}
export async function loadTrialSnapshot(signal: AbortSignal, scopeId?: string): Promise<TrialSnapshot | null> {
  const response = await fetch('/api/trial/snapshot' + (scopeId ? `?scopeId=${encodeURIComponent(scopeId)}` : ''), { cache: 'no-store', signal });
  const data = await response.json() as TrialSnapshot & { error?: string; message?: string };
  if (response.status === 503 && data.error === 'TRIAL_NOT_IMPORTED') return null;
  if (!response.ok) throw new Error(data.message || '试制资料暂时无法读取，请稍后重试。');
  if (data.mode !== 'LOCAL_TRIAL' || !data.scope || !Array.isArray(data.assets) || !Array.isArray(data.recipes)) throw new Error('试制资料格式不匹配。');
  if (scopeId && data.scope.id !== scopeId) throw new Error('试制返回范围与所选范围不一致。');
  return { ...data, assets: data.assets.map(asset => ({ ...asset, scopeId: data.scope.id })), mutationEtag: response.headers.get('etag') || data.mutationEtag };
}

export function AssetReview({ asset, etag, refresh, currentVersion, readOnly=false }: { asset: TrialAsset; etag: string; refresh: () => Promise<void>; currentVersion: boolean; readOnly?:boolean }) {
  const runtime=useRuntimeMode(),hostedReadOnly=runtime.hostedReadOnly||readOnly;
  const [answers, setAnswers] = useState<Record<string, { result: string; comment: string }>>(() => Object.fromEntries((asset.latestReview?.payload.criteria || []).map((criterion) => [criterion.id, { result: criterion.result, comment: criterion.comment || '' }])));
  const [comment, setComment] = useState('');
  const [internalOnly, setInternalOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [enlarged, setEnlarged] = useState(false);
  const imageDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (enlarged) imageDialog.current?.showModal();
    else imageDialog.current?.close();
  }, [enlarged]);
  const [correction, setCorrection] = useState(false);
  const isInitial = !asset.reviewHeadId;
  const canEdit = !hostedReadOnly && currentVersion && !asset.reviewLock?.locked && (isInitial || correction);
  async function submit(decision: string) {
    if (!canEdit || busy) return;
    setBusy(true); setMessage('');
    try {
      const response = await fetch('/api/trial/reviews' + (asset.scopeId ? `?scopeId=${encodeURIComponent(asset.scopeId)}` : ''), {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'If-Match': etag, 'Idempotency-Key': `trial-review-${crypto.randomUUID()}` },
        body: JSON.stringify({
          mediaId: asset.mediaId, versionId: asset.versionId, sha256: asset.sha256, decision, comment,
          ...(asset.scopeId ? { scopeId: asset.scopeId } : {}),
          criteria: asset.reviewCriteria.map(({ id }) => ({ id, result: answers[id]?.result || '', comment: answers[id]?.comment || '' })),
          ...(internalOnly ? { rightsAttestation: 'PROJECT_INTERNAL_ONLY' } : {}),
          ...(asset.reviewHeadId ? { supersedesReviewEventId: asset.reviewHeadId } : {}),
        }),
      });
      const body = await response.json() as { error?: string; message?: string };
      if (!response.ok) {
        const explanations: Record<string, string> = { CAS_CONFLICT: '素材或执行记录已变化，请刷新状态后重新检查；当前意见已保留。', REVIEW_LOCKED: '该版本已有后续采用或新版本，当前判断已锁定。', QUALITY_BLOCK: '这版已确认不符合固定制作要求，需修正后登记新候选；当前意见已保留。', NON_WAIVABLE_BLOCK: '该版本存在权利或安全阻断，不能通过内部使用确认放行。', REVIEW_CRITERIA: '请完成每一项判断。逐项与整体意见均可选填。', RIGHTS_UNKNOWN: '采用前需明确确认项目内部使用范围。' };
        throw new Error(explanations[body.error || ''] || body.message || '意见暂未保存，请保留内容后重试。');
      }
      await refresh(); setMessage('已保存本版本的审阅结论。'); setCorrection(false);
    } catch (error) { setMessage(error instanceof Error ? error.message : '提交失败，意见仍保留在页面。'); }
    finally { setBusy(false); }
  }
  const complete = asset.reviewCriteria.length > 0 && asset.reviewCriteria.every(({ id }) => answers[id]?.result);
  const allPass = complete && asset.reviewCriteria.every(({ id }) => answers[id]?.result === 'PASS');
  const needsRights = String(asset.metadata.RIGHTS_STATUS || asset.metadata.rightsStatus || 'UNKNOWN') === 'UNKNOWN';
  const commonReason = hostedReadOnly ? '镜像仅供查看，请到本地保存正式审阅。' : busy ? '正在保存，请稍候。' : !currentVersion ? '历史版本只读，请切换到最新版本。' : asset.reviewLock?.locked ? asset.reviewLock.reason : !canEdit ? '本版本已保存审阅结论。如需调整，请先点“纠正上次判断”。' : '';
  const incompleteReason = complete ? '' : '请先完成全部逐项判断。';
  const releaseReason = commonReason || (asset.qualityBlocked ? asset.qualityBlockReason || '技术预检已确认这版需要返修，请登记修正后的新候选再审阅。' : asset.nonWaivableBlocked ? '权利或安全问题尚未解决，不能放行。' : incompleteReason || (!allPass ? '有判断为“需要修改”，请先返修。' : needsRights && !internalOnly ? '放行前请确认本项目内部使用范围。' : ''));
  return <>
    <section className="trial-product" aria-label="产物展示与版本状态">
      <div className="trial-media">
        {asset.mediaKind === 'IMAGE' ? <button className="trial-image-button" onClick={() => setEnlarged(true)} aria-label="放大原图"><img src={runtimePath(asset.mediaUrl)} alt={asset.title || asset.label || '当前母版候选'} /></button>
          : asset.mediaKind === 'AUDIO' ? <div className="trial-audio"><span aria-hidden="true">♫</span><audio controls preload="metadata" src={runtimePath(asset.mediaUrl)}>浏览器无法播放此声音。</audio><p>请完整试听，再判断声音、口音与干净程度。</p></div>
            : <video controls preload="metadata" src={runtimePath(asset.mediaUrl)} />}
      </div>
      <div className="trial-version"><span className="trial-status">{labels[asset.lifecycle] || asset.lifecycle}</span><h2>{asset.title || asset.label || '母版候选'}</h2><p>版本 {asset.version}</p><p>本次判断只应用于当前版本。通过后可在本试制范围继续制作。</p>{asset.latestReview && <p><b>最近意见</b><br />{asset.latestReview.payload.comment || '已记录逐项判断。'}</p>}</div>
    </section>
    <dialog ref={imageDialog} className="trial-lightbox" aria-label="图片原件" onCancel={() => setEnlarged(false)}><button autoFocus onClick={() => setEnlarged(false)}>关闭原图</button><img src={runtimePath(asset.mediaUrl)} alt={asset.title || asset.label || '母版原图'} /></dialog>
    <section className="trial-review material-review-zone" aria-label="正式审阅">
      {asset.qualityBlocked && <aside className="trial-feedback"><b>技术预检发现需要返修</b><p>{asset.qualityBlockReason || '这版尚未符合固定制作要求，不能放行进入下游。'}</p></aside>}
      {asset.mediaKind === 'AUDIO' && <aside className="trial-feedback"><b>{asset.lifecycle === 'RELEASED' ? '声音已通过并放行' : '声音表现待完整试听'}</b><p>{asset.lifecycle === 'RELEASED' ? '本版本的审阅结论已保存。仍可随时试听；需要改变结论时，请先进入纠错。' : '请完整试听并检查口音、语气、可懂度和起止静音；循环环境底声还需比较结尾与开头是否自然衔接。技术记录不代表听觉验收通过。'}</p></aside>}
      {!currentVersion && <p className="trial-feedback">这是历史版本，只读查看。请切换到最新版本提交意见。</p>}
      <div className="trial-section-title"><div><h2>这版可以采用吗？</h2><p>先逐项判断，再选择结论。具体位置或表现可在意见中补充。</p></div>{!hostedReadOnly && !isInitial && !correction && <button disabled={busy || !currentVersion || asset.reviewLock?.locked} aria-describedby={!currentVersion || asset.reviewLock?.locked ? 'trial-common-reason' : undefined} onClick={() => setCorrection(true)}>纠正上次判断</button>}</div>
      <div className="trial-criteria">{asset.reviewCriteria.map((criterion) => <fieldset disabled={busy || !canEdit} key={criterion.id}>
        <legend>{criterion.label}</legend>{materialCriterionDescription(criterion.label,criterion.description)&&<p>{materialCriterionDescription(criterion.label,criterion.description)}</p>}
        <label><input type="radio" name={`${asset.id}-${criterion.id}`} value="PASS" checked={answers[criterion.id]?.result === 'PASS'} onClick={() => { if (answers[criterion.id]?.result === 'PASS') setAnswers(old => ({ ...old, [criterion.id]: { ...old[criterion.id], result: '' } })); }} onChange={() => setAnswers({ ...answers, [criterion.id]: { comment: answers[criterion.id]?.comment || '', result: 'PASS' } })} />符合</label>
        <label><input type="radio" name={`${asset.id}-${criterion.id}`} value="FAIL" checked={answers[criterion.id]?.result === 'FAIL'} onClick={() => { if (answers[criterion.id]?.result === 'FAIL') setAnswers(old => ({ ...old, [criterion.id]: { ...old[criterion.id], result: '' } })); }} onChange={() => setAnswers({ ...answers, [criterion.id]: { comment: answers[criterion.id]?.comment || '', result: 'FAIL' } })} />需要修改</label>
        {answers[criterion.id]?.result === 'FAIL' && <textarea rows={2} aria-label={`${criterion.label}的修改意见（选填）`} value={answers[criterion.id]?.comment || ''} onChange={(event) => setAnswers({ ...answers, [criterion.id]: { result: 'FAIL', comment: event.target.value } })} placeholder="选填：说明具体需要修改的内容" />}
      </fieldset>)}</div>
      <label className="trial-comment">整体意见（选填）<textarea rows={2} disabled={busy || !canEdit} value={comment} onChange={(event) => setComment(event.target.value)} placeholder="可补充想保留、改变或重新尝试的部分；留空也能提交。" /></label>
      {needsRights && <label className="trial-rights"><input type="checkbox" disabled={busy || !canEdit} checked={internalOnly} onChange={(event) => setInternalOnly(event.target.checked)} /><span>我确认本版本可用于本项目内部制作。权利情况仍未核验，此确认不代表可以商业发行。</span></label>}
      {commonReason && <p id="trial-common-reason" className="trial-feedback">{commonReason}</p>}
      {!commonReason && incompleteReason && <p id="trial-incomplete-reason">{incompleteReason}</p>}
      <div className="trial-actions"><div><button disabled={Boolean(releaseReason)} aria-describedby={commonReason ? 'trial-common-reason' : releaseReason ? 'trial-release-reason' : undefined} onClick={() => void submit('RELEASED')}>通过并放行</button>{!commonReason && releaseReason && <p id="trial-release-reason" style={{ maxWidth: 320 }}>{releaseReason}</p>}</div><button disabled={Boolean(commonReason || incompleteReason)} aria-describedby={commonReason ? 'trial-common-reason' : incompleteReason ? 'trial-incomplete-reason' : undefined} onClick={() => void submit('REVISION_REQUIRED')}>要求修改</button><button disabled={Boolean(commonReason || incompleteReason)} aria-describedby={commonReason ? 'trial-common-reason' : incompleteReason ? 'trial-incomplete-reason' : undefined} onClick={() => void submit('DO_NOT_USE')}>禁止使用</button></div>
      {message && <p role="status" className="trial-feedback">{message}</p>}
    </section>
    <section className="trial-details material-trial-production"><h2>全部生产资料</h2><h3>实际使用的完整 Prompt</h3><pre>{readablePrompt(asset.prompt)}</pre><details><summary>版本、输入附件与技术检查记录</summary><pre>{JSON.stringify({ versionId: asset.versionId, sha256: asset.sha256, metadata: asset.metadata, qa: asset.qa }, null, 2)}</pre></details></section>
  </>;
}
