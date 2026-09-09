import {canonicalJson,sha256} from './bytes.mjs';
import {materialProductionPlanGraphClosure} from './material-production-preservation.mjs';
import {materialProductionRevisionClosures} from './material-production-revision-preservation.mjs';
import {materialProductionRebaseClosures} from './material-production-rebase-preservation.mjs';

const SCHEMA='MATERIAL_PRODUCTION_REQUIREMENT_REBASE_V1';
const ROLE='MATERIAL_PRODUCTION_REQUIREMENT_REBASE';
const DOMAIN_ROLE='MATERIAL_PRODUCTION_DOMAIN_BASIS';
const roles=new Set(['MATERIAL_PRODUCTION_PLAN','MATERIAL_PRODUCTION_RECIPE',ROLE,DOMAIN_ROLE]);
const hash=value=>sha256(canonicalJson(value));
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const parse=bytes=>JSON.parse(Buffer.from(bytes).toString('utf8'));
const check=(ok,message)=>{if(!ok)throw Object.assign(Error(message),{code:'MATERIAL_PRODUCTION_REBASE_ARCHIVE'});};
const marker=row=>row?.schemaVersion===SCHEMA||Object.hasOwn(row||{},'rebaseId');
const markedPath=path=>path.startsWith('story/material-production/requirement-rebases/')||path.startsWith('story/material-production/domain-bases/');
const one=(rows,id,label)=>{const found=(rows||[]).filter(r=>r.id===id);check(found.length===1,label+'必须精确且唯一');return found[0];};
const latest=rows=>[...rows].sort((a,b)=>(Number(b.eventSequence)||0)-(Number(a.eventSequence)||0)||String(b.recordedAt||'').localeCompare(String(a.recordedAt||''))||String(b.eventId||'').localeCompare(String(a.eventId||'')))[0]||null;
const heads=(rows,key)=>[...new Set(rows.map(r=>r[key]).filter(Boolean))].map(id=>latest(rows.filter(r=>r[key]===id)));
const eventRef=e=>e?{eventId:e.eventId,eventSequence:e.eventSequence||null,sha256:e.sha256}:null;
const refSet=refs=>[...refs].sort((a,b)=>String(a.eventId).localeCompare(String(b.eventId)));
function validateHistoricalHeads({body,row,events,positions,doc,recipes}){
 const water=body.operationEventSequence;
 check(Number.isSafeInteger(water)&&water>=0&&(water===0||positions.has(water)),'重基线操作水位没有真实存储事件');
 for(const [sequence,time]of positions){check(sequence>water||time<=doc.createdAt,'重基线水位纳入了固定源之后的事件');check(time>=doc.createdAt||sequence<=water,'重基线水位遗漏了明确更早的事件');}
 const history=[...events.values()].filter(e=>e.storageSequence<=water),definitions=new Set(recipes.executionDefinitions.filter(d=>d.workItemRef===row.workItemId).map(d=>d.id));
 const requests=heads(history.filter(e=>e.eventKind==='execution-request'&&(e.workItemId===row.workItemId||e.familyId===row.familyId)),'executionRequestId'),requestIds=new Set(requests.map(r=>r.executionRequestId));
 const runs=heads(history.filter(e=>e.eventKind==='run'&&(definitions.has(e.executionDefinitionId)||requestIds.has(e.executionRequestId))),'runId');
 const reviews=history.filter(e=>e.eventKind==='review'&&e.applicationStatus==='APPLIED'&&e.effect==='APPLIED'&&e.subjectType==='ASSET'&&e.familyId===row.familyId),rb=body.basis.revision,parent=body.parentCandidate;
 check(same(refSet(requests.map(eventRef)),refSet(rb.requestHeads||[]))&&same(refSet(runs.map(eventRef)),refSet(rb.runHeads||[])),'重基线冻结水位的请求或Run头被遗漏或换绑');
 check(same(eventRef(latest(reviews)),rb.familyReviewHead)&&same(eventRef(latest(reviews.filter(e=>e.versionId===parent.versionId&&e.versionSha256===parent.sha256))),rb.parentReview),'重基线冻结水位的正式审阅头被旧结论替代');
 const candidates=history.filter(e=>e.eventKind==='asset-version'&&e.familyId===row.familyId),state=r=>String(r.runState||r.state||'RESULT_UNKNOWN');
 for(const run of runs){const registered=candidates.some(c=>c.runId===run.runId&&c.executionRequestId===run.executionRequestId&&c.executionDefinitionId===run.executionDefinitionId&&c.callPackageHash===run.callPackageHash);check(!['PLANNED','SUBMITTED','RUNNING','RESULT_UNKNOWN'].includes(state(run))&&(state(run)!=='SUCCEEDED'||registered),'重基线冻结水位仍有未核清Run或未登记的成功结果');}
 for(const request of requests){const count=new Set(candidates.filter(c=>c.executionRequestId===request.executionRequestId).map(c=>c.versionId)).size;if(count>=Math.max(1,Number(request.maxOutputs)||1))continue;const requestRuns=runs.filter(r=>r.executionRequestId===request.executionRequestId),s=String(request.requestState||request.status||'UNKNOWN');check(!['UNKNOWN','RESULT_UNKNOWN'].includes(s)&&(!['AUTHORIZED','CLAIMED'].includes(s)||requestRuns.length>0&&requestRuns.every(r=>['FAILED','CANCELLED'].includes(state(r)))),'重基线冻结水位仍有未完成授权');}
}

