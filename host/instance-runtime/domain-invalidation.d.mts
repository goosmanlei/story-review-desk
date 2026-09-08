import type {OpaqueLegacyJson} from './index.mjs';
export function applyDomainInvalidations(invalidations:Array<{familyId:string;versionIds:string[];currentHash?:string}>,versions:Map<string,OpaqueLegacyJson>,options?:{reviewedDomainBindings?:Map<string,{familyId:string;sha256:string;domainContextHash:string}>;currentDomainHashes?:Map<string,string>}):string[];
