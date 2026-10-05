/* Direct relationships stay in context; labels are exact commentable text. */
let relationGraphSerial=0;
function relationGroups(data,rows){
  const primary=new Set(data.relationship_layout?.primary||[]),order=data.relationship_layout?.order||[];
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
    make('rect',{x:x-80,y:y-25,width:160,height:50,rx:4,class:'relation-node-box'+(central?' central':'')},null,g);
    const icon=productionEntityIcon(record.payload.entity_type);icon.setAttribute('x',x-70);icon.setAttribute('y',y-12);icon.setAttribute('width',24);icon.setAttribute('height',24);g.append(icon);
    make('text',{x:x+12,y:y+5,'text-anchor':'middle',class:'relation-node-name'},record.payload.title,g);make('title',{},record.payload.title,g);
    if(!central){g.dataset.reviewDialogTrigger='';g.setAttribute('role','button');g.setAttribute('tabindex','0');g.setAttribute('aria-label','打开实体：'+record.payload.title);g.dataset.relatedEntity=record.object_id;
      const open=()=>openUnifiedMaterial(reference||{object_id:record.object_id,revision_id:record.id},g);
      g.ondblclick=e=>{e.preventDefault();e.stopPropagation();open()};g.onkeydown=e=>{if(['Enter',' '].includes(e.key)){e.preventDefault();e.stopPropagation();open()}};
    }return g;
  }
  const layout=[];node(entity,95,42,true);
  for(const group of relationGroups(data,rows)){
    const title=make('text',{x:15,class:'relation-group-title'},group.main?'主要关系':'其他关系');layout.push({title});
    for(const row of group.rows){
      const other=row.payload.entities.find(r=>r.object_id!==entity.object_id),record=by.get(other.object_id);if(!record)continue;
      const path=make('path',{class:'relation-edge'+(group.main?' primary':''),'marker-end':`url(#${markerId})`});if(row.payload.direction==='mutual')path.setAttribute('marker-start',`url(#${markerId})`);
      const foreign=make('foreignObject',{x:65,width:215}),host=materialTextSurface(foreign,row);host.classList.add('relation-text');host.dataset.relationId=row.object_id;
      const caption=relationCaption(row),label=nodeText('span','relation-caption',caption.text,host);if(caption.block){label.dataset.blockId=caption.block.id;label.dataset.anchorOffset=caption.offset}
      entityVersionControl(host,row,r=>{data.localVersions||={};data.localVersions[r.object_id]=r});
      if(row.payload.basis==='production')nodeText('small','production-meta','制作选择',host);
      const scoped=row.payload.applies_to?.length;for(const source of scoped?row.payload.applies_to:row.payload.sources)materialReferenceLink(host,source,scoped?relationSceneLabel(source):'剧情依据',true);
      const endpoint=node(record,375,0,false,other);layout.push({row,path,foreign,host,endpoint});
    }
  }
  const measure=()=>{
    const width=Math.max(260,viewport.clientWidth||470),stacked=width<480;
    let y=91;
    for(const item of layout){
      if(item.title){item.title.setAttribute('y',y);y+=20;continue}
      item.foreign.setAttribute('x',stacked?50:65);item.foreign.setAttribute('width',stacked?width-65:width-255);
      const height=Math.max(70,item.host.scrollHeight+18),cy=stacked?y+height+35:y+height/2,nodeX=stacked?width/2:width-95;
      item.foreign.setAttribute('y',y);item.foreign.setAttribute('height',height);item.endpoint.setAttribute('transform',`translate(${nodeX-375} ${cy})`);
      const forward=item.row.payload.entities[0].object_id===entity.object_id,endX=nodeX-80;
      item.path.setAttribute('d',forward?`M35 67 V${cy} H${endX}`:`M${endX} ${cy} H35 V67`);
      y=stacked?cy+44:y+height+14;
    }
    svg.setAttribute('viewBox',`0 0 ${width} ${y+24}`);svg.style.height=(y+24)+'px';
  };
  measure();
  if(typeof ResizeObserver!=='undefined'){const observer=new ResizeObserver(()=>{if(!svg.isConnected){observer.disconnect();return}measure()});for(const item of layout)if(item.host)observer.observe(item.host);observer.observe(viewport)}
}

function relationSceneLabel(source){
  const ep=state.screenplays.flatMap(s=>s.episodes).find(e=>e.id===source.revision_id);
  return `${ep?.payload.number?reviewPositionLabel('episode',ep.payload.number)+' · ':''}${source.scene_id?reviewPositionLabel('scene',source.scene_id):'全文'}`;
}
