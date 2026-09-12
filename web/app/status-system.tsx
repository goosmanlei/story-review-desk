'use client';

import { visibleText } from './review-semantics';
import {
  deriveLifecycleState,
  lifecycleDefinition,
  lifecycleDefinitions,
  rightsWarning,
  type LifecycleState,
  type StatusRecord as ContractStatusRecord,
  type StatusTone,
} from './status-contract';

export type { LifecycleState, StatusTone } from './status-contract';

// Archived V8 callers still pass the former top-level axes. Keeping them
// optional here preserves read compatibility without letting them override a
// canonical lifecycleState.
export type StatusRecord = ContractStatusRecord & {
  definitionStatus?: string | null;
  inventoryState?: string | null;
  materializationState?: string | null;
  executionState?: string | null;
  qaStatus?: string | null;
  manualQaStatus?: string | null;
  approvalStatus?: string | null;
  approvalState?: string | null;
  rightsStatus?: string | null;
  downstreamEligibility?: string | null;
  historyStatus?: string | null;
  gateStatus?: string | null;
};

// Type-only compatibility for existing call sites. Model 2.0 never renders
// these fields as parallel user-facing states.
export type StatusAxisId =
  | 'definition'
  | 'applicability'
  | 'materialization'
  | 'execution'
  | 'qa'
  | 'approval'
  | 'rights'
  | 'downstream'
  | 'history'
  | 'output'
  | 'review'
  | 'readiness'
  | 'run'
  | 'preflight';

export const statusAxisDefinitions = {
  output: { label: '文件事实', field: 'outputState' },
  review: { label: '审阅结论', field: 'reviewDecision' },
  rights: { label: '项目权利门禁', field: 'projectRightsGate' },
  history: { label: '版本角色', field: 'historyRole' },
  readiness: { label: '上游准备度', field: 'upstreamReadiness' },
  run: { label: '最近运行', field: 'latestRun' },
  preflight: { label: '预检证据', field: 'preflight' },
} as const;

export const stateLayers = [{ id: 'lifecycle', label: '唯一生命周期', states: Object.keys(lifecycleDefinitions) as LifecycleState[] }];

export function statusToneFromRecord(record: StatusRecord): StatusTone {
  return deriveHeadlineState(record).tone;
}

export function deriveHeadlineState(record: StatusRecord) {
  if (record.lifecycleState) {
    const definition = lifecycleDefinitions[record.lifecycleState as LifecycleState];
    if (definition) return { code: record.lifecycleState, ...definition };
    const readableCode = visibleText(record.lifecycleState) || '信息待确认';
    return {
      code: readableCode,
      label: readableCode,
      meaning: '该生命周期状态尚未收录；保持待确认，不自动放行。',
      tone: 'waiting' as const,
      phase: 'exception' as const,
    };
  }
  return lifecycleDefinition(record);
}

type SupportingFact = {
  code?: string;
  label: string;
  meaning: string;
  tone: StatusTone;
  value: string;
};

type FactDefinition = Omit<SupportingFact, 'code' | 'label'>;

const outputDefinitions: Record<string, FactDefinition> = {
  NOT_PRODUCED: { value: '尚无产出', meaning: '尚无已登记的文件与 SHA-256。', tone: 'waiting' },
  PRESENT: { value: '已登记', meaning: '文件与 SHA-256 已登记，可作为本次审阅对象。', tone: 'good' },
  EVIDENCE_ONLY: { value: '仅历史证据', meaning: '可追溯，不可作为当前下游输入。', tone: 'neutral' },
  DELETED: { value: '文件已删除', meaning: '只保留不可变审计记录。', tone: 'neutral' },
  NOT_APPLICABLE: { value: '本项不适用', meaning: '当前业务分支不需要该产出。', tone: 'neutral' },
};

