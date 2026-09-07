export type MaterialMediaType = 'TEXT' | 'IMAGE' | 'VIDEO' | 'AUDIO' | 'UNKNOWN';

export const materialMediaTypeOptions: ReadonlyArray<{ id: MaterialMediaType; label: string }> = [
  { id: 'TEXT', label: '文本' },
  { id: 'IMAGE', label: '图像' },
  { id: 'VIDEO', label: '视频' },
  { id: 'AUDIO', label: '音频' },
];

export const materialBusinessPrimaryOrder = [
  '人物', '场景', '道具', '台词', '配音', '拟音', '环境声', '配乐', '风格与参考',
] as const;

export const materialBusinessSecondaryOrder: Readonly<Record<string, ReadonlyArray<string>>> = {
  人物: ['人物身份', '人物信息卡', '群演身份', '尸身状态', '首级代理'],
  场景: ['地点空态', '地点状态', '空间证据'],
  道具: ['关键道具', '道具状态', '宗教陈设'],
  台词: ['对白文本'],
  配音: ['声音身份', '声音母版'],
  拟音: ['动作拟音'],
  环境声: ['环境底声'],
  配乐: ['原创配乐'],
  风格与参考: ['风格锚点'],
};

export const materialCategoryPresentation: Readonly<Record<string, { icon: string; tone: string }>> = {
  人物: { icon: '👤', tone: 'people' },
  场景: { icon: '🏠', tone: 'scene' },
  道具: { icon: '🧰', tone: 'prop' },
  台词: { icon: '💬', tone: 'dialogue' },
  配音: { icon: '🎙️', tone: 'voice' },
  拟音: { icon: '👣', tone: 'foley' },
  环境声: { icon: '🔉', tone: 'ambience' },
  配乐: { icon: '🎵', tone: 'music' },
  风格与参考: { icon: '🎨', tone: 'style' },
};

export type MaterialCreatorStage =
  | 'INITIAL'
  | 'PRODUCTION_READY'
  | 'WAITING_PRODUCTION'
  | 'IN_PRODUCTION'
  | 'PENDING_REVIEW'
  | 'APPROVED'
  | 'BLOCKED';

export const materialCreatorStageOptions: ReadonlyArray<{ id: MaterialCreatorStage; label: string }> = [
  { id: 'INITIAL', label: '已定义' },
  { id: 'PRODUCTION_READY', label: '待生成' },
  { id: 'PENDING_REVIEW', label: '待审阅' },
  { id: 'APPROVED', label: '已通过' },
];

const materialCreatorStageIds = new Set<string>(materialCreatorStageOptions.map((item) => item.id));

export function isMaterialCreatorStage(value: unknown): value is MaterialCreatorStage {
  return typeof value === 'string' && materialCreatorStageIds.has(value);
}

const creatorStageLabels = Object.fromEntries(
  materialCreatorStageOptions.map((item) => [item.id, item.label]),
) as Record<MaterialCreatorStage, string>;

export type MaterialCreatorStageProjection = {
  /** Operational gate fact; it is not a fifth creator-stage filter. */
  executionBlocked: boolean;
  creatorStage: MaterialCreatorStage;
  creatorStageLabel: string;
  creatorStageDetail: string;
  creatorStageShortReason: string;
  creatorStageReasonCodes: string[];
  creatorStageReasons: string[];
  creatorStageNextStep: string;
  sourceLifecycleState: string;
  executionRequestState: string | null;
};

function normalizedReasonCodes(values: unknown[]) {
  return [...new Set(values.flatMap((value) => (
    Array.isArray(value) ? value : value === null || value === undefined ? [] : [value]
  )).map((value) => String(value).trim()).filter(Boolean))];
}

