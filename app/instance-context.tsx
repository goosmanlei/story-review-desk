'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { configureClientStorage } from './client-storage';
import { instanceProfile, type InstanceProfile } from './instance-profile';
import {configureRuntimeBinding,runtimePath} from './runtime-request-boundary';

const InstanceContext = createContext<InstanceProfile>(instanceProfile(null));

export function InstanceProfileProvider({ children }: { children: ReactNode }) {
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [profile, setProfile] = useState<InstanceProfile>(instanceProfile(null));
  useEffect(() => {
    let active = true;
    let accepted='';
    const refresh=()=>{void fetch(runtimePath('/api/instance/profile'), { cache: 'no-store' }).then(async (response) => {
      if (!response.ok) throw new Error('无法读取当前实例配置');
      const value = await response.json() as Record<string,unknown>;
      if (active) { const next = instanceProfile({ instance: value, deployment:value.deployment });const identity=`${next.deployment.deploymentId}:${next.deployment.runtimeEpoch}:${next.deployment.basePath}`;if(accepted&&accepted!==identity){setStale(true);return;}accepted=identity;configureRuntimeBinding(next.deployment);configureClientStorage(next);setProfile(next); }
    }).catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : '配置加载失败'); });};
    const changed=()=>setStale(true);
    refresh();const timer=window.setInterval(refresh,15000);window.addEventListener('review:configuration-updated',refresh);window.addEventListener('review:runtime-changed',changed);
    return () => { active = false;window.clearInterval(timer);window.removeEventListener('review:configuration-updated',refresh);window.removeEventListener('review:runtime-changed',changed); };
  }, []);
  if(stale)return <main role="alert"><h1>审阅台已更新</h1><p>当前页面属于上一部署或运行期，已停止写入。请刷新后继续；旧草稿不会自动回灌。</p><button onClick={()=>window.location.reload()}>刷新页面</button></main>;
  if (error) return <main role="alert"><p>{error}</p><button onClick={() => window.location.reload()}>重新加载</button></main>;
  if (profile.instanceId === 'UNKNOWN') return <main aria-busy="true">正在读取审阅台实例…</main>;
  return <InstanceContext.Provider value={profile}>{children}</InstanceContext.Provider>;
}

export const useInstanceProfile = () => useContext(InstanceContext);
