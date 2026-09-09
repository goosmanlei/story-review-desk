import test from 'node:test';
import assert from 'node:assert/strict';
import {access,lstat,readFile,readdir} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import path from 'node:path';
import {digest} from '../host/instance-modern-event-validator.mjs';
import {withHistoricalEventTransport} from '../host/instance-modern-event-bridge.mjs';
import {historicalEventContextsHash} from '../host/instance-historical-event-context.mjs';

function fixture(){
  const raw=Buffer.from(JSON.stringify({message:'原始字节与字段顺序',count:1}));const compressed=gzipSync(raw,{mtime:0});
  const payload={encoding:'GZIP_BASE64',data:compressed.toString('base64'),byteSize:raw.length,compressedByteSize:compressed.length,compressedSha256:digest(compressed)};
  const bundle={schemaVersion:'HISTORICAL_EVENT_CONTEXTS_V1',instanceId:'fixture',contexts:[],releases:[{release:{releaseId:'release-fixture'},snapshotBytes:{...payload},recipesBytes:{...payload}}]};
  bundle.contextsHash=historicalEventContextsHash(bundle);return {bundle,compressed};
}

test('host transfer preserves signed bytes, deduplicates files, keeps them private and cleans success',async()=>{
  const {bundle,compressed}=fixture(),before=JSON.stringify(bundle);let directory;
  const result=await withHistoricalEventTransport(bundle,async captured=>{
    directory=captured.directory;
    assert.equal((await lstat(directory)).mode&0o077,0);
    assert.equal(historicalEventContextsHash(captured.historicalContexts),bundle.contextsHash);
    assert.equal(JSON.stringify(captured.historicalContexts).includes('"data"'),false);
    const files=await readdir(directory);assert.deepEqual(files,[digest(compressed)+'.gz']);
    const file=path.join(directory,files[0]);assert.equal((await lstat(file)).mode&0o077,0);assert.deepEqual(await readFile(file),compressed);
    return 'validated';
  });
  assert.equal(result,'validated');assert.equal(JSON.stringify(bundle),before);await assert.rejects(access(directory),{code:'ENOENT'});
});

test('host transfer cleans its own files when isolated validation fails',async()=>{
  const {bundle}=fixture();let directory;
  await assert.rejects(withHistoricalEventTransport(bundle,async captured=>{directory=captured.directory;throw Error('child validation failed');}),/child validation failed/);
  await assert.rejects(access(directory),{code:'ENOENT'});
});

test('changed payload or an input-selected file cannot reach the child callback',async()=>{
  for(const mutate of [b=>{b.releases[0].snapshotBytes.data=Buffer.from('changed').toString('base64');},b=>{b.releases[0].snapshotBytes.file='../../source.gz';},b=>{b.contextsHash='0'.repeat(64);}]){
    const {bundle}=fixture();mutate(bundle);let called=false;
    await assert.rejects(withHistoricalEventTransport(bundle,async()=>{called=true;}),/Historical event transport/);assert.equal(called,false);
  }
});
