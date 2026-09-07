'use client';

import type {DomainConfiguration,DomainEntity} from '../host/instance-runtime/domain-model.mjs';
import type {LocationVisual} from '../host/instance-runtime/domain-reading.mjs';
import type {SpatialEvidence} from '../host/instance-runtime/domain-workspaces.mjs';
import {LocationVisualGallery} from './location-visual-gallery';
import {SettingsImagePreview} from './settings-image-preview';
import {visibleText} from './review-semantics';

export function StoryLocationDetails({entity,configuration,spatial,visuals}:{entity:DomainEntity;configuration:DomainConfiguration;spatial:SpatialEvidence|null;visuals:LocationVisual[]}){
  const location=spatial?.locations?.find(row=>row.id===entity.id);
  const maps=spatial?.mapCards?.filter(map=>map.locationIds?.includes(entity.id)&&map.imageUrl)||[];
  const facts=[['入口',location?.entrance],['空间事实',location?.fact],['制作基线',location?.lock]].filter(([,value])=>value);
  return <div className="settings-location-detail">
    {entity.description&&<p className="settings-full-text">{visibleText(entity.description)}</p>}
    {!!entity.aliases.length&&<p className="settings-scope-note">别名：{entity.aliases.map(visibleText).join('、')}</p>}
    {!!facts.length&&<dl className="settings-facts">{facts.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{visibleText(value!)}</dd></div>)}</dl>}
    {!!maps.length&&<section aria-label="空间基线图片"><h3>空间结构</h3><div className="settings-space-maps">{maps.map(map=><figure key={map.id}><SettingsImagePreview src={map.imageUrl!} label={visibleText(map.label)}/><figcaption><strong>{visibleText(map.label)}</strong>{map.note&&<p>{visibleText(map.note)}</p>}</figcaption></figure>)}</div></section>}
    <LocationVisualGallery items={visuals} configuration={configuration}/>
  </div>;
}
