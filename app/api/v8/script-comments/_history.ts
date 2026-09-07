import { HttpError, stableObjectHash, type operationalSnapshot, type ScriptCommentProjection } from '../_store';
import { CommentPageError, pageClosedComments } from '../../../../host/instance-runtime/comment-pagination.mjs';
type Operations = Awaited<ReturnType<typeof operationalSnapshot>>;
type CurrentThread = ScriptCommentProjection & {anchorMatchesCurrentText:boolean;applicabilityState:string};
export function readClosedHistory(operations:Operations,url:URL,scope:Record<string,unknown>,current:CurrentThread[]) {
  const rows=operations.scriptComments.closedHistory;
  const revision=stableObjectHash({scope,heads:rows.map(row=>[row.commentId,row.commentRevisionId,row.latestEventId])});
  const mode=url.searchParams.get('history');
  if(mode&&!['summary','page','detail'].includes(mode))throw new HttpError(400,'评论历史读取方式无效');
  if(mode==='detail'){
    if(url.searchParams.get('historyRevision')!==revision)throw new HttpError(409,'评论或当前版本已变化，请重新读取列表');
    const item=rows.find(row=>row.commentId===url.searchParams.get('commentId'));
    if(!item)throw new HttpError(404,'此已关闭评论不在当前历史中');
    return {historyRevision:revision,item,thread:current.find(thread=>thread.commentId===item.commentId&&!thread.archived)||null};
  }
  if(mode==='page'||url.searchParams.get('status')==='RESOLVED'){
    try{return {closedPage:pageClosedComments(rows,{revision,query:url.searchParams.get('q')||'',limit:url.searchParams.get('limit')||20,cursor:url.searchParams.get('cursor')||'',currentIds:new Set(current.map(thread=>thread.commentId))})};}
    catch(error){if(error instanceof CommentPageError)throw new HttpError(error.status,error.message);throw error;}
  }
  return {closedCount:rows.length,historyRevision:revision};
}
