'use client';


import {runtimePath} from './runtime-path';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { useManagementDraftGuard } from './management-draft-guard';
import { useRuntimeMode } from './runtime-mode';
import { useInstanceProfile } from './instance-context';
import { managementMutation, readManagementResponse, managementLabel } from './system-management-client';
import './system-management.css';
import {MaintenanceTransfer} from './maintenance-transfer';
import {OrchestrationDashboard} from './orchestration-dashboard';

const ConfigurationWorkspace = dynamic(() => import('./system-configuration-workspace').then(m => m.SystemConfigurationWorkspace), { loading: () => <p role="status">正在读取系统配置…</p> });
const tabs = [['start', '使用与初始化'], ['configuration', '系统配置'], ['runtime', '数据与运行'], ['orchestration', '多 Agent 协作']] as const;
type Tab = typeof tabs[number][0];
type Source = { id: string; title: string; role: string; format: string; sha256: string; revisionId: string; status: string; observation?: string; textAvailable?:boolean; text?: string };
type SourceState = { releaseId: string; sources: Source[]; readOnly?: boolean };

function useManagementLoad<T>(path: string, enabled = true) {
  const [result,setResult]=useState<{path:string;value:T|null;error:string;loading:boolean}>({path,value:null,error:'',loading:enabled});
  const request=useRef<{controller:AbortController;sequence:number}|null>(null);
  const fetchValue=useCallback(async(signal:AbortSignal)=>readManagementResponse<T>(await fetch(path,{cache:'no-store',signal})),[path]);
  const receive=useCallback((controller:AbortController)=>fetchValue(controller.signal).then(value=>{if(!controller.signal.aborted)setResult({path,value,error:'',loading:false});},error=>{if(!controller.signal.aborted)setResult(previous=>({...previous,path,error:error instanceof Error?error.message:'暂时无法读取',loading:false}));}),[fetchValue,path]);
  useEffect(()=>{if(!enabled)return;const controller=new AbortController();request.current?.controller.abort();request.current={controller,sequence:(request.current?.sequence||0)+1};void receive(controller);return()=>controller.abort();},[enabled,receive]);
  const reload=useCallback(async()=>{if(!enabled)return;request.current?.controller.abort();const controller=new AbortController();request.current={controller,sequence:(request.current?.sequence||0)+1};setResult(previous=>({...previous,error:'',loading:true}));await receive(controller);},[enabled,receive]);
  useEffect(()=>()=>request.current?.controller.abort(),[]);
  return{value:result.value,error:result.error,loading:enabled&&(result.loading||result.path!==path),reload};
}

function Feedback({ error, message }: { error: string; message?: string }) {
  return <>{error && <p className="management-feedback is-error" role="alert">{error}</p>}{message && <p className="management-feedback" role="status">{message}</p>}</>;
}

