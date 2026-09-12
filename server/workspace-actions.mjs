import {planManifestPreview} from './production/manifests.mjs';
import {planEpisodeOrganization} from './story/editing.mjs';
import {planInputLockChange} from './production/input-locks.mjs';
import {planExecutionChange} from './production/execution.mjs';
import {planAuthoringChange} from './story/authoring.mjs';
import {planShotRecipeChange} from './production/recipes.mjs';
import {planMaterialProductionChange} from './materials/production-settings.mjs';
import {planStoryEdit} from './story/editing.mjs';
import {planMaterialReview} from './materials/usage-reviews.mjs';
import {planSourceRegistration} from './story/sources.mjs';
import { check, hash, identity, identifier } from './shared/contracts.mjs';
import { PresentationRead } from './presentation/read-unit.mjs';
import { domainWorkspace } from './presentation/materials.mjs';
import { moduleFor } from './modules.mjs';
import { workspaceDraft } from './workspace-drafts.mjs';
import { validateConfiguration } from './project/service.mjs';
import { episodePlan } from './presentation/story.mjs';
import { commentTargets } from './presentation/review.mjs';
import { idFor,idsFor } from './presentation/read-unit.mjs';
import { canonicalShotDesign } from '../web/presentation/shot-design-contract.mjs';
import {animaticWorkspace} from './presentation/animatics.mjs';
import {validateAnimaticTimeline,animaticMediaBindings} from './production/animatic-model.mjs';

import {planSpatialViewChange} from './production/spatial-views.mjs';
import {planShotSettingsChange} from './production/shot-settings.mjs';

const collectionKinds = { entities:'ENTITY', states:'STATE', representations:'REPRESENTATION', relations:'RELATION', requirements:'REQUIREMENT' };
const projectionFields = ['revisionId','objectVersion','revisionSha256','displayId'];
function authored(value) { const content={...value}; for(const key of projectionFields) delete content[key]; return content; }
function draftSave(name, old, content) {
  return { type:'save', id:'workspace-draft:'+name, kind:'NOTE', title:'工作区草稿 · '+name, expectedVersion:old?.version||0, content:{ workspace:name, ...content } };
}
function validateDraftHead(old, revisionId) {
  check((old?.revisionId||null)===(revisionId||null), 'VERSION_CONFLICT', '保存的草稿已改变；当前编辑仍保留，请核对新版本',409);
}
function assertVersions(commands) {return commands.map(c=>({type:'assert',id:c.id,expectedVersion:c.expectedVersion}));}
function domainLinks(value, prior=[]) {
  const links=prior.filter(l=>['SCENE','EPISODE','SOURCE','SHOT','OUTPUT','COMMENT'].includes(l.role));
  const add=(id,role)=>{if(id&&!links.some(l=>l.id===id&&l.role===role))links.push({id,role});};
  add(value.entityId,'ENTITY'); add(value.stateId,'STATE'); add(value.representationId,'REPRESENTATION');
  for(const id of value.assetFamilyIds||[])add(id,'FAMILY');
  for(const id of value.requirementIds||[])add(id,'REQUIREMENT');
  for(const end of [value.from,value.to]) if(end)add(end.id,end.kind==='MATERIAL'?'FAMILY':end.kind);
  return links;
}
async function checkedDomainChanges(unit, state, changes) {
  check(Array.isArray(changes)&&changes.length>0&&changes.length<=30,'CHANGES_REQUIRED','一次修改须包含 1 至 30 个对象');
  const ids=new Set(), result=[];
  for(const change of changes) {
    const kind=collectionKinds[change.collection];identity(change.id);
    check(kind&&!ids.has(change.id),'CHANGE_IDENTITY','修改类型无效或身份重复');ids.add(change.id);
    const old=state.graph[change.collection].find(r=>r.id===change.id),meta=state.ownership[change.collection+':'+change.id];
    check((meta?.recordHash||null)===(change.beforeHash||null),'VERSION_CONFLICT','所编辑对象已改变；未覆盖新内容',409,{id:change.id});
    if(!old)check(!(await unit.tx.query('SELECT 1 FROM objects WHERE id=$1',[change.id])).rowCount,'IDENTITY_EXISTS','此身份已有历史对象，不能重新使用',409);
    check(!meta||meta.owner===state.owner,'DOMAIN_OWNER','请在对象所属工作区维护',409);
    const detail=old?await unit.detail(change.id):null;
    if(change.value!==null) {
      check(change.value?.id===change.id,'CHANGE_IDENTITY','草稿不能改变永久身份');
      const valueOwner=kind==='ENTITY'||kind==='RELATION'&&change.value.from?.kind==='ENTITY'&&change.value.to?.kind==='ENTITY'?'SETTINGS':'MATERIAL';
      check(valueOwner===state.owner,'DOMAIN_OWNER','新增或变更后的对象须由其所属工作区维护',409);
      const content={...detail?.revision.content,...authored(change.value)}; moduleFor(kind).validate?.(kind,content);
      result.push({type:'save',id:change.id,kind,expectedVersion:detail?.version||0,title:content.name||content.label||content.title,content,links:domainLinks(content,detail?.links)});
    } else result.push({type:'archive',id:change.id,expectedVersion:detail.version});
  }
  return result;
}

