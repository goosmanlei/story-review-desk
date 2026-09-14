'use client';
import {useState} from 'react';
import {SpatialPlacementPanel} from './spatial-placement-panel';
import type {SpatialPlacementWorkspace} from '../presentation/spatial-placement.mjs';
import type {DomainGraph,DomainEntity,DomainConfiguration} from '../presentation/domain-model.mjs';
import type {EntityBusinessFacts} from '../presentation/domain-reading.mjs';
import type {SpatialEvidence} from '../presentation/domain-workspaces.mjs';
import {RelationshipCanvas,type CanvasNode} from './relationship-canvas';
import {CanvasSymbol,canvasTone} from './free-canvas';
import {visibleText} from './review-semantics';
import {entityCanvasIcon} from './entity-canvas-appearance';
import {spatialMapBackground} from './spatial-map-backdrop';
const facts={F:'来源事实',A:'改编提案',L:'制作锁定',U:'依据待核'};
export function StorySettingsCanvas({entities,graph,configuration,businessFacts,statusLabels,spatial,spatialPlacements,view,selectedId,onSelect,onSelectRelation,viewportKey}:{statusLabels?:Record<string,string>;entities:DomainEntity[];graph:DomainGraph;configuration:DomainConfiguration;businessFacts?:Record<string,EntityBusinessFacts>;spatial:SpatialEvidence|null;spatialPlacements?:SpatialPlacementWorkspace;view:'subjects'|'space';selectedId?:string;onSelect:(id:string)=>void;onSelectRelation:(id:string)=>void;viewportKey:string}){
 if(view==='subjects')return <SubjectRelationships statusLabels={statusLabels} key={viewportKey+':'+entities.map(entity=>entity.id).join('|')} entities={entities} graph={graph} configuration={configuration} businessFacts={businessFacts} viewportKey={viewportKey} onOpenNode={onSelect}/>;
 const edges=graph.relations.filter(relation=>relation.from.kind==='ENTITY'&&relation.to.kind==='ENTITY'&&!relation.historicalOnly).map(relation=>({id:relation.id,from:relation.from.id,to:relation.to.id,label:visibleText(relation.label),directed:configuration.relationTypes.find(type=>type.id===relation.type)?.directed,uncertain:relation.status!=='CONFIRMED'}));
 const occupied:Array<{x:number;y:number}>=[];
 const visiblePending=new Set(spatialPlacements?.pendingOverlays.map(v=>v.targetEntityId)||[]);
 const unplaced=entities.filter(entity=>!visiblePending.has(entity.id)).filter(entity=>{const position=spatial?.locations?.find(location=>location.id===entity.id)?.pos;return !position||position.length!==2||!position.every(Number.isFinite);});
 const nodes:CanvasNode[]=entities.flatMap(entity=>{
  const common={id:entity.id,label:visibleText(entity.name),group:configuration.entityTypes.find(type=>type.id===entity.type)?.label||'待分类主体',detail:[facts[entity.authority],statusLabels?.[entity.id]].filter(Boolean).join(' · '),icon:entityCanvasIcon(entity.type),tone:canvasTone(entity.type)};
  if(view!=='space')return [common];
  const source=spatial?.locations?.find(location=>location.id===entity.id),position=source?.pos;
  if(!position||position.length!==2||!position.every(Number.isFinite))return [];
  const anchor={x:position[0]*16,y:position[1]*16,label:source?.name||entity.name};
  let x=anchor.x-104,y=anchor.y-100;
  // Only label cards are displaced to avoid overlap. Published anchor coordinates stay fixed.
  for(let attempt=0;attempt<20&&occupied.some(point=>Math.abs(point.x-x)<230&&Math.abs(point.y-y)<110);attempt++){y+=120;if(attempt===4){x+=240;y=anchor.y-100;}}
  occupied.push({x,y});
  return [{...common,x,y,width:208,height:82,group:'已发布空间基线',detail:[source?.entrance||'入口方向待核',statusLabels?.[entity.id]].filter(Boolean).join(' · '),anchor}];
 });
 return <section className={`settings-canvas-main ${view==='space'?'is-spatial':''}`}>
  <div className="settings-canvas-legend"><strong className="settings-compass">{spatial?.orientation==='北上东右'?'↑ 北　　东 →':`方向 UNKNOWN · ${spatial?.orientation||'未登记'}`}</strong></div>
  <RelationshipCanvas nodes={nodes} edges={edges} selectedId={selectedId} onSelect={onSelect} onSelectEdge={onSelectRelation} label="全局空间与地点" viewportKey={viewportKey} height="min(82dvh, 940px)" background={spatialMapBackground(spatial)} supplement={<SpatialPlacementPanel value={spatialPlacements} names={Object.fromEntries(entities.map(e=>[e.id,visibleText(e.name)]))} onSelect={onSelect}/>} showGroups={false} showReadableList={false} notice="制作拓扑 · 地点锚点、片区与门向来自已发布基线；未登记的街巷连接和路线保持待核。"/>
  {view==='space'&&unplaced.length>0&&<section className="settings-unplaced-locations" aria-label="位置待核地点"><h3>尚无当前提案的地点</h3><p>UNKNOWN：未登记全局位置，不按名称或剧情顺序推定方位。</p><div>{unplaced.map(entity=><button type="button" key={entity.id} onClick={()=>onSelect(entity.id)}><CanvasSymbol kind="place"/>{visibleText(entity.name)}<small>位置未知 · {statusLabels?.[entity.id]||'状态待核'}</small></button>)}</div></section>}
 </section>;
}

