/* Direct relationships stay in context; labels are exact commentable text. */
let relationGraphSerial=0;
function relationGraphPosition(center,width,height,scale,offset={x:0,y:0}){
  return {x:center.x*scale+offset.x-width/2,y:center.y*scale+offset.y-height/2};
}
function relationGroups(data,rows){
  const primary=new Set(data.relationship_layout?.primary||[]),order=data.relationship_layout?.order||[];
  if(!primary.size){const ranked=[...rows].sort((a,b)=>(b.payload.applies_to?.length||b.payload.sources?.length||0)-(a.payload.applies_to?.length||a.payload.sources?.length||0)||order.indexOf(b.object_id)-order.indexOf(a.object_id)||a.object_id.localeCompare(b.object_id));for(const row of ranked.slice(0,6))primary.add(row.object_id)}
  const rank=id=>{const i=order.indexOf(id);return i<0?order.length:i};
  return [true,false].map(main=>({main,rows:rows.filter(r=>primary.has(r.object_id)===main).sort((a,b)=>rank(a.object_id)-rank(b.object_id)||a.object_id.localeCompare(b.object_id))})).filter(g=>g.rows.length);
}
// Curves fan in disjoint x strips. Their ordered y coordinates cannot cross;
// only their common entity endpoint is shared. The own caption masks its line.
function relationCurve(start,captionLeft,captionRight,end,forward=true){
  const curve=(a,b)=>`C${a[0]+(b[0]-a[0])*.42} ${a[1]} ${b[0]-(b[0]-a[0])*.42} ${b[1]} ${b[0]} ${b[1]}`;
  if(forward)return `M${start.join(' ')} ${curve(start,captionLeft)} L${captionRight.join(' ')} ${curve(captionRight,end)}`;
  const reverse=(a,b)=>`C${a[0]-(a[0]-b[0])*.42} ${a[1]} ${b[0]+(a[0]-b[0])*.42} ${b[1]} ${b.join(' ')}`;
  return `M${end.join(' ')} ${reverse(end,captionRight)} L${captionLeft.join(' ')} ${reverse(captionLeft,start)}`;
}
function relationSelection(rows,entityId,selection){
  if(!selection)return [];
  return rows.filter(r=>selection.kind==='edge'?r.object_id===selection.id:r.payload.entities.some(e=>e.object_id===selection.id)&&r.payload.entities.some(e=>e.object_id===entityId)).map(r=>r.object_id);
}
function renderEntityRelationGraph(root,data){
  const section=el('section','entity-relations'),heading=el('div','relation-heading');section.setAttribute('aria-label','实体关系');nodeText('h3',null,'关系',heading);section.append(heading);root.append(section);
  const rows=(data.relationships||[]).map(r=>data.localVersions?.[r.object_id]||r),entity=data.entity;
  const by=new Map([entity,...(data.related_entities||[])].map(r=>[r.object_id,r]));
  const viewport=el('div','relation-graph-viewport'),canvas=el('div','relation-graph-canvas');viewport.append(canvas);
  const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');svg.classList.add('relation-graph');svg.setAttribute('role','group');svg.setAttribute('aria-label',entity.payload.title+'的直接关系图');canvas.append(svg);
  const make=(tag,attrs={},text=null,parent=svg)=>{const e=document.createElementNS(ns,tag);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,v);if(text!==null)e.textContent=text;parent.append(e);return e};
  const serial=++relationGraphSerial,markerId='entity-relation-arrow-'+serial;
  const defs=make('defs');for(const [id,color] of [[markerId,'#73917a'],[markerId+'-selected','#a34c21']]){const marker=make('marker',{id,viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:6,markerHeight:6,orient:'auto-start-reverse'},null,defs);make('path',{d:'M0 0L10 5L0 10Z',fill:color},null,marker)}
  const nodeWidth=200,captionWidth=300,width=1080,captionX=460,targetX=850,groups=new Map(),items=[];
  let moved=false;
  const canSelect=e=>!moved&&!e.target.closest('button,a,select,input,textarea')&&!window.getSelection()?.toString();
  function choose(selection){data.graphSelection=selection;paintSelection()}
  function node(record,central=false,reference=null){
    const g=make('g',{class:'relation-node'+(central?' central':''),'data-entity-id':record.object_id}),box=make('rect',{width:nodeWidth,rx:5,class:'relation-node-box'+(central?' central':'')},null,g),foreign=make('foreignObject',{width:nodeWidth},null,g),host=el('div','relation-node-content');foreign.append(host);
    host.append(productionEntityIcon(record.payload.entity_type));const copy=el('div');nodeText('small','relation-node-code',businessCode(record),copy);nodeText('span','relation-node-name',record.payload.title,copy);host.append(copy);
    if(!central){g.dataset.reviewDialogTrigger='';g.setAttribute('role','button');g.setAttribute('tabindex','0');g.setAttribute('aria-label','打开实体：'+record.payload.title);g.setAttribute('aria-pressed','false');g.setAttribute('aria-keyshortcuts','Enter Space s');g.dataset.relatedEntity=record.object_id;make('title',{},'单击选择直接关系；双击或 Enter 打开实体，S 选择关系',g);
      const open=()=>openUnifiedMaterial(reference||{object_id:record.object_id,revision_id:record.id},g);
      g.onclick=e=>{if(canSelect(e)){e.stopPropagation();choose({kind:'node',id:record.object_id})}};
      g.ondblclick=e=>{if(moved)return;e.preventDefault();e.stopPropagation();open()};g.onkeydown=e=>{if(['Enter',' '].includes(e.key)){e.preventDefault();e.stopPropagation();open()}else if(e.key.toLowerCase()==='s'){e.preventDefault();e.stopPropagation();choose({kind:'node',id:record.object_id})}};
    }
    return {g,box,foreign,host};
  }
  const edgeLayer=make('g'),central=node(entity,true);
  for(const group of relationGroups(data,rows))for(const row of group.rows){
    const other=row.payload.entities.find(r=>r.object_id!==entity.object_id),record=by.get(other?.object_id);if(!record)continue;
    if(!groups.has(other.object_id))groups.set(other.object_id,{node:node(record,false,other),items:[]});
    const edge=make('path',{class:'relation-edge'+(group.main?' primary':''),'data-relation-id':row.object_id,'marker-end':`url(#${markerId})`},null,edgeLayer),hit=make('path',{class:'relation-edge-hit','data-relation-id':row.object_id,role:'button',tabindex:0,'aria-label':'选择关系：'+businessCode(row)+' · '+row.payload.label,'aria-pressed':'false'},null,edgeLayer);
    const foreign=make('foreignObject',{width:captionWidth,'data-relation-caption':row.object_id}),host=materialTextSurface(foreign,row);host.classList.add('relation-text');host.dataset.relationId=row.object_id;host.tabIndex=0;host.setAttribute('aria-label','选择关系说明：'+businessCode(row)+' · '+row.payload.label);host.setAttribute('aria-keyshortcuts','Enter Space');
    const select=e=>{if(canSelect(e)){e.stopPropagation();choose({kind:'edge',id:row.object_id})}};hit.onclick=host.onclick=select;
    const keys=e=>{if(e.target===e.currentTarget&&['Enter',' '].includes(e.key)){e.preventDefault();e.stopPropagation();choose({kind:'edge',id:row.object_id})}};hit.onkeydown=host.onkeydown=keys;
    nodeText('small','business-code',businessCode(row),host);for(const block of productionTextBlocks(row)){const label=nodeText('p','relation-caption',block.text,host);label.dataset.blockId=block.id}
    if(row.payload.basis==='production')nodeText('small','production-meta','制作选择',host);
    const references=row.payload.applies_to?.length?row.payload.applies_to:row.payload.sources||[],sources=el('div','relation-sources');nodeText('span','production-meta','剧情依据 · '+references.length,sources);for(const source of references)materialReferenceLink(sources,source,relationSceneLabel(source),true);host.append(sources);
    const item={row,edge,hit,foreign,host,other:other.object_id};items.push(item);groups.get(other.object_id).items.push(item);
  }
  function paintSelection(){
    const selected=new Set(relationSelection(rows,entity.object_id,data.graphSelection)),ends=new Set();for(const item of items){const on=selected.has(item.row.object_id);if(on)for(const e of item.row.payload.entities)ends.add(e.object_id);item.edge.classList.toggle('selected',on);item.host.classList.toggle('selected',on);item.hit.setAttribute('aria-pressed',String(on));item.host.dataset.selected=String(on);const marker=`url(#${markerId+(on?'-selected':'')})`;item.edge.setAttribute('marker-end',marker);if(item.row.payload.direction==='mutual')item.edge.setAttribute('marker-start',marker)}
    for(const n of [central,...[...groups.values()].map(g=>g.node)]){const on=ends.has(n.g.dataset.entityId);n.g.classList.toggle('selected',on);if(n.g.hasAttribute('aria-pressed'))n.g.setAttribute('aria-pressed',String(on))}
  }
  const controls=el('div','relation-controls');heading.append(controls);let scale=data.graphView?.scale||1,height=720,ready=false,mode=data.graphView?.mode||'original';
  const fit=()=>Math.min(1,(viewport.clientWidth-12)/width,(viewport.clientHeight-12)/height),minimum=()=>Math.min(.1,fit()),maximum=4;
  const status=nodeText('output','relation-scale','100%',controls);status.setAttribute('aria-live','polite');
  const buttons={};for(const [key,label] of [['fit','展示完整关系图'],['original','原始大小'],['in','扩大'],['out','缩小']])buttons[key]=productionButton(controls,label,()=>zoom(key));
  controls.append(status);
  if(!rows.length){for(const b of Object.values(buttons))b.disabled=true;nodeText('p','production-meta','暂无已登记的直接关系',section);return}
  section.append(viewport);viewport.tabIndex=0;viewport.setAttribute('aria-label','关系图视窗，可滚动或拖动查看');viewport.setAttribute('aria-keyshortcuts','+ - 0 f Escape ArrowLeft ArrowRight ArrowUp ArrowDown');
  let offsetX=0,offsetY=0;
  function remember(){if(!ready)return;data.graphView={scale,mode,x:(viewport.scrollLeft+viewport.clientWidth/2-offsetX)/scale,y:(viewport.scrollTop+viewport.clientHeight/2-offsetY)/scale}}
  function resize(center){
    const w=viewport.clientWidth,h=viewport.clientHeight;offsetX=Math.max(0,(w-width*scale)/2);offsetY=Math.max(0,(h-height*scale)/2);canvas.style.width=Math.max(w,width*scale)+'px';canvas.style.height=Math.max(h,height*scale)+'px';svg.style.width=width*scale+'px';svg.style.height=height*scale+'px';svg.style.left=offsetX+'px';svg.style.top=offsetY+'px';
    const position=relationGraphPosition(center||{x:width/2,y:h/2/scale},w,h,scale,{x:offsetX,y:offsetY});viewport.scrollLeft=position.x;viewport.scrollTop=position.y;
    status.textContent=Math.round(scale*1000)/10+'%'+(scale<=minimum()+.00001?' · 最小':scale>=maximum?' · 最大':'');buttons.in.disabled=scale>=maximum;buttons.out.disabled=scale<=minimum()+.00001;buttons.fit.setAttribute('aria-pressed',String(mode==='fit'));buttons.original.setAttribute('aria-pressed',String(mode==='original'));remember();
  }
  function zoom(key){remember();const center=data.graphView;mode=key==='fit'?'fit':key==='original'?'original':'custom';scale=key==='fit'?fit():key==='original'?1:Math.max(minimum(),Math.min(maximum,scale*(key==='in'?1.25:.8)));resize(key==='fit'?{x:width/2,y:height/2}:center)}
  const place=(n,x,y,h)=>{n.g.setAttribute('transform',`translate(${x} ${y})`);n.box.setAttribute('height',h);n.foreign.setAttribute('height',h)};
  function layout(){
    if(!viewport.isConnected)return;const saved=data.graphView;let y=30;
    for(const group of groups.values()){const begin=y,nh=Math.max(72,group.node.host.scrollHeight);for(const item of group.items){const ch=Math.max(100,item.host.scrollHeight+12);item.y=y+ch/2;item.foreign.setAttribute('x',captionX);item.foreign.setAttribute('y',y);item.foreign.setAttribute('height',ch);y+=ch+28}const groupHeight=Math.max(nh,y-begin-28);group.y=begin+groupHeight/2;place(group.node,targetX,group.y-nh/2,nh);y=begin+groupHeight+42}
    height=Math.max(240,y);const cy=height/2,ch=Math.max(72,central.host.scrollHeight);place(central,30,cy-ch/2,ch);for(const group of groups.values())for(const item of group.items){const d=relationCurve([230,cy],[captionX,item.y],[captionX+captionWidth,item.y],[targetX,group.y],item.row.payload.entities[0].object_id===entity.object_id);item.edge.setAttribute('d',d);item.hit.setAttribute('d',d)}
    svg.setAttribute('viewBox',`0 0 ${width} ${height}`);ready=true;if(mode==='fit')scale=fit();resize(saved);paintSelection();
  }
  viewport.onscroll=remember;
  let pan=null;
  viewport.onpointerdown=e=>{moved=false;if(e.button!==0||e.target.closest('.relation-text,button,a,select,input,textarea'))return;pan={x:e.clientX,y:e.clientY,left:viewport.scrollLeft,top:viewport.scrollTop,pointer:e.pointerId}};
  viewport.onpointermove=e=>{if(!pan)return;if(Math.hypot(e.clientX-pan.x,e.clientY-pan.y)>5){moved=true;viewport.setPointerCapture(e.pointerId)}if(moved){viewport.scrollLeft=pan.left+pan.x-e.clientX;viewport.scrollTop=pan.top+pan.y-e.clientY}};
  viewport.onpointerup=viewport.onpointercancel=()=>{pan=null};viewport.onclick=e=>{if(canSelect(e)&&!e.target.closest('.relation-node,.relation-text,.relation-edge-hit'))choose(null)};
  viewport.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();choose(null);return}if(e.target!==viewport)return;const key=({'+':'in','=':'in','-':'out','0':'original',f:'fit'})[e.key];if(key){e.preventDefault();e.stopPropagation();zoom(key);return}if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();viewport.scrollBy({left:e.key==='ArrowLeft'?-80:e.key==='ArrowRight'?80:0,top:e.key==='ArrowUp'?-80:e.key==='ArrowDown'?80:0})}};
  requestAnimationFrame(layout);
  if(typeof ResizeObserver!=='undefined'){const observer=new ResizeObserver(()=>{if(!viewport.isConnected){observer.disconnect();return}layout()});observer.observe(viewport);observer.observe(central.host);for(const item of items)observer.observe(item.host);for(const group of groups.values())observer.observe(group.node.host)}
}

function relationSceneLabel(source){
  const ep=state.screenplays.flatMap(s=>s.episodes).find(e=>e.id===source.revision_id);
  return `${ep?.payload.number?reviewPositionLabel('episode',ep)+' · ':''}${source.scene_id?reviewPositionLabel('scene',source.scene_id,source.object_id):'全文'}`;
}

function renderEntityRelations(root,data){
  const rows=(data.relationships||[]).map(r=>data.localVersions?.[r.object_id]||r).filter(r=>reviewWorkMatches(r));if(!rows.length)return;
  const section=el('section','entity-relationships-reading');nodeText('h3',null,'人物与故事关系',section);
  for(const row of rows){const line=el('article');renderOriginalReviewText(line,row);for(const ref of row.payload.entities||[])if(ref.object_id!==data.entity.object_id)productionRefLink(line,{...ref,kind:'ENTITY'},productionName(ref,(data.related_entities||[]).map(r=>({object_id:r.object_id,revision_id:r.id,title:r.payload.title}))));entitySources(line,row);section.append(line)}
  const graph=productionButton(section,'用关系图查看',()=>{const {body}=openReviewDialog('人物关系',graph,'material-reference-dialog');renderEntityRelationGraph(body,data)});
  root.append(section);
}
