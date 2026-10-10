/* Episode / scene navigation and all-shot rows share one exact context reader. */
let breakdownEpoch=0,breakdownSelectionEpoch=0;
function invalidateBreakdownReads(){++breakdownEpoch;++breakdownSelectionEpoch}
function renderAudiovisualSources(host,row){
  const sources=row.payload.sources||[];
  for(const [index,source] of sources.entries())materialReferenceLink(host,source,'故事依据'+(sources.length>1?' '+(index+1):''),'full_scene');
}
function paintMaterialUseText(){
  const data=typeof isEntityReview==='function'&&isEntityReview()?state.entityReview:state.materialReview;
  const records=[...(data?.relation_records||[]),...(data?.comment_records||[])];
  for(const surface of document.querySelectorAll('.material-use-details [data-production-blocks]')){
    const row=records.find(r=>r.id===surface.dataset.productionBlocks);if(!row)continue;
    const blocks=productionTextBlocks(row),source={id:row.object_id,target_revision_id:row.id,blocks};
    for(const [index,block] of blocks.entries()){
      const node=surface.querySelector(`[data-block-id="${CSS.escape(block.id)}"]`);if(!node)continue;
      const marks=blockMarks(source,block,index).filter(m=>m.comment||state.productionSelected?.id===row.id);
      const rendered=renderBlock(source,block,index,marks);node.replaceChildren(...rendered.childNodes);
    }
  }
}
function locateMaterialRelationComment(comment){
  const data=typeof isEntityReview==='function'&&isEntityReview()?state.entityReview:state.materialReview;
  const row=[...(data?.relation_records||[]),...(data?.comment_records||[]),state.productionSelected].find(r=>r?.id===comment.target_revision_id);
  if(row?.kind!=='MATERIAL_RELATION')return false;
  let surface=document.querySelector(`[data-production-blocks="${CSS.escape(row.id)}"]`);
  if(!surface||!productionCommentTextSurface(comment.anchor)){openProductionCommentOriginal(row,comment);return true}
  for(let node=surface.parentElement;node;node=node.parentElement)if(node.tagName==='DETAILS')node.open=true;
  surface.reviewFocus();state.selected=comment.id;state.reviewCommentScope=reviewBlockScope(surface,'text');paintProductionReview();renderComments();
  (surface.querySelector('.comment-mark.selected')||surface.querySelector(`[data-block-id="${CSS.escape(comment.anchor.block_id||'')}"]`)||surface).scrollIntoView({block:'center'});return true;
}
async function openMaterialRelationHistory(row,comment){
  if(comment)return openProductionCommentOriginal(row,comment);
  const {dialog,body}=openReviewDialog('参考用途 · '+materialRelationTitle(row),document.activeElement,'material-reference-dialog');
  const session=referenceReviewSession(dialog,{record:row,history:[row],uses:[]});dialog.reviewFocus=session.focus;
  const info=renderMaterialRelationPurpose(body,row);info.open=true;session.focus();state.selected=comment?.id||null;paintProductionReview();renderComments();if(comment)openPanel();
}
function materialRelationTitle(row){
  return [row.upstream_record&&businessTitle(row.upstream_record),row.downstream_record&&businessTitle(row.downstream_record)].filter(Boolean).join(' → ')||row.payload.title;
}
function rememberMaterialRelations(rows){
  const data=isEntityReview()?state.entityReview:state.materialReview;if(!data)return;
  data.relation_records=[...new Map([...(data.relation_records||[]),...rows].map(r=>[r.id,r])).values()];
  if(isEntityReview()){
    data.comment_records=[...new Map([...(data.comment_records||[]),...rows].map(r=>[r.id,r])).values()];
    data.comment_targets=[...new Map([...(data.comment_targets||[]),...rows.map(productionRef)].map(r=>[r.revision_id,r])).values()];
  }
}
function renderMaterialRelationPurpose(parent,row){
  rememberMaterialRelations([row]);
  const info=el('section','material-use-details');info.dataset.relationId=row.object_id;info.dataset.relationRevision=row.id;

  if(renderRecordComposition(info,row)){parent.append(info);return info}
  const surface=materialTextSurface(info,row);
  // This is one decision on this exact edge, even inside a plan/call reader.
  const focus=e=>{e?.stopPropagation();const url=location.href,card=state.materialCommentCard;focusProductionReview({record:row,history:[row],uses:[]});state.materialCommentCard=card;history.replaceState(history.state,'',url);const dialog=surface.closest('.material-reference-dialog');if(dialog)state.reviewReferenceContext={dialog,record:row}};
  surface.reviewFocus=focus;surface.onpointerdown=focus;surface.onfocusin=focus;
  for(const block of productionTextBlocks(row)){
    const line=el('p'),label={preserve:'保留',change:'允许变化',check:'检查方式'}[block.field];
    if(label)nodeText('b',null,label+'　',line);nodeText('span',null,block.text,line).dataset.blockId=block.id;surface.append(line);
  }
  if(row.payload.condition)nodeText('p',null,'条件：'+row.payload.condition,info);
  if(row.payload.group)nodeText('p',null,'路线：'+row.payload.group+' / '+row.payload.route,info);
  parent.append(info);return info;
}
async function renderInputRelationPurpose(parent,value,need=null){
  if(!value.relation)return;
  try{const detail=await api('/api/production?'+new URLSearchParams(value.relation));
    if(!parent.isConnected)return;
    detail.record.upstream_record=need?.review_input_records?.find(r=>r.id===value.reference?.revision_id);detail.record.downstream_record=need;
    renderMaterialRelationPurpose(parent,detail.record);paintReviewCommentCounts();
  }catch(error){if(parent.isConnected)nodeText('p','production-issue','用途意见读取失败：'+error.message,parent)}
}
function relationReadingSections(row){return row.review_composition?.sections.map(s=>({label:s.label,texts:s.parts.map(p=>p.text)}))||productionTextBlocks(row).map(b=>({label:({preserve:'保留',change:'变化与限制',check:'检查'})[b.field]||'',texts:[b.text]}))}
function renderSharedRelationSections(parent,sections,read){
  for(const section of sections){
    const texts=section.texts.filter(text=>{const key=JSON.stringify([section.label||'',text]);if(read.has(key))return false;read.add(key);return true});
    if(!texts.length)continue;if(section.label)nodeText('h4',null,section.label,parent);for(const text of texts)nodeText('p',null,text,parent);
  }
}
async function renderMaterialRelations(host,materialId,selected=null,{comparisons=null}={}){
  const box=el('section','material-relations');host.append(box);
  const owner=isEntityReview()?state.entityReview:state.materialReview,work=state.reviewWork;
  try{const data=await api('/api/production/material-relations?'+new URLSearchParams({material_id:materialId,...(selected?{revision_id:selected.id}:{})}));
    if(!box.isConnected)return;
    if(data.relations.some(row=>row.payload.relation_type==='business')){
      rememberMaterialRelations([...data.relations,...(data.comment_records||[])]);
      for(const row of data.relations.filter(r=>r.payload.relation_type==='business'&&r.payload.status!=='withdrawn')){
        const target=row.endpoint_records?.find(r=>r.object_id!==materialId);
        if(target){const button=productionButton(box,businessTitle(target),()=>openUnifiedMaterial(productionRef(target),button));bindRelationSummary(button,{record:row,summary:row.payload.summary})}
      }
      return;
    }
    const declared=new Set((selected?.payload.generation?.inputs||[]).map(v=>v.relation?.revision_id).filter(Boolean));
    const rank=r=>r.context_record?.kind==='STATE'?0:r.downstream_record?.payload.media_type==='video'?1:2;
    const candidates=data.relations.filter(row=>!declared.has(row.id));
    const rows=candidates.filter(row=>row.direction==='incoming'||work&&row.downstream_record?.payload.media_type==='video'&&(['AV_SCENE','AV_SHOT','AV_EPISODE'].includes(row.context_record?.kind)?reviewWorkMatches(row.context_record,work):false)).sort((a,b)=>rank(a)-rank(b)||String(businessCode(a.downstream_record)||a.payload.downstream_id).localeCompare(String(businessCode(b.downstream_record)||b.payload.downstream_id),undefined,{numeric:true}));
    const other=candidates.filter(row=>!rows.includes(row));
    if(other.length){const select=el('select');select.setAttribute('aria-label','查看其他使用处');select.append(new Option('查看其他使用处',''));for(const row of other)select.append(new Option(businessTitle(row.downstream_record),row.id));select.onchange=()=>{const row=other.find(r=>r.id===select.value);if(row){const context=row.context_record;openUnifiedMaterial({...productionRef(row.downstream_record),work:['AV_SCENE','AV_SHOT'].includes(context?.kind)?productionRef(context):null},select)}select.value=''};box.append(select)}
    if(!rows.length&&!other.length){box.remove();return}
    if(owner===(isEntityReview()?state.entityReview:state.materialReview))rememberMaterialRelations([...data.relations,...(data.comment_records||[])]);
    const alternatives=rows.filter(r=>r.direction==='incoming'&&r.payload.semantics==='alternative');
    const image=row=>row.upstream_record?.payload.components?.find(c=>c.role==='original'&&c.mime.startsWith('image/'));
    const groups=[['已有形象',alternatives.filter(image)],['旧备选',alternatives.filter(r=>!image(r))],['沿用方案',rows.filter(r=>r.direction==='outgoing')],['其他用途依据',rows.filter(r=>r.direction==='incoming'&&r.payload.semantics!=='alternative')]];
    for(const [label,group] of groups){if(!group.length)continue;const section=el('section','material-use-group');nodeText('h4',null,label,section);
      if(['已有形象','旧备选'].includes(label))nodeText('p','production-meta','供本需求比较，尚未选用。',section);
      const clusters=new Map(),sharedRead=new Set();for(const row of group){const key=label==='沿用方案'?JSON.stringify(relationReadingSections(row)):row.id;if(!clusters.has(key))clusters.set(key,[]);clusters.get(key).push(row)}
      for(const cluster of clusters.values()){
      const shared=cluster.length>1,clusterHost=shared?el('section','shared-material-uses'):section;
      if(shared){section.append(clusterHost);renderSharedRelationSections(clusterHost,relationReadingSections(cluster[0]),sharedRead)}
      for(const row of cluster){const p=row.payload,line=el('article','material-use-row'),out=row.direction==='outgoing',target=out?row.downstream_record:row.upstream_record,reference=out?row.downstream:p.upstream;
        line.dataset.relationId=row.object_id;
        if(target&&reference){
          const preview=!out&&image(row);
          const button=preview?productionButton(line,businessTitle(target),()=>openUnifiedMaterial(reference,button)):productionButton(line,businessTitle(target),()=>out?openUnifiedMaterial(reference,button):openMaterialReference(reference,button));button.classList.add('material-reference');button.setAttribute('aria-haspopup','dialog');
        }
        else nodeText('p','production-issue','准确对象尚未建立',line);
        nodeText('p','production-meta',p.status==='withdrawn'?'历史用途 · 已退出当前准备':out?(!row.declared_input?'用途记录 · 当前方案未声明此输入':row.result?'此方案已有原件候选':'待生成 · 查看方案')+(row.downstream_version?' · 素材版本 '+row.downstream_version:' · 版本未核实'):p.semantics==='alternative'?'尚未选择 · 待比较':p.type_label,line);
        if(out&&row.upstream_matches===false)materialReferenceLink(line,p.upstream,'所引旧版：'+businessTitle(row.upstream_record)+' · 记录修订 '+row.upstream_record.version);
        if(out&&row.result){const button=productionButton(line,'查看此版原件候选',()=>openUnifiedMaterial(row.result,button));button.classList.add('material-reference')}
        if(!out&&image(row)){
          const original=target,component=image(row);materialMedia(line,{record:original,component,components:original.payload.components});
          const data=isEntityReview()?state.entityReview:state.materialReview;if(data){data.comment_records||=[];if(!data.comment_records.some(r=>r.id===original.id))data.comment_records.push(original);if(isEntityReview()){data.comment_targets||=[];if(!data.comment_targets.some(r=>r.revision_id===original.id))data.comment_targets.push(productionRef(original))}}
        }


        if(shared){const opinion=productionButton(line,'此用途的意见',()=>openMaterialRelationHistory(row,null));opinion.classList.add('material-reference')}else renderMaterialRelationPurpose(line,row);
        const old=(data.comment_records||[]).filter(r=>r.object_id===row.object_id&&r.id!==row.id);
        for(const original of old){const button=productionButton(line,'原用途意见 · 修订 '+original.version,()=>openMaterialRelationHistory(original,null));button.classList.add('material-reference')}
        clusterHost.append(line);
      }}(comparisons&&['已有形象','旧备选'].includes(label)?comparisons:box).append(section);
    }paintReviewCommentCounts();
  }catch(error){if(box.isConnected)nodeText('p','production-issue',error.message,box)}
}

