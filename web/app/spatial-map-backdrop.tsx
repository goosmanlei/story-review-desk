import type {SpatialEvidence} from '../presentation/domain-workspaces.mjs';
import type {CanvasBackground} from './free-canvas';

/** Generated reading map, not a new spatial source or an inferred street network. */
export function spatialMapBackground(spatial:SpatialEvidence|null):CanvasBackground|undefined{
 const locations=(spatial?.locations||[]).flatMap(location=>location.pos?.length===2&&location.pos.every(Number.isFinite)?[{...location,x:location.pos[0]*16,y:location.pos[1]*16}]:[]);
 if(!locations.length)return undefined;
 const x=Math.min(...locations.map(p=>p.x))-200,y=Math.min(...locations.map(p=>p.y))-210;
 const width=Math.max(...locations.map(p=>p.x))+200-x,height=Math.max(...locations.map(p=>p.y))+170-y;
 const regions=[...new Set(locations.map(p=>p.zone).filter((zone):zone is string=>!!zone&&zone!=='UNKNOWN'))].map((zone,index)=>{
  const points=locations.filter(p=>p.zone===zone),left=Math.min(...points.map(p=>p.x))-140,top=Math.min(...points.map(p=>p.y))-135;
  return {zone,index,left,top,width:Math.max(...points.map(p=>p.x))+140-left,height:Math.max(...points.map(p=>p.y))+90-top};
 });
 const colors=['#a2b0a0','#c5b08d','#91acae','#b1a4b8'];
 return {x,y,width,height,content:<svg className="spatial-map-backdrop" viewBox={`${x} ${y} ${width} ${height}`} role="img" aria-label="依据已发布坐标生成的空间底图" data-spatial-source-sha={spatial?.sourceSha256} data-spatial-version={spatial?.version}>
  <title>制作拓扑地图 · {spatial?.version||'已发布基线'}</title>
  <desc>地点锚点按已发布坐标绘制。色块仅区分已登记片区，不表示真实边界、道路、建筑尺寸或人物行进路线。</desc>
  <rect x={x} y={y} width={width} height={height} rx="18" fill="#eee7d7"/>
  <rect x={x+12} y={y+12} width={width-24} height={height-24} rx="12" fill="none" stroke="#c9bca5" strokeWidth="2"/>
  <text className="spatial-map-title" x={x+36} y={y+47}>制作拓扑地图</text>
  <text className="spatial-map-note" x={x+36} y={y+73}>已发布锚点 · 门向与片区 · 街巷连接待核</text>
  {spatial?.orientation==='北上东右'&&<g transform={`translate(${x+width-64} ${y+70})`} fill="#626e64"><path d="M0 -38 -10 -8 0 -14 10 -8Z"/><path d="M0 -12V18M-18 0H22" stroke="currentColor"/><text x="-7" y="-43" fontSize="16">北</text><text x="27" y="5" fontSize="16">东</text></g>}
  {regions.map(region=><g key={region.zone} data-map-region={region.zone}>
   <path d={`M ${region.left+32} ${region.top} H ${region.left+region.width-30} L ${region.left+region.width} ${region.top+28} V ${region.top+region.height-35} L ${region.left+region.width-28} ${region.top+region.height} H ${region.left+22} L ${region.left} ${region.top+region.height-24} V ${region.top+32} Z`} fill={colors[region.index%colors.length]} fillOpacity=".13" stroke={colors[region.index%colors.length]} strokeOpacity=".4" strokeWidth="2"/>
   <text className="spatial-map-region" x={region.left+24} y={region.top+31}>{region.zone}</text>
  </g>)}
  {locations.map(location=><g key={location.id} transform={`translate(${location.x} ${location.y})`} data-map-location={location.id} data-map-x={location.x} data-map-y={location.y}>
   {(()=>{const entrance=location.entrance||'',direction=/南(?:门|向)/.test(entrance)?0:/北(?:门|向)/.test(entrance)?180:/东(?:门|向)/.test(entrance)?-90:/西(?:门|向)/.test(entrance)?90:null;return direction===null?null:<g transform={`rotate(${direction})`} data-map-entrance={entrance}><path d="M-52 39H52" stroke="#d5c8b3" strokeWidth="16"/><path d="M-52 39H52" stroke="#faf5e8" strokeWidth="10"/><path d="M-8 24V32M8 24V32M-8 29H8" stroke="#7a6752" strokeWidth="2"/></g>;})()}
   <circle r="23" fill="#f8f4e9" stroke="#a4b1a1" strokeWidth="1.5"/>
   <path d="M-14 0 0-11 14 0M-10-2V11H10V-2M-3 11V3H3V11" fill="none" stroke="#899780" strokeWidth="2" strokeLinejoin="round"/>
  </g>)}
  <text className="spatial-map-note" x={x+36} y={y+height-28}>门前街面仅表示入口朝向 · 不代表实测路网与历史地理边界</text>
 </svg>};
}
