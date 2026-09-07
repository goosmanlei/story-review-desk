/** Real component presentation checks, with synthetic immutable authored data.
 * SSR checks never run effects. Browser checks bundle the actual components,
 * fulfil a local harness document and intercept every business API; no live DB.
 * Main page route/episode selection integration is covered by the shell suite.
 */
import {test,expect,type Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {buildSync} from 'esbuild';
import type * as Logic from '../app/episode-logic-review';
import type * as Reader from '../app/episode-scene-reading';
import type {EpisodePlanContext} from '../app/episode-plan-context';
import type {EpisodeReviewDossierV11,StoryClaim} from '../app/story-review-types';
import {episodeReviewCriteria} from '../app/episode-review-criteria';
import {storyCommentSources} from '../app/story-comment-model';

const site=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),requireFromApp=createRequire(path.join(site,'package.json'));
const entry="export {EpisodeLogicReview} from './app/episode-logic-review';export {EpisodeSceneReading} from './app/episode-scene-reading';";
const compiled=buildSync({stdin:{contents:entry,resolveDir:site,sourcefile:'reading-test.tsx',loader:'tsx'},bundle:true,platform:'node',format:'cjs',jsx:'automatic',packages:'external',write:false,logLevel:'silent'});
const artifact:{exports:Partial<typeof Logic & typeof Reader>}={exports:{}};
new Function('require','module','exports',compiled.outputFiles[0].text)(requireFromApp,artifact,artifact.exports);
const {EpisodeLogicReview,EpisodeSceneReading}=artifact.exports as typeof Logic & typeof Reader;
const claim=(text:string):StoryClaim=>({class:'A',text,evidenceRefs:['fixture-duplicate-source-reference']});
const dossier:EpisodeReviewDossierV11={schemaVersion:'1.1',purpose:{episodeTask:claim('本集任务原文'),characterAction:claim('人物行动原文'),expressionFocus:claim('表达重点原文')},progressionSlices:[{sliceId:'slice-permanent',sequenceId:'SEQ-01',sequenceTitle:claim('来信'),sceneIds:['scene-permanent-a'],coverageRole:'EPISODE_SLICE',structuralRole:claim('推进作用原文'),turningPoint:claim('转折原文'),audienceGain:claim('观众增量原文'),outputState:claim('阶段状态原文')}],informationLayers:{visibleAction:claim('明线原文'),hiddenTruth:claim('暗线原文'),audiencePosition:claim('观众所得原文'),characterKnowledge:[]},payoff:{deliveredResult:claim('本集回报原文'),changedState:claim('结束状态原文'),unresolvedQuestions:[]},comedyBeats:[],causalChainIds:['chain-permanent'],sceneFlow:[{sceneId:'scene-permanent-a',function:claim('本场作用原文')}],boundaryEvidence:{opening:{sceneId:'scene-permanent-a',sceneScriptRevisionId:'script-a',sceneContentHash:'a'.repeat(64),blockIds:['block-permanent-a'],excerptSha256:'a'.repeat(64)},ending:{sceneId:'scene-permanent-a',sceneScriptRevisionId:'script-a',sceneContentHash:'a'.repeat(64),blockIds:['block-permanent-a'],excerptSha256:'a'.repeat(64)}},authoringUnknowns:[]};
const runtime={compactSec:30,baseSec:40,spaciousSec:50,dialogueChars:0,dialogueSec:0,actionSec:30,reactionSec:8,transitionSec:2,overlapSec:0,rationale:'动作和反应逐项估算，仍未锁时',confidence:'中'};
const scenes=['a','b'].map((id,index)=>({id:'scene-permanent-'+id,displayId:'S01',title:index?'回收场':'铺垫场',slugline:'内景 客栈 日',oldSceneIds:[],sourceSegmentIds:['source-fixture'],storyTime:'白天',viewpoint:'甲',purpose:'保留完整正文',audienceKnown:'已经收到信',audienceWithheld:'落款身份',transition:'走出门口',scriptBlocks:[{id:'block-permanent-'+id,type:'action' as const,speaker:'',performanceNote:'',text:index?'随后展开的回收场完整正文。':'本集未经改写的完整正文。'}],contentHash:(index?'b':'a').repeat(64),runtime:{...runtime}}));
const episodes=scenes.map((s,index)=>({episodeUid:'episode-permanent-'+index,displayId:'E0'+(index+1),title:index?'回收集':'铺垫集',sceneIds:[s.id],openingHook:'开场设计原文',coreAdvance:'核心推进原文',endingCliffhanger:'结尾设计原文',reviewQuestion:'本集是否成立',reviewDossier:structuredClone(dossier)}));
const chains=[{id:'chain-permanent',title:'来信的先后因果',setupSceneIds:[scenes[0].id],payoffSceneIds:[scenes[1].id],status:'PENDING_PAYOFF',mustPreserve:'看信之前不能知道落款身份。'}];
const plan:EpisodePlanContext={revisionId:'revision-reading-fixture',sourceRole:'CANDIDATE',snapshotId:'snapshot-reading-fixture',contentHash:'c'.repeat(64),contextHash:'d'.repeat(64),baseRevisionHash:'e'.repeat(64),subjectNames:{},criteriaVersion:'2.0',basisBindingsHash:null,content:{planId:'plan-reading-fixture',episodes,retiredEpisodeUids:[],narrativeRevision:{schemaVersion:'1.0',title:'完整候选阅读 fixture',baseScriptSha256:'f'.repeat(64),transcriptSha256:'f'.repeat(64),runtimeMethod:'净片长分项估算',retiredSceneIds:[],scenes,sequences:[],causalChains:chains,legacySceneEstimates:[],sourceNarrationIndex:[],documents:[]}},presentation:Object.fromEntries(episodes.map((ep,index)=>[ep.episodeUid,{opening:{sceneId:scenes[index].id,blocks:scenes[index].scriptBlocks},ending:{sceneId:scenes[index].id,blocks:scenes[index].scriptBlocks}}]))};
const groups=['opening-boundary','episode-purpose','escalation-turn','information-causality','episode-payoff','ending-propulsion'] as const;
function props(group:typeof groups[number]):Parameters<typeof EpisodeLogicReview>[0]{const ep=episodes[0];return {plan,episode:{episodeId:ep.displayId,episodeUid:ep.episodeUid,title:ep.title,sceneIds:ep.sceneIds,openingHook:claim(ep.openingHook),coreAdvance:claim(ep.coreAdvance),endingCliffhanger:claim(ep.endingCliffhanger),reviewDossier:dossier},presentation:plan.presentation,sceneLabels:Object.fromEntries(scenes.map(s=>[s.id,s.displayId])),previousEpisode:null,nextEpisode:null,causalChains:chains,selectedGroupId:group,selectedItemId:'',criterionStates:episodeReviewCriteria(0,2).map(c=>({id:c.id,label:c.label,verdict:'',note:''})),onSelect:()=>{},onOpenScene:()=>{}};}

