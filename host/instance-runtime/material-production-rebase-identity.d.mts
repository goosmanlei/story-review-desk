export type MaterialProductionRebaseJson=null|boolean|number|string|MaterialProductionRebaseJson[]|{[key:string]:MaterialProductionRebaseJson};
/** Exact raw DOMAIN rows. Complete-graph/source/current-selection checks belong to the caller. */
export type MaterialProductionRebaseRows={
 demand:Record<string,MaterialProductionRebaseJson>;
 representation:Record<string,MaterialProductionRebaseJson>;
 entity:Record<string,MaterialProductionRebaseJson>;
 state:Record<string,MaterialProductionRebaseJson>|null;
};
export type MaterialProductionRebaseIdentityProof={beforeHash:string;afterHash:string;changes:Array<{path:string;before:MaterialProductionRebaseJson;after:MaterialProductionRebaseJson}>};
/** Throws code DOMAIN_CONFLICT for identity/scope drift, aggregate markers, malformed JSON or no change. */
export function materialProductionRebaseIdentity(input:{before:MaterialProductionRebaseRows;after:MaterialProductionRebaseRows}):MaterialProductionRebaseIdentityProof;
