/* One review card for planned materials and exact, existing media. */
const isMaterialReview=()=>state.workspace==='materials.workspace'&&!!state.materialReview;
function materialRows(detail){
  const contexts=Object.values(detail.review_contexts||{current:detail.review_context}).filter(Boolean);
  return [detail.record,...detail.history,...(detail.candidate_records||[]),...Object.values(detail.material_versions||{}).flatMap(rounds=>rounds.flatMap(r=>r.members)),...contexts.flatMap(c=>[c.call,...c.requirements])].filter(Boolean);
}
function materialReviewComments(){const ids=new Set(materialRows(state.materialReview).map(r=>r.id));return state.comments.filter(c=>ids.has(c.target_revision_id))}
function materialCardModels(needs,items){
  const used=new Set(),cards=needs.map(need=>{
    // Browsing an older asset never changes its original card placement. This
    // is UI context only, not a new claim about the old asset's associations.
    const candidates=items.filter(item=>(item.placement_requirements||item.record.payload.candidate_requirements||[]).some(ref=>ref.object_id===need.object_id&&(item.placement_requirements||ref.revision_id===need.id)));
    candidates.forEach(item=>used.add(item.id));return {need,candidates};
  });
  for(const item of items)if(!used.has(item.id))cards.push({need:null,candidates:[item]});
  return cards.sort((a,b)=>{
    const type=c=>c.need?.payload.media_type||c.candidates[0].record.payload.media_type;
    const order=c=>c.need?.payload.slot==='overall'?0:c.need?.payload.slot==='voice'?1:2;
    return ['image','audio','video'].indexOf(type(a))-['image','audio','video'].indexOf(type(b))||order(a)-order(b);
  });
}
function materialField(parent,row,field,label,tag='p'){
  const block=productionTextBlocks(row).find(b=>b.field===field);if(!block)return;
  if(label)nodeText('h4',null,label,parent);const node=nodeText(tag,null,block.text,parent);node.dataset.blockId=block.id;
}
function materialTextSurface(parent,row){
  const host=reviewSurface(el('div','entity-review-text'));host.dataset.productionBlocks=row.id;
  if(state.productionSelected?.id===row.id)host.id='production-blocks';
  const focus=()=>focusProductionReview({record:row,history:[row],uses:[]});host.onpointerdown=focus;host.onfocusin=focus;parent.append(host);return host;
}
function renderActualGeneration(parent,context){
  const call=context?.call,box=el('section','material-actual-inputs');nodeText('h3',null,'本素材实际生成信息',box);
  if(!call){nodeText('p','production-meta','未登记实际生成信息',box);parent.append(box);return}
  const host=materialTextSurface(box,call);
  materialField(host,call,'call.model','模型');materialField(host,call,'call.parameters','参数','pre');materialField(host,call,'call.prompt','提示词','pre');
  nodeText('h4',null,'实际输入',host);
  for(const input of call.payload.inputs||[]){
    const source=context.inputs?.find(r=>r.id===input.revision_id);
    materialReferenceLink(host,input,source?.payload.title||productionName(input));
    if(input.component_id)nodeText('small','production-meta',input.component_id+(input.range?` · ${input.range.start_seconds}–${input.range.end_seconds} 秒`:''),host);
  }
  if(!call.payload.inputs?.length)nodeText('p',null,'无参考输入',host);
  parent.append(box);
}
function renderGenerationRecipe(parent,need){
  const plan=need.payload.generation,box=el('section','material-plan');box.dataset.requirementId=need.object_id;
  nodeText('h3',null,'生成方案',box);
  if(!plan){nodeText('p','production-issue','生成方案待完善',box);parent.append(box);return}
  const host=reviewTextBlocks(box,need);
  materialField(host,need,'generation.output.description',null);
  materialField(host,need,'generation.model','模型');materialField(host,need,'generation.parameters','参数','pre');materialField(host,need,'generation.prompt','提示词','pre');
  nodeText('h4',null,'参考输入',host);
  for(const [index,input] of plan.inputs.entries()){
    materialReferenceLink(host,{...input.reference,component_id:input.component_id,range:input.range,crop:input.crop},productionName(input.reference));
    materialField(host,need,`generation.inputs.${index}.use`,null);
    if(input.component_id)nodeText('small','production-meta',input.component_id+(input.range?` · ${input.range.start_seconds}–${input.range.end_seconds} 秒`:''),host);
  }
  if(!plan.inputs.length)nodeText('p',null,'文字生成，无参考文件',host);
  materialField(host,need,'generation.output.review_criteria','检查要点');
  parent.append(box);
}
function materialMedia(parent,item){
  const {record,component}=item,pane=el('div','entity-review-media-pane');pane.dataset.reviewRevision=record.id;
  const focus=()=>focusProductionReview({record,history:[record],uses:[]});pane.addEventListener('pointerdown',focus,true);pane.addEventListener('focusin',focus,true);
  if(component.mime.startsWith('image/')){
    pane.append(renderStructureVisual({...component,title:item.label||record.payload.title,alt:item.label||record.payload.title,description:`${component.width} × ${component.height}`},true));
    const stage=pane.querySelector('.structure-visual-stage');
    if(component.width&&component.height)stage.style.maxWidth=(420*component.width/component.height)+'px';
    if(item.crop)stage.dataset.reviewCrop=JSON.stringify(item.crop);
  }else if(/^(audio|video)\//.test(component.mime))reviewMediaPlayer(pane,component,record,item);
  else nodeText('p','production-meta',component.id+' · '+component.mime,pane);
  link('下载原文件','/api/production/files/'+encodeURIComponent(component.file),pane);parent.append(pane);
}
function renderMaterialCard(parent,model,options={}){
  const box=el('article','material-card'),need=model.need,items=model.candidates;
  box.dataset.materialKey=need?.object_id||items[0].record.object_id;
  const heading=el('div','entity-review-local-heading');nodeText('h3',null,need?.payload.generation?.output.name||need?.payload.title||items[0].record.payload.title,heading);
  if(need&&options.planVersion)options.planVersion(heading,need);box.append(heading);
  if(!items.length)renderMaterialPlaceholder(box,need);
  for(const item of items){
    const h=el('div','entity-review-local-heading');if(need||items.length>1)nodeText('h4',null,item.record.payload.title,h);
    options.assetVersion?.(h,item);box.append(h);
    if(item.components?.length>1){
      const select=el('select');select.setAttribute('aria-label','原件与预览组成');
      for(const c of item.components)select.append(new Option(`${c.role} · ${c.id}`,c.id));select.value=item.component.id;
      if(options.selectComponent)select.id='production-component';select.onchange=()=>{options.selectComponent?.(select.value)};box.append(select);
    }
    materialMedia(box,item);renderActualGeneration(box,item.review_context);
  }
  if(need)renderGenerationRecipe(box,need);
  for(const related of options.relatedPlans||[]){nodeText("h3",null,related.payload.generation?.output.name||related.payload.title,box);renderGenerationRecipe(box,related)}
  parent.append(box);return box;
}
function renderMaterialWorkspace(root,detail){
  if(detail.record.kind==='REQUIREMENT')return renderMaterialDemand(root,detail);
  const r=detail.record,component=r.payload.components.find(c=>c.id===detail.componentId)||r.payload.components.find(c=>c.role==='original')||r.payload.components[0];
  renderMaterialCard(root,{need:null,candidates:[{record:r,component,components:r.payload.components,review_context:detail.review_context}]},{
    relatedPlans:[...(detail.review_context?.requirements||[]).map(r=>detail.localPlans?.[r.object_id]||r),...Object.values(detail.localPlans||{}).filter(r=>!(detail.review_context?.requirements||[]).some(p=>p.object_id===r.object_id))],
    assetVersion:(parent,item)=>{if(detail.history.length<2)return;const select=el('select','entity-review-version');select.setAttribute('aria-label',r.payload.title+'的版本');for(const v of detail.history)select.append(new Option(`版本 ${v.version}${v.id===v.current_revision?' · 当前':''}`,v.id));select.value=r.id;select.onchange=()=>openProductionRecord(r.object_id,select.value);parent.append(select)},
    selectComponent:id=>{detail.componentId=id;renderProductionReader()}
  });
  if(r.payload.blocks?.length)reviewTextBlocks(root,r);
  const uses=el('section');nodeText('h3',null,'关联用途',uses);
  for(const item of r.payload.state_coverage||[]){productionRefLink(uses,item.state);nodeText('p',null,item.detail,uses)}
  root.append(uses);
  const actions=el('div','production-toolbar');
  const activate=fn=>()=>{focusProductionReview(detail);return fn()};
  if(detail.history.length>1)productionButton(actions,'并排比较版本',activate(()=>showProductionCompare(root)));
  productionButton(actions,'记录本版本审阅结论',activate(()=>showProductionJudgment(root)));
  root.append(actions);
}
function locateMaterialComment(comment){
  const detail=state.materialReview,row=materialRows(detail).find(r=>r.id===comment.target_revision_id);if(!row)return;
  if(row.kind==='ASSET'&&row.id!==detail.record.id){openProductionRecord(row.object_id,row.id).then(()=>locateMaterialComment(comment));return}
  if(row.kind==='CALL'&&row.id!==detail.review_context?.call?.id){
    const asset=detail.history.find(r=>r.payload.production?.revision_id===row.id);
    if(asset){openProductionRecord(asset.object_id,asset.id).then(()=>locateMaterialComment(comment));return}
  }
  if(row.kind==='ASSET'&&(comment.anchor.component_id||comment.anchor.visual_id))detail.componentId=comment.anchor.component_id||comment.anchor.visual_id;
  if(row.kind==='REQUIREMENT'){detail.localPlans||={};detail.localPlans[row.object_id]=row}
  focusProductionReview({record:row,history:[row],uses:[]},false);state.selected=comment.id;renderProductionReader();locateProductionComment(comment,true);
}

// Preview exact references without changing the reader, selection, or draft.
let materialReferenceCount=0;
function materialReferenceRequest(ref,source=false){
  // Story revisions share exact references with production records, but have a
  // separate reader that validates the cited scene and limits the text blocks.
  const isSource=!!(source||ref.scene_id||ref.block_ids?.length||!(state.productionRecords||[]).some(r=>r.object_id===ref.object_id));
  const query=new URLSearchParams({object_id:ref.object_id,revision_id:ref.revision_id});
  if(isSource){if(ref.scene_id)query.set('scene_id',ref.scene_id);if(ref.block_ids?.length)query.set('block_ids',ref.block_ids.join(','))}
  return {isSource,url:'/api/production'+(isSource?'/source':'')+'?'+query};
}
function materialReferenceLink(parent,ref,title,source=false){
  const button=productionButton(parent,title,()=>openMaterialReference(ref,button,source));
  button.classList.add('material-reference');button.setAttribute('aria-haspopup','dialog');button.addEventListener('pointerdown',e=>e.stopPropagation());button.addEventListener('focusin',e=>e.stopPropagation());return button;
}
async function openMaterialReference(ref,trigger,source=false){
  const request=materialReferenceRequest(ref,source);
  const {dialog,title,body}=openReviewDialog(request.isSource?'剧情依据':'参考输入',trigger,'material-reference-dialog');
  nodeText('p',null,'读取中…',body);
  try{
    const detail=await api(request.url);
    if(!dialog.isConnected)return;
    if(request.isSource){
      body.replaceChildren();body.dataset.referenceRevision=detail.reference.revision_id;
      const version=detail.screenplay?.title?.match(/^(?:剧本|版本)\s*([一二三四五六七八九十百零〇\d]+)/u);
      title.textContent='剧情依据 · '+(version?'版本'+version[1]+' · ':'')+detail.title;
      body.dataset.referenceScene=detail.scene?.id||'';
      if(detail.scene)nodeText('h3',null,detail.scene.heading,body);
      for(const block of detail.blocks)nodeText('p','reference-text',block.text,body);
      return;
    }
    const row=detail.record,p=row.payload;body.replaceChildren();title.textContent=p.title+' · 版本 '+row.version;body.dataset.referenceRevision=row.id;
    if(row.kind==='ASSET'){
      const components=ref.component_id?p.components.filter(c=>c.id===ref.component_id):p.components.filter(c=>c.role==='original');
      if(!components.length)throw new Error('引用的文件组成不存在');
      for(const c of components){
        const url='/api/production/files/'+encodeURIComponent(c.file);
        if(c.mime.startsWith('image/')){const img=el('img');img.src=url;img.alt=p.title;img.tabIndex=0;img.setAttribute('role','button');img.setAttribute('aria-label','放大查看：'+p.title);img.setAttribute('aria-haspopup','dialog');const show=()=>openStructureImage({...c,title:p.title,alt:p.title},img);img.onclick=show;img.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();show()}};if(ref.crop){const frame=el('div','reference-crop-frame'),region=el('div','reference-crop');frame.append(img,region);const c=ref.crop;Object.assign(region.style,{left:c.x*100+'%',top:c.y*100+'%',width:c.width*100+'%',height:c.height*100+'%'});region.setAttribute('aria-label','参考裁切范围');body.append(frame)}else body.append(img)}
        else if(/^(audio|video)\//.test(c.mime)){
          const media=el(c.mime.startsWith('audio/')?'audio':'video');media.controls=true;media.src=url;body.append(media);
          if(ref.range){const {start_seconds:start,end_seconds:end}=ref.range;media.addEventListener('loadedmetadata',()=>{media.currentTime=start});media.addEventListener('timeupdate',()=>{if(media.currentTime>=end){media.pause();media.currentTime=start}});media.addEventListener('play',()=>{if(media.currentTime<start||media.currentTime>=end)media.currentTime=start});nodeText('p',null,`参考片段：${start}–${end} 秒`,body)}
        }
        link('下载原文件',url,body);
      }

    }
    for(const b of (p.blocks||[]).filter(b=>!ref.block_ids?.length||ref.block_ids.includes(b.id)))nodeText('p','reference-text',b.text,body);
    if(p.generation){for(const [label,value] of [['模型',p.generation.model],['参数',JSON.stringify(p.generation.parameters,null,2)],['提示词',p.generation.prompt]]){nodeText('h3',null,label,body);nodeText('pre',null,value,body)}for(const input of p.generation.inputs||[])materialReferenceLink(body,{...input.reference,component_id:input.component_id,range:input.range,crop:input.crop},productionName(input.reference))}
  }catch(error){if(dialog.isConnected){body.replaceChildren();nodeText('p','error',error.message,body)}}
}

