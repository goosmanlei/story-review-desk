'use client';
import { useEffect, useState } from 'react';
import { useRuntimeMode } from './runtime-mode';
import type { InstanceProfile } from './instance-profile';

type Settings = {revisionId:string;profile:InstanceProfile};
export function InstanceSettings() {
  const {hostedReadOnly}=useRuntimeMode();
  const [loaded,setLoaded]=useState<Settings|null>(null);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  useEffect(()=>{
    if(hostedReadOnly)return;
    const controller=new AbortController();
    void fetch('/api/instance/settings',{signal:controller.signal,cache:'no-store'}).then(async response=>{const body=await response.json() as Settings & {error?:string};if(!response.ok)throw new Error(body.error||'配置读取失败');setLoaded(body);}).catch(reason=>{if(!controller.signal.aborted)setError(String(reason.message||reason));});
    return ()=>controller.abort();
  },[hostedReadOnly]);
  if(hostedReadOnly)return null;
  if(!loaded)return <section className="instance-settings"><h2>本实例配置</h2><p>{error||'正在读取配置…'}</p></section>;
  const profile=loaded.profile;
  const field=(key:'storyTitle'|'title',value:string)=>setLoaded({...loaded,profile:{...profile,[key]:value}});
  const capability=(key:string,value:unknown)=>setLoaded({...loaded,profile:{...profile,capabilities:{...profile.capabilities,[key]:value}}});
  async function save() {
    if(!loaded)return;
    setBusy(true);setError('');
    try{
      const response=await fetch('/api/v8/operations/snapshot',{cache:'no-store'});
      const operations=await response.json() as {mutationEtag:string};
      if(!response.ok)throw new Error('无法读取当前审阅版本');
      const p=loaded.profile;
      const result=await fetch('/api/instance/settings',{method:'POST',headers:{'Content-Type':'application/json','If-Match':operations.mutationEtag,'Idempotency-Key':`settings:${crypto.randomUUID()}`},body:JSON.stringify({revisionId:loaded.revisionId,storyTitle:p.storyTitle,title:p.title,mark:p.branding.mark,description:p.branding.description,landingView:p.capabilities.landingView||'overview',preferredCollaborator:p.capabilities.preferredCollaborator||'HUMAN_AI',assistantEnabled:p.capabilities.assistantEnabled!==false})});
      const body=await result.json() as {error?:string|{message?:string}};if(!result.ok)throw new Error(typeof body.error==='string'?body.error:body.error?.message||'保存失败');
      window.location.reload();
    }catch(reason){setError(reason instanceof Error?reason.message:'保存失败');setBusy(false);}
  }
  return <section className="instance-settings"><h2>本实例配置</h2><p>这些设置只影响本故事。修改保留配置版本，已有审阅记录继续绑定原来的对象和版本。</p>
    <div className="instance-settings-grid">
      <label>故事名称<input value={profile.storyTitle} onChange={event=>field('storyTitle',event.target.value)} maxLength={300}/></label>
      <label>审阅台名称<input value={profile.title} onChange={event=>field('title',event.target.value)} maxLength={300}/></label>
      <label>标记<input value={profile.branding.mark} onChange={event=>setLoaded({...loaded,profile:{...profile,branding:{...profile.branding,mark:event.target.value}}})} maxLength={4}/></label>
      <label>说明<textarea value={profile.branding.description} onChange={event=>setLoaded({...loaded,profile:{...profile,branding:{...profile.branding,description:event.target.value}}})} maxLength={300}/></label>
      <label>默认入口<select value={String(profile.capabilities.landingView||'overview')} onChange={event=>capability('landingView',event.target.value)}>{[['overview','当前工作'],['story','故事创作'],['settings','故事设定'],['materials','素材管理'],['pipeline','全剧制作'],['system','系统管理']].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
      <label>协作偏好<select value={String(profile.capabilities.preferredCollaborator||'HUMAN_AI')} onChange={event=>capability('preferredCollaborator',event.target.value)}><option value="HUMAN_AI">人和 AI 自由协作</option><option value="HUMAN_FIRST">优先展示人可推进的工作</option><option value="AI_FIRST">优先展示 AI 可推进的工作</option></select></label>
      <label><input type="checkbox" checked={profile.capabilities.assistantEnabled!==false} onChange={event=>capability('assistantEnabled',event.target.checked)}/>启用本地 Codex 辅助入口</label>
    </div>
    {error&&<p role="alert">{error}</p>}<button disabled={busy} onClick={()=>void save()}>{busy?'保存中…':'保存本实例配置'}</button>
  </section>;
}