function productionTab(){const p=new URL(location.href).searchParams;if(state.workspace==='materials.workspace')return 'materials';if(p.get('production_tab')==='history')return 'retired';return (['entities','materials','breakdown'].includes(p.get('production_tab'))?p.get('production_tab'):null)||((p.has('production_entity')||p.has('entity_state'))?'entities':'breakdown')}
function productionTabs(){if(typeof renderWorkspaceTabs==='function')renderWorkspaceTabs()}
function breakdownRoute(values){const url=new URL(location.href);for(const [k,v] of Object.entries(values)){if(v===null)url.searchParams.delete(k);else url.searchParams.set(k,v)}history.replaceState(history.state,'',url)}
function breakdownHeading(host){productionTabs(host)}
function breakdownSceneTitle(row){return (businessCode(row)||reviewPositionLabel('scene',row.payload.source?.scene_id||row.payload.scene_id,row.payload.source?.object_id))+' · '+row.payload.title.replace(/^\d+-\d+\s*/,'')}
function breakdownShotTitle(row){return businessCode(row)||state.businessCodes?businessTitle(row):reviewPositionLabel('shot',row)+' · '+readableProductionTitle(row)}
function breakdownEpisodeTitle(episode){
  if(!episode)return '';
  const title=String(episode.title||episode.payload?.title||''),number=episode.number??episode.payload?.number;
  if(number===undefined||number===null)return reviewPositionText(title);
  const name=title.replace(/^(?:第\s*\d+\s*集|E\d+)\s*[·:：-]?\s*/iu,'');
  return reviewPositionLabel('episode',episode)+(name?' · '+name:'');
}
function breakdownFacetTitle(key,value,catalog){
  if(key==='episode')return breakdownEpisodeTitle(catalog.episodes.find(e=>e.object_id===value))||reviewPositionText(value);
  const scene=catalog.episodes.flatMap(e=>e.scenes||[]).find(s=>s.id===value);
  return scene?breakdownSceneTitle({...scene,payload:{source:{scene_id:scene.id},title:scene.title}}):reviewPositionLabel('scene',value);
}
function breakdownLevel(row){return ({INPUT_LOCK:'story',STORY:'story',EPISODE:'episode',AV_EPISODE:'episode',AV_SCENE:'scene',AV_SHOT:'shot'})[row.kind]}
const breakdownShotLabels={purpose:'叙事目的'};
function shotReferenceItems(row,inputs,records){
  const items=materialInputs(inputs,records,row.review_shot_slots||[]).map(item=>({...item,slot:row.review_shot_slots?.find(s=>s.index===item.index)}));
  for(const slot of row.review_reference_links||[]){
    if(slot.path?.length===1){const item=items.find(i=>i.index===slot.path[0]);if(item){item.referenceKeys||=[];item.referenceKeys.push(slot.key);item.referenceLabel=slot.label}continue}
    items.push({index:slot.index,label:slot.label,ref:slot.candidate||(slot.record&&productionRef(slot.record)),row:slot.record,value:slot.value||{},slot,referenceKeys:[slot.key],missing:slot.invalid});
  }
  return items;
}
function shotReferenceLabel(slot){return `V${slot?.number||'?'} C${slot?.candidate_number||'?'}`}
function shotReferenceOwnerTitle(slot){return reviewPositionText(slot.selection_owner_title)}
async function refreshShotReference(context,slot,result){
  // A draft stays on its original immutable text, even when only inputs changed.
  const draft=state.anchor?Object.fromEntries(['productionSelected','productionDetail','anchor','editing','selected','reviewCommentScope','productionDraftScope'].map(key=>[key,state[key]])):null;
  state.breakdownVideoSelections[context.need.id]={number:result.number};
  breakdownRoute({shot_material_id:context.need.object_id,shot_plan:result.number,shot_baseline:result.baseline_id||null,shot_candidate:null});
  await loadProductionBreakdown({refresh:true}).catch(e=>toast(e.message));
  const shot=document.querySelector(`[data-shot-id="${CSS.escape(context.need.payload.scope.object_id)}"]`);
  const target=slot.routeKey?shot?.querySelector(`[data-route-key="${CSS.escape(slot.routeKey)}"]`):shot?.querySelector(`[data-input-index="${slot.index}"] button`);target?.focus({preventScroll:true});
  if(draft&&target&&state.workspace==='settings.workspace'){Object.assign(state,draft);renderComments()}
}
function openShotReference(item,context,trigger){
  const slot=item.slot;if(!slot?.material_id||!slot.record){toast('准确素材身份缺失，需先修复此参考槽位');return}
  const params=new URLSearchParams({material_id:slot.material_id,...(!slot.current_content&&slot.number?{material_version:slot.number}:{}),...(slot.baseline_id?{material_baseline:slot.baseline_id}:{}),...(slot.candidate?{material_target:slot.candidate.revision_id}:{})});
  const ref=slot.candidate||productionRef(slot.record);
  const parentDialog=typeof reviewDialogStack==='undefined'?null:reviewDialogStack.at(-1)||null;
  const onSaved=result=>{
    const refresh=()=>{
      if(trigger&&!trigger.isConnected)return;
      // An earlier closed dialog may finish while another input is being read.
      // Wait for that reader to return before touching its restored parent.
      const top=typeof reviewDialogStack==='undefined'?null:reviewDialogStack.at(-1)||null;
      if(top&&top!==parentDialog){top.addEventListener('close',()=>afterReviewDialogReturn(refresh),{once:true});return}
      trigger?.closest('.shot-demands')?.querySelectorAll('input,select,button').forEach(control=>control.disabled=true);
      return context.onSaved?context.onSaved(result):refreshShotReference(context,slot,result);
    };
    if(typeof afterReviewDialogReturn==='function')afterReviewDialogReturn(refresh);else refresh();
  };
  return openUnifiedMaterial({...ref,params,component_id:item.value.component_id,defaultSelection:!slot.number,
    shotReference:{...context,slot,indirect:slot.direct===false,onSaved}},trigger);
}
function renderShotInputs(host,row,inputs,records,context,{pure=false}={}){
  const items=shotReferenceItems(row,inputs,records).filter(item=>!pure||item.slot?.direct!==false);if(!items.length){if(pure)nodeText('p','production-meta','此方案没有参考素材',host);return}
  nodeText('h4',null,'参考素材',host);
  const list=el('div','shot-reference-list');host.append(list);
  for(const item of items){const line=el('div','shot-reference-slot');line.dataset.inputIndex=item.index;if(item.slot?.key)line.dataset.referenceKey=item.slot.key;
    if(item.slot?.nonmedia){materialReferenceLink(line,item.ref,item.label+' · '+businessTitle(item.row),true);line.title='文字依据 · 准确版本 '+item.row.version+'；不作为媒体上传'}
    else if(item.slot?.record){const r=item.slot.record,component=item.slot.component;
      const issues=(item.slot.issues||[]).filter(issue=>!['尚未选定素材版本','尚未选定候选'].includes(issue));
      const owner=item.slot.direct===false?'选择归属：'+shotReferenceOwnerTitle(item.slot):'当前方案的参考选择';
      const label=item.slot.direct===false?item.label.replace(/ · 声音$/u,''):item.label+(materialInputRole(item.value)?' · '+materialInputRole(item.value):'');
      const exactState=r.kind==='ASSET'&&item.referenceLabel&&!r.payload.title.includes(item.referenceLabel)?item.referenceLabel+' · ':'';
      const title=r.payload.title.startsWith(label)?r.payload.title:label+' · '+exactState+r.payload.title;
      const range=item.value.range?` · ${item.value.range.start_seconds}–${item.value.range.end_seconds} 秒`:item.value.crop?' · 已登记裁切区域':'';
      const selectionLabel=!item.slot.number?'方案引用 · 尚未选定版本与原件':!item.slot.candidate?'方案引用 · 版本 '+item.slot.number+' · 原件待选':shotReferenceLabel(item.slot);
      if(context.compact||pure){
        const button=productionButton(line,businessTitle(r,title),()=>openShotReference(item,context,button));button.className='material-reference review-reference-button';button.dataset.reviewDialogTrigger='';
        bindRelationSummary(button,item.slot.relation_context);
        nodeText('small','production-meta',selectionLabel+range+(item.slot.direct===false?' · 间接':''),line);
      }else{
      const card=materialSmallCard(line,{...r,version_count:item.slot.version_count,candidate_count:item.slot.candidate_count,object_id:item.slot.material_id||r.object_id,material_code:item.slot.material_code,business_code:item.slot.material_code||r.business_code,title,media_type:r.payload.media_type,generated:!!item.slot.candidate,preview:component},trigger=>openShotReference(item,context,trigger),false,{subtitle:selectionLabel+range+(item.slot.direct===false?' · 间接':'')+(issues.length?' · '+issues.join('；'):'')});card.dataset.reviewDialogTrigger='';card.setAttribute('aria-label',card.textContent+'；'+owner);card.title+=` · ${owner}：${shotReferenceLabel(item.slot)}；V 为素材版本，C 为该版候选，? 表示尚未选定`+(!pure&&item.value.use?' · 用途：'+item.value.use:'')+range;
      }
    }else nodeText('p','production-issue',item.label+' · 准确引用缺失，需先修复槽位',line);
    if(!context.compact&&!pure){if(item.value.use&&!item.value.relation)nodeText('p',null,item.value.use,line);

    renderInputRelationPurpose(line,item.value,row.kind==='REQUIREMENT'?row:null)}
    list.append(line);
  }
}
function shotReferenceChoiceContext(box,model){
  const context=state.shotReferenceContext;if(!context||box.closest('dialog')!==context.dialog)return;
  if(model.material_id!==context.slot.material_id&&model.round?.canonical_id!==context.slot.canonical_material_id)return;
  return context;
}
function renderShotReferenceChoice(box,model,item,player){
  const context=shotReferenceChoiceContext(box,model);if(!context)return;
  const actions=el('div','production-toolbar shot-reference-actions');box.append(actions);
  if(context.indirect){
    nodeText('p','production-meta','间接参考的 '+shotReferenceLabel(context.slot)+' 属于“'+shotReferenceOwnerTitle(context.slot)+'”。当前镜头通过该方案传递此素材；这里浏览不保存，也不修改共享上游方案或其他镜头。',actions);
    const bounds=context.slot.number===model.round?.number?referenceSelectionBounds(context.slot,item):{};
    if(player&&bounds.range)productionButton(actions,`试听已保存片段 · ${bounds.range.start_seconds}–${bounds.range.end_seconds} 秒`,()=>player.reviewAudition(bounds.range,'已保存片段'));
    materialReferenceLink(actions,context.slot.selection_owner,'查看选定归属方案');return actions;
  }
  const purpose=nodeText('p','production-meta','',actions);
  context.drafts||={};
  const identity=JSON.stringify([model.material_id,model.round?.number,item?.record.id||null,item?.component.id||null]);
  const savedChoice=()=>context.slot.number===model.round?.number&&(context.slot.material_id===model.material_id||context.slot.canonical_material_id===model.material_id)&&(context.slot.candidate?.revision_id||null)===(item?.record.id||null)&&(!item||context.slot.value.component_id===item.component.id);
  const savedBounds=()=>savedChoice()?referenceSelectionBounds(context.slot,item):{};
  const selectionFields=renderReferenceSelectionFields(actions,item,{...context.slot,value:savedChoice()?context.slot.value:{}},()=>{player?.reviewPause();context.drafts[identity]=selectionFields.snapshot();context.error=null;refresh()},context.drafts[identity]);
  const actionLabel=item?'选为方案参考':'选定此版本，候选待选';
  const unchanged=()=>savedChoice()&&JSON.stringify(selectionFields())===JSON.stringify(referenceSelectionBounds(context.slot,item));
  const audition=player?productionButton(actions,'试听选段',()=>{
    try{const bounds=selectionFields();if(!bounds.range||!player.reviewAudition(bounds.range,unchanged()?'已保存片段':'未保存范围'))throw Error('起点须早于终点，且在此原件范围内');context.error=null}
    catch(error){context.error=error.message}refresh();
  }):null;
  const button=productionButton(actions,actionLabel,async()=>{
    if(context.busy||button.disabled)return;
    let bounds;try{bounds=selectionFields()}catch(error){context.error=error.message;refresh();return}
    const value={requirement_id:context.need.object_id,expected_revision:context.need.id,expected_content:{edit_token:context.need.edit_token,content_sha256:context.need.content_sha256},plan_number:context.number,index:context.slot.index,input_key:context.slot.input_key,material_id:model.material_id,number:model.round.number,...(item?{candidate:productionRef(item.record),component_id:item.component.id,...bounds}:{candidate:null})};
    const choice=JSON.stringify(value);if(context.requestChoice!==choice){context.requestChoice=choice;context.requestId='shot-ref-'+crypto.randomUUID()}
    const request={id:context.requestId,...value};context.busy=true;context.source.pending=true;context.error=null;refresh();
    try{const result=await api('/api/production/shot-reference',{method:'POST',body:JSON.stringify(request)});
      const slot=result.slots.find(s=>s.index===(result.selected_index??request.index));
      if(result.requirement_id!==request.requirement_id||!slot)throw Error('保存回执与当前消费位置不匹配，请重新打开核对');
      context.need={...context.need,id:result.revision_id};context.number=result.number;context.frozen=!!result.frozen;
      context.slot={...context.slot,...slot};context.source.saved=result;context.result=result;
    }catch(error){context.error='保存失败：'+error.message}
    finally{context.busy=false;context.source.pending=false;if(context.dialog.isConnected&&state.shotReferenceContext===context)context.choiceView?.refresh();else if(!context.dialog.isConnected&&context.pageActive?.()&&context.source.saved)context.source.onSaved(context.source.saved)}
  });
  const discard=productionButton(actions,'放弃范围修改',()=>{player?.reviewPause();delete context.drafts[identity];context.error=null;selectionFields.restore(savedBounds());refresh()});
  const message=nodeText('small','production-meta','',actions);message.setAttribute('role','status');
  const refresh=()=>{if(!actions.isConnected)return;let same=false;try{same=unchanged()}catch{}
    purpose.textContent=`为此素材方案版本 ${context.number} 的参考 ${context.slot.index+1} 选择；仅浏览不会保存。`+(context.frozen?' 已提交版本改选将建立新制作版本。':'');
    button.disabled=context.busy||same||!model.round||!!(item&&(item.record.payload.placeholder||item.component?.role!=='original'));
    button.textContent=context.busy?'正在保存…':same?'已保存 · 方案版本 '+context.number:context.slot.number?'保存修改 · 未保存':actionLabel;
    message.textContent=context.error||(item&&item.component?.role!=='original'?'试听／预览组成仅供比较；请选择原件后保存。':'');message.className=context.error?'production-issue':'production-meta';
    discard.hidden=!context.drafts[identity]||same;discard.disabled=context.busy;
    if(audition){let bounds;try{bounds=selectionFields()}catch{}
      audition.hidden=!selectionFields.snapshot().range?.enabled;
      audition.disabled=!bounds?.range;
      audition.textContent=(same?'试听已保存片段':'试听未保存范围')+(bounds?.range?` · ${bounds.range.start_seconds}–${bounds.range.end_seconds} 秒`:'');
    }
  };
  context.choiceView={refresh};refresh();
  if(!item)nodeText('p','production-meta','可先选定此版本；候选仍待选，完成选定前不能执行制作。',actions);
  return actions;
}
function renderLinkedPrompt(parent,row,inputs,records,field,context=null){
  const block=productionTextBlocks(row).find(b=>b.field===field);if(!block)return;
  const pre=el('pre','shot-generation-prompt');pre.dataset.blockId=block.id;
  nodeText('h4',null,'Prompt',parent);
  const refs=context?shotReferenceItems(row,inputs,records):materialInputs(inputs,records),byLabel=new Map(refs.map(item=>[item.label,item]));
  const spans=[];
  const points=Array.from(block.text),links=row.review_prompt_links||row.payload.generation?.prompt_links||[];
  for(const link of links){
    const input=refs.find(item=>item.referenceKeys?.includes(link.reference_key));
    if(input&&points.slice(link.start,link.end).join('')===link.quote)spans.push({start:points.slice(0,link.start).join('').length,end:points.slice(0,link.end).join('').length,text:link.quote,input,entity:true});
  }
  for(const match of block.text.matchAll(/@?(?:图片|图像|音频|声音|视频|输入)\s*\d+/gu)){
    const label=match[0].replace(/^@/,'').replace(/\s/g,'').replace(/^图像/,'图片').replace(/^声音/,'音频');
    const input=byLabel.get(label)||(/^输入\d+$/.test(label)?refs.find(i=>i.index===Number(label.slice(2))-1&&i.slot?.direct!==false):null);
    if(!spans.some(s=>s.start<match.index+match[0].length&&s.end>match.index))spans.push({start:match.index,end:match.index+match[0].length,text:match[0],input});
  }
  let offset=0;
  for(const span of spans.sort((a,b)=>a.start-b.start)){
    if(span.start<offset)continue;
    pre.append(document.createTextNode(block.text.slice(offset,span.start)));const input=span.input;
    if(input?.ref&&(!input.missing||input.slot?.record)){
      const a=el('a','prompt-reference'+(span.entity?' prompt-entity-reference':''));a.dataset.reviewDialogTrigger='';a.href=reviewURL(materialReferenceRequest(input.ref,false).url);a.textContent=span.text;
      a.title=span.entity?'审阅素材引用；'+(input.slot?.direct===false?'经“'+shotReferenceOwnerTitle(input.slot)+'”传递；不增加模型输入':'对应准确直接输入'):'模型输入 '+input.label;
      if(span.entity)a.setAttribute('aria-label','@'+span.text+'；'+a.title);
      a.onclick=e=>{e.preventDefault();if(getSelection()?.isCollapsed){if(context&&!input.slot?.nonmedia)openShotReference(input,context,a);else openMaterialReference(input.ref,a)}};pre.append(a);
      bindRelationSummary(a,input.slot?.relation_context||row.review_shot_slots?.find(slot=>slot.index===input.index)?.relation_context);
    }else pre.append(document.createTextNode(span.text));offset=span.end;
  }
  pre.append(document.createTextNode(block.text.slice(offset)));parent.append(pre);
}
function breakdownPromptSelection(need,context){
  const detail=context.video_details?.[need.object_id],rounds=detail?.material_versions?.[need.object_id]||[];
  state.breakdownVideoSelections||={};const params=new URL(location.href).searchParams,exact=params.get('shot_material_id')===need.object_id;
  const saved=exact&&params.has('shot_plan')?{number:Number(params.get('shot_plan')),candidate:params.get('shot_candidate')}:state.breakdownVideoSelections[need.id]||{};
  if(exact&&params.has('shot_plan')){
    const checked=new URLSearchParams({material_id:need.object_id,material_version:params.get('shot_plan'),...(params.has('shot_baseline')?{material_baseline:params.get('shot_baseline')}:{})});
    validateUnifiedReference({params:checked,detail});saved.number=Number(checked.get('material_version'));
  }
  const exactNeed=detail?.record?.id===need.id?detail.record:need;
  const bound=rounds.find(r=>(r.definition_records?.requirement||r.plan)?.id===need.id);
  const explicit=saved.number!=null;
  const round=explicit?rounds.find(r=>r.number===saved.number):bound;
  if(explicit&&!round)throw Error('准确素材制作版本不存在；未替换为其他版本');
  const historicalRecipe=!round;
  const source=round?(round.definition_records?round.definition_records.requirement:round.plan):exactNeed;
  const candidates=(round?.results||[]).map(record=>({record,components:record.payload.components,component:record.payload.components.find(c=>c.role==='original')||record.payload.components[0]}));
  const model={need:source,identity:need,candidates,round,rounds,material_id:need.object_id};
  if(saved.candidate&&!candidates.some(i=>i.record.id===saved.candidate))throw Error('准确素材候选不属于此制作版本；未替换为其他结果');
  const selected=materialCandidateChoice(candidates,saved.candidate||materialDefaultCandidate(model,{adoptions:context.adoptions}));
  const selection={number:round?.number,baseline:round?.baseline_id,candidate:selected?.record.id,reference:productionRef(selected?.record||source||round?.definition_records?.call||need)};
  state.breakdownVideoSelections[need.id]=selection;
  const referenceContext={need:source||need,number:round?.number,frozen:!round||!!round.frozen,historical:historicalRecipe};
  return {detail,rounds,exact,saved,round,exactNeed,historicalRecipe,candidates,model,selected,selection,referenceContext};
}
function breakdownEpisodeCount(ep){
  const targets=new Set((ep.comment_targets||[]).map(r=>r.object_id+':'+r.revision_id));
  return new Set((state.comments||[]).filter(c=>c.status!=='DELETED'&&targets.has(c.target_object_id+':'+c.target_revision_id)).map(c=>c.id)).size;
}
function renderBreakdownCommentCounts(){
  for(const ep of state.breakdownData?.episodes||[]){const button=document.querySelector('.breakdown-episode-tabs [data-episode-id="'+CSS.escape(ep.object_id)+'"]');const count=button?.querySelector('.screenplay-episode-count');if(count)count.textContent='评论 '+breakdownEpisodeCount(ep)}
}
function breakdownNavigate(values){
  rememberProductionDraft();const url=new URL(location.href);
  for(const key of ['production_object','production_revision','material_id','material_version','material_round','material_target','production_entity','entity_state','shot_material_id','shot_plan','shot_candidate','shot_baseline'])url.searchParams.delete(key);
  for(const [key,value] of Object.entries(values)){if(value===null)url.searchParams.delete(key);else url.searchParams.set(key,value)}
  history.pushState(null,'',url);return loadProductionBreakdown().catch(e=>toast(e.message));
}
function breakdownSelect(row,nav,updateRoute=true){
  state.breakdownCurrent=row;
  for(const button of nav.querySelectorAll('[data-object-id]')){const active=button.dataset.objectId===row.object_id&&button.dataset.revisionId===row.id;button.classList.toggle('active',active);button.setAttribute('aria-current',active?'location':'false')}
  if(updateRoute){const active=nav.querySelector('[aria-current="location"]');if(active?.getBoundingClientRect&&nav.getBoundingClientRect){const r=active.getBoundingClientRect(),edge=nav.getBoundingClientRect();if(r.bottom>edge.bottom)nav.scrollTop+=r.bottom-edge.bottom;if(r.top<edge.top)nav.scrollTop+=r.top-edge.top}}
  if(updateRoute)breakdownRoute({breakdown_object:row.object_id,breakdown_revision:row.id});
}
function breakdownPosition(body){
  return {key:body.dataset.readingKey,scrollTop:body.scrollTop,windowY:window.scrollY};
}
function rememberBreakdownPosition(body){
  const position=breakdownPosition(body);state.breakdownMemory||={};state.breakdownMemory[position.key]=position;
  history.replaceState({...history.state,breakdownPosition:position},'',location.href);
}
function scrollBreakdownTarget(body,target){
  const header=body.querySelector('.breakdown-scene-head'),offset=header?.getBoundingClientRect().height||0;
  body.style.setProperty('--breakdown-header-height',offset+'px');
  if(target===header){body.scrollTop=0;if(matchMedia('(max-width:700px)').matches)header.scrollIntoView({block:'start'});return}
  target.scrollIntoView({block:'start'});
}
function breakdownSelectionKey(params){
  return ['breakdown_episode_revision','shot_material_id','shot_plan','shot_candidate','production_object','production_revision','material_id','material_version','material_round','material_target','production_entity','entity_state'].map(key=>params.get(key)||'').join('\n');
}
function breakdownEditionTarget(data,params){
  const id=params.get('breakdown_object'),revision=params.get('breakdown_revision');
  if(!id||id===data.design?.object_id){
    if(revision&&data.design?.id!==revision)return {error:'准确集修订不属于所选版本；未替换为最新版'};
    return {scene:data.scenes.find(r=>r.object_id===params.get('breakdown_scene'))||data.scenes[0]};
  }
  const scenes=data.scenes.filter(r=>r.object_id===id&&(!revision||r.id===revision));
  const shots=[...new Map(data.shots.map(r=>[r.id,r])).values()];
  const pairs=data.scenes.filter(scene=>!revision||!params.get('breakdown_scene')||scene.object_id===params.get('breakdown_scene')).flatMap(scene=>scene.payload.shots.flatMap(ref=>shots.filter(r=>r.object_id===id&&r.object_id===ref.object_id&&r.id===ref.revision_id&&(!revision||r.id===revision)).map(target=>({scene,target}))));
  const matches=[...scenes.map(scene=>({scene,target:scene})),...pairs];
  if(matches.length===1)return matches[0];
  return {error:matches.length?'原场镜在所选版本有多个准确位置，无法唯一对应。请从本集场镜导航选择。':revision?'原场镜的准确修订不在所选版本，无法继续定位。请从本集场镜导航选择；未替换为其他修订。':'原场镜不在所选版本的准确组成中，无法继续定位。请从本集场镜导航选择。'};
}
async function loadProductionBreakdown({refresh=false}={}){
  state.productionVisibleEntities=null;state.refreshEntityIndex=null;rememberProductionDraft();
  const oldBody=document.querySelector('.breakdown-body');if(oldBody?.dataset.readingKey){state.breakdownMemory||={};state.breakdownMemory[oldBody.dataset.readingKey]=breakdownPosition(oldBody)}
  const epoch=++breakdownEpoch,workspace=state.workspace,params=new URL(location.href).searchParams,host=$('#production-view'),savedPosition=history.state?.breakdownPosition;
  ++breakdownSelectionEpoch;++productionLoadEpoch;++productionReadEpoch;
  state.entityReview=null;state.materialReview=null;state.unifiedCardRoot=null;state.productionSelected=null;state.productionEntityId=null;
  delete state.breakdownLevels;
  const targetId=params.get('breakdown_object'),targetRevision=params.get('breakdown_revision'),edition=params.get('breakdown_episode_revision');
  const existing=state.breakdownSceneData,existingNav=host.querySelector('.breakdown-scene-list');
  const exact=existing&&[existing.scene,...existing.shots.map(s=>s.record)].find(r=>r.object_id===targetId&&(!targetRevision||r.id===targetRevision));
  if(!refresh&&(!edition||state.breakdownData?.design?.id===edition)&&oldBody&&existingNav&&host.dataset.breakdownWorkspace===workspace&&host.dataset.breakdownTab===productionTab()&&state.breakdownRenderedSelection===breakdownSelectionKey(params)&&exact&&oldBody.dataset.sceneId===existing.scene.object_id){
    activateBreakdownScene(existing,oldBody,existingNav,epoch,params,savedPosition);return;
  }
  // Keep the mounted reader and its geometry while requests are pending. The
  // replacement is assembled off-screen and committed once, before positioning.
  if(!oldBody)host.replaceChildren();
  const staged=el('div'),loading=nodeText('p','breakdown-loading','正在读取本集镜头…',host);loading.setAttribute('role','status');
  const sidebarTop=existingNav?.scrollTop||0,episodeLeft=host.querySelector('.breakdown-episode-tabs')?.scrollLeft||0;
  try{breakdownHeading(host);
  const query=new URLSearchParams({episode:params.get('breakdown_episode')||'',view:'breakdown'});
  if(edition)query.set('episode_revision',edition);
  else if(targetId){query.set('object_id',targetId);if(targetRevision)query.set('revision_id',targetRevision)}
  // Within this immutable episode, selecting an already known exact scene or
  // shot only needs its body. A refresh, changed edition, or another tab reads
  // the authoritative directory again; historical targets never use a head.
  const cached=state.breakdownCatalog,known=cached?.data;
  const reuse=!refresh&&cached?.workspace===workspace&&cached?.tab===productionTab()&&(!edition||known.design?.id===edition)&&known.episode===(params.get('breakdown_episode')||known.episode)&&targetId&&
    [...known.scenes,...known.shots].some(r=>r.object_id===targetId&&r.id===targetRevision);
  const data=reuse?known:await api('/api/production/breakdown?'+query);if(epoch!==breakdownEpoch||workspace!==state.workspace)return;
  state.breakdownCatalog={workspace,tab:productionTab(),data};
  state.breakdownData=data;state.productionRecords=[data.lock,data.design,...data.scenes,...data.shots].filter(Boolean);
  const episodes=el('nav','screenplay-episodes breakdown-episode-tabs');episodes.setAttribute('aria-label','分集导航');staged.append(episodes);
  {const scope='视听制作评论：本集准确集场镜及直接关联素材的当前方案与真实候选；含已关闭评论，按评论去重，不含故事正文和共享上游素材。';episodes.title=scope;episodes.setAttribute('aria-description',scope)}
  for(const ep of data.episodes)renderEpisodeCard(episodes,{...ep,payload:{number:ep.number,title:ep.title,scenes:ep.scenes}},ep.object_id===data.episode,breakdownEpisodeCount(ep),()=>{if(ep.object_id!==(new URL(location.href).searchParams.get('breakdown_episode')||data.episode))breakdownNavigate({breakdown_episode:ep.object_id,breakdown_episode_revision:null,breakdown_scene:null,breakdown_object:null,breakdown_revision:null})});
  const active=episodes.querySelector('.active');if(active){const r=active.getBoundingClientRect(),edge=episodes.getBoundingClientRect();if(r.right>edge.right)episodes.scrollLeft+=r.right-edge.right;if(r.left<edge.left)episodes.scrollLeft+=r.left-edge.left}
  for(const ep of data.episodes){const button=episodes.querySelector(`[data-episode-id="${CSS.escape(ep.object_id)}"]`);if(button)attachAudiovisualNote(button,ep.working_note)}
  const layout=el('div','breakdown-scene-layout'),nav=el('aside','text-reader-index breakdown-scenes'),head=el('header'),sceneList=el('nav','breakdown-scene-list'),body=el('article','breakdown-body');
  nodeText('h2',null,'本集场镜',head);nav.append(head,sceneList);sceneList.setAttribute('aria-label','场镜导航');body.setAttribute('aria-label','逐镜设计与素材制作');layout.append(nav,body);staged.append(layout);
  const resolved=breakdownEditionTarget(data,params),selected=resolved.scene;
  if(resolved.target){params.set('breakdown_object',resolved.target.object_id);params.set('breakdown_revision',resolved.target.id);params.set('breakdown_scene',selected.object_id)}
  if(data.design)params.set('breakdown_episode_revision',data.design.id);
  state.breakdownExpanded||={};
  for(const scene of data.scenes){
    const group=el('section','breakdown-directory-scene'),line=el('div','breakdown-directory-heading'),children=el('div','breakdown-directory-shots'),key=scene.object_id;
    const toggle=productionButton(line,'',()=>{children.hidden=!children.hidden;state.breakdownExpanded[key]=!children.hidden;toggle.textContent=children.hidden?'▸':'▾';toggle.setAttribute('aria-expanded',String(!children.hidden))});
    toggle.className='breakdown-directory-toggle';toggle.setAttribute('aria-label','展开／收起 '+breakdownSceneTitle(scene));children.hidden=state.breakdownExpanded[key]===false;toggle.textContent=children.hidden?'▸':'▾';toggle.setAttribute('aria-expanded',String(!children.hidden));
    const choose=row=>()=>breakdownNavigate({breakdown_episode:data.episode,breakdown_episode_revision:data.design.id,breakdown_scene:scene.object_id,breakdown_object:row.object_id,breakdown_revision:row.id});
    const button=productionButton(line,breakdownSceneTitle(scene),choose(scene));button.className='source-button';button.dataset.objectId=scene.object_id;button.dataset.revisionId=scene.id;
    attachAudiovisualNote(button,scene.working_note);
    for(const shot of [...new Map(data.shots.map(r=>[r.id,r])).values()].filter(r=>scene.payload.shots.some(v=>v.object_id===r.object_id&&v.revision_id===r.id))){const button=productionButton(children,breakdownShotTitle(shot),choose(shot));button.className='source-button';button.dataset.objectId=shot.object_id;button.dataset.revisionId=shot.id}
    group.append(line,children);sceneList.append(group);
  }
  const commit=()=>{host.replaceChildren(...staged.children);host.dataset.breakdownWorkspace=workspace;host.dataset.breakdownTab=productionTab();sceneList.scrollTop=sidebarTop;episodes.scrollLeft=episodeLeft;
    const chosen=episodes.querySelector('.active');if(chosen?.getBoundingClientRect){const r=chosen.getBoundingClientRect(),edge=episodes.getBoundingClientRect();if(r.right>edge.right)episodes.scrollLeft+=r.right-edge.right;if(r.left<edge.left)episodes.scrollLeft+=r.left-edge.left}};
  if(resolved.error){nodeText('p','production-issue',resolved.error,body);state.breakdownCurrent=null;state.breakdownSceneData=null;breakdownRoute({breakdown_episode_revision:data.design.id,breakdown_scene:null,production_object:null,production_revision:null});commit();renderComments()}
  else if(selected)await showBreakdownScene(selected,body,sceneList,epoch,params,savedPosition,commit);else{nodeText('p',null,'本集尚无场次设计',body);commit()}
  const materialTarget=params.get('production_object');
  if(!resolved.error&&epoch===breakdownEpoch&&workspace===state.workspace&&materialTarget&&params.has('material_id')&&!data.scenes.some(r=>r.object_id===materialTarget)&&!data.shots.some(r=>r.object_id===materialTarget)){
    breakdownRoute({material_id:null,material_version:null,material_round:null,material_target:null,production_entity:null,entity_state:null});
    await openUnifiedMaterial({object_id:materialTarget,revision_id:params.get('production_revision'),params},null);
  }
  }catch(error){
    if(epoch!==breakdownEpoch||workspace!==state.workspace)return;
    host.replaceChildren();nodeText('p','production-issue','准确制作位置不可用：'+error.message,host);
    throw error;
  }finally{loading.remove()}
}
function groupedShotMaterials(items){
  const unique=[...new Map(items.map(i=>[i.canonical_material_id||i.object_id,i])).values()],groups=new Map();
  for(const item of unique){const c=item.classification||{key:item.media_type+':other',label:'其他-'+({image:'图像',audio:'声音',video:'视频',project:'工程',document:'文档'}[item.media_type]||'其他')};if(!groups.has(c.key))groups.set(c.key,{...c,items:[]});groups.get(c.key).items.push(item)}
  const media=['image','audio','video','project','document'];return [...groups.values()].sort((a,b)=>media.indexOf(a.key.split(':')[0])-media.indexOf(b.key.split(':')[0])||a.label.localeCompare(b.label,'zh-CN'));
}
function renderBreakdownShot(parent,item,common={fields:{},sounds:[]},referencesParent=null){
  return renderThreePartShot(parent,item);
}