const reviewDefinitions: Record<string, FactDefinition> = {
  PENDING: { value: '待正式审阅', meaning: '尚未形成正式裁决。', tone: 'waiting' },
  RELEASED: { value: '通过并放行', meaning: '已同时完成质量裁决、版本采用和项目内下游放行。', tone: 'good' },
  REVISION_REQUIRED: { value: '需要返修', meaning: '保留当前版本，创建新版本后重新审阅。', tone: 'danger' },
  DO_NOT_USE: { value: '禁止使用', meaning: '当前版本不得进入下游，只保留审计。', tone: 'danger' },
  NOT_APPLICABLE: { value: '本项不适用', meaning: '当前对象不需要正式审阅。', tone: 'neutral' },
};

const rightsDefinitions: Record<string, FactDefinition> = {
  CLEAR: { value: '项目内已满足', meaning: '现有证据允许进入本项目内部下游。', tone: 'good' },
  CLEAR_BY_USER_ATTESTATION: { value: '用户已确认项目内使用', meaning: '仅表示项目内放行，不等于已完成商业发行权利核验。', tone: 'waiting' },
  UNKNOWN: { value: '项目内权利待确认', meaning: '证据不足，不作自动放行。', tone: 'waiting' },
  BLOCKED: { value: '项目内权利阻断', meaning: '存在不可豁免的权利问题。', tone: 'danger' },
  NOT_APPLICABLE: { value: '本项不适用', meaning: '当前对象无独立权利门禁。', tone: 'neutral' },
};

const historyDefinitions: Record<string, FactDefinition> = {
  CURRENT: { value: '当前版本', meaning: '当前采用的版本。', tone: 'good' },
  CANDIDATE: { value: '候选版本', meaning: '尚未取代当前版本。', tone: 'waiting' },
  SUPERSEDED: { value: '已被新版取代', meaning: '只供追溯，不再作为当前输入。', tone: 'neutral' },
  EVIDENCE_ONLY: { value: '仅历史证据', meaning: '只供追溯，不可下传。', tone: 'neutral' },
  DELETED_AUDIT: { value: '已删除留痕', meaning: '文件已删除，只保留审计记录。', tone: 'neutral' },
  PLANNED: { value: '尚未形成版本', meaning: '只存在计划或定义，尚无可审阅版本。', tone: 'waiting' },
};

const readinessDefinitions: Record<string, FactDefinition> = {
  READY: { value: '上游已就绪', meaning: '可以开始制作。', tone: 'good' },
  WAITING: { value: '等待上游', meaning: '直接依赖尚未放行。', tone: 'waiting' },
  BLOCKED: { value: '上游阻断', meaning: '存在明确硬门禁。', tone: 'danger' },
};

const runDefinitions: Record<string, FactDefinition> = {
  PLANNED: { value: '尚未提交', meaning: '尚无实际制作运行。', tone: 'neutral' },
  SUBMITTED: { value: '已提交', meaning: '制作请求已提交。', tone: 'waiting' },
  RUNNING: { value: '执行中', meaning: '最近一次制作运行尚未结束。', tone: 'waiting' },
  SUCCEEDED: { value: '执行成功', meaning: '运行已成功，仍需核对文件与 SHA-256 登记。', tone: 'good' },
  FAILED: { value: '执行失败', meaning: '需先处理失败原因。', tone: 'danger' },
  CANCELLED: { value: '已取消', meaning: '该次运行未产生可登记结果。', tone: 'neutral' },
  RESULT_UNKNOWN: { value: '结果不明', meaning: '需先核查请求证据，禁止盲目重试。', tone: 'danger' },
};

const preflightDefinitions: Record<string, FactDefinition> = {
  PASS: { value: '预检通过', meaning: '仅作为本次审阅的证据，不是第二次审批。', tone: 'good' },
  FAIL: { value: '预检发现问题', meaning: '仅作为本次审阅的证据，不是独立裁决。', tone: 'danger' },
  REJECTED: { value: '预检发现问题', meaning: '仅作为本次审阅的证据，不是独立裁决。', tone: 'danger' },
  NOT_RUN: { value: '尚未预检', meaning: '没有预检证据；不引入额外审批。', tone: 'waiting' },
  TODO: { value: '尚未预检', meaning: '没有预检证据；不引入额外审批。', tone: 'waiting' },
  UNKNOWN: { value: '预检证据待确认', meaning: '保持未知，不把预检当作审批结论。', tone: 'waiting' },
  NOT_APPLICABLE: { value: '预检不适用', meaning: '本项无独立预检要求。', tone: 'neutral' },
};

