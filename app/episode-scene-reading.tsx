'use client';

import type { EpisodePlanContext } from './episode-plan-context';
import type { NarrativeBlock, RuntimeEstimate } from './narrative-revision';
import { runtimeLabel } from './narrative-revision';
import { useSceneNarrativeContext } from './scene-narrative-panel';
import { CommentScriptBlocks } from './story-comments';

type ReadingScene = {
  id: string;
  displayId: string;
  title: string;
  contentHash: string;
  scriptBlocks: Array<Pick<NarrativeBlock, 'id' | 'text'> & {
    type: string;
    speaker?: string;
    performanceNote?: string | null;
  }>;
};

const exactHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const secondsKnown = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const authoredText = (value: unknown) => typeof value === 'string' && value.trim() ? value : 'UNKNOWN';

function hasExactBody(scene: ReadingScene) {
  return exactHash(scene.contentHash) && Array.isArray(scene.scriptBlocks) && scene.scriptBlocks.length > 0
    && scene.scriptBlocks.every(block => block && typeof block.id === 'string' && block.id.length > 0
      && typeof block.type === 'string' && typeof block.text === 'string')
    && new Set(scene.scriptBlocks.map(block => block.id)).size === scene.scriptBlocks.length;
}

function Unavailable({ message, pending = false }: { message: string; pending?: boolean }) {
  return <section className="episode-scene-reader" aria-label="本场正文与估时依据">
    <p role={pending ? 'status' : 'alert'}>{message}</p>
  </section>;
}

function SceneReading({ scene, runtime }: { scene: ReadingScene; runtime?: Partial<RuntimeEstimate> }) {
  const duration = (value: unknown) => secondsKnown(value) ? runtimeLabel(value) : 'UNKNOWN';
  const component = (value: unknown) => secondsKnown(value) ? `${value}秒` : 'UNKNOWN';
  return <section className="episode-scene-reader" aria-label="本场正文与估时依据"
    data-scene-id={scene.id} data-scene-content-hash={scene.contentHash}>
    <section className="episode-scene-rationale" aria-label="本场估时依据">
      <h3>估时依据</h3>
      <p><b>基准 {duration(runtime?.baseSec)}</b> · 紧凑 {duration(runtime?.compactSec)} — 舒展 {duration(runtime?.spaciousSec)}</p>
      <p>{authoredText(runtime?.rationale)}</p>
      {runtime && <p>对白 {component(runtime.dialogueSec)} ＋ 动作 {component(runtime.actionSec)} ＋ 反应／停顿 {component(runtime.reactionSec)} ＋ 转场 {component(runtime.transitionSec)} − 同步重叠 {component(runtime.overlapSec)}；置信度：{authoredText(runtime.confidence)}。</p>}
      <small>仅展示本场精确版本的估算，未锁时；缺失项保留 UNKNOWN。</small>
    </section>
    <article aria-label="本场完整正文">
      <h3>本场完整正文</h3>
      <h4>{scene.displayId} {scene.title}</h4>
      <div className="narrative-script-body" id={`scene-body-${scene.id}`} tabIndex={-1}>
        <CommentScriptBlocks anchorPrefix="" sceneId={scene.id} blocks={scene.scriptBlocks}/>
      </div>
    </article>
  </section>;
}

function GenericSceneReading({ plan, sceneId, episodeUid }: { plan: EpisodePlanContext; sceneId: string; episodeUid: string }) {
  const result = useSceneNarrativeContext(plan, sceneId);
  if (!result.context) return <Unavailable pending={!result.error} message={result.error || '正在读取本场精确正文…'}/>;
  const context = result.context;
  const scene = context.sceneDocument;
  if (context.revisionId !== plan.revisionId || context.planContentHash !== plan.contentHash
    || context.snapshotId !== plan.snapshotId || context.sceneId !== sceneId || context.episodeUid !== episodeUid
    || !exactHash(context.contextHash) || !exactHash(context.sceneContentHash)
    || !scene || scene.id !== sceneId || scene.contentHash !== context.sceneContentHash || !hasExactBody(scene)) {
    return <Unavailable message="本场正文与当前方案、永久场身份或精确版本不一致，暂不展示正文。"/>;
  }
  // The generic scene-context API verifies the exact block hash but has no runtime projection.
  // Do not borrow estimates from legacy scenes, adjacent scenes or a different plan.
  return <SceneReading scene={scene}/>;
}

/** A provider-free reader. Its parent owns the episode comment scope and all review state. */
export function EpisodeSceneReading({ plan, sceneId }: { plan: EpisodePlanContext; sceneId: string }) {
  const owners = plan.content.episodes.filter(episode => episode.sceneIds.includes(sceneId));
  if (!sceneId || owners.length !== 1 || owners[0].sceneIds.filter(id => id === sceneId).length !== 1) {
    return <Unavailable message="此永久场身份未唯一绑定到当前分集方案，暂不展示正文。"/>;
  }
  const narrative = plan.content.narrativeRevision;
  if (narrative) {
    const matches = narrative.scenes.filter(scene => scene.id === sceneId);
    if (matches.length !== 1 || narrative.retiredSceneIds.includes(sceneId) || !hasExactBody(matches[0])) {
      return <Unavailable message="当前方案缺少本场唯一的精确正文，暂不展示其他场次。"/>;
    }
    return <SceneReading scene={matches[0]} runtime={matches[0].runtime}/>;
  }
  return <GenericSceneReading key={`${plan.snapshotId}:${plan.revisionId}:${plan.contentHash}:${sceneId}`}
    plan={plan} sceneId={sceneId} episodeUid={owners[0].episodeUid}/>;
}
