import { resolveEpisodePlan } from '../_episode-plan';
import { appendEvent, assertStableId, HttpError, jsonResponse, listAllEvents, mutationRequestHash, operationalSnapshot, projectScriptCommentEvents, stableObjectHash, type ReviewData, type ScriptCommentProjection } from '../_store';
import { commentTargetKey, storyCommentSources, type StoryCommentTarget } from '../../../story-comment-model';
import { parseCommentAnchorBlocks } from './_context';
import { createHash } from 'node:crypto';
import { readClosedHistory } from './_history';
import { sceneRequirements } from '../../../scene-narrative-context';
import { requirementCommentField } from '../../../story-comment-model';

type Operations = Awaited<ReturnType<typeof operationalSnapshot>>;
export function resolveStoryCommentTargets(data: ReviewData, operations: Operations, revisionId: string) {
  const plan = resolveEpisodePlan(data, operations, revisionId);
  if (!plan) throw new HttpError(409, '当前故事方案不可用');
  return {plan, targets: storyCommentSources(plan).map(source => {
    if (new Set(source.blocks.map(b=>b.id)).size !== source.blocks.length) throw new HttpError(409,'评论文字身份不唯一');
    const scene = plan.content.narrativeRevision?.scenes.find(s=>s.id===source.subjectId);
    const contentHash = source.kind === 'SCENE_SCRIPT' ? scene!.contentHash : stableObjectHash(source.blocks);
    const contextHash = stableObjectHash({snapshotId:plan.snapshotId,planContextHash:plan.contextHash,basisBindingsHash:plan.basisBindingsHash,revisionId:plan.revisionId,planContentHash:plan.contentHash,kind:source.kind,subjectId:source.subjectId,episodeUid:source.episodeUid,contentHash});
    return {...source,revisionId:plan.revisionId,planContentHash:plan.contentHash,contentHash,contextHash} satisfies StoryCommentTarget;
  })};
}

export function anchorFor(target: StoryCommentTarget, anchor: unknown) {
  // Design fields are laid out differently in episode review and scene inheritance.
  // Verify every selected field and character; do not include unseen catalog fields.
  return parseCommentAnchorBlocks(target.blocks, anchor, {allowFieldSelection:target.kind==='EPISODE_DESIGN'});
}

