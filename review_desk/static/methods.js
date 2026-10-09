/* Working methods live in the existing configuration workspace. */
const methodWorkLabels={'comment-polish':'评论润色','media-plan':'媒体方案','novel-writing':'小说写作','reader-review':'独立读者'};
let methodView = {category:'skill', selected:null, data:null, draft:null};
async function renderMethods(root){
  if(methodView.draft&&methodView.page){root.replaceChildren(methodView.page);return}
  if(root.methodLoading)return;
  root.methodLoading=true;
  try{methodView.data=await api('/api/methods');if(state.workspace!=='project.configuration'||state.configSection!=='METHODS')return;drawMethods(root)}
  catch(error){root.replaceChildren();nodeText('p','production-issue',error.message,root)}
  finally{root.methodLoading=false}
}
function drawMethods(root){
  root.replaceChildren();
  const page=el('article','config-page methods-page');root.append(page);
  methodView.page=page;
  const tabs=el('div','config-choice-row method-tabs');page.append(tabs);
  for(const [key,label] of [['skill','方法'],['resource','共用资料'],['binding','工作环节']]){
    const button=el('button',key===methodView.category?'active':'',label);button.type='button';button.setAttribute('aria-pressed',key===methodView.category?'true':'false');
    button.onclick=()=>{if(methodView.draft&&!confirm('放弃当前未保存修改？'))return;methodView={...methodView,category:key,selected:null,draft:null};drawMethods(root)};tabs.append(button);
  }
  const category=methodView.category,records=methodView.data[category],picker=el('select');picker.setAttribute('aria-label','选择'+({skill:'方法',resource:'共用资料',binding:'工作环节'}[category]));
  picker.append(new Option('新建'+({skill:'方法',resource:'共用资料',binding:'工作环节'}[category]),''));
  for(const row of records)picker.append(new Option(`${row.payload.title||methodWorkLabels[row.payload.work_type]||row.payload.work_type} · 第 ${row.version} 版`,row.object_id));
  picker.value=methodView.selected||'';picker.onchange=()=>{if(methodView.draft&&!confirm('放弃当前未保存修改？')){picker.value=methodView.selected||'';return}methodView.selected=picker.value||null;methodView.draft=null;drawMethods(root)};page.append(picker);
  const record=records.find(r=>r.object_id===methodView.selected),p=record?.payload||{};
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
  if(category==='skill'){
    const resourceGroup=el('section','method-resources');form.append(resourceGroup);
    nodeText('h3',null,'共用章节',resourceGroup);
    const available=[...methodView.data.resource];
    for(const exact of p.resources||[]){if(!available.some(r=>r.object_id===exact.object_id&&r.payload.sections[exact.section])){const old=methodView.data.referenced[exact.revision_id];if(old)available.push({...old,payload:{...old.payload,sections:{[exact.section]:old.payload.sections[exact.section]}}})}}
    for(const resource of available){for(const section of Object.keys(resource.payload.sections)){
      const resourceRow=el('div','method-resource-row');resourceGroup.append(resourceRow);
      const exact=p.resources?.find(r=>r.object_id===resource.object_id&&r.section===section),row=el('label','config-choice');
      const enabled=el('input');enabled.type='checkbox';enabled.checked=!!exact;
      const frozen=exact&&methodView.data.referenced[exact.revision_id];
      row.append(enabled,el('span',null,`${resource.payload.title} / ${section} · 第 ${frozen?.version||resource.version} 版`));
      const condition=el('input');condition.placeholder='仅在条件满足时加载，例如 mode=video';condition.setAttribute('aria-label',`${resource.payload.title} ${section} 的加载条件`);condition.value=Object.entries(exact?.when||{}).map(([k,v])=>`${k}=${v}`).join(', ');resourceRow.append(row,condition);condition.disabled=!enabled.checked;enabled.onchange=()=>{condition.disabled=!enabled.checked};
      const update=el('input');update.type='checkbox';update.checked=!exact||exact.revision_id===resource.revision_id;
      if(exact&&exact.revision_id!==resource.revision_id){const updateLabel=el('label');updateLabel.append(update,document.createTextNode(`改用第 ${resource.version} 版（未选则保留第 ${frozen?.version} 版）`));resourceRow.append(updateLabel)}
      references.push(()=>enabled.checked?{object_id:resource.object_id,revision_id:update.checked?resource.revision_id:exact.revision_id,section,when:parseMethodConditions(condition.value)}:null);
    }}
  }
  const rules=[];
  if(category==='binding'){
    nodeText('p','config-explanation','选择本环节的新工作使用的方法。已有执行继续取得原准确版本。条件为空表示默认；更具体的匹配优先。',form);
    const group=el('div','method-rules');form.append(group);
    function ruleEditor(rule={}){const row=el('div','config-field');const conditions=el('input');conditions.placeholder='适用条件，例如 mode=video';conditions.setAttribute('aria-label','方法选择条件');conditions.value=Object.entries(rule.when||{}).map(([k,v])=>`${k}=${v}`).join(', ');
      const choice=el('select');choice.setAttribute('aria-label','执行方法版本');choice.append(new Option('请选择方法',''));
      for(const m of methodView.data.skill)choice.append(new Option(`${m.payload.title} · 第 ${m.version} 版`,JSON.stringify({object_id:m.object_id,revision_id:m.revision_id})));
      if(rule.object_id){const val=JSON.stringify({object_id:rule.object_id,revision_id:rule.revision_id});const old=methodView.data.referenced[rule.revision_id];if(![...choice.options].some(o=>o.value===val))choice.append(new Option(`${old?.payload.title||rule.object_id} · 第 ${old?.version||'?'} 版`,val));choice.value=val}
      row.append(conditions,choice);group.append(row);const getRule=()=>({...JSON.parse(choice.value),when:parseMethodConditions(conditions.value)});rules.push(getRule);const remove=el('button',null,'移除此条件');remove.type='button';remove.onclick=()=>{rules.splice(rules.indexOf(getRule),1);row.remove();methodView.draft=true};row.append(remove);}
    for(const rule of p.rules||[{}])ruleEditor(rule);
    const add=el('button',null,'增加条件选择');add.type='button';add.onclick=()=>{ruleEditor();methodView.draft=true};form.append(add);
  }
  const notice=nodeText('p','config-save-status','',form);notice.setAttribute('role','status');
  const submit=el('button','primary','保存新版本');submit.type='submit';form.append(submit);
  if(p.source){nodeText('p','config-explanation','正文由以下项目 Markdown 维护，同步后形成可恢复的准确版本：'+[...new Set(Object.values(p.source.files).map(s=>s.path))].join('、'),form);for(const input of form.querySelectorAll('input,textarea,button'))input.disabled=true;}
  form.oninput=()=>{methodView.draft=true};
  form.onsubmit=async event=>{event.preventDefault();submit.disabled=true;try{
    let payload;
    if(category==='binding')payload={work_type:name.value.trim(),rules:rules.map(r=>r())};
    else{payload={title:fields.title.value,files:Object.fromEntries(Object.entries(fileEditors).map(([k,v])=>[k,v.value]))};
      if(category==='resource')payload.sections=Object.fromEntries(fields.sections.value.split('\n').filter(v=>v.trim()).map(line=>{const i=line.indexOf('=');if(i<1)throw Error('章节请使用 标识 = 文件');return [line.slice(0,i).trim(),line.slice(i+1).trim()]}));
      else{for(const key of ['purpose','applies','inputs','outputs','checks'])payload[key]=fields[key].value;for(const key of ['work_types','required_inputs','steps'])payload[key]=fields[key].value.split(/[,，]/).map(v=>v.trim()).filter(Boolean);payload.resources=references.map(r=>r()).filter(Boolean);}
    }
    const result=await api('/api/methods/save',{method:'POST',body:JSON.stringify({category,name:name.value.trim(),expected_version:record?.version||0,payload})});
    if(methodView.page!==page)return;
    methodView.selected=result.object_id;methodView.draft=null;methodView.data=await api('/api/methods');
    if(methodView.page!==page||state.workspace!=='project.configuration'||state.configSection!=='METHODS')return;
    drawMethods(root);nodeText('p','config-save-status',`已保存第 ${result.version} 版。工作环节选择此版后，新执行会取得对应正文与共用章节。`,root);
  }catch(error){notice.textContent=error.message+'；当前输入保留。可在新页面核对已保存版本后合并修改。'}finally{submit.disabled=false}};
}
function parseMethodConditions(value){const result={};for(const part of value.split(/[,，]/).filter(s=>s.trim())){const i=part.indexOf('=');if(i<1)throw Error('条件请使用 字段=值');result[part.slice(0,i).trim()]=part.slice(i+1).trim()}return result}
