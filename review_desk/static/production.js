/* Production readers share app.js comments, drafts, keyboard handling and API. */
const productionKinds={ENTITY:'实体',STATE:'实体状态',INPUT_LOCK:'剧本依据',AV_EPISODE:'视听集',AV_SCENE:'视听场',AV_SHOT:'视听镜头',MATERIAL_RELATION:'素材关系',REQUIREMENT:'素材需求',ASSET:'实际素材',CALL:'实际制作',RELATION:'明确采用'};
const productionGroups={'settings.workspace':['ENTITY','STATE','AV_SCENE','AV_SHOT'],'materials.workspace':['REQUIREMENT','ASSET']};
const productionWorkspaceCanRead=(workspace,r)=>workspace==='materials.workspace'||productionGroups[workspace]?.includes(r.kind)||workspace==='settings.workspace'&&r.kind==='RELATION'&&['entity','business'].includes(r.payload.relation_type);
const productionLabels={character:'角色',space:'场景',prop:'道具',song:'歌曲',visual:'画面',voice:'声音',visual_voice:'画面与声音',mention:'仅提及',generation_input:'生成输入',post_audio:'后期声音',editorial:'剪辑参考',review_reference:'独立审阅参考'};
const productionRef=r=>({object_id:r.object_id,revision_id:r.id});
const productionCompleteState=r=>r.kind==='STATE'&&r.payload.state_model==='complete-v1';
// This read-only projection also runs in review_text.py for exact anchor validation.
function productionTextBlocks(record){
  if(!record)return [];
  const p=record.payload,blocks=[...(p.blocks||[])],body=blocks.map(b=>b.text).join('\n'),seen=new Set();
  let prefix='@review/';while(blocks.some(b=>b.id.startsWith(prefix)))prefix='@'+prefix;
  for(const field of ['facts','choices','unknowns'])for(const [index,text] of (p[field]||[]).entries()){
    if(typeof text!=='string'||!text.trim()||body.includes(text)||seen.has(text))continue;
    seen.add(text);blocks.push({id:`${prefix}${field}/${index}`,text,field,index});
  }
  const sorted=value=>Array.isArray(value)?value.map(sorted):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,sorted(value[k])])):value;
  const extra=[['production_description',p.production_description]],plan=p.generation;
  if(p.format==='production-av-shot-v1')for(const field of ['purpose','framing','spatial','axis','movement','action_start','action_end','motion','performance','lighting','color','editing','continuity'])extra.push([field,p[field]]);
  if(p.format==='production-av-shot-v1')for(const [i,value] of (p.key_states||[]).entries())extra.push([`key_states.${i}.description`,value.description]);
  if(['AV_EPISODE','AV_SCENE','MATERIAL_RELATION'].includes(record.kind))for(const field of ['purpose','structure','rhythm','continuity','preserve','change','check'])extra.push([field,p[field]]);
  if(record.kind==='AV_SCENE')for(const field of ['spatial','axis','lighting','color','sound'])extra.push([field,p[field]]);
  if(p.relation_type==='entity')extra.push(['relationship.label',p.label]);
  if(plan){extra.push(['generation.tool',plan.tool],['generation.model',plan.model],['generation.parameters',record.review_parameter_text??JSON.stringify(sorted(plan.parameters||{}),null,2)],['generation.prompt',plan.prompt],['generation.output.description',plan.output?.description],['generation.output.review_criteria',(plan.output?.review_criteria||[]).join('\n')]);for(const [i,v] of (plan.inputs||[]).entries())extra.push([`generation.inputs.${i}.use`,v.use])}
  if(p.format==='production-call-v1')extra.push(['call.model',p.model],['call.parameters',record.review_call_parameter_text??JSON.stringify(sorted(Object.fromEntries(Object.entries(p.parameters||{}).filter(([k,v])=>k!=='prompt'||v!==p.prompt))),null,2)],['call.prompt',p.prompt]);
  for(const [field,text] of extra)if(typeof text==='string'&&text.trim()&&!body.includes(text)&&!seen.has(text)){seen.add(text);blocks.push({id:prefix+field.replaceAll('.','/'),text,field})}
  if(p.format==='production-av-shot-v1')for(const [index,item] of (p.sound||[]).entries()){
    if(item?.type==='source_action')continue;
    const name=typeof item==='string'||item?.text?'text':'description',text=typeof item==='string'?item:item?.[name];
    if(typeof text==='string'&&text.trim()){const field=`sound.${index}.${name}`;blocks.push({id:prefix+field.replaceAll('.','/'),text,field})}
  }
  return blocks;
}
const productionEntitySymbols={
  character:['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z','M4.5 21v-2a7.5 7.5 0 0 1 15 0v2'],
  space:['M3 4h18v16H3Z','M3 17l5-5 4 4 4-7 5 8','M8 8h.01'],
  prop:['m12 3 9 5v9l-9 5-9-5V8Z','m3 8 9 5 9-5','M12 13v9','m7.5 5.5 9 5V15'],
  song:['M9 17V5l12-2v12','M9 9l12-2','M9 17c0 2-2 3-4 3s-3-1-3-2 2-3 4-3c1 0 3 0 3 2Z','M21 15c0 2-2 3-4 3s-3-1-3-2 2-3 4-3c1 0 3 0 3 2Z']
};
const productionMediaLabels={image:'图像',audio:'声音',video:'视频',project:'工程',document:'说明文件'};
const productionMediaSymbols={image:productionEntitySymbols.space,audio:productionEntitySymbols.song,video:['M3 5h12v14H3Z','m15 10 6-4v12l-6-4'],project:productionEntitySymbols.prop,document:['M5 3h10l4 4v14H5Z','M14 3v5h5','M8 12h8','M8 16h8']};
function productionFilterMediaTypes(row,byId,seen=new Set()){
  if(!row||seen.has(row.object_id))return [];seen.add(row.object_id);
  if(row.payload.media_type)return [row.payload.media_type];
  const refs=[row.payload.asset,row.payload.target,...(row.payload.outputs||[])].filter(Boolean);
  return [...new Set(refs.flatMap(ref=>productionFilterMediaTypes(byId.get(ref.object_id),byId,seen)))];
}
function productionMaterialEntries(records,memberships={}){
  const needs=records.filter(r=>r.kind==='REQUIREMENT'&&r.payload.status!=='withdrawn');
  const used=new Set(),entries=needs.map(need=>{
    const assets=records.filter(r=>r.kind==='ASSET'&&(memberships[need.object_id]?.includes(r.object_id)||r.payload.candidate_requirements?.some(ref=>ref.object_id===need.object_id)));
    assets.forEach(r=>used.add(r.object_id));
    const real=r=>!r.payload.placeholder&&r.payload.components?.some(c=>c.role==='original');
    return {...need,material_assets:assets,material_generated:assets.some(real)||!!memberships[need.object_id]?.length};
  });
  for(const asset of records)if(asset.kind==='ASSET'&&!used.has(asset.object_id))entries.push({...asset,material_generated:!asset.payload.placeholder&&asset.payload.components?.some(c=>c.role==='original')});
  return entries;
}
function productionWorkspaceRows(records,workspace,memberships={}){
  if(workspace==='materials.workspace')return productionMaterialEntries(records,memberships);
  return records.filter(r=>workspace==='settings.workspace'?r.kind==='ENTITY'&&r.payload.status!=='withdrawn':productionGroups[workspace].includes(r.kind)&&r.payload.status!=='withdrawn');
}
function productionEntityIcon(type){
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');svg.setAttribute('stroke-width','1.6');svg.setAttribute('stroke-linecap','round');svg.setAttribute('stroke-linejoin','round');svg.setAttribute('aria-hidden','true');svg.setAttribute('focusable','false');svg.classList.add('production-entity-icon');
  for(const d of productionEntitySymbols[type]||productionMediaSymbols[type]||productionEntitySymbols.prop){const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',d);svg.append(path)}
  return svg;
}
const productionDimensionLabels={appearance:'整体外观',clothing:'服装',injury:'伤势',health:'健康',fatigue:'疲劳',voice:'声音',attachments:'随身物',layout:'空间布局',dressing:'场景布置',time_light:'时间与光照',structure:'完整结构',condition:'状况',contents:'组成与内容',placement:'使用位置',lyrics_scope:'歌词范围',rendition:'演唱方式',performers:'演唱者'};
let productionLoadEpoch=0,productionReadEpoch=0;
// A new page choice ends every read owned by the previous production page,
// including another child of the same workspace and a later return to it.
function invalidateProductionReads(){
  ++productionLoadEpoch;++productionReadEpoch;
  if(typeof invalidateBreakdownReads==='function')invalidateBreakdownReads();
}
function productionButton(parent,text,action){const b=nodeText('button',null,text,parent);b.type='button';b.onclick=()=>Promise.resolve().then(action).catch(e=>toast(e.message));return b}
function productionVisuals(){return (state.productionSelected?.payload.components||[]).filter(c=>c.mime.startsWith('image/')).map(c=>({...c,title:reviewPositionText(state.productionSelected.payload.title),alt:reviewPositionText(state.productionSelected.payload.title),description:`${c.role} · ${c.width}×${c.height} · ${c.sha256}`}))}
function productionName(ref,referenceTitles=[]){
  const matches=row=>row.object_id===ref.object_id&&(!ref.revision_id||row.id===ref.revision_id);
  const title=ref.revision_id&&referenceTitles.find(row=>row.object_id===ref.object_id&&row.revision_id===ref.revision_id)?.title;
  if(typeof title==='string'&&title)return businessTitle({object_id:ref.object_id,payload:{title}});
  const detailRows=[state.unifiedScope,state.productionSelected,...(state.entityReview?entityReviewRows(state.entityReview):[]),...(state.materialReview?materialRows(state.materialReview):[]),...[state.productionDetail,state.productionEntityDetail,state.productionChildDetail].flatMap(detail=>detail?[detail.record,...(detail.history||[])]:[])].filter(Boolean);
  const row=[...(state.productionRecords||[]),...(ref.revision_id?detailRows:[]),...(state.screenplays||[]).flatMap(s=>s.episodes||[]),...(state.screenplays||[])].find(matches);
  if(row?.payload?.title)return businessTitle(row);
  const source=(state.sources||[]).find(source=>source.id===ref.object_id&&(!ref.revision_id||source.target_revision_id===ref.revision_id));
  return source?.title?reviewPositionText(source.title):ref.object_id;
}
function productionBasisSummary(record){
  const p=record.payload,script=state.screenplays.find(s=>s.object_id===p.screenplay.object_id&&s.id===p.screenplay.revision_id);
  const title=script?.payload.title||p.title,label=title.match(/^(?:剧本|版本)\s*([一二三四五六七八九十百零〇\d]+)/u);
  return `剧本依据：${label?'版本'+label[1]:title} · 已确认 · ${p.episodes.length} 集`;
}
function productionRefLink(parent,ref,label,referenceTitles=[]){
  if(!ref?.object_id||!ref.revision_id)return;
  const kind=ref.kind||(state.productionRecords||[]).find(row=>row.object_id===ref.object_id)?.kind;
  if(['AV_SHOT','AV_SCENE'].includes(kind)||['ENTITY','STATE'].includes(ref.kind)){
    const button=productionButton(parent,label?businessTitle({...ref,kind},label):productionName(ref,referenceTitles),()=>openUnifiedMaterial(ref,button));button.className='production-ref';button.setAttribute('aria-haspopup','dialog');return button;
  }
  const basis=state.productionRecords?.find(r=>r.object_id===ref.object_id&&r.kind==='INPUT_LOCK');
  if(basis){nodeText('span','production-ref',basis.id===ref.revision_id?productionBasisSummary(basis):(label||'剧本依据')+' · 历史版本',parent);return}
  if(ref.scene_id||ref.block_ids)return materialReferenceLink(parent,ref,label||`${productionName(ref,referenceTitles)} · ${ref.scene_id?reviewPositionLabel('scene',ref.scene_id,ref.object_id):'正文依据'}`,true);
  if(label)label=businessTitle(ref,label);
  const episode=state.screenplays.flatMap(v=>v.episodes).find(e=>e.object_id===ref.object_id&&e.id===ref.revision_id);
  if(episode){const url=new URL(location.href);url.search='';url.searchParams.set('workspace','story.script');url.searchParams.set('script',episode.payload.screenplay_id);url.searchParams.set('episode',episode.object_id);if(ref.scene_id)url.searchParams.set('scene',ref.scene_id);const a=link(label||`${reviewPositionText(episode.payload.title)} · ${ref.scene_id?reviewPositionLabel('scene',ref.scene_id,ref.object_id):'本集'}`,url.href,parent);a.className='production-ref';a.title=`修订 ${ref.revision_id}\n${(ref.block_ids||[]).join(', ')}`;return}
  const script=state.screenplays.find(s=>s.object_id===ref.object_id&&s.id===ref.revision_id);
  if(script){const url=new URL(location.href);url.search='';url.searchParams.set('workspace','story.script');url.searchParams.set('script',script.object_id);link(label||script.payload.title,url.href,parent);return}
  if(!(state.productionRecords||[]).some(r=>r.object_id===ref.object_id))return materialReferenceLink(parent,ref,label||productionName(ref,referenceTitles),true);
  if((state.productionRecords||[]).some(r=>r.object_id===ref.object_id&&['ASSET','REQUIREMENT'].includes(r.kind)))return materialReferenceLink(parent,ref,label||productionName(ref,referenceTitles));
  const b=productionButton(parent,label||productionName(ref,referenceTitles),()=>openProductionRecord(ref.object_id,ref.revision_id,true));b.className='production-ref';b.title=`${ref.object_id} · ${ref.revision_id}`;
}
// Browsing follows stable entity identity; the selected record remains an exact revision.
function productionEntityIds(record,byId=new Map((state.productionRecords||[]).map(r=>[r.object_id,r]))){
  if(!record)return [];
  if(record.kind==='ENTITY')return [record.object_id];
  if(record.kind==='STATE')return [record.payload.entity.object_id];
  return [];
}
function productionEntityChildren(entityId){
  const byId=new Map((state.productionRecords||[]).map(r=>[r.object_id,r]));
  return (state.productionRecords||[]).filter(r=>r.payload.status!=='withdrawn'&&productionCompleteState(r)&&productionEntityIds(r,byId).includes(entityId));
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
  for(const [kind,label] of [['STATE','实体状态']]){
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
  if(r?.kind==='STATE'&&!productionCompleteState(r))nodeText('p','production-issue','历史局部状态：保留当时的引用与评论，不计入当前实体状态。请从上方选择实体状态查看现用设定。',section);
  if(!children.length)nodeText('p','production-meta','尚未登记实体状态或制作设定。',section);
  root.append(section);
}
async function loadProductionWorkspace({onReadStart}={}){
  invalidateProductionReads();
  const route=new URL(location.href),legacyObject=route.searchParams.get('production_object');
  if(typeof productionTab==='function'&&legacyObject&&!route.searchParams.has('breakdown_object')&&!route.searchParams.has('material_id')&&productionTab()==='breakdown'&&!route.searchParams.has('production_entity')){
    const workspace=state.workspace,read=++productionReadEpoch;
    let linked;try{linked=await api('/api/production?'+new URLSearchParams({object_id:legacyObject,...(route.searchParams.get('production_revision')?{revision_id:route.searchParams.get('production_revision')}:{})}))}
    catch(error){if(state.workspace!==workspace||read!==productionReadEpoch)return;const host=$('#production-view');host.replaceChildren();nodeText('p','production-issue','准确旧目标不可用：'+error.message,host);state.productionSelected=null;throw error}
    if(state.workspace!==workspace||read!==productionReadEpoch)return;
    const row=linked.record;
    if(row.retired_review){const host=$('#production-view');host.replaceChildren();nodeText('p','production-issue',row.payload.title,host);for(const comment of row.history_comments||[])host.append(commentCard(comment));state.productionSelected=null;return}
    if(workspace==='settings.workspace'&&['ENTITY','STATE'].includes(row.kind))route.searchParams.set('production_tab','entities');
    else if(['AV_SHOT','AV_SCENE'].includes(row.kind)){
      const episode=row.payload.episode||row.payload.source;
      if(episode)route.searchParams.set('breakdown_episode',episode.object_id);
      route.searchParams.set('breakdown_object',row.object_id);route.searchParams.set('breakdown_revision',row.id);
    }
    else{const host=$('#production-view');host.replaceChildren();nodeText('p','production-issue','此准确对象不是场镜制作位置，请从原来源读取。',host);state.productionSelected=null;return}
    history.replaceState(null,'',route);
  }
  if(typeof productionTab==='function'){const tab=productionTab();if(tab==='retired'){const host=$('#production-view');host.replaceChildren();nodeText('p','production-issue','此旧页面已退役，目标不可用。请从生产制作选择当前子页。',host);state.productionSelected=null;return}if(tab==='breakdown')return loadProductionBreakdown();if(tab==='materials')return loadProductionMaterials()}
  const workspace=state.workspace,epoch=++productionLoadEpoch,readEpoch=productionReadEpoch,view=$('#production-view');view.replaceChildren();const loading=nodeText('p',null,'正在读取制作记录…',view);
  let result;try{result=await api(typeof productionTab==='function'?'/api/production/index?'+new URLSearchParams({view:'settings',...(typeof managementScopeParams==='function'?managementScopeParams():{}),object_id:new URL(location.href).searchParams.get('production_object')||''}):'/api/production')}
  catch(error){if(state.workspace!==workspace||epoch!==productionLoadEpoch||readEpoch!==productionReadEpoch)return;if(loading.isConnected){view.replaceChildren();nodeText('p','production-issue',`制作记录读取失败：${error.message}。请通过左侧导航重新打开本页。`,view);if(['production_scope_episode','production_scope_revision','production_scope_scene'].some(key=>new URL(location.href).searchParams.has(key)))productionButton(view,'重新选择制作范围',()=>{breakdownRoute({production_scope_episode:null,production_scope_revision:null,production_scope_scene:null});loadProductionWorkspace()})}throw error}
  if(state.workspace!==workspace||epoch!==productionLoadEpoch)return;
  state.productionRecords=result.records;
  if(workspace==='settings.workspace'&&result.entity_state_counts)return loadEntityManagement(result,{epoch,onReadStart});
  const param=new URL(location.href).searchParams,selected=param.get('production_object'),requested=result.records.find(r=>r.object_id===selected);
  const host=$('#production-view');host.replaceChildren();
  if(typeof productionTabs==='function')productionTabs(host);
  const flatFilters=workspace==='settings.workspace',flatLayout=flatFilters||workspace==='materials.workspace',filters={kind:'',category:'',episode:'',scene:''},filterSelects={};
  const filterPanel=el('section',flatLayout?'production-filters':''),toolbar=el('div','production-toolbar'),search=el('input');
  search.type='search';search.placeholder=flatFilters?'搜索实体、别名、状态或设定':'搜索名称、别名或集场';search.setAttribute('aria-label','搜索制作记录');
  let clearFilters,resultSummary;
  if(flatLayout){
    filterPanel.setAttribute('aria-label',flatFilters?'制作设定筛选':'素材管理筛选');
    const label=el('label','production-filter-search');nodeText('span',null,flatFilters?'搜索设定':'搜索素材',label);label.append(search);toolbar.append(label);
    clearFilters=productionButton(toolbar,'清除筛选',()=>{search.value='';for(const key of Object.keys(filters))filters[key]='';refreshIndex()});
    filterPanel.append(toolbar);
  }else{toolbar.append(search);filterPanel.append(toolbar)}
  const kindOptions=workspace==='materials.workspace'?[['','全部'],['ungenerated','未生成'],['generated','已生成']]:[['','全部类型'],...productionGroups[workspace].map(kind=>[kind,productionKinds[kind]])];
  const categoryRows=productionWorkspaceRows(result.records,workspace,result.material_assets),categoryById=new Map(result.records.map(r=>[r.object_id,r]));
  const categories=flatFilters?[...new Set(categoryRows.filter(r=>r.kind==='ENTITY').map(r=>r.payload.entity_type))]:workspace==='materials.workspace'?['image','audio','video','project','document'].filter(type=>categoryRows.some(r=>productionFilterMediaTypes(r,categoryById).includes(type))):[];
  const categoryOptions=[['',flatFilters?'全部实体':'全部内容'],...categories.map(value=>[value,productionLabels[value]||categoryRows.find(r=>r.payload.entity_type===value)?.payload.entity_type_label||({image:'图像',audio:'声音',video:'视频',project:'工程',document:'说明文件'})[value]])];
  const facetButtons=[];
  for(const [key,label,options] of [['kind',workspace==='materials.workspace'?'生成状态':'记录类型',kindOptions],['category','内容分类',categoryOptions]]){
    if((key==='kind'&&flatFilters)||(key==='category'&&!categories.length))continue;
    if(flatLayout){
      const group=el('div','production-filter-group'),labelId=`production-filter-${key}-label`;
      group.setAttribute('role','group');group.setAttribute('aria-labelledby',labelId);nodeText('span','production-filter-label',label,group).id=labelId;
      const choices=el('div','production-filter-options');group.append(choices);
      for(const [value,title] of options){
        const button=productionButton(choices,'',()=>{filters[key]=filters[key]===value?'':value;refreshIndex()});
        button.className='production-filter-chip';button.dataset.filterKey=key;button.dataset.filterValue=value;
        if(productionEntitySymbols[value]||productionMediaSymbols[value]){button.append(productionEntityIcon(value));button.dataset.entityType=value}
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
  if(flatLayout){resultSummary=nodeText('p','production-filter-summary','',filterPanel);resultSummary.setAttribute('role','status')}
  host.append(filterPanel);
  const board=el('div','production-board'+(flatFilters?' entity-review-board':'')),index=el('nav','production-index'),reader=el('article','production-reader');index.id='production-index';index.setAttribute('aria-label',flatFilters?'制作实体':'制作记录');reader.id='production-reader';board.append(index,reader);host.append(board);
  const byId=new Map(result.records.map(r=>[r.object_id,r]));
  const contextOf=(r,seen=new Set())=>{if(!r||seen.has(r.object_id))return {};seen.add(r.object_id);const p=r.payload;if(p.episode||p.source)return {episode:(p.episode||p.source).object_id,episodeRevision:(p.episode||p.source).revision_id,scene:p.scene_id||p.source?.scene_id,number:p.number};return contextOf(byId.get(p.scope?.object_id),seen)};
  const contexts=new Map(result.records.map(r=>[r.object_id,contextOf(r)]));
  const workspaceRows=productionWorkspaceRows(result.records,workspace,result.material_assets);
  const childrenByEntity=new Map(workspaceRows.map(r=>[r.object_id,[]]));
  if(flatFilters)for(const r of result.records.filter(r=>productionCompleteState(r)))for(const id of productionEntityIds(r,byId))childrenByEntity.get(id)?.push(r);
  const searchTexts=new Map(workspaceRows.map(r=>[r.object_id,JSON.stringify([r.payload,...(r.material_assets||[]).map(a=>a.payload),...(childrenByEntity.get(r.object_id)||[]).map(child=>child.payload)]).toLowerCase()]));
  const matches=(r,selection=filters)=>{
    const context=contexts.get(r.object_id),category=selection.category;
    return (!selection.kind||(workspace==='materials.workspace'?(selection.kind==='generated'?r.material_generated:!r.material_generated):r.kind===selection.kind))&&
      (!category||r.payload.entity_type===category||productionFilterMediaTypes(r,byId).includes(category)||byId.get(r.payload.entity?.object_id)?.payload.entity_type===category)&&
      (!selection.episode||context.episode===selection.episode)&&(!selection.scene||context.scene===selection.scene)&&searchTexts.get(r.object_id).includes(search.value.trim().toLowerCase());
  };
  const episodes=state.screenplays.flatMap(s=>s.episodes);
  const renderIndex=()=>{
    index.replaceChildren();
    const matchingRows=workspaceRows.filter(r=>matches(r));if(flatFilters)state.productionVisibleEntities=new Set(matchingRows.map(r=>r.object_id));
    for(const kind of productionGroups[workspace]){
      const rows=matchingRows.filter(r=>r.kind===kind).sort((a,b)=>{const x=contexts.get(a.object_id),y=contexts.get(b.object_id);return (x.episode||'').localeCompare(y.episode||'')||(x.scene||'').localeCompare(y.scene||'')||(x.number||0)-(y.number||0)||a.object_id.localeCompare(b.object_id)});
      if(!rows.length)continue;
      nodeText('h3',null,`${workspace==='materials.workspace'?(kind==='REQUIREMENT'?'素材':'历史独立素材'):productionKinds[kind]} · ${rows.length}`,index);
      let lastType=null,entityList=index;
      for(const r of rows.sort((a,b)=>flatFilters?a.payload.entity_type.localeCompare(b.payload.entity_type)||a.payload.title.localeCompare(b.payload.title):0)){
        const children=childrenByEntity.get(r.object_id)||[],states=children.filter(child=>child.kind==='STATE').length;
        if(flatFilters&&lastType!==r.payload.entity_type){lastType=r.payload.entity_type;nodeText('h3',null,productionLabels[lastType]||r.payload.entity_type_label||lastType,index);entityList=el('div','entity-small-list');index.append(entityList)}
        const counts=flatFilters?(result.entity_material_counts?.[r.object_id]||{}):{},selected=(flatFilters?state.productionEntityId:state.productionSelected?.object_id)===r.object_id;
        const context=contexts.get(r.object_id),episode=episodes.find(ep=>ep.object_id===context.episode&&(!context.episodeRevision||ep.id===context.episodeRevision));
        const position=[episode?reviewPositionLabel('episode',episode):null,context.scene?reviewPositionLabel('scene',context.scene,context.episode):null,r.kind==='AV_SHOT'?reviewPositionLabel('shot',r):null].filter(Boolean).join(' / ');
        const version=r.current_content||r.candidate_id?'':workspace==='materials.workspace'?(r.material_generated?'已生成':'未生成'):r.kind==='ASSET'?(Number.isInteger(r.material_version)&&r.material_version>0?'版本 '+r.material_version:''):'修订 '+r.version;
        const title=r.kind==='AV_SCENE'?breakdownSceneTitle(r):r.kind==='AV_SHOT'?breakdownShotTitle(r):reviewPositionText(r.payload.title);
        const subtitle=flatFilters?`状态 ${result.entity_state_counts?.[r.object_id]??states} 个 · 素材 ${Object.values(counts).reduce((sum,n)=>sum+n,0)} 个 · `:['REQUIREMENT','ASSET'].includes(r.kind)?materialCountText(result.material_card_counts?.[r.object_id]||{}):[productionLabels[r.payload.entity_type]||position,version].filter(Boolean).join(' · ');
        const b=reviewSmallCard(entityList,{title,business_code:['AV_SCENE','AV_SHOT'].includes(r.kind)?'':businessCode(r),icon:r.payload.entity_type||r.payload.media_type||({AV_SCENE:'space',AV_SHOT:'video'})[r.kind]||'document',preview:flatFilters?result.entity_previews?.[r.object_id]:r.payload.components?.find(c=>c.role==='original'&&c.mime?.startsWith('image/')),subtitle},()=>openProductionRecord(r.object_id),selected);b.dataset.objectId=r.object_id;b.classList.toggle('active',selected);
        if(flatFilters){b.classList.add('entity-small-card');b.dataset.entityType=r.payload.entity_type}

      }
    }
    if(!index.childElementCount)nodeText('p',null,workspaceRows.length?'没有匹配记录，请调整筛选条件。':'当前没有可审阅的记录。',index);
    if(flatFilters&&!matchingRows.length){++productionReadEpoch;state.productionSelected=null;state.entityReview=null;state.materialReview=null;reader.replaceChildren();nodeText('p','production-meta','没有符合筛选条件的实体',reader);renderComments()}
    return matchingRows;
  };
  let indexReady=false;
  const refreshIndex=()=>{
    const rows=renderIndex();
    for(const facet of facetButtons){
      const count=workspaceRows.filter(r=>matches(r,{...filters,[facet.key]:facet.value})).length,selected=filters[facet.key]===facet.value;
      facet.count.textContent=count;facet.button.classList.toggle('is-active',selected);facet.button.classList.toggle('is-zero',!count);
      facet.button.setAttribute('aria-pressed',String(selected));facet.button.setAttribute('aria-label',`${facet.label}：${facet.title}，${count} ${flatFilters?'个实体':'项素材'}`);
    }
    if(resultSummary){
      resultSummary.textContent=flatFilters?`当前结果：${rows.length} 个实体`:`当前结果：${rows.length} 项素材`;
      clearFilters.disabled=!search.value&&!Object.values(filters).some(Boolean);
    }
    if(indexReady&&flatFilters&&rows.length&&(!state.entityReview||!rows.some(r=>r.object_id===state.productionEntityId)))openProductionRecord(rows[0].object_id).catch(e=>toast(e.message));
  };
  state.refreshEntityIndex=async()=>{if(!flatFilters)return;const fresh=await api('/api/production/index?view=settings');if(state.workspace!==workspace||epoch!==productionLoadEpoch)return;result.entity_material_counts=fresh.entity_material_counts;refreshIndex()};
  const firstMatchingRow=()=>productionGroups[workspace].flatMap(kind=>workspaceRows.filter(r=>r.kind===kind&&matches(r)).sort((a,b)=>a.object_id.localeCompare(b.object_id)))[0];
  search.oninput=refreshIndex;refreshIndex();
  indexReady=true;
  const candidate=(requested&&(productionWorkspaceCanRead(workspace,requested)||(flatFilters&&typeof entityMaterialRouteOwner==='function'&&entityMaterialRouteOwner(requested,param)))?requested:null)||(flatFilters?result.records.find(r=>r.kind==='ENTITY'&&r.object_id===param.get('production_entity')):null)||firstMatchingRow();
  if(candidate){const reading=openProductionRecord(candidate.object_id,selected===candidate.object_id?param.get('production_revision'):null);onReadStart?.({workspace,loadEpoch:epoch,readEpoch:productionReadEpoch});await reading}else{state.productionSelected=null;nodeText('p',null,'此入口已开放，当前实例尚未登记生产数据。',reader);renderComments()}
}
async function openProductionRecord(objectId,revisionId=null,navigate=false,entityId=null){
  if(typeof rememberProductionDraft==='function')rememberProductionDraft();const workspaceAtStart=state.workspace,epoch=++productionReadEpoch;
  let detail=await api('/api/production?'+new URLSearchParams({object_id:objectId,...(revisionId?{revision_id:revisionId}:{})}));
  const exactRoute=new URL(location.href);
  if(exactRoute.searchParams.get('production_object')===objectId&&Object.values(detail.material_versions||{}).some(rs=>rs.some(r=>r.baseline_id))){
    normalizeConsolidatedMaterialRoute(exactRoute.searchParams,exactRoute.searchParams.has('material_round')?detail.legacy_material_versions:detail.material_versions);history.replaceState(history.state,'',exactRoute);
  }
  if(epoch!==productionReadEpoch||state.workspace!==workspaceAtStart)return;
  const needsWorkspaceRoute=!productionWorkspaceCanRead(state.workspace,detail.record);
  if(navigate&&needsWorkspaceRoute){
    const workspace=Object.keys(productionGroups).find(k=>productionGroups[k].includes(detail.record.kind))||(detail.record.kind==='CALL'?'materials.workspace':state.workspace);
    const url=new URL(location.href);
    url.searchParams.set('workspace',workspace);url.searchParams.set('production_object',objectId);url.searchParams.set('production_revision',detail.record.id);url.hash='';
    if(url.href!==location.href){
      if(typeof rememberWorkspacePosition==='function')rememberWorkspacePosition();
      if(typeof rememberWorkspaceRoute==='function')rememberWorkspaceRoute();
      history.pushState(null,'',url);
    }
    if(needsWorkspaceRoute){switchWorkspace(workspace,false);return}
  }
  const materialOwner=!navigate&&state.workspace==='settings.workspace'&&typeof entityMaterialRouteOwner==='function'?entityMaterialRouteOwner(detail.record,new URL(location.href).searchParams):null;
  if(materialOwner){await openEntityReview(materialOwner,detail,epoch,revisionId);return}
  if(!isProduction()||!productionWorkspaceCanRead(state.workspace,detail.record))return;
  const byId=new Map(state.productionRecords.map(r=>[r.object_id,r]));
  const owners=productionEntityIds(detail.record,byId),url=new URL(location.href);
  if(state.materialReview&&(state.materialReview.record.object_id!==objectId||revisionId&&revisionId!==state.materialReview.record.id)){url.searchParams.delete('material_round');url.searchParams.delete('material_target');history.replaceState(null,'',url)}
  const preferred=entityId||url.searchParams.get('production_entity')||state.productionEntityId;
  const owner=owners.includes(preferred)?preferred:owners[0]||null;
  if(state.workspace==='settings.workspace'&&owner&&detail.record.kind!=='RELATION'&&typeof openEntityReview==='function'){
    await openEntityReview(owner,detail,epoch,revisionId);return;
  }
  state.entityReview=null;state.materialReview=state.workspace==='materials.workspace'&&['ASSET','REQUIREMENT'].includes(detail.record.kind)?detail:null;if(state.materialReview)detail.explicitRevision=!!revisionId;
  let entityDetail=null,childDetail=null;
  if(state.workspace==='settings.workspace'&&owner&&detail.record.kind!=='RELATION'){
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
  for(const button of document.querySelectorAll('#production-index button')){
    const selected=button.dataset.objectId===(state.workspace==='settings.workspace'&&owner?owner:detail.record.object_id);
    button.classList.toggle('active',selected);
    if(button.dataset.objectId)button.setAttribute('aria-pressed',String(selected));
  }
  renderProductionReader();renderComments();
}
function focusProductionReview(detail,paint=true){
  const r=detail.record;
  if(state.productionSelected?.id!==r.id){if(typeof rememberProductionDraft==='function')rememberProductionDraft();state.reviewCommentScope=null;state.anchor=null;state.editing=null;state.selected=null;state.drawMode=null}
  state.productionSelected=r;state.productionDetail=detail;
  const url=new URL(location.href);url.searchParams.set('production_object',r.object_id);url.searchParams.set('production_revision',r.id);
  if(typeof isEntityReview==='function'&&isEntityReview()){
    if(!['ASSET','REQUIREMENT','CALL'].includes(r.kind)&&r.id===r.current_revision&&!state.entityReview.historical&&!state.entityReview.historicalTarget)url.searchParams.delete('production_revision');
    const context=['ASSET','REQUIREMENT','CALL'].includes(r.kind)?materialCommentContext():null;
    if(context){const round=state.entityReview.material_versions?.[context.material_id]?.find(r=>r.number===context.number);writeMaterialVersionRoute(url.searchParams,context.material_id,round||context)}
    else{url.searchParams.delete('material_id');url.searchParams.delete('material_round');url.searchParams.delete('material_version');url.searchParams.delete('material_baseline')}
  }
  if((state.workspace==='settings.workspace'||state.unifiedCardRoot&&state.entityReview)&&state.productionEntityId){url.searchParams.set('production_entity',state.productionEntityId);if(state.productionChildDetail?.record)url.searchParams.set('entity_state',state.productionChildDetail.record.object_id);}else url.searchParams.delete('production_entity');
  if(typeof isMaterialReview==='function'&&isMaterialReview()){url.searchParams.set('production_object',state.materialReview.record.object_id);url.searchParams.set('production_revision',state.materialReview.record.id);url.searchParams.set('material_target',r.id)}
  history.replaceState(history.state,'',url);
  for(const blocks of document.querySelectorAll('[data-production-blocks]')){if(blocks.dataset.productionBlocks===r.id)blocks.id='production-blocks';else{blocks.removeAttribute('id');for(const para of blocks.querySelectorAll('.comment-flash'))para.classList.remove('comment-flash')}}
  if(typeof restoreProductionDraft==='function')restoreProductionDraft();
  if(paint){paintProductionReview();renderComments()}
}
function productionFields(parent,fields){const dl=el('dl','production-fields');for(const [label,value] of fields){if(value===undefined||value===null||value==='')continue;nodeText('dt',null,label,dl);nodeText('dd',null,typeof value==='string'?value:JSON.stringify(value),dl)}parent.append(dl)}
function productionList(parent,title,items){if(!items?.length)return;nodeText('h3',null,title,parent);const list=el('ul');for(const item of items){const row=el('li');if(typeof item==='string')row.textContent=item;else if(item.speaker){nodeText('p',null,`${item.speaker}${item.type==='singing'?'（演唱）':'（对白）'}：${item.text}`,row);if(item.fps&&Number.isFinite(item.planned_start_frame))nodeText('small',null,`镜内预计 ${(item.planned_start_frame/item.fps).toFixed(2)}–${(item.planned_end_frame/item.fps).toFixed(2)} 秒；${item.timing_status}`,row);productionRefLink(row,item.source,'查看原文')}else row.textContent=item.description||JSON.stringify(item);list.append(row)}parent.append(list)}
function productionMedia(parent,component,review=true){
  const url='/api/production/files/'+encodeURIComponent(component.file);
  if(component.mime.startsWith('image/')){if(review)parent.append(renderStructureVisual({...component,title:reviewPositionText(state.productionSelected.payload.title),alt:reviewPositionText(state.productionSelected.payload.title),description:`${component.role} · ${component.width}×${component.height}`},true));else{const img=el('img');img.width=component.width;img.height=component.height;img.src=reviewURL(url);img.alt=component.id;parent.append(img)}}
  else if(component.mime.startsWith('audio/')||component.mime.startsWith('video/'))reviewMediaPlayer(parent,component,state.productionSelected,{},review);
  if(!component.mime.startsWith('audio/'))link(`下载 ${component.role} · ${component.file.slice(0,12)}…`,url,parent);nodeText('p','production-meta',`${component.mime} · ${component.bytes.toLocaleString()} bytes · SHA-256 ${component.sha256}`,parent);
}
function renderProductionReader(){
  const restore=preserveCardPosition();try{return renderProductionReaderContent()}finally{restore()}
}
function preserveCardPosition(){
  if(typeof window==='undefined')return ()=>{};
  const selectors=['#production-reader','.review-dialog-body','.unified-card-material','.production-entity-options','.review-choice-buttons','.relation-graph-viewport'];
  const offsets=selectors.map(selector=>[selector,[...document.querySelectorAll(selector)].map(node=>[node.scrollLeft,node.scrollTop])]),x=window.scrollX,y=window.scrollY;
  return ()=>{for(const [selector,values] of offsets)[...document.querySelectorAll(selector)].forEach((node,i)=>{if(values[i]){node.scrollLeft=values[i][0];node.scrollTop=values[i][1]}});window.scrollTo(x,y)};
}
function renderProductionReaderContent(){
  const root=state.unifiedCardRoot||$('#production-reader');if(!root)return;if(typeof pauseReviewMedia==='function')pauseReviewMedia(root);root.replaceChildren();
  if(state.positionReview&&state.unifiedCardRoot){renderUnifiedCard(root);return}
  if(typeof isEntityReview==='function'&&isEntityReview()){renderUnifiedCard(root);return}
  if(typeof isMaterialReview==='function'&&isMaterialReview()){renderUnifiedCard(root);return}
  if(state.workspace==='settings.workspace'&&state.productionEntityDetail){
    const entity=el('section','production-entity-basics');entity.setAttribute('aria-label','实体基础信息');root.append(entity);
    renderProductionRecord(entity,state.productionEntityDetail,true);
    renderProductionEntityNavigation(root,state.productionChildDetail?.record);
    if(state.productionChildDetail){const child=el('section','production-entity-state');child.setAttribute('aria-label','状态与设定详情');root.append(child);renderProductionRecord(child,state.productionChildDetail)}
  }else renderProductionRecord(root,state.productionDetail);
  paintProductionReview();
}
function renderProductionRecord(root,detail,entityCard=false){
  const r=detail.record,p=r.payload,activate=action=>()=>{focusProductionReview(detail);return action()},referenceTitles=detail.reference_titles||[];
  const review=entityCard?el('section','production-entity-review'):root;

  nodeText('small','production-pill',entityCard?'实体基础信息 · '+productionLabels[p.entity_type]:p.relation_type==='entity'?'实体关系':productionKinds[r.kind],root);nodeText('h2',null,businessTitle(r,p.title),root);
  const bar=el('div','production-toolbar'),versions=el('select');versions.setAttribute('aria-label',entityCard?'选择实体版本':'选择精确版本');for(const v of detail.history){const option=new Option(`${['ASSET','REQUIREMENT','CALL'].includes(r.kind)?'记录修订':'版本'} ${v.version}${v.id===r.current_revision?' · 当前':''}`,v.id);option.title=v.created_at;versions.append(option)}versions.value=r.id;versions.onchange=()=>openProductionRecord(r.object_id,versions.value).catch(e=>toast(e.message));if(!r.current_content&&!r.candidate_id)bar.append(versions);
  if(p.relation_type==='entity'){versions.remove();nodeText('small','production-meta',`记录修订 ${r.version}${p.explanation_removed?' · 旧说明已清理':''}`,bar)}
  productionButton(bar,'整体意见',activate(()=>startDraft({type:'global'})));productionButton(bar,'查看评论',activate(openPanel));productionButton(bar,'查看当前引用',async()=>{const data=await api('/api/production/impact?revision_id='+r.id);const section=el('section');nodeText('h3',null,`受影响的当前引用 ${data.affected.length}`,section);for(const use of data.affected)productionRefLink(section,use,`${productionKinds[use.kind]||use.kind} · ${use.title}`);if(!data.affected.length)nodeText('p',null,'没有查到当前下游引用。',section);root.append(section);section.scrollIntoView({block:'center'})});review.append(bar);if(entityCard)root.append(review);
  const blocks=reviewSurface(el('div'));blocks.dataset.productionBlocks=r.id;if(state.productionSelected?.id===r.id)blocks.id='production-blocks';blocks.onpointerdown=()=>focusProductionReview(detail);blocks.onfocusin=()=>focusProductionReview(detail);for(const b of p.blocks){const para=nodeText('p',null,b.text,blocks);para.dataset.blockId=b.id}root.append(blocks);
  if(productionCompleteState(r)){
    nodeText('p','production-meta','这是该实体在一个时刻的完整状态，可跨场复用。整体参考说明全貌，角度、局部和声音作为补充。',root);
    productionFields(root,[['整体参考类型',({image:'图像',audio:'声音',none:'仅提及，无媒体生产要求'})[p.reference_media]]]);
    const candidates=state.productionRecords.filter(a=>a.kind==='ASSET'&&a.payload.state_coverage?.some(c=>c.state.revision_id===r.id));
    if(candidates.length){nodeText('h3',null,'关联素材候选',root);for(const a of candidates)for(const c of a.payload.state_coverage.filter(c=>c.state.revision_id===r.id)){productionRefLink(root,productionRef(a),`${c.role==='overall'?'整体':'补充'} · ${a.payload.title} · 版本 ${materialRecordRound(a)||1} · ${c.component_id}`);nodeText('p',null,c.detail,root)}}
    if(p.reference_media!=='none'){
      if(r.id===r.current_revision){const inputs=el('div','production-state-references');root.append(inputs);renderProductionReadiness(inputs,r,{isCurrent:()=>root.isConnected}).catch(e=>nodeText('p','production-issue',e.message,inputs))}
      else nodeText('p','production-meta','这是历史实体状态；现有参考与采用请在当前版本中核对。',root);
    }
  }
  productionFields(root,[['身份类型',productionLabels[p.entity_type]],['别名',p.aliases?.join('、')],['历史状态维度',productionCompleteState(r)?null:p.dimensions],['叙事目的',p.purpose],['构图与景别',p.framing],['空间关系',p.spatial],['动作开始',p.action_start],['动作结束',p.action_end],['预计时长',p.duration_frames&&p.fps?`${(p.duration_frames/p.fps).toFixed(2)} 秒 · ${p.duration_frames} 帧 / ${p.fps} fps`:null],['连续性',p.continuity],['输入用途',productionLabels[p.usage]],['制作状态',p.status],['工具',p.tool],['审阅结论',({keep:'保留原引用',rework:'需要返工',replace:'需要替换',needs_review:'待复核'})[p.change?.action]||productionLabels[p.verdict]],['审阅者',p.actor],['说明',p.reason],['画幅',p.width&&p.height?`${p.width}×${p.height}`:null]]);
  productionList(root,'剧本事实',p.facts);productionList(root,'制作选择',p.choices);productionList(root,'待确认',p.unknowns);productionList(root,'声音设计',p.sound);
  renderProductionTransitions(root,p.state_transitions);
  if(p.state_coverage?.length){nodeText('h3',null,'素材所说明的实体状态',root);for(const c of p.state_coverage){const row=el('div','production-need');productionRefLink(row,c.state);nodeText('p',null,`${c.role==='overall'?'整体参考':'细节／角度／声音补充'} · ${c.component_id} · ${c.detail}`,row);if(c.crop||c.range)productionFields(row,[['裁切',c.crop],['时间段',c.range]]);root.append(row)}}
  if(p.lyrics){nodeText('h3',null,'歌词原文与段落',root);for(const lyric of p.lyrics){nodeText('strong',null,lyric.section,root);nodeText('p',null,lyric.text,root);productionRefLink(root,lyric.source,'查看歌词正文依据')}nodeText('p',null,p.composition_status,root);productionList(root,'作品内容待确认',p.content_unknowns)}
  const references=entityCard?el('section','production-entity-references'):root;if(entityCard){nodeText('h3',null,'故事与使用位置',references);root.append(references)}
  const refs=el('section');nodeText('h3',null,'来源与依赖',refs);for(const key of ['entity','episode','screenplay','source','scope','production','target','asset'])if(p[key]?.revision_id)productionRefLink(refs,p[key],`${{entity:'所属实体',source:'剧情依据',production:'实际制作',scope:'使用位置',target:'审阅对象',episode:'所属分集',screenplay:'正式整版'}[key]||key}：${productionName(p[key],referenceTitles)}`,referenceTitles);for(const key of ['sources','entities','states','subjects','inputs','outputs','dependencies','previous_states'])for(const ref of p[key]||[])if(ref.revision_id)productionRefLink(refs,ref,undefined,referenceTitles);references.append(refs);
  if(p.occurrences){nodeText('h3',null,`全场出场检查 · ${p.occurrences.length} 项`,root);for(const occurrence of p.occurrences){const row=el('div','production-need');productionRefLink(row,occurrence.entity);nodeText('span','production-pill',productionLabels[occurrence.mode],row);for(const ref of occurrence.states)productionRefLink(row,ref);renderProductionTransitions(row,occurrence.transitions);for(const ref of occurrence.evidence)productionRefLink(row,ref,'查看正文依据');root.append(row)}}
  if(p.components?.length){nodeText('h3',null,'实际文件组成',root);const select=el('select');select.id='production-component';select.setAttribute('aria-label','原件与预览组成');for(const c of p.components)select.append(new Option(`${c.role} · ${c.id}`,c.id));const media=el('section');const draw=()=>{media.replaceChildren();productionMedia(media,p.components.find(c=>c.id===select.value));paintProductionReview()};select.onchange=draw;root.append(select,media);draw();if(r.kind==='ASSET'&&detail.history.length>1)productionButton(root,'并排比较版本',()=>showProductionCompare(root));}
  if(r.kind==='CALL')renderActualGeneration(root,{call:r,inputs:r.review_input_records||[]});
  else if(p.generation)renderGenerationRecipe(root,r);
  else if(p.prompt){const content=el('section');nodeText('h3',null,'制作内容',content);nodeText('p',null,p.prompt,content);root.append(content)}
  const relatedVersions=r.id===r.current_revision?detail.history:[r];
  const related=(state.productionRecords||[]).filter(other=>other.object_id!==r.object_id&&!(r.kind==='ENTITY'&&['STATE'].includes(other.kind))).map(other=>({other,versions:relatedVersions.filter(v=>JSON.stringify(other.payload).includes('"'+v.id+'"'))})).filter(item=>item.versions.length);
  if(related.length){nodeText('h3',null,'出场与当前使用',references);for(const {other,versions} of related)productionRefLink(references,productionRef(other),`${productionKinds[other.kind]} · ${other.payload.title}${relatedVersions.length>1?' · 引用版本 '+versions.map(v=>v.version).join('、'):''}`)}
  if(['AV_SHOT','AV_SCENE'].includes(r.kind)){if(r.id===r.current_revision)renderProductionReadiness(root,r).catch(e=>nodeText('p','production-issue',e.message,root));else nodeText('p','production-meta','当前正在阅读历史修订。查看现有缺项或改变采用，请切换到当前版本；历史制作输入保留在下方精确引用中。',root)}

}
function productionCommentTextRange(comment){
  const row=state.productionSelected,a=comment?.anchor;
  if(!a||comment.anchor_state?.valid===false||(a.type||'text')!=='text'||row?.object_id!==comment.target_object_id||row.id!==comment.target_revision_id)return null;
  if(a.segments){
    const segments=a.segments.map(anchor=>productionCommentTextRange({...comment,anchor}));
    if(segments.some(range=>!range))return null;
    return {segments,valid:segments.every(range=>range.valid),blocks:segments[0].blocks,anchor:a};
  }
  const blocks=productionTextBlocks(row),first=blocks.findIndex(b=>b.id===a.block_id),last=blocks.findIndex(b=>b.id===(a.end_block_id||a.block_id));
  if(first<0||last<first)return null;
  const valid=Number.isInteger(a.start)&&Number.isInteger(a.end)&&a.start>=0&&a.end>=0&&a.start<=Array.from(blocks[first].text).length&&a.end<=Array.from(blocks[last].text).length&&(first!==last||a.start<a.end);
  return {blocks,first,last,valid,anchor:a};
}
function productionTextHidden(node){
  for(let parent=node;parent;parent=parent.parentElement){
    if(parent.hidden||parent.getAttribute?.('aria-hidden')==='true')return true;
    if(typeof getComputedStyle==='function'){const style=getComputedStyle(parent);if(style.display==='none'||style.visibility==='hidden')return true}
  }
  return false;
}
function productionCommentTextSurface(comment){
  const range=productionCommentTextRange(comment);if(!range)return null;
  const root=state.reviewReferenceContext?.dialog||state.unifiedCardRoot||document.querySelector('#production-reader')||document.querySelector('#production-view');
  const surfaces=[...root?.querySelectorAll('[data-production-blocks]')||[]].filter(host=>host.dataset.productionBlocks===comment.target_revision_id&&!productionTextHidden(host)&&productionTextSurfaceContainsRange(range,host));
  // A visible exact surface wins over a collapsed copy. Otherwise reveal only
  // the selected exact surface, within the current card/reference container.
  return surfaces.find(host=>host.getClientRects?.().length)||surfaces[0]||null;
}
function productionTextSurfaceContainsRange(range,surface){
  if(range.segments)return range.segments.every(part=>productionTextSurfaceContainsRange(part,surface));
  const nodes=productionCommentTextNodes(range,surface);if(!range.valid)return !!nodes.length;
  for(let index=range.first;index<=range.last;index++){
    const text=Array.from(range.blocks[index].text),start=index===range.first?range.anchor.start:0,end=index===range.last?range.anchor.end:text.length;
    let cursor=start;
    const parts=nodes.filter(n=>n.dataset.blockId===range.blocks[index].id).map(n=>({start:Number(n.dataset.anchorOffset||0),end:Number(n.dataset.anchorOffset||0)+Array.from(n.textContent).length})).sort((a,b)=>a.start-b.start);
    for(const part of parts){if(part.start>cursor&&!(part.start===cursor+1&&text[cursor]==='\n'))return false;cursor=Math.max(cursor,part.end);if(cursor>=end)break}
    if(cursor<end)return false;
  }
  return true;
}
function productionCommentTextNodes(range,surface){
  if(range.segments)return [...new Set(range.segments.flatMap(part=>productionCommentTextNodes(part,surface)))];
  return [...surface.querySelectorAll('[data-block-id]')].filter(node=>{
    if(productionTextHidden(node))return false;
    const index=range.blocks.findIndex(b=>b.id===node.dataset.blockId);if(index<range.first||index>range.last)return false;
    if(!range.valid)return index===range.first;
    const start=index===range.first?range.anchor.start:0,end=index===range.last?range.anchor.end:Array.from(range.blocks[index].text).length;
    const base=Number(node.dataset.anchorOffset||0),length=Array.from(node.textContent).length;
    return base<end&&start<base+length;
  });
}
function productionCommentTextNode(anchor){
  const comment={anchor,target_object_id:state.productionSelected?.object_id,target_revision_id:state.productionSelected?.id},surface=productionCommentTextSurface(comment);
  return surface?productionCommentTextNodes(productionCommentTextRange(comment),surface)[0]:null;
}
function paintProductionCommentText(comment){
  // Clear prior selection without flattening unrelated interactive markup.
  for(const node of document.querySelectorAll('[data-production-comment-text]')){
    for(const mark of [...node.querySelectorAll('.comment-mark')])mark.replaceWith(document.createTextNode(mark.textContent));
    node.normalize();
    node.removeAttribute('data-production-comment-text');node.classList.remove('comment-flash');
  }
  for(const node of document.querySelectorAll('#production-blocks .comment-flash'))node.classList.remove('comment-flash');
  const range=productionCommentTextRange(comment),surface=productionCommentTextSurface(comment);if(!range||!surface)return;
  if(surface.closest('.material-use-details'))return; // Already uses the shared full comment renderer.
  for(const part of range.segments||[range])for(const node of productionCommentTextNodes(part,surface)){
    const index=part.blocks.findIndex(b=>b.id===node.dataset.blockId),block=part.blocks[index],base=Number(node.dataset.anchorOffset||0),text=node.textContent,length=Array.from(text).length;
    // Excerpts carry Unicode offsets into the original block. Preserve their
    // exact text and labels; missing/invalid legacy ranges get only a block cue.
    node.dataset.productionCommentText='';
    if(!part.valid||Array.from(block.text).slice(base,base+length).join('')!==text){node.classList.add('comment-flash');continue}
    const start=Math.max(0,(index===part.first?part.anchor.start:0)-base),end=Math.min(length,(index===part.last?part.anchor.end:Array.from(block.text).length)-base);
    paintProductionTextMark(node,start,end,comment);
  }
}
function paintProductionTextMark(node,start,end,comment){
  // Wrap text leaves, retaining reference links and other inline controls.
  const walker=document.createTreeWalker(node,4),leaves=[];let offset=0,leaf;
  while(leaf=walker.nextNode()){const length=Array.from(leaf.textContent).length;leaves.push({leaf,offset,length});offset+=length}
  for(const {leaf,offset,length} of leaves){
    const from=Math.max(0,start-offset),to=Math.min(length,end-offset);if(from>=to)continue;
    const letters=Array.from(leaf.textContent),mark=el('span','comment-mark selected'+(comment.status==='CLOSED'?' closed':''),letters.slice(from,to).join(''));
    mark.dataset.commentIds=comment.id;mark.title=comment.body;
    mark.onclick=()=>{if(window.getSelection()?.isCollapsed)selectComment(comment.id)};
    leaf.replaceWith(document.createTextNode(letters.slice(0,from).join('')),mark,document.createTextNode(letters.slice(to).join('')));
  }
}
function paintProductionReview(){
  if(!isProduction())return;if(typeof paintMaterialUseText==='function')paintMaterialUseText();paintStructureRegions();for(const player of document.querySelectorAll('.review-media-player'))player.reviewPaintComments?.();
  const selected=state.comments.find(c=>c.id===state.selected&&c.target_object_id===state.productionSelected?.object_id&&c.target_revision_id===state.productionSelected?.id);
  paintProductionCommentText(selected);
}
function renderProductionTransitions(root,transitions){
  if(!transitions?.length)return;
  const section=el('section','production-transitions');nodeText('h3',null,'实体状态转换',section);
  for(const t of transitions){const row=el('div','production-need');productionRefLink(row,t.from);nodeText('span',null,' → ',row);productionRefLink(row,t.to);nodeText('p',null,t.action,row);productionRefLink(row,t.source,'查看转换依据');section.append(row)}
  root.append(section);
}
function productionCommentLocationIssue(comment,row){
  if(comment.anchor_state?.valid===false)return comment.anchor_state.reason||'原圈选已失效；评论仍保留。';
  if(!row||row.id!==comment.target_revision_id||row.object_id!==comment.target_object_id)return '评论所属的准确修订不可用；未打开其他版本。';
  const a=comment.anchor;
  if(!['time','visual','region'].includes(a.type))return null;
  const component=row.payload.components?.find(c=>c.id===(a.component_id||a.visual_id));
  if(!component||!component.file||typeof component.mime!=='string'||component.file!==a.asset_file)return '评论所属的原文件组成不可用；未替换为预览或其他文件。';
  if(a.type==='time'&&(!/^(audio|video)\//.test(component.mime)||!Number.isFinite(a.start_seconds)||!Number.isFinite(a.end_seconds)||a.start_seconds<0||a.start_seconds>=a.end_seconds||Number.isFinite(component.duration_seconds)&&a.end_seconds>component.duration_seconds))return '原评论的时间范围已不可用；未改写圈选。';
  if(a.type!=='time'&&!component.mime.startsWith('image/'))return '原评论的图像组成不可用；评论仍保留。';
  return null;
}
function locateProductionComment(comment,local=false){
  if(comment.original_context?.matches_current===false){const row=[state.productionSelected,...(state.productionRecords||[])].find(r=>r?.object_id===comment.target_object_id)||{object_id:comment.target_object_id,payload:{title:comment.original_context.excerpt.title}};return openProductionCommentOriginal(row,comment);}
  if(typeof locateMaterialRelationComment==='function'&&locateMaterialRelationComment(comment))return;
  if(!local&&typeof isEntityReview==='function'&&isEntityReview())return locateEntityReviewComment(comment);
  if(!local&&typeof isMaterialReview==='function'&&isMaterialReview())return locateMaterialComment(comment);
  const issue=productionCommentLocationIssue(comment,state.productionSelected);if(issue){toast(issue);return false}
  if((comment.anchor.type||'text')==='text'&&!productionCommentTextSurface(comment))return openProductionCommentOriginal(state.productionSelected,comment);
  state.selected=comment.id;const a=comment.anchor,select=$('#production-component'),component=a.component_id||a.visual_id;
  // A merged display never migrates the original field. Reveal its exact text
  // in the same immutable shot before the shared locator and paint run.
  if((a.type||'text')==='text'){
    const surface=productionCommentTextSurface(comment),node=surface&&productionCommentTextNodes(productionCommentTextRange(comment),surface)[0];
    for(let parent=node?.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;
  }
  if(select&&component&&select.value!==component){select.value=component;select.onchange()}
  // Component ids can repeat across state references and unassigned candidates.
  // Locate the exact asset revision before looking up its image or player.
  const root=state.unifiedCardRoot||$('#production-reader'),exact=`[data-review-revision="${CSS.escape(comment.target_revision_id)}"]`,file=`[data-review-file="${CSS.escape(a.asset_file||'')}"]`;
  if(a.type==='time'){
    const player=[...root?.querySelectorAll('.review-media-player'+exact+file)||[]].find(p=>Number(p.dataset.reviewFrom)<=a.start_seconds&&a.end_seconds<=Number(p.dataset.reviewTo));
    if(!player?.reviewLocate){toast('原文件或圈选范围当前无法显示；评论仍保留。');return false}
    if(player.reviewLocate(a)===false){toast('原文件或圈选范围当前无法显示；评论仍保留。');return false}
  }
  paintProductionReview();
  if(a.type!=='time'){const surface=a.block_id?productionCommentTextSurface(comment):null,target=a.block_id?(surface?.querySelector('.comment-mark.selected')||productionCommentTextNode(a)):a.visual_id?root?.querySelector(exact+' '+file+` [data-visual-id="${CSS.escape(a.visual_id)}"]`):root;if(!target){toast('原圈选当前无法显示；评论仍保留。');return false}target.scrollIntoView({block:'center'})}
  renderComments();
  return true;
}
function showProductionCompare(root){const box=el('section');nodeText('h3',null,'同一素材的候选比较',box);const columns=el('div','production-compare');for(let i=0;i<2;i++){const col=el('div'),select=el('select');select.setAttribute('aria-label',`比较版本 ${i+1}`);for(const r of state.productionDetail.history)select.append(new Option(`版本 ${r.version}`,r.id));select.selectedIndex=Math.min(i,select.options.length-1);const pane=el('div');const draw=()=>{pane.replaceChildren();const r=state.productionDetail.history.find(r=>r.id===select.value);productionMedia(pane,r.payload.components.find(c=>c.role==='original'),false)};select.onchange=draw;col.append(select,pane);columns.append(col);draw()}box.append(columns);root.append(box);box.scrollIntoView({block:'center'})}
async function renderProductionReadiness(root,r,options={}){
  const readEpoch=productionReadEpoch;
  const isCurrent=options.isCurrent||(()=>state.productionSelected?.id===r.id&&productionReadEpoch===readEpoch&&root.isConnected);
  const data=await api('/api/production/readiness?scope='+encodeURIComponent(r.object_id));if(!isCurrent()||options.replaceSection&&!options.replaceSection.isConnected||options.canReplace&&!options.canReplace())return;
  const section=el('section','production-readiness');section.setAttribute('aria-label','素材缺项检查');
  if(options.title)nodeText('h3',null,reviewPositionText(options.title),section);
  nodeText('h3',null,`必要输入：${data.required_count} 项，缺项 ${data.missing_count} 项`,section);
  nodeText('p',null,data.inputs_ready?'必要输入齐备。':'必要槽位尚未全部就绪。',section);
  if(data.state_coverage){
    nodeText('p','production-meta',r.kind==='STATE'?'检查此实体状态的整体与补充参考。':`实体状态：检查 ${data.state_coverage.checked_count} 次实体使用，引用 ${data.state_coverage.states.length} 个准确状态版本。`,section);
    if(data.state_coverage.issues.length){const issues=el('section');nodeText('h4','production-issue',`状态覆盖缺项 ${data.state_coverage.issues.length} 项`,issues);for(const issue of data.state_coverage.issues){const row=el('div','production-need');nodeText('p',null,({missing_complete_state:'此实体尚未关联实体状态',legacy_partial_state:'仍在使用历史局部状态',state_owner_mismatch:'状态属于其他实体',mention_state_used_for_presentation:'仅提及状态被用于实际呈现',missing_or_unmatched_state_transition:'状态转换与顺序未交代完整',invalid_state_transition:'状态转换缺少本场／本镜准确依据',missing_overall_reference_requirement:'缺少该准确状态的整体参考需求',redundant_consecutive_state:'连续重复了同一状态'})[issue.code]||issue.code,row);if(issue.entity)nodeText('p',null,productionName({object_id:issue.entity}),row);if(issue.state)productionRefLink(row,issue.state);if(issue.scope)productionRefLink(row,issue.scope);issues.append(row)}section.append(issues)}
  }
  const actions=el('div','production-toolbar');section.append(actions);
  if(options.close)productionButton(actions,'收起缺项检查',options.close);
  const cards=el('div'),pagination=el('div','production-toolbar');section.append(pagination,cards);
  const pageSize=20;let page=Math.min(Math.max(0,options.page||0),Math.max(0,Math.ceil(data.requirements.length/pageSize)-1));
  const drawPage=()=>{
    cards.replaceChildren();pagination.replaceChildren();
    if(data.requirements.length>pageSize){
      const previous=productionButton(pagination,'上一页',()=>{page--;drawPage()});previous.disabled=page===0;
      nodeText('span','production-meta',`第 ${page*pageSize+1}–${Math.min((page+1)*pageSize,data.requirements.length)} 项 / 共 ${data.requirements.length} 项`,pagination);
      const next=productionButton(pagination,'下一页',()=>{page++;drawPage()});next.disabled=(page+1)*pageSize>=data.requirements.length;
    }
  for(const row of data.requirements.slice(page*pageSize,(page+1)*pageSize)){const p=row.requirement.payload,card=el('div','production-need');nodeText('strong',null,reviewPositionText(p.title),card);nodeText('p',null,`${p.purpose} · ${productionLabels[p.usage]} · ${p.required?'必需':'可选'}`,card);if(row.adoption)productionRefLink(card,{...row.adoption.payload.asset,...Object.fromEntries(['component_id','crop','range'].filter(k=>row.adoption.payload[k]).map(k=>[k,row.adoption.payload[k]]))},`已采用：${row.asset?.payload.title||'素材'} · 版本 ${row.asset?materialRecordRound(row.asset)||1:'未知'}`);for(const issue of row.issues.filter(issue=>!(data.package_issue?.revision_id===row.asset?.id&&data.package_issue?.component_id===row.adoption?.payload.component_id&&data.package_issue?.reason===issue)))nodeText('span','production-pill production-issue',({missing_adoption:'尚未采用',scope_revision_changed:'使用位置已修订',placeholder_is_not_ready:'占位素材',missing_entity_reference:'素材未标明所需实体',missing_state_reference:'素材未覆盖所需状态',missing_exact_state_coverage:'素材的确切状态、整体／细节角色或范围不匹配',below_minimum_long_edge:'实际长边像素不足',native_4k_not_verified:'原生 4K 尚未核实',below_minimum_width:'实际宽度不足',below_minimum_height:'实际高度不足',below_minimum_sample_rate:'采样率不足',below_minimum_channels:'声道数不足',incompatible_media_or_usage:'媒体类型或用途不匹配'}[issue]||issue),card);productionButton(card,row.adoption?'显式换版':'选择素材版本',()=>showProductionAdoption(card,row));cards.append(card)}
  };
  drawPage();
  const scopeKind=data.scope?.kind||r.kind;
  const label=scopeKind==='STATE'?'下载状态参考清单':scopeKind==='AV_SHOT'?'下载逐镜输入清单':scopeKind==='EPISODE'?'下载本集输入清单':'下载本场输入清单';
  const button=productionButton(actions,label,async()=>{const value=await api('/api/production/package?scope='+encodeURIComponent(r.object_id));const a=el('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));a.download=r.object_id+'-manifest.json';a.click();URL.revokeObjectURL(a.href);toast('清单已下载；包含原件的目录包可由 production-package 命令导出')});button.disabled=!data.inputs_ready||data.package_available===false;
  if(data.inputs_ready&&data.package_available===false&&data.package_issue){
    const issue=data.package_issue,reason=({'missing media or byte size mismatch':'文件缺失或大小不符','media checksum mismatch':'文件校验失败，原件可能已损坏','media changed during verification':'文件在检查期间发生变化，请重新检查','invalid production filename':'文件引用无效','managed media cannot be a symlink':'原件必须是实际文件','managed media directory cannot be a symlink':'原件目录必须是实际目录'})[issue.reason]||'文件或准确依赖无法校验，请核对原件';
    const target=issue.title?`「${reviewPositionText(issue.title)}」${issue.component_id?`的 ${issue.component_id} 组成`:''}：`:'';
    nodeText('small','production-issue',`暂不能下载完整清单：${target}${reason}。`,actions);
    if(issue.object_id&&issue.revision_id&&!data.requirements.some(row=>row.adoption?.payload.asset.revision_id===issue.revision_id&&row.adoption?.payload.component_id===issue.component_id))productionRefLink(actions,{object_id:issue.object_id,revision_id:issue.revision_id,component_id:issue.component_id},'查看所引用的原件');
  }
  if(options.replaceSection)options.replaceSection.replaceWith(section);else{if(options.replace)root.replaceChildren();root.append(section)}
}
function showProductionAdoption(parent,row){
  const p=row.requirement.payload,box=el('div','production-editor'),assets=el('select'),versions=el('select'),components=el('select');assets.setAttribute('aria-label','选择素材');versions.setAttribute('aria-label','候选记录修订');components.setAttribute('aria-label','采用文件组成');
  const workspace=state.workspace,loadEpoch=productionLoadEpoch,readEpoch=productionReadEpoch;
  let history=[],requestEpoch=0,closed=false,loading=false,loadingAssets=row.candidates==null,saving=false,confirm,pendingRequest=null;
  const isOpen=()=>!closed&&box.isConnected&&state.workspace===workspace&&productionLoadEpoch===loadEpoch&&productionReadEpoch===readEpoch;
  const renderAssets=records=>{
    if(!Array.isArray(records))throw Error('素材列表暂无法读取，请关闭后重试');
    const items=[...new Map(records.filter(r=>r.kind==='ASSET'&&r.payload.media_type===p.media_type).map(r=>[r.object_id,r])).values()];
    assets.replaceChildren(new Option(items.length?'选择一个实际素材':'暂无这种类型的实际素材',''));
    for(const item of items)assets.append(new Option(reviewPositionText(item.payload.title),item.object_id));
  };
  if(loadingAssets)assets.append(new Option('正在读取可用素材…',''));else renderAssets(row.candidates);
  const selectedAsset=()=>history.find(r=>r.object_id===assets.value&&r.id===versions.value);
  const updateControls=()=>{const asset=selectedAsset();assets.disabled=loadingAssets||saving;versions.disabled=loadingAssets||loading||saving||!history.length;components.disabled=loadingAssets||loading||saving||!asset;confirm.disabled=loadingAssets||loading||saving||!asset?.payload.components.some(c=>c.id===components.value);for(const input of [reason,start,end,...Object.values(cropFields)])input.disabled=saving};
  const ordered=value=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])])):value;
  const samePayload=(left,right)=>JSON.stringify(ordered(left))===JSON.stringify(ordered(right));
  const readAttempt=async request=>{
    const result=await api('/api/production?kind=RELATION');
    if(!Array.isArray(result.records))throw Error('采用结果暂无法核实，请重试核对');
    const current=result.records.find(r=>r.object_id===request.object_id);
    const other=result.records.find(r=>r.object_id!==request.object_id&&r.payload.relation_type==='adoption'&&r.payload.scope.object_id===request.payload.scope.object_id&&r.payload.slot===request.payload.slot);
    if(!other&&current?.version===request.expected_version+1&&samePayload(current.payload,request.payload))return 'saved';
    if(other||current&&current.version!==request.expected_version||!current&&request.expected_version!==0)return 'changed';
    return 'unchanged';
  };
  const changed=()=>Error('采用已变化，未覆盖现有判断。请刷新并核对当前采用后再操作');
  const renderComponents=()=>{components.replaceChildren();const entries=selectedAsset()?.payload.components||[];for(const c of entries){const label=({original:'原件',preview:'预览',thumbnail:'缩略图',metadata:'说明文件'})[c.role]||'文件',peers=entries.filter(v=>v.role===c.role);components.append(new Option(label+(peers.length>1?' '+(peers.indexOf(c)+1):''),c.id))}updateControls()};
  assets.onchange=async()=>{
    if(!isOpen()||loadingAssets||saving)return;
    const assetId=assets.value,epoch=++requestEpoch,isCurrent=()=>isOpen()&&epoch===requestEpoch&&assets.value===assetId;
    history=[];versions.replaceChildren();components.replaceChildren();loading=!!assetId;updateControls();if(!assetId)return;
    try{const result=await api('/api/production?object_id='+encodeURIComponent(assetId));if(!isCurrent())return;
      if(!Array.isArray(result.history)||result.history.some(r=>r.object_id!==assetId))throw Error('素材版本与当前选择不一致，请重新选择');
      history=result.history;for(const r of history)versions.append(new Option(`记录修订 ${r.version}${r.id===r.current_revision?' · 当前':''}`,r.id));renderComponents();
    }catch(error){if(isCurrent())toast(error.message)}finally{if(isCurrent()){loading=false;updateControls()}}
  };
  versions.onchange=renderComponents;components.onchange=updateControls;box.append(assets,versions,components);
  const reason=el('input');reason.placeholder='采用或换版理由';reason.setAttribute('aria-label','采用理由');box.append(reason);const start=el('input'),end=el('input');for(const [input,label] of [[start,'入点秒（可选）'],[end,'出点秒（可选）']]){input.type='number';input.step='.01';input.min='0';input.placeholder=label;input.setAttribute('aria-label',label);box.append(input)}
  const cropFields={};if(p.media_type==='image'||p.media_type==='video'){nodeText('p',null,'局部采用可填写裁切比例：左上角为 0,0，整张图为宽 1、高 1。留空采用完整画面。',box);for(const [key,label] of Object.entries({x:'裁切左边比例',y:'裁切上边比例',width:'裁切宽度比例',height:'裁切高度比例'})){const input=el('input');input.type='number';input.min='0';input.max='1';input.step='.01';input.placeholder=label;input.setAttribute('aria-label',label);cropFields[key]=input;box.append(input)}}
  confirm=productionButton(box,'确认采用所选文件',async()=>{
    if(!isOpen()||loadingAssets||loading||saving)return;
    const asset=selectedAsset();if(!asset||!asset.payload.components.some(c=>c.id===components.value)||!reason.value.trim())throw Error('请选择确切素材版本和文件组成并填写理由');
    const payload={format:'production-relation-v1',title:p.title+' · 采用',blocks:[{id:'adoption',text:reason.value}],relation_type:'adoption',scope:p.scope,slot:p.slot,asset:productionRef(asset),component_id:components.value,usage:p.usage,reason:reason.value};if(start.value!==''||end.value!=='')payload.range={start_seconds:Number(start.value),end_seconds:Number(end.value)};if(Object.values(cropFields).some(input=>input.value!=='')){if(Object.values(cropFields).some(input=>input.value===''))throw Error('裁切需同时填写左、上、宽、高四项');payload.crop=Object.fromEntries(Object.entries(cropFields).map(([key,input])=>[key,Number(input.value)]))}
    saving=true;updateControls();
    try{
      let saved=false;
      if(pendingRequest){
        const status=await readAttempt(pendingRequest);if(!isOpen())return;
        if(status==='changed')throw changed();
        if(status==='saved'){
          if(!samePayload(payload,pendingRequest.payload))throw Error('上次采用已保存；当前修改尚未提交，请保留输入并刷新核对');
          saved=true;
        }
      }
      if(!saved){
        // Keep the exact wire payload and id until an uncertain write is resolved.
        if(!pendingRequest||!samePayload(payload,pendingRequest.payload))pendingRequest=JSON.parse(JSON.stringify({object_id:row.adoption?.object_id||'adoption-'+crypto.randomUUID(),expected_version:row.adoption?.version||0,payload}));
        try{await api('/api/production/adopt',{method:'POST',body:JSON.stringify(pendingRequest)})}
        catch(error){
          if(!isOpen())return;
          let status;try{status=await readAttempt(pendingRequest)}catch(readError){throw Error(`${error.message}；采用结果暂无法核实，请重试核对`)}
          if(!isOpen())return;
          if(status==='changed')throw changed();
          if(status!=='saved')throw error;
        }
      }
      if(!isOpen())return;pendingRequest=null;toast('精确采用已保存');await loadProductionWorkspace();
    }
    catch(error){if(isOpen())throw error}finally{saving=false;if(isOpen())updateControls()}
  });
  productionButton(box,'取消',()=>{closed=true;++requestEpoch;box.remove()});parent.append(box);updateControls();
  if(loadingAssets)(async()=>{
    try{
      // Read the complete current
      // inventory only when choosing an adoption; exact revisions load below.
      const result=await api('/api/production?kind=ASSET');if(!isOpen())return;
      renderAssets(result.records);
    }catch(error){if(isOpen()){assets.replaceChildren(new Option('素材读取失败，请关闭后重试',''));toast(error.message)}}
    finally{if(isOpen()){loadingAssets=false;updateControls()}}
  })();
}

function currentReviewWork(){
  if(state.unifiedCardRoot)return state.reviewWork?.reference||null;
  const params=new URL(location.href).searchParams;
  if(state.workspace==='settings.workspace'&&productionTab()==='breakdown'&&state.breakdownSceneData?.scene)return productionRef(state.breakdownSceneData.scene);
  const episode=params.get('production_scope_episode'),revision=params.get('production_scope_revision');
  return episode&&revision?{object_id:episode,revision_id:revision,scene_id:params.get('production_scope_scene')||undefined}:null;
}
function reviewWorkMatches(row,work=state.reviewWork){
  if(!work)return true;
  const refs=[row?.payload?.scope,row?.payload?.context,row&&productionRef(row)].filter(Boolean);
  if(refs.some(ref=>work.positions.some(p=>p.object_id===ref.object_id&&p.revision_id===ref.revision_id)))return true;
  if(['AV_SCENE','AV_SHOT','AV_EPISODE'].includes(row?.kind)||refs.some(ref=>work.positions.some(p=>p.object_id===ref.object_id)))return false;
  return [...(row?.payload?.sources||[]),...(row?.payload?.applies_to||[])].some(ref=>work.sources.some(s=>s.object_id===ref.object_id&&s.revision_id===ref.revision_id&&(!s.scene_id||s.scene_id===ref.scene_id)));
}
