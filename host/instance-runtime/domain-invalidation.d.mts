import type {OpaqueLegacyJson} from './index.mjs';
export function applyDomainInvalidations(invalidations:Array<{familyId:string;versionIds:string[]}>,versions:Map<string,OpaqueLegacyJson>):string[];