/** Selection is emphasis only: current filters own the complete graph. */
function SubjectRelationships({entities,graph,configuration,businessFacts,statusLabels,viewportKey,onOpenNode}:{statusLabels?:Record<string,string>;businessFacts?:Record<string,EntityBusinessFacts>;entities:DomainEntity[];graph:DomainGraph;configuration:DomainConfiguration;viewportKey:string;onOpenNode:(id:string)=>void}){
 const [focusId,setFocusId]=useState<string|null>(null),[edgeId,setEdgeId]=useState<string|null>(null),[neighborsOnly,setNeighborsOnly]=useState(false);
 const shownIds=new Set(entities.map(entity=>entity.id)),focus=focusId&&shownIds.has(focusId)?focusId:undefined;
 const allEdges=graph.relations.filter(r=>r.from.kind==='ENTITY'&&r.to.kind==='ENTITY'&&!r.historicalOnly&&shownIds.has(r.from.id)&&shownIds.has(r.to.id)).map(r=>({id:r.id,from:r.from.id,to:r.to.id,label:visibleText(r.label),directed:configuration.relationTypes.find(t=>t.id===r.type)?.directed,uncertain:r.status!=='CONFIRMED'}));
 const adjacent=allEdges.filter(e=>e.from===focus||e.to===focus),neighborIds=new Set([focus,...adjacent.flatMap(e=>[e.from,e.to])]);
 const visible=neighborsOnly&&focus?entities.filter(e=>neighborIds.has(e.id)):entities;
 // Connected nodes stay near one another. Coordinates are display geometry only.
 const degree=(id:string)=>allEdges.filter(e=>e.from===id||e.to===id).length;
 const pending=new Set(visible.map(e=>e.id)),ordered:DomainEntity[]=[];
 for(const seed of [...visible].sort((a,b)=>degree(b.id)-degree(a.id)||a.id.localeCompare(b.id))){const queue=[seed.id];while(queue.length){const id=queue.shift()!;if(!pending.delete(id))continue;ordered.push(visible.find(e=>e.id===id)!);queue.push(...allEdges.filter(e=>e.from===id||e.to===id).map(e=>e.from===id?e.to:e.from).filter(id=>pending.has(id)));}}
 const columns=Math.min(8,Math.max(2,Math.ceil(Math.sqrt(ordered.length))));
 const nodes:CanvasNode[]=ordered.map((entity,index)=>({id:entity.id,label:visibleText(entity.name),group:configuration.entityTypes.find(t=>t.id===entity.type)?.label||'待分类主体',detail:statusLabels?.[entity.id],x:24+(index%columns)*238,y:24+Math.floor(index/columns)*132,height:78,width:182,icon:entityCanvasIcon(entity.type),tone:canvasTone(entity.type),draggable:false}));
 const edges=allEdges.map(e=>({...e,hideLabel:edgeId?e.id!==edgeId:!focus||e.from!==focus&&e.to!==focus}));
 return <section className="settings-canvas-main is-subject-relations">
  <div className="settings-neighborhood-tools"><span>{visible.length} 个主体 · {allEdges.filter(e=>visible.some(n=>n.id===e.from)&&visible.some(n=>n.id===e.to)).length} 条登记关系</span><label><input type="checkbox" disabled={!focus} checked={neighborsOnly} onChange={e=>setNeighborsOnly(e.target.checked)}/>只看选中主体及相邻主体</label>{focus&&<button onClick={()=>onOpenNode(focus)}>打开 {visibleText(entities.find(e=>e.id===focus)!.name)} 档案</button>}</div>
  <RelationshipCanvas key={String(neighborsOnly)} nodes={nodes} edges={edges} selectedId={focus} selectedEdgeId={edgeId||undefined} onSelect={id=>{setEdgeId(null);setFocusId(previous=>previous===id?null:id);if(focus===id)setNeighborsOnly(false);}} onSelectEdge={id=>{setEdgeId(previous=>previous===id?null:id);}} onOpenNode={id=>{setEdgeId(null);setFocusId(id);onOpenNode(id);}} onClearSelection={()=>{setFocusId(null);setEdgeId(null);setNeighborsOnly(false);}} label="主体与关联关系" viewportKey={viewportKey+':compact:'+neighborsOnly} height="min(72dvh, 760px)" showGroups={false} defaultAllEdges edgeRouting="curved" readOnly preserveGraphOnSelect showReadableList={false} notice="单击主体高亮相邻关系，双击打开档案；选中后显示关系名称。虚线表示尚未确认。"/>
  {focus&&<section className="settings-neighbor-list" aria-label="选中主体的关系"><h3>{visibleText(entities.find(e=>e.id===focus)!.name)} · {adjacent.length} 条关系</h3>{adjacent.map(e=><button key={e.id} aria-pressed={edgeId===e.id} onClick={()=>setEdgeId(e.id)}>{visibleText(entities.find(n=>n.id===e.from)?.name||e.from)} {e.directed?'→':'—'} {e.label} {e.directed?'→':'—'} {visibleText(entities.find(n=>n.id===e.to)?.name||e.to)}{e.uncertain?' · 待核':''}</button>)}{!adjacent.length&&<p>尚无已登记的主体关系。</p>}</section>}
 </section>;
}
