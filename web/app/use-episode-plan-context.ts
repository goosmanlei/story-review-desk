'use client';
import { useEffect, useState } from 'react';
import {readWorkspaceJson,workspaceCacheScope} from './workspace-read-cache';
import {useInstanceProfile} from './instance-context';
import type { EpisodePlanContext } from './episode-plan-context';

export function useEpisodePlanContext(enabled: boolean, snapshotId: string, storyMode?: string) {
  const instance=useInstanceProfile();
  const [plan, setPlan] = useState<EpisodePlanContext | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!enabled) return;
    let controller: AbortController | null = null;
    let selectedKey: string | undefined;
    const selection = () => {
      const params = new URL(window.location.href).searchParams;
      const archive = params.get('episodePlanArchive') === '1';
      const current = storyMode === 'story-structure' && !archive;
      const revisionId = current ? null : params.get('episodePlanRevision');
      return {current, revisionId, archive, key: JSON.stringify([current, revisionId, archive])};
    };
    const load = async (event?:Event) => {
      const selected = selection();
      if (event?.type === 'focus' && !selected.current) return;
      if (event?.type === 'popstate' && selectedKey === selected.key && !selected.current) return;
      controller?.abort();
      const requestController = new AbortController();
      controller = requestController;
      if (selectedKey !== selected.key) setPlan(null);
      selectedKey = selected.key; setError('');
      try {
        const {revisionId, archive} = selected;
        const payload=await readWorkspaceJson<{plan:EpisodePlanContext|null;error?:string}>(`/api/v1/workspaces/views/episode-plan${revisionId ? `?revisionId=${encodeURIComponent(revisionId)}&archive=${archive?'1':'0'}` : ''}`,workspaceCacheScope(instance),requestController.signal);
        if (payload.plan?.snapshotId !== snapshotId && payload.plan) throw new Error('分集方案与页面快照不一致，请刷新页面');
        if (revisionId && payload.plan && payload.plan.revisionId !== revisionId) throw new Error('返回的分集方案不是链接指定的精确版本，未跳到其他候选。');
        if (requestController.signal.aborted || selection().key !== selected.key) return;
        setPlan(payload.plan); setError(payload.plan ? '' : '当前实例尚未登记分集方案。');
        if (payload.plan && !revisionId && (location.search || location.hash)) {
          const current = new URL(window.location.href);
          if (selected.current) {
            current.searchParams.delete('episodePlanRevision');
            current.searchParams.delete('episodePlanArchive');
          } else current.searchParams.set('episodePlanRevision', payload.plan.revisionId);
          window.history.replaceState(window.history.state, '', current);
          selectedKey = selection().key;
        }
      } catch (reason) { if (!requestController.signal.aborted) { setPlan(null); setError(reason instanceof Error ? reason.message : '分集方案读取失败'); } }
    };
    void load();
    window.addEventListener('review:story-refresh', load);
    window.addEventListener('focus', load);
    window.addEventListener('popstate', load);
    window.addEventListener('review:story-updated', load);
    return () => { controller?.abort(); window.removeEventListener('review:story-refresh', load); window.removeEventListener('focus', load); window.removeEventListener('popstate', load); window.removeEventListener('review:story-updated', load); };
  }, [enabled, snapshotId,instance,storyMode]);
  return { plan, error };
}