async function domainAction(tx, body) {
  check(['SETTINGS','MATERIAL'].includes(body.owner),'DOMAIN_OWNER','工作区归属无效');
  const unit=new PresentationRead(tx), state=await domainWorkspace(unit,body.owner), name='domain:'+body.owner, old=await workspaceDraft(tx,name);
  if(body.action==='save') {
    validateDraftHead(old,body.expectedDraftRevisionId);
    const checked=await checkedDomainChanges(unit,state,body.changes);
    return {commands:[...assertVersions(checked),draftSave(name,old,{status:'DRAFT',changes:body.changes,baseReleaseId:state.releaseId,basis:checked.map(c=>({id:c.id,expectedVersion:c.expectedVersion}))})],response:results=>({revisionId:results.at(-1).revisionId,releaseId:state.releaseId,formalAdoptionPerformed:false})};
  }
  check(old&&old.content.status==='DRAFT','DRAFT_REQUIRED','请先保存草稿',409);
  validateDraftHead(old,body.draftRevisionId);
  const checked=await checkedDomainChanges(unit,state,old.content.changes);
  if(body.action==='rebase')return {commands:[...assertVersions(checked),draftSave(name,old,{...old.content,baseReleaseId:state.releaseId})],response:r=>({revisionId:r.at(-1).revisionId,notice:'已核对本草稿涉及的对象版本，原修改完整保留。'})};
  const previewHash=hash({revisionId:old.revisionId,commands:checked});
  const impact={added:checked.filter(c=>c.expectedVersion===0).length,changed:checked.filter(c=>c.expectedVersion>0&&c.type==='save').length,removed:checked.filter(c=>c.type==='archive').length,affectedFamilies:[],invalidations:[]};
  if(body.action==='preview')return {commands:[...assertVersions(checked),{type:'assert',id:old.id,expectedVersion:old.version}],response:()=>({previewHash,impact,checks:['永久身份与对象所见版本一致','只修改本模块所属对象','采用、权利与实际输入不会被草稿自动改变']})};
  check(body.action==='publish','WORKSPACE_ACTION','不支持的工作区动作');
  check(body.previewHash===previewHash,'PREVIEW_STALE','预览依据已改变，请重新预览',409);
  // Publishing a settings edit makes its draft head available immediately. It is
  // not a story decision, material approval, input lock, or generation grant.
  return {commands:[...checked,draftSave(name,old,{...old.content,status:'PUBLISHED',publishedBasis:previewHash})],response:results=>({revisionId:results.at(-1).revisionId,impact,notice:'本模块修改已保存并生效；正式采用与生成授权单独记录。'})};
}

async function relationsAction(tx, body) {
  const unit=new PresentationRead(tx),state=await domainWorkspace(unit,'SETTINGS'),name='relations',old=await workspaceDraft(tx,name);
  const changes=body.action==='save'?body.changes:old?.content.changes;
  check(Array.isArray(changes)&&changes.length>0&&changes.length<=30,'CHANGES_REQUIRED','一次关系修改须包含 1 至 30 个对象');
  check(new Set(changes.map(c=>c.id)).size===changes.length,'CHANGE_IDENTITY','修改对象身份重复');
  validateDraftHead(old,body.action==='save'?body.expectedDraftRevisionId:body.draftRevisionId);
  const commands=[];
  for(const owner of ['SETTINGS','MATERIAL']) {
    const selected=changes.filter(c=>(state.ownership[c.collection+':'+c.id]?.owner||(c.collection==='entities'||c.collection==='relations'&&c.value?.from?.kind==='ENTITY'&&c.value?.to?.kind==='ENTITY'?'SETTINGS':'MATERIAL'))===owner);
    if(selected.length)commands.push(...await checkedDomainChanges(unit,{...state,owner},selected));
  }
  if(body.action==='save')return {commands:[...assertVersions(commands),draftSave(name,old,{status:'DRAFT',changes})],response:results=>({revisionId:results.at(-1).revisionId,releaseId:state.releaseId})};
  check(old?.content.status==='DRAFT','DRAFT_REQUIRED','请先保存关系草稿',409);
  const previewHash=hash({revisionId:old.revisionId,commands}),impact={added:commands.filter(c=>c.expectedVersion===0).length,changed:commands.filter(c=>c.type==='save'&&c.expectedVersion>0).length,removed:commands.filter(c=>c.type==='archive').length,affectedRepresentationIds:commands.filter(c=>c.kind==='REPRESENTATION').map(c=>c.id)};
  if(body.action==='preview')return {commands:[...assertVersions(commands),{type:'assert',id:old.id,expectedVersion:old.version}],response:()=>({previewHash,impact,checks:['核对所有修改对象的精确版本','实体、状态、素材形态和关系共用永久身份','不改变原素材版本、采用结论或生成授权'],blockers:[]})};
  check(body.action==='publish'&&body.previewHash===previewHash,'PREVIEW_STALE','关系预览已变化，请重新核对',409);
  return {commands:[...commands,draftSave(name,old,{...old.content,status:'PUBLISHED'})],response:results=>({revisionId:results.at(-1).revisionId,impact,formalAdoptionPerformed:false})};
}

