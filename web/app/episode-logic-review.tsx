'use client';

import { episodeReviewCriteria } from './episode-review-criteria';
import type { EpisodePlanContext, EpisodeExcerpt } from './episode-plan-context';
import { useEffect, useRef, createContext, useContext } from 'react';
import { CommentScriptBlocks, DesignText } from './story-comments';
import { commentItemId } from './story-comment-model';
const EpisodeCommentIdentity = createContext('');
import type { EpisodeCriterionId, EpisodeCriterionState } from './episode-plan-workbench';
import { visibleText } from './review-semantics';
import type { EpisodeReviewDossier, StoryClaim } from './story-review-types';
import {runtimeLabel,type RuntimeEstimate} from './narrative-revision';

type EpisodeSummary = {
  episodeId: string;
  episodeUid: string;
  title: string;
  sceneIds: string[];
  openingHook: StoryClaim;
  coreAdvance: StoryClaim;
  endingCliffhanger: StoryClaim;
  reviewDossier: EpisodeReviewDossier;
};

type CausalChain = {
  id: string;
  title: string;
  setupSceneIds: string[];
  payoffSceneIds: string[];
  status: string;
  mustPreserve: string;
};

export type LogicItem = { id: string; label: string; hint: string };
export type LogicGroup = { id: EpisodeCriterionId; label: string; items: LogicItem[] };

export function logicGroupsForEpisode(dossier: EpisodeReviewDossier): LogicGroup[] {
  return [
    { id: 'opening-boundary', label: '起集点', items: [
      { id: 'incoming-handoff', label: '入集衔接', hint: '上集结尾 → 本集开场' },
      { id: 'opening-hook', label: '开场钩子', hint: '本集最先抓住观众的冲突' },
    ] },
    { id: 'episode-purpose', label: '本集任务', items: [
      { id: 'episode-task', label: '结构任务', hint: '这一集必须完成什么' },
      { id: 'core-advance', label: '核心推进', hint: '本集怎样把主剧情往前推' },
      { id: 'character-action', label: '人物行动主线', hint: '谁在推动任务' },
      { id: 'expression-focus', label: '重点表达', hint: '希望观众最终理解什么' },
    ] },
    { id: 'escalation-turn', label: '递进与转折', items: [
      ...dossier.progressionSlices.map((slice) => ({
        id: `slice-${slice.sequenceId.toLowerCase()}`,
        label: `${slice.sequenceId} · ${slice.sceneIds[0]}–${slice.sceneIds.at(-1)}`,
        hint: slice.coverageRole === 'EPISODE_SLICE' ? '只审本集覆盖切片' : '本集完整覆盖该SEQ',
      })),
      { id: 'key-turns', label: '关键转折', hint: '状态真正发生变化的位置' },
      ...(dossier.comedyBeats.length ? [{ id: 'comedy-rhythm', label: '笑点与节奏', hint: '仅在本集确有作者化笑点时出现' }] : []),
    ] },
    { id: 'information-causality', label: '信息与因果', items: [
      { id: 'visible-action', label: '明线行动', hint: '画面上正在发生什么' },
      { id: 'hidden-truth', label: '暗线真相', hint: '人物尚未掌握的事实' },
      { id: 'audience-position', label: '观众所得', hint: '观众此刻比谁多知道什么' },
      { id: 'causal-chains', label: '因果链', hint: '本集关联的铺垫与回收' },
    ] },
    { id: 'episode-payoff', label: '本集回报', items: [
      { id: 'delivered-result', label: '兑现结果', hint: '本集实际交付了什么' },
      { id: 'changed-state', label: '状态变化', hint: '人物或案件到达哪里' },
      { id: 'unresolved-questions', label: '尚未解决', hint: '有意留给后续的问题' },
    ] },
    { id: 'ending-propulsion', label: '断集与追看', items: [
      { id: 'ending-cliffhanger', label: '结尾悬念', hint: '本集动作自然产生的断点' },
      { id: 'outgoing-handoff', label: '出集衔接', hint: '本集结尾 → 下集开场' },
    ] },
  ];
}

export function firstLogicItem(groupId: EpisodeCriterionId, dossier: EpisodeReviewDossier) {
  return logicGroupsForEpisode(dossier).find((group) => group.id === groupId)?.items[0]?.id || 'incoming-handoff';
}

