import {check, hash, identity} from '../shared/contracts.mjs';
import {PresentationRead} from '../presentation/read-unit.mjs';
import {episodePlan} from '../presentation/story.mjs';
import {commentTargets} from '../presentation/review.mjs';
import {planStoryEdit} from './editing.mjs';

const role = 'STORY_FEEDBACK_PREVIEW';
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const version = row => ({objectId: row.id, revisionId: row.revision.id, expectedVersion: row.version, sha256: row.revision.sha256});

/** All saved feedback for one permanent episode, with original anchors intact. */
export async function feedbackContext(unit, episodeId) {
  identity(episodeId, 'episodeId');
  const plan = await episodePlan(unit);
  const episode = plan?.content.episodes.find(row => row.episodeUid === episodeId);
  check(episode, 'EPISODE_REQUIRED', '请选择当前方案中的永久集身份；不按显示编号猜测', 404);
  const ids = [episodeId, ...episode.sceneIds];
  const objects = await Promise.all(ids.map(id => unit.detail(id)));
  const current = new Map(objects.map(row => [row.id, row]));
  const targets = (await commentTargets(unit, plan)).filter(t => ids.includes(t.objectId));
  // Scope the query before loading content, so unrelated episodes cannot truncate it.
  const commentIds = (await unit.tx.query(`SELECT o.id FROM objects o JOIN revisions r
    ON r.id=COALESCE(o.draft_revision_id,o.adopted_revision_id) WHERE o.kind='COMMENT'
    AND COALESCE(r.content #>> '{target,subjectId}',r.content #>> '{target,objectId}')=ANY($1::text[])
    AND COALESCE(r.content->>'status','OPEN') NOT IN ('CLOSED','RESOLVED')
    ORDER BY o.id LIMIT 5001`, [ids])).rows.map(row => row.id);
  check(commentIds.length <= 5000, 'FEEDBACK_LIMIT', '本集反馈超过单次范围上限，请先明确更小的处理范围；未返回不完整结果', 413);
  const comments = await Promise.all(commentIds.map(id => unit.detail(id)));
  const feedback = comments.map(row => {
    const original = row.revision.content.target || {}, anchor = row.revision.content.anchor || {};
    const objectId = original.subjectId || original.objectId;
    const target = targets.find(t => t.objectId === objectId);
    const parts = anchor.segments?.length ? anchor.segments : [anchor];
    const anchorMatches = Boolean(target) && parts.every(part => {
      const block = target.blocks.find(b => b.id === part.blockId);
      return block && Number.isInteger(part.startOffset) && Number.isInteger(part.endOffset)
        && block.text.slice(part.startOffset, part.endOffset) === part.quote;
    });
    const originalRevision = original.objectRevisionId || original.revisionId;
    const revisionMatches = originalRevision === current.get(objectId)?.revision.id
      && (original.sourceVersions || []).every(source => unit.basis.get(source.objectId)?.revisionId === source.revisionId);
    return {id: row.id, kind: 'COMMENT', text: row.revision.content.text,
      input: version(row), objectId, originalTarget: original, anchor,
      applicability: row.historical || !revisionMatches ? 'HISTORICAL' : anchorMatches ? 'CURRENT' : 'ANCHOR_STALE',
      anchorMatchesCurrentText: anchorMatches};
  });
  const reviews = (await unit.tx.query(`SELECT DISTINCT ON (object_id) * FROM reviews
    WHERE object_id=ANY($1::text[]) ORDER BY object_id,created_at DESC,id DESC`, [ids])).rows;
  for (const review of reviews) {
    const applicability = current.get(review.object_id)?.revision.id === review.revision_id ? 'CURRENT' : 'HISTORICAL';
    const shared = {kind: 'REVIEW', objectId: review.object_id, reviewId: review.id,
      originalRevisionId: review.revision_id, recordedAt: new Date(review.created_at).toISOString(), applicability, decision: review.decision};
    if (nonempty(review.note)) feedback.push({...shared, id: 'review:' + review.id + ':note', text: review.note});
    for (const finding of review.findings || []) if (nonempty(finding.note))
      feedback.push({...shared, id: 'review:' + review.id + ':' + finding.criterionId, text: finding.note, finding});
  }
  // This flags overlapping feedback for author judgment, not a semantic verdict.
  for (const item of feedback) item.potentialConflictWith = feedback.filter(other => other.id !== item.id
    && item.kind === 'COMMENT' && other.kind === 'COMMENT' && other.objectId === item.objectId
    && hash(other.anchor) === hash(item.anchor) && other.text !== item.text).map(other => other.id);
  const basis = [unit.basis.get(plan.content.planId), ...objects.map(version), ...comments.map(version)].filter(Boolean);
  const sourceIds = [...new Set(objects.flatMap(row => row.dependencies.map(d => d.revisionId)))];
  const sources = [];
  for (const revisionId of sourceIds) {
    const row = (await unit.tx.query('SELECT object_id FROM revisions WHERE id=$1', [revisionId])).rows[0];
    if (row && !ids.includes(row.object_id)) {
      const source = await unit.detail(row.object_id, revisionId);
      sources.push({objectId: source.id, revisionId, title: source.title, kind: source.kind, content: source.revision.content});
    }
  }
  const index = plan.content.episodes.findIndex(row => row.episodeUid === episodeId);
  const neighbours = [plan.content.episodes[index - 1], plan.content.episodes[index + 1]].filter(Boolean);
  for (const neighbour of neighbours) basis.push(version(await unit.detail(neighbour.episodeUid)));
  const result = {snapshotId: await unit.namespace(), episodeId, planRevisionId: plan.revisionId,
    episode, objects: objects.map(row => ({...version(row), title: row.title, kind: row.kind, content: row.revision.content})),
    feedback, basis, sources, neighbours, reviewHeads: reviews.map(row => row.id),
    notice: '仅包含已保存的未关闭评论和最新审阅意见；浏览器未提交草稿不在其中。重叠意见仅提示潜在冲突，须由用户核对。'};
  return {...result, contextHash: hash(result)};
}

