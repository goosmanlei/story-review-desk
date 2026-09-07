import { resolveEpisodePlan } from '../../_episode-plan';
import { operationalSnapshot } from '../../_store';
import { createHash } from 'node:crypto';
import { sceneCommentBlocks } from '../../script-comments/_context';
import { errorResponse, HttpError, jsonResponse, reviewData, storyConfirmationTargets, type ReviewData } from '../../_store';

type StoryEvidence = {
  ref: string;
  sourceKind?: string;
  displayFormat?: 'MARKDOWN' | 'JSON';
  sourceTitle?: string;
  sourcePath?: string;
  sourceSha256?: string;
  locator?: string;
  excerpt?: string;
  excerptSha256?: string;
  readingContext?: {
    locator?: string;
    lineStart?: number;
    lineEnd?: number;
    excerpt?: string;
    excerptSha256?: string;
  } | null;
  sceneIds?: string[];
  episodeIds?: string[];
  reviewUse?: string;
  transcriptSegments?: Array<{
    beatId: string;
    sourcePath: string;
    sourceSha256: string;
    sourceHashScope: 'FULL_SOURCE_FILE';
    sourceLineStart: number;
    sourceLineEnd: number;
    timecodeStart: string;
    text: string;
    textSha256: string;
    textHashScope: 'NORMALIZED_TRANSCRIPT_SEGMENT_TEXT_WITHOUT_TIMESTAMP_MARKER';
  }>;
  creatorContext?: {
    beats?: Record<string, { audioQuestion?: string; currentSafeRendering?: string }>;
    scenes?: Record<string, {
      sceneSummary?: string;
      auditFocus?: string;
      revisionNote?: string;
      audioQuestions?: Array<{ question?: string; currentSafeRendering?: string }>;
    }>;
  };
  internalTarget?: {
    storyView?: string;
    sceneId?: string | null;
    episodeId?: string | null;
    episodeUid?: string | null;
    canonicalScopeId?: string | null;
    scopeType?: string | null;
    scopeId?: string | null;
    anchorId?: string | null;
    causeChainId?: string | null;
    structureSection?: 'overview' | 'spine' | 'characters' | 'truth-route' | 'audience' | 'space' | null;
  } | null;
};

type ProductionEvidence = {
  ref: string;
  sourceKind?: string;
  displayFormat?: 'MARKDOWN' | 'JSON';
  title?: string;
  path?: string;
  sourceSha256?: string;
  locator?: string;
  excerpt?: string;
  excerptSha256?: string;
};

