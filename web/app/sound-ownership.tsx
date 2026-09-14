'use client';

import {useEffect,useState,useRef,type FormEvent} from 'react';
import {runtimePath} from './runtime-path';
import {readManagementResponse} from './system-management-client';
import {visibleText} from './review-semantics';
import './sound-ownership.css';

export type SoundReferenceKind='SPACE'|'STORY'|'EPISODE'|'SCENE'|'SHOT'|'ENTITY'|'STATE'|'REPRESENTATION'|'REQUIREMENT'|'MATERIAL';
export type SoundExactReference={objectId:string;kind:SoundReferenceKind;revisionId:string;sha256:string;expectedVersion:number};
export type SoundOwnershipBinding={
 id:string;title:string;version:number;revisionId:string;revisionSha256:string;state:string;status:'ASSIGNED'|'UNKNOWN'|'PENDING_CONFIRMATION';resolution:'ASSIGNED'|'UNKNOWN';usage:string;stale:boolean;
 source?:SoundExactReference;target?:SoundExactReference;resources:SoundExactReference[];
 pending?:{reason:string;missingEvidence:string[];todo:string};
 exactReferences:{source:boolean|null;target:boolean|null;resources:Record<string,boolean>};
 currentReferences:{target:boolean|null;resources:Record<string,boolean>};
};
export type LegacySoundSource={id:string;title:string;version:number;historical:boolean;revisionId:string;revisionSha256:string};
export type SoundOwnershipWorkspace={schemaVersion:string;snapshotId:string;bindings:SoundOwnershipBinding[];pending:SoundOwnershipBinding[];legacySources?:LegacySoundSource[];counts:{assigned:number;pending:number};hasMore:boolean;nextOffset:number|null};
export type SoundOwner={kind:'SPACE'|'STORY'|'EPISODE'|'SCENE'|'SHOT';id:string;label:string};
type SoundOwnershipStatusFilter='ALL'|'ASSIGNED'|'UNKNOWN';

const kindLabels:Record<SoundReferenceKind,string>={SPACE:'空间',STORY:'剧',EPISODE:'集',SCENE:'场',SHOT:'镜',ENTITY:'旧主体来源',STATE:'声音设定',REPRESENTATION:'声音表现',REQUIREMENT:'声音需求',MATERIAL:'声音素材族'};
const recordLabels:Record<string,string>={DRAFT:'草稿（未采用）',SUBMITTED:'待审阅（未采用）',ADOPTED:'已采用',CHANGES_REQUESTED:'要求修改（未采用）',ARCHIVED:'历史记录'};
const uniqueBindings=(rows:SoundOwnershipBinding[]):SoundOwnershipBinding[]=>[...new Map(rows.map(row=>[row.id+'\0'+row.revisionId,row])).values()];
const exactObjectUrl=(reference:Pick<SoundExactReference,'objectId'|'revisionId'>)=>runtimePath('/api/v1/objects/'+encodeURIComponent(reference.objectId)+'?revisionId='+encodeURIComponent(reference.revisionId));

export function soundReferenceUrl(reference:Pick<SoundExactReference,'kind'|'objectId'|'revisionId'>){
 const id=encodeURIComponent(reference.objectId);
 if(reference.kind==='SPACE')return runtimePath(`/?view=settings&settingsSection=space&settingsEntity=${id}`);
 if(reference.kind==='STORY')return runtimePath('/?view=story&storyMode=story-structure');
 if(reference.kind==='EPISODE')return runtimePath(`/?view=story&storyMode=logic&episode=${id}`);
 if(reference.kind==='SCENE')return runtimePath(`/?view=story&storyMode=audit&scene=${id}`);
 if(reference.kind==='SHOT')return runtimePath(`/?view=pipeline&shot=${id}`);
 if(reference.kind==='STATE'||reference.kind==='REPRESENTATION')return runtimePath(`/?view=materials&materialPanel=definitions&materialDefinitionKind=${reference.kind==='STATE'?'states':'representations'}&materialDefinitionId=${id}`);
 if(reference.kind==='REQUIREMENT')return runtimePath(`/?view=materials&material=${id}`);
 if(reference.kind==='MATERIAL')return runtimePath(`/?view=materials&family=${id}`);
 return exactObjectUrl(reference);
}

