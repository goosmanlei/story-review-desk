import {assets,materialRows,realizedOutput} from './materials.mjs';
import {idFor,idsFor} from './read-unit.mjs';
import {check,hash} from '../shared/contracts.mjs';

export async function materialModel(unit,{ids,summary=true}={}) {
 const requirements=await materialRows(unit,{ids,summary});
 const familyIds=[...new Set(requirements.flatMap(r=>r.assetFamilyRefs))];
 const media=await assets(unit,familyIds,{summary});
 const calls=await unit.rows(['CALL'],{fields:['workItemRef','declaredGate','definitionStatus']});
 const plans=await unit.rows(['NOTE'],{roles:['MATERIAL_PRODUCTION'],fields:['requirementId','currentCallId']});
 const workItems=requirements.filter(r=>r.requirementClass!=='EVIDENCE_ONLY').map(r=>{
  const selected=plans.find(p=>p.content.requirementId===r.id)?.content.currentCallId;
  const call=calls.find(c=>c.id===selected)||calls.find(c=>idsFor(c,'REQUIREMENT').includes(r.id));
  const family=media.assetFamilies.find(f=>r.assetFamilyRefs.includes(f.id)),version=media.assetVersions.find(v=>v.id===family?.currentVersionRef);
  return {id:call?.content.workItemRef||'material:'+r.id,label:r.title,lane:'MATERIAL_PREP',workflowStepId:null,requirementRef:r.id,requirementHash:r.requirementHash,scopeType:'PROJECT',scopeId:r.id,episodeIds:r.episodeIds,episodeUids:r.episodeUids,sceneIds:r.sceneIds,shotIds:r.shotIds,structureCardRefs:[],inputAssetRefs:[],outputAssetRef:family?.id||null,additionalOutputAssetRefs:r.assetFamilyRefs.filter(id=>id!==family?.id),consumerWorkItemRefs:[],sourceRef:call?.revisionId||r.revisionId,executionDefinitionRef:call?.id||null,definitionAuthoringState:call?'DEFINED':'REQUIRED',declaredExecutionGate:call?.content.declaredGate||'UNKNOWN',generationAllowed:false,executionBlockReasons:['EXPLICIT_GENERATION_AUTHORIZATION_REQUIRED'],applicabilityState:r.requirementClass==='OPTIONAL'?'OPTIONAL':'REQUIRED',lifecycleState:version?.lifecycleState||'PLANNED',outputState:version?.outputState||'NOT_GENERATED',reviewDecision:version?.reviewDecision||'PENDING_REVIEW',canFlowDownstream:version?.canFlowDownstream||false,flowBlockReasons:version?.flowBlockReasons||[],...(summary?{}:{reviewSpec:r.reviewSpec})};
 });
 const expectedIds=(await unit.tx.query("SELECT owner_id FROM memberships WHERE role='FAMILY' AND member_id=ANY($1::text[])",[familyIds])).rows.map(r=>r.owner_id);
 const expectations=summary?[]:await unit.rows(['EXPECTED_OUTPUT'],{ids:expectedIds});
 return {...media,materialRequirements:requirements.map(r=>({...r,materialWorkItemRef:workItems.find(w=>w.requirementRef===r.id)?.id||null})),materialWorkItems:workItems,
  expectedOutputs:expectations.map(r=>realizedOutput(r,media.assetVersions))};
}
/** Lightweight complete graph index; no Prompt, source body, design or execution record. */
export async function materialCatalog(unit) {
 const model=await materialModel(unit,{summary:true});
 return {snapshotId:await unit.namespace(),readVersion:unit.version(),page:model,total:model.materialRequirements.length};
}
export async function materialPage(unit,params) {
 const limit=Number(params.get('limit')||50);
 check(Number.isSafeInteger(limit)&&limit>=1&&limit<=100,'PAGE_LIMIT','分页大小须为 1 至 100');
 const requirementId=params.get('requirementId'),filters=Object.fromEntries(['search','entityId','mediaType','category'].map(k=>[k,params.get(k)||null]));
 check(Object.values(filters).every(v=>v===null||v.length<=500),'PAGE_FILTER','筛选条件过长');
 const catalog=(await unit.tx.query(`SELECT o.id,o.version,r.id AS revision_id FROM objects o JOIN revisions r ON r.id=COALESCE(o.draft_revision_id,o.adopted_revision_id)
  WHERE o.kind='REQUIREMENT' AND NOT o.historical AND ($1::text IS NULL OR o.id=$1)
  AND ($2::text IS NULL OR o.title ILIKE '%'||$2||'%' OR o.id ILIKE '%'||$2||'%')
  AND ($3::text IS NULL OR EXISTS(SELECT 1 FROM memberships m WHERE m.owner_id=o.id AND m.role='ENTITY' AND m.member_id=$3))
  AND ($4::text IS NULL OR COALESCE(r.content->>'mediaType',r.content->>'mediaKind')=$4)
  AND ($5::text IS NULL OR r.content->>'category'=$5) ORDER BY o.id`,[requirementId,filters.search,filters.entityId,filters.mediaType,filters.category])).rows;
 const version=hash(catalog),filterHash=hash({requirementId,filters});let after='';
 if(params.has('cursor')){
  let cursor;try{cursor=JSON.parse(Buffer.from(params.get('cursor'),'base64url').toString());}catch{check(false,'PAGE_CURSOR','分页游标无效');}
  check(cursor?.resource==='materials'&&typeof cursor.after==='string','PAGE_CURSOR','分页游标无效');
  check(cursor.version===version&&cursor.filters===filterHash,'VERSION_CONFLICT','素材目录或筛选条件已变化，请重新读取',409);after=cursor.after;
 }
 const selected=catalog.filter(r=>r.id>after).slice(0,limit),last=selected.at(-1)?.id;
 const more=!!last&&catalog.some(r=>r.id>last),summary=!requirementId&&params.get('detail')!=='complete';
 const page=await materialModel(unit,{ids:selected.map(r=>r.id),summary});
 return {schemaVersion:'1.0',snapshotId:await unit.namespace(),readVersion:version,detailState:summary?'SUMMARY':'COMPLETE',count:selected.length,total:catalog.length,hasMore:more,nextCursor:more?Buffer.from(JSON.stringify({resource:'materials',version,filters:filterHash,after:last})).toString('base64url'):null,appliedMode:'requirements',appliedFilters:filters,page};
}