export function storyCommentPolishContext(data: ReviewData, operations: Operations, body: Record<string,unknown>) {
  if(body.snapshotId!==data.snapshotId)throw new HttpError(412,'故事快照已变化');
  const requested=body.target as StoryCommentTarget;
  if(!requested || Object.keys(requested).some(k=>!['kind','subjectId','revisionId','planContentHash','contentHash','contextHash'].includes(k)))throw new HttpError(400,'评论润色只接受目标身份，不接受客户端上下文');
  const {plan,targets}=resolveStoryCommentTargets(data,operations,assertStableId(body.revisionId,'revisionId'));
  const target=targets.find(t=>t.kind===requested.kind&&t.subjectId===requested.subjectId);
  if(!target||requested.revisionId!==target.revisionId||requested.planContentHash!==target.planContentHash||requested.contentHash!==target.contentHash||requested.contextHash!==target.contextHash)throw new HttpError(409,'评论文字或上下文已变化');
  const anchor=anchorFor(target,body.anchor);
  const episode=plan.content.episodes.find(ep=>ep.episodeUid===target.episodeUid)!;
  const scenes=plan.content.narrativeRevision!.scenes.filter(s=>target.kind==='SCENE_SCRIPT'?s.id===target.subjectId:episode.sceneIds.includes(s.id));
  const ids=[...new Set(scenes.flatMap(s=>s.sourceSegmentIds))];
  const transcript=data.storySources?.transcript as {sha256?:string;segments?:Array<{id:string;text:string;contentSha256:string;timecode?:string}>};
  if(!transcript?.sha256 || transcript.sha256!==data.sourceHashes?.transcriptSha256)throw new HttpError(503,'原文版本校验失败');
  const beats=(data.adaptationAudit?.beats||[]) as Array<{beat_id:string;source:{content_sha256:string;timecode_start:string;timecode_end:string};authority?:string;asr_status?:string;summary?:string}>;
  const directSourceSegments=ids.map(id=>{
    const segment=transcript.segments?.find(s=>s.id===id),beat=beats.find(b=>b.beat_id===id);
    if(!segment||!beat||createHash('sha256').update(segment.text).digest('hex')!==segment.contentSha256||beat.source.content_sha256!==segment.contentSha256)throw new HttpError(503,'关联原文未通过精确内容校验');
    return {beatId:id,text:segment.text,contentSha256:segment.contentSha256,timecodeStart:beat.source.timecode_start||segment.timecode||'',timecodeEnd:beat.source.timecode_end||'',authority:beat.authority||'UNKNOWN',asrStatus:beat.asr_status||'UNKNOWN',summary:beat.summary||''};
  });
  const sceneScript=scenes.map(s=>`${s.displayId} ${s.title}\n${s.scriptBlocks.map(b=>`${b.speaker?`【${b.speaker}】`:''}${b.performanceNote?`（${b.performanceNote}）`:''}${b.text}`).join('\n\n')}`).join('\n\n')+(target.kind==='EPISODE_DESIGN'?`\n\n分集设计说明\n${target.blocks.map(b=>`${b.label}：${b.text}`).join('\n')}`:'');
  if(!directSourceSegments.length||directSourceSegments.length>50||directSourceSegments.some(s=>s.text.length>4000)||directSourceSegments.reduce((n,s)=>n+s.text.length,0)>12000||sceneScript.length>20000)throw new HttpError(422,'本次关联材料超出评论润色范围，请保留人工意见或缩小圈选目标');
  return {target,anchor,sceneContext:{sceneTitle:target.label,sceneScript,selectionText:anchor.quote,selectionPrefix:anchor.prefix,selectionSuffix:anchor.suffix,directSourceSegments,relatedContext:[],dossierHash:stableObjectHash(episode.reviewDossier),transcriptSha256:transcript.sha256}};
}

export function decorateStoryComment(thread: ScriptCommentProjection, targets: StoryCommentTarget[]) {
  const original = thread.target;
  if (!original) return null;
  const target = targets.find(t => commentTargetKey(t) === commentTargetKey(original));
  if (!target) return null;
  let anchorMatchesCurrentText = false;
  try {
    anchorFor(target,thread.anchor);
    // A reused field position must never silently borrow an identical substring
    // from a different authored statement after revision/reordering.
    const segments = (thread.anchor.segments || [thread.anchor]) as Array<{blockId:string}>;
    anchorMatchesCurrentText = segments.every(s=>target.blocks.find(b=>b.id===s.blockId)?.text === original.blocks.find(b=>b.id===s.blockId)?.text);
  } catch { /* retain current-revision broken anchors as explicit unlocatable comments */ }
  if (original.revisionId !== target.revisionId && !anchorMatchesCurrentText) return null;
  return {...thread,anchorMatchesCurrentText,applicabilityState:original.contextHash===target.contextHash?'CURRENT':'STALE',target:original};
}

