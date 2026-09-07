/* eslint-disable @next/next/no-img-element */
'use client';

import { EvidenceTrigger } from './evidence-reader';
import { visibleText } from './review-semantics';
import type { StoryClaim, StoryOverview, StoryOverviewSectionId } from './story-review-types';

export const STORY_OVERVIEW_SECTIONS: Array<{ id: StoryOverviewSectionId; label: string; eyebrow: string }> = [
  { id: 'overview', label: '一眼看懂', eyebrow: 'STORY MAP' },
  { id: 'spine', label: '故事骨架', eyebrow: 'ACT × SEQ' },
  { id: 'characters', label: '人物关系', eyebrow: 'CHARACTERS' },
  { id: 'truth-route', label: '案情真实路线', eyebrow: 'CASE TRUTH' },
  { id: 'audience', label: '观众叙事与线索', eyebrow: 'AUDIENCE' },
  { id: 'space', label: '空间关系', eyebrow: 'SPACE' },
];

function ClaimCard({ label, claim }: { label: string; claim: StoryClaim }) {
  return <article className="story-structure-claim">
    <header><span className={`narrative-authority authority-${claim.class.toLowerCase()}`}>{claim.class}</span><b>{label}</b></header>
    <p>{visibleText(claim.text)}</p>
    {claim.evidenceRefs.length > 0 && <EvidenceTrigger
      refs={claim.evidenceRefs}
      heading={`${label} · 判断依据`}
      semantics="这里只展开该结构判断直接绑定的权威片段；故事结构用于创作理解，不形成正式审阅结论。"
    />}
  </article>;
}

function ResultBlock({ value }: { value: unknown }) {
  if (Array.isArray(value)) return <ol className="story-structure-result-list">{value.map((item, index) => <li key={`${index}:${String(item)}`}>{visibleText(String(item))}</li>)}</ol>;
  if (value && typeof value === 'object') return <dl className="story-structure-result-grid">{Object.entries(value as Record<string, unknown>).map(([key, item]) => <div key={key}><dt>{visibleText(key)}</dt><dd>{visibleText(String(item))}</dd></div>)}</dl>;
  return <p>{visibleText(String(value ?? 'UNKNOWN'))}</p>;
}

type Props = {
  overview: StoryOverview;
  selectedSection: StoryOverviewSectionId;
  onSelectSection: (section: StoryOverviewSectionId) => void;
  onOpenImage: (src: string, opener: HTMLElement) => void;
};

