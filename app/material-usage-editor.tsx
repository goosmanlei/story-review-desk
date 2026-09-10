'use client';
import {useEffect,useState} from 'react';
import type {MaterialUsageContent,MaterialUsageTarget} from '../host/instance-runtime/material-usage-model.mjs';
import type {MaterialUsageSelection,MaterialUsageWorkspace} from '../host/instance-runtime/material-usage-service.mjs';
import {reconcileUsagePending,validUsagePending,validUsageLocalDraft,validUsageReceipt,validUsageSelection,validUsageWorkspace,type UsagePending,type UsageLocalDraft,type UsageEditableDraft} from './material-usage-client.mjs';
import {useRuntimeMode} from './runtime-mode';
import './shot-production-recipe-editor.css';
import {instanceSessionStorage} from './client-storage';
import {runtimePath} from './runtime-path';

type Draft=UsageEditableDraft;
const endpoint='/api/instance/material-usage';
const actionLabels={APPROVE_AND_RELEASE:'通过此用途',REQUEST_REVISION:'此用途需修订',DO_NOT_USE:'不用于此需求'};
const jobLabels:Record<string,string>={QUEUED:'等待登记',RUNNING:'正在登记',SUCCEEDED:'已登记',FAILED:'登记失败',RESULT_UNKNOWN:'结果待核查'};
const targetOf=(value:MaterialUsageTarget):MaterialUsageTarget=>({requirementId:value.requirementId,familyId:value.familyId,versionId:value.versionId,sha256:value.sha256});
const query=(target:MaterialUsageTarget)=>endpoint+'?'+new URLSearchParams(target);
async function read<T=unknown>(response:Response):Promise<T>{if(response.status===404)throw Error('当前系统尚未支持新用途审阅，请在系统更新后重读');const value=await response.json() as {error?:string|{message?:string};message?:string};if(!response.ok)throw Error(typeof value?.error==='string'?value.error:value?.error?.message||value?.message||'用途审阅读取失败');return value as T;}
function blank(state:MaterialUsageWorkspace):Draft{return {purposeNote:'',authorization:{scope:'PROJECT_INTERNAL_ONLY',basis:''},observation:{versionId:state.versionId,sha256:state.sha256,originalViewed:false,note:''},decision:{action:'',reviewSpecHash:state.reviewSpec.hash,criterionFindings:state.reviewSpec.criteria.map(c=>({criterionId:c.id,verdict:'',note:''})),note:''}};}
function rebaseStaleContent(content:Draft,state:MaterialUsageWorkspace):Draft{const draft=blank(state);return {...draft,purposeNote:content.purposeNote,authorization:content.authorization,observation:{...draft.observation,note:content.observation.note},decision:{...draft.decision,note:content.decision.note}};}
function complete(draft:Draft,state:MaterialUsageWorkspace){if(!draft.observation.originalViewed||!draft.purposeNote.trim()||!draft.authorization.basis.trim()||!draft.observation.note.trim()||!draft.decision.note.trim()||!draft.decision.action||draft.decision.reviewSpecHash!==state.reviewSpec.hash||state.reviewSpec.criteria.some(c=>!draft.decision.criterionFindings.some(f=>f.criterionId===c.id&&f.verdict&&f.note.trim()&&(f.verdict!=='NA'||c.allowNA))))throw Error('请查看原图、填写用途与依据，并完成每项审阅判断。');return draft as MaterialUsageContent;}

