import { createHash } from 'node:crypto';
import type { SceneExcerptRef } from '../../story-review-types';
import { HttpError, storyConfirmationTargets, stableObjectHash, type ReviewData } from './_store';
import { sceneCommentBlocks } from './script-comments/_context';
import {authoringBlocks} from '../../../host/instance-runtime/domain-authoring-plan.mjs';
import type {AuthoringRoot} from '../../../host/instance-runtime/domain-authoring.mjs';

export function episodeExcerptBlocks(data: ReviewData, ref: SceneExcerptRef, boundary?: 'opening' | 'ending') {
  const generic=(data.productionModel as typeof data.productionModel & {genericAuthoring?:{roots:AuthoringRoot[]}}).genericAuthoring?.roots.find(r=>r.id===ref.sceneId&&r.kind==='SCENE_SCRIPT'&&r.revisionId===ref.sceneScriptRevisionId);
  const genericRevision=data.productionModel.sceneScriptRevisions?.find(r=>r.id===ref.sceneScriptRevisionId&&r.sceneId===ref.sceneId&&r.authoringEntry==='GENERIC_AUTHORING_DRAFT'&&r.scopeRole==='PROPOSAL');
  if(generic&&genericRevision){
    const blocks=authoringBlocks(generic),contentHash=stableObjectHash(blocks);
    if(contentHash!==ref.sceneContentHash||genericRevision.contentHash!==contentHash)throw new HttpError(409,'作者场稿版本已变化');
    const indexes=ref.blockIds.map(id=>blocks.findIndex(b=>b.id===id));
    if(!indexes.length||indexes.some((i,p)=>i<0||p>0&&i!==indexes[p-1]+1)||boundary==='opening'&&indexes[0]!==0||boundary==='ending'&&indexes.at(-1)!==blocks.length-1)throw new HttpError(422,'作者场稿首尾必须绑定连续正文块');
    const selected=indexes.map(i=>blocks[i]);if(createHash('sha256').update(JSON.stringify(selected)).digest('hex')!==ref.excerptSha256)throw new HttpError(409,'作者场稿片段哈希不匹配');return selected;
  }
  const target = storyConfirmationTargets(data).find((item) => item.sceneId === ref.sceneId);
  const revision = data.productionModel.sceneScriptRevisions?.find((item) => item.id === ref.sceneScriptRevisionId);
  if (!target || !revision || target.sceneContentHash !== ref.sceneContentHash
    || revision.sceneId !== ref.sceneId || revision.scopeRole !== 'CURRENT' || revision.isCurrent !== true
    || ![revision.contentHash, revision.revisionHash, revision.sourceSha256, revision.sceneContentHash].includes(ref.sceneContentHash)) {
    throw new HttpError(409, '首尾正文依据已变化，请重新绑定当前场正文');
  }
  const blocks = sceneCommentBlocks(data, ref.sceneId);
  const indexes = ref.blockIds.map((id) => blocks.findIndex((block) => block.id === id));
  if (!indexes.length || indexes.some((index, position) => index < 0 || position > 0 && index !== indexes[position - 1] + 1)) throw new HttpError(422, '首尾正文引用必须是同场连续且存在的正文块');
  const visible = blocks.filter((block) => block.type !== 'divider' && block.text?.trim());
  if (boundary === 'opening' && ref.blockIds[0] !== visible[0]?.id || boundary === 'ending' && ref.blockIds.at(-1) !== visible.at(-1)?.id) throw new HttpError(422, '首尾引用必须触及实际开场或结尾');
  const selected = indexes.map((index) => blocks[index]);
  const payload = selected.map((block) => ({ id: block.id, type: block.type, speaker: block.speaker || '', performanceNote: block.performanceNote || '', text: block.text || '' }));
  const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  if (hash !== ref.excerptSha256) throw new HttpError(409, '首尾正文片段校验失败');
  return payload;
}