function explainMaterialBlockers(lifecycle: string, reasonCodes: string[]) {
  const joined = reasonCodes.join(' ');
  const reasons: string[] = [];
  const executionDefinitionMissing = /EXECUTION_DEFINITION/.test(joined);
  const pictureLockMissing = /CURRENT_PICTURE_LOCK/.test(joined);
  const syncPointsMissing = /SYNC_POINTS/.test(joined);
  const resultUnknown = lifecycle === 'RESULT_UNKNOWN' || /RESULT_UNKNOWN/.test(joined);
  const executionFailed = lifecycle === 'EXECUTION_FAILED' || /EXECUTION_FAILED/.test(joined);
  const rightsBlocked = lifecycle === 'RIGHTS_HOLD' || /RIGHTS_(?:HOLD|BLOCKED)|CURRENT_RIGHTS_BLOCKED/.test(joined);

  if (executionDefinitionMissing) {
    reasons.push('当前需求尚未登记可执行的完整生产定义；Prompt、模型、参数和固定输出还未锁定。');
  }
  if (pictureLockMissing) {
    reasons.push('相关场景尚未完成“场剪辑与画面锁定”，正式画面与 EDL 还未冻结。');
  }
  if (syncPointsMissing) {
    reasons.push('动作发生的准确帧点尚未登记，拟音无法与锁定画面精确同步。');
  }
  if (resultUnknown) {
    reasons.push('执行请求已经发出，但系统尚不能确认是否产生结果；当前禁止自动重试。');
  }
  if (executionFailed) {
    reasons.push('最近一次执行已明确失败，必须先核对失败记录并重新创建执行授权。');
  }
  if (rightsBlocked) {
    reasons.push('当前权利门禁未通过，该素材不能继续生产或向下游流转。');
  }
  if (!reasons.length && lifecycle === 'BLOCKED') {
    reasons.push('系统只确认存在硬门禁，但尚未登记可供创作者判断的具体原因。');
  }

  let shortReason = '';
  let nextStep = '';
  if (executionDefinitionMissing && pictureLockMissing && syncPointsMissing) {
    shortReason = '缺执行定义、画面锁定与同步点';
    nextStep = '先按主线完成相关场的镜头方案、单镜锁定和“场剪辑与画面锁定”，从锁定时间线登记动作同步点；再补齐本需求的完整执行定义并重新判断生产就绪。';
  } else if (executionDefinitionMissing && pictureLockMissing) {
    shortReason = '缺执行定义与画面锁定';
    nextStep = '先按主线完成相关场的镜头方案、单镜锁定和“场剪辑与画面锁定”；再依据锁定时间线补齐本需求的完整执行定义并重新判断生产就绪。';
  } else if (pictureLockMissing || syncPointsMissing) {
    shortReason = '等待画面锁定与同步点';
    nextStep = '先按主线完成相关场的镜头方案、单镜锁定和“场剪辑与画面锁定”，再从锁定时间线登记动作同步点；系统随后重新判断是否可以开始生产。';
  } else if (executionDefinitionMissing) {
    shortReason = '缺少完整执行定义';
    nextStep = '补齐并校验本需求的上传附件、完整 Prompt、模型、参数和固定输出后，重新判断生产就绪。';
  } else if (resultUnknown) {
    shortReason = '执行结果尚未查明';
    nextStep = '先按 REQUEST_ID／LOG_ID 或平台任务 ID 核查唯一结果；确认没有产出后才能创建新的执行授权。';
  } else if (executionFailed) {
    shortReason = '最近一次执行失败';
    nextStep = '先核对失败原因；确需再次生产时创建新的单次执行授权，不复用旧请求。';
  } else if (rightsBlocked) {
    shortReason = '权利门禁未通过';
    nextStep = '先解决不可豁免的权利问题并登记可核验依据；未解决前保持阻断。';
  } else if (reasons.length) {
    shortReason = '阻断原因尚未完整登记';
    nextStep = '先补齐可核验的具体阻断原因；原因不明时不能开始生产。';
  }

  return { reasons, shortReason, nextStep };
}

