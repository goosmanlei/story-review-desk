import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createInstanceRepository,canonicalJson,sha256} from '../host/instance-runtime/index.mjs';
import {blankProfile,blankSnapshot} from '../host/instance-runtime/blank.mjs';
import {planInstanceExtension} from '../host/instance-extension-controller.mjs';

async function fixture(t){
  const parent=path.resolve(import.meta.dirname,'.test-tmp');await mkdir(parent,{recursive:true});
  const root=await mkdtemp(path.join(parent,'historical-source-capture-'));
  const profile=blankProfile({title:'Historical source capture fixture'});
  profile.sourceBindings.derivedRegistryPaths=Array.from({length:9},(_,i)=>`registry/${i}.json`);
  const repo=await createInstanceRepository({dbPath:path.join(root,'fixture.sqlite'),instanceId:profile.instanceId,profile});
  t.after(async()=>{await repo.close();await rm(root,{recursive:true,force:true});});
  const compiler={workflowPath:'scripts/review_workflow.py',storyQaPath:'scripts/qa_story_structure_v2.py',registryBuilderPath:'scripts/build_production_control_registries.py',snapshotBuilderPath:'scripts/build_review_site_data.py',semanticQaPath:'scripts/qa_review_site_v8.py',snapshotPath:'registry/snapshot.json',recipesPath:'registry/recipes.json',eventDirectory:'events'};
  const {snapshot,recipes}=blankSnapshot(profile);
  snapshot.productionModel.historicalFixtureValue='before-realization';
  await repo.writeTransaction(async tx=>{
    const sourceRevisionIds=[];
    for(const alias of [...Object.values(compiler).filter(p=>p.endsWith('.py')),...profile.sourceBindings.derivedRegistryPaths,'scripts/adapter.py']){
      const doc=await tx.putDocument({documentId:'fixture:'+alias,aliases:[alias],bytes:alias.endsWith('.py')?'# original fixture\n':'{}',expectedRevisionId:null,metadata:{sourceRole:alias.endsWith('.py')?'INSTANCE_EXTENSION':'SOURCE_DOCUMENT'}});sourceRevisionIds.push(doc.revisionId);
    }
    await tx.publishRelease({snapshot,recipes,expectedReleaseId:null,sourceRevisionIds});
  });
  const historicalRelease=await repo.readRelease();
  // The production contract rejects ambiguous millisecond ties. This fixture
  // deliberately creates distinguishable real publication/event timestamps.
  await delay(3);
  const payload={schemaVersion:'2.0',snapshotId:historicalRelease.snapshotId,creationSnapshotId:historicalRelease.snapshotId,subjectKind:'SCENE_COVERAGE',scopedReviewSpec:{schemaVersion:'2.0'}};
  const {event}=await repo.writeTransaction(tx=>tx.appendEvent({kind:'creative-revision',idempotencyKey:'fixture:historical-candidate',requestHash:sha256(canonicalJson(payload)),eventSchemaVersion:'2.0',authorityDomain:'FORMAL',payload}));
  await repo.writeTransaction(async tx=>{
    const view=await tx.readView(),next=structuredClone(view.snapshot);next.productionModel.historicalFixtureValue='after-realization';
    await tx.publishRelease({snapshot:next,recipes:view.recipes,expectedReleaseId:view.releaseId,sourceRevisionIds:view.sourceRevisionIds});
  });
  const current=await repo.readRelease(),adapter=await repo.readDocument('scripts/adapter.py'),content='# updated fixture\n';
  const manifest={schemaVersion:'1.0',operationId:'fixture-historical-adapter-plan',instanceId:profile.instanceId,baseReleaseId:current.releaseId,softwareCommit:'a'.repeat(40),compiler,extensions:[{alias:'scripts/adapter.py',oldRevisionId:adapter.revisionId,oldSha:adapter.sha256,newSha:sha256(content),content}]};
  const compileCalls=[];
  const compilerStub=async input=>{
    compileCalls.push(input);
    return{snapshotBytes:input.baseRelease.snapshotBytes,recipesBytes:input.baseRelease.recipesBytes,derived:profile.sourceBindings.derivedRegistryPaths.map(p=>({path:p,bytes:Buffer.from('{}')})),qa:{status:'PASS'}};
  };
  return{root,repo,profile,event,historicalRelease,current,manifest,compileCalls,compilerStub};
}

test('extension baseline and proposed compilation receive the same real historical publication, without changing current bytes',async t=>{
  const f=await fixture(t),before=(await f.repo.exportState()).exportSha256;
  const {plan}=await planInstanceExtension(f.repo,{instanceRoot:f.root,manifest:f.manifest,softwareCommit:f.manifest.softwareCommit,compiler:f.compilerStub});
  assert.equal(f.compileCalls.length,2);
  const [baseline,proposed]=f.compileCalls;
  assert.deepEqual(baseline.historicalContexts,proposed.historicalContexts);
  assert.equal(plan.context.historicalContextsHash,baseline.historicalContexts.contextsHash);
  assert.equal(baseline.historicalContexts.contexts.length,1);
  assert.equal(baseline.historicalContexts.contexts[0].eventId,f.event.eventId);
  assert.equal(baseline.historicalContexts.contexts[0].releaseId,f.historicalRelease.releaseId);
  assert.notEqual(f.current.releaseId,f.historicalRelease.releaseId);
  assert.equal(baseline.baseRelease.releaseId,f.current.releaseId);
  assert.equal((await f.repo.exportState()).exportSha256,before);
  assert.equal(plan.mode,'PLAN_ONLY');assert.equal(plan.sourceMutationPerformed,false);
});

test('a new publication during extension compilation fails CAS before any adapter source replacement',async t=>{
  const f=await fixture(t),old=await f.repo.readDocument('scripts/adapter.py');let calls=0;
  const compiler=async input=>{
    const result=await f.compilerStub(input);
    if(++calls===2)await f.repo.writeTransaction(async tx=>{const view=await tx.readView();await tx.publishRelease({snapshot:view.snapshot,recipes:view.recipes,expectedReleaseId:view.releaseId,sourceRevisionIds:view.sourceRevisionIds});});
    return result;
  };
  await assert.rejects(planInstanceExtension(f.repo,{instanceRoot:f.root,manifest:f.manifest,softwareCommit:f.manifest.softwareCommit,compiler}),error=>['EXTENSION_BASE_CHANGED','EXTENSION_CAS_CONFLICT'].includes(error.code));
  assert.equal((await f.repo.readDocument('scripts/adapter.py')).revisionId,old.revisionId);
});
