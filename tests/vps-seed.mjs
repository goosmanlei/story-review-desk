// Synthetic-only fixture. Invoked inside a specifically named isolated owner.
import {resolveInstance,openInstanceRepository} from '../host/instance-runtime/index.mjs';
import {writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root=process.argv[2],label=process.argv[3]||'A';
if(root!=='/instance'||!['A','B','C','REMOTE_DIRT'].includes(label))throw Error('Explicit synthetic seed only');
const repository=await openInstanceRepository(resolveInstance(root));
try{
 const media=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
 const hash=createHash('sha256').update(media).digest('hex');
 await writeFile('/instance/media/fixture.png',media,{flag:'w',mode:0o600});
 await repository.writeTransaction(async tx=>{
  const current=await tx.getAux('vps-rehearsal','baseline');
  await tx.putAux({namespace:'vps-rehearsal',key:'baseline',bytes:JSON.stringify({label,frozenUrl:'/api/v8/media/original-identity',unicode:'历史字节'}),expectedRevisionId:current?.revisionId||null});
  if(label!=='REMOTE_DIRT'){
   await tx.registerMedia({mediaId:'synthetic-media',versionId:'synthetic-version',relativePath:'media/fixture.png',sha256:hash,byteSize:media.length,availability:'PRESENT',aliases:['fixtures/one-pixel.png','media/fixture.png'],metadata:{synthetic:true}});
   const view=await tx.readView(),model=structuredClone(view.snapshot.productionModel);
   model.assetVersions=[{id:'synthetic-version',familyId:'synthetic-family',path:'media/fixture.png',sha256:hash,outputState:'PRESENT',mediaType:'IMAGE',label:'synthetic pixel'}];
   await tx.publishRelease({snapshot:{...view.snapshot,snapshotId:'VPS-FIXTURE-'+label,productionModel:model},recipes:{...view.recipes,snapshotId:'VPS-FIXTURE-'+label},expectedReleaseId:view.releaseId,sourceRevisionIds:view.sourceRevisionIds||[]});
  }
 });
 console.log(JSON.stringify(await repository.getMetadata()));
}finally{await repository.close();}
