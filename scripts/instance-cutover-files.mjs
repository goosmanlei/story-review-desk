/** Preserve long-lived Docker Desktop bind directory identities during cutover. */
import {readFile,writeFile,lstat,realpath,mkdir,readdir,copyFile,chmod,rename,rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {canonicalJson,sha256} from '../host/instance-runtime/bytes.mjs';
import {docker} from './instance-postgres.mjs';
const check=(ok,message)=>{if(!ok)throw new Error(message);};
async function regular(file){const info=await lstat(file);check(info.isFile()&&!info.isSymbolicLink()&&await realpath(file)===file,'Unsafe cutover file');return readFile(file);}
async function exists(file){try{return await lstat(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function fileTree(root,relative=''){
 const directory=path.join(root,relative),info=await lstat(directory);check(info.isDirectory()&&!info.isSymbolicLink()&&await realpath(directory)===directory,'Unsafe cutover directory');const files=[];
 for(const name of (await readdir(directory)).sort()){const child=path.join(relative,name),stat=await lstat(path.join(root,child));check(!stat.isSymbolicLink(),'Cutover refuses symbolic links');if(stat.isDirectory())files.push(...await fileTree(root,child));else{const bytes=await regular(path.join(root,child));files.push({path:child,bytes:bytes.length,sha256:sha256(bytes)});}}
 return files;
}
export async function stableRootInputs(sourceRoot,stageRoot){
 const sourceBootstrap=await regular(path.join(sourceRoot,'instance.json')),stageBootstrap=await regular(path.join(stageRoot,'instance.json')),proof=await regular(path.join(stageRoot,'data/restore-proof.json'));
 const sourcePassword=path.join(sourceRoot,'runtime/private/postgres-password'),stagePassword=await regular(path.join(stageRoot,'runtime/private/postgres-password')),passwordInfo=await exists(sourcePassword);
 if(passwordInfo){check(!(passwordInfo.mode&0o077)&&(await regular(sourcePassword)).equals(stagePassword),'Prepared PostgreSQL password differs from the staged secret');}
 check((await readdir(path.join(stageRoot,'data'))).every(name=>name==='restore-proof.json'),'Stage contains unplanned local database controls');
 const mediaFiles=await fileTree(stageRoot,'media');for(const file of mediaFiles){const bytes=await regular(path.join(sourceRoot,file.path));check(bytes.length===file.bytes&&sha256(bytes)===file.sha256,'Staged media is missing or differs at the stable formal path: '+file.path);}
 const inodePaths=['','instance.json','data','media','scratch','backups','runtime','runtime/locks','runtime/assistant','runtime/assistant/public','runtime/private'];const inodes={};for(const relative of inodePaths){const file=path.join(sourceRoot,relative),info=await lstat(file);check(!info.isSymbolicLink()&&await realpath(file)===file,'Stable cutover path must be canonical');inodes[relative||'.']={dev:info.dev,ino:info.ino};}
 return {sourceBootstrapSha256:sha256(sourceBootstrap),stageBootstrapSha256:sha256(stageBootstrap),restoreProofSha256:sha256(proof),mediaFileCount:mediaFiles.length,mediaManifestSha256:sha256(canonicalJson(mediaFiles)),passwordPrepared:Boolean(passwordInfo),inodes};
}
export async function frozenSqliteFiles(root){const files=await fileTree(root,'data');check(files.some(file=>file.path==='data/review.sqlite')&&files.every(file=>/^data\/review\.sqlite(?:-wal|-shm)?$/.test(file.path)),'Frozen SQLite data contains unplanned files');return files;}
async function copyArchiveTree(source,target){
 const info=await lstat(source);check(!info.isSymbolicLink(),'Rollback archive refuses symlinks');if(info.isDirectory()){await mkdir(target,{mode:info.mode&0o777});for(const name of await readdir(source))await copyArchiveTree(path.join(source,name),path.join(target,name));return;}
 check(info.isFile(),'Rollback archive accepts only regular files');await copyFile(source,target,constants.COPYFILE_EXCL);await chmod(target,info.mode&0o777);check((await regular(source)).equals(await regular(target)),'Rollback archive bytes differ');
}
/** State is mutated before each reversible action so partial failures also restore. */
export async function switchStableRoot(plan,state,persist=async()=>{},verifyFrozen=async()=>{}){
 const current=await stableRootInputs(plan.sourceRoot,plan.stageRoot);check(canonicalJson(current)===canonicalJson(plan.stableFiles),'Stable-root files changed after the final freeze');
 const source=plan.sourceRoot,archive=plan.archiveRoot,stage=plan.stageRoot;
 const frozenFiles=await frozenSqliteFiles(source);if(state.sourceDataFiles)check(canonicalJson(state.sourceDataFiles)===canonicalJson(frozenFiles),'Frozen SQLite controls changed before archival');else state.sourceDataFiles=frozenFiles;await persist();
 await mkdir(archive,{mode:0o700});state.archiveCreated=true;await persist();
 await copyArchiveTree(path.join(source,'instance.json'),path.join(archive,'instance.json'));
 await copyArchiveTree(path.join(source,'runtime'),path.join(archive,'runtime'));
 await mkdir(path.join(archive,'data'),{mode:0o700});state.archiveReady=true;state.movedData=[];await persist();
 await writeFile(path.join(archive,'cutover-rollback.json'),JSON.stringify({schemaVersion:'1.0',kind:'IN_PLACE_LOCATOR_ROLLBACK',sourceRoot:source,stageRoot:stage,planSha256:plan.planSha256,mediaRetainedAt:source+'/media',completeBackup:'See the execution journal frozenBackup; this control archive is not a standalone instance backup.'},null,2)+'\n',{flag:'wx',mode:0o600});
 // Archiving private runtime state can take time. Recheck the exact stopped
 // owner and frozen database bytes immediately before the first source move.
 await verifyFrozen();check(canonicalJson(await frozenSqliteFiles(source))===canonicalJson(state.sourceDataFiles),'Frozen SQLite controls changed during rollback archival');
 for(const file of state.sourceDataFiles){await rename(path.join(source,file.path),path.join(archive,file.path));state.movedData.push(file.path);await persist();}
 const password=path.join(source,'runtime/private/postgres-password'),stagePassword=await regular(path.join(stage,'runtime/private/postgres-password'));
 if(!current.passwordPrepared){state.passwordCreated=true;await persist();await writeFile(password,stagePassword,{flag:'wx',mode:0o600});}else check((await regular(password)).equals(stagePassword),'Prepared PostgreSQL secret changed');
 state.proofCopied=true;await persist();await copyFile(path.join(stage,'data/restore-proof.json'),path.join(source,'data/restore-proof.json'),constants.COPYFILE_EXCL);
 // A stopped older container may retain an individual file bind. Update the
 // existing file inode as well as retaining all ancestor directory inodes.
 state.locatorChanged=true;await persist();await writeFile(path.join(source,'instance.json'),await regular(path.join(stage,'instance.json')));
 state.ownerRemoved=true;await persist();await rm(path.join(source,'runtime/storage-owner.json'));
 await assertStableInodes(plan);
}
export async function assertStableInodes(plan){for(const [relative,expected] of Object.entries(plan.stableFiles.inodes)){const info=await lstat(path.join(plan.sourceRoot,relative));check(info.dev===expected.dev&&info.ino===expected.ino,'A long-lived Docker bind path inode changed: '+relative);}}
export async function restoreStableRoot(plan,state){
 const source=plan.sourceRoot,archive=plan.archiveRoot;
 if(state.locatorChanged)await writeFile(path.join(source,'instance.json'),await regular(path.join(archive,'instance.json')));
 if(state.proofCopied){const proof=path.join(source,'data/restore-proof.json');if(await exists(proof)){check(sha256(await regular(proof))===plan.stableFiles.restoreProofSha256,'Rollback refuses changed restore proof');await rm(proof);}}
 for(const relative of [...(state.movedData||[])].reverse()){check(!await exists(path.join(source,relative)),'Rollback refuses to overwrite a new SQLite file');await rename(path.join(archive,relative),path.join(source,relative));}
 if(state.ownerRemoved)await writeFile(path.join(source,'runtime/storage-owner.json'),await regular(path.join(archive,'runtime/storage-owner.json')),{mode:0o600});
 if(state.passwordCreated){const secret=path.join(source,'runtime/private/postgres-password');if(await exists(secret)){check((await regular(secret)).equals(await regular(path.join(plan.stageRoot,'runtime/private/postgres-password'))),'Rollback secret changed');await rm(secret);}}
 await assertStableInodes(plan);
}
/** Daemon-side parent-directory probe; secret hashes/bytes are never logged. */
export async function probeStableRoot(plan,{postgres=true,image='node:22-bookworm-slim',fileState={}}={}){
 const sourceDataFiles=fileState.sourceDataFiles||(postgres?[{path:'data/review.sqlite'},{path:'data/review.sqlite-wal'},{path:'data/review.sqlite-shm'}]:await frozenSqliteFiles(plan.sourceRoot));
 const root=plan.sourceRoot,mediaFiles=await fileTree(plan.stageRoot,'media'),files=[{path:'instance.json',sha256:postgres?plan.stableFiles.stageBootstrapSha256:plan.stableFiles.sourceBootstrapSha256},...mediaFiles];
 if(postgres)files.push({path:'data/restore-proof.json',sha256:plan.stableFiles.restoreProofSha256},{path:'runtime/private/postgres-password',sha256:sha256(await regular(path.join(plan.stageRoot,'runtime/private/postgres-password')))});else files.push(...sourceDataFiles);
 const missing=postgres?['data/review.sqlite','data/review.sqlite-wal','data/review.sqlite-shm']:['data/restore-proof.json'];
 const script="const fs=require('node:fs'),crypto=require('node:crypto');const p=JSON.parse(fs.readFileSync(0));const rows=p.files.map(f=>{let matches=false;try{matches=crypto.createHash('sha256').update(fs.readFileSync('/probe/'+f.path)).digest('hex')===f.sha256;}catch{}return {path:f.path,matches};});const matches=rows.every(r=>r.matches),missing=p.missing.every(f=>!fs.existsSync('/probe/'+f));const checks=Object.fromEntries(['instance.json','data/','media/','runtime/private/'].map(prefix=>[prefix,rows.filter(r=>r.path.startsWith(prefix)).every(r=>r.matches)]));process.stdout.write(JSON.stringify({matches,missing,checks,filesChecked:p.files.length}));";
 let result;
 // Docker Desktop's metadata view may lag an unlink briefly. Re-read only;
 // never start a database/app or relax the expected bytes until it agrees.
 for(let attempt=0;attempt<5;attempt++){
  try{result=JSON.parse(await docker(['run','--rm','-i','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--mount',`type=bind,source=${root},target=/probe,readonly`,image,'node','-e',script],{input:JSON.stringify({files,missing}),timeout:180000}));}catch(error){throw Object.assign(new Error('Docker daemon could not verify stable bootstrap, data, media and secret bytes'),{code:'CUTOVER_BIND_PROBE_FAILED',detail:error.detail});}
  if(result.matches&&result.missing)return {...result,attempts:attempt+1};
  if(attempt<4)await new Promise(resolve=>setTimeout(resolve,300));
 }
 throw Object.assign(new Error('Docker daemon reads a different instance tree'),{code:'CUTOVER_BIND_BYTES_MISMATCH',detail:JSON.stringify(result)});
}