test('选场阅读器只展示本场精确估时与正文，不借另一场数据',()=>{
 const before=JSON.stringify(plan),html=renderToStaticMarkup(createElement(EpisodeSceneReading,{plan,sceneId:scenes[0].id}));
 expect(html).toContain('class="episode-scene-rationale"');expect(html).toContain('data-scene-content-hash="'+scenes[0].contentHash+'"');expect(html).not.toContain('<details');expect(html).toContain('0分40秒');expect(html).toContain('铺垫场');expect(html).not.toContain('回收场');expect(JSON.stringify(plan)).toBe(before);
});
for(const group of groups)test(`${group}：判断材料不重复本集完整剧本，保留六项目录与原卷宗`,()=>{
 const before=JSON.stringify(plan),html=renderToStaticMarkup(createElement(EpisodeLogicReview,props(group)));
 expect(html).not.toContain('episode-full-script');expect(html).not.toContain('data-full-script-scene');expect(html).toContain('data-review-group-id="'+group+'"');expect((html.match(/data-logic-group=/g)||[])).toHaveLength(6);expect(html).not.toContain('分集判断依据');expect(html).not.toContain('evidence-inline');expect(JSON.stringify(plan)).toBe(before);
});
test('紧凑因果链仍保留跨集两端、原文和本集责任，端点不带跳往audit的href',()=>{
 const html=renderToStaticMarkup(createElement(EpisodeLogicReview,props('information-causality')));
 for(const value of ['episode-causal-flow','data-scene-id="scene-permanent-a"','data-scene-id="scene-permanent-b"','S01（本集）','S01（他集）','本集责任：','建立铺垫','看信之前不能知道落款身份。'])expect(html).toContain(value);
 expect(html).not.toContain('storyMode=audit');expect((html.match(/data-scene-id="scene-permanent-b"/g)||[])).toHaveLength(1);
});
test('上方读者无自身评论provider与独立正式审阅，保留永久正文块和内容hash',()=>{
 const before=JSON.stringify(plan),html=renderToStaticMarkup(createElement(EpisodeSceneReading,{plan,sceneId:scenes[0].id}));
 for(const text of ['本场完整正文','本集未经改写的完整正文。','data-block-id="block-permanent-a"','data-scene-id="scene-permanent-a"','data-scene-content-hash="'+scenes[0].contentHash+'"'])expect(html).toContain(text);
 for(const text of ['本场正式审阅','scene-narrative-review','story-comment-surface','story-comment-trigger','分集与场次'])expect(html).not.toContain(text);
 expect(JSON.stringify(plan)).toBe(before);
});

