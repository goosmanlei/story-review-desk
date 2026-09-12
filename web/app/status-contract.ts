export type StatusTone = 'good' | 'waiting' | 'danger' | 'neutral';

export type LifecycleState =
  | 'WAITING_UPSTREAM'
  | 'READY_TO_START'
  | 'IN_PROGRESS'
  | 'EXECUTION_FAILED'
  | 'RESULT_PENDING_REGISTRATION'
  | 'RESULT_UNKNOWN'
  | 'BLOCKED'
  | 'REVIEW_PENDING'
  | 'RELEASED'
  | 'REVISION_REQUIRED'
  | 'DO_NOT_USE'
  | 'RIGHTS_HOLD'
  | 'NOT_APPLICABLE'
  | 'SATISFIED_BY_EXISTING'
  | 'EVIDENCE_ONLY'
  | 'DELETED_AUDIT'
  | 'UNKNOWN';

export type StatusRecord = {
  lifecycleState?: string | null;
  outputState?: string | null;
  reviewDecision?: string | null;
  projectRightsGate?: string | null;
  historyRole?: string | null;
  applicabilityState?: string | null;
  upstreamReadiness?: string | null;
  latestRun?: { state?: string | null; recordedAt?: string | null; source?: string | null } | string | null;
  preflight?: { status?: string | null; role?: string | null; sourceRef?: string | null } | string | null;
  canFlowDownstream?: boolean | null;
  flowBlockReasons?: string[] | null;
  legacyState?: Record<string, unknown> | null;
};

export type LifecycleDefinition = {
  label: string;
  meaning: string;
  tone: StatusTone;
  phase: 'before-output' | 'review' | 'terminal' | 'exception';
};

const state = (
  label: string,
  meaning: string,
  tone: StatusTone,
  phase: LifecycleDefinition['phase'],
): LifecycleDefinition => ({ label, meaning, tone, phase });

export const lifecycleDefinitions: Record<LifecycleState, LifecycleDefinition> = {
  WAITING_UPSTREAM: state('等待上游', '尚未产出；直接依赖或锁定条件尚未满足。', 'waiting', 'before-output'),
  READY_TO_START: state('可开始制作', '尚未产出；所需上游已经就绪。', 'neutral', 'before-output'),
  IN_PROGRESS: state('制作中', '生产运行已启动，尚未登记可审阅文件。', 'waiting', 'before-output'),
  EXECUTION_FAILED: state('制作失败', '最近一次运行失败，需要处理失败原因后再试。', 'danger', 'exception'),
  RESULT_PENDING_REGISTRATION: state('结果待登记', '运行已成功，但文件与 SHA-256 尚未完成登记。', 'waiting', 'exception'),
  RESULT_UNKNOWN: state('执行结果不明', '请求结果没有可靠回执，需先核查再决定是否重试。', 'danger', 'exception'),
  BLOCKED: state('当前阻断', '存在明确硬门禁，当前不得继续。', 'danger', 'exception'),
  REVIEW_PENDING: state('待审阅', '文件与 SHA-256 已登记，等待一次正式审阅。', 'waiting', 'review'),
  RELEASED: state('通过并放行', '该版本已被采用，并自动允许进入项目内部下游。', 'good', 'terminal'),
  REVISION_REQUIRED: state('需要返修', '当前版本保留历史，新版本完成后重新审阅。', 'danger', 'terminal'),
  DO_NOT_USE: state('禁止使用', '该版本明确禁用，仅保留审计记录。', 'danger', 'terminal'),
  RIGHTS_HOLD: state('权利阻断', '权利存在不可豁免问题，不能项目内放行。', 'danger', 'exception'),
  NOT_APPLICABLE: state('本项不适用', '当前业务分支不需要该工作项。', 'neutral', 'terminal'),
  SATISFIED_BY_EXISTING: state('既有资产满足', '需求已由既有有效资产满足，无需重复制作。', 'good', 'terminal'),
  EVIDENCE_ONLY: state('仅历史证据', '可追溯查看，但不能作为当前下游输入。', 'neutral', 'terminal'),
  DELETED_AUDIT: state('已删除留痕', '原文件已删除，只保留不可变审计信息。', 'neutral', 'terminal'),
  UNKNOWN: state('信息待确认', '现有证据不足，保持 UNKNOWN，不作推断。', 'waiting', 'exception'),
};

export const lifecycleOrder = Object.keys(lifecycleDefinitions) as LifecycleState[];

