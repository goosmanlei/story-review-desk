'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { evidenceText, visibleText } from './review-semantics';

const styles = {
  readable: 'evidence-readable',
  readableHeader: 'evidence-readable-header',
  card: 'evidence-readable-card',
  cardHeader: 'evidence-readable-card-header',
  tags: 'evidence-readable-tags',
  summary: 'evidence-readable-summary',
  grid: 'evidence-readable-grid',
  panel: 'evidence-readable-panel',
  facts: 'evidence-readable-facts',
  warning: 'is-warning',
  complete: 'is-complete',
  claims: 'evidence-readable-claims',
  raw: 'evidence-reader-raw',
} as const;

export type EvidenceRecord = {
  ref: string;
  sourceKind: string;
  displayFormat: 'MARKDOWN' | 'JSON';
  title: string;
  path: string;
  locator: string;
  excerpt: string;
  sourceSha256: string;
  excerptSha256: string;
  readingContext: {
    locator: string;
    lineStart: number;
    lineEnd: number;
    excerpt: string;
    excerptSha256: string;
  } | null;
  reviewUse: string;
  sceneIds: string[];
  episodeIds: string[];
  internalHref: string | null;
  internalLabel: string | null;
  transcriptSegments?: TranscriptSegmentEvidence[];
  creatorContext?: CreatorEvidenceContext;
};

type TranscriptSegmentEvidence = {
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
};

type AudioQuestionContext = {
  question?: string;
  currentSafeRendering?: string;
};

type BeatAudioContext = {
  audioQuestion?: string;
  currentSafeRendering?: string;
};

type CreatorEvidenceContext = {
  beats?: Record<string, BeatAudioContext>;
  scenes?: Record<string, {
    sceneSummary?: string;
    auditFocus?: string;
    revisionNote?: string;
    audioQuestions?: AudioQuestionContext[];
  }>;
};

type EvidenceRequest = {
  heading: string;
  semantics: string;
  refs: string[];
};

type EvidenceReaderValue = {
  openEvidence: (request: EvidenceRequest, opener?: HTMLElement | null) => void;
};

type EvidenceHistoryState = Record<string, unknown> & {
  reviewOverlay?: { kind: string; depth?: number };
  evidenceRequest?: EvidenceRequest;
};

const EvidenceReaderContext = createContext<EvidenceReaderValue | null>(null);

export function useEvidenceReader() {
  const context = useContext(EvidenceReaderContext);
  if (!context) throw new Error('useEvidenceReader must be used inside EvidenceReaderProvider');
  return context;
}

function evidenceScope(record: EvidenceRecord) {
  if (record.sceneIds.length) return `关联${record.sceneIds.length}场：${record.sceneIds.join('、')}`;
  if (record.episodeIds.length) return `关联${record.episodeIds.join('、')}`;
  return '项目级依据';
}

type JsonObject = Record<string, unknown>;

const authorityLabels: Record<string, string> = {
  F: 'F · 原始故事事实',
  A: 'A · 改编判断',
  L: 'L · 制作锁定',
  U: 'U · 尚未确认',
};

const priorityLabels: Record<string, string> = {
  MUST: '必须保留',
  SHOULD: '应当保留',
  OPTIONAL: '可选内容',
  OMIT: '明确不采用',
};

const asrLabels: Record<string, string> = {
  OK: '逐字稿可用',
  AUDIO_VERIFIED: '已回听原音',
  AUDIO_VERIFY_REQUIRED: '需要回听原音',
};

const coverageLabels: Record<string, string> = {
  FULL: '已完整表达',
  PARTIAL: '部分保留／有意压缩',
  PARTIAL_BY_DESIGN: '按设计部分保留',
  ABSENT: '剧本缺失',
  DISTORTED: '表达失真',
  CONTRADICTED: '与原文冲突',
  NOT_APPLICABLE: '明确不采用',
  UNVERIFIABLE: '尚无法核实',
};

const shootabilityLabels: Record<string, string> = {
  SHOOTABLE: '可直接拍摄',
  ADAPTATION_REQUIRED: '需要改编后拍摄',
  UNFILMABLE: '当前不可拍',
  UNKNOWN: '尚未确认可拍性',
};

const actionLabels: Record<string, string> = {
  PRESERVE: '原样保留',
  COMPRESS: '压缩表达',
  REORDER: '重排位置',
  OMIT: '明确删去',
  VERIFY: '核实后决定',
};

const auditResultLabels: Record<string, string> = {
  FULL: '原文要求已完整覆盖',
  PARTIAL_BY_DESIGN: '按改编设计部分覆盖',
  ADAPTATION_SUPPORTED: '改编内容有依据支撑',
};

const rewriteStatusLabels: Record<string, string> = {
  UPDATED_IN_THIS_AUDIT: '本轮审计已更新',
  RETAINED_AFTER_REVIEW: '复核后保留现稿',
};

