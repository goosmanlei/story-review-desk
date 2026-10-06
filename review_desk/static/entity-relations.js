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
  // Fixed readable columns. Measure full HTML before placing any node or edge;
  // a longer explanation expands the graph, never the square viewport.
  const groups=relationGroups(data,rows),ordered=groups.flatMap(g=>g.rows.map(row=>({row,main:g.main})));
  const center=340,nodeWidth=220,captionWidth=260,items=[];
  function node(record,central=false,reference=null){
    const g=make('g',{class:'relation-node'+(central?' central':'')});
    const box=make('rect',{width:nodeWidth,rx:4,class:'relation-node-box'+(central?' central':'')},null,g);
    const foreign=make('foreignObject',{width:nodeWidth},null,g),host=el('div','relation-node-content');foreign.append(host);
    host.append(productionEntityIcon(record.payload.entity_type));const copy=el('div');nodeText('small','relation-node-code',businessCode(record),copy);nodeText('span','relation-node-name',record.payload.title,copy);host.append(copy);
    if(!central){g.dataset.reviewDialogTrigger='';g.setAttribute('role','button');g.setAttribute('tabindex','0');g.setAttribute('aria-label','打开实体：'+record.payload.title);g.dataset.relatedEntity=record.object_id;
      const open=()=>openUnifiedMaterial(reference||{object_id:record.object_id,revision_id:record.id},g);
      g.ondblclick=e=>{e.preventDefault();e.stopPropagation();open()};g.onkeydown=e=>{if(['Enter',' '].includes(e.key)){e.preventDefault();e.stopPropagation();open()}};
    }
    return {g,box,foreign,host};
  }
  const central=node(entity,true);
  for(const [index,item] of ordered.entries()){
    const {row}=item,other=row.payload.entities.find(r=>r.object_id!==entity.object_id),record=by.get(other.object_id);if(!record)continue;
    const edge=make('path',{class:'relation-edge'+(item.main?' primary':''),'marker-end':`url(#${markerId})`,'stroke-dasharray':index%3===1?'8 4':index%3===2?'3 4':'none'});
    if(row.payload.direction==='mutual')edge.setAttribute('marker-start',`url(#${markerId})`);
    const foreign=make('foreignObject',{width:captionWidth}),host=materialTextSurface(foreign,row);host.classList.add('relation-text');host.dataset.relationId=row.object_id;
    nodeText('small','business-code',businessCode(row),host);
    for(const block of productionTextBlocks(row)){const label=nodeText('p','relation-caption',block.text,host);label.dataset.blockId=block.id}
    if(row.payload.basis==='production')nodeText('small','production-meta','制作选择',host);
    const references=row.payload.applies_to?.length?row.payload.applies_to:row.payload.sources;
    const sources=el('div','relation-sources');nodeText('span','production-meta','剧情依据 · '+references.length,sources);
    for(const source of references)materialReferenceLink(sources,source,relationSceneLabel(source),true);host.append(sources);
    items.push({...item,index,edge,foreign,host,node:node(record,false,other)});
  }
  let size=720,measuredScale=1,laidOut=false;
  const place=(n,x,y,h)=>{n.g.setAttribute('transform',`translate(${x-nodeWidth/2} ${y})`);n.box.setAttribute('height',h);n.foreign.setAttribute('height',h)};
  const layout=()=>{
    if(!viewport.isConnected)return;
    const centralHeight=Math.max(80,central.host.scrollHeight),top=40;place(central,center,top,centralHeight);
    const narrow=viewport.clientWidth<480, next=[top+centralHeight+90,top+centralHeight+90];
    for(const item of items){const side=item.index%2,x=narrow?center:(side?510:170),y=next[narrow?0:side],nh=Math.max(80,item.node.host.scrollHeight),ch=Math.max(120,item.host.scrollHeight+12);
      place(item.node,x,y,nh);item.foreign.setAttribute('x',x-captionWidth/2);item.foreign.setAttribute('y',y+nh+12);item.foreign.setAttribute('height',ch);
      next[narrow?0:side]=y+nh+12+ch+50;
      const cy=top+centralHeight/2,forward=item.row.payload.entities[0].object_id===entity.object_id;
      let d;
      if(item.index<(narrow?1:2)){const start=[center+(side?40:-40),top+centralHeight],end=[x,y];d=forward?`M${start} C${start[0]} ${y-40} ${x} ${y-40} ${end}`:`M${end} C${x} ${y-40} ${start[0]} ${y-40} ${start}`}
      else{const lane=side?680+Math.floor(item.index/2)*12:0-Math.floor(item.index/2)*12,port=side?center+nodeWidth/2:center-nodeWidth/2,endpoint=side?x+nodeWidth/2:x-nodeWidth/2,ty=y+nh/2;
        const points=[[port,cy],[lane,cy],[lane,ty],[endpoint,ty]];if(!forward)points.reverse();d='M'+points.map(v=>v.join(' ')).join(' L');
      }
      item.edge.setAttribute('d',d);
    }
    const gutter=Math.ceil(items.length/2)*12+30,left=-gutter,width=680+gutter*2,height=Math.max(720,...next);
    svg.setAttribute('viewBox',`${left} 0 ${width} ${height}`);svg.style.width=width+'px';svg.style.height=height+'px';size=height;
    if(!laidOut){viewport.scrollLeft=Math.max(0,center+gutter-viewport.clientWidth/2);viewport.scrollTop=0;laidOut=true;if(data.graphPosition){const saved=data.graphPosition;viewport.scrollLeft=saved.x+(saved.width-viewport.clientWidth)/2;viewport.scrollTop=saved.y}}
  };
  viewport.tabIndex=0;viewport.setAttribute('aria-label','关系图视窗，可滚动或拖动查看');
  const measure=layout;requestAnimationFrame(layout);
  viewport.onscroll=()=>{data.graphPosition={x:viewport.scrollLeft,y:viewport.scrollTop,scale:measuredScale,width:viewport.clientWidth,height:viewport.clientHeight}};
  let pan=null;
  viewport.onpointerdown=e=>{if(e.target.closest('.relation-text,[role=button]'))return;pan={x:e.clientX,y:e.clientY,left:viewport.scrollLeft,top:viewport.scrollTop};viewport.setPointerCapture(e.pointerId)};
  viewport.onpointermove=e=>{if(!pan)return;viewport.scrollLeft=pan.left+pan.x-e.clientX;viewport.scrollTop=pan.top+pan.y-e.clientY};
  viewport.onpointerup=viewport.onpointercancel=()=>{pan=null};
  viewport.onkeydown=e=>{if(e.target!==viewport||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();viewport.scrollBy({left:e.key==='ArrowLeft'?-80:e.key==='ArrowRight'?80:0,top:e.key==='ArrowUp'?-80:e.key==='ArrowDown'?80:0})};
  if(typeof ResizeObserver!=='undefined'){let width=viewport.clientWidth;const observer=new ResizeObserver(()=>{if(!viewport.isConnected){observer.disconnect();return}const nextWidth=viewport.clientWidth;if(width!==nextWidth){viewport.scrollLeft+=(width-nextWidth)/2;width=nextWidth}measure()});observer.observe(viewport);observer.observe(central.host);for(const item of items){observer.observe(item.host);observer.observe(item.node.host)}}
}

function relationSceneLabel(source){
  const ep=state.screenplays.flatMap(s=>s.episodes).find(e=>e.id===source.revision_id);
  return `${ep?.payload.number?reviewPositionLabel('episode',ep.payload.number)+' · ':''}${source.scene_id?reviewPositionLabel('scene',source.scene_id):'全文'}`;
}
