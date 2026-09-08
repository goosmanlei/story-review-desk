/** Mutates only the disposable usability projection. Immutable reviews are untouched. */
export function applyDomainInvalidations(invalidations,versions,{reviewedDomainBindings=new Map(),currentDomainHashes=new Map()}={}){
  const stale=new Set(invalidations.flatMap(row=>row.versionIds.filter(id=>versions.get(id)?.familyId===row.familyId)));
  const recorded=new Set(stale);
  let expanded=true;
  while(expanded){expanded=false;for(const version of versions.values()){
    if(stale.has(version.id))continue;
    if((version.inputVersionBindings||[]).some(binding=>{
      const id=binding.versionId||binding.assetVersionRef,parent=versions.get(id);
      return parent&&stale.has(id)&&binding.sha256===parent.sha256;
    })){stale.add(version.id);expanded=true;}
  }}
  // Preserve the complete historical descendant closure before resolving an
  // individually reviewed root. Reapproving identical parent bytes is not
  // evidence that an existing dependent output handled the changed domain.
  const pending=new Set([...recorded].filter(id=>{
    const version=versions.get(id),binding=reviewedDomainBindings.get(id);
    const currentHash=currentDomainHashes.get(version.familyId);
    const latest=invalidations.filter(row=>row.familyId===version.familyId).at(-1);
    return binding&&binding.familyId===version.familyId&&binding.sha256===version.sha256
      && /^[a-f0-9]{64}$/.test(String(version.sha256||''))
      && /^[a-f0-9]{64}$/.test(String(currentHash||''))
      && binding.domainContextHash===currentHash&&latest?.currentHash===currentHash;
  }));
  let resolved=true;
  while(resolved){resolved=false;for(const id of pending){
    const version=versions.get(id);
    const parentsCurrent=(version.inputVersionBindings||[]).every(binding=>{
      const parentId=binding.versionId||binding.assetVersionRef,parent=versions.get(parentId);
      const familyId=binding.familyId||binding.assetFamilyRef;
      return parent&&binding.sha256===parent.sha256&&(!familyId||familyId===parent.familyId)
        &&!stale.has(parentId)&&parent.canFlowDownstream===true;
    });
    if(parentsCurrent){stale.delete(id);pending.delete(id);resolved=true;}
  }}
  for(const id of stale){const version=versions.get(id);if(!version)continue;
    if(!['DO_NOT_USE','RIGHTS_HOLD'].includes(String(version.lifecycleState)))version.lifecycleState='REVISION_REQUIRED';
    version.canFlowDownstream=false;version.flowBlockReasons=[...new Set([...(version.flowBlockReasons||[]),'DOMAIN_RELATION_INPUT_CHANGED'])];
  }
  return [...stale];
}
