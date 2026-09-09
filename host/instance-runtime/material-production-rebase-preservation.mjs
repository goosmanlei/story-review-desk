import {canonicalJson,sha256} from './bytes.mjs';
import {domainHash} from './domain-model.mjs';
import {inspectExecutionDefinitionHash} from './execution-definition-hash.mjs';
import {materialProductionRebaseIdentity} from './material-production-rebase-identity.mjs';
import {assertFailedMaterialAttempt,materialEventBinding} from './material-production-failed-attempt.mjs';

const SCHEMA='MATERIAL_PRODUCTION_REQUIREMENT_REBASE_V1';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const fail=message=>{throw Object.assign(new Error(message),{code:'MATERIAL_PRODUCTION_SOURCE_CONFLICT'});};
const check=(ok,message)=>{if(!ok)fail(message);};
const one=(rows,id,label)=>{const found=(rows||[]).filter(r=>r.id===id);check(found.length===1,label+'必须精确且唯一');return found[0];};
const without=(v,keys)=>Object.fromEntries(Object.entries(v||{}).filter(([k])=>!keys.includes(k)));
const familyMutable=['versionRefs','currentVersionId','latestVersionId','expectedOutputRefs','currentExpectedOutputId','domainContext','lifecycleState','reviewDecision','publishState','referenceEligible','generationAllowed'];
const workMutable=['executionDefinitionRef','promptRef','inputAssetRefs','lifecycleState','reviewDecision','publishState','generationAllowed'];
const outputMutable=['id','targetPath','plannedVersionLabel','legacyVersionId','expectationState','realizedVersionId','sourceRef','executionDefinitionRef'];
const definitionMutable=['id','currentRevisionId','definitionHash','sourceRef','sourceRevisionId','sourceSha256','upload','model','parameters','parametersRaw','prompt','output','rawSourceBlock','authoringContent','parentVersionId','parentVersionSha256','materialRequirementHash','materialProductionRequirementRebaseId'];
const baselineFour=closure=>closure.body.rebase?.after||{demand:closure.body.basis.demand,representation:closure.body.graphBinding.afterRepresentation,entity:closure.body.basis.entity,state:closure.body.basis.state};
const baselineSource=closure=>({sourcePath:closure.plan.sourcePath,sourceRevisionId:closure.doc.revisionId,sourceSha256:closure.doc.sha256,requirementHash:closure.plan.requirementHash});
function source(documents,{revisionId,sha256:hash,path},role){
 const found=(documents||[]).filter(d=>d.revisionId===revisionId);
 check(found.length===1,'需求重基线缺少唯一固定源修订');const doc=found[0];
 check(!doc.deleted&&doc.sha256===hash&&sha256(doc.bytes)===hash&&doc.aliases?.includes(path)&&doc.metadata?.sourceRole===role,'需求重基线固定源身份、路径、角色或SHA不一致');
 let body;try{body=JSON.parse(Buffer.from(doc.bytes).toString('utf8'));}catch{fail('需求重基线固定源不是合法JSON');}
 return {doc,body};
}
function graphEvidence(documents,declared,published,expectedGraphRef,rows,instanceId){
 check(declared&&published&&same(without(published,['revisionId']),declared)&&typeof published.revisionId==='string','重基线领域证据源缺少实际发布修订');
 check(declared.graphRevisionId===expectedGraphRef.revisionId&&declared.graphSha256===expectedGraphRef.sha256&&declared.sha256===declared.graphSha256&&declared.path==='story/material-production/domain-bases/'+declared.graphRevisionId+'.json','重基线领域证据源未绑定原精确图修订');
 const {doc,body:graph}=source(documents,published,'MATERIAL_PRODUCTION_DOMAIN_BASIS');
 check(doc.metadata.graphRevisionId===declared.graphRevisionId&&doc.metadata.graphSha256===declared.graphSha256&&doc.metadata.instanceId===instanceId&&domainHash(graph)===declared.graphSha256,'重基线领域证据原字节、实例或图哈希不一致');
 check(graph.schemaVersion==='1.0','重基线领域图版本无效');
 const demand=one(graph.requirements,rows.demand.id,'领域证据需求'),representation=one(graph.representations,rows.representation.id,'领域证据表现'),entity=one(graph.entities,rows.entity.id,'领域证据实体'),state=rows.state===null?null:one(graph.states,rows.state.id,'领域证据状态');
 check(same({demand,representation,entity,state},rows),'重基线四行不等于精确领域图原行');
}
function contextProof(model,context){
 check(context&&context.id&&context.contextHash===domainHash(without(context,['contextHash'])),'重基线审阅上下文哈希不一致');
 check(same(one(model.reviewContexts,context.id,'重基线历史审阅上下文'),context),'重基线历史审阅上下文被删除或覆盖');
 return context.id;
}
function commonRebase({model,recipes,documents,initial,previous,c,baseline,ancestors}){
 const {row,body,doc}=c,plan=initial.plan,rb=body.basis?.revision,proof=body.rebase;
 check(row.schemaVersion===SCHEMA&&row.rebaseId===row.id&&body.schemaVersion===SCHEMA&&body.mode==='REQUIREMENT_REBASE'&&body.basis?.mode==='REQUIREMENT_REBASE'&&/^MP-REBASE-[a-f0-9]{24}$/.test(row.id)&&row.sourcePath==='story/material-production/requirement-rebases/'+row.id+'.json','重基线schema、mode、身份或专用源路径不一致');
 check(Number.isSafeInteger(body.operationEventSequence)&&body.operationEventSequence>=0,'重基线缺少实际全局操作水位');
 check(body.id===row.id&&body.sourcePath===row.sourcePath&&body.materialProductionPlanId===plan.id&&row.materialProductionPlanId===plan.id&&row.requirementId===plan.requirementId&&body.requirementId===plan.requirementId&&row.representationId===plan.representationId&&body.representationId===plan.representationId&&row.familyId===plan.familyId&&row.workItemId===plan.workItemId,'重基线不能改变原计划、需求、表现、族或工作身份');
 check(proof&&Object.keys(proof).sort().join(',')==='acknowledgement,after,afterHash,before,beforeHash,changes,domainSources,graphRef,previousBaseline','重基线语义证明字段不完整或包含未知协议字段');
 let identity;try{identity=materialProductionRebaseIdentity({before:proof.before,after:proof.after});}catch(e){fail('重基线身份/范围证明无效：'+e.message);}
 check(same(identity,{beforeHash:proof.beforeHash,afterHash:proof.afterHash,changes:proof.changes})&&same(proof.before,baselineFour(baseline))&&same(proof.previousBaseline,baselineSource(baseline)),'重基线未承接原始或最近已验证语义基线');
 const beforeHash=domainHash({demand:proof.before.demand,representation:proof.before.representation}),afterHash=domainHash({demand:proof.after.demand,representation:proof.after.representation});
 check(beforeHash===baseline.plan.requirementHash&&body.requirementBefore?.requirementHash===beforeHash&&body.requirementAfter?.requirementHash===afterHash&&row.requirementHash===afterHash&&body.basis.requirementHash===afterHash&&body.basisHash===row.basisHash&&domainHash(body.basis)===row.basisHash,'重基线需求或作者基线哈希不一致');
 const projection={title:proof.after.demand.title,entityRef:proof.after.entity.id,stateRef:proof.after.representation.stateId,mediaType:proof.after.demand.mediaType,category:proof.after.demand.category,reuseScope:proof.after.demand.reuseScope,scopeBindings:proof.after.demand.scope,acceptanceCriteria:proof.after.demand.acceptanceCriteria,sourceBindings:proof.after.demand.evidence,acceptanceProfile:proof.after.representation.type};
 for(const [key,value]of Object.entries(projection))check(same(body.requirementAfter[key],value),'重基线新需求投影未由精确领域原行派生：'+key);
 check(body.requirementAfter.sourceKind==='DOMAIN_GRAPH'&&body.requirementAfter.requirementClass==='REQUIRED','重基线新需求不是当前领域生产需求');
 const beforeRequirement=baseline.body.requirementAfter;
 check(same(body.requirementBefore,beforeRequirement),'重基线旧需求投影不是精确有效来源基线');
 for(const req of [body.requirementBefore,body.requirementAfter])check(req.id===plan.requirementId&&req.representationRef===plan.representationId&&same(req.assetFamilyRefs,[plan.familyId]),'重基线需求投影改变身份/族');
 check(body.requirementAfter.materialWorkItemRef===plan.workItemId&&body.requirementAfter.plannedAssetFamilyId===plan.familyId,'重基线新需求缺少唯一制作成员绑定');
 for(const key of ['reviewSpec','configurationBinding'])check(same(body.requirementBefore[key],body.requirementAfter[key]),'重基线不得修改原冻结审阅标准或配置');
 check(same({demand:body.basis.demand,representation:body.basis.representation,entity:body.basis.entity,state:body.basis.state},proof.after)&&same(body.basis.graphRef,proof.graphRef),'重基线作者基线与新领域四行不一致');
 const ack=proof.acknowledgement;
 check(ack&&Object.keys(ack).sort().join(',')==='afterHash,beforeHash,confirmed,note'&&ack.confirmed===true&&ack.beforeHash===proof.beforeHash&&ack.afterHash===proof.afterHash&&typeof ack.note==='string'&&ack.note.trim()&&ack.note.length<=20000,'重基线缺少明确的新旧语义确认');
 check(rb&&typeof rb.instanceId==='string'&&rb.instanceId.length>0,'重基线缺少原实例身份');
 const oldGraph=baseline.body.rebase?.graphRef||{revisionId:initial.plan.graphRevisionId,sha256:initial.plan.graphSha256};
 const beforeInstanceId=baseline.body.rebase?baseline.body.basis.revision.instanceId:initial.body.workContext.scopeId;
 check(typeof beforeInstanceId==='string'&&beforeInstanceId.length>0,'重基线旧领域源缺少固定实例身份');
 for(const name of ['before','after'])graphEvidence(documents,proof.domainSources?.[name],row.domainSources?.[name],name==='before'?oldGraph:proof.graphRef,proof[name],name==='before'?beforeInstanceId:rb.instanceId);
 check(rb.materialProductionPlanId===plan.id&&rb.familyId===plan.familyId&&rb.workItemId===plan.workItemId&&body.previousDefinitionId===row.previousDefinitionId&&body.previousExpectedOutputId===row.previousExpectedOutputId&&rb.definitionId===row.previousDefinitionId&&rb.expectedOutputId===row.previousExpectedOutputId&&row.previousDefinitionId===previous.executionDefinition.id&&row.previousExpectedOutputId===previous.expectedOutput.id&&rb.definitionHash===previous.executionDefinition.definitionHash&&rb.expectedOutputHash===domainHash(previous.expectedOutput),'重基线缺少精确紧邻旧定义/预期产物闭包');
 const candidate=body.parentCandidate;
 check(candidate&&candidate.familyId===plan.familyId&&candidate.versionId===row.parentVersionId&&candidate.sha256===row.parentVersionSha256&&/^[a-f0-9]{64}$/.test(row.parentVersionSha256||'')&&body.parentVersionId===row.parentVersionId&&body.parentVersionSha256===row.parentVersionSha256&&rb.parentVersionId===row.parentVersionId&&rb.parentVersionSha256===row.parentVersionSha256&&rb.parentCandidate?.eventId===candidate.eventId&&rb.parentCandidate?.sha256===domainHash(candidate)&&candidate.eventId&&candidate.runId&&candidate.executionRequestId,'重基线缺少精确实际父候选源证据');
 const parentDefinition=one(recipes.executionDefinitions,candidate.executionDefinitionId,'父候选调用定义'),parentOutput=one(model.expectedOutputs,candidate.expectedOutputId,'父候选预期产物');
 check(inspectExecutionDefinitionHash(parentDefinition).valid&&parentDefinition.definitionHash===candidate.callPackageHash&&parentDefinition.output?.assetFamilyRef===row.familyId&&parentDefinition.output?.expectedOutputRef===parentOutput.id&&parentOutput.familyId===row.familyId&&candidate.path===parentOutput.targetPath&&candidate.versionId===row.familyId+'@'+parentOutput.plannedVersionLabel,'重基线父候选与真实冻结调用输出不一致');
 if(rb.failedAttempt){
  const p=rb.failedAttempt,previousDefinition=one(recipes.executionDefinitions,row.previousDefinitionId,'失败调用定义'),previousSources=documents.filter(d=>d.revisionId===previousDefinition.sourceRevisionId);
  assertFailedMaterialAttempt(p,{definition:previousDefinition,output:one(model.expectedOutputs,row.previousExpectedOutputId,'失败预期产物'),parentCandidate:candidate,parentDefinition,parentOutput,sourceDocument:previousSources.length===1?previousSources[0]:null,fail});
  check(ancestors.some(a=>a.definitionId===parentDefinition.id&&a.output.id===parentOutput.id)&&parentDefinition.id!==previousDefinition.id,'重基线失败尝试的父候选不属于更早已验证祖先');
  const src=d=>({path:d.sourceRef,revisionId:d.sourceRevisionId,sha256:d.sourceSha256});
  check(same(p.source,src(previousDefinition))&&same(p.parentSource,src(parentDefinition))&&p.requestHeads.every(e=>(rb.requestHeads||[]).some(h=>same(h,e)))&&p.runHeads.every(e=>(rb.runHeads||[]).some(h=>same(h,e)))&&(rb.runHeads||[]).some(h=>same(h,materialEventBinding(p.parentRun))),'重基线失败尝试缺少真实固定请求/运行来源');
 }else check(candidate.executionDefinitionId===previous.executionDefinition.id&&candidate.expectedOutputId===previous.expectedOutput.id&&candidate.callPackageHash===previous.executionDefinition.definitionHash,'重基线实际父候选不是紧邻已实现版本');
 const definition=one(recipes.executionDefinitions,row.definitionId,'重基线新调用定义'),output=one(model.expectedOutputs,row.expectedOutputId,'重基线新预期产物'),family=body.assetFamily,work=body.materialWorkItem,envelope={sourceRef:row.sourcePath,sourceRevisionId:doc.revisionId,sourceSha256:doc.sha256};
 check(inspectExecutionDefinitionHash(definition).valid&&definition.definitionHash===row.definitionHash&&same(definition,{...body.executionDefinition,...envelope})&&definition.workItemRef===plan.workItemId&&definition.materialProductionPlanId===plan.id&&definition.materialRequirementRef===plan.requirementId&&definition.materialRequirementHash===afterHash&&definition.materialProductionRequirementRebaseId===row.id&&definition.parentVersionId===row.parentVersionId&&definition.parentVersionSha256===row.parentVersionSha256,'重基线新定义或父SHA不一致');
 check(same(without(definition,definitionMutable),without(previous.executionDefinition,definitionMutable)),'重基线不得修改调用定义的冻结用途/技术规格/协议字段');
 const prompt=one(recipes.promptRevisions,definition.currentRevisionId,'重基线提示词');
 check(same(prompt,{...body.promptRevision,...envelope})&&prompt.executionDefinitionId===definition.id&&prompt.definitionHash===definition.definitionHash&&same(prompt.prompt,definition.prompt),'重基线提示词与定义不一致');
 const label='V'+String(Number(previous.expectedOutput.plannedVersionLabel.slice(1))+1).padStart(3,'0');
 check(/^V\d{3,}$/.test(previous.expectedOutput.plannedVersionLabel||'')&&output.plannedVersionLabel===label&&rb.plannedVersionLabel===label&&output.legacyVersionId===plan.expectedOutputId&&output.materialProductionPlanId===plan.id&&output.familyId===plan.familyId&&output.executionDefinitionRef===definition.id&&output.sourceRef===row.sourcePath&&same(without(output,['expectationState','realizedVersionId']),without(body.expectedOutput,['expectationState','realizedVersionId']))&&same(without(output,outputMutable),without(previous.expectedOutput,outputMutable)),'重基线须按同族顺序追加新预期产物');
 check(definition.output?.assetFamilyRef===plan.familyId&&definition.output?.expectedOutputRef===output.id&&definition.output?.mediaType===initial.body.assetFamily.kind&&definition.output?.path===output.targetPath&&output.targetPath==='media/_review_pending/material-production/'+plan.familyId+'/'+label+(definition.output.mediaType==='IMAGE'?'.png':'.wav'),'重基线输出路径或媒介改变');
 check(family?.id===plan.familyId&&same(without(family,familyMutable),without(previous.assetFamily,familyMutable))&&family.currentExpectedOutputId===output.id&&same(family.expectedOutputRefs,[...previous.assetFamily.expectedOutputRefs,output.id]),'重基线不得重建素材族或丢失旧预期产物');
 check(work?.id===plan.workItemId&&same(without(work,[...workMutable,'requirementHash','reviewContextRef','materialProductionRequirementRebaseId']),without(previous.materialWorkItem,[...workMutable,'requirementHash','reviewContextRef','materialProductionRequirementRebaseId']))&&work.requirementHash===afterHash&&work.materialProductionRequirementRebaseId===row.id&&work.executionDefinitionRef===definition.id&&work.promptRef===prompt.id&&work.reviewContextRef===body.workContext?.id,'重基线不得改工作归属或原冻结配置/审阅标准');
 const inputs=body.inputBindings;
 check(Array.isArray(inputs)&&same(inputs,body.authoringContent?.inputBindings)&&new Set(inputs.map(b=>b.familyId)).size===inputs.length&&same(work.inputAssetRefs,inputs.map(b=>b.familyId))&&same((definition.upload?.items||[]).map(b=>({familyId:b.assetFamilyRef,versionId:b.assetVersionRef,sha256:b.sha256})),inputs),'重基线输入与调用包不一致');
 const ctx=body.workContext;
 check(ctx?.materialProductionRequirementRebaseId===row.id&&ctx.requirementId===plan.requirementId&&ctx.requirementHash===afterHash&&ctx.representationId===plan.representationId&&ctx.scopeType==='PROJECT'&&ctx.scopeId===rb.instanceId&&same(ctx.sourceRefs,[row.sourcePath])&&same(ctx.binding,{requirementId:plan.requirementId,requirementHash:afterHash,domainContextHash:family.domainContext.hash,bindingStatus:'CURRENT',mismatchReasons:[]})&&same(ctx.judgment,{purpose:{class:'A',text:body.requirementAfter.title,evidenceRefs:[row.sourcePath]},acceptanceCriteria:body.requirementAfter.acceptanceCriteria||[]}), '重基线新审阅上下文与当前需求不一致');
 contextProof(model,ctx);
 return {...c,definition,output,initial};
}