function ExactReference({reference,verified,current,role}:{reference:SoundExactReference;verified?:boolean|null;current?:boolean|null;role:string}){
 const targetUrl=reference.kind==='ENTITY'?exactObjectUrl(reference):soundReferenceUrl(reference);
 return <article className="sound-reference" data-sound-reference-kind={reference.kind} data-sound-reference-id={reference.objectId}>
  <header><span>{role} · {kindLabels[reference.kind]||reference.kind}</span>{verified===false&&<b className="sound-danger">精确依据不一致</b>}{verified===true&&<b>精确依据已核验</b>}</header>
  <dl><div><dt>永久身份</dt><dd><a href={targetUrl}>{reference.objectId}</a></dd></div><div><dt>精确修订</dt><dd><code>{reference.revisionId}</code></dd></div>{current!==undefined&&current!==null&&<div><dt>当前关系</dt><dd>{current?'仍是当前修订':'保留原修订；当前头已变化'}</dd></div>}</dl>
  <details><summary>技术追溯 · SHA 与对象版本</summary><code>{reference.sha256}</code><p>引用时对象版本：{reference.expectedVersion}</p><a href={exactObjectUrl(reference)} target="_blank" rel="noreferrer">读取此对象的精确修订 ↗</a></details>
 </article>;
}

function BindingCard({binding}:{binding:SoundOwnershipBinding}){
 const pending=binding.resolution==='UNKNOWN'||binding.status!=='ASSIGNED';
 return <article className={`sound-binding-card ${pending?'is-pending':''} ${binding.stale?'is-stale':''}`} data-sound-binding-id={binding.id} data-sound-resolution={binding.resolution}>
  <header><div><small>{pending?'归属待确认':'归属明确'} · {recordLabels[binding.state]||binding.state||'记录状态 UNKNOWN'}</small><h4>{visibleText(binding.title||binding.usage)}</h4></div><span>{binding.stale?'依据已过时':pending?'待补证据':'精确关联'}</span></header>
  <p>{visibleText(binding.usage)}</p>
  {pending&&binding.pending&&<section className="sound-pending-evidence" aria-label="声音归属待确认事项"><p><b>为什么还不能归属：</b>{visibleText(binding.pending.reason)}</p><div><b>缺少证据</b><ul>{binding.pending.missingEvidence.map((item,index)=><li key={index}>{visibleText(item)}</li>)}</ul></div><p><b>待办：</b>{visibleText(binding.pending.todo)}</p></section>}
  {binding.stale&&<p className="sound-stale-note" role="status">这条记录仍保留原精确依据，但不再作为当前归属投影。请核对目标或资源的新修订；不会自动换绑。</p>}
  {binding.target&&<ExactReference role="归属目标" reference={binding.target} verified={binding.exactReferences.target} current={binding.currentReferences.target}/>}
  {binding.source&&<ExactReference role="旧 SOUND 历史来源（非当前主体）" reference={binding.source} verified={binding.exactReferences.source}/>}
  <details className="sound-resources" open={binding.resources.length===1}><summary>关联声音资源 · {binding.resources.length}</summary>{binding.resources.map(reference=><ExactReference key={reference.objectId+'\0'+reference.revisionId} role="关联资源" reference={reference} verified={binding.exactReferences.resources[reference.objectId]} current={binding.currentReferences.resources[reference.objectId]}/>)}</details>
  <details className="sound-binding-technical"><summary>归属记录自身的精确修订</summary><dl><div><dt>永久归属记录</dt><dd><code>{binding.id}</code></dd></div><div><dt>记录修订</dt><dd><code>{binding.revisionId}</code></dd></div><div><dt>记录 SHA</dt><dd><code>{binding.revisionSha256}</code></dd></div><div><dt>记录对象版本</dt><dd>{binding.version}</dd></div></dl></details>
 </article>;
}