export function splitConfiguration(value, unit) {
  check(value?.schemaVersion==='2.0','CONFIGURATION_SCHEMA','配置格式无效');
  for(const group of ['domain','taxonomy','workflow','technical','sources','collaboration','presentation'])check(value[group]&&typeof value[group]==='object','CONFIGURATION_GROUP','缺少配置组：'+group);
  check(Array.isArray(value.reviewProfiles),'REVIEW_PROFILES','审阅标准须为列表');
  for(const rows of [value.reviewProfiles,value.domain.entityTypes,value.domain.relationTypes,value.domain.representationTypes,value.domain.stateDimensions,value.domain.referencePolicies,value.taxonomy.categories,value.workflow.phases,value.workflow.gates]) {
    check(Array.isArray(rows)&&rows.length<=500,'CONFIGURATION_LIST','配置列表无效或过长');
    const ids=rows.map(r=>r?.id);check(ids.every(id=>typeof id==='string'&&id.length>0)&&new Set(ids).size===ids.length,'CONFIGURATION_ID','配置身份须唯一且非空');
  }
  for(const profile of value.reviewProfiles){check(Array.isArray(profile.criteria),'REVIEW_CRITERIA','审阅标准须包含判断条目');const ids=profile.criteria.map(c=>c.id);check(ids.every(Boolean)&&new Set(ids).size===ids.length,'REVIEW_CRITERIA','判断条目身份不能重复');}
  const {picture,...technical}=value.technical,{storyTitle,title,mark,description,landingView,...candidateOptions}=value.presentation;
  const {apiKeyEnvName,codexBridge,defaultExecutor,...assistant}=value.collaboration;
  const previous=unit.config.collaboration;
  check(apiKeyEnvName===previous.apiKeyEnvName&&defaultExecutor===previous.defaultExecutor&&hash(codexBridge)===hash(previous.codexBridge),'MACHINE_CONFIGURATION','宿主执行配置须通过本机配置入口修改，不能混入普通项目配置',409);
  const system={...unit.systemConfiguration,template:value.template,reviewStandards:value.reviewProfiles,entityTypes:value.domain,materialTypes:value.taxonomy,productionStages:value.workflow,technicalStandards:technical,sourceRules:value.sources.continuity,assistant:{...assistant,enabled:assistant.assistantEnabled}};
  const project={...unit.projectConfiguration,title:storyTitle,branding:{title,mark,description},defaultWorkspace:landingView,candidateOptions,pictureBaseline:picture,sourcePriority:value.sources.order};
  validateConfiguration('system',system);validateConfiguration('project',project);
  return {system,project};
}
async function configurationAction(tx, workspace, body) {
  const unit=new PresentationRead(tx);await unit.configuration();
  const old=await workspaceDraft(tx,'configuration'), versions=unit.configurationVersions, baseline=hash(versions);
  if(workspace==='configuration') {
    validateDraftHead(old,body.expectedDraftRevision);
    check(body.expectedConfigurationRevisionId===baseline,'VERSION_CONFLICT','配置已被其他操作修改，当前编辑仍保留',409);
    splitConfiguration(body.configuration,unit);
    check(!body.upgradeKeys?.length,'EXPLICIT_OBJECT_UPGRADE','已有对象保留冻结标准；升级须在对应对象核对后应用',409);
    return {commands:[...Object.entries(versions).map(([scope,expectedVersion])=>({type:'configuration.assert',scope,expectedVersion})),draftSave('configuration',old,{status:'DRAFT',configuration:body.configuration,versions,upgradeKeys:[],expectedReleaseId:baseline})],response:results=>({revisionId:results.at(-1).revisionId})};
  }
  check(old&&old.content.status==='DRAFT','DRAFT_REQUIRED','请先保存配置草稿',409);validateDraftHead(old,body.draftRevisionId);
  check(hash(old.content.versions)===baseline,'VERSION_CONFLICT','当前配置已改变，请重新核对草稿',409);
  const scopes=splitConfiguration(old.content.configuration,unit),previewHash=hash({revisionId:old.revisionId,versions,scopes});
  const changedGroups=Object.keys(unit.config).filter(k=>hash(unit.config[k])!==hash(old.content.configuration[k]));
  if(workspace==='configuration/preview')return {commands:[{type:'assert',id:old.id,expectedVersion:old.version},...Object.entries(versions).map(([scope,expectedVersion])=>({type:'configuration.assert',scope,expectedVersion}))],response:async()=>({previewHash,semanticChange:changedGroups.some(k=>k!=='presentation'),changedGroups,affectedObjects:[],retainedObjectCount:Number((await tx.query("SELECT count(*) AS n FROM objects WHERE NOT historical")).rows[0].n),checks:['系统与项目字段各有唯一归属','已有对象继续使用其冻结标准','密钥、机器路径与执行资格不进入项目配置']})};
  check(workspace==='configuration/publish'&&body.previewHash===previewHash,'PREVIEW_STALE','配置预览已改变，请重新预览',409);
  return {commands:[...Object.entries(scopes).map(([scope,content])=>({type:'configuration.save',scope,content,expectedVersion:versions[scope]||0})),draftSave('configuration',old,{...old.content,status:'PUBLISHED'})],response:results=>({revisionId:results.at(-1).revisionId})};
}

