import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createInstanceRepository,canonicalJson} from '../host/instance-runtime/index.mjs';
import {blankProfile,blankSnapshot} from '../host/instance-runtime/blank.mjs';
import {initializeConfiguration} from '../host/instance-runtime/configuration-service.mjs';
import {domainHash} from '../host/instance-runtime/domain-model.mjs';
import {domainOwnership} from '../host/instance-runtime/domain-ownership.mjs';
import {projectDomainGraph} from '../host/instance-runtime/domain-projection.mjs';
import {verifySourceBindings} from '../host/instance-runtime/domain-sources.mjs';
import {verifyDomainWorkspaceEvidence} from '../host/instance-runtime/domain-workspace-evidence.mjs';
import * as workspace from '../host/instance-runtime/domain-workspaces.mjs';

const entity=id=>({id,type:'CHARACTER',name:id,aliases:[],description:'',authority:'A',evidence:[]});
const representation=(id,evidence=[])=>({id,entityId:'person-a',stateId:null,type:'IDENTITY',label:id,dimensions:{},assetFamilyIds:[],requirementIds:[],authority:'A',evidence});
const binding=(document,quote)=>({sourceId:`source_${document.sha256}`,revisionId:document.revisionId,sha256:document.sha256,locator:'正文第一段',quote});
const change=(collection,before,value)=>({collection,id:value?.id||before.id,beforeHash:before?domainHash(before):null,value});

async function fixture(run,{sameBytes=false,registered=false}={}) {
  const root=await mkdtemp(path.join(os.tmpdir(),'domain-history-evidence-'));
  const profile=blankProfile({title:'精确历史来源保留回归'});
  const repo=await createInstanceRepository({dbPath:path.join(root,'data/review.sqlite'),instanceId:profile.instanceId,profile});
  try {
    await repo.writeTransaction(tx=>tx.publishRelease({...blankSnapshot(profile),expectedReleaseId:null,sourceRevisionIds:[]}));
    await repo.writeTransaction(tx=>initializeConfiguration(tx));
    let original,refreshed,graph;
    await repo.writeTransaction(async tx=>{
      const view=await tx.readView();
      original=await tx.putDocument({documentId:'doc:registry',aliases:['registries/people.json'],bytes:'原身份说明。第二条原证据。',expectedRevisionId:null});
      const evidence=binding(original,'原身份说明');
      graph={schemaVersion:'1.0',entities:[{...entity('person-a'),evidence:[evidence]},entity('person-b')],states:[],representations:[representation('look-a',[evidence])],relations:[],requirements:[]};
      const record=await tx.putAux({namespace:'domain-graph',key:'current',bytes:canonicalJson(graph),expectedRevisionId:null});
      if(registered)await tx.putAux({namespace:'domain-sources',key:evidence.sourceId,bytes:canonicalJson({id:evidence.sourceId,documentRevisionId:original.revisionId,documentSha256:original.sha256}),expectedRevisionId:null});
      const snapshot=projectDomainGraph(view.snapshot,graph,{revisionId:record.revisionId,sha256:record.sha256});
      snapshot.productionModel.domainOwnership=domainOwnership(graph);
      await tx.publishRelease({snapshot,recipes:view.recipes,expectedReleaseId:view.releaseId,sourceRevisionIds:[...view.sourceRevisionIds,original.revisionId]});
    });
    await repo.writeTransaction(async tx=>{
      const view=await tx.readView();
      refreshed=await tx.putDocument({documentId:'doc:registry',bytes:sameBytes?original.bytes:'当前来源的新事实。',metadata:{sourceSync:'new-published-revision'},expectedRevisionId:original.revisionId});
      await tx.publishRelease({snapshot:view.snapshot,recipes:view.recipes,expectedReleaseId:view.releaseId,sourceRevisionIds:view.sourceRevisionIds.filter(id=>id!==original.revisionId).concat(refreshed.revisionId)});
    });
    assert.notEqual(refreshed.revisionId,original.revisionId);
    assert(!(await repo.readTransaction(tx=>tx.listPublishedDocumentMetadata())).some(r=>r.revisionId===original.revisionId));
    await run(repo,{original,refreshed,graph});
  } finally {await repo.close();await rm(root,{recursive:true,force:true});}
}