/** Companion to the complete archive byte scan. Historical releases retain
 * only digests, source pins and the few actual base members referenced by a
 * rebase source. Domain AUX revisions retain SHA/length, never graph bodies.
 * Runtime epochs belong to their original evidence and are not rewritten on
 * restore. This validator does not confer candidate adoption or media rights. */
export function createMaterialProductionRebaseArchiveValidator(){
 const documents=[],aliases=new Map(),aux=new Map(),profiles=new Map(),releases=new Map(),historicalRows=new Map(),events=new Map(),positions=new Map();
 let instanceId=null,currentReleaseId=null,sourceBytes=0,hasMarker=false,capacityExceeded=false,positionInvalid=false,internedBytes=0;
 const objects=new Map(),LIMIT=64*1024*1024;
 const intern=value=>{const text=canonicalJson(value),id=sha256(text);if(!objects.has(id)){internedBytes+=Buffer.byteLength(text);if(internedBytes>LIMIT)capacityExceeded=true;else objects.set(id,value);}return id;};
 const hydrate=release=>({model:Object.fromEntries(Object.entries(release.members.model).map(([k,ids])=>[k,ids.map(id=>objects.get(id))])),recipes:Object.fromEntries(Object.entries(release.members.recipes).map(([k,ids])=>[k,ids.map(id=>objects.get(id))])),markers:release.markers});
 const sourceBodies=new Map();
 return {accept(table,row,parsedSnapshot){
  if(table==='repository_meta'){instanceId=row.instance_id;currentReleaseId=row.current_release_id;}
  if(table==='document_aliases'){const list=aliases.get(row.document_id)||[];list.push(row.alias);aliases.set(row.document_id,list);if(markedPath(row.alias))hasMarker=true;}
  if(table==='record_revisions'){
   if(row.namespace==='aux:domain-graph'&&row.record_key==='current'){
    check(sha256(row.content_bytes)===row.content_sha256,'原领域AUX字节SHA错误');
    check(!aux.has(row.revision_id),'领域AUX修订重复');aux.set(row.revision_id,{sha256:row.content_sha256,byteSize:row.content_bytes.length,deleted:Boolean(row.deleted),createdAt:row.created_at});
   }
   if(row.namespace==='settings'&&row.record_key==='instance-profile'){
    check(sha256(row.content_bytes)===row.content_sha256,'重基线历史profile SHA错误');profiles.set(row.revision_id,parse(row.content_bytes).instanceId);
   }
   if(row.namespace==='documents'){
    const metadata=JSON.parse(row.metadata_json);
    if(roles.has(metadata.sourceRole)){
     if([ROLE,DOMAIN_ROLE].includes(metadata.sourceRole))hasMarker=true;
     sourceBytes+=row.content_bytes.length;if(sourceBytes>LIMIT){capacityExceeded=true;return;}
     check(sha256(row.content_bytes)===row.content_sha256,'重基线固定源原字节SHA错误');
     check(!documents.some(d=>d.revisionId===row.revision_id),'重基线固定源修订重复');
     const doc={documentId:row.record_key,revisionId:row.revision_id,sha256:row.content_sha256,bytes:row.content_bytes,metadata,deleted:Boolean(row.deleted),createdAt:row.created_at};documents.push(doc);
     if(metadata.sourceRole===ROLE){hasMarker=true;sourceBodies.set(doc.revisionId,parse(doc.bytes));}
     if(metadata.sourceRole===DOMAIN_ROLE)hasMarker=true;
    }
   }
  }
  if(table==='domain_events'){
   const e=parse(row.event_bytes);
   if(!(Number.isSafeInteger(row.storage_sequence)&&row.storage_sequence>0&&!positions.has(row.storage_sequence)&&typeof row.recorded_at==='string'&&row.recorded_at===e.recordedAt))positionInvalid=true;positions.set(row.storage_sequence,row.recorded_at);
   if(['asset-version','execution-request','run','review'].includes(e.eventKind)){
    check(sha256(row.event_bytes)===row.event_sha256,'重基线历史事件字节SHA错误');check(!events.has(e.eventId),'重基线历史事件身份重复');
    events.set(e.eventId,{...Object.fromEntries(['eventId','eventKind','recordedAt','executionRequestId','runId','executionDefinitionId','callPackageHash','workItemId','familyId','runState','state','requestState','status','maxOutputs','versionId','versionSha256','subjectType','applicationStatus','effect'].filter(k=>e[k]!==undefined).map(k=>[k,e[k]])),sha256:hash(e),eventSequence:e.eventSequence||null,storageSequence:row.storage_sequence});
   }
  }
  if(table==='releases'){
   const snapshot=parsedSnapshot||parse(row.snapshot_bytes),recipes=parse(row.recipes_bytes),model=snapshot.productionModel||{};
   const allRows=model.materialProductionRecipeRevisions||[];check(Array.isArray(allRows),'重基线发布ledger格式无效');
   const ledger=allRows.filter(marker),pins=JSON.parse(row.source_revision_ids_json);check(Array.isArray(pins),'重基线发布源集合无效');
   for(const r of ledger){hasMarker=true;const digest=hash(r);check(!historicalRows.has(r.id)||historicalRows.get(r.id)===digest,'历史重基线ledger被换绑');historicalRows.set(r.id,digest);}
   const explicitIds=[];if(snapshot.instance!==undefined)explicitIds.push(snapshot.instance?.instanceId);if(model.instance!==undefined)explicitIds.push(model.instance?.instanceId);
   const graphRef=model.domainGraphRef;
   check(!releases.has(row.release_id),'重基线历史发布身份重复');
   const plans=model.materialProductionPlans||[],planIds=new Set(plans.map(p=>p.id)),familyIds=new Set(plans.map(p=>p.familyId)),workIds=new Set(plans.map(p=>p.workItemId)),requirementIds=new Set(plans.map(p=>p.requirementId));
   const selected={materialProductionPlans:plans,materialProductionRecipeRevisions:allRows,assetFamilies:(model.assetFamilies||[]).filter(f=>familyIds.has(f.id)),materialWorkItems:(model.materialWorkItems||[]).filter(w=>workIds.has(w.id)),expectedOutputs:(model.expectedOutputs||[]).filter(o=>familyIds.has(o.familyId)),reviewContexts:(model.reviewContexts||[]).filter(c=>requirementIds.has(c.requirementId)),assetVersions:[]};
   const definitions=(recipes.executionDefinitions||[]).filter(d=>workIds.has(d.workItemRef)||planIds.has(d.materialProductionPlanId)),definitionIds=new Set(definitions.map(d=>d.id));
   const selectedRecipes={executionDefinitions:definitions,promptRevisions:(recipes.promptRevisions||[]).filter(p=>definitionIds.has(p.executionDefinitionId))};
   const markers=[...(model.materialWorkItems||[]),...(recipes.executionDefinitions||[])].filter(x=>Object.hasOwn(x,'materialProductionRequirementRebaseId')).map(x=>x.materialProductionRequirementRebaseId);if(markers.length)hasMarker=true;
   const members={model:Object.fromEntries(Object.entries(selected).map(([k,rows])=>[k,rows.map(intern)])),recipes:Object.fromEntries(Object.entries(selectedRecipes).map(([k,rows])=>[k,rows.map(intern)]))};
   releases.set(row.release_id,{releaseId:row.release_id,createdAt:row.created_at,snapshotId:snapshot.snapshotId,recipeSnapshotId:recipes.snapshotId,rowSnapshotId:row.snapshot_id,profileRevisionId:row.profile_revision_id,instanceIds:explicitIds,pins:new Set(pins),ledger:ledger.map(r=>({id:r.id,sha256:hash(r)})),members,markers,graphRef,graphHash:model.domainGraph?hash(model.domainGraph):null,bytesValid:sha256(row.snapshot_bytes)===row.snapshot_sha256&&sha256(row.recipes_bytes)===row.recipes_sha256});
  }
 },finish(){
  if(!hasMarker)return;
  check(!capacityExceeded,'重基线固定来源或去重成员超出独立语义校验容量');check(!positionInvalid,'重基线实际存储事件序列或时间无效');
  const released=releases.get(currentReleaseId);check(released,'缺少当前重基线发布');
  const current=hydrate(released),selectedPlanIds=new Set([...sourceBodies.values()].map(b=>b.materialProductionPlanId));for(const r of current.model.materialProductionRecipeRevisions.filter(marker))selectedPlanIds.add(r.materialProductionPlanId);
  current.model.materialProductionPlans=current.model.materialProductionPlans.filter(p=>selectedPlanIds.has(p.id));current.model.materialProductionRecipeRevisions=current.model.materialProductionRecipeRevisions.filter(r=>selectedPlanIds.has(r.materialProductionPlanId));
  const checkRelease=r=>{const owner=r&&profiles.get(r.profileRevisionId);check(r&&r.bytesValid&&r.snapshotId===r.recipeSnapshotId&&r.snapshotId===r.rowSnapshotId&&typeof owner==='string'&&owner&&r.instanceIds.every(id=>id===owner),'重基线实际发布字节、实例或配方身份不符');return owner;};
  check(checkRelease(released)===instanceId,'当前重基线发布实例与档案身份不符');
  for(const doc of documents)doc.aliases=aliases.get(doc.documentId)||[];
  for(const [id,paths]of aliases)if(paths.some(markedPath))check(documents.some(d=>d.documentId===id&&[ROLE,DOMAIN_ROLE].includes(d.metadata.sourceRole)),'重基线路径缺少合法固定来源角色');
  const currentRows=current.model.materialProductionRecipeRevisions,byId=new Map(currentRows.map(r=>[r.id,r]));
  for(const [id,digest]of historicalRows)check(byId.has(id)&&hash(byId.get(id))===digest,'当前重基线ledger丢失或更改原历史');
  // Same-clock publications have no sortable UUID chronology. Require every
  // later time group to retain the union already proven in earlier groups.
  const prior=new Map(),groups=new Map();for(const release of releases.values()){const list=groups.get(release.createdAt)||[];list.push(release);groups.set(release.createdAt,list);}
  for(const time of [...groups.keys()].sort()){
   for(const release of groups.get(time)){const refs=new Map(release.ledger.map(r=>[r.id,r.sha256]));for(const [id,digest]of prior)check(refs.get(id)===digest,'中间历史发布丢失或改变已生效重基线ledger');}
   for(const release of groups.get(time))for(const item of release.ledger)prior.set(item.id,item.sha256);
  }
  for(const release of releases.values())if(release.ledger.length){checkRelease(release);for(const item of release.ledger){const r=byId.get(item.id);check(r&&hash(r)===item.sha256&&release.pins.has(r.sourceRevisionId),'历史重基线发布缺少其固定源');for(const d of Object.values(r.domainSources||{}))check(release.pins.has(d.revisionId),'历史重基线发布缺少领域副本源');}}
  const rebases=currentRows.filter(r=>r.schemaVersion===SCHEMA),usedCopies=new Set();
  check(sourceBodies.size===rebases.length,'重基线来源与当前ledger不完整或存在孤立来源');
  for(const id of current.markers)check(rebases.some(r=>r.id===id),'当前producer含孤立重基线标记');
  const initialClosures=current.model.materialProductionPlans.map(plan=>({plan,...materialProductionPlanGraphClosure({plan,document:documents.find(d=>d.revisionId===plan.sourceRevisionId)})}));
  materialProductionRebaseClosures({model:current.model,recipes:current.recipes,documents,initialClosures,validateLegacySegment:materialProductionRevisionClosures});
  for(const r of rebases){
   const body=sourceBodies.get(r.sourceRevisionId),base=releases.get(body?.baseReleaseId),doc=documents.find(d=>d.revisionId===r.sourceRevisionId),plan=one(current.model.materialProductionPlans,r.materialProductionPlanId,'重基线原计划');
   check(body&&doc&&!doc.deleted&&doc.sha256===r.sourceSha256&&released.pins.has(doc.revisionId),'重基线固定源未被当前发布完整保留');checkRelease(base);
   const baseView=hydrate(base),basePlan=one(baseView.model.materialProductionPlans,plan.id,'实际基线原计划'),baseWork=one(baseView.model.materialWorkItems,plan.workItemId,'实际基线工作项');
   check(base.createdAt<=doc.createdAt&&same(basePlan,plan)&&baseWork.executionDefinitionRef===r.previousDefinitionId,'重基线未由真实先前发布原计划和当前调用定义承接');
   const previousDefinition=one(current.recipes.executionDefinitions,r.previousDefinitionId,'重基线旧定义'),previousOutput=one(current.model.expectedOutputs,r.previousExpectedOutputId,'重基线旧产物');
   check(same(one(baseView.recipes.executionDefinitions,r.previousDefinitionId,'实际基线旧定义'),previousDefinition)&&same(one(baseView.model.expectedOutputs,r.previousExpectedOutputId,'实际基线旧产物'),previousOutput),'重基线历史发布旧调用/产物与保全对象不符');
   check(base.pins.has(body.rebase.previousBaseline.sourceRevisionId)&&base.pins.has(previousDefinition.sourceRevisionId),'重基线真实基线未固定语义源或紧邻配方源');
   check(same(base.graphRef,body.rebase.graphRef)&&base.graphHash===body.rebase.graphRef.sha256,'重基线新领域图不等于真实基线发布原图');
   check(body.basis.revision.instanceId===profiles.get(base.profileRevisionId),'重基线作者证据实例错误');
   const baselineDoc=documents.find(d=>d.revisionId===body.rebase.previousBaseline.sourceRevisionId),baselineBody=baselineDoc&&parse(baselineDoc.bytes);
   const beforeInstanceId=baselineBody?.rebase?baselineBody.basis.revision.instanceId:baselineBody?.workContext?.scopeId;
   for(const name of ['before','after']){
    const descriptor=r.domainSources[name],copy=documents.find(d=>d.revisionId===descriptor.revisionId),original=aux.get(descriptor.graphRevisionId);usedCopies.add(descriptor.revisionId);
    check(copy&&!copy.deleted&&copy.metadata.instanceId===(name==='before'?beforeInstanceId:body.basis.revision.instanceId)&&original&&!original.deleted&&original.sha256===descriptor.graphSha256&&original.sha256===copy.sha256&&original.byteSize===copy.bytes.length&&original.createdAt<=copy.createdAt,'领域证据副本与真实原AUX修订不一致');
   }
   const revision=body.basis.revision,refs=[revision.parentCandidate,revision.parentReview,revision.familyReviewHead,...(revision.requestHeads||[]),...(revision.runHeads||[])].filter(Boolean);
   validateHistoricalHeads({body,row:r,events,positions,doc,recipes:current.recipes});
   for(const ref of refs){const e=events.get(ref.eventId);check(e&&e.sha256===ref.sha256&&e.eventSequence===ref.eventSequence&&typeof e.recordedAt==='string'&&e.recordedAt<=doc.createdAt,'重基线来源引用的真实事件缺失、被修改或晚于固定源');}
   check(events.get(body.parentCandidate.eventId)?.eventKind==='asset-version'&&events.get(body.parentCandidate.eventId)?.sha256===hash(body.parentCandidate),'重基线父候选不是保留的原始实际事件');
   const parent=body.parentCandidate,runRefs=revision.failedAttempt?[...(revision.runHeads||[]),{eventId:revision.failedAttempt.parentRun?.eventId}]:(revision.runHeads||[]);
   const parentRun=runRefs.map(ref=>events.get(ref.eventId)).find(e=>e?.eventKind==='run'&&e.runId===parent.runId&&e.executionRequestId===parent.executionRequestId&&e.executionDefinitionId===parent.executionDefinitionId&&e.callPackageHash===parent.callPackageHash&&(e.runState||e.state)==='SUCCEEDED');
   check(parentRun,'重基线父候选缺少冻结的真实成功Run');
  }
  for(const d of documents)if(d.metadata.sourceRole===DOMAIN_ROLE)check(usedCopies.has(d.revisionId)&&released.pins.has(d.revisionId),'领域证据副本被删除、未发布或成为孤立来源');
 }};
}

export function validateMaterialProductionRebaseArchive(archive,{encoded=true}={}){
 const validator=createMaterialProductionRebaseArchiveValidator();
 for(const table of ['repository_meta','document_aliases','record_revisions','domain_events','releases'])for(const row of archive.tables?.[table]||[]){
  const decoded=encoded?Object.fromEntries(Object.entries(row).map(([key,value])=>{
   if(value===null||typeof value!=='object')return[key,value];
   check(value.encoding==='base64'&&typeof value.bytes==='string','重基线档案字节编码无效');const bytes=Buffer.from(value.bytes,'base64');check(bytes.toString('base64')===value.bytes,'重基线档案原字节编码无效');return[key,bytes];
  })):row;
  validator.accept(table,decoded);
 }
 validator.finish();
}
