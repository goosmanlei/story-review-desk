import {createHash} from 'node:crypto';
import {lstat,readFile,readdir,realpath} from 'node:fs/promises';
import path from 'node:path';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function exactFile(root,relative){
 if(typeof relative!=='string'||path.isAbsolute(relative)||relative.includes('\\')||relative.split('/').some(part=>!part||part==='.'||part==='..'))throw Error('Unsafe built artifact path');
 const filename=path.join(root,relative),info=await lstat(filename);
 if(!info.isFile()||info.isSymbolicLink()||await realpath(filename)!==filename)throw Error('Built runtime input must be canonical: '+relative);
 return {bytes:await readFile(filename),size:info.size};
}
/** Bind the emitted public bytes, not merely the export checked before npm ci. */
export async function assertHostedBuildOutput(built,exported){
 const client=path.join(await realpath(built),'client');
 if(!(await lstat(client)).isDirectory()||(await lstat(client)).isSymbolicLink()||await realpath(client)!==client)throw Error('Sites client assets are missing');
 const runtime=JSON.parse((await exactFile(client,'runtime/manifest.json')).bytes);
 const manifest=exported.manifest;
 if(runtime.mode!=='HOSTED_READ_ONLY'||runtime.snapshotId!==manifest.snapshotId||runtime.recipeSnapshotId!==manifest.snapshotId||runtime.exportManifestSha256!==manifest.manifestSha256||['instanceId','releaseId','repositoryRevision'].some(key=>runtime[key]!==manifest[key]))throw Error('Built runtime differs from the frozen export identity');
 const files=manifest.files,expectedNames=new Set(files.map(file=>file.path));
 if(!Array.isArray(runtime.files)||runtime.files.length!==files.length||new Set(runtime.files.map(file=>file.filename)).size!==files.length||runtime.files.some(file=>!expectedNames.has(file.filename)))throw Error('Built runtime file inventory differs');
 const names=await readdir(path.join(client,'runtime'));
 if(names.length!==files.length+1||names.some(name=>name!=='manifest.json'&&!expectedNames.has(name)))throw Error('Unlisted built runtime asset');
 for(const expected of files){
  const record=runtime.files.find(file=>file.filename===expected.path),actual=await exactFile(client,'runtime/'+expected.path);
  if(record.sha256!==expected.sha256||record.sizeBytes!==expected.bytes||actual.size!==expected.bytes||sha(actual.bytes)!==expected.sha256)throw Error('Built public snapshot bytes differ: '+expected.path);
 }
 const expectedMedia=manifest.media.map(({url,path:exportPath,sha256,bytes})=>({url,path:exportPath,sha256,bytes}));
 if(JSON.stringify(runtime.media)!==JSON.stringify(expectedMedia))throw Error('Built media manifest differs');
 const mediaFiles=new Set();
 for(const media of manifest.media){
  if(!media.url.startsWith('/media/'))throw Error('Invalid public media alias');
  const relative=media.url.slice(1),actual=await exactFile(client,relative);mediaFiles.add(relative);
  if(actual.size!==media.bytes||sha(actual.bytes)!==media.sha256)throw Error('Built public media bytes differ: '+relative);
 }
 async function mediaInventory(relative){
  for(const entry of await readdir(path.join(client,relative),{withFileTypes:true})){
   const name=relative+'/'+entry.name;
   if(entry.isSymbolicLink())throw Error('Built media symlink is forbidden');
   if(entry.isDirectory())await mediaInventory(name);
   else if(!entry.isFile()||!mediaFiles.delete(name))throw Error('Unlisted built public media: '+name);
  }
 }
 try{await lstat(path.join(client,'media'));await mediaInventory('media');}catch(error){if(error.code!=='ENOENT')throw error;}
 if(mediaFiles.size)throw Error('Built public media is incomplete');
 return {client,snapshotId:runtime.snapshotId,exportManifestSha256:runtime.exportManifestSha256};
}
export function assertHostedExportUnchanged(before,after){
 if(before.manifest.manifestSha256!==after.manifest.manifestSha256)throw Error('Hosted export changed during the build');
}
