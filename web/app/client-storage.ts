import type { InstanceProfile } from './instance-profile';

let profile: InstanceProfile | null = null;
export function configureClientStorage(value: InstanceProfile) { profile = value; }
function scoped(key: string) {
  if (!profile || profile.instanceId === 'UNKNOWN') throw new Error('Instance identity is not loaded');
  return `review-instance:${profile.instanceId}:${profile.deployment.runtimeEpoch}:${key}`;
}
function storage(session: boolean) {
  return {
    getItem(key: string) {
      const target = session ? window.sessionStorage : window.localStorage;
      const current = target.getItem(scoped(key));
      if (current !== null) return current;
      if (profile?.deployment?.runtimeEpoch) return null;
      const migration = profile?.capabilities.browserStorageMigration as { prefix?: string; unprefixedKeys?: boolean } | undefined;
      const legacyKey = key.startsWith('review.') && migration?.prefix ? migration.prefix + key.slice(7) : migration?.unprefixedKeys ? key : null;
      if (!legacyKey) return null;
      const legacy = target.getItem(legacyKey);
      if (legacy !== null) target.setItem(scoped(key), legacy);
      return legacy;
    },
    setItem(key: string, value: string) { (session ? window.sessionStorage : window.localStorage).setItem(scoped(key), value); },
    removeItem(key: string) { (session ? window.sessionStorage : window.localStorage).removeItem(scoped(key)); },
  };
}
export const instanceLocalStorage = storage(false);
export const instanceSessionStorage = storage(true);
