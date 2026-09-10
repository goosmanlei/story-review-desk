import type {InstanceReadUnit} from './index.mjs';
import type {MaterialUsageSource,MaterialUsageEvidence} from './material-usage-model.mjs';
export function materialUsageMediaCurrent(tx:InstanceReadUnit,source:MaterialUsageSource):Promise<boolean>;
export function loadMaterialUsageEvidence<T extends object>(tx:InstanceReadUnit,model:T,options?:{view?:Awaited<ReturnType<InstanceReadUnit['readView']>>;events?:Record<string,any>[]}):Promise<T&{materialUsageEvidence?:MaterialUsageEvidence[]}>;
export function preserveMaterialUsageProjection<S,R>(input:{snapshot:S;recipes:R;baseSnapshot:unknown;documents:unknown[];events:unknown[]}):{snapshot:S;recipes:R};
