import {check,hash} from '../shared/contracts.mjs';
import {PresentationRead,idFor,idsFor} from '../presentation/read-unit.mjs';
import {assets,domainWorkspace} from '../presentation/materials.mjs';
import {workspaceDraft} from '../workspace-drafts.mjs';

const modes={usage:{workspace:'material-usage',protocol:'MATERIAL_USAGE_V1',role:'MATERIAL_USAGE_REVIEW',key:'usageId'},context:{workspace:'asset-context-revalidation',protocol:'ASSET_CONTEXT_REVALIDATION_V1',role:'ASSET_CONTEXT_REVALIDATION',key:'revalidationId'}};
const reviewed=result=>({APPROVE_AND_RELEASE:'ADOPT',REQUEST_REVISION:'REQUEST_CHANGES',DO_NOT_USE:'DISABLE'})[result];
function frozenSpec(spec){check(spec?.criteria?.length,'REVIEW_SPEC_REQUIRED','此需求尚未登记完整验收标准',409);const value={...spec,criteria:spec.criteria.map(c=>({...c,question:c.question||c.description||'',allowNA:c.allowNA===true}))};return {...value,hash:hash(value)};}
const contextSpec=frozenSpec({id:'current-material-domain',label:'当前实体关系复核',criteria:[{id:'identity',label:'主体身份与状态',question:'原图是否符合当前登记的主体身份、状态与形态？',required:true},{id:'relations',label:'关系与适用范围',question:'继承、排除和用途范围是否符合当前关系，且没有改写原生成事实？',required:true},{id:'original',label:'原件与采用依据',question:'是否查看精确版本原件，并核对原采用记录及实际输入？',required:true}]});
const targetOf=input=>({familyId:input.familyId,versionId:input.versionId,sha256:input.sha256,...(input.requirementId?{requirementId:input.requirementId}:{})});
async function requirementBasis(unit,id){const row=await unit.detail(id);check(row.kind==='REQUIREMENT','REQUIREMENT_REQUIRED','请选择素材需求');return {row,value:{...row.revision.content,requirementId:row.id,requirementHash:row.revision.content.requirementHash||row.revision.sha256,revisionId:row.revision.id,reviewSpec:frozenSpec(row.revision.content.reviewSpec)}};}

export async function materialUsageSelection(unit,requirementId){
  const requirement=await requirementBasis(unit,requirementId),media=await assets(unit),entity=idFor(requirement.row,'ENTITY');
  const eligibleSources=media.assetVersions.filter(v=>v.mediaKind==='IMAGE'&&v.canFlowDownstream&&media.assetFamilies.some(f=>f.id===v.familyId&&f.adoptedVersionRef===v.id)).map(v=>({familyId:v.familyId,versionId:v.id,sha256:v.sha256,title:v.title,sameEntity:!!entity&&media.assetFamilies.some(f=>f.id===v.familyId&&f.entityId===entity),mediaUrl:v.mediaUrl,mediaToken:v.sha256}));
  return {protocol:'MATERIAL_USAGE_V1',supported:true,requirementId,readOnly:requirement.row.historical,releaseId:requirement.row.revision.id,requirement:requirement.value,reviewSpec:requirement.value.reviewSpec,eligibleSources,blockers:requirement.row.historical?['历史需求只读']:[]};
}

