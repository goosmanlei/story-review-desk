export const visibleProductionPhases = [
  { order: 1, label: '镜头方案与预演' },
  { order: 2, label: '镜头成品' },
  { order: 3, label: '场景成片' },
  { order: 4, label: '分集成片' },
  { order: 5, label: '全剧交付' },
] as const;

const legacyWorkflowLabels: Record<number, string> = {
  1: '素材管理／素材分类管理',
  2: '镜头方案与预演／粗分镜与对白',
  3: '镜头方案与预演／Animatic锁时',
  4: '镜头成品／正式首尾帧',
  5: '镜头成品／镜头视频',
  6: '镜头成品／镜头锁定',
  7: '场景成片／声音、字幕与混音',
  8: '分集成片／分集组装',
  9: '全剧交付／跨集连续性',
};

const stageLabels: Record<string, string> = {
  P01: '场景包与镜头卡',
  P02: '风格锚定',
  P03: '人物母版',
  P04A: '建筑空态',
  P04B: '素材管理／素材分类管理',
  P05: '道具状态',
  P06: '声音母版',
  P07: '粗分镜',
  P08: '对白干声',
  P09: 'Animatic锁时',
  P10: '正式首尾帧',
  P11: '镜头视频',
  P12: '镜头锁定（口型为条件分支）',
  P13: '场景成片／声音、字幕与混音',
  P14: '分集成片／分集组装',
  P15: '全剧交付／跨集连续性',
  KFA: 'KFA首帧',
  KFB: 'KFB尾帧',
};

const stagePublicKeys: Record<string, string> = {
  P01: 'SCENE_PACKAGE',
  P02: 'STYLE_ANCHOR',
  P03: 'CHARACTER_MASTER',
  P04A: 'LOCATION_EMPTY',
  P04B: 'LOCATION_STATE',
  P05: 'PROP_STATE',
  P06: 'VOICE_MASTER',
  P07: 'STORYBOARD',
  P08: 'DIALOGUE_DRY',
  P09: 'ANIMATIC',
  P10: 'KEYFRAMES',
  P11: 'SHOT_VIDEO',
  P12: 'LIP_LOCK',
  P13: 'SCENE_SOUND',
  P14: 'EPISODE_MASTER',
  P15: 'FINAL_REVIEW',
};

export function workflowDisplay(order: number) {
  return legacyWorkflowLabels[order] || '制作门禁';
}

export function stageDisplay(code: string) {
  return stageLabels[code] || visibleText(code);
}

function replaceToken(value: string, token: string, replacement: string) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return value.replace(new RegExp(`(^|[^A-Za-z0-9])${escaped}(?=[^A-Za-z0-9]|$)`, 'gi'), (_match, prefix: string) => `${prefix}${replacement}`);
}

/**
 * The story-structure source once reused P01-P10 for narrative sequences.
 * Those values are not production stages. Translate them to the source's
 * canonical SEQ-01-SEQ-10 identifiers before the production-code pass so an
 * expanded evidence excerpt never mislabels a narrative sequence as a stage.
 */
function replaceNarrativeLegacyPhaseIds(value: string) {
  return value
    .replace(/(\blegacy_phase_id\b["']?\s*[:=]\s*["']?)P(0[1-9]|10)\b/gi, '$1SEQ-$2')
    .replaceAll('^P(0[1-9]|10)$', '^SEQ-(0[1-9]|10)$');
}

/**
 * Converts machine-only compatibility codes before text reaches the DOM,
 * clipboard, error surface or address bar. KFA/KFB remain visible because
 * they identify the meaningful first/last-frame deliverables.
 */
export function visibleText(raw: unknown) {
  if (raw === null || raw === undefined) return '';
  let value = replaceNarrativeLegacyPhaseIds(String(raw))
    .replace(/P01_ESTIMATE(?:_NOT_TIMING_LOCK|_PENDING_P09)?/gi, '制作估算（未锁时）')
    .replace(/P01[–-]P10只作旧链接兼容ID/gi, '旧链接兼容编号只留底层解析')
    .replace(/HOLD_P07_CALIBRATION/gi, '等待校准粗分镜审阅')
    .replace(/P07_CALIBRATION_REVIEW/gi, '校准粗分镜审阅中')
    .replace(/P07_USER_APPROVAL_PENDING/gi, '粗分镜等待你的审阅')
    .replace(/WAITING_P07_APPROVAL/gi, '等待粗分镜批准')
    .replace(/PENDING_USER_P09/gi, '等待Animatic锁时审阅')
    .replace(/WAIT(?:ING)?_P12/gi, '等待口型与锁镜')
    .replace(/LOCKED_P08/gi, '对白已锁定');
  for (const [code, label] of Object.entries(stageLabels)) {
    if (code === 'KFA' || code === 'KFB') continue;
    value = replaceToken(value, code, label);
  }
  value = replaceToken(value, 'P04', '叙事序列04');
  for (const [order, label] of Object.entries(legacyWorkflowLabels)) {
    value = replaceToken(value, `W${String(order).padStart(2, '0')}`, label);
  }
  value = replaceToken(value, 'CANCEL_UNSTARTED', '撤销未启动授权');
  value = value.replaceAll('_', ' ');
  return value;
}

/**
 * Evidence keeps the source's punctuation, whitespace, JSON keys and IDs, but
 * translates machine-only workflow tokens before rendering.  The catalog still
 * stores and hashes the exact source slice; this function is presentation-only.
 */
export function evidenceText(raw: unknown) {
  if (raw === null || raw === undefined) return '';
  let value = replaceNarrativeLegacyPhaseIds(String(raw))
    .replace(/P01_ESTIMATE(?:_NOT_TIMING_LOCK|_PENDING_P09)?/gi, '制作估算（未锁时）')
    .replace(/P01[–-]P10只作旧链接兼容ID/gi, '旧链接兼容编号只留底层解析')
    .replace(/HOLD_P07_CALIBRATION/gi, '等待校准粗分镜审阅')
    .replace(/P07_CALIBRATION_REVIEW/gi, '校准粗分镜审阅中')
    .replace(/P07_USER_APPROVAL_PENDING/gi, '粗分镜等待你的审阅')
    .replace(/WAITING_P07_APPROVAL/gi, '等待粗分镜批准')
    .replace(/PENDING_USER_P09/gi, '等待Animatic锁时审阅')
    .replace(/WAIT(?:ING)?_P12/gi, '等待口型与锁镜')
    .replace(/LOCKED_P08/gi, '对白已锁定');
  for (const [code, label] of Object.entries(stageLabels)) {
    if (code === 'KFA' || code === 'KFB') continue;
    value = replaceToken(value, code, label);
  }
  value = replaceToken(value, 'P04', '叙事序列04');
  for (const [order, label] of Object.entries(legacyWorkflowLabels)) {
    value = replaceToken(value, `W${String(order).padStart(2, '0')}`, label);
  }
  return value;
}

/** Stable semantic alias used only for public URLs and rendered identifiers. */
export function publicRef(raw: string | null | undefined) {
  if (!raw) return '';
  let value = raw;
  for (const [code, key] of Object.entries(stagePublicKeys)) value = replaceToken(value, code, key);
  value = replaceToken(value, 'P04', 'NARRATIVE_SEQUENCE_04');
  for (const order of Object.keys(legacyWorkflowLabels)) value = replaceToken(value, `W${String(order).padStart(2, '0')}`, `STEP${String(order).padStart(2, '0')}`);
  return value;
}

export function publicRefMatches(internal: string, candidate: string | null | undefined) {
  return Boolean(candidate && (internal === candidate || publicRef(internal) === candidate));
}
