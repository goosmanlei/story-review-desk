import {idFor,idsFor} from './read-unit.mjs';
import {assets} from './materials.mjs';
import {hash} from '../shared/contracts.mjs';
import {animaticHashes,animaticImpact} from '../production/animatic-model.mjs';

export async function animaticWorkspace(unit,sceneId){
  const scene=await unit.detail(sceneId),design=(await unit.rows(['SHOT_DESIGN'])).find(r=>idFor(r,'SCENE')===sceneId);
  const shots=design?await unit.rows(['SHOT'],{ids:idsFor(design,'SHOT')}):[];
  const saved=(await unit.rows(['ASSEMBLY'])).find(r=>r.content.role==='ANIMATIC'&&idFor(r,'SCENE')===sceneId);
  const output=(await unit.rows(['EXPECTED_OUTPUT'])).find(o=>o.content.sceneId===sceneId&&o.content.deliverableKey==='ANIMATIC'&&o.content.expectationState==='PLANNED'),outputFamilyId=output?idFor(output,'FAMILY'):'animatic-family:'+sceneId,outputFamilyExists=Boolean((await unit.tx.query('SELECT 1 FROM objects WHERE id=$1',[outputFamilyId])).rowCount);
  const content=saved?.content.timeline||null,detail=saved?await unit.detail(saved.id):null;
  const media=await assets(unit),availableMedia=media.assetVersions.filter(v=>v.canFlowDownstream&&v.mediaUrl).map(v=>({...v,versionId:v.id,kind:v.mediaKind,path:v.path||'',label:v.label}));
  const blockers=[];
  if(!design)blockers.push('本场尚无镜头设计。');
  else if(design.state!=='ADOPTED')blockers.push('请先审阅采用本场镜头设计。');
  const ordered=design?idsFor(design,'SHOT').map(id=>shots.find(s=>s.id===id)).filter(Boolean):[];
  if(ordered.some(s=>!(s.content.design?.estimatedDurationSeconds>0)))blockers.push('请在镜头设计中填写每个镜头的预估时长，再建立时间线。预估时长尚未锁定。');
  const basis=ordered.length&&!blockers.length?{sceneId,shotPlanRevisionId:design.revisionId,stagePolicy:'PREVIS_FIRST_V1',dialogueLines:[],shots:ordered.map(s=>({shotId:s.id,title:s.title,durationFrames:Math.max(1,Math.round(s.content.design.estimatedDurationSeconds*24))}))}:null;
  const jobs=(await unit.tx.query("SELECT id,status,request,result,error FROM operations WHERE kind='ANIMATIC_RENDER' AND request->>'objectId'=$1 ORDER BY created_at DESC LIMIT 50",[saved?.id||''])).rows.map(j=>({jobId:j.id,jobRevisionId:hash({status:j.status,result:j.result,error:j.error}),status:j.status,timelineRevisionId:j.request.revisionId,error:j.error?.message,result:j.result}));
  const adopted=media.assetVersions.find(v=>v.familyId===outputFamilyId&&v.canFlowDownstream&&v.basis?.executionRevisionId),adoptedReview=adopted?(await unit.tx.query("SELECT id FROM reviews WHERE object_id=$1 AND revision_id=$2 AND decision='ADOPT' ORDER BY created_at DESC LIMIT 1",[adopted.id,adopted.revisionId])).rows[0]:null;
  const lock=adoptedReview?{timelineRevisionId:adopted.basis.executionRevisionId,reviewEventId:adoptedReview.id}:null;
  return {sceneId,outputFamilyId,outputFamilyExists,expectedOutputId:output?.id||null,runtimeEpoch:(await unit.profile()).deployment.runtimeEpoch,releaseId:hash({scene:scene.revision.id,design:design?.revisionId,shots:ordered.map(s=>s.revisionId)}),revisionId:saved?.revisionId||null,timelineRevisionId:saved?.revisionId||null,objectId:saved?.id||'animatic:'+sceneId,expectedVersion:saved?.version||0,content,hashes:content?animaticHashes(content):null,impact:content?animaticImpact(null,content):[],stale:!!content&&content.shotPlanRevisionId!==design?.revisionId,blockers,availableMedia,requiredCards:[],jobs,lock,basis,readOnly:scene.historical};
}