export async function materialReviewWorkspace(unit,mode,input){
  const definition=modes[mode];check(definition,'MATERIAL_REVIEW_KIND','复核类型无效');
  const target=targetOf(input),asset=await unit.detail(input.versionId);
  check(asset.kind==='ASSET'&&idFor(asset,'FAMILY')===input.familyId,'ASSET_IDENTITY','素材族与版本不一致',409);
  const media=(await unit.tx.query("SELECT m.sha256,m.availability,m.mime_type,m.original_path FROM asset_media a JOIN media m ON m.id=a.media_id AND m.version_id=a.media_version_id WHERE a.revision_id=$1 AND a.role='OUTPUT'",[asset.revision.id])).rows;
  check(media.length===1&&media[0].sha256===input.sha256,'ASSET_SHA','原件与所选 SHA 不一致',409);
  const rights=(await unit.tx.query('SELECT * FROM rights WHERE revision_id=$1',[asset.revision.id])).rows[0];
  const blockers=[];
  if(asset.state!=='ADOPTED'||asset.adoptedRevisionId!==asset.revision.id)blockers.push('此素材版本尚未采用');
  if(media[0].availability!=='PRESENT'||!media[0].mime_type.startsWith('image/'))blockers.push('需读取已登记、可用的原始图片');
  if(rights?.fact==='BLOCKED'||rights?.fact!=='CLEAR'&&!rights?.internal_attestation)blockers.push('原版本权利未知或阻断');
  const basis=[{objectId:asset.id,revisionId:asset.revision.id,sha256:asset.revision.sha256,expectedVersion:asset.version,purpose:'ACTUAL_INPUT'}];
  let requirement,domainContext,reviewSpec;
  if(mode==='usage'){
    requirement=await requirementBasis(unit,input.requirementId);reviewSpec=requirement.value.reviewSpec;
    if(requirement.row.historical)blockers.push('历史需求只读');
    basis.push({objectId:requirement.row.id,revisionId:requirement.row.revision.id,sha256:requirement.row.revision.sha256,expectedVersion:requirement.row.version,purpose:'DEFINITION'});
  }else{
    const domain=await domainWorkspace(unit,'MATERIAL'),requirements=domain.graph.requirements.filter(r=>r.assetFamilyIds?.includes(input.familyId)),representations=domain.graph.representations.filter(r=>r.assetFamilyIds.includes(input.familyId)||r.requirementIds.some(id=>requirements.some(r=>r.id===id)));
    const ids=new Set([...representations.map(r=>r.id),...representations.flatMap(r=>[r.entityId,r.stateId]),...requirements.map(r=>r.id),...asset.links.filter(l=>['ENTITY','STATE','REPRESENTATION','REQUIREMENT'].includes(l.role)).map(l=>l.id)].filter(Boolean));
    const relations=domain.graph.relations.filter(r=>ids.has(r.from.id)||ids.has(r.to.id));
    for(const relation of relations){ids.add(relation.id);ids.add(relation.from.id);ids.add(relation.to.id);}
    domainContext=Object.fromEntries(Object.entries(domain.graph).filter(([,rows])=>Array.isArray(rows)).map(([key,rows])=>[key,rows.filter(r=>ids.has(r.id))]));
    for(const id of ids){const row=unit.basis.get(id);if(row)basis.push({...row,purpose:'DEFINITION'});}
    if(!ids.size)blockers.push('此原图尚无可唯一核对的实体与关系登记');
    reviewSpec=contextSpec;
  }
  const name=(mode==='usage'?'material-usage:':'asset-context:')+hash(target),old=await workspaceDraft(unit.tx,name),basisHash=hash(basis),releaseId=basisHash;
  const value={protocol:definition.protocol,supported:true,...target,readOnly:blockers.length>0,releaseId,basisHash,[definition.key]:name,reviewSpec,blockers,sourceVersion:{...target,path:media[0].original_path,media:media[0],projectRightsGate:rights?.fact,adoption:{revisionId:asset.adoptedRevisionId}},...(requirement?{requirement:requirement.value,sourceAdoption:{revisionId:asset.adoptedRevisionId}}:{domainContext,legacyAdoptionProof:{revisionId:asset.adoptedRevisionId,reviews:asset.reviews}})};
  const draft=old?.state==='DRAFT'?{...target,[definition.key]:name,revisionId:old.revisionId,baseReleaseId:old.content.baseReleaseId,basisHash:old.content.basisHash,content:old.content.reviewContent}:null;
  const current=draft?.basisHash===basisHash;
  const head=old?(await unit.tx.query('SELECT r.id,r.content FROM objects o JOIN revisions r ON r.id=o.adopted_revision_id WHERE o.id=$1',[old.id])).rows[0]:null;
  const jobs=(await unit.tx.query("SELECT id AS \"jobId\",id AS \"requestId\",status,error FROM operations WHERE request#>>'{commands,0,workspace}'=$1 AND request#>>'{commands,0,input,versionId}'=$2 AND COALESCE(request#>>'{commands,0,input,requirementId}','')=$3 AND request#>>'{commands,0,input,action}'='publish' ORDER BY created_at DESC LIMIT 20",[definition.workspace,input.versionId,input.requirementId||''])).rows.map(r=>({...r,error:r.error?.message}));
  return {value:{...value,draftHeadRevisionId:old?.revisionId||null,draft:current?draft:null,staleDraft:draft&&!current?{...draft,reason:'实际依据已变化'}:null,head:head?{revisionId:head.id,...head.content.reviewContent,action:head.content.reviewContent.decision?.action||head.content.reviewContent.action}:null,jobs},basis,old,name,definition};
}

