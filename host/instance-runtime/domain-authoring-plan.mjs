import {createHash} from 'node:crypto';
import {domainHash} from './domain-model.mjs';
const fail=message=>{throw Object.assign(new Error(message),{code:'DOMAIN_INVALID'});};
const nonempty=value=>typeof value==='string'&&Boolean(value.trim());
const list=value=>Array.isArray(value);
function claim(value,classes){if(!value||!classes.includes(value.class)||!nonempty(value.text)||!list(value.evidenceRefs)||value.class!=='U'&&!value.evidenceRefs.length)fail('审阅卷宗必须区分作者判断、事实与未知，并提供来源引用');}
export function authoringBlocks(root){return root.scriptBlocks||root.body.split(/\n\s*\n/).filter(s=>s.trim()).map((text,index)=>({id:`${root.id}-B${String(index+1).padStart(3,'0')}`,type:'action',speaker:'',performanceNote:'',text}));}
export function authoringBoundary(root,side){const blocks=authoringBlocks(root),block=side==='opening'?blocks[0]:blocks.at(-1);return{sceneId:root.id,sceneScriptRevisionId:root.revisionId,sceneContentHash:domainHash(blocks),blockIds:[block.id],excerptSha256:createHash('sha256').update(JSON.stringify([block])).digest('hex')};}
/** Validate author-supplied meaning; deterministic code only binds scene identity and exact excerpts. */
export function prepareAuthoringPlan(root,roots,planId){
 const value=root.planContent;if(!value)return null;
 if(root.kind!=='EPISODE_PLAN'||!list(value.episodes)||!value.episodes.length||value.planId!==planId||!list(value.retiredEpisodeUids)||value.retiredEpisodeUids.length)fail('首个分集提案必须使用实例方案身份、非空分集与空退役名单');
 if(Object.keys(value).some(k=>!['planId','episodes','retiredEpisodeUids','changeSummary'].includes(k)))fail('首稿分集提案包含未支持字段');
 const episodes=value.episodes,sceneIds=episodes.flatMap(e=>e.sceneIds||[]);if(sceneIds.join('|')!==root.sceneIds.join('|'))fail('分集必须按所选场稿顺序覆盖且不重复');
 const uids=new Set();for(const [index,episode] of episodes.entries()){
  if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(episode.episodeUid)||uids.has(episode.episodeUid)||episode.displayId!==`E${String(index+1).padStart(2,'0')}`||!episode.sceneIds.length)fail('分集身份、顺序或范围无效');uids.add(episode.episodeUid);
  for(const key of ['title','openingHook','coreAdvance','endingCliffhanger','reviewQuestion'])if(!nonempty(episode[key]))fail('分集需作者填写完整任务、推进、首尾与审阅问题');
  const dossier=episode.reviewDossier;if(dossier?.schemaVersion!=='1.1')fail('首稿分集使用1.1卷宗和2.0判断标准');
  for(const key of ['episodeTask','characterAction','expressionFocus'])claim(dossier.purpose?.[key],['A']);
  claim(dossier.informationLayers?.visibleAction,['F','A']);claim(dossier.informationLayers?.hiddenTruth,['F','U']);claim(dossier.informationLayers?.audiencePosition,['A']);
  if(!list(dossier.informationLayers?.characterKnowledge)||!dossier.informationLayers.characterKnowledge.length)fail('需明确人物所知');for(const item of dossier.informationLayers.characterKnowledge){if(!nonempty(item.subjectId))fail('人物所知缺少主体');claim(item.knowledge,['F','A','U']);}
  for(const key of ['deliveredResult','changedState'])claim(dossier.payoff?.[key],key==='deliveredResult'?['A','F']:['F','A','L','U']);
  if(!list(dossier.payoff?.unresolvedQuestions)||!list(dossier.authoringUnknowns)||!list(dossier.comedyBeats)||!list(dossier.causalChainIds)||!list(dossier.progressionSlices))fail('分集卷宗列表缺失');
  for(const item of dossier.payoff.unresolvedQuestions)claim(item,['A']);for(const item of dossier.authoringUnknowns)claim(item,['U']);
  if(dossier.progressionSlices.length||dossier.causalChainIds.length)fail('首稿尚无已登记叙事段落或因果链；不要借用其他故事身份');
  if(!list(dossier.sceneFlow)||dossier.sceneFlow.map(s=>s.sceneId).join('|')!==episode.sceneIds.join('|'))fail('逐场作用必须覆盖本集场次');for(const row of dossier.sceneFlow)claim(row.function,['A']);
  for(const beat of dossier.comedyBeats){if(!nonempty(beat.canonicalStoryId)||!list(beat.sceneIds)||!beat.sceneIds.length||beat.sceneIds.some(id=>!episode.sceneIds.includes(id)))fail('笑点引用超出本集');claim(beat.role,['A']);}
  const opening=roots.find(r=>r.id===episode.sceneIds[0]),ending=roots.find(r=>r.id===episode.sceneIds.at(-1));if(!opening||!ending)fail('首尾场稿不存在');
  dossier.boundaryEvidence={opening:authoringBoundary(opening,'opening'),ending:authoringBoundary(ending,'ending')};
 }
 return structuredClone(value);
}