export function normalizeLogicSelection(groupId: string | null, itemId: string | null, dossier: EpisodeReviewDossier) {
  const groups = logicGroupsForEpisode(dossier);
  const group = groups.find((candidate) => candidate.id === groupId) || groups.find((candidate) => candidate.items.some((item) => item.id === itemId)) || groups[0];
  const item = group.items.find((candidate) => candidate.id === itemId) || group.items[0];
  return { groupId: group.id, itemId: item.id };
}

const authorityMeaning: Record<StoryClaim['class'], string> = {
  A: '改编判断',
  F: '当前剧本或审计事实',
  L: '制作锁定',
  U: '尚未确认',
};

function ClaimCard({ label, claim, fieldId, episodeUid }: { label?: string; claim: StoryClaim; fieldId?:string; episodeUid?:string }) {
  const currentEpisodeUid=useContext(EpisodeCommentIdentity);
  return <section className="episode-logic-claim-block">
    <article className="episode-logic-claim narrative-claim" data-content-role="primary">
      <header>
        {label && <b>{label}</b>}
        <span className={`episode-logic-authority authority-${claim.class.toLowerCase()}`}>{claim.class} · {authorityMeaning[claim.class]}</span>
      </header>
      <p>{fieldId?<DesignText episodeUid={episodeUid||currentEpisodeUid} fieldId={fieldId} text={claim.text}/>:visibleText(claim.text)}</p>
      {claim.class === 'U' && claim.evidenceRefs.length === 0 && <small className="episode-logic-unknown">权威依据未明，不自动补写。</small>}
    </article>
  </section>;
}

function SceneLinks({ sceneIds, onOpenScene, sceneLabels = {}, currentSceneIds }: { sceneIds: string[]; onOpenScene: (sceneId: string) => void; sceneLabels?: Record<string,string>; currentSceneIds?: ReadonlySet<string> }) {
  return <div className="episode-logic-scenes" aria-label="关联场次">{[...new Set(sceneIds)].map((sceneId) => <button type="button" key={sceneId} data-scene-id={sceneId} onClick={() => onOpenScene(sceneId)}>{(sceneLabels[sceneId] || sceneId) + (currentSceneIds ? currentSceneIds.has(sceneId) ? '（本集）' : '（他集）' : '')}</button>)}</div>;
}

type Props = {
  plan?: EpisodePlanContext;
  reviewSpec?: EpisodePlanContext["reviewSpec"];
  episode: EpisodeSummary;
  presentation: EpisodePlanContext['presentation'];
  subjectNames?: Record<string,string>;
  sceneLabels?: Record<string,string>;
  previousEpisode: EpisodeSummary | null;
  nextEpisode: EpisodeSummary | null;
  causalChains: CausalChain[];
  selectedGroupId: EpisodeCriterionId;
  selectedItemId: string;
  selectedCausalChainId?: string | null;
  criterionStates: EpisodeCriterionState[];
  onSelect: (groupId: EpisodeCriterionId, itemId: string) => void;
  onOpenScene: (sceneId: string) => void;
  hideSummary?: boolean;
};

function ActualExcerpt({ excerpt, label, sceneLabels = {} }: { excerpt?: EpisodeExcerpt | null; label: string; sceneLabels?: Record<string,string> }) {
  return <section className="episode-actual-excerpt" data-evidence-kind="SCREENPLAY">
    <header><b>{label}</b><small>{sceneLabels[excerpt?.sceneId || ''] || excerpt?.sceneId || 'UNKNOWN'} · 当前剧本正文</small></header>
    {excerpt ? <CommentScriptBlocks sceneId={excerpt.sceneId} blocks={excerpt.blocks}/> : <p>该版本未绑定正文片段，请到场级拆解核对。不可据此视为首尾事实已确认。</p>}
  </section>;
}

