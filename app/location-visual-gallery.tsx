'use client';
import {useState} from 'react';
import type {LocationVisual} from '../host/instance-runtime/domain-reading.mjs';
import type {DomainConfiguration} from '../host/instance-runtime/domain-model.mjs';
import {useRuntimeMode} from './runtime-mode';
import {visibleText} from './review-semantics';
import {SettingsImagePreview} from './settings-image-preview';
function VisualCard({item,configuration}:{item:LocationVisual;configuration:DomainConfiguration}){
 const {hostedReadOnly}=useRuntimeMode();const [failed,setFailed]=useState<Set<string>>(()=>new Set());
 const version=item.version,original=hostedReadOnly?version?.previewUrl:version?.imageUrl;
 const src=original&&!failed.has(original)?original:version?.previewUrl&&!failed.has(version.previewUrl)?version.previewUrl:null;
 const dimensions=Object.entries(item.dimensions).filter(([,value])=>value&&value!=='UNKNOWN');
 return <article className="settings-location-visual" data-representation-id={item.representationId} data-version-id={version?.id} data-version-sha={version?.sha256}>
  {src?<SettingsImagePreview src={src} label={visibleText(item.label)} onError={()=>setFailed(current=>new Set([...current,src]))}/>:<div className="settings-visual-empty">{version?'此版本图片暂不可读取':'尚无已登记图片'}</div>}
  <div><h4>{visibleText(item.label)}</h4>{item.association==='COMPOSITE_MEMBER'&&<p>组合空间 · {visibleText(item.compositeName||'已登记组合')}</p>}
  <dl>{dimensions.map(([key,value])=><div key={key}><dt>{configuration.stateDimensions.find(d=>d.id===key)?.label||({viewpoint:'视角／机位',time:'时辰',weather:'天气'} as Record<string,string>)[key]||key}</dt><dd>{visibleText(value)}</dd></div>)}</dl>
  {!dimensions.length&&<p>视角、时辰与天气尚未完整登记</p>}<small>{version?({RELEASED:'已通过',REVIEW_PENDING:'待审阅',REVISION_REQUIRED:'需修改'} as Record<string,string>)[version.lifecycleState]||'已登记':'待补图片'}</small></div>
 </article>;
}
export function LocationVisualGallery({items,configuration}:{items:LocationVisual[];configuration:DomainConfiguration}){
 return <section className="settings-location-gallery" aria-label="地点视觉资料"><h3>地点视觉资料</h3><p>按已登记表现查看空间、机位与状态；组合空间图片明确标注成员归属。</p>{!items.length?<p>尚无精确关联的地点图片。</p>:[...new Set(items.map(item=>item.type))].map(type=><section key={type}><h4>{configuration.representationTypes.find(row=>row.id===type)?.label||type}</h4><div className="settings-location-visuals">{items.filter(item=>item.type===type).map(item=><VisualCard key={item.representationId+':'+item.familyId} item={item} configuration={configuration}/>)}</div></section>)}</section>;
}