export function projectMaterialCreatorStage({
  lifecycleState,
  executionRequestState,
  requirementClass,
  flowBlockReasons,
  executionBlockReasons,
  executionGate,
  coverageSatisfied,
  bindingStale,
}: {
  coverageSatisfied?: boolean;
  bindingStale?: boolean;
  lifecycleState?: string | null;
  executionRequestState?: string | null;
  requirementClass?: string | null;
  flowBlockReasons?: readonly unknown[] | null;
  executionBlockReasons?: readonly unknown[] | null;
  executionGate?: unknown;
}): MaterialCreatorStageProjection {
  const lifecycle = String(lifecycleState || 'UNKNOWN');
  const request = executionRequestState ? String(executionRequestState) : null;
  const reasonCodes = normalizedReasonCodes([flowBlockReasons, executionBlockReasons, executionGate]);
  const blockerExplanation = explainMaterialBlockers(lifecycle, reasonCodes);
  let creatorStage: MaterialCreatorStage = 'BLOCKED';
  let detail = '当前状态证据不完整，已按异常阻断处理，不能推断为正常生产阶段。';

  if (requirementClass === 'EVIDENCE_ONLY' || ['EVIDENCE_ONLY', 'NOT_APPLICABLE', 'DELETED_AUDIT'].includes(lifecycle)) {
    creatorStage = 'BLOCKED';
    detail = '该对象只属于历史或审计证据，不应进入当前素材目录。';
  } else if (['BLOCKED','RIGHTS_HOLD','EXECUTION_FAILED','RESULT_UNKNOWN'].includes(lifecycle) || (blockerExplanation.reasons.length > 0 && !['REVIEW_PENDING','RELEASED','SATISFIED_BY_EXISTING'].includes(lifecycle))) {
    creatorStage='BLOCKED';detail=blockerExplanation.reasons.join('；')||'存在未解决的门禁，需核对后继续。';
  } else if (request === 'CLAIMED' || ['IN_PROGRESS', 'RESULT_PENDING_REGISTRATION'].includes(lifecycle)) {
    creatorStage = 'IN_PRODUCTION';
    detail = lifecycle === 'RESULT_PENDING_REGISTRATION'
      ? '执行已经成功，正在登记文件与 SHA-256。'
      : '生产任务已经认领或运行，尚未形成可审阅版本。';
  } else if (request === 'AUTHORIZED' && !['REVIEW_PENDING', 'RELEASED'].includes(lifecycle)) {
    creatorStage = 'WAITING_PRODUCTION';
    detail = '生产物料已经按精确调用包获授权，等待执行或登记运行。';
  } else if (lifecycle === 'READY_TO_START') {
    creatorStage = 'PRODUCTION_READY';
    detail = 'Prompt、依赖素材与执行定义已就绪，尚未获得本轮生产授权。';
  } else if (lifecycle === 'REVIEW_PENDING') {
    creatorStage = 'PENDING_REVIEW';
    detail = '文件与 SHA-256 已登记，等待创作者正式审阅。';
  } else if (['RELEASED', 'SATISFIED_BY_EXISTING'].includes(lifecycle)) {
    creatorStage = 'APPROVED';
    detail = '当前版本已经通过并采用；是否可在项目内部下传仍以权利与下游资格投影为准。';
  } else if (['WAITING_UPSTREAM', 'REVISION_REQUIRED', 'DO_NOT_USE'].includes(lifecycle)) {
    creatorStage = 'INITIAL';
    detail = lifecycle === 'REVISION_REQUIRED'
      ? '旧版本保留为需返修历史；下一版回到初始状态，按审阅意见重新准备生产物料。'
      : lifecycle === 'DO_NOT_USE'
        ? '旧版本保留为禁止使用历史；如仍需该素材，下一版从初始状态重新准备。'
        : '需求已经登记，但生产物料或上游依赖尚未就绪。';
  } else if (['BLOCKED', 'RIGHTS_HOLD', 'EXECUTION_FAILED', 'RESULT_UNKNOWN'].includes(lifecycle)) {
    creatorStage = 'BLOCKED';
    detail = blockerExplanation.reasons.length
      ? blockerExplanation.reasons.join('；')
      : lifecycle === 'RESULT_UNKNOWN'
        ? '执行结果不明，必须先核查 REQUEST_ID／LOG_ID，禁止自动重试。'
        : '存在异常或硬门禁，解决后才能继续推进。';
  }

  const blocked = creatorStage === 'BLOCKED';
  if (creatorStage === 'IN_PRODUCTION' || creatorStage === 'WAITING_PRODUCTION') creatorStage = 'PRODUCTION_READY';
  if (blocked) creatorStage = 'INITIAL';
  if (creatorStage === 'APPROVED' && (coverageSatisfied === false || bindingStale)) {
    creatorStage = 'INITIAL'; detail = '已有审阅记录，但当前需求或精确输入尚不满足下游使用条件。';
  }
  return {
    creatorStage,
    executionBlocked: blocked,
    creatorStageLabel: creatorStageLabels[creatorStage],
    creatorStageDetail: detail,
    creatorStageShortReason: blocked ? blockerExplanation.shortReason : '',
    creatorStageReasonCodes: blocked ? reasonCodes : [],
    creatorStageReasons: blocked ? blockerExplanation.reasons : [],
    creatorStageNextStep: blocked ? blockerExplanation.nextStep : '',
    sourceLifecycleState: lifecycle,
    executionRequestState: request,
  };
}

