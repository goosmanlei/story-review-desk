'use client';
import {useEffect,useState} from 'react';
import {useRetainedDraft} from './draft-retention';
import {useManagementDraftGuard} from './management-draft-guard';
import {managementMutation} from './system-management-client';
type LockState={basisHash:string;inputs:Array<{id:string;sha256:string;mediaUrl:string|null}>;reviewRequired:Array<{id:string;title:string;revisionId:string;criteria:Array<{id:string;label?:string;title?:string;question?:string}>}>;lockCriteria:Array<{id:string;label?:string;title?:string;question?:string}>;blockers:string[];lock:{state:string;id:string}|null};
export function RecipeInputLock({callId,onReady,disabled}:{callId:string;onReady:(ready:boolean)=>void;disabled:boolean}){
 const [state,setState]=useState<LockState|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [draft,setDraft,retained]=useRetainedDraft<{basisHash:string;checked:string[];note:string}>('input-lock:'+callId);
 const checked=state?.basisHash===draft?.basisHash?draft?.checked||[]:[],note=draft?.note||'';
 const setChecked=(update:(value:string[])=>string[])=>{if(state)setDraft({basisHash:state.basisHash,checked:update(checked),note});};
 const setNote=(note:string)=>{if(state)setDraft({basisHash:state.basisHash,checked,note});};
 useManagementDraftGuard(Boolean(draft)&&!retained,'输入核对意见');
 async function read(){const response=await fetch('/api/v1/workspaces/input-locks?callId='+encodeURIComponent(callId),{cache:'no-store'}),value=await response.json();if(!response.ok)throw Error(value.error||'输入依据读取失败');setState(value);}
 useEffect(()=>{let active=true;setState(null);onReady(false);fetch('/api/v1/workspaces/input-locks?callId='+encodeURIComponent(callId),{cache:'no-store'}).then(async response=>{const value=await response.json();if(!response.ok)throw Error(value.error||'输入依据读取失败');if(active){setState(value);setError('');}}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[callId,onReady]);
 useEffect(()=>onReady(state?.lock?.state==='ADOPTED'&&!state.blockers.length),[state,onReady]);
 async function confirm(){if(!state)return;setBusy(true);try{await managementMutation('/api/v1/workspaces/input-locks',{action:'confirm',explicit:true,callId,basisHash:state.basisHash,note,confirmedRevisionIds:state.reviewRequired.filter(r=>checked.includes(r.revisionId)).map(r=>r.revisionId),confirmedCriteria:checked});await read();setDraft(null);setError('');window.dispatchEvent(new Event('review:operations-updated'));}catch(e){setError(e instanceof Error?e.message:'输入锁定未完成');}finally{setBusy(false);}}
 const toggle=(id:string,yes:boolean)=>setChecked(current=>yes?[...current,id]:current.filter(v=>v!==id));
 return <section className="creator-external-run"><header><b>实际输入核对</b><span>{state?.lock?.state==='ADOPTED'?'已锁定':state?'待核对':'读取中'}</span></header>
 {error&&<p role="alert">{error}</p>}{draft&&state&&draft.basisHash!==state.basisHash&&<p role="alert">输入版本已变化，已保留说明；请重新核对勾选项。</p>}{state?.blockers.map(reason=><p key={reason}>{reason}</p>)}
 {state&&!state.lock&&<><p>确认本页完整调用包、模型、参数和以下精确附件；此确认保存采用判断与输入锁定。生成仍需下一步明确授权。</p>
 {state.inputs.map(input=><p key={input.id}><b>{input.id}</b><br/><small>SHA {input.sha256}</small>{input.mediaUrl&&<> · <a href={input.mediaUrl} target="_blank" rel="noreferrer">查看原件</a></>}</p>)}
 {state.reviewRequired.map(row=><fieldset key={row.id}><legend>{row.title}</legend><label><input type="checkbox" checked={checked.includes(row.revisionId)} onChange={e=>toggle(row.revisionId,e.target.checked)}/>已核对并采用此精确版本</label>{row.criteria.map(c=><label key={c.id}><input type="checkbox" checked={checked.includes(row.id+'|'+c.id)} onChange={e=>toggle(row.id+'|'+c.id,e.target.checked)}/>{c.label||c.title||c.id} {c.question}</label>)}</fieldset>)}
 {(state.lockCriteria||[]).map(c=><label key={c.id}><input type="checkbox" checked={checked.includes('lock|'+c.id)} onChange={e=>toggle('lock|'+c.id,e.target.checked)}/>{c.label||c.title||c.id} {c.question}</label>)}
 <label>核对说明<textarea value={note} onChange={e=>setNote(e.target.value)} maxLength={4000}/></label><button type="button" disabled={disabled||busy||state.blockers.length>0||!note.trim()} onClick={()=>void confirm()}>{busy?'正在确认…':'确认并锁定实际输入'}</button></>}
 </section>;
}