const flowReasonDefinitions: Record<string, string> = {
  DO_NOT_USE: '当前版本禁止使用',
  FILE_DELETED: '文件已删除',
  HISTORY_EVIDENCE_ONLY: '当前仅作历史证据',
  HISTORY_ROLE_DELETED_AUDIT: '已删除，只保留审计留痕',
  HISTORY_ROLE_EVIDENCE_ONLY: '版本仅作历史证据',
  OUTPUT_NOT_PRESENT: '尚无已登记的文件与 SHA-256',
  REVIEW_PENDING: '等待正式审阅',
  RIGHTS_CONFIRMATION_REQUIRED_IN_REVIEW: '项目内权利需在本次审阅中确认',
};

function supportingFact(label: string, raw: string | null | undefined, definitions: Record<string, FactDefinition>): SupportingFact | null {
  if (!raw) return null;
  const definition = definitions[raw];
  if (definition) return { code: raw, label, ...definition };
  const readableCode = visibleText(raw) || '信息待确认';
  return {
    code: readableCode,
    label,
    value: readableCode,
    meaning: '该状态尚未收录；保持待确认，不作自动放行。',
    tone: 'waiting',
  };
}

function latestRunState(record: StatusRecord) {
  if (!record.latestRun) return null;
  return typeof record.latestRun === 'string' ? record.latestRun : record.latestRun.state || 'UNKNOWN';
}

function preflightState(record: StatusRecord) {
  if (!record.preflight) return null;
  return typeof record.preflight === 'string' ? record.preflight : record.preflight.status || 'UNKNOWN';
}

function hasNoOutput(record: StatusRecord) {
  if (record.outputState) return record.outputState === 'NOT_PRODUCED';
  return new Set([
    'WAITING_UPSTREAM',
    'READY_TO_START',
    'IN_PROGRESS',
    'EXECUTION_FAILED',
    'RESULT_PENDING_REGISTRATION',
    'RESULT_UNKNOWN',
    'BLOCKED',
  ]).has(record.lifecycleState || '');
}

function lifecycleFacts(record: StatusRecord) {
  const facts = [
    supportingFact('产出', record.outputState, outputDefinitions),
    supportingFact('审阅结论', record.reviewDecision, reviewDefinitions),
    supportingFact('项目内权利', record.projectRightsGate, rightsDefinitions),
    supportingFact('版本角色', record.historyRole, historyDefinitions),
  ];
  if (typeof record.canFlowDownstream === 'boolean') {
    facts.push({
      code: record.canFlowDownstream ? 'YES' : 'NO',
      label: '是否可下传',
      value: record.canFlowDownstream ? '可以进入下游' : '当前不可下传',
      meaning: record.canFlowDownstream ? '系统已解锁项目内下游。' : '具体原因见阻断原因。',
      tone: record.canFlowDownstream ? 'good' : 'waiting',
    });
  }
  if (hasNoOutput(record)) {
    facts.push(supportingFact('上游准备度', record.upstreamReadiness, readinessDefinitions));
    facts.push(supportingFact('最近一次制作运行', latestRunState(record), runDefinitions));
  }
  facts.push(supportingFact('预检证据（不是第二次审批）', preflightState(record), preflightDefinitions));
  return facts.filter((fact): fact is SupportingFact => Boolean(fact));
}

function technicalFacts(record: StatusRecord) {
  const facts: Array<{ label: string; value: string }> = [];
  if (record.outputState) facts.push({ label: '文件事实', value: record.outputState });
  if (record.reviewDecision) facts.push({ label: '审阅结论', value: record.reviewDecision });
  if (record.projectRightsGate) facts.push({ label: '项目权利门禁', value: record.projectRightsGate });
  if (record.historyRole) facts.push({ label: '版本角色', value: record.historyRole });
  if (record.upstreamReadiness) facts.push({ label: '上游准备度', value: record.upstreamReadiness });
  if (record.latestRun) {
    const value = typeof record.latestRun === 'string' ? record.latestRun : record.latestRun.state || 'UNKNOWN';
    facts.push({ label: '最近运行', value });
  }
  if (record.preflight) {
    const value = typeof record.preflight === 'string' ? record.preflight : record.preflight.status || 'UNKNOWN';
    facts.push({ label: '预检证据', value });
  }
  if (typeof record.canFlowDownstream === 'boolean') {
    facts.push({ label: '系统派生下传', value: record.canFlowDownstream ? 'YES' : 'NO' });
  }
  return facts;
}

