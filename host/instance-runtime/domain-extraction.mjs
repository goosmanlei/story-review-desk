import {randomUUID} from 'node:crypto';
import {canonicalJson} from './bytes.mjs';
import {domainHash,defaultDomainConfiguration,validateInitializationContent,validateDomainGraph} from './domain-model.mjs';
import {currentGraph,evidenceBindings,verifyQuotes,validateIdentities} from './domain-service.mjs';
import {listDomainSources,verifySourceBindings} from './domain-sources.mjs';
import {getConfiguration} from './configuration-service.mjs';
const fail=message=>{throw Object.assign(new Error(message),{code:'DOMAIN_CONFLICT'});};
const read=r=>r?JSON.parse(r.bytes):null;
const save=(tx,namespace,key,value,expectedRevisionId)=>tx.putAux({namespace,key,bytes:Buffer.from(canonicalJson(value)),expectedRevisionId,mediaType:'application/json'});
const publicTask=record=>{if(!record)return null;const task=read(record);delete task.claimToken;return {...task,revisionId:record.revisionId};};
export async function getExtraction(tx){
 const view=await tx.readView(),input=await tx.getAux('setting-extraction-inputs','current'),task=await tx.getAux('setting-extraction-tasks','current');
 return {releaseId:view.releaseId,input:input?{revisionId:input.revisionId,baseReleaseId:read(input).baseReleaseId,sourceBindings:read(input).selectedSourceBindings}:null,task:publicTask(task),sources:(await listDomainSources(tx)).sources.map(s=>({sourceId:s.id,revisionId:s.documentRevisionId,sha256:s.documentSha256,title:s.title,textAvailable:s.textAvailable,observation:s.observation})),results:(await tx.listAux('setting-extraction-results')).map(r=>({revisionId:r.revisionId,taskId:r.key,summary:read(r).summary,uncertainties:read(r).uncertainties})),readOnly:false};
}
export async function prepareExtraction(tx,input){
 const view=await tx.readView();if(view.releaseId!==input.expectedReleaseId)fail('当前发布已变化，请重新选择资料');
 if(!view.profile.configurationRef&&view.snapshot.productionModel.initialization?.state!=='READY')fail('先确认系统规则，再整理设定草稿');
 const old=await tx.getAux('setting-extraction-inputs','current'),task=read(await tx.getAux('setting-extraction-tasks','current'));
 if(task&&['REQUESTED','RUNNING'].includes(task.state))fail('已有整理任务，不能替换正在使用的资料');
 if((old?.revisionId||null)!==input.expectedInputRevisionId)fail('抽取输入版本已变化');
 if(!Array.isArray(input.sourceBindings)||!input.sourceBindings.length||input.sourceBindings.length>1000||input.sourceBindings.some(b=>!b||typeof b.sourceId!=='string'||typeof b.revisionId!=='string'||! /^[a-f0-9]{64}$/.test(b.sha256||''))||new Set(input.sourceBindings.map(b=>b.sourceId)).size!==input.sourceBindings.length)fail('明确选择不重复且版本完整的来源资料（最多1000份）');
 const sources=(await listDomainSources(tx)).sources;
 for(const binding of input.sourceBindings)if(!sources.some(s=>s.id===binding.sourceId&&s.documentRevisionId===binding.revisionId&&s.documentSha256===binding.sha256))fail('选定资料已变化，不能使用旧或未知版本');
 await verifySourceBindings(tx,input.sourceBindings,{allowLegacy:true});
 const current=await currentGraph(tx,view),config=await getConfiguration(tx);
 const configuration={...config.configuration,schemaVersion:'2.0',domain:config.configuration.domain||defaultDomainConfiguration()};
 const sourceBindings=[...new Map([...evidenceBindings(current.graph),...input.sourceBindings].map(b=>[b.sourceId+':'+b.revisionId,b])).values()];
 const content={schemaVersion:'1.0',title:view.profile.storyTitle,summary:'',configuration,graph:current.graph,uncertainties:[],sourceBindings};
 const record=await save(tx,'setting-extraction-inputs','current',{baseReleaseId:view.releaseId,graphRevisionId:current.revisionId,configurationHash:domainHash(configuration),selectedSourceBindings:input.sourceBindings,content},old?.revisionId||null);
 return {revisionId:record.revisionId,aiAnalysisPerformed:false,formalAdoptionPerformed:false};
}
export async function prepareAndRequestExtraction(tx,input){
 const prior=await tx.getAux('setting-extraction-start-requests',input.requestId);
 if(prior){const receipt=read(prior);if(receipt.hash!==domainHash(input))fail('请求编号已用于不同整理任务');return receipt.result;}
 const prepared=await prepareExtraction(tx,{expectedReleaseId:input.expectedReleaseId,expectedInputRevisionId:input.expectedInputRevisionId,sourceBindings:input.sourceBindings});
 const result=await requestExtraction(tx,{inputRevisionId:prepared.revisionId,requestId:'prepared:'+input.requestId});
 await save(tx,'setting-extraction-start-requests',input.requestId,{hash:domainHash(input),result},null);
 return result;
}
export async function requestExtraction(tx,input){
 const prior=await tx.getAux('setting-extraction-requests',input.requestId);
 if(prior){const receipt=read(prior);if(receipt.hash!==domainHash(input))fail('请求编号已用于不同整理任务');return receipt.result;}
 const view=await tx.readView(),record=await tx.getAux('setting-extraction-inputs','current'),prepared=read(record);
 if(!record||record.revisionId!==input.inputRevisionId||prepared.baseReleaseId!==view.releaseId)fail('先重新准备并核对当前资料');
 const old=await tx.getAux('setting-extraction-tasks','current');if(old&&['REQUESTED','RUNNING'].includes(read(old).state))fail('已有整理任务，不能重复发起');
 await verifySourceBindings(tx,prepared.selectedSourceBindings,{allowLegacy:true});
 const task={taskId:'settings_extract_'+randomUUID(),state:'REQUESTED',inputRevisionId:record.revisionId,baseReleaseId:view.releaseId,requestedAt:new Date().toISOString(),capability:'SETTING_SUGGESTIONS_ONLY',observedMedia:[],formalAdoptionPerformed:false};
 const saved=await save(tx,'setting-extraction-tasks','current',task,old?.revisionId||null),result={...task,revisionId:saved.revisionId};
 await save(tx,'setting-extraction-requests',input.requestId,{hash:domainHash(input),result},null);return result;
}
export async function claimExtraction(tx,{workerId}){
 const record=await tx.getAux('setting-extraction-tasks','current'),task=read(record);if(task?.state!=='REQUESTED')return null;
 const inputRecord=await tx.getAux('setting-extraction-inputs','current'),input=read(inputRecord),view=await tx.readView();
 if(inputRecord?.revisionId!==task.inputRevisionId||view.releaseId!==task.baseReleaseId){await save(tx,'setting-extraction-tasks','current',{...task,state:'FAILED',error:'输入或发布已变化，未调用模型',providerEvidence:{status:'NOT_CALLED'}},record.revisionId);return null;}
 let sources;
 try{await verifySourceBindings(tx,input.selectedSourceBindings,{allowLegacy:true});
 sources=(await listDomainSources(tx,{includeText:true})).sources.filter(s=>input.selectedSourceBindings.some(b=>b.sourceId===s.id&&b.revisionId===s.documentRevisionId&&b.sha256===s.documentSha256));
 if(sources.length!==input.selectedSourceBindings.length)fail('冻结资料集合无法精确回读');
 }catch(error){await save(tx,'setting-extraction-tasks','current',{...task,state:'FAILED',error:String(error.message),providerEvidence:{status:'NOT_CALLED'}},record.revisionId);return null;}
 const next={...task,state:'RUNNING',workerId,claimToken:randomUUID(),startedAt:new Date().toISOString()};
 await save(tx,'setting-extraction-tasks','current',next,record.revisionId);return {task:next,content:input.content,sources};
}
export async function finishExtraction(tx,input){
 const record=await tx.getAux('setting-extraction-tasks','current'),task=read(record);
 if(!record||task.state!=='RUNNING'||task.taskId!==input.taskId||task.claimToken!==input.claimToken)fail('任务身份或状态不匹配');
 if(input.error){await save(tx,'setting-extraction-tasks','current',{...task,state:'FAILED',error:String(input.error).slice(0,2000),providerEvidence:input.providerEvidence||{status:'UNKNOWN'},completedAt:new Date().toISOString()},record.revisionId);return {state:'FAILED'};}
 const view=await tx.readView(),preparedRecord=await tx.getAux('setting-extraction-inputs','current'),prepared=read(preparedRecord);
 if(view.releaseId!==task.baseReleaseId||preparedRecord?.revisionId!==task.inputRevisionId)fail('资料或发布已变化，结果不能覆盖；请重新整理');
 const content=validateInitializationContent(input.content);
 for(const collection of ['entities','states','representations','relations'])for(const row of content.graph[collection])if(row.authority==='L'&&domainHash(row)!==domainHash(prepared.content.graph[collection].find(r=>r.id===row.id)||null))fail('AI新增或修改的制作建议不能冒充已锁定设定');
 for(const row of content.graph.relations)if(content.configuration.domain.relationTypes.find(t=>t.id===row.type)?.class==='REFERENCE'&&domainHash(row)!==domainHash(prepared.content.graph.relations.find(r=>r.id===row.id)||null)&&row.status!=='PROPOSED')fail('AI新增或修改的参考关系只能作为待确认建议');
 if(domainHash(content.configuration)!==prepared.configurationHash||domainHash(content.sourceBindings)!==domainHash(prepared.content.sourceBindings))fail('AI不能改变冻结配置或来源绑定');
 await verifySourceBindings(tx,content.sourceBindings,{allowLegacy:true});await verifyQuotes(tx,content.graph);await validateIdentities(tx,content.graph,view);
 validateDomainGraph(content.graph,{configuration:content.configuration.domain,sourceBindings:content.sourceBindings,knownFamilyIds:(view.snapshot.productionModel.assetFamilies||[]).map(r=>r.id),knownRequirementIds:(view.snapshot.productionModel.materialRequirements||[]).map(r=>r.id)});
 const result=await save(tx,'setting-extraction-results',task.taskId,{baseReleaseId:task.baseReleaseId,graph:content.graph,summary:content.summary,uncertainties:content.uncertainties,sourceBindings:prepared.selectedSourceBindings,configurationHash:prepared.configurationHash,providerEvidence:input.providerEvidence,formalAdoptionPerformed:false},null);
 await save(tx,'setting-extraction-tasks','current',{...task,state:'COMPLETED',resultRevisionId:result.revisionId,completedAt:new Date().toISOString(),providerEvidence:input.providerEvidence},record.revisionId);
 return {state:'COMPLETED',resultRevisionId:result.revisionId,formalAdoptionPerformed:false};
}
export async function failInterruptedExtraction(tx){
 const record=await tx.getAux('setting-extraction-tasks','current'),task=read(record);if(task?.state!=='RUNNING')return;
 await save(tx,'setting-extraction-tasks','current',{...task,state:'FAILED',error:'工作器重启，先前请求结果未知；未自动重试',executionOutcome:'UNKNOWN'},record.revisionId);
}
