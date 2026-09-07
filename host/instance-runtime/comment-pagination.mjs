/** Read-only, deterministic paging over the authoritative event projection. */
export class CommentPageError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const compare = (a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.commentId.localeCompare(a.commentId);
export function normalizeClosedQuery(value = '') {
  if (typeof value !== 'string' || value.length > 500) throw new CommentPageError(400, '评论检索最多 500 字');
  return value.trim().toLocaleLowerCase();
}
export function pageClosedComments(rows, { revision, query = '', limit = 20, cursor = '', currentIds = new Set() }) {
  const size = Number(limit), normalized = normalizeClosedQuery(query);
  if (!Number.isSafeInteger(size) || size < 1 || size > 100) throw new CommentPageError(400, '评论每页数量须为 1 至 100');
  // Never duplicate a permanent comment identity, even if a caller combines projections.
  const unique = [...new Map([...rows].sort(compare).map(row => [row.commentId, row]).reverse()).values()].sort(compare);
  const matching = unique.filter(row => [row.commentText, row.quote, row.originalTarget.label, row.originalTarget.subjectId, row.resolutionNote].join('\n').toLocaleLowerCase().includes(normalized));
  let offset = 0;
  if (cursor) {
    let value;
    try {
      if (typeof cursor !== 'string' || cursor.length > 3000 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
      value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    } catch { throw new CommentPageError(400, '评论分页游标无效'); }
    if (value?.v !== 1 || typeof value.after !== 'string' || typeof value.updatedAt !== 'string') throw new CommentPageError(400, '评论分页游标无效');
    if (value.revision !== revision || value.query !== normalized || value.limit !== size) throw new CommentPageError(409, '评论或筛选已变化，请从第一页重新读取');
    const previous = matching.findIndex(row => row.commentId === value.after && row.updatedAt === value.updatedAt);
    if (previous < 0) throw new CommentPageError(409, '评论分页位置已变化，请从第一页重新读取');
    offset = previous + 1;
  }
  const selected = matching.slice(offset, offset + size), last = selected.at(-1);
  return {
    historyRevision: revision, total: unique.length, matched: matching.length, offset, limit: size,
    items: selected.map(row => ({
      commentId: row.commentId, commentRevisionId: row.commentRevisionId, latestEventId: row.latestEventId,
      preview: [...row.commentText].slice(0, 140).join(''), updatedAt: row.updatedAt,
      label: [...row.originalTarget.label].slice(0, 140).join(''), archived: row.archived,
      isCurrent: currentIds.has(row.commentId),
    })),
    nextCursor: offset + size < matching.length && last ? Buffer.from(JSON.stringify({v:1,revision,query:normalized,limit:size,after:last.commentId,updatedAt:last.updatedAt})).toString('base64url') : null,
  };
}