async function commentAction(tx,body) {
  const unit=new PresentationRead(tx);
  check(['CREATE','EDIT','RESOLVE_USER','REOPEN'].includes(body.commentAction),'COMMENT_ACTION','评论动作无效');
  let command;
  if(body.commentAction==='CREATE') {
    const plan=await episodePlan(unit),targets=await commentTargets(unit,plan);
    const target=targets.find(t=>t.kind===body.target?.kind&&t.subjectId===body.target?.subjectId);
    check(target&&body.target.contentHash===target.contentHash&&body.target.contextHash===target.contextHash&&body.target.objectRevisionId===target.objectRevisionId&&body.target.expectedVersion===target.expectedVersion,'VERSION_CONFLICT','圈选依据已改变，原评论草稿仍保留',409);
    command={type:'save',kind:'COMMENT',id:identity(body.commentId),expectedVersion:0,title:target.label,content:{text:body.commentText,status:'OPEN',anchor:body.anchor,target:{...target,planRevisionId:target.revisionId,revisionId:target.objectRevisionId}},links:[{id:target.objectId,role:target.kind==='SCENE_SCRIPT'?'SCENE':'EPISODE',expectedVersion:target.expectedVersion}],dependencies:target.sourceVersions.map(s=>({revisionId:s.revisionId,sha256:s.sha256,purpose:'CONTENT'}))};
  } else {
    const current=await unit.detail(body.commentId);
    check(current.kind==='COMMENT'&&current.revision.id===body.commentRevisionId,'VERSION_CONFLICT','评论已被其他操作修改，原编辑仍保留',409);
    check(!body.latestEventId||body.latestEventId===(current.revision.content.eventId||current.revision.id),'VERSION_CONFLICT','评论状态已改变',409);
    const content={...current.revision.content};
    if(body.commentAction==='EDIT')content.text=body.commentText;
    if(body.commentAction==='RESOLVE_USER')content.status='RESOLVED';
    if(body.commentAction==='REOPEN')content.status='OPEN';
    command={type:'save',id:current.id,expectedVersion:current.version,content};
  }
  const sources=body.commentAction==='CREATE'?command.content.target.sourceVersions||[]:[];
  return {commands:[...sources.map(s=>({type:'assert',id:s.objectId,expectedVersion:s.expectedVersion})),command],response:results=>({commentId:command.id,eventId:results.at(-1).revisionId,commentRevisionId:results.at(-1).revisionId})};
}

const preparationFields=new Set(['sceneRole','audienceTakeaway','informationBoundary','beats','visualIntent','soundAndDialogueIntent','entityStateRequirements','timeAndSpace','materialGaps','nextPreparationAction','reviewFocus']);
const frozenPreparationFields=new Set(['sourceDialogue','generationAuthorized','formalShotIds','formalReviewCreated','adoptionCreated','formalAdoptionPerformed','adoptedAssetBindings','mediaObserved','canonicalEntityId','stateId','bindingStatus','locationBinding','stateBinding','zoneBinding','cameraBinding','freezeBinding']);
function frozenValues(value,path='',result={}) {
  if(value&&typeof value==='object')for(const [k,v]of Object.entries(value)){
    if(frozenPreparationFields.has(k))result[path+'.'+k]=v;
    else frozenValues(v,path+'.'+k,result);
  }
  return result;
}
async function preparationAction(tx,body) {
  const unit=new PresentationRead(tx),rows=await unit.rows(['PREPARATION']),row=rows.find(r=>r.id===body.objectId&&idFor(r,'SCENE')===body.sceneId);
  check(row&&row.version===body.expectedVersion&&row.revisionId===body.expectedRevisionId,'VERSION_CONFLICT','本场准备稿已改变，当前编辑仍保留',409);
  if(body.action==='comment') {
    const id=identifier('comment');
    return {commands:[{type:'save',id,kind:'COMMENT',expectedVersion:0,title:row.title+' · 准备意见',content:{text:body.text,status:'OPEN',target:{objectId:row.id,revisionId:row.revisionId,expectedVersion:row.version,sha256:row.sha256}},links:[{id:body.sceneId,role:'SCENE'}],dependencies:[{revisionId:row.revisionId,purpose:'CONTENT'}]}],response:results=>({commentId:id,revisionId:results[0].revisionId})};
  }
  check(body.action==='save','PREPARATION_ACTION','准备稿动作无效');
  const content=body.preparation;
  check(content&&typeof content==='object','PREPARATION_CONTENT','准备稿内容无效');
  for(const k of new Set([...Object.keys(content),...Object.keys(row.content)]))if(!preparationFields.has(k))check(hash(content[k]??null)===hash(row.content[k]??null),'PREPARATION_FROZEN','此准备字段为冻结依据，不能在正文编辑中改变：'+k,409);
  check(hash(frozenValues(content))===hash(frozenValues(row.content)),'PREPARATION_FROZEN','来源对白、实体身份和实际输入事实不能随准备稿改写',409);
  return {commands:[{type:'save',id:row.id,expectedVersion:body.expectedVersion,content}],response:results=>({revisionId:results[0].revisionId,objectId:row.id,expectedVersion:results[0].version})};
}