export function internalLink(
  target: StoryEvidence['internalTarget'],
  episodes: Array<{ id?: string; displayId?: string; episodeUid?: string; canonicalScopeId?: string }>,
  currentEpisodePlan: boolean,
) {
  if (!target) return { internalHref: null, internalLabel: null, internalNote: null };
  const stableTargetIdentities = [
    target.episodeUid,
    target.canonicalScopeId,
    target.scopeType === 'EPISODE' ? target.scopeId : null,
  ].filter((value): value is string => typeof value === 'string' && Boolean(value));
  const episode = currentEpisodePlan
    ? episodes.find((item) => stableTargetIdentities.some((identity) => (
        identity === item.episodeUid || identity === item.canonicalScopeId
      ))) || null
    : null;
  const episodeScopeId = currentEpisodePlan
    ? episode?.canonicalScopeId || episode?.episodeUid || null
    : target.episodeId || null;
  const rejectedEpisodeIdentity = target.episodeId || stableTargetIdentities[0];
  const internalNote = currentEpisodePlan && rejectedEpisodeIdentity && !episodeScopeId
    ? `历史分集位置 ${rejectedEpisodeIdentity} 仅作证据；该记录未绑定当前episodeUid，已禁止跳转到当前同号分集。`
    : null;
  const episodeDisplay = currentEpisodePlan && episode && episodeScopeId
    ? `&episodeDisplay=${encodeURIComponent(episode.displayId || episode.id || '')}`
    : '';
  if ((target.storyView === 'audit' || target.storyView === 'script') && target.sceneId) {
    const anchor = target.anchorId ? `&readerAnchor=${encodeURIComponent(target.anchorId)}` : '';
    return { internalHref: `?view=story&storyMode=audit&confirmScene=${encodeURIComponent(target.sceneId)}&scene=${encodeURIComponent(target.sceneId)}${anchor}`, internalLabel: '在场级拆解精确定位', internalNote };
  }
  if (target.storyView === 'episodes' && episodeScopeId) {
    return { internalHref: `?view=story&storyMode=logic&episode=${encodeURIComponent(episodeScopeId)}${episodeDisplay}&logicGroup=opening-boundary&logicItem=incoming-handoff`, internalLabel: '在叙事拆解查看本集', internalNote };
  }
  if (target.storyView === 'story-structure' || target.storyView === 'case') {
    const section = target.storyView === 'case'
      ? 'truth-route'
      : target.structureSection || 'overview';
    return { internalHref: `?view=story&storyMode=story-structure&structureSection=${section}`, internalLabel: '在故事结构查看全局关系', internalNote };
  }
  if (['timeline', 'structure'].includes(String(target.storyView || '')) && !target.sceneId && !episodeScopeId) {
    return { internalHref: '?view=story&storyMode=story-structure&structureSection=spine', internalLabel: '在故事结构查看故事骨架', internalNote };
  }
  if (['timeline', 'structure'].includes(String(target.storyView || ''))) {
    const scene = target.sceneId ? `&scene=${encodeURIComponent(target.sceneId)}` : '';
    const episodeParam = episodeScopeId ? `&episode=${encodeURIComponent(episodeScopeId)}${episodeDisplay}` : '';
    return { internalHref: `?view=story&storyMode=logic${scene}${episodeParam}&logicGroup=escalation-turn&logicItem=key-turns`, internalLabel: '在叙事拆解查看本集转折', internalNote };
  }
  if (['logic', 'cause'].includes(String(target.storyView || ''))) {
    const scene = target.sceneId ? `&scene=${encodeURIComponent(target.sceneId)}` : '';
    const episodeParam = episodeScopeId ? `&episode=${encodeURIComponent(episodeScopeId)}${episodeDisplay}` : '';
    const anchor = target.anchorId ? `&readerAnchor=${encodeURIComponent(target.anchorId)}` : '';
    const causeChain = target.storyView === 'cause' && target.causeChainId
      ? `&causeChain=${encodeURIComponent(target.causeChainId)}`
      : '';
    const item = target.storyView === 'cause'
      ? '&logicGroup=information-causality&logicItem=causal-chains'
      : '';
    return { internalHref: `?view=story&storyMode=logic${scene}${episodeParam}${anchor}${item}${causeChain}`, internalLabel: '在叙事拆解查看位置', internalNote };
  }
  return { internalHref: null, internalLabel: internalNote, internalNote };
}