/** Each legacy segment is verified by the unchanged legacy algorithm, anchored
 * only in an independently checked rebase source. Synthetic views are local
 * validation inputs, never rewritten plans, source documents or catalog records.
 */
export function materialProductionRebaseClosures({model,recipes,documents,initialClosures,validateLegacySegment}){
 check(typeof validateLegacySegment==='function','缺少原后继版本验证器');
 const rows=model.materialProductionRecipeRevisions||[];
 for(const row of rows)if(Object.hasOwn(row,'schemaVersion'))check([SCHEMA,'MATERIAL_PRODUCTION_RECIPE_V1'].includes(row.schemaVersion),'未知基础素材后继源schema');
 const marked=rows.some(r=>r.schemaVersion===SCHEMA||Object.hasOwn(r,'rebaseId'))||(model.materialWorkItems||[]).some(w=>Object.hasOwn(w,'materialProductionRequirementRebaseId'))||(recipes.executionDefinitions||[]).some(d=>Object.hasOwn(d,'materialProductionRequirementRebaseId'));
 if(!marked)return {revisions:validateLegacySegment({model,recipes,documents,initialClosures}),anchors:initialClosures,contextIds:initialClosures.map(c=>c.body.workContext.id)};
 for(const key of ['id','definitionId','expectedOutputId'])check(new Set(rows.map(r=>r[key])).size===rows.length,'重基线链出现重复身份');
 check(new Set(initialClosures.map(c=>c.plan.id)).size===initialClosures.length,'重基线原计划重复');
 for(const row of rows)check(initialClosures.some(c=>c.plan.id===row.materialProductionPlanId),'重基线链缺少原始计划');
 const parsed=rows.map(row=>({row,...source(documents,{revisionId:row.sourceRevisionId,sha256:row.sourceSha256,path:row.sourcePath},row.schemaVersion===SCHEMA?'MATERIAL_PRODUCTION_REQUIREMENT_REBASE':'MATERIAL_PRODUCTION_RECIPE')}));
 const revisions=[],anchors=[],contexts=new Set();
 for(const initial of initialClosures){
  contextProof(model,initial.body.workContext);contexts.add(initial.body.workContext.id);
  let baseline=initial,previous=initial.body,segment=[];const visited=new Set(),chain=parsed.filter(c=>c.row.materialProductionPlanId===initial.plan.id),ancestors=[];
  const flush=()=>{
   if(!segment.length)return;
   const tail=segment.at(-1).body,familyId=initial.plan.familyId,workId=initial.plan.workItemId;
   const view={...model,materialProductionRecipeRevisions:segment.map(c=>c.row),assetFamilies:(model.assetFamilies||[]).map(f=>f.id===familyId?tail.assetFamily:f),materialWorkItems:(model.materialWorkItems||[]).map(w=>w.id===workId?tail.materialWorkItem:w),expectedOutputs:(model.expectedOutputs||[]).filter(o=>o.familyId!==familyId||tail.assetFamily.expectedOutputRefs.includes(o.id))};
   const verified=validateLegacySegment({model:view,recipes,documents,initialClosures:[baseline],verifiedAncestors:ancestors.filter(a=>a.definitionId===initial.body.executionDefinition.id||revisions.some(c=>c.definition.id===a.definitionId))});
   check(verified.length===segment.length&&same(verified.map(c=>c.row.id).sort(),segment.map(c=>c.row.id).sort()),'原后继段验证结果不完整');
   revisions.push(...verified);segment=[];
  };
  while(true){
   const next=chain.filter(c=>c.row.previousDefinitionId===previous.executionDefinition.id);check(next.length<=1,'同族重基线/后继源不能分叉');if(!next.length)break;
   const c=next[0];check(!visited.has(c.row.id),'重基线后继链循环');visited.add(c.row.id);
   ancestors.push({definitionId:previous.executionDefinition.id,output:previous.expectedOutput});
   if(c.row.schemaVersion===SCHEMA){
    flush();const verified=commonRebase({model,recipes,documents,initial,previous,c,baseline,ancestors});revisions.push(verified);contexts.add(c.body.workContext.id);
    baseline={plan:{...initial.plan,requirementHash:c.row.requirementHash,sourcePath:c.row.sourcePath,sourceRevisionId:c.row.sourceRevisionId,sourceSha256:c.row.sourceSha256},body:c.body,doc:c.doc};
   }else{
    const marker=baseline.body.rebase?baseline.body.id:null;
    for(const actual of [c.row.rebaseId,c.body.basis?.revision?.rebaseId,c.body.materialWorkItem?.materialProductionRequirementRebaseId,c.body.executionDefinition?.materialProductionRequirementRebaseId])check(marker?actual===marker:actual===undefined,'普通后继源没有保留精确有效重基线身份');
    if(marker)check(same(without(c.body.executionDefinition,definitionMutable),without(previous.executionDefinition,definitionMutable)),'重基线后继改变冻结用途/技术规格');
    segment.push(c);
   }
   previous=c.body;
  }
  flush();check(visited.size===chain.length,'重基线链存在脱离初始计划的节点');
  const work=one(model.materialWorkItems,initial.plan.workItemId,'当前重基线工作项'),family=one(model.assetFamilies,initial.plan.familyId,'当前重基线素材族');
  check(same(without(work,['lifecycleState','reviewDecision','publishState','generationAllowed']),without(previous.materialWorkItem,['lifecycleState','reviewDecision','publishState','generationAllowed'])),'当前工作项未保留精确已验证链末端');
  check(same(without(family,familyMutable),without(previous.assetFamily,familyMutable))&&family.currentExpectedOutputId===previous.expectedOutput.id&&same(family.expectedOutputRefs,previous.assetFamily.expectedOutputRefs)&&same((model.expectedOutputs||[]).filter(o=>o.familyId===family.id).map(o=>o.id).sort(),[...previous.assetFamily.expectedOutputRefs].sort()),'当前素材族未保留全部原预期产物及精确后继末端');
  anchors.push(baseline);
 }
 return {revisions,anchors,contextIds:[...contexts]};
}