async function reviewAction(tx,workspace,body) {
  const unit=new PresentationRead(tx),episode=workspace==='episode-plan-reviews',id=episode?body.episodeUid:['ASSET','WORK_PRODUCT'].includes(body.subjectType)?body.versionId:body.subjectId;
  const row=await unit.detail(id),revisionId=row.revision.id;
  check(body.expectedVersion===row.version&&body.objectRevisionId===revisionId,'VERSION_CONFLICT','所审对象已改变，请保留判断并重新核对',409);
  const decision=({APPROVE_AND_RELEASE:'ADOPT',REQUEST_REVISION:'REQUEST_CHANGES',DO_NOT_USE:'DISABLE'})[body.reviewAction||body.action];
  check(decision,'REVIEW_DECISION','请选择正式结论');
  if(episode)check(row.kind==='EPISODE','EPISODE_REQUIRED','请绑定本集永久身份');
  if(row.kind==='SCENE') {
    const parents=(await unit.rows(['EPISODE'])).filter(e=>e.links.some(l=>l.role==='SCENE'&&l.id===row.id));
    check(parents.length===1&&parents[0].state==='ADOPTED','EPISODE_NOT_ADOPTED','请先确认本集叙事要求',409);
  }
  let spec=row.revision.content.reviewSpec,standard,reviewBasis;
  const extra=[];
  if(row.kind==='ASSET') {
    if(body.subjectType==='WORK_PRODUCT'){
      const output=(await unit.rows(['EXPECTED_OUTPUT'])).find(o=>o.content.workItemId===body.workItemId&&o.content.expectationState==='PLANNED'),family=(await tx.query('SELECT family_id FROM asset_versions WHERE object_id=$1',[row.id])).rows[0];
      check(output&&idsFor(output,'FAMILY').includes(family?.family_id),'OUTPUT_BINDING','制作成果与本工作项的精确输出不一致',409);spec=output.content.reviewSpec;reviewBasis={id:output.id,expectedVersion:output.version,revisionId:output.revisionId,reviewSpecHash:body.reviewSpecHash};extra.push({type:'assert',id:output.id,expectedVersion:output.version});
    }else if(workspace!=='candidates/reviews'){
    const requirement=await unit.detail(body.requirementId),family=(await tx.query('SELECT family_id FROM asset_versions WHERE object_id=$1',[row.id])).rows[0];
    check(requirement.kind==='REQUIREMENT'&&requirement.version===body.requirementVersion&&requirement.revision.id===body.requirementRevisionId&&requirement.links.some(l=>l.role==='FAMILY'&&l.id===family?.family_id),'VERSION_CONFLICT','素材需求或归属已改变',409);
    spec=requirement.revision.content.reviewSpec;
    reviewBasis={id:requirement.id,expectedVersion:requirement.version,revisionId:requirement.revision.id,reviewSpecHash:body.reviewSpecHash};
    extra.push({type:'assert',id:requirement.id,expectedVersion:requirement.version});
    }
    const rights=(await tx.query('SELECT * FROM rights WHERE revision_id=$1',[revisionId])).rows[0];
    if(body.rightsUnknownConfirmation) {
      check(decision==='ADOPT'&&body.rightsUnknownConfirmation.confirmed===true&&body.rightsUnknownConfirmation.scope==='PROJECT_INTERNAL_ONLY'&&rights?.fact==='UNKNOWN','RIGHTS_CONFIRMATION','仅可明确确认未知权利素材在本项目内部使用');
      extra.push({type:'rights.record',id:row.id,expectedVersion:row.version,revisionId,explicit:true,fact:'UNKNOWN',internalAttestation:true,evidence:{note:body.rightsUnknownConfirmation.basis,scope:'PROJECT_INTERNAL_ONLY'}});
    }
    if(body.supersedesReviewEventId)check(!(await tx.query("SELECT 1 FROM dependencies d JOIN objects o ON o.adopted_revision_id=d.consumer_revision_id WHERE d.dependency_revision_id=$1 AND d.purpose='ACTUAL_INPUT' AND o.kind='INPUT_LOCK' AND o.state='ADOPTED' LIMIT 1",[revisionId])).rowCount,'REVIEW_CORRECTION_LOCKED','此素材版本已被锁定为实际输入，请新建版本',409);
  }
  if(!spec&&row.kind==='SCENE') {
    const config=await unit.configuration();spec=config.reviewProfiles.find(p=>p.id==='script-scene');
    standard={id:'script-scene',expectedVersion:unit.configurationVersions.system};
    check(body.configurationVersion===standard.expectedVersion,'VERSION_CONFLICT','审阅标准已改变',409);
  }
  check(spec&&body.reviewSpecHash===(spec.hash||hash(spec)),'REVIEW_SPEC_CONFLICT','审阅标准与所见版本不一致',409);
  const findings=(body.criterionFindings||[]).map(f=>({...f,criterionId:episode&&f.criterionId.startsWith('episode:'+id+':')?f.criterionId.slice(('episode:'+id+':').length):f.criterionId}));
  check(new Set(findings.map(f=>f.criterionId)).size===findings.length,'REVIEW_FINDINGS','判断条目不能重复');
  for(const c of spec.criteria.filter(c=>c.required!==false)) {
    const finding=findings.find(f=>f.criterionId===c.id);
    check(finding&&['PASS','FAIL','NA'].includes(finding.verdict),'REQUIRED_CRITERION','请完成全部审阅条目');
    check(finding.verdict!=='NA'||c.allowNA===true,'NA_NOT_ALLOWED','此项不能选择不适用');
    check(finding.verdict!=='FAIL'||!c.noteRequiredOnFail||finding.note?.trim(),'FINDING_NOTE_REQUIRED','问题项请填写说明');
  }
  const commands=[...extra],supersedes=body.supersedesReviewEventId||body.supersedesEpisodeSubmissionEventId;
  let version=row.version+extra.filter(c=>c.type==='rights.record').length;
  if(['DRAFT','CHANGES_REQUESTED'].includes(row.state)&&decision!=='DISABLE'&&!supersedes) {commands.push({type:'submit',id,expectedVersion:version,revisionId});version++;}
  commands.push({type:'review',id,expectedVersion:version,revisionId,decision,explicit:true,reassess:row.state==='ADOPTED'&&!row.reviews.length,note:body.note||'',findings,reviewStandard:standard,reviewBasis,productionEvidence:body.shotProductionEvidence,reviewMetadata:Object.fromEntries(['subjectType','subjectId','workItemId','workPackageId','productionPhaseId','productionGateId','scopeType','scopeId','contextHash','reviewContextRef','reviewSpecHash','subjectRevisionId','versionId','versionSha256'].filter(k=>body[k]!==undefined).map(k=>[k,body[k]])),...(supersedes?{supersedesReviewId:supersedes}:{})});
  return {commands,response:results=>{
    const last=results.at(-1),action=body.reviewAction||body.action;
    return {eventId:last.reviewId,event:{eventId:last.reviewId,episodeUid:episode?id:undefined,subjectRevisionId:body.subjectRevisionId,objectRevisionId:revisionId,action,recommendation:action,criterionFindings:body.criterionFindings,note:body.note||'',sourceSyncRequired:false},adopted:last.state==='ADOPTED',affected:last.affected,allEpisodesSubmitted:false};
  }};
}