export function StoryStructureWorkbench({ overview, selectedSection, onSelectSection, onOpenImage }: Props) {
  const active = STORY_OVERVIEW_SECTIONS.find((item) => item.id === selectedSection) || STORY_OVERVIEW_SECTIONS[0];
  return <section className="story-structure-workbench" aria-label="故事结构只读总览" data-read-only="true">
    <aside className="story-structure-navigation" aria-label="故事结构分类">
      <p>STORY STRUCTURE</p>
      <h3>从全局关系理解故事</h3>
      <span>只读创作参照，不在这里审阅分集或修改剧本。</span>
      <nav>{STORY_OVERVIEW_SECTIONS.map((item, index) => <button
        type="button"
        key={item.id}
        aria-current={active.id === item.id ? 'location' : undefined}
        onClick={() => onSelectSection(item.id)}
      ><small>{String(index + 1).padStart(2, '0')} · {item.eyebrow}</small><b>{item.label}</b></button>)}</nav>
      <footer><b>{overview.sourceBindings.length}份权威源绑定</b><span>结构图是阅读入口，文字结构与哈希绑定才是核对依据。</span></footer>
    </aside>

    <div className="story-structure-content" id={`story-structure-${active.id}`}>
      <header className="story-structure-section-heading"><div><small>{active.eyebrow}</small><h3>{active.label}</h3></div><span>只读</span></header>

      {active.id === 'overview' && <div className="story-structure-overview">
        <button type="button" className="story-structure-map" onClick={(event) => onOpenImage(overview.overviewMap.imageUrl, event.currentTarget)}>
          <img src={overview.overviewMap.imageUrl} alt={visibleText(overview.overviewMap.label)} />
          <span><b>{visibleText(overview.overviewMap.label)}</b><small>{visibleText(overview.overviewMap.note)} · 点击放大</small></span>
        </button>
        <section className="story-structure-guide"><h4>阅读顺序</h4><ol><li>先看六幕与十个SEQ如何把“受辱—误杀—藏首—查案—伏法”连成一线。</li><li>再核对三条犯罪线、九颗头与证物怎样跨人物和地点汇合。</li><li>最后区分观众已知、角色误判与调查者逐步所得，避免提前揭底。</li></ol></section>
      </div>}

      {active.id === 'spine' && <div className="story-spine-view">
        <section className="story-act-strip" aria-label="六幕故事骨架">{overview.storySpine.acts.map((act) => <article key={act.id}><small>{act.id} · {act.sceneStart}–{act.sceneEnd}</small><b>{visibleText(act.title.text)}</b></article>)}</section>
        <div className="story-sequence-flow">{overview.storySpine.sequences.map((sequence) => <article key={sequence.id}>
          <header><span>{String(sequence.order).padStart(2, '0')}</span><div><small>{sequence.id} · {sequence.sceneIds[0]}–{sequence.sceneIds.at(-1)}</small><h4>{visibleText(sequence.title.text)}</h4></div></header>
          <div className="story-structure-claim-grid"><ClaimCard label="发生什么" claim={sequence.summary} /><ClaimCard label="承担作用" claim={sequence.structuralRole} /><ClaimCard label="关键转折" claim={sequence.turningPoint.event} /><ClaimCard label="结束状态" claim={sequence.outputState[0]} /></div>
        </article>)}</div>
      </div>}

      {active.id === 'characters' && <div className="story-character-lines">{overview.characterLines.map((character) => <article key={character.id}>
        <header><small>{character.id}</small><h4>{visibleText(character.name)}</h4></header>
        <dl><div><dt>故事功能</dt><dd>{visibleText(character.storyFunction)}</dd></div><div><dt>人物路线</dt><dd>{visibleText(character.arc)}</dd></div></dl>
        {character.evidenceRefs.length > 0 && <EvidenceTrigger refs={character.evidenceRefs} heading={`${character.name} · 人物依据`} semantics="核对人物功能与表演级重构所绑定的来源；这里不替代逐场正文审阅。" />}
      </article>)}</div>}

      {active.id === 'truth-route' && <div className="story-truth-route">{overview.truthRoute.map((item, index) => <article key={item.id}>
        <header><span>{String(index + 1).padStart(2, '0')}</span><div><small>{item.id} · {visibleText(item.status)}</small><h4>{visibleText(item.name)}</h4></div></header>
        <ResultBlock value={item.result} />
        {item.note && <p className="story-structure-note">边界：{visibleText(item.note)}</p>}
      </article>)}</div>}

      {active.id === 'audience' && <div className="story-audience-view">
        <section className="story-causal-flow"><h4>九条铺垫—回收链</h4>{overview.causalChains.map((chain) => <article key={chain.id}><header><small>{chain.id}</small><b>{visibleText(chain.title)}</b></header><div><span>铺垫 {chain.setupSceneIds.join('、')}</span><i>→</i><span>回收 {chain.payoffSceneIds.join('、')}</span></div><p>{visibleText(chain.mustPreserve)}</p></article>)}</section>
        <section className="story-audience-threads"><h4>误导、揭晓与线索</h4>{overview.audienceThreads.map((thread) => <article key={thread.id}><header><small>{thread.id}</small><span>{thread.functions.join(' · ')}</span></header><p>{visibleText(thread.title)}</p><footer>{thread.sceneIds.length ? thread.sceneIds.join('、') : '全局背景'} · {visibleText(thread.adaptationStatus)}</footer></article>)}</section>
      </div>}

      {active.id === 'space' && <div className="story-space-view">
        <p className="story-space-orientation">统一方向：{visibleText(overview.spatialSummary.orientation)}。这里只呈现理解剧情所需的地点关系；机位、区域与冻结点仍留在制作空间圣经。</p>
        <section className="story-space-maps">{overview.spatialSummary.mapCards.map((card) => <button type="button" key={card.id} onClick={(event) => onOpenImage(card.imageUrl, event.currentTarget)}><img src={card.imageUrl} alt={visibleText(card.label)} /><span><b>{visibleText(card.label)}</b><small>{visibleText(card.note)}</small></span></button>)}</section>
        <section className="story-location-list">{overview.spatialSummary.locations.map((location) => <article key={location.id}><small>{location.id} · {visibleText(location.zone)}</small><h4>{visibleText(location.name)}</h4><p>{visibleText(location.fact)}</p></article>)}</section>
      </div>}
    </div>
  </section>;
}
