/* Episode / scene navigation and all-shot rows share one exact context reader. */
let breakdownEpoch=0,breakdownSelectionEpoch=0;
function invalidateBreakdownReads(){++breakdownEpoch;++breakdownSelectionEpoch}
function renderAudiovisualSources(host,row){
  const sources=row.payload.sources||[];
  for(const [index,source] of sources.entries())materialReferenceLink(host,source,'故事依据'+(sources.length>1?' '+(index+1):''),'full_scene');
}
function renderAudiovisualDesign(host,row,companions=[],alreadyRead=[]){
  if(renderRecordComposition(host,row,companions,alreadyRead))return true;
  const surface=materialTextSurface(host,row),labels={purpose:'叙事目的',structure:'编排与拆镜理由',rhythm:'节奏',continuity:'连续性',preserve:'保留',change:'允许变化',check:'检查方式'};
  for(const block of productionTextBlocks(row)){
    if(alreadyRead.includes(block.text))continue;
    if(row.kind==='AV_SCENE'&&['spatial','axis','lighting','color','sound'].includes(block.field))continue;
    const line=el('p');if(labels[block.field])nodeText('b',null,labels[block.field]+'　',line);
    nodeText('span',null,block.text,line).dataset.blockId=block.id;surface.append(line);
  }
}
const productionAcceptancePanels=new Set();
async function renderProductionAcceptance(host,row){
  if(state.reviewWork&&row?.kind==='REQUIREMENT'){const button=productionButton(host,'决定此素材方案的生成许可',()=>openUnifiedMaterial({...productionRef(row),work:null},button));return}
  if(!row||!['AV_EPISODE','AV_SCENE','AV_SHOT','REQUIREMENT','MATERIAL_RELATION'].includes(row.kind))return;
  const box=el('div','production-toolbar production-acceptance');host.append(box);
  let data,serial=0;
  const refresh=async()=>{const token=++serial;try{
    const next=await api('/api/production/acceptance?'+new URLSearchParams({object_id:row.object_id,revision_id:row.id}));
    if(box.isConnected&&token===serial){data=next;draw()}
  }catch(error){if(box.isConnected&&token===serial){box.replaceChildren();nodeText('p','production-issue',error.message,box)}}};
  const entry={box,refresh};
  productionAcceptancePanels.add(entry);
  Promise.resolve().then(()=>{for(const panel of productionAcceptancePanels)if(!panel.box.isConnected)productionAcceptancePanels.delete(panel)});
  const draw=()=>{box.replaceChildren();
    const button=productionButton(box,data.accepted?'取消认可':row.kind==='REQUIREMENT'?'认可此制作方案':'认可此设计',async()=>{
      if(!box.isConnected||button.disabled)return;
      button.disabled=true;++serial;
      try{const next=await api('/api/production/acceptance',{method:'POST',body:JSON.stringify({object_id:row.object_id,expected_revision:row.id,expected_decision:data.decision?productionRef(data.decision):null,action:data.accepted?'revoke':'accept',actor:'用户'})});if(box.isConnected){data=next;draw()}
        for(const panel of productionAcceptancePanels){if(!panel.box.isConnected)productionAcceptancePanels.delete(panel);else if(panel!==entry)panel.refresh()}
      }catch(error){if(box.isConnected){button.disabled=false;toast(error.message);refresh()}}
    });button.disabled=!data.can_change;
    if(!data.can_change)nodeText('small','production-meta','历史版本',box);
    else if(data.partial)nodeText('small','production-meta','部分子项已采纳',box);
    const info=el('section','decision-scope');
    if(row.kind==='REQUIREMENT')nodeText('p',null,'仅认可此素材方案；也可沿所属状态的整体生成许可执行。原件及结果另行判断。',info);
    if(row.kind!=='AV_SHOT')renderDecisionScope(info,data.scope,data.scope_records||[]);
    if(data.decision){nodeText('p',null,'涉及本版的最新决定：'+reviewDecisionLabel(data.decision)+' · '+data.decision.payload.actor+' · '+reviewDecisionTime(data.decision.created_at),info);nodeText('p',null,data.decision.payload.reason,info)}
    renderDecisionHistory(info,data.history||[]);
    box.append(info);
  };
  await refresh();
}

