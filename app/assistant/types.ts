export type WorkFocus = {
  projectId: string;
  snapshotId: string;
  view: string;
  subjectType: 'PROJECT' | 'SOURCE' | 'EPISODE' | 'SCENE' | 'MATERIAL' | 'WORK_ITEM' | 'GUIDE';
  subjectId: string;
  title: string;
  versionId?: string;
  criterionId?: string;
  itemId?: string;
  selection?: Record<string, unknown>;
  references?: string[];
  filters?: Record<string, string>;
};

export type ClientDraft = {
  id: string; label: string; fieldId: string; subjectId: string;
  versionId?: string; value: string; baseHash: string;
};

export type AssistantResource = {
  id: string; title: string; kind: string; versionId?: string;
  sha256: string; text: string; href: string;
  role: 'CURRENT' | 'HISTORICAL' | 'REFERENCE';
  relations: string[];
  media?: { kind: 'image' | 'audio' | 'video'; path: string; sha256: string; mimeType: string };
  sourceBinding?: import('../../host/instance-runtime/assistant-source.mjs').SourceBinding;
};

export type ResourceCatalog = {
  schemaVersion: '1.0' | '1.1'; projectId: string; scopeKey: string;
  snapshotId: string; resources: AssistantResource[];
};

export type ContextPacket = {
  packetId: string;
  packetHash: string;
  body: {
    schemaVersion: '1.0' | '1.1'; projectId: string; scopeKey: string;
    snapshotId: string; focus: WorkFocus; focusKey: string;
    dependencyHash: string; catalogHash: string;
    initialResourceIds: string[]; draftTargets: ClientDraft[]; missing: string[];
  };
};

export type AssistantContextRef = { packetId: string; packetHash: string };
export type DraftSuggestion = { targetId: string; text: string };
export type WorkContextResult = AssistantContextRef & {
  focusKey: string; evidenceIds: string[]; observedImageIds: string[];
  suggestions: DraftSuggestion[]; stale: boolean;
};

export type AssistantDraftTarget = Omit<ClientDraft, 'baseHash'> & {
  canAdopt: boolean;
  disabledReason?: string;
  apply: (nextValue: string, expectedValue: string) => boolean;
};

/** Stable UTF-8 JSON wire format shared with the host worker. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function textHash(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