function attachAudiovisualNote(button,note){
  if(!note?.body)return;
  const pop=el('div','av-working-note');pop.id='av-note-'+note.object_id;pop.setAttribute('role','tooltip');pop.hidden=true;
  nodeText('p',null,note.body,pop);let timer=null,closing=null;
  const close=()=>{clearTimeout(timer);clearTimeout(closing);pop.hidden=true;button.removeAttribute('aria-describedby')};
  const open=()=>{clearTimeout(closing);clearTimeout(timer);timer=setTimeout(()=>{if(!button.isConnected)return;document.querySelectorAll('.av-working-note').forEach(node=>node.hidden=true);const box=button.getBoundingClientRect();pop.style.left=Math.max(8,Math.min(box.left,innerWidth-432))+'px';pop.style.top=Math.min(box.bottom+6,innerHeight-240)+'px';pop.hidden=false;button.setAttribute('aria-describedby',pop.id)},1000)};
  const leave=()=>{clearTimeout(timer);closing=setTimeout(()=>{if(!pop.matches(':hover')&&!button.matches(':hover')&&document.activeElement!==button&&!pop.contains(document.activeElement))close()},150)};
  button.addEventListener('pointerenter',open);button.addEventListener('pointerleave',leave);button.addEventListener('focus',open);button.addEventListener('blur',leave);button.addEventListener('click',close);
  button.addEventListener('keydown',e=>{if(e.key==='Escape')close()});pop.addEventListener('pointerenter',()=>clearTimeout(closing));pop.addEventListener('pointerleave',leave);pop.addEventListener('focusout',leave);pop.addEventListener('keydown',e=>{if(e.key==='Escape'){close();button.focus({preventScroll:true});clearTimeout(timer)}});pop.tabIndex=0;
  // The note leaves with its navigation item, so a late timer cannot show a
  // previous episode's text after navigation.
  button.after(pop);
}

