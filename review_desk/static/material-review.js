/* One review card for planned materials and exact, existing media. */
const isMaterialReview=()=>state.workspace==='materials.workspace'&&!!state.materialReview;
function materialRows(detail){
  const contexts=Object.values(detail.review_contexts||{current:detail.review_context}).filter(Boolean);
  return [detail.record,...detail.history,...contexts.flatMap(c=>[c.call,...c.requirements])].filter(Boolean);
}
function materialReviewComments(){const ids=new Set(materialRows(state.materialReview).map(r=>r.id));return state.comments.filter(c=>ids.has(c.target_revision_id))}
function materialCardModels(needs,items){
  const used=new Set(),cards=needs.map(need=>{
    const candidates=items.filter(item=>(item.record.payload.candidate_requirements||[]).some(ref=>ref.object_id===need.object_id&&ref.revision_id===need.id));
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
    productionRefLink(host,input,source?.payload.title||productionName(input));
    if(input.component_id)nodeText('small','production-meta',input.component_id+(input.range?` · ${input.range.start_seconds}–${input.range.end_seconds} 秒`:''),host);
  }
  if(!call.payload.inputs?.length)nodeText('p',null,'无参考输入',host);
  parent.append(box);
}
function renderGenerationRecipe(parent,need){
  const plan=need.payload.generation,box=el('section','material-plan');box.dataset.requirementId=need.object_id;
  nodeText('h3',null,need.id===need.current_revision?'当前生成方案':'历史生成方案',box);
  if(!plan){nodeText('p','production-issue','生成方案待完善',box);parent.append(box);return}
  if(need.id!==need.current_revision)nodeText('small','production-pill','历史方案',box);
  const host=reviewTextBlocks(box,need);
  materialField(host,need,'generation.output.description',null);
  materialField(host,need,'generation.model','模型');materialField(host,need,'generation.parameters','参数','pre');materialField(host,need,'generation.prompt','提示词','pre');
  nodeText('h4',null,'参考输入',host);
  for(const [index,input] of plan.inputs.entries()){
    productionRefLink(host,input.reference,(input.reference.object_id.startsWith('need-')?'待采用输出 · ':'准确素材 · ')+productionName(input.reference));
    materialField(host,need,`generation.inputs.${index}.use`,null);
    if(input.component_id)nodeText('small','production-meta',input.component_id+(input.range?` · ${input.range.start_seconds}–${input.range.end_seconds} 秒`:''),host);
  }
  if(!plan.inputs.length)nodeText('p',null,'文字生成，无参考文件',host);
  materialField(host,need,'generation.output.review_criteria','检查要点');
  if(plan.blockers?.length){const issues=el('div','entity-review-generation-issues');for(const text of plan.blockers)nodeText('p',null,text,issues);box.append(issues)}
  if(need.id===need.current_revision){
    const result=el('div','production-meta');productionButton(box,'检查生成输入',async()=>{
      const ready=await api('/api/production/generation-ready?requirement_id='+encodeURIComponent(need.object_id));if(!box.isConnected)return;result.replaceChildren();
      if(ready.ready){nodeText('p',null,'生成输入已齐备',result);const a=link('下载生成清单','/api/production/generation-package?requirement_id='+encodeURIComponent(need.object_id),result);a.download=need.object_id+'.json'}
      else for(const issue of ready.issues)nodeText('p',null,issue,result);
    });box.append(result);
  }
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
    if(item.record.id!==item.record.current_revision)nodeText('small','production-pill','历史素材',box);
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
  if(r.id===r.current_revision)productionButton(actions,'维护整体与细节关联',activate(()=>showProductionCoverage(root,r)));
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
