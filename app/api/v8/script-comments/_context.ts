import { createHash } from 'node:crypto';
import {
  assertStableId,
  assertString,
  HttpError,
  sceneReviewDossierTargets,
  stableObjectHash,
  storyConfirmationTargets,
  type ReviewData,
} from '../_store';

const maxAnchorQuoteLength = 20_000;
const maxAnchorSegments = 500;
const maxDirectSourceCharacters = 12_000;
const maxRelatedSummaryCharacters = 4_000;

export type ScriptBlock = {
  id?: string;
  type?: string;
  text?: string;
  speaker?: string;
  performanceNote?: string | null;
  sourceLineStart?: number;
  sourceLineEnd?: number;
};

type TranscriptSegment = {
  id?: string;
  timecode?: string;
  text?: string;
  contentSha256?: string;
};

type AdaptationBeat = {
  beat_id?: string;
  summary?: string;
  authority?: string;
  asr_status?: string;
  source?: {
    timecode_start?: string;
    timecode_end?: string;
    content_sha256?: string;
  };
};

function trustedSha256(value: unknown, name: string) {
  const result = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^[a-f0-9]{64}$/.test(result)) {
    throw new HttpError(503, `${name} is unavailable or is not a complete SHA-256`);
  }
  return result;
}

function verifiedTranscriptSha256(data: ReviewData) {
  const transcriptSha256 = trustedSha256(data.storySources?.transcript?.sha256, 'the current transcript hash');
  const sourceSha256 = trustedSha256(data.sourceHashes?.transcriptSha256, 'the current transcript source hash');
  if (transcriptSha256 !== sourceSha256) {
    throw new HttpError(503, 'the current transcript failed its source hash check');
  }
  return transcriptSha256;
}

function verifiedDossierHash(data: ReviewData, sceneId: string) {
  const matches = (data.actionQueueInputs?.sceneReviewDossiers || []).filter((item) => (
    item && typeof item === 'object' && !Array.isArray(item) && String(item.sceneId || '') === sceneId
  ));
  if (matches.length !== 1) {
    throw new HttpError(503, 'the current scene review dossier is unavailable or ambiguous');
  }
  const rawDossier = matches[0] as Record<string, unknown>;
  const dossierHash = trustedSha256(rawDossier.dossierHash, 'the current scene review dossier hash');
  const hashPayload = Object.fromEntries(
    Object.entries(rawDossier).filter(([key, value]) => key !== 'dossierHash' && value !== undefined),
  );
  if (stableObjectHash(hashPayload) !== dossierHash) {
    throw new HttpError(503, 'the current scene review dossier failed its content hash check');
  }
  return dossierHash;
}

export function currentSceneCommentTarget(data: ReviewData, sceneId: string) {
  const target = storyConfirmationTargets(data).find((item) => String(item.sceneId || '') === sceneId);
  if (!target) throw new HttpError(422, 'sceneId is not a current script-scene comment target');
  return target;
}

export function sceneCommentBlocks(data: ReviewData, sceneId: string) {
  const scene = data.creativeLineage?.scenes?.find((item) => String(item.id || '') === sceneId);
  return Array.isArray(scene?.scriptBlocks) ? scene.scriptBlocks as ScriptBlock[] : [];
}

function integerOffset(value: unknown, name: string, max: number) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < 0 || result > max) throw new HttpError(400, `${name} is invalid`);
  return result;
}

function parseAnchorSegment(blocks: ScriptBlock[], value: unknown, index: number) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, `anchor.segments.${index} is invalid`);
  const raw = value as Record<string, unknown>;
  const blockId = assertStableId(raw.blockId, `anchor.segments.${index}.blockId`);
  const block = blocks.find(item => item.id === blockId);
  if (!block || typeof block.text !== 'string') throw new HttpError(422, '圈选文字块已不可用');
  const text = block.text || '';
  const startOffset = integerOffset(raw.startOffset, `anchor.segments.${index}.startOffset`, text.length);
  const endOffset = integerOffset(raw.endOffset, `anchor.segments.${index}.endOffset`, text.length);
  if (endOffset <= startOffset) throw new HttpError(422, 'comment anchor segments must select non-empty text ranges');
  assertString(raw.quote, `anchor.segments.${index}.quote`, maxAnchorQuoteLength);
  const quote = raw.quote as string;
  if (text.slice(startOffset, endOffset) !== quote) {
    throw new HttpError(409, 'comment anchor no longer matches the current scene text; select the passage again');
  }
  return {
    blockId,
    startOffset,
    endOffset,
    quote,
    sourceLineStart: Number(block.sourceLineStart || 0),
    sourceLineEnd: Number(block.sourceLineEnd || block.sourceLineStart || 0),
    blockTextLength: text.length,
  };
}

