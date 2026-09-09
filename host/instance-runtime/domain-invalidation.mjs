import {canonicalJson,sha256} from './bytes.mjs';
const inputTuple=b=>({familyId:b.familyId||b.assetFamilyRef,versionId:b.versionId||b.assetVersionRef,sha256:b.sha256});
/** Mutates only the disposable usability projection. Immutable reviews are untouched. */
export function applyDomainInvalidations(invalidations,versions,{reviewedDomainBindings=new Map(),currentDomainHashes=new Map(),freshProductionProofs=new Map(),compatibilityExceptions=new Map()}={}){
  const stale=new Set(invalidations.flatMap(row=>row.versionIds.filter(id=>versions.get(id)?.familyId===row.familyId)));
  const causes=new Map();
  invalidations.forEach((row,index)=>{for(const id of row.versionIds)if(versions.get(id)?.familyId===row.familyId)causes.set(id,new Set([...(causes.get(id)||[]),index]));});
  const recorded=new Set(stale);
  const descendants=new Set();
  let expanded=true;
  while(expanded){expanded=false;for(const version of versions.values()){
    if((version.inputVersionBindings||[]).some(binding=>{
      const id=binding.versionId||binding.assetVersionRef,parent=versions.get(id);
      return parent&&stale.has(id)&&binding.sha256===parent.sha256;
    })){descendants.add(version.id);if(!stale.has(version.id)){stale.add(version.id);expanded=true;}}
  }}
  // Keep every cause in the complete historical closure, including cases where
  // a version has both a direct occurrence and an inherited occurrence.
  let causesChanged=true;
  while(causesChanged){causesChanged=false;for(const version of versions.values())for(const binding of version.inputVersionBindings||[]){
    const parent=versions.get(binding.versionId||binding.assetVersionRef);if(!parent||binding.sha256!==parent.sha256)continue;
    for(const index of causes.get(parent.id)||[]){const existing=causes.get(version.id)||new Set();if(!existing.has(index)){existing.add(index);causes.set(version.id,existing);causesChanged=true;}}
  }}
  // Preserve the complete historical descendant closure before resolving an
  // individually reviewed root. Reapproving identical parent bytes is not
  // evidence that an existing dependent output handled the changed domain.
  const pending=new Set([...recorded].filter(id=>{
    // Having its own older direct invalidation does not prove that a child
    // handled a later ancestor change. Root-only recovery excludes it too.
    if(descendants.has(id))return false;
    const version=versions.get(id),binding=reviewedDomainBindings.get(id);
    const currentHash=currentDomainHashes.get(version.familyId);
    const latest=invalidations.filter(row=>row.familyId===version.familyId).at(-1);
    return binding&&!binding.compatibilityOnly&&binding.familyId===version.familyId&&binding.sha256===version.sha256
      && /^[a-f0-9]{64}$/.test(String(version.sha256||''))
      && /^[a-f0-9]{64}$/.test(String(currentHash||''))
      && binding.domainContextHash===currentHash&&latest?.currentHash===currentHash;
  }));
  const recovered=new Map();
  let resolved=true;
  while(resolved){resolved=false;for(const id of pending){
    const version=versions.get(id);
    const parentsCurrent=(version.inputVersionBindings||[]).every(binding=>{
      const parentId=binding.versionId||binding.assetVersionRef,parent=versions.get(parentId);
      const familyId=binding.familyId||binding.assetFamilyRef;
      return parent&&binding.sha256===parent.sha256&&(!familyId||familyId===parent.familyId)
        &&!stale.has(parentId)&&parent.canFlowDownstream===true;
    });
    if(parentsCurrent){stale.delete(id);pending.delete(id);resolved=true;const review=reviewedDomainBindings.get(id);if(Number.isSafeInteger(review.reviewEventSequence)&&review.reviewEventSequence>0&&typeof review.reviewEventId==='string'&&review.reviewEventId)recovered.set(id,review.reviewEventSequence);}
  }}
  // The old descendant closure stays held. Only a genuinely new, fully proven
  // execution AFTER every recovered ancestor's exact review can be exempted.
  // Candidate registration time alone is never evidence of fresh production.
  let progressed=true;
  while(progressed){progressed=false;for(const id of stale){
    if(recorded.has(id))continue;
    const version=versions.get(id),proof=freshProductionProofs.get(id);if(!version||!proof)continue;
    let floor=0,valid=true;
    for(const binding of proof.inputs){
      const parent=versions.get(binding.versionId),barrier=recovered.get(binding.versionId);
      if(!parent||parent.familyId!==binding.familyId||parent.sha256!==binding.sha256||stale.has(parent.id)||parent.canFlowDownstream!==true){valid=false;break;}
      if((recorded.has(parent.id)||descendants.has(parent.id))&&!barrier){valid=false;break;}
      if(barrier){
        const review=reviewedDomainBindings.get(parent.id);
        if(!review||review.familyId!==parent.familyId||review.sha256!==parent.sha256||!Number.isSafeInteger(review.reviewEventSequence)||review.reviewEventSequence<barrier){valid=false;break;}
        const parentProof=freshProductionProofs.get(parent.id);
        if(!recorded.has(parent.id)&&(!parentProof||review.reviewEventSequence<=parentProof.candidateSequence)){valid=false;break;}
        floor=Math.max(floor,barrier,review.reviewEventSequence);
      }
    }
    if(valid&&floor>0&&proof.authorizedSequence>floor&&proof.submittedSequence>proof.authorizedSequence){stale.delete(id);recovered.set(id,floor);progressed=true;}
  }}
  // Business compatibility is NOT fresh production. It covers only explicitly
  // listed original versions, exact SHA and every recorded/inherited occurrence.
  // Never use it to populate the newer-execution review-sequence barrier above.
  let compatibleProgress=true;
  while(compatibleProgress){compatibleProgress=false;for(const id of stale){
    const version=versions.get(id),proof=compatibilityExceptions.get(id),indexes=causes.get(id);
    if(!version||!proof||!indexes?.size||proof.versionId!==id||proof.familyId!==version.familyId||proof.sha256!==version.sha256||!proof.domainContextHash||proof.domainContextHash!==currentDomainHashes.get(version.familyId)||!(proof.occurrenceHashes instanceof Map))continue;
    if([...indexes].some(i=>proof.occurrenceHashes.get(i)!==sha256(canonicalJson(invalidations[i]))))continue;
    const actual=(version.inputVersionBindings||[]).map(inputTuple);
    if(canonicalJson(actual)!==canonicalJson(proof.inputBindings))continue;
    const parentsCurrent=actual.every(binding=>{const parent=versions.get(binding.versionId);return parent&&parent.familyId===binding.familyId&&parent.sha256===binding.sha256&&!stale.has(parent.id)&&parent.canFlowDownstream===true;});
    if(!parentsCurrent)continue;
    // The preexisting candidate/review/rights state remains exactly as projected.
    // A compatibility record never creates approval or flips canFlowDownstream.
    stale.delete(id);compatibleProgress=true;
  }}
  for(const id of stale){const version=versions.get(id);if(!version)continue;
    if(!['DO_NOT_USE','RIGHTS_HOLD'].includes(String(version.lifecycleState)))version.lifecycleState='REVISION_REQUIRED';
    version.canFlowDownstream=false;version.flowBlockReasons=[...new Set([...(version.flowBlockReasons||[]),'DOMAIN_RELATION_INPUT_CHANGED'])];
  }
  return [...stale];
}