export function SoundOwnershipList({bindings,heading='关联声音',empty=false,label}:{bindings:SoundOwnershipBinding[];heading?:string;empty?:boolean;label?:string}){
 const rows=uniqueBindings(bindings);
 if(!rows.length&&!empty)return null;
 return <section className="sound-ownership-list" aria-label={label||heading}><header className="sound-list-heading"><div><h3>{heading}</h3></div><span>{rows.filter(row=>row.resolution==='UNKNOWN').length?`${rows.filter(row=>row.resolution==='UNKNOWN').length} 项待确认`:`${rows.length} 项`}</span></header>
  {rows.length?<div className="sound-binding-grid">{rows.map(binding=><BindingCard key={binding.id+'\0'+binding.revisionId} binding={binding}/>)}</div>:<p>当前没有已登记的声音归属；这不代表需要生成声音。</p>}
 </section>;
}

function LegacySources({sources}:{sources:LegacySoundSource[]}){
 if(!sources.length)return null;
 return <details className="legacy-sound-sources"><summary>旧 SOUND 来源 · 历史追溯 {sources.length} 项</summary><p>这里只保留迁移来源与原修订，不把旧 SOUND 恢复为当前独立主体，也不据标题推断新归属。</p><div>{sources.map(source=><article key={source.id}><div><b>{visibleText(source.title)}</b><span>{source.historical?'已退役历史来源':'待迁移旧来源'}</span></div><dl><div><dt>永久身份</dt><dd>{source.id}</dd></div><div><dt>精确修订</dt><dd><code>{source.revisionId}</code></dd></div></dl><details><summary>技术 SHA</summary><code>{source.revisionSha256}</code><p>当前对象版本：{source.version}</p></details><a href={exactObjectUrl({objectId:source.id,revisionId:source.revisionId})} target="_blank" rel="noreferrer">读取旧来源精确修订 ↗</a></article>)}</div></details>;
}

async function readSoundWorkspace(params:URLSearchParams,signal?:AbortSignal){
 return readManagementResponse<SoundOwnershipWorkspace>(await fetch(runtimePath('/api/v1/workspaces/sound-ownership?'+params.toString()),{cache:'no-store',signal}));
}

export function SoundOwnershipDirectory(){
 const [query,setQuery]=useState(''),[applied,setApplied]=useState<{query:string;status:SoundOwnershipStatusFilter}>({query:'',status:'ALL'}),[result,setResult]=useState<SoundOwnershipWorkspace|null>(null),[error,setError]=useState(''),[attempt,setAttempt]=useState(0),[loading,setLoading]=useState(true),generation=useRef(0),[expanded,setExpanded]=useState(false),expansionInitialized=useRef(false);
 useEffect(()=>{const request=++generation.current,controller=new AbortController(),params=new URLSearchParams({limit:'100'});if(applied.query)params.set('q',applied.query);if(applied.status!=='ALL')params.set('status',applied.status);setResult(null);setError('');setLoading(true);void readSoundWorkspace(params,controller.signal).then(value=>{if(controller.signal.aborted||request!==generation.current)return;setResult(value);if(!expansionInitialized.current){expansionInitialized.current=true;setExpanded(value.pending.length>0);}setError('');setLoading(false);}).catch(reason=>{if(controller.signal.aborted||request!==generation.current)return;setError(reason instanceof Error?reason.message:'声音归属读取失败');setLoading(false);});return()=>{++generation.current;controller.abort();};},[applied,attempt]);
 async function more(){if(!result?.hasMore||result.nextOffset===null||loading)return;const request=generation.current,params=new URLSearchParams({limit:'100',offset:String(result.nextOffset)});if(applied.query)params.set('q',applied.query);if(applied.status!=='ALL')params.set('status',applied.status);setLoading(true);try{const next=await readSoundWorkspace(params);if(request!==generation.current)return;const bindings=uniqueBindings([...result.bindings,...next.bindings]);setResult({...next,bindings,pending:bindings.filter(b=>b.resolution==='UNKNOWN'),legacySources:uniqueLegacy([...(result.legacySources||[]),...(next.legacySources||[])])});setError('');}catch(reason){if(request===generation.current)setError(reason instanceof Error?reason.message:'声音归属下一页读取失败');}finally{if(request===generation.current)setLoading(false);}}
 function submit(event:FormEvent){event.preventDefault();setApplied(previous=>({...previous,query:query.trim()}));}
 return <details className="sound-ownership-directory" open={expanded} onToggle={event=>setExpanded(event.currentTarget.open)}><summary><span>声音归属与待确认</span><b>{result?`${result.pending.length} 项待确认 · 当前读取 ${result.bindings.length} 项`:loading?'读取中':'需要重读'}</b></summary>
  <p>按空间或剧、集、场、镜查阅声音用途、归属依据和待确认事项。</p>
  <form role="search" onSubmit={submit}><label><span>搜索声音归属</span><input value={query} onChange={event=>setQuery(event.target.value)} placeholder="用途、归属记录标题或待确认原因"/></label><button type="submit" disabled={loading}>检索</button></form>
  <nav aria-label="声音归属状态筛选">{([['ALL','全部'],['ASSIGNED','归属明确'],['UNKNOWN','待确认']] as const).map(([id,label])=><button type="button" key={id} aria-pressed={applied.status===id} onClick={()=>setApplied(previous=>({...previous,status:id}))}>{label}</button>)}</nav>
  {error&&<p role="alert">{error} <button type="button" onClick={()=>setAttempt(value=>value+1)}>重新读取</button></p>}
  {result&&<><SoundOwnershipList bindings={result.bindings} heading={applied.status==='UNKNOWN'?'待确认声音':applied.query?`声音检索：${applied.query}`:'全部声音归属'} empty/><LegacySources sources={result.legacySources||[]}/>{result.hasMore&&<button type="button" disabled={loading} onClick={()=>void more()}>{loading?'正在读取…':'继续读取声音归属'}</button>}</>}
 </details>;
}

