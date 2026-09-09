import type {DomainGraph} from './domain-model.mjs';
import type {OpaqueLegacyJson} from './index.mjs';
export function domainProductionSlice(graph:DomainGraph,ids:string[],options?:{referencePolicies?:OpaqueLegacyJson;representationPolicies?:OpaqueLegacyJson;configuration?:OpaqueLegacyJson}):OpaqueLegacyJson;
export function projectDomainGraph(snapshot:OpaqueLegacyJson,graph:DomainGraph,reference:{revisionId:string;sha256:string},options?:{initialization?:OpaqueLegacyJson;eventVersions?:OpaqueLegacyJson[];preserveReferencePolicies?:boolean;directorySource?:{content:OpaqueLegacyJson|null;revisionId:string|null;sha256:string|null}}):OpaqueLegacyJson;
export function relationProjection(graph:DomainGraph,filters?:{requirementId?:string;familyId?:string;entityId?:string}):DomainGraph;
export function domainReferenceEligibility(model:OpaqueLegacyJson,targetFamilyId:string,inputBindings?:OpaqueLegacyJson[]):string[];
export function preserveDomainProjection(input:{snapshot:OpaqueLegacyJson;baseSnapshot:OpaqueLegacyJson;events?:OpaqueLegacyJson[]}):OpaqueLegacyJson;