export function parseSceneCommentAnchor(data: ReviewData, sceneId: string, value: unknown) {
  return parseCommentAnchorBlocks(sceneCommentBlocks(data, sceneId), value);
}

export function parseCommentAnchorBlocks(blocks: ScriptBlock[], value: unknown, {allowFieldSelection=false}: {allowFieldSelection?:boolean} = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'anchor is invalid');
  const raw = value as Record<string, unknown>;
  const rawSegments = raw.segments;
  if (rawSegments != null && (!Array.isArray(rawSegments) || !rawSegments.length || rawSegments.length > maxAnchorSegments)) {
    throw new HttpError(400, 'anchor.segments is invalid');
  }
  const segments = Array.isArray(rawSegments)
    ? rawSegments.map((segment, index) => parseAnchorSegment(blocks, segment, index))
    : [parseAnchorSegment(blocks, raw, 0)];
  const blockPositions = new Map(blocks.map((block, index) => [String(block.id || ''), index]));
  const positions = segments.map((segment) => blockPositions.get(segment.blockId) ?? -1);
  if (new Set(positions).size!==positions.length) throw new HttpError(422,'同一文字块不能在圈选中重复出现');
  if (positions.some((position) => position < 0) || !allowFieldSelection && positions.some((position, index) => index > 0 && position !== positions[index - 1] + 1)) {
    throw new HttpError(422, 'comment anchor segments must cover one continuous block range in scene order');
  }
  if (segments.length > 1) {
    if (segments[0].endOffset !== segments[0].blockTextLength || segments.at(-1)?.startOffset !== 0) {
      throw new HttpError(422, 'a cross-block comment must include the complete boundary between its first and last blocks');
    }
    if (segments.slice(1, -1).some((segment) => segment.startOffset !== 0 || segment.endOffset !== segment.blockTextLength)) {
      throw new HttpError(422, 'a cross-block comment cannot skip text inside intermediate blocks');
    }
  }
  const quote = segments.map((segment) => segment.quote).join('\n\n');
  if (quote.length > maxAnchorQuoteLength || (assertString(raw.quote, 'anchor.quote', maxAnchorQuoteLength), raw.quote) !== quote) {
    throw new HttpError(409, 'comment anchor quote does not match its continuous scene range');
  }
  const first = segments[0];
  const last = segments[segments.length - 1];
  const firstBlock = blocks.find(b => b.id === first.blockId)!;
  const lastBlock = blocks.find(b => b.id === last.blockId)!;
  const prefix = (firstBlock.text || '').slice(Math.max(0, first.startOffset - 48), first.startOffset);
  const suffix = (lastBlock.text || '').slice(last.endOffset, Math.min((lastBlock.text || '').length, last.endOffset + 48));
  const sourceLineStart = first.sourceLineStart;
  const sourceLineEnd = last.sourceLineEnd;
  const canonicalSegments = segments.map((segment) => ({
    blockId: segment.blockId,
    startOffset: segment.startOffset,
    endOffset: segment.endOffset,
    quote: segment.quote,
    sourceLineStart: segment.sourceLineStart,
    sourceLineEnd: segment.sourceLineEnd,
  }));
  const anchorHashPayload = {
    blockId: first.blockId,
    startOffset: first.startOffset,
    endOffset: first.endOffset,
    endBlockId: last.blockId,
    endBlockOffset: last.endOffset,
    quote,
    prefix,
    suffix,
    sourceLineStart,
    sourceLineEnd,
    segments: canonicalSegments,
  };
  const anchorHash = createHash('sha256').update(JSON.stringify(anchorHashPayload)).digest('hex');
  return { ...anchorHashPayload, anchorHash };
}

function scriptBlockText(block: ScriptBlock) {
  const text = String(block.text || '').trim();
  if (!text) return '';
  const speaker = String(block.speaker || '').trim();
  const performanceNote = String(block.performanceNote || '').trim();
  if (block.type === 'dialogue' && speaker) {
    return performanceNote ? `【${speaker}】（${performanceNote}）${text}` : `【${speaker}】${text}`;
  }
  if (performanceNote) return `【表演提示】${performanceNote}\n${text}`;
  return text;
}