function renderThreePartShot(parent,item){
  const shot=item.record,row=el('article','breakdown-row breakdown-shot av-three-part');row.dataset.shotId=shot.object_id;row.dataset.shotRevision=shot.id;
  const text=el('section','breakdown-shot-copy'),heading=el('header');nodeText('h3',null,breakdownShotTitle(shot),heading);renderAudiovisualSources(heading,shot);text.append(heading);row.append(text);parent.append(row);
  const purpose=el('section','av-shot-purpose');nodeText('h4',null,'叙事目的',purpose);text.append(purpose);
  const surface=materialTextSurface(purpose,shot),block=productionTextBlocks(shot).find(b=>b.field==='purpose'||b.id==='purpose');
  if(block)nodeText('p',null,block.text,surface).dataset.blockId=block.id;else nodeText('p','production-meta','此镜尚未编写叙事目的',surface);
  const states=el('section','av-shot-states');nodeText('h4',null,'镜头关键状态',states);text.append(states);
  for(const [index,value] of (shot.payload.key_states||[]).entries()){
    const stateHost=el('article','av-key-state');states.append(stateHost);const surface=materialTextSurface(stateHost,shot),block=productionTextBlocks(shot).find(b=>b.field===`key_states.${index}.description`);
    const line=nodeText('p',null,value.description,surface);if(block)line.dataset.blockId=block.id;
    const links=el('div','av-state-demands');stateHost.append(links);
    for(const reference of value.requirements){const need=item.context.requirements.find(r=>r.id===reference.revision_id&&r.object_id===reference.object_id);
      const button=productionButton(links,need?businessTitle(need):'准确素材需求缺失',()=>openUnifiedMaterial(reference,button));button.disabled=!need;button.className='review-reference-button';button.dataset.reviewDialogTrigger='';
    }
  }
  if(!shot.payload.key_states?.length)nodeText('p','production-meta','本镜没有需独立准备素材的关键状态',states);
  const generation=el('section','av-shot-generation');nodeText('h4',null,'生成方案',generation);text.append(generation);
  const products=shot.payload.products||[];
  if(!products.length){nodeText('p','production-meta','本镜尚未登记产物方案',generation);return row}
  state.breakdownProductSelections||={};const params=new URL(location.href).searchParams,routed=params.get('shot_material_id');
  let selected=products.find(v=>v.requirement.object_id===routed)?.requirement.object_id||state.breakdownProductSelections[shot.id];
  if(!products.some(v=>v.requirement.object_id===selected))selected=products[0].requirement.object_id;
  const tabs=el('div','av-product-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label',breakdownShotTitle(shot)+'的产物');const panel=el('section','shot-demands av-product-panel');panel.setAttribute('role','tabpanel');generation.append(tabs,panel);
  const draw=()=>{state.breakdownProductSelections[shot.id]=selected;panel.replaceChildren();for(const button of tabs.children){const active=button.dataset.materialId===selected;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1}
    const product=products.find(v=>v.requirement.object_id===selected),need=item.context.requirements.find(r=>r.object_id===selected&&r.id===product.requirement.revision_id);
    panel.id='av-product-'+shot.object_id;panel.setAttribute('aria-labelledby','av-tab-'+shot.object_id+'-'+selected);
    if(!need)nodeText('p','production-issue','此产物的准确方案缺失，未替换为其他版本',panel);else renderShotProductPlan(panel,need,item.context);
    restoreBreakdownPromptDraft(panel);paintReviewCommentCounts();
  };
  for(const [index,product] of products.entries()){
    const button=productionButton(tabs,product.label,()=>{if(selected===product.requirement.object_id)return;rememberProductionDraft();selected=product.requirement.object_id;breakdownRoute({shot_material_id:selected,shot_plan:null,shot_candidate:null,shot_baseline:null});draw()});
    button.dataset.materialId=product.requirement.object_id;button.id='av-tab-'+shot.object_id+'-'+product.requirement.object_id;button.setAttribute('role','tab');button.setAttribute('aria-controls','av-product-'+shot.object_id);
    button.onkeydown=e=>{const direction={ArrowRight:1,ArrowLeft:-1,Home:-index,End:products.length-1-index}[e.key];if(direction===undefined)return;e.preventDefault();const target=tabs.children[(index+direction+products.length)%products.length];target.click();target.focus()};
  }
  draw();return row;
}

