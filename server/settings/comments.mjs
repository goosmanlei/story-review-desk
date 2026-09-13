import {check, hash, identity, canonical} from '../shared/contracts.mjs';
import {PresentationRead} from '../presentation/read-unit.mjs';
import {workspaceDraft} from '../workspace-drafts.mjs';
import {assistantContext} from '../collaboration/assistant-context.mjs';

export async function entityCommentTarget(unit, entityId, includeDraft = true) {
  identity(entityId, 'entityId');
  const registered = (await unit.rows(['ENTITY'], {ids: [entityId]}))[0];
  const draft = includeDraft ? await workspaceDraft(unit.tx, 'domain:SETTINGS') : null;
  const change = draft?.content.status === 'DRAFT' ? draft.content.changes.find(c => c.collection === 'entities' && c.id === entityId) : null;
  check(registered || change?.value, 'ENTITY_REQUIRED', '实体不在当前登记对象或已保存草稿中', 404);
  const candidate = Boolean(change?.value);
  const holder = await unit.detail(candidate ? draft.id : entityId);
  const body = candidate ? change.value : {...holder.revision.content, id: entityId, name: holder.revision.content.name || holder.title};
  let adopted = null;
  if (registered?.adoptedRevisionId) {
    const old = await unit.detail(entityId, registered.adoptedRevisionId);
    adopted = {revisionId: old.revision.id, sha256: old.revision.sha256, content: old.revision.content};
  }
  const candidateBasisCurrent=!candidate||!registered||draft.content.basis?.find(b=>b.id===entityId)?.expectedVersion===registered.version;
  const sourceVersions=[{objectId:holder.id,revisionId:holder.revision.id,sha256:holder.revision.sha256,objectVersion:holder.version}];
  if(candidate&&registered&&candidateBasisCurrent)sourceVersions.push({objectId:registered.id,revisionId:registered.revisionId,sha256:registered.sha256,objectVersion:registered.version});
  return {candidateBasisCurrent,kind: 'ENTITY_SETTING', subjectId: entityId, entityId, objectId: holder.id,
    objectRevisionId: holder.revision.id, revisionId: holder.revision.id, expectedVersion: holder.version,
    sha256: holder.revision.sha256, contentHash: hash(body), includeDraft, candidate,
    state: candidate ? 'DRAFT' : holder.state, snapshotId: await unit.namespace(),
    label: body.name || holder.title, body, adopted,
    sourceVersions,
    basisLabel: candidate ? '已保存设定草稿' : '当前登记稿'};
}

export async function entityComments(unit, params) {
  const target = await entityCommentTarget(unit, params.get('entityId'), params.get('draft') !== '0');
  const rows = (await unit.tx.query(`SELECT o.id,o.version,r.id AS revision_id,r.content FROM objects o
    JOIN revisions r ON r.id=COALESCE(o.draft_revision_id,o.adopted_revision_id)
    WHERE o.kind='COMMENT' AND r.content #>> '{target,kind}'='ENTITY_SETTING'
    AND r.content #>> '{target,entityId}'=$1 ORDER BY o.created_at,o.id LIMIT 5001`, [target.entityId])).rows;
  check(rows.length <= 5000, 'COMMENT_LIMIT', '本实体评论超出单次范围，未返回不完整历史', 413);
  const threads = rows.map(row => ({commentId: row.id, commentRevisionId: row.revision_id,
    expectedVersion: row.version, text: row.content.text, status: row.content.status || 'OPEN', target: row.content.target,
    applicability: row.content.target.revisionId === target.revisionId && row.content.target.contentHash === target.contentHash ? 'CURRENT' : 'HISTORICAL'}));
  return {target, threads};
}

