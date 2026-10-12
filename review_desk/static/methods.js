/* Working methods live in the existing configuration workspace. */
const methodWorkLabels={'comment-polish':'评论清晰表达','media-plan':'媒体方案','novel-writing':'小说写作','reader-review':'独立读者','audiovisual-design':'视听设计','creative-system-review':'创作协作 Review','story-structure':'故事结构','screenplay-writing':'剧本写作','material-judgment':'素材判断','material-assessment':'素材判断','generation-preparation':'生成准备','generation-preflight':'生成准备','result-review':'结果检查与返修','text-layer':'文字制作'};
const methodTabs=[['skill','方法'],['resource','共用资料'],['binding','工作环节']];
const methodBusinesses=[['all','全部'],['story','故事创作'],['production','生产制作'],['collaboration','协作辅助'],['other','其他']];
const methodWorkOrder=['story-structure','novel-writing','screenplay-writing','reader-review','audiovisual-design','material-assessment','material-judgment','media-plan','text-layer','generation-preflight','generation-preparation','result-review','comment-polish','creative-system-review'];
const methodWorkBusiness=Object.fromEntries(methodWorkOrder.map((key,i)=>[key,i<4?'story':i<12?'production':'collaboration']));
let methodView = {category:'skill', selected:null, data:null, draft:null, mode:'read', memories:{}, positions:{}, stack:[], filters:{}, configurationDrafts:{}};
function methodGroups(record,category,data=methodView.data){
  if(category==='resource'){
    const paths=Object.values(record.payload.source?.files||{}).map(f=>f.path).join(' '),id=record.object_id;
    return [paths.includes('filmcraft/')?'filmcraft':paths.includes('seedance-video-handbook')?'video':paths.includes('creative-system-review/')?'review':id.includes('reader')?'reader':id.includes('continuity')?'continuity':'other'];
  }
  const types=category==='binding'?[record.payload.work_type]:data.binding.filter(b=>b.payload.rules.some(r=>r.object_id===record.object_id)).map(b=>b.payload.work_type);
  if(!types.length)types.push(...record.payload.work_types||[]);
  return [...new Set(types.map(t=>methodWorkBusiness[t]||'other'))].length?[...new Set(types.map(t=>methodWorkBusiness[t]||'other'))]:['other'];
}
function methodOrder(record,category,data=methodView.data){
  const types=category==='binding'?[record.payload.work_type]:data.binding.filter(b=>b.payload.rules.some(r=>r.object_id===record.object_id)).map(b=>b.payload.work_type);
  if(!types.length)types.push(...record.payload.work_types||[]);
  return Math.min(...types.map(t=>{const i=methodWorkOrder.indexOf(t);return i<0?methodWorkOrder.length:i}),methodWorkOrder.length);
}
function methodTitle(record){return record.payload.work_types?.includes('result-review')?'结果检查与返修':record.payload.title||methodWorkLabels[record.payload.work_type]||record.payload.work_type;}
function methodPurpose(record){return record.payload.work_types?.includes('generation-preflight')?'核对当前媒体方案、准确输入与本次授权，形成准备包或具体缺项。':record.payload.purpose;}
function methodFilter(category=methodView.category){return methodView.filters[category]||={group:'all',range:'active',fileType:'all'};}
function methodRows(category=methodView.category,data=methodView.data){
  const filter=methodFilter(category),active=new Set(data.binding.flatMap(b=>b.payload.rules.map(r=>r.object_id)));
  return (data[category]||[]).filter(r=>(category!=='skill'||filter.range==='all'||active.has(r.object_id))&&(filter.group==='all'||methodGroups(r,category,data).includes(filter.group))).sort((a,b)=>methodOrder(a,category,data)-methodOrder(b,category,data)||methodTitle(a).localeCompare(methodTitle(b),'zh'));
}
function methodDefaultRevision(record,category=methodView.category){const scope=category==='skill'?methodScopes(record.object_id)[0]:null;return scope?scope.binding.payload.rules[scope.index].revision_id:record.revision_id;}
function methodReveal(record,category){const filter=methodFilter(category);if(category==='skill'&&!methodScopes(record.object_id).length)filter.range='all';if(filter.group!=='all'&&!methodGroups(record,category).includes(filter.group))filter.group='all';}
function methodChoiceRow(parent,label,items,value,onChange){
  const row=el('div','method-choices');row.setAttribute('role','group');row.setAttribute('aria-label',label);parent.append(row);
  for(const [key,title] of items){const b=methodButton(row,title,()=>onChange(key));b.setAttribute('aria-pressed',String(key===value));b.classList.toggle('active',key===value)}return row;
}
function methodPage(root){
  root.replaceChildren();const page=el('article','config-page methods-page');root.append(page);methodView.page=page;methodView.root=root;
  const tabs=el('nav','method-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','工作方法子页面');page.append(tabs);
  for(const [key,label] of methodTabs){
    const activate=()=>{const mem=methodView.memories[key]||{};methodOpen(root,key,mem.selected||null,mem.revision||null,mem.file||null);root.querySelector('#method-tab-'+key)?.focus()};
    const b=methodButton(tabs,label,activate);b.id='method-tab-'+key;b.setAttribute('role','tab');b.setAttribute('aria-selected',String(key===methodView.category));b.setAttribute('aria-controls','method-panel-'+key);b.tabIndex=key===methodView.category?0:-1;
    b.onkeydown=e=>{const i=methodTabs.findIndex(t=>t[0]===key),next=e.key==='ArrowRight'?(i+1)%3:e.key==='ArrowLeft'?(i+2)%3:e.key==='Home'?0:e.key==='End'?2:null;if(next===null)return;e.preventDefault();const k=methodTabs[next][0],m=methodView.memories[k]||{};methodOpen(root,k,m.selected||null,m.revision||null,m.file||null);root.querySelector('#method-tab-'+k)?.focus()};
  }
  const panel=el('section','method-tab-panel');panel.id='method-panel-'+methodView.category;panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby','method-tab-'+methodView.category);page.append(panel);return panel;
}
function methodBrowse(panel,root){
  const category=methodView.category,filter=methodFilter(category),groups=category==='resource'?[['all','全部'],['continuity','连续性'],['filmcraft','影视知识'],['video','视频手册'],['reader','独立读者'],['review','系统 Review'],['other','其他']]:methodBusinesses;
  const change=(key,value)=>{filter[key]=value;methodOpen(root,category,null,null,null)};
  methodChoiceRow(panel,'业务分类',groups.filter(([key])=>key==='all'||key!=='other'||(methodView.data[category]||[]).some(r=>methodGroups(r,category).includes(key))),filter.group,value=>change('group',value));
  if(category==='skill')methodChoiceRow(panel,'方法范围',[['active','正在使用'],['all','全部方法']],filter.range,value=>change('range',value));
  const layout=el('div','method-browse-layout'),directory=el('nav','method-catalog');directory.setAttribute('aria-label',methodTabs.find(t=>t[0]===category)[1]+'目录');layout.append(directory);
  const rows=methodRows();for(const record of rows){const b=methodButton(directory,methodTitle(record),()=>methodOpen(root,category,record.object_id,methodDefaultRevision(record,category),null));b.classList.toggle('active',record.object_id===methodView.selected);b.setAttribute('aria-current',record.object_id===methodView.selected?'true':'false');if(methodPurpose(record))nodeText('small',null,methodPurpose(record),b)}
  if(!rows.length)nodeText('p','config-explanation','此范围没有现有项。',directory);
  const content=el('div','method-content');layout.append(content);panel.append(layout);return content;
}
function methodVersions(parent,record,root){
  const versions=methodView.data.versions?.[record.object_id]||[record],current=methodView.data[methodView.category].find(r=>r.object_id===record.object_id),used=new Set(methodScopes(record.object_id).map(s=>s.binding.payload.rules[s.index].revision_id));
  methodChoiceRow(parent,'正文版本',versions.map(r=>[r.revision_id,'第 '+r.version+' 版'+(used.has(r.revision_id)?' · 正在使用':r.revision_id===current?.revision_id?' · 最新正文':'')]),record.revision_id,rid=>methodOpen(root,methodView.category,record.object_id,rid,methodView.file));
}
async function renderMethods(root){
  if(methodView.draft&&methodView.page){root.replaceChildren(methodView.page);return}
  if(root.methodLoading)return;
  root.methodLoading=true;
  try{methodView.data=await api('/api/methods');if(state.workspace!=='project.configuration'||state.configSection!=='METHODS')return;drawMethods(root)}
  catch(error){root.replaceChildren();nodeText('p','production-issue',error.message,root)}
  finally{root.methodLoading=false}
}
function drawMethodConfiguration(root){
  if(typeof rememberStoryDraft==='function')rememberStoryDraft();++methodReadEpoch;methodView.document=null;state.anchor=null;state.editing=null;state.selected=null;renderComments();
  const category=methodView.category,key=JSON.stringify([category,methodView.selected]),cached=methodView.configurationDrafts[key];
  if(cached){root.replaceChildren(cached.page);methodView.page=cached.page;methodView.leaveCurrent=cached.leave;methodView.draft=true;return}
  const panel=methodPage(root),page=methodBrowse(panel,root),outer=methodView.page;
  const record=methodView.record?.object_id===methodView.selected&&methodView.record.revision_id===methodView.revision?methodView.record:methodView.data[category].find(r=>r.object_id===methodView.selected),p=record?.payload||{};
  nodeText('h2',null,record?'编辑 '+methodTitle(record):'新建'+methodTabs.find(t=>t[0]===category)[1],page);
  methodButton(page,'返回阅读，保留配置修改',()=>methodOpen(root,category,methodView.selected,methodView.revision,methodView.file));
  const leave=()=>{if(methodView.draft)methodView.configurationDrafts[key]={page:outer,leave}};methodView.leaveCurrent=leave;
  const form=el('form','config-form');page.append(form);const fields={};
  function field(key,label,value='',multiline=false){const row=el('label','config-field');row.append(el('span',null,label));const input=el(multiline?'textarea':'input');input.value=value;input.name=key;if(multiline)input.rows=key==='body'?16:3;row.append(input);form.append(row);fields[key]=input;return input}
  const name=field('name',category==='binding'?'工作类型标识':'稳定标识',record?.object_id.split('.').slice(2).join('.')||'');name.required=true;name.disabled=!!record;
  if(category!=='binding')field('title','名称',p.title||'').required=true;
  if(category==='skill'){
    for(const [key,label] of [['purpose','用途'],['applies','适用条件'],['inputs','需要的输入'],['outputs','交付产物'],['checks','检查要求']])field(key,label,p[key]||'',true).required=true;
    field('work_types','适用工作类型（逗号分隔）',(p.work_types||[]).join(', '));
    field('required_inputs','必要输入字段（逗号分隔）',(p.required_inputs||[]).join(', '));
    field('steps','必要步骤（按顺序，逗号分隔）',(p.steps||['result']).join(', '));
  }
  const fileValues={...(p.files||{})};
  if(category==='skill'&&!fileValues['SKILL.md'])fileValues['SKILL.md']='---\nname: working-method\ndescription: 说明此方法完成什么工作及何时使用\n---\n\n';
  if(category==='resource'&&!Object.keys(fileValues).length)fileValues['references/main.md']='';
  const fileEditors={};
  if(category!=='binding'){
    const container=el('section','method-files');form.append(container);
    function addFile(path,body){const row=el('div','config-field');row.append(el('span',null,path));const input=el('textarea');input.rows=path==='SKILL.md'?18:10;input.value=body;input.setAttribute('aria-label',path);row.append(input);container.append(row);fileEditors[path]=input;if(path!=='SKILL.md'){const remove=el('button',null,'移除 '+path);remove.type='button';remove.onclick=()=>{delete fileEditors[path];row.remove();methodView.draft=true};row.append(remove)}}
    for(const [path,body] of Object.entries(fileValues))addFile(path,body);
    const path=el('input');path.placeholder='references/example.md';path.setAttribute('aria-label','新增包内文件路径');container.append(path);
    const add=el('button',null,'添加文件');add.type='button';add.onclick=()=>{if(path.value&&!fileEditors[path.value]){addFile(path.value,'');path.value='';methodView.draft=true}};container.append(add);
  }
  if(category==='resource')field('sections','章节标识 = 包内文件（每行一个）',Object.entries(p.sections||{'main':'references/main.md'}).map(([k,v])=>`${k} = ${v}`).join('\n'),true);
  const references=[];
  const conditionTexts=record?.condition_texts||methodView.data.condition_texts?.[record?.revision_id]||[];
  function conditionEditor(input,original,index){
    const originalText=conditionTexts[index]??(original?.when===undefined?'':JSON.stringify(original.when));
    input.value=originalText;
    input.placeholder='例如 {"need_staging":true} 或 media_type=video';
    return ()=>input.value===originalText&&original?.when===undefined?null:input.value;
  }
  if(category==='skill'){
    const resourceGroup=el('section','method-resources');form.append(resourceGroup);
    nodeText('h3',null,'共用章节',resourceGroup);
    nodeText('p','config-explanation','加载条件：true / false 是布尔值，"true" / "false" 是文本；条件为空时总是加载。多个字段、数组或对象可写成 JSON 对象。',resourceGroup);
    // Render selected references first, in their saved order. Each exact
    // reference keeps its own row, even when sections repeat or versions differ.
    const selected=p.resources||[];
    const rows=selected.map((exact,index)=>({exact,index,resource:methodView.data.resource.find(r=>r.object_id===exact.object_id&&r.payload.sections[exact.section])||methodView.data.referenced[exact.revision_id],section:exact.section}));
    for(const resource of methodView.data.resource)for(const section of Object.keys(resource.payload.sections)){
      if(!selected.some(r=>r.object_id===resource.object_id&&r.section===section))rows.push({resource,section});
    }
    for(const {exact,index,resource,section} of rows){
      const resourceRow=el('div','method-resource-row');resourceGroup.append(resourceRow);
      const row=el('label','config-choice'),enabled=el('input');enabled.type='checkbox';enabled.checked=!!exact;
      const frozen=exact&&methodView.data.referenced[exact.revision_id];
      row.append(enabled,el('span',null,`${resource.payload.title} / ${section} · 第 ${frozen?.version||resource.version} 版`));
      const condition=el('input');condition.setAttribute('aria-label',`${resource.payload.title} ${section} 的加载条件`);const getCondition=conditionEditor(condition,exact,index);resourceRow.append(row,condition);condition.disabled=!enabled.checked;enabled.onchange=()=>{condition.disabled=!enabled.checked};
      const update=el('input');update.type='checkbox';update.checked=!exact||exact.revision_id===resource.revision_id;
      if(exact&&exact.revision_id!==resource.revision_id){const updateLabel=el('label');updateLabel.append(update,document.createTextNode(`改用第 ${resource.version} 版（未选则保留第 ${frozen?.version} 版）`));resourceRow.append(updateLabel)}
      references.push(()=>enabled.checked?{ref:{...exact,object_id:resource.object_id,revision_id:update.checked?resource.revision_id:exact.revision_id,section},text:getCondition()}:null);
    }
  }
  const rules=[];
  if(category==='binding'){
    nodeText('p','config-explanation','选择本环节的新工作使用的方法。已有执行继续取得原准确版本。条件为空表示默认；更具体的匹配优先。true / false 是布尔值，"true" / "false" 是文本。',form);
    const group=el('div','method-rules');form.append(group);
    function ruleEditor(rule={},index){const row=el('div','config-field');const conditions=el('input');conditions.setAttribute('aria-label','方法选择条件');const getCondition=conditionEditor(conditions,rule,index);
      const choice=el('div','method-rule-choice');let selected=rule.object_id||'',revision=rule.revision_id||'';
      const candidates=methodView.data.skill.filter(m=>!p.work_type||(m.payload.work_types||[]).includes(p.work_type)||m.object_id===selected);
      const drawChoice=()=>{choice.replaceChildren();methodChoiceRow(choice,'执行方法',candidates.map(m=>[m.object_id,methodTitle(m)]),selected,id=>{selected=id;const m=candidates.find(r=>r.object_id===id);revision=methodDefaultRevision(m,'skill');methodView.draft=true;drawChoice()});if(selected){const versions=methodView.data.versions?.[selected]||[methodView.data.referenced[revision]||candidates.find(m=>m.object_id===selected)];methodChoiceRow(choice,'执行方法版本',versions.map(m=>[m.revision_id,'第 '+m.version+' 版']),revision,id=>{revision=id;methodView.draft=true;drawChoice()})}};drawChoice();
      row.append(conditions,choice);group.append(row);const getRule=()=>{if(!selected||!revision)throw Error('请选择执行方法版本');return {ref:{...rule,object_id:selected,revision_id:revision},text:getCondition()??''}};rules.push(getRule);const remove=el('button',null,'移除此条件');remove.type='button';remove.onclick=()=>{rules.splice(rules.indexOf(getRule),1);row.remove();methodView.draft=true};row.append(remove);}
    (p.rules||[{}]).forEach((rule,index)=>ruleEditor(rule,index));
    const add=el('button',null,'增加条件选择');add.type='button';add.onclick=()=>{ruleEditor();methodView.draft=true};form.append(add);
  }
  const notice=nodeText('p','config-save-status','',form);notice.setAttribute('role','status');
  const submit=el('button','primary','保存新版本');submit.type='submit';form.append(submit);
  if(p.source){nodeText('p','config-explanation','正文由以下项目 Markdown 维护，同步后形成可恢复的准确版本：'+[...new Set(Object.values(p.source.files).map(s=>s.path))].join('、'),form);for(const input of form.querySelectorAll('input,textarea,button'))input.disabled=true;}
  form.oninput=()=>{methodView.draft=true};
  form.onsubmit=async event=>{event.preventDefault();submit.disabled=true;try{
    let payload,condition_texts;
    if(category==='binding'){const selected=rules.map(r=>r());payload={...p,work_type:name.value.trim(),rules:selected.map(r=>r.ref)};condition_texts=selected.map(r=>r.text)}
    else{payload={...p,title:fields.title.value,files:Object.fromEntries(Object.entries(fileEditors).map(([k,v])=>[k,v.value]))};
      if(category==='resource')payload.sections=Object.fromEntries(fields.sections.value.split('\n').filter(v=>v.trim()).map(line=>{const i=line.indexOf('=');if(i<1)throw Error('章节请使用 标识 = 文件');return [line.slice(0,i).trim(),line.slice(i+1).trim()]}));
      else{for(const key of ['purpose','applies','inputs','outputs','checks'])payload[key]=fields[key].value;for(const key of ['work_types','required_inputs','steps'])payload[key]=fields[key].value.split(/[,，]/).map(v=>v.trim()).filter(Boolean);const selected=references.map(r=>r()).filter(Boolean);payload.resources=selected.map(r=>r.ref);condition_texts=selected.map(r=>r.text);}
    }
    const result=await api('/api/methods/save',{method:'POST',body:JSON.stringify({category,name:name.value.trim(),expected_version:record?.version||0,payload,...(condition_texts!==undefined?{condition_texts}:{})})});
    delete methodView.configurationDrafts[key];
    if(methodView.page!==outer)return;
    methodView.selected=result.object_id;methodView.revision=result.revision_id;methodView.file=payload.files?.[methodView.file]?methodView.file:null;methodView.draft=null;methodView.leaveCurrent=null;methodView.mode='read';methodView.data=await api('/api/methods');
    if(methodView.page!==outer||state.workspace!=='project.configuration'||state.configSection!=='METHODS')return;
    drawMethods(root);nodeText('p','config-save-status',`已保存第 ${result.version} 版。`+(category==='binding'?'新工作按这些条件取得准确方法；已开始的工作保持原包。':'工作环节选择此版后，新执行会取得对应正文与共用章节。'),root);
  }catch(error){notice.textContent=error.message+'；当前输入保留。可在新页面核对已保存版本后合并修改。'}finally{submit.disabled=false}};
}

