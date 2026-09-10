'use client';

import {runtimePath} from './runtime-path';
import {useEffect,useState} from 'react';
import {useRuntimeMode} from './runtime-mode';
import {managementMutation,readManagementResponse} from './system-management-client';
import type {SourceBinding} from '../host/instance-runtime/domain-model.mjs';
import type {AuthoringRoot,AuthoringRootInput} from '../host/instance-runtime/domain-authoring.mjs';
import {useManagementDraftGuard} from './management-draft-guard';
import './system-management.css';
type Kind=AuthoringRootInput['kind'];
type Candidate={creativeRevisionId:string;rootId:string|null;rootRevisionId:string|null;review:Record<string,unknown>|null};
type AuthoringState={releaseId:string;roots:AuthoringRoot[];readOnly?:boolean;initializationReady?:boolean;sourceBindings?:SourceBinding[];sourceChoices?:Array<SourceBinding&{title:string}>;candidates?:Candidate[];adoptedCreativeRevisionId?:string|null};
type AdoptionInput={expectedReleaseId:string;rootId:string;expectedRevisionId:string;creativeRevisionId:string;reviewEventId:string};
const labels:Record<Kind,string>={STORY_OUTLINE:'故事结构草稿',SCREENPLAY:'完整剧本草稿',SCENE_SCRIPT:'场正文草稿',EPISODE_PLAN:'分集方案草稿'};
type FormValues={title:string;body:string;parentId:string;sceneIds:string[];planText:string};
function valuesOf(root?:AuthoringRoot):FormValues{return{title:root?.title||'',body:root?.body||'',parentId:root?.parentId||'',sceneIds:root?.sceneIds||[],planText:root?.planContent?JSON.stringify(root.planContent,null,2):''};}
export function GenericAuthoringWorkspace({kind}:{kind:Kind}){return <AuthoringEditor key={kind} kind={kind}/>;}
function AuthoringEditor({kind}:{kind:Kind}){
 const {hostedReadOnly}=useRuntimeMode();
 const [state,setState]=useState<AuthoringState|null>(null),[selected,setSelected]=useState<string|null>(null);
 const [localDraft,setLocalDraft]=useState<{values:FormValues;releaseId:string;revisionId:string|null;root?:AuthoringRoot;sourceBindings:SourceBinding[]}|null>(null);
 const [error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[attempt,setAttempt]=useState(0);
 const [adoptionPreview,setAdoptionPreview]=useState<{input:AdoptionInput;previewHash:string;checks:string[]}|null>(null);
 const dirty=Boolean(localDraft);useManagementDraftGuard(dirty,'作者草稿');
 useEffect(()=>{const controller=new AbortController();void fetch('/api/instance/authoring',{cache:'no-store',signal:controller.signal}).then(readManagementResponse<AuthoringState>).then(value=>{if(!controller.signal.aborted)setState(value);}).catch(e=>{if(!controller.signal.aborted)setError(e.message);});return()=>controller.abort();},[attempt]);
 useEffect(()=>{const refresh=()=>setAttempt(v=>v+1);window.addEventListener('review:authoring-updated',refresh);window.addEventListener('review:operations-updated',refresh);return()=>{window.removeEventListener('review:authoring-updated',refresh);window.removeEventListener('review:operations-updated',refresh);};},[]);
 const readonly=hostedReadOnly||state?.readOnly||state?.initializationReady===false;
 const roots=state?.roots.filter(r=>r.kind===kind)||[],root=roots.find(r=>r.id===selected);
 const candidate=state?.candidates?.filter(item=>item.rootId===root?.id&&item.rootRevisionId===root?.revisionId).at(-1);
 const adopted=Boolean(candidate&&state?.adoptedCreativeRevisionId===candidate.creativeRevisionId);
 const review=candidate?.review;
 const canAdopt=Boolean(candidate&&!adopted&&review?.action==='APPROVE_AND_RELEASE'&&review?.applicationStatus==='APPLIED'&&review?.effect==='APPLIED'&&review?.sourceSyncState==='PENDING'&&typeof review?.eventId==='string');
 const currentPreview=!dirty&&canAdopt&&adoptionPreview?.input.expectedReleaseId===state?.releaseId&&adoptionPreview?.input.expectedRevisionId===root?.revisionId&&adoptionPreview?.input.creativeRevisionId===candidate?.creativeRevisionId&&adoptionPreview?.input.reviewEventId===review?.eventId?adoptionPreview:null;
 const {title,body,parentId,sceneIds,planText}=localDraft?.values||valuesOf(root);
 const remoteChanged=Boolean(localDraft&&state&&(localDraft.releaseId!==state.releaseId||localDraft.revisionId!==(root?.revisionId||null)));
 const parents=state?.roots.filter(r=>r.kind===(kind==='SCREENPLAY'?'STORY_OUTLINE':'SCREENPLAY'))||[];
 const scenes=state?.roots.filter(r=>r.kind==='SCENE_SCRIPT'&&r.parentId===parentId)||[];
 function edit(update:Partial<FormValues>){if(!state||readonly||busy)return;setLocalDraft(current=>({...current,values:{...(current?.values||valuesOf(root)),...update},releaseId:current?.releaseId||state.releaseId,revisionId:current?current.revisionId:root?.revisionId||null,root:current?current.root:root,sourceBindings:current?.sourceBindings||root?.sourceBindings||[]}));}
 function chooseSources(bindings:SourceBinding[]){edit({});setLocalDraft(current=>current?{...current,sourceBindings:bindings}:current);}
 function choose(id:string|null){if(dirty&&!window.confirm('有未保存的正文修改，切换后将丢失。仍要切换吗？'))return;setSelected(id);setLocalDraft(null);setMessage('');}
 async function save(){if(!state||!localDraft||readonly)return;setBusy(true);setError('');try{
  const planContent=planText.trim()?JSON.parse(planText):undefined;
  if(planContent&&(!Array.isArray(planContent.episodes)||typeof planContent.planId!=='string'))throw new Error('分集卷宗必须是包含 planId 和 episodes 的完整方案。');
  const baseRoot=localDraft.root;
  const value=await managementMutation<{root:AuthoringRoot;releaseId:string}>('/api/instance/authoring',{action:'save',expectedReleaseId:localDraft.releaseId,expectedRevisionId:localDraft.revisionId,root:{...(baseRoot?{id:baseRoot.id}:{}),kind,title,body,parentId:parentId||null,sceneIds:kind==='EPISODE_PLAN'?sceneIds:[],sourceBindings:localDraft.sourceBindings,...(planContent?{planContent}:{}),...(baseRoot?.scriptBlocks?{scriptBlocks:baseRoot.scriptBlocks}:{}),...(baseRoot?.episodes?{episodes:baseRoot.episodes}:{})}});
  setState(current=>current?{...current,releaseId:value.releaseId,roots:[...current.roots.filter(r=>r.id!==value.root.id),value.root]}:current);setLocalDraft(null);setSelected(value.root.id);window.dispatchEvent(new Event('review:authoring-updated'));setMessage('作者草稿已保存。完整候选经对应正式审阅后才能采用。');
 }catch(e){setError(e instanceof Error?e.message:'草稿保存未完成');}finally{setBusy(false);}}
 async function submit(){if(!state||!root?.planContent||dirty)return;setBusy(true);setError('');try{await managementMutation('/api/instance/authoring',{action:'submit',rootId:root.id,expectedReleaseId:state.releaseId,expectedRevisionId:root.revisionId});setMessage('完整分集候选已登记，可以进入六项叙事拆解审阅。尚未采用或解锁制作。');window.dispatchEvent(new Event('review:operations-updated'));}catch(e){setError(e instanceof Error?e.message:'候选登记未完成');}finally{setBusy(false);}}
 async function adopt(action:'adoptionPreview'|'adopt'){if(!state||!root||!candidate||!canAdopt||dirty||readonly)return;setBusy(true);setError('');try{const input:AdoptionInput={expectedReleaseId:state.releaseId,rootId:root.id,expectedRevisionId:root.revisionId,creativeRevisionId:candidate.creativeRevisionId,reviewEventId:String(review!.eventId)};if(action==='adoptionPreview'){const value=await managementMutation<{previewHash:string;checks:string[]}>('/api/instance/authoring',{action,...input});setAdoptionPreview({input,...value});setMessage('采用预览已就绪，核对影响后再确认。');}else{if(!currentPreview)throw new Error('先重新预览当前候选的采用影响。');const value=await managementMutation<{releaseId:string;creativeRevisionId:string;state:string}>('/api/instance/authoring',{action,...currentPreview.input,previewHash:currentPreview.previewHash});if(value.state!=='SOURCE_CURRENT')throw new Error('尚未取得方案采用成功的回执。');setState(current=>current?{...current,releaseId:value.releaseId,adoptedCreativeRevisionId:value.creativeRevisionId}:current);setAdoptionPreview(null);setMessage('分集方案已采用。场正文继续逐场审阅，制作范围尚未锁定。');window.dispatchEvent(new Event('review:operations-updated'));}}catch(e){setError(e instanceof Error?e.message:'方案采用未完成');}finally{setBusy(false);}}
 return <section className="management-card generic-authoring-workspace"><header><div><h2>{labels[kind]}</h2><p>结合来源资料与实体关系继续创作。草稿保留版本，正式候选与放行按各自审阅流程推进。</p></div></header>
 {remoteChanged&&<p role="status">远端作者草稿已有更新。你的未保存正文已保留；保存将核对原编辑版本，避免覆盖他处修改。</p>}{error&&<p role="alert">{error}<button onClick={()=>{setError('');setAttempt(v=>v+1);}}>重新读取</button></p>}{message&&<p role="status">{message}</p>}
 {state?<>{state.initializationReady===false&&<p>先到<a href={runtimePath("?view=system&systemTab=start")}>系统管理确认系统规则</a>，再保存本故事的创作草稿。</p>}
 <div className="management-form-grid"><label>已保存草稿<select value={selected||''} onChange={e=>choose(e.target.value||null)}><option value="">新建{labels[kind]}</option>{roots.map(r=><option key={r.id} value={r.id}>{r.title}</option>)}</select></label><label>草稿名称<input disabled={readonly||busy} value={title} onChange={e=>edit({title:e.target.value})} placeholder={labels[kind]}/></label></div>
 {kind!=='STORY_OUTLINE'&&<label className="management-field">{kind==='SCREENPLAY'?'依据的故事结构':'所属剧本'}<select disabled={readonly||busy} value={parentId} onChange={e=>edit({parentId:e.target.value,sceneIds:[]})}><option value="">尚未指定</option>{parents.map(r=><option key={r.id} value={r.id}>{r.title}</option>)}</select></label>}
 <label className="management-field">正文<textarea disabled={readonly||busy} rows={14} value={body} onChange={e=>edit({body:e.target.value})} placeholder="在这里整理故事结构或写下本场正文。保留来源事实与改编的区别。"/></label>
 <fieldset disabled={readonly||busy}><legend>本稿实际依据的来源 · {(localDraft?.sourceBindings||root?.sourceBindings||[]).length} 份</legend><p>显式勾选已导入的资料，保存时冻结版本；登记资料不代表已核实事实或观察过音视频。</p>{(state.sourceChoices||state.sourceBindings?.map(s=>({...s,title:s.sourceId}))||[]).map(source=>{const bindings=localDraft?.sourceBindings||root?.sourceBindings||[];return <label key={source.sourceId}><input type="checkbox" checked={bindings.some(b=>b.sourceId===source.sourceId&&b.revisionId===source.revisionId)} onChange={e=>chooseSources(e.target.checked?[...bindings.filter(b=>b.sourceId!==source.sourceId),{sourceId:source.sourceId,revisionId:source.revisionId,sha256:source.sha256}]:bindings.filter(b=>b.sourceId!==source.sourceId))}/>{source.title}</label>;})}{(localDraft?.sourceBindings||root?.sourceBindings||[]).filter(b=>!(state.sourceChoices||state.sourceBindings||[]).some(s=>s.sourceId===b.sourceId&&s.revisionId===b.revisionId)).map(b=><p key={b.sourceId}>保留原来源版本：{b.sourceId} · {b.revisionId}</p>)}</fieldset>
 {kind==='EPISODE_PLAN'&&<details className="management-card"><summary>完整分集卷宗与候选登记</summary><p>在完整剧本和场稿已登记后，导入作者准备的完整分集方案。正文说明不会自动转换为六项审阅卷宗。</p><fieldset disabled={readonly||busy}><legend>本方案覆盖的场稿</legend>{scenes.map(scene=><label key={scene.id}><input type="checkbox" checked={sceneIds.includes(scene.id)} onChange={e=>edit({sceneIds:e.target.checked?[...sceneIds,scene.id]:sceneIds.filter(id=>id!==scene.id)})}/>{scene.title}</label>)}{!scenes.length&&<p>所选剧本还没有已登记场稿。</p>}</fieldset><label className="management-field">导入完整方案文件<input type="file" accept="application/json,.json" disabled={readonly||busy} onChange={async e=>{const file=e.target.files?.[0];if(!file)return;try{const text=await file.text();JSON.parse(text);edit({planText:text});setError('');}catch{setError('方案文件不是可读取的 JSON。');}}}/></label><label className="management-field">完整分集方案 JSON<textarea rows={10} disabled={readonly||busy} value={planText} onChange={e=>edit({planText:e.target.value})}/></label><p>方案需包含永久分集身份、场次覆盖、逐项审阅依据和精确正文边界。服务端按现有候选规则校验。</p></details>}
 {!readonly&&<div className="management-actions"><button className="management-primary" disabled={busy||!dirty||!title.trim()||!body.trim()} onClick={()=>void save()}>保存作者草稿</button>{root?.planContent&&<button disabled={busy||dirty||adopted} onClick={()=>void submit()}>提交分集候选</button>}<span>{adopted?'这份分集方案已采用；场正文仍须逐场审阅。':candidate?'完整候选已登记，正式通过后还需预览并采用。':'当前为草稿，尚未采用或解锁制作。'}</span></div>}
 {candidate&&!adopted&&<p><a href={runtimePath("?view=story&storyMode=logic")}>进入六项叙事拆解审阅 →</a> 完整方案获得正式通过意见后，回到此草稿预览采用影响。</p>}
 {!readonly&&canAdopt&&<section className="management-preview"><h3>采用已通过的分集方案</h3><p>当前草稿与已通过候选精确对应。采用只建立当前方案，场正文、素材和制作产物分别继续。</p><div className="management-actions"><button disabled={busy||dirty} onClick={()=>void adopt('adoptionPreview')}>预览方案采用</button><button className="management-primary" disabled={busy||dirty||!currentPreview} onClick={()=>void adopt('adopt')}>确认采用分集方案</button></div>{currentPreview&&<ul>{currentPreview.checks.map((check,index)=><li key={index}>{check}</li>)}</ul>}</section>}
 </>:!error&&<p role="status">正在读取作者草稿…</p>}</section>;
}
