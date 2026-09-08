#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import {readRegisteredMediaBytes} from './media-read-lease.mjs';
import { isContainerStorageRuntime, resolveStorageOwner, runInstanceCli } from './transport.mjs';

const [command, ...args] = process.argv.slice(2);
const flags = {};
for (let i = 0; i < args.length; i += 2) {
  if (!args[i]?.startsWith('--') || args[i + 1] === undefined) throw new Error('Expected --flag value pairs');
  flags[args[i].slice(2)] = args[i + 1];
}
const required = (name) => { if (!flags[name]) throw new Error(`--${name} is required`); return flags[name]; };
const external = (value) => {
  if (Array.isArray(value)) return value.map(external);
  if (!value || typeof value !== 'object') return value;
  const { bytes, ...rest } = value;
  return { ...rest, ...(bytes ? { bytesBase64: Buffer.from(bytes).toString('base64') } : {}) };
};
const expected = () => { const value = required('expected-revision'); return value === 'NULL' ? null : value; };
let stdin;
const stdinBytes=()=>stdin??=(readFileSync(0));
const body = () => JSON.parse(stdinBytes().toString('utf8'));
const bytes = (input) => {
  if (typeof input.bytesBase64 !== 'string') throw new Error('stdin JSON requires bytesBase64');
  const result = Buffer.from(input.bytesBase64, 'base64');
  if (result.toString('base64') !== input.bytesBase64) throw new Error('bytesBase64 is not canonical base64');
  return result;
};
let repo;
try {
  const instancePath=required('instance');
  const write = ['aux-put', 'aux-delete', 'aux-move','read-model-cleanup','assistant-action','orchestration-write'].includes(command);
  // Direct host CLI calls share exactly the same routing boundary as Python.
  if(!isContainerStorageRuntime() && (await resolveStorageOwner(instancePath)||JSON.parse(readFileSync(instancePath+'/instance.json','utf8')).schemaVersion==='2.0')){
    const forwarded=Object.entries(flags).filter(([key])=>key!=='instance').flatMap(([key,value])=>['--'+key,value]);
    const result=await runInstanceCli(instancePath,[command,...forwarded],{input:['aux-put','read-model-cleanup','assistant-action','orchestration-write','orchestration-read'].includes(command)?stdinBytes():undefined});
    process.stdout.write(JSON.stringify(result)+'\n');
  }else{
    const {openInstanceRepository,resolveInstance,sha256,RepositoryError}=await import('./index.mjs');
    const instance=resolveInstance(instancePath);
    repo=await openInstanceRepository({...instance,readOnly:!write});
    const mismatch=(code,message)=>{throw new RepositoryError(code,message);};
    async function state(tx){
      const current=await tx.getMetadata();
      if(current.instanceId!==instance.instanceId)mismatch('INSTANCE_MISMATCH','Repository identity changed');
      if(flags['expected-runtime-epoch']!==undefined&&flags['expected-runtime-epoch']!==current.runtimeEpoch)mismatch('RUNTIME_EPOCH_CHANGED','Runtime epoch changed; restart required');
      if(flags['expected-profile-revision']!==undefined&&flags['expected-profile-revision']!==current.profileRevisionId)mismatch('PROFILE_REVISION_CHANGED','Instance profile changed; restart required');
      return current;
    }
    function checkedRecord(record){
      if(!record||record.deleted||sha256(record.bytes)!==record.sha256)mismatch('REGISTERED_BYTES_MISMATCH','Registered repository bytes failed verification');
      return record.bytes;
    }
    let result;
    if(write){
      const input=['aux-put','read-model-cleanup','assistant-action','orchestration-write'].includes(command)?body():undefined;
      result=await repo.writeTransaction(async tx=>{
        await state(tx); // Epoch check is inside the same write transaction as CAS.
        if(command==='orchestration-write')return (await import('./orchestration-service.mjs')).writeOrchestration(tx,input);
        if(command==='assistant-action')return (await import('./assistant-action-service.mjs')).executeAssistantAction(tx,input);
        if(command==='read-model-cleanup')return (await import('./read-model-cleanup.mjs')).applyReadModelCleanup(tx,instance,input);
        if(command==='aux-put')return tx.putAux({namespace:required('namespace'),key:required('key'),bytes:bytes(input),expectedRevisionId:expected(),...(input.metadata?{metadata:input.metadata}:{}),...(input.mediaType?{mediaType:input.mediaType}:{})});
        if(command==='aux-delete')return tx.deleteAux({namespace:required('namespace'),key:required('key'),expectedRevisionId:expected()});
        const moved=await tx.moveAux({fromNamespace:required('from-namespace'),fromKey:required('from-key'),fromRevisionId:required('from-revision'),toNamespace:required('to-namespace'),toKey:required('to-key')});
        return {source:external(moved.source),destination:external(moved.destination)};
      });
    }else if(command==='integrity'){
      result=await repo.readTransaction(async tx=>{await state(tx);return repo.integrityCheck();});
    }else{
      result=await repo.readTransaction(async tx=>{
        const current=await state(tx);
        switch(command){
          case 'orchestration-read': return (await import('./orchestration-service.mjs')).readOrchestration(tx,stdinBytes().length?body():{});
          case 'git-business-state': return (await import('./git-business-archive.mjs')).gitBusinessState(tx);
          case 'read-model-cleanup-plan': return (await import('./read-model-cleanup.mjs')).planReadModelCleanup(tx,instance,required('backup-sha256'));
          case 'host-profile': {
            const record=await tx.getRecord('settings','instance-profile',current.profileRevisionId);
            const profile=JSON.parse(checkedRecord(record));
            if(profile.instanceId!==current.instanceId)mismatch('INSTANCE_MISMATCH','Published profile identity mismatch');
            return {...current,profile,executionProtocol:(await import('./assistant-execution-policy.mjs')).EXECUTION_PROTOCOL};
          }
          case 'host-context': {
            const names=JSON.parse(required('aliases'));
            if(!Array.isArray(names)||!names.length||names.length>16||new Set(names).size!==names.length||names.some(alias=>typeof alias!=='string'||!alias||alias.length>1024))throw new Error('Invalid context alias list');
            const release=await tx.readRelease(current.releaseId);if(!release)mismatch('RELEASE_MISSING','No current release');
            const documents={},manifest=[];
            for(const alias of names){
              const record=await tx.getPublishedDocument(alias);
              if(!record)mismatch('CONTEXT_BINDING_MISSING','Context document lacks a unique published revision');
              const content=checkedRecord(record);
              if(content.length>65536)mismatch('CONTEXT_SIZE_LIMIT','Instruction document exceeds size limit');
              documents[alias]=new TextDecoder('utf-8',{fatal:true}).decode(content);manifest.push({path:alias,sha256:sha256(content),bytes:content.length});
            }
            if(sha256(release.snapshotBytes)!==release.snapshotSha256)mismatch('REGISTERED_BYTES_MISMATCH','Release snapshot SHA mismatch');
            const snapshot={snapshotId:release.snapshotId,sha256:release.snapshotSha256,bytes:release.snapshotBytes.length};
            manifest.push({path:'instance:current-release',sha256:snapshot.sha256,bytes:snapshot.bytes});
            return {...current,documents,manifest,snapshot};
          }
          case 'aux-get': return tx.getAux(required('namespace'),required('key'));
          case 'aux-list': {
            const records=await tx.listAux(required('namespace'),{prefix:flags.prefix||'',includeDeleted:flags['include-deleted']==='true'});
            return flags['keys-only']==='true'?records.map(record=>({key:record.key,revisionId:record.revisionId})):records;
          }
          case 'document-get': return tx.readDocument(required('alias'));
          case 'assistant-source-read': return (await import('./assistant-source.mjs')).readFrozenSourceChunk(tx,required('catalog-hash'),required('resource-id'));
          case 'assistant-source-search': return (await import('./assistant-source.mjs')).searchFrozenSourceChunks(tx,required('catalog-hash'),required('query'));
          case 'media-resolve': {
            const expectedSha=required('sha256');if(!/^[a-f0-9]{64}$/.test(expectedSha))throw new Error('Media requires SHA-256');
            const media=await tx.resolveMedia(required('alias'),{sha256:expectedSha,...(flags['version-id']?{versionId:flags['version-id']}:{})});
            if(!media||media.availability!=='PRESENT'||!media.relativePath?.startsWith('media/')||media.relativePath.split('/').some(part=>!part||part==='.'||part==='..')||media.relativePath.includes('\\'))mismatch('MEDIA_NOT_AVAILABLE','No unique registered media match');
            const content=flags['include-bytes']==='true'?await readRegisteredMediaBytes(instance.root,media,{maxBytes:Number(required('max-bytes'))}):null;
            return {...current,...(content?{bytes:content}:{}),media:{mediaId:media.mediaId,versionId:media.versionId,relativePath:media.relativePath,sha256:media.sha256,byteSize:media.byteSize,availability:media.availability}};
          }
          default: throw new Error('Unknown instance repository command');
        }
      });
    }
    process.stdout.write(JSON.stringify(external(result))+'\n');
  }
}catch(error){
  process.stderr.write(JSON.stringify({error:typeof error.code==='string'?error.code:'CLI_ERROR',message:'Instance repository command rejected'})+'\n');process.exitCode=1;
}finally{await repo?.close();}
