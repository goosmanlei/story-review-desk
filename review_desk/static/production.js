/* Production readers share app.js comments, drafts, keyboard handling and API. */
const productionKinds={ENTITY:'实体',STATE:'实体状态',REPRESENTATION:'制作设定',INPUT_LOCK:'剧本依据',PREPARATION:'集场检查',SHOT_DESIGN:'镜头设计',REQUIREMENT:'素材需求',ASSET:'实际素材',CALL:'实际制作',RELATION:'明确采用',JUDGMENT:'审阅结论',ASSEMBLY:'动态分镜组合',DELIVERABLE:'输出与工程'};
const productionGroups={'settings.workspace':['ENTITY','STATE','REPRESENTATION'],'materials.workspace':['ASSET','CALL','JUDGMENT','RELATION'],'production.workspace':['PREPARATION','SHOT_DESIGN','REQUIREMENT','ASSEMBLY','DELIVERABLE']};
const productionLabels={character:'角色',space:'场景',prop:'道具',song:'歌曲',visual:'画面',voice:'声音',visual_voice:'画面与声音',mention:'仅提及',generation_input:'生成输入',post_audio:'后期声音',editorial:'剪辑参考',pending:'待审',passed:'通过',changes_requested:'需修改',rejected:'未通过',accepted:'用户接受',impact_resolved:'影响已处理'};
const productionRef=r=>({object_id:r.object_id,revision_id:r.id});
const productionCompleteState=r=>r.kind==='STATE'&&r.payload.state_model==='complete-v1';
// This read-only projection also runs in review_text.py for exact anchor validation.
function productionTextBlocks(record){
  const p=record.payload,blocks=[...(p.blocks||[])],body=blocks.map(b=>b.text).join('\n'),seen=new Set();
  let prefix='@review/';while(blocks.some(b=>b.id.startsWith(prefix)))prefix='@'+prefix;
  for(const field of ['facts','choices','unknowns'])for(const [index,text] of (p[field]||[]).entries()){
    if(typeof text!=='string'||!text.trim()||body.includes(text)||seen.has(text))continue;
    seen.add(text);blocks.push({id:`${prefix}${field}/${index}`,text,field,index});
  }
  const sorted=value=>Array.isArray(value)?value.map(sorted):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,sorted(value[k])])):value;
  const extra=[['production_description',p.production_description]],plan=p.generation;
  if(plan){extra.push(['generation.tool',plan.tool],['generation.model',plan.model],['generation.parameters',record.review_parameter_text??JSON.stringify(sorted(plan.parameters||{}),null,2)],['generation.prompt',plan.prompt],['generation.output.description',plan.output?.description],['generation.output.review_criteria',(plan.output?.review_criteria||[]).join('\n')]);for(const [i,v] of (plan.inputs||[]).entries())extra.push([`generation.inputs.${i}.use`,v.use])}
  if(p.format==='production-call-v1')extra.push(['call.model',p.model],['call.parameters',record.review_call_parameter_text??JSON.stringify(sorted(Object.fromEntries(Object.entries(p.parameters||{}).filter(([k,v])=>k!=='prompt'||v!==p.prompt))),null,2)],['call.prompt',p.prompt]);
  for(const [field,text] of extra)if(typeof text==='string'&&text.trim()&&!body.includes(text)&&!seen.has(text)){seen.add(text);blocks.push({id:prefix+field.replaceAll('.','/'),text,field})}
  return blocks;
}
const productionEntitySymbols={
  character:['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z','M4.5 21v-2a7.5 7.5 0 0 1 15 0v2'],
  space:['M3 4h18v16H3Z','M3 17l5-5 4 4 4-7 5 8','M8 8h.01'],
  prop:['m12 3 9 5v9l-9 5-9-5V8Z','m3 8 9 5 9-5','M12 13v9','m7.5 5.5 9 5V15'],
  song:['M9 17V5l12-2v12','M9 9l12-2','M9 17c0 2-2 3-4 3s-3-1-3-2 2-3 4-3c1 0 3 0 3 2Z','M21 15c0 2-2 3-4 3s-3-1-3-2 2-3 4-3c1 0 3 0 3 2Z']
};
function productionEntityIcon(type){
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');svg.setAttribute('stroke-width','1.6');svg.setAttribute('stroke-linecap','round');svg.setAttribute('stroke-linejoin','round');svg.setAttribute('aria-hidden','true');svg.setAttribute('focusable','false');svg.classList.add('production-entity-icon');
  for(const d of productionEntitySymbols[type]||productionEntitySymbols.prop){const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',d);svg.append(path)}
  return svg;
}
const productionDimensionLabels={appearance:'整体外观',clothing:'服装',injury:'伤势',health:'健康',fatigue:'疲劳',voice:'声音',attachments:'随身物',layout:'空间布局',dressing:'场景布置',time_light:'时间与光照',structure:'完整形态',condition:'状况',contents:'组成与内容',placement:'使用位置',lyrics_scope:'歌词范围',rendition:'演唱方式',performers:'演唱者'};
let productionLoadEpoch=0,productionReadEpoch=0;
function productionButton(parent,text,action){const b=nodeText('button',null,text,parent);b.type='button';b.onclick=()=>Promise.resolve().then(action).catch(e=>toast(e.message));return b}
function productionVisuals(){return (state.productionSelected?.payload.components||[]).filter(c=>c.mime.startsWith('image/')).map(c=>({...c,title:state.productionSelected.payload.title,alt:state.productionSelected.payload.title,description:`${c.role} · ${c.width}×${c.height} · ${c.sha256}`}))}
function productionName(ref){return state.productionRecords?.find(r=>r.object_id===ref.object_id)?.payload.title||state.screenplays.flatMap(s=>s.episodes).find(e=>e.object_id===ref.object_id)?.payload.title||state.screenplays.find(s=>s.object_id===ref.object_id)?.payload.title||ref.object_id}
function productionBasisSummary(record){
  const p=record.payload,script=state.screenplays.find(s=>s.object_id===p.screenplay.object_id&&s.id===p.screenplay.revision_id);
  const title=script?.payload.title||p.title,label=title.match(/^(?:剧本|版本)\s*([一二三四五六七八九十百零〇\d]+)/u);
  return `剧本依据：${label?'版本'+label[1]:title} · 已确认 · ${p.episodes.length} 集`;
}
function productionRefLink(parent,ref,label){
  if(!ref?.object_id||!ref.revision_id)return;
  const basis=state.productionRecords?.find(r=>r.object_id===ref.object_id&&r.kind==='INPUT_LOCK');
  if(basis){nodeText('span','production-ref',basis.id===ref.revision_id?productionBasisSummary(basis):(label||'剧本依据')+' · 历史版本',parent);return}
  if(ref.scene_id||ref.block_ids){const b=productionButton(parent,label||`${productionName(ref)} · ${ref.scene_id||'正文依据'}`,()=>showProductionSource(ref));b.className='production-ref';b.title=`精确修订 ${ref.revision_id}`;return}
  const episode=state.screenplays.flatMap(v=>v.episodes).find(e=>e.object_id===ref.object_id&&e.id===ref.revision_id);
  if(episode){const url=new URL(location.href);url.search='';url.searchParams.set('workspace','story.script');url.searchParams.set('script',episode.payload.screenplay_id);url.searchParams.set('episode',episode.object_id);if(ref.scene_id)url.searchParams.set('scene',ref.scene_id);const a=link(label||`${episode.payload.title} · ${ref.scene_id||'本集'}`,url.href,parent);a.className='production-ref';a.title=`修订 ${ref.revision_id}\n${(ref.block_ids||[]).join(', ')}`;return}
  const script=state.screenplays.find(s=>s.object_id===ref.object_id&&s.id===ref.revision_id);
  if(script){const url=new URL(location.href);url.search='';url.searchParams.set('workspace','story.script');url.searchParams.set('script',script.object_id);link(label||script.payload.title,url.href,parent);return}
  if(!state.productionRecords.some(r=>r.object_id===ref.object_id)){const b=productionButton(parent,label||ref.object_id,()=>showProductionSource(ref));b.className='production-ref';return}
  const b=productionButton(parent,label||productionName(ref),()=>openProductionRecord(ref.object_id,ref.revision_id,true));b.className='production-ref';b.title=`${ref.object_id} · ${ref.revision_id}`;
}
async function showProductionSource(ref){
  const selected=state.productionSelected?.id;
  const query=new URLSearchParams({object_id:ref.object_id,revision_id:ref.revision_id});if(ref.scene_id)query.set('scene_id',ref.scene_id);if(ref.block_ids)query.set('block_ids',ref.block_ids.join(','));
  const data=await api('/api/production/source?'+query);if(state.productionSelected?.id!==selected)return;const panel=el('section','production-editor');panel.setAttribute('aria-label','精确剧情来源');panel.setAttribute('role','region');
  nodeText('h3',null,data.title+(data.scene?' · '+data.scene.heading:''),panel);nodeText('p','production-meta',`引用修订 ${ref.revision_id} · ${data.is_current?'当前修订':'历史修订，未替换为新版'}`,panel);
  for(const block of data.blocks){nodeText('small',null,block.id,panel);nodeText('p',null,block.text,panel)}
  productionButton(panel,'关闭来源',()=>panel.remove());$('#production-reader').prepend(panel);panel.scrollIntoView({block:'start'});
}
// Browsing follows stable entity identity; the selected record remains an exact revision.
function productionEntityIds(record,byId=new Map((state.productionRecords||[]).map(r=>[r.object_id,r]))){
  if(!record)return [];
  if(record.kind==='ENTITY')return [record.object_id];
  if(record.kind==='STATE')return [record.payload.entity.object_id];
  if(record.kind!=='REPRESENTATION')return [];
  return [...new Set([...(record.payload.entities||[]).map(ref=>ref.object_id),...(record.payload.states||[]).map(ref=>byId.get(ref.object_id)?.payload.entity?.object_id).filter(Boolean)])];
}
function productionEntityChildren(entityId){
  const byId=new Map((state.productionRecords||[]).map(r=>[r.object_id,r]));
  return (state.productionRecords||[]).filter(r=>(productionCompleteState(r)||r.kind==='REPRESENTATION'&&!r.payload.review_model)&&productionEntityIds(r,byId).includes(entityId));
}
function productionStateOrder(a,b){const x=a.payload.sources?.[0],y=b.payload.sources?.[0];return (x?.scene_id||'').localeCompare(y?.scene_id||'')||(x?.block_ids?.[0]||'').localeCompare(y?.block_ids?.[0]||'')||a.object_id.localeCompare(b.object_id)}
function renderProductionEntityNavigation(root,r){
  if(state.workspace!=='settings.workspace')return;
  const entity=state.productionRecords.find(row=>row.kind==='ENTITY'&&row.object_id===state.productionEntityId);
  if(!entity)return;
  const section=el('section','production-entity-context');section.setAttribute('aria-label','实体内的状态与设定');
  nodeText('h3','production-entity-title','选择状态',section);
  const children=productionEntityChildren(entity.object_id);
  // A historical link can refer to an earlier parent; do not lose the selected revision.
  if(r&&r.kind!=='ENTITY'&&!r.payload.review_model&&!children.some(row=>row.object_id===r.object_id))children.push(r);
  for(const [kind,label] of [['STATE','完整状态'],['REPRESENTATION','制作设定']]){
    const rows=children.filter(row=>row.kind===kind&&(kind!=='STATE'||productionCompleteState(row))).sort(productionStateOrder);
    if(!rows.length)continue;
    const group=el('div','production-entity-group');group.setAttribute('role','group');group.setAttribute('aria-label',label);
    nodeText('span','production-entity-label',`${label} · ${rows.length}`,group);
    const choices=el('div','production-entity-options');group.append(choices);
    for(const current of rows){
      const selected=current.object_id===r?.object_id,row=selected?r:current;
      const title=row.payload.title.startsWith(entity.payload.title)?row.payload.title.slice(entity.payload.title.length).replace(/^[\s·：:—-]+/u,'')||row.payload.title:row.payload.title;
      const button=productionButton(choices,kind==='STATE'&&current===rows[0]?'基础状态 · '+title:title,()=>openProductionRecord(row.object_id,row.id,false,entity.object_id));
      button.setAttribute('aria-pressed',String(selected));button.dataset.objectId=row.object_id;button.title=`${row.payload.title} · 版本 ${row.version}`;
    }
    section.append(group);
  }
  if(r?.kind==='STATE'&&!productionCompleteState(r))nodeText('p','production-issue','历史局部状态：保留当时的引用与评论，不计入当前完整状态。请从上方选择完整状态查看现用设定。',section);
  if(!children.length)nodeText('p','production-meta','尚未登记实体状态或制作设定。',section);
  root.append(section);
}
async function loadProductionWorkspace(){
  const workspace=state.workspace,epoch=++productionLoadEpoch;$('#production-view').replaceChildren();nodeText('p',null,'正在读取制作记录…',$('#production-view'));const result=await api('/api/production');if(state.workspace!==workspace||epoch!==productionLoadEpoch)return;
  state.productionRecords=result.records;
  const param=new URL(location.href).searchParams,selected=param.get('production_object'),requested=result.records.find(r=>r.object_id===selected);
  if(requested?.kind==='INPUT_LOCK'){
    const url=new URL(location.href);url.searchParams.delete('production_object');url.searchParams.delete('production_revision');history.replaceState(null,'',url);
    if(workspace!=='production.workspace'){switchWorkspace('production.workspace');return}
  }
  const host=$('#production-view');host.replaceChildren();
  const heading=el('header','production-heading'),title=el('div');nodeText('small',null,'剧本依据 → 制作设定 → 实际素材 → 镜头输入',title);nodeText('h1',null,{'settings.workspace':'制作设定','materials.workspace':'素材管理','production.workspace':'全剧制作'}[workspace],title);
  nodeText('p',null,{'settings.workspace':'直接审阅实体、完整状态和关联素材，通过评论提出意见，也可采纳当前版本。','materials.workspace':'查看原件、候选和实际制作记录；审阅结论与具体采用分别保存。','production.workspace':'按集场组织镜头和输入槽位，检查缺项并登记动态分镜组合与交付。'}[workspace],title);heading.append(title);const actions=el('div','production-toolbar');if(workspace!=='settings.workspace')productionButton(actions,'批量导入',showProductionImport);if(workspace==='materials.workspace')productionButton(actions,'登记实际原件',showProductionUpload);heading.append(actions);host.append(heading);
  const inputLocks=result.records.filter(r=>r.kind==='INPUT_LOCK');
  if(workspace==='production.workspace'){
    const basis=el('div','production-basis');basis.setAttribute('aria-label','剧本依据');
    for(const lock of inputLocks)nodeText('p',null,productionBasisSummary(lock),basis);
    if(!inputLocks.length)nodeText('p',null,'剧本依据：尚未登记',basis);host.append(basis);
  }
  const flatFilters=workspace==='settings.workspace',filters={kind:'',category:'',episode:'',scene:''},filterSelects={};
  const filterPanel=el('section',flatFilters?'production-filters':''),toolbar=el('div','production-toolbar'),search=el('input');
  search.type='search';search.placeholder=flatFilters?'搜索实体、别名、状态或设定':'搜索名称、别名或集场';search.setAttribute('aria-label','搜索制作记录');
  let clearFilters,resultSummary;
  if(flatFilters){
    filterPanel.setAttribute('aria-label','制作设定筛选');
    const label=el('label','production-filter-search');nodeText('span',null,'搜索设定',label);label.append(search);toolbar.append(label);
    clearFilters=productionButton(toolbar,'清除筛选',()=>{search.value='';for(const key of Object.keys(filters))filters[key]='';refreshIndex()});
    filterPanel.append(toolbar);
    nodeText('p','production-filter-note','按实体计数，状态与制作设定在实体内查看；搜索也包含状态和设定内容。',filterPanel);
  }else{toolbar.append(search);filterPanel.append(toolbar)}
  const kindOptions=[['','全部类型'],...productionGroups[workspace].map(kind=>[kind,productionKinds[kind]])];
  const categories=flatFilters?['character','space','prop','song']:workspace==='materials.workspace'?['image','audio','video','project','document']:[];
  const categoryOptions=[['',flatFilters?'全部实体':'全部内容'],...categories.map(value=>[value,productionLabels[value]||({image:'图像',audio:'声音',video:'视频',project:'工程',document:'说明文件'})[value]])];
  const facetButtons=[];
  for(const [key,label,options] of [['kind','记录类型',kindOptions],['category','内容分类',categoryOptions]]){
    if((key==='kind'&&flatFilters)||(key==='category'&&!categories.length))continue;
    if(flatFilters){
      const group=el('div','production-filter-group'),labelId=`production-filter-${key}-label`;
      group.setAttribute('role','group');group.setAttribute('aria-labelledby',labelId);nodeText('span','production-filter-label',label,group).id=labelId;
      const choices=el('div','production-filter-options');group.append(choices);
      for(const [value,title] of options){
        const button=productionButton(choices,'',()=>{filters[key]=filters[key]===value?'':value;refreshIndex()});
        button.className='production-filter-chip';button.dataset.filterKey=key;button.dataset.filterValue=value;
        if(productionEntitySymbols[value]){button.append(productionEntityIcon(value));button.dataset.entityType=value}
        nodeText('span',null,title,button);const count=nodeText('b','production-filter-count','0',button);count.setAttribute('aria-hidden','true');
        facetButtons.push({button,count,key,value,label,title});
      }
      filterPanel.append(group);
    }else{
      const select=el('select');select.setAttribute('aria-label',label);
      for(const [value,title] of options)select.append(new Option(title,value));
      filterSelects[key]=select;select.onchange=()=>{filters[key]=select.value;refreshIndex()};toolbar.append(select);
    }
  }
  if(flatFilters){resultSummary=nodeText('p','production-filter-summary','',filterPanel);resultSummary.setAttribute('role','status')}
  host.append(filterPanel);
  const board=el('div','production-board'+(flatFilters?' entity-review-board':'')),index=el('nav','production-index'),reader=el('article','production-reader');index.id='production-index';index.setAttribute('aria-label',flatFilters?'制作实体':'制作记录');reader.id='production-reader';board.append(index,reader);host.append(board);
  const byId=new Map(result.records.map(r=>[r.object_id,r]));
  const contextOf=(r,seen=new Set())=>{if(!r||seen.has(r.object_id))return {};seen.add(r.object_id);const p=r.payload;if(p.episode||p.source)return {episode:(p.episode||p.source).object_id,scene:p.scene_id||p.source?.scene_id,number:p.number};return contextOf(byId.get(p.scope?.object_id),seen)};
  const contexts=new Map(result.records.map(r=>[r.object_id,contextOf(r)]));
  const workspaceRows=result.records.filter(r=>flatFilters?r.kind==='ENTITY':productionGroups[workspace].includes(r.kind)&&!(r.kind==='RELATION'&&r.payload.relation_type==='entity')&&r.payload.status!=='withdrawn');
  const childrenByEntity=new Map(workspaceRows.map(r=>[r.object_id,[]]));
  if(flatFilters)for(const r of result.records.filter(r=>productionCompleteState(r)||r.kind==='REPRESENTATION'&&!r.payload.review_model))for(const id of productionEntityIds(r,byId))childrenByEntity.get(id)?.push(r);
  const searchTexts=new Map(workspaceRows.map(r=>[r.object_id,JSON.stringify([r.payload,...(childrenByEntity.get(r.object_id)||[]).map(child=>child.payload)]).toLowerCase()]));
  const commonSettings=flatFilters?result.records.filter(r=>r.kind==='REPRESENTATION'&&!r.payload.review_model&&!productionEntityIds(r,byId).length):[];
  if(commonSettings.length){
    const common=el('section','production-common-settings');common.setAttribute('aria-label','项目共用设定');
    nodeText('h3',null,'项目共用设定',common);
    for(const r of commonSettings)productionRefLink(common,productionRef(r));host.insertBefore(common,board);
  }
  const matches=(r,selection=filters)=>{
    const context=contexts.get(r.object_id),category=selection.category;
    return (!selection.kind||r.kind===selection.kind)&&
      (!category||r.payload.entity_type===category||r.payload.media_type===category||byId.get(r.payload.entity?.object_id)?.payload.entity_type===category)&&
      (!selection.episode||context.episode===selection.episode)&&(!selection.scene||context.scene===selection.scene)&&searchTexts.get(r.object_id).includes(search.value.trim().toLowerCase());
  };
  const episodeFilter=el('select'),sceneFilter=el('select');episodeFilter.setAttribute('aria-label','制作分集');sceneFilter.setAttribute('aria-label','制作场次');episodeFilter.append(new Option('全剧各集',''));sceneFilter.append(new Option('全部场次',''));
  const episodes=state.screenplays.flatMap(s=>s.episodes),scopeReview=el('section','production-scope-review');
  let scopeButton,scopeReviewEpoch=0;
  const scopeRecord=()=>filters.scene?workspaceRows.find(r=>r.kind==='PREPARATION'&&contexts.get(r.object_id).episode===filters.episode&&contexts.get(r.object_id).scene===filters.scene):episodes.find(e=>e.object_id===filters.episode);
  const clearScopeReview=()=>{scopeReviewEpoch++;scopeReview.replaceChildren();scopeReview.hidden=true;if(scopeButton){scopeButton.textContent=filters.scene?'检查本场素材缺项':'检查本集素材缺项';scopeButton.disabled=!filters.episode||!scopeRecord()}};
  if(workspace==='production.workspace'){
    const present=new Set([...contexts.values()].map(c=>c.episode));
    const available=episodes.filter(e=>present.has(e.object_id));
    for(const ep of available)episodeFilter.append(new Option(ep.payload.title,ep.object_id));
    const requestedContext=requested&&productionGroups[workspace].includes(requested.kind)?contexts.get(requested.object_id):null;
    filters.episode=requestedContext?(requestedContext.episode||''):inputLocks.flatMap(r=>r.payload.episodes).find(ref=>available.some(e=>e.object_id===ref.object_id&&e.id===ref.revision_id))?.object_id||available[0]?.object_id||'';
    filters.scene=requestedContext?.scene||'';
    filters.kind=requestedContext?requested.kind:workspaceRows.some(r=>r.kind==='SHOT_DESIGN'&&contexts.get(r.object_id).episode===filters.episode)?'SHOT_DESIGN':'PREPARATION';
    episodeFilter.value=filters.episode;filterSelects.kind.value=filters.kind;
    toolbar.append(episodeFilter,sceneFilter);
    scopeButton=productionButton(toolbar,'检查本集素材缺项',async()=>{
      const subject=scopeRecord();if(!subject)return;
      const check=++scopeReviewEpoch,isCurrent=()=>state.workspace===workspace&&productionLoadEpoch===epoch&&scopeReviewEpoch===check;
      scopeReview.hidden=false;scopeReview.replaceChildren();nodeText('p',null,'正在检查所选范围…',scopeReview);scopeButton.disabled=true;
      try{await renderProductionReadiness(scopeReview,subject,{isCurrent,replace:true,title:subject.payload.title,close:clearScopeReview})}
      catch(e){if(isCurrent())nodeText('p','production-issue',e.message,scopeReview)}
      finally{if(isCurrent())scopeButton.disabled=false}
    });
    scopeReview.hidden=true;scopeReview.setAttribute('aria-label','所选集场素材缺项');host.insertBefore(scopeReview,board);
  }
  const renderIndex=()=>{
    index.replaceChildren();
    const matchingRows=workspaceRows.filter(r=>matches(r));
    for(const kind of productionGroups[workspace]){
      const rows=matchingRows.filter(r=>r.kind===kind).sort((a,b)=>{const x=contexts.get(a.object_id),y=contexts.get(b.object_id);return (x.episode||'').localeCompare(y.episode||'')||(x.scene||'').localeCompare(y.scene||'')||(x.number||0)-(y.number||0)||a.object_id.localeCompare(b.object_id)});
      if(!rows.length)continue;
      nodeText('h3',null,`${productionKinds[kind]} · ${rows.length}`,index);
      for(const r of rows){
        const children=childrenByEntity.get(r.object_id)||[],states=children.filter(child=>child.kind==='STATE').length;
        const b=productionButton(index,r.payload.title,()=>openProductionRecord(r.object_id));b.dataset.objectId=r.object_id;
        b.classList.toggle('active',(flatFilters?state.productionEntityId:state.productionSelected?.object_id)===r.object_id);
        if(flatFilters){b.dataset.entityType=r.payload.entity_type;const icon=el('span','production-entity-avatar');icon.append(productionEntityIcon(r.payload.entity_type));b.prepend(icon);nodeText('span','production-state-count',`${states} 个完整状态`,b);const settings=children.filter(child=>child.kind==='REPRESENTATION').length;nodeText('small',null,`${productionLabels[r.payload.entity_type]}${settings?' · '+settings+' 项制作设定':''}`,b)}
        else nodeText('small',null,`${productionLabels[r.payload.entity_type]||contexts.get(r.object_id).scene||''} 版本 ${r.version}`,b);
      }
    }
    if(!index.childElementCount)nodeText('p',null,workspaceRows.length?'没有匹配记录，请调整筛选条件。':'尚未登记记录，可从整理后的生产数据批量导入。',index);
    return matchingRows;
  };
  const refreshIndex=()=>{
    const rows=renderIndex();
    for(const facet of facetButtons){
      const count=workspaceRows.filter(r=>matches(r,{...filters,[facet.key]:facet.value})).length,selected=filters[facet.key]===facet.value;
      facet.count.textContent=count;facet.button.classList.toggle('is-active',selected);facet.button.classList.toggle('is-zero',!count);
      facet.button.setAttribute('aria-pressed',String(selected));facet.button.setAttribute('aria-label',`${facet.label}：${facet.title}，${count} 个实体`);
    }
    if(resultSummary){
      resultSummary.textContent=`当前结果：${rows.length} 个实体`;
      clearFilters.disabled=!search.value&&!Object.values(filters).some(Boolean);
    }
  };
  const renderScenes=()=>{sceneFilter.replaceChildren(new Option('全部场次',''));const scenes=[...new Set([...contexts.values()].filter(c=>c.scene&&(!filters.episode||c.episode===filters.episode)).map(c=>c.scene))].sort();for(const scene of scenes)sceneFilter.append(new Option(scene,scene));sceneFilter.value=filters.scene;refreshIndex();clearScopeReview()};
  const firstMatchingRow=()=>productionGroups[workspace].flatMap(kind=>workspaceRows.filter(r=>r.kind===kind&&matches(r)).sort((a,b)=>a.object_id.localeCompare(b.object_id)))[0];
  const openFilteredScope=()=>{const row=firstMatchingRow();if(row)openProductionRecord(row.object_id).catch(e=>toast(e.message));else{++productionReadEpoch;state.productionSelected=null;reader.replaceChildren();const url=new URL(location.href);url.searchParams.delete('production_object');url.searchParams.delete('production_revision');history.replaceState(null,'',url);nodeText('p',null,'当前范围没有此类记录，请调整记录类型。',reader);renderComments()}};
  search.oninput=refreshIndex;sceneFilter.onchange=()=>{filters.scene=sceneFilter.value;refreshIndex();clearScopeReview();openFilteredScope()};episodeFilter.onchange=()=>{filters.episode=episodeFilter.value;filters.scene='';if(!workspaceRows.some(r=>matches(r))){filters.kind=workspaceRows.some(r=>r.kind==='PREPARATION'&&(!filters.episode||contexts.get(r.object_id).episode===filters.episode))?'PREPARATION':'';filterSelects.kind.value=filters.kind}renderScenes();openFilteredScope()};renderScenes();
  const candidate=(requested&&productionGroups[workspace].includes(requested.kind)?requested:null)||(flatFilters?result.records.find(r=>r.kind==='ENTITY'&&r.object_id===param.get('production_entity')):null)||firstMatchingRow();
  if(candidate)await openProductionRecord(candidate.object_id,selected===candidate.object_id?param.get('production_revision'):null);else{state.productionSelected=null;nodeText('p',null,'此入口已开放，当前实例尚未登记生产数据。',reader);renderComments()}
}
async function openProductionRecord(objectId,revisionId=null,navigate=false,entityId=null){
  const workspaceAtStart=state.workspace,epoch=++productionReadEpoch;
  let detail=await api('/api/production?'+new URLSearchParams({object_id:objectId,...(revisionId?{revision_id:revisionId}:{})}));
  if(epoch!==productionReadEpoch||state.workspace!==workspaceAtStart)return;
  if(navigate&&!productionGroups[state.workspace]?.includes(detail.record.kind)){const workspace=Object.keys(productionGroups).find(k=>productionGroups[k].includes(detail.record.kind));const url=new URL(location.href);url.searchParams.set('production_object',objectId);url.searchParams.set('production_revision',detail.record.id);history.replaceState(null,'',url);switchWorkspace(workspace);return}
  if(!isProduction()||!productionGroups[state.workspace].includes(detail.record.kind))return;
  const byId=new Map(state.productionRecords.map(r=>[r.object_id,r]));
  if(detail.record.kind==='REPRESENTATION'){
    // Resolve historical state ownership for the exact representation being read.
    await Promise.all((detail.record.payload.states||[]).map(async ref=>{if(byId.get(ref.object_id)?.id!==ref.revision_id){const data=await api('/api/production?'+new URLSearchParams({object_id:ref.object_id,revision_id:ref.revision_id}));byId.set(ref.object_id,data.record)}}));
    if(epoch!==productionReadEpoch||state.workspace!==workspaceAtStart)return;
  }
  const owners=productionEntityIds(detail.record,byId),url=new URL(location.href);
  const preferred=entityId||url.searchParams.get('production_entity')||state.productionEntityId;
  const owner=owners.includes(preferred)?preferred:owners[0]||null;
  if(state.workspace==='settings.workspace'&&owner&&typeof openEntityReview==='function'&&(detail.record.kind!=='REPRESENTATION'||detail.record.payload.review_model==='entity-review-v1')){
    await openEntityReview(owner,detail,epoch,revisionId);return;
  }
  state.entityReview=null;state.materialReview=state.workspace==='materials.workspace'&&detail.record.kind==='ASSET'?detail:null;
  let entityDetail=null,childDetail=null;
  if(state.workspace==='settings.workspace'&&owner){
    const read=async record=>record?api('/api/production?'+new URLSearchParams({object_id:record.object_id,revision_id:record.id})):null;
    entityDetail=detail.record.kind==='ENTITY'?detail:await read(byId.get(owner));
    if(detail.record.kind==='ENTITY'){
      // Entity browsing starts at its first complete form; exact entity review
      // links retain their target and the state already being read, if any.
      const previous=revisionId&&state.productionEntityId===owner?state.productionChildDetail:null;
      const base=productionEntityChildren(owner).filter(productionCompleteState).sort(productionStateOrder)[0];
      childDetail=previous||await read(base);
      if(!revisionId&&childDetail)detail=childDetail;
    }else childDetail=detail;
    if(epoch!==productionReadEpoch||state.workspace!==workspaceAtStart)return;
  }
  state.productionEntityId=owner;state.productionEntityDetail=entityDetail;state.productionChildDetail=childDetail;
  const materialTarget=state.materialReview&&materialRows(detail).find(r=>r.id===url.searchParams.get('material_target'));
  focusProductionReview(materialTarget?{record:materialTarget,history:[materialTarget],uses:[]}:detail,false);
  for(const button of document.querySelectorAll('#production-index button'))button.classList.toggle('active',button.dataset.objectId===(state.workspace==='settings.workspace'?owner:detail.record.object_id));
  renderProductionReader();renderComments();
}
function focusProductionReview(detail,paint=true){
  const r=detail.record;
  if(state.productionSelected?.id!==r.id){state.anchor=null;state.editing=null;state.selected=null;state.drawMode=null}
  state.productionSelected=r;state.productionDetail=detail;
  const url=new URL(location.href);url.searchParams.set('production_object',r.object_id);url.searchParams.set('production_revision',r.id);
  if(typeof isEntityReview==='function'&&isEntityReview()&&!state.entityReview.historical&&!state.entityReview.historicalTarget)url.searchParams.delete('production_revision');
  if(state.workspace==='settings.workspace'&&state.productionEntityId){url.searchParams.set('production_entity',state.productionEntityId);if(state.productionChildDetail?.record)url.searchParams.set('entity_state',state.productionChildDetail.record.object_id);}else url.searchParams.delete('production_entity');
  if(typeof isMaterialReview==='function'&&isMaterialReview()){url.searchParams.set('production_object',state.materialReview.record.object_id);url.searchParams.set('production_revision',state.materialReview.record.id);url.searchParams.set('material_target',r.id)}
  history.replaceState(null,'',url);
  for(const blocks of document.querySelectorAll('[data-production-blocks]')){if(blocks.dataset.productionBlocks===r.id)blocks.id='production-blocks';else{blocks.removeAttribute('id');for(const para of blocks.querySelectorAll('.comment-flash'))para.classList.remove('comment-flash')}}
  if(paint){paintProductionReview();renderComments()}
}
function productionFields(parent,fields){const dl=el('dl','production-fields');for(const [label,value] of fields){if(value===undefined||value===null||value==='')continue;nodeText('dt',null,label,dl);nodeText('dd',null,typeof value==='string'?value:JSON.stringify(value),dl)}parent.append(dl)}
function productionList(parent,title,items){if(!items?.length)return;nodeText('h3',null,title,parent);const list=el('ul');for(const item of items){const row=el('li');if(typeof item==='string')row.textContent=item;else if(item.speaker){nodeText('p',null,`${item.speaker}${item.type==='singing'?'（演唱）':'（对白）'}：${item.text}`,row);if(item.fps&&Number.isFinite(item.planned_start_frame))nodeText('small',null,`镜内预计 ${(item.planned_start_frame/item.fps).toFixed(2)}–${(item.planned_end_frame/item.fps).toFixed(2)} 秒；${item.timing_status}`,row);productionRefLink(row,item.source,'查看原文')}else row.textContent=item.description||JSON.stringify(item);list.append(row)}parent.append(list)}
function productionMedia(parent,component,review=true){
  const url='/api/production/files/'+encodeURIComponent(component.file);
  if(component.mime.startsWith('image/')){if(review)parent.append(renderStructureVisual({...component,title:state.productionSelected.payload.title,alt:state.productionSelected.payload.title,description:`${component.role} · ${component.width}×${component.height}`},true));else{const img=el('img');img.width=component.width;img.height=component.height;img.src=url;img.alt=component.id;parent.append(img)}}
  else if(component.mime.startsWith('audio/')||component.mime.startsWith('video/'))reviewMediaPlayer(parent,component,state.productionSelected,{},review);
  link(`下载 ${component.role} · ${component.file.slice(0,12)}…`,url,parent);nodeText('p','production-meta',`${component.mime} · ${component.bytes.toLocaleString()} bytes · SHA-256 ${component.sha256}`,parent);
}
function renderProductionReader(){
  const root=$('#production-reader');root.replaceChildren();
  if(typeof isEntityReview==='function'&&isEntityReview()){renderEntityReview(root);paintProductionReview();return}
  if(typeof isMaterialReview==='function'&&isMaterialReview()){renderMaterialWorkspace(root,state.materialReview);paintProductionReview();return}
  if(state.workspace==='settings.workspace'&&state.productionEntityDetail){
    const entity=el('section','production-entity-basics');entity.setAttribute('aria-label','实体基础信息');root.append(entity);
    renderProductionRecord(entity,state.productionEntityDetail,true);
    renderProductionEntityNavigation(root,state.productionChildDetail?.record);
    if(state.productionChildDetail){const child=el('section','production-entity-state');child.setAttribute('aria-label','状态与设定详情');root.append(child);renderProductionRecord(child,state.productionChildDetail)}
  }else renderProductionRecord(root,state.productionDetail);
  paintProductionReview();
}
function renderProductionRecord(root,detail,entityCard=false){
  const r=detail.record,p=r.payload,activate=action=>()=>{focusProductionReview(detail);return action()};
  const review=entityCard?el('details','production-entity-review'):root;
  if(entityCard)nodeText('summary',null,'实体版本与评论',review);
  nodeText('small','production-pill',entityCard?'实体基础信息 · '+productionLabels[p.entity_type]:productionKinds[r.kind],root);nodeText('h2',null,p.title,root);nodeText('p','production-meta',`版本 ${r.version} · ${r.id}${r.id===r.current_revision?' · 当前版本':' · 历史版本'}`,review);
  const bar=el('div','production-toolbar'),versions=el('select');versions.setAttribute('aria-label',entityCard?'选择实体版本':'选择精确版本');for(const v of detail.history)versions.append(new Option(`版本 ${v.version} · ${v.created_at}`,v.id));versions.value=r.id;versions.onchange=()=>openProductionRecord(r.object_id,versions.value).catch(e=>toast(e.message));bar.append(versions);
  productionButton(bar,'整体意见',activate(()=>startDraft({type:'global'})));productionButton(bar,'查看评论',activate(openPanel));if(state.workspace!=='settings.workspace')productionButton(bar,'编辑说明与设定',activate(showProductionEditor));productionButton(bar,'查看所选修订的影响',async()=>{const data=await api('/api/production/impact?revision_id='+r.id);const section=el('section');nodeText('h3',null,`受影响的当前引用 ${data.affected.length}`,section);for(const use of data.affected)productionRefLink(section,use,`${productionKinds[use.kind]||use.kind} · ${use.title}`);if(!data.affected.length)nodeText('p',null,'没有查到当前下游引用。',section);root.append(section);section.scrollIntoView({block:'center'})});review.append(bar);if(entityCard)root.append(review);
  const blocks=reviewSurface(el('div'));blocks.dataset.productionBlocks=r.id;if(state.productionSelected?.id===r.id)blocks.id='production-blocks';blocks.onpointerdown=()=>focusProductionReview(detail);blocks.onfocusin=()=>focusProductionReview(detail);for(const b of p.blocks){const para=nodeText('p',null,b.text,blocks);para.dataset.blockId=b.id}root.append(blocks);
  if(productionCompleteState(r)){
    nodeText('p','production-meta','这是该实体在一个时刻的完整形态，可跨场复用。整体参考说明全貌，角度、局部和声音作为补充。',root);
    productionFields(root,[['整体参考类型',({image:'图像',audio:'声音',none:'仅提及，无媒体生产要求'})[p.reference_media]]]);
    const candidates=state.productionRecords.filter(a=>a.kind==='ASSET'&&a.payload.state_coverage?.some(c=>c.state.revision_id===r.id));
    if(candidates.length){nodeText('h3',null,'关联素材候选',root);for(const a of candidates)for(const c of a.payload.state_coverage.filter(c=>c.state.revision_id===r.id)){productionRefLink(root,productionRef(a),`${c.role==='overall'?'整体':'补充'} · ${a.payload.title} · 版本 ${a.version} · ${c.component_id}`);nodeText('p',null,c.detail,root)}}
    if(p.reference_media!=='none'){
      if(r.id===r.current_revision){productionButton(root,'添加细节或声音需求',()=>showProductionStateNeed(root,r));const inputs=el('div','production-state-references');root.append(inputs);renderProductionReadiness(inputs,r,{isCurrent:()=>root.isConnected}).catch(e=>nodeText('p','production-issue',e.message,inputs))}
      else nodeText('p','production-meta','这是历史完整状态；现有参考与采用请在当前版本中核对。',root);
    }
  }
  productionFields(root,[['身份类型',productionLabels[p.entity_type]],['别名',p.aliases?.join('、')],['历史状态维度',productionCompleteState(r)?null:p.dimensions],['叙事目的',p.purpose],['构图与景别',p.framing],['空间关系',p.spatial],['动作开始',p.action_start],['动作结束',p.action_end],['预计时长',p.duration_frames&&p.fps?`${(p.duration_frames/p.fps).toFixed(2)} 秒 · ${p.duration_frames} 帧 / ${p.fps} fps`:null],['连续性',p.continuity],['输入用途',productionLabels[p.usage]],['制作状态',p.status],['工具',p.tool],['模型',p.model],['审阅结论',productionLabels[p.verdict]],['审阅者',p.actor],['说明',p.reason],['画幅',p.width&&p.height?`${p.width}×${p.height}`:null]]);
  productionList(root,'剧本事实',p.facts);productionList(root,'制作选择',p.choices);productionList(root,'待确认',p.unknowns);productionList(root,'声音设计',p.sound);
  renderProductionTransitions(root,p.state_transitions);
  if(p.state_coverage?.length){nodeText('h3',null,'素材所说明的完整状态',root);for(const c of p.state_coverage){const row=el('div','production-need');productionRefLink(row,c.state);nodeText('p',null,`${c.role==='overall'?'整体参考':'细节／角度／声音补充'} · ${c.component_id} · ${c.detail}`,row);if(c.crop||c.range)productionFields(row,[['裁切',c.crop],['时间段',c.range]]);root.append(row)}}
  if(r.kind==='ASSET'&&r.id===r.current_revision)productionButton(root,'维护整体与细节关联',()=>showProductionCoverage(root,r));
  if(p.lyrics){nodeText('h3',null,'歌词原文与段落',root);for(const lyric of p.lyrics){nodeText('strong',null,lyric.section,root);nodeText('p',null,lyric.text,root);productionRefLink(root,lyric.source,'查看歌词正文依据')}nodeText('p',null,p.composition_status,root);productionList(root,'作品内容待确认',p.content_unknowns)}
  const references=entityCard?el('details','production-entity-references'):root;if(entityCard){nodeText('summary',null,'来源、出场与历史引用',references);root.append(references)}
  const refs=el('section');nodeText('h3',null,'来源与依赖',refs);for(const key of ['entity','episode','screenplay','source','scope','production','target','asset','assembly'])if(p[key]?.revision_id)productionRefLink(refs,p[key],`${{entity:'所属实体',source:'剧情依据',production:'实际制作',scope:'使用位置',target:'审阅对象',episode:'所属分集',screenplay:'正式整版'}[key]||key}：${productionName(p[key])}`);for(const key of ['sources','entities','states','subjects','inputs','outputs','dependencies','previous_states'])for(const ref of p[key]||[])if(ref.revision_id)productionRefLink(refs,ref);references.append(refs);
  if(p.occurrences){nodeText('h3',null,`全场出场检查 · ${p.occurrences.length} 项`,root);for(const occurrence of p.occurrences){const row=el('div','production-need');productionRefLink(row,occurrence.entity);nodeText('span','production-pill',productionLabels[occurrence.mode],row);for(const ref of occurrence.states)productionRefLink(row,ref);renderProductionTransitions(row,occurrence.transitions);for(const ref of occurrence.evidence)productionRefLink(row,ref,'查看正文依据');root.append(row)}}
  if(p.components?.length){nodeText('h3',null,'实际文件组成',root);const select=el('select');select.id='production-component';select.setAttribute('aria-label','原件与预览组成');for(const c of p.components)select.append(new Option(`${c.role} · ${c.id}`,c.id));const media=el('section');const draw=()=>{media.replaceChildren();productionMedia(media,p.components.find(c=>c.id===select.value));paintProductionReview()};select.onchange=draw;root.append(select,media);draw();if(r.kind==='ASSET'&&detail.history.length>1)productionButton(root,'并排比较版本',()=>showProductionCompare(root));if(r.kind==='ASSET')productionButton(root,'记录本版本审阅结论',()=>showProductionJudgment(root))}
  if(p.prompt){const detail=el('details');nodeText('summary',null,'实际提示词与参数',detail);nodeText('p',null,p.prompt,detail);nodeText('pre',null,JSON.stringify({parameters:p.parameters,receipt:p.receipt,usage:p.usage,lineage:p.lineage},null,2),detail);root.append(detail)}
  if(p.items){nodeText('h3',null,'时间线精确引用',root);const table=el('table','production-table');for(const item of p.items){const row=el('tr');nodeText('td',null,item.track,row);nodeText('td',null,`${(item.start_frame/p.fps).toFixed(2)}–${((item.start_frame+item.duration_frames)/p.fps).toFixed(2)} 秒`,row);const cell=el('td');productionRefLink(cell,item.asset);productionRefLink(cell,item.shot);nodeText('small',null,item.motion||'',cell);row.append(cell);table.append(row)}root.append(table)}
  const relatedVersions=r.id===r.current_revision?detail.history:[r];
  const related=(state.productionRecords||[]).filter(other=>other.object_id!==r.object_id&&!(r.kind==='ENTITY'&&['STATE','REPRESENTATION'].includes(other.kind))).map(other=>({other,versions:relatedVersions.filter(v=>JSON.stringify(other.payload).includes('"'+v.id+'"'))})).filter(item=>item.versions.length);
  if(related.length){nodeText('h3',null,'出场与当前使用',references);for(const {other,versions} of related)productionRefLink(references,productionRef(other),`${productionKinds[other.kind]} · ${other.payload.title}${relatedVersions.length>1?' · 引用版本 '+versions.map(v=>v.version).join('、'):''}`)}
  if(['SHOT_DESIGN','PREPARATION'].includes(r.kind)){if(r.id===r.current_revision)renderProductionReadiness(root,r).catch(e=>nodeText('p','production-issue',e.message,root));else nodeText('p','production-meta','当前正在阅读历史修订。查看现有缺项或改变采用，请切换到当前版本；历史制作输入保留在下方精确引用中。',root)}
  const details=el('details');nodeText('summary',null,'完整记录与历史引用',details);nodeText('pre',null,JSON.stringify({record:r,uses:detail.uses},null,2),details);references.append(details);
}
function productionCommentTextNode(anchor){return [...document.querySelectorAll('#production-blocks [data-block-id]')].find(node=>node.dataset.blockId===anchor.block_id&&(!node.hasAttribute('data-anchor-offset')||(Number(node.dataset.anchorOffset)<=anchor.start&&anchor.start<Number(node.dataset.anchorOffset)+Array.from(node.textContent).length)))}
function paintProductionReview(){
  if(!isProduction())return;paintStructureRegions();for(const player of document.querySelectorAll('.review-media-player'))player.reviewPaintComments?.();
  const selected=state.comments.find(c=>c.id===state.selected&&c.target_revision_id===state.productionSelected?.id),target=selected?productionCommentTextNode(selected.anchor):null;
  for(const para of document.querySelectorAll('#production-blocks [data-block-id]'))para.classList.toggle('comment-flash',para===target);
}
function renderProductionTransitions(root,transitions){
  if(!transitions?.length)return;
  const section=el('section','production-transitions');nodeText('h3',null,'完整状态转换',section);
  for(const t of transitions){const row=el('div','production-need');productionRefLink(row,t.from);nodeText('span',null,' → ',row);productionRefLink(row,t.to);nodeText('p',null,t.action,row);productionRefLink(row,t.source,'查看转换依据');section.append(row)}
  root.append(section);
}
function showProductionStateNeed(root,r){
  const box=el('section','production-editor');nodeText('h3',null,'补充整体参考的细节、角度或声音',box);
  const title=el('input'),purpose=el('textarea'),media=el('select'),required=el('select');
  title.setAttribute('aria-label','补充需求名称');title.placeholder='例如：掌心伤处特写';purpose.setAttribute('aria-label','补充需求说明');purpose.placeholder='说明要看清或听清的具体内容';
  media.setAttribute('aria-label','补充素材类型');for(const [key,label] of [['image','图像'],['audio','声音'],['video','视频']])media.append(new Option(label,key));
  required.setAttribute('aria-label','是否必需');required.append(new Option('可选补充','false'),new Option('生产必需','true'));box.append(title,purpose,media,required);
  productionButton(box,'保存补充需求',async()=>{
    if(!title.value.trim()||!purpose.value.trim())throw Error('请填写名称与具体用途');
    const id='need-'+crypto.randomUUID(),slot='detail-'+crypto.randomUUID();
    const payload={format:'production-requirement-v1',title:r.payload.title+' · '+title.value.trim(),blocks:[{id:'purpose',text:purpose.value.trim()}],scope:productionRef(r),slot,required:required.value==='true',purpose:purpose.value.trim(),media_type:media.value,usage:media.value==='audio'?'post_audio':'generation_input',entities:[r.payload.entity],states:[productionRef(r)],specification:{reference_role:'detail'}};
    await api('/api/production/import',{method:'POST',body:JSON.stringify({format:'production-import-v1',records:[{object_id:id,kind:'REQUIREMENT',expected_version:0,payload}]})});await loadProductionWorkspace();await openProductionRecord(r.object_id);toast('补充需求已登记，整体参考仍单独保留');
  });productionButton(box,'取消',()=>box.remove());root.prepend(box);
}
function showProductionCoverage(root,r){
  const box=el('section','production-editor');box.setAttribute('aria-label','整体与细节关联');
  nodeText('h3',null,'核对这份素材能说明哪些完整状态',box);
  nodeText('p',null,'保存为素材的新候选修订。请选择准确状态、文件组成和覆盖内容；整体参考须说明全貌，细节可说明角度、局部或声音。实际制作记录和既有采用保留原引用。',box);
  const entries=[],list=el('div');box.append(list);
  const choices=state.productionRecords.filter(productionCompleteState).map(s=>({ref:productionRef(s),label:`${s.payload.title} · 版本 ${s.version}`}));
  for(const c of r.payload.state_coverage||[])if(!choices.some(s=>s.ref.revision_id===c.state.revision_id))choices.push({ref:c.state,label:`${productionName(c.state)} · 历史修订 ${c.state.revision_id.slice(0,12)}`});
  const add=(value={})=>{
    const row=el('div','production-need'),selected=el('select'),role=el('select'),component=el('select'),detail=el('textarea');
    selected.setAttribute('aria-label','关联的完整状态');selected.append(new Option('选择完整状态',''));for(const choice of choices)selected.append(new Option(choice.label,choice.ref.revision_id));selected.value=value.state?.revision_id||'';
    role.setAttribute('aria-label','参考角色');role.append(new Option('整体参考','overall'),new Option('细节／角度／声音补充','detail'));role.value=value.role||'detail';
    component.setAttribute('aria-label','关联文件组成');for(const c of r.payload.components)component.append(new Option(`${c.id} · ${c.role}`,c.id));if(value.component_id)component.value=value.component_id;
    detail.setAttribute('aria-label','覆盖内容说明');detail.value=value.detail||'';detail.placeholder='这份素材能说明该状态的哪些内容';row.append(selected,role,component,detail);
    const bounds={};for(const [key,label] of [['start_seconds','范围起点秒'],['end_seconds','范围终点秒'],['x','区域左边'],['y','区域上边'],['width','区域宽度'],['height','区域高度']]){const input=el('input');input.type='number';input.min='0';input.step='.01';input.setAttribute('aria-label',label);input.placeholder=label+'（可选）';input.value=value.range?.[key]??value.crop?.[key]??'';bounds[key]=input;row.append(input)}
    const entry={row,selected,role,component,detail,bounds};entries.push(entry);productionButton(row,'移除此关联',()=>{entries.splice(entries.indexOf(entry),1);row.remove()});list.append(row);
  };
  for(const c of r.payload.state_coverage||[])add(c);if(!entries.length)add();
  productionButton(box,'增加一个状态或细节关联',()=>add());
  productionButton(box,'保存关联新修订',async()=>{
    const coverage=entries.map(e=>{
      const choice=choices.find(c=>c.ref.revision_id===e.selected.value);if(!choice||!e.detail.value.trim())throw Error('每个关联都需选择完整状态并说明覆盖内容');
      const value={state:choice.ref,role:e.role.value,component_id:e.component.value,detail:e.detail.value.trim()};
      for(const [key,fields] of [['range',['start_seconds','end_seconds']],['crop',['x','y','width','height']]])if(fields.some(f=>e.bounds[f].value!=='')){if(fields.some(f=>e.bounds[f].value===''))throw Error('时间范围或区域的字段必须填完整');value[key]=Object.fromEntries(fields.map(f=>[f,Number(e.bounds[f].value)]))}
      return value;
    });
    const p=structuredClone(r.payload);p.state_coverage=coverage;for(const c of coverage)if(!p.states.some(s=>s.revision_id===c.state.revision_id))p.states.push(c.state);
    await api('/api/production/import',{method:'POST',body:JSON.stringify({format:'production-import-v1',records:[{object_id:r.object_id,kind:'ASSET',expected_version:r.version,payload:p}]})});await loadProductionWorkspace();await openProductionRecord(r.object_id);toast('新候选关联已保存，尚未自动采用');
  });productionButton(box,'取消',()=>box.remove());root.prepend(box);
}
function locateProductionComment(comment,local=false){
  if(!local&&typeof isEntityReview==='function'&&isEntityReview())return locateEntityReviewComment(comment);
  if(!local&&typeof isMaterialReview==='function'&&isMaterialReview())return locateMaterialComment(comment);
  if(comment.anchor_state?.valid===false)return toast(comment.anchor_state.reason);
  state.selected=comment.id;const a=comment.anchor,select=$('#production-component'),component=a.component_id||a.visual_id;
  if(select&&component&&select.value!==component){select.value=component;select.onchange()}
  // Component ids can repeat across state references and unassigned candidates.
  // Locate the exact asset revision before looking up its image or player.
  const exact=`[data-review-revision="${CSS.escape(comment.target_revision_id)}"]`,mediaRoot=typeof isEntityReview==='function'&&isEntityReview()?(document.querySelector('[data-comment-media]'+exact)||document.querySelector(exact)):$('#production-reader');
  if(a.type==='time'){const media=mediaRoot?.querySelector(`[data-component-id="${CSS.escape(a.component_id)}"]`);if(media){media.dataset.reviewSeek=a.start_seconds;media.currentTime=a.start_seconds;const player=media.closest?.('.review-media-player');if(player?.reviewLocate)player.reviewLocate(a);else{media.scrollIntoView({block:'center'});media.focus()}}}
  else{const target=a.block_id?productionCommentTextNode(a):a.visual_id?mediaRoot?.querySelector(`[data-visual-id="${CSS.escape(a.visual_id)}"]`):mediaRoot||$('#production-reader');target?.scrollIntoView({block:'center'})}
  paintProductionReview();renderComments();
}
function showProductionEditor(){
  const r=state.productionSelected,p=structuredClone(r.payload),root=$('#production-reader');if(r.id!==r.current_revision)throw Error('历史修订不可改写，请先选择当前版本');
  const form=el('form','production-editor');nodeText('h3',null,'保存为新修订',form);const controls=[];
  for(const key of ['title','aliases','facts','choices','unknowns'])if(p[key]!==undefined){nodeText('label',null,({title:'名称',aliases:'别名，每行一个',facts:'剧本事实，每行一项',choices:'制作选择，每行一项',unknowns:'待确认，每行一项'})[key],form);const input=el(key==='title'?'input':'textarea');input.value=Array.isArray(p[key])?p[key].join('\n'):p[key];input.setAttribute('aria-label',({title:'名称',aliases:'别名，每行一个',facts:'剧本事实，每行一项',choices:'制作选择，每行一项',unknowns:'待确认，每行一项'})[key]);controls.push([key,input]);form.append(input)}
  if(productionCompleteState(r))for(const [key,value] of Object.entries(p.dimensions)){const label=productionDimensionLabels[key]||key;nodeText('label',null,label,form);const area=el('textarea');area.setAttribute('aria-label',label);area.value=value;area.oninput=()=>{p.dimensions[key]=area.value;p.blocks=[{id:'description',text:Object.entries(p.dimensions).map(([k,v])=>`${productionDimensionLabels[k]||k}：${v}`).join('\n')}]};form.append(area)}
  else for(const block of p.blocks){nodeText('label',null,`说明 · ${block.id}`,form);const area=el('textarea');area.setAttribute('aria-label',`说明 · ${block.id}`);area.value=block.text;area.oninput=()=>{block.text=area.value};form.append(area)}
  productionButton(form,'保存新修订',async()=>{for(const [key,input] of controls)p[key]=Array.isArray(p[key])?input.value.split('\n').map(s=>s.trim()).filter(Boolean):input.value;await api('/api/production/import',{method:'POST',body:JSON.stringify({format:'production-import-v1',records:[{object_id:r.object_id,kind:r.kind,expected_version:r.version,payload:p}]})});await loadProductionWorkspace();await openProductionRecord(r.object_id);toast('新修订已保存，历史采用未改写')});productionButton(form,'取消',()=>form.remove());root.prepend(form);
}
function showProductionImport(){
  const host=$('#production-view'),box=el('section','production-editor production-import');nodeText('h2',null,'导入整理好的生产记录',box);const file=el('input');file.type='file';file.accept='.json';file.setAttribute('aria-label','生产数据 JSON');box.append(file);let document=null;const summary=el('pre');box.append(summary);file.onchange=async()=>{try{document=JSON.parse(await file.files[0].text());summary.textContent=`${document.records?.length||0} 条记录，先校验再提交。`}catch(e){document=null;summary.textContent=e.message}};
  productionButton(box,'只校验',async()=>{if(!document)throw Error('请选择 JSON');const result=await api('/api/production/import',{method:'POST',body:JSON.stringify({...document,validate_only:true})});summary.textContent=`校验通过 ${result.records.length} 条；尚未写入。`});productionButton(box,'提交导入',async()=>{if(!document)throw Error('请选择 JSON');const result=await api('/api/production/import',{method:'POST',body:JSON.stringify(document)});toast(`已导入 ${result.records.length} 条`);await loadProductionWorkspace()});productionButton(box,'关闭',()=>box.remove());host.prepend(box);
}
function showProductionUpload(){
  const box=el('section','production-editor'),host=$('#production-view');
  nodeText('h2',null,'登记已有的实际原件',box);
  nodeText('p',null,'保存文件、实际制作来源和新候选版本；原有采用保持不变。批量素材可继续使用导入文件。',box);
  const field=(label,type='input')=>{nodeText('label',null,label,box);const value=el(type);value.setAttribute('aria-label',label);box.append(value);return value};
  const file=field('实际原件');file.type='file';
  const title=field('素材名称'),existing=field('作为哪份素材的版本','select');
  existing.append(new Option('新建素材',''));
  for(const row of state.productionRecords.filter(r=>r.kind==='ASSET'))existing.append(new Option(row.payload.title,row.object_id));
  const tool=field('实际制作工具或来源'),method=field('制作方式','select');
  for(const [value,label] of [['','请选择'],['text2image','从文字生成图像'],['image2image','从图像参考生成'],['manual','人工创作或录制'],['external','其他已完成制作']])method.append(new Option(label,value));
  const note=field('实际制作说明或提示词','textarea');
  const subjects=field('关联实体（可多选，项目级素材可留空）','select');subjects.multiple=true;subjects.size=5;
  for(const row of state.productionRecords.filter(r=>r.kind==='ENTITY'))subjects.append(new Option(row.payload.title,row.object_id));
  const references=field('实际图像参考（可多选）','select');references.multiple=true;references.size=4;
  for(const row of state.productionRecords.filter(r=>r.kind==='ASSET'&&r.payload.media_type==='image'))references.append(new Option(`${row.payload.title} · 版本 ${row.version}`,row.object_id));
  const status=nodeText('p','production-meta','尚未上传。',box);
  const save=productionButton(box,'上传并登记候选',async()=>{
    if(!file.files?.[0]||!title.value.trim()||!tool.value.trim()||!note.value.trim()||!method.value)throw Error('请选择原件并填写名称、来源、制作方式和说明');
    save.disabled=true;
    try{
      const raw=file.files[0],response=await fetch('/api/production/files/'+encodeURIComponent(raw.name),{method:'PUT',body:raw});
      const result=await response.json();if(!response.ok)throw Error(result.error||'原件导入失败');
      const component=result.component||result,mediaType=component.mime.startsWith('image/')?'image':component.mime.startsWith('audio/')?'audio':component.mime.startsWith('video/')?'video':component.mime==='application/x-blender'?'project':'document';
      const selected=[...subjects.selectedOptions].map(o=>productionRef(state.productionRecords.find(r=>r.object_id===o.value)));
      const imageInputs=[...references.selectedOptions].map(o=>state.productionRecords.find(r=>r.object_id===o.value));
      if(mediaType==='image'&&method.value==='external')throw Error('图像请明确是否使用过生成参考，以保留谱系');
      if(mediaType==='image'&&((method.value==='image2image')!==Boolean(imageInputs.length)))throw Error('图生图须选出全部实际图像参考；其他方式不应带参考');
      const lineage=mediaType==='image'?{i2i_depth:imageInputs.length?Math.max(...imageInputs.map(r=>r.payload.lineage?.i2i_depth??99))+1:0,references:imageInputs.map(productionRef)}:{};
      const target=state.productionRecords.find(r=>r.object_id===existing.value),assetId=target?.object_id||'asset-'+crypto.randomUUID(),callId='call-'+crypto.randomUUID();
      const call={format:'production-call-v1',title:title.value+' · 实际制作',blocks:[{id:'description',text:note.value}],method:method.value,tool:tool.value,status:'submitted',inputs:[...selected,...imageInputs.map(productionRef)],outputs:[],prompt:note.value,lineage};
      const records=[{object_id:callId,kind:'CALL',expected_version:0,payload:call},{object_id:assetId,kind:'ASSET',expected_version:target?.version||0,payload:{format:'production-asset-v1',title:title.value,blocks:[{id:'description',text:note.value}],media_type:mediaType,subjects:selected,states:[],components:[component],production:{object_id:callId,revision_id:'@'+callId},lineage}}];
      const imported=await api('/api/production/import',{method:'POST',body:JSON.stringify({format:'production-import-v1',records})});
      const asset=imported.records.find(r=>r.id===assetId);
      await api('/api/production/import',{method:'POST',body:JSON.stringify({format:'production-import-v1',records:[{object_id:callId,kind:'CALL',expected_version:1,payload:{...call,status:'completed',outputs:[{object_id:assetId,revision_id:asset.revision}]}}]})});
      toast('原件与新候选已登记，未自动采用');await loadProductionWorkspace();await openProductionRecord(assetId);
    }catch(e){status.textContent=e.message+'。已上传的文件保留，未自动采用。';throw e}finally{save.disabled=false}
  });
  productionButton(box,'关闭',()=>box.remove());host.prepend(box);box.scrollIntoView({block:'start'});
}
function showProductionCompare(root){const box=el('section');nodeText('h3',null,'同一素材的候选比较',box);const columns=el('div','production-compare');for(let i=0;i<2;i++){const col=el('div'),select=el('select');select.setAttribute('aria-label',`比较版本 ${i+1}`);for(const r of state.productionDetail.history)select.append(new Option(`版本 ${r.version}`,r.id));select.selectedIndex=Math.min(i,select.options.length-1);const pane=el('div');const draw=()=>{pane.replaceChildren();const r=state.productionDetail.history.find(r=>r.id===select.value);productionMedia(pane,r.payload.components.find(c=>c.role==='original'),false)};select.onchange=draw;col.append(select,pane);columns.append(col);draw()}box.append(columns);root.append(box);box.scrollIntoView({block:'center'})}
function showProductionJudgment(root){const r=state.productionSelected,box=el('section','production-editor');nodeText('h3',null,'审阅结论仅针对此版本',box);const verdict=el('select');verdict.setAttribute('aria-label','审阅结果');for(const key of ['passed','changes_requested','rejected'])verdict.append(new Option(productionLabels[key],key));const actor=el('input');actor.placeholder='审阅者';actor.setAttribute('aria-label','审阅者');const reason=el('textarea');reason.placeholder='结论依据';reason.setAttribute('aria-label','结论依据');box.append(verdict,actor,reason);productionButton(box,'保存审阅',async()=>{if(!actor.value.trim()||!reason.value.trim())throw Error('请填写审阅者和结论依据');const id='review-'+crypto.randomUUID();await api('/api/production/judgment',{method:'POST',body:JSON.stringify({object_id:id,expected_version:0,payload:{format:'production-judgment-v1',title:r.payload.title+' · 审阅',blocks:[{id:'review',text:reason.value}],target:productionRef(r),verdict:verdict.value,actor:actor.value,reason:reason.value}})});toast('审阅已记录；采用保持原样');await loadProductionWorkspace()});productionButton(box,'取消',()=>box.remove());root.append(box)}
async function renderProductionReadiness(root,r,options={}){
  const readEpoch=productionReadEpoch;
  const isCurrent=options.isCurrent||(()=>state.productionSelected?.id===r.id&&productionReadEpoch===readEpoch&&root.isConnected);
  const data=await api('/api/production/readiness?scope='+encodeURIComponent(r.object_id));if(!isCurrent())return;
  const section=el('section','production-readiness');section.setAttribute('aria-label','素材缺项检查');
  if(options.title)nodeText('h3',null,options.title,section);
  nodeText('h3',null,`必要输入：${data.required_count} 项，缺项或待复核 ${data.missing_count} 项`,section);
  nodeText('p',null,data.inputs_ready?'技术输入齐备；作品是否接受单独记录。':'必要槽位尚未全部就绪。',section);
  if(data.state_coverage){
    nodeText('p','production-meta',r.kind==='STATE'?'检查此完整状态的整体与补充参考。':`完整状态：检查 ${data.state_coverage.checked_count} 次实体使用，引用 ${data.state_coverage.states.length} 个准确状态版本。`,section);
    if(data.state_coverage.issues.length){const issues=el('details');nodeText('summary','production-issue',`状态覆盖缺项 ${data.state_coverage.issues.length} 项`,issues);for(const issue of data.state_coverage.issues){const row=el('div','production-need');nodeText('p',null,({missing_complete_state:'此实体尚未关联完整状态',legacy_partial_state:'仍在使用历史局部状态',state_owner_mismatch:'状态属于其他实体',mention_state_used_for_presentation:'仅提及状态被用于实际呈现',missing_or_unmatched_state_transition:'状态转换与顺序未交代完整',invalid_state_transition:'状态转换缺少本场／本镜准确依据',missing_overall_reference_requirement:'缺少该准确状态的整体参考需求',redundant_consecutive_state:'连续重复了同一状态'})[issue.code]||issue.code,row);if(issue.entity)nodeText('p',null,productionName({object_id:issue.entity}),row);if(issue.state)productionRefLink(row,issue.state);if(issue.scope)productionRefLink(row,issue.scope);issues.append(row)}section.append(issues)}
  }
  const actions=el('div','production-toolbar');section.append(actions);
  if(options.close)productionButton(actions,'收起缺项检查',options.close);
  const cards=el('div'),pagination=el('div','production-toolbar');section.append(pagination,cards);
  const pageSize=20;let page=0;
  const drawPage=()=>{
    cards.replaceChildren();pagination.replaceChildren();
    if(data.requirements.length>pageSize){
      const previous=productionButton(pagination,'上一页',()=>{page--;drawPage()});previous.disabled=page===0;
      nodeText('span','production-meta',`第 ${page*pageSize+1}–${Math.min((page+1)*pageSize,data.requirements.length)} 项 / 共 ${data.requirements.length} 项`,pagination);
      const next=productionButton(pagination,'下一页',()=>{page++;drawPage()});next.disabled=(page+1)*pageSize>=data.requirements.length;
    }
  for(const row of data.requirements.slice(page*pageSize,(page+1)*pageSize)){const p=row.requirement.payload,card=el('div','production-need');nodeText('strong',null,p.title,card);nodeText('p',null,`${p.purpose} · ${productionLabels[p.usage]} · ${p.required?'必需':'可选'}`,card);if(row.adoption)productionRefLink(card,row.adoption.payload.asset,`已采用：${row.asset?.payload.title||'素材'} · 版本 ${row.asset?.version}`);for(const issue of row.issues)nodeText('span','production-pill production-issue',({missing_adoption:'尚未采用',upstream_needs_review:'上游变化待复核',requirement_needs_review:'需求待复核',scope_revision_changed:'使用位置已修订',placeholder_is_not_ready:'占位素材',missing_entity_reference:'素材未标明所需实体',missing_state_reference:'素材未覆盖所需状态',missing_exact_state_coverage:'素材的确切状态、整体／细节角色或范围不匹配',below_minimum_long_edge:'实际长边像素不足',native_4k_not_verified:'原生 4K 尚未核实',below_minimum_width:'实际宽度不足',below_minimum_height:'实际高度不足',below_minimum_sample_rate:'采样率不足',below_minimum_channels:'声道数不足',incompatible_media_or_usage:'媒体类型或用途不匹配'}[issue]||issue),card);if(row.pending_changes?.length){const changes=el('details');nodeText('summary',null,`待复核的准确版本 · ${row.pending_changes.length} 项`,changes);for(const change of row.pending_changes){const line=el('div');nodeText('p',null,productionName(change)+' · '+(change.target.object_id===row.requirement.object_id?'需求依据':'采用依据'),line);productionRefLink(line,{object_id:change.object_id,revision_id:change.used_revision},'当时采用的上游版本');productionRefLink(line,{object_id:change.object_id,revision_id:change.current_revision},'上游当前版本');productionButton(line,'记录变更处理',()=>showProductionChange(line,change));changes.append(line)}card.append(changes)}productionButton(card,row.adoption?'显式换版':'选择素材版本',()=>showProductionAdoption(card,row));cards.append(card)}
  };
  drawPage();
  const label=r.kind==='STATE'?'下载状态参考清单':r.kind==='SHOT_DESIGN'?'下载逐镜输入清单':r.kind==='EPISODE'?'下载本集输入清单':'下载本场输入清单';
  const button=productionButton(actions,label,async()=>{const value=await api('/api/production/package?scope='+encodeURIComponent(r.object_id));const a=el('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));a.download=r.object_id+'-manifest.json';a.click();URL.revokeObjectURL(a.href);toast('清单已下载；包含原件的目录包可由 production-package 命令导出')});button.disabled=!data.inputs_ready;
  if(options.replace)root.replaceChildren();root.append(section);
}
function showProductionAdoption(parent,row){
  const p=row.requirement.payload,box=el('div','production-editor'),assets=el('select'),versions=el('select'),components=el('select');assets.setAttribute('aria-label','选择素材');versions.setAttribute('aria-label','采用素材版本');components.setAttribute('aria-label','采用文件组成');assets.append(new Option('选择一个实际素材',''));for(const r of state.productionRecords.filter(r=>r.kind==='ASSET'&&r.payload.media_type===p.media_type))assets.append(new Option(r.payload.title,r.object_id));let history=[];
  const renderComponents=()=>{components.replaceChildren();const r=history.find(r=>r.id===versions.value);for(const c of r?.payload.components||[])components.append(new Option(`${c.id} · ${c.role}`,c.id))};assets.onchange=async()=>{const result=await api('/api/production?object_id='+encodeURIComponent(assets.value));history=result.history;versions.replaceChildren();for(const r of history)versions.append(new Option(`版本 ${r.version} · ${r.id.slice(0,12)}`,r.id));renderComponents()};versions.onchange=renderComponents;box.append(assets,versions,components);
  const reason=el('input');reason.placeholder='采用或换版理由';reason.setAttribute('aria-label','采用理由');box.append(reason);const start=el('input'),end=el('input');for(const [input,label] of [[start,'入点秒（可选）'],[end,'出点秒（可选）']]){input.type='number';input.step='.01';input.min='0';input.placeholder=label;input.setAttribute('aria-label',label);box.append(input)}
  const cropFields={};if(p.media_type==='image'||p.media_type==='video'){nodeText('p',null,'局部采用可填写裁切比例：左上角为 0,0，整张图为宽 1、高 1。留空采用完整画面。',box);for(const [key,label] of Object.entries({x:'裁切左边比例',y:'裁切上边比例',width:'裁切宽度比例',height:'裁切高度比例'})){const input=el('input');input.type='number';input.min='0';input.max='1';input.step='.01';input.placeholder=label;input.setAttribute('aria-label',label);cropFields[key]=input;box.append(input)}}
  productionButton(box,'确认采用此版本',async()=>{const asset=history.find(r=>r.id===versions.value);if(!asset||!reason.value.trim())throw Error('请选择确切素材版本并填写理由');const payload={format:'production-relation-v1',title:p.title+' · 采用',blocks:[{id:'adoption',text:reason.value}],relation_type:'adoption',scope:p.scope,slot:p.slot,asset:productionRef(asset),component_id:components.value,usage:p.usage,reason:reason.value};if(start.value!==''||end.value!=='')payload.range={start_seconds:Number(start.value),end_seconds:Number(end.value)};if(Object.values(cropFields).some(input=>input.value!=='')){if(Object.values(cropFields).some(input=>input.value===''))throw Error('裁切需同时填写左、上、宽、高四项');payload.crop=Object.fromEntries(Object.entries(cropFields).map(([key,input])=>[key,Number(input.value)]))}await api('/api/production/adopt',{method:'POST',body:JSON.stringify({object_id:row.adoption?.object_id||'adoption-'+crypto.randomUUID(),expected_version:row.adoption?.version||0,payload})});toast('精确采用已保存');await loadProductionWorkspace()});productionButton(box,'取消',()=>box.remove());parent.append(box);
}

function showProductionChange(parent,change){
  const box=el('section','production-editor'),action=el('select'),actor=el('input'),reason=el('textarea');
  action.setAttribute('aria-label','变更处理');for(const [value,label] of Object.entries({keep:'保留原引用，无需返工',rework:'需要返工，保持待处理',replace:'需要替换，另行选择新版本'}))action.append(new Option(label,value));
  actor.setAttribute('aria-label','复核者');actor.placeholder='复核者';reason.setAttribute('aria-label','复核依据');reason.placeholder='说明这次变化对当前需求或采用的实际影响';box.append(action,actor,reason);
  productionButton(box,'保存变更处理',async()=>{
    if(!actor.value.trim()||!reason.value.trim())throw Error('请填写复核者与具体依据');
    const payload={format:'production-judgment-v1',title:productionName(change)+' · 变更复核',blocks:[{id:'decision',text:reason.value}],target:change.target,verdict:'impact_resolved',actor:actor.value,reason:reason.value,change:{old:{object_id:change.object_id,revision_id:change.used_revision},new:{object_id:change.object_id,revision_id:change.current_revision},action:action.value}};
    await api('/api/production/judgment',{method:'POST',body:JSON.stringify({object_id:'change-'+crypto.randomUUID(),expected_version:0,payload})});toast('复核结论已保存；实际采用没有自动换版');await loadProductionWorkspace();
  });productionButton(box,'取消',()=>box.remove());parent.append(box);
}
