import {hash,check} from '../shared/contracts.mjs';

export async function archivedPlanIndex(unit) {
  const rows=(await unit.tx.query("SELECT o.id,o.title,r.id AS revision_id,r.content->>'originalRevisionId' AS original_revision_id,r.content->>'originalEventSha256' AS original_event_sha256,(r.content->>'text')::jsonb->>'recordedAt' AS recorded_at FROM objects o JOIN revisions r ON r.id=COALESCE(o.draft_revision_id,o.adopted_revision_id) WHERE o.kind='SOURCE' AND r.content->>'role'='ARCHIVED_EPISODE_PLAN' ORDER BY recorded_at,o.id LIMIT 501")).rows;
  check(rows.length<=500,'HISTORY_LIMIT','请进一步按历史范围读取',413);
  check(new Set(rows.map(r=>r.original_revision_id)).size===rows.length,'HISTORY_IDENTITY','历史方案身份存在冲突',409);
  return rows.map(r=>({objectId:r.id,sourceRevisionId:r.revision_id,revisionId:r.original_revision_id,sha256:r.original_event_sha256,title:r.title,recordedAt:r.recorded_at,readOnly:true}));
}

export async function archivedPlan(unit, revisionId) {
  const record=(await archivedPlanIndex(unit)).find(r=>r.revisionId===revisionId);
  if(!record)return null;
  const source=await unit.detail(record.objectId,record.sourceRevisionId),document=source.revision.content;
  check(hash(Buffer.from(document.text,'utf8'))===record.sha256&&record.sha256===document.sha256,'HISTORY_SHA','历史方案原件 SHA 不符',409);
  const event=JSON.parse(document.text),content=event.content;
  check(event.creativeRevisionId===revisionId&&event.subjectKind==='EPISODE_PLAN'&&Array.isArray(content?.episodes),'HISTORY_IDENTITY','历史事件与方案身份不符',409);
  const scenes=content.narrativeRevision?.scenes||[],presentation={};
  for(const episode of content.episodes){
    presentation[episode.episodeUid]={};
    for(const edge of ['opening','ending']){
      const boundary=episode.reviewDossier?.boundaryEvidence?.[edge],sceneId=boundary?.sceneId||(edge==='opening'?episode.sceneIds[0]:episode.sceneIds.at(-1)),scene=scenes.find(s=>s.id===sceneId);
      presentation[episode.episodeUid][edge]=scene?{sceneId,blocks:boundary?.blockIds?.length?scene.scriptBlocks.filter(b=>boundary.blockIds.includes(b.id)):scene.scriptBlocks}:null;
    }
  }
  const spec=event.reviewSpec||event.configurationBinding?.reviewSpec||undefined;
  return {readOnly:true,archived:true,revisionId,creativeRevisionId:revisionId,objectVersion:source.version,sourceRole:'CANDIDATE',snapshotId:await unit.namespace(),contentHash:event.contentHash,contextHash:event.contextHash,baseRevisionHash:event.baseRevisionHash,criteriaVersion:event.criteriaVersion,basisBindingsHash:event.basisBindingsHash,basisBindings:event.basisBindings,subjectNames:{},content,presentation,reviewSpec:spec,originalEvent:{eventId:document.originalEventId,sha256:record.sha256,recordedAt:event.recordedAt},historyNotice:scenes.length?'原候选正文与当时的永久集场身份，只读保留。':'这份早期方案未内嵌场正文；保留原分集设计，不套用当前稿。'};
}

export async function archivedReviews(unit,revisionId){
 const rows=(await unit.tx.query("SELECT content FROM provenance WHERE kind='review' AND content->>'subjectKind'='EPISODE_PLAN' AND content->>'subjectRevisionId'=$1 ORDER BY content->>'recordedAt' DESC,original_id DESC",[revisionId])).rows;
 return rows.map(r=>({...r.content,readOnly:true,historical:true}));
}
