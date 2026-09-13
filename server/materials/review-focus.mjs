import {check,hash} from '../shared/contracts.mjs';
import {idsFor,idFor} from '../presentation/read-unit.mjs';
const text=value=>typeof value==='string'&&value.trim()&&!/^(UNKNOWN|UNDEFINED|NULL)$/i.test(value.trim())?value.trim():null;
export async function materialReviewFocus(unit,{requirementId,versionId}){
 const asset=await unit.detail(versionId);check(asset.kind==='ASSET','MATERIAL_REVIEW_VERSION','请选择实际素材版本');
 const historical=asset.historical||asset.revision.content.historyRole==='HISTORICAL',familyId=idFor(asset,'FAMILY');
 let requirement;
 if(historical){const prior=asset.dependencies.filter(d=>d.kind==='REQUIREMENT'&&d.purpose==='DEFINITION');if(prior.length===1)requirement=await unit.detail(prior[0].objectId,prior[0].revisionId);}
 else{requirement=await unit.detail(requirementId);check(requirement.kind==='REQUIREMENT'&&idsFor(requirement,'FAMILY').includes(familyId),'MATERIAL_REVIEW_BINDING','素材与需求不属于同一精确关联',409);}
 const sources=new Map(),sections=[],missing=[];
 const bind=row=>{const value={objectId:row.id,revisionId:row.revision.id,sha256:row.revision.sha256,expectedVersion:row.version};sources.set(row.revision.id,value);return value;};bind(asset);
 const add=(label,value,row,field)=>{if(text(value))sections.push({label,text:text(value),source:{...bind(row),field}});};
 const fields=(label,value,row,path)=>{if(value&&typeof value==='object')for(const [key,v] of Object.entries(value)){if(typeof v==='string')add(label+' · '+key,v,row,path+'.'+key);else if(Array.isArray(v)&&v.every(x=>typeof x==='string'))add(label+' · '+key,v.join('、'),row,path+'.'+key);}};
 if(requirement){bind(requirement);const body=requirement.revision.content;
  add('素材用途',body.storyBasis?.whyNeeded||body.description,requirement,'storyBasis.whyNeeded/description');
  for(const [key,label] of [['onScreenRequirement','画面要求'],['factBoundary','事实边界']])add(label,body.storyBasis?.[key],requirement,'storyBasis.'+key);
  for(const [key,label] of [['displayName','卡内姓名'],['contextLine','卡内身份信息'],['narrativeCue','原登记出场提示'],['spoilerPolicy','信息披露边界'],['role','模板职责']])add(label,body.cardSpec?.[key],requirement,'cardSpec.'+key);
  const definitions=[...new Set([...idsFor(requirement,'ENTITY'),...idsFor(requirement,'STATE'),...idsFor(requirement,'REPRESENTATION')])];
  if(!definitions.length)missing.push('未绑定唯一主体、状态或素材表现；身份与形态依据 UNKNOWN。');
  for(const id of definitions){
   let row;if(historical){const binding=requirement.dependencies.find(d=>d.objectId===id);if(binding)row=await unit.detail(id,binding.revisionId);else{missing.push('历史需求未冻结此定义修订：'+id+'；不使用当前设定补写。');continue;}}else row=await unit.detail(id);
   const value=row.revision.content;bind(row);add(row.kind==='ENTITY'?'主体身份':'状态与表现',value.name||value.label,row,'name/label');add('具体业务属性',value.description,row,'description');fields('状态／发展／方位',value.dimensions,row,'dimensions');
   for(const key of ['scope','evidence'])if(Array.isArray(value[key]))for(const entry of value[key].slice(0,12)){if(key==='evidence'){add('已登记来源摘录',entry.quote,row,'evidence');if(!entry.sourceId||!entry.revisionId)missing.push('来源摘录未绑定可读取的原文修订；原文核验 UNKNOWN。');}else if(entry.revisionId)add('适用修订',entry.scopeId+' / '+entry.revisionId,row,'scope');}
   if(value.authority==='U'||value.type==='UNRESOLVED')missing.push('此定义仍为 UNKNOWN：'+(value.name||value.label||id));
   if(row.kind==='REPRESENTATION'&&!historical)for(const stateId of idsFor(row,'STATE')){const state=await unit.detail(stateId);add('状态要求',state.revision.content.label,state,'label');fields('状态／发展／方位',state.revision.content.dimensions,state,'dimensions');}
  }
  const sceneIds=idsFor(requirement,'SCENE');if(!sceneIds.length)missing.push('未登记当前永久集／场的精确用途关联；旧显示场号不作为当前适用性依据。');
  for(const id of sceneIds.slice(0,24)){const binding=requirement.dependencies.find(d=>d.objectId===id);if(!binding){missing.push('场用途缺少精确修订：'+id);continue;}const scene=await unit.detail(id,binding.revisionId);add('剧情用途',scene.revision.content.purpose||scene.revision.content.title,scene,'purpose/title');}
 }else missing.push('历史素材没有唯一冻结需求修订；原审阅标准和业务属性 UNKNOWN，不使用当前要求替代。');
 const rules=[];if(!historical){for(const g of await unit.rows(['GUIDANCE'])){if(!g.adoptedRevisionId||!['PROJECT_RULE_SOURCE','PROJECT_GUIDANCE'].includes(g.content.role))continue;const row=await unit.detail(g.id,g.adoptedRevisionId);if(text(row.revision.content.text))rules.push({title:row.title,text:row.revision.content.text,source:bind(row)});}}
 else missing.push('当前项目规则不补作历史版本的冻结输入；请按其原来源与生产记录核对。');
 const result={historical,familyId,versionId,requirementId:requirement?.id||null,requirementRevisionId:requirement?.revision.id||null,sections,missing:[...new Set(missing)],rules,reviewSpec:requirement?.revision.content.reviewSpec||null,sources:[...sources.values()].sort((a,b)=>a.revisionId.localeCompare(b.revisionId))};
 check(Buffer.byteLength(JSON.stringify(result))<=160*1024,'MATERIAL_REVIEW_CONTEXT_LIMIT','素材业务依据过大，请缩小精确关联范围',413);return {...result,contextHash:hash({...result,sources:result.sources.map(({expectedVersion,...source})=>source)})};
}
