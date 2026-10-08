/* One review card for planned materials and exact, existing media. */
const isMaterialReview=()=>isProduction()&&!!state.materialReview&&materialRows(state.materialReview).some(r=>r.id===state.productionSelected?.id);
function materialVersionCommentRows(round){return [...new Map([...(round?.members||[]),...Object.values(round?.definition_records||{})].filter(Boolean).map(row=>[row.id,row])).values()]}
function materialRows(detail){
  const contexts=Object.values(detail.review_contexts||{current:detail.review_context}).filter(Boolean);
  return [detail.record,...detail.history,...(detail.candidate_records||[]),...Object.values(detail.material_versions||{}).flatMap(rounds=>rounds.flatMap(materialVersionCommentRows)),...contexts.flatMap(c=>[c.call,...c.requirements])].filter(Boolean);
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
  const focus=()=>{const dialog=host.closest('.material-reference-dialog');if(dialog?.reviewFocus)dialog.reviewFocus();else focusProductionReview({record:row,history:[row],uses:[]})};host.reviewFocus=focus;host.onpointerdown=focus;host.onfocusin=focus;parent.append(host);return host;
}
function materialParameters(host,row,prefix,model){
  const heading=nodeText('h4',null,'参数 · ',host),block=productionTextBlocks(row).find(b=>b.field===prefix+'.model');
  const name=nodeText('span',null,model||'模型未知',heading);if(block)name.dataset.blockId=block.id;
  materialField(host,row,prefix+'.parameters',null,'pre');
}
function materialInputs(inputs,records=[],slots=[]){
  const counts={};return inputs.flatMap((value,index)=>{
    const ref=value.reference||value,row=records.find(r=>r.id===ref.revision_id)||(state.productionRecords||[]).find(r=>r.id===ref.revision_id);
    // Keep the complete ordered inputs, including exact entity/script records.
    if(!row)return [{value,index,row:null,label:'输入'+(index+1),ref:{...ref,...value},missing:true}];
    if(!['ASSET','REQUIREMENT'].includes(row.kind))return [{value,index,row,label:({ENTITY:'实体',STATE:'状态',EPISODE:'剧本',SOURCE:'资料',STORY:'故事',INPUT_LOCK:'剧本依据'})[row.kind]||'输入'+(index+1),ref:{...ref,...Object.fromEntries(['component_id','crop','range'].filter(k=>value[k]).map(k=>[k,value[k]]))}}];
    const component=value.component_id?row.payload.components?.find(c=>c.id===value.component_id):row.payload.components?.find(c=>c.role==='original');
    if(row.kind==='ASSET'&&(!value.component_id||!component))return [{value,index,row,label:'输入'+(index+1),ref:{...ref,...value},missing:true}];
    const type=component?.mime.split('/')[0]||row.payload.media_type,label={image:'图片',audio:'音频',video:'视频'}[type];if(!label)return [];
    if(slots.find(s=>s.index===index)?.active===false)return [{value,index,row,label:'备选 '+(slots.find(s=>s.index===index)?.rule?.route||index+1),ref:{...ref,...value}}];
    counts[type]=(counts[type]||0)+1;return [{value,index,row,label:label+counts[type],ref:{...ref,...Object.fromEntries(['component_id','crop','range'].filter(k=>value[k]).map(k=>[k,value[k]]))}}];
  });
}
function renderMaterialInputs(host,inputs,records=[],need=null){
  const effective=materialInputs(inputs,records);if(!effective.length)return;
  nodeText('h4',null,'参考输入',host);
  for(const item of effective){
    const line=el('div','material-input');if(item.missing)nodeText('p','production-issue',item.label+' · 准确输入记录或文件组成缺失',line);else materialReferenceLink(line,item.ref,item.label+' · '+businessTitle(item.row),['EPISODE','SOURCE','STORY'].includes(item.row.kind));
    nodeText('small','production-meta',(item.row?materialVersionLabel(item.row):'版本未知')+''+(item.value.range?` · ${item.value.range.start_seconds}–${item.value.range.end_seconds} 秒`:'')+(item.value.crop?' · 使用裁切区域':''),line);
    if(need)materialField(line,need,`generation.inputs.${item.index}.use`,null);else if(item.value.use)nodeText('p',null,item.value.use,line);
    host.append(line);
  }
}
function renderActualGeneration(parent,context){
  const call=context?.call,box=el('section','material-actual-inputs');nodeText('h3',null,'生成内容',box);
  if(!call){nodeText('p','production-meta','未登记真实调用，无法还原生成内容',box);parent.append(box);return}
  const host=materialTextSurface(box,call);
  materialParameters(host,call,'call',call.payload.model);
  renderMaterialInputs(host,call.payload.inputs||[],context.inputs||[]);
  materialField(host,call,'call.prompt','提示词','pre');parent.append(box);
}
function renderMaterialRequirements(parent,requirement){
  const info=el('section','material-requirements');nodeText('h3',null,'素材要求',info);const host=materialTextSurface(info,requirement);
  const blocks=requirement.payload.blocks||[],description=productionTextBlocks(requirement).find(b=>b.field==='generation.output.description');
  const names=[requirement.payload.title,requirement.payload.generation?.output.name].filter(Boolean);
  const repeated=description&&blocks.find(b=>description.text===b.text||names.some(name=>['：',': ',':'].some(separator=>description.text===name+separator+b.text)));
  const anchor=state.productionSelected?.id===requirement.id&&state.anchor||state.comments.find(c=>c.id===state.selected&&c.target_revision_id===requirement.id)?.anchor;
  // Show an old output-description anchor with its exact original prefix and
  // offsets. Ordinary reading shows the equivalent requirement only once.
  const locatingDescription=repeated&&anchor?.type==='text'&&(anchor.block_id===description.id||anchor.end_block_id===description.id);
  for(const block of blocks){if(locatingDescription&&anchor.block_id===description.id&&(!anchor.end_block_id||anchor.end_block_id===description.id)&&block===repeated)continue;const node=nodeText('p',null,block.text,host);node.dataset.blockId=block.id}
  if(!repeated||locatingDescription)materialField(host,requirement,'generation.output.description',repeated?null:'需求描述');
  materialField(host,requirement,'generation.output.review_criteria','检查要点');parent.append(info);
}
function renderGenerationRecipe(parent,need,requirementsShown=false){
  const plan=need.payload.generation,box=el('section','material-plan');box.dataset.requirementId=need.object_id;
  nodeText('h3',null,'生成方案',box);
  if(!plan){nodeText('p',need.payload.status==='withdrawn'?'production-meta':'production-issue',need.payload.status==='withdrawn'?'此版本未附生成方案':'生成方案待完善',box);parent.append(box);return}
  const host=materialTextSurface(box,need);if(!requirementsShown)materialField(host,need,'generation.output.description',null);
  materialParameters(host,need,'generation',plan.model);renderMaterialRouteChoices(host,need,result=>refreshMaterialPlan(result));
  if(need.review_shot_slots&&typeof renderShotInputs==='function')renderShotInputs(host,need,plan.inputs||[],need.review_input_records||[],{need,number:materialRecordRound(need),frozen:!!Object.values(materialVersions()).flat().find(r=>r.members.some(v=>v.id===need.id))?.frozen,onSaved:result=>refreshMaterialPlan(result)});
  else renderMaterialInputs(host,plan.inputs||[],need.review_input_records||[],need);
  if(plan.blockers?.length){nodeText('h4',null,'生成前仍需',host);for(const issue of plan.blockers)nodeText('p','production-issue',issue,host)}
  materialField(host,need,'generation.prompt','提示词','pre');if(!requirementsShown)materialField(host,need,'generation.output.review_criteria','检查要点');parent.append(box);
}
function materialVersions(){return (isEntityReview()?state.entityReview:state.materialReview)?.material_versions||{}}
function materialRecordRound(row){for(const rounds of Object.values(materialVersions()))for(const round of rounds)if(round.members.some(r=>r.id===row.id))return round.number;if(Number.isInteger(row.material_version))return row.material_version;if(row.material_round_numbers&&Object.keys(row.material_round_numbers).length)return Object.values(row.material_round_numbers)[0];return null}
function materialVersionLabel(row){const number=materialRecordRound(row);return number?'素材版本 '+number:'记录修订 '+row.version}
function materialResultKey(row){return JSON.stringify([row.payload.production?.object_id,[...new Set(row.payload.components.filter(c=>c.role==='original').map(c=>c.sha256))].sort()])}
function materialRoundResults(round,selected,explicit){return round.results.map(row=>explicit&&row.object_id===selected.object_id&&materialResultKey(row)===materialResultKey(selected)&&round.members.some(m=>m.id===selected.id)?selected:row)}
function materialCandidateChoice(items,targetId){
  return items.find(i=>i.record.id===targetId)||items.find(i=>i.review_context?.call?.id===targetId)||[...items].sort((a,b)=>(b.candidate_number||b.record.candidate_number||0)-(a.candidate_number||a.record.candidate_number||0)||(b.record.created_at||'').localeCompare(a.record.created_at||'')||(b.record.version||0)-(a.record.version||0))[0]||null;
}
function materialExactCandidates(detail,items,targetId,round=null){
  const target=(round?round.members:materialRows(detail)).find(r=>r.kind==='ASSET'&&r.id===targetId);if(!target)return items;
  const sameResult=item=>materialResultKey(item.record)===materialResultKey(target);
  let index=items.findIndex(item=>item.record.object_id===target.object_id&&sameResult(item));
  // A round may deduplicate equal originals from the same call under another
  // asset object. Keep its one result while displaying the exact member read.
  if(index<0&&round)index=items.findIndex(sameResult);if(index<0)return items;
  return items.map((item,i)=>i!==index?item:{...item,record:target,candidate_number:item.record.candidate_number,candidate_code:item.record.candidate_code,components:target.payload.components,component:target.payload.components.find(c=>c.id===item.component.id)||target.payload.components.find(c=>c.role==='original')||target.payload.components[0],review_context:detail.review_contexts?.[target.id]||(detail.record.id===target.id?detail.review_context:null)||(item.review_context?.call?.id===target.payload.production?.revision_id?item.review_context:undefined)});
}
function materialCandidateOptions(detail,items){
  const requested=detail.selectedCandidateId||new URL(location.href).searchParams.get('material_target');
  const targetId=items.some(i=>i.record.id===requested)?requested:typeof materialDefaultCandidate==='function'?materialDefaultCandidate({need:detail.record,candidates:items},detail):null;
  return {selectedComponents:detail.selectedComponents,selectedCandidateId:targetId,selectCandidate:id=>{
    const item=items.find(i=>i.record.id===id);if(!item)return;
    rememberProductionDraft();detail.selectedCandidateId=id;focusProductionReview({record:item.record,history:[item.record],uses:[]},false);
    renderProductionReader();renderComments();document.querySelector('[aria-label="本轮候选"] [aria-pressed="true"]')?.focus({preventScroll:true});
  }};
}
function materialRoundControl(parent,mid,rounds,selected,change){
  return reviewChoiceButtons(parent,'素材版本',[...rounds].sort((a,b)=>a.number-b.number).map(r=>({id:r.number,label:'版本 '+r.number})),selected.number,change);
}
function reviewChoiceButtons(parent,label,choices,selected,change,{repeat=false}={}){
  const bar=el('div','review-choice-buttons');bar.setAttribute('role','group');bar.setAttribute('aria-label',label);
  for(const choice of choices){const button=productionButton(bar,choice.label,()=>{if(repeat||String(choice.id)!==String(selected))return change(choice.id)});button.setAttribute('aria-pressed',String(String(choice.id)===String(selected)));button.dataset.choiceId=choice.id}
  parent.append(bar);if(typeof requestAnimationFrame==='function')requestAnimationFrame(()=>{const button=bar.querySelector('[aria-pressed=true]');if(button)bar.scrollLeft=Math.max(0,button.offsetLeft-bar.offsetLeft+button.offsetWidth-bar.clientWidth)});return bar;
}
function materialDefaultRound(rounds){
  const ordered=[...(rounds||[])].sort((a,b)=>b.number-a.number);
  return ordered.find(r=>(r.results||[]).some(row=>!row.payload.placeholder&&row.payload.components?.some(c=>c.role==='original')))||ordered[0];
}
function switchMaterialRound(data,mid,number){
  cancelMaterialCommentLocation();
  const rounds=data.material_versions[mid],old=data.selectedMaterialRounds?.[mid]||rounds[0].number;
  data.roundDrafts||={};data.roundDrafts[mid+':'+old]={row:state.productionSelected,anchor:state.anchor,editing:state.editing,selected:state.selected,scope:state.reviewCommentScope};
  data.selectedMaterialRounds||={};data.selectedMaterialRounds[mid]=number;data.explicitRevision=false;delete data.selectedCandidateId;
  const round=rounds.find(r=>r.number===number);if(!round)throw Error('准确素材版本不存在；未替换为最新版本');const saved=data.roundDrafts[mid+':'+number];
  state.materialCommentCard={data,material_id:mid,number};
  const candidates=round.results.map(record=>({record})),preferred=typeof materialDefaultCandidate==='function'?materialDefaultCandidate({need:round.plan,identity:data.requirements?.find(r=>r.object_id===mid),candidates},data):null;
  const row=saved?.row&&materialVersionCommentRows(round).some(r=>r.id===saved.row.id)?saved.row:materialCandidateChoice(candidates,preferred)?.record||round.plan||round.definition_records?.call||round.definition_records?.requirement;
  state.anchor=null;state.editing=null;state.selected=null;state.reviewCommentScope=null;state.drawMode=null;
  if(row)focusProductionReview({record:row,history:[row],uses:[]},false);
  if(saved&&row===saved.row){state.anchor=saved.anchor;state.editing=saved.editing;state.selected=saved.selected;state.reviewCommentScope=saved.scope}
}
function focusMaterialRoundControl(mid){[...document.querySelectorAll('.material-card')].find(n=>n.dataset.materialKey===mid)?.querySelector('[aria-label="素材版本"] [aria-pressed="true"]')?.focus({preventScroll:true})}
function materialRoundSelection(current,data){
  const rounds=data.material_versions?.[current.object_id]||[],number=data.selectedMaterialRounds?.[current.object_id],round=rounds.find(r=>r.number===number)||materialDefaultRound(rounds);
  const local=data.localVersions?.[current.object_id];
  return {rounds,round,need:round?(local&&round.members.some(r=>r.id===local.id)?local:round.plan||(round.model==='plan-v1'&&round.frozen?null:current)):current};
}
function materialRoundModels(needs,items,data){
  const used=new Set(),models=needs.map(current=>{
    const {rounds,round,need}=materialRoundSelection(current,data);
    if(!round){const model=materialCardModels([current],items).find(m=>m.need===current);model.candidates.forEach(i=>used.add(i.record.object_id));return model}
    data.selectedMaterialRounds||={};data.selectedMaterialRounds[current.object_id]=round.number;
    // Older results belong to this card's history, including when the current round has no result.
    for(const history of rounds)for(const row of history.members)if(row.kind==='ASSET')used.add(row.object_id);
    const candidates=round.results.map(row=>{const original=items.find(i=>i.record.object_id===row.object_id),component=row.payload.components.find(c=>c.role==='original')||row.payload.components[0];
      return {...original,record:row,label:original?.record.id===row.id?original.label:items.find(item=>item.record.id===row.id)?.label,component,components:row.payload.components,review_context:data.materialContexts?.[row.id],range:original?.record.id===row.id?original.range:null,crop:original?.record.id===row.id?original.crop:null}});
    candidates.forEach(i=>used.add(i.record.object_id));
    return {need,identity:current,candidates,round,rounds,material_id:current.object_id};
  });
  const shownRounds=new Set(models.map(m=>m.material_id).filter(Boolean));
  const extra=materialCardModels([],items.filter(i=>!used.has(i.record.object_id))).flatMap(model=>{
    const original=model.candidates[0],identity=original.record;
    const [mid,rounds]=Object.entries(data.material_versions||{}).find(([mid,rs])=>mid!==identity.object_id&&rs.some(r=>r.members.some(m=>m.kind==='ASSET'&&m.object_id===identity.object_id)))||[identity.object_id,data.material_versions?.[identity.object_id]];
    const round=rounds?.find(r=>r.number===data.selectedMaterialRounds?.[mid])||materialDefaultRound(rounds);if(!round)return [model];
    if(shownRounds.has(mid))return [];shownRounds.add(mid);data.selectedMaterialRounds||={};data.selectedMaterialRounds[mid]=round.number;
    return [{...model,need:round.plan||null,identity,material_id:mid,round,rounds,candidates:materialRoundResults(round,identity,!!data.localVersions?.[identity.object_id]).map(record=>({...original,record,components:record.payload.components,label:record.id===identity.id?original.label:items.find(item=>item.record.id===record.id)?.label,component:record.payload.components.find(c=>c.id===original.component?.id)||record.payload.components.find(c=>c.role==='original')||record.payload.components[0],review_context:data.materialContexts?.[record.id]||(record.id===identity.id?original.review_context:undefined),range:record.id===identity.id?original.range:null,crop:record.id===identity.id?original.crop:null}))}];
  });
  return [...models,...extra];
}
function materialRevisionIntent(){return null}
function materialCommentContext(){
  if(state.reviewReferenceContext)return null;
  const row=state.productionSelected;if(!isProduction()||!row)return null;
  const data=isEntityReview()?state.entityReview:state.materialReview,card=state.materialCommentCard,matches=[];
  for(const [mid,rounds] of Object.entries(materialVersions())){const selected=data?.selectedMaterialRounds?.[mid]||rounds[0]?.number;if(materialVersionCommentRows(rounds.find(r=>r.number===selected)).some(r=>r.id===row.id))matches.push({material_id:mid,number:selected,...(rounds.find(r=>r.number===selected)?.model==='plan-v1'?{model:'plan-v1'}:{})})}
  return matches.find(c=>card?.data===data&&c.material_id===card.material_id&&c.number===card.number)||matches.find(c=>c.material_id===data?.record?.object_id)||(matches.length===1?matches[0]:null);
}
function focusMaterialCommentCard(mid,number){
  cancelMaterialCommentLocation();
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
  const focus=()=>focusProductionReview({record,history:[record],uses:[]});pane.reviewFocus=()=>focusProductionReview({record,history:[record],uses:[]},false);pane.addEventListener('pointerdown',focus,true);pane.addEventListener('focusin',focus,true);
  if(component.mime.startsWith('image/')){
    pane.append(renderStructureVisual({...component,title:reviewPositionText(item.label||record.payload.title),alt:reviewPositionText(item.label||record.payload.title),description:`${component.width} × ${component.height}`},true));
    const stage=pane.querySelector('.structure-visual-stage');
    const viewport=pane.querySelector('.structure-visual-viewport');viewport.classList.add('material-image-frame');
    const fit=()=>{const width=viewport.clientWidth,height=viewport.clientHeight,ratio=(component.width||stage.querySelector('img').naturalWidth)/(component.height||stage.querySelector('img').naturalHeight);if(!ratio)return;const w=Math.min(width,height*ratio);stage.style.width=w+'px';stage.style.height=w/ratio+'px'};
    const observer=new ResizeObserver(()=>{if(!pane.isConnected){observer.disconnect();return}fit()});observer.observe(viewport);stage.querySelector('img').addEventListener('load',fit);requestAnimationFrame(fit);
    if(item.crop)stage.dataset.reviewCrop=JSON.stringify(item.crop);
  }else if(/^(audio|video)\//.test(component.mime))reviewMediaPlayer(pane,component,record,item);
  else nodeText('p','production-meta',component.id+' · '+component.mime,pane);
  if(!component.mime.startsWith('audio/'))link('下载原文件','/api/production/files/'+encodeURIComponent(component.file),pane);parent.append(pane);
}
function materialModelCode(model){return model.round?.business_code?.split(' / MV')[0]||businessCode(model.need||model.identity||model.candidates[0]?.record)}
function materialCompareControl(host,model){
  const choices=[];
  for(const round of model.rounds||[])for(const [index,row] of (round.results||[]).entries()){
    const component=row.payload.components.find(c=>c.role==='original');if(component)choices.push({round,record:row,component,label:'版本 '+round.number+' · 候选 '+(row.candidate_number||index+1)});
  }
  if(choices.length<2)return;
  productionButton(host,'比较两个候选',event=>{
    if(typeof pauseReviewMedia==='function')pauseReviewMedia();
    const {dialog,body}=openReviewDialog('同需求候选比较',event?.currentTarget||document.activeElement,'material-reference-dialog material-compare-dialog');
    const grid=el('div','material-compare-grid');body.append(grid);
    for(const side of [0,1]){
      const pane=el('section'),select=el('select'),content=el('div');select.setAttribute('aria-label',side?'右侧候选':'左侧候选');
      for(const [index,item] of choices.entries())select.append(new Option(item.label,String(index)));select.value=String(side);
      const draw=()=>{content.replaceChildren();const item=choices[Number(select.value)],component=item.component;
        nodeText('h3',null,item.label,content);nodeText('p',null,item.record.payload.title,content);
        const type=component.mime.split('/')[0];if(['image','audio','video'].includes(type)){
          const media=el(type==='image'?'img':type);media.src='/api/production/files/'+encodeURIComponent(component.file);if(type==='image')media.alt=item.label+' · '+item.record.payload.title;else {media.controls=true;media.addEventListener('play',()=>{for(const other of grid.querySelectorAll('audio,video'))if(other!==media)other.pause()})}content.append(media);
        }
        materialReferenceLink(content,productionRef(item.record),'审阅此准确候选');
        const plan=item.round.definition_records?.requirement?.payload.generation;
        if(plan){nodeText('h4',null,'本版检查要点',content);for(const text of plan.output?.review_criteria||[])nodeText('p',null,text,content)}
        nodeText('p','production-meta','此处切换只用于比较；参考选择和实际采用在对应操作中保存。',content);
      };
      select.onchange=()=>{for(const media of content.querySelectorAll('audio,video'))media.pause();draw()};pane.append(select,content);grid.append(pane);draw();
    }
    dialog.addEventListener('close',()=>{for(const media of grid.querySelectorAll('audio,video'))media.pause()},{once:true});
  });
}
function renderMaterialCard(parent,model,options={}){
  const box=el('article','material-card'),need=model.need;
  let items=model.candidates.map(item=>{
    const number=item.record.candidate_codes?.find(c=>c.material_id===model.material_id&&c.version===model.round?.number);
    return number?{...item,candidate_number:number.number,candidate_code:number.code}:item;
  });
  items=[...items].sort((a,b)=>(a.candidate_number||a.record.candidate_number||0)-(b.candidate_number||b.record.candidate_number||0));
  box.dataset.materialKey=need?.object_id||model.material_id||items[0].record.object_id;
  if(model.round){const focus=e=>{if(e?.target.closest('.material-reference,[data-review-dialog-trigger]'))return;focusMaterialCommentCard(model.material_id,model.round.number)};box.addEventListener('pointerdown',focus,true);box.addEventListener('focusin',focus,true)}
  const heading=el('div','entity-review-local-heading');nodeText('h3',null,businessTitle({...need||model.identity||items[0].record,material_code:materialModelCode(model)},need?.payload.generation?.output.name||need?.payload.title||model.identity?.payload.title||items[0].record.payload.title),heading);
  if(model.round)materialRoundControl(heading,model.material_id,model.rounds,model.round,options.roundChange);else if(need&&options.planVersion)options.planVersion(heading,need);box.append(heading);
  materialCompareControl(heading,model);
  if(need)renderProductionAcceptance(heading,need);
  renderMaterialRelations(box,model.material_id||need?.object_id);
  if(options.selectCandidate&&items.length){
    const chosen=materialCandidateChoice(items,options.selectedCandidateId);
    reviewChoiceButtons(box,'本轮候选',items.map((item,index)=>({id:item.record.id,label:'候选'+(item.candidate_number||item.record.candidate_number||index+1)})),chosen.record.id,options.selectCandidate);
    if(chosen.candidate_code||chosen.record.candidate_code)nodeText('small','business-code',chosen.candidate_code||chosen.record.candidate_code,box);items=[chosen];
  }
  if(options.selectedComponents)items=items.map(item=>{const component=item.components?.find(c=>c.id===options.selectedComponents[item.record.id]);return component?{...item,component}:item});
  if(need?.payload.status==='withdrawn')nodeText('p','production-meta','此素材需求已撤回',box);
  else if(!items.length)renderMaterialPlaceholder(box,need||model.identity);
  for(const item of items){
    const h=el('div','entity-review-local-heading');if(need||items.length>1)nodeText('h4',null,reviewPositionText(item.record.payload.title),h);
    if(!model.round)options.assetVersion?.(h,item);box.append(h);
    const previewable=(item.components||[]).filter(c=>/^(image|audio|video)\//.test(c.mime));
    if(!/^(image|audio|video)\//.test(item.component?.mime)&&previewable.length)item.component=previewable.find(c=>c.role==='original')||previewable[0];
    if(previewable.length>1){
      const select=el('select');select.setAttribute('aria-label','原件与预览组成');
      for(const c of previewable){const label=({original:'原件',preview:'预览',thumbnail:'缩略图'})[c.role]||'媒体';const peers=previewable.filter(v=>v.role===c.role);select.append(new Option(label+(peers.length>1?' '+(peers.indexOf(c)+1):''),c.id))};select.value=item.component.id;
      if(options.selectComponent&&!options.multipleCards)select.id='production-component';select.onchange=()=>{options.selectComponent?.(select.value,item.record.id)};box.append(select);
    }
    materialMedia(box,item);renderActualGeneration(box,item.review_context);
  }
  // A version owns one demand definition. Result associations are uses, not
  // interchangeable historical definitions for every related state.
  const definitionRecords=model.round?.definition_records;
  const requirement=definitionRecords?definitionRecords.requirement:need;
  if(requirement)renderMaterialRequirements(box,requirement);
  else if(definitionRecords)nodeText('p','production-meta','此版本未保留完整素材要求。',box);
  if(!items.length&&need)renderGenerationRecipe(box,need,!!requirement);
  else if(!items.length&&model.round?.model==='plan-v1'){
    const call=model.round.members.find(r=>r.kind==='CALL');
    if(call){renderActualGeneration(box,{call,inputs:call.review_input_records||[]});nodeText('p','production-meta','此版本有调用记录，尚无已确认的原件结果。',box)}
    else nodeText('p','production-meta','此版本的历史方案未记录完整。',box);
  }
  parent.append(box);if(typeof renderShotReferenceChoice==='function')renderShotReferenceChoice(box,model,items[0]);return box;
}
function renderMaterialWorkspace(root,detail){
  if(detail.record.kind==='REQUIREMENT')return renderMaterialDemand(root,detail);
  const r=detail.record,component=r.payload.components.find(c=>c.id===(detail.selectedComponents?.[r.id]||detail.componentId))||r.payload.components.find(c=>c.role==='original')||r.payload.components[0];
  const entries=Object.entries(detail.material_versions||{}),card=state.materialCommentCard;
  const [mid,rounds]=(card?.data===detail&&entries.find(([mid])=>mid===card.material_id))||entries[0]||[];
  // An asset opened from the index is already an exact result. Its material may
  // have newer rounds containing different assets; retain this result on entry.
  let round;if(rounds?.length){const number=detail.selectedMaterialRounds?.[mid]||Number(new URL(location.href).searchParams.get(materialVersionParam(detail)));if(number&&!rounds.some(v=>v.number===number))throw Error('准确素材版本不存在；未替换为最新版本');round=rounds.find(v=>v.number===number)||rounds.find(v=>v.members.some(m=>m.id===r.id))||rounds[0]}
  if(round){detail.selectedMaterialRounds||={};detail.selectedMaterialRounds[mid]=round.number;const url=new URL(location.href);writeMaterialVersionRoute(url.searchParams,mid,round);history.replaceState(history.state,'',url)}
  if(round&&round.plan&&detail.localPlans?.[round.plan.object_id]&&round.members.some(r=>r.id===detail.localPlans[round.plan.object_id].id))round={...round,plan:detail.localPlans[round.plan.object_id]};
  const allCandidates=round?materialRoundResults(round,r,detail.explicitRevision).map(row=>{const c=row.payload.components.find(c=>c.id===(detail.selectedComponents?.[row.id]||(row.id===r.id?detail.componentId:null)))||row.payload.components.find(c=>c.role==='original')||row.payload.components[0];return {record:row,component:c,components:row.payload.components,review_context:detail.review_contexts?.[row.id]||(row.id===r.id?detail.review_context:null)}}):[{record:r,component,components:r.payload.components,review_context:detail.review_context}];
  const candidateTarget=detail.selectedCandidateId||new URL(location.href).searchParams.get('material_target')||r.id,candidates=materialExactCandidates(detail,allCandidates,candidateTarget,round);
  renderMaterialCard(root,{need:round?.plan||null,identity:r,candidates,round,rounds,material_id:mid},{
    ...materialCandidateOptions(detail,candidates),
    selectedCandidateId:candidateTarget,
    roundChange:number=>{switchMaterialRound(detail,mid,number);const url=new URL(location.href);writeMaterialVersionRoute(url.searchParams,mid,rounds.find(r=>r.number===number));history.replaceState(history.state,'',url);renderProductionReader();renderComments();focusMaterialRoundControl(mid)},
    relatedPlans:round?[]:detail.review_context?.requirements||[],
    assetVersion:(parent,item)=>{if(detail.history.length<2)return;const select=el('select','entity-review-version');select.setAttribute('aria-label',reviewPositionText(r.payload.title)+'的版本');for(const v of detail.history)select.append(new Option(`记录修订 ${v.version}${v.id===v.current_revision?' · 当前':''}`,v.id));select.value=r.id;select.onchange=()=>openProductionRecord(r.object_id,select.value);parent.append(select)},
    selectComponent:(id,revision)=>{detail.selectedComponents||={};detail.selectedComponents[revision]=id;renderProductionReader();document.querySelector('#production-component')?.focus({preventScroll:true})}
  });
  const displayed=materialCandidateChoice(candidates,candidateTarget)?.record;
  if(displayed?.payload.blocks?.length){nodeText('h3',null,'生成结果自检',root);reviewTextBlocks(root,displayed)}
  if(!displayed)return;
  const uses=el('section');nodeText('h3',null,'关联用途',uses);
  for(const item of displayed.payload.state_coverage||[]){productionRefLink(uses,item.state);nodeText('p',null,item.detail,uses)}
  root.append(uses);
  const actions=el('div','production-toolbar');
  const activate=fn=>()=>{focusProductionReview({record:displayed,history:detail.history,uses:detail.uses});return fn()};
  if(!round&&detail.history.length>1)productionButton(actions,'并排比较版本',activate(()=>showProductionCompare(root)));
  productionButton(actions,'记录本版本审阅结论',activate(()=>showProductionJudgment(root)));
  root.append(actions);
  const requirement=detail.adoptionContext?.requirements?.find(need=>need.object_id===mid);
  if(requirement&&typeof renderMaterialAdoptionControls==='function')renderMaterialAdoptionControls(root,{...detail,record:requirement,candidate_records:candidates.map(item=>item.record)});
}
let materialCommentLocation=null;
function cancelMaterialCommentLocation(){
  const pending=materialCommentLocation;materialCommentLocation=null;
  // Invalidate only our own pending read, never a newer navigation's request.
  if(pending?.loading&&pending.epoch===productionReadEpoch)++productionReadEpoch;
}
function selectCommentMaterialRound(data,row,comment,materialId=null){
  if(comment.material_scopes?.length&&data.legacy_material_versions)data.material_versions=data.legacy_material_versions;
  const versions=data.material_versions||{},scopes=comment.material_plan_scopes?.length?comment.material_plan_scopes:comment.material_scopes||[];
  if(scopes.length){
    const matches=scopes.filter(scope=>versions[scope.material_id]);
    const card=state.materialCommentCard;
    const selected=materialId?scopes.find(scope=>scope.material_id===materialId):matches.find(scope=>card?.data===data&&scope.material_id===card.material_id)||matches.find(scope=>scope.material_id===data.record?.object_id)||matches.find(scope=>row.kind==='REQUIREMENT'&&scope.material_id===row.object_id)||(matches.length===1?matches[0]:null);
    if(!selected){toast(matches.length?'这条评论关联多个素材，请先选择对应素材卡再定位。':'原评论的素材版本当前无法准确定位；评论仍保留。');return false}
    if(!versions[selected.material_id]?.some(round=>round.number===selected.number&&materialVersionCommentRows(round).some(member=>member.id===row.id))){toast('原评论的素材版本当前无法准确定位；评论仍保留。');return false}
    data.selectedMaterialRounds||={};data.selectedMaterialRounds[selected.material_id]=selected.number;
    state.materialCommentCard={data,material_id:selected.material_id,number:selected.number};
  }else{
    // Legacy opinions lack an exact round: retain a compatible current view,
    // otherwise use the existing revision-based fallback without writing history.
    for(const [mid,rounds] of Object.entries(versions)){
      const matches=rounds.filter(round=>materialVersionCommentRows(round).some(member=>member.id===row.id));
      const round=matches.find(round=>round.number===data.selectedMaterialRounds?.[mid])||matches[0];
      if(round){data.selectedMaterialRounds||={};data.selectedMaterialRounds[mid]=round.number}
    }
  }
  return true;
}
async function locateMaterialComment(comment){
  cancelMaterialCommentLocation();
  const request={workspace:state.workspace,loading:false,epoch:null};materialCommentLocation=request;
  const current=()=>materialCommentLocation===request&&state.workspace===request.workspace&&(request.epoch===null||request.epoch===productionReadEpoch);
  try{
    let detail=state.materialReview,row=detail&&materialRows(detail).find(r=>r.id===comment.target_revision_id);if(!row)return false;
    const card=state.materialCommentCard,materialId=card?.data===detail&&(comment.material_plan_scopes?.length?comment.material_plan_scopes:comment.material_scopes)?.some(scope=>scope.material_id===card.material_id)?card.material_id:null;
    const asset=row.kind==='ASSET'&&row.id!==detail.record.id?row:row.kind==='CALL'&&row.id!==detail.review_context?.call?.id?detail.history.find(r=>r.payload.production?.revision_id===row.id):null;
    if(asset){
      request.loading=true;const opening=openProductionRecord(asset.object_id,asset.id);request.epoch=productionReadEpoch;
      await opening;request.loading=false;
      if(!current())return false;
      detail=state.materialReview;row=detail&&materialRows(detail).find(r=>r.id===comment.target_revision_id);
      if(!row||detail.record.id!==asset.id)return false;
    }
    if(!current()||!selectCommentMaterialRound(detail,row,comment,materialId))return false;
    if(row.kind==='ASSET'&&(comment.anchor.component_id||comment.anchor.visual_id)){detail.selectedComponents||={};detail.selectedComponents[row.id]=comment.anchor.component_id||comment.anchor.visual_id;if(row.id===detail.record.id)detail.componentId=detail.selectedComponents[row.id]}
    if(row.kind==='REQUIREMENT'){detail.localPlans||={};detail.localPlans[row.object_id]=row}
    state.reviewCommentScope=null;focusProductionReview({record:row,history:[row],uses:[]},false);state.selected=comment.id;renderProductionReader();if(materialPlanCommentNeedsHistory(row,comment))await openMaterialPlanHistory(row,comment);else locateProductionComment(comment,true);return true;
  }catch(error){if(current())toast(error.message);return false}
  finally{if(materialCommentLocation===request)materialCommentLocation=null}
}

// Preview exact references without changing the reader, selection, or draft.
let materialReferenceCount=0;
function materialReferenceRequest(ref,source=null){
  if(!ref?.object_id||!ref?.revision_id)throw Error("剧情依据缺少准确对象或修订，未替换为最新剧本");
  // Story revisions share exact references with production records, but have a
  // separate reader that validates the cited scene and limits the text blocks.
  const known=(state.productionRecords||[]).find(r=>r.object_id===ref.object_id);
  const isSource=!!(source===true||source==='full_scene'||source==='scene_script'||['EPISODE','SOURCE','STORY'].includes(known?.kind)||ref.scene_id||ref.block_ids?.length||source===null&&!(state.productionRecords||[]).some(r=>r.object_id===ref.object_id));
  const query=new URLSearchParams({object_id:ref.object_id,revision_id:ref.revision_id});
  if(isSource){if(source==='full_scene'||source==='scene_script')query.set('full_scene','1');if(ref.scene_id)query.set('scene_id',ref.scene_id);if(source!=='scene_script'&&ref.block_ids?.length)query.set('block_ids',ref.block_ids.join(','))}
  return {isSource,url:'/api/production'+(isSource?'/source':'')+'?'+query};
}
function materialReferenceLink(parent,ref,title,source=false){
  const button=productionButton(parent,reviewPositionText(title),()=>openMaterialReference(ref,button,source));
  button.classList.add('material-reference','review-reference-button');button.setAttribute('aria-haspopup','dialog');button.addEventListener('pointerdown',e=>e.stopPropagation());button.addEventListener('focusin',e=>e.stopPropagation());return button;
}
function materialPlanCommentNeedsHistory(row,comment){
  if(row.kind!=='REQUIREMENT'||!row.payload.generation||comment.anchor.type!=='text')return false;
  const block=productionTextBlocks(row).find(b=>b.id===comment.anchor.block_id);
  return !!block&&/^generation\.(model|parameters|prompt|tool|inputs\.)/.test(block.field||'')&&!document.querySelector(`[data-production-blocks="${CSS.escape(row.id)}"] [data-block-id="${CSS.escape(block.id)}"]`);
}
async function openMaterialPlanHistory(row,comment=null){
  const {dialog,body}=openReviewDialog('原方案 · '+reviewPositionText(row.payload.title),document.activeElement,'material-reference-dialog');
  try{
    const detail=await api('/api/production?'+new URLSearchParams({object_id:row.object_id,revision_id:row.id}));if(!dialog.isConnected)return;
    const session=referenceReviewSession(dialog,detail);dialog.reviewFocus=session.focus;
    renderGenerationRecipe(body,detail.record);paintReviewCommentCounts();
    if(comment){session.focus();state.selected=comment.id;const block=body.querySelector(`[data-block-id="${CSS.escape(comment.anchor.block_id||'')}"]`),surface=block?.closest('.review-surface')||body.querySelector('.review-surface');state.reviewCommentScope=reviewBlockScope(surface,'text');openPanel();renderComments();surface.querySelector(`[data-block-id="${CSS.escape(comment.anchor.block_id||'')}"]`)?.scrollIntoView({block:'center'})}
  }catch(error){if(dialog.isConnected)nodeText('p','error',error.message,body)}
}
function referenceReviewSession(dialog,detail){
  const fields=['productionSelected','productionDetail','anchor','editing','selected','reviewCommentScope','pending','drawMode','suggestion','preview','previewExpanded','materialCommentCard','reviewReferenceContext','historyOpen','historyLimit'];
  const previous=Object.fromEntries(fields.map(key=>[key,state[key]])),panel=document.querySelector('#comment-panel'),parent=panel.parentNode,next=panel.nextSibling,hidden=panel.hidden;
  const focus=()=>{
    if(state.reviewReferenceContext?.dialog!==dialog){
      for(const key of ['anchor','editing','selected','reviewCommentScope','pending','drawMode','suggestion','preview'])state[key]=null;
      state.previewExpanded=false;
    }
    state.reviewReferenceContext={dialog,record:detail.record};state.productionSelected=detail.record;state.productionDetail=detail;
    if(panel.parentNode!==dialog)dialog.append(panel);
  };
  const locate=comment=>{focus();state.selected=comment.id;[...dialog.querySelectorAll('.review-media-player')].find(box=>box.dataset.reviewFile===comment.anchor.asset_file&&box.querySelector('[data-component-id]')?.dataset.componentId===comment.anchor.component_id)?.reviewLocate(comment.anchor);paintProductionReview();renderComments()};
  dialog.addEventListener('close',()=>{
    parent.insertBefore(panel,next?.parentNode===parent?next:null);Object.assign(state,previous);panel.hidden=hidden;
    paintProductionReview();renderComments();setPanelOpen(!hidden);
  },{once:true});
  return {focus,locate};
}
async function openMaterialReference(ref,trigger,source=false){
  const {dialog,title,body}=openReviewDialog(source?'剧情依据':'参考输入',trigger,'material-reference-dialog');
  nodeText('p',null,'读取中…',body);
  try{
    const request=materialReferenceRequest(ref,source);
    const detail=await api(request.url);
    if(!dialog.isConnected)return;
    if(request.isSource){
      body.replaceChildren();body.dataset.referenceRevision=detail.reference.revision_id;
      const version=detail.screenplay?.title?.match(/^(?:剧本|版本)\s*([一二三四五六七八九十百零〇\d]+)/u);
      title.textContent=(source==='full_scene'||source==='scene_script'?'查看剧本':'剧情依据')+' · '+(version?'版本'+version[1]+' · ':'')+reviewPositionText(detail.title);
      body.dataset.referenceScene=detail.scene?.id||'';
      if(detail.scene)nodeText('h3',null,reviewPositionLabel('scene',detail.scene,detail.reference.object_id)+' · '+String(detail.scene.heading||detail.scene.title||detail.scene.id).replace(/^\d+-\d+\s*/,''),body);
      const highlighted=new Set(source==='scene_script'?[]:detail.highlight_block_ids||[]);
      for(const block of detail.blocks){const line=nodeText('p','reference-text',block.text,body);line.dataset.referenceBlock=block.id;if(highlighted.has(block.id)){line.classList.add('reference-highlight');line.setAttribute('aria-label','本镜剧情依据')}}
      if(source!=='scene_script'&&detail.full_scene&&!(ref.block_ids?.length))nodeText('p','production-issue','本镜未登记准确正文块引用；未高亮其他文字',body);
      body.querySelector('.reference-highlight')?.scrollIntoView({block:'center'});
      return;
    }
    const row=detail.record,p=row.payload;body.replaceChildren();const versions=[...new Set(Object.values(detail.material_versions||{}).flatMap(rs=>rs.filter(r=>r.members.some(m=>m.id===row.id)).map(r=>r.number)))];title.textContent=businessTitle(row)+' · '+(versions.length===1?'素材版本 '+versions[0]:'记录修订 '+row.version);body.dataset.referenceRevision=row.id;
    if(row.kind==='ASSET'){
      const components=ref.component_id?p.components.filter(c=>c.id===ref.component_id):p.components.filter(c=>c.role==='original');
      const session=components.some(c=>/^(audio|video)\//.test(c.mime))?referenceReviewSession(dialog,detail):null;
      if(!components.length)throw new Error('引用的文件组成不存在');
      for(const c of components){
        const url='/api/production/files/'+encodeURIComponent(c.file);
        if(c.mime.startsWith('image/')){const img=el('img');img.src=url;img.alt=reviewPositionText(p.title);img.tabIndex=0;img.setAttribute('role','button');img.setAttribute('aria-label','放大查看：'+reviewPositionText(p.title));img.setAttribute('aria-haspopup','dialog');const show=()=>openStructureImage({...c,title:reviewPositionText(p.title),alt:reviewPositionText(p.title)},img);img.onclick=show;img.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();show()}};if(ref.crop){const frame=el('div','reference-crop-frame'),region=el('div','reference-crop');frame.append(img,region);const c=ref.crop;Object.assign(region.style,{left:c.x*100+'%',top:c.y*100+'%',width:c.width*100+'%',height:c.height*100+'%'});region.setAttribute('aria-label','参考裁切范围');body.append(frame)}else body.append(img)}
        else if(/^(audio|video)\//.test(c.mime)){
          reviewMediaPlayer(body,c,row,ref,true,session);
          nodeText('p','production-meta',(c.role==='original'?'原件':'预览')+(ref.range?` · ${ref.range.start_seconds}–${ref.range.end_seconds} 秒`:''),body);
        }
        if(!c.mime.startsWith('audio/'))link('下载原文件',url,body);
      }

    }
    for(const b of (p.blocks||[]).filter(b=>!ref.block_ids?.length||ref.block_ids.includes(b.id)))nodeText('p','reference-text',b.text,body);
    if(row.kind==='REQUIREMENT')nodeText('p','production-issue','此引用是尚未产出准确原件的素材需求',body);
    if(p.generation){nodeText('h3',null,'参数 · '+(p.generation.model||'模型未知'),body);nodeText('pre',null,row.review_parameter_text||JSON.stringify(p.generation.parameters,null,2),body);renderMaterialInputs(body,p.generation.inputs||[],row.review_input_records||[]);nodeText('h3',null,'提示词',body);nodeText('pre',null,p.generation.prompt,body)}
    paintReviewCommentCounts();
  }catch(error){if(dialog.isConnected){body.replaceChildren();nodeText('p','error',error.message,body)}}
}

// A demand is a real REQUIREMENT, never a fabricated ASSET. Round data comes
// from the shared material version contract when available.
function renderMaterialDemand(root,detail){
  const r=detail.record,[mid,rounds]=Object.entries(detail.material_versions||{})[0]||[];
  const selected=detail.selectedMaterialRounds?.[mid]||Number(new URL(location.href).searchParams.get(materialVersionParam(detail)));
  if(selected&&!rounds?.some(v=>v.number===selected))throw Error('准确素材版本不存在；未替换为最新版本');
  const round=rounds?.find(v=>v.number===selected)||(detail.explicitRevision?rounds?.find(v=>v.members.some(m=>m.id===r.id)):null)||materialDefaultRound(rounds);
  if(round){detail.selectedMaterialRounds||={};detail.selectedMaterialRounds[mid]=round.number;const url=new URL(location.href);writeMaterialVersionRoute(url.searchParams,mid,round);history.replaceState(history.state,'',url)}
  const local=detail.localPlans?.[r.object_id];
  const need=local&&round?.members.some(m=>m.id===local.id)?local:round?.plan||(round?.model==='plan-v1'&&round.frozen?null:r);
  const results=round?.results||(detail.candidate_records||[]).filter(a=>a.payload.candidate_requirements?.some(ref=>ref.revision_id===r.id));
  const allCandidates=results.filter(a=>!a.payload.placeholder).map(record=>({record,component:record.payload.components.find(c=>c.id===detail.selectedComponents?.[record.id])||record.payload.components.find(c=>c.role==='original')||record.payload.components[0],components:record.payload.components,review_context:detail.review_contexts?.[record.id]})).filter(i=>i.component);
  const candidates=materialExactCandidates(detail,allCandidates,detail.selectedCandidateId||new URL(location.href).searchParams.get('material_target'),round);
  renderMaterialCard(root,{need,identity:r,candidates,round,rounds,material_id:mid},{
    ...materialCandidateOptions(detail,candidates),
    roundChange:number=>{switchMaterialRound(detail,mid,number);const url=new URL(location.href);writeMaterialVersionRoute(url.searchParams,mid,rounds.find(r=>r.number===number));history.replaceState(history.state,'',url);renderProductionReader();renderComments();focusMaterialRoundControl(mid)},
    planVersion:(parent,row)=>{if(rounds?.length||detail.history.length<2)return;const select=el('select','entity-review-version');select.setAttribute('aria-label',reviewPositionText(row.payload.title)+'的版本');for(const v of detail.history)select.append(new Option(`记录修订 ${v.version}${v.id===v.current_revision?' · 当前':''}`,v.id));select.value=row.id;select.onchange=()=>openProductionRecord(row.object_id,select.value);parent.append(select)},
    selectComponent:(id,revision)=>{detail.selectedComponents||={};detail.selectedComponents[revision]=id;renderProductionReader();document.querySelector('#production-component')?.focus({preventScroll:true})}
  });
  if(need)productionRefLink(root,need.payload.scope,'适用范围：'+productionName(need.payload.scope));
  if(typeof renderMaterialAdoptionControls==='function')renderMaterialAdoptionControls(root,detail);
}

function materialVersionParam(data){return Object.values(data?.material_versions||{}).some(rs=>rs.some(r=>r.model==='plan-v1'))?'material_version':'material_round'}
function writeMaterialVersionRoute(params,mid,round){
  params.set('material_id',mid);params.delete(round.model==='plan-v1'?'material_round':'material_version');
  params.set(round.model==='plan-v1'?'material_version':'material_round',round.number);
  if(round.baseline_id)params.set('material_baseline',round.baseline_id);else params.delete('material_baseline');
}
function normalizeConsolidatedMaterialRoute(params,versions){
  const parameter=params.has('material_round')?'material_round':'material_version',mid=params.get('material_id');
  const sets=Object.entries(versions||{}).filter(([id])=>!mid||id===mid),rounds=sets.flatMap(([,rs])=>rs),baseline=rounds.find(r=>r.baseline_id);
  if(!baseline||!params.has(parameter))return;
  const number=Number(params.get(parameter));
  if(params.has('material_baseline')){
    if(params.get('material_baseline')!==baseline.baseline_id)throw Error('素材版本基线已失效，请重新选择。');
  }else{
    if(parameter==='material_round'||sets.length!==1||!baseline.previous_numbers?.[number])throw Error('此准确素材版本已删除；原链接不可用，请重新选择。');
    params.set(parameter,baseline.previous_numbers[number]);params.set('material_baseline',baseline.baseline_id);
  }
}
