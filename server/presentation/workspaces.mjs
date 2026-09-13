import {productionEvidenceTemplate} from '../production/review-evidence.mjs';
import {evidenceRecord} from './evidence.mjs';
import {inputLockWorkspace} from '../production/input-locks.mjs';
import {executionState} from '../production/execution.mjs';
import {presentRecipe} from './recipe.mjs';
import {authoringWorkspace} from '../story/authoring.mjs';
import {shotRecipeWorkspace} from '../production/recipes.mjs';
import {candidateScopeIndex,candidateSnapshot} from './candidates.mjs';
import {storyEditor,episodeOrganization} from '../story/editing.mjs';
import {archivedPlanIndex,archivedReviews} from './archived-story.mjs';
import {materialProductionWorkspace} from '../materials/production-settings.mjs';
import {materialUsageSelection,materialReviewWorkspace} from '../materials/usage-reviews.mjs';
import { PresentationRead } from './read-unit.mjs';
import { bootstrap, episodePlan, sourceCatalog, sourceText, storySources } from './story.mjs';
import { domainWorkspace, materialDirectory, assets, materialRows, assetReviewContextHash } from './materials.mjs';
import { productionPage, preparationWorkspace, workflowWorkspace } from './production.mjs';
import { spatialBaseline } from '../workspaces.mjs';
import { catalog } from '../repository.mjs';
import { hash, check } from '../shared/contracts.mjs';
import { configurationDefaults } from './defaults.mjs';
import { creativeRevisions, episodeReviews, storyComments, sceneReviewContext, reviewEvent, reviewHistory } from './review.mjs';
import { episodeProduction, shotProduction } from './scene-production.mjs';
import { workspaceDraft } from '../workspace-drafts.mjs';
import {spatialViewWorkspace} from '../production/spatial-views.mjs';
import {animaticWorkspace} from './animatics.mjs';
import {parseProductionMaterialQuery,queryProductionMaterialPage} from './production-material-query.mjs';

