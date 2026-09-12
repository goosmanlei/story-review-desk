'use client';
import { useState } from 'react';
import type { Configuration, Criterion } from '../presentation/configuration-model.mjs';
import type { ConfigurationState } from '../presentation/configuration-service.mjs';
import { reviewCatalog, leafForProfile, standardLabel, type ReviewCatalogNode } from '../presentation/review-standard-catalog.mjs';

const readable=(text:string)=>text.replaceAll('UNKNOWN','待确认').replaceAll('QA','质量检查').replaceAll('Animatic','场级预演');
export function ReviewStandardsEditor({config,state,profileId,onSelect,onEdit,readonly,upgradeKeys,onUpgrade}:{
 config:Configuration;state:ConfigurationState;profileId:string;onSelect:(id:string)=>void;
 onEdit:(edit:(c:Configuration)=>void)=>void;readonly:boolean;upgradeKeys:string[];onUpgrade:(keys:string[])=>void;
}) {
 const [moduleId,setModuleId]=useState('story');
 const catalog=reviewCatalog(config);
 const selected=leafForProfile(catalog,profileId);
 const profile=config.reviewProfiles.find(p=>p.id===profileId) || config.reviewProfiles[0];
 const peers=selected?.profileIds || [profile.id];
 const activeModule=catalog.find(n=>n.id===moduleId)!;
 const usages=state.bindings.filter(b=>peers.includes(b.defaultProfileId || b.profileId));
 const change=(fn:(p:typeof profile)=>void)=>onEdit(c=>{for(const p of c.reviewProfiles)if(peers.includes(p.id))fn(p);});
 const changeCriterion=(index:number,fn:(criterion:Criterion)=>void)=>change(p=>fn(p.criteria[index]));
 const field=(label:string,value:string,onChange:(value:string)=>void,multi=false)=><label className="configuration-field">{label}{multi?<textarea disabled={readonly} value={value} onChange={e=>onChange(e.target.value)}/>:<input disabled={readonly} value={value} onChange={e=>onChange(e.target.value)}/>}</label>;
 const first=(nodes:ReviewCatalogNode[]):string|undefined=>{for(const node of nodes){if(node.profileIds?.length)return node.profileIds[0];const id=first(node.children);if(id)return id;}};
 function tree(nodes:ReviewCatalogNode[],depth=0):React.ReactNode {
  return nodes.map(original=>{const node=original.children.length===1 && original.children[0].profileIds && original.children[0].label===original.label ? {...original.children[0],id:original.id} : original;return node.profileIds?<button key={node.id} className="standard-leaf" aria-current={node.profileIds.includes(profile.id)?'page':undefined} onClick={()=>onSelect(node.profileIds![0])}>{node.label}</button>:<details className="standard-group" key={node.id} open={depth===0 || Boolean(leafForProfile(node.children,profile.id))}><summary>{node.label}</summary>{node.children.length?tree(node.children,depth+1):<p className="standard-empty">此环节暂无可编辑标准</p>}</details>});
 }
 return <div className="review-standards-layout">
  <nav className="standards-directory" aria-label="审阅模块与标准目录">
   {catalog.map(node=><div className="standard-module" key={node.id}>
    <button className="standard-module-button" aria-expanded={moduleId===node.id} onClick={()=>{setModuleId(node.id);if(!leafForProfile([node],profile.id)){const id=first(node.children);if(id)onSelect(id);}}}>{node.label}<span aria-hidden="true">{moduleId===node.id?'−':'＋'}</span></button>
    {moduleId===node.id && <div className="standard-module-tree">{tree(node.children)}</div>}
   </div>)}
  </nav>
  <section className="standard-detail" aria-label="当前审阅标准">
   <header><p className="standard-breadcrumb">{activeModule.label} / {selected?.label || profile.label}</p><h3>{selected?.label || profile.label}</h3><p>{profile.subjectKind==='EPISODE_PLAN'?'判断每一集的剧情设计是否成立。每集完成六项意见后，整套方案统一形成正式结论。':profile.subjectKind==='SCRIPT_SCENE'?'判断场正文的事实、叙事作用和制作可行性。':profile.subjectKind==='ASSET'?'判断此类素材能否满足制作需要，并作为后续可复用输入。':'判断此项交付物是否达到所属环节的使用要求。独立产物分别验收。'}</p>
    {selected?.condition && <p className="standard-condition">适用条件：{selected.condition}</p>}
    <p className="standard-stats">{profile.criteria.length} 项判断 · {usages.length} 个已有对象保留创建时标准</p>
   </header>
   {field('标准名称',readonly?standardLabel(profile):profile.label,value=>change(p=>{p.label=value;}))}
   <div className="standard-criteria" key={profile.id}>
   {profile.criteria.map((criterion,index)=><details className="standard-criterion" key={criterion.id}>
    <summary><span className="standard-number">{index+1}</span><span><b>{readable(criterion.label)}</b><span className="standard-question">{readable(criterion.question)}</span></span><span className="standard-edit-hint">{readonly?'详情':'编辑'}</span></summary>
    <div className="standard-criterion-editor">
     {field('判断标题',criterion.label,value=>changeCriterion(index,c=>{c.label=value;}))}
     {field('判断问题',criterion.question,value=>changeCriterion(index,c=>{c.question=value;}),true)}
     <details className="standard-advanced"><summary>高级设置</summary><label><input type="checkbox" disabled={readonly || profile.subjectKind==='EPISODE_PLAN'} checked={criterion.allowNA} onChange={e=>changeCriterion(index,c=>{c.allowNA=e.target.checked;})}/>允许选择不适用</label><label><input type="checkbox" disabled={readonly || profile.subjectKind==='EPISODE_PLAN'} checked={criterion.noteRequiredOnFail} onChange={e=>changeCriterion(index,c=>{c.noteRequiredOnFail=e.target.checked;})}/>不通过时须说明</label></details>
     {!readonly && <div className="configuration-row-actions"><button disabled={index===0} onClick={()=>change(p=>{[p.criteria[index-1],p.criteria[index]]=[p.criteria[index],p.criteria[index-1]];})}>上移</button><button disabled={index===profile.criteria.length-1} onClick={()=>change(p=>{[p.criteria[index+1],p.criteria[index]]=[p.criteria[index],p.criteria[index+1]];})}>下移</button>{profile.subjectKind!=='EPISODE_PLAN' && <button disabled={profile.criteria.length===1} onClick={()=>change(p=>{p.criteria.splice(index,1);})}>移除此项</button>}</div>}
    </div>
   </details>)}
   </div>
   {profile.subjectKind==='EPISODE_PLAN'?<details className="standard-special"><summary>首集与末集的特殊判断</summary>{field('首集开场判断',profile.firstQuestion || '',value=>change(p=>{p.firstQuestion=value;}),true)}{field('末集收束判断',profile.lastQuestion || '',value=>change(p=>{p.lastQuestion=value;}),true)}</details>:!readonly && <button onClick={()=>{const id=`criterion-${crypto.randomUUID()}`;change(p=>{p.criteria.push({id,label:'新增判断',question:'请填写具体判断问题',required:true,allowNA:false,noteRequiredOnFail:true});});}}>添加判断</button>}
   <details className="standard-usage"><summary>使用情况与已有对象（{usages.length}）</summary><p>这里编辑的是新对象默认使用的标准。已有对象的实际判断保留在下面；仅勾选的对象会纳入升级预览。</p>
    {usages.map(binding=>{const spec=state.boundStandards?.find(s=>s.hash===binding.reviewSpecHash);return <details key={binding.key} className="standard-bound"><summary>{binding.title || '已有对象'} · 创建时标准</summary>{spec?<ol>{spec.criteria.map(c=><li key={c.id}><b>{readable(c.label)}</b><p>{readable(c.question)}</p></li>)}</ol>:<p>此版本未提供完整判断内容，不能按当前默认补齐。</p>}{!readonly && <label><input type="checkbox" checked={upgradeKeys.includes(binding.key)} onChange={e=>onUpgrade(e.target.checked?[...upgradeKeys,binding.key]:upgradeKeys.filter(k=>k!==binding.key))}/>将此对象纳入升级预览</label>}</details>;})}
    {!usages.length && <p>暂无已创建对象。未来对象会在创建时固定当时发布的标准。</p>}
   </details>
   <details className="standard-technical"><summary>技术详情</summary><p>标准标识：{peers.join('、')}</p><p>判断标识：{profile.criteria.map(c=>c.id).join('、')}</p></details>
  </section>
 </div>;
}
