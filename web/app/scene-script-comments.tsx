'use client';

import { useInstanceProfile } from './instance-context';
import {requestCommentPolish} from './comment-polish-client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRuntimeMode } from './runtime-mode';
import { useAssistantFocus } from './assistant/context-provider';
import { useProjectAssistantDraftTargets } from './assistant/project-draft-adapters';
import { PaginatedClosedCommentHistory, type ClosedCommentHistoryEntry } from './closed-comment-history';

export type SceneCommentAnchorSegment = {
  blockId: string;
  startOffset: number;
  endOffset: number;
  quote: string;
  sourceLineStart?: number;
  sourceLineEnd?: number;
};

export type SceneCommentAnchor = {
  blockId: string;
  startOffset: number;
  endOffset: number;
  endBlockId?: string;
  endBlockOffset?: number;
  quote: string;
  prefix?: string;
  suffix?: string;
  sourceLineStart?: number;
  sourceLineEnd?: number;
  segments?: SceneCommentAnchorSegment[];
  anchorHash?: string;
};

export function sceneCommentAnchorSegments(anchor: SceneCommentAnchor): SceneCommentAnchorSegment[] {
  if (Array.isArray(anchor.segments) && anchor.segments.length) return anchor.segments;
  return [{
    blockId: anchor.blockId,
    startOffset: anchor.startOffset,
    endOffset: anchor.endOffset,
    quote: anchor.quote,
    sourceLineStart: anchor.sourceLineStart,
    sourceLineEnd: anchor.sourceLineEnd,
  }];
}

export type ScriptCommentThread = {
  commentId: string;
  commentRevisionId: string;
  commentTextHash: string;
  editCount: number;
  lastEditedAt: string | null;
  latestEventId: string;
  sceneId: string;
  creationSnapshotId: string;
  sceneContentHash: string;
  businessContextHash: string;
  anchor: SceneCommentAnchor;
  commentText: string;
  status: 'OPEN' | 'AI_QUEUED' | 'AI_PROCESSING' | 'RESOLVED';
  assignee: 'USER' | 'AI';
  createdAt: string;
  updatedAt: string;
  resolvedBy: 'USER' | 'AI' | null;
  resolutionNote: string;
  alignedSnapshotId: string | null;
  alignedSceneContentHash: string | null;
  applicabilityState: 'CURRENT' | 'STALE';
  staleReasons: string[];
  anchorMatchesCurrentText: boolean;
  resolutionAlignedToCurrent: boolean;
};

type SceneCommentTarget = {
  sceneId: string;
  sceneContentHash: string;
  businessContextHash: string;
};

type CommentPolishSuggestion = {
  polishedComment: string;
  originalComment: string;
  requestMode: 'POLISH_DRAFT' | 'SUGGEST_FROM_CONTEXT';
  model: string;
  directBeatCount: number;
  relatedBeatCount: number;
};

function sceneCommentSelectionIdentity(selection: SceneCommentAnchor | null) {
  if (!selection) return '';
  return JSON.stringify({
    blockId: selection.blockId,
    startOffset: selection.startOffset,
    endOffset: selection.endOffset,
    endBlockId: selection.endBlockId || '',
    endBlockOffset: selection.endBlockOffset ?? null,
    quote: selection.quote,
    prefix: selection.prefix || '',
    suffix: selection.suffix || '',
    sourceLineStart: selection.sourceLineStart ?? null,
    sourceLineEnd: selection.sourceLineEnd ?? null,
    anchorHash: selection.anchorHash || '',
    segments: sceneCommentAnchorSegments(selection).map((segment) => ({
      blockId: segment.blockId,
      startOffset: segment.startOffset,
      endOffset: segment.endOffset,
      quote: segment.quote,
      sourceLineStart: segment.sourceLineStart ?? null,
      sourceLineEnd: segment.sourceLineEnd ?? null,
    })),
  });
}

async function digest(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes)).map((item) => item.toString(16).padStart(2, '0')).join('');
}