// A demand is a real REQUIREMENT, never a fabricated ASSET. Round data comes
// from the shared material version contract when available.
function renderMaterialDemand(root,detail){
  const r=detail.record,[mid,rounds]=Object.entries(detail.material_versions||{})[0]||[];
  const selected=detail.selectedMaterialRounds?.[mid]||Number(new URL(location.href).searchParams.get('material_round'));
  const round=rounds?.find(v=>v.number===selected)||(detail.explicitRevision?rounds?.find(v=>v.members.some(m=>m.id===r.id)):null)||rounds?.[0];
  const need=round?.plan||r;
  const results=round?.results||(detail.candidate_records||[]).filter(a=>a.payload.candidate_requirements?.some(ref=>ref.revision_id===r.id));
  const candidates=results.filter(a=>!a.payload.placeholder).map(record=>({record,component:record.payload.components.find(c=>c.id===detail.componentId)||record.payload.components.find(c=>c.role==='original')||record.payload.components[0],components:record.payload.components,review_context:detail.review_contexts?.[record.id]})).filter(i=>i.component);
  renderMaterialCard(root,{need,candidates,round,rounds,material_id:mid},{
    roundChange:number=>{detail.selectedMaterialRounds||={};detail.selectedMaterialRounds[mid]=number;const url=new URL(location.href);url.searchParams.set('material_round',number);history.replaceState(null,'',url);renderProductionReader();renderComments()},
    planVersion:(parent,row)=>{if(rounds?.length||detail.history.length<2)return;const select=el('select','entity-review-version');select.setAttribute('aria-label',row.payload.title+'的版本');for(const v of detail.history)select.append(new Option(`版本 ${v.version}${v.id===v.current_revision?' · 当前':''}`,v.id));select.value=row.id;select.onchange=()=>openProductionRecord(row.object_id,select.value);parent.append(select)},
    selectComponent:id=>{detail.componentId=id;renderProductionReader()}
  });
  productionRefLink(root,need.payload.scope,'所属状态：'+productionName(need.payload.scope));
}
