'use client';

import {
  impactLabel,
  type ActionItem,
  type ActionOwnerModule,
  type ActorGroup,
  type ProgressCapability,
  type WorkState,
  type WorkType,
} from './action-queue-contract';

export type CurrentWorkArea = 'ALL' | 'STORY' | 'MATERIALS' | 'PRODUCTION' | 'EXCEPTION';
export type CurrentWorkActor = 'ALL' | 'HUMAN' | 'AI' | 'BOTH' | 'AUTOMATION';
export type CurrentWorkStateFilter = 'NOW' | WorkState | 'ALL';
export type CurrentWorkTypeFilter = WorkType | 'ALL';
export type CurrentWorkViewState = {
  area: CurrentWorkArea;
  actor: CurrentWorkActor;
  state: CurrentWorkStateFilter;
  type: CurrentWorkTypeFilter;
  stage?: string;
};

export const defaultCurrentWorkView: CurrentWorkViewState = { area: 'ALL', actor: 'ALL', state: 'NOW', type: 'ALL' };

const ownerMeta: Record<Exclude<ActionOwnerModule, 'SYSTEM'>, { area: CurrentWorkArea; label: string; eyebrow: string }> = {
  STORY_CREATION: { area: 'STORY', label: '故事 → 剧本', eyebrow: 'STORY TO SCREENPLAY' },
  WORLD_AND_MATERIALS: { area: 'MATERIALS', label: '剧本 → 素材', eyebrow: 'SCREENPLAY TO MATERIALS' },
  FULL_PRODUCTION: { area: 'PRODUCTION', label: '剧本 + 素材 → 全剧制作', eyebrow: 'FULL PRODUCTION' },
};

const workTypeLabels: Record<WorkType, string> = {
  AUTHORING: '内容准备',
  FORMAL_REVIEW: '正式审阅',
  AUTHORIZATION: '生成授权',
  EXECUTION: '制作执行',
  RESULT_REGISTRATION: '结果登记',
  SOURCE_SYNC: '受控同步',
  ISSUE_RESOLUTION: '问题处理',
};

const workStateLabels: Record<WorkState, string> = {
  READY: '可立即开展',
  IN_PROGRESS: '进行中',
  WAITING: '等待依赖',
  BLOCKED: '阻断',
};

function canAdvance(item: ActionItem, actorGroup: ActorGroup) {
  return item.progressCapabilities.some((capability) => (
    capability.actorGroup === actorGroup
    && capability.level === 'ADVANCE'
    && capability.availability === 'NOW'
  ));
}

function isException(item: ActionItem) {
  return item.ownerModule === 'SYSTEM' || item.workState === 'BLOCKED' || item.workType === 'ISSUE_RESOLUTION';
}

export function matchesCurrentWorkFilters(item: ActionItem, filters: CurrentWorkViewState) {
  const areaMatches = filters.area === 'ALL'
    || (filters.area === 'EXCEPTION' && isException(item))
    || ownerMeta[item.ownerModule as Exclude<ActionOwnerModule, 'SYSTEM'>]?.area === filters.area;
  const human = canAdvance(item, 'HUMAN');
  const ai = canAdvance(item, 'AI');
  const actorMatches = filters.actor === 'ALL'
    || (filters.actor === 'HUMAN' && human)
    || (filters.actor === 'AI' && ai)
    || (filters.actor === 'BOTH' && human && ai)
    || (filters.actor === 'AUTOMATION' && canAdvance(item, 'AUTOMATION'));
  const stateMatches = filters.state === 'ALL'
    || (filters.state === 'NOW' && ['READY', 'IN_PROGRESS'].includes(item.workState))
    || item.workState === filters.state;
  return areaMatches && actorMatches && stateMatches && (filters.type === 'ALL' || item.workType === filters.type);
}

export function collapseWorkUnits(items: ActionItem[]) {
  const stateRank: Record<WorkState, number> = { IN_PROGRESS: 0, READY: 1, BLOCKED: 2, WAITING: 3 };
  const groups = new Map<string, ActionItem[]>();
  for (const item of items) groups.set(item.workUnitKey, [...(groups.get(item.workUnitKey) || []), item]);
  return [...groups.values()].map((entries) => {
    const representative = entries.reduce((current, candidate) => (
      stateRank[candidate.workState] < stateRank[current.workState] ? candidate : current
    ));
    const currentEntries = entries.filter((entry) => entry.workState === representative.workState);
    const capabilities = new Map<string, ProgressCapability>();
    for (const entry of currentEntries) {
      for (const capability of entry.progressCapabilities) {
        capabilities.set([
          capability.actorGroup,
          capability.actorKind,
          capability.level,
          capability.availability,
          capability.actionType,
        ].join(':'), capability);
      }
    }
    const assignees = new Map<string, NonNullable<ActionItem['currentAssignee']>>();
    for (const entry of currentEntries) {
      if (!entry.currentAssignee) continue;
      assignees.set([
        entry.currentAssignee.source,
        entry.currentAssignee.evidenceId,
        entry.currentAssignee.evidenceState,
        entry.currentAssignee.actorKind,
      ].join(':'), entry.currentAssignee);
    }
    return {
      ...representative,
      sourceActionKeys: [...new Set(entries.flatMap((entry) => [entry.actionKey, ...entry.sourceActionKeys]))],
      progressCapabilities: [...capabilities.values()],
      currentAssignee: assignees.size === 1 ? [...assignees.values()][0] : null,
    };
  });
}

