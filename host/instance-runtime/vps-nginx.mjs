import {createHash} from 'node:crypto';
import {lstat,open,readFile,realpath} from 'node:fs/promises';
import {EXISTING_NGINX_AUTH} from './vps-target.mjs';
export const nginxSha=value=>createHash('sha256').update(value).digest('hex');
const marker=target=>'STORY_REVIEW_MANAGED '+target.targetId;
export function nginxManagedBlock(target,{upstream,maintenance=false}={}){
 if(!maintenance&&!/^(?:[a-zA-Z0-9][a-zA-Z0-9.-]*|\[[a-fA-F0-9:]+\]):[1-9][0-9]{0,4}$/.test(upstream||''))throw Error('Exact inspected Nginx upstream required');
 const id=marker(target),base=target.basePath,auth=target.nginx,name='review_maintenance_'+target.targetId.replaceAll('-','_').replaceAll('.','_'),publicDemo=target.accessMode==='PUBLIC_DEMO';
 const common=[
  ...(publicDemo?['auth_basic off;']:['auth_basic "'+auth.authBasicRealm+'";','auth_basic_user_file '+auth.authBasicUserFile+';']),'access_log off;',
  'proxy_http_version 1.1;','proxy_buffering off;','proxy_request_buffering on;','proxy_read_timeout 3600s;',
  'proxy_set_header Host '+new URL(target.publicUrl).host+';','proxy_set_header X-Forwarded-Host '+new URL(target.publicUrl).host+';','proxy_set_header X-Forwarded-Proto https;',
  'proxy_set_header X-Forwarded-Port '+(new URL(target.publicUrl).port||'443')+';','proxy_set_header X-Forwarded-For $remote_addr;',
  'proxy_set_header X-Review-Proxy controlled-nginx-v1;','proxy_set_header X-Review-Access-Mode '+(publicDemo?'PUBLIC_DEMO':'BASIC_AUTH')+';',
  'proxy_set_header X-Review-Authenticated-User '+(publicDemo?'""':'$remote_user')+';',
  'proxy_set_header X-Review-Internal-Gateway "";','proxy_set_header Authorization "";','proxy_set_header Forwarded "";',
  'proxy_set_header Range $http_range;','proxy_set_header If-Range $http_if_range;',
 ];
 // Authentication precedes the proxy content handler, unlike rewrite return.
 const proxy=maintenance?['proxy_connect_timeout 1s;','proxy_intercept_errors on;','error_page 502 504 =503 @'+name+';','proxy_pass http://127.0.0.1:9;']:['proxy_pass http://'+upstream+';'];
 let block='    # BEGIN '+id+'\n';
 for(const location of base?['= '+base,'^~ '+base+'/']:['^~ /'])block+='    location '+location+' {\n'+[...common,...proxy].map(line=>'        '+line+'\n').join('')+'    }\n';
 if(maintenance)block+='    location @'+name+' {\n        access_log off;\n        default_type text/html;\n        add_header Cache-Control "no-store" always;\n        return 503 \'<h1>Review desk maintenance</h1>\';\n    }\n';
 return block+'    # END '+id+'\n';
}
function serverBounds(source,serverName){
 const candidates=[],pattern=/(?:^|\n)[ \t]*server[ \t]*\{/g;let match;
 while((match=pattern.exec(source))){let depth=0,quote='',escaped=false,comment=false;
  for(let index=source.indexOf('{',match.index);index<source.length;index++){
   const ch=source[index];if(comment){if(ch==='\n')comment=false;continue;}if(escaped){escaped=false;continue;}if(quote){if(ch==='\\')escaped=true;else if(ch===quote)quote='';continue;}if(ch==='#'){comment=true;continue;}if(ch==='"'||ch==="'"){quote=ch;continue;}if(ch==='{')depth++;else if(ch==='}'&&--depth===0){
    const body=source.slice(match.index,index+1).replace(/#[^\n]*/g,'');
    const names=[...body.matchAll(/\bserver_name\s+([^;]+);/g)].flatMap(m=>m[1].trim().split(/\s+/));
    const ssl=[...body.matchAll(/\blisten\s+([^;]+);/g)].some(m=>/(?:^|\s)(?:[^\s:]+:)?443(?:\s|$)/.test(m[1])&&/(?:^|\s)ssl(?:\s|$)/.test(m[1]));
    if(names.includes(serverName)&&ssl)candidates.push({start:match.index,end:index+1,close:index});break;
   }
  }
 }
 if(candidates.length!==1)throw Error('Exactly one existing HTTPS server for the target is required');return candidates[0];
}
export function patchNginxConfig(source,target,options={}){
 if(typeof source!=='string'||!source.endsWith('\n'))throw Error('Nginx configuration must be complete newline-terminated text');
 const bounds=serverBounds(source,target.nginx.serverName);
 if(target.accessMode!=='PUBLIC_DEMO'&&target.nginx.authBasicRealm===EXISTING_NGINX_AUTH){
  // Only accept explicit unambiguous server directives. Complex includes or
  // inherited auth require the operator to inspect and specify exact values.
  let body=source.slice(source.indexOf('{',bounds.start)+1,bounds.close);
  body=body.replace(/#[^\n]*/g,'');
  let previous;do{previous=body;body=body.replace(/[^;{}]*\{[^{}]*\}/g,'');}while(body!==previous);
  const realms=[...body.matchAll(/(?:^|;)\s*auth_basic\s+(?:"([A-Za-z0-9 _.-]+)"|([A-Za-z0-9_.-]+))\s*;/g)];
  const files=[...body.matchAll(/(?:^|;)\s*auth_basic_user_file\s+(\/[A-Za-z0-9_./-]+)\s*;/g)];
  if(realms.length!==1||files.length!==1||realms[0][2]==='off')throw Error('Existing HTTPS Basic Auth cannot be resolved safely; inspect and configure both exact non-secret values');
  target={...target,nginx:{...target.nginx,authBasicRealm:realms[0][1]||realms[0][2],authBasicUserFile:files[0][1]}};
 }
 const block=nginxManagedBlock(target,options),begin='# BEGIN '+marker(target),end='# END '+marker(target);
 const first=source.indexOf(begin),last=source.indexOf(end);
 if((first<0)!==(last<0)||first>=0&&(source.indexOf(begin,first+1)>=0||source.indexOf(end,last+1)>=0||last<first||first<bounds.start||last>bounds.end))throw Error('Nginx managed markers are missing, misplaced or ambiguous');
 let output;
 if(first>=0){const lineStart=source.lastIndexOf('\n',first)+1,lineEnd=source.indexOf('\n',last)+1;output=source.slice(0,lineStart)+block+source.slice(lineEnd);}
 else{
  // Other servers (including the HTTP ACME/redirect server) do not own this
  // HTTPS route. Match the exact path, not a sibling such as /story-assets/.
  const route=(target.basePath||'/').replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const conflicting=new RegExp('\\blocation\\s+(?:=\\s+|\\^~\\s+)?'+route+(target.basePath?'/?':'')+'\\s*\\{');
  if(conflicting.test(source.slice(bounds.start,bounds.end)))throw Error('Unmanaged target location already exists');
  output=source.slice(0,bounds.close)+block+source.slice(bounds.close);
 }
 return {contents:output,sha256:nginxSha(output),changed:output!==source,blockSha256:nginxSha(block)};
}
export async function applyNginxConfigInPlace(filename,target,{expectedSha256,validate,reload,readBack,...options}={}){
 if(!/^[a-f0-9]{64}$/.test(expectedSha256||'')||![validate,reload,readBack].every(f=>typeof f==='function'))throw Error('Nginx SHA guard, validation, reload and mounted-file readback are mandatory');
 const info=await lstat(filename);if(!info.isFile()||info.isSymbolicLink()||await realpath(filename)!==filename)throw Error('Nginx bind source must be one canonical regular file');
 const before=await readFile(filename);if(nginxSha(before)!==expectedSha256||nginxSha(await readBack())!==expectedSha256)throw Error('Nginx host/mounted configuration SHA changed');
 if(!Buffer.from(before.toString('utf8')).equals(before))throw Error('Nginx configuration is not losslessly representable as UTF-8; no bytes were changed');
 const patch=patchNginxConfig(before.toString('utf8'),target,options),handle=await open(filename,'r+');
 const write=async bytes=>{let written=0;while(written<bytes.length){const result=await handle.write(bytes,written,bytes.length-written,written);if(!result.bytesWritten)throw Error('Short Nginx write');written+=result.bytesWritten;}await handle.truncate(bytes.length);await handle.sync();};
 let wrote=false;
 try{
  const opened=await handle.stat();if(opened.ino!==info.ino||nginxSha(await readFile(filename))!==expectedSha256)throw Error('Nginx CAS changed before write');
  wrote=true;await write(Buffer.from(patch.contents));await validate();await reload();
  if((await lstat(filename)).ino!==info.ino||nginxSha(await readBack())!==patch.sha256)throw Error('Nginx mounted readback/inode differs');
  return {status:'NGINX_APPLIED',beforeSha256:expectedSha256,afterSha256:patch.sha256,blockSha256:patch.blockSha256,inodePreserved:true,changed:patch.changed};
 }catch(error){
  if(!wrote)throw error;
  await write(before);await validate();await reload();
  if(nginxSha(await readBack())!==expectedSha256)throw Error('Nginx rollback readback failed; retain maintenance and inspect manually',{cause:error});
  throw Object.assign(error,{nginxRestored:true});
 }finally{await handle.close();}
}
