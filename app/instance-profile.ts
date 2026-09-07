/** Public, story-neutral identity. Business values are supplied by one instance. */
export type InstanceProfile = {
  schemaVersion: '1.0'; instanceId: string; projectId: string; title: string;
  storyTitle: string; episodePlanId: string; locale: string;
  branding: { mark: string; title: string; description: string };
  assistant: { scopeKey: string; schedulerProtocol: string; conversationHashNamespace: string; archiveHashNamespace: string; contextMode: string };
  sourceBindings: { creativeRevisionPaths: Record<string, string>; derivedRegistryPaths: string[] };
  capabilities: Record<string, unknown>;
  configurationRef?: {revisionId:string;sha256:string};
};

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' ? value : '';
const unique = (values: string[]) => [...new Set(values.filter(Boolean))];

export function instanceProfile(value: unknown): InstanceProfile {
  const data = record(value);
  const model = Object.keys(record(data.productionModel)).length ? record(data.productionModel) : data;
  const profile = record(data.instance || model.instance);
  const revisions = Array.isArray(model.episodePlanRevisions) ? model.episodePlanRevisions.map(record) : [];
  const contexts = Array.isArray(model.reviewContexts) ? model.reviewContexts.map(record) : [];
  // Compatibility reads only use explicit graph identities; no prefix, title or directory inference.
  const projectIds = unique([...revisions, ...contexts].filter((item) => item.scopeType === 'PROJECT').map((item) => text(item.scopeId)));
  const planIds = unique(revisions.map((item) => text(item.planId)));
  const projectId = text(profile.projectId) || (projectIds.length === 1 ? projectIds[0] : 'UNKNOWN');
  const episodePlanId = text(profile.episodePlanId) || (planIds.length === 1 ? planIds[0] : 'UNKNOWN');
  const title = text(profile.title) || '制作审阅台';
  const branding = record(profile.branding);
  const assistant = record(profile.assistant);
  const sourceBindings = record(profile.sourceBindings);
  return {
    schemaVersion: '1.0', instanceId: text(profile.instanceId) || projectId, projectId, episodePlanId,
    title, storyTitle: text(profile.storyTitle) || title, locale: text(profile.locale) || 'zh-CN',
    branding: { mark: text(branding.mark) || '阅', title: text(branding.title) || title, description: text(branding.description) || '故事创作、素材审阅与全剧制作。' },
    assistant: {
      scopeKey: text(assistant.scopeKey) || `local:${projectId}`,
      schedulerProtocol: text(assistant.schedulerProtocol) || 'REVIEW_CODEX_SCHEDULER_V1',
      conversationHashNamespace: text(assistant.conversationHashNamespace) || 'REVIEW_CODEX_CONVERSATION_V1',
      archiveHashNamespace: text(assistant.archiveHashNamespace) || 'REVIEW_CODEX_ARCHIVE_EVENTS_V1',
      contextMode: text(assistant.contextMode) || 'HOST_EXPORT',
    },
    sourceBindings: {
      creativeRevisionPaths: record(sourceBindings.creativeRevisionPaths) as Record<string, string>,
      derivedRegistryPaths: Array.isArray(sourceBindings.derivedRegistryPaths) ? sourceBindings.derivedRegistryPaths.filter((item): item is string => typeof item === 'string') : [],
    },
    capabilities: record(profile.capabilities),
    configurationRef: profile.configurationRef as InstanceProfile["configurationRef"],
  };
}

export const projectIdFor = (value: unknown) => instanceProfile(value).projectId;
export const episodePlanIdFor = (value: unknown) => instanceProfile(value).episodePlanId;
