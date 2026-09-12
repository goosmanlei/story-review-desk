'use client';
import type {Configuration} from '../presentation/configuration-model.mjs';
import type {ConfigurationState} from '../presentation/configuration-service.mjs';
import {defaultDomainConfiguration} from '../presentation/domain-defaults.mjs';
import {ImageTechnicalSpecPanel} from './image-technical-spec-panel';

export function ImagePurposeConfiguration({config,state,readonly,onEdit,upgradeKeys,onUpgrade}:{
 config:Configuration;state:ConfigurationState;readonly:boolean;
 onEdit:(edit:(config:Configuration)=>void)=>void;upgradeKeys:string[];onUpgrade:(keys:string[])=>void;
}) {
 const enabled=config.schemaVersion==='2.1' && Boolean(config.technical.imagePurposeProfiles);
 const available=state.bindings.filter(binding=>binding.imageTechnicalUpgradeEligible);
 const bound=state.bindings.filter(binding=>binding.technicalSpec && binding.technicalSpecHash);
 return <section aria-label="分阶段图像规格" className="configuration-card">
  <h3>分阶段图像规格</h3>
  <p>基础参考图和粗分镜保留原图尺寸；正式关键帧使用上方项目画布。视频和 Animatic 继续核对项目帧率与时长。</p>
  {enabled?<p role="status">已启用{state.configuration.schemaVersion==='2.1'?'':'（待保存、预览及发布）'}。新建制作任务将固定对应阶段的规格。</p>
   :<><p>当前使用已有统一规格。启用后，已建档素材仍保留原规格。</p>{!readonly && <button onClick={()=>onEdit(c=>{
    c.schemaVersion='2.1';
    c.domain ||= defaultDomainConfiguration();
    c.technical.imagePurposeProfiles={schemaVersion:'IMAGE_TECHNICAL_SPEC_V1',
     BASE_REFERENCE:{dimensionPolicy:'NATIVE_ORIGINAL',formats:['PNG']},
     PREVIS_STILL:{dimensionPolicy:'NATIVE_ORIGINAL',formats:['PNG']},
     PRODUCTION_FRAME:{dimensionPolicy:'EXACT_PROJECT_CANVAS',formats:['PNG']}};
   })}>启用分阶段图像规格</button>}</>}
  {enabled && <details><summary>为尚未建档的图片需求启用新规格（{available.length}）</summary>
   <p>仅勾选的需求会进入本次升级预览；已有产物和制作历史保留原规格。</p>
   {available.map(binding=><label className="configuration-field" key={binding.key}>
    <span><input type="checkbox" disabled={readonly} checked={upgradeKeys.includes(binding.key)} onChange={e=>onUpgrade(e.target.checked?[...new Set([...upgradeKeys,binding.key])]:upgradeKeys.filter(key=>key!==binding.key))}/>{binding.title || binding.key}</span>
   </label>)}
   {!available.length && <p>当前没有可单独升级的未建档图片需求。</p>}
  </details>}
  {bound.length>0 && <details><summary>已有图片的固定规格（{bound.length}）</summary>{bound.map(binding=><div key={binding.key}><b>{binding.title || binding.key}</b><ImageTechnicalSpecPanel spec={binding.technicalSpec} hash={binding.technicalSpecHash}/></div>)}</details>}
 </section>;
}
