'use client';

import {EpisodeOrganization} from './episode-organization';
import {useEffect,useState} from 'react';
import {useInstanceProfile} from './instance-context';
import {useRuntimeMode} from './runtime-mode';
import {managementMutation,readManagementResponse} from './system-management-client';
import type {NarrativeBlock} from './narrative-revision';

type State={objectId:string;kind:'SCENE'|'EPISODE';title:string;revisionId:string;expectedVersion:number;readOnly:boolean;content:Record<string,unknown>;links:Array<{id:string;role:string}>};
type Draft={objectId:string;revisionId:string;expectedVersion:number;title:string;content:Record<string,unknown>;sceneIds?:string[]};
const labels:Record<string,string>={slugline:'场景标头',purpose:'本场任务',storyTime:'故事时间',viewpoint:'叙事视角',audienceKnown:'观众已知',audienceWithheld:'暂不揭示',transition:'转场',openingHook:'开场钩子',coreAdvance:'核心推进',endingCliffhanger:'结尾悬念',reviewQuestion:'本集审阅问题'};
const fields={SCENE:['slugline','purpose','storyTime','viewpoint','audienceKnown','audienceWithheld','transition'],EPISODE:['openingHook','coreAdvance','endingCliffhanger','reviewQuestion']};
function editable(state:State):Draft {
  const content:Record<string,unknown>=Object.fromEntries(fields[state.kind].map(k=>[k,String(state.content[k]||'')]));
  if(state.kind==='SCENE')content.blocks=structuredClone(state.content.blocks||[{id:state.objectId+'-body',type:'action',text:String(state.content.text||''),speaker:'',performanceNote:''}]);
  return {objectId:state.objectId,revisionId:state.revisionId,expectedVersion:state.expectedVersion,title:state.title,content,...(state.kind==='EPISODE'?{sceneIds:state.links.filter(l=>l.role==='SCENE').map(l=>l.id)}:{})};
}
export function StoryObjectEditor({objectId,readOnly=false,sceneNames={}}:{objectId:string;readOnly?:boolean;sceneNames?:Record<string,string>}) {
  const {hostedReadOnly}=useRuntimeMode();
  const [open,setOpen]=useState(false);
  if(readOnly||hostedReadOnly)return null;
  return <details className="management-card" onToggle={e=>setOpen(e.currentTarget.open)}><summary>编辑本稿</summary>{open&&<Editor key={objectId} objectId={objectId} sceneNames={sceneNames}/>}</details>;
}
function Editor({objectId,sceneNames}:{objectId:string;sceneNames:Record<string,string>}) {
  const instance=useInstanceProfile(),key=`review:story-draft:${instance.instanceId}:${instance.deployment.runtimeEpoch}:${objectId}`;
  const [state,setState]=useState<State|null>(null),[draft,setDraft]=useState<Draft|null>(null),[error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{const controller=new AbortController();try{const saved=JSON.parse(sessionStorage.getItem(key)||'null');if(saved?.objectId===objectId&&typeof saved.revisionId==='string'&&Number.isInteger(saved.expectedVersion))setDraft(saved);}catch{}
    void fetch('/api/v1/workspaces/story-editing?objectId='+encodeURIComponent(objectId),{signal:controller.signal,cache:'no-store'}).then(readManagementResponse<State>).then(setState).catch(e=>{if(!controller.signal.aborted)setError(e.message);});return()=>controller.abort();},[objectId,key]);
  const value=draft||(state?editable(state):null),blocks=(value?.content.blocks||[]) as NarrativeBlock[];
  function change(next:Draft){setDraft(next);setMessage('');try{sessionStorage.setItem(key,JSON.stringify(next));}catch{setError('浏览器草稿空间已满；当前输入仍保留，请先保存本稿再离开。');}}
  function blockChange(index:number,patch:Partial<NarrativeBlock>){if(value)change({...value,content:{...value.content,blocks:blocks.map((b,i)=>i===index?{...b,...patch}:b)}});}
  async function save(){if(!draft)return;setBusy(true);setError('');try{
    await managementMutation('/api/v1/workspaces/story-editing',draft);
    const fresh=await fetch('/api/v1/workspaces/story-editing?objectId='+encodeURIComponent(objectId),{cache:'no-store'}).then(readManagementResponse<State>);
    setState(fresh);setDraft(null);sessionStorage.removeItem(key);setMessage('草稿已保存；原采用版本、评论和审阅记录保留。');window.dispatchEvent(new Event('review:story-updated'));
  }catch(e){setError(e instanceof Error?e.message:'保存未完成；编辑内容仍保留');}finally{setBusy(false);}}
  const reload=()=>{void fetch('/api/v1/workspaces/story-editing?objectId='+encodeURIComponent(objectId),{cache:'no-store'}).then(readManagementResponse<State>).then(setState).catch(e=>setError(e.message));};
  return <section className="generic-authoring-workspace" aria-label="集场正文编辑">{error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}{value&&state?<>
    {draft&&draft.revisionId!==state.revisionId&&<p role="status">本稿远端已更新。这里保留你原先的编辑；保存会核对原版本。</p>}
    <fieldset disabled={busy||state.readOnly}><label className="management-field">标题<input value={value.title} onChange={e=>change({...value,title:e.target.value})}/></label>
    <div className="management-form-grid">{fields[state.kind].map(field=><label key={field}>{labels[field]}<textarea rows={2} value={String(value.content[field]||'')} onChange={e=>change({...value,content:{...value.content,[field]:e.target.value}})}/></label>)}</div>
    {state.kind==='SCENE'&&<section aria-label="正文段落">{blocks.map((block,index)=><section className="management-card" key={block.id}><div className="management-form-grid"><label>段落 {index+1}<select value={block.type} onChange={e=>blockChange(index,{type:e.target.value as NarrativeBlock['type']})}><option value="action">动作</option><option value="dialogue">对白</option></select></label>{block.type==='dialogue'&&<><label>说话人<input value={block.speaker||''} onChange={e=>blockChange(index,{speaker:e.target.value})}/></label><label>表演提示<input value={block.performanceNote||''} onChange={e=>blockChange(index,{performanceNote:e.target.value})}/></label></>}</div><label className="management-field">正文<textarea rows={3} value={block.text} onChange={e=>blockChange(index,{text:e.target.value})}/></label><div className="management-actions">{([-1,1] as const).map(direction=><button type="button" key={direction} disabled={index+direction<0||index+direction>=blocks.length} onClick={()=>{const next=[...blocks];[next[index],next[index+direction]]=[next[index+direction],next[index]];change({...value,content:{...value.content,blocks:next}});}}>{direction===-1?'上移':'下移'}</button>)}<button type="button" disabled={blocks.length===1} onClick={()=>change({...value,content:{...value.content,blocks:blocks.filter((_,i)=>i!==index)}})}>删除本段</button></div></section>)}<button type="button" onClick={()=>change({...value,content:{...value.content,blocks:[...blocks,{id:'block:'+crypto.randomUUID(),type:'action',speaker:'',performanceNote:'',text:''}]}})}>添加段落</button></section>}
    {state.kind==='EPISODE'&&<section><h4>本集场次顺序</h4>{value.sceneIds?.map((id,index)=><div className="management-actions" key={id}><span>{sceneNames[id]||id}</span>{([-1,1] as const).map(direction=><button type="button" key={direction} disabled={index+direction<0||index+direction>=value.sceneIds!.length} onClick={()=>{const next=[...value.sceneIds!];[next[index],next[index+direction]]=[next[index+direction],next[index]];change({...value,sceneIds:next});}}>{direction===-1?'上移':'下移'}</button>)}</div>)}</section>}
    <div className="management-actions"><button className="management-primary" type="button" disabled={!draft} onClick={()=>void save()}>{busy?'正在保存…':'保存本稿草稿'}</button><span>保存后继续在原审阅区确认采用。</span></div></fieldset>{state.kind==='EPISODE'&&<EpisodeOrganization episodeId={objectId} disabled={Boolean(draft)||busy||state.readOnly} onChanged={reload}/> }
  </>:<p role="status">正在读取本稿…</p>}</section>;
}