export function buildSceneCommentPolishContext(
  data: ReviewData,
  sceneId: string,
  anchor: ReturnType<typeof parseSceneCommentAnchor>,
) {
  const dossier = sceneReviewDossierTargets(data).find((item) => item.sceneId === sceneId);
  if (!dossier) throw new HttpError(503, 'the current scene review dossier is unavailable');
  const dossierHash = verifiedDossierHash(data, sceneId);
  const transcriptSha256 = verifiedTranscriptSha256(data);

  const rawData = data as unknown as {
    adaptationAudit?: { beats?: AdaptationBeat[] };
    storySources?: { transcript?: { segments?: TranscriptSegment[]; sha256?: string } };
    creativeLineage?: { scenes?: Array<{ id?: string; slugline?: string; scriptBlocks?: ScriptBlock[] }> };
  };
  const beatById = new Map((rawData.adaptationAudit?.beats || []).map((beat) => [String(beat.beat_id || ''), beat]));
  const segmentById = new Map((rawData.storySources?.transcript?.segments || []).map((segment) => [String(segment.id || ''), segment]));

  const directSourceSegments = dossier.directBeatIds.map((beatId) => {
    const beat = beatById.get(beatId);
    const segment = segmentById.get(beatId);
    if (!beat || !segment || typeof segment.text !== 'string' || !segment.text.trim()) {
      throw new HttpError(503, `direct story source ${beatId} is unavailable`);
    }
    const beatHash = trustedSha256(beat.source?.content_sha256, `direct story source ${beatId} beat hash`);
    const segmentHash = trustedSha256(segment.contentSha256, `direct story source ${beatId} segment hash`);
    const actualSegmentHash = createHash('sha256').update(segment.text).digest('hex');
    if (beatHash !== segmentHash || actualSegmentHash !== segmentHash) {
      throw new HttpError(503, `direct story source ${beatId} failed its content hash check`);
    }
    return {
      beatId,
      timecodeStart: String(beat.source?.timecode_start || segment.timecode || ''),
      timecodeEnd: String(beat.source?.timecode_end || ''),
      authority: String(beat.authority || 'UNKNOWN'),
      asrStatus: String(beat.asr_status || 'UNKNOWN'),
      summary: String(beat.summary || ''),
      text: segment.text,
      contentSha256: segmentHash,
    };
  });
  const directCharacterCount = directSourceSegments.reduce((total, segment) => total + segment.text.length, 0);
  if (!directSourceSegments.length || directCharacterCount > maxDirectSourceCharacters) {
    throw new HttpError(503, 'the direct story source package is empty or exceeds the AI collaboration limit');
  }

  const relatedContext = dossier.relatedBeatIds.map((beatId) => {
    const beat = beatById.get(beatId);
    const segment = segmentById.get(beatId);
    if (!beat || !segment || typeof segment.text !== 'string' || !segment.text.trim() || !String(beat.summary || '').trim()) {
      throw new HttpError(503, `related story context ${beatId} is unavailable`);
    }
    const beatHash = trustedSha256(beat.source?.content_sha256, `related story context ${beatId} beat hash`);
    const segmentHash = trustedSha256(segment.contentSha256, `related story context ${beatId} segment hash`);
    const actualSegmentHash = createHash('sha256').update(segment.text).digest('hex');
    if (beatHash !== segmentHash || actualSegmentHash !== segmentHash) {
      throw new HttpError(503, `related story context ${beatId} failed its content hash check`);
    }
    return {
      beatId,
      timecodeStart: String(beat.source?.timecode_start || ''),
      authority: String(beat.authority || 'UNKNOWN'),
      asrStatus: String(beat.asr_status || 'UNKNOWN'),
      summary: String(beat.summary || ''),
    };
  });
  if (relatedContext.reduce((total, item) => total + item.summary.length, 0) > maxRelatedSummaryCharacters) {
    throw new HttpError(503, 'the related story context exceeds the AI collaboration limit');
  }

  const scene = rawData.creativeLineage?.scenes?.find((item) => String(item.id || '') === sceneId);
  const sceneScript = (scene?.scriptBlocks || sceneCommentBlocks(data, sceneId))
    .map(scriptBlockText)
    .filter(Boolean)
    .join('\n\n');
  if (!sceneScript) throw new HttpError(503, 'the current scene script is unavailable');

  return {
    sceneId,
    sceneTitle: String(scene?.slugline || ''),
    sceneScript,
    selectionText: anchor.quote,
    selectionPrefix: anchor.prefix,
    selectionSuffix: anchor.suffix,
    directSourceSegments,
    relatedContext,
    dossierHash,
    transcriptSha256,
  };
}
