import {archivedReviews} from './archived-story.mjs';
import { episodePlan } from './story.mjs';
import { storyCommentSources } from './story-comment-model.mjs';
import { sceneRequirements } from './scene-narrative-context.mjs';
import { hash, check } from '../shared/contracts.mjs';

export const decisionAction=decision=>({ADOPT:'APPROVE_AND_RELEASE',REQUEST_CHANGES:'REQUEST_REVISION',DISABLE:'DO_NOT_USE'})[decision];
export const reviewEvent=row=>({...(row.metadata||{}),schemaVersion:'2.2',eventKind:'review',eventId:row.id,subjectId:row.metadata?.subjectType==='WORK_PRODUCT'?row.metadata.workItemId:row.family_id||row.object_id,subjectRevisionId:row.revision_id,objectRevisionId:row.revision_id,subjectType:row.metadata?.subjectType==='WORK_PRODUCT'?'WORK_PRODUCT':row.kind==='ASSET'?'ASSET':row.kind==='SCENE'?'SCRIPT_SCENE':'CREATIVE_REVISION',familyId:row.family_id,versionId:row.kind==='ASSET'?row.object_id:row.revision_id,versionSha256:row.media_sha256,action:decisionAction(row.decision),reviewDecision:({ADOPT:'RELEASED',REQUEST_CHANGES:'REVISION_REQUIRED',DISABLE:'DO_NOT_USE'})[row.decision],criterionFindings:row.findings,note:row.note,createdAt:row.created_at,recordedAt:new Date(row.created_at).toISOString(),effect:'APPLIED',sourceSyncRequired:false,sourceSyncState:'SUCCEEDED'});

