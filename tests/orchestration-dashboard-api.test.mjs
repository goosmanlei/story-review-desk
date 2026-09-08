import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServer} from 'vite';
import {blankProfile, blankSnapshot} from '../host/instance-runtime/blank.mjs';
import {createInstanceRepository} from '../host/instance-runtime/index.mjs';
import {ORCHESTRATION_NAMESPACE} from '../host/instance-runtime/orchestration-service.mjs';
import {dashboardRecords} from './fixtures/orchestration-dashboard.mjs';

test('GET uses only the explicit instance, preserves the ledger, filters private fields, and rejects hosted/foreign queries before reading',async () => {
  const root=process.cwd(),tmp=await realpath(await mkdtemp(path.join(tmpdir(),'orchestration-api-'))),repos=[];
  const keys=['REVIEW_INSTANCE_DB','REVIEW_INSTANCE_ID','REVIEW_INSTANCE_ROOT','REVIEW_INSTANCE_READ_ONLY','REVIEW_REMOTE_READ_ONLY','REVIEW_SITE_ROOT','REVIEW_EXPORT_DIR'];
  const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  let server,store;
  try {
    for(const id of ['first','second']){
      const profile=blankProfile({instanceId:'api-'+id,projectId:'project-'+id});
      const dbPath=path.join(tmp,id+'.sqlite'),repo=createInstanceRepository({dbPath,instanceId:profile.instanceId,profile});
      await repo.writeTransaction(tx=>tx.publishRelease({...blankSnapshot(profile),expectedReleaseId:null}));
      if(id==='first'){
        const fixture=dashboardRecords(await repo.readTransaction(tx=>tx.getMetadata()));
        await repo.writeTransaction(async tx=>{for(const [key,value] of fixture.rows)await tx.putAux({namespace:ORCHESTRATION_NAMESPACE,key,bytes:JSON.stringify(value),expectedRevisionId:null});});
      }
      repos.push({repo,dbPath,profile});
    }
    Object.assign(process.env,{REVIEW_SITE_ROOT:root,REVIEW_INSTANCE_ROOT:'',REVIEW_REMOTE_READ_ONLY:'',REVIEW_INSTANCE_READ_ONLY:'',REVIEW_EXPORT_DIR:'',REVIEW_INSTANCE_DB:repos[0].dbPath,REVIEW_INSTANCE_ID:repos[0].profile.instanceId});
    server=await createServer({root,configFile:false,logLevel:'error',cacheDir:path.join(tmp,'vite-cache'),server:{middlewareMode:true},appType:'custom'});
    store=await server.ssrLoadModule('/app/api/v8/_store.ts');
    const route=await server.ssrLoadModule('/app/api/instance/orchestration/route.ts');
    const get=(query='')=>route.GET(new Request('http://localhost:4000/api/instance/orchestration'+query));
    assert.deepEqual(Object.keys(route),['GET']);
    const before=await repos[0].repo.readTransaction(tx=>tx.getMetadata());
    const response=await get();assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
    const value=await response.json();assert.equal(value.instanceId,'api-first');assert.equal(value.readOnly,true);assert.equal(value.completed.total,23);assert.equal(value.completed.tasks.length,20);
    assert.doesNotMatch(JSON.stringify(value),/SENTINEL|capabilityToken|tokenHash|token|inputs|worktree|\/private|threadId|authorization/i);
    const history=await (await get('?completedPage=1')).json();assert.equal(history.completed.tasks.length,3);assert.ok(history.completed.tasks.some(t=>t.status==='CANCELLED'));
    for(const query of ['?instance=/private/other','?taskId=working','?completedPage=-1','?completedPage=0&completedPage=1','?completedPage=1000001','?completedPage=no'])assert.equal((await get(query)).status,400);
    assert.deepEqual(await repos[0].repo.readTransaction(tx=>tx.getMetadata()),before);
    Object.assign(process.env,{REVIEW_INSTANCE_DB:repos[1].dbPath,REVIEW_INSTANCE_ID:repos[1].profile.instanceId});
    const empty=await (await get()).json();assert.equal(empty.instanceId,'api-second');assert.equal(empty.completed.total,0);assert.equal(empty.processing.length,0);assert.equal(empty.autoRefresh,false);
    // A deliberately invalid local binding must never be resolved in hosted mode.
    Object.assign(process.env,{REVIEW_REMOTE_READ_ONLY:'1',REVIEW_INSTANCE_ROOT:'/PRIVATE_BINDING_SENTINEL'});
    const hosted=await get('?completedPage=0');assert.equal(hosted.status,405);assert.deepEqual(await hosted.json(),{error:'多 Agent 协作状态仅在本地实例可用'});
    process.env.REVIEW_REMOTE_READ_ONLY='';
    const failure=await get();assert.equal(failure.status,503);assert.doesNotMatch(await failure.text(),/PRIVATE_BINDING|SENTINEL|ENOENT|path|stack|\/private/);
  } finally {
    process.env.REVIEW_REMOTE_READ_ONLY='';process.env.REVIEW_INSTANCE_ROOT='';
    if(store){Object.assign(process.env,{REVIEW_INSTANCE_DB:repos[1].dbPath,REVIEW_INSTANCE_ID:repos[1].profile.instanceId});await (await store.instanceRepository())?.close();}
    await server?.close();for(const {repo} of repos)await repo.close();
    for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}
    await rm(tmp,{recursive:true,force:true});
  }
});
