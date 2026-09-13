'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { configureClientStorage } from './client-storage';
import { instanceProfile, type InstanceProfile } from './instance-profile';
import {configureRuntimeBinding,runtimePath} from './runtime-request-boundary';
import {InstanceStatePage} from './instance-state-page';

const InstanceContext = createContext<InstanceProfile>(instanceProfile(null));

export function InstanceProfileProvider({ children }: { children: ReactNode }) {
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [profile, setProfile] = useState<InstanceProfile>(instanceProfile(null));
  useEffect(() => {
    let active = true;
    let accepted='';
    let acceptedProfile='';
    const refresh=()=>{void fetch(runtimePath('/api/v1/workspaces/profile'), { cache: 'no-store' }).then(async (response) => {
      if (!response.ok) throw new Error('无法读取当前实例配置');
      const value = await response.json() as Record<string,unknown>;
      if (active) {
        const next = instanceProfile({ instance: value, deployment:value.deployment });
        const identity=`${next.deployment.deploymentId}:${next.deployment.runtimeEpoch}:${next.deployment.basePath}`;
        if(accepted&&accepted!==identity){setStale(true);return;}
        const signature=JSON.stringify(next);
        accepted=identity;
        setError('');
        // The regular poll fences changed deployments and picks up real profile
        // changes. Replacing an equivalent context value makes every consumer
        // render, and object-dependent workspace loaders then tear down and
        // rebuild otherwise unchanged pages on every poll.
        if(acceptedProfile===signature)return;
        acceptedProfile=signature;
        configureRuntimeBinding(next.deployment);
        configureClientStorage(next);
        setProfile(next);
      }
    }).catch((reason: unknown) => {
      // A failed initial read has no safe profile to display. A transient
      // background check must not unmount an already fenced workspace; request
      // boundaries still reject stale writes and the next successful poll can
      // surface a changed deployment.
      if (active&&!acceptedProfile) setError(reason instanceof Error ? reason.message : '配置加载失败');
    });};
    const changed=()=>setStale(true);
    refresh();const timer=window.setInterval(refresh,15000);window.addEventListener('review:configuration-updated',refresh);window.addEventListener('review:runtime-changed',changed);
    return () => { active = false;window.clearInterval(timer);window.removeEventListener('review:configuration-updated',refresh);window.removeEventListener('review:runtime-changed',changed); };
  }, []);
  if(stale)return <InstanceStatePage state="updated"/>;
  if (error) return <InstanceStatePage state="error" error={error}/>;
  if (profile.instanceId === 'UNKNOWN') return <InstanceStatePage state="loading"/>;
  return <InstanceContext.Provider value={profile}>{children}</InstanceContext.Provider>;
}

export const useInstanceProfile = () => useContext(InstanceContext);
