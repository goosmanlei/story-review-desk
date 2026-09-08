import {shotProductionEntryGates} from './shot-production-model.mjs';
import {shotRecipeDefinitionBindingReasons} from './shot-production-recipe-basis.mjs';

/** Server-only current closure checks; the browser receives their evaluated reasons. */
export function shotProductionExecutionEntries(model,state,recipes){
  const entries=shotProductionEntryGates(model,state);
  for(const work of model.workItems||[]){
    if(!work.shotProductionPlanId)continue;
    const definition=(recipes?.executionDefinitions||[]).find(d=>d.id===work.executionDefinitionRef);
    const reasons=entries[work.id]||['SHOT_PRODUCTION_GATE_PROJECTION_REQUIRED'];
    entries[work.id]=[...new Set([...reasons,...(definition?shotRecipeDefinitionBindingReasons(model,state,definition):[])])];
  }
  return entries;
}
