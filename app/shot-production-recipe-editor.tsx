'use client';
import {useEffect,useState} from 'react';
import {useManagementDraftGuard} from './management-draft-guard';
import {readManagementResponse} from './system-management-client';
import './shot-production-recipe-editor.css';

type AuthorContent={model:string;prompt:string;negativePrompt:string;parameters:Record<string,unknown>};
type BoundInput={order:number;path:string;familyId?:string;versionId?:string;assetFamilyRef?:string;assetVersionRef?:string;sha256:string};
type Workspace={deliverableKey?:string;productionPurpose?:string|null;allowedUse?:string|null;releaseId:string;draftHeadRevisionId:string|null;draft:{revisionId:string;content:AuthorContent}|null;current:Record<string,unknown>|null;defaults:AuthorContent|null;inputs:BoundInput[];output:Record<string,unknown>|null;readOnly:boolean;blockers:string[];jobs?:Array<{jobId:string;status:string;error?:string}>};
type Preview={previewHash:string;definition?:unknown;bodydiff?:unknown};
const empty:AuthorContent={model:'',prompt:'',negativePrompt:'',parameters:{}};
function sourceContent(state:Workspace):AuthorContent{
 if(state.draft?.content)return state.draft.content;
 const current=state.current;if(!current)return state.defaults||empty;if(current.content)return current.content as AuthorContent;if(current.authorContent)return current.authorContent as AuthorContent;
 const model=current.model as {branch?:string;rawRule?:string}|undefined,prompt=current.prompt as {main?:string;negative?:string}|undefined;
 let parameters:Record<string,unknown>={};try{const parsed=JSON.parse(String(current.parametersRaw||'{}'));if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))parameters=parsed;}catch{/* original raw parameters remain visible in the immutable recipe */}
 return{model:typeof current.model==='string'?current.model:model?.branch||model?.rawRule||'',prompt:typeof current.prompt==='string'?current.prompt:prompt?.main||'',negativePrompt:String(current.negativePrompt||prompt?.negative||''),parameters};
}
export function ShotProductionRecipeEditor({workItemId,definitionRef,readOnly=false}:{workItemId:string;definitionRef?:string|null;readOnly?:boolean}){
 const [open,setOpen]=useState(false),[state,setState]=useState<Workspace|null>(null),[draft,setDraft]=useState<AuthorContent>(empty),[parameters,setParameters]=useState('{}'),[dirty,setDirty]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[uncertain,setUncertain]=useState(false),[preview,setPreview]=useState<Preview|null>(null),[refresh,setRefresh]=useState(0);
 useManagementDraftGuard(dirty||uncertain,'镜头调用包');
 useEffect(()=>{if(!open)return;const controller=new AbortController();fetch('/api/instance/shot-production/recipes?workItemId='+encodeURIComponent(workItemId),{cache:'no-store',signal:controller.signal}).then(readManagementResponse<Workspace>).then(result=>{if(controller.signal.aborted)return;const content=sourceContent(result);setState(result);setDraft(content);setParameters(JSON.stringify(content.parameters,null,2));setDirty(false);setUncertain(false);setPreview(null);setMessage('');}).catch(error=>{if(!controller.signal.aborted)setMessage(error instanceof Error?error.message:'调用包依据不可用');});return()=>controller.abort();},[open,workItemId,refresh]);
 function edit(field:keyof AuthorContent,value:string){if(field==='parameters')setParameters(value);else setDraft(current=>({...current,[field]:value}));setDirty(true);setPreview(null);}
 async function inspectUnconfirmed(){setBusy(true);try{const result=await readManagementResponse<Workspace>(await fetch('/api/instance/shot-production/recipes?workItemId='+encodeURIComponent(workItemId),{cache:'no-store'}));setState(result);setUncertain(false);setPreview(null);setMessage('已重读当前调用包及任务，本次编辑仍保留。请核对是否已经登记。');}catch(error){setMessage(error instanceof Error?error.message:'当前结果仍无法核查');}finally{setBusy(false);}}
 async function action(action:'save'|'preview'|'publish'){
  if(!state||readOnly||state.readOnly||busy||uncertain)return;setBusy(true);setMessage('');let submitted=false;
  try{
   let content:AuthorContent|undefined;if(action==='save'){const parsed=JSON.parse(parameters);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('参数必须填写JSON对象');if(!draft.model.trim()||!draft.prompt.trim())throw Error('请填写模型ID和完整主提示词');content={...draft,parameters:parsed};}
   const requestId='recipe-'+crypto.randomUUID(),body=action==='save'?{action,requestId,workItemId,expectedReleaseId:state.releaseId,expectedDraftRevisionId:state.draftHeadRevisionId,content}:{action,requestId,workItemId,draftRevisionId:state.draft?.revisionId,...(action==='publish'?{previewHash:preview?.previewHash}:{})};
   const operations=await readManagementResponse<{mutationEtag:string}>(await fetch('/api/v8/operations/snapshot?summary=1',{cache:'no-store'}));if(!operations.mutationEtag)throw Error('当前运行快照不可用');
   submitted=true;const response=await fetch('/api/instance/shot-production/recipes',{method:'POST',headers:{'Content-Type':'application/json','If-Match':operations.mutationEtag,'Idempotency-Key':requestId},body:JSON.stringify(body)});
   if(response.status>=400&&response.status<500)submitted=false;if(!response.ok)await readManagementResponse(response);
   const result=await response.json() as Preview&{jobId?:string;status?:string;revisionId?:string};
   if(!result||typeof result!=='object'||Array.isArray(result)||(action==='save'?typeof result.revisionId!=='string'||!result.revisionId.trim():action==='preview'?typeof result.previewHash!=='string'||!result.previewHash.trim():typeof result.jobId!=='string'||!result.jobId.trim()||result.status!=='QUEUED'))throw Error('服务返回的操作回执缺少草稿版本或任务依据');submitted=false;
   if(action==='preview'){setPreview(result);setMessage('请核对完整调用包和精确附件，再登记为当前执行定义。');}
   else if(action==='save'){setDirty(false);setRefresh(value=>value+1);}
   else{setPreview(null);setMessage('调用包登记任务已排队'+(result.jobId?'：'+result.jobId:'')+'。工作器处理后再按现有生成授权流程执行。');window.dispatchEvent(new Event('review:operations-updated'));}
  }catch(error){if(submitted)setUncertain(true);setMessage((error instanceof Error?error.message:'操作失败')+(submitted?'；提交结果尚未确认，请重读当前调用包与任务后再操作。':''));}finally{setBusy(false);}
 }
 if(readOnly)return null;
 return <section className="shot-production-recipe-editor" aria-label="镜头调用包编写">
  {!open?<button type="button" onClick={()=>setOpen(true)}>{definitionRef?'编写调用包新修订':'编写本工作项调用包'}</button>:<>
   <header><h4>本工作项调用包</h4><button type="button" disabled={busy||(dirty&&!uncertain)} onClick={()=>{if(uncertain)void inspectUnconfirmed();else{setState(null);setRefresh(value=>value+1);}}}>重读调用包与任务</button></header>
   <p>保存作者草稿，核对当前附件与预期输出，再由工作器登记执行定义。模型调用使用独立的生成授权。</p>
   {state?<>
    {state.allowedUse==='PREVIS_TIMING'&&<p>本产物仅用于粗分镜与预演锁时。临时对白不要求正式声音母版；进入最终对白制作时另建独立产物。</p>}
    {state.blockers.map(reason=><p key={reason} role="status">{reason}</p>)}
    <fieldset disabled={state.readOnly||busy||uncertain}><label>模型ID<input value={draft.model} onChange={e=>edit('model',e.target.value)} autoComplete="off"/></label><label>完整主提示词<textarea value={draft.prompt} onChange={e=>edit('prompt',e.target.value)}/></label><label>完整负面提示词<textarea value={draft.negativePrompt} onChange={e=>edit('negativePrompt',e.target.value)}/></label><label>模型参数（JSON对象）<textarea value={parameters} onChange={e=>edit('parameters',e.target.value)} spellCheck={false}/></label></fieldset>
    <details open><summary>当前精确附件与预期输出</summary>{state.inputs.length?<ol>{state.inputs.map(input=><li key={input.order+':'+input.path}><b>{input.order}. {input.assetVersionRef||input.versionId}</b><span>{input.path}</span><code>SHA {input.sha256}</code></li>)}</ol>:<p>当前派生附件清单为空。</p>}<pre>{JSON.stringify(state.output,null,2)}</pre></details>
    <footer><button type="button" disabled={state.readOnly||busy||uncertain||!dirty} onClick={()=>void action('save')}>保存调用包草稿</button><button type="button" disabled={state.readOnly||busy||uncertain||dirty||!state.draft||state.blockers.length>0} onClick={()=>void action('preview')}>预览完整调用包</button></footer>
    {preview&&<section className="shot-recipe-preview"><h4>待登记调用包</h4><pre>{JSON.stringify(preview.definition||preview.bodydiff||preview,null,2)}</pre><button type="button" disabled={state.readOnly||busy||uncertain||dirty} onClick={()=>void action('publish')}>确认登记调用包</button></section>}
    {state.jobs?.map(job=><p key={job.jobId}>任务 {job.jobId} · {job.status}{job.error?' · '+job.error:''}</p>)}
   </>:<p role="status">正在读取当前制作依据…</p>}
   <button type="button" disabled={busy||uncertain} onClick={()=>{if(!dirty||confirm('放弃这次尚未保存的调用包修改？')){setDirty(false);setOpen(false);}}}>收起编写</button>
  </>}
  {message&&<p role="status">{message}</p>}
 </section>;
}
