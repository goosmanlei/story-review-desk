'use client';
import {useEffect,useRef,useState} from 'react';
import type {AssetContextTarget,AssetContextContent,AssetContextWorkspace} from '../host/instance-runtime/asset-context-revalidation-service.mjs';
import {validContextWorkspace,validContextReceipt,validContextLocalDraft,validContextPending,reconcileContextPending,type ContextEditableDraft,type ContextPending,type ContextLocalDraft} from './asset-context-revalidation-client.mjs';
import {useRuntimeMode} from './runtime-mode';
import './shot-production-recipe-editor.css';

const endpoint='/api/instance/asset-context-revalidation';
const jobs:Record<string,string>={QUEUED:'等待登记',RUNNING:'正在登记',SUCCEEDED:'复核已登记',FAILED:'登记失败',RESULT_UNKNOWN:'结果待核查'};
const targetOf=(v:AssetContextTarget):AssetContextTarget=>({familyId:v.familyId,versionId:v.versionId,sha256:v.sha256});
async function read<T=unknown>(response:Response):Promise<T>{if(response.status===404)throw Error('当前系统尚未支持旧采用图片的关系复核，请更新后重读');const value=await response.json() as {error?:string|{message?:string};message?:string};if(!response.ok)throw Error(typeof value.error==='string'?value.error:value.error?.message||value.message||'关系复核未完成');return value as T;}
function blank(w:AssetContextWorkspace):ContextEditableDraft{return {purpose:'LEGACY_ADOPTION_DOMAIN_REVALIDATION',action:'CONFIRM_CURRENT_DOMAIN',observedVersionId:w.versionId,observedSha256:w.sha256,originalViewed:false,criterionFindings:w.reviewSpec.criteria.map(c=>({criterionId:c.id,verdict:'',note:''})),note:''};}
function complete(d:ContextEditableDraft,w:AssetContextWorkspace):AssetContextContent {if(!d.originalViewed||!d.note.trim()||w.reviewSpec.criteria.some(c=>!d.criterionFindings.some(f=>f.criterionId===c.id&&(f.verdict==='PASS'||f.verdict==='NA'&&c.allowNA)&&f.note.trim())))throw Error('请查看原图并完成每项判断；存在不通过项时不能确认当前关系。');return {purpose:d.purpose,action:d.action,observedVersionId:d.observedVersionId,observedSha256:d.observedSha256,criterionFindings:d.criterionFindings as AssetContextContent['criterionFindings'],note:d.note};}