export function StatusHeadline({ record, compact = false }: { record: StatusRecord; compact?: boolean }) {
  const headline = deriveHeadlineState(record);
  return <span className={`unified-status-headline tone-${headline.tone}${compact ? ' compact' : ''}`} title={headline.meaning}>
    <b>{headline.label}</b>{!compact && <small>{headline.meaning}</small>}
  </span>;
}

export function UnifiedStatusPanel({
  record,
  compact = false,
  showCodes = false,
  showGateReason = true,
}: {
  record: StatusRecord;
  axes?: StatusAxisId[];
  compact?: boolean;
  showCodes?: boolean;
  showGateReason?: boolean;
}) {
  if (record.lifecycleState) {
    const warning = rightsWarning(record);
    const facts = lifecycleFacts(record);
    const blockReasons = (record.flowBlockReasons || []).map((reason) => flowReasonDefinitions[reason] || visibleText(reason));
    if (compact) {
      return <div className="unified-status-panel compact">
        <StatusHeadline record={record} compact />
        {warning && <span className={`unified-status-exception tone-${warning.tone}`} title={warning.meaning}>{warning.label}</span>}
      </div>;
    }

    return <section className="unified-status-panel" aria-label="统一生命周期状态">
      <header><span>当前生命周期</span><StatusHeadline record={record} /></header>
      {warning && <aside className={`unified-status-exception tone-${warning.tone}`}><b>{warning.label}</b><span>{warning.meaning}</span></aside>}
      {facts.length > 0 && <div className="unified-status-layers">
        <article style={{ gridColumn: '1 / -1' }}>
          <header><b>支撑事实</b><small>用于解释当前生命周期，不构成额外审批。</small></header>
          <div>{facts.map((fact) => <span className={`unified-status-token tone-${fact.tone}`} key={fact.label} title={fact.meaning}>
            <b>{fact.label}</b><i>{fact.value}</i>{showCodes && fact.code && <code>{visibleText(fact.code)}</code>}
          </span>)}</div>
        </article>
      </div>}
      {showGateReason && record.canFlowDownstream === false && <footer>
        <b>当前不可下传</b>
        <span>{blockReasons.length ? blockReasons.join('；') : '具体阻断原因尚未登记。'}</span>
      </footer>}
    </section>;
  }

  const warning = rightsWarning(record);
  const facts = technicalFacts(record);
  if (compact) {
    return <div className="unified-status-panel compact">
      <StatusHeadline record={record} compact />
      {warning && <span className={`unified-status-exception tone-${warning.tone}`} title={warning.meaning}>{warning.label}</span>}
    </div>;
  }

  return <section className="unified-status-panel" aria-label="统一生命周期状态">
    <header><span>当前状态</span><StatusHeadline record={record} /></header>
    {warning && <aside className={`unified-status-exception tone-${warning.tone}`}><b>{warning.label}</b><span>{warning.meaning}</span></aside>}
    {showGateReason && Boolean(record.flowBlockReasons?.length) && <footer>
      <b>当前未解锁原因</b>
      <span>{record.flowBlockReasons!.map((reason) => visibleText(reason)).join('；')}</span>
    </footer>}
    {facts.length > 0 && <details className="unified-status-technical">
      <summary>技术状态与证据</summary>
      <div>{facts.map((fact) => <span className="unified-status-token" key={fact.label}>
        <b>{fact.label}</b><i>{visibleText(fact.value)}</i>{showCodes && <code>{visibleText(fact.value)}</code>}
      </span>)}</div>
      <p>这些字段用于解释与审计；它们不构成额外审批步骤。当前生命周期由 <code>{deriveLifecycleState(record)}</code> 派生。</p>
    </details>}
  </section>;
}