export function EpisodeLogicSummary({episode,criterionStates,sceneLabels={},sceneRuntimes={}}:{episode:EpisodeSummary;criterionStates:EpisodeCriterionState[];sceneLabels?:Record<string,string>;sceneRuntimes?:Record<string,RuntimeEstimate>}){
  const sceneLabel=(id:string|undefined)=>sceneLabels[id||'']||id;
  const dossier=episode.reviewDossier;
  const runtimes=episode.sceneIds.map(id=>sceneRuntimes[id]);
  const total=runtimes.length&&runtimes.every(value=>value&&[value.baseSec,value.compactSec,value.spaciousSec].every(seconds=>Number.isFinite(seconds)&&seconds>=0))?runtimes.reduce((sum,value)=>({baseSec:sum.baseSec+value.baseSec,compactSec:sum.compactSec+value.compactSec,spaciousSec:sum.spaciousSec+value.spaciousSec}),{baseSec:0,compactSec:0,spaciousSec:0}):null;
  return <section className="episode-logic-summary" aria-label="本集全局概要" data-episode-uid={episode.episodeUid}><div className="episode-summary-heading"><b>{episode.episodeId} {episode.title} · {sceneLabel(episode.sceneIds[0])}–{sceneLabel(episode.sceneIds.at(-1))}</b><div className="episode-runtime-total"><b>净片长预估：{total?runtimeLabel(total.baseSec):'UNKNOWN'}</b><small>{total?'紧凑 '+runtimeLabel(total.compactSec)+' ／ 舒展 '+runtimeLabel(total.spaciousSec)+'。':'当前候选尚未提供完整估时。'}未锁时；片头、片尾与回顾另计。</small></div><span>{criterionStates.filter((state) => state.verdict).length}/6 项已判断</span></div><p><DesignText episodeUid={episode.episodeUid} fieldId="purpose.episodeTask" text={dossier.purpose.episodeTask.text}/></p><small>起点：<DesignText episodeUid={episode.episodeUid} fieldId="openingHook" text={episode.openingHook.text}/></small><small>终点：<DesignText episodeUid={episode.episodeUid} fieldId="payoff.changedState" text={dossier.payoff.changedState.text}/></small></section>;
}

