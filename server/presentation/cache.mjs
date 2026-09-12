import {BoundedCache} from '../shared/cache.mjs';
import {hash} from '../shared/contracts.mjs';
import {workspaceRead} from './workspaces.mjs';
const cache=new BoundedCache();
const expiry=setInterval(()=>cache.sweep(),30000);expiry.unref();
const cachedNames=new Set(['views/bootstrap','views/episode-plan','views/production','views/materials','views/production-materials','domain-workspaces','material-directory','production-preparation','configuration','sources','story-history','spatial-settings']);
// A cheap revision token is only a cache invalidator, never a write precondition.
// Object versions are monotone; imports replace the runtime epoch. Media states
// and configuration revisions also participate, including new/deleted records.
export async function presentationToken(tx){
 const {rows}=await tx.query(`SELECT p.instance_id,p.runtime_epoch,
  (SELECT count(*)::text||':'||COALESCE(sum(version),0)::text FROM objects) AS objects,
  (SELECT COALESCE(string_agg(scope||':'||version::text,',' ORDER BY scope),'') FROM configurations) AS configuration,
  (SELECT md5(COALESCE(string_agg(id||':'||version_id||':'||sha256||':'||availability,',' ORDER BY id,version_id),'')) FROM media) AS media
  FROM project p`);
 return hash(rows);
}
export async function cachedWorkspace(tx,path,params,ifNoneMatch){
 const name=path.join('/');
 if(!cachedNames.has(name))return {value:await workspaceRead(tx,path,params)};
 const token=await presentationToken(tx),key=name+'?'+params.toString();let entry=cache.get(key);
 if(!entry||entry.token!==token){const value=await workspaceRead(tx,path,params);entry={token,body:JSON.stringify(value),etag:'"'+hash(value)+'"'};cache.set(key,entry);}
 return {etag:entry.etag,...(ifNoneMatch===entry.etag?{unchanged:true}:{body:entry.body})};
}
