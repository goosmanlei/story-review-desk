export class CommentPageError extends Error { status:number; constructor(status:number,message:string); }
export type ClosedHistoryRow = {
 commentId:string;commentRevisionId:string;latestEventId:string;updatedAt:string;commentText:string;quote:string;resolutionNote:string;archived:boolean;originalTarget:{label:string;subjectId:string};
};
export type ClosedHistorySummary = {commentId:string;commentRevisionId:string;latestEventId:string;updatedAt:string;preview:string;label:string;archived:boolean;isCurrent:boolean};
export type ClosedHistoryPage = {historyRevision:string;total:number;matched:number;offset:number;limit:number;items:ClosedHistorySummary[];nextCursor:string|null};
export function normalizeClosedQuery(value?:string):string;
export function pageClosedComments(rows:ClosedHistoryRow[],options:{revision:string;query?:string;limit?:string|number;cursor?:string;currentIds?:Set<string>}):ClosedHistoryPage;
