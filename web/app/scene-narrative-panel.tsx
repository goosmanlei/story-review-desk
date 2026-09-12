'use client';

import {runtimePath} from './runtime-path';
import {useEffect,useState} from 'react';
import {DesignText} from './story-comments';
import {requirementCommentField} from './story-comment-model';
import type {EpisodePlanContext} from './episode-plan-context';
import type {SceneNarrativeContext,SceneRequirement} from './scene-narrative-context';
import {CurrentSceneConfirmationReview} from './adaptation-audit';

const stateLabels: Record<SceneNarrativeContext['upstreamState'],string> = {HISTORICAL:'历史只读',PENDING_REVIEW:'待审要求',REVISION_REQUIRED:'要求修改',DO_NOT_USE:'禁止使用',APPROVED_PENDING_SYNC:'已获批 · 待同步',CURRENT:'已生效要求'};
export function useSceneNarrativeContext(plan: EpisodePlanContext,sceneId: string) {
  const key=`${plan.revisionId}:${plan.contentHash}:${sceneId}`;
  const [result,setResult]=useState<{key:string;context:SceneNarrativeContext|null;error:string}>({key:'',context:null,error:''});
  const [attempt,setAttempt]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();
    const load=async()=>{try{
      const response=await fetch(`/api/v1/workspaces/views/scene-review-context?revisionId=${encodeURIComponent(plan.revisionId)}&archive=${plan.archived?'1':'0'}&sceneId=${encodeURIComponent(sceneId)}`,{cache:'no-store',signal:controller.signal});
      const value=await response.json() as {context:SceneNarrativeContext;error?:string};
      if(!response.ok)throw new Error(value.error||'读取失败');
      if(value.context.revisionId!==plan.revisionId||value.context.planContentHash!==plan.contentHash||value.context.sceneId!==sceneId||value.context.snapshotId!==plan.snapshotId)throw new Error('承接材料与当前正文版本不一致');
      if(!controller.signal.aborted)setResult({key,context:value.context,error:''});
    }catch(error){if(!controller.signal.aborted)setResult({key,context:null,error:error instanceof Error?error.message:'读取失败'});}};
    void load();return()=>controller.abort();
  },[key,plan.revisionId,plan.contentHash,plan.snapshotId,sceneId,attempt]);
  return {context:result.key===key?result.context:null,error:result.key===key?result.error:'',retry:()=>{setResult({key:'',context:null,error:''});setAttempt(a=>a+1);}};
}
export function SceneNarrativeRequirements({context,onOpenScene,onLocate}: {context:SceneNarrativeContext;onOpenScene:(id:string)=>void;onLocate:(ids:string[])=>void}) {
  function locate(row: SceneRequirement){if(row.sceneIds.includes(context.sceneId))onLocate(row.blockIds);else onOpenScene(row.sceneIds[0]);}
  const logicHref=`/?view=story&storyMode=logic&episodePlanRevision=${encodeURIComponent(context.revisionId)}&episode=${encodeURIComponent(context.episodeUid)}&logicGroup=episode-task`;
  return <section className="scene-inheritance" aria-label="本集要求与本场承接">
    <header><div><small>从分集要求到本场正文</small><h3>本集要求与本场承接</h3></div><span className={`inheritance-state is-${context.upstreamState.toLowerCase()}`}>{stateLabels[context.upstreamState]}</span></header>
    <p className="scene-inheritance-position">{context.episode.displayId} {context.episode.title} · 本集第 {context.episode.scenePosition} / {context.episode.sceneCount} 场 <a href={runtimePath(logicHref)}>返回本集叙事判断 →</a></p>
    <div className="scene-inheritance-groups">{(['EPISODE','SCENE'] as const).map(scope=><section key={scope}><h4>{scope==='EPISODE'?'本集要求与相关推进段':'本场具体责任'}</h4>{context.requirements.filter(r=>r.scope===scope).map(row=><article key={row.id}><b>{row.label}</b><p>{requirementCommentField(row.id,context.sceneId)?<DesignText episodeUid={context.episodeUid} fieldId={requirementCommentField(row.id,context.sceneId)!} text={row.claim.text}/>:row.claim.text}</p><footer><span>{row.blockIds.length?'精确正文块依据':`场级依据：${row.sceneIds.map(id=>context.sceneLabels[id]?.split(' ')[0]||id).join('、')}`}</span><button type="button" onClick={()=>locate(row)}>{row.sceneIds.includes(context.sceneId)?'定位正文依据':'打开承担场次'} →</button></footer></article>)}</section>)}</div>
    {context.chains.length>0&&<section className="scene-inheritance-chains"><h4>铺垫与回收</h4>{context.chains.map(chain=><article key={chain.id}><b>{chain.title} · {chain.role}</b><p><DesignText episodeUid={context.episodeUid} fieldId={`chain:${chain.id}`} text={chain.requirement}/></p><div>{(['setup','payoff'] as const).map(part=><p key={part}><span>{part==='setup'?'铺垫':'回收'}：</span>{chain[part].map(id=><button key={id} type="button" aria-current={id===context.sceneId?'true':undefined} onClick={()=>onOpenScene(id)}>{context.sceneLabels[id]||id}</button>)}</p>)}</div></article>)}</section>}
    {context.neighbours.length>0&&<div className="scene-inheritance-neighbours">{context.neighbours.map(scene=><article key={scene.direction}><b>{scene.direction==='previous'?'前场交接':'后场承接'}</b><button type="button" onClick={()=>onOpenScene(scene.id)}>{scene.label} →</button><p>{scene.transition}</p></article>)}</div>}
    {context.missing.length>0&&<div className="narrative-no-evidence"><b>资料缺项／待核</b>{context.missing.map((text,i)=><p key={i}>{text}</p>)}</div>}
    <p className="scene-inheritance-note">以上是创作要求及其依据。是否遗漏、偏离或提前泄露，须结合完整正文判断；此处不自动判定已经落实。</p>
  </section>;
}
export function SceneNarrativeReview({context}: {context:SceneNarrativeContext}) {
  if(context.formalTarget)return <CurrentSceneConfirmationReview target={context.formalTarget} snapshotId={context.snapshotId}/>;
  return <section className="scene-inheritance-review" aria-label="本场正式审阅"><header><small>场级拆解审阅</small><h3>本场正式审阅</h3></header><p className="narrative-no-evidence">{context.formalBlockReason}</p><div>{context.reviewSpec.criteria.map(c=><article key={c.id}><b>{c.label}</b><p>{c.question}</p><small>待上游生效后判断</small></article>)}</div><button type="button" disabled>上游尚未就绪</button></section>;
}