export async function GET(request: Request) {
  try {
    const ref = new URL(request.url).searchParams.get('ref')?.trim() ?? '';
    if (!ref || ref.length > 2000) throw new HttpError(400, 'ref is invalid');
    const data = await reviewData() as unknown as {
      schemaVersion: string;
      snapshotId: string;
      creativeLineage?: {
        episodes?: Array<{ id?: string; displayId?: string; episodeUid?: string; canonicalScopeId?: string }>;
        storyStructure?: { planStatus?: string; evidenceCatalog?: Record<string, StoryEvidence> };
      };
      productionModel?: { reviewContextCatalog?: { evidenceCatalog?: Record<string, ProductionEvidence> } };
    };
    let story = data.creativeLineage?.storyStructure?.evidenceCatalog?.[ref];
    // Resolve only an exact current screenplay alias plus a canonical scene.
    // This does not read arbitrary paths or invent evidence for unknown references.
    if (!story) {
      const source = data as unknown as ReviewData;
      const target = storyConfirmationTargets(source).find((item) => item.scriptPath && ref === `${item.scriptPath}#${item.sceneId}`);
      if (target) {
        const revision = source.productionModel.sceneScriptRevisions?.find((item) => item.sceneId === target.sceneId && item.scopeRole === 'CURRENT' && item.isCurrent === true);
        if (!revision || revision.sourceSha256 !== target.scriptSha256 || ![revision.revisionHash,revision.contentHash].includes(target.sceneContentHash)) throw new HttpError(409, '当前场正文依据绑定不一致');
        const blocks = sceneCommentBlocks(source, target.sceneId);
        const excerpt = blocks.map((block) => `${block.speaker ? `【${block.speaker}】` : ''}${block.performanceNote ? `（${block.performanceNote}）` : ''}${block.text || ''}`).join('\n\n');
        if (!excerpt.trim()) throw new HttpError(404, '当前场没有可读取正文');
        story = { ref, sourceKind: 'SCREENPLAY', displayFormat: 'MARKDOWN', sourceTitle: `${target.sceneId} · 当前剧本正文`, sourcePath: target.scriptPath, sourceSha256: target.scriptSha256, locator: target.sceneId, excerpt, excerptSha256: createHash('sha256').update(excerpt).digest('hex'), sceneIds: [target.sceneId], reviewUse: '当前已发布快照中的场正文；用于判断本集设计与实际剧情是否一致。', internalTarget: {storyView:'audit',sceneId:target.sceneId} };
      }
    }
    if (!story && ref.startsWith('NARRATIVE:')) {
      const plan = resolveEpisodePlan(data as unknown as ReviewData, await operationalSnapshot());
      const scene = plan?.content.narrativeRevision?.scenes.find((scene) => ref === `NARRATIVE:${scene.id}:${scene.contentHash}`);
      if (!scene || !plan) throw new HttpError(409, '指定候选正文依据不可用，请读取最新方案');
      const excerpt = scene.scriptBlocks.map((block) => `${block.speaker ? `【${block.speaker}】` : ''}${block.performanceNote ? `（${block.performanceNote}）` : ''}${block.text}`).join('\n\n');
      story = { ref, sourceKind: 'SCREENPLAY', displayFormat: 'MARKDOWN', sourceTitle: `${scene.displayId} ${scene.title} · 待审稿`, sourcePath: '完整叙事候选', sourceSha256: scene.contentHash,
        locator: scene.displayId, excerpt, excerptSha256: createHash('sha256').update(excerpt).digest('hex'), sceneIds: [scene.id], reviewUse: `与当前完整分集候选精确绑定的完整场正文；尚未采用。${scene.purpose}`, internalTarget: {storyView:'audit',sceneId:scene.id} };
    }
    const production = data.productionModel?.reviewContextCatalog?.evidenceCatalog?.[ref];
    if (!story && !production) throw new HttpError(404, 'evidence is not present in the current snapshot', { ref });
    const links = internalLink(
      story?.internalTarget,
      data.creativeLineage?.episodes || [],
      data.creativeLineage?.storyStructure?.planStatus === 'CURRENT',
    );
    const record = story ? {
      ref: story.ref,
      sourceKind: story.sourceKind ?? 'SOURCE',
      displayFormat: story.displayFormat ?? 'MARKDOWN',
      title: story.sourceTitle ?? story.ref,
      path: story.sourcePath ?? story.ref,
      locator: story.locator ?? '',
      excerpt: story.excerpt ?? '',
      sourceSha256: story.sourceSha256 ?? '',
      excerptSha256: story.excerptSha256 ?? '',
      readingContext: story.readingContext ? {
        locator: story.readingContext.locator ?? '',
        lineStart: story.readingContext.lineStart ?? 0,
        lineEnd: story.readingContext.lineEnd ?? 0,
        excerpt: story.readingContext.excerpt ?? '',
        excerptSha256: story.readingContext.excerptSha256 ?? '',
      } : null,
      reviewUse: [story.reviewUse ?? '', links.internalNote].filter(Boolean).join('；'),
      sceneIds: story.sceneIds ?? [],
      episodeIds: story.episodeIds ?? [],
      transcriptSegments: story.transcriptSegments ?? [],
      creatorContext: story.creatorContext,
      ...links,
    } : {
      ref: production!.ref,
      sourceKind: production!.sourceKind ?? 'SOURCE',
      displayFormat: production!.displayFormat ?? 'MARKDOWN',
      title: production!.title ?? production!.ref,
      path: production!.path ?? production!.ref,
      locator: production!.locator ?? '',
      excerpt: production!.excerpt ?? '',
      sourceSha256: production!.sourceSha256 ?? '',
      excerptSha256: production!.excerptSha256 ?? '',
      readingContext: null,
      reviewUse: '以下为当前审阅上下文直接引用的源片段；显示依据不改变其F／L／A／U等级。',
      sceneIds: [],
      episodeIds: [],
      internalHref: null,
      internalLabel: null,
    };
    return jsonResponse({ schemaVersion: data.schemaVersion, snapshotId: data.snapshotId, data: record });
  } catch (reason) {
    return errorResponse(reason, 'evidence lookup failed');
  }
}
