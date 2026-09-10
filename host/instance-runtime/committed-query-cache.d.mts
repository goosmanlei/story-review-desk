import type { InstanceReadUnit, InstanceRepository } from './index.mjs';
/** Top-level committed GET projection only. Existing transactions bypass it. */
export function committedQueryJson(repository: InstanceRepository, queryKey: string,
  read: (tx: InstanceReadUnit) => unknown | Promise<unknown>, observe?: (name:string, milliseconds:number)=>void,
  describe?: (metadata:Awaited<ReturnType<InstanceReadUnit['getMetadata']>>)=>void): Promise<string>;
/** Called within a committed GET; all other transactions compute private results. */
export function committedProjectionJson(tx: InstanceReadUnit, projectionKey: string,
  read: (tx: InstanceReadUnit) => unknown | Promise<unknown>): Promise<string>;