function renderAudiovisualEdition(host,data){
  if(!data.design)return;
  const box=el('section','audiovisual-edition');nodeText('h3',null,data.design.payload.title,box);
  const versions=el('select');versions.setAttribute('aria-label','视听集设计版本');
  for(const version of data.versions||[])versions.append(new Option('版本 '+version.version,version.id));versions.value=data.design.id;
  versions.onchange=()=>{
    const params=new URL(location.href).searchParams;
    // Keep identity, resolve its revision only inside the selected edition.
    breakdownNavigate({breakdown_episode:data.design.object_id,breakdown_episode_revision:versions.value,breakdown_object:params.get('breakdown_object')||data.design.object_id,breakdown_revision:null});
  };box.append(versions);
  renderAudiovisualSources(box,data.design);renderAudiovisualDesign(box,data.design);host.append(box);renderProductionAcceptance(box,data.design);
}
function renderShotDemands(host,context,onReading=null){
  const needs=context.requirements||[];if(!needs.length){nodeText('p','production-meta','本镜尚无素材需求',host);return}
  const section=el('section','shot-demands'),select=el('select'),body=el('div');select.setAttribute('aria-label','本镜素材需求');
  for(const need of needs)select.append(new Option(readableProductionTitle(need),need.object_id));
  const routed=new URL(location.href).searchParams.get('shot_material_id');
  select.value=(needs.find(r=>r.object_id===routed)||needs.find(r=>r.payload.media_type==='video')||needs[0]).object_id;
  const draw=()=>{body.replaceChildren();const need=needs.find(r=>r.object_id===select.value);breakdownPrompt(body,need,context,onReading);renderMaterialRelations(body,need.object_id,need);restoreBreakdownPromptDraft(body)};
  select.onchange=()=>{rememberProductionDraft();breakdownRoute({shot_material_id:select.value,shot_plan:null,shot_candidate:null});draw()};
  section.append(select,body);host.append(section);draw();
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
      if(['已有形象','旧备选'].includes(label))nodeText('p','production-meta','供本需求比较，尚未选用；旧原件的认可仅适用于原件。',section);
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
          const original=target,component=image(row);materialMedia(line,{record:original,component,components:original.payload.components});renderMaterialResultReview(line,original,{});
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
const breakdownShotLabels={purpose:'叙事目的',framing:'构图',spatial:'空间',axis:'轴线与方向',movement:'机位运动',performance:'表演',lighting:'光线',color:'色彩',editing:'剪辑',action_start:'起始',action_end:'结束',motion:'动作过程',continuity:'承接'};
function breakdownShotFields(shot){
  const blocks=productionTextBlocks(shot);
  return Object.entries(breakdownShotLabels).map(([key,label])=>{
    const value=shot.payload[key],block=blocks.find(b=>b.field===key||b.id===key)||blocks.find(b=>b.text===value);
    // A legacy projection can omit an independent substring. Read its full
    // value without assigning another field's text anchor to it.
    return {key,label,value,block:block?.text===value?block:null};
  }).filter(item=>typeof item.value==='string'&&item.value.trim());
}
function breakdownCommonConditions(items){
  const shots=items.map(item=>item.record),fields={},sounds=[],shared=[];
  if(shots.length<2)return {fields,sounds};
  for(const key of ['spatial','axis','lighting','color','continuity']){
    const value=shots[0].payload[key];
    if(typeof value==='string'&&value.trim()&&shots.every(shot=>shot.payload[key]===value))fields[key]=value;
    const groups=new Map();for(const shot of shots){const text=shot.payload[key];if(typeof text!=='string'||!text.trim())continue;if(!groups.has(text))groups.set(text,[]);groups.get(text).push(shot)}
    for(const [text,group] of groups)if(group.length>1)shared.push({key,value:text,shots:group});
  }
  // Equal dialogue can be an intentional repeated event. Only an explicitly
  // typed background sound may move out of the individual shot's sequence.
  const background=shot=>(shot.payload.sound||[]).filter(item=>item&&typeof item==='object'&&['ambience','environment','music'].includes(item.type)).map(item=>item.text||item.description).filter(Boolean);
  for(const value of background(shots[0]))if(!sounds.includes(value)&&shots.every(shot=>background(shot).includes(value)))sounds.push(value);
  return {fields,sounds,...(shared.length?{shared}:{})};
}
function breakdownFieldLine(host,item,label=item.label){
  const line=el('p');nodeText('b',null,label+'　',line);const span=nodeText('span',null,item.value,line);
  if(item.block)span.dataset.blockId=item.block.id;host.append(line);return span;
}
function breakdownReadingConditions(data,composedScene,sceneText,sceneRead=[]){
  const common={...breakdownCommonConditions(data.shots),sceneId:data.scene.id,composedScene,sceneText,sceneRead};
  if(composedScene===true){
    const shown=(row,value)=>!row.review_composition||row.review_composition.sections.some(section=>section.parts.some(part=>part.text===value));
    common.fields=Object.fromEntries(Object.entries(common.fields).filter(([key,value])=>data.shots.every(item=>shown(item.record,value))));
    common.shared=(common.shared||[]).filter(group=>group.shots.every(row=>shown(row,group.value)));
  }
  return common;
}
function renderBreakdownConditions(host,data,common){
  const scene=data.scene,box=el('section','breakdown-conditions');
  const seen=new Set();
  const add=(row,field,value,label)=>{if(!value||seen.has(value)||common.sceneText?.includes(value))return;seen.add(value);const surface=materialTextSurface(box,row),block=productionTextBlocks(row).find(b=>b.field===field&&b.text===value);breakdownFieldLine(surface,{value,label,block})};
  if(!common.composedScene)for(const key of ['spatial','axis','lighting','color'])add(scene,key,scene.payload[key],breakdownShotLabels[key]);
  const sceneSound=Array.isArray(scene.payload.sound)?scene.payload.sound:[scene.payload.sound];
  for(const sound of sceneSound)add(scene,'sound',typeof sound==='string'?sound:sound?.text||sound?.description,'声音');
  for(const [key,value] of Object.entries(common.fields)){if(key==='continuity'&&scene.payload.continuity===value)continue;add(data.shots[0].record,key,value,breakdownShotLabels[key])}
  for(const value of common.sounds)add(data.shots[0].record,'sound',value,'声音');
  for(const group of common.shared||[]){if(seen.has(group.value)||common.sceneText?.includes(group.value))continue;add(group.shots[0],group.key,group.value,breakdownShotLabels[group.key]);if(group.shots.length!==data.shots.length)nodeText('small','production-meta','适用镜头：'+group.shots.map(businessCode).join('、'),box)}
  if(box.childElementCount)host.append(box);
}

function breakdownShotText(parent,shot,common={fields:{},sounds:[]},coveredVoices=[],companions=[]){
  const shared=(common.shared||[]).filter(group=>group.shots.some(row=>row.id===shot.id)).map(group=>group.value);
  if(renderRecordComposition(parent,shot,companions,[...Object.values(common.fields),...shared,...(common.sceneRead||[])]))return true;
  const blocks=productionTextBlocks(shot),fields=breakdownShotFields(shot),byKey=new Map(fields.map(item=>[item.key,item]));
  const text=reviewSurface(el('div'));text.dataset.productionBlocks=shot.id;text.reviewFocus=()=>{state.breakdownReviewFocus=(state.breakdownReviewFocus||0)+1;focusProductionReview(entityReviewDetail(shot),false)};text.onpointerdown=text.reviewFocus;text.onfocusin=text.reviewFocus;parent.append(text);
  const original=[],shown=new Set();
  for(const item of fields){
    const {key,value,block}=item,pair={purpose:'performance',framing:'movement',performance:'purpose',movement:'framing'}[key],other=byKey.get(pair),same=other&&value===other.value;
    if(same&&['performance','movement'].includes(key)){
      if(block&&block.id!==other.block?.id)original.push(item);
      continue;
    }
    if(common.fields[key]===value||common.sceneText?.includes(value)||(common.shared||[]).some(group=>group.key===key&&group.value===value&&group.shots.some(row=>row.id===shot.id))){original.push(item);continue}
    breakdownFieldLine(text,item,same?{purpose:'叙事目的与表演',framing:'构图与机位运动'}[key]:item.label);
    if(block)shown.add(block.id);
  }
  const sounds=blocks.filter(b=>/^sound\.\d+\.(text|description)$/.test(b.field||''));
  for(const block of sounds){
    const item={key:block.field,label:'声音',value:block.text,block};
    const source=shot.payload.sound[Number(block.field.split('.')[1])],background=source&&typeof source==='object'&&['ambience','environment','music'].includes(source.type);
    if(coveredVoices.includes(block.text)||(background&&common.sounds.includes(block.text))||(typeof source==='string'&&shot.payload.editing===block.text))original.push(item);
    else breakdownFieldLine(text,item);
  }
  const unique=original.filter((item,index)=>!item.block||!shown.has(item.block.id)&&original.findIndex(other=>other.block?.id===item.block.id)===index);
  // Exact duplicated fields stay in the immutable record and comment reader.

}
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
  const params=new URLSearchParams({material_id:slot.material_id,...(slot.number?{material_version:slot.number}:{}),...(slot.baseline_id?{material_baseline:slot.baseline_id}:{}),...(slot.candidate?{material_target:slot.candidate.revision_id}:{})});
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
function renderShotInputs(host,row,inputs,records,context){
  const items=shotReferenceItems(row,inputs,records);if(!items.length)return;
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
      const card=materialSmallCard(line,{...r,version_count:item.slot.version_count,candidate_count:item.slot.candidate_count,object_id:item.slot.material_id||r.object_id,material_code:item.slot.material_code,business_code:item.slot.material_code||r.business_code,title,media_type:r.payload.media_type,generated:!!item.slot.candidate,preview:component},trigger=>openShotReference(item,context,trigger),false,{subtitle:selectionLabel+range+(item.slot.direct===false?' · 间接':'')+(issues.length?' · '+issues.join('；'):'')});card.dataset.reviewDialogTrigger='';card.setAttribute('aria-label',card.textContent+'；'+owner);card.title+=` · ${owner}：${shotReferenceLabel(item.slot)}；V 为素材版本，C 为该版候选，? 表示尚未选定`+(item.value.use?' · 用途：'+item.value.use:'')+range;
    }else nodeText('p','production-issue',item.label+' · 准确引用缺失，需先修复槽位',line);
    if(item.value.use&&!item.value.relation)nodeText('p',null,item.value.use,line);
    renderInputRelationPurpose(line,item.value,row.kind==='REQUIREMENT'?row:null);
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
    const value={requirement_id:context.need.object_id,expected_revision:context.need.id,plan_number:context.number,index:context.slot.index,input_key:context.slot.input_key,material_id:model.material_id,number:model.round.number,...(item?{candidate:productionRef(item.record),component_id:item.component.id,...bounds}:{candidate:null})};
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
    }else pre.append(document.createTextNode(span.text));offset=span.end;
  }
  pre.append(document.createTextNode(block.text.slice(offset)));parent.append(pre);
}
function renderBreakdownPromptReading(parent,row,reading){
  const surface=materialTextSurface(parent,row);surface.classList.add('shot-action-reading');
  nodeText('h4',null,'动作与对白',surface);
  for(const part of reading.parts){const line=el('p');
    if(part.role==='action')nodeText('b',null,'动作　',line);
    const text=nodeText('span',null,part.text,line);text.dataset.blockId=reading.block_id;text.dataset.anchorOffset=part.start;surface.append(line);
  }
}
function preserveBreakdownDetailPosition(detail,section,summary){
  let position=null;
  const close=()=>{detail.open=false;const body=section.closest('.breakdown-body');
    if(body&&position){body.scrollTop=position.scrollTop;window.scrollTo(0,position.windowY)}
    else summary.scrollIntoView({block:'nearest'});
  };
  summary.onclick=()=>{if(!detail.open){const body=section.closest('.breakdown-body');if(body)position=breakdownPosition(body)}else requestAnimationFrame(close)};
  const footer=el('div','generation-detail-close');productionButton(footer,'收起生成细节',close);
  // The footer remains last even as the full reader is assembled synchronously.
  Promise.resolve().then(()=>detail.append(footer));
}
function breakdownPromptSelection(need,context){
  const detail=context.video_details?.[need.object_id],rounds=detail?.material_versions?.[need.object_id]||[];
  state.breakdownVideoSelections||={};const params=new URL(location.href).searchParams,exact=params.get('shot_material_id')===need.object_id;
  if(exact&&params.has('shot_plan')){
    const checked=new URLSearchParams({material_id:need.object_id,material_version:params.get('shot_plan'),...(params.has('shot_baseline')?{material_baseline:params.get('shot_baseline')}:{})});
    try{validateUnifiedReference({params:checked,detail});params.set('shot_plan',checked.get('material_version'))}
    catch(error){throw error}
  }
  const saved=exact?{number:Number(params.get('shot_plan')),candidate:params.get('shot_candidate')}:state.breakdownVideoSelections[need.id]||{},round=rounds.find(r=>r.number===saved.number)||[...rounds].sort((a,b)=>b.number-a.number)[0];
  if(exact&&saved.number&&!rounds.some(r=>r.number===saved.number))throw Error('准确素材制作版本不存在');
  const exactNeed=detail?.record?.id===need.id?detail.record:need;
  const historicalRecipe=typeof materialHistoricalDefinition==='function'&&materialHistoricalDefinition(exactNeed,round);
  const candidates=(historicalRecipe?[]:round?.results||[]).map(record=>({record,components:record.payload.components,component:record.payload.components.find(c=>c.role==='original')||record.payload.components[0]}));
  const model={need:historicalRecipe?exactNeed:round?(round.definition_records?round.definition_records.requirement:round.plan):need,identity:need,candidates,round,rounds,material_id:need.object_id};
  if(saved.candidate&&!candidates.some(i=>i.record.id===saved.candidate))throw Error('准确素材候选不属于此制作版本；未替换为其他结果');
  const selected=materialCandidateChoice(candidates,saved.candidate||materialDefaultCandidate(model,{adoptions:context.adoptions}));
  const selection={number:round?.number,baseline:round?.baseline_id,candidate:selected?.record.id,reference:productionRef(selected?.record||model.need||round?.definition_records?.call||need)};state.breakdownVideoSelections[need.id]=selection;
  const referenceContext={need:model.need||need,number:round?.number,frozen:!!round?.frozen,historical:historicalRecipe};
  return {detail,rounds,exact,saved,round,exactNeed,historicalRecipe,candidates,model,selected,selection,referenceContext};
}
function breakdownPrompt(parent,need,context,onReading=null,references=null){
  let chosen;try{chosen=breakdownPromptSelection(need,context)}catch(error){onReading?.(null,null);nodeText('p','production-issue',error.message,parent);return}
  const {detail,rounds,round,model,selected,candidates,referenceContext,historicalRecipe}=chosen;
  const section=el('section','shot-generation-content');parent.append(section);
  const route=(number,candidate=null)=>{const url=new URL(location.href);url.searchParams.set('shot_material_id',need.object_id);url.searchParams.set('shot_plan',number);const baseline=rounds.find(r=>r.number===number)?.baseline_id;if(baseline)url.searchParams.set('shot_baseline',baseline);else url.searchParams.delete('shot_baseline');if(candidate)url.searchParams.set('shot_candidate',candidate);else url.searchParams.delete('shot_candidate');history.pushState(history.state,'',url);state.breakdownRenderedSelection=breakdownSelectionKey(url.searchParams)};
  const repaint=()=>{rememberProductionDraft();section.remove();breakdownPrompt(parent,need,context,onReading,references);restoreBreakdownPromptDraft(parent);paintReviewCommentCounts()};
  if(rounds.length>1)materialRoundControl(section,need.object_id,rounds,round,number=>{state.breakdownVideoSelections[need.id]={number};route(number);repaint()});
  if(candidates.length>1)reviewChoiceButtons(section,'素材候选',candidates.map((item,index)=>({id:item.record.id,label:'候选'+(item.record.candidate_number||index+1)})),selected.record.id,id=>{state.breakdownVideoSelections[need.id].candidate=id;route(round.number,id);repaint()});
  const actual=selected?detail.review_contexts?.[selected.record.id]:null;
  const source=selected?actual?.call:!historicalRecipe&&round?.definition_records?.call||model.need;
  if(selected){materialMedia(section,selected);renderMaterialResultReview(section,selected.record,actual||{})}else nodeText('p','production-meta','尚无生成原件',section);
  const reading=source?.review_reading;onReading?.(reading,source);
  if(reading)renderBreakdownPromptReading(section,source,reading);
  else if(need.payload.media_type==='video'){
    nodeText('p','production-issue',source?'此版本尚无核对过的动作阅读稿；以下保留准确原文。':selected?'此原件未保留准确生成记录。':'此版本未保留完整生成方案。',section);
    if(source){const host=materialTextSurface(section,source),inputs=source.kind==='CALL'?source.payload.inputs||[]:source.payload.generation?.inputs||[],records=source.kind==='CALL'?actual?.inputs||source.review_input_records||[]:source.review_input_records||[];renderLinkedPrompt(host,source,inputs,records,source.kind==='CALL'?'call.prompt':'generation.prompt',historicalRecipe?null:referenceContext)}
  }else if(model.need)renderMaterialRequirements(section,model.need);else nodeText('p','production-issue','此版本未保留完整素材要求。',section);
  if(references?.register){references.register(need,source,referenceContext,actual);return}
  if(!references){references=el('section','shot-reference-reading');section.append(references)}
  if(references){references.replaceChildren();nodeText('h3',null,readableProductionTitle(need),references);const plan=model.need?.payload.generation;
    if(source){const inputs=source.kind==='CALL'?source.payload.inputs||[]:source.payload.generation?.inputs||[];const records=source.kind==='CALL'?actual?.inputs||source.review_input_records||[]:source.review_input_records||[];renderShotInputs(references,source,inputs,records,referenceContext)}
    if(plan&&!historicalRecipe)renderMaterialRouteChoices(references,model.need,(result,routeKey)=>refreshShotReference(referenceContext,{routeKey},result));
    if(model.need){const button=productionButton(references,'审阅此制作方案',()=>openUnifiedMaterial(productionRef(model.need),button))}
  }
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
function breakdownDisclosureState(host){
  const values=new Map();
  for(const node of host?.querySelectorAll?.('details')||[]){
    // Preserve reading disclosures, not a decision scope from another revision.
    if(!node.matches('.audiovisual-edition,.breakdown-conditions,.breakdown-shot-original,.shot-state-trace,.shot-generation-details'))continue;
    const owner=node.matches('.audiovisual-edition')?'':node.closest('[data-shot-id]')?.dataset.shotId||host.querySelector('.breakdown-body')?.dataset.sceneId||'';
    values.set(owner+':'+(node.dataset.readingRevision||'')+':'+node.className+':'+node.querySelector('summary')?.textContent,node.open);
  }
  return values;
}
function restoreBreakdownDisclosures(host,values){
  for(const node of host.querySelectorAll?.('details')||[]){
    const owner=node.matches('.audiovisual-edition')?'':node.closest('[data-shot-id]')?.dataset.shotId||host.querySelector('.breakdown-body')?.dataset.sceneId||'';
    const key=owner+':'+(node.dataset.readingRevision||'')+':'+node.className+':'+node.querySelector('summary')?.textContent;
    if(values.has(key))node.open=values.get(key);
  }
}
async function loadProductionBreakdown({refresh=false}={}){
  state.productionVisibleEntities=null;state.refreshEntityIndex=null;rememberProductionDraft();
  const oldBody=document.querySelector('.breakdown-body');if(oldBody?.dataset.readingKey){state.breakdownMemory||={};state.breakdownMemory[oldBody.dataset.readingKey]=breakdownPosition(oldBody)}
  const epoch=++breakdownEpoch,workspace=state.workspace,params=new URL(location.href).searchParams,host=$('#production-view'),savedPosition=history.state?.breakdownPosition;
  ++breakdownSelectionEpoch;++productionLoadEpoch;++productionReadEpoch;
  state.entityReview=null;state.materialReview=null;state.unifiedCardRoot=null;state.productionSelected=null;state.productionEntityId=null;
  delete state.breakdownLevels;
  const targetId=params.get('breakdown_object'),targetRevision=params.get('breakdown_revision'),edition=params.get('breakdown_episode_revision'),disclosures=breakdownDisclosureState(host);
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
  {const scope='视听制作评论：本集准确集场镜及直接关联素材的全部方案版本与候选；含已关闭评论，按评论去重，不含故事正文和共享上游素材。';episodes.title=scope;episodes.setAttribute('aria-description',scope)}
  for(const ep of data.episodes)renderEpisodeCard(episodes,{...ep,payload:{number:ep.number,title:ep.title,scenes:ep.scenes}},ep.object_id===data.episode,breakdownEpisodeCount(ep),()=>{if(ep.object_id!==(new URL(location.href).searchParams.get('breakdown_episode')||data.episode))breakdownNavigate({breakdown_episode:ep.object_id,breakdown_episode_revision:null,breakdown_scene:null,breakdown_object:null,breakdown_revision:null})});
  const active=episodes.querySelector('.active');if(active){const r=active.getBoundingClientRect(),edge=episodes.getBoundingClientRect();if(r.right>edge.right)episodes.scrollLeft+=r.right-edge.right;if(r.left<edge.left)episodes.scrollLeft+=r.left-edge.left}
  renderAudiovisualEdition(staged,data);
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
    for(const shot of [...new Map(data.shots.map(r=>[r.id,r])).values()].filter(r=>scene.payload.shots.some(v=>v.object_id===r.object_id&&v.revision_id===r.id))){const button=productionButton(children,breakdownShotTitle(shot),choose(shot));button.className='source-button';button.dataset.objectId=shot.object_id;button.dataset.revisionId=shot.id}
    group.append(line,children);sceneList.append(group);
  }
  const commit=()=>{host.replaceChildren(...staged.children);host.dataset.breakdownWorkspace=workspace;host.dataset.breakdownTab=productionTab();restoreBreakdownDisclosures(host,disclosures);sceneList.scrollTop=sidebarTop;episodes.scrollLeft=episodeLeft;
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
  const shot=item.record,row=el('article','breakdown-row breakdown-shot');row.dataset.shotId=shot.object_id;row.dataset.shotRevision=shot.id;
  const text=el('section','breakdown-shot-copy'),heading=el('header'),title=el('div','breakdown-shot-heading');nodeText('h3',null,breakdownShotTitle(shot),title);renderAudiovisualSources(title,shot);heading.append(title);nodeText('small',null,`${shot.payload.duration_frames/shot.payload.fps} 秒`,heading);text.append(heading);row.append(text);parent.append(row);
  const actions=el('div'),design=el('div','breakdown-shot-design');text.append(actions,design);
  const references=referencesParent?.register?referencesParent:el('section','shot-references');if(!referencesParent?.register)(referencesParent||text).append(references);
  const video=(item.context.requirements||[]).find(r=>r.payload.media_type==='video');
  const draw= (reading,source)=>{design.replaceChildren();const composed=breakdownShotText(design,shot,common,reading?.parts.filter(p=>p.role==='voice').map(p=>p.text)||[],[common.sceneId,...(source?[source.id]:[])].filter(Boolean));if(composed!==true)renderShotStateContext(design,shot,item.context)};
  if(video)breakdownPrompt(actions,video,item.context,draw,references);else draw(null,null);
  if(references.register){references.designs.set(shot.id,shot)}else renderProductionAcceptance(references,shot);

}

// Identical decisions may serve several shots. Their common reading is not a
// comment target: each shot button opens its own exact relation and decision.
async function renderSharedReferencePurposes(parent,uses){
  const content=el('div','shared-reference-purpose');parent.append(content);
  const results=await Promise.allSettled(uses.filter(u=>u.item.value.relation).map(async use=>({use,row:(await api('/api/production?'+new URLSearchParams(use.item.value.relation))).record})));
  if(!content.isConnected)return;
  const read=new Set();
  for(const result of results){
    if(result.status==='rejected'){nodeText('p','production-issue','用途读取失败：'+result.reason.message,content);continue}
    const {row}=result.value;
    renderSharedRelationSections(content,relationReadingSections(row),read);
  }
}

function createSceneReferenceReader(data){
  const host=el('section','scene-reference-reading'),selections=new Map(),designs=new Map();let queued=false;
  const draw=()=>{queued=false;host.replaceChildren();nodeText('h2',null,'原件与制作取舍',host);
    const groups=new Map();
    for(const {need,source,context,actual} of selections.values()){
      if(!source)continue;const inputs=source.kind==='CALL'?source.payload.inputs||[]:source.payload.generation?.inputs||[],records=source.kind==='CALL'?actual?.inputs||source.review_input_records||[]:source.review_input_records||[];
      for(const item of shotReferenceItems(source,inputs,records)){
        if(item.slot?.nonmedia)continue;
        const key=JSON.stringify([item.ref?.object_id,item.ref?.revision_id,item.value.component_id,item.value.range,item.value.crop]);
        if(!groups.has(key))groups.set(key,{item,uses:[]});groups.get(key).uses.push({item,need,context});
      }
    }
    for(const {item,uses} of groups.values()){
      const box=el('article','scene-reference-original'),row=item.row||item.slot?.record;host.append(box);
      nodeText('h3',null,row?businessTitle(row):item.label,box);
      const component=row?.kind==='ASSET'&&(row.payload.components||[]).find(c=>item.value.component_id?c.id===item.value.component_id:c.role==='original');
      if(component){materialMedia(box,{record:row,component,components:row.payload.components,range:item.value.range,crop:item.value.crop});renderMaterialResultReview(box,row,{})}
      else nodeText('p','production-meta','此参考尚未选定原件；可打开比较已有成果。',box);
      renderSharedReferencePurposes(box,uses);
      for(const use of uses){
        const line=el('section','scene-reference-use');box.append(line);
        const shot=data.shots.find(s=>s.record.id===use.need.payload.scope?.revision_id)?.record;
        const label=shot?breakdownShotTitle(shot):readableProductionTitle(use.need);
        const button=productionButton(line,label+' · '+(use.item.slot?.candidate?'已选参考':'比较与选择'),()=>openShotReference(use.item,use.context,button));button.classList.add('material-reference');
        if(!use.item.value.relation&&use.item.value.use)nodeText('p',null,use.item.value.use,line);
      }
    }
    const plans=el('section','scene-production-plans');nodeText('h3',null,'本场制作',plans);host.append(plans);
    const materials=[...new Map(data.shots.flatMap(s=>s.context.materials||[]).map(i=>[i.canonical_material_id||i.object_id,i])).values()];
    const empty=materials.filter(i=>!i.generated),available=materials.filter(i=>i.generated);
    nodeText('p',null,`${available.length} 项已有结果；${empty.length} 项尚无结果。`,plans);
    const browse=productionButton(plans,'查看本场全部成果与制作方案',()=>{breakdownRoute({production_tab:'materials',production_object:null,production_revision:null,material_id:null,material_target:null});loadProductionMaterials()});
    const links=el('div','scene-material-links');plans.append(links);
    for(const item of materials){const button=materialSmallCard(links,item,trigger=>{const selected=state.breakdownVideoSelections?.[item.id],params=selected?new URLSearchParams({material_id:item.object_id,...(selected.number?{material_version:selected.number}:{}),...(selected.candidate?{material_target:selected.candidate}:{})}):null;openUnifiedMaterial({...selected?.reference||{object_id:item.object_id,revision_id:item.id},params},trigger)});button.dataset.reviewDialogTrigger=''}
    const decisions=el('section','scene-design-decisions');nodeText('h3',null,'设计认可',decisions);host.append(decisions);
    renderProductionAcceptance(decisions,data.scene);
    for(const shot of designs.values()){const line=el('section');nodeText('h4',null,breakdownShotTitle(shot),line);decisions.append(line);renderProductionAcceptance(line,shot)}
  };
  queued=true;Promise.resolve().then(draw);
  return {host,designs,register(need,source,context,actual){selections.set(need.object_id,{need,source,context,actual});if(!queued){queued=true;Promise.resolve().then(draw)}}};
}

async function showBreakdownScene(scene,body,nav,epoch,restore=null,savedPosition=null,commit=null){
  const request=++breakdownSelectionEpoch,workspace=state.workspace,targetId=restore?.get('breakdown_object'),targetRevision=restore?.get('breakdown_revision'),shot=(state.breakdownData.shots||[]).find(r=>r.object_id===targetId&&r.id===targetRevision);
  const design=state.breakdownData.design;
  const data=await api('/api/production/scene?'+new URLSearchParams({object_id:scene.object_id,revision_id:scene.id,view:'breakdown',...(design?{episode:design.object_id,episode_revision:design.id}:{}),...(shot?{shot_revision:shot.id}:{})}));if(epoch!==breakdownEpoch||request!==breakdownSelectionEpoch||workspace!==state.workspace)return;
  body.replaceChildren();state.breakdownSceneData=data;body.dataset.sceneId=scene.object_id;body.dataset.readingKey=scene.id+':'+(shot?.id||'');
  breakdownRoute({breakdown_episode:state.breakdownData.episode,breakdown_episode_revision:state.breakdownData.design?.id||null,breakdown_scene:scene.object_id,production_tab:'breakdown',...(state.breakdownData.design?{production_scope_episode:state.breakdownData.design.object_id,production_scope_revision:state.breakdownData.design.id,production_scope_scene:scene.object_id}:{})});
  const page=el('section','breakdown-scene');body.append(page);
  const header=el('header','text-reader-head breakdown-scene-head'),heading=el('div','breakdown-scene-heading');nodeText('h2',null,breakdownSceneTitle(data.scene),heading);renderAudiovisualSources(heading,data.scene); header.append(heading);page.append(header);
  const alreadyRead=[...body.parentElement?.parentElement?.querySelectorAll('.audiovisual-edition [data-block-id]')||[]].map(node=>node.textContent);
  const composedScene=renderAudiovisualDesign(page,data.scene,[...data.shots.map(s=>s.record.id),...data.shots.flatMap(s=>s.context.requirements.map(r=>r.id))],alreadyRead);
  const common=breakdownReadingConditions(data,composedScene,page.textContent,[...page.querySelectorAll?.('[data-block-id]')||[]].map(node=>node.textContent));renderBreakdownConditions(page,data,common);
  const references=createSceneReferenceReader(data);
  for(const item of data.shots)renderBreakdownShot(page,item,common,references);page.append(references.host);
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
  return JSON.stringify([state.productionSelected?.id||null,context?.material_id||null,context?.number||null,context?.model||null]);
}
function rememberProductionDraft(){
  if(!isProduction()||!state.productionSelected||!state.anchor)return;
  if(typeof rememberLiveCommentEdit==='function')try{rememberLiveCommentEdit()}catch{rememberCommentDraftFailure()}
  if(state.productionDraftScope&&state.productionDraftScope!==productionDraftKey())return;
  state.productionDraftContexts||={};state.productionDraftContexts[state.productionDraftScope||productionDraftKey()]={anchor:state.anchor,editing:state.editing,selected:state.selected,scope:state.reviewCommentScope,draftKey:typeof draftKey==='function'?draftKey():null};
}
function restoreProductionDraft(){
  const key=productionDraftKey(),changed=state.productionDraftScope&&state.productionDraftScope!==key;state.productionDraftScope=key;
  const saved=state.productionDraftContexts?.[key];
  if(saved){state.anchor=saved.anchor;state.editing=saved.editing;state.selected=saved.selected;state.reviewCommentScope=saved.scope}
  else if(changed){state.anchor=null;state.editing=null;state.selected=null;state.reviewCommentScope=null}
}
function restoreBreakdownPromptDraft(row){
  if(!row||!['breakdown','shots'].includes(productionTab()))return;
  const surfaces=[...row.querySelectorAll('[data-production-blocks]')];
  for(const [key,saved] of Object.entries(state.productionDraftContexts||{}).reverse()){
    let revision;try{revision=JSON.parse(key)[0];if(!saved.anchor||!saved.draftKey||localStorage.getItem(saved.draftKey)===null)continue}catch{continue}
    // Only a displayed exact plan/call may restore a Prompt draft. Do not move
    // a draft to another shot, version or newer immutable revision.
    const exact=surfaces.filter(node=>node.dataset.productionBlocks===revision),a=saved.anchor;
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

function renderShotStateContext(host,shot,context={}){
  const records=[...(context.states||[]),...(context.continuity_states||[])];
  const link=(parent,ref)=>{const row=records.find(r=>r.id===ref.revision_id);materialReferenceLink(parent,ref,row?businessTitle(row):'查看实体状态')};
  const transitions=shot.payload.state_transitions||[];
  if(transitions.length){const changes=el('div','shot-state-changes');nodeText('h4',null,'本镜状态变化',changes);for(const value of transitions){const line=el('div');link(line,value.from);nodeText('span',null,' → ',line);link(line,value.to);nodeText('p',null,value.action,line);changes.append(line)}host.append(changes)}
  return null;
}
async function refreshMaterialPlan(result){
  const epoch=productionLoadEpoch,workspace=state.workspace,target=state.productionSelected?.id;
  const params=new URLSearchParams({material_id:result.requirement_id,material_version:result.number,...(result.baseline_id?{material_baseline:result.baseline_id}:{})});
  const value=await readUnifiedCard(result.requirement_id,result.revision_id,params);
  if(epoch!==productionLoadEpoch||workspace!==state.workspace||target!==state.productionSelected?.id)return;
  activateUnifiedCard(value);renderProductionReader();renderComments();
}
function renderMaterialRouteChoices(host,need,onSaved){
  const slots=need.review_shot_slots||[],plan=need.payload.generation,groups=new Map(),conditions=new Set();
  if(!plan)return;
  const save=async(action,key,value,control)=>{control.disabled=true;try{const result=await api('/api/production/material-route',{method:'POST',body:JSON.stringify({id:'route-'+crypto.randomUUID(),requirement_id:need.object_id,expected_revision:need.id,action,key,value})});if(control.isConnected)await onSaved(result,control.dataset.routeKey)}catch(error){if(control.isConnected){control.disabled=false;toast(error.message)}}};
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
