import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import { blankProfile, blankSnapshot } from '../host/instance-runtime/blank.mjs';
import { createInstanceRepository, sha256 } from '../host/instance-runtime/index.mjs';
import { instanceCandidateRelativePath } from '../host/instance-runtime/media-paths.mjs';
import { sharedStoryPostgres } from './fixtures/shared-story-postgres.mjs';

const run = (args, env) => new Promise((resolve, reject) => {
  const child = spawn('python3', args, { env }); let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
  child.on('error', reject); child.on('exit', code => resolve({ code, stdout, stderr }));
});

test('Seed Audio uses real isolated PostgreSQL Run and candidate APIs, preserving logical recipe bytes',
  { skip: process.env.REVIEW_TEST_POSTGRES !== '1', timeout: 120000 }, async () => {
  const siteRoot = path.resolve(import.meta.dirname, '..');
  assert(process.env.REVIEW_TEST_PROJECT_ROOT, 'REVIEW_TEST_PROJECT_ROOT must identify the host project explicitly');
  const project = path.resolve(process.env.REVIEW_TEST_PROJECT_ROOT);
  const parent = path.join(siteRoot, 'tests/.test-tmp'); await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(path.join(parent, 'audio-execution-'));
  const keys = ['REVIEW_INSTANCE_ROOT','REVIEW_INSTANCE_ID','REVIEW_INSTANCE_DB','REVIEW_INSTANCE_READ_ONLY',
    'REVIEW_REMOTE_READ_ONLY','REVIEW_SITE_ROOT','REVIEW_ALLOWED_ORIGINS','REVIEW_POSTGRES_HOST',
    'REVIEW_POSTGRES_PORT','REVIEW_POSTGRES_PASSWORD_FILE','REVIEW_POSTGRES_PASSWORD','REVIEW_POSTGRES_USER'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  let pg, repo, vite, http, store;
  try {
    pg = await sharedStoryPostgres(temporary);
    const profile = blankProfile({ title: '音频隔离测试' });
    await writeFile(path.join(temporary, 'instance.json'), JSON.stringify({schemaVersion:'2.0', instanceId:profile.instanceId, database:pg.database}), {flag:'wx'});
    repo = await createInstanceRepository({root:temporary, instanceId:profile.instanceId, backend:'postgres', database:pg.database, profile});
    const fixture = blankSnapshot(profile), family = 'VOICE-ISOLATED-V001', work = 'MATITEM-VOICE-ISOLATED-V001';
    const expected = `EXPECTED_OUTPUT:${family}@V001`, logical = 'production/generated/05_audio/JTA_VOICE_ISOLATED_V001.wav';
    const spec = JSON.parse(await readFile(path.join(project,'data/seed_audio_assets.example.json'),'utf8')).assets[0];
    Object.assign(spec, {asset_id:family, name_zh:'隔离合成测试', output_path:logical, execution_gate:'READY_TO_START',
      text_prompt:'生成一段原创测试声音。', negative_prompt:'不模仿真人。', references:[]});
    const definition = {id:'CALL:TESTAUDIO', definitionStatus:'DEFINED', definitionHash:'a'.repeat(64), workItemRef:work,
      declaredGate:'READY_TO_START', model:{branch:'seed-audio-1.0'}, prompt:{main:spec.text_prompt,negative:spec.negative_prompt},
      parametersRaw:JSON.stringify({audio_config:spec.audio_config,delivery:spec.delivery}), upload:{items:[]},
      output:{path:logical,mediaType:'AUDIO',assetFamilyRef:family,expectedOutputRef:expected}};
    fixture.recipes.executionDefinitions.push(definition);
    fixture.snapshot.productionModel.assetFamilies.push({id:family,label:'隔离测试声音',mediaType:'AUDIO',versionRefs:[],expectedOutputRefs:[expected],
      currentExpectedOutputId:expected,currentVersionId:null,usedByRefs:[],lifecycleState:'READY_TO_START',outputState:'NOT_PRODUCED'});
    fixture.snapshot.productionModel.expectedOutputs.push({id:expected,familyId:family,targetPath:logical,legacyVersionId:`${family}@V001`,mediaType:'AUDIO'});
    fixture.snapshot.productionModel.materialWorkItems.push({id:work,label:'隔离测试声音',outputAssetRef:family,inputAssetRefs:[],executionDefinitionRef:definition.id,
      declaredExecutionGate:'READY_TO_START',flowBlockReasons:[]});
    await repo.writeTransaction(tx => tx.publishRelease({...fixture,expectedReleaseId:null}));
    const before = await repo.readRelease();
    Object.assign(process.env,{REVIEW_INSTANCE_ROOT:temporary,REVIEW_INSTANCE_ID:profile.instanceId,REVIEW_INSTANCE_DB:'',
      REVIEW_INSTANCE_READ_ONLY:'',REVIEW_REMOTE_READ_ONLY:'',REVIEW_SITE_ROOT:siteRoot});
    vite = await createServer({root:siteRoot,configFile:false,logLevel:'error',cacheDir:path.join(temporary,'vite'),server:{middlewareMode:true},appType:'custom'});
    store = await vite.ssrLoadModule('/app/api/v8/_store.ts');
    http = createHttpServer(async (req,res) => {
      try {
        const url = new URL(req.url, origin), pathname = url.pathname;
        const route = pathname.startsWith('/api/v8/recipes/') ? '/api/v8/recipes/[id]' : pathname;
        const module = await vite.ssrLoadModule(`/app${route}/route.ts`);
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const request = new Request(url,{method:req.method,headers:req.headers,...(chunks.length?{body:Buffer.concat(chunks)}:{})});
        const response = await module[req.method](request,{params:Promise.resolve({id:decodeURIComponent(pathname.split('/').at(-1))})});
        res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
      } catch(error) {res.writeHead(500);res.end(String(error.stack));}
    });
    await new Promise(resolve => http.listen(0,'127.0.0.1',resolve));
    const origin = `http://127.0.0.1:${http.address().port}`;process.env.REVIEW_ALLOWED_ORIGINS=origin;
    const get = async p => {const r=await fetch(origin+p);const b=await r.json();assert.equal(r.status,200,JSON.stringify(b));return b;};
    const post = async (p,body,key) => {const ops=await get('/api/v8/operations/snapshot');const r=await fetch(origin+p,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,'If-Match':ops.mutationEtag,'Idempotency-Key':key},body:JSON.stringify({snapshotId:fixture.snapshot.snapshotId,...body})});const b=await r.json();assert(r.ok,JSON.stringify(b));return b;};
    const request = await post('/api/v8/execution-requests',{action:'AUTHORIZE',workItemId:work,familyId:family,executor:'CODEX',authorized:true,maxOutputs:1,
      executionDefinitionId:definition.id,callPackageHash:definition.definitionHash,inputBindings:[]},'test-audio-authorize');
    await post('/api/v8/execution-requests',{action:'CLAIM',executionRequestId:request.executionRequestId,claimedBy:'isolated-test'},'test-audio-claim');
    const specPath=path.join(temporary,'spec.json');await writeFile(specPath,JSON.stringify({assets:[spec]}),{flag:'wx'});
    // Only the provider boundary is replaced; every localhost HTTP request and
    // PostgreSQL write below is the production implementation.
    const python = `import sys,io,wave\nsys.path.insert(0,sys.argv[1])\nimport generate_seed_audio as s\nb=io.BytesIO()\nwith wave.open(b,'wb') as w:\n w.setnchannels(1);w.setsampwidth(2);w.setframerate(48000);w.writeframes(bytes(48000))\ns.api_request=lambda *a,**kw:dict(audio=b.getvalue(),request_id='synthetic-request',log_id='synthetic-log',duration=0.5,original_duration=0.5,url_present=False,subtitle=None)\nsys.exit(s.main(sys.argv[2:]))`;
    const args=['-c',python,path.join(project,'scripts'),'--spec',specPath,'--instance',temporary,'--asset',family,'--execution-request-id',request.executionRequestId,
      '--base-url',origin,'--execute','--register-candidate'];
    const result=await run(args,{...process.env,VOLCENGINE_SPEECH_API_KEY:'synthetic-never-sent',OPENAI_API_KEY:''});
    assert.equal(result.code,0,result.stderr+'\n'+result.stdout);
    const output=JSON.parse(result.stdout).results[0], managed=instanceCandidateRelativePath(logical,family);
    assert.equal(output.candidate,managed);assert.equal(output.run_state,'SUCCEEDED');
    const versions=await get('/api/v8/asset-versions?familyId='+family);assert.equal(versions.events.length,1);
    const event=versions.events[0];assert.equal(event.path,logical);assert.equal(event.sha256,sha256(await readFile(path.join(temporary,managed))));
    const media=await repo.resolveMedia(event.versionId,{sha256:event.sha256});assert.equal(media.relativePath,managed);
    const ops=await get('/api/v8/operations/snapshot');assert.equal(ops.stateProjection.assetVersionsById[event.versionId].lifecycleState,'REVIEW_PENDING');
    assert.equal(ops.stateProjection.assetFamiliesById[family].currentExpectedOutputId,null);
    assert.equal(ops.stateProjection.expectedOutputsById[expected].realizedVersionId,event.versionId);
    const after=await repo.readRelease();assert.deepEqual(after.snapshotBytes,before.snapshotBytes);assert.deepEqual(after.recipesBytes,before.recipesBytes);
    const retry=await run(args,{...process.env,VOLCENGINE_SPEECH_API_KEY:'synthetic-never-sent'});assert.equal(retry.code,2);
    assert.equal((await repo.listEvents('asset-version')).length,1);
  } finally {
    if(http)await new Promise(resolve=>http.close(resolve));await (await store?.instanceRepository())?.close();await repo?.close();await vite?.close();await pg?.cleanup();
    for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}
    await rm(temporary,{recursive:true,force:true});
  }
});
