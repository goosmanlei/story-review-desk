/* Production readers share app.js comments, drafts, keyboard handling and API. */
const productionKinds={ENTITY:'实体',STATE:'实体状态',REPRESENTATION:'制作设定',INPUT_LOCK:'正式输入',PREPARATION:'集场检查',SHOT_DESIGN:'镜头设计',REQUIREMENT:'素材需求',ASSET:'实际素材',CALL:'实际制作',RELATION:'明确采用',JUDGMENT:'审阅结论',ASSEMBLY:'动态分镜组合',DELIVERABLE:'输出与工程'};
const productionGroups={'settings.workspace':['ENTITY','STATE','REPRESENTATION','INPUT_LOCK'],'materials.workspace':['ASSET','CALL','JUDGMENT','RELATION'],'production.workspace':['PREPARATION','SHOT_DESIGN','REQUIREMENT','ASSEMBLY','DELIVERABLE']};
const productionLabels={character:'角色',space:'场景',prop:'道具',song:'歌曲',visual:'画面',voice:'声音',visual_voice:'画面与声音',mention:'仅提及',generation_input:'生成输入',post_audio:'后期声音',editorial:'剪辑参考',pending:'待审',passed:'通过',changes_requested:'需修改',rejected:'未通过',accepted:'用户接受',impact_resolved:'影响已处理'};
const productionRef=r=>({object_id:r.object_id,revision_id:r.id});
let productionLoadEpoch=0,productionReadEpoch=0;
function productionButton(parent,text,action){const b=nodeText('button',null,text,parent);b.type='button';b.onclick=()=>Promise.resolve().then(action).catch(e=>toast(e.message));return b}
function productionVisuals(){return (state.productionSelected?.payload.components||[]).filter(c=>c.mime.startsWith('image/')).map(c=>({...c,title:state.productionSelected.payload.title,alt:state.productionSelected.payload.title,description:`${c.role} · ${c.width}×${c.height} · ${c.sha256}`}))}
function productionName(ref){return state.productionRecords?.find(r=>r.object_id===ref.object_id)?.payload.title||state.screenplays.flatMap(s=>s.episodes).find(e=>e.object_id===ref.object_id)?.payload.title||state.screenplays.find(s=>s.object_id===ref.object_id)?.payload.title||ref.object_id}
function productionRefLink(parent,ref,label){
  if(!ref?.object_id||!ref.revision_id)return;
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
async function loadProductionWorkspace(){
  const workspace=state.workspace,epoch=++productionLoadEpoch;$('#production-view').replaceChildren();nodeText('p',null,'正在读取制作记录…',$('#production-view'));const result=await api('/api/production');if(state.workspace!==workspace||epoch!==productionLoadEpoch)return;
  state.productionRecords=result.records;
  const host=$('#production-view');host.replaceChildren();
  const heading=el('header','production-heading'),title=el('div');nodeText('small',null,'剧本依据 → 制作设定 → 实际素材 → 镜头输入',title);nodeText('h1',null,{'settings.workspace':'制作设定','materials.workspace':'素材管理','production.workspace':'全剧制作'}[workspace],title);
  nodeText('p',null,{'settings.workspace':'核对身份、实体状态、来源与制作选择，反查出场和镜头。','materials.workspace':'查看原件、候选和实际制作记录；审阅结论与具体采用分别保存。','production.workspace':'按集场组织镜头和输入槽位，检查缺项并登记动态分镜组合与交付。'}[workspace],title);heading.append(title);const actions=el('div','production-toolbar');productionButton(actions,'批量导入',showProductionImport);if(workspace==='materials.workspace')productionButton(actions,'登记实际原件',showProductionUpload);heading.append(actions);host.append(heading);
  const flatFilters=workspace==='settings.workspace',filters={kind:'',category:'',episode:'',scene:''};
  const filterPanel=el('section',flatFilters?'production-filters':''),toolbar=el('div','production-toolbar'),search=el('input');
  search.type='search';search.placeholder=flatFilters?'搜索名称、别名或设定内容':'搜索名称、别名或集场';search.setAttribute('aria-label','搜索制作记录');
  let clearFilters,resultSummary;
  if(flatFilters){
    filterPanel.setAttribute('aria-label','制作设定筛选');
    const label=el('label','production-filter-search');nodeText('span',null,'搜索设定',label);label.append(search);toolbar.append(label);
    clearFilters=productionButton(toolbar,'清除筛选',()=>{search.value='';for(const key of Object.keys(filters))filters[key]='';refreshIndex()});
    filterPanel.append(toolbar);
    nodeText('p','production-filter-note','数字表示保留其他筛选、选择该项后的记录数。实体与实体状态分别计数，历史版本不重复累计。',filterPanel);
  }else{toolbar.append(search);filterPanel.append(toolbar)}
  const kindOptions=[['','全部类型'],...productionGroups[workspace].map(kind=>[kind,productionKinds[kind]])];
  const categories=flatFilters?['character','space','prop','song']:workspace==='materials.workspace'?['image','audio','video','project','document']:[];
  const categoryOptions=[['','全部内容'],...categories.map(value=>[value,productionLabels[value]||({image:'图像',audio:'声音',video:'视频',project:'工程',document:'说明文件'})[value]])];
  const facetButtons=[];
  for(const [key,label,options] of [['kind','记录类型',kindOptions],['category','内容分类',categoryOptions]]){
    if(key==='category'&&!categories.length)continue;
    if(flatFilters){
      const group=el('div','production-filter-group'),labelId=`production-filter-${key}-label`;
      group.setAttribute('role','group');group.setAttribute('aria-labelledby',labelId);nodeText('span','production-filter-label',label,group).id=labelId;
      const choices=el('div','production-filter-options');group.append(choices);
      for(const [value,title] of options){
        const button=productionButton(choices,'',()=>{filters[key]=filters[key]===value?'':value;refreshIndex()});
        button.className='production-filter-chip';button.dataset.filterKey=key;button.dataset.filterValue=value;
        nodeText('span',null,title,button);const count=nodeText('b','production-filter-count','0',button);count.setAttribute('aria-hidden','true');
        facetButtons.push({button,count,key,value,label,title});
      }
      filterPanel.append(group);
    }else{
      const select=el('select');select.setAttribute('aria-label',label);
      for(const [value,title] of options)select.append(new Option(title,value));
      select.onchange=()=>{filters[key]=select.value;refreshIndex()};toolbar.append(select);
    }
  }
  if(flatFilters){resultSummary=nodeText('p','production-filter-summary','',filterPanel);resultSummary.setAttribute('role','status')}
  host.append(filterPanel);
  const board=el('div','production-board'),index=el('nav','production-index'),reader=el('article','production-reader');index.id='production-index';index.setAttribute('aria-label','制作记录');reader.id='production-reader';board.append(index,reader);host.append(board);
  const byId=new Map(result.records.map(r=>[r.object_id,r]));
  const contextOf=(r,seen=new Set())=>{if(!r||seen.has(r.object_id))return {};seen.add(r.object_id);const p=r.payload;if(p.episode||p.source)return {episode:(p.episode||p.source).object_id,scene:p.scene_id||p.source?.scene_id,number:p.number};return contextOf(byId.get(p.scope?.object_id),seen)};
  const contexts=new Map(result.records.map(r=>[r.object_id,contextOf(r)]));
  const workspaceRows=result.records.filter(r=>productionGroups[workspace].includes(r.kind));
  const searchTexts=new Map(workspaceRows.map(r=>[r.object_id,JSON.stringify(r.payload).toLowerCase()]));
  const matches=(r,selection=filters)=>{
    const context=contexts.get(r.object_id),category=selection.category;
    return (!selection.kind||r.kind===selection.kind)&&
      (!category||r.payload.entity_type===category||r.payload.media_type===category||byId.get(r.payload.entity?.object_id)?.payload.entity_type===category)&&
      (!selection.episode||context.episode===selection.episode)&&(!selection.scene||context.scene===selection.scene)&&searchTexts.get(r.object_id).includes(search.value.trim().toLowerCase());
  };
  const episodeFilter=el('select'),sceneFilter=el('select');episodeFilter.setAttribute('aria-label','制作分集');sceneFilter.setAttribute('aria-label','制作场次');episodeFilter.append(new Option('全剧各集',''));sceneFilter.append(new Option('全部场次',''));
  if(workspace==='production.workspace'){
    const present=new Set([...contexts.values()].map(c=>c.episode));
    for(const ep of state.screenplays.flatMap(s=>s.episodes).filter(e=>present.has(e.object_id)))episodeFilter.append(new Option(ep.payload.title,ep.object_id));
    toolbar.append(episodeFilter,sceneFilter);
  }
  const renderIndex=()=>{
    index.replaceChildren();
    const matchingRows=workspaceRows.filter(r=>matches(r));
    for(const kind of productionGroups[workspace]){
      const rows=matchingRows.filter(r=>r.kind===kind).sort((a,b)=>{const x=contexts.get(a.object_id),y=contexts.get(b.object_id);return (x.episode||'').localeCompare(y.episode||'')||(x.scene||'').localeCompare(y.scene||'')||(x.number||0)-(y.number||0)||a.object_id.localeCompare(b.object_id)});
      if(!rows.length)continue;
      nodeText('h3',null,`${productionKinds[kind]} · ${rows.length}`,index);
      for(const r of rows){const b=productionButton(index,r.payload.title,()=>openProductionRecord(r.object_id));b.dataset.objectId=r.object_id;b.classList.toggle('active',state.productionSelected?.object_id===r.object_id);nodeText('small',null,`${productionLabels[r.payload.entity_type]||contexts.get(r.object_id).scene||''} 版本 ${r.version}`,b)}
    }
    if(!index.childElementCount)nodeText('p',null,workspaceRows.length?'没有匹配记录，请调整筛选条件。':'尚未登记记录，可从整理后的生产数据批量导入。',index);
    return matchingRows;
  };
  const refreshIndex=()=>{
    const rows=renderIndex();
    for(const facet of facetButtons){
      const count=workspaceRows.filter(r=>matches(r,{...filters,[facet.key]:facet.value})).length,selected=filters[facet.key]===facet.value;
      facet.count.textContent=count;facet.button.classList.toggle('is-active',selected);facet.button.classList.toggle('is-zero',!count);
      facet.button.setAttribute('aria-pressed',String(selected));facet.button.setAttribute('aria-label',`${facet.label}：${facet.title}，${count} 条记录`);
    }
    if(resultSummary){
      const counts=productionGroups[workspace].map(kind=>[productionKinds[kind],rows.filter(r=>r.kind===kind).length]).filter(([,count])=>count);
      resultSummary.textContent=`当前结果：${rows.length} 条记录${counts.length?'（'+counts.map(([label,count])=>`${label} ${count}`).join(' · ')+'）':''}`;
      clearFilters.disabled=!search.value&&!Object.values(filters).some(Boolean);
    }
  };
  const renderScenes=()=>{filters.scene='';sceneFilter.replaceChildren(new Option('全部场次',''));const scenes=[...new Set([...contexts.values()].filter(c=>c.scene&&(!filters.episode||c.episode===filters.episode)).map(c=>c.scene))].sort();for(const scene of scenes)sceneFilter.append(new Option(scene,scene));refreshIndex()};
  search.oninput=refreshIndex;sceneFilter.onchange=()=>{filters.scene=sceneFilter.value;refreshIndex()};episodeFilter.onchange=()=>{filters.episode=episodeFilter.value;renderScenes()};renderScenes();
  const param=new URL(location.href).searchParams,selected=param.get('production_object'),candidate=result.records.find(r=>r.object_id===selected&&productionGroups[workspace].includes(r.kind))||result.records.find(r=>productionGroups[workspace].includes(r.kind));
  if(candidate)await openProductionRecord(candidate.object_id,selected===candidate.object_id?param.get('production_revision'):null);else{state.productionSelected=null;nodeText('p',null,'此入口已开放，当前实例尚未登记生产数据。',reader);renderComments()}
}
async function openProductionRecord(objectId,revisionId=null,navigate=false){
  const workspaceAtStart=state.workspace,epoch=++productionReadEpoch;
  const detail=await api('/api/production?'+new URLSearchParams({object_id:objectId,...(revisionId?{revision_id:revisionId}:{})}));
  if(epoch!==productionReadEpoch||state.workspace!==workspaceAtStart)return;
  if(navigate&&!productionGroups[state.workspace]?.includes(detail.record.kind)){const workspace=Object.keys(productionGroups).find(k=>productionGroups[k].includes(detail.record.kind));const url=new URL(location.href);url.searchParams.set('production_object',objectId);url.searchParams.set('production_revision',detail.record.id);history.replaceState(null,'',url);switchWorkspace(workspace);return}
  if(!isProduction()||!productionGroups[state.workspace].includes(detail.record.kind))return;
  state.productionSelected=detail.record;state.productionDetail=detail;state.anchor=null;state.editing=null;state.selected=null;state.drawMode=null;
  const url=new URL(location.href);url.searchParams.set('production_object',objectId);url.searchParams.set('production_revision',detail.record.id);history.replaceState(null,'',url);
  for(const button of document.querySelectorAll('#production-index button'))button.classList.toggle('active',button.dataset.objectId===objectId);
  renderProductionReader();renderComments();
}
function productionFields(parent,fields){const dl=el('dl','production-fields');for(const [label,value] of fields){if(value===undefined||value===null||value==='')continue;nodeText('dt',null,label,dl);nodeText('dd',null,typeof value==='string'?value:JSON.stringify(value),dl)}parent.append(dl)}
function productionList(parent,title,items){if(!items?.length)return;nodeText('h3',null,title,parent);const list=el('ul');for(const item of items){const row=el('li');if(typeof item==='string')row.textContent=item;else if(item.speaker){nodeText('p',null,`${item.speaker}${item.type==='singing'?'（演唱）':'（对白）'}：${item.text}`,row);if(item.fps&&Number.isFinite(item.planned_start_frame))nodeText('small',null,`镜内预计 ${(item.planned_start_frame/item.fps).toFixed(2)}–${(item.planned_end_frame/item.fps).toFixed(2)} 秒；${item.timing_status}`,row);productionRefLink(row,item.source,'查看原文')}else row.textContent=item.description||JSON.stringify(item);list.append(row)}parent.append(list)}
function productionMedia(parent,component,review=true){
  const url='/api/production/files/'+encodeURIComponent(component.file);
  if(component.mime.startsWith('image/')){if(review)parent.append(renderStructureVisual({...component,title:state.productionSelected.payload.title,alt:state.productionSelected.payload.title,description:`${component.role} · ${component.width}×${component.height}`},true));else{const img=el('img');img.width=component.width;img.height=component.height;img.src=url;img.alt=component.id;parent.append(img)}}
  else if(component.mime.startsWith('audio/')||component.mime.startsWith('video/')){const media=el(component.mime.startsWith('audio/')?'audio':'video');media.controls=true;media.preload='metadata';media.src=url;media.dataset.componentId=component.id;parent.append(media);if(review){const row=el('div','production-toolbar'),start=el('input'),end=el('input');for(const [input,label] of [[start,'评论开始秒'],[end,'评论结束秒']]){input.type='number';input.min='0';input.step='0.01';input.setAttribute('aria-label',label);input.placeholder=label;row.append(input)}start.value='0';end.value=Math.min(component.duration_seconds,3).toFixed(2);productionButton(row,'取当前为起点',()=>{start.value=media.currentTime.toFixed(2)});productionButton(row,'取当前为终点',()=>{end.value=media.currentTime.toFixed(2)});productionButton(row,'评论此时间段',()=>{const a=Number(start.value),b=Number(end.value);if(!(0<=a&&a<b&&b<=component.duration_seconds))throw Error('请选择原件内的有效时间段');startDraft({type:'time',component_id:component.id,asset_file:component.file,start_seconds:a,end_seconds:b})});parent.append(row)}}
  link(`下载 ${component.role} · ${component.file.slice(0,12)}…`,url,parent);nodeText('p','production-meta',`${component.mime} · ${component.bytes.toLocaleString()} bytes · SHA-256 ${component.sha256}`,parent);
}
function renderProductionReader(){
  const root=$('#production-reader'),r=state.productionSelected,p=r.payload;root.replaceChildren();
  nodeText('small','production-pill',productionKinds[r.kind],root);nodeText('h2',null,p.title,root);nodeText('p','production-meta',`版本 ${r.version} · ${r.id}${r.id===r.current_revision?' · 当前版本':' · 历史版本'}`,root);
  const bar=el('div','production-toolbar'),versions=el('select');versions.setAttribute('aria-label','选择精确版本');for(const v of state.productionDetail.history)versions.append(new Option(`版本 ${v.version} · ${v.created_at}`,v.id));versions.value=r.id;versions.onchange=()=>openProductionRecord(r.object_id,versions.value).catch(e=>toast(e.message));bar.append(versions);
  productionButton(bar,'整体意见',()=>startDraft({type:'global'}));productionButton(bar,'查看评论',openPanel);productionButton(bar,'编辑说明与设定',showProductionEditor);productionButton(bar,'查看所选修订的影响',async()=>{const data=await api('/api/production/impact?revision_id='+r.id);const section=el('section');nodeText('h3',null,`受影响的当前引用 ${data.affected.length}`,section);for(const use of data.affected)productionRefLink(section,use,`${productionKinds[use.kind]||use.kind} · ${use.title}`);if(!data.affected.length)nodeText('p',null,'没有查到当前下游引用。',section);root.append(section);section.scrollIntoView({block:'center'})});root.append(bar);
  const blocks=el('div');blocks.id='production-blocks';for(const b of p.blocks){const para=nodeText('p',null,b.text,blocks);para.dataset.blockId=b.id}root.append(blocks);
  productionFields(root,[['身份类型',productionLabels[p.entity_type]],['别名',p.aliases?.join('、')],['状态维度',p.dimensions],['叙事目的',p.purpose],['构图与景别',p.framing],['空间关系',p.spatial],['动作开始',p.action_start],['动作结束',p.action_end],['预计时长',p.duration_frames&&p.fps?`${(p.duration_frames/p.fps).toFixed(2)} 秒 · ${p.duration_frames} 帧 / ${p.fps} fps`:null],['连续性',p.continuity],['输入用途',productionLabels[p.usage]],['制作状态',p.status],['工具',p.tool],['模型',p.model],['审阅结论',productionLabels[p.verdict]],['审阅者',p.actor],['说明',p.reason],['画幅',p.width&&p.height?`${p.width}×${p.height}`:null]]);
  productionList(root,'剧本事实',p.facts);productionList(root,'制作选择',p.choices);productionList(root,'待确认',p.unknowns);productionList(root,'声音设计',p.sound);
  if(p.lyrics){nodeText('h3',null,'歌词原文与段落',root);for(const lyric of p.lyrics){nodeText('strong',null,lyric.section,root);nodeText('p',null,lyric.text,root);productionRefLink(root,lyric.source,'查看歌词正文依据')}nodeText('p',null,p.composition_status,root);productionList(root,'作品内容待确认',p.content_unknowns)}
  const refs=el('section');nodeText('h3',null,'来源与依赖',refs);for(const key of ['entity','episode','screenplay','source','scope','production','target','asset','assembly'])if(p[key]?.revision_id)productionRefLink(refs,p[key],`${{entity:'所属实体',source:'剧情依据',production:'实际制作',scope:'使用位置',target:'审阅对象',episode:'所属分集',screenplay:'正式整版'}[key]||key}：${productionName(p[key])}`);for(const key of ['sources','entities','states','subjects','inputs','outputs','dependencies','previous_states'])for(const ref of p[key]||[])if(ref.revision_id)productionRefLink(refs,ref);root.append(refs);
  if(p.occurrences){nodeText('h3',null,`全场出场检查 · ${p.occurrences.length} 项`,root);for(const occurrence of p.occurrences){const row=el('div','production-need');productionRefLink(row,occurrence.entity);nodeText('span','production-pill',productionLabels[occurrence.mode],row);for(const ref of occurrence.states)productionRefLink(row,ref);for(const ref of occurrence.evidence)productionRefLink(row,ref,'查看正文依据');root.append(row)}}
  if(p.components?.length){nodeText('h3',null,'实际文件组成',root);const select=el('select');select.id='production-component';select.setAttribute('aria-label','原件与预览组成');for(const c of p.components)select.append(new Option(`${c.role} · ${c.id}`,c.id));const media=el('section');const draw=()=>{media.replaceChildren();productionMedia(media,p.components.find(c=>c.id===select.value));paintProductionReview()};select.onchange=draw;root.append(select,media);draw();if(r.kind==='ASSET'&&state.productionDetail.history.length>1)productionButton(root,'并排比较版本',()=>showProductionCompare(root));if(r.kind==='ASSET')productionButton(root,'记录本版本审阅结论',()=>showProductionJudgment(root))}
  if(p.prompt){const detail=el('details');nodeText('summary',null,'实际提示词与参数',detail);nodeText('p',null,p.prompt,detail);nodeText('pre',null,JSON.stringify({parameters:p.parameters,receipt:p.receipt,usage:p.usage,lineage:p.lineage},null,2),detail);root.append(detail)}
  if(p.items){nodeText('h3',null,'时间线精确引用',root);const table=el('table','production-table');for(const item of p.items){const row=el('tr');nodeText('td',null,item.track,row);nodeText('td',null,`${(item.start_frame/p.fps).toFixed(2)}–${((item.start_frame+item.duration_frames)/p.fps).toFixed(2)} 秒`,row);const cell=el('td');productionRefLink(cell,item.asset);productionRefLink(cell,item.shot);nodeText('small',null,item.motion||'',cell);row.append(cell);table.append(row)}root.append(table)}
  const relatedVersions=r.id===r.current_revision?state.productionDetail.history:[r];
  const related=(state.productionRecords||[]).filter(other=>other.object_id!==r.object_id).map(other=>({other,versions:relatedVersions.filter(v=>JSON.stringify(other.payload).includes('"'+v.id+'"'))})).filter(item=>item.versions.length);
  if(related.length){nodeText('h3',null,'出场、状态与当前使用',root);for(const {other,versions} of related)productionRefLink(root,productionRef(other),`${productionKinds[other.kind]} · ${other.payload.title}${relatedVersions.length>1?' · 引用版本 '+versions.map(v=>v.version).join('、'):''}`)}
  if(['SHOT_DESIGN','PREPARATION','INPUT_LOCK'].includes(r.kind)){if(r.id===r.current_revision)renderProductionReadiness(root,r).catch(e=>nodeText('p','production-issue',e.message,root));else nodeText('p','production-meta','当前正在阅读历史修订。查看现有缺项或改变采用，请切换到当前版本；历史制作输入保留在下方精确引用中。',root)}
  const details=el('details');nodeText('summary',null,'完整记录与历史引用',details);nodeText('pre',null,JSON.stringify({record:r,uses:state.productionDetail.uses},null,2),details);root.append(details);paintProductionReview();
}
function paintProductionReview(){if(!isProduction())return;paintStructureRegions();for(const para of document.querySelectorAll('#production-blocks [data-block-id]')){para.classList.toggle('comment-flash',!!state.selected&&state.comments.find(c=>c.id===state.selected)?.anchor.block_id===para.dataset.blockId)}}
function locateProductionComment(comment){if(comment.anchor_state?.valid===false)return toast(comment.anchor_state.reason);state.selected=comment.id;const a=comment.anchor,select=$('#production-component'),component=a.component_id||a.visual_id;if(select&&component&&select.value!==component){select.value=component;select.onchange()}if(a.type==='time'){const media=document.querySelector(`[data-component-id="${CSS.escape(a.component_id)}"]`);if(media){media.currentTime=a.start_seconds;media.scrollIntoView({block:'center'});media.focus()}}else{const target=a.block_id?document.querySelector(`#production-blocks [data-block-id="${CSS.escape(a.block_id)}"]`):a.visual_id?document.querySelector(`[data-visual-id="${CSS.escape(a.visual_id)}"]`):$('#production-reader');target?.scrollIntoView({block:'center'})}paintProductionReview();renderComments()}
function showProductionEditor(){
  const r=state.productionSelected,p=structuredClone(r.payload),root=$('#production-reader');if(r.id!==r.current_revision)throw Error('历史修订不可改写，请先选择当前版本');
  const form=el('form','production-editor');nodeText('h3',null,'保存为新修订',form);const controls=[];
  for(const key of ['title','aliases','facts','choices','unknowns'])if(p[key]!==undefined){nodeText('label',null,({title:'名称',aliases:'别名，每行一个',facts:'剧本事实，每行一项',choices:'制作选择，每行一项',unknowns:'待确认，每行一项'})[key],form);const input=el(key==='title'?'input':'textarea');input.value=Array.isArray(p[key])?p[key].join('\n'):p[key];input.setAttribute('aria-label',({title:'名称',aliases:'别名，每行一个',facts:'剧本事实，每行一项',choices:'制作选择，每行一项',unknowns:'待确认，每行一项'})[key]);controls.push([key,input]);form.append(input)}
  for(const block of p.blocks){nodeText('label',null,`说明 · ${block.id}`,form);const area=el('textarea');area.setAttribute('aria-label',`说明 · ${block.id}`);area.value=block.text;area.oninput=()=>{block.text=area.value};form.append(area)}
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
async function renderProductionReadiness(root,r){
  const data=await api('/api/production/readiness?scope='+encodeURIComponent(r.object_id));if(state.productionSelected?.id!==r.id)return;const section=el('section');nodeText('h3',null,`必要输入：${data.required_count} 项，缺项或待复核 ${data.missing_count} 项`,section);nodeText('p',null,data.inputs_ready?'技术输入齐备；作品是否接受单独记录。':'必要槽位尚未全部就绪。',section);
  for(const row of data.requirements){const p=row.requirement.payload,card=el('div','production-need');nodeText('strong',null,p.title,card);nodeText('p',null,`${p.purpose} · ${productionLabels[p.usage]} · ${p.required?'必需':'可选'}`,card);if(row.adoption)productionRefLink(card,row.adoption.payload.asset,`已采用：${row.asset?.payload.title||'素材'} · 版本 ${row.asset?.version}`);for(const issue of row.issues)nodeText('span','production-pill production-issue',({missing_adoption:'尚未采用',upstream_needs_review:'上游变化待复核',requirement_needs_review:'需求待复核',scope_revision_changed:'使用位置已修订',placeholder_is_not_ready:'占位素材',missing_entity_reference:'素材未标明所需实体',missing_state_reference:'素材未覆盖所需状态',below_minimum_long_edge:'实际长边像素不足',native_4k_not_verified:'原生 4K 尚未核实',below_minimum_width:'实际宽度不足',below_minimum_height:'实际高度不足',below_minimum_sample_rate:'采样率不足',below_minimum_channels:'声道数不足',incompatible_media_or_usage:'媒体类型或用途不匹配'}[issue]||issue),card);if(row.pending_changes?.length){const changes=el('details');nodeText('summary',null,`待复核的准确版本 · ${row.pending_changes.length} 项`,changes);for(const change of row.pending_changes){const line=el('div');nodeText('p',null,productionName(change)+' · '+(change.target.object_id===row.requirement.object_id?'需求依据':'采用依据'),line);productionRefLink(line,{object_id:change.object_id,revision_id:change.used_revision},'当时采用的上游版本');productionRefLink(line,{object_id:change.object_id,revision_id:change.current_revision},'上游当前版本');productionButton(line,'记录变更处理',()=>showProductionChange(line,change));changes.append(line)}card.append(changes)}productionButton(card,row.adoption?'显式换版':'选择素材版本',()=>showProductionAdoption(card,row));section.append(card)}
  const button=productionButton(section,'下载逐镜输入清单',async()=>{const value=await api('/api/production/package?scope='+encodeURIComponent(r.object_id));const a=el('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));a.download=r.object_id+'-manifest.json';a.click();URL.revokeObjectURL(a.href);toast('清单已下载；包含原件的目录包可由 production-package 命令导出')});button.disabled=!data.inputs_ready;root.append(section);
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