function uniqueLegacy(rows:LegacySoundSource[]){return [...new Map(rows.map(row=>[row.id+'\0'+row.revisionId,row])).values()];}

export function SoundOwnershipScope({owners,label='当前范围声音',empty=false}:{owners:SoundOwner[];label?:string;empty?:boolean}){
 const normalized:SoundOwner[]=[...new Map<string,SoundOwner>(owners.filter(owner=>owner.id&&owner.id!=='UNKNOWN').map(owner=>[owner.kind+'\0'+owner.id,owner])).values()];
 const key=normalized.map(owner=>owner.kind+'\0'+owner.id).join('\x01'),[state,setState]=useState<{key:string;bindings:SoundOwnershipBinding[];error:string}|null>(null),[attempt,setAttempt]=useState(0);
 useEffect(()=>{if(!key){setState({key,bindings:[],error:''});return;}const controller=new AbortController();void Promise.all(normalized.map(async owner=>{const rows:SoundOwnershipBinding[]=[];let offset=0;for(;;){const value=await readSoundWorkspace(new URLSearchParams({ownerId:owner.id,limit:'500',offset:String(offset)}),controller.signal);rows.push(...value.bindings);if(!value.hasMore)break;if(value.nextOffset===null||value.nextOffset<=offset)throw Error('声音分页游标无效');offset=value.nextOffset;}return rows;})).then(groups=>{if(!controller.signal.aborted)setState({key,bindings:uniqueBindings(groups.flat()),error:''});}).catch(reason=>{if(!controller.signal.aborted)setState({key,bindings:[],error:reason instanceof Error?reason.message:'声音归属读取失败'});});return()=>controller.abort();},[key,attempt]);
 const ready=state?.key===key;if(!key)return null;if(!ready)return <p className="sound-scope-loading" role="status">正在读取{label}…</p>;if(state.error)return <p className="sound-scope-error" role="alert">{label}读取失败：{state.error} <button type="button" onClick={()=>setAttempt(value=>value+1)}>重试</button></p>;
 return <SoundOwnershipList bindings={state.bindings} heading={label} label={label} empty={empty}/>;
}

export function bindingsForObject(bindings:SoundOwnershipBinding[]|undefined,objectId:string|undefined){
 if(!objectId)return [];
 return uniqueBindings((bindings||[]).filter(binding=>binding.source?.objectId===objectId||binding.target?.objectId===objectId||binding.resources.some(reference=>reference.objectId===objectId)));
}
