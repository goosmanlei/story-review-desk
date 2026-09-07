import { expect, test } from '@playwright/test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import type * as EpisodeLogicModule from '../app/episode-logic-review';

// Playwright uses its own JSX runtime even when tsconfig says react-jsx.
// Compile the product component and all local JSX dependencies through esbuild;
// execute only this in-memory artifact with the application's real React runtime.
const requireFromApp = createRequire(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../package.json'));
const compiled = buildSync({
  entryPoints: [path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../app/episode-logic-review.tsx')],
  bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic',
  packages: 'external', write: false, logLevel: 'silent',
});
const artifact: { exports: Partial<typeof EpisodeLogicModule> } = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(requireFromApp, artifact, artifact.exports);
const { EpisodeLogicReview, EpisodeLogicSummary, normalizeLogicSelection } = artifact.exports as typeof EpisodeLogicModule;
import { episodeReviewCriteria } from '../app/episode-review-criteria';
import type { EpisodeReviewDossierV11, StoryClaim } from '../app/story-review-types';

const claim = (text: string): StoryClaim => ({ class: 'A', text, evidenceRefs: [] });
const dossier: EpisodeReviewDossierV11 = {
  schemaVersion: '1.1',
  purpose: { episodeTask: claim('任务唯一标记'), characterAction: claim('人物行动唯一标记'), expressionFocus: claim('表达重点唯一标记') },
  progressionSlices: [{ sliceId: 'episode:two:SEQ-01', sequenceId: 'SEQ-01', sequenceTitle: claim('序列'), sceneIds: ['S02'], coverageRole: 'EPISODE_SLICE', structuralRole: claim('本集的序列作用'), turningPoint: claim('转折唯一标记'), audienceGain: claim('观众增量唯一标记'), outputState: claim('终点唯一标记') }],
  informationLayers: { visibleAction: claim('可见行动'), hiddenTruth: { class: 'F', text: '案情真相唯一标记', evidenceRefs: [] }, audiencePosition: claim('观众此刻所得'), characterKnowledge: [{ subjectId: 'character:a', knowledge: claim('甲不知道信的作者') }] },
  payoff: { deliveredResult: claim('阶段兑现唯一标记'), changedState: claim('状态改变唯一标记'), unresolvedQuestions: [claim('有意留给观众的问题')] },
  comedyBeats: [], causalChainIds: ['cause:letter'],
  sceneFlow: [{ sceneId: 'S02', function: claim('S02在本集的独立作用') }],
  boundaryEvidence: { opening: { sceneId: 'S02', sceneScriptRevisionId: 'scene:2', sceneContentHash: 'a'.repeat(64), blockIds: ['block:opening'], excerptSha256: 'b'.repeat(64) }, ending: { sceneId: 'S02', sceneScriptRevisionId: 'scene:2', sceneContentHash: 'a'.repeat(64), blockIds: ['block:ending'], excerptSha256: 'c'.repeat(64) } },
  authoringUnknowns: [{ class: 'U', text: '资料待核唯一标记', evidenceRefs: [] }],
};
function props(group: Parameters<typeof EpisodeLogicReview>[0]['selectedGroupId']): Parameters<typeof EpisodeLogicReview>[0] {
  const episode = { episodeId: 'E02', episodeUid: 'episode:two', title: '第二集', sceneIds: ['S02'], openingHook: claim('开场设计'), coreAdvance: claim('核心推进唯一标记'), endingCliffhanger: claim('结尾设计'), reviewDossier: dossier };
  const excerpt = (sceneId: string, text: string) => ({ sceneId, blocks: [{ id: `${sceneId}:block`, type: 'action', text, speaker: '', performanceNote: '' }] });
  return {
    episode, previousEpisode: { ...episode, episodeId: 'E01', episodeUid: 'episode:one', sceneIds: ['S01'] }, nextEpisode: { ...episode, episodeId: 'E03', episodeUid: 'episode:three', sceneIds: ['S03'] },
    presentation: { 'episode:one': { opening: null, ending: excerpt('S01', '上集实际结尾独立文本') }, 'episode:two': { opening: excerpt('S02', '本集实际开场独立文本'), ending: excerpt('S02', '本集实际结尾独立文本') }, 'episode:three': { opening: excerpt('S03', '下集实际开场独立文本'), ending: null } },
    causalChains: [{ id: 'cause:letter', title: '信件铺垫与回收', setupSceneIds: ['S01', 'S02'], payoffSceneIds: ['S03'], status: 'PENDING_PAYOFF', mustPreserve: '开信之前不能知道落款身份' }],
    selectedGroupId: group, selectedItemId: '', criterionStates: episodeReviewCriteria(1, 3).map(item => ({ id: item.id, label: item.label, verdict: '', note: '' })),
    onSelect: () => {}, onOpenScene: () => {},
  };
}
const render = (group: Parameters<typeof EpisodeLogicReview>[0]['selectedGroupId']) => renderToStaticMarkup(createElement(EpisodeLogicReview, props(group)));

test('the material directory renders exactly six group entries', () => {
  const html = render('episode-purpose');
  expect((html.match(/data-logic-group=/g) || []).length).toBe(6);
  expect((html.match(/data-review-group-id=/g) || []).length).toBe(1);
  for (const text of ['任务唯一标记', '核心推进唯一标记', '人物行动唯一标记', '表达重点唯一标记', 'S02在本集的独立作用']) expect(html).toContain(text);
});

test('cross-episode causal chains preserve both endpoints and the current episode responsibility', () => {
  const html = render('information-causality');
  for (const text of ['S01（他集）', 'S02（本集）', 'S03（他集）', '开信之前不能知道落款身份', '本集责任：', '甲不知道信的作者']) expect(html).toContain(text);
  expect(html).not.toContain('data-review-group-id="episode-payoff"');
});

test('boundary evidence compares actual neighbouring excerpts rather than repeating only claims', () => {
  const opening = render('opening-boundary');
  expect(opening).toContain('上集实际结尾独立文本');
  expect(opening).toContain('本集实际开场独立文本');
  expect(opening).not.toContain('下集实际开场独立文本');
  const ending = render('ending-propulsion');
  expect(ending).toContain('本集实际结尾独立文本');
  expect(ending).toContain('下集实际开场独立文本');
});

test('authoring unknowns and deliberately unresolved story questions remain different sections', () => {
  const html = render('episode-payoff');
  expect(html).toContain('id="logic-unresolved-questions"');
  expect(html).toContain('class="episode-authoring-unknowns"');
  expect(html).toContain('有意留给观众的问题');
  expect(html).toContain('资料待核唯一标记');
  expect(html.indexOf('有意留给观众的问题')).toBeLessThan(html.indexOf('episode-authoring-unknowns'));
});

test('first, last, and single episodes receive contextual questions while all six IDs remain stable', () => {
  const first = episodeReviewCriteria(0, 7); const middle = episodeReviewCriteria(3, 7); const last = episodeReviewCriteria(6, 7); const single = episodeReviewCriteria(0, 1);
  const ids = middle.map(item => item.id);
  for (const criteria of [first, middle, last, single]) expect(criteria.map(item => item.id)).toEqual(ids);
  expect(first[0].question).not.toMatch(/上集|上一集/);
  expect(middle[0].question).toMatch(/上集/);
  expect(last[5].question).not.toMatch(/下一集|下集/);
  expect(last[5].question).toMatch(/终局|闭合/);
  expect(single[0].question).toBe(first[0].question);
  expect(single[5].question).toBe(last[5].question);
});

for (const [group, item] of [['episode-purpose', 'core-advance'], ['escalation-turn', 'slice-seq-01'], ['information-causality', 'causal-chains'], ['ending-propulsion', 'outgoing-handoff']]) {
  test(`legacy ${group}/${item} deep link keeps its group and anchor`, () => {
    expect(normalizeLogicSelection(group, item, dossier)).toEqual({ groupId: group, itemId: item });
  });
}

test('global summary is a separate slot while integrated material keeps all six menu identities',()=>{
 const input=props('episode-purpose'),summary=renderToStaticMarkup(createElement(EpisodeLogicSummary,input)),columns=renderToStaticMarkup(createElement(EpisodeLogicReview,{...input,hideSummary:true}));
 expect(summary).toContain('aria-label="本集全局概要"');expect(summary).toContain('data-episode-uid="episode:two"');
 for(const text of ['任务唯一标记','开场设计','状态改变唯一标记'])expect(summary).toContain(text);
 expect(columns).not.toContain('class="episode-logic-summary"');expect(columns).toContain('class="episode-logic-columns"');
 expect((columns.match(/data-logic-group=/g)||[]).length).toBe(6);expect(columns).toContain('S02在本集的独立作用');expect(columns).toContain('data-review-group-id="episode-purpose"');
});

test('概要总估时只累加本集完整估时，缺失任何一场保持UNKNOWN且不借邻集',()=>{
 const input=props('episode-purpose'),episode={...input.episode,sceneIds:['scene-a','scene-b']};
 const runtime=(value:number)=>({baseSec:value,compactSec:value,spaciousSec:value,dialogueChars:0,dialogueSec:0,actionSec:value,reactionSec:0,transitionSec:0,overlapSec:0,rationale:'独立合成估时',confidence:'中'});
 const missing=renderToStaticMarkup(createElement(EpisodeLogicSummary,{...input,episode,sceneRuntimes:{'scene-a':runtime(30),'unrelated':runtime(999)}}));
 expect(missing).toContain('净片长预估：UNKNOWN');expect(missing).not.toContain('16分39秒');
 const complete=renderToStaticMarkup(createElement(EpisodeLogicSummary,{...input,episode,sceneRuntimes:{'scene-a':runtime(30),'scene-b':runtime(70),'unrelated':runtime(999)}}));
 expect(complete).toContain('净片长预估：1分40秒');expect(complete).not.toContain('16分39秒');expect(complete).not.toContain('本集拆解与审阅');
});