export async function configurationWorkspace(unit) {
  const configuration = await unit.configuration();
  const rows = await unit.rows(['STORY','EPISODE','SCENE','REQUIREMENT','SHOT_DESIGN']);
  const bindings = rows.filter(r=>r.content.reviewSpec).map(r=>({key:r.id,title:r.title,kind:r.kind,profileId:r.content.reviewSpec.id||'unknown',profileLabel:r.content.reviewSpec.label,reviewSpecHash:hash(r.content.reviewSpec),configurationHash:hash(configuration)}));
  const draft=await workspaceDraft(unit.tx,'configuration');
  return {snapshotId:await unit.namespace(),releaseId:hash(unit.configurationVersions),revisionId:hash(unit.configurationVersions),sha256:hash(configuration),configuration,defaults:configurationDefaults,bindings,boundStandards:rows.map(r=>r.content.reviewSpec).filter(Boolean),history:[],initialized:true,readOnly:false,draft:draft?{...draft.content,revisionId:draft.revisionId,published:draft.content.status==='PUBLISHED'}:null,trialAvailable:(await candidateScopeIndex(unit)).scopes.length>0};
}
export async function operationalProjection(unit) {
  const {assetFamilies,assetVersions}=await assets(unit);
  const requirements=await materialRows(unit),events=await reviewHistory(unit,{limit:5000});
  const locks=(await unit.tx.query("SELECT d.dependency_revision_id,o.id FROM dependencies d JOIN objects o ON o.adopted_revision_id=d.consumer_revision_id WHERE o.kind='INPUT_LOCK' AND d.purpose='ACTUAL_INPUT' AND o.state='ADOPTED'")).rows;
  const versions=assetVersions.map(v=>{
    const refs=requirements.filter(r=>r.assetFamilyRefs.includes(v.familyId)),head=events.find(e=>e.versionId===v.id),locked=locks.filter(l=>l.dependency_revision_id===v.revisionId);
    return {...v,adoptionFact:v.lifecycleState==='RELEASED'&&!head?{revisionId:v.revisionId,canFlowDownstream:v.canFlowDownstream}:null,reviewContextHash:assetReviewContextHash(v,requirements),reviewCorrection:head?{state:locked.length?'LOCKED':'OPEN',headEventId:head.eventId,lockReasons:locked.map(l=>({code:'ACTUAL_INPUT_LOCKED',message:'此版本已用于锁定的实际输入',subjectId:l.id})),canCorrect:locked.length===0}:null};
  });
  const scenes=await unit.rows(['SCENE']),episodes=await unit.rows(['EPISODE']);
  const state=r=>({id:r.id,revisionId:r.revisionId,objectVersion:r.version,lifecycleState:r.state==='ADOPTED'?'RELEASED':r.state,canFlowDownstream:r.state==='ADOPTED',reviewHeadEventId:events.find(e=>e.subjectId===r.id)?.eventId||null});
  return {schemaVersion:'2.1',assetFamiliesById:Object.fromEntries(assetFamilies.map(f=>[f.id,{...f,adoptedVersionId:f.adoptedVersionRef,currentVersionId:f.currentVersionRef}])),assetVersionsById:Object.fromEntries(versions.map(v=>[v.id,v])),workItemsById:{},materialWorkItemsById:{},workPackagesById:{},shotsById:{},scenesById:Object.fromEntries(scenes.map(r=>[r.id,state(r)])),scriptScenesById:Object.fromEntries(scenes.map(r=>[r.id,state(r)])),episodesById:Object.fromEntries(episodes.map(r=>[r.id,state(r)])),materialRequirementsById:Object.fromEntries(requirements.map(r=>[r.id,r]))};
}
export async function workspaceRead(tx, path, params) {
  const unit = new PresentationRead(tx), name=path.join('/');
  let result;
  if(name==='profile')result=await unit.profile();
  else if(name==='settings')result={profile:await unit.profile(),revisionId:hash(unit.configurationVersions)};
  else if(name==='views/bootstrap')result={data:await bootstrap(unit)};
  else if(name==='views/episode-plan')result={plan:await episodePlan(unit,params.get('revisionId'),params.get('archive')==='1')};
  else if(name==='views/shot-production-review-evidence')result={...await productionEvidenceTemplate(unit,params.get('workItemId'),params.get('versionId')),snapshotId:await unit.namespace()};
  else if(name==='views/evidence')result=await evidenceRecord(unit,params);
  else if(name==='story-history')result={items:await archivedPlanIndex(unit)};
  else if(name==='input-locks')result=(await inputLockWorkspace(unit,Object.fromEntries(params))).value;
  else if(name==='execution-requests')result=await executionState(tx,params.get('executionRequestId'));
  else if(name==='authoring')result=await authoringWorkspace(unit);
  else if(name==='episode-organization')result=await episodeOrganization(unit,params.get('episodeId'));
  else if(name==='story-editing')result=await storyEditor(unit,params.get('objectId'));
  else if(name==='creative-revisions')result=await creativeRevisions(unit,params);
  else if(name==='script-comments')result=await storyComments(unit,params);
  else if(name==='episode-plan-reviews')result=await episodeReviews(unit,params);
  else if(name==='views/scene-review-context')result=await sceneReviewContext(unit,params);
  else if(name==='reviews'){const id=params.get('versionId')||params.get('subjectId');result={events:params.get('archive')==='1'?await archivedReviews(unit,params.get('subjectRevisionId')):id?await reviewHistory(unit,{id}):[],snapshotId:await unit.namespace(),mutationEtag:await unit.namespace()};}
  else if(name==='views/story-sources')result={snapshotId:await unit.namespace(),storySources:await storySources(unit)};
  else if(name==='configuration'&&params.get('export')==='1'){
    const configuration=await unit.configuration();
    result={kind:'REVIEW_CONFIGURATION_TEMPLATE',schemaVersion:'2.0',configuration:{...configuration,presentation:structuredClone(configurationDefaults.presentation),sources:{...configuration.sources,order:structuredClone(configurationDefaults.sources.order)},technical:{...configuration.technical,picture:structuredClone(configurationDefaults.technical.picture)}}};
  }
  else if(name==='configuration')result=await configurationWorkspace(unit);
  else if(name==='configuration/export')result={schemaVersion:'1.0',configuration:await unit.configuration()};
  else if(name==='domain-workspaces')result=await domainWorkspace(unit,params.get('owner')||'SETTINGS');
  else if(name==='relations'){
    const state=await domainWorkspace(unit,'SETTINGS'),draft=await workspaceDraft(tx,'relations'),graph=structuredClone(state.graph);
    if(draft?.content.status==='DRAFT')for(const change of draft.content.changes||[]){const rows=graph[change.collection],index=rows.findIndex(r=>r.id===change.id);if(change.value===null){if(index>=0)rows.splice(index,1);}else if(index>=0)rows[index]=change.value;else rows.push(change.value);}
    result={...state,draftHeadRevisionId:draft?.revisionId||null,draft:draft?.content.status==='DRAFT'?{revisionId:draft.revisionId,content:graph,changes:draft.content.changes}:null};
  }
  else if(name==='material-directory')result=await materialDirectory(unit,params.get('detail')==='summary');
  else if(name==='material-production')result=(await materialProductionWorkspace(unit,Object.fromEntries(params))).value;
  else if(name==='material-usage')result=params.has('versionId')?(await materialReviewWorkspace(unit,'usage',Object.fromEntries(params))).value:await materialUsageSelection(unit,params.get('requirementId'));
  else if(name==='asset-context-revalidation')result=(await materialReviewWorkspace(unit,'context',Object.fromEntries(params))).value;
  else if(name==='production-preparation')result=await preparationWorkspace(unit,params.get('sceneId'));
  else if(name==='episode-production')result=await episodeProduction(unit,params);
  else if(name==='spatial-shot-view')result=(await spatialViewWorkspace(unit,Object.fromEntries(params))).value;
  else if(name==='shot-production/recipes')result=(await shotRecipeWorkspace(unit,params.get('workItemId'))).value;
  else if(name==='shot-production')result=await shotProduction(unit,params.get('sceneId'));
  else if(name==='shot-production/animatics')result=await animaticWorkspace(unit,params.get('sceneId'));
  else if(name==='views/production-materials'){const view=await productionPage(unit,params),basis=unit.finish({})._basis;result={...queryProductionMaterialPage(view.page,{},parseProductionMaterialQuery(new URL('http://workspace/?'+params),basis)),snapshotId:await unit.namespace(),operationRevision:hash(basis)};}
  else if(['views/production','views/materials'].includes(name))result=await productionPage(unit,params,name==='views/materials');
  else if(name==='workflow'||name==='action-queue'){const workflow=await workflowWorkspace(unit);result=name==='workflow'?workflow:workflow.queue;}
  else if(name==='spatial-settings'){const value=await spatialBaseline(tx);result={...value,snapshotId:await unit.namespace()};}
  else if(name==='sources')result=await sourceCatalog(unit);
  else if(name==='documents'){const id=params.get('id')||params.get('documentId');check(id,'DOCUMENT_ID','请选择资料');result=await sourceText(unit,id,params.get('revisionId')||undefined);}
  else if(name==='operations/snapshot')result={snapshotId:await unit.namespace(),mutationEtag:await unit.namespace(),stateProjection:params.get('summary')?undefined:await operationalProjection(unit),reviews:params.get('summary')?undefined:{events:await reviewHistory(unit,{limit:5000})}};
  else if(name==='views/adaptation-audit'){const b=await bootstrap(unit);result={snapshotId:await unit.namespace(),adaptationAudit:b.adaptationAudit,scenes:b.creativeLineage.scenes,storyConfirmations:[],audioVerifications:[],sceneReviewDossiers:[]};}
  else if(name==='views/search'){const hits=await catalog(tx,{query:params.get('q')||'',limit:Math.min(Number(params.get('limit')||12),50)});result={snapshotId:await unit.namespace(),results:hits.items.map(r=>({id:r.id,title:r.title,label:r.title,type:r.kind,kind:r.kind,href:'?view='+({story:'story',settings:'settings',materials:'materials',production:'pipeline'}[r.module]||'overview'),excerpt:r.preview.description})),total:hits.total};}
  else if(name==='asset-versions'){
    const value=await assets(unit,params.get('familyId')?[params.get('familyId')]:undefined),version=params.get('versionId'),sha=params.get('sha256');
    const exact=version?value.assetVersions.find(v=>v.id===version&&(!sha||v.sha256===sha)):null;
    const events=exact?(await tx.query("SELECT content FROM provenance WHERE kind='asset-version' AND content->>'familyId'=$1 AND content->>'versionId'=$2 AND content->>'sha256'=$3",[exact.familyId,exact.id,exact.sha256])).rows.map(r=>({...r.content,mediaToken:exact.sha256})):[];
    result={snapshotId:await unit.namespace(),events,versions:value.assetVersions,assetVersions:value.assetVersions,hasMore:false,nextCursor:null,total:value.assetVersions.length};
  }
  else if(path[0]==='recipes'&&path.length===2){const row=await unit.detail(path[1],params.get('revisionId')||undefined);check(row.kind==='CALL','CALL_REQUIRED','所选对象不是调用定义',404);result={recipe:presentRecipe(row)};}
  else if(name==='candidates/scopes')result=await candidateScopeIndex(unit);
  else if(name==='candidates/snapshot')result=await candidateSnapshot(unit,params.get('scopeId'));
  else check(false,'WORKSPACE_NOT_FOUND','工作区接口不存在：'+name,404);
  return unit.finish(result);
}