function renderShotProductPlan(parent,need,context){
  let selected;try{selected=breakdownPromptSelection(need,context)}catch(error){nodeText('p','production-issue',error.message,parent);return}
  const {rounds,round,model,referenceContext,historicalRecipe}=selected;
  const source=model.need||round?.definition_records?.call;
  const controls=el('div','av-plan-controls');parent.append(controls);
  if(rounds.length>1)materialRoundControl(controls,need.object_id,rounds,round||{number:null},number=>{rememberProductionDraft();state.breakdownVideoSelections[need.id]={number};breakdownRoute({shot_material_id:need.object_id,shot_plan:number,shot_candidate:null,shot_baseline:rounds.find(r=>r.number===number)?.baseline_id||null});parent.replaceChildren();renderShotProductPlan(parent,need,context);restoreBreakdownPromptDraft(parent);paintReviewCommentCounts()});
  const inspect=productionButton(controls,'查看素材',()=>openUnifiedMaterial({...productionRef(source||need),params:new URLSearchParams({material_id:need.object_id,...(round&&!round.current_content?{material_version:round.number,...(round.baseline_id?{material_baseline:round.baseline_id}:{})}:{})})},inspect));inspect.className='review-reference-button';inspect.dataset.reviewDialogTrigger='';if(source?.kind==='REQUIREMENT')renderReviewHelp(controls,source);
  if(!source){nodeText('p','production-meta','此版本未保留准确生成方案',parent);return}
  const plan=source.kind==='CALL'?source.payload:source.payload.generation;
  if(!plan){nodeText('p','production-meta',need.payload.media_type==='project'?'此产物为已有工程；尚无模型生成方案，可打开素材核对工程与交付要求。':'此产物尚无生成方案',parent);return}
  const inputs=plan.inputs||[],records=source.review_input_records||[];
  if(need.current_content)renderMaterialInputs(parent,inputs,records,source,source.kind==='CALL',{compact:true});else renderShotInputs(parent,source,inputs,records,referenceContext,{pure:true});
  const surface=materialTextSurface(parent,source);materialParameters(surface,source,source.kind==='CALL'?'call':'generation',plan.model);
  renderLinkedPrompt(surface,source,inputs,records,source.kind==='CALL'?'call.prompt':'generation.prompt',referenceContext);
}