const legacyBusinessCategory: Record<string, { primary: string; secondary: string }> = {
  人物身份: { primary: '人物', secondary: '人物身份' },
  人物信息卡: { primary: '人物', secondary: '人物信息卡' },
  群演身份: { primary: '人物', secondary: '群演身份' },
  地点空态: { primary: '场景', secondary: '地点空态' },
  地点状态: { primary: '场景', secondary: '地点状态' },
  关键道具: { primary: '道具', secondary: '关键道具' },
  道具状态: { primary: '道具', secondary: '道具状态' },
  宗教陈设: { primary: '道具', secondary: '宗教陈设' },
  尸身状态: { primary: '人物', secondary: '尸身状态' },
  首级代理: { primary: '人物', secondary: '首级代理' },
  动作拟音: { primary: '拟音', secondary: '动作拟音' },
  原创配乐: { primary: '配乐', secondary: '原创配乐' },
  声音身份: { primary: '配音', secondary: '声音身份' },
  声音母版: { primary: '配音', secondary: '声音母版' },
  环境底声: { primary: '环境声', secondary: '环境底声' },
  风格锚点: { primary: '风格与参考', secondary: '风格锚点' },
};

export type ClassifiedMaterial = {
  mediaType: MaterialMediaType;
  businessCategoryPrimaryId: string;
  businessCategorySecondaryId: string;
  presentation?: {icon:string;tone:string;primaryOrder:number;secondaryOrder:number};
  businessCategoryPrimary: string;
  businessCategorySecondary: string;
  classificationHash: string;
  currentShotIds: string[];
  historicalShotIds: string[];
  currentShotRelationState: string;
};

export function classifiedMaterial(
  requirement: Record<string, unknown> & { category?: string; mediaKind?: string; shotIds?: string[] },
): ClassifiedMaterial {
  const fallback = legacyBusinessCategory[String(requirement.category || '')] || {
    primary: 'UNKNOWN',
    secondary: String(requirement.category || 'UNKNOWN'),
  };
  const mediaType = String(
    requirement.mediaType || (['IMAGE','AUDIO','VIDEO','TEXT'].includes(String(requirement.mediaKind))?requirement.mediaKind:'UNKNOWN'),
  ) as MaterialMediaType;
  return {
    mediaType: materialMediaTypeOptions.some((item) => item.id === mediaType) ? mediaType : 'UNKNOWN',
    businessCategoryPrimaryId: String(requirement.businessCategoryPrimaryId||requirement.businessCategoryPrimary||fallback.primary),
    businessCategorySecondaryId: String(requirement.businessCategorySecondaryId||requirement.businessCategorySecondary||fallback.secondary),
    presentation: requirement.classificationPresentation as ClassifiedMaterial['presentation'],
    businessCategoryPrimary: String(requirement.businessCategoryPrimary || fallback.primary),
    businessCategorySecondary: String(requirement.businessCategorySecondary || fallback.secondary),
    classificationHash: String(requirement.classificationHash || ''),
    currentShotIds: Array.isArray(requirement.currentShotIds)
      ? requirement.currentShotIds.map(String)
      : [],
    historicalShotIds: Array.isArray(requirement.historicalShotIds)
      ? requirement.historicalShotIds.map(String)
      : (requirement.shotIds || []).map(String),
    currentShotRelationState: String(requirement.currentShotRelationState || 'UNKNOWN'),
  };
}
