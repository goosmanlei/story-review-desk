/** Daily UI projection only. Immutable version, family, review and release records are never changed. */
type VersionIdentity={id:string;familyId:string;outputState?:string|null;historyRole?:string|null;lifecycleState?:string|null};
type FamilyIdentity={id:string;versionRefs:string[]};
export function isDeletedMaterialVersion(version:VersionIdentity|null|undefined):boolean{
 return Boolean(version&&(version.outputState==='DELETED'||version.historyRole==='DELETED_AUDIT'||version.lifecycleState==='DELETED_AUDIT'));
}
export function exactMaterialVersion<T extends VersionIdentity>(model:{assetVersions:T[]},family:FamilyIdentity|null|undefined,id:string):T|null{
 if(!family||!family.versionRefs.includes(id))return null;
 const matches=model.assetVersions.filter(v=>v.id===id);
 return matches.length===1&&matches[0].familyId===family.id?matches[0]:null;
}
export function dailyMaterialVersionRefs<T extends VersionIdentity>(model:{assetVersions:T[]},family:FamilyIdentity|null|undefined):string[]{
 if(!family)return [];
 // A missing, ambiguous or wrong-family record is UNKNOWN, not evidence of deletion.
 // Preserve its identity placeholder; never infer deletion from path/SHA/preview absence.
 return family.versionRefs.filter(id=>!isDeletedMaterialVersion(exactMaterialVersion(model,family,id)));
}
