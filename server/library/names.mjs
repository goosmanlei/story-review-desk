import path from 'node:path';
import { pinyin } from 'pinyin-pro';
import { hash } from '../shared/contracts.mjs';

export function slug(value, fallback = 'unclassified') {
  return String(value || '').replace(/\p{Script=Han}+/gu, word => ' ' + pinyin(word, { toneType: 'none', v: true }) + ' ')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100).replace(/-+$/g, '') || fallback;
}
const extensions = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/svg+xml': 'svg',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/flac': 'flac', 'audio/ogg': 'ogg',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'text/plain': 'txt', 'text/markdown': 'md', 'application/json': 'json', 'application/pdf': 'pdf',
};
const modelExtensions = new Set(['obj','mtl','fbx','glb','gltf','blend','usd','usda','usdc','stl']);
const fallbackExtensions = new Set([...modelExtensions,'svg','png','jpg','jpeg','webp','gif','avif','tif','tiff','exr','psd','wav','mp3','mp4','webm','mov','md','txt','json','pdf','srt','vtt','yaml','yml','zip']);
export function mediaExtension(row) {
  if (extensions[row.mime_type]) return extensions[row.mime_type];
  const ext = path.posix.extname(row.evidence?.legacyVersion?.path || row.original_path || '').slice(1).toLowerCase();
  return fallbackExtensions.has(ext) ? ext : 'bin';
}
const categoryNames = new Map([
  ['character','characters'], ['characters','characters'], ['portrait','characters'], ['人物','characters'], ['角色','characters'],
  ['location','locations'], ['locations','locations'], ['environment','locations'], ['场景','locations'], ['空间','locations'],
  ['prop','props'], ['props','props'], ['道具','props'], ['storyboard','storyboards'], ['分镜','storyboards'],
  ['voice','voices'], ['voice_master','voices'], ['声音母版','voices'], ['dialogue','dialogue'], ['对白','dialogue'],
  ['ambience','ambience'], ['ambient','ambience'], ['环境声','ambience'], ['music','music'], ['音乐','music'],
  ['sfx','effects'], ['effect','effects'], ['effects','effects'], ['音效','effects'],
  ['animatic','animatics'], ['动态分镜','animatics'], ['shot','shots'], ['assembly','assemblies'], ['deliverable','assemblies'],
  ['character_identity','characters'], ['character_info_card','characters'], ['人物身份','characters'], ['群演身份','characters'], ['appearance','characters'],
  ['location_empty','locations'], ['location_state','locations'], ['地点空态','locations'], ['地点状态','locations'],
  ['prop_identity','props'], ['prop_state','props'], ['关键道具','props'], ['道具状态','props'], ['religious_set_dressing','props'],
  ['voice_identity','voices'], ['声音身份','voices'], ['对白干声','dialogue'], ['原创配乐','music'], ['ambience_loop','ambience'], ['环境底声','ambience'],
  ['action_foley','effects'], ['动作拟音','effects'], ['production_reference','references'], ['derived_crop','references'], ['historical_media_evidence','references'], ['风格锚点','references'],
  ['shot_video','shots'], ['episode_master','assemblies'], ['animatic_timing_lock','animatics'],
]);
const allowedCategories = {
  images: new Set(['characters','locations','props','storyboards','references']),
  audio: new Set(['voices','dialogue','ambience','music','effects','sources']),
  videos: new Set(['animatics','shots','assemblies']),
};
export function mediaName(row, bindings = []) {
  const legacy = row.evidence?.legacyVersion || {};
  const paths = [legacy.path, row.original_path, row.id.replace(/^[^:]+:/, '')].filter(Boolean);
  const readablePath = paths.find(p => !/^[a-f0-9]{32,}(\.[a-z0-9]+)?$/i.test(path.posix.basename(p.replaceAll('\\', '/'))));
  const readable = readablePath && path.posix.basename(readablePath.replaceAll('\\', '/'));
  const ref = bindings.find(b => b.role === 'OUTPUT' && b.kind === 'ASSET') || bindings[0];
  const descriptive = readable || ref?.familyTitle || ref?.title || row.id;
  const ext = mediaExtension(row);
  const mediaType = row.mime_type.split('/')[0];
  const type = mediaType === 'image' || ['svg','png','jpg'].includes(ext) ? 'images' : mediaType === 'audio' ? 'audio' : mediaType === 'video' ? 'videos' : 'other';
  const fields = [ref?.content?.businessCategoryPrimaryId, ref?.familyContent?.businessCategoryPrimaryId,
    ref?.content?.subtype, ref?.familyContent?.subtype, ref?.content?.type];
  let category = fields.map(v => categoryNames.get(String(v || '').toLowerCase().replace(/^material_requirement_/, ''))).find(v => allowedCategories[type]?.has(v));
  if (!category && (bindings.some(b => b.kind === 'SOURCE') || row.id.startsWith('source-artifact:')) && type === 'audio') category = 'sources';
  if (!category && type === 'images' && (row.id.startsWith('evidence-artifact:') || !ref)) category = 'references';
  if (!category && type === 'other') category = modelExtensions.has(ext) ? 'models' : ext;
  category ||= 'unclassified';
  const scope = slug(ref?.familyTitle || ref?.title || path.posix.basename(path.posix.dirname(readablePath || '')), 'unclassified');
  let stem = slug(path.posix.basename(descriptive, path.posix.extname(descriptive)));
  if (/^v[0-9]+$/.test(stem) && ref?.familyTitle) stem = slug(ref.familyTitle) + '-' + stem;
  if (!readable && legacy.label && !stem.includes(slug(legacy.label))) stem += '-' + slug(legacy.label);
  // Always include the identity suffix: adding a same-named item never renames an existing version.
  const key = hash([row.id, row.version_id, row.sha256]);
  return { key, path: `${type}/${category}/${scope}/${stem}--${key.slice(0, 12)}.${ext}` };
}

export function renderScreenplay(plan) {
  const scenes = new Map(plan.content.narrativeRevision.scenes.map(scene => [scene.id, scene]));
  const lines = ['# 完整剧本', ''];
  for (const episode of plan.content.episodes) {
    lines.push(`## ${[episode.displayId, episode.title].filter(Boolean).join(' · ')}`, '');
    for (const id of episode.sceneIds) {
      const scene = scenes.get(id);
      if (!scene) throw Error('剧本关联场缺失：' + id);
      lines.push(`### ${[scene.displayId, scene.title].filter(Boolean).join(' · ')}`, '');
      if (scene.slugline) lines.push(scene.slugline, '');
      for (const block of scene.scriptBlocks || []) {
        const speaker = plan.subjectNames?.[block.speaker] || block.speaker;
        if (speaker) lines.push(`**${speaker}**${block.performanceNote ? `（${block.performanceNote}）` : ''}`, '');
        else if (block.performanceNote) lines.push(`（${block.performanceNote}）`, '');
        if (block.text) lines.push(block.text, '');
      }
    }
  }
  return Buffer.from(lines.join('\n').trimEnd() + '\n');
}
