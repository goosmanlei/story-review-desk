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
function materialParameters(host,row,prefix,model){
  const heading=nodeText('h4',null,'参数 · ',host),block=productionTextBlocks(row).find(b=>b.field===prefix+'.model');
  const name=nodeText('span',null,model||'模型未知',heading);if(block)name.dataset.blockId=block.id;
  materialField(host,row,prefix+'.parameters',null,'pre');
}
function materialInputs(inputs,records=[]){
  const counts={};return inputs.flatMap((value,index)=>{
    const ref=value.reference||value,row=records.find(r=>r.id===ref.revision_id)||(state.productionRecords||[]).find(r=>r.id===ref.revision_id);
    // Only submitted media or explicit future media requirements are references.
    if(!row||!['ASSET','REQUIREMENT'].includes(row.kind))return [];
    const component=row.payload.components?.find(c=>c.id===value.component_id)||row.payload.components?.find(c=>c.role==='original');
    if(row.kind==='ASSET'&&(!value.component_id||!component||!(/^(image|audio|video)\//.test(component.mime))))return [];
    const type=component?.mime.split('/')[0]||row.payload.media_type,label={image:'图片',audio:'音频',video:'视频'}[type];if(!label)return [];
    counts[type]=(counts[type]||0)+1;return [{value,index,row,label:label+counts[type],ref:{...ref,...Object.fromEntries(['component_id','crop','range'].filter(k=>value[k]).map(k=>[k,value[k]]))}}];
  });
}
function renderMaterialInputs(host,inputs,records=[],need=null){
  const effective=materialInputs(inputs,records);if(!effective.length)return;
  nodeText('h4',null,'参考输入',host);
  for(const item of effective){
    const line=el('div','material-input');materialReferenceLink(line,item.ref,item.label+' · '+item.row.payload.title);
    const version=materialRecordRound(item.row)||item.row.version;nodeText('small','production-meta','版本 '+version+(item.value.component_id?' · '+item.value.component_id:'')+(item.value.range?` · ${item.value.range.start_seconds}–${item.value.range.end_seconds} 秒`:'')+(item.value.crop?' · 使用裁切区域':''),line);
    if(need)materialField(line,need,`generation.inputs.${item.index}.use`,null);else if(item.value.use)nodeText('p',null,item.value.use,line);
    host.append(line);
  }
}
function renderActualGeneration(parent,context){
  const call=context?.call,box=el('section','material-actual-inputs');nodeText('h3',null,'本素材实际生成信息',box);
  if(!call){nodeText('p','production-meta','未登记实际生成信息',box);parent.append(box);return}
  const host=materialTextSurface(box,call);
  materialParameters(host,call,'call',call.payload.model);
  renderMaterialInputs(host,call.payload.inputs||[],context.inputs||[]);
  materialField(host,call,'call.prompt','提示词','pre');parent.append(box);
}
function renderGenerationRecipe(parent,need){
  const plan=need.payload.generation,box=el('section','material-plan');box.dataset.requirementId=need.object_id;
  nodeText('h3',null,'生成方案',box);
  if(!plan){nodeText('p','production-issue','生成方案待完善',box);parent.append(box);return}
  const host=materialTextSurface(box,need);materialField(host,need,'generation.output.description',null);
  materialParameters(host,need,'generation',plan.model);
  renderMaterialInputs(host,plan.inputs||[],need.review_input_records||[],need);
  materialField(host,need,'generation.prompt','提示词','pre');materialField(host,need,'generation.output.review_criteria','检查要点');parent.append(box);
}
function materialVersions(){return (isEntityReview()?state.entityReview:state.materialReview)?.material_versions||{}}
function materialRecordRound(row){if(row.material_round_numbers&&Object.keys(row.material_round_numbers).length)return Object.values(row.material_round_numbers)[0];for(const rounds of Object.values(materialVersions()))for(const round of rounds)if(round.members.some(r=>r.id===row.id))return round.number;return null}
function materialResultKey(row){return JSON.stringify([row.payload.production?.object_id,row.payload.components.filter(c=>c.role==='original').map(c=>c.sha256)])}
function materialRoundResults(round,selected,explicit){return round.results.map(row=>explicit&&row.object_id===selected.object_id&&materialResultKey(row)===materialResultKey(selected)&&round.members.some(m=>m.id===selected.id)?selected:row)}
function materialCandidateChoice(items,targetId){
  return items.find(i=>i.record.id===targetId)||items.find(i=>i.review_context?.call?.id===targetId)||items[0]||null;
}
function materialExactCandidates(detail,items,targetId){
  const target=materialRows(detail).find(r=>r.kind==='ASSET'&&r.id===targetId);if(!target)return items;
  return items.map(item=>{
    if(item.record.object_id!==target.object_id||materialResultKey(item.record)!==materialResultKey(target))return item;
    return {...item,record:target,components:target.payload.components,component:target.payload.components.find(c=>c.id===item.component.id)||item.component,review_context:detail.review_contexts?.[target.id]||item.review_context};
  });
}
function materialCandidateOptions(detail,items){
  const targetId=detail.selectedCandidateId||new URL(location.href).searchParams.get('material_target');
  return {selectedCandidateId:targetId,selectCandidate:id=>{
    const item=items.find(i=>i.record.id===id);if(!item)return;
    detail.selectedCandidateId=id;focusProductionReview({record:item.record,history:[item.record],uses:[]},false);
    renderProductionReader();renderComments();document.querySelector('[aria-label="本轮候选"]')?.focus({preventScroll:true});
  }};
}
function materialRoundControl(parent,mid,rounds,selected,change){
  const select=el('select','entity-review-version');select.setAttribute('aria-label','素材版本');
  for(const round of rounds)select.append(new Option(`版本 ${round.number}${round===rounds[0]?' · 当前':''}`,round.number));select.value=selected.number;select.disabled=rounds.length<2;select.onchange=()=>change(Number(select.value));parent.append(select);
}
function switchMaterialRound(data,mid,number){
  const rounds=data.material_versions[mid],old=data.selectedMaterialRounds?.[mid]||rounds[0].number;
  data.roundDrafts||={};data.roundDrafts[mid+':'+old]={row:state.productionSelected,anchor:state.anchor,editing:state.editing,selected:state.selected,scope:state.reviewCommentScope};
  data.selectedMaterialRounds||={};data.selectedMaterialRounds[mid]=number;data.explicitRevision=false;delete data.selectedCandidateId;
  const round=rounds.find(r=>r.number===number),saved=data.roundDrafts[mid+':'+number];
  state.materialCommentCard={data,material_id:mid,number};
  const row=saved?.row&&round.members.some(r=>r.id===saved.row.id)?saved.row:round.results[0]||round.plan;
  state.anchor=null;state.editing=null;state.selected=null;state.reviewCommentScope=null;state.drawMode=null;
  if(row)focusProductionReview({record:row,history:[row],uses:[]},false);
  if(saved&&row===saved.row){state.anchor=saved.anchor;state.editing=saved.editing;state.selected=saved.selected;state.reviewCommentScope=saved.scope}
}
function focusMaterialRoundControl(mid){[...document.querySelectorAll('.material-card')].find(n=>n.dataset.materialKey===mid)?.querySelector('[aria-label="素材版本"]')?.focus({preventScroll:true})}
function materialRoundModels(needs,items,data){
  const used=new Set(),models=needs.map(current=>{
    const rounds=data.material_versions?.[current.object_id]||[],number=data.selectedMaterialRounds?.[current.object_id],round=rounds.find(r=>r.number===number)||rounds[0];
    if(!round){const model=materialCardModels([current],items).find(m=>m.need===current);model.candidates.forEach(i=>used.add(i.record.object_id));return model}
    data.selectedMaterialRounds||={};data.selectedMaterialRounds[current.object_id]=round.number;
    // Older results belong to this card's history, including when the current round has no result.
    for(const history of rounds)for(const row of history.members)if(row.kind==='ASSET')used.add(row.object_id);
    const candidates=round.results.map(row=>{const original=items.find(i=>i.record.object_id===row.object_id),component=row.payload.components.find(c=>c.role==='original')||row.payload.components[0];
      return {...original,record:row,component,review_context:data.materialContexts?.[row.id],range:original?.record.id===row.id?original.range:null,crop:original?.record.id===row.id?original.crop:null}});
    candidates.forEach(i=>used.add(i.record.object_id));
    return {need:data.localVersions?.[current.object_id]&&round.members.some(r=>r.id===data.localVersions[current.object_id].id)?data.localVersions[current.object_id]:round.plan||current,candidates,round,rounds,material_id:current.object_id};
  });
  const shownRounds=new Set(models.map(m=>m.material_id).filter(Boolean));
  const extra=materialCardModels([],items.filter(i=>!used.has(i.record.object_id))).flatMap(model=>{
    const original=model.candidates[0],identity=original.record;
    const [mid,rounds]=Object.entries(data.material_versions||{}).find(([mid,rs])=>mid!==identity.object_id&&rs.some(r=>r.members.some(m=>m.kind==='ASSET'&&m.object_id===identity.object_id)))||[identity.object_id,data.material_versions?.[identity.object_id]];
    const round=rounds?.find(r=>r.number===data.selectedMaterialRounds?.[mid])||rounds?.[0];if(!round)return [model];
    if(shownRounds.has(mid))return [];shownRounds.add(mid);data.selectedMaterialRounds||={};data.selectedMaterialRounds[mid]=round.number;
    return [{...model,need:round.plan||null,identity,material_id:mid,round,rounds,candidates:materialRoundResults(round,identity,!!data.localVersions?.[identity.object_id]).map(record=>({...original,record,component:record.payload.components.find(c=>c.id===original.component?.id)||record.payload.components.find(c=>c.role==='original')||record.payload.components[0],review_context:data.materialContexts?.[record.id]||(record.id===identity.id?original.review_context:undefined),range:record.id===identity.id?original.range:null,crop:record.id===identity.id?original.crop:null}))}];
  });
  return [...models,...extra];
}
function materialRevisionIntent(){
  if(!isProduction()||state.editing)return null;
  const row=state.productionSelected;if(!row)return null;
  const context=materialCommentContext();
  for(const [mid,rounds] of Object.entries(materialVersions())){
    if(context&&context.material_id!==mid)continue;
    const selected=(isEntityReview()?state.entityReview.selectedMaterialRounds:state.materialReview.selectedMaterialRounds)?.[mid]||rounds[0]?.number;
    const active=rounds[0];if(!active||selected!==active.number)continue;
    if(active.members.some(r=>r.id===row.id)||(active.state==='preparing'&&rounds[1]?.members.some(r=>r.id===row.id)))return {material_id:mid,expected_round:active.number};
  }return null;
}
function materialCommentContext(){
  const row=state.productionSelected;if(!isProduction()||!row)return null;
  const data=isEntityReview()?state.entityReview:state.materialReview,card=state.materialCommentCard,matches=[];
  for(const [mid,rounds] of Object.entries(materialVersions())){const selected=data?.selectedMaterialRounds?.[mid]||rounds[0]?.number;if(rounds.find(r=>r.number===selected)?.members.some(r=>r.id===row.id))matches.push({material_id:mid,number:selected})}
  return matches.find(c=>card?.data===data&&c.material_id===card.material_id&&c.number===card.number)||matches.find(c=>c.material_id===data?.record?.object_id)||(matches.length===1?matches[0]:null);
}
function focusMaterialCommentCard(mid,number){
  const data=isEntityReview()?state.entityReview:state.materialReview,previous=state.materialCommentCard;
  const changed=previous?.data!==data||previous.material_id!==mid||previous.number!==number;
  state.materialCommentCard={data,material_id:mid,number};
  if(changed){
    state.anchor=null;state.editing=null;state.selected=null;state.reviewCommentScope=null;state.pending=null;
    renderComments();
  }
}
function materialMedia(parent,item){
  const {record,component}=item,pane=el('div','entity-review-media-pane');pane.dataset.reviewRevision=record.id;
  const focus=()=>focusProductionReview({record,history:[record],uses:[]});pane.addEventListener('pointerdown',focus,true);pane.addEventListener('focusin',focus,true);
  if(component.mime.startsWith('image/')){
    pane.append(renderStructureVisual({...component,title:item.label||record.payload.title,alt:item.label||record.payload.title,description:`${component.width} × ${component.height}`},true));
    const stage=pane.querySelector('.structure-visual-stage');
    const viewport=pane.querySelector('.structure-visual-viewport');viewport.classList.add('material-image-frame');
    const fit=()=>{const width=viewport.clientWidth,height=viewport.clientHeight,ratio=(component.width||stage.querySelector('img').naturalWidth)/(component.height||stage.querySelector('img').naturalHeight);if(!ratio)return;const w=Math.min(width,height*ratio);stage.style.width=w+'px';stage.style.height=w/ratio+'px'};
    const observer=new ResizeObserver(()=>{if(!pane.isConnected){observer.disconnect();return}fit()});observer.observe(viewport);stage.querySelector('img').addEventListener('load',fit);requestAnimationFrame(fit);
    if(item.crop)stage.dataset.reviewCrop=JSON.stringify(item.crop);
  }else if(/^(audio|video)\//.test(component.mime))reviewMediaPlayer(pane,component,record,item);
  else nodeText('p','production-meta',component.id+' · '+component.mime,pane);
  if(!component.mime.startsWith('audio/'))link('下载原文件','/api/production/files/'+encodeURIComponent(component.file),pane);parent.append(pane);
}
function renderMaterialCard(parent,model,options={}){
  const box=el('article','material-card'),need=model.need;
  let items=model.candidates;
  box.dataset.materialKey=need?.object_id||model.material_id||items[0].record.object_id;
  if(model.round){const focus=()=>focusMaterialCommentCard(model.material_id,model.round.number);box.addEventListener('pointerdown',focus,true);box.addEventListener('focusin',focus,true)}
  const heading=el('div','entity-review-local-heading');nodeText('h3',null,need?.payload.generation?.output.name||need?.payload.title||model.identity?.payload.title||items[0].record.payload.title,heading);
  if(model.round)materialRoundControl(heading,model.material_id,model.rounds,model.round,options.roundChange);else if(need&&options.planVersion)options.planVersion(heading,need);box.append(heading);
  if(options.selectCandidate&&items.length){
    const chosen=materialCandidateChoice(items,options.selectedCandidateId);
    if(items.length>1){
      const select=el('select','entity-review-version');select.setAttribute('aria-label','本轮候选');
      items.forEach((item,index)=>select.append(new Option(`候选 ${index+1} · ${item.record.payload.title}`,item.record.id)));
      select.value=chosen.record.id;select.onchange=()=>options.selectCandidate(select.value);heading.append(select);
    }
    items=[chosen];
  }
  if(!items.length)renderMaterialPlaceholder(box,need||model.identity);
  for(const item of items){
    const h=el('div','entity-review-local-heading');if(need||items.length>1)nodeText('h4',null,item.record.payload.title,h);
    if(!model.round)options.assetVersion?.(h,item);box.append(h);
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
  const entries=Object.entries(detail.material_versions||{}),[mid,rounds]=entries[0]||[];
  let round;if(rounds?.length){const number=detail.selectedMaterialRounds?.[mid]||Number(new URL(location.href).searchParams.get('material_round'));round=rounds.find(v=>v.number===number)||(detail.explicitRevision?rounds.find(v=>v.members.some(m=>m.id===r.id)):null)||rounds[0]}
  if(round){detail.selectedMaterialRounds||={};detail.selectedMaterialRounds[mid]=round.number;const url=new URL(location.href);url.searchParams.set('material_round',round.number);history.replaceState(null,'',url)}
  if(round&&round.plan&&detail.localPlans?.[round.plan.object_id]&&round.members.some(r=>r.id===detail.localPlans[round.plan.object_id].id))round={...round,plan:detail.localPlans[round.plan.object_id]};
  const allCandidates=round?materialRoundResults(round,r,detail.explicitRevision).map(row=>{const c=row.payload.components.find(c=>c.id===detail.componentId)||row.payload.components.find(c=>c.role==='original')||row.payload.components[0];return {record:row,component:c,components:row.payload.components,review_context:detail.review_contexts?.[row.id]||detail.review_context}}):[{record:r,component,components:r.payload.components,review_context:detail.review_context}];
  const candidateTarget=detail.selectedCandidateId||new URL(location.href).searchParams.get('material_target'),candidates=materialExactCandidates(detail,allCandidates,candidateTarget);
  renderMaterialCard(root,{need:round?.plan||null,identity:r,candidates,round,rounds,material_id:mid},{
    ...materialCandidateOptions(detail,candidates),
    roundChange:number=>{switchMaterialRound(detail,mid,number);const url=new URL(location.href);url.searchParams.set('material_round',number);history.replaceState(null,'',url);renderProductionReader();renderComments();focusMaterialRoundControl(mid)},
    relatedPlans:round?[]:detail.review_context?.requirements||[],
    assetVersion:(parent,item)=>{if(detail.history.length<2)return;const select=el('select','entity-review-version');select.setAttribute('aria-label',r.payload.title+'的版本');for(const v of detail.history)select.append(new Option(`版本 ${v.version}${v.id===v.current_revision?' · 当前':''}`,v.id));select.value=r.id;select.onchange=()=>openProductionRecord(r.object_id,select.value);parent.append(select)},
    selectComponent:id=>{detail.componentId=id;renderProductionReader();document.querySelector('#production-component')?.focus({preventScroll:true})}
  });
  const displayed=materialCandidateChoice(candidates,candidateTarget)?.record;
  if(displayed?.payload.blocks?.length)reviewTextBlocks(root,displayed);
  if(!displayed)return;
  const uses=el('section');nodeText('h3',null,'关联用途',uses);
  for(const item of displayed.payload.state_coverage||[]){productionRefLink(uses,item.state);nodeText('p',null,item.detail,uses)}
  root.append(uses);
  const actions=el('div','production-toolbar');
  const activate=fn=>()=>{focusProductionReview({record:displayed,history:detail.history,uses:detail.uses});return fn()};
  if(!round&&detail.history.length>1)productionButton(actions,'并排比较版本',activate(()=>showProductionCompare(root)));
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
  for(const [mid,rounds] of Object.entries(detail.material_versions||{})){const round=rounds.find(v=>v.members.some(r=>r.id===row.id));if(round){detail.selectedMaterialRounds||={};detail.selectedMaterialRounds[mid]=round.number}}
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
    const row=detail.record,p=row.payload;body.replaceChildren();title.textContent=p.title+' · 版本 '+(materialRecordRound(row)||row.version);body.dataset.referenceRevision=row.id;
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
        if(!c.mime.startsWith('audio/'))link('下载原文件',url,body);
      }

    }
    for(const b of (p.blocks||[]).filter(b=>!ref.block_ids?.length||ref.block_ids.includes(b.id)))nodeText('p','reference-text',b.text,body);
    if(p.generation){nodeText('h3',null,'参数 · '+(p.generation.model||'模型未知'),body);nodeText('pre',null,row.review_parameter_text||JSON.stringify(p.generation.parameters,null,2),body);renderMaterialInputs(body,p.generation.inputs||[],row.review_input_records||[]);nodeText('h3',null,'提示词',body);nodeText('pre',null,p.generation.prompt,body)}
  }catch(error){if(dialog.isConnected){body.replaceChildren();nodeText('p','error',error.message,body)}}
}

// A demand is a real REQUIREMENT, never a fabricated ASSET. Round data comes
// from the shared material version contract when available.
function renderMaterialDemand(root,detail){
  const r=detail.record,[mid,rounds]=Object.entries(detail.material_versions||{})[0]||[];
  const selected=detail.selectedMaterialRounds?.[mid]||Number(new URL(location.href).searchParams.get('material_round'));
  const round=rounds?.find(v=>v.number===selected)||(detail.explicitRevision?rounds?.find(v=>v.members.some(m=>m.id===r.id)):null)||rounds?.[0];
  if(round){detail.selectedMaterialRounds||={};detail.selectedMaterialRounds[mid]=round.number;const url=new URL(location.href);url.searchParams.set('material_round',round.number);history.replaceState(null,'',url)}
  const local=detail.localPlans?.[r.object_id];
  const need=local&&round?.members.some(m=>m.id===local.id)?local:round?.plan||r;
  const results=round?.results||(detail.candidate_records||[]).filter(a=>a.payload.candidate_requirements?.some(ref=>ref.revision_id===r.id));
  const allCandidates=results.filter(a=>!a.payload.placeholder).map(record=>({record,component:record.payload.components.find(c=>c.id===detail.componentId)||record.payload.components.find(c=>c.role==='original')||record.payload.components[0],components:record.payload.components,review_context:detail.review_contexts?.[record.id]})).filter(i=>i.component);
  const candidates=materialExactCandidates(detail,allCandidates,detail.selectedCandidateId||new URL(location.href).searchParams.get('material_target'));
  renderMaterialCard(root,{need,candidates,round,rounds,material_id:mid},{
    ...materialCandidateOptions(detail,candidates),
    roundChange:number=>{switchMaterialRound(detail,mid,number);const url=new URL(location.href);url.searchParams.set('material_round',number);history.replaceState(null,'',url);renderProductionReader();renderComments();focusMaterialRoundControl(mid)},
    planVersion:(parent,row)=>{if(rounds?.length||detail.history.length<2)return;const select=el('select','entity-review-version');select.setAttribute('aria-label',row.payload.title+'的版本');for(const v of detail.history)select.append(new Option(`版本 ${v.version}${v.id===v.current_revision?' · 当前':''}`,v.id));select.value=row.id;select.onchange=()=>openProductionRecord(row.object_id,select.value);parent.append(select)},
    selectComponent:id=>{detail.componentId=id;renderProductionReader();document.querySelector('#production-component')?.focus({preventScroll:true})}
  });
  productionRefLink(root,need.payload.scope,'所属状态：'+productionName(need.payload.scope));
}
