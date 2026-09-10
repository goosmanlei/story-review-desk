'use client';


import {runtimePath} from './runtime-path';
/* eslint-disable @next/next/no-html-link-for-pages -- full reload keeps the desk's URL state restorer and visible workspace in sync. */

import { useEffect, useMemo, useState } from 'react';
import {
  actionQueueSurfaceIncludes,
  unifiedActionCounts,
  type ActionItem,
  type ActionSurfaceMode,
  type QueuePayload,
} from './action-queue-contract';

type Mode = ActionSurfaceMode;

const modeCopy: Record<Mode, { eyebrow: string; title: string; description: string }> = {
  CONTROL: { eyebrow: 'CROSS-OBJECT HANDOFFS', title: '只保留需要统筹的异常与交接', description: '这里不复制普通待审清单；只显示跨对象阻断、结果不明、源同步和本地主机工作器任务。' },
  MATERIALS: { eyebrow: 'MATERIAL ACTION FRONTIER', title: '素材库存与当前动作分开看', description: '补执行定义是Codex创作动作；等待粗分镜或锁镜是依赖状态；只有调用包完整后才出现用户生成授权。' },
  REVIEW: { eyebrow: 'FORMAL REVIEW FRONTIER', title: '当前可提交与等待依赖明确分层', description: '已产出不等于现在可提交；镜头按依赖链逐项开放，下一动作只指向真实依赖前沿。' },
};

function actorLabel(actor: ActionItem['actor']) {
  return actor === 'USER' ? '你' : actor === 'USER_EXTERNAL' ? '你（外部执行）' : actor === 'CODEX' ? 'Codex' : actor === 'HOST_WORKER' ? '本地主机工作器' : '等待';
}

export function ActionQueueSurface({ mode }: { mode: Mode }) {
  const [queue, setQueue] = useState<QueuePayload | null>(null);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => fetch('/api/v8/action-queue', { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as QueuePayload & { error?: string };
        if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
        setError('');
        setQueue(payload);
      })
      .catch((reason) => { if (!controller.signal.aborted) { setQueue(null); setError(reason instanceof Error ? reason.message : 'UNKNOWN'); } });
    void refresh();
    window.addEventListener('review:operations-updated', refresh);
    return () => { controller.abort(); window.removeEventListener('review:operations-updated', refresh); };
  }, []);

  const items = useMemo(() => (queue?.items || []).filter((item) => actionQueueSurfaceIncludes(mode, item)), [mode, queue]);
  const collapsedLimit = mode === 'MATERIALS' ? 8 : 6;
  const visibleItems = expanded ? items : items.slice(0, collapsedLimit);
  const copy = modeCopy[mode];
  const counts = queue ? unifiedActionCounts(queue) : null;
  const metrics = [
    ['待你做决定', counts?.userDecisions],
    ['已产出待裁决', counts?.producedPendingDecision],
    ['现在可提交', counts?.submittableNow],
    ['等待依赖', counts?.waitingDependency],
  ] as const;

  return <section className={`action-queue-surface mode-${mode.toLowerCase()}`}>
    <header><div><small>{copy.eyebrow}</small><h2>{copy.title}</h2></div><p>{copy.description}</p></header>
    {error && <p className="action-surface-error"><b>当前投影 UNKNOWN</b>{error}。不能把接口异常解释为零待办。</p>}
    <div className="action-surface-metrics" aria-label="统一行动统计">{metrics.map(([label, value]) => <article key={label}><span>{label}</span><b>{typeof value === 'number' ? value : 'UNKNOWN'}</b></article>)}</div>
    <div className="action-surface-list">{visibleItems.map((item) => <article key={item.actionKey}><header><b>{item.title}</b><span>{actorLabel(item.actor)}</span></header><p>{item.reasonText}</p><footer><small>{item.nextActionText}</small><a href={runtimePath(item.navigationIntent.href)}>{item.navigationIntent.label}</a></footer></article>)}
      {queue && !items.length && <p className="action-surface-empty">当前没有这一类行动；库存、普通待审或已完成对象不会填充此处。</p>}
      {!queue && !error && <p className="action-surface-empty">正在读取统一行动投影…</p>}
    </div>
    {queue && <footer><div className="action-surface-count"><span>{`显示 ${visibleItems.length} / 共 ${items.length} 项`}</span><code>{queue.snapshotId} · {queue.operationRevision}</code></div><div>{items.length > collapsedLimit && <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? '收起列表' : `展开全部 ${items.length} 项`}</button>}<a href={runtimePath("/?view=overview")}>查看完整行动中心</a></div></footer>}
  </section>;
}
