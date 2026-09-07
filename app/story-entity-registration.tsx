'use client';

import {useState} from 'react';
import type {DomainConfiguration,DomainEntity} from '../host/instance-runtime/domain-model.mjs';
import {SettingsDetailDialog} from './settings-detail-dialog';

export function StoryEntityRegistration({initial,configuration,busy,onSave,onClose}:{initial:DomainEntity;configuration:DomainConfiguration;busy:boolean;onSave:(entity:DomainEntity)=>Promise<void>;onClose:()=>void}){
  const [entity,setEntity]=useState(initial);
  const [aliases,setAliases]=useState(initial.aliases.join('，'));
  const [error,setError]=useState('');
  const location=initial.type==='LOCATION',title=location?'登记地点':'登记主体';
  async function save(){
    if(busy||!entity.name.trim())return;
    setError('');
    try{await onSave({...entity,name:entity.name.trim(),description:entity.description.trim(),aliases:[...new Set(aliases.split(/[，,；;\n]/).map(value=>value.trim()).filter(Boolean))]});}
    catch(reason){setError(reason instanceof Error?reason.message:'保存未完成，请保留输入并重试。');}
  }
  return <SettingsDetailDialog enabled label={title} onRequestClose={()=>{if(!busy)onClose();}}>
    <section className="settings-detail settings-registration">
      <header><h2>{title}</h2><button type="button" aria-label={'关闭'+title} disabled={busy} onClick={onClose}>×</button></header>
      <p>填写已知信息，保存为设定草稿；确认本模块更新后生效。</p>
      <form onSubmit={event=>{event.preventDefault();void save();}}>
        <fieldset disabled={busy}>
          <div className="settings-registration-basics"><label>{location?'地点名称':'主体名称'}<input autoFocus required value={entity.name} onChange={event=>setEntity(current=>({...current,name:event.target.value}))}/></label>{!location&&<label>主体类型<select value={entity.type} onChange={event=>setEntity(current=>({...current,type:event.target.value}))}>{configuration.entityTypes.filter(type=>type.id!=='LOCATION'&&type.id!=='UNRESOLVED').map(type=><option key={type.id} value={type.id}>{type.label}</option>)}</select></label>}</div>
          <label>关键信息<textarea rows={4} value={entity.description} onChange={event=>setEntity(current=>({...current,description:event.target.value}))} placeholder={location?'空间结构、入口或剧情中的用途':'身份、特点及在故事中的作用'}/></label>
          <label>别名（选填）<input value={aliases} onChange={event=>setAliases(event.target.value)} placeholder="多个别名用逗号分隔"/></label>
        </fieldset>
        {error&&<p role="alert">{error}</p>}
        <footer className="settings-registration-actions"><button type="button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="management-primary" disabled={busy||!entity.name.trim()}>{busy?'正在保存…':'保存草稿'}</button></footer>
      </form>
    </section>
  </SettingsDetailDialog>;
}
