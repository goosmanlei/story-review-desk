'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { configureClientStorage } from './client-storage';
import { instanceProfile, type InstanceProfile } from './instance-profile';

const InstanceContext = createContext<InstanceProfile>(instanceProfile(null));

export function InstanceProfileProvider({ children }: { children: ReactNode }) {
  const [error, setError] = useState('');
  const [profile, setProfile] = useState<InstanceProfile>(instanceProfile(null));
  useEffect(() => {
    let active = true;
    const refresh=()=>{void fetch('/api/instance/profile', { cache: 'no-store' }).then(async (response) => {
      if (!response.ok) throw new Error('无法读取当前实例配置');
      const value = await response.json();
      if (active) { const next = instanceProfile({ instance: value }); configureClientStorage(next); setProfile(next); }
    }).catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : '配置加载失败'); });};
    refresh();window.addEventListener('review:configuration-updated',refresh);
    return () => { active = false;window.removeEventListener('review:configuration-updated',refresh); };
  }, []);
  if (error) return <main role="alert"><p>{error}</p><button onClick={() => window.location.reload()}>重新加载</button></main>;
  if (profile.instanceId === 'UNKNOWN') return <main aria-busy="true">正在读取审阅台实例…</main>;
  return <InstanceContext.Provider value={profile}>{children}</InstanceContext.Provider>;
}

export const useInstanceProfile = () => useContext(InstanceContext);