async function shotDesignAction(tx,body) {
  check(body.subjectKind==='SHOT_PLAN_SET','CREATIVE_KIND','请选择镜头设计对象');
  const unit=new PresentationRead(tx),rows=await unit.rows(['SHOT_DESIGN']),plan=rows.find(r=>r.id===body.subjectId),sceneId=body.content?.sceneId;
  check(sceneId,'SCENE_REQUIRED','镜头设计须绑定永久场身份');
  check(plan&&plan.version===body.expectedVersion&&plan.revisionId===body.objectRevisionId&&plan.sha256===body.baseRevisionHash&&idFor(plan,'SCENE')===sceneId,'VERSION_CONFLICT','本场镜头设计已改变；编辑内容仍保留',409);
  const parent=await unit.detail(plan.id),scene=await unit.detail(sceneId),episode=(await unit.rows(['EPISODE'])).find(e=>e.links.some(l=>l.role==='SCENE'&&l.id===sceneId));
  check(episode?.state==='ADOPTED','EPISODE_NOT_ADOPTED','本集叙事尚未采用',409);
  for(const [type,row]of [['SCENE_REVISION',{id:scene.id,sha256:scene.revision.sha256}],['EPISODE_REVISION',episode]])check(body.basisBindings?.some(b=>b.bindingType===type&&b.bindingId===row.id&&b.bindingHash===row.sha256),'INPUT_REVISION_CONFLICT','镜头设计的本集或本场依据已改变',409);
  const shots=body.content.shots;check(Array.isArray(shots)&&shots.length>0&&shots.length<=90,'SHOT_LIST','一次设计须包含 1 至 90 个镜头');
  const ids=shots.map(s=>identity(s.shotId));check(new Set(ids).size===ids.length,'SHOT_IDENTITY','镜头永久身份重复');
  const originalIds=parent.links.filter(l=>l.role==='SHOT').map(l=>l.id),changedIdentity=hash(ids)!==hash(originalIds);
  check(!changedIdentity||typeof body.content.identityChangeReason==='string'&&body.content.identityChangeReason.trim()&&body.content.identityChangeReason!=='NO_IDENTITY_CHANGE','SHOT_IDENTITY_REASON','增删或调整镜头顺序须说明原因');
  const oldShots=await unit.rows(['SHOT'],{historical:true,ids:[...new Set([...ids,...originalIds])]}),commands=[{type:'assert',id:scene.id,expectedVersion:scene.version},{type:'assert',id:episode.id,expectedVersion:episode.version}],dependencies=parent.dependencies.filter(d=>!oldShots.some(s=>s.revisionId===d.revisionId));
  for(const [index,input]of shots.entries()) {
    check(input.sceneId===sceneId,'SHOT_SCENE','镜头不能绑定到另一场');
    const old=oldShots.find(s=>s.id===input.shotId);
    check(!old||originalIds.includes(old.id),'SHOT_IDENTITY','此镜头身份已存在于其他设计或历史版本',409);
    if(old)check(input.objectVersion===old.version&&input.revisionId===old.revisionId,'VERSION_CONFLICT','镜头正文已改变，请保留编辑并重新核对',409,{id:old.id});
    const content=authored(input);delete content.id;delete content.shotId;delete content.sceneId;delete content.inputBindings;
    content.authority='A';content.order=index+1;content.inputBindings=old?.content.inputBindings||[];
    content.design=canonicalShotDesign(content.design);
    const requirements=content.materialRequirementRefs||[];
    check(Array.isArray(requirements)&&new Set(requirements).size===requirements.length,'MATERIAL_REQUIREMENTS','素材需求身份不能重复');
    const references=await unit.rows(['REQUIREMENT'],{ids:requirements});check(references.length===requirements.length,'MATERIAL_REQUIREMENTS','设计引用了不存在或已退役的需求');
    const inputs=[{revisionId:scene.revision.id,sha256:scene.revision.sha256,purpose:'CONTENT'},...references.map(r=>({revisionId:r.revisionId,sha256:r.sha256,purpose:'DEFINITION'}))];
    if(old&&hash(content)===hash(old.content)) {commands.push({type:'assert',id:old.id,expectedVersion:old.version});dependencies.push({revisionId:old.revisionId,purpose:'DESIGN'});}
    else {const from=commands.length;commands.push({type:'save',id:input.shotId,kind:'SHOT',expectedVersion:old?.version||0,title:input.title,content,position:index,links:[{id:sceneId,role:'SCENE'},...requirements.map(id=>({id,role:'REQUIREMENT'}))],dependencies:inputs});dependencies.push({revisionIdFrom:from,objectId:input.shotId,purpose:'DESIGN'});}
  }
  commands.push({type:'save',id:plan.id,expectedVersion:plan.version,content:{...plan.content,identityChangeReason:body.content.identityChangeReason},links:[...parent.links.filter(l=>l.role!=='SHOT'),...ids.map(id=>({id,role:'SHOT'}))],dependencies});
  return {commands,response:results=>({creativeRevisionId:results.at(-1).revisionId,expectedVersion:results.at(-1).version,formalAdoptionPerformed:false})};
}

