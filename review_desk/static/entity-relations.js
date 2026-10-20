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
  const lifetime=reviewLifetime(viewport);let frame=requestAnimationFrame(layout);
  lifetime.onDispose(()=>cancelAnimationFrame(frame));
  if(typeof ResizeObserver!=='undefined'){const observer=new ResizeObserver(()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(layout)});lifetime.onDispose(()=>observer.disconnect());observer.observe(viewport);observer.observe(central.host);for(const item of items)observer.observe(item.host);for(const group of groups.values())observer.observe(group.node.host)}
}

function relationSceneLabel(source){
  const ep=state.screenplays.flatMap(s=>s.episodes).find(e=>e.id===source.revision_id);
  return `${ep?.payload.number?reviewPositionLabel('episode',ep)+' · ':''}${source.scene_id?reviewPositionLabel('scene',source.scene_id,source.object_id):'全文'}`;
}

function renderEntityRelations(root,data){
  if(!(data.relationships||[]).length)return;
  renderEntityRelationGraph(root,data);
}

// Only declared directions create ranks. SCCs keep cycles in one rank;
// weak components also include undirected edges and isolated entities.
function managementGraphLayout(rows,edges){
  const sorted=[...rows].sort((a,b)=>businessCode(a).localeCompare(businessCode(b),undefined,{numeric:true})),ids=new Set(sorted.map(r=>r.object_id));
  const valid=edges.filter(e=>!e.derived&&e.endpoints.length===2&&e.endpoints.every(id=>ids.has(id))),adj=new Map(sorted.map(r=>[r.object_id,[]])),weak=new Map(sorted.map(r=>[r.object_id,[]]));
  for(const edge of valid){let [a,b]=edge.endpoints;weak.get(a).push(b);weak.get(b).push(a);if(edge.direction==='reverse')[a,b]=[b,a];if(['forward','reverse','mutual'].includes(edge.direction))adj.get(a).push(b);if(edge.direction==='mutual')adj.get(b).push(a);}
  let serial=0;const indexes=new Map(),low=new Map(),stack=[],active=new Set(),scc=[],owner=new Map();
  function visit(id){indexes.set(id,serial);low.set(id,serial++);stack.push(id);active.add(id);for(const next of adj.get(id)){if(!indexes.has(next)){visit(next);low.set(id,Math.min(low.get(id),low.get(next)));}else if(active.has(next))low.set(id,Math.min(low.get(id),indexes.get(next)));}if(low.get(id)===indexes.get(id)){const group=[];let member;do{member=stack.pop();active.delete(member);owner.set(member,scc.length);group.push(member);}while(member!==id);scc.push(group);}}
  for(const row of sorted)if(!indexes.has(row.object_id))visit(row.object_id);
  const parents=scc.map(()=>new Set());for(const [id,targets] of adj)for(const next of targets)if(owner.get(id)!==owner.get(next))parents[owner.get(next)].add(owner.get(id));
  const ranks=new Map();function rank(group){if(!ranks.has(group))ranks.set(group,parents[group].size?1+Math.max(...[...parents[group]].map(rank)):0);return ranks.get(group);}
  const seen=new Set(),components=[],nodes=[];let top=40,component=0;
  for(const first of sorted){if(seen.has(first.object_id))continue;const members=[],pending=[first.object_id];seen.add(first.object_id);while(pending.length){const id=pending.shift();members.push(id);for(const next of weak.get(id))if(!seen.has(next)){seen.add(next);pending.push(next);}}
    components.push(members);
  }
  components.sort((a,b)=>b.length-a.length);
  const isolated=[];
  for(const members of components){
    if(members.length===1&&!weak.get(members[0]).length){isolated.push(sorted.find(r=>r.object_id===members[0]));continue;}
    const ordered=sorted.filter(row=>members.includes(row.object_id)),directed=members.some(id=>adj.get(id).length),levels=new Map();
    if(directed){for(const row of ordered){const level=rank(owner.get(row.object_id));if(!levels.has(level))levels.set(level,[]);levels.get(level).push(row);}}
    else {
      // Breadth from the strongest hub expresses adjacency, without inventing direction.
      const hub=[...ordered].sort((a,b)=>weak.get(b.object_id).length-weak.get(a.object_id).length||sorted.indexOf(a)-sorted.indexOf(b))[0];
      const depths=new Map([[hub.object_id,0]]),queue=[hub.object_id],order=[];
      while(queue.length){const id=queue.shift();order.push(id);for(const next of weak.get(id))if(!depths.has(next)){depths.set(next,depths.get(id)+1);queue.push(next);}}
      for(const id of order){const level=depths.get(id);if(!levels.has(level))levels.set(level,[]);levels.get(level).push(ordered.find(row=>row.object_id===id));}
    }
    const count=Math.max(...[...levels.values()].map(group=>group.length));
    for(const [level,group] of levels)group.forEach((row,i)=>nodes.push({id:row.object_id,row,x:40+level*490,y:top+(i+(count-group.length)/2)*180,w:230,h:120,component,rank:directed?level:null}));
    top+=count*180+30;component++;
  }
  const columns=Math.max(3,...nodes.map(n=>Math.round((n.x-40)/490)+1));
  isolated.forEach((row,i)=>nodes.push({id:row.object_id,row,x:40+(i%columns)*280,y:top+Math.floor(i/columns)*160,w:230,h:120,component:component+i,rank:null}));
  // Pack smaller connected groups and valid isolated cards into a compact shelf.
  const main=nodes.filter(n=>n.component===0),limit=Math.max(1200,...main.map(n=>n.x+n.w));
  let shelfX=40,shelfY=Math.max(40,...main.map(n=>n.y+n.h))+60,shelfHeight=0;
  for(const c of [...new Set(nodes.map(n=>n.component))].filter(c=>c!==0)){
    const group=nodes.filter(n=>n.component===c),left=Math.min(...group.map(n=>n.x)),top=Math.min(...group.map(n=>n.y)),w=Math.max(...group.map(n=>n.x+n.w))-left,h=Math.max(...group.map(n=>n.y+n.h))-top;
    if(shelfX+w>limit){shelfX=40;shelfY+=shelfHeight+50;shelfHeight=0;}
    for(const n of group){n.x+=shelfX-left;n.y+=shelfY-top;}shelfX+=w+60;shelfHeight=Math.max(shelfHeight,h);
  }
  return nodes;
}
function managementOverlap(a,b){return a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y;}
// One bounded worker keeps layout off the UI thread. Only successful complete
// geometry is cached; failures release the worker and can be retried normally.
let managementGraphWorker=null,managementGraphRequest=0;
const managementGraphPending=new Map(),managementGraphCache=new Map();
const managementGraphFlights=new Map();
function managementGraphWorkerFailure(error){
  managementGraphWorker?.terminate();managementGraphWorker=null;
  for(const item of managementGraphPending.values()){clearTimeout(item.timer);item.reject(error);}
  managementGraphPending.clear();
}
async function managementEdgeGeometry(nodes,edges,signal){
  if(signal?.aborted)throw new DOMException('关系图读取已取消','AbortError');
  const input=nodes.map(({id,w,h,component,rank})=>({id,w,h,component,rank})),key=JSON.stringify([input,edges]);
  let raw=managementGraphCache.get(key);
  if(!raw){
    if(!managementGraphWorker){
      managementGraphWorker=new Worker(reviewURL('/entity-graph-worker.js'));
      managementGraphWorker.onmessage=({data})=>{
        const item=managementGraphPending.get(data.id);if(!item)return;
        clearTimeout(item.timer);managementGraphPending.delete(data.id);
        if(data.error)item.reject(new Error(data.error));else item.resolve(data.geometry);
      };
      managementGraphWorker.onerror=()=>managementGraphWorkerFailure(new Error('关系图计算程序未能运行，请重试'));
    }
    let flight=managementGraphFlights.get(key);
    if(!flight){flight={clients:0};flight.promise=new Promise((resolve,reject)=>{
      const id=++managementGraphRequest,timer=setTimeout(()=>managementGraphWorkerFailure(new Error('关系图计算超时，请重试')),5000);
      flight.id=id;flight.reject=reject;managementGraphPending.set(id,{resolve,reject,timer});managementGraphWorker.postMessage({id,nodes:input,edges});
    }).finally(()=>{if(managementGraphFlights.get(key)===flight)managementGraphFlights.delete(key)});managementGraphFlights.set(key,flight)}
    flight.clients++;
    try{raw=await reviewWait(flight.promise,signal)}finally{
      flight.clients--;
      if(!flight.clients&&managementGraphPending.has(flight.id)){const item=managementGraphPending.get(flight.id);clearTimeout(item.timer);managementGraphPending.delete(flight.id);flight.reject(new DOMException('关系图读取已取消','AbortError'));if(!managementGraphPending.size){managementGraphWorker?.terminate();managementGraphWorker=null}}
    }
    if(!Number.isFinite(raw.width)||!Number.isFinite(raw.height)||raw.width<=0||raw.height<=0)throw new Error('实体关系图边界无效');
    if(raw.nodes.length!==nodes.length||raw.views.length!==edges.length||new Set(raw.nodes.map(n=>n.id)).size!==nodes.length||new Set(raw.views.map(v=>v.edge.id)).size!==edges.length)throw new Error('实体关系图未返回完整集合');
    if(raw.nodes.some((n,i)=>n.id!==nodes[i].id||![n.x,n.y,n.w,n.h].every(Number.isFinite)))throw new Error('实体关系节点不一致');
    for(const [i,view] of raw.views.entries())if(JSON.stringify(view.edge)!==JSON.stringify(edges[i])||!view.path||!view.curves?.length||view.curves.some(c=>c.length<4||(c.length-1)%3||c.some(p=>p.length!==2||!p.every(Number.isFinite))))throw new Error('实体关系连线不完整');
    managementGraphCache.set(key,raw);while(managementGraphCache.size>24)managementGraphCache.delete(managementGraphCache.keys().next().value);
  }
  const by=new Map(nodes.map(n=>[n.id,n])),placed=raw.nodes.map(n=>({...n,row:by.get(n.id)?.row})),newBy=new Map(placed.map(n=>[n.id,n]));
  if(placed.some(n=>!n.row))throw new Error('实体关系节点不一致');
  return {...raw,nodes:placed,views:raw.views.map(v=>({...v,a:newBy.get(v.a.id),b:newBy.get(v.b.id)}))};
}
function renderManagementEntityGraph(root,rows,result,memory){
  if(!rows.length){nodeText('p','production-meta','此范围没有实体',root);return}
  const ids=new Set(rows.map(r=>r.object_id)),edges=(result.entity_graph?.edges||[]).filter(e=>!e.derived&&e.endpoints.every(id=>ids.has(id)));
  const signature=JSON.stringify([rows.map(r=>[r.object_id,r.id]),edges]);if(memory.signature!==signature){memory.nodes=managementGraphLayout(rows,edges);memory.signature=signature;memory.selection=null;memory.scale=null;memory.mode='fit';memory.left=0;memory.top=0;}
  const nodes=memory.nodes,by=new Map(nodes.map(n=>[n.id,n])),controls=el('div','relation-controls'),viewport=el('div','relation-graph-viewport management-graph-viewport'),canvas=el('div','relation-graph-canvas');
  root.append(controls,viewport);viewport.append(canvas);viewport.tabIndex=0;viewport.setAttribute('aria-label','实体关系图，可拖动和缩放');
  const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');svg.classList.add('relation-graph','management-relation-graph');svg.style.visibility='hidden';svg.setAttribute('role','group');svg.setAttribute('aria-label','实体与关系');canvas.append(svg);
  const make=(tag,attrs={},parent=svg)=>{const node=document.createElementNS(ns,tag);for(const [k,v] of Object.entries(attrs))node.setAttribute(k,v);parent.append(node);return node};
  const marker='entity-map-arrow-'+(++relationGraphSerial),defs=make('defs'),arrow=make('marker',{id:marker,viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:6,markerHeight:6,orient:'auto-start-reverse'},defs);make('path',{d:'M0 0L10 5L0 10Z',fill:'#73917a'},arrow);
  const edgeLayer=make('g'),captionLayer=make('g'),edgeViews=[];let width=Math.max(800,...nodes.map(n=>n.x+360)),height=Math.max(450,...nodes.map(n=>n.y+220));
  const nodeHosts=[];let moved=false,pan=null,opening=false;
  const lifetime=reviewLifetime(viewport);let geometryKey=null;
  function choose(selection){memory.selection=selection;paintSelection();}
  function paintSelection(){
    const selection=memory.selection,selected=managementGraphSelection(edges,selection),ends=new Set(selection?.kind==='node'?[selection.id]:[]);
    for(const edge of edges)if(selected.has(edge.id))for(const id of edge.endpoints)ends.add(id);
    for(const {node,foreign,button} of nodeHosts){foreign.classList.toggle('graph-muted',!!selection&&!ends.has(node.id));foreign.classList.toggle('related-highlight',ends.has(node.id));foreign.classList.toggle('graph-center',selection?.kind==='node'&&selection.id===node.id);button.setAttribute('aria-pressed',String(selection?.kind==='node'&&selection.id===node.id));}
    for(const v of edgeViews){const on=selected.has(v.edge.id);v.path.classList.toggle('selected',on);v.label.classList.toggle('selected',on);v.path.classList.toggle('graph-muted',!!selection&&!on);v.foreign.classList.toggle('graph-muted',!!selection&&!on);}
  }
  for(const node of nodes){const foreign=make('foreignObject',{x:node.x,y:node.y,width:node.w,height:node.h,'data-entity-id':node.id}),host=el('div','management-graph-node');foreign.append(host);const button=entitySmallCard(host,node.row,{stateCount:result.entity_state_counts?.[node.id]||0,materialCount:Object.values(result.entity_material_counts?.[node.id]||{}).reduce((a,b)=>a+b,0),preview:result.entity_previews?.[node.id],references:[{object_id:node.id,revision_id:node.row.id}]});button.setAttribute('aria-keyshortcuts','Space Enter');
    button.onclick=e=>{e.stopPropagation();if(!moved&&e.detail<2)choose(memory.selection?.kind==='node'&&memory.selection.id===node.id?null:{kind:'node',id:node.id});};
    const open=()=>{if(moved||opening)return;choose({kind:'node',id:node.id});opening=true;Promise.resolve(openUnifiedMaterial({object_id:node.id,revision_id:node.row.id},button)).finally(()=>{opening=false;});};
    button.ondblclick=e=>{e.preventDefault();e.stopPropagation();open();};
    button.onkeydown=e=>{if(e.isComposing||e.repeat)return;if(e.key===' '){e.preventDefault();e.stopPropagation();choose(memory.selection?.kind==='node'&&memory.selection.id===node.id?null:{kind:'node',id:node.id});}else if(e.key==='Enter'){e.preventDefault();e.stopPropagation();moved=false;open();}};
    nodeHosts.push({node,foreign,host,button});}

  async function drawEdges(token){
    // Calculate and build the complete replacement offscreen before changing
    // the visible graph, including card bounds and viewBox. One failed route
    // must not erase a complete drawing or leave a partially committed layer.
    const measured=nodeHosts.map(({node,host})=>({...node,h:Math.max(110,host.scrollHeight)}));
    const key=JSON.stringify(measured.map(({id,w,h,component,rank})=>[id,w,h,component,rank]));
    if(key===geometryKey)return true;
    const geometry=await managementEdgeGeometry(measured,edges,lifetime.signal);if(token!==layoutSerial||!viewport.isConnected)return false;const nextEdges=document.createElementNS(ns,'g'),nextCaptions=document.createElementNS(ns,'g'),nextViews=[];
    for(const view of geometry.views){const {edge,a,b,label:box}=view,path=make('path',{class:'relation-edge','data-edge-id':edge.id,d:view.path},nextEdges);
      if(['forward','reverse','mutual'].includes(edge.direction))path.setAttribute('marker-end',`url(#${marker})`);if(edge.direction==='mutual')path.setAttribute('marker-start',`url(#${marker})`);
      const foreign=make('foreignObject',{x:box.x,y:box.y,width:box.w,height:box.h,'data-relation-id':edge.id},nextCaptions),label=el('button','relation-text management-edge-caption');label.textContent=edge.summary;label.setAttribute('aria-label',a.row.payload.title+(edge.direction==='related'?' — ':' → ')+b.row.payload.title+'：'+edge.summary);foreign.append(label);
      label.onclick=e=>{e.stopPropagation();if(!moved)choose({kind:'edge',id:edge.id});};nextViews.push({edge,path,label,foreign});
    }
    for(const [i,{node,foreign}] of nodeHosts.entries()){Object.assign(node,geometry.nodes[i]);foreign.setAttribute('x',node.x);foreign.setAttribute('y',node.y);foreign.setAttribute('height',node.h);}
    edgeLayer.replaceChildren(...nextEdges.childNodes);captionLayer.replaceChildren(...nextCaptions.childNodes);edgeViews.splice(0,edgeViews.length,...nextViews);width=geometry.width;height=geometry.height;
    svg.setAttribute('viewBox',`0 0 ${width} ${height}`);svg.style.visibility='visible';geometryKey=key;paintSelection();return true;
  }
  svg.setAttribute('viewBox',`0 0 ${width} ${height}`);
  let scale=memory.scale||1,ready=false;const status=nodeText('output','relation-scale','',controls);
  const remember=()=>{if(ready){memory.scale=scale;memory.left=viewport.scrollLeft;memory.top=viewport.scrollTop}};
  function resize(center){svg.style.width=width*scale+'px';svg.style.height=height*scale+'px';canvas.style.width=Math.max(viewport.clientWidth,width*scale)+'px';canvas.style.height=Math.max(viewport.clientHeight,height*scale)+'px';if(center){const pos=relationGraphPosition(center,viewport.clientWidth,viewport.clientHeight,scale);viewport.scrollLeft=pos.x;viewport.scrollTop=pos.y}status.textContent=Math.round(scale*100)+'%';remember()}
  const fit=()=>Math.min(1,(viewport.clientWidth-20)/width,(viewport.clientHeight-20)/height);
  const zoom=key=>{memory.mode=key==='fit'?'fit':key==='original'?'original':'custom';const center={x:(viewport.scrollLeft+viewport.clientWidth/2)/scale,y:(viewport.scrollTop+viewport.clientHeight/2)/scale};scale=key==='fit'?fit():key==='original'?1:Math.max(Math.min(.05,fit()),Math.min(2,scale*(key==='in'?1.25:.8)));resize(key==='fit'?{x:width/2,y:height/2}:center)};
  for(const [key,label] of [['out','缩小'],['in','放大'],['fit','适应全图'],['original','原始大小']])productionButton(controls,label,()=>zoom(key));
  viewport.onscroll=remember;
  viewport.onpointerdown=e=>{moved=false;if(e.button!==0||e.target.closest('a,input,textarea,select,.management-edge-caption'))return;pan={x:e.clientX,y:e.clientY,left:viewport.scrollLeft,top:viewport.scrollTop};};
  viewport.onpointermove=e=>{if(!pan)return;if(Math.hypot(pan.x-e.clientX,pan.y-e.clientY)>5){moved=true;viewport.setPointerCapture(e.pointerId);}if(moved){viewport.scrollLeft=pan.left+pan.x-e.clientX;viewport.scrollTop=pan.top+pan.y-e.clientY;}};
  viewport.onpointerup=()=>{pan=null;};viewport.onpointercancel=()=>{moved=true;pan=null;};
  viewport.onclick=e=>{if(!moved&&!e.target.closest('[data-entity-id],[data-relation-id]'))choose(null);};
  viewport.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();choose(null);return;}if(e.target!==viewport)return;const key={'+':'in','=':'in','-':'out','0':'original',f:'fit'}[e.key];if(key){e.preventDefault();zoom(key);}};
  const issue=el('div','production-issue');issue.hidden=true;issue.setAttribute('role','alert');root.append(issue);
  let layoutSerial=0;
  async function layout(){
    if(!viewport.isConnected)return;const token=++layoutSerial;
    try{if(!await drawEdges(token))return;const {left,top}=memory;issue.hidden=true;issue.replaceChildren();if(memory.mode==='fit'||!memory.scale)scale=fit();resize(memory.mode==='fit'?{x:width/2,y:height/2}:null);if(memory.mode!=='fit'){viewport.scrollLeft=left??0;viewport.scrollTop=top??0;}ready=true;remember();}
    catch(error){if(token!==layoutSerial||!viewport.isConnected)return;issue.hidden=false;issue.replaceChildren();nodeText('p',null,(ready?'关系图未能重新绘制，仍保留上一次完整结果。':'关系图绘制失败。')+error.message,issue);productionButton(issue,'重新绘制关系图',layout);}
  }
  let layoutFrame=requestAnimationFrame(layout);
  lifetime.onDispose(()=>{++layoutSerial;cancelAnimationFrame(layoutFrame)});
  if(typeof ResizeObserver!=='undefined'){const observer=new ResizeObserver(entries=>{
    if(!viewport.isConnected)return;
    if(ready&&entries.length&&entries.every(entry=>entry.target===viewport)){if(memory.mode==='fit')scale=fit();resize(memory.mode==='fit'?{x:width/2,y:height/2}:null);return}
    cancelAnimationFrame(layoutFrame);layoutFrame=requestAnimationFrame(layout);
  });lifetime.onDispose(()=>observer.disconnect());observer.observe(viewport);for(const {host} of nodeHosts)observer.observe(host);}
}
function managementGraphSelection(edges,selection){
  return new Set(!selection?[]:edges.filter(e=>selection.kind==='edge'?e.id===selection.id:e.endpoints.includes(selection.id)).map(e=>e.id));
}
