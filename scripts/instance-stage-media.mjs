import {copyFile,lstat,mkdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import {constants} from 'node:fs';
import {parseArgs} from 'node:util';
import {resolveInstance,openInstanceRepository,sha256} from '../host/instance-runtime/index.mjs';
import {instanceCandidateRelativePath} from '../host/instance-runtime/media-paths.mjs';
import {delegateInstanceMaintenance} from './instance-maintenance.mjs';
if(process.env.REVIEW_INSTANCE_READ_ONLY==='1'||process.env.REVIEW_REMOTE_READ_ONLY==='1')throw new Error('Read-only instance cannot stage media');
if(await delegateInstanceMaintenance('instance-stage-media.mjs',process.argv.slice(2)))process.exit(0);
const {values}=parseArgs({options:{instance:{type:'string'},source:{type:'string'},target:{type:'string'},sha256:{type:'string'}}});
if(!values.instance||!values.source||!values.target||!values.sha256)throw new Error('Explicit --instance --source --target --sha256 required');
const instance=resolveInstance(values.instance);const relative=instanceCandidateRelativePath(values.target);const repo=(await openInstanceRepository(instance));
try{
 await repo.writeTransaction(async tx=>{
 const view=(await tx.readView());const expected=(view.snapshot.productionModel.expectedOutputs||[]).filter(item=>item.targetPath===values.target);
 if(expected.length!==1||expected[0].scopeRole==='HISTORICAL'||expected[0].activityRole==='HISTORICAL_EVIDENCE'||expected[0].generationAllowed===false)throw new Error('Candidate target must bind one current ExpectedOutput');
 const info=await lstat(values.source);if(!info.isFile()||info.isSymbolicLink())throw new Error('Source must be a regular file');
 const bytes=await readFile(values.source);if(sha256(bytes)!==values.sha256)throw new Error('Source SHA mismatch');
 let directory=instance.root;for(const part of relative.split('/').slice(0,-1)){directory=path.join(directory,part);await mkdir(directory,{recursive:true});if((await lstat(directory)).isSymbolicLink())throw new Error('Symlink target is forbidden');}
 const destination=path.join(instance.root,relative);await copyFile(values.source,destination,constants.COPYFILE_EXCL);
 if(sha256(await readFile(destination))!==values.sha256)throw new Error('Copied candidate SHA mismatch');
 console.log(JSON.stringify({instanceId:instance.instanceId,logicalTarget:values.target,relativePath:relative,sha256:values.sha256,expectedOutputId:expected[0].id,registered:false,reviewed:false}));
 });
}finally{(await repo.close());}
