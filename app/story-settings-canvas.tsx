'use client';
import {useState} from 'react';
import type {DomainGraph,DomainEntity,DomainConfiguration} from '../host/instance-runtime/domain-model.mjs';
import type {EntityBusinessFacts} from '../host/instance-runtime/domain-reading.mjs';
import type {SpatialEvidence} from '../host/instance-runtime/domain-workspaces.mjs';
import {RelationshipCanvas,type CanvasNode} from './relationship-canvas';
import {CanvasSymbol,canvasTone} from './free-canvas';
import {visibleText} from './review-semantics';
import {entityCanvasIcon} from './entity-canvas-appearance';
import {spatialMapBackground} from './spatial-map-backdrop';
const facts={F:'来源事实',A:'改编提案',L:'制作锁定',U:'依据待核'};
export function StorySettingsCanvas({entities,graph,configuration,businessFacts,spatial,view,selectedId,onSelect,onSelectRelation,viewportKey}:{entities:DomainEntity[];graph:DomainGraph;configuration:DomainConfiguration;businessFacts?:Record<string,EntityBusinessFacts>;spatial:SpatialEvidence|null;view:'subjects'|'space';selectedId?:string;onSelect:(id:string)=>void;onSelectRelation:(id:string)=>void;viewportKey:string}){
 if(view==='subjects')return <SubjectRelationships key={viewportKey+':'+entities.map(entity=>entity.id).join('|')} entities={entities} graph={graph} configuration={configuration} businessFacts={businessFacts} viewportKey={viewportKey} onOpenNode={onSelect}/>;
 const edges=graph.relations.filter(relation=>relation.from.kind==='ENTITY'&&relation.to.kind==='ENTITY'&&!relation.historicalOnly).map(relation=>({id:relation.id,from:relation.from.id,to:relation.to.id,label:visibleText(relation.label),directed:configuration.relationTypes.find(type=>type.id===relation.type)?.directed,uncertain:relation.status!=='CONFIRMED'}));
 const occupied:Array<{x:number;y:number}>=[];
 const unplaced=entities.filter(entity=>{const position=spatial?.locations?.find(location=>location.id===entity.id)?.pos;return !position||position.length!==2||!position.every(Number.isFinite);});
 const nodes:CanvasNode[]=entities.flatMap(entity=>{
  const common={id:entity.id,label:visibleText(entity.name),group:configuration.entityTypes.find(type=>type.id===entity.type)?.label||'待分类主体',detail:facts[entity.authority],icon:entityCanvasIcon(entity.type),tone:canvasTone(entity.type)};
  if(view!=='space')return [common];
  const source=spatial?.locations?.find(location=>location.id===entity.id),position=source?.pos;
  if(!position||position.length!==2||!position.every(Number.isFinite))return [];
  const anchor={x:position[0]*16,y:position[1]*16,label:source?.name||entity.name};
  let x=anchor.x-104,y=anchor.y-100;
  // Only label cards are displaced to avoid overlap. Published anchor coordinates stay fixed.
  for(let attempt=0;attempt<20&&occupied.some(point=>Math.abs(point.x-x)<230&&Math.abs(point.y-y)<110);attempt++){y+=120;if(attempt===4){x+=240;y=anchor.y-100;}}
  occupied.push({x,y});
  return [{...common,x,y,width:208,height:82,group:'已发布空间基线',detail:source?.entrance||'入口方向待核',anchor}];
 });
 return <section className={`settings-canvas-main ${view==='space'?'is-spatial':''}`}>
  <div className="settings-canvas-legend"><strong className="settings-compass">{spatial?.orientation==='北上东右'?'↑ 北　　东 →':`方向 UNKNOWN · ${spatial?.orientation||'未登记'}`}</strong></div>
  <RelationshipCanvas nodes={nodes} edges={edges} selectedId={selectedId} onSelect={onSelect} onSelectEdge={onSelectRelation} label="全局空间与地点" viewportKey={viewportKey} height="min(82dvh, 940px)" background={spatialMapBackground(spatial)} showGroups={false} showReadableList={false} notice="制作拓扑 · 地点锚点、片区与门向来自已发布基线；未登记的街巷连接和路线保持待核。"/>
  {view==='space'&&unplaced.length>0&&<section className="settings-unplaced-locations" aria-label="位置待核地点"><h3>位置待核 · 不放入地图</h3><p>UNKNOWN：未登记全局位置，不按名称或剧情顺序推定方位。</p><div>{unplaced.map(entity=><button type="button" key={entity.id} onClick={()=>onSelect(entity.id)}><CanvasSymbol kind="place"/>{visibleText(entity.name)}<small>位置未知</small></button>)}</div></section>}
 </section>;
}

/** Selection is emphasis only: current filters own the complete graph. */
function SubjectRelationships({entities,graph,configuration,businessFacts,viewportKey,onOpenNode}:{businessFacts?:Record<string,EntityBusinessFacts>;entities:DomainEntity[];graph:DomainGraph;configuration:DomainConfiguration;viewportKey:string;onOpenNode:(id:string)=>void}){
 const [focusId,setFocusId]=useState<string|null>(null);
 const [edgeId,setEdgeId]=useState<string|null>(null);
 const shownIds=new Set(entities.map(entity=>entity.id));
 const focus=focusId&&shownIds.has(focusId)?focusId:undefined;
 const edges=graph.relations.filter(relation=>relation.from.kind==='ENTITY'&&relation.to.kind==='ENTITY'&&!relation.historicalOnly&&shownIds.has(relation.from.id)&&shownIds.has(relation.to.id)).map(relation=>({id:relation.id,from:relation.from.id,to:relation.to.id,label:visibleText(relation.label),directed:configuration.relationTypes.find(type=>type.id===relation.type)?.directed,uncertain:relation.status!=='CONFIRMED'}));
 const nodes:CanvasNode[]=entities.map(entity=>({id:entity.id,label:visibleText(entity.name),group:configuration.entityTypes.find(type=>type.id===entity.type)?.label||'待分类主体',detail:facts[entity.authority],facts:[businessFacts?.[entity.id]?.members.length?'成员：'+businessFacts[entity.id].members.map(m=>m.name).join('、'):visibleText(entity.description||'业务说明待补'),[businessFacts?.[entity.id]?.stateCount?businessFacts[entity.id].stateCount+' 个状态':'',businessFacts?.[entity.id]?.requirementCount?businessFacts[entity.id].requirementCount+' 项素材':''].filter(Boolean).join(' · ')].filter(Boolean),height:160,width:240,icon:entityCanvasIcon(entity.type),tone:canvasTone(entity.type),draggable:false}));
 return <section className="settings-canvas-main is-subject-relations">
  <RelationshipCanvas nodes={nodes} edges={edges} selectedId={focus} selectedEdgeId={edgeId||undefined} onSelect={id=>{setEdgeId(null);setFocusId(previous=>previous===id?null:id);}} onSelectEdge={id=>{setFocusId(null);setEdgeId(previous=>previous===id?null:id);}} onOpenNode={id=>{setEdgeId(null);setFocusId(id);onOpenNode(id);}} onClearSelection={()=>{setFocusId(null);setEdgeId(null);}} label="主体与关联关系" viewportKey={viewportKey+':readonly:overview'} height="calc(100dvh - 140px)" showGroups defaultAllEdges edgeRouting="curved" readOnly preserveGraphOnSelect showReadableList={false} notice="单击主体查看关联，双击打开档案；单击连线或关系文字高亮该关系及两端主体。再次点击取消；虚线表示尚未确认。"/>
 </section>;
}
