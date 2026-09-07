import {createHash} from 'node:crypto';
import {readFile,lstat,realpath,readdir} from 'node:fs/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const cacheRoots=new Set(['node_modules','dist','.next','.vinext','.wrangler']);
const generatedNames=new Set(['review-data-core.generated.json','review-data-production-a.generated.json','review-data-production-b.generated.json','review-recipes.generated.json','hosted-material-events.generated.json']);
async function verifyExtraFiles(software,managed){
 async function walk(relative=''){
  for(const entry of await readdir(path.join(software,relative),{withFileTypes:true})){
   const name=relative?relative+'/'+entry.name:entry.name,filename=path.join(software,name),info=await lstat(filename);
   if(info.isSymbolicLink()||(await realpath(filename))!==filename)throw Error('Package symlink is forbidden: '+name);
   if(info.isDirectory()){if(!cacheRoots.has(name))await walk(name);continue;}
   if(!info.isFile())throw Error('Package input must be regular: '+name);
   if(name==='software-manifest.json'||managed.has(name))continue;
   if(/^host\/__pycache__\/[A-Za-z0-9_]+\.cpython-\d+(?:\.opt-\d+)?\.pyc$/.test(name))continue;
   const generated=name==='app/review-data.generated.json'
    ||name.startsWith('data/')&&generatedNames.has(name.slice(5))
    ||name.startsWith('public/runtime/')&&(generatedNames.has(name.slice(15))||name==='public/runtime/manifest.json');
   if(generated&&info.size<=16*1024*1024){
    const payload=JSON.parse(await readFile(filename,'utf8'));if(payload.snapshotId==='REVIEW-EMPTY-V1')continue;
   }
   throw Error('Unmanaged software file: '+name);
  }
 }
 await walk();
}
export async function verifySoftwarePackage(softwarePath,{expectedCommit,allowUnversioned=false}={}) {
 const software=path.resolve(softwarePath);
 if((await realpath(software))!==software||(await lstat(software)).isSymbolicLink())throw Error('Pinned package cannot be a symlink');
 const manifestPath=path.join(software,'software-manifest.json'),manifestInfo=await lstat(manifestPath);
 if(!manifestInfo.isFile()||manifestInfo.isSymbolicLink())throw Error('Manifest must be a regular file');
 const bytes=await readFile(manifestPath),manifest=JSON.parse(bytes);
 if(manifest.kind!=='STORY_NEUTRAL_SOFTWARE'||!(/^[a-f0-9]{40}$/.test(manifest.softwareCommit||'')||(allowUnversioned&&manifest.softwareCommit==='UNVERSIONED'))||(expectedCommit&&manifest.softwareCommit!==expectedCommit)||manifest.copiedBusinessData!==false||manifest.copiedCredentials!==false||!Array.isArray(manifest.productionStorySpecificHits)||manifest.productionStorySpecificHits.length||!Array.isArray(manifest.files)||!manifest.files.length)throw Error('Pinned package manifest differs');
 const seen=new Set();
 for(const file of manifest.files){
  if(typeof file.path!=='string'||path.isAbsolute(file.path)||file.path.includes('\\')||file.path.split('/').some(s=>!s||s==='.'||s==='..')||seen.has(file.path)||!Number.isSafeInteger(file.bytes)||file.bytes<0||!/^[a-f0-9]{64}$/.test(file.sha256||''))throw Error('Invalid manifest file entry');
  seen.add(file.path);const filename=path.join(software,file.path),info=await lstat(filename);
  if(!info.isFile()||info.isSymbolicLink()||(await realpath(filename))!==filename||info.size!==file.bytes||hash(await readFile(filename))!==file.sha256)throw Error('Managed software changed: '+file.path);
 }
 await verifyExtraFiles(software,seen);
 return {software,manifest,manifestSha256:hash(bytes)};
}
export async function verifySoftwarePin(projectPath) {
 const project=await realpath(path.resolve(projectPath)),pinPath=path.join(project,'core-lock.json');
 if(!(await lstat(pinPath)).isFile()||(await lstat(pinPath)).isSymbolicLink())throw Error('Core pin must be a regular file');
 const pin=JSON.parse(await readFile(pinPath,'utf8'));
 if(pin.schemaVersion!=='1.0'||pin.kind!=='CORE_SOFTWARE_PIN'||pin.packagePath!=='review-software'||!/^[a-f0-9]{40}$/.test(pin.commit||'')||!/^[a-f0-9]{64}$/.test(pin.softwareManifestSha256||'')||!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(pin.repository||''))throw Error('Invalid exact core pin');
 const result=await verifySoftwarePackage(path.join(project,pin.packagePath),{expectedCommit:pin.commit});
 if(result.manifestSha256!==pin.softwareManifestSha256)throw Error('Pinned package manifest differs');
 return {project,software:result.software,pin,manifest:result.manifest};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const {values}=parseArgs({options:{project:{type:'string'}}});if(!values.project)throw Error('--project is required');
 const result=await verifySoftwarePin(values.project);console.log(JSON.stringify({state:'SOFTWARE_PIN_VERIFIED',coreCommit:result.pin.commit,softwareManifestSha256:result.pin.softwareManifestSha256,fileCount:result.manifest.files.length}));
}
