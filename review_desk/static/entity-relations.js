/* Direct relationships stay in context; labels are exact commentable text. */
let relationGraphSerial=0;
function relationGraphPosition(saved,width,height,scale,center){
  if(!saved?.scale)return {x:center*scale-width/2,y:center*scale-height/2};
  return {x:(saved.x+saved.width/2)*scale/saved.scale-width/2,y:(saved.y+saved.height/2)*scale/saved.scale-height/2};
}
function relationGroups(data,rows){
  const primary=new Set(data.relationship_layout?.primary||[]),order=data.relationship_layout?.order||[];
  if(!primary.size){const ranked=[...rows].sort((a,b)=>(b.payload.applies_to?.length||b.payload.sources?.length||0)-(a.payload.applies_to?.length||a.payload.sources?.length||0)||order.indexOf(b.object_id)-order.indexOf(a.object_id)||a.object_id.localeCompare(b.object_id));for(const row of ranked.slice(0,6))primary.add(row.object_id)}
  const rank=id=>{const i=order.indexOf(id);return i<0?order.length:i};
  return [true,false].map(main=>({main,rows:rows.filter(r=>primary.has(r.object_id)===main).sort((a,b)=>rank(a.object_id)-rank(b.object_id)||a.object_id.localeCompare(b.object_id))})).filter(g=>g.rows.length);
}
function relationCaption(row){
  const blocks=productionTextBlocks(row),block=blocks.find(b=>b.text.includes(row.payload.label));
  const offset=block?Array.from(block.text.slice(0,block.text.indexOf(row.payload.label))).length:0;
  const anchor=state.comments.find(c=>c.id===state.selected&&c.target_revision_id===row.id)?.anchor;
  // A historical opinion can include endpoint names or older explanation text.
  // Show that exact passage only while locating that opinion, once on the edge.
  const quoted=anchor?.type==='text'&&blocks.find(b=>b.id===anchor.block_id);
  if(quoted&&(quoted!==block||anchor.start<offset||anchor.end>offset+Array.from(row.payload.label).length))return {block:quoted,text:quoted.text,offset:0};
  return {block,text:row.payload.label,offset};
}
function renderEntityRelations(root,data){
  const section=el('section','entity-relations');section.setAttribute('aria-label','实体关系');nodeText('h3',null,'关系',section);root.append(section);
  const rows=(data.relationships||[]).map(r=>data.localVersions?.[r.object_id]||r);
  if(!rows.length){nodeText('p','production-meta','暂无已登记的直接关系',section);return}
  const entity=data.entity,by=new Map([entity,...(data.related_entities||[])].map(r=>[r.object_id,r]));
  const viewport=el('div','relation-graph-viewport');section.append(viewport);
  const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');svg.classList.add('relation-graph');svg.setAttribute('role','group');svg.setAttribute('aria-label',entity.payload.title+'的直接关系图');viewport.append(svg);
  const markerId='entity-relation-arrow-'+(++relationGraphSerial);
  const make=(tag,attrs={},text=null,parent=svg)=>{const e=document.createElementNS(ns,tag);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,v);if(text!==null)e.textContent=text;parent.append(e);return e};
  const defs=make('defs'),marker=make('marker',{id:markerId,viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:6,markerHeight:6,orient:'auto-start-reverse'},null,defs);make('path',{d:'M0 0L10 5L0 10Z',fill:'#73917a'},null,marker);
  function node(record,x,y,central=false,reference=null){
    const g=make('g',{class:'relation-node'+(central?' central':'')});
    make('rect',{x:x-85,y:y-38,width:170,height:76,rx:4,class:'relation-node-box'+(central?' central':'')},null,g);
    const icon=productionEntityIcon(record.payload.entity_type);icon.setAttribute('x',x-70);icon.setAttribute('y',y-12);icon.setAttribute('width',24);icon.setAttribute('height',24);g.append(icon);
    const chars=Array.from(record.payload.title),lines=[chars.slice(0,6).join('')];if(chars.length>6)lines.push(chars.slice(6,chars.length>12?11:12).join('')+(chars.length>12?'…':''));
    make('text',{x:x+12,y:y-22,'text-anchor':'middle',class:'relation-node-code'},businessCode(record),g);
    for(const [index,line] of lines.entries())make('text',{x:x+12,y:y+(lines.length===1?12:1)+index*20,'text-anchor':'middle',class:'relation-node-name'},line,g);make('title',{},businessTitle(record),g);
    if(!central){g.dataset.reviewDialogTrigger='';g.setAttribute('role','button');g.setAttribute('tabindex','0');g.setAttribute('aria-label','打开实体：'+record.payload.title);g.dataset.relatedEntity=record.object_id;
      const open=()=>openUnifiedMaterial(reference||{object_id:record.object_id,revision_id:record.id},g);
      g.ondblclick=e=>{e.preventDefault();e.stopPropagation();open()};g.onkeydown=e=>{if(['Enter',' '].includes(e.key)){e.preventDefault();e.stopPropagation();open()}};
    }return g;
  }
  const groups=relationGroups(data,rows),positions=[];
  for(const group of groups){
    const perRing=8;
    group.rows.forEach((row,index)=>{const ring=Math.floor(index/perRing),count=Math.min(perRing,group.rows.length-ring*perRing),angle=-Math.PI/2+(index%perRing)*Math.PI*2/count;
      const radius=(group.main?190:545)+ring*310;positions.push({row,main:group.main,radius,angle});
    });
  }
  const extent=Math.max(360,...positions.map(v=>v.radius+225)),center=extent,size=extent*2;
  svg.setAttribute('viewBox',`0 0 ${size} ${size}`);
  for(const item of positions){
    const {row,angle,radius}=item,other=row.payload.entities.find(r=>r.object_id!==entity.object_id),record=by.get(other.object_id);if(!record)continue;
    const x=center+Math.cos(angle)*radius,y=center+Math.sin(angle)*radius,forward=row.payload.entities[0].object_id===entity.object_id;
    const near={x:center+Math.cos(angle)*85,y:center+Math.sin(angle)*45},far={x:x-Math.cos(angle)*82,y:y-Math.sin(angle)*39};
    const path=make('path',{class:'relation-edge'+(item.main?' primary':''),d:forward?`M${near.x} ${near.y} L${far.x} ${far.y}`:`M${far.x} ${far.y} L${near.x} ${near.y}`,'marker-end':`url(#${markerId})`});
    if(row.payload.direction==='mutual')path.setAttribute('marker-start',`url(#${markerId})`);
    const foreign=make('foreignObject',{x:x-110,y:y+45,width:220,height:85}),host=materialTextSurface(foreign,row);host.classList.add('relation-text');host.dataset.relationId=row.object_id;
    nodeText('small','business-code',businessCode(row),host);const caption=relationCaption(row),label=nodeText('span','relation-caption',caption.text,host);if(caption.block){label.dataset.blockId=caption.block.id;label.dataset.anchorOffset=caption.offset}
    if(row.payload.basis==='production')nodeText('small','production-meta','制作选择',host);
    const references=row.payload.applies_to?.length?row.payload.applies_to:row.payload.sources;
    const sources=el('details','relation-sources');nodeText('summary',null,'剧情依据 · '+references.length,sources);
    for(const source of references)materialReferenceLink(sources,source,relationSceneLabel(source),true);host.append(sources);
    node(record,x,y,false,other);
    if(typeof ResizeObserver!=='undefined'){const observer=new ResizeObserver(()=>{if(!host.isConnected){observer.disconnect();return}foreign.setAttribute('height',Math.max(85,host.scrollHeight+8))});observer.observe(host)}
  }
  node(entity,center,center,true);
  viewport.tabIndex=0;viewport.setAttribute('aria-label','关系图视窗，可滚动或拖动查看');
  let measuredScale=0;
  const measure=()=>{const scale=Math.max(.55,viewport.clientWidth/720),position=relationGraphPosition(data.graphPosition,viewport.clientWidth,viewport.clientHeight,scale,center);svg.style.width=size*scale+'px';svg.style.height=size*scale+'px';measuredScale=scale;
    viewport.scrollLeft=position.x;viewport.scrollTop=position.y;
    data.graphPosition={x:viewport.scrollLeft,y:viewport.scrollTop,scale,width:viewport.clientWidth,height:viewport.clientHeight};
  };
  requestAnimationFrame(measure);
  viewport.onscroll=()=>{data.graphPosition={x:viewport.scrollLeft,y:viewport.scrollTop,scale:measuredScale,width:viewport.clientWidth,height:viewport.clientHeight}};
  let pan=null;
  viewport.onpointerdown=e=>{if(e.target.closest('foreignObject,[role=button]'))return;pan={x:e.clientX,y:e.clientY,left:viewport.scrollLeft,top:viewport.scrollTop};viewport.setPointerCapture(e.pointerId)};
  viewport.onpointermove=e=>{if(!pan)return;viewport.scrollLeft=pan.left+pan.x-e.clientX;viewport.scrollTop=pan.top+pan.y-e.clientY};
  viewport.onpointerup=viewport.onpointercancel=()=>{pan=null};
  viewport.onkeydown=e=>{if(e.target!==viewport||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();viewport.scrollBy({left:e.key==='ArrowLeft'?-80:e.key==='ArrowRight'?80:0,top:e.key==='ArrowUp'?-80:e.key==='ArrowDown'?80:0})};
  if(typeof ResizeObserver!=='undefined'){let width=0;const observer=new ResizeObserver(()=>{if(!viewport.isConnected){observer.disconnect();return}if(viewport.clientWidth!==width){width=viewport.clientWidth;measure()}});observer.observe(viewport)}
}

function relationSceneLabel(source){
  const ep=state.screenplays.flatMap(s=>s.episodes).find(e=>e.id===source.revision_id);
  return `${ep?.payload.number?reviewPositionLabel('episode',ep.payload.number)+' · ':''}${source.scene_id?reviewPositionLabel('scene',source.scene_id):'全文'}`;
}