function validateReview(mode,content,state){
  check(content&&typeof content==='object','REVIEW_CONTENT','缺少复核正文');
  const decision=mode==='usage'?content.decision:{action:'APPROVE_AND_RELEASE',reviewSpecHash:state.reviewSpec.hash,criterionFindings:content.criterionFindings,note:content.note};
  check(reviewed(decision?.action)&&decision.reviewSpecHash===state.reviewSpec.hash,'REVIEW_SPEC_CONFLICT','判断与当前标准不一致',409);
  check(typeof decision.note==='string'&&decision.note.trim(),'REVIEW_NOTE','请填写判断说明');
  const findings=decision.criterionFindings;
  check(Array.isArray(findings)&&new Set(findings.map(f=>f.criterionId)).size===findings.length&&findings.length===state.reviewSpec.criteria.length,'REVIEW_FINDINGS','请完整填写逐项判断');
  for(const c of state.reviewSpec.criteria){const finding=findings.find(f=>f.criterionId===c.id);check(finding&&['PASS','FAIL','NA'].includes(finding.verdict)&&typeof finding.note==='string'&&finding.note.trim()&&(finding.verdict!=='NA'||c.allowNA),'REVIEW_FINDINGS','请完成每项判断并填写依据');}
  check(decision.action!=='APPROVE_AND_RELEASE'||!findings.some(f=>f.verdict==='FAIL'),'REVIEW_FAILED_CRITERIA','失败项不能同时通过');
  if(mode==='usage')check(typeof content.purposeNote==='string'&&content.purposeNote.trim()&&content.authorization?.scope==='PROJECT_INTERNAL_ONLY'&&typeof content.authorization.basis==='string'&&content.authorization.basis.trim()&&content.observation?.originalViewed===true&&content.observation.versionId===state.versionId&&content.observation.sha256===state.sha256&&typeof content.observation.note==='string'&&content.observation.note.trim(),'USAGE_OBSERVATION','须明确用途、内部使用依据，并核对本次精确原图');
  else check(content.purpose==='LEGACY_ADOPTION_DOMAIN_REVALIDATION'&&content.action==='CONFIRM_CURRENT_DOMAIN'&&content.observedVersionId===state.versionId&&content.observedSha256===state.sha256&&content.originalViewed===true,'CONTEXT_OBSERVATION','须明确查看本次精确原图并核对当前关系');
  return decision;
}

export async function planMaterialReview(tx,mode,input){
  const state=await materialReviewWorkspace(new PresentationRead(tx),mode,input),{value,basis,old,name,definition}=state;
  check(!value.readOnly,'MATERIAL_REVIEW_BLOCKED',value.blockers.join('；'),409);
  const assert=basis.map(b=>({type:'assert',id:b.objectId,expectedVersion:b.expectedVersion}));
  const flags={modelCalls:0,formalAdoptionPerformed:false,[mode==='usage'?'formalUsageReviewPerformed':'contextRevalidationPerformed']:input.action==='publish'};
  if(input.action==='save'){
    check(input.expectedBasisHash===value.basisHash&&input.expectedReleaseId===value.releaseId&&(input.expectedDraftRevisionId||null)===(old?.revisionId||null),'VERSION_CONFLICT','复核依据或保存草稿已改变；当前输入仍保留',409);
    validateReview(mode,input.content,value);
    const content={workspace:name,role:definition.role,target:targetOf(input),basisHash:value.basisHash,baseReleaseId:value.releaseId,reviewSpec:value.reviewSpec,reviewContent:input.content};
    return {commands:[...assert,{type:'save',id:'workspace-draft:'+name,kind:'NOTE',title:mode==='usage'?'图片用途判断':'原图当前关系复核',expectedVersion:old?.version||0,content,dependencies:basis.map(b=>({revisionId:b.revisionId,sha256:b.sha256,purpose:b.purpose})),links:[{id:input.familyId,role:'FAMILY'},...(input.requirementId?[{id:input.requirementId,role:'REQUIREMENT'}]:[])]}],response:results=>({...flags,revisionId:results.at(-1).revisionId})};
  }
  check(old&&value.draft&&input.draftRevisionId===old.revisionId,'VERSION_CONFLICT','请先保存并核对当前依据的草稿',409);
  const decision=validateReview(mode,old.content.reviewContent,value),body={schemaVersion:mode==='usage'?'MATERIAL_USAGE_REVIEW_V1':'ASSET_CONTEXT_REVALIDATION_SOURCE_V1',[definition.key]:name,baseReleaseId:value.releaseId,draftRevisionId:old.revisionId,basis:{source:targetOf(input),...(mode==='usage'?{requirement:value.requirement}:{current:{reviewSpec:value.reviewSpec,domainContext:value.domainContext}})},content:old.content.reviewContent},previewHash=hash(body);
  if(input.action==='preview')return {commands:[...assert,{type:'assert',id:old.id,expectedVersion:old.version}],response:()=>({...flags,previewHash,[mode==='usage'?'usage':'revalidation']:body})};
  check(input.action==='publish'&&input.previewHash===previewHash,'PREVIEW_STALE','预览已改变，请重新核对',409);
  return {commands:[...assert,{type:'submit',id:old.id,expectedVersion:old.version,revisionId:old.revisionId},{type:'review',id:old.id,expectedVersion:old.version+1,revisionId:old.revisionId,decision:reviewed(decision.action),explicit:true,findings:decision.criterionFindings,note:decision.note}],response:results=>({...flags,[definition.key]:name,revisionId:old.revisionId,eventId:results.at(-1).reviewId})};
}
