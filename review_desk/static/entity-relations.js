/* Direct relationships stay in context; labels are exact commentable text. */
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
  const make=(tag,attrs={},text=null)=>{const e=document.createElementNS(ns,tag);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,v);if(text!==null)e.textContent=text;svg.append(e);return e};
  const defs=make('defs'),marker=document.createElementNS(ns,'marker');for(const [k,v] of Object.entries({id:'entity-relation-arrow',viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:6,markerHeight:6,orient:'auto-start-reverse'}))marker.setAttribute(k,v);const arrow=document.createElementNS(ns,'path');arrow.setAttribute('d','M0 0L10 5L0 10Z');arrow.setAttribute('fill','#73917a');marker.append(arrow);defs.append(marker);
  function node(record,x,y,central=false){
    make('rect',{x:x-83,y:y-25,width:166,height:50,rx:7,class:'relation-node-box'+(central?' central':'')});
    const icon=productionEntityIcon(record.payload.entity_type);icon.setAttribute('x',x-73);icon.setAttribute('y',y-12);icon.setAttribute('width',24);icon.setAttribute('height',24);svg.append(icon);
    make('text',{x:x+12,y:y+5,'text-anchor':'middle',class:'relation-node-name'},record.payload.title);
  }
  let y=88;
  for(const group of relationGroups(data,rows)){
    make('text',{x:24,y,class:'relation-group-title'},group.main?'主要关系':'其他关系');y+=26;
    for(let i=0;i<group.rows.length;i+=2){
      const pair=group.rows.slice(i,i+2),rowHeight=Math.max(86,...pair.map(r=>{
        const sources=r.payload.applies_to?.length?r.payload.applies_to:r.payload.sources;
        const versions=data.versions?.[r.object_id]?.length>1?28:0;
        return Math.ceil(Array.from(relationCaption(r).text).length/13)*22+sources.length*28+versions+24;
      }));
      pair.forEach((row,index)=>{
        const left=index===0,other=row.payload.entities.find(r=>r.object_id!==entity.object_id),record=by.get(other.object_id);if(!record)return;
        const x=left?105:895,cy=y+rowHeight/2,labelX=left?205:596;
        const start=left?470:530,end=left?190:810,fromHere=row.payload.entities[0].object_id===entity.object_id;
        const path=make('path',{d:fromHere?`M${start} 48 V${cy} H${end}`:`M${end} ${cy} H${start} V48`,class:'relation-edge'+(group.main?' primary':''),'marker-end':'url(#entity-relation-arrow)'});
        if(row.payload.direction==='mutual')path.setAttribute('marker-start','url(#entity-relation-arrow)');
        const foreign=make('foreignObject',{x:labelX,y,width:200,height:rowHeight});
        const host=materialTextSurface(foreign,row);host.classList.add('relation-text');host.dataset.relationId=row.object_id;
        const caption=relationCaption(row);
        const label=nodeText('span','relation-caption',caption.text,host);
        if(caption.block){label.dataset.blockId=caption.block.id;label.dataset.anchorOffset=caption.offset}
        entityVersionControl(host,row,r=>{data.localVersions||={};data.localVersions[r.object_id]=r});
        if(row.payload.basis==='production')nodeText('small','production-meta','制作选择',host);
        const scoped=row.payload.applies_to?.length;for(const source of scoped?row.payload.applies_to:row.payload.sources)materialReferenceLink(host,source,scoped?relationSceneLabel(source):'剧情依据',true);
        node(record,x,cy);
      });y+=rowHeight;
    }
    y+=22;
  }
  node(entity,500, 48,true);
  svg.setAttribute('viewBox',`0 0 1000 ${y}`);svg.style.height=y+'px';
}
function relationSceneLabel(source){
  const ep=state.screenplays.flatMap(s=>s.episodes).find(e=>e.id===source.revision_id);
  return `${ep?.payload.number?'第 '+ep.payload.number+' 集 · ':''}${source.scene_id||'全文'}`;
}