async function showBreakdownScene(scene,body,nav,epoch,restore=null,savedPosition=null,commit=null){
  const request=++breakdownSelectionEpoch,workspace=state.workspace,targetId=restore?.get('breakdown_object'),targetRevision=restore?.get('breakdown_revision'),shot=(state.breakdownData.shots||[]).find(r=>r.object_id===targetId&&r.id===targetRevision);
  const design=state.breakdownData.design;
  const data=await api('/api/production/scene?'+new URLSearchParams({object_id:scene.object_id,revision_id:scene.id,view:'breakdown',...(design?{episode:design.object_id,episode_revision:design.id}:{}),...(shot?{shot_revision:shot.id}:{})}));if(epoch!==breakdownEpoch||request!==breakdownSelectionEpoch||workspace!==state.workspace)return;
  body.replaceChildren();state.breakdownSceneData=data;body.dataset.sceneId=scene.object_id;body.dataset.readingKey=scene.id+':'+(shot?.id||'');
  breakdownRoute({breakdown_episode:state.breakdownData.episode,breakdown_episode_revision:state.breakdownData.design?.id||null,breakdown_scene:scene.object_id,production_tab:'breakdown',...(state.breakdownData.design?{production_scope_episode:state.breakdownData.design.object_id,production_scope_revision:state.breakdownData.design.id,production_scope_scene:scene.object_id}:{})});
  const page=el('section','breakdown-scene');body.append(page);
  const header=el('header','text-reader-head breakdown-scene-head'),heading=el('div','breakdown-scene-heading');nodeText('h2',null,breakdownSceneTitle(data.scene),heading);renderAudiovisualSources(heading,data.scene); header.append(heading);page.append(header);
  for(const item of data.shots)renderBreakdownShot(page,item);
  state.productionRecords=[...state.productionRecords,...data.shots.map(s=>s.record),data.scene,...(data.shared||[]).flatMap(c=>[c.record,...c.requirements,...c.entities,...c.states]),...data.shots.flatMap(s=>s.context.requirements)];
  if(commit)commit();
  state.breakdownRenderedSelection=breakdownSelectionKey(restore||new URLSearchParams());
  activateBreakdownScene(data,body,nav,epoch,restore,savedPosition,{page,header});
}
function activateBreakdownScene(data,body,nav,epoch,restore=null,savedPosition=null,rendered=null){
  const targetId=restore?.get('breakdown_object'),targetRevision=restore?.get('breakdown_revision'),page=rendered?.page||body.querySelector('.breakdown-scene'),header=rendered?.header||body.querySelector('.breakdown-scene-head');
  const chosen=data.shots.find(s=>s.record.object_id===targetId&&(!targetRevision||s.record.id===targetRevision))?.record||data.scene;
  body.dataset.readingKey=data.scene.id+':'+(chosen.kind==='AV_SHOT'?chosen.id:'');
  focusProductionReview(entityReviewDetail(chosen),false);restoreProductionDraft();breakdownSelect(chosen,nav);paintReviewCommentCounts();renderComments();
  const target=chosen.kind==='AV_SHOT'?page.querySelector('[data-shot-id="'+CSS.escape(chosen.object_id)+'"]'):header;
  if(chosen.kind==='AV_SHOT')restoreBreakdownPromptDraft(target);
  const memory=savedPosition?.key===body.dataset.readingKey?savedPosition:!targetId?state.breakdownMemory?.[body.dataset.readingKey]:null;
  if(memory){body.scrollTop=memory.scrollTop;window.scrollTo(0,memory.windowY)}else scrollBreakdownTarget(body,target);
  let frame=null;
  const track=()=>{if(frame!==null)return;frame=requestAnimationFrame(()=>{frame=null;if(epoch!==breakdownEpoch||!body.isConnected||document.querySelector('dialog[open]'))return;
    const edge=body.getBoundingClientRect(),limit=matchMedia('(max-width:700px)').matches?Math.max(0,document.querySelector('.workspace-topbar')?.getBoundingClientRect().bottom||0)+20:Math.max(edge.top,parseFloat(getComputedStyle(header).top)||0)+header.getBoundingClientRect().height+20;
    const rows=[...page.querySelectorAll('[data-shot-id]')],visible=rows.filter(r=>r.getBoundingClientRect().top<=limit).at(-1);
    const current=visible?data.shots.find(s=>s.record.id===visible.dataset.shotRevision)?.record:data.scene;if(current)breakdownSelect(current,nav,false);rememberBreakdownPosition(body);
  })};body.onscroll=track;
  // The narrow reader scrolls with the window. Old listeners remove themselves.
  if(state.breakdownWindowTrack)window.removeEventListener('scroll',state.breakdownWindowTrack);
  const windowTrack=()=>{if(epoch!==breakdownEpoch){window.removeEventListener('scroll',windowTrack);return}if(matchMedia('(max-width:700px)').matches)track()};state.breakdownWindowTrack=windowTrack;window.addEventListener('scroll',windowTrack,{passive:true});
  rememberBreakdownPosition(body);
}

