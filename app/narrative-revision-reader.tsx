'use client';
import { useState } from 'react';
import { StoryCommentsProvider, CommentScriptBlocks } from './story-comments';
import {useSceneNarrativeContext,SceneNarrativeRequirements,SceneNarrativeReview} from './scene-narrative-panel';
import { DocumentBlocks, type DocumentBlock } from './document-blocks';
import type { EpisodePlanContext } from './episode-plan-context';
import { NARRATIVE_OVERVIEW_SECTIONS, runtimeLabel, runtimeTotal, type NarrativeOverviewSection, type NarrativeRevision, type RuntimeEstimate } from './narrative-revision';

function AuthoredDocument({ text }: {text: string}) {
  const paragraphs = text.trim().split(/\n\s*\n/);
  const blocks: DocumentBlock[] = paragraphs.map((paragraph, index) => {
    const base = {id: `narrative-doc-${index}`, sourceLineStart: 0, sourceLineEnd: 0};
    const heading = /^(#{1,6}) (.+)$/.exec(paragraph);
    if (heading) return {...base, type: 'heading', level: Math.max(3, heading[1].length + 1), text: heading[2]};
    const lines = paragraph.split('\n');
    if (lines.length > 2 && /^\|[ :|\-]+\|$/.test(lines[1])) {
      const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map(value => value.trim());
      return {...base,type: 'table',headers: cells(lines[0]),rows: lines.slice(2).map(cells)};
    }
    if (lines.every(line => /^[-*] /.test(line))) return {...base,type: 'list',items:lines.map(line => line.slice(2))};
    return {...base,type: 'paragraph',text: paragraph};
  });
  return <DocumentBlocks blocks={blocks}/>;
}
function Timing({ runtime }: {runtime: Pick<RuntimeEstimate,'baseSec'|'compactSec'|'spaciousSec'>}) {
  return <><b>{runtimeLabel(runtime.baseSec)}</b><small>紧凑 {runtimeLabel(runtime.compactSec)} ／ 舒展 {runtimeLabel(runtime.spaciousSec)}</small></>;
}
export function NarrativeEpisodeTiming({ narrative, sceneIds }: {narrative: NarrativeRevision; sceneIds: string[]}) {
  const scenes = sceneIds.map((id) => narrative.scenes.find((scene) => scene.id === id)!);
  const total = runtimeTotal(scenes);
  return <section className="narrative-timing"><h3>本集净片长预估：{runtimeLabel(total.baseSec)}</h3><p>紧凑 {runtimeLabel(total.compactSec)} ／ 舒展 {runtimeLabel(total.spaciousSec)}。未锁时；片头、片尾与回顾另计。</p><h4>各场估时与依据</h4><div className="narrative-table-scroll"><table><thead><tr><th>场次</th><th>基准</th><th>紧凑—舒展</th><th>时长依据</th></tr></thead><tbody>{scenes.map((scene) => <tr key={scene.id}><td>{scene.displayId} {scene.title}</td><td>{runtimeLabel(scene.runtime.baseSec)}</td><td>{runtimeLabel(scene.runtime.compactSec)}—{runtimeLabel(scene.runtime.spaciousSec)}</td><td>{scene.runtime.rationale}</td></tr>)}</tbody></table></div></section>;
}

export function NarrativeRevisionReader({ plan, selectedSceneId, onSelectScene, embedded = false }: { plan: EpisodePlanContext; selectedSceneId?: string | null; onSelectScene: (id: string) => void; embedded?: boolean }) {
  const narrative = plan.content.narrativeRevision!;
  const exactScene = narrative.scenes.find((scene) => scene.id === selectedSceneId);
  const requestedScene = exactScene || narrative.scenes[0];
  const inheritance = useSceneNarrativeContext(plan, requestedScene.id);
  const [highlightedBlocks,setHighlightedBlocks] = useState<string[]>([]);
  function locate(blockIds:string[]){
    setHighlightedBlocks(blockIds);
    const element=blockIds.length ? document.getElementById(blockIds[0]) : document.getElementById(`scene-body-${requestedScene.id}`);
    element?.scrollIntoView({behavior:'smooth',block:'center'});element?.focus({preventScroll:true});
  }
  if (selectedSceneId && !exactScene) return <section><h2>无法定位此场</h2><p>请从当前分集与场次目录重新选择。</p><button type="button" onClick={() => onSelectScene(narrative.scenes[0].id)}>打开首场</button></section>;
  const scene = exactScene || narrative.scenes[0];
  const episode = plan.content.episodes.find((episode) => episode.sceneIds.includes(scene.id))!;
  return <StoryCommentsProvider key={`${plan.revisionId}:${scene.id}`} plan={plan} sceneId={scene.id}><section className={`narrative-reader${embedded ? ' is-embedded' : ''}`}>
    {!embedded && <header><h2>{narrative.title}</h2><p>{plan.sourceRole==='CURRENT'?'当前已生效稿':'完整待审稿'} · {plan.content.episodes.length} 集 / {narrative.scenes.length} 场。{plan.sourceRole==='CURRENT'?'分集要求已生效，结合承接材料与完整正文完成本场审阅。':'先在叙事拆解完成整套方案判断，采用并同步后再逐场正式确认。'}</p></header>}
    <div className="narrative-reader-layout">{!embedded && <nav aria-label="分集与场次">{plan.content.episodes.map((ep) => <section key={ep.episodeUid}><h3>{ep.displayId} {ep.title}</h3>{ep.sceneIds.map((id) => { const row = narrative.scenes.find((s) => s.id === id)!; return <button type="button" key={id} aria-current={id === scene.id ? 'page' : undefined} onClick={() => onSelectScene(id)}><span>{row.displayId} {row.title}</span><small>{runtimeLabel(row.runtime.baseSec)}</small></button>; })}</section>)}</nav>}
    <article className="narrative-scene" key={scene.id}><header><small>{episode.displayId} {episode.title}</small><h3>{scene.displayId} {scene.title}</h3><p>{scene.slugline}</p><div className="narrative-time-value"><Timing runtime={scene.runtime}/></div></header>
      {inheritance.context ? <SceneNarrativeRequirements context={inheritance.context} onOpenScene={onSelectScene} onLocate={locate}/> : <div className="review-bootstrap-state" role="status"><p>{inheritance.error || '正在读取本集要求与本场承接…'}</p>{inheritance.error&&<button type="button" onClick={inheritance.retry}>重新读取</button>}</div>}
      <h3 className="narrative-script-heading">本场完整正文</h3>
      <dl><dt>叙事时点与视角</dt><dd>{scene.storyTime}；跟随{scene.viewpoint}</dd><dt>本场推进</dt><dd>{scene.purpose}</dd><dt>观众此刻知道</dt><dd>{scene.audienceKnown}</dd><dt>留待后续</dt><dd>{scene.audienceWithheld}</dd></dl>
      <div className="narrative-script-body" id={`scene-body-${scene.id}`} tabIndex={-1}><CommentScriptBlocks anchorPrefix="" sceneId={scene.id} blocks={scene.scriptBlocks} highlighted={highlightedBlocks}/></div>
      <footer><p><b>出场与衔接：</b>{scene.transition}</p><p><b>估时：</b>对白 {scene.runtime.dialogueSec}秒 + 动作 {scene.runtime.actionSec}秒 + 反应／停顿 {scene.runtime.reactionSec}秒 + 转场 {scene.runtime.transitionSec}秒 − 同步重叠 {scene.runtime.overlapSec}秒。{scene.runtime.rationale}；置信度：{scene.runtime.confidence}。</p><p><b>原文依据：</b>{scene.sourceSegmentIds.join('、')}。原音精确字词未完成听辨的部分仍为 UNKNOWN。</p></footer>
    </article><aside className="narrative-review-sidebar">{inheritance.context ? <SceneNarrativeReview context={inheritance.context}/> : <section className="scene-inheritance-review"><h3>本场正式审阅</h3><p>承接上下文读取完成前，正式审阅保持关闭。</p></section>}</aside></div>
  </section></StoryCommentsProvider>;
}

export function NarrativeOverview({ plan, tab, onSelectTab }: {plan: EpisodePlanContext; tab: NarrativeOverviewSection; onSelectTab: (tab: NarrativeOverviewSection)=>void}) {
  const narrative = plan.content.narrativeRevision!;
  const total = runtimeTotal(narrative.scenes);
  const label = (id: string) => narrative.scenes.find((scene) => scene.id === id)?.displayId || id;
  return <section className="narrative-overview"><header><h2>故事结构与创作说明</h2><p>{plan.content.episodes.length} 集 · {narrative.scenes.length} 场 · 基准净片长 {runtimeLabel(total.baseSec)}，估算区间 {runtimeLabel(total.compactSec)}—{runtimeLabel(total.spaciousSec)}。{plan.sourceRole==='CURRENT'?'当前为已生效方案。':'当前为待审候选。'}</p></header>
    <nav aria-label="故事结构资料">{NARRATIVE_OVERVIEW_SECTIONS.map(({id,label}) => <button key={id} type="button" aria-pressed={tab === id} onClick={() => onSelectTab(id)}>{label}</button>)}</nav>
    {tab === 'structure' && <><p>{narrative.runtimeMethod}</p>{plan.content.episodes.map((episode) => <article key={episode.episodeUid}><h3>{episode.displayId} {episode.title} · {runtimeLabel(runtimeTotal(narrative.scenes.filter((scene) => episode.sceneIds.includes(scene.id))).baseSec)}</h3><p>{episode.coreAdvance}</p><p><b>开场：</b>{episode.openingHook}</p><p><b>结尾：</b>{episode.endingCliffhanger}</p><p>{episode.sceneIds.map((id) => { const scene = narrative.scenes.find((s) => s.id === id)!; return `${scene.displayId} ${scene.title}（${scene.viewpoint}）`; }).join(' → ')}</p></article>)}</>}
    {tab === 'causality' && narrative.causalChains.map((chain) => <article key={chain.id}><h3>{chain.title}</h3><p>{chain.mustPreserve}</p><p>铺垫：{chain.setupSceneIds.map(label).join('、')} → 回收：{chain.payoffSceneIds.map(label).join('、')}</p></article>)}
    {tab === 'documents' && narrative.documents.map((doc) => <article key={doc.id}>{!/^#{1,6}\s+/.test(doc.text.trimStart())||doc.text.trimStart().split('\n')[0].replace(/^#{1,6}\s+/,'').trim()!==doc.title.trim()?<h3>{doc.title}</h3>:null}<div className="narrative-document"><AuthoredDocument text={doc.text}/></div></article>)}
  </section>;
}
