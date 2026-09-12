import {createHash} from 'node:crypto';
import {GUIDANCE_ALIASES, TOPIC_GUIDANCE_ALIASES, allowedGuidanceRole} from '../../presentation/guidance-aliases.mjs';
import {contextResource} from './context-catalog';
import type {AssistantResource} from './types';

type PublishedDocument = {documentId: string; revisionId: string; aliases: string[]; sha256: string; bytes: Uint8Array; metadata: Record<string, unknown>; deleted?: boolean};
export const guidanceResourceId = (alias: string) => 'guidance:' + alias;
export const GUIDANCE_INDEX_ID = 'guidance:index';

/** Only exact published, fixed-alias guidance enters this catalog; no draft promotion. */
export function projectGuidanceResources(documents: PublishedDocument[]): AssistantResource[] {
  const resources: AssistantResource[] = [];
  for (const alias of GUIDANCE_ALIASES) {
    const matches = documents.filter(document => document.aliases.includes(alias));
    if (matches.length > 1) throw new Error('GUIDANCE_ALIAS_AMBIGUOUS');
    if (!matches.length) continue;
    const document = matches[0];
    if (document.deleted || document.aliases.length !== 1 || !allowedGuidanceRole(document, alias)) throw new Error('GUIDANCE_ROLE_INVALID');
    const bytes = Buffer.from(document.bytes);
    if (createHash('sha256').update(bytes).digest('hex') !== document.sha256) throw new Error('GUIDANCE_BYTES_INVALID');
    const text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);
    resources.push(contextResource({
      id: guidanceResourceId(alias), title: alias, kind: 'PROJECT_GUIDANCE', text,
      href: '/?view=system&document=' + encodeURIComponent(document.documentId),
      relations: [], role: 'REFERENCE', versionId: document.revisionId,
    }));
  }
  if (resources.length) resources.push(contextResource({
    id: GUIDANCE_INDEX_ID, title: '项目指引索引', kind: 'GUIDANCE_INDEX', role: 'REFERENCE',
    href: '/?view=system', relations: resources.map(resource => resource.id),
    text: JSON.stringify({
      policy: '通用规则与当前对象先行；按任务 search_project/read_resources 读取相关专题，不一次加载全部细则。指引不新增正式审阅、制作或外部操作授权；未读取内容不得声称已读。',
      documents: resources.map(resource => ({id: resource.id, alias: resource.title, revisionId: resource.versionId, sha256: resource.sha256, onDemand: TOPIC_GUIDANCE_ALIASES.some(alias => resource.id === guidanceResourceId(alias))})),
    }),
  }));
  return resources;
}

export function initialGuidanceIds(resources: AssistantResource[]): string[] {
  // Topics and STATE are discoverable, never added wholesale to every turn.
  return [GUIDANCE_INDEX_ID, guidanceResourceId('AGENTS.md')].filter(id => resources.some(resource => resource.id === id));
}
