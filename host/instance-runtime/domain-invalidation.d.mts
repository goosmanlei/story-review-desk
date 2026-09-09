import type {OpaqueLegacyJson} from './index.mjs';
import type {DomainProductionProof} from './domain-production-lineage.mjs';
import type {DomainCompatibilityException} from './domain-production-compatibility.mjs';
export function applyDomainInvalidations(invalidations:Array<{familyId:string;versionIds:string[];currentHash?:string}>,versions:Map<string,OpaqueLegacyJson>,options?:{reviewedDomainBindings?:Map<string,{familyId:string;sha256:string;domainContextHash:string;reviewEventId?:string;reviewEventSequence?:number;compatibilityOnly?:boolean}>;currentDomainHashes?:Map<string,string>;freshProductionProofs?:Map<string,DomainProductionProof>;compatibilityExceptions?:Map<string,DomainCompatibilityException>}):string[];
