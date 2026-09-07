import type {DomainGraph,DomainConfiguration} from './domain-model.mjs';
import type {DomainChange,DomainOwner,Ownership} from './domain-workspaces.mjs';
export const domainCollections:Array<keyof Omit<DomainGraph,'schemaVersion'>>;
export const domainOwners:DomainOwner[];
export function objectKey(collection:string,id:string):string;
export function domainOwnership(graph:DomainGraph,configuration?:DomainConfiguration,registered?:Record<string,unknown>):Ownership;
export function applyDomainChanges(graph:DomainGraph,changes:DomainChange[],owner:DomainOwner,ownership:Ownership):{graph:DomainGraph;ownership:Ownership};
