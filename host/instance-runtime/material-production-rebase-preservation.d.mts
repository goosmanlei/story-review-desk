export type MaterialProductionRebaseSourceClosure={
 plan:Record<string,any>;body:Record<string,any>;doc:Record<string,any>;
};
export type MaterialProductionRebaseRevisionClosure={
 row:Record<string,any>;body:Record<string,any>;definition:Record<string,any>;output:Record<string,any>;initial:MaterialProductionRebaseSourceClosure;
};
export type MaterialProductionRebaseLegacyInput={
 model:Record<string,any>;recipes:Record<string,any>;documents:Array<Record<string,any>>;initialClosures:MaterialProductionRebaseSourceClosure[];
 instanceId?:string;
 verifiedAncestors?:Array<{definitionId:string;output:Record<string,any>}>;
};
/** Pure source closure verification; no proof of an actual media read or provider call. */
export function materialProductionRebaseClosures(input:MaterialProductionRebaseLegacyInput&{
 validateLegacySegment:(input:MaterialProductionRebaseLegacyInput)=>MaterialProductionRebaseRevisionClosure[];
}):{revisions:MaterialProductionRebaseRevisionClosure[];anchors:MaterialProductionRebaseSourceClosure[];contextIds:string[]};
