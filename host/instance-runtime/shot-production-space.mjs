import {spatialShotViewReasons} from './spatial-production.mjs';
/** Current coordinate evidence and explicit adopted state only; legacy scene routes are never aliases. */
export function productionSpaceReasons(model,settings){
 const space=settings?.space,evidence=model.spatialEvidence,reasons=[];
 if(!space||['loc','state','zone','camera','freeze'].some(k=>typeof space[k]!=='string'||!space[k]||space[k]==='UNKNOWN'))return['SPACE_BINDING_REQUIRED'];
 const hash=evidence?.sourceSha256,source=evidence?.sourceRef,expected=model.sourceHashes?.productionMapSha256||model.sourceHashes?.[source];
 const local=space.freeze.startsWith('SPATIAL-VIEW-');
 if(!/^[a-f0-9]{64}$/.test(hash||'')||!source||expected!==hash||!local&&![hash,source+'@'+hash].includes(space.freeze))reasons.push('SPACE_FREEZE_NOT_CURRENT');
 if(local)reasons.push(...spatialShotViewReasons(model,settings));
 const locations=(evidence?.locations||[]).filter(l=>l.id===space.loc),packages=(evidence?.locationPackages||[]).filter(p=>p.id===space.loc);
 if(locations.length!==1||packages.length!==1)reasons.push('SPACE_LOCATION_NOT_CURRENT');
 const pack=packages[0],zones=(pack?.zones||[]).filter(z=>z.id===space.zone),cameras=(pack?.cameras||[]).filter(c=>c.id===space.camera);
 if(zones.length!==1||!local&&(cameras.length!==1||cameras[0]?.zoneId&&cameras[0].zoneId!==space.zone||Array.isArray(cameras[0]?.zoneIds)&&!cameras[0].zoneIds.includes(space.zone)))reasons.push('SPACE_COORDINATES_NOT_IN_LOCATION');
 const directory=model.materialDirectory,graph=directory?.graph||model.domainGraph,states=(graph?.states||[]).filter(s=>s.id===space.state),state=states[0],entity=(graph?.entities||[]).find(e=>e.id===state?.entityId);
 const bound=(settings.inputs||[]).some(input=>{
  const requirement=(model.materialRequirements||[]).find(r=>r.id===input.requirementId&&r.requirementClass==='REQUIRED'&&(r.assetFamilyRefs||[]).includes(input.familyId));
  if(!requirement||directory?.staleIds?.includes(requirement.id))return false;
  const binding=(directory?.bindings||[]).find(b=>b.requirementId===requirement.id),representation=(graph?.representations||[]).find(r=>r.id===(binding?.representationId||requirement.representationRef));
  return (binding?.stateId||requirement.stateRef||representation?.stateId)===space.state&&(binding?.entityId||requirement.entityRef||representation?.entityId)===state?.entityId;
 });
 if(states.length!==1||!entity||entity.type!=='LOCATION'||state.authority==='U'||!bound||evidence?.projectionSchemaVersion==='PRODUCTION_SPATIAL_V1'&&state.entityId!==(locations[0]?.entityId||space.loc))reasons.push('SPACE_STATE_NOT_BOUND_TO_ADOPTED_INPUT');
 return reasons;
}
