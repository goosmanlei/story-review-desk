'use client';
import {useState} from 'react';
import type {Configuration} from '../host/instance-runtime/configuration-model.mjs';
import {managementMutation,readManagementResponse} from './system-management-client';

export function MaintenanceTransfer({onQueued}:{onQueued:()=>void}){
 const [file,setFile]=useState<File|null>(null),[directory,setDirectory]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
 async function run(task:()=>Promise<void>){setBusy(true);setError('');setMessage('');try{await task();}catch(e){setError(e instanceof Error?e.message:'操作未完成');}finally{setBusy(false);}}
 async function importBackup(upload:boolean){await run(async()=>{
  const source=upload?{uploadId:(await managementMutation<{uploadId:string}>('/api/instance/maintenance/upload',file)).uploadId}:{sourcePath:directory.trim()};
  await managementMutation('/api/instance/maintenance',{action:'import',...source});
  setMessage('备份已提交核验。通过后才能下载或恢复，不会覆盖当前实例。');setFile(null);setDirectory('');onQueued();
 });}
 async function exportTemplate(){await run(async()=>{const value=await readManagementResponse<unknown>(await fetch('/api/instance/configuration?export=1',{cache:'no-store'}));const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='review-configuration-template.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});}
 async function importTemplate(file:File){await run(async()=>{
  if(file.size>2*1024**2)throw Error('配置模板不能超过2MB');
  const template=JSON.parse(await file.text());if(template.kind!=='REVIEW_CONFIGURATION_TEMPLATE'||!template.configuration)throw Error('不是审阅台配置模板');
  const state=await readManagementResponse<{configuration:Configuration;revisionId:string|null;releaseId:string;draft?:{revisionId:string;published?:boolean}|null}>(await fetch('/api/instance/configuration',{cache:'no-store'}));
  if(state.draft&&!state.draft.published)throw Error('已有未发布配置草稿，请先在系统配置中处理后再导入模板');
  const configuration={...template.configuration,presentation:state.configuration.presentation,sources:{...template.configuration.sources,continuity:{...template.configuration.sources?.continuity,specAlias:state.configuration.sources.continuity.specAlias}}};
  await managementMutation('/api/instance/configuration',{configuration,expectedDraftRevision:state.draft?.revisionId||null,expectedReleaseId:state.releaseId,expectedConfigurationRevisionId:state.revisionId,upgradeKeys:[]},'PUT');
  setMessage('配置模板已保存为草稿；请到系统配置继续草稿、预览并确认发布。已有对象的冻结规则未改变。');
 });}
 return <section className="management-transfer"><h3>导入完整备份</h3><p>完整备份含业务历史与受管媒体，也可能含私有助手记录，请妥善保管。只读导出不能用于恢复。</p>
  <div className="management-form-grid"><label>备份文件<input type="file" accept=".review-backup.gz,application/gzip" disabled={busy} onChange={e=>setFile(e.target.files?.[0]||null)}/><button disabled={busy||!file} onClick={()=>void importBackup(true)}>上传并核验</button></label><label>或项目内已有备份目录<input value={directory} disabled={busy} onChange={e=>setDirectory(e.target.value)} placeholder="完整备份目录的绝对路径"/><button disabled={busy||!directory.trim()} onClick={()=>void importBackup(false)}>导入目录并核验</button></label></div>
  <details><summary>配置模板导入与导出</summary><p>仅转移通用规则，不含故事内容、媒体、凭证或正式审阅历史。</p><div className="management-actions"><button disabled={busy} onClick={()=>void exportTemplate()}>导出配置模板</button><label>导入并保存配置草稿<input type="file" accept=".json,application/json" disabled={busy} onChange={e=>{const f=e.target.files?.[0];e.target.value='';if(f)void importTemplate(f);}}/></label></div></details>
  {busy&&<p role="status">正在传输或登记，请保持当前页面打开…</p>}{error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
 </section>;
}