export function MaterialUsageEditor({requirementId}:{requirementId:string}){const {hostedReadOnly}=useRuntimeMode();return hostedReadOnly?null:<Editor key={requirementId} requirementId={requirementId}/>;}
function Editor({requirementId}:{requirementId:string}){
 const [open,setOpen]=useState(false),[selection,setSelection]=useState<MaterialUsageSelection|null>(null),[state,setState]=useState<MaterialUsageWorkspace|null>(null),[draft,setDraft]=useState<Draft|null>(null),[dirty,setDirty]=useState(false),[busy,setBusy]=useState(false),[pending,setPending]=useState<UsagePending|null>(null),[storageError,setStorageError]=useState(false),[preview,setPreview]=useState<Record<string,unknown>|null>(null),[message,setMessage]=useState('');
 const pendingKey='material-usage-pending:'+requirementId;
 const draftKey='material-usage-draft:'+requirementId;
 function remember(value:UsagePending|null){if(value)instanceSessionStorage.setItem(pendingKey,JSON.stringify(value));else instanceSessionStorage.removeItem(pendingKey);setPending(value);}
 function rememberDraft(content:Draft,next:MaterialUsageWorkspace){instanceSessionStorage.setItem(draftKey,JSON.stringify({target:targetOf(next),basisHash:next.basisHash,releaseId:next.releaseId,content}));}
 function loadDraft(next:MaterialUsageWorkspace){setState(next);setDraft(next.draft?.content||blank(next));setDirty(false);setPreview(null);}
 useEffect(()=>{if(!open)return;const controller=new AbortController();void (async()=>{
  let stored:UsagePending|null=null,local:UsageLocalDraft|null=null;try{const raw=instanceSessionStorage.getItem(pendingKey),localRaw=instanceSessionStorage.getItem(draftKey);if(raw)stored=validUsagePending(JSON.parse(raw),requirementId);if(localRaw)local=validUsageLocalDraft(JSON.parse(localRaw),requirementId);}catch{setStorageError(true);throw Error('本地草稿或待核查请求无法读取；为避免丢稿或重复登记，暂时停止提交。');}
  const selected=validUsageSelection(await read(await fetch(endpoint+'?requirementId='+encodeURIComponent(requirementId),{cache:'no-store',signal:controller.signal})),requirementId);if(controller.signal.aborted)return;setSelection(selected);
  if(stored){setPending(stored);const next=validUsageWorkspace(await read(await fetch(query(stored.target),{cache:'no-store',signal:controller.signal})),stored.target);if(controller.signal.aborted)return;loadDraft(next);setDraft(stored.content);setMessage('上次提交结果待核查，请重读并核对原请求。');}
  else if(local){const next=validUsageWorkspace(await read(await fetch(query(local.target),{cache:'no-store',signal:controller.signal})),local.target);if(controller.signal.aborted)return;loadDraft(next);const current=local.basisHash===next.basisHash&&local.releaseId===next.releaseId,restored=current?local.content:rebaseStaleContent(local.content,next);setDraft(restored);setDirty(true);rememberDraft(restored,next);setMessage(current?'已恢复本地未保存草稿。':'已恢复草稿说明；依据已变化，请重新逐项判断后保存。');}
 })().catch(e=>{if(!controller.signal.aborted)setMessage(e.message);}).finally(()=>{if(!controller.signal.aborted)setBusy(false);});return()=>controller.abort();},[open,requirementId,pendingKey,draftKey]);
 async function selectSource(familyId:string){if(busy||pending||storageError)return;const source=selection?.eligibleSources.find(s=>s.familyId===familyId);if(!source)return;setBusy(true);setMessage('');try{const target={...targetOf({...source,requirementId})};const next=validUsageWorkspace(await read(await fetch(query(target),{cache:'no-store'})),target);loadDraft(next);if(next.staleDraft)setMessage('之前的草稿依据已变化。请按当前原图与需求重新填写，旧稿保留在下方。');}catch(e){setMessage(e instanceof Error?e.message:'图片用途资料读取失败');}finally{setBusy(false);}}
 function edit(next:Draft){if(!state)return;try{rememberDraft(next,state);setDraft(next);setDirty(true);setPreview(null);}catch{setStorageError(true);setMessage('本地草稿暂时无法保存，已保留上次输入并停止编辑。');}}
 async function inspect(){if(busy)return;setBusy(true);try{
  if(!state&&!pending){setSelection(validUsageSelection(await read(await fetch(endpoint+'?requirementId='+encodeURIComponent(requirementId),{cache:'no-store'})),requirementId));setMessage('已重读可复用的图片。');return;}
  const target=pending?.target||targetOf(state!);const next=validUsageWorkspace(await read(await fetch(query(target),{cache:'no-store'})),target);setState(next);setPreview(null);
  if(pending){const result=reconcileUsagePending(pending,next);if(!result.confirmed){setMessage('尚未找到与上次提交完全一致的草稿或任务；保持待核查，未重复提交。');return;}const restored=result.stale?rebaseStaleContent(result.draft!.content,next):result.draft?.content||pending.content;if(result.stale)rememberDraft(restored,next);else instanceSessionStorage.removeItem(draftKey);remember(null);setDirty(!!result.stale);setDraft(restored);setMessage(result.stale?'已核回保存成功；依据已变化，已保留说明，请重新逐项判断并保存。':result.job?'已核回原请求：'+jobLabels[result.job.status]+'。':'已核回保存的同一份草稿。');}
  else if(dirty&&draft&&state&&(state.basisHash!==next.basisHash||state.releaseId!==next.releaseId)){const restored=rebaseStaleContent(draft,next);rememberDraft(restored,next);setDraft(restored);setMessage('已保留草稿说明；依据已变化，请重新逐项判断后保存。');}
  else{if(!dirty)setDraft(next.draft?.content||blank(next));setMessage('已重读用途审阅与登记任务。');}
  window.dispatchEvent(new Event('review:operations-updated'));
 }catch(e){setMessage(e instanceof Error?e.message:'用途审阅尚无法核查');}finally{setBusy(false);}}
 async function act(action:'save'|'preview'|'publish'){
  if(!state||!draft||state.readOnly||busy||pending||storageError||state.blockers.length||state.jobs.some(j=>['QUEUED','RUNNING','RESULT_UNKNOWN'].includes(j.status)))return;setBusy(true);setMessage('');let submitted=false;
  try{const content=complete(draft,state),target=targetOf(state),requestId='material-usage:'+crypto.randomUUID();
   const operations=await read<{mutationEtag:string}>(await fetch('/api/v8/operations/snapshot?summary=1',{cache:'no-store'}));if(typeof operations.mutationEtag!=='string'||!operations.mutationEtag)throw Error('当前素材版本不可用');
   const body=action==='save'?{action,...target,expectedReleaseId:state.releaseId,expectedBasisHash:state.basisHash,expectedDraftRevisionId:state.draftHeadRevisionId,content}:{action,...target,draftRevisionId:state.draft?.revisionId,...(action==='publish'?{previewHash:preview?.previewHash}:{})};
   if(action!=='preview')remember({action,target,requestId,basisHash:state.basisHash,releaseId:state.releaseId,oldDraftRevisionId:state.draftHeadRevisionId,content});submitted=true;
   const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','If-Match':operations.mutationEtag,'Idempotency-Key':requestId},body:JSON.stringify(body)});
   if(!response.ok&&response.status<500){submitted=false;if(action!=='preview')remember(null);}
   const result=validUsageReceipt(await read(response),action,state);submitted=false;if(action!=='preview')remember(null);
   if(action==='save'){instanceSessionStorage.removeItem(draftKey);const revisionId=String(result.revisionId);setState({...state,draftHeadRevisionId:revisionId,staleDraft:null,draft:{...target,usageId:state.usageId,baseReleaseId:state.releaseId,basisHash:state.basisHash,revisionId,content}});setDirty(false);setPreview(null);setMessage('用途审阅草稿已保存，请预览后登记。');}
   else if(action==='preview'){setPreview(result);setMessage('请核对这张图片在当前需求中的用途与审阅结论。');}
   else{setPreview(null);setState({...state,jobs:[{jobId:String(result.jobId),requestId,status:'QUEUED'},...state.jobs]});setMessage('用途审阅已排队登记；请重读任务确认结果。');window.dispatchEvent(new Event('review:operations-updated'));}
  }catch(e){setMessage((e instanceof Error?e.message:'操作失败')+(submitted&&action!=='preview'?'；结果待核查，请重读原请求，勿重复提交。':''));}finally{setBusy(false);}
 }
 const source=selection?.eligibleSources.find(s=>state&&s.familyId===state.familyId&&s.versionId===state.versionId&&s.sha256===state.sha256),imageUrl=source?.mediaToken?runtimePath('/api/v8/media/'+source.mediaToken):source?.mediaUrl;
 const blocked=!!state&&(state.readOnly||state.blockers.length>0||state.jobs.some(j=>['QUEUED','RUNNING','RESULT_UNKNOWN'].includes(j.status)))||busy||!!pending||storageError;
 return <section className="shot-production-recipe-editor" aria-label="复用图片用途审阅">
  {!open?<button type="button" onClick={()=>{setBusy(true);setOpen(true);}}>复用已通过图片</button>:<>
   <header><h4>复用已通过图片</h4><button type="button" disabled={busy||storageError} onClick={()=>void inspect()}>重读图片与用途审阅</button></header>
   <p>选择一张已通过的图片，判断它是否满足这项需求。原图的版本和采用记录将保留。</p>
   {selection&&<><label>选择图片<select value={state?.familyId||''} disabled={busy||!!pending||dirty||storageError||selection.readOnly} onChange={e=>void selectSource(e.target.value)}><option value="">请选择</option>{selection.eligibleSources.map(s=><option key={s.familyId} value={s.familyId}>{s.sameEntity?'同一实体 · ':''}{s.title} · {s.versionId}</option>)}</select></label>{selection.blockers.map(b=><p key={b}>{b}</p>)}</>}
   {state&&draft&&<>
    {imageUrl&&<figure><a href={runtimePath(imageUrl)} target="_blank" rel="noreferrer">
     {/* Display exact registered bytes rather than a re-encoded image derivative. */}
     {/* eslint-disable-next-line @next/next/no-img-element */}
     <img src={runtimePath(imageUrl)} alt="本次用途审阅的原图" style={{width:'100%',maxHeight:420,objectFit:'contain'}}/>
    </a><figcaption>点击查看原图</figcaption></figure>}
    <details><summary>查看绑定版本与文件校验值</summary><p>{state.versionId}</p><code>{state.sha256}</code></details>
    {state.head&&<p>最近登记：{actionLabels[state.head.action as keyof typeof actionLabels]||'已记录用途判断'}。是否可用以当前素材覆盖状态为准。</p>}
    {state.blockers.map(b=><p key={b}>{b}</p>)}
    {state.staleDraft&&<details><summary>查看依据已变化的旧草稿</summary><pre>{JSON.stringify(state.staleDraft.content,null,2)}</pre></details>}
    <fieldset disabled={blocked}>
     <label>这张图片如何满足当前需求<textarea value={draft.purposeNote} onChange={e=>edit({...draft,purposeNote:e.target.value})}/></label>
     <label><input type="checkbox" checked={draft.observation.originalViewed} onChange={e=>edit({...draft,observation:{...draft.observation,originalViewed:e.target.checked}})}/>已查看这个版本的原图</label>
     <label>原图观察记录<textarea value={draft.observation.note} onChange={e=>edit({...draft,observation:{...draft.observation,note:e.target.value}})}/></label>
     {state.reviewSpec.criteria.map(c=>{const finding=draft.decision.criterionFindings.find(f=>f.criterionId===c.id);return <fieldset key={c.id}><legend>{c.label}</legend><p>{c.question}</p><label>判断<select value={finding?.verdict||''} onChange={e=>edit({...draft,decision:{...draft.decision,criterionFindings:draft.decision.criterionFindings.map(f=>f.criterionId===c.id?{...f,verdict:e.target.value as typeof f.verdict}:f)}})}><option value="">请选择</option><option value="PASS">通过</option><option value="FAIL">不通过</option>{c.allowNA&&<option value="NA">不适用</option>}</select></label><label>判断依据<textarea value={finding?.note||''} onChange={e=>edit({...draft,decision:{...draft.decision,criterionFindings:draft.decision.criterionFindings.map(f=>f.criterionId===c.id?{...f,note:e.target.value}:f)}})}/></label></fieldset>;})}
     <label>项目内部使用依据<textarea value={draft.authorization.basis} onChange={e=>edit({...draft,authorization:{scope:'PROJECT_INTERNAL_ONLY',basis:e.target.value}})}/></label>
     <label>用途结论<select value={draft.decision.action} onChange={e=>edit({...draft,decision:{...draft.decision,action:e.target.value as Draft['decision']['action']}})}><option value="">请选择</option>{Object.entries(actionLabels).map(([action,label])=><option key={action} value={action}>{label}</option>)}</select></label>
     <label>审阅说明<textarea value={draft.decision.note} onChange={e=>edit({...draft,decision:{...draft.decision,note:e.target.value}})}/></label>
    </fieldset>
    <p>{dirty?'未保存内容已暂存于此浏览器，返回这项素材时可恢复。':''}</p>
    <footer><button type="button" disabled={blocked||!dirty} onClick={()=>void act('save')}>保存用途审阅草稿</button><button type="button" disabled={blocked||dirty||!state.draft} onClick={()=>void act('preview')}>预览用途审阅</button></footer>
    {preview&&<section><h4>待登记用途审阅</h4><p>{draft.purposeNote}</p><p>{draft.decision.action&&actionLabels[draft.decision.action]}：{draft.decision.note}</p><details><summary>查看完整用途与逐项判断</summary><pre>{JSON.stringify(preview.usage,null,2)}</pre></details><button type="button" disabled={blocked||dirty} onClick={()=>void act('publish')}>确认登记用途审阅</button></section>}
    {state.jobs.map(j=><p key={j.jobId}>{jobLabels[j.status]}{j.error?'：'+j.error:''}{j.status==='SUCCEEDED'&&<button type="button" disabled={dirty||!!pending} onClick={()=>window.location.reload()}>读取素材最新状态</button>}</p>)}
   </>}
  </>}{message&&<p role="status">{message}</p>}
 </section>;
}
