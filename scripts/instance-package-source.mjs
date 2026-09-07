import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile,lstat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {verifySoftwarePackage} from './instance-software-pin.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const gitBlob=bytes=>createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
const runGit=(root,args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
/** A repo above an installed review-software directory is the project repo,
 * not the software authority. Tests may supply only a read-only Git fixture. */
export async function inspectPackageSource(source,{requestedCommit,explicitDevelopment=false,gitRead=runGit}={}){
 const root=await realpath(source);
 if(requestedCommit==='UNVERSIONED'){
  if(!explicitDevelopment)throw Error('UNVERSIONED requires explicit development packaging');
  return {root,kind:'DEVELOPMENT_UNVERSIONED',softwareCommit:'UNVERSIONED'};
 }
 if(requestedCommit!=null&&!/^[a-f0-9]{40}$/.test(requestedCommit))throw Error('Published software requires an exact 40-character Git commit');
 let gitRoot=null;
 try{gitRoot=gitRead(root,['rev-parse','--show-toplevel']).trim();}catch{}
 if(gitRoot&&await realpath(gitRoot)===root){
  const head=gitRead(root,['rev-parse','--verify','HEAD']).trim(),dirty=gitRead(root,['status','--porcelain','--untracked-files=all']);
  if(!/^[a-f0-9]{40}$/.test(head)||(requestedCommit&&head!==requestedCommit)||dirty.trim())throw Error('Packaging requires the exact clean source Git commit');
  const entries=gitRead(root,['ls-tree','-r','-z','--full-tree',head]).split('\0').filter(Boolean),files=new Map();
  for(const entry of entries){const match=entry.match(/^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/);if(match)files.set(match[3],{gitBlob:match[2]});}
  return {root,kind:'EXACT_GIT_COMMIT',softwareCommit:head,files,identity:head};
 }
 const manifestPath=path.join(root,'software-manifest.json');
 try{await lstat(manifestPath);}catch(error){if(error.code==='ENOENT')throw Error('No exact source Git root or verified software manifest; use explicit UNVERSIONED for development');throw error;}
 const verified=await verifySoftwarePackage(root,{expectedCommit:requestedCommit});
 return {root,kind:'VERIFIED_SOFTWARE_PACKAGE',softwareCommit:verified.manifest.softwareCommit,files:new Map(verified.manifest.files.map(file=>[file.path,file])),identity:verified.manifestSha256};
}
export async function readPackageSource(source,relative){
 if(typeof relative!=='string'||path.isAbsolute(relative)||relative.includes('\\')||relative.split('/').some(part=>!part||part==='.'||part==='..'))throw Error('Unsafe software input path');
 const filename=path.join(source.root,relative),info=await lstat(filename);
 if(!info.isFile()||info.isSymbolicLink()||await realpath(filename)!==filename)throw Error('Software inputs must be canonical regular files: '+relative);
 const bytes=await readFile(filename);
 if(source.kind!=='DEVELOPMENT_UNVERSIONED'){
  const expected=source.files.get(relative);
  if(!expected||(expected.gitBlob?gitBlob(bytes)!==expected.gitBlob:bytes.length!==expected.bytes||hash(bytes)!==expected.sha256))throw Error('Software input differs from the frozen source identity: '+relative);
 }
 return bytes;
}
export async function assertPackageSourceUnchanged(source,{gitRead=runGit}={}){
 if(source.kind==='DEVELOPMENT_UNVERSIONED')return;
 const current=await inspectPackageSource(source.root,{requestedCommit:source.softwareCommit,gitRead});
 if(current.kind!==source.kind||current.identity!==source.identity)throw Error('Software source identity changed during packaging');
}