async function openBreakdownMaterial(need,reader,selectionEpoch=null,restore=false){
  rememberProductionDraft();const read=++productionReadEpoch,workspace=state.workspace,params=restore?new URL(location.href).searchParams:new URLSearchParams();
  reader.replaceChildren();nodeText('p',null,'正在读取素材…',reader);
  if(!restore)breakdownRoute({material_id:null,material_version:null,material_round:null,material_target:null,production_entity:null,entity_state:null});
  try{const result=await readUnifiedCard(need.object_id,need.id||null,params);if(read!==productionReadEpoch||workspace!==state.workspace||selectionEpoch!==null&&selectionEpoch!==breakdownSelectionEpoch)return;
    result.allowDraftFocus=!restore;result.defaultSelection=!restore;state.unifiedCardRoot=null;activateUnifiedCard(result);renderProductionReader();renderComments();
    const mid=state.entityReview?.unifiedMaterialId||Object.keys(result.detail.material_versions||{})[0]||result.detail.record.object_id;
    for(const button of document.querySelectorAll('.material-index [data-material-id]'))button.setAttribute('aria-pressed',String(button.dataset.materialId===mid));
  }catch(error){if(read===productionReadEpoch){reader.replaceChildren();nodeText('p','production-issue',error.message,reader)}}
}
function flatFilterGroup(parent,key,label,options,selected,counts,onchange){
  const group=el('div','production-filter-group');group.setAttribute('role','group');group.setAttribute('aria-label',label);nodeText('span','production-filter-label',label,group);const choices=el('div','production-filter-options');group.append(choices);
  for(const [value,title] of options){const button=productionButton(choices,'',()=>onchange(selected===value?'':value));button.className='production-filter-chip';button.setAttribute('aria-pressed',String(selected===value));button.dataset.filterKey=key;button.dataset.filterValue=value;nodeText('span',null,title,button);if(counts)nodeText('b','production-filter-count',String(counts[value]||0),button)}parent.append(group);
}
async function loadProductionMaterials(){return loadMaterialManagement()}