let browserCode:string|undefined;
async function browserFixture(page:Page){
 if(!browserCode){
  const code=`import React,{useState} from 'react';import{createRoot}from'react-dom/client';${entry.replaceAll('export {','import {')}import{StoryCommentsProvider}from'./app/story-comments';const plan=${JSON.stringify(plan)},baseProps=${JSON.stringify(props('episode-purpose'))};function App(){const[group,setGroup]=useState('episode-purpose'),[scene,setScene]=useState(plan.content.episodes[0].sceneIds[0]);const episode=plan.content.episodes.find(ep=>ep.sceneIds.includes(scene));return <main><output data-selected-scene>{scene}</output><StoryCommentsProvider plan={plan} episodeUid={episode.episodeUid}><EpisodeSceneReading plan={plan} sceneId={scene}/><EpisodeLogicReview {...baseProps} plan={plan} episode={{...baseProps.episode,episodeUid:episode.episodeUid,episodeId:episode.displayId,title:episode.title,sceneIds:episode.sceneIds,reviewDossier:episode.reviewDossier}} selectedGroupId={group} onSelect={setGroup} onOpenScene={setScene}/></StoryCommentsProvider></main>}createRoot(document.getElementById('root')).render(<App/>);`;
  browserCode=buildSync({stdin:{contents:code,resolveDir:site,sourcefile:'narrative-reading-harness.tsx',loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',write:false,logLevel:'silent',define:{'process.env.NODE_ENV':'"production"'}}).outputFiles[0].text;
 }
 const css=readFileSync(path.join(site,'app/globals.css'),'utf8')+'\n'+readFileSync(path.join(site,'app/narrative-reading.css'),'utf8')+'\n'+readFileSync(path.join(site,'app/episode-scene-navigator.css'),'utf8');
 const state={errors:[] as string[],unexpected:[] as string[],writes:[] as string[],commentScopes:[] as string[]};page.on('pageerror',e=>state.errors.push(e.message));
 const targets=storyCommentSources(plan).map(t=>({...t,revisionId:plan.revisionId,planContentHash:plan.contentHash,contentHash:'a'.repeat(64),contextHash:'b'.repeat(64)}));
 await page.route('**/api/**',async route=>{const request=route.request(),url=new URL(request.url());if(request.method()!=='GET'){state.writes.push(request.method()+' '+url.pathname);return route.fulfill({status:405,json:{error:'READ_ONLY_FIXTURE'}});}
  if(url.pathname==='/api/v8/script-comments'){state.commentScopes.push(url.search);return route.fulfill({json:{snapshotId:plan.snapshotId,revisionId:plan.revisionId,planContentHash:plan.contentHash,targets,threads:[],closedHistory:[]}});}
  if(url.pathname==='/api/v8/ui/scene-review-context'){const scene=scenes.find(s=>s.id===url.searchParams.get('sceneId'))!,episode=episodes.find(e=>e.sceneIds.includes(scene.id))!;return route.fulfill({json:{context:{revisionId:plan.revisionId,planContentHash:plan.contentHash,snapshotId:plan.snapshotId,sceneId:scene.id,sceneContentHash:scene.contentHash,episodeUid:episode.episodeUid,contextHash:'d'.repeat(64),upstreamState:'PENDING_REVIEW',episode:{displayId:episode.displayId,title:episode.title,scenePosition:1,sceneCount:1},requirements:[],neighbours:[],chains:[],sceneLabels:Object.fromEntries(scenes.map(s=>[s.id,s.displayId])),missing:[],reviewSpec:{criteria:[]},formalTarget:null,formalBlockReason:'等待上游正式确认'}}});}
  state.unexpected.push(url.pathname);return route.fulfill({status:418,json:{error:'UNEXPECTED_FIXTURE_API'}});
 });
 await page.route('**/__narrative-reading-fixture',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'</style></head><body><div id="root"></div><script>'+browserCode!.replaceAll('</script','<\\/script')+'</script></body></html>'}));
 await page.goto('/__narrative-reading-fixture');return state;
}
test('真实浏览器：因果端点以永久场ID更新上方阅读器，判断材料与原评论保持可达',async({page})=>{
 const f=await browserFixture(page);await page.locator('[data-logic-group="information-causality"]').click();await expect(page.locator('[data-comment-block="chain:chain-permanent"]')).toHaveText(chains[0].mustPreserve);
 await page.locator('.episode-causal-flow [data-scene-id="scene-permanent-b"]').click();await expect(page.locator('[data-selected-scene]')).toHaveText(scenes[1].id);await expect(page.locator('.episode-scene-reader')).toHaveAttribute('data-scene-id',scenes[1].id);await expect(page.locator('.episode-logic-navigation')).toBeVisible();await expect(page.getByRole('navigation',{name:'分集与场次'})).toHaveCount(0);await expect(page.locator('[data-comment-block="block-permanent-b"]')).toHaveText(scenes[1].scriptBlocks[0].text);await expect(page.getByRole('heading',{name:'本场正式审阅',exact:true})).toHaveCount(0);expect(new URL(page.url()).pathname).toBe('/__narrative-reading-fixture');expect(new URL(page.url()).search).toBe('');
 expect(f.commentScopes.some(q=>new URLSearchParams(q).get('episodeUid')===episodes[1].episodeUid)).toBe(true);expect(f.writes).toEqual([]);expect(f.unexpected).toEqual([]);expect(f.errors).toEqual([]);
});
test('真实浏览器：切六判断只更新材料，上方唯一完整正文不卸载，手机无横向溢出',async({page})=>{
 await page.setViewportSize({width:390,height:844});const f=await browserFixture(page),reader=page.locator('.episode-scene-reader'),body=reader.locator('[data-block-id="block-permanent-a"]');await expect(body).toBeVisible();
 await reader.evaluate(element=>element.setAttribute('data-reading-probe','stable'));const reads=f.commentScopes.length;
 for(const group of groups){await page.locator(`[data-logic-group="${group}"]`).click();await expect(reader).toHaveAttribute('data-reading-probe','stable');await expect(body).toBeVisible();await expect(page.locator('.episode-full-script')).toHaveCount(0);await expect(page.locator('.episode-logic-detail .evidence-inline')).toHaveCount(0);}
 await expect(page.locator('.episode-scene-reader')).toHaveCount(1);await expect(page.locator('.story-comment-surface')).toHaveCount(1);expect(f.commentScopes.length).toBe(reads);expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(390);expect(f.writes).toEqual([]);expect(f.unexpected).toEqual([]);expect(f.errors).toEqual([]);
});