const storyKindLabels: Record<string, string> = {
  STORY: '故事推进',
  SETUP: '铺垫',
  CHARACTER: '人物',
  PAYOFF: '回收',
  CAUSAL: '因果',
  MISDIRECTION: '误导',
  REVEAL: '揭晓',
  GAG: '笑点',
};

const sourceKindLabels: Record<string, string> = {
  ADAPTATION_AUDIT: '原文与剧本改编审计',
  EPISODE_REGISTRY: '分集方案',
  SCREENPLAY: '当前剧本',
  CONTINUITY_MATRIX: '连续性依据',
  PROJECT_RULE: '项目规则',
  SOURCE: '来源依据',
};

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function distinctString(value: unknown, duplicates: Array<string | null> = [], genericValues: string[] = []) {
  const text = nonEmptyString(value);
  if (!text || genericValues.includes(text) || duplicates.some((candidate) => candidate === text)) return null;
  return text;
}

function creatorFacingAuditText(value: unknown) {
  const text = nonEmptyString(value);
  if (!text) return null;
  return text
    .replaceAll('原始ASR文本', '原始转写文本')
    .replaceAll('ASR', '语音识别')
    .replaceAll('/she/音形', '“蛇”的读音')
    .replaceAll('A/L/U边界', '改编、制作锁定与待确认边界');
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(nonEmptyString).filter((item): item is string => Boolean(item)) : [];
}

function labelFor(value: unknown, labels: Record<string, string>, missing = '旧记录未提供') {
  const raw = nonEmptyString(value);
  if (!raw) return missing;
  if (raw === 'UNKNOWN' || raw === 'UNCONFIRMED') return '尚未确认';
  return labels[raw] ?? `${raw} · 未识别状态`;
}

function parseJsonExcerpt(excerpt: string): JsonObject[] | null {
  const raw = excerpt.trim();
  const candidates = [raw];
  if (raw.endsWith(',')) candidates.push(raw.slice(0, -1).trimEnd());
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const records = (Array.isArray(parsed) ? parsed : [parsed])
        .map(asObject)
        .filter((item): item is JsonObject => Boolean(item));
      if (records.length) return records;
    } catch {
      // Some source slices deliberately retain a trailing comma. The second
      // candidate handles that form; an unreadable payload falls back to raw.
    }
  }
  return null;
}

function evidenceNavigationLabel(record: EvidenceRecord) {
  if (record.sourceKind === 'SCREENPLAY' && record.sceneIds.length) return {
    title: `${record.sceneIds.join('、')} · 当前剧本片段`,
    meta: '',
  };
  const parsed = record.displayFormat === 'JSON' ? parseJsonExcerpt(record.excerpt)?.[0] : null;
  const sceneId = nonEmptyString(parsed?.scene_id);
  if (sceneId) return {
    title: `${sceneId} · ${nonEmptyString(parsed?.title) || '场次依据'}`,
    meta: '场正文改编审计',
  };
  const beatId = nonEmptyString(parsed?.beat_id);
  if (beatId) return {
    title: `${beatId} · ${nonEmptyString(parsed?.summary) || '原始故事节拍'}`,
    meta: '原始故事节拍',
  };
  const episodeId = nonEmptyString(parsed?.episode_id);
  if (episodeId) return {
    title: `${episodeId} · 分集依据`,
    meta: stringList(parsed?.scene_ids).join('、') || record.locator,
  };
  return { title: record.title, meta: record.locator };
}

function inlineEvidenceRecords(records: EvidenceRecord[]) {
  return records.filter((record, index) => {
    if (record.sourceKind !== 'SCREENPLAY') return true;
    const excerpt = record.excerpt.trim();
    return !records.some((other, otherIndex) => {
      if (otherIndex === index || other.sourceKind !== 'SCREENPLAY' || other.path !== record.path) return false;
      const otherExcerpt = other.excerpt.trim();
      return otherExcerpt.includes(excerpt) && (otherExcerpt.length > excerpt.length || otherIndex < index);
    });
  });
}