function renderMaterialAdoptionControls(reader,detail){
  if(!detail.adoptionContext)return;
  reader.querySelector('[data-adoption-controls]')?.remove();
  const controls=el('section','production-toolbar');controls.dataset.adoptionControls='true';reader.append(controls);
  const adoption=detail.adoptionContext.adoptions.find(r=>r.payload.slot===detail.record.payload.slot);
  if(adoption)materialReferenceLink(controls,{...adoption.payload.asset,component_id:adoption.payload.component_id,...(adoption.payload.range?{range:adoption.payload.range}:{}),...(adoption.payload.crop?{crop:adoption.payload.crop}:{})},'已采用的准确原件');
  if(detail.candidate_records?.length)productionButton(controls,adoption?'更换采用':'选择采用',()=>showProductionAdoption(controls,{requirement:detail.record,adoption,candidates:detail.candidate_records}));

}
function productionDraftKey(){
  const context=typeof materialCommentContext==='function'?materialCommentContext():null;
  return JSON.stringify([state.productionSelected?.id||null,context?.material_id||null,context?.number||null,context?.model||null,state.productionSelected?.edit_token||null]);
}
function productionDraftContexts(){
  if(!state.productionDraftContexts){try{state.productionDraftContexts=JSON.parse(localStorage.getItem('review-production-drafts:'+commentPageId)||'{}')}catch{state.productionDraftContexts={}}}
  return state.productionDraftContexts;
}
function rememberProductionDraft(){
  if(!isProduction()||!state.productionSelected||!state.anchor)return;
  if(typeof rememberLiveCommentEdit==='function')try{rememberLiveCommentEdit()}catch{rememberCommentDraftFailure()}
  if(state.productionDraftScope&&state.productionDraftScope!==productionDraftKey())return;
  const contexts=productionDraftContexts(),panel=$('#comment-panel');contexts[state.productionDraftScope||productionDraftKey()]={anchor:state.anchor,editing:state.editing,selected:state.selected,scope:state.reviewCommentScope,draftKey:typeof draftKey==='function'?draftKey():null,panelOpen:!!panel&&!panel.hidden};
  try{localStorage.setItem('review-production-drafts:'+commentPageId,JSON.stringify(contexts))}catch{rememberCommentDraftFailure();toast('草稿位置未能保存到本机，当前输入仍保留。')}
}
function restoreProductionDraft(){
  const key=productionDraftKey(),changed=state.productionDraftScope&&state.productionDraftScope!==key;state.productionDraftScope=key;
  const saved=productionDraftContexts()[key];
  if(saved&&(saved.editing||saved.selected||saved.draftKey&&readCommentDraftStorage(saved.draftKey)!==null)){state.anchor=saved.anchor;state.editing=saved.editing;state.selected=saved.selected;state.reviewCommentScope=saved.scope;if(saved.panelOpen)openPanel()}
  else if(changed){state.anchor=null;state.editing=null;state.selected=null;state.reviewCommentScope=null}
}
function appendStaleProductionDrafts(parent){
  if(!isProduction()||!state.productionSelected?.current_content)return;
  const current=JSON.parse(productionDraftKey());
  for(const [key,saved] of Object.entries(productionDraftContexts())){
    let previous,text;try{previous=JSON.parse(key);text=localStorage.getItem(saved.draftKey)}catch{continue}
    if(previous[0]!==current[0]||previous[4]===current[4]||saved.editing||!text)continue;
    const box=el('section','comment-editor');nodeText('strong',null,'当前内容修改前的未提交意见',box);
    nodeText('p','comment-help','原圈选的正文已修改，草稿仍保留。请复制后重新圈选，避免提交到相似文字。',box);
    if(saved.anchor?.quote)nodeText('blockquote',null,saved.anchor.quote,box);
    nodeText('p',null,text,box);
    const copy=nodeText('button',null,'复制草稿',box);copy.onclick=async()=>{try{await navigator.clipboard.writeText(text);toast('草稿已复制；请重新选择当前内容。')}catch{toast('复制失败，草稿仍在此处，可手动选择复制。')}};
    parent.append(box);
  }
}
function restoreBreakdownPromptDraft(row){
  if(!row||!['breakdown','shots'].includes(productionTab()))return;
  const surfaces=[...row.querySelectorAll('[data-production-blocks]')];
  for(const [key,saved] of Object.entries(productionDraftContexts()).reverse()){
    let revision,token;try{const parts=JSON.parse(key);revision=parts[0];token=parts[4]||'';if(!saved.anchor||!saved.draftKey||localStorage.getItem(saved.draftKey)===null)continue}catch{continue}
    // Only a displayed exact plan/call may restore a Prompt draft. Do not move
    // a draft to another shot, version or newer immutable revision.
    const exact=surfaces.filter(node=>node.dataset.productionBlocks===revision&&(node.dataset.productionEditToken||'')===String(token)),a=saved.anchor;
    const surface=exact.find(node=>!node.querySelectorAll||[...node.querySelectorAll('[data-block-id]')].some(text=>text.dataset.blockId===a.block_id&&(!text.hasAttribute('data-anchor-offset')||(Number(text.dataset.anchorOffset)<=a.start&&a.end<=Number(text.dataset.anchorOffset)+Array.from(text.textContent).length))));
    if(surface?.reviewFocus){for(let parent=surface.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;surface.reviewFocus();return}
  }
}

async function openBreakdownSceneNotes(row,comment){
  const {dialog,body}=openReviewDialog('历史制作说明 · '+breakdownSceneTitle(row),document.activeElement,'material-reference-dialog');
  const detail=await api('/api/production?'+new URLSearchParams({object_id:row.object_id,revision_id:row.id}));if(!dialog.isConnected)return;
  const session=referenceReviewSession(dialog,detail);const surface=materialTextSurface(body,detail.record);
  for(const block of productionTextBlocks(detail.record))nodeText('p',null,block.text,surface).dataset.blockId=block.id;
  session.focus();state.selected=comment.id;paintReviewCommentCounts();openPanel();renderComments();surface.querySelector('[data-block-id="'+CSS.escape(comment.anchor.block_id)+'"]')?.scrollIntoView({block:'center'});
}

async function refreshMaterialPlan(result){
  const epoch=productionLoadEpoch,workspace=state.workspace,target=state.productionSelected?.id;
  const params=new URLSearchParams({material_id:result.requirement_id,...(result.number?{material_version:result.number}:{}),...(result.baseline_id?{material_baseline:result.baseline_id}:{})});
  const value=await readUnifiedCard(result.requirement_id,result.revision_id,params);
  if(epoch!==productionLoadEpoch||workspace!==state.workspace||target!==state.productionSelected?.id)return;
  activateUnifiedCard(value);renderProductionReader();renderComments();
}
function renderMaterialRouteChoices(host,need,onSaved){
  const slots=need.review_shot_slots||[],plan=need.payload.generation,groups=new Map(),conditions=new Set();
  if(!plan)return;
  const save=async(action,key,value,control)=>{control.disabled=true;try{const result=await api('/api/production/material-route',{method:'POST',body:JSON.stringify({id:'route-'+crypto.randomUUID(),requirement_id:need.object_id,expected_revision:need.id,expected_content:{edit_token:need.edit_token,content_sha256:need.content_sha256},action,key,value})});if(control.isConnected)await onSaved(result,control.dataset.routeKey)}catch(error){if(control.isConnected){control.disabled=false;toast(error.message)}}};
  for(const slot of slots){const rule=slot.rule;if(!rule)continue;if(rule.necessity==='one_of'){if(!groups.has(rule.group))groups.set(rule.group,new Map());groups.get(rule.group).set(rule.route,slot)}if(rule.necessity==='conditional')conditions.add(rule.condition)}
  if(!groups.size&&!conditions.size&&!slots.some(s=>s.rule?.necessity==='optional'))return;
  const box=el('div','material-route-controls');host.append(box);
  for(const [group,choices] of groups){const label=el('label'),select=el('select');nodeText('span',null,'执行路线 · '+group,label);select.setAttribute('aria-label','执行路线 '+group);select.dataset.routeKey='route:'+group;select.append(new Option('请选择路线',''));for(const [route,slot] of choices)select.append(new Option(slot.record?.payload.title||route,route));select.value=plan.selected_routes?.[group]||'';select.disabled=need.id!==need.current_revision;select.onchange=()=>{if(select.value)save('route',group,select.value,select)};label.append(select);box.append(label)}
  for(const key of conditions){const label=el('label'),select=el('select');nodeText('span',null,'条件 · '+key,label);select.setAttribute('aria-label','条件 '+key);select.dataset.routeKey='condition:'+key;for(const [v,title] of [['','待判断'],['true','满足'],['false','不满足']])select.append(new Option(title,v));select.value=key in (plan.conditions||{})?String(plan.conditions[key]):'';select.disabled=need.id!==need.current_revision;select.onchange=()=>{if(select.value)save('condition',key,select.value==='true',select)};label.append(select);box.append(label)}
  for(const slot of slots.filter(s=>s.rule?.necessity==='optional')){const label=el('label'),input=el('input');input.type='checkbox';input.dataset.routeKey='optional:'+slot.index;input.checked=slot.active;input.disabled=need.id!==need.current_revision;input.onchange=()=>save('optional',slot.index,input.checked,input);label.append(input,document.createTextNode('使用可选参考：'+(slot.record?.payload.title||slot.index+1)));box.append(label)}
}
function referenceSelectionBounds(slot,item){
  const value=item&&slot.candidate?.revision_id===item.record.id&&slot.value.component_id===item.component.id?slot.value:{};
  return Object.fromEntries([['crop',['x','y','width','height']],['range',['start_seconds','end_seconds']]].filter(([key])=>value[key]).map(([key,fields])=>[key,Object.fromEntries(fields.map(name=>[name,value[key][name]]))]));
}
function renderReferenceSelectionFields(host,item,slot,onChange=()=>{},draft=null){
  const controls=[],current=referenceSelectionBounds(slot,item),component=item?.component;
  const add=(key,title,fields,initial)=>{const wrap=el('fieldset'),legend=el('legend'),toggle=el('input');toggle.type='checkbox';toggle.setAttribute('aria-label',title);toggle.checked=draft?.[key]?.enabled??!!current[key];legend.append(toggle,document.createTextNode(title));wrap.append(legend);const values={};
    for(const [name,label,max,step] of fields){const line=el('label'),input=el('input');input.type='number';input.min='0';input.max=String(max);input.step=String(step);input.value=String(draft?.[key]?.[name]??current[key]?.[name]??initial[name]);input.setAttribute('aria-label',label);input.disabled=!toggle.checked;input.oninput=onChange;line.append(document.createTextNode(label),input);wrap.append(line);values[name]=input}toggle.onchange=()=>{Object.values(values).forEach(input=>input.disabled=!toggle.checked);onChange()};host.append(wrap);controls.push({key,toggle,values,initial});
  };
  if(item){
  if(component.mime.startsWith('image/')||component.mime.startsWith('video/'))add('crop','使用局部区域（0–1比例）',[['x','左边界',1,.01],['y','上边界',1,.01],['width','区域宽度',1,.01],['height','区域高度',1,.01]],{x:0,y:0,width:1,height:1});
  if(component.mime.startsWith('audio/')||component.mime.startsWith('video/'))add('range','使用时间段（秒）',[['start_seconds','开始秒数',component.duration_seconds,.01],['end_seconds','结束秒数',component.duration_seconds,.01]],{start_seconds:0,end_seconds:component.duration_seconds});
  }
  const read=()=>Object.fromEntries(controls.filter(c=>c.toggle.checked).map(({key,values})=>[key,Object.fromEntries(Object.entries(values).map(([name,input])=>{if(input.value.trim()===''||!Number.isFinite(Number(input.value)))throw Error('请填写完整的范围数值');return [name,Number(input.value)]}))]));
  read.snapshot=()=>Object.fromEntries(controls.map(({key,toggle,values})=>[key,{enabled:toggle.checked,...Object.fromEntries(Object.entries(values).map(([name,input])=>[name,input.value]))}]));
  read.restore=bounds=>{for(const {key,toggle,values,initial} of controls){toggle.checked=!!bounds[key];for(const [name,input] of Object.entries(values)){input.value=String(bounds[key]?.[name]??initial[name]);input.disabled=!toggle.checked}}};
  return read;
}