export function SourceImport({ onChanged = () => {}, compact=false }: { onChanged?: () => void; compact?:boolean }) {
  const { hostedReadOnly } = useRuntimeMode();
  const sources = useManagementLoad<SourceState>('/api/instance/sources');
  const [mode, setMode] = useState<'text' | 'file'>('text');
  const [title, setTitle] = useState('');
  const [role, setRole] = useState('PRIMARY');
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const readonly = hostedReadOnly || sources.value?.readOnly;
  useManagementDraftGuard(Boolean(title||text||file),'待导入资料');
  async function submit() {
    if (!sources.value || readonly) return;
    setBusy(true); setError(''); setMessage('');
    try {
      if (mode === 'file') {
        if (!file) throw new Error('先选择一份来源文件。');
        const form = new FormData(); form.set('file', file); form.set('title', title.trim() || file.name); form.set('role', role); form.set('expectedReleaseId', sources.value.releaseId);
        await managementMutation('/api/instance/sources', form);
      } else {
        if (!title.trim() || !text.trim()) throw new Error('填写资料名称和原文后再导入。');
        await managementMutation('/api/instance/sources', { title: title.trim(), role, text, expectedReleaseId: sources.value.releaseId });
      }
      setTitle(''); setText(''); setFile(null); setMessage('资料已登记。原文与后续整理结果分别保留。');
      await sources.reload(); onChanged(); window.dispatchEvent(new Event('review:sources-updated'));
    } catch (e) { setError(e instanceof Error ? e.message : '资料导入未完成'); }
    finally { setBusy(false); }
  }
  return <section className={`management-card ${compact?'source-import-compact':''}`} id="story-source-import" aria-labelledby="source-import-title">
    <header><span className="management-step">01</span><div><h2 id="source-import-title">先提供故事的原始资料</h2><p>原文、梗概、已有剧本和制作要求可以一起提供。请区分一手来源与辅助整理。</p></div></header>
    {hostedReadOnly ? <p>请在本地审阅台导入故事资料。此镜像只展示已发布内容。</p> : <>
      <div className="management-inline-tabs" role="group" aria-label="资料导入方式"><button className={mode === 'text' ? 'active' : ''} onClick={() => setMode('text')}>粘贴文字</button><button className={mode === 'file' ? 'active' : ''} onClick={() => setMode('file')}>上传文件</button></div>
      <div className="management-form-grid"><label>资料名称<input value={title} onChange={e => setTitle(e.target.value)} disabled={busy || readonly} placeholder="例如：故事原文、补充人物说明" /></label><label>资料角色<select value={role} onChange={e => setRole(e.target.value)} disabled={busy || readonly}><option value="PRIMARY">原始依据</option><option value="DERIVED">派生整理</option><option value="AUXILIARY">辅助资料</option></select></label></div>
      {mode === 'text' ? <label className="management-field">来源正文<textarea aria-label="来源正文" rows={7} value={text} onChange={e => setText(e.target.value)} disabled={busy || readonly} placeholder="粘贴故事原文。导入不会改变原文，也不表示已审阅或已采用。" /></label> : <label className="management-upload">选择原始文件<input type="file" disabled={busy || readonly} onChange={e => setFile(e.target.files?.[0] || null)} /><small>文档保留原件与可读取文本；图片、音频、视频以实际解析和观察结果为准。</small></label>}
      <div className="management-actions"><button className="management-primary" disabled={busy || readonly || !sources.value} onClick={() => void submit()}>{busy ? '正在导入…' : '登记这份资料'}</button><span>资料可以分批补充；导入不采用剧本，也不覆盖故事设定。</span></div>
      <Feedback error={error || sources.error} message={message} />
      {sources.error && <button onClick={() => void sources.reload()}>重新读取资料目录</button>}
    </>}
    {hostedReadOnly&&sources.error&&<><Feedback error={sources.error}/><button onClick={()=>void sources.reload()}>重新读取已发布资料目录</button></>}
    {!compact&&<div className="management-source-list" aria-label="已登记故事资料">{sources.loading && !sources.value && <p role="status">正在读取来源目录…</p>}{sources.value?.sources.map(s => <article key={s.id}><div><b>{s.title}</b><span>{({ PRIMARY: '原始依据', DERIVED: '派生整理', AUXILIARY: '辅助资料' } as Record<string,string>)[s.role] || s.role} · {s.format}</span></div><span>{s.observation === 'ORIGINAL_UNOBSERVED' || s.status === 'ORIGINAL_UNOBSERVED' ? '原件已保存 · 尚未观察' : s.observation === 'TEXT_UNAVAILABLE_NO_OCR' ? '原件已保存 · 文字尚不可读取' : s.textAvailable===true || (s.textAvailable!==false && (s.status === 'REGISTERED' || s.status === 'TEXT_AVAILABLE')) ? '已登记 · 文字可读取' : managementLabel(s.status)}</span></article>)}{sources.value && !sources.value.sources.length && <p>{hostedReadOnly?'此镜像尚未发布来源目录。':'还没有故事资料。先导入一份原文或梗概。'}</p>}</div>}
  </section>;
}