async function currentMutation(snapshotId: string) {
  const response = await fetch('/api/v1/workspaces/operations/snapshot', { cache: 'no-store' });
  const payload = await response.json() as { snapshotId?: string; mutationEtag?: string; etag?: string; error?: string };
  if (!response.ok) throw new Error(payload.error || `运行快照 HTTP ${response.status}`);
  if (payload.snapshotId !== snapshotId) throw new Error('基础快照已变化，请刷新后重新核对');
  const etag = payload.mutationEtag || payload.etag;
  if (!etag) throw new Error('运行快照缺少安全写入ETag');
  return etag;
}

export function useSceneScriptComments(sceneId: string | null, snapshotId: string) {
  const requestKey = `${snapshotId}:${sceneId || 'NO_SCENE'}`;
  const [state, setState] = useState<{ requestKey: string; threads: ScriptCommentThread[]; closedHistory:ClosedCommentHistoryEntry[]; loading: boolean; error: string }>({ requestKey: '', threads: [], closedHistory:[], loading: false, error: '' });
  const requestGenerationRef = useRef(0);
  const requestAbortRef = useRef<AbortController | null>(null);
  const rememberClosed=useCallback((thread:ScriptCommentThread)=>setState(current=>{
    if(current.requestKey!==requestKey)return current;
    const open=current.threads.filter(item=>item.status!=='RESOLVED');
    const closed=[...current.threads.filter(item=>item.status==='RESOLVED'&&item.commentId!==thread.commentId),thread].slice(-20);
    return {...current,threads:[...open,...closed]};
  }),[requestKey]);
  const refresh = useCallback(() => {
    if (!sceneId) return;
    requestAbortRef.current?.abort();
    const controller = new AbortController();
    requestAbortRef.current = controller;
    const generation = ++requestGenerationRef.current;
    setState((current) => ({ ...current, requestKey, loading: true, error: '' }));
    fetch(`/api/v1/workspaces/script-comments?sceneId=${encodeURIComponent(sceneId)}&limit=500`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as { threads?: ScriptCommentThread[]; closedHistory?:ClosedCommentHistoryEntry[]; snapshotId?: string; error?: string };
        if (!response.ok) throw new Error(payload.error || `评论读取 HTTP ${response.status}`);
        if (payload.snapshotId !== snapshotId) throw new Error('评论与当前基础快照不一致');
        return {threads:payload.threads || [],closedHistory:payload.closedHistory || []};
      })
      .then(({threads,closedHistory}) => {
        if (controller.signal.aborted || requestGenerationRef.current !== generation) return;
        setState({ requestKey, threads, closedHistory, loading: false, error: '' });
      })
      .catch((reason) => {
        if (controller.signal.aborted || requestGenerationRef.current !== generation || (reason as { name?: string }).name === 'AbortError') return;
        setState({ requestKey, threads: [], closedHistory:[], loading: false, error: reason instanceof Error ? reason.message : 'UNKNOWN' });
      });
  }, [requestKey, sceneId, snapshotId]);

  useEffect(() => {
    if (!sceneId) return;
    const timer = window.setTimeout(refresh, 0);
    window.addEventListener('review:operations-updated', refresh);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('review:operations-updated', refresh);
      requestGenerationRef.current += 1;
      requestAbortRef.current?.abort();
      requestAbortRef.current = null;
    };
  }, [refresh, sceneId]);

  if (!sceneId) return { threads: [], closedHistory:[], loading: false, error: '', refresh,rememberClosed };
  if (state.requestKey !== requestKey) return { threads: [], closedHistory:[], loading: true, error: '', refresh,rememberClosed };
  return { ...state, refresh,rememberClosed };
}

function commentStatusLabel(status: ScriptCommentThread['status']) {
  if (status === 'AI_QUEUED') return '待AI处理';
  if (status === 'AI_PROCESSING') return 'AI处理中';
  if (status === 'RESOLVED') return '已关闭';
  return '旧评论待处理';
}

function readableDate(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(parsed);
}

