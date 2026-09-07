import type {InstanceReadUnit,InstanceUnit} from './index.mjs';
export type SourceSummary={id:string;title:string;role:'PRIMARY'|'DERIVED'|'AUXILIARY';format:string;sha256:string;revisionId:string;documentRevisionId:string;documentSha256:string;status:string;observation:string;textAvailable:boolean;text?:string;filename:string;byteSize:number};
export function prepareSourceImport(input:{title:string;role:string;filename?:string;text?:string;contentBase64?:string;bytes?:Uint8Array;expectedReleaseId:string},instanceRoot:string):Promise<Record<string,unknown>>;
export function importSource(tx:InstanceUnit,prepared:Record<string,unknown>):Promise<{source:SourceSummary;releaseId:string;replayed:boolean}>;
export function listDomainSources(tx:InstanceReadUnit,options?:{includeText?:boolean}):Promise<{releaseId:string;sources:SourceSummary[];readOnly:boolean}>;
export function sourceBindingsFor(tx:InstanceReadUnit):Promise<import('./domain-model.mjs').SourceBinding[]>;
export function verifySourceBindings(tx:InstanceReadUnit,bindings:import('./domain-model.mjs').SourceBinding[],options?:{allowLegacy?:boolean}):Promise<boolean>;
export function registerPublishedSource(tx:InstanceUnit,input:{alias:string;title:string;role:string;expectedReleaseId:string}):Promise<{source:SourceSummary;releaseId:string;replayed:boolean}>;