async function save(repo,owner,changes,inject) {
  const state=await repo.readTransaction(tx=>workspace.getDomainWorkspace(tx,owner));
  return repo.writeTransaction(tx=>{
    inject?.(tx);
    return workspace.saveDomainWorkspace(tx,{owner,changes,expectedReleaseId:state.releaseId,expectedDraftRevisionId:state.draftHeadRevisionId});
  });
}
const preview=(repo,owner,draftRevisionId,inject)=>repo.readTransaction(tx=>{inject?.(tx);return workspace.previewDomainWorkspace(tx,{owner,draftRevisionId});});
const publish=(repo,owner,draftRevisionId,previewHash,inject)=>repo.writeTransaction(tx=>{inject?.(tx);return workspace.publishDomainWorkspace(tx,{owner,draftRevisionId,previewHash,requestId:'exact-history-publication'});});

for(const sameBytes of [false,true])test(`save, preview and publication retain exact original row evidence after source refresh (same bytes: ${sameBytes})`,()=>fixture(async(repo,{original,refreshed,graph})=>{
  const changes=[change('representations',graph.representations[0],{...graph.representations[0],label:'本次修改表现说明，原证据保持冻结'})];
  if(!sameBytes)changes.push(change('representations',null,representation('look-current',[binding(refreshed,'当前来源的新事实')])));
  const before=await repo.readView(),saved=await save(repo,'MATERIAL',changes);
  assert.equal((await repo.readView()).releaseId,before.releaseId,'saving remains a draft');
  const checked=await preview(repo,'MATERIAL',saved.revisionId);
  assert(checked.sourceBindings.some(b=>b.revisionId===original.revisionId));
  const result=await publish(repo,'MATERIAL',saved.revisionId,checked.previewHash);
  const after=await repo.readView();
  assert.equal(after.releaseId,result.releaseId);
  assert.deepEqual(after.snapshot.productionModel.domainGraph.entities,graph.entities);
  assert.deepEqual(after.snapshot.productionModel.domainGraph.representations[0].evidence,graph.representations[0].evidence);
  assert(!after.sourceRevisionIds.includes(original.revisionId),'retention does not republish or rebind the historical source');
  assert.equal(after.eventsByKind.review?.length||0,0);
  await assert.rejects(repo.readTransaction(tx=>verifySourceBindings(tx,[binding(original,'原身份说明')],{allowLegacy:true})),/来源已变化/,'global current-source authorization remains strict');
},{sameBytes,registered:sameBytes}));

test('same permanent row may change other fields while preserving its original registered evidence',()=>fixture(async(repo,{graph})=>{
  const saved=await save(repo,'SETTINGS',[change('entities',graph.entities[0],{...graph.entities[0],description:'补充非身份说明'})]);
  const checked=await preview(repo,'SETTINGS',saved.revisionId);
  await publish(repo,'SETTINGS',saved.revisionId,checked.previewHash);
  const actual=(await repo.readView()).snapshot.productionModel.domainGraph.entities[0];
  assert.equal(actual.description,'补充非身份说明');
  assert.deepEqual(actual.evidence,graph.entities[0].evidence);
},{registered:true}));

const forbidden=[
  ['copy onto a new permanent object',({graph})=>change('representations',null,representation('look-new',graph.representations[0].evidence))],
  ['copy onto another existing object',({graph})=>change('entities',graph.entities[1],{...graph.entities[1],evidence:graph.entities[0].evidence})],
  ['change the original quotation',({graph,original})=>change('entities',graph.entities[0],{...graph.entities[0],evidence:[binding(original,'第二条原证据')]})],
  ['change the original locator',({graph})=>change('entities',graph.entities[0],{...graph.entities[0],evidence:[{...graph.entities[0].evidence[0],locator:'新增定位'}]})],
  ['duplicate an inherited occurrence',({graph})=>change('entities',graph.entities[0],{...graph.entities[0],evidence:[...graph.entities[0].evidence,...graph.entities[0].evidence]})]
];
for(const [name,make] of forbidden)test(`historical retention cannot ${name}`,()=>fixture(async(repo,state)=>{
  const mutation=make(state),owner=mutation.collection==='entities'?'SETTINGS':'MATERIAL';
  const before=await repo.readView();
  await assert.rejects(save(repo,owner,[mutation]),/来源已变化/);
  assert.equal((await repo.readView()).releaseId,before.releaseId);
  assert.equal((await repo.readTransaction(tx=>workspace.getDomainWorkspace(tx,owner))).draft,null);
}));

