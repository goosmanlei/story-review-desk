import {productionReadiness} from '../production/review-evidence.mjs';
import { idFor, idsFor, present } from './read-unit.mjs';
import { hash, check } from '../shared/contracts.mjs';
import { spatialBaseline } from '../workspaces.mjs';
import { reviewEvent } from './review.mjs';
import { assets, materialRows } from './materials.mjs';
import {spatialCatalog,availableLocalViews} from '../production/spatial-views.mjs';

export async function episodeProduction(unit,params){
  const sceneId=params.get('sceneId'),episodeId=params.get('episodeUid');
  const scene=await unit.detail(sceneId),ep=await unit.detail(episodeId);
  check(ep.links.some(l=>l.role==='SCENE'&&l.id===sceneId),'SCENE_MEMBERSHIP','本场不属于所选分集',409);
  const rows=(await unit.rows(['COVERAGE','SHOT_DESIGN'])).filter(r=>idFor(r,'SCENE')===sceneId);
  const canAuthor=ep.state==='ADOPTED';
  const plans=[];
  for(const [kind,uiKind] of [['COVERAGE','SCENE_COVERAGE'],['SHOT_DESIGN','SHOT_PLAN_SET']]){
    const row=rows.find(r=>r.kind===kind),id=row?.id||uiKind+':'+sceneId;
    const content={sceneId, ...(row?.content||{}), ...(kind==='SHOT_DESIGN'?{shots:(await unit.rows(['SHOT'],{ids:row?idsFor(row,'SHOT'):[]})).map(r=>({...present(r),shotId:r.id,sceneId,order:r.position,coverageBeatRefs:r.content.coverageBeatRefs||[],materialRequirementRefs:idsFor(r,'REQUIREMENT'),inputBindings:r.content.inputBindings||[]}))}:{})};
    const detail=row?await unit.detail(row.id):null,review=detail?.reviews.find(r=>r.revision_id===row.revisionId);
    plans.push({kind:uiKind,canAuthor,blockedReason:canAuthor?'':'本集叙事尚未采用；可以查看已有设计，采用与实际输入锁定分别核对。',basisBindings:[{bindingType:'SCENE_REVISION',bindingId:sceneId,bindingHash:scene.revision.sha256},{bindingType:'EPISODE_REVISION',bindingId:episodeId,bindingHash:ep.revision.sha256}],template:{planId:id,revisionHash:row?.sha256||hash(content),content,retiredShotIds:[]},candidate:row?{creativeRevisionId:row.revisionId,contentHash:row.sha256,contextHash:hash(detail.dependencies),content,scopedReviewSpec:row.content.reviewSpec,expectedVersion:row.version}:undefined,review:review?reviewEvent(review):undefined,state:{canFlowDownstream:row?.state==='ADOPTED'},materialRequirementSetSchemaVersion:'3.0'});
  }
  return {snapshotId:await unit.namespace(),episode:{displayId:ep.displayId,title:ep.title},release:{canFlowDownstream:canAuthor,reason:canAuthor?'本集采用版本已生效':'请先在叙事拆解确认本集要求'},plans,formalShotCount:rows.find(r=>r.kind==='SHOT_DESIGN'&&r.state==='ADOPTED')?plans[1].candidate.content.shots.length:null};
}
export async function availableSpace(unit,sceneId){
  const catalog=await spatialCatalog(unit);
  return {sourceSha256:catalog.sourceBinding?.sha256||null,version:catalog.version,locations:catalog.locations,states:catalog.states,localViews:await availableLocalViews(unit,sceneId)};
}
import {shotSettingsBasis,defaultShotSettings} from '../production/shot-settings.mjs';
export async function shotProduction(unit,sceneId){
  const basis=await shotSettingsBasis(unit,sceneId),{scene,design,shots,saved,published}=basis;
  const defaults=defaultShotSettings(basis,await materialRows(unit));
  const media=await assets(unit),requirements=await materialRows(unit),availableInputs=[...new Set(shots.flatMap(s=>idsFor(s,'REQUIREMENT')))].flatMap(id=>{const r=requirements.find(r=>r.id===id);return (r?.assetFamilyRefs||[]).flatMap(fid=>media.assetVersions.filter(v=>v.familyId===fid).map(v=>({requirementId:id,familyId:fid,versionId:v.id,sha256:v.sha256,label:r.title,purpose:'REFERENCE',canFlowDownstream:v.canFlowDownstream})));});
  const outputs=(await unit.rows(['EXPECTED_OUTPUT'])).filter(o=>o.content.sceneId===sceneId&&o.content.expectationState==='PLANNED'),stageEntries=outputs.map(o=>({id:o.content.workItemId,workItemId:o.content.workItemId,shotId:o.content.shotId,gateId:o.content.gateId,deliverableKey:o.content.deliverableKey,label:o.title,blockers:[]}));
  const manifestJobs=(await unit.tx.query("SELECT id,status,error FROM operations WHERE kind='PRODUCTION_MANIFEST_RENDER' AND request->>'sceneId'=$1 ORDER BY created_at DESC LIMIT 50",[sceneId])).rows.map(r=>({jobId:r.id,status:r.status,error:r.error?.message}));
  return {stageEntries,manifestTargets:stageEntries.filter(o=>['SHOT_INPUT_LOCK','LOCKED_SHOT'].includes(o.deliverableKey)),snapshotId:await unit.namespace(),sceneId,releaseId:basis.releaseId,readOnly:scene.historical,basis:design?{shots:shots.map(r=>({id:r.id,title:r.title,materialRequirementRefs:idsFor(r,'REQUIREMENT')}))}:null,blockers:design?[]:['本场尚未登记镜头设计；可以先整理准备稿。'],defaultContent:defaults,currentPlan:published?{content:published.content.content}:null,draft:saved?.content.status==='DRAFT'?{revisionId:saved.revisionId,content:saved.content.content}:null,draftHeadRevisionId:saved?.revisionId||null,availableInputs,availableSpace:await availableSpace(unit,sceneId),jobs:manifestJobs,manifestJobs,readiness:design?await productionReadiness(unit,sceneId,shots):{ready:false,readyCount:0,shotCount:null,shots:[]}};
}
