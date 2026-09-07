/** Browser-safe gate over exact recorded inputs. No inference from filenames or prose. */
export function domainReferenceEligibility(model,targetFamilyId,inputBindings=[]){
 const rules=(model.domainReferenceRules||[]).filter(r=>r.targetFamilyId===targetFamilyId),reasons=[];
 const versions=model.assetVersionsById||new Map((model.assetVersions||[]).map(v=>[v.id,v]));const versionGet=id=>versions instanceof Map?versions.get(id):versions[id];const familyGet=id=>model.assetFamiliesById?(model.assetFamiliesById instanceof Map?model.assetFamiliesById.get(id):model.assetFamiliesById[id]):(model.assetFamilies||[]).find(f=>f.id===id);
 function generation(version,active=new Set()){
  if(active.has(version.id))return Infinity;active=new Set(active).add(version.id);
  const bindings=[...(version.inputVersionBindings||version.inputBindings||[])];
  // A version parent records revision history; only actual model inputs count as derived generations.
  let depth=0;for(const binding of bindings){const parentId=binding.assetVersionRef||binding.versionId,parent=versionGet(parentId);if(!parent){if(parentId)return Infinity;continue;}
   // Follow the exact recorded inputs even when a later graph removed an old reference edge.
   if(!binding.sha256||binding.sha256!==parent.sha256)return Infinity;
   const deterministic=version.derivationKind==='DETERMINISTIC';depth=Math.max(depth,generation(parent,active)+(deterministic?0:1));
  }return depth;
 }
 const target=model.domainReferenceTargets?.[targetFamilyId];if(target?.unresolved)reasons.push('DOMAIN_TARGET_IDENTITY_UNRESOLVED:'+targetFamilyId);
 if(target?.representationTypes?.some(t=>t==='IDENTITY'||t==='VOICE_IDENTITY')){
  const voice=target.representationTypes.includes('VOICE_IDENTITY'),foreign=new Set();
  const masterPolicy=target.masterPolicy||model.domainConfiguration?.referencePolicies?.find(p=>p.id===(voice?'VOICE_MASTER':'CLEAN_MASTER'));
  for(const binding of inputBindings){
   const sourceId=binding.assetFamilyRef||binding.familyId,source=model.domainReferenceTargets?.[sourceId],version=versionGet(binding.assetVersionRef||binding.versionId);
   if(!source){reasons.push('DOMAIN_IDENTITY_REFERENCE_UNRESOLVED:'+String(sourceId||binding.path||'UNKNOWN'));continue;}
   const same=target.entityIds.length===1&&source.entityIds.length===1&&target.entityIds[0]===source.entityIds[0];
   const kinship=!voice&&source.representationTypes.includes('IDENTITY')&&rules.some(r=>r.type==='FAMILY_RESEMBLANCE'&&r.status==='CONFIRMED'&&r.authority!=='U'&&r.sourceFamilyIds.includes(sourceId));
   if(!same&&!kinship||same&&!source.representationTypes.includes(voice?'VOICE_IDENTITY':'IDENTITY')){reasons.push('DOMAIN_IDENTITY_INPUT_FORBIDDEN:'+String(sourceId));continue;}
   if(!same)foreign.add(sourceId);
   // Same-master version corrections need the generation limit even without a separate edge.
   if(same&&(!masterPolicy||!version||generation(version)+1>masterPolicy.maxDerivedGenerations))reasons.push('DOMAIN_REFERENCE_MASTER_RESET_REQUIRED:'+String(sourceId));
  }
  if(foreign.size>1)reasons.push('DOMAIN_KINSHIP_SINGLE_REFERENCE_REQUIRED:'+targetFamilyId);
 }
 for(const rule of rules){
  const policy=rule.policy||model.domainConfiguration?.referencePolicies?.find(p=>p.id===rule.policyId);
  if(!policy||policy.requireApprovedVersion!==true||policy.allowIdentityTransfer!==false||!policy.purposes.includes(rule.purpose)){reasons.push(`DOMAIN_REFERENCE_POLICY_INVALID:${rule.relationId}`);continue;}
  if(rule.status!=='CONFIRMED'||rule.authority==='U'){reasons.push(`DOMAIN_REFERENCE_UNCONFIRMED:${rule.relationId}`);continue;}
  if(rule.type==='SAME_IDENTITY'&&rule.sourceEntityId!==rule.targetEntityId||['identity','voice-identity'].includes(rule.purpose)&&rule.sourceEntityId!==rule.targetEntityId){reasons.push(`DOMAIN_IDENTITY_TRANSFER_FORBIDDEN:${rule.relationId}`);continue;}
  if((rule.purpose==='identity'||rule.type==='FAMILY_RESEMBLANCE')&&rule.sourceRepresentationType!=='IDENTITY'||rule.purpose==='voice-identity'&&rule.sourceRepresentationType!=='VOICE_IDENTITY'){reasons.push(`DOMAIN_CLEAN_MASTER_REQUIRED:${rule.relationId}`);continue;}
  if(rule.type==='FAMILY_RESEMBLANCE'&&(rule.purpose!=='family-resemblance'||!rule.exclude?.length||policy.maxDerivedGenerations>1)){reasons.push(`DOMAIN_KINSHIP_LIMIT_REQUIRED:${rule.relationId}`);continue;}
  if(rule.sourceFamilyIds.length!==1){reasons.push(`DOMAIN_REFERENCE_UNRESOLVED:${rule.relationId}`);continue;}
  const family=familyGet(rule.sourceFamilyIds[0]),version=versionGet(family?.currentVersionId),binding=inputBindings.find(b=>(b.assetFamilyRef||b.familyId)===family?.id);
  if(!family||!version?.sha256||family.lifecycleState!=='RELEASED'||family.canFlowDownstream!==true||version.lifecycleState&&version.lifecycleState!=='RELEASED'||version.canFlowDownstream===false){reasons.push(`DOMAIN_REFERENCE_NOT_RELEASED:${rule.relationId}`);continue;}
  if(!binding||(binding.assetVersionRef||binding.versionId)!==version.id||binding.sha256!==version.sha256){reasons.push(`DOMAIN_REFERENCE_EXACT_BINDING_REQUIRED:${rule.relationId}`);continue;}
  const nextGeneration=generation(version)+(rule.type==='DETERMINISTIC_DERIVATION'?0:1);
  if(nextGeneration>policy.maxDerivedGenerations)reasons.push(`DOMAIN_REFERENCE_MASTER_RESET_REQUIRED:${rule.relationId}`);
 }
 return [...new Set(reasons)];
}
