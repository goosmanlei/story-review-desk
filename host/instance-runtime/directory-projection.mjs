import {domainHash} from './domain-model.mjs';
export function directoryProjection(model,content){
 const graph=structuredClone(model.domainGraph||{schemaVersion:'1.0',entities:[],states:[],representations:[],relations:[],requirements:[]});
 if(!content)return {graph,bindings:[],trials:[],staleIds:[],staleBindings:[],revisionId:null};
 const requirements=new Map((model.materialRequirements||[]).map(r=>[r.id,r]));
 const bindings=[],staleIds=[],staleBindings=[];
 for(const collection of ['entities','states','relations'])for(const row of content['new'+collection[0].toUpperCase()+collection.slice(1)]||[])if(!graph[collection].some(r=>r.id===row.id))graph[collection].push({...row,directoryOnly:true});
 for(const b of content.directoryBindings||[]){const requirement=requirements.get(b.requirementId),representation=graph.representations.find(r=>r.id===b.representationId),targetEntity=graph.entities.find(e=>e.id===b.entityId),targetState=graph.states.find(s=>s.id===b.stateId);if(!requirement||(requirement.requirementClass&&requirement.requirementClass!=='REQUIRED')||requirement.requirementHash!==b.requirementHash||!representation||domainHash(representation)!==b.representationHash||!targetEntity||targetState?.entityId!==b.entityId){staleIds.push(b.requirementId);staleBindings.push(b);continue;}bindings.push(b);}
 for(const b of bindings){const r=graph.representations.find(r=>r.id===b.representationId);r.entityId=b.entityId;r.stateId=b.stateId;}
 return {graph,bindings,trials:content.trialBindings||[],staleIds,staleBindings,sourceBindings:content.sourceBindings||[],scopePolicy:'LEGACY_SCOPE_EVIDENCE_ONLY'};
}
/** A read model is reprojected, never copied across a new authoritative graph.
 * New snapshots retain rejected binding definitions so pure compilation can
 * recheck them later without inventing source rows or silently losing history.
 * Old snapshots that retained only stale IDs remain fail-closed until a
 * transaction supplies their actual auxiliary definition again. */
export function refreshDirectoryProjection(model,source){
 const previous=model.materialDirectory;
 if(!source&&!previous)return undefined;
 const fromAux=Boolean(source),content=source?source.content:{
  directoryBindings:[...(previous.bindings||[]),...(previous.staleBindings||[])],
  newEntities:(previous.graph?.entities||[]).filter(row=>row.directoryOnly),
  newStates:(previous.graph?.states||[]).filter(row=>row.directoryOnly),
  newRelations:(previous.graph?.relations||[]).filter(row=>row.directoryOnly),
  trialBindings:previous.trials||[],sourceBindings:previous.sourceBindings||[]
 };
 const projected=directoryProjection(model,content);
 const unresolvedLegacy=!fromAux?(previous.staleIds||[]).filter(id=>!content.directoryBindings.some(b=>b.requirementId===id)):[];
 const staleIds=[...new Set([...projected.staleIds,...unresolvedLegacy])];
 return {...projected,staleIds,revisionId:source?source.revisionId:previous.revisionId||null,
  sourceSha256:source?source.sha256:previous.sourceSha256||null,
  projectionBasis:{schemaVersion:'1.0',domainGraphHash:domainHash(model.domainGraph||{}),
   requirementsHash:domainHash((model.materialRequirements||[]).map(row=>({id:row.id,requirementHash:row.requirementHash||null,requirementClass:row.requirementClass||null})).sort((a,b)=>a.id.localeCompare(b.id)))},
  projectionSource:fromAux?'REGISTERED_AUXILIARY_DEFINITION':'REPROJECTED_READ_MODEL'};
}
