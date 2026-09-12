'use client';
import { useEffect, useState } from 'react';
import {readWorkspaceJson,workspaceCacheScope} from './workspace-read-cache';
import {useInstanceProfile} from './instance-context';
import type { EpisodePlanContext } from './episode-plan-context';

export function useEpisodePlanContext(enabled: boolean, snapshotId: string) {
  const instance=useInstanceProfile();
  const [plan, setPlan] = useState<EpisodePlanContext | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!enabled) return;
    let controller: AbortController | null = null;
    let selectedRevision: string|null|undefined;let selectedArchive=false;
    const load = async (event?:Event) => {
      const nextRevision=new URL(window.location.href).searchParams.get('episodePlanRevision');
      const nextArchive=new URL(window.location.href).searchParams.get('episodePlanArchive')==='1';
      if(event?.type==='popstate'&&selectedRevision===nextRevision&&selectedArchive===nextArchive)return;selectedArchive=nextArchive;
      controller?.abort();
      const requestController = new AbortController();
      controller = requestController;
      if(selectedRevision!==undefined&&selectedRevision!==nextRevision)setPlan(null);
      selectedRevision=nextRevision;setError('');
      try {
        const url = new URL(window.location.href);
        const revisionId = url.searchParams.get('episodePlanRevision');
        const archive=url.searchParams.get('episodePlanArchive')==='1';
        const payload=await readWorkspaceJson<{plan:EpisodePlanContext|null;error?:string}>(`/api/v1/workspaces/views/episode-plan${revisionId ? `?revisionId=${encodeURIComponent(revisionId)}&archive=${archive?'1':'0'}` : ''}`,workspaceCacheScope(instance),requestController.signal);
        if (payload.plan?.snapshotId !== snapshotId && payload.plan) throw new Error('分集方案与页面快照不一致，请刷新页面');
        if (revisionId && payload.plan && payload.plan.revisionId !== revisionId) throw new Error('返回的分集方案不是链接指定的精确版本，未跳到其他候选。');
        if (requestController.signal.aborted || new URL(window.location.href).searchParams.get('episodePlanRevision') !== revisionId) return;
        setPlan(payload.plan); setError(payload.plan ? '' : '当前实例尚未登记分集方案。');
        if (payload.plan && !revisionId && (location.search || location.hash)) {
          const current = new URL(window.location.href);
          current.searchParams.set('episodePlanRevision', payload.plan.revisionId);
          window.history.replaceState(window.history.state, '', current);
          selectedRevision=payload.plan.revisionId;
        }
      } catch (reason) { if (!requestController.signal.aborted) { setPlan(null); setError(reason instanceof Error ? reason.message : '分集方案读取失败'); } }
    };
    void load();
    window.addEventListener('popstate', load);
    window.addEventListener('review:story-updated', load);
    return () => { controller?.abort(); window.removeEventListener('popstate', load); window.removeEventListener('review:story-updated', load); };
  }, [enabled, snapshotId,instance]);
  return { plan, error };
}
