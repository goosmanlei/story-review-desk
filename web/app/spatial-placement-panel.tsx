'use client';
import type {SpatialPlacementWorkspace,StoredSpatialPlacementEntry} from '../presentation/spatial-placement.mjs';
import './spatial-placement.css';

export function SpatialPlacementPanel({value,names,onSelect}:{value?:SpatialPlacementWorkspace;names:Record<string,string>;onSelect:(id:string)=>void}) {
 if(!value)return null;
 const pending=value.entries.filter(entry=>entry.classification==='PENDING_OVERLAY'&&entry.content&&Object.hasOwn(names,entry.content.location.id));
 function card(entry:StoredSpatialPlacementEntry) {
  const target=entry.content?.location?.id;
  return <article key={entry.note.id} data-placement-note={entry.note.id} data-placement-classification={entry.classification} data-placement-target={target}>
   <strong>{target?(names[target]||value?.locations.find(v=>v.id===target)?.title||target):entry.title}</strong>
   <span className="placement-status">待确认 · PENDING_CONFIRMATION · 草稿未采用</span>
   <p>精确位置、入口朝向与距离：UNKNOWN</p>
   {entry.classification!=='PENDING_OVERLAY'&&<p className="placement-warning">{entry.classification==='PUBLISHED_ANCHOR_EXISTS'?'与已发布锚点冲突':entry.classification==='CONFLICT'?'当前提案冲突':'依据陈旧或记录只读'} · 原提案保留可查</p>}
   {entry.issues.map((issue,index)=><p key={index}>{issue.message}</p>)}
   {target&&Object.hasOwn(names,target)&&<button type="button" onClick={()=>onSelect(target)}>打开地点 · {names[target]}</button>}
   <details><summary>查看提案与精确依据</summary>
    <p>{entry.content?.note}</p>
    <ul>{entry.content?.unknowns?.map(item=><li key={item}>{item}</li>)}</ul>
    {entry.content?.sceneEvidence?.status==='UNKNOWN'&&<p>场依据 UNKNOWN：{entry.content.sceneEvidence.reason}</p>}
    <p>卡槽仅是显示记录：{entry.content?.proposedSlot?.join(' / ')}；不表示方位、门向、距离、路线或制作几何。</p>
    <a href={`/api/v1/objects/${encodeURIComponent(entry.note.id)}?revisionId=${encodeURIComponent(entry.note.revisionId)}`} target="_blank" rel="noreferrer">读取 NOTE 原修订 ↗</a>
    <p>NOTE 版本 {entry.note.expectedVersion} · {entry.note.revisionId}</p>
    {entry.content&&[entry.content.location,entry.content.spatialSource,...(entry.content.sceneEvidence?.status==='EXACT'?entry.content.sceneEvidence.references:[])].map(reference=><p key={reference.id}><a href={`/api/v1/objects/${encodeURIComponent(reference.id)}?revisionId=${encodeURIComponent(reference.revisionId)}`} target="_blank" rel="noreferrer">{reference.id} · 精确依据 ↗</a><br/>{reference.revisionId}</p>)}
    <details><summary>技术追溯 · 修订 SHA 与原始来源 SHA</summary><pre>{JSON.stringify({note:entry.note,placement:entry.content},null,2)}</pre></details>
   </details>
  </article>;
 }
 return <section className="spatial-placement-panel" aria-label="地图待确认区域" data-geographic="false">
  <h3>待确认示意区（非地理位置） · {pending.length} 个地点</h3>
  <p>这里的卡片用于找到地点。区域与上方坐标地图独立，排列不表示空间关系；确认前保持 UNKNOWN。</p>
  {value.issues.map((issue,index)=><p key={index} role="status">{issue.message}</p>)}
  <div className="spatial-placement-cards">{pending.map(card)}</div>
  {!pending.length&&<p>当前没有可展示的待确认提案。</p>}
  {!!(value.staleDrafts.length+value.conflicts.length)&&<details className="spatial-placement-history" open><summary>陈旧与冲突提案 · {value.staleDrafts.length+value.conflicts.length} 项</summary><div className="spatial-placement-cards">{[...value.staleDrafts,...value.conflicts].map(card)}</div></details>}
 </section>;
}
