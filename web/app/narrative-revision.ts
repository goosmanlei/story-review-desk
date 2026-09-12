/** Author-owned screenplay within a complete, unadopted EpisodePlan candidate. */
export type NarrativeBlock = { id: string; type: 'action' | 'dialogue'; speaker: string; performanceNote: string; text: string };
export type RuntimeEstimate = {
  compactSec: number; baseSec: number; spaciousSec: number;
  dialogueChars: number; dialogueSec: number; actionSec: number; reactionSec: number;
  transitionSec: number; overlapSec: number; rationale: string; confidence: string;
};
export type NarrativeScene = {
  id: string; displayId: string; title: string; slugline: string;
  oldSceneIds: string[]; oldSceneMappingNote?: string; sourceSegmentIds: string[]; storyTime: string; viewpoint: string;
  purpose: string; audienceKnown: string; audienceWithheld: string; transition: string;
  scriptBlocks: NarrativeBlock[]; contentHash: string; runtime: RuntimeEstimate;
};
export type NarrativeRevision = {
  schemaVersion: '1.0'; title: string; baseScriptSha256: string; transcriptSha256: string;
  runtimeMethod: string; scenes: NarrativeScene[];
  retiredSceneIds: string[];
  sequences: Array<{ id: string; title: string; sceneIds: string[] }>;
  causalChains: Array<{ id: string; title: string; setupSceneIds: string[]; payoffSceneIds: string[]; status: string; mustPreserve: string }>;
  legacySceneEstimates: Array<{ sceneId: string; title: string; runtime: RuntimeEstimate; sourceSceneContentHash?: string; sourceDocumentSha256?: string }>;
  sourceNarrationIndex: Array<{ id: string; sourceSha256: string; summary: string; viewpoint: string; treatment: string; reason: string; sceneIds: string[] }>;
  documents: Array<{ id: string; title: string; text: string; sha256: string }>;
};

export function runtimeTotal(scenes: NarrativeScene[]): Pick<RuntimeEstimate, 'compactSec' | 'baseSec' | 'spaciousSec'> {
  const add=(a:number,b:number)=>Number.isFinite(b)?a+b:NaN;
  return scenes.reduce((sum, scene) => ({ compactSec: add(sum.compactSec,scene.runtime.compactSec), baseSec: add(sum.baseSec,scene.runtime.baseSec), spaciousSec: add(sum.spaciousSec,scene.runtime.spaciousSec) }), { compactSec: 0, baseSec: 0, spaciousSec: 0 });
}
export function runtimeLabel(seconds: number) { return Number.isFinite(seconds)?`${Math.floor(seconds / 60)}分${String(Math.round(seconds % 60)).padStart(2, '0')}秒`:'UNKNOWN'; }

export const NARRATIVE_OVERVIEW_SECTIONS = [
  {id:'documents',label:'创作说明'}, {id:'structure',label:'分集与视角接力'}, {id:'causality',label:'铺垫与揭晓'},
] as const;
export type NarrativeOverviewSection = typeof NARRATIVE_OVERVIEW_SECTIONS[number]['id'];
export function narrativeOverviewSection(value: string | null | undefined): NarrativeOverviewSection {
  return NARRATIVE_OVERVIEW_SECTIONS.find(section=>section.id===value)?.id || (value==='audience' ? 'causality' : 'documents');
}