export function EpisodeLogicReview({ plan, reviewSpec, episode, presentation, subjectNames, sceneLabels = {}, previousEpisode, nextEpisode, causalChains, selectedGroupId, selectedItemId, selectedCausalChainId, criterionStates, onSelect, onOpenScene, hideSummary=false }: Props) {
  const sceneLabel = (id: string | undefined) => sceneLabels[id || ''] || id;
  const dossier = episode.reviewDossier;
  const enhanced = dossier.schemaVersion === '1.1' ? dossier : null;
  const groups = logicGroupsForEpisode(dossier);
  const activeGroup = groups.find((group) => group.id === selectedGroupId) || groups[0];
  const criteria = episodeReviewCriteria(previousEpisode ? 1 : 0, nextEpisode ? (previousEpisode ? 3 : 2) : (previousEpisode ? 2 : 1), enhanced ? '2.0' : '1.0',reviewSpec);
  const criterion = criteria.find((item) => item.id === activeGroup.id)!;
  const stateById = new Map(criterionStates.map((state) => [state.id, state]));
  const currentSceneSet = new Set(episode.sceneIds);
  const chains = causalChains.filter((chain) => dossier.causalChainIds.includes(chain.id));
  const previousSelection = useRef({ revisionId: plan?.revisionId, episodeUid: episode.episodeUid, groupId: selectedGroupId, itemId: selectedItemId });
  useEffect(() => {
    const previous = previousSelection.current;
    previousSelection.current = { revisionId: plan?.revisionId, episodeUid: episode.episodeUid, groupId: selectedGroupId, itemId: selectedItemId };
    // Mounting another episode must not scroll past its navigator to a default
    // criterion. Explicit criterion changes and comment anchors remain separate.
    if (!selectedItemId || previous.revisionId !== plan?.revisionId || previous.episodeUid !== episode.episodeUid
      || previous.groupId === selectedGroupId && previous.itemId === selectedItemId) return;
    const element = document.getElementById(`logic-${selectedItemId}`);
    if (element) element.scrollIntoView({ block: 'nearest' });
  }, [plan?.revisionId, episode.episodeUid, selectedGroupId, selectedItemId]);
  const fields:Record<string,string>={'opening-hook':'openingHook','episode-task':'purpose.episodeTask','core-advance':'coreAdvance','character-action':'purpose.characterAction','expression-focus':'purpose.expressionFocus','visible-action':'informationLayers.visibleAction','hidden-truth':'informationLayers.hiddenTruth','audience-position':'informationLayers.audiencePosition','delivered-result':'payoff.deliveredResult','changed-state':'payoff.changedState','ending-cliffhanger':'endingCliffhanger'};
  const claim = (id: string, label: string, value: StoryClaim) => <div id={`logic-${id}`}><ClaimCard fieldId={fields[id]} label={label} claim={value} /></div>;
  const detail = (() => {
    switch (activeGroup.id) {
      case 'opening-boundary': return <>
        {previousEpisode ? <section id="logic-incoming-handoff"><h4>上集留下什么</h4><ActualExcerpt sceneLabels={sceneLabels} label={`${previousEpisode.episodeId} 实际结尾`} excerpt={presentation[previousEpisode.episodeUid]?.ending} /><ClaimCard label="上集结尾的设计意图" claim={previousEpisode.endingCliffhanger} episodeUid={previousEpisode.episodeUid} fieldId="endingCliffhanger" /></section> : <p className="episode-logic-scope">首集独立建立人物困境与观看关注点。</p>}
        <ActualExcerpt sceneLabels={sceneLabels} label="本集实际开场" excerpt={presentation[episode.episodeUid]?.opening} />
        {claim('opening-hook', '开场的设计意图', episode.openingHook)}
      </>;
      case 'episode-purpose': return <>
        {claim('episode-task', '本集要完成什么', dossier.purpose.episodeTask)}
        {claim('core-advance', '对主剧情的推进', episode.coreAdvance)}
        {claim('character-action', '人物如何推动任务', dossier.purpose.characterAction)}
        {claim('expression-focus', '重点表达', dossier.purpose.expressionFocus)}
        {enhanced && <section className="episode-scene-flow"><h4>各场为什么留在本集</h4>{enhanced.sceneFlow.map((row) => <article key={row.sceneId}><button type="button" onClick={() => onOpenScene(row.sceneId)}>{sceneLabel(row.sceneId)}</button><span>A · <DesignText episodeUid={episode.episodeUid} fieldId={`scene:${row.sceneId}:function`} text={row.function.text}/></span></article>)}</section>}
      </>;
      case 'escalation-turn': return <>
        {dossier.progressionSlices.map((slice) => <section className="episode-logic-slice" id={`logic-slice-${slice.sequenceId.toLowerCase()}`} key={slice.sliceId}>
          <header><h4>{slice.sequenceId} · {sceneLabel(slice.sceneIds[0])}–{sceneLabel(slice.sceneIds.at(-1))}</h4><small>{slice.coverageRole === 'EPISODE_SLICE' ? '跨集段落的本集部分' : '本集完整段落'}</small></header>
          <SceneLinks sceneLabels={sceneLabels} sceneIds={slice.sceneIds} onOpenScene={onOpenScene} />
          <ClaimCard label="承担作用" claim={slice.structuralRole} fieldId={`slice:${slice.sliceId}:structuralRole`} />
          <ClaimCard label="关键转折" claim={slice.turningPoint} fieldId={`slice:${slice.sliceId}:turningPoint`} />
          <ClaimCard label="观众新得到什么" claim={slice.audienceGain} fieldId={`slice:${slice.sliceId}:audienceGain`} />
          <ClaimCard label="到达什么状态" claim={slice.outputState} fieldId={`slice:${slice.sliceId}:outputState`} />
        </section>)}
        {dossier.comedyBeats.length > 0 && <section id="logic-comedy-rhythm"><h4>笑点与节奏作用</h4>{dossier.comedyBeats.map((beat) => <div key={beat.canonicalStoryId}><SceneLinks sceneLabels={sceneLabels} sceneIds={beat.sceneIds} onOpenScene={onOpenScene} /><ClaimCard claim={beat.role} fieldId={`comedy:${beat.canonicalStoryId}`} /></div>)}</section>}
      </>;
      case 'information-causality': return <>
        {claim('visible-action', '明线：画面上的行动', dossier.informationLayers.visibleAction)}
        {claim('hidden-truth', '暗线：尚未公开的真相', dossier.informationLayers.hiddenTruth)}
        {enhanced && <section><h4>人物到本集结束时知道什么</h4>{enhanced.informationLayers.characterKnowledge.map((item) => <ClaimCard key={item.subjectId} label={item.displayName || subjectNames?.[item.subjectId] || '人物名称未登记'} claim={item.knowledge} fieldId={`knowledge:${item.subjectId}`} />)}</section>}
        {claim('audience-position', '观众到本集结束时知道什么', dossier.informationLayers.audiencePosition)}
        <section id="logic-causal-chains" className="episode-logic-causal"><h4>相关因果链</h4>{chains.length ? chains.map((chain) => {
          const responsibility = [chain.setupSceneIds.some((id) => currentSceneSet.has(id)) ? '建立铺垫' : '', chain.payoffSceneIds.some((id) => currentSceneSet.has(id)) ? '完成回收' : ''].filter(Boolean).join('、');
          return <article key={chain.id} data-cause-chain={chain.id} className={`episode-causal-row ${selectedCausalChainId === chain.id ? 'active' : ''}`}>
            <header><h4>{chain.title}</h4><small className="episode-causal-responsibility">本集责任：{responsibility || '本集没有登记铺垫或回收端点'}</small></header>
            <div className="episode-causal-flow" aria-label="铺垫至回收">
              <section><b>铺垫</b>{chain.setupSceneIds.length ? <SceneLinks sceneLabels={sceneLabels} sceneIds={chain.setupSceneIds} currentSceneIds={currentSceneSet} onOpenScene={onOpenScene}/> : <small>未登记铺垫场次</small>}</section>
              <span className="episode-causal-arrow" aria-hidden="true">→</span>
              <section><b>回收</b>{chain.payoffSceneIds.length ? <SceneLinks sceneLabels={sceneLabels} sceneIds={chain.payoffSceneIds} currentSceneIds={currentSceneSet} onOpenScene={onOpenScene}/> : <small>未登记回收场次</small>}</section>
            </div>
            <p className="episode-causal-preserve"><DesignText episodeUid={episode.episodeUid} fieldId={`chain:${chain.id}`} text={chain.mustPreserve}/></p>
          </article>;
        }) : <p>本集未登记因果链。</p>}</section>
      </>;
      case 'episode-payoff': return <>
        {claim('delivered-result', '本集兑现了什么', dossier.payoff.deliveredResult)}
        {claim('changed-state', '本集结束后的状态', dossier.payoff.changedState)}
        <section id="logic-unresolved-questions"><h4>有意留给后续的问题</h4>{dossier.payoff.unresolvedQuestions.length ? dossier.payoff.unresolvedQuestions.map((value,index) => <ClaimCard fieldId={`question:${commentItemId(value.text,index)}`} key={index} claim={value} />) : <p>没有另行保留的叙事悬念。</p>}</section>
        {enhanced && enhanced.authoringUnknowns.length > 0 && <section className="episode-authoring-unknowns"><h4>创作资料待核事项</h4><p>以下是资料的不确定项，不计为观众追看的悬念。</p>{enhanced.authoringUnknowns.map((value,index) => <ClaimCard fieldId={`unknown:${commentItemId(value.text,index)}`} key={index} claim={value} />)}</section>}
      </>;
      case 'ending-propulsion': return <>
        <ActualExcerpt sceneLabels={sceneLabels} label="本集实际结尾" excerpt={presentation[episode.episodeUid]?.ending} />
        {claim('ending-cliffhanger', nextEpisode ? '停在这里的设计意图' : '终局的设计意图', episode.endingCliffhanger)}
        {nextEpisode ? <section id="logic-outgoing-handoff"><ActualExcerpt sceneLabels={sceneLabels} label={`${nextEpisode.episodeId} 实际开场`} excerpt={presentation[nextEpisode.episodeUid]?.opening} /><ClaimCard label="下集如何接住" claim={nextEpisode.openingHook} episodeUid={nextEpisode.episodeUid} fieldId="openingHook" /></section> : <p className="episode-logic-scope">末集检查承诺兑现、因果闭合与余韵，不要求制造下一集悬念。</p>}
      </>;
    }
  })();
  return <EpisodeCommentIdentity.Provider value={episode.episodeUid}><section className={hideSummary?'episode-logic-columns':undefined} aria-label="当前分集审阅摘要">
    {!hideSummary&&<EpisodeLogicSummary episode={episode} criterionStates={criterionStates} sceneLabels={sceneLabels}/>}
    <div className="episode-logic-reading-layout">
      <aside className="episode-logic-navigation" aria-label="本集六项判断"><nav>{criteria.map((item,index) => <button type="button" data-logic-group={item.id} key={item.id} aria-current={activeGroup.id === item.id ? 'location' : undefined} onClick={() => onSelect(item.id, firstLogicItem(item.id,dossier))}><span>{String(index+1).padStart(2,'0')}</span><b>{item.label}</b><small>{stateById.get(item.id)?.verdict === 'PASS' ? '通过' : stateById.get(item.id)?.verdict === 'FAIL' ? '有问题' : '待判断'}</small></button>)}</nav></aside>
      <main className="episode-logic-detail" id="episode-logic-detail" data-review-group-id={activeGroup.id} data-review-item-id={selectedItemId}><header><small>{episode.episodeId} · {sceneLabel(episode.sceneIds[0])}–{sceneLabel(episode.sceneIds.at(-1))}</small><h3>{criterion.label}</h3></header><div className="episode-logic-group-materials">{detail}</div></main>
    </div>
  </section></EpisodeCommentIdentity.Provider>;
}