export async function planEntityComment(tx, input) {
  check(['CREATE', 'EDIT', 'CLOSE'].includes(input.action), 'COMMENT_ACTION', '评论动作无效');
  const unit = new PresentationRead(tx);
  if (input.action === 'CREATE') {
    const target = await entityCommentTarget(unit, input.entityId, input.target?.includeDraft !== false);
    check(input.target?.revisionId === target.revisionId && input.target?.expectedVersion === target.expectedVersion
      && input.target?.contentHash === target.contentHash && input.target?.objectId === target.objectId
      && hash(input.target?.sourceVersions || []) === hash(target.sourceVersions),
    'VERSION_CONFLICT', '实体或已保存草稿已改变；评论输入仍保留，请重新核对', 409);
    check(typeof input.text === 'string' && input.text.trim() && input.text.length <= 16000, 'COMMENT_TEXT', '请填写修改意见');
    return {commands: [...target.sourceVersions.map(v=>({type:'assert',id:v.objectId,expectedVersion:v.objectVersion})),
      {type: 'save', id: identity(input.commentId), kind: 'COMMENT', title: target.label + ' · 评论', expectedVersion: 0,
        content: {text: input.text, status: 'OPEN', target, anchor: {}},
        dependencies: target.sourceVersions.map(v => ({revisionId: v.revisionId, purpose: 'CONTENT'}))}],
      response: results => ({commentId: results.at(-1).id, revisionId: results.at(-1).revisionId})};
  }
  const row = await unit.detail(identity(input.commentId));
  check(row.kind === 'COMMENT' && row.revision.content.target?.kind === 'ENTITY_SETTING'
    && row.revision.content.target.entityId === input.entityId, 'COMMENT_TARGET', '评论不属于此实体', 409);
  check(row.version === input.expectedVersion && row.revision.id === input.commentRevisionId,
    'VERSION_CONFLICT', '评论已更新，输入仍保留', 409);
  check(input.action !== 'EDIT' || typeof input.text === 'string' && input.text.trim() && input.text.length <= 16000,
    'COMMENT_TEXT', '请填写修改意见');
  const content = {...row.revision.content, ...(input.action === 'EDIT' ? {text: input.text} : {status: 'CLOSED'})};
  return {commands: [{type: 'save', id: row.id, expectedVersion: row.version, content}],
    response: results => ({commentId: row.id, revisionId: results.at(-1).revisionId})};
}

export async function entityPolishContext(tx, input) {
  const unit = new PresentationRead(tx), target = await entityCommentTarget(unit, input.target.entityId, input.target.includeDraft !== false);
  check(input.snapshotId === target.snapshotId && input.target.revisionId === target.revisionId
    && input.target.expectedVersion === target.expectedVersion && input.target.contentHash === target.contentHash,
  'CONTEXT_STALE', '实体意见所依据的版本已改变，草稿仍保留', 409);
  check(typeof input.commentDraft === 'string' && input.commentDraft.trim() && input.commentDraft.length <= 16000,
    'COMMENT_TEXT', '请先填写需要润色的修改意见');
  check(target.candidateBasisCurrent,'CONTEXT_STALE','已保存设定草稿的原依据发生变化，请先重新核对草稿；未发起润色',409);
  const profile = await unit.profile();
  const context = await assistantContext(tx, {focus: {projectId: profile.projectId, snapshotId: target.snapshotId,
    subjectType: 'PROJECT', subjectId: profile.projectId, view: 'settings', filters: {settingId: target.objectId}, versionId: target.revisionId}, draftTargets: []});
  context.resources=context.resources.filter(resource=>resource.id!==target.objectId);
  context.resources.unshift({id: target.objectId, semanticEntityId:target.entityId, title: target.label, kind: target.candidate?'NOTE':'ENTITY', semanticKind:'ENTITY', role: target.candidate ? 'CANDIDATE' : 'CURRENT',
    versionId: target.revisionId, sha256: target.sha256, entityContentHash: target.contentHash, text: canonical(target.body), excerpt: target.basisLabel, relations: [],
    versionOwnerId: target.objectId, instruction: '实体身份与修订载体分别记录；只针对此实体的用户意见润色，不修改设定。'});
  if (target.adopted) {
    context.resources.push({id: target.entityId, title: target.label + ' · 已采用稿', kind: 'ENTITY', role: 'ADOPTED',
      versionId: target.adopted.revisionId, sha256: target.adopted.sha256, text: canonical(target.adopted.content), relations: []});
    context.sourceVersions.push({objectId: target.entityId, revisionId: target.adopted.revisionId, sha256: target.adopted.sha256});
  }
  for(const evidence of Array.isArray(target.body.evidence)?target.body.evidence:[]){
    if(!context.resources.some(resource=>resource.id===evidence.sourceId&&resource.versionId===evidence.revisionId))context.missing.push('未取得来源原文，只有已保存摘录；保持 UNKNOWN：'+(evidence.sourceId||'未登记来源')+' / '+(evidence.revisionId||'未登记修订'));
  }
  context.sourceVersions=[...new Map([...context.sourceVersions,...target.sourceVersions].map(v=>[v.revisionId,v])).values()].sort((a,b)=>a.revisionId.localeCompare(b.revisionId));
  context.dependencyHash=hash({sourceVersions:context.sourceVersions,configurationVersions:context.configurationVersions});
  delete context.packetHash; delete context.packetId;
  check(Buffer.byteLength(canonical(context)) <= 192 * 1024, 'CONTEXT_LIMIT', '实体依据超出上下文预算，请先缩小关联范围', 413);
  context.packetHash = hash(context); context.packetId = 'context_' + context.packetHash.slice(0, 32);
  return {context, target};
}
