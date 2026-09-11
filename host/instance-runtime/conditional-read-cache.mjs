import {readBasis,workspaceReadMetadata} from './read-basis.mjs';
// Retain only validators from successful committed responses, never body trees.
const repositories=new WeakMap(),MAX_ENTRIES=64;
const key=request=>{const url=new URL(request.url);return url.pathname+url.search;};
export function retainReadValidator(repository,request,response){
 if(repository.inTransaction||response.status!==200)return;
 const etag=response.headers.get('ETag'),basis=response.headers.get('X-Review-Basis');
 if(!etag||!basis)return;
 let cache=repositories.get(repository);if(!cache){cache=new Map();repositories.set(repository,cache);}
 const id=key(request);cache.delete(id);cache.set(id,{etag,basis,headers:Object.fromEntries(['ETag','Cache-Control','X-Review-Version','X-Review-Basis'].flatMap(name=>response.headers.has(name)?[[name,response.headers.get(name)]]:[]))});
 while(cache.size>MAX_ENTRIES)cache.delete(cache.keys().next().value);
}
export async function conditionalWorkspaceRead(repository,request){
 if(repository.inTransaction)return null;
 const entry=repositories.get(repository)?.get(key(request));
 if(!entry||request.headers.get('If-None-Match')!==entry.etag)return null;
 // The version check and successful COMMIT precede returning 304. Heartbeats
 // are excluded by the shared basis; every relevant head/media change is not.
 const basis=await repository.readTransaction(async tx=>readBasis(await workspaceReadMetadata(tx)));
 return basis===entry.basis?new Response(null,{status:304,headers:entry.headers}):null;
}
