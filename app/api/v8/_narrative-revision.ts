import { createHash } from 'node:crypto';
import type { NarrativeRevision, RuntimeEstimate } from '../../narrative-revision';
import type { SceneExcerptRef } from '../../story-review-types';
import { assertJsonObject, assertSha256, assertStableId, assertString, HttpError, stableObjectHash, type ReviewData } from './_store';

export function validateRuntime(value: RuntimeEstimate) {
  if (!value || typeof value !== 'object') throw new HttpError(422, '逐场时长估算缺失');
  for (const key of ['compactSec','baseSec','spaciousSec','dialogueChars','dialogueSec','actionSec','reactionSec','transitionSec','overlapSec'] as const) {
    if (!Number.isInteger(value[key]) || value[key] < 0 || value[key] > 100_000) throw new HttpError(422, `时长分项 ${key} 无效`);
  }
  if (!value.baseSec || value.compactSec > value.baseSec || value.baseSec > value.spaciousSec
    || value.baseSec !== value.dialogueSec + value.actionSec + value.reactionSec + value.transitionSec - value.overlapSec
    || value.overlapSec > Math.min(value.dialogueSec, value.actionSec)) throw new HttpError(422, '时长三档或分项合计不一致');
  assertString(value.rationale, 'runtime.rationale', 8000); assertString(value.confidence, 'runtime.confidence', 100);
}

