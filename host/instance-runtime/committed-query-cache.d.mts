import type { InstanceReadUnit, InstanceRepository } from './index.mjs';
/** Top-level committed GET projection only. Existing transactions bypass it. */
export function committedQueryJson(repository: InstanceRepository, queryKey: string,
  read: (tx: InstanceReadUnit) => unknown | Promise<unknown>): Promise<string>;