function unresolvedEvidenceNavigationLabel(ref: string, meta: string) {
  const scene = ref.match(/#(?:sceneAudits:)?(S\d{2})(?:-S\d{2})?$/)?.[1];
  if (scene) return { title: `${scene} · 场次依据`, meta };
  const beat = ref.match(/#(TR-\d{3})(?:-TR-\d{3})?$/)?.[1];
  if (beat) return { title: `${beat} · 原始故事节拍`, meta };
  const episode = ref.match(/#(E\d{2})(?:-E\d{2})?$/)?.[1];
  if (episode) return { title: `${episode} · 分集依据`, meta };
  return { title: '当前判断依据', meta };
}

function evidenceSourceKindLabel(value: string) {
  return sourceKindLabels[value] ?? '来源依据';
}

function TranscriptTechnicalTrace({ segment }: { segment: TranscriptSegmentEvidence }) {
  const lineLabel = segment.sourceLineStart === segment.sourceLineEnd
    ? `第${segment.sourceLineStart}行`
    : `第${segment.sourceLineStart}–${segment.sourceLineEnd}行`;
  return <section className="evidence-reader-transcript-trace" data-transcript-beat={segment.beatId}>
    <div className="evidence-reader-trace">
      <code>{segment.sourcePath} · {lineLabel}</code>
      <small>逐字稿源 SHA-256 {segment.sourceSha256.slice(0, 12)}… · 段落正文 {segment.textSha256.slice(0, 12)}…</small>
    </div>
    <pre>{segment.text}</pre>
  </section>;
}

function EvidenceTechnicalTrace({ record, includeRaw }: { record: EvidenceRecord; includeRaw: boolean }) {
  return <details className={styles.raw} aria-label="原始证据与技术追溯" data-content-role="technical-trace">
    <summary><span>原始证据与技术追溯</span><small>仅在核对字段、路径或哈希时展开</small></summary>
    {(record.transcriptSegments || []).map((segment) => <TranscriptTechnicalTrace key={`${segment.beatId}:${segment.textSha256}`} segment={segment} />)}
    <div className="evidence-reader-trace">
      <code>{evidenceText(record.path || record.ref)}</code>
      <small>审计／引用源 SHA-256 {record.sourceSha256.slice(0, 12)}… · 精确引用 {record.excerptSha256.slice(0, 12)}…{record.readingContext ? ` · 阅读上下文 ${record.readingContext.excerptSha256.slice(0, 12)}…` : ''}</small>
    </div>
    {includeRaw && <pre>{evidenceText(record.excerpt)}</pre>}
  </details>;
}

function EvidenceTechnicalTraceList({ records }: { records: EvidenceRecord[] }) {
  if (!records.length) return null;
  return <details className={`${styles.raw} evidence-reader-raw-list`} aria-label="原始证据与技术追溯" data-content-role="technical-trace">
    <summary><span>原始证据与技术追溯</span><small>{records.length}条来源，仅在核对路径、字段或哈希时展开</small></summary>
    <div>{records.map((record) => {
      const structuredRecords = record.displayFormat === 'JSON' ? parseJsonExcerpt(record.excerpt) : null;
      return <section className="evidence-reader-trace-entry" data-evidence-ref={record.ref} key={record.ref}>
        {(record.transcriptSegments || []).map((segment) => <TranscriptTechnicalTrace key={`${segment.beatId}:${segment.textSha256}`} segment={segment} />)}
        <div className="evidence-reader-trace">
          <code>{evidenceText(record.path || record.ref)}</code>
          <small>审计／引用源 SHA-256 {record.sourceSha256.slice(0, 12)}… · 精确引用 {record.excerptSha256.slice(0, 12)}…{record.readingContext ? ` · 阅读上下文 ${record.readingContext.excerptSha256.slice(0, 12)}…` : ''}</small>
        </div>
        {structuredRecords && <pre>{evidenceText(record.excerpt)}</pre>}
      </section>;
    })}</div>
  </details>;
}

function EvidenceTags({ labels }: { labels: Array<string | null> }) {
  const values = labels.filter((label): label is string => Boolean(label));
  if (!values.length) return null;
  return <div className={styles.tags}>{values.map((label, index) => <span key={`${label}-${index}`}>{visibleText(label)}</span>)}</div>;
}

function EvidenceFacts({ items }: { items: Array<{ label: string; value: string | null }> }) {
  const visibleItems = items.filter((item): item is { label: string; value: string } => Boolean(item.value));
  if (!visibleItems.length) return null;
  return <dl className={styles.facts}>{visibleItems.map(({ label, value }) => <div key={label}><dt>{label}</dt><dd>{visibleText(value)}</dd></div>)}</dl>;
}

function BeatEvidenceCard({ record, inline = false, creatorContext }: { record: JsonObject; inline?: boolean; creatorContext?: CreatorEvidenceContext }) {
  const source = asObject(record.source) ?? {};
  const audience = asObject(record.audience_knowledge) ?? {};
  const mapping = asObject(record.current_mapping) ?? {};
  const decision = asObject(record.adaptation_decision) ?? {};
  const beatId = nonEmptyString(record.beat_id) ?? '未登记节拍ID';
  const timeStart = nonEmptyString(source.timecode_start);
  const timeEnd = nonEmptyString(source.timecode_end);
  const sceneIds = stringList(mapping.scene_ids);
  const targetSceneIds = stringList(decision.target_scene_ids);
  const mappedScenes = sceneIds.length ? sceneIds : targetSceneIds;
  const audioQuestion = creatorContext?.beats?.[beatId];
  const needsAudioReview = record.asr_status === 'AUDIO_VERIFY_REQUIRED';
  const sourceKinds = stringList(record.source_kind).map((kind) => storyKindLabels[kind] ?? `${kind} · 未识别类型`);
  const summary = nonEmptyString(record.summary);
  const audienceBefore = distinctString(audience.before, [], inline ? ['承接上一段；首次发生时尚未知本段关键信息。'] : []);
  const audienceAfter = distinctString(audience.after, inline ? [summary] : []);
  const screenExpression = distinctString(decision.screen_expression, [], inline ? ['以动作、对白、物证或可见反应承载。'] : []);
  const decisionReason = distinctString(decision.reason, inline ? [summary, audienceAfter, screenExpression] : []);
  const mappingNote = distinctString(
    creatorFacingAuditText(mapping.notes),
    [summary, audienceAfter, screenExpression, decisionReason],
  );
  const hasAudienceUpdate = Boolean(audienceBefore || audienceAfter || nonEmptyString(audience.withheld));

  return <article className={styles.card} data-evidence-kind="adaptation-beat" data-beat-id={beatId}>
    <header className={styles.cardHeader}>
      <div><h4>{inline ? '原始故事节拍' : `${evidenceText(beatId)} · 原始故事节拍`}</h4></div>
      <span>{timeStart ? `${timeStart}${timeEnd ? `–${timeEnd}` : ''}` : '时间码未提供'}</span>
    </header>
    <EvidenceTags labels={inline ? [
      labelFor(record.authority, authorityLabels),
      labelFor(record.priority, priorityLabels),
      record.asr_status && record.asr_status !== 'OK' ? labelFor(record.asr_status, asrLabels) : null,
    ] : [
      labelFor(record.authority, authorityLabels),
      labelFor(record.priority, priorityLabels),
      labelFor(record.asr_status, asrLabels),
      ...sourceKinds,
      mappedScenes.length ? `落到 ${mappedScenes.join('、')}` : '未映射到当前剧本',
    ]} />
    <section className={styles.summary}><h5>审计摘要</h5><p>{visibleText(summary || '旧记录未提供')}</p></section>
    <div className={styles.grid}>
      {hasAudienceUpdate && <section className={styles.panel}>
        <h5>观众此时知道什么</h5>
        <EvidenceFacts items={[
          { label: '此前知道', value: audienceBefore },
          { label: '本段新增', value: audienceAfter },
          { label: '暂不揭示', value: nonEmptyString(audience.withheld) },
        ]} />
      </section>}
      <section className={styles.panel}>
        <h5>当前剧本处理</h5>
        <EvidenceFacts items={[
          ...(!inline ? [{ label: '落点', value: mappedScenes.length ? mappedScenes.join('、') : record.priority === 'OMIT' ? '明确不进入剧本' : null }] : []),
          { label: '覆盖', value: labelFor(mapping.coverage, coverageLabels) },
          ...(!inline ? [{ label: '可拍性', value: labelFor(mapping.shootability, shootabilityLabels) }] : []),
          { label: '处理动作', value: labelFor(decision.action, actionLabels) },
          { label: '画面承载', value: screenExpression },
          { label: '处理原因', value: decisionReason },
          { label: '补充说明', value: mappingNote },
        ]} />
      </section>
      {needsAudioReview && <section className={`${styles.panel} ${styles.warning}`}>
        <h5>原音核对提醒</h5>
        <EvidenceFacts items={[
          { label: '待核对', value: creatorFacingAuditText(audioQuestion?.audioQuestion) || '该处原音仍需回听确认。' },
          { label: '当前安全写法', value: creatorFacingAuditText(audioQuestion?.currentSafeRendering) || '当前写法不把疑词当作已确认事实。' },
        ]} />
      </section>}
    </div>
  </article>;
}

function SceneAuditEvidenceCard({ record, inline = false, creatorContext }: { record: JsonObject; inline?: boolean; creatorContext?: CreatorEvidenceContext }) {
  const sceneId = nonEmptyString(record.scene_id) ?? '未登记场次';
  const gaps = stringList(record.remaining_gaps);
  const sceneContext = creatorContext?.scenes?.[sceneId];
  const sceneSummary = creatorFacingAuditText(sceneContext?.sceneSummary);
  const auditFocus = distinctString(creatorFacingAuditText(sceneContext?.auditFocus), [sceneSummary]);
  const revisionNote = creatorFacingAuditText(sceneContext?.revisionNote);
  const audioQuestions = sceneContext?.audioQuestions || [];
  const hasDetails = Boolean(sceneSummary || auditFocus || revisionNote || gaps.length || audioQuestions.length);
  return <article className={styles.card} data-evidence-kind="scene-audit" data-scene-id={sceneId}>
    <header className={styles.cardHeader}>
      <div><small>场正文改编审计</small><h4>{evidenceText(sceneId)} · {visibleText(nonEmptyString(record.title) || '场名未提供')}</h4></div>
      <span>{labelFor(record.audit_result, auditResultLabels)}</span>
    </header>
    <EvidenceTags labels={inline ? [
      record.authority === 'F' ? 'F · 当前剧本／审计事实' : labelFor(record.authority, authorityLabels),
    ] : [
      labelFor(record.authority, authorityLabels),
      labelFor(record.shootability, shootabilityLabels),
      labelFor(record.rewrite_status, rewriteStatusLabels),
    ]} />
    {hasDetails && <div className={styles.grid}>
      {sceneSummary && <section className={styles.panel}>
        <h5>本场剧情</h5><p>{visibleText(sceneSummary)}</p>
      </section>}
      {auditFocus && <section className={styles.panel}>
        <h5>本场审计重点</h5><p>{visibleText(auditFocus)}</p>
      </section>}
      {revisionNote && <section className={styles.panel}>
        <h5>本轮修订要点</h5><p>{visibleText(revisionNote)}</p>
      </section>}
      {gaps.length > 0 && <section className={`${styles.panel} ${styles.warning}`}>
        <h5>本场需注意</h5>
        <ul>{gaps.map((gap) => <li key={gap}>{visibleText(gap)}</li>)}</ul>
      </section>}
      {audioQuestions.map((question, index) => <section className={`${styles.panel} ${styles.warning}`} key={`${question.question || ''}:${index}`}>
        <h5>原音核对提醒</h5>
        <EvidenceFacts items={[
          { label: '待核对', value: creatorFacingAuditText(question.question) },
          { label: '当前安全写法', value: creatorFacingAuditText(question.currentSafeRendering) },
        ]} />
      </section>)}
    </div>}
  </article>;
}

function EpisodeRegistryEvidenceCard({ record }: { record: JsonObject }) {
  const episodeId = nonEmptyString(record.episode_id) ?? '未登记分集';
  const sceneIds = stringList(record.scene_ids);
  const claims = [
    ['开场钩子', asObject(record.opening_hook)],
    ['核心推进', asObject(record.core_advance)],
    ['结尾悬念', asObject(record.ending_cliffhanger)],
  ] as const;
  const runtime = record.estimated_duration_seconds == null
    ? '尚未锁时'
    : `${String(record.estimated_duration_seconds)}秒`;
  return <article className={styles.card} data-evidence-kind="episode-registry" data-episode-id={episodeId}>
    <header className={styles.cardHeader}>
      <div><small>分集登记</small><h4>{evidenceText(episodeId)} · {sceneIds.length ? `${sceneIds[0]}–${sceneIds.at(-1)}` : '场次范围未提供'}</h4></div>
      <span>{runtime}</span>
    </header>
    <EvidenceTags labels={[
      record.structure_status === 'PROPOSED_NAVIGATION_ONLY' ? 'A · 全剧候选的一部分' : labelFor(record.structure_status, {}),
      record.timing_status === 'UNCONFIRMED' ? '时长尚未确认' : labelFor(record.timing_status, {}),
      `${sceneIds.length}场`,
    ]} />
    <div className={styles.claims}>{claims.map(([label, claim]) => <section key={label}>
      <header><b>{label}</b><span>{claim ? labelFor(claim.class, authorityLabels) : '等级未提供'}</span></header>
      <p>{visibleText(nonEmptyString(claim?.text) || '旧记录未提供')}</p>
    </section>)}</div>
  </article>;
}

function GenericJsonEvidenceCard({ record, index, inline = false }: { record: JsonObject; index: number; inline?: boolean }) {
  const rows = Object.entries(record).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value));
  return <article className={styles.card} data-evidence-kind="generic-json">
    <header className={styles.cardHeader}><div><small>结构化依据</small><h4>{inline ? '当前记录缺少创作者可读投影' : `记录 ${String(index + 1).padStart(2, '0')}`}</h4></div>{!inline && <span>暂无专用依据摘要</span>}</header>
    {!inline && <EvidenceFacts items={rows.map(([label, value]) => ({ label, value: String(value) }))} />}
  </article>;
}

function StructuredEvidence({ records, inline = false, creatorContext }: { records: JsonObject[]; inline?: boolean; creatorContext?: CreatorEvidenceContext }) {
  return <section className={`${styles.readable}${inline ? ' is-inline' : ''}`} aria-label="审阅依据">
    {!inline && <header className={styles.readableHeader}><div><small>REVIEW VIEW</small><h4>已转换为可直接判断的证据卡</h4></div><span>{records.length}条记录</span></header>}
    {records.map((record, index) => {
      if (nonEmptyString(record.beat_id)) return <BeatEvidenceCard key={`${record.beat_id}-${index}`} record={record} inline={inline} creatorContext={creatorContext} />;
      if (nonEmptyString(record.scene_id)) return <SceneAuditEvidenceCard key={`${record.scene_id}-${index}`} record={record} inline={inline} creatorContext={creatorContext} />;
      if (nonEmptyString(record.episode_id)) return <EpisodeRegistryEvidenceCard key={`${record.episode_id}-${index}`} record={record} />;
      return <GenericJsonEvidenceCard key={index} record={record} index={index} inline={inline} />;
    })}
  </section>;
}

export function InlineEvidence({ refs, heading }: EvidenceRequest) {
  const uniqueRefs = useMemo(() => Array.from(new Set(refs.filter(Boolean))), [refs]);
  const refsKey = uniqueRefs.join('\n');
  const [records, setRecords] = useState<EvidenceRecord[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(uniqueRefs.length > 0);

  useEffect(() => {
    const requestedRefs = refsKey ? refsKey.split('\n') : [];
    if (!requestedRefs.length) return;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setRecords([]);
      setErrors([]);
      setLoading(true);
    });
    Promise.allSettled(requestedRefs.map(async (ref) => {
      const response = await fetch(`/api/v8/ui/evidence?ref=${encodeURIComponent(ref)}`, { signal: controller.signal });
      if (!response.ok) throw new Error(response.status === 404 ? `依据未进入当前快照：${ref}` : `依据读取失败（HTTP ${response.status}）：${ref}`);
      const payload = await response.json() as { data: EvidenceRecord };
      return payload.data;
    })).then((results) => {
      if (controller.signal.aborted) return;
      const loaded: EvidenceRecord[] = [];
      const failed: string[] = [];
      results.forEach((result) => {
        if (result.status === 'fulfilled') loaded.push(result.value);
        else if ((result.reason as { name?: string }).name !== 'AbortError') failed.push(result.reason instanceof Error ? result.reason.message : '依据读取失败');
      });
      setRecords(loaded);
      setErrors(failed);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [refsKey]);

  if (!uniqueRefs.length) return null;
  const readableRecords = inlineEvidenceRecords(records);
  const visibleRecordCount = readableRecords.reduce((count, record) => {
    const structured = record.displayFormat === 'JSON'
      || ['ADAPTATION_AUDIT', 'EPISODE_REGISTRY'].includes(record.sourceKind);
    return count + (structured ? parseJsonExcerpt(record.excerpt)?.length || 1 : 1);
  }, 0);
  const sourceCount = readableRecords.length || uniqueRefs.length;
  const countLabel = visibleRecordCount > sourceCount
    ? `${sourceCount}组 · ${visibleRecordCount}条`
    : `${sourceCount}条`;
  const loadedRefs = new Set(records.map((record) => record.ref));
  const settledRefs = new Set([
    ...records.map((record) => record.ref),
    ...uniqueRefs.filter((ref) => errors.some((error) => error.includes(ref))),
  ]);
  const evidenceReady = !loading && uniqueRefs.every((ref) => settledRefs.has(ref));
  return <section
    className="evidence-inline"
    aria-label={heading}
    data-content-role="evidence"
    data-evidence-ready={evidenceReady ? 'true' : 'false'}
    data-evidence-loaded-count={loadedRefs.size}
  >
    <header className="evidence-inline-header">
      <h4>判断依据 <span>{countLabel}</span></h4>
    </header>
    {loading && !records.length && <div className="evidence-inline-state"><b>正在读取当前快照中的依据…</b></div>}
    {errors.map((error) => <div className="evidence-inline-state is-error" role="alert" key={error}><b>无法读取依据</b><span>{visibleText(error)}</span></div>)}
    {readableRecords.map((record) => {
      const isJson = record.displayFormat === 'JSON' || ['ADAPTATION_AUDIT', 'EPISODE_REGISTRY'].includes(record.sourceKind);
      const structuredRecords = isJson ? parseJsonExcerpt(record.excerpt) : null;
      const label = evidenceNavigationLabel(record);
      return <section className={`evidence-inline-record${structuredRecords ? ' is-structured' : ''}`} data-evidence-ref={record.ref} data-content-role="evidence-record" key={record.ref}>
        {!structuredRecords && <header><div>{record.sourceKind !== 'SCREENPLAY' && <small>{evidenceSourceKindLabel(record.sourceKind)}</small>}<h4>{visibleText(label.title)}</h4></div>{label.meta && <span>{visibleText(label.meta)}</span>}</header>}
        {structuredRecords
          ? <StructuredEvidence records={structuredRecords} inline creatorContext={record.creatorContext} />
          : <section className="evidence-reader-quote is-exact">
            <header><b>{record.readingContext ? '精确引用' : isJson ? '结构化依据解析失败，显示原始记录' : '引用原文'}</b>{record.sourceKind !== 'SCREENPLAY' && <span>{visibleText(record.locator)}</span>}</header>
            <pre>{evidenceText(record.excerpt)}</pre>
          </section>}
        {record.readingContext && record.readingContext.excerptSha256 !== record.excerptSha256 && record.readingContext.excerpt.trim() !== record.excerpt.trim() && <section className="evidence-reader-quote is-context">
          <header><div><b>完整章节上下文</b><small>用于阅读，不扩大上方精确引用的证据范围</small></div><span>{visibleText(record.readingContext.locator)}</span></header>
          <pre>{evidenceText(record.readingContext.excerpt)}</pre>
        </section>}
        {!structuredRecords && record.sourceKind !== 'SCREENPLAY' && <footer><span>{evidenceScope(record)}</span></footer>}
      </section>;
    })}
    <EvidenceTechnicalTraceList records={records} />
  </section>;
}

export function EvidenceReaderProvider({ children, onInternalNavigate }: { children: ReactNode; onInternalNavigate?: (href: string, label: string) => void }) {
  const [request, setRequest] = useState<EvidenceRequest | null>(null);
  const [records, setRecords] = useState<EvidenceRecord[]>([]);
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const cacheRef = useRef(new Map<string, EvidenceRecord>());

  const finishClose = useCallback((restoreFocus = true) => {
    const dialog = dialogRef.current;
    if (dialog?.open) dialog.close();
    setRequest(null);
    if (restoreFocus) window.setTimeout(() => openerRef.current?.focus(), 0);
  }, []);

  const close = useCallback(() => {
    const state = (window.history.state || {}) as EvidenceHistoryState;
    if (state.reviewOverlay?.kind === 'evidence' && (state.reviewOverlay.depth || 0) > 0) {
      window.history.back();
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.delete('evidenceRef');
    window.history.replaceState({ ...state, reviewOverlay: undefined, evidenceRequest: undefined }, '', url);
    finishClose();
  }, [finishClose]);

  const openEvidence = useCallback((nextRequest: EvidenceRequest, opener?: HTMLElement | null) => {
    const refs = Array.from(new Set(nextRequest.refs.filter(Boolean)));
    if (!refs.length) return;
    openerRef.current = opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setRequest({ ...nextRequest, refs });
    setSelectedRef(refs[0]);
    setErrors({});
    const url = new URL(window.location.href);
    url.searchParams.set('evidenceRef', refs[0]);
    const current = (window.history.state || {}) as EvidenceHistoryState;
    const nextState: EvidenceHistoryState = { ...current, reviewOverlay: { kind: 'evidence', depth: request ? current.reviewOverlay?.depth || 1 : 1 }, evidenceRequest: { ...nextRequest, refs } };
    if (request) window.history.replaceState(nextState, '', url);
    else window.history.pushState(nextState, '', url);
  }, [request]);

  const restoreEvidenceFromLocation = useCallback(() => {
    const ref = new URL(window.location.href).searchParams.get('evidenceRef')?.trim();
    if (!ref) {
      if (request) finishClose();
      return;
    }
    const state = (window.history.state || {}) as EvidenceHistoryState;
    const restored = state.evidenceRequest?.refs.includes(ref)
      ? state.evidenceRequest
      : { refs: [ref], heading: '链接指向的判断依据', semantics: '以下内容来自当前数据快照；显示依据不改变其F／L／A／U等级。' };
    setRequest(restored);
    setSelectedRef(ref);
    setErrors({});
    if (!state.reviewOverlay) window.history.replaceState({ ...state, reviewOverlay: { kind: 'evidence', depth: 0 }, evidenceRequest: restored }, '', window.location.href);
  }, [finishClose, request]);

  useEffect(() => {
    queueMicrotask(restoreEvidenceFromLocation);
    window.addEventListener('popstate', restoreEvidenceFromLocation);
    return () => window.removeEventListener('popstate', restoreEvidenceFromLocation);
  }, [restoreEvidenceFromLocation]);

  useEffect(() => {
    if (!request) return;
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    const controller = new AbortController();
    const missingRefs = request.refs.filter((ref) => !cacheRef.current.has(ref));
    const cached = request.refs.map((ref) => cacheRef.current.get(ref)).filter((item): item is EvidenceRecord => Boolean(item));
    setRecords(cached);
    setErrors({});
    if (!missingRefs.length) {
      setLoading(false);
      return () => controller.abort();
    }
    setLoading(true);
    Promise.allSettled(missingRefs.map(async (ref) => {
      const response = await fetch(`/api/v8/ui/evidence?ref=${encodeURIComponent(ref)}`, { signal: controller.signal });
      if (!response.ok) throw new Error(response.status === 404 ? '当前快照没有包含这条依据。' : `读取失败（HTTP ${response.status}）。`);
      const payload = await response.json() as { data: EvidenceRecord };
      cacheRef.current.set(ref, payload.data);
      return payload.data;
    })).then((results) => {
      if (controller.signal.aborted) return;
      const nextErrors: Record<string, string> = {};
      results.forEach((result, index) => {
        if (result.status === 'rejected' && (result.reason as { name?: string }).name !== 'AbortError') {
          nextErrors[missingRefs[index]] = result.reason instanceof Error ? result.reason.message : '读取失败。';
        }
      });
      setRecords(request.refs.map((ref) => cacheRef.current.get(ref)).filter((item): item is EvidenceRecord => Boolean(item)));
      setErrors(nextErrors);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [request]);

  const selected = useMemo(
    () => records.find((record) => record.ref === selectedRef) ?? (!selectedRef || errors[selectedRef] ? null : records[0] ?? null),
    [errors, records, selectedRef],
  );
  const selectedError = selectedRef ? errors[selectedRef] : null;
  const selectedIsJson = Boolean(selected && (
    selected.displayFormat === 'JSON'
    || ['ADAPTATION_AUDIT', 'EPISODE_REGISTRY'].includes(selected.sourceKind)
  ));
  const structuredRecords = useMemo(
    () => selected && selectedIsJson ? parseJsonExcerpt(selected.excerpt) : null,
    [selected, selectedIsJson],
  );

  return <EvidenceReaderContext.Provider value={{ openEvidence }}>
    {children}
    <dialog ref={dialogRef} className="evidence-reader" aria-labelledby="evidence-reader-title" onCancel={(event) => { event.preventDefault(); close(); }} onClose={() => setRequest(null)}>
      <div className="evidence-reader-shell">
        <header className="evidence-reader-header">
          <div><small>独立证据阅读层</small><h2 id="evidence-reader-title">{request?.heading ?? '查看依据内容'}</h2><p>{request?.semantics}</p></div>
          <button type="button" onClick={close} aria-label="关闭证据阅读器">关闭</button>
        </header>
        <div className="evidence-reader-body">
          <nav aria-label="证据条目">
            {(request?.refs ?? []).map((ref, index) => {
              const record = records.find((item) => item.ref === ref);
              const active = selectedRef === ref;
              const label = record
                ? evidenceNavigationLabel(record)
                : unresolvedEvidenceNavigationLabel(ref, errors[ref] ? '依据暂不可用' : loading ? '正在读取…' : '等待读取');
              return <button key={ref} type="button" aria-current={active ? 'true' : undefined} className={active ? 'active' : ''} onClick={() => { setSelectedRef(ref); const url = new URL(window.location.href); url.searchParams.set('evidenceRef', ref); window.history.replaceState({ ...(window.history.state || {}), evidenceRequest: request || undefined }, '', url); }}><span>{String(index + 1).padStart(2, '0')}</span><b>{visibleText(label.title)}</b><small>{visibleText(label.meta)}</small></button>;
            })}
          </nav>
          <section className="evidence-reader-content" aria-live="polite">
            {loading && !selected && <div className="evidence-reader-state"><b>正在读取当前快照中的原始依据…</b><span>正文只在打开时加载。</span></div>}
            {selectedError && <div className="evidence-reader-state is-error"><b>这条依据暂时不可读</b><span>{visibleText(selectedError)} 其他已载入条目仍可正常查看。</span><details className={styles.raw}><summary><span>技术信息</span><small>仅供排查</small></summary><div className="evidence-reader-trace"><code>{evidenceText(selectedRef || '')}</code></div></details></div>}
            {selected && <article>
              <header><div><small>{evidenceSourceKindLabel(selected.sourceKind)}</small><h3>{visibleText(evidenceNavigationLabel(selected).title)}</h3></div><span>{visibleText(evidenceNavigationLabel(selected).meta)}</span></header>
              {selected.reviewUse && <p className="evidence-reader-use">{visibleText(selected.reviewUse)}</p>}
              {structuredRecords
                ? <StructuredEvidence records={structuredRecords} creatorContext={selected.creatorContext} />
                : <section className="evidence-reader-quote is-exact">
                  <header><b>{selected.readingContext ? '精确引用' : selectedIsJson ? '结构化依据解析失败，显示原始记录' : '引用原文'}</b><span>{visibleText(selected.locator)}</span></header>
                  <pre>{evidenceText(selected.excerpt)}</pre>
                </section>}
              <EvidenceTechnicalTrace record={selected} includeRaw={Boolean(structuredRecords)} />
              {selected.readingContext && <section className="evidence-reader-quote is-context">
                <header><div><b>完整章节上下文</b><small>用于阅读，不扩大上方精确引用的证据范围</small></div><span>{visibleText(selected.readingContext.locator)}</span></header>
                <pre>{evidenceText(selected.readingContext.excerpt)}</pre>
              </section>}
              <footer>
                <div><span>{evidenceScope(selected)}</span>{selected.internalHref && (onInternalNavigate ? <button type="button" onClick={() => { finishClose(false); onInternalNavigate(selected.internalHref as string, selected.internalLabel ?? '在正文中定位'); }}>{selected.internalLabel ?? '在正文中定位'}</button> : <a href={selected.internalHref}>{selected.internalLabel ?? '在正文中定位'}</a>)}</div>
              </footer>
            </article>}
          </section>
        </div>
      </div>
    </dialog>
  </EvidenceReaderContext.Provider>;
}

export function EvidenceTrigger({ refs, heading, semantics, label = '查看依据内容' }: EvidenceRequest & { label?: string }) {
  const { openEvidence } = useEvidenceReader();
  const uniqueRefs = Array.from(new Set(refs.filter(Boolean)));
  if (!uniqueRefs.length) return null;
  return <button type="button" className="evidence-trigger" onClick={(event) => openEvidence({ refs: uniqueRefs, heading, semantics }, event.currentTarget)}><span>{label}</span><small>{uniqueRefs.length}处</small></button>;
}