export async function reviewHistory(unit,{id,limit=100}={}) {
  const rows=(await unit.tx.query(`SELECT r.*,o.kind,av.family_id,am.sha256 AS media_sha256,
    COALESCE(p.content,'{}'::jsonb)||COALESCE(op.request->'commands'->0->'input','{}'::jsonb) AS metadata
    FROM reviews r JOIN objects o ON o.id=r.object_id LEFT JOIN asset_versions av ON av.object_id=o.id
    LEFT JOIN LATERAL (SELECT sha256 FROM asset_media WHERE revision_id=r.revision_id AND role='OUTPUT' ORDER BY media_id LIMIT 1) am ON true
    LEFT JOIN LATERAL (SELECT content FROM provenance WHERE kind='review' AND (original_id=r.id OR content->>'eventId'=r.id) LIMIT 1) p ON true
    LEFT JOIN operations op ON op.id=r.operation_id
    WHERE ($1::text IS NULL OR o.id=$1 OR av.family_id=$1) ORDER BY r.created_at DESC,r.id DESC LIMIT $2`,[id||null,limit])).rows;
  return rows.map(reviewEvent);
}
export async function episodeReviews(unit,params) {
  const plan=await episodePlan(unit,params.get('subjectRevisionId'),params.get('archive')==='1');
  if(!plan)return {heads:[],latestHeads:[],episodeReviews:[],episodeReleases:[]};
  if(plan.readOnly){const events=await archivedReviews(unit,plan.revisionId);return {heads:[],latestHeads:[],episodeReviews:[],episodeReleases:[],historicalEvents:events,readOnly:true};}
  const ids=plan.content.episodes.map(e=>e.episodeUid);
  const rows=(await unit.tx.query('SELECT DISTINCT ON(r.object_id) r.*,o.adopted_revision_id,o.draft_revision_id,o.state,o.version AS object_version FROM reviews r JOIN objects o ON o.id=r.object_id WHERE r.object_id=ANY($1::text[]) ORDER BY r.object_id,r.created_at DESC,r.id DESC',[ids])).rows;
  const current=rows.filter(r=>r.revision_id===r.draft_revision_id||!r.draft_revision_id&&r.revision_id===r.adopted_revision_id);
  const heads=current.map(r=>({...reviewEvent(r),criterionFindings:r.findings.map(f=>({...f,criterionId:f.criterionId.startsWith('episode:'+r.object_id+':')?f.criterionId:'episode:'+r.object_id+':'+f.criterionId})),episodeUid:r.object_id,subjectRevisionId:plan.revisionId,subjectRevisionHash:plan.contentHash,recommendation:decisionAction(r.decision),objectRevisionId:r.revision_id,objectVersion:r.object_version}));
  return {heads,latestHeads:heads,episodeReviews:heads,episodeReleases:current.map(r=>({episodeUid:r.object_id,state:r.state==='ADOPTED'?'CURRENT':r.state,canFlowDownstream:r.state==='ADOPTED'&&r.adopted_revision_id===r.revision_id,reason:r.state==='ADOPTED'?'本集采用版本已生效':'本集尚未采用',reviewEventId:r.id}))};
}
export async function creativeRevisions(unit,params) {
  if(params.get('subjectKind')==='EPISODE_PLAN') {const plan=await episodePlan(unit,params.get('revisionId'),params.get('archive')==='1');return {events:plan?[{...plan,creativeRevisionId:plan.revisionId,revisionState:plan.sourceRole==='CURRENT'?'ADOPTED':'READY_FOR_REVIEW',basisBindings:plan.basisBindings||unit.finish({})._basis.map(b=>({bindingType:'OBJECT_REVISION',bindingId:b.objectId,bindingHash:b.sha256}))}]:[]};}
  const id=params.get('subjectId');
  if(!id)return {events:[]};
  const row=await unit.detail(id);
  return {events:[{creativeRevisionId:row.revision.id,contentHash:row.revision.sha256,contextHash:hash(row.dependencies),content:row.revision.content,subjectId:id}]};
}
export async function commentTargets(unit,plan){
  return storyCommentSources(plan).map(source=>{const row=unit.basis.get(source.subjectId);const contentHash=hash(source.blocks);const sourceVersions=[row,...(source.kind==='EPISODE_DESIGN'?[unit.basis.get(plan.content.planId)]:[])].filter(Boolean);return {...source,revisionId:plan.revisionId,planContentHash:plan.contentHash,contentHash,contextHash:hash({kind:source.kind,subjectId:source.subjectId,contentHash}),objectId:source.subjectId,objectRevisionId:row?.revisionId,expectedVersion:row?.expectedVersion,sha256:row?.sha256,sourceVersions};});
}
export async function storyComments(unit,params){
  const plan=await episodePlan(unit,params.get('revisionId'),params.get('archive')==='1');check(plan,'PLAN_REQUIRED','故事方案尚未登记',404);
  const targets=(await commentTargets(unit,plan)).filter(t=>params.get('sceneId')?t.subjectId===params.get('sceneId')||t.kind==='EPISODE_DESIGN'&&plan.content.episodes.find(e=>e.sceneIds.includes(params.get('sceneId')))?.episodeUid===t.subjectId:!params.get('episodeUid')||t.episodeUid===params.get('episodeUid')),targetIds=new Set(targets.map(t=>t.subjectId));
  const rows=await unit.rows(['COMMENT'],{historical:true});
  const threads=rows.filter(r=>targetIds.has(r.content.target?.subjectId||r.content.target?.objectId)).map(row=>{
    const original=row.content.target,current=targets.find(t=>t.subjectId===(original?.subjectId||original?.objectId)&&(!original.kind||t.kind===original.kind));
    const anchor=row.content.anchor||{},parts=anchor.segments?.length?anchor.segments:[anchor];
    const matches=!!current&&parts.every(a=>current.blocks.find(b=>b.id===a.blockId)?.text.slice(a.startOffset,a.endOffset)===a.quote);
    return {commentId:row.id,commentRevisionId:row.revisionId,latestEventId:row.content.eventId||row.revisionId,target:{...original,subjectId:original?.subjectId||original?.objectId,episodeUid:original?.episodeUid||current?.episodeUid},anchor,commentText:row.content.text,status:['CLOSED','RESOLVED'].includes(row.content.status)?'RESOLVED':'OPEN',updatedAt:row.updatedAt,anchorMatchesCurrentText:matches,applicabilityState:matches?'CURRENT':'STALE',objectVersion:row.version,resolutionNote:row.content.resolutionNote||'',archived:row.historical};
  });
  const closed=threads.filter(t=>t.status==='RESOLVED'),historyRevision=hash(closed.map(t=>[t.commentId,t.commentRevisionId]));
  if(params.get('history')==='detail'){
    check(!params.get('historyRevision')||params.get('historyRevision')===historyRevision,'VERSION_CONFLICT','评论历史已更新',409);
    const thread=closed.find(t=>t.commentId===params.get('commentId'));check(thread,'COMMENT_NOT_FOUND','评论不存在',404);
    return {historyRevision,thread,item:{...thread,quote:thread.anchor.quote||'',createdAt:thread.updatedAt,readOnly:true,resolvedBy:null,originalTarget:thread.target,resolutionTarget:null}};
  }
  if(params.get('history')==='page'){
    const q=params.get('q')||'',matched=closed.filter(t=>(t.commentText+' '+t.anchor.quote).includes(q)),offset=Number(params.get('cursor')||0),items=matched.slice(offset,offset+20).map(t=>({...t,label:t.target.label,preview:t.commentText,quote:t.anchor.quote}));
    return {closedPage:{historyRevision,items,total:closed.length,matched:matched.length,nextCursor:offset+20<matched.length?String(offset+20):null}};
  }
  return {snapshotId:await unit.namespace(),revisionId:plan.revisionId,planContentHash:plan.contentHash,targets,threads:threads.filter(t=>t.status!=='RESOLVED'),closedCount:closed.length};
}
export async function sceneReviewContext(unit,params){
  const plan=await episodePlan(unit,params.get('revisionId'),params.get('archive')==='1'),id=params.get('sceneId');check(plan,'PLAN_REQUIRED','请先登记故事方案');
  const historicalScenes=plan.content.narrativeRevision?.scenes||[];
  if(plan.readOnly&&!historicalScenes.some(s=>s.id===id)){const episode=plan.content.episodes.find(e=>e.sceneIds.includes(id));check(episode,'SCENE_NOT_FOUND','此场不在原方案中',404);return {context:{snapshotId:await unit.namespace(),revisionId:plan.revisionId,planContentHash:plan.contentHash,episodeUid:episode.episodeUid,sceneId:id,sceneContentHash:hash({source:plan.originalEvent?.sha256,id,available:false}),contextHash:hash({revisionId:plan.revisionId,id}),upstreamState:'HISTORICAL',episode:{displayId:episode.displayId,title:episode.title,scenePosition:episode.sceneIds.indexOf(id)+1,sceneCount:episode.sceneIds.length},requirements:[],missing:['此原始方案未内嵌场正文；未套用当前稿。'],neighbours:[],chains:[],sceneLabels:{},reviewSpec:{criteria:[]},formalTarget:null,formalBlockReason:'历史原稿只读。'}};}
  const scene=historicalScenes.find(s=>s.id===id);check(scene,'SCENE_NOT_FOUND','此场不在所选方案中',404);
  const {episode,requirements,missing}=sceneRequirements(plan,id), scenes=plan.content.narrativeRevision.scenes,index=scenes.findIndex(s=>s.id===id);
  if(plan.readOnly)return {context:{snapshotId:await unit.namespace(),revisionId:plan.revisionId,planContentHash:plan.contentHash,episodeUid:episode.episodeUid,sceneId:id,sceneContentHash:scene.contentHash,contextHash:hash({scene:scene.contentHash,requirements}),upstreamState:'HISTORICAL',episode:{displayId:episode.displayId,title:episode.title,scenePosition:episode.sceneIds.indexOf(id)+1,sceneCount:episode.sceneIds.length},requirements,missing,neighbours:[],chains:[],sceneLabels:Object.fromEntries(scenes.map(s=>[s.id,s.displayId+' '+s.title])),reviewSpec:{criteria:[]},formalTarget:null,formalBlockReason:'历史版本只读；保留当时正文与依据。',sceneDocument:{...scene,sourceBindings:plan.basisBindings||[]}}};
  const current=await unit.detail(id),owner=await unit.detail(episode.episodeUid);
  const standard=current.revision.content.reviewSpec||(await unit.configuration()).reviewProfiles.find(p=>p.id==='script-scene');
  const reviewSpec=standard?{...standard,hash:standard.hash||hash(standard)}:{criteria:[]};
  const context={snapshotId:await unit.namespace(),revisionId:plan.revisionId,planContentHash:plan.contentHash,episodeUid:episode.episodeUid,sceneId:id,sceneContentHash:scene.contentHash,contextHash:hash({scene:scene.contentHash,requirements}),upstreamState:owner.state==='ADOPTED'?'CURRENT':'PENDING_REVIEW',episode:{displayId:episode.displayId,title:episode.title,scenePosition:episode.sceneIds.indexOf(id)+1,sceneCount:episode.sceneIds.length},requirements,missing,neighbours:[[-1,'previous'],[1,'next']].flatMap(([n,direction])=>scenes[index+n]?[{id:scenes[index+n].id,label:scenes[index+n].displayId+' '+scenes[index+n].title,transition:scenes[index+n].transition,direction}]:[]),chains:plan.content.narrativeRevision.causalChains.filter(c=>c.setupSceneIds.includes(id)||c.payoffSceneIds.includes(id)).map(c=>({id:c.id,title:c.title,requirement:c.mustPreserve,role:c.setupSceneIds.includes(id)?'铺垫':'回收',setup:c.setupSceneIds,payoff:c.payoffSceneIds})),sceneLabels:Object.fromEntries(scenes.map(s=>[s.id,s.displayId+' '+s.title])),reviewSpec:current.revision.content.reviewSpec||{criteria:[]},formalTarget:null,formalBlockReason:owner.state==='ADOPTED'?'本场判断与本集采用版本分别记录。':'请先确认本集叙事要求。',sceneDocument:{...scene,sourceBindings:current.dependencies.filter(d=>d.purpose==='SOURCE')}};
  context.reviewSpec=reviewSpec;
  context.formalTarget=owner.state==='ADOPTED'?{sceneId:id,title:scene.title,objectRevisionId:current.revision.id,expectedVersion:current.version,upstreamState:'CURRENT',configurationVersion:unit.configurationVersions?.system,sceneContentHash:scene.contentHash,businessContextHash:context.contextHash,reviewSpec}:null;
  return {context};
}
