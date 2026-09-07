'use client';
import { useEffect, useState } from 'react';
import type { EpisodePlanContext } from './episode-plan-context';

export function useEpisodePlanContext(enabled: boolean, snapshotId: string) {
  const [plan, setPlan] = useState<EpisodePlanContext | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!enabled) return;
    let controller: AbortController | null = null;
    const load = async () => {
      controller?.abort();
      const requestController = new AbortController();
      controller = requestController;
      setPlan(null); setError('');
      try {
        const url = new URL(window.location.href);
        const revisionId = url.searchParams.get('episodePlanRevision');
        const response = await fetch(`/api/v8/ui/episode-plan${revisionId ? `?revisionId=${encodeURIComponent(revisionId)}` : ''}`, { cache: 'no-store', signal: requestController.signal });
        const payload = await response.json() as { plan: EpisodePlanContext | null; error?: string };
        if (!response.ok) throw new Error(payload.error || '分集方案读取失败');
        if (payload.plan?.snapshotId !== snapshotId && payload.plan) throw new Error('分集方案与页面快照不一致，请刷新页面');
        if (revisionId && payload.plan && payload.plan.revisionId !== revisionId) throw new Error('返回的分集方案不是链接指定的精确版本，未跳到其他候选。');
        if (requestController.signal.aborted || new URL(window.location.href).searchParams.get('episodePlanRevision') !== revisionId) return;
        setPlan(payload.plan); setError(payload.plan ? '' : '当前实例尚未登记分集方案。');
        if (payload.plan && !revisionId) {
          const current = new URL(window.location.href);
          current.searchParams.set('episodePlanRevision', payload.plan.revisionId);
          window.history.replaceState(window.history.state, '', current);
        }
      } catch (reason) { if (!requestController.signal.aborted) { setPlan(null); setError(reason instanceof Error ? reason.message : '分集方案读取失败'); } }
    };
    void load();
    window.addEventListener('popstate', load);
    return () => { controller?.abort(); window.removeEventListener('popstate', load); };
  }, [enabled, snapshotId]);
  return { plan, error };
}