export async function planWorkspaceChange(tx, command, context) {
  check(typeof command.workspace==='string','WORKSPACE_REQUIRED','请选择工作区');
  const body=command.input||{};
  if(command.workspace==='settings'){
    const unit=new PresentationRead(tx);await unit.configuration();
    check(body.revisionId===hash(unit.configurationVersions),'VERSION_CONFLICT','实例配置已改变；编辑仍保留',409);
    for(const key of ['storyTitle','title','mark','description'])check(typeof body[key]==='string'&&body[key].length<=(key==='mark'?4:300)&&(key==='description'||body[key].trim()),'INSTANCE_SETTING','实例名称或说明无效');
    check(['overview','story','settings','materials','pipeline','system'].includes(body.landingView)&&['HUMAN_AI','HUMAN_FIRST','AI_FIRST'].includes(body.preferredCollaborator)&&typeof body.assistantEnabled==='boolean','INSTANCE_SETTING','默认入口或协作偏好无效');
    const project={...unit.projectConfiguration,title:body.storyTitle,branding:{...unit.projectConfiguration.branding,title:body.title,mark:body.mark,description:body.description},defaultWorkspace:body.landingView,preferredCollaborator:body.preferredCollaborator};
    const system={...unit.systemConfiguration,assistant:{...unit.systemConfiguration.assistant,enabled:body.assistantEnabled}};
    return {commands:[{type:'configuration.save',scope:'project',expectedVersion:unit.configurationVersions.project||0,content:project},{type:'configuration.save',scope:'system',expectedVersion:unit.configurationVersions.system||0,content:system}],response:results=>({revisionId:hash(Object.fromEntries(results.map(r=>[r.scope,r.version])))})};
  }
  if(command.workspace==='domain-workspaces')return domainAction(tx,body);
  if(command.workspace==='relations')return relationsAction(tx,body);
  if(['configuration','configuration/preview','configuration/publish'].includes(command.workspace))return configurationAction(tx,command.workspace,body);
  if(command.workspace==='script-comments')return commentAction(tx,body);
  if(command.workspace==='production-preparation')return preparationAction(tx,body);
  if(command.workspace==='episode-organization')return planEpisodeOrganization(tx,body);
  if(command.workspace==='input-locks')return planInputLockChange(tx,body);
  if(['execution-requests','runs','imports'].includes(command.workspace))return planExecutionChange(tx,command.workspace,body,context);
  if(command.workspace==='material-production')return planMaterialProductionChange(tx,body);
  if(command.workspace==='material-usage')return planMaterialReview(tx,'usage',body);
  if(command.workspace==='asset-context-revalidation')return planMaterialReview(tx,'context',body);
  if(command.workspace==='sources')return planSourceRegistration(tx,body,context.operationId);
  if(command.workspace==='authoring')return planAuthoringChange(tx,body,context.operationId);
  if(command.workspace==='story-editing')return planStoryEdit(tx,body);
  if(command.workspace==='candidates/reviews'){
    const row=await new PresentationRead(tx).detail(body.objectId);
    const media=(await tx.query("SELECT sha256 FROM asset_media WHERE revision_id=$1 AND role='OUTPUT'",[row.revision.id])).rows;
    check(row.kind==='ASSET'&&row.revision.content.sourceRef?.trialAssetId===row.id&&row.revision.content.sourceRef.scopeId===body.scopeId&&row.revision.content.sourceRef.versionId===body.versionId&&idFor(row,'FAMILY')===body.mediaId&&media.length===1&&media[0].sha256===body.sha256,'CANDIDATE_IDENTITY','候选范围、版本或原件已改变',409);
    return reviewAction(tx,'candidates/reviews',{...body,subjectType:'ASSET',subjectId:body.mediaId,versionId:row.id,objectRevisionId:body.objectRevisionId,expectedVersion:body.expectedVersion,reviewSpecHash:body.reviewSpecHash,action:({RELEASED:'APPROVE_AND_RELEASE',REVISION_REQUIRED:'REQUEST_REVISION',DO_NOT_USE:'DO_NOT_USE'})[body.decision],note:body.comment,criterionFindings:(body.criteria||[]).map(c=>({criterionId:c.id,verdict:c.result,note:c.comment||''})),...(body.rightsAttestation==='PROJECT_INTERNAL_ONLY'?{rightsUnknownConfirmation:{confirmed:true,scope:'PROJECT_INTERNAL_ONLY',basis:body.comment||'用户在本次候选审阅中明确确认仅用于本项目内部制作'}}:{})});
  }
  if(['reviews','episode-plan-reviews'].includes(command.workspace))return reviewAction(tx,command.workspace,body);
  if(command.workspace==='spatial-shot-view')return planSpatialViewChange(tx,body);
  if(command.workspace==='shot-production/recipes')return planShotRecipeChange(tx,body);
  if(command.workspace==='shot-production'&&body.action==='manifest-preview')return planManifestPreview(tx,body);
  if(command.workspace==='shot-production')return planShotSettingsChange(tx,body);
  if(command.workspace==='creative-revisions')return shotDesignAction(tx,body);
  if(command.workspace==='shot-production/animatics'){
    const unit=new PresentationRead(tx),state=await animaticWorkspace(unit,body.sceneId);
    check(body.expectedReleaseId===state.releaseId&&body.expectedRevisionId===state.revisionId,'VERSION_CONFLICT','时间线或镜头依据已变化；草稿仍保留',409);
    check(body.action==='save','ANIMATIC_ACTION','请通过后台操作接口提交预演任务',409);
    check(state.basis&&!state.readOnly,'ANIMATIC_BASIS','镜头依据尚未完整',409);
    const timeline=validateAnimaticTimeline(body.content,{sceneId:body.sceneId,shotPlanRevisionId:state.basis.shotPlanRevisionId,shotIds:state.basis.shots.map(s=>s.shotId)});
    const commands=unit.finish({})._basis.filter(b=>b.objectId===body.sceneId||b.revisionId===state.basis.shotPlanRevisionId||state.basis.shots.some(s=>s.shotId===b.objectId)).map(b=>({type:'assert',id:b.objectId,expectedVersion:b.expectedVersion}));
    const inputs=[];
    for(const m of animaticMediaBindings(timeline)){
      const v=state.availableMedia.find(v=>v.id===m.versionId&&v.familyId===m.familyId&&v.sha256===m.sha256);check(v,'ANIMATIC_MEDIA','所选媒体未采用、权利未知、缺失或版本已改变',409);
      commands.push({type:'assert',id:v.id,expectedVersion:v.objectVersion});inputs.push({revisionId:v.revisionId,sha256:v.revisionSha256,purpose:'ACTUAL_INPUT'});
    }
    if(!state.outputFamilyExists)commands.push({type:'save',kind:'MATERIAL',id:state.outputFamilyId,expectedVersion:0,title:'场级预演',content:{description:'本场预演候选'},links:[{id:body.sceneId,role:'SCENE'}]});
    commands.push({type:'save',id:state.objectId,kind:'ASSEMBLY',title:'场级预演时间线',expectedVersion:state.expectedVersion,content:{role:'ANIMATIC',timeline,expectedOutputId:state.expectedOutputId},links:[{id:body.sceneId,role:'SCENE'},{id:state.outputFamilyId,role:'FAMILY'}],dependencies:[{revisionId:state.basis.shotPlanRevisionId,purpose:'DESIGN'},...inputs]});
    return {commands,response:results=>({revisionId:results.at(-1).revisionId,timelineRevisionId:results.at(-1).revisionId,formalAdoptionPerformed:false})};
  }
  check(false,'WORKSPACE_ACTION','此工作区操作尚未接通：'+command.workspace,404);
}
