import type {InstanceReadUnit,OpaqueLegacyJson} from './index.mjs';
export type SourceBinding = {schemaVersion:'1.0';releaseId:string;documentId:string;revisionId:string;sha256:string;byteSize:number;byteStart:number;byteEnd:number};
export const SOURCE_CHUNK_BYTES:number;
export function sourceDocumentResourceId(id:string):string;
export function sourceContextResources(documents:Array<{documentId:string;revisionId:string;sha256:string;byteSize:number;aliases:string[];metadata:Record<string,OpaqueLegacyJson>}>,releaseId:string):Array<{id:string;title:string;kind:string;text:string;sha256:string;href:string;role:'REFERENCE';versionId:string;relations:string[];sourceBinding?:SourceBinding}>;
export function validateSourceBinding(binding:unknown):void;
export function decodeSourceChunk(bytes:Uint8Array,binding:SourceBinding):{sourceText:string;sourceTextSha256:string;sourceSha256:string;revisionId:string;byteStart:number;byteEnd:number;byteSize:number};
export function readFrozenSourceCatalog(tx:InstanceReadUnit,catalogHash:string):Promise<OpaqueLegacyJson>;
export function readFrozenSourceChunk(tx:InstanceReadUnit,catalogHash:string,resourceId:string):Promise<OpaqueLegacyJson>;
export function searchFrozenSourceChunks(tx:InstanceReadUnit,catalogHash:string,query:string):Promise<OpaqueLegacyJson>;
export function sourceSearchScore(resource:{id:string;title:string},text:string,query:string):number;

export type BodyBinding={schemaVersion:'1.0';sha256:string;byteSize:number;characterCount:number;chunkCount:number};
export const DERIVED_BODY_MAX_BYTES:number;
export function validateBodyBinding(binding:unknown):void;
export function compactResourceCatalog<T extends {schemaVersion:string;resources:unknown[]}>(catalog:T):T;
export function catalogBodyRecords(catalog:object):Array<{sha256:string;bytes:Uint8Array}>;
export function resolveCatalogResource<T extends {resources:unknown[]}>(catalog:T,id:string):T['resources'][number]&{bodyBinding?:BodyBinding;relationBinding?:BodyBinding;bodySection?:'TEXT'|'RELATIONS';bodyRange?:{byteStart:number;byteEnd:number};bodyOf?:string}|null;
export function bodyChunkId(resource:{id:string;bodyBinding:BodyBinding},index:number):string;

export function prepareInitialSourceReadCosts(tx:InstanceReadUnit,catalog:{resources:unknown[]},resourceIds:string[]):Promise<void>;
export function catalogResourceReadCharacters(catalog:object,resource:unknown):number;