function SystemInitialization({openConfiguration}:{openConfiguration:()=>void}) {
  const state=useManagementLoad<{initialized:boolean;readOnly?:boolean}>('/api/instance/configuration');
  const {hostedReadOnly}=useRuntimeMode();
  const runtime=useManagementLoad<RuntimeState>('/api/instance/maintenance',!hostedReadOnly);
  return <section className="management-card"><header><div><h2>系统初始化</h2><p>确认实例规则与运行条件；故事设定和素材需求分别在所属模块确认。</p></div></header>
    {state.error?<><p role="alert">{state.error}</p><button onClick={()=>void state.reload()}>重新读取</button></>:<p role="status">{state.loading?'正在核对系统规则…':state.value?.initialized?'实例规则已确认，可分别开展故事创作、设定核对和素材准备。':'先核对并确认系统配置；不需要预先完成全部故事设定。'}</p>}
    <div className="management-readiness"><div><small>实例规则</small><strong>{state.error?'暂不可读取':state.loading||!state.value?'读取中':state.value.initialized?'已确认':'待确认'}</strong></div><div><small>数据权威</small><strong>{hostedReadOnly?'已发布只读镜像':runtime.error?'暂不可读取':String(runtime.value?.storage?.provider||'读取中')}</strong></div><div><small>运行维护</small><strong>{hostedReadOnly?'由本地实例维护':runtime.error?'暂不可读取':String(runtime.value?.runtime?.status||'读取中')}</strong></div></div>
    <button className="management-primary" onClick={openConfiguration}>核对系统配置与审阅标准 →</button>
  </section>;
}

