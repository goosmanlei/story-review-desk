'use client';
import {useEffect,useState} from 'react';
import {useRuntimeMode} from './runtime-mode';
import {useManagementDraftGuard} from './management-draft-guard';
import './shot-production-recipe-editor.css';
type Binding={familyId:string;versionId:string;sha256:string};
type Content={model:string;prompt:string;negativePrompt:string;parameters:Record<string,unknown>;inputBindings:Binding[]};
type Workspace={releaseId:string;basisHash:string;mode?:'FIRST_SETUP'|'REVISION';parentVersionId?:string|null;parentVersionSha256?:string|null;plannedVersionLabel?:string;currentDefinitionId?:string|null;currentRegistration:{familyId:string}|null;readOnly:boolean;draftHeadRevisionId:string|null;draft:{revisionId:string;content:Content}|null;staleDraft?:{revisionId:string;content:Content;reason:string}|null;defaults:Content|null;availableInputs:Array<Binding&{label:string;kind:string}>;blockers:string[];jobs:Array<{jobId:string;status:string;error?:string}>};
type Preview={previewHash:string;definition?:unknown;[key:string]:unknown};
const empty:Content={model:'',prompt:'',negativePrompt:'',parameters:{},inputBindings:[]};
async function read<T>(response:Response):Promise<T>{const value=await response.json() as {error?:string|{message?:string};message?:string};if(!response.ok)throw Error(typeof value?.error==='string'?value.error:value?.message||value?.error?.message||'制作资料读取失败');return value as T;}
function validWorkspace(value:Workspace,expectedRevision=false){
 const binding=(b:Binding)=>b&&typeof b.familyId==='string'&&typeof b.versionId==='string'&&/^[a-f0-9]{64}$/.test(b.sha256);
 const content=(c:Content)=>c&&typeof c.model==='string'&&typeof c.prompt==='string'&&typeof c.negativePrompt==='string'&&c.parameters&&typeof c.parameters==='object'&&!Array.isArray(c.parameters)&&Array.isArray(c.inputBindings)&&c.inputBindings.every(binding);
 if(!value||typeof value.releaseId!=='string'||typeof value.readOnly!=='boolean'||!/^([a-f0-9]{64})$/.test(value.basisHash)||!(value.draftHeadRevisionId===null||typeof value.draftHeadRevisionId==='string')||!(value.draft===null||(typeof value.draft?.revisionId==='string'&&content(value.draft.content)))||!(value.defaults===null||content(value.defaults))||!Array.isArray(value.availableInputs)||!value.availableInputs.every(b=>binding(b)&&typeof b.label==='string'&&typeof b.kind==='string')||!Array.isArray(value.blockers)||!value.blockers.every(b=>typeof b==='string')||!Array.isArray(value.jobs)||!value.jobs.every(j=>j&&typeof j.jobId==='string'&&typeof j.status==='string'))throw Error('制作资料回执不完整');
 if(value.mode!==undefined&&!['FIRST_SETUP','REVISION'].includes(value.mode)||expectedRevision&&value.mode!=='REVISION'||value.mode==='REVISION'&&!value.blockers.length&&(!value.currentRegistration?.familyId||!value.parentVersionId||!/^[a-f0-9]{64}$/.test(value.parentVersionSha256||'')||!/^V\d{3,}$/.test(value.plannedVersionLabel||'')||!value.currentDefinitionId))throw Error('素材版本依据不完整');
 if(value.staleDraft&&(value.draft!==null||typeof value.staleDraft.revisionId!=='string'||typeof value.staleDraft.reason!=='string'||!content(value.staleDraft.content)))throw Error('旧稿回执不完整');return value;
}
export function MaterialProductionSetupEditor({requirementId,revision=false}:{requirementId:string;revision?:boolean}){const {hostedReadOnly}=useRuntimeMode();return hostedReadOnly?null:<Editor key={requirementId+':'+revision} requirementId={requirementId} revision={revision}/>;}
function Editor({requirementId,revision}:{requirementId:string;revision:boolean}){
 const [open,setOpen]=useState(false),[state,setState]=useState<Workspace|null>(null),[draft,setDraft]=useState<Content>(empty),[parameters,setParameters]=useState('{}'),[dirty,setDirty]=useState(false),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false),[message,setMessage]=useState(''),[preview,setPreview]=useState<Preview|null>(null);
 useManagementDraftGuard(dirty||uncertain,'素材制作资料');
 const endpoint='/api/instance/material-production';
 const revising=state?.mode==='REVISION'||revision;
 useEffect(()=>{if(!open)return;const controller=new AbortController();void fetch(endpoint+'?requirementId='+encodeURIComponent(requirementId),{cache:'no-store',signal:controller.signal}).then(read<Workspace>).then(value=>validWorkspace(value,revision)).then(value=>{if(controller.signal.aborted)return;const content=value.draft?.content||value.staleDraft?.content||value.defaults||empty;setState(value);setDraft(content);setParameters(JSON.stringify(content.parameters,null,2));setDirty(Boolean(value.staleDraft));setMessage(value.staleDraft?'已恢复之前的草稿。请核对当前版本与参考素材后重新保存。':'');}).catch(e=>{if(!controller.signal.aborted)setMessage(e.message);});return()=>controller.abort();},[open,requirementId,revision]);
 function edit(patch:Partial<Content>){setDraft(d=>({...d,...patch}));setDirty(true);setPreview(null);}
 async function inspect(){setBusy(true);try{const next=validWorkspace(await read<Workspace>(await fetch(endpoint+'?requirementId='+encodeURIComponent(requirementId),{cache:'no-store'})),revision);setState(next);setUncertain(false);setPreview(null);setMessage('已重读当前制作资料及任务，本次编辑仍保留。请核对已登记结果。');}catch(e){setMessage(e instanceof Error?e.message:'尚无法核查结果');}finally{setBusy(false);}}
 async function act(action:'save'|'preview'|'publish'){
  if(!state||state.readOnly||busy||uncertain)return;setBusy(true);setMessage('');let submitted=false;
  try{
   let content:Content|undefined;if(action==='save'){const parsed=JSON.parse(parameters);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('参数必须填写JSON对象');content={...draft,parameters:parsed};}
   const operations=await read<{mutationEtag:string}>(await fetch('/api/v8/operations/snapshot?summary=1',{cache:'no-store'}));if(!operations.mutationEtag)throw Error('当前版本不可用');
   const body=action==='save'?{action,requirementId,expectedReleaseId:state.releaseId,expectedDraftRevisionId:state.draftHeadRevisionId,...(revising?{expectedBasisHash:state.basisHash}:{}),content}:{action,requirementId,draftRevisionId:state.draft?.revisionId,...(action==='publish'?{previewHash:preview?.previewHash}:{})};
   submitted=true;const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','If-Match':operations.mutationEtag,'Idempotency-Key':'material-setup:'+crypto.randomUUID()},body:JSON.stringify(body)});if(!response.ok&&response.status<500)submitted=false;
   const value=await read<Record<string,unknown>>(response);if(!value||typeof value!=='object'||(action==='save'?typeof value.revisionId!=='string'||!value.revisionId.trim():action==='preview'?typeof value.previewHash!=='string'||!/^([a-f0-9]{64})$/.test(value.previewHash)||!(value.plan&&typeof value.plan==='object'&&(value.plan as {requirementId?:string;basisHash?:string}).requirementId===requirementId&&(value.plan as {basisHash?:string}).basisHash===state.basisHash):typeof value.jobId!=='string'||!value.jobId.trim()||value.status!=='QUEUED'))throw Error('制作资料回执不完整');submitted=false;
   if(action==='save'){setState({...state,staleDraft:null,draftHeadRevisionId:String(value.revisionId),draft:{revisionId:String(value.revisionId),content:content!}});setDirty(false);setMessage('草稿已保存，请预览制作资料。');}
   else if(action==='preview'){setPreview(value as Preview);setMessage('请核对素材归属、附件与完整调用包。');}
   else{setPreview(null);setState({...state,jobs:[{jobId:String(value.jobId),status:String(value.status||'QUEUED')},...state.jobs]});setMessage('制作资料登记任务已排队。完成后可在本素材卡中继续生成与审阅。');window.dispatchEvent(new Event('review:operations-updated'));}
  }catch(e){if(submitted)setUncertain(true);setMessage((e instanceof Error?e.message:'操作失败')+(submitted?'；提交结果尚未确认，请重读制作资料及任务后再操作。':''));}finally{setBusy(false);}
 }
 return <section className="shot-production-recipe-editor" aria-label="基础素材制作资料">
  {!open?<button type="button" onClick={()=>setOpen(true)}>{revision?'修订素材制作资料':'建立素材制作资料'}</button>:<>
   <header><h4>{revising?'制作本素材的下一候选版本':'建立本素材的制作资料'}</h4><button type="button" disabled={busy} onClick={()=>void inspect()}>重读制作资料与任务</button></header>
   <p>{revising?'结合审阅意见修改提示词和参考素材，登记下一候选版本；通过审阅后采用。':'核对所属需求和参考素材，填写完整调用包。登记后再生成候选并审阅。'}</p>
   {revising&&state?.parentVersionId&&<p>基于版本：{state.parentVersionId}{state.plannedVersionLabel?' · 下一候选：'+state.plannedVersionLabel:''}</p>}
   {state?.staleDraft&&<p>之前的草稿依据已变化：{state.staleDraft.reason}</p>}
   {state&&<>{state.blockers.map(reason=><p key={reason}>{reason}</p>)}
    <fieldset disabled={state.readOnly||busy||uncertain}><label>模型ID<input value={draft.model} onChange={e=>edit({model:e.target.value})}/></label><label>完整主提示词<textarea value={draft.prompt} onChange={e=>edit({prompt:e.target.value})}/></label><label>完整负面提示词<textarea value={draft.negativePrompt} onChange={e=>edit({negativePrompt:e.target.value})}/></label><label>模型参数（JSON对象）<textarea value={parameters} onChange={e=>{setParameters(e.target.value);setDirty(true);setPreview(null);}} spellCheck={false}/></label>
     <fieldset><legend>已采用的参考素材</legend>{state.availableInputs.map(input=><label key={input.versionId}><input type="checkbox" checked={draft.inputBindings.some(b=>b.familyId===input.familyId&&b.versionId===input.versionId&&b.sha256===input.sha256)} onChange={e=>edit({inputBindings:e.target.checked?[...draft.inputBindings,{familyId:input.familyId,versionId:input.versionId,sha256:input.sha256}]:draft.inputBindings.filter(b=>b.familyId!==input.familyId)})}/>{input.label} · {input.kind} · {input.versionId}</label>)}{!state.availableInputs.length&&<p>暂无已采用的参考素材。</p>}</fieldset>
     {draft.inputBindings.filter(binding=>!state.availableInputs.some(input=>input.familyId===binding.familyId&&input.versionId===binding.versionId&&input.sha256===binding.sha256)).map(binding=><p key={binding.versionId+binding.sha256}>原引用已不在当前采用列表：{binding.versionId} <button type="button" onClick={()=>edit({inputBindings:draft.inputBindings.filter(item=>item!==binding)})}>移除此引用</button></p>)}
    </fieldset>
    <footer><button type="button" disabled={state.readOnly||busy||uncertain||!dirty} onClick={()=>void act('save')}>保存制作资料草稿</button><button type="button" disabled={state.readOnly||busy||uncertain||dirty||!state.draft||state.blockers.length>0} onClick={()=>void act('preview')}>预览素材制作资料</button></footer>
    {preview&&<section><h4>待登记制作资料</h4><p>模型：{draft.model} · 已采用参考：{draft.inputBindings.length} 项</p><p>主提示词</p><pre>{draft.prompt}</pre>{draft.negativePrompt&&<><p>排除要求</p><pre>{draft.negativePrompt}</pre></>}<details><summary>查看素材归属、完整调用包与版本证据</summary><pre>{JSON.stringify(preview,null,2)}</pre></details><button type="button" disabled={state.readOnly||busy||uncertain||dirty} onClick={()=>void act('publish')}>{revising?'确认建立下一候选版本':'确认建立制作资料'}</button></section>}
    {(state.currentRegistration||state.jobs.some(job=>job.status==='SUCCEEDED'))&&<button type="button" onClick={()=>window.location.reload()}>读取已登记的素材卡</button>}
    {state.jobs.map(job=><p key={job.jobId}>任务 {job.jobId} · {job.status}{job.error?' · '+job.error:''}</p>)}
   </>}
  </>}{message&&<p role="status">{message}</p>}
 </section>;
}