let methodReadEpoch=0;
const isMethodsReading=()=>state.workspace==='project.configuration'&&state.configSection==='METHODS'&&!!methodView.document&&methodView.mode==='read';
const methodKey=()=>JSON.stringify([methodView.category,methodView.selected,methodView.revision,methodView.file]);
const methodStorageScope=()=>JSON.stringify([typeof REVIEW_DEPLOYMENT==='undefined'?'':REVIEW_DEPLOYMENT.publication_id,state.navigationInstanceId||'']);
function rememberMethodPosition(){if(methodView.document)methodView.positions[methodKey()]=window.scrollY;try{sessionStorage.setItem('method-reading',JSON.stringify({scope:methodStorageScope(),category:methodView.category,selected:methodView.selected,revision:methodView.revision,file:methodView.file,memories:methodView.memories,positions:methodView.positions,stack:methodView.stack,filters:methodView.filters}))}catch{}}
window.addEventListener('scroll',()=>{if(isMethodsReading())rememberMethodPosition()},{passive:true});
function methodButton(parent,label,action){const b=nodeText('button',null,label,parent);b.type='button';b.onclick=action;return b}
function methodOpen(root,category,oid,rid,file,back=false){
  rememberMethodPosition();
  if(isMethodsReading()&&typeof rememberStoryDraft==='function')rememberStoryDraft();
  methodView.leaveCurrent?.();methodView.leaveCurrent=null;
  if(back)methodView.stack.push({category:methodView.category,selected:methodView.selected,revision:methodView.revision,file:methodView.file});
  methodView.memories[methodView.category]={selected:methodView.selected,revision:methodView.revision,file:methodView.file};
  methodView.category=category;methodView.selected=oid;methodView.revision=rid;methodView.file=file;methodView.mode='read';methodView.document=null;methodView.draft=null;methodRoute();state.anchor=null;state.editing=null;state.selected=null;state.reviewCommentScope=null;hideSelectionAction();return drawMethods(root);
}
function methodRoute(){const filter=methodFilter(),url=new URL(location.href);for(const [key,value] of Object.entries({method_category:methodView.category,method_object:methodView.selected,method_revision:methodView.revision,method_file:methodView.file,method_group:filter.group,method_range:filter.range,method_file_type:filter.fileType})){if(value)url.searchParams.set(key,value);else url.searchParams.delete(key)}history.replaceState(history.state,'',url)}
function methodScopeLabel(binding,index){const r=binding.payload.rules[index],values=r.when||{},keys=Object.keys(values),raw=binding.condition_texts?.[index]||methodView.data?.condition_texts?.[binding.revision_id]?.[index];const label=!keys.length?'默认':keys.length===1&&keys[0]==='media_type'?({image:'图像',audio:'音频',video:'视频'}[values.media_type]||values.media_type):(raw||JSON.stringify(values));return (methodWorkLabels[binding.payload.work_type]||binding.payload.work_type)+' · '+label;}
function methodScopes(oid){return methodView.data.binding.flatMap(b=>b.payload.rules.flatMap((r,index)=>r.object_id===oid?[{binding:b,index,label:methodScopeLabel(b,index)}]:[]));}
function methodEligibleScopes(record){return methodView.data.binding.flatMap(b=>(record.payload.work_types||[]).includes(b.payload.work_type)?b.payload.rules.map((r,index)=>({binding:b,index,label:methodScopeLabel(b,index)})):[]);}
async function drawMethods(root){
  const epoch=++methodReadEpoch;
  if(!methodView.restored){methodView.restored=true;try{const saved=JSON.parse(sessionStorage.getItem('method-reading')||'null');if(saved?.scope===methodStorageScope())Object.assign(methodView,saved)}catch{}const route=new URL(location.href).searchParams;if(route.has('method_category')||route.has('method_object')){methodView.category=route.get('method_category')||'skill';methodView.selected=route.get('method_object');methodView.revision=route.get('method_revision');methodView.file=route.get('method_file');const filter=methodFilter();for(const [key,param] of [['group','method_group'],['range','method_range'],['fileType','method_file_type']])if(route.has(param))filter[key]=route.get(param)}}
  if(!methodTabs.some(t=>t[0]===methodView.category))methodView.category='skill';
  if(methodView.mode==='configuration'){drawMethodConfiguration(root);return}
  const category=methodView.category,rows=methodView.data[category]||[];
  if(!methodView.selected)methodView.selected=methodRows()[0]?.object_id;
  let record=rows.find(r=>r.object_id===methodView.selected);if(record)methodReveal(record,category);
  if(!methodView.revision&&record)methodView.revision=methodDefaultRevision(record,category);
  methodView.document=null;methodView.prose=null;
  renderComments();
  if(methodView.rawURL){URL.revokeObjectURL(methodView.rawURL);methodView.rawURL=null;}
  const panel=methodPage(root),page=methodBrowse(panel,root),mounted=methodView.page;
  if(methodView.stack.length)methodButton(page,'返回原阅读位置',()=>{const back=methodView.stack.pop();methodOpen(root,back.category,back.selected,back.revision,back.file)});
  if(!methodView.selected){methodButton(page,'新建'+methodTabs.find(t=>t[0]===category)[1],()=>{methodView.mode='configuration';drawMethods(root)});rememberMethodPosition();return}
  const objectId=methodView.selected,revisionId=methodView.revision;
  const status=nodeText('p','config-save-status','正在读取准确正文…',page);status.setAttribute('role','status');
  try{
    record=await api('/api/methods/record?'+new URLSearchParams({object_id:objectId,...(revisionId?{revision_id:revisionId}:{})}));
    if(epoch!==methodReadEpoch||!mounted.isConnected)return;
    if(record.payload.format!=='managed-method-'+category+'-v1')throw Error('准确对象不属于当前目录；未替换为其他方法。');
    methodView.revision=record.revision_id;methodView.record=record;
    const p=record.payload;
    if(category==='binding'){
      status.remove();nodeText('h2',null,methodTitle(record),page);methodVersions(page,record,root);
      const rules=el('section','method-binding-rules');page.append(rules);
      for(const [index,rule] of p.rules.entries()){
        const m=methodView.data.referenced[rule.revision_id]||await api('/api/methods/record?'+new URLSearchParams({object_id:rule.object_id,revision_id:rule.revision_id}));
        if(epoch!==methodReadEpoch||!mounted.isConnected)return;
        const row=el('div','method-binding-rule');nodeText('p',null,methodScopeLabel(record,index),row);methodButton(row,methodTitle(m)+' · 第 '+m.version+' 版',()=>methodOpen(root,'skill',m.object_id,m.revision_id,'SKILL.md',true));rules.append(row);
      }
      methodButton(page,'编辑此环节',()=>{methodView.mode='configuration';drawMethods(root)});
      methodButton(page,'新建工作环节',()=>{methodView.selected=null;methodView.revision=null;methodView.mode='configuration';drawMethods(root)});
      methodRoute();rememberMethodPosition();return;
    }
    const files=Object.keys(p.files||{});methodView.file ||= files.includes('SKILL.md')?'SKILL.md':Object.values(p.sections||{})[0]||files[0];
    const doc=await api('/api/methods/document?'+new URLSearchParams({object_id:record.object_id,revision_id:record.revision_id,file:methodView.file}));
    if(epoch!==methodReadEpoch||!mounted.isConnected)return;
    status.remove();methodView.document=doc;
    nodeText('h2',null,methodTitle(record),page);if(methodPurpose(record))nodeText('p','method-purpose',methodPurpose(record),page);methodVersions(page,record,root);
    if(category==='skill'){const scopes=methodScopes(record.object_id);nodeText('p','method-use',scopes.length?'后续使用：'+scopes.map(s=>s.label+'（第 '+(methodView.data.referenced[s.binding.payload.rules[s.index].revision_id]?.version||'?')+' 版）').join('；'):'尚未用于后续工作',page)}
    const tools=el('div','method-tools');page.append(tools);
    methodButton(tools,'查看评论',()=>{openPanel();renderComments()});
    if(!p.source)methodButton(tools,'编辑正文',()=>drawMethodEditor(root,record));
    methodButton(tools,p.source?'查看维护配置':'维护执行配置',()=>{methodView.mode='configuration';drawMethods(root)});
    if(methodView.configurationDrafts[JSON.stringify([category,record.object_id])])methodButton(tools,'继续未保存的配置修改',()=>{methodView.mode='configuration';drawMethods(root)});
    methodButton(tools,'新建'+(category==='skill'?'方法':'资料'),()=>{methodView.selected=null;methodView.revision=null;methodView.mode='configuration';drawMethods(root)});
    if(p.source)nodeText('p','method-source','源文件只读 · '+(p.source.files[doc.file]?.path||doc.file),page);
    const layout=el('div','method-reading-layout'),nav=el('nav','method-directory');nav.setAttribute('aria-label','准确文件目录');layout.append(nav);
    const fileType=file=>/\.md$/.test(file)?'text':/\.(svg|png|jpe?g|webp)$/.test(file)?'image':/\.json$/.test(file)?'data':'tool',filter=methodFilter();
    const drawFiles=()=>{nav.replaceChildren();methodChoiceRow(nav,'文件类型',[['all','全部文件'],['text','正文'],['image','图示'],['data','数据'],['tool','工具与附件']].filter(([key])=>key==='all'||files.some(f=>fileType(f)===key)),filter.fileType,key=>{filter.fileType=key;methodRoute();rememberMethodPosition();drawFiles()});for(const file of files.filter(f=>filter.fileType==='all'||fileType(f)===filter.fileType)){const title=(p.files[file].match(/^#{1,3} (.+)$/m)||[])[1]||file,b=methodButton(nav,title,()=>methodOpen(root,category,record.object_id,record.revision_id,file));b.title=file;b.classList.toggle('active',file===doc.file);b.setAttribute('aria-current',String(file===doc.file));if(title!==file)nodeText('small',null,file,b)}};drawFiles();
    const raw=el('a',null,'下载当前准确文件');raw.href=methodView.rawURL=URL.createObjectURL(new Blob([p.files[doc.file]],{type:'text/plain;charset=utf-8'}));raw.download=doc.file.split('/').at(-1);tools.append(raw);
    const prose=el('div','method-prose');prose.dataset.reviewRevision=record.revision_id;prose.dataset.methodFile=doc.file;methodView.prose=prose;layout.append(prose);page.append(layout);
    renderMethodBlocks(prose,doc,root);
    if(p.resources?.length){const resources=el('nav','method-shared');nodeText('h3',null,'本方法引用的准确共用章节',resources);for(const ref of p.resources){const resource=methodView.data.referenced[ref.revision_id];const b=methodButton(resources,(resource?.payload.title||ref.object_id)+' / '+ref.section+' · 第 '+(resource?.version||'?')+' 版',()=>methodOpen(root,'resource',ref.object_id,ref.revision_id,resource?.payload.sections[ref.section],true));if(ref.when)nodeText('small',null,'按当前工作需要读取',b)}page.append(resources)}
    const pending=localStorage.getItem('method-edit:'+record.object_id);if(pending)methodButton(page,'继续未完成的改稿或应用',()=>drawMethodEditor(root,record,JSON.parse(pending)));
    if(typeof restoreStoryDraft==='function')restoreStoryDraft();paintMethodComments();renderComments();
    methodRoute();window.scrollTo(0,methodView.positions[methodKey()]||0);rememberMethodPosition();
  }catch(error){if(epoch===methodReadEpoch&&mounted.isConnected){status.textContent=error.message;if(!status.isConnected)page.append(status);methodRoute();rememberMethodPosition();methodButton(page,'重试准确正文',()=>drawMethods(root))}}
}
function methodLink(root,doc,part,parent){
  const link=nodeText('a',null,part.text,parent),href=part.href;
  if(/^https:\/\//.test(href)){link.href=href;link.target='_blank';link.rel='noopener noreferrer';return}
  const raw=href.split('#')[0],hash=href.split('#')[1],base=doc.file.split('/').slice(0,-1),pieces=[...base,...raw.split('/')],out=[];for(const piece of pieces){if(piece==='..')out.pop();else if(piece&&piece!=='.')out.push(piece)}const path=out.join('/');
  const payload=doc.record.payload;
  if(payload.source&&(/\.(mp4|webm|mp3|wav|png|jpg|jpeg|webp)$/.test(href))){link.href=reviewURL('/api/methods/media?'+new URLSearchParams({object_id:doc.record.object_id,revision_id:doc.record.revision_id,file:doc.file,href}));link.target='_blank';link.rel='noopener';const media=el(/\.(mp3|wav)$/.test(href)?'audio':/\.(mp4|webm)$/.test(href)?'video':'img');media.src=link.href;if(media.tagName!=='IMG'){media.controls=true;media.preload='metadata'}else media.alt=part.text;media.onerror=()=>{media.remove();nodeText('p','production-issue','准确媒体未能读取，未替换为其他版本。',parent)};const figure=el('figure','approach-media');figure.append(media);parent.parentElement.append(figure);return;}
  let ref={category:methodView.category,object_id:doc.record.object_id,revision_id:doc.record.revision_id,file:raw?path:doc.file};
  if(!payload.files[ref.file]){
    ref=null;
    for(const r of payload.resources||[]){const resource=methodView.data.referenced[r.revision_id];for(const file of Object.keys(resource?.payload.files||{}))if(file===path||resource.payload.source?.files[file]?.path===path){ref={category:'resource',object_id:r.object_id,revision_id:r.revision_id,file};break}if(ref)break}
  }
  link.href='#';link.onclick=e=>{e.preventDefault();if(!ref){toast('本准确包未包含此资料；请从源入口补取，未替换为最新版');return}if(ref.object_id===doc.record.object_id&&ref.file===doc.file&&hash){const target=[...methodView.prose.querySelectorAll('[data-section]')].find(n=>n.dataset.section===hash||n.dataset.section.startsWith(hash.toLowerCase()+'-'));if(target){target.scrollIntoView({block:'start'});return}}methodOpen(root,ref.category,ref.object_id,ref.revision_id,ref.file,true).then(()=>{if(hash&&methodView.document?.record.revision_id===ref.revision_id&&methodView.document.file===ref.file){const target=[...methodView.prose.querySelectorAll('[data-section]')].find(n=>n.dataset.section===hash||n.dataset.section.startsWith(hash.toLowerCase()+'-'));target?.scrollIntoView({block:'start'})}})};
}
function renderMethodBlocks(parent,doc,root){
  let table=null,tableRow=null,lastRow=null;
  for(const block of doc.blocks){
    let node;
    if(block.type==='table-cell'){if(!table){table=el('table','approach-table');parent.append(table)}if(lastRow!==block.row){tableRow=el('tr');table.append(tableRow);lastRow=block.row}node=el('td');tableRow.append(node)}
    else{table=null;node=el(block.type==='heading'?'h'+Math.min(6,block.level+1):block.type==='code'?'pre':block.type==='quote'?'blockquote':'p',block.type==='list-item'?'method-list-item':null);parent.append(node)}
    node.dataset.blockId=block.id;
    if(block.type==='heading')node.dataset.section=block.section||block.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu,'-');
    for(const part of block.parts){if(part.type==='link')methodLink(root,doc,part,node);else if(part.type==='image'){
        if(doc.record.payload.source&&/\.(png|jpg|jpeg|webp)$/.test(part.href)){methodLink(root,doc,part,node);continue;}
        nodeText('span',null,part.text,node);
        const path=part.href,files=doc.record.payload.files;
        const relative=[...doc.file.split('/').slice(0,-1),...path.split('/')].reduce((a,p)=>{if(p==='..')a.pop();else if(p&&p!=='.')a.push(p);return a},[]).join('/');
        if(files[relative]?.startsWith('<svg')||files[relative]?.includes('<svg')){const image=el('img');image.alt=part.text;image.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(files[relative]);const figure=el('figure','approach-media');figure.append(image);parent.append(figure)}
      }else nodeText(part.type==='code'?'code':part.type==='strong'?'strong':'span',null,part.text,node)}
  }
  reviewSurface(parent,'text');
}
function paintMethodComments(){if(!isMethodsReading()||!methodView.prose)return;const doc=methodView.document;
  for(const node of methodView.prose.querySelectorAll('[data-block-id]')){for(const mark of node.querySelectorAll('.comment-mark'))mark.replaceWith(document.createTextNode(mark.textContent));node.normalize();const index=doc.blocks.findIndex(b=>b.id===node.dataset.blockId);for(const c of state.comments.filter(c=>c.target_revision_id===doc.record.revision_id&&c.anchor.file===doc.file))for(const r of textAnchorBlockRanges(c.anchor,doc.blocks,index))if(r.start<r.end)paintProductionTextMark(node,r.start,r.end,c)}paintReviewCommentCounts();
}
async function locateMethodComment(comment){
  const key=methodKey(),root=methodView.root;
  const record=await api('/api/methods/record?'+new URLSearchParams({object_id:comment.target_object_id,revision_id:comment.target_revision_id}));
  if(methodKey()!==key||!isMethodsReading())return false;
  await methodOpen(root,record.payload.format==='managed-method-skill-v1'?'skill':'resource',record.object_id,record.revision_id,comment.anchor.file,methodView.selected!==record.object_id||methodView.revision!==record.revision_id||methodView.file!==comment.anchor.file);
  if(!isMethodsReading()||methodView.document.record.revision_id!==comment.target_revision_id||methodView.document.file!==comment.anchor.file)return false;
  state.selected=comment.id;paintMethodComments();renderComments();methodView.prose?.querySelector('[data-block-id="'+CSS.escape(comment.anchor.block_id)+'"]')?.scrollIntoView({block:'center'});return true;
}
function drawMethodEditor(root,record,recovery=null){
  rememberMethodPosition();if(typeof rememberStoryDraft==='function')rememberStoryDraft();++methodReadEpoch;methodView.mode='edit';methodView.draft=true;methodView.document=null;state.anchor=null;state.editing=null;state.selected=null;renderComments();
  const page=methodPage(root),mounted=methodView.page;nodeText('h2',null,'编辑 '+methodTitle(record),page);
  const pendingKey='method-edit:'+record.object_id,base=recovery?.base_revision||record.revision_id;
  const values={files:{...(recovery?.changes?.files||record.payload.files)}};
  const file=methodView.file||Object.keys(values.files)[0];
  const textarea=el('textarea','method-body-editor');textarea.value=values.files[file];textarea.rows=25;textarea.setAttribute('aria-label','正文 '+file);page.append(textarea);
  const choices=el('fieldset','method-apply-scopes');nodeText('legend',null,'用于哪些后续工作',choices);page.append(choices);const checkboxes=[];
  for(const scope of methodEligibleScopes(record)){const label=el('label'),input=el('input');input.type='checkbox';input.checked=recovery?.scopes?.some(s=>s.object_id===scope.binding.object_id&&s.index===scope.index)||false;label.append(input,document.createTextNode(scope.label));choices.append(label);checkboxes.push({input,scope})}
  const notice=nodeText('p','config-save-status','',page);notice.setAttribute('role','status');
  let request=recovery,saving=false,finished=false;
  const build=apply=>({object_id:record.object_id,base_revision:base,changes:{...values,files:{...values.files,[file]:textarea.value}},...(request?.saved_revision?{saved_revision:request.saved_revision}:{}),scopes:apply?checkboxes.filter(c=>c.input.checked).map(c=>({object_id:c.scope.binding.object_id,revision_id:c.scope.binding.revision_id,index:c.scope.index})):[]});
  const persist=()=>{request=build(!!request?.scopes?.length);try{localStorage.setItem(pendingKey,JSON.stringify(request))}catch{notice.textContent='本机草稿保存失败，请复制正文留存。'}};for(const c of checkboxes)c.input.onchange=()=>{if(!request)request={scopes:[]};request.scopes=checkboxes.filter(x=>x.input.checked).map(x=>({object_id:x.scope.binding.object_id,revision_id:x.scope.binding.revision_id,index:x.scope.index}));persist()};textarea.oninput=()=>{if(request?.saved_revision){notice.textContent='已保存的改稿正在应用中。先完成或返回新版本，再继续编辑。';return}persist()};
  methodView.leaveCurrent=()=>{if(!finished)persist()};
  const reviewCurrentScopes=async()=>{const data=await api('/api/methods');if(methodView.page!==mounted)return;methodView.data=data;drawMethodEditor(root,record,request);nodeText('p','config-save-status','当前使用范围已读回，请检查条件分支与当前方法版本，再选择继续应用。',methodView.page);for(const c of methodEligibleScopes(record)){const r=c.binding.payload.rules[c.index],m=methodView.data.referenced[r.revision_id];nodeText('p',null,c.label+'：当前第 '+m?.version+' 版',methodView.page)}};
  if(request?.saved_revision){const saved=methodView.data.versions?.[record.object_id]?.find(r=>r.revision_id===request.saved_revision);notice.textContent='方法已保存'+(saved?'第 '+saved.version+' 版':'准确版本')+'；请核对后续使用范围，沿此版本继续应用。';const retry=methodButton(page,'核对当前使用范围',reviewCurrentScopes);retry.dataset.methodScopeRetry='true'}
  const save=async apply=>{if(saving)return;if(request?.saved_revision&&textarea.value!==request.changes.files[file]){notice.textContent='已保存的改稿须先完成应用，正文已保留。';return}saving=true;for(const b of actions.querySelectorAll('button'))b.disabled=true;
    try{request=build(apply);localStorage.setItem(pendingKey,JSON.stringify(request));const result=await api('/api/methods/edit',{method:'POST',body:JSON.stringify(request)});request.saved_revision=result.saved.revision_id;localStorage.setItem(pendingKey,JSON.stringify(request));
      notice.textContent='方法已保存第 '+result.saved.version+' 版。'+(apply?'已用于：'+(result.applied.flatMap(a=>a.indices.map(i=>checkboxes.find(c=>c.scope.binding.object_id===a.object_id&&c.scope.index===i)?.scope.label||methodWorkLabels[a.work_type]||a.work_type)).join('；')||'无')+'。未应用：'+(result.unapplied.map(a=>(methodWorkLabels[a.object_id.split('.').slice(2).join('.')]||a.object_id)+'：'+a.error).join('；')||'无'):'仅保存待用，后续工作保持原选择。');
      if(result.unapplied.length){if(!page.querySelector('button[data-method-scope-retry]')){const retry=methodButton(page,'核对当前使用范围',reviewCurrentScopes);retry.dataset.methodScopeRetry='true'}}else{finished=true;textarea.readOnly=true;for(const c of checkboxes)c.input.disabled=true;localStorage.removeItem(pendingKey);if(methodView.page===mounted)methodView.draft=null;methodButton(page,'阅读已保存正文',async()=>{const data=await api('/api/methods');if(methodView.page!==mounted)return;methodView.data=data;methodOpen(root,record.payload.format==='managed-method-skill-v1'?'skill':'resource',record.object_id,result.saved.revision_id,file)})}
    }catch(error){notice.textContent=error.message+'；当前改稿保留。';methodButton(page,'核对最新正文',async()=>{const current=await api('/api/methods/record?'+new URLSearchParams({object_id:record.object_id}));if(methodView.page!==mounted)return;const modal=openReviewDialog('核对最新正文',textarea,'method-conflict'),dialog=modal.body;nodeText('pre',null,current.payload.files[file]||'当前稿已没有此文件；原改稿保留。',dialog);methodButton(dialog,'按此版本继续合并当前改稿',()=>{const next={...request,base_revision:current.revision_id,changes:{files:{...current.payload.files,[file]:textarea.value}}};delete next.saved_revision;modal.dialog.close();drawMethodEditor(root,current,next)})})}
    finally{saving=false;for(const [i,b] of [...actions.querySelectorAll('button')].entries())b.disabled=finished&&i<2}
  };
  const actions=el('div','method-tools');page.append(actions);methodButton(actions,'保存并用于所选后续工作',()=>{if(!checkboxes.some(c=>c.input.checked)){notice.textContent='请选择需要使用此版的后续工作。';return}save(true)});methodButton(actions,'仅保存待用',()=>save(false));methodButton(actions,'返回阅读，保留改稿',()=>methodOpen(root,methodView.category,record.object_id,record.revision_id,file));
}

function appendMethodResponseAction(actions,comment,onSaved=null){
  methodButton(actions,'回应原意见',async()=>{
    const target=JSON.stringify(commentTarget());
    let current;
    try{current=await api('/api/methods/record?'+new URLSearchParams({object_id:comment.target_object_id}))}catch(error){if(actions.isConnected&&JSON.stringify(commentTarget())===target)toast('回应稿读取失败：'+error.message);return}
    if(!actions.isConnected||JSON.stringify(commentTarget())!==target)return;
    const modal=openReviewDialog('回应方法原意见',actions,'method-response'),dialog=modal.body;
    nodeText('blockquote',null,comment.body,dialog);nodeText('p',null,'回应将关联原圈选和第 '+current.version+' 版当前正文；关闭评论仍由你决定。',dialog);
    let file=comment.anchor.file;
    if(!Object.hasOwn(current.payload.files,file)){
      nodeText('p','comment-help','当前稿已没有原文件 '+file+'。请选择回应实际对应的当前文件；原圈选仍保留原文件。',dialog);
      file='';const choice=el('div');dialog.append(choice);const draw=()=>{choice.replaceChildren();methodChoiceRow(choice,'回应所对应的当前文件',Object.keys(current.payload.files).map(name=>[name,name]),file,name=>{file=name;draw()})};draw();
    }
    const input=el('textarea');input.rows=5;input.setAttribute('aria-label','回应说明');dialog.append(input);const notice=nodeText('p','config-save-status','',dialog);
    const submit=methodButton(dialog,'保存回应',async()=>{submit.disabled=true;try{if(!file)throw Error('请选择回应实际对应的当前文件；输入仍保留。');await api('/api/methods/respond',{method:'POST',body:JSON.stringify({comment_id:comment.id,revision_id:current.revision_id,file,explanation:input.value})});modal.dialog.close();afterReviewDialogReturn(()=>{renderComments();onSaved?.()});toast('回应已保存，可复核原文与改动')}catch(error){notice.textContent=error.message;submit.disabled=false}});
  });
}
