/* Summaries are reading aids, never character anchors into the original. */
let relationSummaryView=null,relationSummaryTimer=null,relationSummaryRestoringFocus=false;
function closeRelationSummary(){
  clearTimeout(relationSummaryTimer);relationSummaryTimer=null;
  if(!relationSummaryView)return;
  relationSummaryView.trigger.removeAttribute('aria-describedby');
  relationSummaryView.observer?.disconnect();relationSummaryView.node.remove();relationSummaryView=null;
}
function openRelationOriginal(row,trigger){
  closeRelationSummary();rememberMaterialRelations([row]);
  const {dialog,body}=openReviewDialog('关系原文 · '+businessTitle(row),trigger,'material-reference-dialog');
  const session=referenceReviewSession(dialog,{record:row,history:[row],uses:[]});dialog.reviewFocus=session.focus;
  renderOriginalReviewText(body,row);entitySources(body,row);session.focus();paintProductionReview();renderComments();
}
function showRelationSummary(trigger,context){
  if(!trigger.isConnected||!context?.summary)return;
  closeRelationSummary();
  const row=context.record,node=el('div','relation-summary-popover');node.id='relation-summary-'+(++relationGraphSerial);
  node.setAttribute('role','dialog');node.setAttribute('aria-label','关系摘要');
  nodeText('small','business-code',context.code||businessCode(row),node);
  const summary=nodeText('p',null,context.summary,node);summary.id=node.id+'-text';trigger.setAttribute('aria-describedby',summary.id);
  const action=productionButton(node,'原文与意见',()=>openRelationOriginal(row,trigger));action.className='review-reference-button';
  for(const ref of row.payload.sources||[]){
    const story=!!(ref.scene_id||ref.block_ids?.length||state.screenplays?.some(s=>s.episodes?.some(e=>e.id===ref.revision_id)));
    const label=story?relationSceneLabel(ref):businessCode(ref);
    if(label)materialReferenceLink(node,ref,label,story);
  }
  // A native modal makes its outside DOM inert and paints above it. Keep the
  // reading surface inside the owning modal so it remains visible/focusable.
  (trigger.closest('dialog')||document.body).append(node);
  const position=()=>{if(!trigger.isConnected){closeRelationSummary();return}const r=trigger.getBoundingClientRect(),b=node.getBoundingClientRect();node.style.left=Math.max(12,Math.min(r.left,innerWidth-b.width-12))+'px';node.style.top=Math.max(12,r.bottom+8+b.height<innerHeight-12?r.bottom+8:r.top-b.height-8)+'px'};
  const observer=new MutationObserver(()=>{if(!trigger.isConnected)closeRelationSummary()});observer.observe(document.body,{childList:true,subtree:true});
  relationSummaryView={trigger,node,observer,position};position();
  node.onpointerenter=()=>clearTimeout(relationSummaryTimer);
  node.onpointerleave=()=>scheduleRelationSummaryClose(trigger);
  node.onfocusout=()=>scheduleRelationSummaryClose(trigger);
}
function scheduleRelationSummaryClose(trigger){
  clearTimeout(relationSummaryTimer);relationSummaryTimer=setTimeout(()=>{const view=relationSummaryView;if(view?.trigger===trigger&&!view.node.matches(':hover')&&!view.node.contains(document.activeElement)&&document.activeElement!==trigger)closeRelationSummary()},180);
}
function bindRelationSummary(trigger,context){
  if(!trigger||!context?.summary)return;
  trigger.dataset.relationRevision=context.record.id;
  trigger.addEventListener('pointerenter',()=>{clearTimeout(relationSummaryTimer);relationSummaryTimer=setTimeout(()=>showRelationSummary(trigger,context),240)});
  trigger.addEventListener('pointerleave',()=>scheduleRelationSummaryClose(trigger));
  trigger.addEventListener('focus',()=>{if(!relationSummaryRestoringFocus)showRelationSummary(trigger,context)});
  trigger.addEventListener('blur',()=>scheduleRelationSummaryClose(trigger));
  trigger.addEventListener('keydown',event=>{if(event.key==='ArrowDown'){event.preventDefault();showRelationSummary(trigger,context);relationSummaryView?.node.querySelector('button')?.focus()}});
  trigger.addEventListener('click',()=>closeRelationSummary());
}
function relationEndpointRefs(row,data=null){
  if(row.payload.entities)return row.payload.entities;
  return (row.payload.endpoints||[]).map(oid=>{const record=[data?.entity,...(data?.related_entities||[])].find(r=>r?.object_id===oid);return {object_id:oid,...(record?{revision_id:record.id}:{})}});
}
if(typeof document!=='undefined'){
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&relationSummaryView){event.preventDefault();event.stopImmediatePropagation();const trigger=relationSummaryView.trigger;const within=relationSummaryView.node.contains(document.activeElement);closeRelationSummary();if(within){relationSummaryRestoringFocus=true;try{trigger.focus({preventScroll:true})}finally{relationSummaryRestoringFocus=false}}}},true);
  window.addEventListener('resize',()=>relationSummaryView?.position());
  document.addEventListener('scroll',()=>relationSummaryView?.position(),true);
}
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
  return rows.filter(r=>selection.kind==='edge'?r.object_id===selection.id:relationEndpointRefs(r).some(e=>e.object_id===selection.id)&&relationEndpointRefs(r).some(e=>e.object_id===entityId)).map(r=>r.object_id);
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
    const other=relationEndpointRefs(row,data).find(r=>r.object_id!==entity.object_id),record=by.get(other?.object_id);if(!record)continue;
    if(!groups.has(other.object_id))groups.set(other.object_id,{node:node(record,false,other),items:[]});
    const summary=row.payload.summary||row.payload.label||'历史关系说明未保留';
    const edge=make('path',{class:'relation-edge'+(group.main?' primary':''),'data-relation-id':row.object_id},null,edgeLayer),hit=make('path',{class:'relation-edge-hit','data-relation-id':row.object_id,role:'button',tabindex:0,'aria-label':'选择关系：'+businessCode(row)+' · '+summary,'aria-pressed':'false'},null,edgeLayer);
    const foreign=make('foreignObject',{width:captionWidth,'data-relation-caption':row.object_id}),host=el('div','relation-text relation-summary-caption');foreign.append(host);host.dataset.relationId=row.object_id;host.tabIndex=0;host.setAttribute('aria-label','选择关系摘要：'+businessCode(row)+' · '+summary);host.setAttribute('aria-keyshortcuts','Enter Space ArrowDown');
    const select=e=>{if(canSelect(e)){e.stopPropagation();choose({kind:'edge',id:row.object_id})}};hit.onclick=host.onclick=select;
    const keys=e=>{if(e.target===e.currentTarget&&['Enter',' '].includes(e.key)){e.preventDefault();e.stopPropagation();choose({kind:'edge',id:row.object_id})}};hit.onkeydown=host.onkeydown=keys;
    nodeText('small','business-code',businessCode(row),host);nodeText('p','relation-caption',summary,host);
    bindRelationSummary(hit,{record:row,summary});bindRelationSummary(host,{record:row,summary});
    const item={row,edge,hit,foreign,host,other:other.object_id};items.push(item);groups.get(other.object_id).items.push(item);
  }
  function paintSelection(){
    const selected=new Set(relationSelection(rows,entity.object_id,data.graphSelection)),ends=new Set();for(const item of items){const on=selected.has(item.row.object_id);if(on)for(const e of relationEndpointRefs(item.row,data))ends.add(e.object_id);item.edge.classList.toggle('selected',on);item.host.classList.toggle('selected',on);item.hit.setAttribute('aria-pressed',String(on));item.host.dataset.selected=String(on);const marker=`url(#${markerId+(on?'-selected':'')})`;item.edge.removeAttribute('marker-end');item.edge.removeAttribute('marker-start');if(item.row.payload.relation_type==='business'&&item.row.payload.direction!=='related')item.edge.setAttribute(item.row.payload.direction==='forward'?'marker-end':'marker-start',marker)}
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
    for(const group of groups.values()){const begin=y,nh=Math.max(72,group.node.host.scrollHeight);for(const item of group.items){const ch=Math.max(64,item.host.scrollHeight+8);item.y=y+ch/2;item.foreign.setAttribute('x',captionX);item.foreign.setAttribute('y',y);item.foreign.setAttribute('height',ch);y+=ch+28}const groupHeight=Math.max(nh,y-begin-28);group.y=begin+groupHeight/2;place(group.node,targetX,group.y-nh/2,nh);y=begin+groupHeight+42}
    height=Math.max(240,y);const cy=height/2,ch=Math.max(72,central.host.scrollHeight);place(central,30,cy-ch/2,ch);for(const group of groups.values())for(const item of group.items){const d=relationCurve([230,cy],[captionX,item.y],[captionX+captionWidth,item.y],[targetX,group.y],relationEndpointRefs(item.row,data)[0].object_id===entity.object_id);item.edge.setAttribute('d',d);item.hit.setAttribute('d',d)}
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
  if(!(data.relationships||[]).length)return;
  renderEntityRelationGraph(root,data);
}

