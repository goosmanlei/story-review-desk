/** Daily UI projection only. Immutable version, family, review and release records are never changed. */
type VersionIdentity={id:string;familyId:string;outputState?:string|null;historyRole?:string|null;lifecycleState?:string|null;path?:string|null;sha256?:string|null};
type FamilyIdentity={id:string;versionRefs:string[];expectedOutputRefs?:string[]};
type ExpectedIdentity={id:string;familyId:string;expectationState:string;realizedVersionId?:string|null;realizedVersionSha256?:string|null};
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

function exactMaterialExpected<T extends ExpectedIdentity>(model:{expectedOutputs?:T[]},family:FamilyIdentity|null|undefined,id:string):T|null{
 if(!family||!family.expectedOutputRefs?.includes(id))return null;
 const matches=(model.expectedOutputs||[]).filter(item=>item.id===id);
 return matches.length===1&&matches[0].familyId===family.id?matches[0]:null;
}
export function pendingMaterialExpectedOutputs<T extends ExpectedIdentity>(model:{expectedOutputs?:T[]},family:FamilyIdentity|null|undefined):T[]{
 return [...new Set(family?.expectedOutputRefs||[])].map(id=>exactMaterialExpected(model,family,id)).filter((item):item is T=>Boolean(item&&item.expectationState==='PLANNED'&&!item.realizedVersionId&&!item.realizedVersionSha256));
}
/** Resolve only the explicitly requested record; never fall back to the latest version. */
export function resolveExactMaterialSelection<V extends VersionIdentity,E extends ExpectedIdentity>(model:{assetVersions:V[];expectedOutputs?:E[]},family:FamilyIdentity|null|undefined,id:string):{version:V|null;expected:E|null}{
 const unresolved={version:null,expected:null};
 if(!family)return unresolved;
 const version=exactMaterialVersion(model,family,id);
 const expected=exactMaterialExpected(model,family,id);
 if(version)return (model.expectedOutputs||[]).some(item=>item.id===id)?unresolved:{version,expected:null};
 if(!expected)return unresolved;
 if(expected.expectationState==='PLANNED'&&!expected.realizedVersionId&&!expected.realizedVersionSha256)return {version:null,expected};
 if(expected.expectationState!=='REALIZED'||!expected.realizedVersionId||!expected.realizedVersionSha256)return unresolved;
 const realized=exactMaterialVersion(model,family,expected.realizedVersionId);
 if(!realized||realized.outputState!=='PRESENT'||!realized.path||!/^[a-f0-9]{64}$/i.test(realized.sha256||'')||realized.sha256!==expected.realizedVersionSha256)return unresolved;
 return {version:realized,expected:null};
}