export function AssetContextRevalidationEditor({target,mediaToken}:{target:AssetContextTarget;mediaToken?:string}) {
 const {hostedReadOnly}=useRuntimeMode();return hostedReadOnly?null:<Editor key={target.familyId+':'+target.versionId+':'+target.sha256} target={target} mediaToken={mediaToken}/>;
}
function Editor({target,mediaToken}:{target:AssetContextTarget;mediaToken?:string}) {
 const [open,setOpen]=useState(false),[state,setState]=useState<AssetContextWorkspace|null>(null),[draft,setDraft]=useState<ContextEditableDraft|null>(null),[busy,setBusy]=useState(false),[dirty,setDirty]=useState(false),[pending,setPending]=useState<ContextPending|null>(null),[storageError,setStorageError]=useState(false),[preview,setPreview]=useState<Record<string,unknown>|null>(null),[message,setMessage]=useState(''),[staleLocalDrafts,setStaleLocalDrafts]=useState<ContextLocalDraft[]>([]);
 const key='asset-context-revalidation:'+target.familyId+':'+target.versionId+':'+target.sha256;
 const draftKey=key+':draft',pendingKey=key+':pending',staleKey=key+':stale-drafts';
 function writeStorage(k:string,v:string){try{sessionStorage.setItem(k,v);}catch{setStorageError(true);throw Error('浏览器无法保全观察稿或请求记录，已停止提交；请保留当前内容。');}}
 function removeStorage(k:string){try{sessionStorage.removeItem(k);}catch{setStorageError(true);throw Error('浏览器无法更新观察稿或请求记录，已停止提交。');}}
 function remember(value:ContextPending|null){if(value)writeStorage(pendingKey,JSON.stringify(value));else removeStorage(pendingKey);setPending(value);}
 function rememberDraft(content:ContextEditableDraft,w:AssetContextWorkspace){writeStorage(draftKey,JSON.stringify({target:targetOf(w),basisHash:w.basisHash,releaseId:w.releaseId,content}));}
 async function inspect(signal?:AbortSignal){try{
  const w=validContextWorkspace(await read(await fetch(endpoint+'?'+new URLSearchParams(target),{cache:'no-store',signal})),target);if(signal?.aborted)return;
  let local:ContextLocalDraft|null=null,stored:ContextPending|null=null,stale:ContextLocalDraft[]=[];
  try{const l=sessionStorage.getItem(draftKey),p=sessionStorage.getItem(pendingKey),old=sessionStorage.getItem(staleKey);if(old){const values:unknown=JSON.parse(old);if(!Array.isArray(values))throw Error('Invalid stale draft list');stale=values.map(value=>validContextLocalDraft(value,target));}if(l)local=validContextLocalDraft(JSON.parse(l),target);if(p)stored=validContextPending(JSON.parse(p),target);}catch{setStorageError(true);throw Error('本地草稿或待核查请求无法读取，暂时停止提交以免丢稿或重复登记。');}
  setState(w);setPreview(null);setPending(stored);setStaleLocalDrafts(stale);
  if(stored){const result=reconcileContextPending(stored,w);if(result.confirmed){remember(null);if(result.draft){removeStorage(draftKey);local=null;}setMessage(result.job?'已找到原登记任务，请核对下方结果。':'已找到原保存请求的草稿。');}else setMessage('原请求结果尚未核实；继续重读，暂不重复提交。');}
  if(local&&local.basisHash===w.basisHash&&local.releaseId===w.releaseId){setDraft(local.content);setDirty(true);}
  else if(local){if(!stale.some(old=>JSON.stringify(old)===JSON.stringify(local))){const preserved=[...stale,local];writeStorage(staleKey,JSON.stringify(preserved));setStaleLocalDrafts(preserved);}const reset=blank(w);reset.note=local.content.note;setDraft(reset);setDirty(true);rememberDraft(reset,w);setMessage('依据已变化，旧稿已完整保留在下方；请按当前原图与标准重新判断。');}
  else {setDraft(w.draft?{...w.draft.content,originalViewed:false}:blank(w));setDirty(false);}
 }catch(e){if(!signal?.aborted)setMessage(e instanceof Error?e.message:'读取失败');}finally{if(!signal?.aborted)setBusy(false);}}
 const loadController=useRef<AbortController|null>(null);
 useEffect(()=>()=>loadController.current?.abort(),[]);
 function beginInspect(){loadController.current?.abort();const controller=new AbortController();loadController.current=controller;setBusy(true);void inspect(controller.signal);}
 function edit(next:ContextEditableDraft){if(!state)return;setDraft(next);setDirty(true);setPreview(null);try{rememberDraft(next,state);}catch{setStorageError(true);setMessage('浏览器无法保存草稿，暂时停止提交；请保留当前观察内容。');}}
 async function act(action:'save'|'preview'|'publish') {if(!state||!draft||blocked)return;setBusy(true);let submitted=false;try{
  const content=complete(draft,state),requestId='asset-context:'+crypto.randomUUID();
  const operations=await read<{mutationEtag:string}>(await fetch('/api/v8/operations/snapshot?summary=1',{cache:'no-store'}));if(typeof operations.mutationEtag!=='string'||!operations.mutationEtag)throw Error('当前写入水位不可用');
  const body=action==='save'?{action,...targetOf(state),expectedReleaseId:state.releaseId,expectedBasisHash:state.basisHash,expectedDraftRevisionId:state.draftHeadRevisionId,content}:{action,...targetOf(state),draftRevisionId:state.draft?.revisionId,...(action==='publish'?{previewHash:preview?.previewHash}:{})};
  if(action!=='preview')remember({action,target:targetOf(state),requestId,basisHash:state.basisHash,releaseId:state.releaseId,oldDraftRevisionId:state.draftHeadRevisionId,content});submitted=true;
  const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','If-Match':operations.mutationEtag,'Idempotency-Key':requestId},body:JSON.stringify(body)});
  if(!response.ok&&response.status<500){submitted=false;if(action!=='preview')remember(null);}
  const result=validContextReceipt(await read(response),action,state);submitted=false;if(action!=='preview')remember(null);
  if(action==='save'){removeStorage(draftKey);const revisionId=String(result.revisionId);setState({...state,draftHeadRevisionId:revisionId,staleDraft:null,draft:{...targetOf(state),revalidationId:state.revalidationId,baseReleaseId:state.releaseId,basisHash:state.basisHash,revisionId,content}});setDirty(false);setPreview(null);setMessage('复核草稿已保存，请预览后登记。');}
  else if(action==='preview'){setPreview(result);setMessage('请核对当前关系、原图与逐项判断。');}
  else {setPreview(null);setState({...state,jobs:[{jobId:String(result.jobId),requestId,status:'QUEUED'},...state.jobs]});setMessage('复核已排队登记，请重读确认结果。');window.dispatchEvent(new Event('review:operations-updated'));}
 }catch(e){setMessage((e instanceof Error?e.message:'复核未完成')+(submitted&&action!=='preview'?'；结果待核查，请重读原请求，勿重复提交。':''));}finally{setBusy(false);}}
 const blocked=busy||!!pending||storageError||!!state&&(state.readOnly||state.blockers.length>0||state.jobs.some(j=>['QUEUED','RUNNING','RESULT_UNKNOWN'].includes(j.status)));
 const imageUrl=mediaToken&&/^[A-Za-z0-9_-]+$/.test(mediaToken)?'/api/v8/media/'+mediaToken:null;
 return <section className="shot-production-recipe-editor" aria-label="旧采用图片的关系复核">
  {!open?<button type="button" onClick={()=>{setOpen(true);beginInspect();}}>复核原图在当前关系中的适用性</button>:<>
   <header><h4>复核原图在当前关系中的适用性</h4><button type="button" disabled={busy||storageError} onClick={beginInspect}>重读原图与复核记录</button></header>
   <p>重新核对实体关系变化后的适用性。复核会保留原采用记录，并单独登记当前结论。</p>
   {state&&draft&&<>
    {imageUrl&&<figure><a href={imageUrl} target="_blank" rel="noreferrer">{/* eslint-disable-next-line @next/next/no-img-element */}
     <img src={imageUrl} alt="本次关系复核的原图" style={{width:'100%',maxHeight:420,objectFit:'contain'}}/></a><figcaption>点击查看原图</figcaption></figure>}
    <details><summary>当前关系与原采用依据</summary><pre>{JSON.stringify({versionId:state.versionId,sha256:state.sha256,domainContext:state.domainContext,legacyAdoptionProof:state.legacyAdoptionProof},null,2)}</pre></details>
    {state.head&&<p>已有关系复核记录。是否可用以重读后的素材状态为准。</p>}
    {state.blockers.map(b=><p key={b}>{b}</p>)}
    {staleLocalDrafts.length>0&&<details><summary>依据变化前的本地观察稿（{staleLocalDrafts.length}）</summary>{staleLocalDrafts.map((old,index)=><div key={index}><p>原依据：{old.releaseId} · {old.basisHash}</p><pre>{JSON.stringify(old.content,null,2)}</pre></div>)}</details>}
    {state.staleDraft&&<details><summary>依据已变化的旧草稿</summary><pre>{JSON.stringify(state.staleDraft.content,null,2)}</pre></details>}
    <fieldset disabled={blocked}>
     <label><input type="checkbox" checked={draft.originalViewed} onChange={e=>edit({...draft,originalViewed:e.target.checked})}/>已查看此版本原图，并核对当前关系</label>
     {state.reviewSpec.criteria.map(c=>{const f=draft.criterionFindings.find(f=>f.criterionId===c.id);return <fieldset key={c.id}><legend>{c.label}</legend><p>{c.question}</p><label>判断<select value={f?.verdict||''} onChange={e=>edit({...draft,criterionFindings:draft.criterionFindings.map(f=>f.criterionId===c.id?{...f,verdict:e.target.value as typeof f.verdict}:f)})}><option value="">请选择</option><option value="PASS">通过</option><option value="FAIL">不通过</option>{c.allowNA&&<option value="NA">不适用</option>}</select></label><label>判断依据<textarea value={f?.note||''} onChange={e=>edit({...draft,criterionFindings:draft.criterionFindings.map(f=>f.criterionId===c.id?{...f,note:e.target.value}:f)})}/></label></fieldset>;})}
     <label>原图观察与当前适用范围<textarea value={draft.note} onChange={e=>edit({...draft,note:e.target.value})}/></label>
    </fieldset>
    <p>{dirty?'未保存内容已暂存于此浏览器。':''}{draft.criterionFindings.some(f=>f.verdict==='FAIL')?'存在不通过项：观察保留在本地，不能确认当前关系。':''}</p>
    <footer><button type="button" disabled={blocked||!dirty} onClick={()=>void act('save')}>保存复核草稿</button><button type="button" disabled={blocked||dirty||!state.draft} onClick={()=>void act('preview')}>预览关系复核</button></footer>
    {preview&&<section><h4>待登记关系复核</h4><p>{draft.note}</p><details><summary>完整复核内容</summary><pre>{JSON.stringify(preview.revalidation,null,2)}</pre></details><button type="button" disabled={blocked||dirty} onClick={()=>void act('publish')}>确认登记当前关系复核</button></section>}
    {state.jobs.map(j=><p key={j.jobId}>{jobs[j.status]}{j.error?'：'+j.error:''}{j.status==='SUCCEEDED'&&<button type="button" disabled={dirty||!!pending} onClick={()=>window.location.reload()}>读取素材最新状态</button>}</p>)}
   </>}
  </>}{message&&<p role="status">{message}</p>}
 </section>;
}