export function SceneScriptCommentsPanel({
  target,
  snapshotId,
  selection,
  threads,
  loading,
  error,
  selectedCommentId,
  onSelectComment,
  onLocateComment,
  onReadClosedComment,
  onEditingCommentChange,
  onClearSelection,
  onRefresh,
}: {
  target: SceneCommentTarget;
  snapshotId: string;
  selection: SceneCommentAnchor | null;
  threads: ScriptCommentThread[];
  closedHistory?:ClosedCommentHistoryEntry[];
  loading: boolean;
  error: string;
  selectedCommentId: string | null;
  onSelectComment: (commentId: string | null) => void;
  onLocateComment: (commentId: string) => boolean;
  onReadClosedComment?: (thread:ScriptCommentThread)=>void;
  onEditingCommentChange: (commentId: string | null) => void;
  onClearSelection: () => void;
  onRefresh: () => void;
}) {
  const instance = useInstanceProfile();
  const { hostedReadOnly } = useRuntimeMode();
  const [commentText, setCommentText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [polishing, setPolishing] = useState(false);
  const [polishSuggestion, setPolishSuggestion] = useState<CommentPolishSuggestion | null>(null);
  const [prePolishText, setPrePolishText] = useState<string | null>(null);
  const [editingComment, setEditingComment] = useState<ScriptCommentThread | null>(null);
  const [message, setMessage] = useState('圈选左侧正文中的连续文字，可跨段落或对白添加一条评论。');
  const selectionIdentity = useMemo(() => JSON.stringify({
    snapshotId,
    sceneId: target.sceneId,
    sceneContentHash: target.sceneContentHash,
    businessContextHash: target.businessContextHash,
    anchor: sceneCommentSelectionIdentity(selection),
  }), [selection, snapshotId, target.businessContextHash, target.sceneContentHash, target.sceneId]);
  const editorAnchor = editingComment?.anchor || selection;
  const editorIdentity = useMemo(() => JSON.stringify({
    mode: editingComment ? 'EDIT' : 'CREATE',
    commentId: editingComment?.commentId || '',
    commentRevisionId: editingComment?.commentRevisionId || '',
    selection: sceneCommentSelectionIdentity(editorAnchor),
    snapshotId,
    sceneId: target.sceneId,
    sceneContentHash: target.sceneContentHash,
    businessContextHash: target.businessContextHash,
  }), [editingComment, editorAnchor, snapshotId, target.businessContextHash, target.sceneContentHash, target.sceneId]);
  const previousSelectionIdentityRef = useRef(selectionIdentity);
  const currentEditorIdentityRef = useRef(editorIdentity);
  const currentCommentTextRef = useRef(commentText);
  const polishAbortRef = useRef<AbortController | null>(null);
  const polishPreviewRef = useRef<HTMLElement | null>(null);
  const openThreads = useMemo(() => threads
    .filter((thread) => thread.status !== 'RESOLVED')
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)), [threads]);
  const openCount = threads.filter((item) => item.status !== 'RESOLVED').length;

  const cancelPolishRequest = useCallback(() => {
    polishAbortRef.current?.abort();
    polishAbortRef.current = null;
    setPolishing(false);
  }, []);

  useEffect(() => {
    currentEditorIdentityRef.current = editorIdentity;
    const timer = window.setTimeout(() => {
      cancelPolishRequest();
      setPolishSuggestion(null);
      setPrePolishText(null);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [cancelPolishRequest, editorIdentity]);

  useEffect(() => {
    if (previousSelectionIdentityRef.current === selectionIdentity) return;
    previousSelectionIdentityRef.current = selectionIdentity;
    if (editingComment) return;
    const timer = window.setTimeout(() => {
      cancelPolishRequest();
      currentCommentTextRef.current = '';
      setCommentText('');
      setPolishSuggestion(null);
      setPrePolishText(null);
      setMessage(selection
        ? '圈选范围已更新；请为当前范围填写修改意见。'
        : '圈选左侧正文中的连续文字，可跨段落或对白添加一条评论。');
    }, 0);
    return () => window.clearTimeout(timer);
  }, [cancelPolishRequest, editingComment, selection, selectionIdentity]);

  useEffect(() => () => {
    polishAbortRef.current?.abort();
    polishAbortRef.current = null;
  }, []);

  useEffect(() => {
    onEditingCommentChange(editingComment?.commentId || null);
    return () => onEditingCommentChange(null);
  }, [editingComment?.commentId, onEditingCommentChange]);

  useEffect(() => {
    if (!editingComment) return;
    const latest = threads.find((thread) => thread.commentId === editingComment.commentId);
    if (!latest || (latest.commentRevisionId === editingComment.commentRevisionId && latest.latestEventId === editingComment.latestEventId)) return;
    currentEditorIdentityRef.current = `STALE:${editingComment.commentId}:${editingComment.commentRevisionId}`;
    const timer = window.setTimeout(() => {
      cancelPolishRequest();
      setPolishSuggestion(null);
      setPrePolishText(null);
      setMessage('该评论在编辑期间已发生变化；当前草稿已保留，请取消编辑并重新打开后再提交。');
    }, 0);
    return () => window.clearTimeout(timer);
  }, [cancelPolishRequest, editingComment, threads]);

  useEffect(() => {
    if (!polishSuggestion) return;
    const frame = window.requestAnimationFrame(() => {
      const preview = polishPreviewRef.current;
      if (!preview) return;
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      preview.scrollIntoView({
        behavior: reduceMotion ? 'auto' : 'smooth',
        block: 'center',
        inline: 'nearest',
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [polishSuggestion]);

  function updateCommentText(value: string) {
    if (value !== currentCommentTextRef.current) {
      cancelPolishRequest();
      setPolishSuggestion(null);
    }
    currentCommentTextRef.current = value;
    setCommentText(value);
  }

  async function post(body: Record<string, unknown>) {
    const [etag, key] = await Promise.all([currentMutation(snapshotId), digest(JSON.stringify(body))]);
    const response = await fetch('/api/v1/workspaces/script-comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'If-Match': etag, 'Idempotency-Key': `script-comment-${key}` },
      body: JSON.stringify(body),
    });
    const payload = await response.json() as { commentId?: string; eventId?: string; error?: string };
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    window.dispatchEvent(new CustomEvent('review:operations-updated'));
    onRefresh();
    return payload;
  }

  async function createComment() {
    if (!selection || !commentText.trim() || hostedReadOnly || submitting || polishing) return;
    const commentId = `comment_${crypto.randomUUID()}`;
    try {
      setSubmitting(true);
      setMessage('正在保存评论…');
      await post({
        schemaVersion: '1.1', snapshotId, commentAction: 'CREATE', commentId,
        sceneId: target.sceneId, sceneContentHash: target.sceneContentHash,
        businessContextHash: target.businessContextHash, anchor: selection,
        commentText: commentText.trim(),
      });
      cancelPolishRequest();
      currentCommentTextRef.current = '';
      setCommentText('');
      setPolishSuggestion(null);
      setPrePolishText(null);
      onClearSelection();
      onSelectComment(commentId);
      setMessage('评论已保存并进入AI待处理队列。');
    } catch (reason) {
      setMessage(`评论保存失败：${reason instanceof Error ? reason.message : 'UNKNOWN'}`);
    } finally { setSubmitting(false); }
  }

  async function editComment() {
    if (!editingComment || !commentText.trim() || commentText.trim() === editingComment.commentText.trim() || hostedReadOnly || submitting || polishing) return;
    try {
      setSubmitting(true);
      setMessage('正在保存评论修改…');
      await post({
        schemaVersion: '1.1', snapshotId, commentAction: 'EDIT',
        commentId: editingComment.commentId,
        commentRevisionId: editingComment.commentRevisionId,
        sceneId: editingComment.sceneId,
        sceneContentHash: editingComment.sceneContentHash,
        businessContextHash: editingComment.businessContextHash,
        alignedSceneContentHash: target.sceneContentHash,
        commentText: commentText.trim(),
      });
      cancelPolishRequest();
      currentCommentTextRef.current = '';
      setCommentText('');
      setPolishSuggestion(null);
      setPrePolishText(null);
      setEditingComment(null);
      onSelectComment(editingComment.commentId);
      setMessage('评论已保存并重新进入AI待处理队列。');
    } catch (reason) {
      setMessage(`评论修改保存失败：${reason instanceof Error ? reason.message : 'UNKNOWN'}；草稿已保留。`);
    } finally { setSubmitting(false); }
  }

  async function polishComment() {
    const originalComment = commentText;
    const commentDraft = originalComment.trim();
    if (!editorAnchor || hostedReadOnly || submitting || polishing) return;
    cancelPolishRequest();
    const controller = new AbortController();
    polishAbortRef.current = controller;
    const requestEditorIdentity = editorIdentity;
    const expectedRequestMode = commentDraft ? 'POLISH_DRAFT' : 'SUGGEST_FROM_CONTEXT';
    try {
      setPolishing(true);
      setPolishSuggestion(null);
      setMessage(commentDraft
        ? '正在请求AI润色修改意见；原稿不会被自动覆盖…'
        : '正在请求AI根据故事原文和当前剧本生成修改建议…');
      const body = {
        schemaVersion: '1.1', snapshotId, sceneId: target.sceneId,
        sceneContentHash: target.sceneContentHash,
        businessContextHash: target.businessContextHash,
        anchor: editorAnchor,
        commentDraft,
      };
      const key = crypto.randomUUID();
      if (controller.signal.aborted
        || currentEditorIdentityRef.current !== requestEditorIdentity
        || currentCommentTextRef.current !== originalComment) return;
      const payload = await requestCommentPolish(body,`comment-polish-${key}`,controller.signal);
      if (payload.snapshotId !== snapshotId
        || payload.sceneId !== target.sceneId
        || payload.sceneContentHash !== target.sceneContentHash
        || payload.businessContextHash !== target.businessContextHash) {
        throw new Error('AI润色结果与当前场次绑定不一致，请勿采用');
      }
      if (payload.requestMode && payload.requestMode !== expectedRequestMode) {
        throw new Error('AI建议模式与当前草稿不一致，请勿采用');
      }
      const polishedComment = payload.polishedComment?.trim() || '';
      if (!polishedComment) throw new Error('AI润色服务没有返回可用建议');
      if (controller.signal.aborted
        || currentEditorIdentityRef.current !== requestEditorIdentity
        || currentCommentTextRef.current !== originalComment) return;
      setPolishSuggestion({
        polishedComment,
        originalComment,
        requestMode: payload.requestMode || expectedRequestMode,
        model: payload.model || 'AI',
        directBeatCount: payload.sourceContext?.directBeatCount || 0,
        relatedBeatCount: payload.sourceContext?.relatedBeatCount || 0,
      });
      setMessage(`${expectedRequestMode === 'SUGGEST_FROM_CONTEXT' ? 'AI修改建议' : 'AI润色建议'}已返回但尚未保存；请先审阅，再决定是否采用。`);
    } catch (reason) {
      if ((reason as { name?: string }).name === 'AbortError' || controller.signal.aborted) return;
      setMessage(`AI润色失败：${reason instanceof Error ? reason.message : 'UNKNOWN'}。原稿已保留，本次不会自动重试。`);
    } finally {
      if (polishAbortRef.current === controller) {
        polishAbortRef.current = null;
        setPolishing(false);
      }
    }
  }

  function adoptPolishSuggestion() {
    if (!polishSuggestion) return;
    setPrePolishText(polishSuggestion.originalComment);
    currentCommentTextRef.current = polishSuggestion.polishedComment;
    setCommentText(polishSuggestion.polishedComment);
    setPolishSuggestion(null);
    setMessage(`已将AI建议填入修改意见；你仍可编辑或恢复原稿，只有点击“${editingComment ? '保存修改' : '添加评论'}”才会写入事件。`);
  }

  function keepOriginalComment() {
    setPolishSuggestion(null);
    setMessage('已保留当前草稿；AI建议未保存，也没有写入任何评论事件。');
  }

  function restorePrePolishText() {
    if (prePolishText == null) return;
    currentCommentTextRef.current = prePolishText;
    setCommentText(prePolishText);
    setPrePolishText(null);
    setPolishSuggestion(null);
    setMessage('已恢复AI建议前的草稿；尚未保存评论。');
  }

  function clearCommentSelection() {
    cancelPolishRequest();
    currentCommentTextRef.current = '';
    setCommentText('');
    setPolishSuggestion(null);
    setPrePolishText(null);
    onClearSelection();
  }

  function startEditingComment(thread: ScriptCommentThread) {
    if (hostedReadOnly || submitting || polishing) return;
    if (selection) {
      setMessage('请先保存或取消当前圈选的新评论，再编辑已有评论。');
      return;
    }
    if (!thread.anchorMatchesCurrentText) {
      onSelectComment(thread.commentId);
      setMessage('当前正文中已无法精确定位原圈选内容；为避免错绑，该评论暂不能编辑。');
      return;
    }
    cancelPolishRequest();
    setEditingComment(thread);
    currentCommentTextRef.current = thread.commentText;
    setCommentText(thread.commentText);
    setPolishSuggestion(null);
    setPrePolishText(null);
    onSelectComment(thread.commentId);
    onLocateComment(thread.commentId);
    setMessage('正在编辑评论；原圈选范围已固定，保存后将重新进入AI待处理队列。');
    window.setTimeout(() => document.getElementById(`scene-comment-editor-${thread.commentId}`)?.focus(), 0);
  }

  function cancelEditingComment() {
    cancelPolishRequest();
    currentCommentTextRef.current = '';
    setCommentText('');
    setPolishSuggestion(null);
    setPrePolishText(null);
    setEditingComment(null);
    setMessage('已取消编辑，未写入任何评论事件。');
  }

  async function closeComment(thread: ScriptCommentThread) {
    if (hostedReadOnly || submitting) return;
    try {
      setSubmitting(true);
      onSelectComment(null);
      setMessage('正在关闭评论…');
      await post({
        schemaVersion: '1.1', snapshotId, commentAction: 'RESOLVE_USER', commentId: thread.commentId,
        commentRevisionId: thread.commentRevisionId,
        sceneId: thread.sceneId, sceneContentHash: thread.sceneContentHash,
        businessContextHash: thread.businessContextHash,
        alignedSceneContentHash: target.sceneContentHash,
        resolutionNote: '用户确认该评论已处理。',
      });
      setMessage('评论已对齐当前正文并关闭。');
    } catch (reason) {
      setMessage(`评论操作失败：${reason instanceof Error ? reason.message : 'UNKNOWN'}`);
    } finally { setSubmitting(false); }
  }

  function focusAnchor(thread: ScriptCommentThread) {
    if (editingComment && editingComment.commentId !== thread.commentId) {
      onSelectComment(editingComment.commentId);
      onLocateComment(editingComment.commentId);
      setMessage('正在编辑另一条评论；请先保存或取消编辑，再切换评论。');
      return;
    }
    onSelectComment(thread.commentId);
    const located = thread.anchorMatchesCurrentText && onLocateComment(thread.commentId);
    if (!located) {
      setMessage('当前正文中已无法精确定位原圈选内容；不会尝试模糊匹配。');
      return;
    }
    setMessage(thread.applicabilityState === 'STALE'
      ? '原业务上下文已变化；原圈选内容仍与当前正文精确匹配。'
      : '已在左侧正文中高亮并定位该评论的原圈选内容。');
  }

  const assistantCommentEditable = Boolean(editorAnchor && !hostedReadOnly && !submitting && !polishing
    && (!editingComment || threads.some((thread) => thread.commentId === editingComment.commentId
      && thread.commentRevisionId === editingComment.commentRevisionId && thread.latestEventId === editingComment.latestEventId
      && thread.status !== 'RESOLVED' && thread.anchorMatchesCurrentText)));
  useAssistantFocus(editorAnchor ? {
    projectId: instance.projectId, snapshotId, view: 'audit', subjectType: 'SCENE',
    subjectId: target.sceneId, title: `场级拆解 · ${target.sceneId} · 圈选评论`, versionId: target.sceneContentHash,
    selection: { ...editorAnchor }, references: [`business-context:${target.businessContextHash}`],
  } : null, 20);
  const assistantCommentAnchorIdentity = editorAnchor ? JSON.stringify(sceneCommentAnchorSegments(editorAnchor)
    .map((segment) => [segment.blockId, segment.startOffset, segment.endOffset])) : 'NO_SELECTION';
  const assistantDrafts = useProjectAssistantDraftTargets({
    identity: `comment:${snapshotId}:${target.sceneId}:${target.sceneContentHash}:${target.businessContextHash}:${editingComment?.commentRevisionId || 'NEW'}:${assistantCommentAnchorIdentity}`,
    subjectId: target.sceneId, versionId: target.sceneContentHash,
    fields: editorAnchor ? [{ fieldId: 'comment', label: `${target.sceneId} · 圈选正文修改意见`, value: commentText }] : [],
    canAdopt: assistantCommentEditable,
    disabledReason: '当前圈选或评论修订已变化，或正在提交；建议仍可复制。',
    applyField: (_fieldId, nextValue) => updateCommentText(nextValue),
  });

  function renderEditor(mode: 'CREATE' | 'EDIT') {
    const anchor = mode === 'EDIT' ? editingComment?.anchor || null : selection;
    if (!anchor) return null;
    const emptyDraft = !commentText.trim();
    const unchangedEdit = mode === 'EDIT' && commentText.trim() === editingComment?.commentText.trim();
    const aiActionLabel = emptyDraft ? 'AI生成修改建议' : 'AI润色修改意见';
    const saveActionLabel = mode === 'EDIT' ? '保存修改' : '添加评论';
    return <section className={`scene-comment-composer ${mode === 'EDIT' ? 'is-editing' : ''}`} aria-label={mode === 'EDIT' ? '编辑评论' : '为圈选正文添加评论'} aria-busy={polishing}>
      <small>{mode === 'EDIT' ? '固定原圈选' : '已圈选'}{sceneCommentAnchorSegments(anchor).length > 1 ? ` ${sceneCommentAnchorSegments(anchor).length}个正文块` : ''} · {anchor.sourceLineStart ? `母本源行${anchor.sourceLineStart}${anchor.sourceLineEnd && anchor.sourceLineEnd !== anchor.sourceLineStart ? `–${anchor.sourceLineEnd}` : ''}` : anchor.blockId}</small>
      <blockquote>{anchor.quote}</blockquote>
      <label><span>修改意见</span><textarea id={mode === 'EDIT' && editingComment ? `scene-comment-editor-${editingComment.commentId}` : undefined} autoFocus value={commentText} maxLength={20_000} onFocus={() => assistantDrafts.activateField('comment')} onChange={(event) => updateCommentText(event.target.value)} placeholder="可直接填写修改意见，也可留空后交由AI根据故事原文和当前剧本生成建议…" /></label>
      <small className="scene-comment-notice">点击AI功能会将当前草稿、固定圈选、本场正文、对应原文证据和关联上下文发送给OpenAI API；草稿留空时，AI会直接生成修改建议。建议不会自动写入评论或修改剧本。为防重复调用，同一输入不会自动重试；返回建议仅在本机幂等卷暂存10分钟用于断线回放，随后抹除正文。
      </small>
      <button type="button" disabled={hostedReadOnly || !assistantDrafts.hasTargets} onClick={assistantDrafts.askAboutActiveDraft}>结合这条意见问助手</button>
      {polishSuggestion && <section ref={polishPreviewRef} className="scene-comment-notice scene-comment-polish-preview" role="region" aria-label="AI修改建议" aria-live="polite" aria-atomic="true">
        <header><b>{polishSuggestion.requestMode === 'SUGGEST_FROM_CONTEXT' ? 'AI修改建议' : 'AI润色建议'} · 尚未保存</b><br /><small>{polishSuggestion.model} · 参考{polishSuggestion.directBeatCount}条直接原文、{polishSuggestion.relatedBeatCount}条关联上下文</small></header>
        <p>{polishSuggestion.polishedComment}</p>
        <div><button type="button" onClick={adoptPolishSuggestion}>采用润色</button>{' '}<button type="button" onClick={keepOriginalComment}>保留原稿</button></div>
      </section>}
      <div><button type="button" disabled={emptyDraft || unchangedEdit || hostedReadOnly || submitting || polishing} onClick={mode === 'EDIT' ? () => { void editComment(); } : () => { void createComment(); }}>{submitting ? '保存中…' : saveActionLabel}</button><button type="button" aria-label={aiActionLabel} title={hostedReadOnly ? '远端只读镜像不可调用AI' : undefined} disabled={hostedReadOnly || submitting || polishing} onClick={() => void polishComment()}>{polishing ? (emptyDraft ? 'AI生成中…' : 'AI润色中…') : aiActionLabel}</button>{prePolishText != null && <button type="button" disabled={submitting || polishing} onClick={restorePrePolishText}>恢复AI建议前</button>}<button type="button" disabled={submitting || polishing} onClick={mode === 'EDIT' ? cancelEditingComment : clearCommentSelection}>{mode === 'EDIT' ? '取消编辑' : '取消圈选'}</button></div>
    </section>;
  }

  return <section id={`scene-script-comments-${target.sceneId}`} className="scene-script-comments" aria-labelledby={`scene-script-comments-title-${target.sceneId}`}>
    <header><div><small>ANCHORED REVIEW COMMENTS</small><h3 id={`scene-script-comments-title-${target.sceneId}`}>正文评论</h3><p>可对连续多个段落添加一条修改意见；新评论默认进入AI待处理队列，不替代正式结论。</p></div><span>{openCount}未关闭</span></header>
    {hostedReadOnly && <p className="scene-comment-notice">远端是只读镜像；请在本地审阅台新增、编辑或关闭评论。</p>}
    {selection && !editingComment && renderEditor('CREATE')}
    {!selection && !editingComment && <p className="scene-comment-selection-help">在左侧正文中拖选连续文字，支持跨段落与对白；修改意见会作为一条评论绑定完整范围。也可以不填人工意见，直接交由AI生成建议。</p>}
    <div className="scene-comment-list" aria-live="polite">
      {loading && <p>正在读取本场评论…</p>}
      {error && <p role="alert">评论暂时无法读取：{error}</p>}
      {!loading && !error && !threads.length && <p>本场还没有评论。</p>}
      {openThreads.map((thread) => <article key={thread.commentId} className={selectedCommentId === thread.commentId ? 'is-selected' : ''} data-comment-status={thread.status} data-comment-id={thread.commentId}>
        <button type="button" className="scene-comment-anchor-link" aria-label={`定位评论：${thread.anchor.quote.slice(0, 80)}`} aria-pressed={selectedCommentId === thread.commentId} onClick={() => focusAnchor(thread)}>
          <span>{commentStatusLabel(thread.status)} · {readableDate(thread.updatedAt)}</span>
          <q>{thread.anchor.quote}</q>
          <span className="scene-comment-text">{thread.commentText}</span>
        </button>
        <div className="scene-comment-actions"><button type="button" className="scene-comment-edit" aria-label="编辑评论" title={!thread.anchorMatchesCurrentText ? '原圈选内容无法在当前正文中精确定位' : '编辑评论'} disabled={hostedReadOnly || submitting || polishing || Boolean(editingComment) || !thread.anchorMatchesCurrentText} onClick={() => startEditingComment(thread)}>编辑</button><button type="button" className="scene-comment-close" aria-label="关闭评论" title="关闭评论" disabled={hostedReadOnly || submitting || polishing || Boolean(editingComment)} onClick={() => void closeComment(thread)}>×</button></div>
        {editingComment?.commentId === thread.commentId && renderEditor('EDIT')}
        {thread.applicabilityState === 'STALE' && <small className="scene-comment-stale">{thread.anchorMatchesCurrentText ? '原业务上下文已变化；原圈选内容仍与当前正文精确匹配。' : '原业务上下文已变化；当前正文中已无法精确定位原圈选内容。'}</small>}
        {thread.applicabilityState !== 'STALE' && !thread.anchorMatchesCurrentText && <small className="scene-comment-stale">当前正文中已无法精确定位原圈选内容。</small>}
      </article>)}

    </div>
    {!loading&&!error&&<PaginatedClosedCommentHistory<ScriptCommentThread> key={target.sceneId} endpoint={`/api/v1/workspaces/script-comments?sceneId=${encodeURIComponent(target.sceneId)}`} onThreadRead={onReadClosedComment} renderActions={thread=><button type="button" disabled={!thread.anchorMatchesCurrentText} onClick={()=>focusAnchor(thread)}>定位原圈选</button>}/>}
    <footer><p role="status">{message}</p></footer>
  </section>;
}