export async function getStoryComments(data: ReviewData, operations: Operations, url: URL) {
  const revisionId = assertStableId(url.searchParams.get('revisionId'),'revisionId');
  const {plan,targets} = resolveStoryCommentTargets(data,operations,revisionId);
  const sceneId=url.searchParams.get('sceneId'), episodeUid=url.searchParams.get('episodeUid');
  let selected = targets;
  if (sceneId) {
    const scene=targets.find(t=>t.kind==='SCENE_SCRIPT'&&t.subjectId===sceneId);
    if(!scene) throw new HttpError(409,'此场不属于当前方案');
    selected=targets.filter(t=>t.subjectId===sceneId || t.kind==='EPISODE_DESIGN'&&t.episodeUid===scene.episodeUid);
  } else if (episodeUid) {
    const index=plan.content.episodes.findIndex(ep=>ep.episodeUid===episodeUid);
    if(index<0)throw new HttpError(409,'此集不属于当前方案');
    const ids=plan.content.episodes.slice(Math.max(0,index-1),index+2).map(ep=>ep.episodeUid);
    selected=targets.filter(t=>ids.includes(t.episodeUid));
  }
  const threads=operations.scriptComments.threads.filter(t=>!t.archived).map(t=>decorateStoryComment(t,selected)).filter((t):t is NonNullable<typeof t>=>Boolean(t));
  // Match the visible reader exactly, including only adjacent opening/ending evidence.
  const fields=sceneId?new Set([...sceneRequirements(plan,sceneId).requirements.map(r=>requirementCommentField(r.id,sceneId)),...(plan.content.narrativeRevision?.causalChains.filter(c=>c.setupSceneIds.includes(sceneId)||c.payoffSceneIds.includes(sceneId)).map(c=>`chain:${c.id}`)||[])]):null;
  const index=plan.content.episodes.findIndex(ep=>ep.episodeUid===episodeUid);
  const current=threads.filter(t=>{
    const segments=(t.anchor.segments||[t.anchor]) as Array<{blockId:string}>;
    if(sceneId)return t.target.subjectId===sceneId||t.target.kind==='EPISODE_DESIGN'&&segments.some(s=>fields?.has(s.blockId));
    if(!episodeUid||t.target.episodeUid===episodeUid)return true;
    const previous=t.target.episodeUid===plan.content.episodes[index-1]?.episodeUid;
    const next=t.target.episodeUid===plan.content.episodes[index+1]?.episodeUid;
    if(!previous&&!next)return false;
    if(t.target.kind==='EPISODE_DESIGN')return t.anchor.blockId===(previous?'endingCliffhanger':'openingHook');
    const excerpt=plan.presentation[t.target.episodeUid]?.[previous?'ending':'opening'];
    return excerpt?.sceneId===t.target.subjectId&&segments.every(s=>excerpt.blocks.some(b=>b.id===s.blockId));
  });
  const history=readClosedHistory(operations,url,{snapshotId:data.snapshotId,revisionId:plan.revisionId,planContentHash:plan.contentHash,sceneId,episodeUid},current);
  const metadata={schemaVersion:'1.3',snapshotId:data.snapshotId,revisionId:plan.revisionId,planContentHash:plan.contentHash,mutationEtag:operations.mutationEtag};
  if(url.searchParams.get('history')==='page'||url.searchParams.get('history')==='detail'||url.searchParams.get('status')==='RESOLVED')return jsonResponse({...metadata,...history});
  const status=url.searchParams.get('status');
  return jsonResponse({...metadata,targets:selected,threads:threads.filter(t=>t.status!=='RESOLVED'&&(!status||t.status===status)),...history});
}