function capabilityBadges(capabilities: ProgressCapability[]) {
  const now = capabilities.filter((capability) => capability.availability === 'NOW');
  const human = now.some((capability) => capability.actorGroup === 'HUMAN' && capability.level === 'ADVANCE');
  const ai = now.some((capability) => capability.actorGroup === 'AI' && capability.level === 'ADVANCE');
  const automation = now.some((capability) => capability.actorGroup === 'AUTOMATION' && capability.level === 'ADVANCE');
  const aiAssist = now.some((capability) => capability.actorGroup === 'AI' && capability.level === 'ASSIST');
  const future = capabilities.filter((capability) => capability.level === 'ADVANCE' && capability.availability === 'AFTER_AUTHORIZATION');
  return <div className="current-work-capabilities" aria-label="可推进主体">
    {human && <span className="is-human">人可推进</span>}
    {ai && <span className="is-ai">AI可推进</span>}
    {automation && <span className="is-automation">自动化执行</span>}
    {aiAssist && <span className="is-assist">AI可辅助</span>}
    {future.some((capability) => capability.actorGroup === 'AI') && <span className="is-future">授权后AI执行</span>}
    {future.some((capability) => capability.actorGroup === 'HUMAN') && <span className="is-future">授权后人工执行</span>}
  </div>;
}

function assigneeLabel(item: ActionItem) {
  if (!item.currentAssignee) return '';
  if (item.currentAssignee.claimedBy) return item.currentAssignee.claimedBy;
  return item.currentAssignee.actorKind === 'USER_EXTERNAL'
    ? '外部人工执行者'
    : item.currentAssignee.actorKind === 'CODEX' ? 'Codex' : item.currentAssignee.actorKind === 'HOST_WORKER' ? '本地主机工作器' : '审阅者';
}

export function WorkCard({ item, isMainline = false }: { item: ActionItem; isMainline?: boolean }) {
  const coordinates = [item.coordinates?.episodeId, item.coordinates?.sceneId, item.coordinates?.shotId].filter(Boolean).join(' / ');
  return <article
    className={`current-work-card is-${item.workState.toLowerCase()}`}
    data-action-key={item.actionKey}
    data-work-unit={item.workUnitKey}
    data-work-state={item.workState}
    data-work-type={item.workType}
    data-owner-module={item.ownerModule || 'SYSTEM'}
    data-capability-human={canAdvance(item, 'HUMAN') ? 'true' : 'false'}
    data-capability-ai={canAdvance(item, 'AI') ? 'true' : 'false'}
    data-current-mainline={isMainline ? 'true' : 'false'}
  >
    <header>
      <div><span>{isMainline ? `当前主线 · ${workTypeLabels[item.workType]}` : workTypeLabels[item.workType]}</span><b>{item.title}</b></div>
      <em>{workStateLabels[item.workState]}</em>
    </header>
    {capabilityBadges(item.progressCapabilities)}
    {item.currentAssignee && <p className="current-work-assignee"><b>当前已指派</b>{assigneeLabel(item)}</p>}
    <dl>
      <div><dt>为什么现在</dt><dd>{item.reasonText}</dd></div>
      <div><dt>完成后解锁</dt><dd>{impactLabel(item.impactSummary) || item.unlockText}</dd></div>
    </dl>
    <details><summary>查看工作依据与下一步</summary><dl>
      <div><dt>下一步</dt><dd>{item.nextActionText}</dd></div>
      <div><dt>工作坐标</dt><dd>{coordinates || item.subjectId}</dd></div>
      <div><dt>证据行动</dt><dd>{item.sourceActionKeys.length}条当前行动投影</dd></div>
    </dl></details>
    <footer><small>{coordinates || item.subjectId}</small><a href={item.navigationIntent.href}>{item.navigationIntent.label}</a></footer>
  </article>;
}