test('collection and permanent identity jointly scope retention even when IDs match',()=>fixture(async(repo,{graph})=>{
  const next=structuredClone(graph);
  next.states.push({id:'person-a',entityId:'person-a',label:'新状态',dimensions:{},scope:[],authority:'A',evidence:graph.entities[0].evidence});
  await assert.rejects(repo.readTransaction(tx=>verifyDomainWorkspaceEvidence(tx,next,graph)),/来源已变化/);
}));

const faults={missing:()=>null,deleted:doc=>({...doc,deleted:true}),storedSha:doc=>({...doc,sha256:'0'.repeat(64)}),actualBytes:doc=>({...doc,bytes:Buffer.from('被篡改的字节')}),wrongRevision:doc=>({...doc,revisionId:'different-revision'})};
for(const [name,mutate] of Object.entries(faults))test(`historical source ${name} blocks save, preview and publish without changing formal state`,()=>fixture(async(repo,{graph,original})=>{
  const inject=tx=>{const read=tx.readDocumentRevision.bind(tx);tx.readDocumentRevision=async id=>{const doc=await read(id);return id===original.revisionId?mutate(doc):doc;};};
  const changes=[change('representations',graph.representations[0],{...graph.representations[0],label:'检查不可篡改来源'})];
  await assert.rejects(save(repo,'MATERIAL',changes,inject),/历史来源无法精确回读或 SHA 不一致/);
  const saved=await save(repo,'MATERIAL',changes),checked=await preview(repo,'MATERIAL',saved.revisionId),before=await repo.readView();
  await assert.rejects(preview(repo,'MATERIAL',saved.revisionId,inject),/历史来源无法精确回读或 SHA 不一致/);
  await assert.rejects(publish(repo,'MATERIAL',saved.revisionId,checked.previewHash,inject),/历史来源无法精确回读或 SHA 不一致/);
  assert.equal((await repo.readView()).releaseId,before.releaseId);
  assert.deepEqual((await repo.readView()).snapshot.productionModel.domainGraph,graph);
  assert.equal(await repo.readTransaction(tx=>tx.getAux('domain-workspace-published',`MATERIAL:${saved.revisionId}`)),null);
}));

test('an original quotation absent from its exact original document still blocks retention',()=>fixture(async(repo,{graph})=>{
  const bad=structuredClone(graph);bad.entities[0].evidence[0].quote='从未存在的引文';
  await assert.rejects(repo.readTransaction(tx=>verifyDomainWorkspaceEvidence(tx,bad,bad)),/历史来源引用无法精确回读/);
}));

test('new current-source evidence still needs an exact quotation on save, preview and publish',()=>fixture(async(repo,{refreshed})=>{
  await assert.rejects(save(repo,'MATERIAL',[change('representations',null,representation('bad-quote',[binding(refreshed,'当前正文未包含这句')]))]),/来源引用无法精确回读/);
  const created=representation('new-current',[binding(refreshed,'当前来源的新事实')]);
  const saved=await save(repo,'MATERIAL',[change('representations',null,created)]);
  const checked=await preview(repo,'MATERIAL',saved.revisionId);
  const inject=tx=>{const list=tx.listPublishedDocumentMetadata.bind(tx);tx.listPublishedDocumentMetadata=async()=> (await list()).filter(r=>r.revisionId!==refreshed.revisionId);};
  await assert.rejects(preview(repo,'MATERIAL',saved.revisionId,inject),/来源已变化/);
  await assert.rejects(publish(repo,'MATERIAL',saved.revisionId,checked.previewHash,inject),/来源已变化/);
}));
