'use client';
import {useState} from 'react';
import type {DomainEntity,DomainGraph} from '../presentation/domain-model.mjs';
import type {WorkspaceState} from '../presentation/domain-workspaces.mjs';
import {RelationshipCanvas,type CanvasNode,type CanvasEdge} from './relationship-canvas';
import {canvasTone,type CanvasIcon} from './free-canvas';
import {entityCanvasIcon} from './entity-canvas-appearance';
import {visibleText} from './review-semantics';

export function SettingsEntityGraph({entity,graph,state,onEntity}:{entity:DomainEntity;graph:DomainGraph;state:WorkspaceState;onEntity:(id:string)=>void}){
 const [selected,setSelected]=useState<string|null>(null);
 const relations=graph.relations.filter(r=>!r.historicalOnly&&r.from.kind==='ENTITY'&&r.to.kind==='ENTITY'&&(r.from.id===entity.id||r.to.id===entity.id));
 const neighborIds=new Set(relations.flatMap(r=>[r.from.id,r.to.id]));neighborIds.delete(entity.id);
 const neighbors=graph.entities.filter(e=>neighborIds.has(e.id));
 const reps=graph.representations.filter(r=>r.entityId===entity.id);
 const requirements=state.requirements.filter(q=>q.entityRef===entity.id||reps.some(r=>q.representationRef===r.id||r.requirementIds.includes(q.id)));
 const items=[...reps.map(rep=>({id:'rep:'+rep.id,label:rep.label,rep,requirements:requirements.filter(q=>q.representationRef===rep.id||rep.requirementIds.includes(q.id)),familyIds:rep.assetFamilyIds})),...requirements.filter(q=>!reps.some(r=>q.representationRef===r.id||r.requirementIds.includes(q.id))).map(q=>({id:'requirement:'+q.id,label:q.title,rep:null,requirements:[q],familyIds:q.assetFamilyRefs}))];
 const familyIds=(item:typeof items[number])=>[...new Set([...item.familyIds,...item.requirements.flatMap(q=>q.assetFamilyRefs)])];
 const families=(item:typeof items[number])=>familyIds(item).map(id=>state.materialGraph?.families.find(f=>f.id===id)).filter(f=>!!f);
 const current=(item:typeof items[number])=>families(item).map(f=>state.materialGraph?.versions.find(v=>v.id===f.currentVersionRef)).find(v=>!!v);
 const nodes:CanvasNode[]=[{id:entity.id,label:visibleText(entity.name),group:'当前主体',x:300,y:120,width:218,height:88,icon:entityCanvasIcon(entity.type),tone:canvasTone(entity.type)},...neighbors.map((e,i)=>({id:e.id,label:visibleText(e.name),group:state.configuration.entityTypes.find(t=>t.id===e.type)?.label||'关联主体',x:-260*Math.floor(i/5),y:(i%5)*150,width:184,height:78,icon:entityCanvasIcon(e.type)})),...items.map((item,i)=>{const version=current(item),missing=version&&version.outputState!=='PRESENT',kind=(missing?families(item)[0]?.kind||item.requirements[0]?.mediaType:version?.mediaKind)||families(item)[0]?.kind||item.requirements[0]?.mediaType||'UNKNOWN';const preview=!missing&&kind!=='AUDIO'?version?.preview:undefined;return {id:item.id,label:visibleText(item.label),group:'关联素材',detail:missing?'媒体缺失':version?families(item).some(f=>f.adoptedVersionRef===version.id)?'已有采用版本':'已有版本 · 尚未采用':'尚无登记版本',x:660+Math.floor(i/5)*370,y:(i%5)*156,width:284,height:112,icon:({IMAGE:'image',AUDIO:'audio',VIDEO:'video',TEXT:'text'} as Record<string,CanvasIcon>)[kind]||'media',thumbnail:preview||undefined,mediaPlaceholder:preview?undefined:missing?'媒体缺失':kind==='AUDIO'?'音频':kind==='VIDEO'?'视频 · 无预览':kind==='IMAGE'?'尚无图片':'类型待核'};})];
 const edges:CanvasEdge[]=[...relations.map(r=>({id:r.id,from:r.from.id,to:r.to.id,label:visibleText(r.label),directed:state.configuration.relationTypes.find(t=>t.id===r.type)?.directed,uncertain:r.status!=='CONFIRMED'})),...items.map(item=>({id:'material:'+item.id,from:entity.id,to:item.id,label:'素材',hideLabel:true}))];
 const item=items.find(i=>i.id===selected);
 return <section className="settings-entity-graph" aria-label="主体与素材局部关系">
  <RelationshipCanvas nodes={nodes} edges={edges} selectedId={selected||entity.id} onSelect={id=>id.startsWith('rep:')||id.startsWith('requirement:')?setSelected(id):id!==entity.id?onEntity(id):setSelected(null)} label="关联主体与素材" viewportKey={'settings-entity:'+entity.id} height={440} readOnly showGroups={false} showReadableList defaultReadableListOpen edgeRouting="curved" defaultAllEdges notice="点击相邻主体查看档案；点击素材就地查看要求和采用版本。"/>
  {item&&<section className="settings-inline-material" aria-label="素材要求与版本"><header><h3>{visibleText(item.label)}</h3><button onClick={()=>setSelected(null)} aria-label="关闭素材要求">×</button></header>
    {item.requirements.length?item.requirements.map(q=><article key={q.id}><h4>{visibleText(q.title)}</h4><p>{q.mediaType||'类型待核'} · {({DRAFT:'草稿',SUBMITTED:'待审阅',ADOPTED:'已采用',CHANGES_REQUESTED:'要求修改',DISABLED:'已停用',ARCHIVED:'历史'} as Record<string,string>)[q.state||'']||'状态待核'}</p>{q.acceptanceCriteria?.length?<ul>{q.acceptanceCriteria.map((c,i)=><li key={i}>{visibleText(c)}</li>)}</ul>:<p>尚未登记验收要求。</p>}</article>):<p>此素材表现尚未关联需求。</p>}
    {families(item).map(f=>{const adopted=state.materialGraph?.versions.find(v=>v.id===f.adoptedVersionRef),latest=state.materialGraph?.versions.find(v=>v.id===f.currentVersionRef);return <article key={f.id}><h4>{visibleText(f.label)}</h4><p>当前采用：{adopted?visibleText(adopted.label):f.adoptedVersionRef?'UNKNOWN · 采用版本未取得':'尚未采用'}</p>{latest&&<p>{latest.outputState==='PRESENT'?'媒体可读取':'媒体缺失'} · {latest.canFlowDownstream?'可用于下游':'下游条件未满足'}</p>}<details><summary>精确素材版本</summary><p>素材族 <code>{f.id}</code></p>{[...new Set([f.currentVersionRef,f.adoptedVersionRef])].filter(Boolean).map(id=>{const v=state.materialGraph?.versions.find(v=>v.id===id);return <p key={id}><code>{id}</code><br/>{v?<><code>{v.revisionId}</code><br/><code>{v.sha256||'SHA UNKNOWN'}</code></>:'版本 UNKNOWN'}</p>})}</details></article>})}
    {!families(item).length&&<p>尚无登记素材族或版本。</p>}
    <details><summary>素材依据与身份</summary>{item.rep&&<><code>{item.rep.id}</code><p>{item.rep.authority} · {item.rep.type}</p></>}{item.requirements.map(q=><p key={q.id}><code>{q.id}</code> · {q.revisionId||'修订 UNKNOWN'}</p>)}</details>
  </section>}
 </section>;
}
