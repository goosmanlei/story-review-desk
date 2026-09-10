'use client';
import {useInstanceProfile} from './instance-context';
import {readWorkspaceJson,workspaceCacheScope} from './workspace-read-cache';
import {useWorkspaceReadiness} from './workspace-read-boundary';
import {useEffect,useState} from 'react';
import {useRuntimeMode} from './runtime-mode';
import {visibleText} from './review-semantics';
import {ShotDesignEditor,ShotDesignSummary,type ShotDesignPlan} from './shot-design-editor';
import type {ShotDesign} from '../host/instance-runtime/shot-design-contract.mjs';

type Candidate={creativeRevisionId:string;contentHash:string;contextHash:string;content:{beats?:Array<Record<string,unknown>>;shots?:Array<Record<string,unknown>>};scopedReviewSpec?:{hash:string;criteria:Array<{id:string;label:string;question:string}>}};
type Plan={kind:string;candidate?:Candidate;review?:{eventId:string;action:string};state?:{canFlowDownstream?:boolean};canAuthor:boolean;blockedReason:string;basisBindings:Array<{bindingType:string;bindingId:string;bindingHash:string}>;template?:{planId:string;revisionHash:string;content?:{beats?:Array<{beatId:string;narrativeBeat:string;materialRequirementRefs:string[]}>;shots?:Array<Record<string,unknown>>};retiredShotIds?:string[]}};
type Entry={snapshotId:string;episode:{displayId:string};release:{canFlowDownstream:boolean;reason:string}|null;plans:Plan[];formalShotCount:number|null};
const fieldLabels:Record<string,string>={title:'镜头标题',narrativeBeat:'叙事节拍',audienceTakeaway:'观众所得',visualIntent:'画面意图',actionIntent:'动作意图',soundIntent:'声音意图',dialogueContext:'对白与表演',materialRequirementRefs:'素材需求',coverageBeatRefs:'覆盖节拍'};

export function EpisodeProductionEntry({episodeUid,sceneId}:{episodeUid:string;sceneId:string}) {
  const {hostedReadOnly}=useRuntimeMode();
  const cacheScope=workspaceCacheScope(useInstanceProfile());
  const [attempt,setAttempt]=useState(0),[result,setResult]=useState<{key:string;entry:Entry|null;error:string}|null>(null);
  const requestKey=JSON.stringify([episodeUid,sceneId,attempt]);
  const entry=result?.key===requestKey?result.entry:null,error=result?.key===requestKey?result.error:'';
  useEffect(()=>{const controller=new AbortController();let active=true;void readWorkspaceJson<Entry>(`/api/v8/episode-production?episodeUid=${encodeURIComponent(episodeUid)}&sceneId=${encodeURIComponent(sceneId)}`,cacheScope,controller.signal).then(body=>{if(active)setResult({key:requestKey,entry:body,error:''});}).catch(reason=>{if(active)setResult({key:requestKey,entry:null,error:reason.message});});const refresh=()=>setAttempt(v=>v+1);window.addEventListener('review:operations-updated',refresh);return()=>{active=false;controller.abort();window.removeEventListener('review:operations-updated',refresh);};},[episodeUid,sceneId,requestKey,cacheScope]);
  useWorkspaceReadiness(!entry&&!error,error,()=>setAttempt(v=>v+1));
  return <section className="episode-production-entry" aria-label="本集正式镜头设计">
    <header><h3>本场正式镜头设计</h3><p>本集正文生效后即可逐场推进；其他集未完成，不阻断本场。</p></header>
    {error&&<p role="alert">{visibleText(error)} <button onClick={()=>setAttempt(v=>v+1)}>重新读取</button></p>}
    {!entry&&!error&&<p role="status">正在读取本集发布与本场计划…</p>}
    {entry&&!entry.release?.canFlowDownstream&&<p>本集尚未正式通过并完成受控同步。{entry.release?.reason||'请先在叙事拆解确认本集正文及六项判断。'}</p>}
    {entry?.plans.map(plan=><ScenePlanningReview key={`${sceneId}:${plan.kind}:${plan.candidate?.creativeRevisionId||'none'}`} plan={plan} sceneId={sceneId} snapshotId={entry.snapshotId} readOnly={hostedReadOnly} coverage={entry.plans.find(row=>row.kind==='SCENE_COVERAGE')?.template?.content} onSaved={()=>setAttempt(v=>v+1)}/>)}
    {entry&&<p>本场正式镜头分母：{entry.formalShotCount===null?'待确定（UNKNOWN）':`${entry.formalShotCount} 镜`}。本集放行不等于素材、镜头输入或成片已通过。</p>}
  </section>;
}