export async function postStoryComment(data: ReviewData, body: Record<string,unknown>, idempotencyKey: string, ifMatch: string, rawRequestHash: string) {
  if(body.snapshotId!==data.snapshotId)throw new HttpError(412,'故事快照已变化，请重新读取');
  const operations=await operationalSnapshot();
  const requested=body.target as StoryCommentTarget | undefined;
  if(!requested || !['SCENE_SCRIPT','EPISODE_DESIGN'].includes(requested.kind))throw new HttpError(422,'评论目标无效');
  const {targets}=resolveStoryCommentTargets(data,operations,assertStableId(body.revisionId,'revisionId'));
  const target=targets.find(t=>t.kind===requested.kind&&t.subjectId===requested.subjectId);
  if(!target || requested.contentHash!==target.contentHash || requested.contextHash!==target.contextHash || requested.revisionId!==target.revisionId || requested.planContentHash!==target.planContentHash)throw new HttpError(409,'评论所对应的文字或上下文已变化，请重新读取');
  const commentId=assertStableId(body.commentId,'commentId'), action=String(body.commentAction||'');
  if(!['CREATE','EDIT','RESOLVE_USER','REOPEN','AI_START','RESOLVE_AI'].includes(action))throw new HttpError(400,'评论操作无效');
  const existing=projectScriptCommentEvents(await listAllEvents('script-comment')).find(t=>t.commentId===commentId);
  const text=typeof body.commentText==='string'?body.commentText.trim():'';
  if(['CREATE','EDIT'].includes(action)&&(!text||text.length>20000))throw new HttpError(422,'请填写修改意见（最多两万字）');
  if(!['CREATE','EDIT'].includes(action)&&text)throw new HttpError(422,'此操作不可修改评论文字');
  if(action==='CREATE'&&existing)throw new HttpError(409,'评论已存在');
  if(action!=='CREATE') {
    if(existing?.archived)throw new HttpError(409,'已归档历史只读保留，请在当前文字上另建评论');
    if(!existing?.target || commentTargetKey(existing.target)!==commentTargetKey(target))throw new HttpError(422,'评论不属于此文字目标');
    if(body.commentRevisionId!==existing.commentRevisionId || body.latestEventId!==existing.latestEventId)throw new HttpError(409,'评论已由另一处更新，请重新读取');
    if(action==='EDIT'&&existing.status==='RESOLVED')throw new HttpError(409,'已关闭评论不可编辑');
    if(action==='EDIT'&&text===existing.commentText)throw new HttpError(409,'评论文字未变化');
    if(action==='REOPEN'&&existing.status!=='RESOLVED')throw new HttpError(409,'仅已关闭评论可以重新打开');
    if(['RESOLVE_USER','RESOLVE_AI'].includes(action)&&existing.status==='RESOLVED')throw new HttpError(409,'评论已关闭');
    if(action==='AI_START'&&existing.status!=='AI_QUEUED')throw new HttpError(409,'评论不在待处理状态');
    if(action==='RESOLVE_AI'&&(!['AI_QUEUED','AI_PROCESSING'].includes(existing.status)||!String(body.resolutionNote||'').trim()))throw new HttpError(422,'AI处理须绑定当前评论并提供具体处理说明');
    if(['EDIT','REOPEN','AI_START','RESOLVE_AI'].includes(action)&&!decorateStoryComment(existing,targets)?.anchorMatchesCurrentText)throw new HttpError(409,'原圈选已无法精确定位，请重新圈选');
  }
  const anchor=action==='CREATE'?anchorFor(target,body.anchor):existing!.anchor;
  const eventTarget=existing?.target || target;
  const closing=['RESOLVE_USER','RESOLVE_AI'].includes(action);
  const semantic={schemaVersion:'1.2',snapshotId:data.snapshotId,creationSnapshotId:existing?.creationSnapshotId||data.snapshotId,commentAction:action,commentId,target:eventTarget,
    sceneId:target.kind==='SCENE_SCRIPT'?target.subjectId:'',sceneContentHash:eventTarget.contentHash,businessContextHash:eventTarget.contextHash,anchor,
    ...(action==='CREATE'?{initialStatus:'AI_QUEUED'}:{commentRevisionId:existing!.commentRevisionId}),
    ...(['CREATE','EDIT'].includes(action)?{commentText:text}:{}),
    ...(closing?{alignedSnapshotId:data.snapshotId,alignedSceneContentHash:target.contentHash,resolutionNote:String(body.resolutionNote||'用户确认该评论已处理。')}:{})};
  const result=await appendEvent('script-comment',idempotencyKey,mutationRequestHash('script-comment',semantic),ifMatch,{...semantic,rawRequestHash},'1.2',async()=>{
    const all=await listAllEvents('script-comment');
    const current=projectScriptCommentEvents(all).find(t=>t.commentId===commentId);
    if(action==='CREATE'&&all.some(e=>e.commentId===commentId)||action!=='CREATE'&&current?.latestEventId!==existing?.latestEventId)throw new HttpError(409,'评论已更新，请重新读取');
  });
  return jsonResponse({eventId:result.event.eventId,commentId,replayed:result.replayed,mutationEtag:result.operations.mutationEtag});
}
