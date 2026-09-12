'use client';
import {useEffect,useState} from 'react';
import {managementMutation,readManagementResponse} from './system-management-client';
import {useRetainedDraft} from './draft-retention';
type Episode={id:string;title:string;displayId:string;expectedVersion:number;revisionId:string};
type State={episodeId:string;expectedVersion:number;revisionId:string;episodes:Episode[];scenes:Array<{id:string;title:string;expectedVersion:number;revisionId:string}>};
export function EpisodeOrganization({episodeId,disabled,onChanged}:{episodeId:string;disabled:boolean;onChanged:()=>void}){
 const [state,setState]=useState<State|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[reload,setReload]=useState(0);
 const [draft,setDraft]=useRetainedDraft<{title:string;text:string}>('new-scene:'+episodeId);
 useEffect(()=>{const c=new AbortController();fetch('/api/v1/workspaces/episode-organization?episodeId='+encodeURIComponent(episodeId),{signal:c.signal,cache:'no-store'}).then(readManagementResponse<State>).then(setState).catch(e=>{if(!c.signal.aborted)setError(e.message);});return()=>c.abort();},[episodeId,reload]);
 async function run(input:Record<string,unknown>){if(!state)return;setBusy(true);setError('');try{await managementMutation('/api/v1/workspaces/episode-organization',{...input,episodeId,expectedVersion:state.expectedVersion,revisionId:state.revisionId});if(input.action==='create')setDraft(null);setReload(v=>v+1);onChanged();window.dispatchEvent(new Event('review:story-updated'));}catch(e){setError(e instanceof Error?e.message:'集场组织未完成');}finally{setBusy(false);}}
 return <details className="management-card"><summary>集场组织</summary><p>新增或移动场次会保存受影响分集的草稿，原采用版本和历史评论继续保留。</p>{error&&<p role="alert">{error}</p>}
 <fieldset disabled={disabled||busy||!state}><legend>移动到其他分集</legend>{state?.scenes.map(scene=><label key={scene.id}>{scene.title}<select aria-label={scene.title+' 移到分集'} value="" disabled={state.scenes.length<=1} onChange={e=>{const target=state.episodes.find(r=>r.id===e.target.value);if(target)void run({action:'move',sceneId:scene.id,sceneExpectedVersion:scene.expectedVersion,targetEpisodeId:target.id,targetExpectedVersion:target.expectedVersion,targetRevisionId:target.revisionId});}}><option value="">保持在本集</option>{state.episodes.map(e=><option key={e.id} value={e.id}>{e.displayId} · {e.title}</option>)}</select></label>)}
 <legend>在本集新增一场</legend><label>新场标题<input value={draft?.title||''} onChange={e=>setDraft(v=>({text:v?.text||'',title:e.target.value}))}/></label><label>新场正文<textarea value={draft?.text||''} onChange={e=>setDraft(v=>({title:v?.title||'',text:e.target.value}))}/></label><button type="button" disabled={!draft?.title.trim()||!draft?.text.trim()} onClick={()=>void run({action:'create',sceneId:'scene:'+crypto.randomUUID(),blockId:'block:'+crypto.randomUUID(),...draft})}>新增本集场次</button></fieldset>
 {disabled&&<p>先保存上方正文编辑，再调整场次归属。</p>}</details>;
}