type RuntimeState = { runtime?: Record<string, unknown>; storage?: Record<string, unknown>; backups?: Array<Record<string, unknown>>; capabilities?: Record<string, unknown>; operations?: Array<Record<string, unknown>>; readOnly?: boolean };
function MaintenanceOperation({operation}:{operation:Record<string,unknown>}) {
  const action=String(operation.action),status=String(operation.status);
  const result=operation.result&&typeof operation.result==='object'&&!Array.isArray(operation.result)?operation.result as Record<string,unknown>:{};
  const titles:Record<string,string>={backup:'完整备份',import:'导入备份',restore:'独立恢复',verify:'实例核验',export:'只读导出'};
  const statuses:Record<string,string>={QUEUED:'等待执行',RUNNING:'正在执行',SUCCEEDED:'已完成',FAILED:'未完成'};
  const count=Number.isSafeInteger(result.mediaFiles)&&Number(result.mediaFiles)>=0?`${result.mediaFiles} 份受管媒体`:'受管媒体';
  const verified=status==='SUCCEEDED';
  const summary=operation.error?String(operation.error):status==='QUEUED'?'等待本地维护工作器执行。':status==='RUNNING'?'工作器正在处理，完成后会核验结果。':verified&&result.status==='BACKUP_VERIFIED'?`业务历史与${count}已核验，可下载或恢复。`:verified&&result.status==='RESTORED_VERIFIED'?'独立副本已恢复并核验；当前实例未切换。':verified&&result.status==='HOSTED_EXPORT_VERIFIED'?'只读导出已核验，不含原始音频与私有助手记录。':verified&&result.passed===true?'当前实例完整性核验通过。':verified?'任务已完成，具体结果见核验依据。':'执行结果仍需核查，未自动重试。';
  const fields:Record<string,unknown>={'任务身份':operation.operationId,'开始时间':operation.startedAt||operation.createdAt,'完成时间':operation.completedAt,'结果代码':result.status,'清单 SHA-256':result.manifestSha256,'输出目录':result.output,'当前发布':result.releaseId,'恢复运行期':result.runtimeEpoch};
  return <article><b>{titles[action]||'维护任务'}</b><span>{statuses[status]||'状态待核查'}</span><p>{summary}</p><details><summary>核验依据</summary><dl>{Object.entries(fields).filter(([,value])=>typeof value==='string'&&value).map(([label,value])=><div key={label}><dt>{label}</dt><dd>{String(value)}</dd></div>)}</dl></details></article>;
}
function DataAndRuntime({ technicalAppendix }: { technicalAppendix?: ReactNode }) {
  const { hostedReadOnly } = useRuntimeMode();
  const state = useManagementLoad<RuntimeState>('/api/instance/maintenance', !hostedReadOnly);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [message,setMessage] = useState('');
  const [backup,setBackup] = useState('');
  const [target,setTarget] = useState('');
  useEffect(() => { if (!state.value?.operations?.some(o => ['QUEUED','RUNNING'].includes(String(o.status)))) return; const id = window.setTimeout(() => void state.reload(), 3000); return () => clearTimeout(id); }, [state]);
  async function run(action: string) {
    setBusy(true); setError(''); setMessage('');
    try { const result = await managementMutation<{ status: string; operationId: string }>('/api/instance/maintenance', { action, ...(action === 'restore' ? { backupId: backup, target } : {}) }); setMessage(result.status === 'QUEUED' ? '任务已排队，完成证据会显示在下方。' : '任务状态已更新。'); await state.reload(); }
    catch(e) { setError(e instanceof Error ? e.message : '维护任务未完成'); }
    finally { setBusy(false); }
  }
  return <div className="management-stack"><section className="management-card"><header><div><h2>这个故事的数据与运行</h2><p>一部故事使用一个独立实例。备份包括业务版本与受管媒体；恢复到新目录。</p></div></header>
    {hostedReadOnly ? <p>此处是只读镜像。数据维护请回到本地审阅台。</p> : <>
      <Feedback error={error || state.error} message={message} />
      <dl className="management-runtime-facts"><div><dt>存储</dt><dd>{state.error?'暂不可读取':String(state.value?.storage?.provider||'读取中')}</dd></div><div><dt>运行维护</dt><dd>{state.error?'暂不可读取':String(state.value?.runtime?.status||'读取中')}</dd></div><div><dt>备份</dt><dd>{state.error?'暂不可读取':!state.value?'读取中':state.value.backups?.length ? `已登记 ${state.value.backups.length} 份` : '暂无本页登记的备份'}</dd></div><div><dt>维护任务</dt><dd>{state.error?'暂不可读取':!state.value?'读取中':`${state.value.operations?.filter(o=>['QUEUED','RUNNING'].includes(String(o.status))).length||0} 项进行中`}</dd></div></dl>
      <details className="management-runtime-details"><summary>实例身份与存储详情</summary><dl className="management-runtime-facts">{Object.entries({...(state.value?.runtime||{}),...(state.value?.storage||{})}).filter(([key])=>!/secret|password|token|credential/i.test(key)).map(([key,value])=><div key={key}><dt>{({instanceId:'实例身份',projectId:'故事身份',releaseId:'当前发布',runtimeEpoch:'运行期',provider:'存储方式',status:'运行状态',authority:'数据权威'} as Record<string,string>)[key]||key}</dt><dd>{managementLabel(value)}</dd></div>)}</dl></details>
      <div className="management-actions">{[['verify','核验当前实例'],['backup','创建完整备份'],['export','准备只读导出']].map(([action,label]) => <button key={action} disabled={busy || !state.value || state.value.capabilities?.[action] === false} onClick={() => void run(action)}>{label}</button>)}<button disabled={state.loading} onClick={() => void state.reload()}>刷新状态</button></div>
      <MaintenanceTransfer onQueued={()=>void state.reload()}/>
      {!!state.value?.backups?.length && <section className="management-restore"><h3>下载或恢复已核验备份</h3><div className="management-form-grid"><label>已有备份<select value={backup} onChange={e => setBackup(e.target.value)}><option value="">选择一份完整备份</option>{state.value.backups.map((b,index) => <option key={String(b.id || index)} value={String(b.id || b.backupId || '')}>{String(b.title || b.createdAt || b.id || `备份 ${index+1}`)}</option>)}</select></label><label>新实例目录名<input value={target} onChange={e => setTarget(e.target.value)} placeholder="例如：my-story-copy（与当前实例同目录）" /></label></div><div className="management-actions"><button disabled={busy || !backup || !target.trim() || state.value.capabilities?.restore === false} onClick={() => void run('restore')}>恢复到新目录</button>{state.value.backups.filter(b=>b.id===backup&&b.downloadUrl).map(b=><a key={String(b.id)} href={runtimePath(String(b.downloadUrl))} download>下载完整备份</a>)}</div><p>恢复不替换当前实例。核验独立副本后，再由本地 Codex 显式切换运行绑定；原实例保留用于回滚。</p></section>}
      <div className="management-operation-list" aria-label="维护任务记录">{state.value?.operations?.map((operation,index) => <MaintenanceOperation key={String(operation.operationId || index)} operation={operation}/>)}</div>
    </>}
  </section>{technicalAppendix && <details className="management-card management-appendix"><summary>技术附录与审计依据</summary>{technicalAppendix}</details>}</div>;
}

