import {errorResponse,HttpError,jsonResponse,operationalSnapshot,reviewData,deriveCurrentAdoptedMaterialSet,deriveCurrentMaterialRequirementSet} from '../_store';
import type {EpisodePlanContent} from '../../../episode-plan-context';

export async function GET(request:Request) {
  try {
    const url=new URL(request.url),episodeUid=url.searchParams.get('episodeUid')||'',sceneId=url.searchParams.get('sceneId')||'';
    const data=await reviewData(),ops=await operationalSnapshot();
    if(data.snapshotId!==ops.snapshotId)throw new HttpError(409,'快照已变化');
    const latest=ops.creativeRevisions.events.find(e=>e.subjectKind==='EPISODE_PLAN');
    const episode=(latest?.content as EpisodePlanContent|undefined)?.episodes.find(e=>e.episodeUid===episodeUid);
    if(!episode||!episode.sceneIds.includes(sceneId))throw new HttpError(409,'永久集与场不匹配，不按显示场号换绑');
    const release=ops.stateProjection.episodeNarrativeReleasesByUid[episodeUid];
    const plans=(['SCENE_COVERAGE','SHOT_PLAN_SET'] as const).map(kind=>{
      const template=(kind==='SCENE_COVERAGE'?data.productionModel.sceneCoveragePlanRevisions:data.productionModel.shotPlanSetRevisions)?.find(r=>r.scopeId===sceneId);
      const candidate=template?ops.creativeRevisions.events.find(e=>e.subjectKind===kind&&e.subjectId===template.planId):undefined;
      const review=candidate?ops.reviews.events.find(e=>e.subjectType==='CREATIVE_REVISION'&&e.creativeRevisionId===candidate.creativeRevisionId):undefined;
      const state=template?ops.stateProjection.structuresById[`${kind}::${String(template.planId)}`]:undefined;
      let basis:unknown[]=[],blockedReason='';
      try {
        if(!release?.canFlowDownstream)throw new Error(release?.reason||'本集尚未正式通过并完成受控同步');
        if(kind==='SCENE_COVERAGE'){
          const scene=data.productionModel.sceneScriptRevisions?.find(r=>r.sceneId===sceneId&&r.episodeNarrativeReleaseId===release.id);
          if(!scene||!data.sourceHashes?.productionMapSha256)throw new Error('本场正文或空间依据缺失');
          basis=[{bindingType:'EPISODE_NARRATIVE_RELEASE',bindingId:release.id,bindingHash:release.contentHash,scopeType:'EPISODE',scopeId:episodeUid},{bindingType:'SCENE_SCRIPT_REVISION',bindingId:scene.id,bindingHash:scene.contentHash,scopeType:'SCENE',scopeId:sceneId},{bindingType:'CONTINUITY_SPEC',bindingId:'PRODUCTION-MAP-SPEC',bindingHash:data.sourceHashes.productionMapSha256}];
        }else{
          const coverage=data.productionModel.sceneCoveragePlanRevisions?.find(r=>r.scopeId===sceneId&&r.scopeRole==='CURRENT');
          if(!coverage||!ops.stateProjection.structuresById[`SCENE_COVERAGE::${String(coverage.planId)}`]?.canFlowDownstream)throw new Error('本场镜头意图尚未通过并完成精确同步');
          const materials=deriveCurrentMaterialRequirementSet(data,sceneId,'3.0');
          basis=[{bindingType:'SCENE_COVERAGE_REVISION',bindingId:coverage.id,bindingHash:coverage.contentHash,scopeType:'SCENE',scopeId:sceneId},{bindingType:'MATERIAL_REQUIREMENT_SET',bindingId:materials.id,bindingHash:materials.contentHash,scopeType:'SCENE',scopeId:sceneId}];
        }
      }catch(error){blockedReason=error instanceof Error?error.message:'UNKNOWN';}
      let materialReadiness:Record<string,unknown>|null=null;
      if(kind==='SHOT_PLAN_SET'&&!blockedReason){
        try {const actual=deriveCurrentAdoptedMaterialSet(data,ops.stateProjection,sceneId);materialReadiness={adoptedMaterialSet:actual,materialsReady:true,canGenerate:false,reasons:['SHOT_EXACT_INPUT_LOCK_REQUIRED']};}
        catch(error){materialReadiness={materialsReady:false,canGenerate:false,reasons:[error instanceof Error?error.message:'MATERIAL_INPUT_UNKNOWN','SHOT_EXACT_INPUT_LOCK_REQUIRED']};}
      }
      return {kind,template,candidate,review,state,canAuthor:!blockedReason,blockedReason,basisBindings:basis,...(kind==='SHOT_PLAN_SET'?{planningContractVersion:'3.0',materialRequirementSetSchemaVersion:'3.0',adoptionScope:'SHOT_DESIGN_ONLY',canGenerate:false,materialReadiness}: {})};
    });
    return jsonResponse({snapshotId:data.snapshotId,episode:{episodeUid,displayId:episode.displayId,title:episode.title},sceneId,release:release?{id:release.id,state:release.state,canFlowDownstream:release.canFlowDownstream,reason:release.reason,reviewEventId:release.reviewEventId,episodeScriptReleaseSnapshot:release.episodeScriptReleaseSnapshot}:null,plans,wholePlanAdopted:false,formalShotCount:plans[1].state?.canFlowDownstream?(data.productionModel.shotPlanSetRevisions?.find(r=>r.scopeId===sceneId&&r.scopeRole==='CURRENT')?.denominator??null):null});
  }catch(error){return errorResponse(error,'本集制作入口不可用');}
}
