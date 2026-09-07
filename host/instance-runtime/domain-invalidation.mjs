/** Mutates only the disposable usability projection. Immutable reviews are untouched. */
export function applyDomainInvalidations(invalidations,versions){
  const stale=new Set(invalidations.flatMap(row=>row.versionIds.filter(id=>versions.get(id)?.familyId===row.familyId)));
  let expanded=true;
  while(expanded){expanded=false;for(const version of versions.values()){
    if(stale.has(version.id))continue;
    if((version.inputVersionBindings||[]).some(binding=>{
      const id=binding.versionId||binding.assetVersionRef,parent=versions.get(id);
      return parent&&stale.has(id)&&binding.sha256===parent.sha256;
    })){stale.add(version.id);expanded=true;}
  }}
  for(const id of stale){const version=versions.get(id);if(!version)continue;
    if(!['DO_NOT_USE','RIGHTS_HOLD'].includes(String(version.lifecycleState)))version.lifecycleState='REVISION_REQUIRED';
    version.canFlowDownstream=false;version.flowBlockReasons=[...new Set([...(version.flowBlockReasons||[]),'DOMAIN_RELATION_INPUT_CHANGED'])];
  }
  return [...stale];
}