// Deterministic force layout includes every component and isolated node. The
// saved positions belong to this exact management scope, never to entity data.
function managementGraphLayout(rows,edges){
  const sorted=[...rows].sort((a,b)=>businessCode(a).localeCompare(businessCode(b),undefined,{numeric:true})),n=sorted.length,cols=Math.max(2,Math.ceil(Math.sqrt(n)));
  const nodes=sorted.map((row,i)=>({id:row.object_id,row,x:(i%cols)*420,y:Math.floor(i/cols)*280})),by=new Map(nodes.map(v=>[v.id,v]));
  for(let step=0;step<90;step++){
    const force=nodes.map(()=>({x:0,y:0}));
    for(let i=0;i<n;i++)for(let j=i+1;j<n;j++){
      let dx=nodes[i].x-nodes[j].x,dy=nodes[i].y-nodes[j].y;if(!dx&&!dy)dx=1;
      const d=Math.max(30,Math.hypot(dx,dy)),k=Math.min(80,100000/d/d);force[i].x+=dx/d*k;force[i].y+=dy/d*k;force[j].x-=dx/d*k;force[j].y-=dy/d*k;
    }
    const index=new Map(nodes.map((v,i)=>[v.id,i]));
    for(const edge of edges){const a=by.get(edge.endpoints[0]),b=by.get(edge.endpoints[1]);if(!a||!b)continue;const dx=b.x-a.x,dy=b.y-a.y,d=Math.max(1,Math.hypot(dx,dy)),k=(d-650)*.012;force[index.get(a.id)].x+=dx/d*k;force[index.get(a.id)].y+=dy/d*k;force[index.get(b.id)].x-=dx/d*k;force[index.get(b.id)].y-=dy/d*k}
    nodes.forEach((v,i)=>{v.x+=Math.max(-60,Math.min(60,force[i].x));v.y+=Math.max(-60,Math.min(60,force[i].y))});
  }
  // Pack the relaxed centers into distinct cells. Unlike iterative collision
  // nudges, this guarantees separation even in the full, high-degree graph.
  const occupied=new Set();
  for(const node of nodes){const gx=Math.round(node.x/380),gy=Math.round(node.y/220);let selected=null;
    for(let ring=0;!selected;ring++)for(let dx=-ring;dx<=ring&&!selected;dx++)for(let dy=-ring;dy<=ring;dy++){
      if(Math.max(Math.abs(dx),Math.abs(dy))!==ring)continue;const key=(gx+dx)+','+(gy+dy);if(!occupied.has(key)){occupied.add(key);selected=[gx+dx,gy+dy];break}
    }
    node.x=selected[0]*380;node.y=selected[1]*220;
  }
  const minX=Math.min(0,...nodes.map(v=>v.x))-80,minY=Math.min(0,...nodes.map(v=>v.y))-80;for(const v of nodes){v.x-=minX;v.y-=minY}return nodes;
}
function renderManagementEntityGraph(root,rows,result,memory){
  if(!rows.length){nodeText('p','production-meta','此范围没有实体',root);return}
  const ids=new Set(rows.map(r=>r.object_id)),edges=(result.entity_graph?.edges||[]).filter(e=>e.endpoints.every(id=>ids.has(id)));
  const signature=rows.map(r=>r.object_id).sort().join('|');if(memory.signature!==signature){memory.nodes=managementGraphLayout(rows,edges);memory.signature=signature}
  const nodes=memory.nodes,by=new Map(nodes.map(n=>[n.id,n])),controls=el('div','relation-controls'),viewport=el('div','relation-graph-viewport management-graph-viewport'),canvas=el('div','relation-graph-canvas');
  root.append(controls,viewport);viewport.append(canvas);viewport.tabIndex=0;viewport.setAttribute('aria-label','实体关系图，可拖动和缩放');
  const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');svg.classList.add('relation-graph','management-relation-graph');svg.setAttribute('role','group');svg.setAttribute('aria-label','实体与关系');canvas.append(svg);
  const make=(tag,attrs={},parent=svg)=>{const node=document.createElementNS(ns,tag);for(const [k,v] of Object.entries(attrs))node.setAttribute(k,v);parent.append(node);return node};
  const marker='entity-map-arrow-'+(++relationGraphSerial),defs=make('defs'),arrow=make('marker',{id:marker,viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:6,markerHeight:6,orient:'auto-start-reverse'},defs);make('path',{d:'M0 0L10 5L0 10Z',fill:'#73917a'},arrow);
  const edgeLayer=make('g'),captionLayer=make('g'),edgeViews=[];let width=Math.max(800,...nodes.map(n=>n.x+360)),height=Math.max(450,...nodes.map(n=>n.y+220));
  const bins=new Map(),overlap=(a,b)=>a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y;
  const cells=box=>{const keys=[];for(let x=Math.floor(box.x/200);x<=Math.floor((box.x+box.w)/200);x++)for(let y=Math.floor(box.y/150);y<=Math.floor((box.y+box.h)/150);y++)keys.push(x+','+y);return keys};
  const reserve=box=>{for(const key of cells(box)){if(!bins.has(key))bins.set(key,[]);bins.get(key).push(box)}};
  const collides=box=>cells(box).some(key=>(bins.get(key)||[]).some(v=>overlap(box,v)));
  nodes.forEach(n=>reserve({x:n.x-12,y:n.y-12,w:304,h:164}));
  const boundary=(node,target)=>{const cx=node.x+140,cy=node.y+65,dx=target[0]-cx,dy=target[1]-cy,k=1/Math.max(Math.abs(dx)/145,Math.abs(dy)/70,1e-9);return [cx+dx*k,cy+dy*k]};
  for(const [index,edge] of edges.entries()){
    const a=by.get(edge.endpoints[0]),b=by.get(edge.endpoints[1]),start=boundary(a,[b.x+140,b.y+65]),end=boundary(b,[a.x+140,a.y+65]);
    const w=edge.derived?90:250,h=edge.derived?36:Math.max(58,Math.ceil(Array.from(edge.summary).length/16)*19+16),mx=(start[0]+end[0])/2-w/2,my=(start[1]+end[1])/2-h/2;
    let box={x:Math.max(8,mx),y:Math.max(8,my),w,h};for(let attempt=0;collides(box);attempt++){const ring=1+Math.floor(attempt/16),angle=(attempt%16)*Math.PI/8;box={x:Math.max(8,mx+Math.cos(angle)*ring*100),y:Math.max(8,my+Math.sin(angle)*ring*75),w,h};if(attempt>=1000)box={x:width+20,y:8,w,h}}
    reserve({...box,x:box.x-5,y:box.y-4,w:w+10,h:h+8});width=Math.max(width,box.x+w+60);height=Math.max(height,box.y+h+60);
    const cx=box.x+w/2,cy=box.y+h/2,path=make('path',{class:'relation-edge','data-edge-id':edge.id,d:`M${start.join(' ')} Q${cx} ${cy} ${cx} ${cy} T${end.join(' ')}`},edgeLayer);
    if(edge.derived)path.setAttribute('stroke-dasharray','5 4');
    if(['forward','reverse','mutual'].includes(edge.direction))path.setAttribute(edge.direction==='reverse'?'marker-start':'marker-end',`url(#${marker})`);if(edge.direction==='mutual')path.setAttribute('marker-start',`url(#${marker})`);
    const foreign=make('foreignObject',{x:box.x,y:box.y,width:w,height:h},captionLayer),label=el('button','relation-text management-edge-caption');label.textContent=edge.summary;label.setAttribute('aria-label',a.row.payload.title+' → '+b.row.payload.title+'：'+edge.summary);foreign.append(label);
    label.onclick=()=>{for(const v of edgeViews){const active=v.edge.id===edge.id;v.path.classList.toggle('selected',active);v.label.classList.toggle('selected',active)}for(const node of svg.querySelectorAll('[data-entity-id]'))node.classList.toggle('related-highlight',edge.endpoints.includes(node.dataset.entityId))};edgeViews.push({edge,path,label});
    label.onpointerenter=()=>{path.classList.add('selected');for(const n of svg.querySelectorAll('[data-entity-id]'))n.classList.toggle('related-highlight',edge.endpoints.includes(n.dataset.entityId))};
    label.onpointerleave=()=>{if(!label.classList.contains('selected'))path.classList.remove('selected')};
  }
  for(const node of nodes){const foreign=make('foreignObject',{x:node.x,y:node.y,width:280,height:145,'data-entity-id':node.id}),host=el('div','management-graph-node');foreign.append(host);const row=rows.find(r=>r.object_id===node.id);entitySmallCard(host,row,{stateCount:result.entity_state_counts?.[node.id]||0,materialCount:Object.values(result.entity_material_counts?.[node.id]||{}).reduce((a,b)=>a+b,0),preview:result.entity_previews?.[node.id]});}
  svg.setAttribute('viewBox',`0 0 ${width} ${height}`);
  let scale=memory.scale||1,ready=false;const status=nodeText('output','relation-scale','',controls);
  const remember=()=>{if(ready){memory.scale=scale;memory.left=viewport.scrollLeft;memory.top=viewport.scrollTop}};
  function resize(center){svg.style.width=width*scale+'px';svg.style.height=height*scale+'px';canvas.style.width=Math.max(viewport.clientWidth,width*scale)+'px';canvas.style.height=Math.max(viewport.clientHeight,height*scale)+'px';if(center){const pos=relationGraphPosition(center,viewport.clientWidth,viewport.clientHeight,scale);viewport.scrollLeft=pos.x;viewport.scrollTop=pos.y}status.textContent=Math.round(scale*100)+'%';remember()}
  const fit=()=>Math.min(1,(viewport.clientWidth-20)/width,(viewport.clientHeight-20)/height);
  const zoom=key=>{const center={x:(viewport.scrollLeft+viewport.clientWidth/2)/scale,y:(viewport.scrollTop+viewport.clientHeight/2)/scale};scale=key==='fit'?fit():key==='original'?1:Math.max(Math.min(.05,fit()),Math.min(2,scale*(key==='in'?1.25:.8)));resize(key==='fit'?{x:width/2,y:height/2}:center)};
  for(const [key,label] of [['out','缩小'],['in','放大'],['fit','适应全图'],['original','原始大小']])productionButton(controls,label,()=>zoom(key));
  viewport.onscroll=remember;let pan=null;
  viewport.onpointerdown=e=>{if(e.button!==0||e.target.closest('button,a,input'))return;pan={x:e.clientX,y:e.clientY,left:viewport.scrollLeft,top:viewport.scrollTop};viewport.setPointerCapture(e.pointerId)};
  viewport.onpointermove=e=>{if(pan){viewport.scrollLeft=pan.left+pan.x-e.clientX;viewport.scrollTop=pan.top+pan.y-e.clientY}};viewport.onpointerup=viewport.onpointercancel=()=>{pan=null};
  viewport.onkeydown=e=>{if(e.target!==viewport)return;const key={'+':'in','=':'in','-':'out','0':'original',f:'fit'}[e.key];if(key){e.preventDefault();zoom(key)}};
  requestAnimationFrame(()=>{if(!viewport.isConnected)return;resize();viewport.scrollLeft=memory.left??Math.max(0,(width*scale-viewport.clientWidth)/2);viewport.scrollTop=memory.top??Math.max(0,(height*scale-viewport.clientHeight)/2);ready=true;remember()});
}