export async function feedbackWorkspace(unit, params) {
  if (params.get('previewId')) {
    const preview = await unit.detail(params.get('previewId'), params.get('revisionId') || undefined);
    check(preview.kind === 'NOTE' && preview.revision.content.role === role, 'PREVIEW_REQUIRED', '不是反馈修稿预览', 404);
    return {preview: {...version(preview), content: preview.revision.content, dependencies: preview.dependencies}};
  }
  const result = await feedbackContext(unit, params.get('episodeId'));
  check(!params.get('contextHash') || params.get('contextHash') === result.contextHash, 'VERSION_CONFLICT', '反馈或正文已变化，请重新读取完整范围', 409);
  const offset = Number(params.get('cursor') || 0), limit = Number(params.get('limit') || 50);
  check(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit > 0 && limit <= 100, 'PAGE_RANGE', '分页范围无效');
  return {...result, feedback: result.feedback.slice(offset, offset + limit), total: result.feedback.length,
    nextCursor: offset + limit < result.feedback.length ? String(offset + limit) : null};
}

export async function planFeedbackChange(tx, input) {
  check(['preview', 'apply'].includes(input.action), 'FEEDBACK_ACTION', '请选择预览或明确应用');
  const unit = new PresentationRead(tx);
  if (input.action === 'preview') {
    const context = await feedbackContext(unit, input.episodeId);
    check(context.feedback.length > 0, 'FEEDBACK_REQUIRED', '本集没有已保存的待处理反馈，未创建修稿预览');
    check(input.contextHash === context.contextHash, 'VERSION_CONFLICT', '已读取的反馈或正文改变，请重新核对', 409);
    check(Array.isArray(input.changes) && input.changes.length > 0 && input.changes.length <= 100,
      'FEEDBACK_CHANGES', '预览须包含 1 至 100 个本集正文修改');
    check(new Set(input.changes.map(change => change.objectId)).size === input.changes.length, 'FEEDBACK_CHANGES', '同一对象不可重复修改');
    const planned = [];
    for (const change of input.changes) {
      check(Object.keys(change).every(key=>['objectId','revisionId','expectedVersion','title','content'].includes(key)), 'FEEDBACK_FIELD', '修稿预览只接受正文和所示叙事字段');
      check(context.objects.some(row => row.objectId === change.objectId), 'FEEDBACK_SCOPE', '不能修改本集范围外的对象');
      planned.push((await planStoryEdit(tx, change)).commands[0]);
    }
    const responses = input.responses;
    check(Array.isArray(responses) && responses.length === context.feedback.length
      && new Set(responses.map(row => row.feedbackId)).size === responses.length, 'FEEDBACK_COVERAGE', '每条反馈须有唯一回应，包括暂不处理的原因');
    for (const response of responses) {
      const feedback = context.feedback.find(row => row.id === response.feedbackId);
      check(feedback && ['ADDRESSED', 'DEFERRED', 'NEEDS_CLARIFICATION'].includes(response.outcome)
        && nonempty(response.explanation) && Array.isArray(response.objectIds)
        && response.objectIds.every(id => planned.some(change => change.id === id)), 'FEEDBACK_RESPONSE', '逐条回应须说明处理结论、修改对象或未处理原因');
      check(response.outcome !== 'ADDRESSED' || response.objectIds.length > 0, 'FEEDBACK_RESPONSE', '已处理反馈须关联实际修改对象');
      check(feedback.applicability === 'CURRENT' || response.outcome !== 'ADDRESSED', 'FEEDBACK_STALE', '过期反馈不能自动重绑当前稿；请先明确新版本意见', 409);
      check(!feedback.potentialConflictWith.length || response.outcome !== 'ADDRESSED' || nonempty(response.conflictResolution),
        'FEEDBACK_CONFLICT', '重叠意见须说明已确认的处理依据，或保留待澄清');
    }
    const previewId = identity(input.previewId, 'previewId');
    const fullDraft = context.objects.map(row => {
      const change = planned.find(item => item.id === row.objectId);
      return {objectId: row.objectId, kind: row.kind, title: change?.title || row.title,
        baseRevisionId: row.revisionId, baseSha256: row.sha256, expectedVersion: row.expectedVersion,
        changed: Boolean(change), content: change?.content || row.content};
    });
    const content = {role, status: 'PREVIEW', episodeId: context.episodeId, contextHash: context.contextHash,
      basis: context.basis, feedback: context.feedback, fullDraft, changes: input.changes, responses};
    return {commands: [...context.basis.map(row => ({type: 'assert', id: row.objectId, expectedVersion: row.expectedVersion})),
      {type: 'save', id: previewId, kind: 'NOTE', title: '反馈修稿预览', expectedVersion: 0, content,
        dependencies: context.basis.map(row => ({revisionId: row.revisionId, purpose: 'CONTENT'}))}],
      validateAfterLock: async () => check((await feedbackContext(new PresentationRead(tx), context.episodeId)).contextHash === context.contextHash, 'VERSION_CONFLICT', '反馈在加锁前改变，未保存陈旧预览', 409),
      response: results => ({previewId, revisionId: results.at(-1).revisionId, expectedVersion: results.at(-1).version,
        fullDraft, responses, storyChanged: false, formalAdoptionPerformed: false})};
  }
  check(input.explicit === true, 'EXPLICIT_APPLICATION_REQUIRED', '须由用户明确应用这份预览');
  const preview = await unit.detail(identity(input.previewId, 'previewId'));
  check(preview.kind === 'NOTE' && preview.revision.content.role === role && preview.revision.content.status === 'PREVIEW',
    'PREVIEW_REQUIRED', '请选择尚未应用的反馈修稿预览', 409);
  check(preview.version === input.expectedVersion && preview.revision.id === input.revisionId, 'VERSION_CONFLICT', '预览版本已改变', 409);
  const saved = preview.revision.content, context = await feedbackContext(unit, saved.episodeId);
  check(context.contextHash === saved.contextHash, 'VERSION_CONFLICT', '正文或反馈已变化；完整预览仍保留，未应用陈旧修改', 409);
  const rebuilt = await planFeedbackChange(tx, {action: 'preview', episodeId: saved.episodeId,
    contextHash: saved.contextHash, changes: saved.changes, responses: saved.responses, previewId: preview.id});
  check(Object.entries(rebuilt.commands.at(-1).content).every(([key,value]) => hash(value) === hash(saved[key])),
    'PREVIEW_CONTENT_CHANGED', '完整预览与待应用修改不一致，未写入正文', 409);
  const commands = context.basis.map(row => ({type: 'assert', id: row.objectId, expectedVersion: row.expectedVersion}));
  const outputs = [];
  for (const change of saved.changes) {
    const planned = await planStoryEdit(tx, change);
    outputs.push({objectId: change.objectId, revisionIdFrom: commands.length, purpose: 'CONTENT'});
    commands.push(...planned.commands);
  }
  commands.push({type: 'save', id: preview.id, expectedVersion: preview.version,
    content: {...saved, status: 'APPLIED', previewRevisionId: preview.revision.id},
    dependencies: [...saved.basis.map(row => ({revisionId: row.revisionId, purpose: 'SOURCE'})), ...outputs]});
  return {commands, validateAfterLock: async () => check((await feedbackContext(new PresentationRead(tx), saved.episodeId)).contextHash === saved.contextHash, 'VERSION_CONFLICT', '反馈在加锁前改变，未应用陈旧预览', 409),
    response: results => ({previewId: preview.id, resultRevisionId: results.at(-1).revisionId,
    outputs: outputs.map(row => results[row.revisionIdFrom]), responses: saved.responses,
    formalAdoptionPerformed: false, commentsClosed: false})};
}
