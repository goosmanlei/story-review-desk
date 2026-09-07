'use client';

import { deriveLifecycleState, type StatusRecord } from './status-contract';

export type AssetStatus = 'approved' | 'blocked' | 'planned' | 'warning';

export type Asset = StatusRecord & {
  id: string;
  title: string;
  type: '视觉' | '声音' | '生成目标';
  subtype: string;
  definitionStatus: 'DEFINED';
  version: string;
  preview?: string | null;
  audio?: string;
  scenes: string[];
  parents: string[];
  children: string[];
  storyUse: string;
  qa: string;
  rights: string;
  path: string;
  prompt: string;
  promptVersion?: string;
  duration?: number;
  transcript?: string;
  technical?: string;
  evidence?: Record<string, string>;
  sha256?: string;
  proxySha256?: string;
  reviewProxy?: string;
  reviewedAt?: string;
  subject?: string;
  loc?: string;
  zone?: string;
};

/**
 * Existing catalog styles use four visual buckets. Derive those buckets from
 * the canonical model-2.0 lifecycle instead of reading the retired parallel
 * status fields from the asset record.
 */
export function assetPresentationStatus(asset: Asset): AssetStatus {
  switch (deriveLifecycleState(asset)) {
    case 'RELEASED':
    case 'SATISFIED_BY_EXISTING':
      return 'approved';
    case 'DO_NOT_USE':
    case 'RIGHTS_HOLD':
    case 'BLOCKED':
    case 'EXECUTION_FAILED':
    case 'DELETED_AUDIT':
      return 'blocked';
    case 'REVIEW_PENDING':
    case 'REVISION_REQUIRED':
    case 'RESULT_PENDING_REGISTRATION':
    case 'RESULT_UNKNOWN':
      return 'warning';
    default:
      return 'planned';
  }
}

export type Coverage = {
  visualTotal: number;
  visualApproved: number;
  visualBlocked: number;
  audioTotal: number;
  audioPlayable: number;
  audioPlanned: number;
  audioRemainingAuthored: number;
  audioRemainingMaterialized: number;
  audioRemainingRightsUnknown: number;
  audioExecutionCallTotal: number;
  shotsTotal: number;
  shotsReady: number;
  shotsWarning: number;
  shotsBlocked: number;
  storyboardsExpected: number;
  storyboardsMaterialized: number;
  storyboardsQaPass: number;
  storyboardsReviewDecision: 'PENDING' | 'RELEASED' | 'REVISION_REQUIRED' | 'DO_NOT_USE' | 'NOT_APPLICABLE';
  storyboardsReleasedCount: number;
  outputArtifactsTotal: number;
  outputArtifactsMaterialized: number;
};

export type Shot = StatusRecord & {
  id: string;
  scene: string;
  title: string;
  duration: number;
  branch: string;
  definitionStatus: 'DEFINED';
  issue: string;
  visualRefs: string[];
  audioRefs: string[];
  rebaseRefs: string[];
  locs: string[];
  zones: string[];
  cams: string[];
  output: string;
  outputArtifactRefs: string[];
  prompt: string;
  sourceContent?: string;
  segmentId?: string;
  beatId?: string;
  promptDefinitionStatus?: string;
  storyboardRef: string;
  storyboardPath?: string;
  storyboardLifecycleState: string;
  storyboardReviewDecision: 'PENDING' | 'RELEASED' | 'REVISION_REQUIRED' | 'DO_NOT_USE' | 'NOT_APPLICABLE';
  storyboardReviewProxy: string | null;
};

function pauseOtherAudio(active: HTMLAudioElement) {
  document.querySelectorAll<HTMLAudioElement>('audio[data-review-audio]').forEach((audio) => {
    if (audio !== active) audio.pause();
  });
}

export function stopSeamAudition() {
  document.dispatchEvent(new Event('review-stop-seam'));
}

export function handleReviewAudioPlay(active: HTMLAudioElement) {
  if (active.dataset.seamAudition === 'programmatic') delete active.dataset.seamAudition;
  else stopSeamAudition();
  pauseOtherAudio(active);
}
