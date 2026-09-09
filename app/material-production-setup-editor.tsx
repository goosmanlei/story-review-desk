'use client';
import {useEffect,useRef,useState} from 'react';
import {useRuntimeMode} from './runtime-mode';
import {useManagementDraftGuard} from './management-draft-guard';
import './shot-production-recipe-editor.css';
type Binding={familyId:string;versionId:string;sha256:string};
type Content={model:string;prompt:string;negativePrompt:string;parameters:Record<string,unknown>;inputBindings:Binding[]};
type Workspace={rebase?:{beforeHash:string;afterHash:string;changes:Array<{path:string;before:unknown;after:unknown}>};releaseId:string;basisHash:string;mode?:'FIRST_SETUP'|'REVISION'|'LEGACY_AUDIO_REVISION'|'REQUIREMENT_REBASE';familyId?:string|null;parentVersionId?:string|null;parentVersionSha256?:string|null;plannedVersionLabel?:string;currentDefinitionId?:string|null;currentRegistration:{familyId:string}|null;readOnly:boolean;draftHeadRevisionId:string|null;draft:{revisionId:string;content:Content;mode?:string;basisHash?:string;baseReleaseId?:string;acknowledgement?:unknown}|null;staleDraft?:{revisionId:string;content:Content;reason:string}|null;defaults:Content|null;availableInputs:Array<Binding&{label:string;kind:string}>;blockers:string[];jobs:Array<{jobId:string;status:string;error?:string;mode?:string;basisHash?:string}>};
type Preview={previewHash:string;definition?:unknown;[key:string]:unknown};
const canonical=(value:unknown):string=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical((value as Record<string,unknown>)[key])).join(',')+'}':JSON.stringify(value);
const empty:Content={model:'',prompt:'',negativePrompt:'',parameters:{},inputBindings:[]};
async function read<T>(response:Response):Promise<T>{const value=await response.json() as {error?:string|{message?:string};message?:string};if(!response.ok)throw Error(typeof value?.error==='string'?value.error:value?.message||value?.error?.message||'制作资料读取失败');return value as T;}
function validWorkspace(value:Workspace,expectedRevision=false,expectedMode?:'REQUIREMENT_REBASE'){
 if(expectedMode!==undefined&&value?.mode!==expectedMode||expectedMode===undefined&&value?.mode==='REQUIREMENT_REBASE')throw Error('制作资料协议与当前明确选择不一致');
 const binding=(b:Binding)=>b&&typeof b.familyId==='string'&&typeof b.versionId==='string'&&/^[a-f0-9]{64}$/.test(b.sha256);
 const content=(c:Content)=>c&&typeof c.model==='string'&&typeof c.prompt==='string'&&typeof c.negativePrompt==='string'&&c.parameters&&typeof c.parameters==='object'&&!Array.isArray(c.parameters)&&Array.isArray(c.inputBindings)&&c.inputBindings.every(binding);
 if(!value||typeof value.releaseId!=='string'||typeof value.readOnly!=='boolean'||!/^([a-f0-9]{64})$/.test(value.basisHash)||!(value.draftHeadRevisionId===null||typeof value.draftHeadRevisionId==='string')||!(value.draft===null||(typeof value.draft?.revisionId==='string'&&content(value.draft.content)))||!(value.defaults===null||content(value.defaults))||!Array.isArray(value.availableInputs)||!value.availableInputs.every(b=>binding(b)&&typeof b.label==='string'&&typeof b.kind==='string')||!Array.isArray(value.blockers)||!value.blockers.every(b=>typeof b==='string')||!Array.isArray(value.jobs)||!value.jobs.every(j=>j&&typeof j.jobId==='string'&&typeof j.status==='string'))throw Error('制作资料回执不完整');
 if(value.mode!==undefined&&!['FIRST_SETUP','REVISION','LEGACY_AUDIO_REVISION','REQUIREMENT_REBASE'].includes(value.mode)||expectedRevision&&!['REVISION','LEGACY_AUDIO_REVISION','REQUIREMENT_REBASE'].includes(value.mode||'')||['REVISION','LEGACY_AUDIO_REVISION','REQUIREMENT_REBASE'].includes(value.mode||'')&&!value.blockers.length&&(!(value.mode==='LEGACY_AUDIO_REVISION'?value.familyId:value.currentRegistration?.familyId)||!value.parentVersionId||!/^[a-f0-9]{64}$/.test(value.parentVersionSha256||'')||!/^V\d{3,}$/.test(value.plannedVersionLabel||'')||!value.currentDefinitionId))throw Error('素材版本依据不完整');
 if(value.mode==='REQUIREMENT_REBASE'&&(!value.rebase||!/^[a-f0-9]{64}$/.test(value.rebase.beforeHash)||!/^[a-f0-9]{64}$/.test(value.rebase.afterHash)||!Array.isArray(value.rebase.changes)||!value.rebase.changes.length))throw Error('新旧需求差异依据不完整');
 if(value.staleDraft&&(value.draft!==null||typeof value.staleDraft.revisionId!=='string'||typeof value.staleDraft.reason!=='string'||!content(value.staleDraft.content)))throw Error('旧稿回执不完整');return value;
}
export function MaterialProductionSetupEditor({requirementId,revision=false}:{requirementId:string;revision?:boolean}){const {hostedReadOnly}=useRuntimeMode();return hostedReadOnly?null:<Editor key={requirementId+':'+revision} requirementId={requirementId} revision={revision}/>;}
function Editor({requirementId,revision}:{requirementId:string;revision:boolean}){
 const [open,setOpen]=useState(false),[state,setState]=useState<Workspace|null>(null),[draft,setDraft]=useState<Content>(empty),[parameters,setParameters]=useState('{}'),[dirty,setDirty]=useState(false),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false),[message,setMessage]=useState(''),[preview,setPreview]=useState<Preview|null>(null);
 useManagementDraftGuard(dirty||uncertain,'素材制作资料');
 const [mode,setMode]=useState<'REQUIREMENT_REBASE'|undefined>(),[acknowledged,setAcknowledged]=useState(false),[rebaseNote,setRebaseNote]=useState('');
 const pendingWrite=useRef<{action:string;content?:Content;acknowledgement?:unknown;priorHead:string|null;basisHash:string;releaseId:string}|null>(null);
 const dirtyRef=useRef(dirty);useEffect(()=>{dirtyRef.current=dirty;},[dirty]);
 const endpoint='/api/instance/material-production',workspaceUrl=endpoint+'?requirementId='+encodeURIComponent(requirementId)+(mode?'&mode='+mode:'');
 const revising=['REVISION','LEGACY_AUDIO_REVISION','REQUIREMENT_REBASE'].includes(state?.mode||'')||revision;
 useEffect(()=>{if(!open)return;const controller=new AbortController();void fetch(workspaceUrl,{cache:'no-store',signal:controller.signal}).then(read<Workspace>).then(value=>validWorkspace(value,revision,mode)).then(value=>{if(controller.signal.aborted)return;const content=value.draft?.content||value.staleDraft?.content||value.defaults||empty;setState(value);if(!dirtyRef.current){setDraft(content);setParameters(JSON.stringify(content.parameters,null,2));}setDirty(dirtyRef.current||Boolean(value.staleDraft)||value.mode==='REQUIREMENT_REBASE');setAcknowledged(false);setMessage(value.staleDraft?'已恢复之前的草稿。请核对当前版本与参考素材后重新保存。':'');}).catch(e=>{if(!controller.signal.aborted)setMessage(e.message);});return()=>controller.abort();},[open,workspaceUrl,revision,mode]);
 function edit(patch:Partial<Content>){setDraft(d=>({...d,...patch}));setDirty(true);setPreview(null);}
 async function inspect(){setBusy(true);try{
  const pending=mode&&!uncertain?state?.jobs.find(job=>job.mode===mode&&job.basisHash===state.basisHash&&['QUEUED','RUNNING','RESULT_UNKNOWN','SUCCEEDED'].includes(job.status)):null;
  if(pending){
   const job=await read<{schemaVersion:string;requirementId:string;jobId:string;mode:string;status:string;error?:string;result?:{releaseId:string;mode:string}}>(await fetch(endpoint+'?requirementId='+encodeURIComponent(requirementId)+'&jobId='+encodeURIComponent(pending.jobId),{cache:'no-store'}));
   if(job.schemaVersion!=='MATERIAL_PRODUCTION_JOB_STATUS_V1'||job.requirementId!==requirementId||job.jobId!==pending.jobId||job.mode!==mode||!['QUEUED','RUNNING','RESULT_UNKNOWN','SUCCEEDED','FAILED'].includes(job.status))throw Error('制作任务回执不完整');
   if(job.status==='SUCCEEDED'){
    if(!job.result?.releaseId||job.result.mode!==mode)throw Error('制作任务成功回执不完整');
    setMode(undefined);setState(null);setPreview(null);setAcknowledged(false);setUncertain(false);setMessage('新需求基线已登记，正在读取当前制作资料；未提交编辑仍保留。');return;
   }
   setState(previous=>previous?{...previous,jobs:previous.jobs.map(value=>value.jobId===job.jobId?{...value,jobId:job.jobId,status:job.status,error:job.error}:value)}:previous);setUncertain(job.status==='RESULT_UNKNOWN');setMessage(job.status==='FAILED'?'制作任务失败：'+(job.error||'请核查原任务'):'制作任务尚未完成，请等待受控工作器回执。');return;
  }
  const next=validWorkspace(await read<Workspace>(await fetch(workspaceUrl,{cache:'no-store'})),revision,mode);if(mode&&next.basisHash!==state?.basisHash){setAcknowledged(false);setDirty(true);}setState(next);setPreview(null);
  if(mode&&uncertain){
   const pending=pendingWrite.current,saved=next.draft;
   const proven=pending?.action==='save'&&saved&&saved.revisionId!==pending.priorHead&&saved.revisionId===next.draftHeadRevisionId&&next.basisHash===pending.basisHash&&next.releaseId===pending.releaseId&&saved.mode===mode&&saved.baseReleaseId===pending.releaseId&&saved.basisHash===pending.basisHash&&canonical(saved.content)===canonical(pending.content)&&canonical(saved.acknowledgement)===canonical(pending.acknowledgement);
   if(!proven){setMessage('尚未核到本次提交的精确保存或任务结果；保留编辑，禁止重发。');return;}
   pendingWrite.current=null;setUncertain(false);setDirty(false);setMessage('当前内容已核实保存；这不是对丢失的原请求回执作推断。');return;
  }
  setUncertain(false);setMessage('已重读当前制作资料及任务，本次编辑仍保留。请核对已登记结果。');}catch(e){setMessage(e instanceof Error?e.message:'尚无法核查结果');}finally{setBusy(false);}}
 async function act(action:'save'|'preview'|'publish'){
  if(!state||state.readOnly||busy||uncertain||mode&&(!acknowledged||!rebaseNote.trim())||state.mode==='LEGACY_AUDIO_REVISION'&&state.blockers.length)return;setBusy(true);setMessage('');let submitted=false;
  try{
   let content:Content|undefined;if(action==='save'){const parsed=JSON.parse(parameters);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('参数必须填写JSON对象');content={...draft,parameters:parsed};}
   const operations=await read<{mutationEtag:string}>(await fetch('/api/v8/operations/snapshot?summary=1',{cache:'no-store'}));if(!operations.mutationEtag)throw Error('当前版本不可用');
   const protocol=mode?{mode}:{};const body=action==='save'?{action,requirementId,...protocol,...(mode?{acknowledgement:{confirmed:acknowledged,beforeHash:state.rebase?.beforeHash,afterHash:state.rebase?.afterHash,note:rebaseNote}}:{}),expectedReleaseId:state.releaseId,expectedDraftRevisionId:state.draftHeadRevisionId,...(revising?{expectedBasisHash:state.basisHash}:{}),content}:{action,requirementId,...protocol,draftRevisionId:state.draft?.revisionId,...(action==='publish'?{previewHash:preview?.previewHash}:{})};
   if(mode)pendingWrite.current={action,content:content?structuredClone(content):undefined,acknowledgement:action==='save'?(body as {acknowledgement?:unknown}).acknowledgement:undefined,priorHead:state.draftHeadRevisionId,basisHash:state.basisHash,releaseId:state.releaseId};
   submitted=true;const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','If-Match':operations.mutationEtag,'Idempotency-Key':'material-setup:'+crypto.randomUUID()},body:JSON.stringify(body)});if(!response.ok&&response.status<500)submitted=false;
   const value=await read<Record<string,unknown>>(response);if(!value||typeof value!=='object'||(action==='save'?typeof value.revisionId!=='string'||!value.revisionId.trim():action==='preview'?typeof value.previewHash!=='string'||!/^([a-f0-9]{64})$/.test(value.previewHash)||!(value.plan&&typeof value.plan==='object'&&(value.plan as {requirementId?:string;basisHash?:string}).requirementId===requirementId&&(value.plan as {basisHash?:string}).basisHash===state.basisHash&&(!mode||((value.plan as {mode?:string}).mode===mode&&(value.plan as {schemaVersion?:string}).schemaVersion==='MATERIAL_PRODUCTION_REQUIREMENT_REBASE_V1'))):typeof value.jobId!=='string'||!value.jobId.trim()||value.status!=='QUEUED'))throw Error('制作资料回执不完整');submitted=false;pendingWrite.current=null;
   if(action==='save'){setState({...state,staleDraft:null,draftHeadRevisionId:String(value.revisionId),draft:{revisionId:String(value.revisionId),content:content!}});setDirty(false);setMessage('草稿已保存，请预览制作资料。');}
   else if(action==='preview'){setPreview(value as Preview);setMessage('请核对素材归属、附件与完整调用包。');}
   else{setPreview(null);setState({...state,jobs:[{jobId:String(value.jobId),status:String(value.status||'QUEUED'),...(mode?{mode,basisHash:state.basisHash}:{})},...state.jobs]});setMessage('制作资料登记任务已排队。完成后可在本素材卡中继续生成与审阅。');window.dispatchEvent(new Event('review:operations-updated'));}
  }catch(e){if(submitted)setUncertain(true);setMessage((e instanceof Error?e.message:'操作失败')+(submitted?'；提交结果尚未确认，请重读制作资料及任务后再操作。':''));}finally{setBusy(false);}
 }
 return <section className="shot-production-recipe-editor" aria-label="基础素材制作资料">
  {!open?<button type="button" onClick={()=>setOpen(true)}>{revision?'修订素材制作资料':'建立素材制作资料'}</button>:<>
   <header><h4>{revising?'制作本素材的下一候选版本':'建立本素材的制作资料'}</h4><button type="button" disabled={busy} onClick={()=>void inspect()}>重读制作资料与任务</button></header>
   <p>{revising?'结合审阅意见修改提示词和参考素材，登记下一候选版本；通过审阅后采用。':'核对所属需求和参考素材，填写完整调用包。登记后再生成候选并审阅。'}</p>
   {!mode&&message.includes('当前需求已偏离首次制作建档闭包')&&<button type="button" disabled={busy||uncertain} onClick={()=>{setMode('REQUIREMENT_REBASE');setPreview(null);}}>查看已发布需求差异，明确建立新制作基线</button>}
   {state?.mode==='REQUIREMENT_REBASE'&&state.rebase&&<section><h4>新旧需求差异</h4><p>原版本和审阅保留。这次只为当前需求建立新候选，沿用原审阅标准，旧通过不会替代新条件的审阅。</p>{state.rebase.changes.map((change,index)=><details key={change.path+index} open><summary>{change.path}</summary><p>原要求</p><pre>{JSON.stringify(change.before,null,2)}</pre><p>当前要求</p><pre>{JSON.stringify(change.after,null,2)}</pre></details>)}<label><input type="checkbox" disabled={busy||uncertain} checked={acknowledged} onChange={e=>{setAcknowledged(e.target.checked);setDirty(true);setPreview(null);}}/>我已核对差异，明确按新基线制作下一候选</label><label>新基线制作说明<textarea disabled={busy||uncertain} value={rebaseNote} onChange={e=>{setRebaseNote(e.target.value);setDirty(true);setPreview(null);}}/></label></section>}
   {revising&&state?.parentVersionId&&<p>基于版本：{state.parentVersionId}{state.plannedVersionLabel?' · 下一候选：'+state.plannedVersionLabel:''}</p>}
   {state?.staleDraft&&<p>之前的草稿依据已变化：{state.staleDraft.reason}</p>}
   {state&&<>{state.blockers.map(reason=><p key={reason}>{reason}</p>)}
    <fieldset disabled={state.readOnly||busy||uncertain||state.mode==='LEGACY_AUDIO_REVISION'&&state.blockers.length>0}><label>模型ID<input value={draft.model} onChange={e=>edit({model:e.target.value})}/></label><label>完整主提示词<textarea value={draft.prompt} onChange={e=>edit({prompt:e.target.value})}/></label><label>完整负面提示词<textarea value={draft.negativePrompt} onChange={e=>edit({negativePrompt:e.target.value})}/></label><label>模型参数（JSON对象）<textarea value={parameters} onChange={e=>{setParameters(e.target.value);setDirty(true);setPreview(null);}} spellCheck={false}/></label>
     <fieldset><legend>已采用的参考素材</legend>{state.availableInputs.map(input=><label key={input.versionId}><input type="checkbox" checked={draft.inputBindings.some(b=>b.familyId===input.familyId&&b.versionId===input.versionId&&b.sha256===input.sha256)} onChange={e=>edit({inputBindings:e.target.checked?[...draft.inputBindings,{familyId:input.familyId,versionId:input.versionId,sha256:input.sha256}]:draft.inputBindings.filter(b=>b.familyId!==input.familyId)})}/>{input.label} · {input.kind} · {input.versionId}</label>)}{!state.availableInputs.length&&<p>暂无已采用的参考素材。</p>}</fieldset>
     {draft.inputBindings.filter(binding=>!state.availableInputs.some(input=>input.familyId===binding.familyId&&input.versionId===binding.versionId&&input.sha256===binding.sha256)).map(binding=><p key={binding.versionId+binding.sha256}>原引用已不在当前采用列表：{binding.versionId} <button type="button" onClick={()=>edit({inputBindings:draft.inputBindings.filter(item=>item!==binding)})}>移除此引用</button></p>)}
    </fieldset>
    <footer><button type="button" disabled={state.readOnly||busy||uncertain||!!mode&&(!acknowledged||!rebaseNote.trim())||!dirty||state.mode==='LEGACY_AUDIO_REVISION'&&state.blockers.length>0} onClick={()=>void act('save')}>保存制作资料草稿</button><button type="button" disabled={state.readOnly||busy||uncertain||dirty||!state.draft||state.blockers.length>0} onClick={()=>void act('preview')}>预览素材制作资料</button></footer>
    {preview&&<section><h4>待登记制作资料</h4><p>模型：{draft.model} · 已采用参考：{draft.inputBindings.length} 项</p><p>主提示词</p><pre>{draft.prompt}</pre>{draft.negativePrompt&&<><p>排除要求</p><pre>{draft.negativePrompt}</pre></>}<details><summary>查看素材归属、完整调用包与版本证据</summary><pre>{JSON.stringify(preview,null,2)}</pre></details><button type="button" disabled={state.readOnly||busy||uncertain||dirty} onClick={()=>void act('publish')}>{revising?'确认建立下一候选版本':'确认建立制作资料'}</button></section>}
    {(state.currentRegistration||state.jobs.some(job=>job.status==='SUCCEEDED'))&&<button type="button" onClick={()=>window.location.reload()}>读取已登记的素材卡</button>}
    {state.jobs.map(job=><p key={job.jobId}>任务 {job.jobId} · {job.status}{job.error?' · '+job.error:''}</p>)}
   </>}
  </>}{message&&<p role="status">{message}</p>}
 </section>;
}