function knownLifecycle(value: unknown): LifecycleState | null {
  return typeof value === 'string' && value in lifecycleDefinitions ? value as LifecycleState : null;
}

function runState(record: StatusRecord) {
  return typeof record.latestRun === 'string' ? record.latestRun : record.latestRun?.state || '';
}

/** Canonical records carry lifecycleState. The fallback only reads archived V8.0 facts. */
export function deriveLifecycleState(record: StatusRecord): LifecycleState {
  const explicit = knownLifecycle(record.lifecycleState);
  if (explicit) return explicit;

  const legacy = record.legacyState || {};
  const output = record.outputState || String(legacy.materializationState || '');
  const decision = record.reviewDecision || String(legacy.approvalStatus || '');
  const rights = record.projectRightsGate || String(legacy.rightsStatus || '');
  const history = record.historyRole || String(legacy.historyStatus || '');
  const applicability = record.applicabilityState || String(legacy.applicabilityState || '');
  const execution = runState(record) || String(legacy.executionState || '');
  const readiness = record.upstreamReadiness || String(legacy.gateStatus || '');

  if (applicability === 'NOT_REQUIRED' || output === 'NOT_APPLICABLE') return 'NOT_APPLICABLE';
  if (applicability === 'SATISFIED_BY_EXISTING') return 'SATISFIED_BY_EXISTING';
  if (history === 'DELETED_AUDIT' || output === 'DELETED') return 'DELETED_AUDIT';
  if (history === 'EVIDENCE_ONLY' || output === 'EVIDENCE_ONLY') return 'EVIDENCE_ONLY';
  if (decision === 'DO_NOT_USE') return 'DO_NOT_USE';
  if (decision === 'REVISION_REQUIRED' || decision === 'REJECTED') return 'REVISION_REQUIRED';
  if (rights === 'BLOCKED') return 'RIGHTS_HOLD';
  if (decision === 'RELEASED' || decision === 'APPROVED') {
    return ['CLEAR', 'CLEAR_BY_USER_ATTESTATION', 'NOT_APPLICABLE', 'APPROVED'].includes(rights)
      ? 'RELEASED'
      : 'RIGHTS_HOLD';
  }
  if (output === 'PRESENT' || output === 'GENERATED') return 'REVIEW_PENDING';
  if (execution === 'RUNNING' || execution === 'SUBMITTED' || execution === 'IN_PROGRESS') return 'IN_PROGRESS';
  if (execution === 'FAILED') return 'EXECUTION_FAILED';
  if (execution === 'RESULT_UNKNOWN') return 'RESULT_UNKNOWN';
  if (execution === 'SUCCEEDED' || execution === 'COMPLETE') return 'RESULT_PENDING_REGISTRATION';
  if (/BLOCK/.test(readiness)) return 'BLOCKED';
  if (readiness === 'READY') return 'READY_TO_START';
  if (readiness === 'WAITING' || /WAIT|HOLD/.test(readiness)) return 'WAITING_UPSTREAM';
  return 'UNKNOWN';
}

export function lifecycleDefinition(recordOrState: StatusRecord | string): LifecycleDefinition & { code: LifecycleState } {
  const code = typeof recordOrState === 'string'
    ? knownLifecycle(recordOrState) || 'UNKNOWN'
    : deriveLifecycleState(recordOrState);
  return { code, ...lifecycleDefinitions[code] };
}

export function lifecycleTone(recordOrState: StatusRecord | string): StatusTone {
  return lifecycleDefinition(recordOrState).tone;
}

export function isOutputPresent(record: StatusRecord) {
  return record.outputState === 'PRESENT' || record.outputState === 'EVIDENCE_ONLY';
}

export function rightsWarning(record: StatusRecord) {
  if (record.projectRightsGate === 'BLOCKED') {
    return { tone: 'danger' as const, label: '权利不可放行', meaning: '存在不可豁免的权利问题。' };
  }
  if (record.projectRightsGate === 'UNKNOWN') {
    return {
      tone: 'waiting' as const,
      label: '权利事实仍为 UNKNOWN',
      meaning: record.reviewDecision === 'RELEASED'
        ? '已确认仅限本项目内部生产；商业发行继续阻断。'
        : '通过时需在同一次审阅中确认仅限本项目内部生产。',
    };
  }
  if (record.projectRightsGate === 'CLEAR_BY_USER_ATTESTATION') {
    return { tone: 'waiting' as const, label: '仅限项目内部', meaning: '依据同次确认放行；商业发行权利仍未核验。' };
  }
  return null;
}
