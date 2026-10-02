/* A direct-neighbour graph. Relationship text uses the common exact reviewer. */
function renderEntityRelations(root,data){
  const section=el('section','entity-relations');section.setAttribute('aria-label','实体关系');nodeText('h3',null,'关系',section);root.append(section);
  const rows=(data.relationships||[]).map(r=>data.localVersions?.[r.object_id]||r);
  if(!rows.length){nodeText('p','production-meta','暂无已登记的直接关系',section);return}
  const entity=data.entity,by=new Map([entity,...(data.related_entities||[])].map(r=>[r.object_id,r]));
  const neighbours=new Map();
  for(const row of rows){const other=row.payload.entities.find(r=>r.object_id!==entity.object_id);if(!other)continue;if(!neighbours.has(other.object_id))neighbours.set(other.object_id,[]);neighbours.get(other.object_id).push(row)}
  const toolbar=el('div','relation-graph-tools'),viewport=el('div','relation-graph-viewport');section.append(toolbar,viewport);
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),height=Math.max(320,Math.ceil(neighbours.size/2)*112+100),width=1000;
  svg.setAttribute('aria-label',entity.payload.title+'的直接关系图');svg.setAttribute('role','group');svg.classList.add('relation-graph');svg.style.height=height+'px';viewport.append(svg);
  let zoom=1,offset=[0,0],drag=null;
  const paint=()=>svg.setAttribute('viewBox',`${offset[0]} ${offset[1]} ${width/zoom} ${height/zoom}`);
  productionButton(toolbar,'放大',()=>{zoom=Math.min(4,zoom*1.3);paint()});productionButton(toolbar,'缩小',()=>{zoom=Math.max(1,zoom/1.3);paint()});productionButton(toolbar,'重置',()=>{zoom=1;offset=[0,0];paint()});
  const make=(tag,attrs={},text=null)=>{const e=document.createElementNS(svg.namespaceURI,tag);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,String(v));if(text!==null)e.textContent=text;svg.append(e);return e};
  const defs=make('defs'),marker=document.createElementNS(svg.namespaceURI,'marker');for(const [k,v] of Object.entries({id:'entity-relation-arrow',viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:6,markerHeight:6,orient:'auto-start-reverse'}))marker.setAttribute(k,v);const arrow=document.createElementNS(svg.namespaceURI,'path');arrow.setAttribute('d','M0 0L10 5L0 10Z');arrow.setAttribute('fill','#73917a');marker.append(arrow);defs.append(marker);
  const details=el('section','relation-description');section.append(details);
  const drawDetails=row=>{
    data.selectedRelation=row.object_id;details.replaceChildren();const heading=el('div','entity-review-local-heading');nodeText('h4',null,row.payload.title,heading);entityVersionControl(heading,row,r=>{data.localVersions||={};data.localVersions[r.object_id]=r});details.append(heading);
    nodeText('small','production-pill',row.payload.basis==='script'?'剧本事实':'制作选择',details);
    reviewTextBlocks(details,row);
    if(row.payload.applies_to?.length){nodeText('h4',null,'适用集场',details);for(const source of row.payload.applies_to)productionRefLink(details,source,relationSceneLabel(source))}
    entitySources(details,row);paintProductionReview();
    for(const label of svg.querySelectorAll('[data-relation-id]'))label.classList.toggle('active',label.dataset.relationId===row.object_id);
  };
  const label=(row,x,y)=>{
    const g=make('g',{tabindex:0,role:'button','aria-label':row.payload.title,'data-relation-id':row.object_id,class:'relation-label'});
    const caption=row.payload.label+(row.payload.applies_to?.length?' · '+relationSceneLabel(row.payload.applies_to[0]):'');
    const lines=Array.from(caption).reduce((a,c,i)=>{if(i%14===0)a.push('');a[a.length-1]+=c;return a},[]);
    const rect=document.createElementNS(svg.namespaceURI,'rect');for(const [k,v] of Object.entries({x:x-108,y:y-17,width:216,height:lines.length*18+10,rx:4}))rect.setAttribute(k,v);g.append(rect);
    const text=document.createElementNS(svg.namespaceURI,'text');text.setAttribute('text-anchor','middle');lines.forEach((line,i)=>{const t=document.createElementNS(svg.namespaceURI,'tspan');t.setAttribute('x',x);t.setAttribute('y',y+i*18);t.textContent=line;text.append(t)});g.append(text);
    g.onclick=()=>drawDetails(row);g.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();drawDetails(row)}};
  };
  const node=(record,x,y,central=false)=>{
    const g=make('g',{class:'relation-node'+(central?' central':''),tabindex:0,role:central?'group':'link','aria-label':record.payload.title});
    const rect=document.createElementNS(svg.namespaceURI,'rect');for(const [k,v] of Object.entries({x:x-88,y:y-34,width:176,height:68,rx:7}))rect.setAttribute(k,v);g.append(rect);
    const icon=productionEntityIcon(record.payload.entity_type);icon.setAttribute('x',x-75);icon.setAttribute('y',y-12);icon.setAttribute('width',24);icon.setAttribute('height',24);g.append(icon);
    const name=Array.from(record.payload.title);for(let i=0;i<name.length;i+=8){const t=document.createElementNS(svg.namespaceURI,'text');t.setAttribute('x',x+10);t.setAttribute('y',y+(name.length>8?-4:5)+(i/8)*18);t.setAttribute('text-anchor','middle');t.textContent=name.slice(i,i+8).join('');g.append(t)}
    if(!central){const open=()=>openProductionRecord(record.object_id,null,true);g.onclick=open;g.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open()}}}
  };
  let i=0;
  for(const [oid,edges] of neighbours){
    const left=i%2===0,x=left?105:895,y=145+Math.floor(i/2)*112,centreY=48,record=by.get(oid);i++;
    if(!record)continue;
    for(const [index,row] of edges.entries()){
      const fromHere=row.payload.entities[0].object_id===entity.object_id,begin=[left?412:588,centreY],end=[left?193:807,y],a=fromHere?begin:end,b=fromHere?end:begin;
      const path=make('path',{d:fromHere?`M${begin[0]} ${begin[1]} H${left?420:580} V${y} H${end[0]}`:`M${end[0]} ${y} H${left?420:580} V${centreY} H${begin[0]}`,class:'relation-edge','marker-end':'url(#entity-relation-arrow)'});
      if(row.payload.direction==='mutual')path.setAttribute('marker-start','url(#entity-relation-arrow)');
      label(row,left?305:695,y-8+index*28);
    }
    node(record,x,y);
  }
  node(entity,500,48,true);
  svg.onpointerdown=e=>{if(e.button!==0||e.target.closest('.relation-node,.relation-label'))return;drag={x:e.clientX,y:e.clientY,offset:[...offset]};svg.setPointerCapture(e.pointerId)};
  svg.onpointermove=e=>{if(!drag)return;const rect=svg.getBoundingClientRect();offset=[drag.offset[0]-(e.clientX-drag.x)/rect.width*width/zoom,drag.offset[1]-(e.clientY-drag.y)/rect.height*height/zoom];paint()};svg.onpointerup=svg.onpointercancel=()=>{drag=null};
  paint();drawDetails(rows.find(r=>r.object_id===data.selectedRelation)||rows[0]);
}
function relationSceneLabel(source){
  const ep=state.screenplays.flatMap(s=>s.episodes).find(e=>e.id===source.revision_id);
  return `${ep?.payload.number?'第 '+ep.payload.number+' 集 · ':''}${source.scene_id||'全文'}`;
}