/** Candidate validation never projects these scenes as CURRENT production objects. */
export function validateNarrativeRevision(data: ReviewData, value: unknown, adopted = false): NarrativeRevision {
  const bundle = assertJsonObject(value, 'narrativeRevision', 4_000_000) as unknown as NarrativeRevision;
  if (bundle.schemaVersion !== '1.0') throw new HttpError(422, '叙事正文候选版本无效');
  assertString(bundle.title, 'narrative.title', 500); assertString(bundle.runtimeMethod, 'runtimeMethod', 8000);
  const scriptHash = String(data.creativeLineage?.scriptDocument?.sha256 || data.sourceHashes?.scriptSha256 || '');
  if (!adopted && (assertSha256(bundle.baseScriptSha256, 'baseScriptSha256') !== scriptHash
    || assertSha256(bundle.transcriptSha256, 'transcriptSha256') !== data.storySources?.transcript?.sha256)) throw new HttpError(409, '叙事重构依据已经变化');
  if (!Array.isArray(bundle.scenes) || !bundle.scenes.length || bundle.scenes.length > 500) throw new HttpError(422, '完整新场目录缺失');
  const currentScenes = data.creativeLineage?.scenes || [];
  const oldIds = adopted ? bundle.retiredSceneIds : currentScenes.map((scene) => String(scene.id));
  if (adopted && (currentScenes.length !== bundle.scenes.length || currentScenes.some(row => {const scene=bundle.scenes.find(s=>s.id===row.id);return !scene || stableObjectHash(row.scriptBlocks)!==scene.contentHash;}))) throw new HttpError(409, '已生效新稿与当前场正文不一致');
  const ids = bundle.scenes.map((scene) => assertStableId(scene.id, 'narrative sceneId', 20));
  if (new Set(ids).size !== ids.length || ids.some((id) => oldIds.includes(id))) throw new HttpError(422, '重构场必须使用不复用旧场的永久身份');
  if (!Array.isArray(bundle.retiredSceneIds) || stableObjectHash([...bundle.retiredSceneIds].sort()) !== stableObjectHash([...oldIds].sort())) throw new HttpError(422, '旧场身份退役清单不完整');
  const segments = data.storySources?.transcript?.segments || [];
  const segmentMap = new Map(segments.map((segment) => [segment.id, segment.contentSha256]));
  const coveredOld = new Set<string>();
  for (const [index, scene] of bundle.scenes.entries()) {
    if (scene.displayId !== `S${String(index + 1).padStart(2, '0')}`) throw new HttpError(422, '新场显示编号必须按顺序排列');
    for (const key of ['title','slugline','storyTime','viewpoint','purpose','audienceKnown','audienceWithheld','transition'] as const) assertString(scene[key], `scene.${key}`, 8000);
    if (!Array.isArray(scene.oldSceneIds) || !scene.oldSceneIds.length || scene.oldSceneIds.some((id) => !oldIds.includes(id))) throw new HttpError(422, '新旧场映射无效');
    if (scene.oldSceneMappingNote) assertString(scene.oldSceneMappingNote, 'scene.oldSceneMappingNote', 8000);
    scene.oldSceneIds.forEach((id) => coveredOld.add(id));
    if (!Array.isArray(scene.sourceSegmentIds) || !scene.sourceSegmentIds.length || scene.sourceSegmentIds.some((id) => !segmentMap.has(id))) throw new HttpError(422, '新场原文依据无效');
    if (!Array.isArray(scene.scriptBlocks) || !scene.scriptBlocks.length || scene.scriptBlocks.length > 1000) throw new HttpError(422, '新场必须提供完整正文');
    scene.scriptBlocks.forEach((block, i) => {
      if (block.id !== `${scene.id}-B${String(i + 1).padStart(3, '0')}` || !['action','dialogue'].includes(block.type)
        || typeof block.speaker !== 'string' || typeof block.performanceNote !== 'string') throw new HttpError(422, '新场正文块身份或类型无效');
      assertString(block.text, 'block.text', 20000);
    });
    if (stableObjectHash(scene.scriptBlocks) !== assertSha256(scene.contentHash, 'scene.contentHash')) throw new HttpError(409, '新场正文哈希不匹配');
    validateRuntime(scene.runtime);
  }
  if (oldIds.some((id) => !coveredOld.has(id))) throw new HttpError(422, '原场内容未完整交代去向');
  if (!Array.isArray(bundle.sequences) || !bundle.sequences.length || bundle.sequences.flatMap((s) => s.sceneIds).join('|') !== ids.join('|') || new Set(bundle.sequences.map((s) => s.id)).size !== bundle.sequences.length) throw new HttpError(422, '新叙事段落必须按新场顺序完整覆盖');
  if (!Array.isArray(bundle.causalChains) || bundle.causalChains.some((chain) => !chain.setupSceneIds.length || !chain.payoffSceneIds.length || [...chain.setupSceneIds,...chain.payoffSceneIds].some((id) => !ids.includes(id)) || !chain.mustPreserve)) throw new HttpError(422, '因果链两端必须绑定新场');
  if (!Array.isArray(bundle.legacySceneEstimates) || bundle.legacySceneEstimates.map((s) => s.sceneId).join('|') !== oldIds.join('|')) throw new HttpError(422, '旧场估时基线缺场');
  bundle.legacySceneEstimates.forEach((scene) => validateRuntime(scene.runtime));
  if (!Array.isArray(bundle.sourceNarrationIndex) || bundle.sourceNarrationIndex.length !== segments.length || new Set(bundle.sourceNarrationIndex.map((row) => row.id)).size !== segments.length) throw new HttpError(422, '原文叙事索引未全量覆盖');
  for (const row of bundle.sourceNarrationIndex) {
    if (!segmentMap.has(row.id) || segmentMap.get(row.id) !== assertSha256(row.sourceSha256, 'sourceNarrationIndex.sourceSha256') || !row.summary || !row.viewpoint || !row.treatment || !row.reason || !Array.isArray(row.sceneIds) || row.sceneIds.some((id) => !ids.includes(id))) throw new HttpError(422, '原文叙事索引依据或去向无效');
    const linked = bundle.scenes.filter((scene) => scene.sourceSegmentIds.includes(row.id)).map((scene) => scene.id);
    if (stableObjectHash([...row.sceneIds].sort()) !== stableObjectHash(linked.sort())) throw new HttpError(422, '原文叙事索引与场正文依据不一致');
  }
  if (!Array.isArray(bundle.documents) || bundle.documents.length > 20) throw new HttpError(422, '叙事说明文档无效');
  for (const doc of bundle.documents) {
    assertStableId(doc.id, 'document.id'); assertString(doc.title, 'document.title', 500); assertString(doc.text, 'document.text', 500_000);
    if (createHash('sha256').update(doc.text).digest('hex') !== doc.sha256) throw new HttpError(409, '叙事说明文档哈希不匹配');
  }
  return bundle;
}

export function narrativeExcerpt(bundle: NarrativeRevision, ref: SceneExcerptRef, boundary?: 'opening' | 'ending') {
  const scene = bundle.scenes.find((scene) => scene.id === ref.sceneId);
  if (!scene || ref.sceneContentHash !== scene.contentHash || ref.sceneScriptRevisionId !== `NSR-${scene.contentHash.slice(0,24)}`) throw new HttpError(409, '候选正文片段绑定失效');
  const indexes = ref.blockIds.map((id) => scene.scriptBlocks.findIndex((block) => block.id === id));
  if (!indexes.length || indexes.some((i, p) => i < 0 || p > 0 && i !== indexes[p-1] + 1)
    || boundary === 'opening' && indexes[0] !== 0 || boundary === 'ending' && indexes.at(-1) !== scene.scriptBlocks.length - 1) throw new HttpError(422, '候选首尾必须使用实际连续正文块');
  const blocks = indexes.map((i) => scene.scriptBlocks[i]);
  if (createHash('sha256').update(JSON.stringify(blocks)).digest('hex') !== ref.excerptSha256) throw new HttpError(409, '候选正文片段哈希不匹配');
  return blocks;
}