export function SystemManagement({ technicalAppendix }: { technicalAppendix?: ReactNode }) {
  const instance = useInstanceProfile();
  const [tab,setTab] = useState<Tab>('start');
  const [tabReady,setTabReady]=useState(false);
  useEffect(() => { const sync = () => { const url = new URL(location.href); const requested = url.hash === '#system-configuration' ? 'configuration' : url.searchParams.get('systemTab'); setTab(tabs.some(([id]) => id === requested) ? requested as Tab : 'start');setTabReady(true); }; sync(); window.addEventListener('popstate',sync); window.addEventListener('hashchange',sync); return () => { window.removeEventListener('popstate',sync); window.removeEventListener('hashchange',sync); }; }, []);
  function select(next: Tab) { if(next === tab) return; if(!window.dispatchEvent(new Event('review:configuration-before-leave',{cancelable:true}))) return; const url = new URL(location.href); url.searchParams.set('systemTab',next); url.hash = ''; history.pushState({},'',url); setTab(next); }
  return <section className="system-management workspace-view" aria-labelledby="system-management-title">
    <header className="workspace-heading management-heading"><div><h1 id="system-management-title">系统管理</h1><p>{instance.storyTitle} · 实例规则、审阅标准与数据运行</p></div></header>
    <nav className="management-tabs" aria-label="系统管理模块" role="tablist">{tabs.map(([id,label],index) => <button key={id} id={`management-tab-${id}`} aria-controls={`management-panel-${id}`} role="tab" aria-selected={tab===id} tabIndex={tab===id?0:-1} className={tab===id?'active':''} onClick={() => select(id)} onKeyDown={e => { const next = e.key==='ArrowRight'?(index+1)%tabs.length:e.key==='ArrowLeft'?(index+tabs.length-1)%tabs.length:e.key==='Home'?0:e.key==='End'?tabs.length-1:-1; if(next<0)return; e.preventDefault();select(tabs[next][0]);document.getElementById(`management-tab-${tabs[next][0]}`)?.focus(); }}>{label}</button>)}</nav>
    <div id={`management-panel-${tab}`} role="tabpanel" aria-labelledby={`management-tab-${tab}`}>
      {tabReady && tab==='start' && <div className="management-stack"><SystemInitialization openConfiguration={()=>select('configuration')}/><details className="management-card management-new-story"><summary>为下一部故事建立独立项目</summary><p>使用干净软件与空实例，以新项目根目录作为 Codex 工作目录。确认系统规则后即可开始作者草稿，并在来源资料中显式导入原文。</p><code>node review-software/scripts/instance-project-create.mjs --project /新项目目录 --title 故事名</code></details></div>}
      {tabReady && tab==='configuration' && <ConfigurationWorkspace />}
      {tabReady && tab==='runtime' && <DataAndRuntime technicalAppendix={technicalAppendix} />}
      {tabReady && tab==='orchestration' && <OrchestrationDashboard />}
    </div>
  </section>;
}