function ScenePlanningReview({plan,sceneId,snapshotId,readOnly,coverage,onSaved}:{plan:Plan;sceneId:string;snapshotId:string;readOnly:boolean;coverage?:{beats?:Array<{beatId:string;narrativeBeat:string;materialRequirementRefs:string[]}>};onSaved:()=>void}) {
  const [findings,setFindings]=useState<Record<string,{verdict:string;note:string}>>({}),[action,setAction]=useState(''),[note,setNote]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const candidate=plan.candidate,criteria=candidate?.scopedReviewSpec?.criteria||[],title=plan.kind==='SCENE_COVERAGE'?'场级镜头意图':'正式镜头计划';
  const complete=criteria.length>0&&criteria.every(c=>['PASS','FAIL'].includes(findings[c.id]?.verdict)&&(!(findings[c.id]?.verdict==='FAIL')||findings[c.id]?.note.trim()));
  const hasFailure=criteria.some(c=>findings[c.id]?.verdict==='FAIL');
  async function submit() {
    if(!candidate||!complete||!action||busy||readOnly||plan.review||!plan.canAuthor)return;
    setBusy(true);setMessage('');
    try {
      const response=await fetch('/api/v8/operations/snapshot',{cache:'no-store'}),binding=await response.json() as {snapshotId:string;mutationEtag:string};
      if(!response.ok||binding.snapshotId!==snapshotId||!binding.mutationEtag)throw new Error('运行依据已变化，请重新读取后核对');
      const body={schemaVersion:'2.2',snapshotId,subjectType:'CREATIVE_REVISION',subjectKind:plan.kind,subjectId:plan.template?.planId,subjectRevisionId:candidate.creativeRevisionId,subjectRevisionHash:candidate.contentHash,contextHash:candidate.contextHash,scopeType:'SCENE',scopeId:sceneId,reviewSpecHash:candidate.scopedReviewSpec?.hash,criterionFindings:criteria.map(c=>({criterionId:c.id,verdict:findings[c.id].verdict,note:findings[c.id].note})),action,note};
      const result=await fetch('/api/v8/reviews',{method:'POST',headers:{'Content-Type':'application/json','If-Match':binding.mutationEtag,'Idempotency-Key':`scene-review-${crypto.randomUUID()}`},body:JSON.stringify(body)}),payload=await result.json() as {error?:string};
      if(!result.ok)throw new Error(payload.error||'提交未完成');onSaved();window.dispatchEvent(new CustomEvent('review:operations-updated'));
    }catch(reason){setMessage(`提交未确认：${reason instanceof Error?reason.message:'UNKNOWN'}。请先重新读取状态，不自动重试。`);}finally{setBusy(false);}
  }
  return <article className="scoped-planning-card">
    <h4>{title} · {plan.state?.canFlowDownstream?'已通过并同步':plan.review?.action==='APPROVE_AND_RELEASE'?'已通过，待本场受控同步':candidate?'已登记候选':plan.canAuthor?'可以开始编写':'等待本場上游'}</h4>
    {!plan.canAuthor&&<p>{visibleText(plan.blockedReason)}</p>}
    {!candidate&&plan.canAuthor&&<p>可请 Codex 基于本集已发布正文和本场准备稿编写完整{title}，通过精确依据登记候选后在此审阅。作者稿不自动通过，不会调用媒体模型。</p>}
    {plan.kind==='SHOT_PLAN_SET'&&<ShotDesignEditor plan={plan as unknown as ShotDesignPlan} coverage={coverage} sceneId={sceneId} snapshotId={snapshotId} readOnly={readOnly} onSaved={onSaved}/>}
    {candidate&&<><div className="scoped-planning-reading">{(candidate.content.beats||candidate.content.shots||[]).map((row,index)=><section key={index}><h5>{index+1}. {String(row.title||row.narrativeBeat||title)}</h5>{Object.entries(fieldLabels).filter(([field])=>row[field]!==undefined&&field!=='title').map(([field,label])=><p key={field}><strong>{label}：</strong>{Array.isArray(row[field])?(row[field] as string[]).join('、')||'无':String(row[field])}</p>)}{plan.kind==='SHOT_PLAN_SET'&&<ShotDesignSummary design={row.design as ShotDesign|undefined}/>}</section>)}</div>
      {plan.review?<p>{plan.review.action==='APPROVE_AND_RELEASE'?'已登记正式通过。只有本场受控同步完成后，下一环节才使用该版本。':plan.review.action==='REQUEST_REVISION'?'本候选要求修改，请登记新候选。':'本候选禁止使用。'}</p>:criteria.length>0&&<form onSubmit={e=>{e.preventDefault();void submit();}}>
        {criteria.map(c=><fieldset key={c.id} disabled={readOnly||busy||!plan.canAuthor}><legend>{c.label}</legend><p>{c.question}</p>{['PASS','FAIL'].map(verdict=><label key={verdict}><input type="radio" name={`${candidate.creativeRevisionId}:${c.id}`} checked={findings[c.id]?.verdict===verdict} onClick={()=>{if(findings[c.id]?.verdict===verdict)setFindings(old=>({...old,[c.id]:{note:old[c.id]?.note||'',verdict:''}}));}} onChange={()=>setFindings(old=>({...old,[c.id]:{note:old[c.id]?.note||'',verdict}}))}/>{verdict==='PASS'?'通过':'有问题'}</label>)}<textarea aria-label={`${c.label}说明`} placeholder="问题项请写具体修改方向" value={findings[c.id]?.note||''} onChange={e=>setFindings(old=>({...old,[c.id]:{verdict:old[c.id]?.verdict||'',note:e.target.value}}))}/></fieldset>)}
        <label>本场结论<select value={action} onChange={e=>setAction(e.target.value)} disabled={readOnly||busy}><option value="">请选择</option><option value="APPROVE_AND_RELEASE">通过并放行</option><option value="REQUEST_REVISION">要求修改</option><option value="DO_NOT_USE">禁止使用</option></select></label><textarea aria-label="本场结论说明" value={note} onChange={e=>setNote(e.target.value)}/>
        <button disabled={readOnly||busy||!plan.canAuthor||!complete||!action||(action==='APPROVE_AND_RELEASE'?hasFailure:!hasFailure||!note.trim())}>{busy?'正在提交…':'提交本场正式结论'}</button>
      </form>}
    </>}
    {message&&<p role="alert">{visibleText(message)}</p>}
    <details><summary>精确创作交接依据</summary><p>永久场：{sceneId}；候选和实际输入须按下列绑定登记。尚未齐备的素材或空间条件不能借用其他场。</p><pre>{JSON.stringify({subjectKind:plan.kind,subjectId:plan.template?.planId,baseRevisionHash:plan.template?.revisionHash,basisBindings:plan.basisBindings,creativeRevisionId:candidate?.creativeRevisionId,reviewEventId:plan.review?.eventId},null,2)}</pre></details>
  </article>;
}
