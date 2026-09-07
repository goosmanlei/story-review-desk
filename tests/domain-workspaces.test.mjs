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
import {directoryProjection,readMaterialDirectory} from '../host/instance-runtime/material-directory.mjs';
import {projectDomainGraph,preserveDomainProjection} from '../host/instance-runtime/domain-projection.mjs';
import * as work from '../host/instance-runtime/domain-workspaces.mjs';
import * as old from '../host/instance-runtime/domain-service.mjs';
import * as extraction from '../host/instance-runtime/domain-extraction.mjs';
import {performExtraction} from '../workers/initialization-worker.mjs';
import {prepareSourceImport,importSource} from '../host/instance-runtime/domain-sources.mjs';
import {saveAuthoringRoot} from '../host/instance-runtime/domain-authoring.mjs';
const entity=(id,name=id)=>({id,type:'CHARACTER',name,aliases:[],description:'',authority:'A',evidence:[]});
const rep=(id,entityId)=>({id,entityId,stateId:null,type:'IDENTITY',label:id,dimensions:{},assetFamilyIds:[],requirementIds:[],authority:'A',evidence:[]});
test('one-click extraction is atomic and replay never starts a second task',()=>fixture(async(repo,root)=>{
 const view=await repo.readView(),source=await prepareSourceImport({title:'本次唯一来源',role:'PRIMARY',text:'甲在门前。',expectedReleaseId:view.releaseId},root);
 await repo.writeTransaction(tx=>importSource(tx,source));
 const state=await repo.readTransaction(tx=>extraction.getExtraction(tx)),binding=(({sourceId,revisionId,sha256})=>({sourceId,revisionId,sha256}))(state.sources[0]);
 const input={requestId:'atomic-start-one',expectedReleaseId:state.releaseId,expectedInputRevisionId:null,sourceBindings:[binding]};
 for(const bad of [{...input,expectedReleaseId:'stale'},{...input,sourceBindings:[{...binding,sha256:'f'.repeat(64)}]}]){
  await assert.rejects(repo.writeTransaction(tx=>extraction.prepareAndRequestExtraction(tx,bad)));
  assert.equal((await repo.readTransaction(tx=>extraction.getExtraction(tx))).input,null);
 }
 await assert.rejects(repo.writeTransaction(async tx=>{
  const original=tx.putAux.bind(tx);
  tx.putAux=arg=>arg.namespace==='setting-extraction-tasks'?Promise.reject(Error('injected task write failure')):original(arg);
  return extraction.prepareAndRequestExtraction(tx,input);
 }),/injected/);
 assert.equal((await repo.readTransaction(tx=>extraction.getExtraction(tx))).input,null);
 const result=await repo.writeTransaction(tx=>extraction.prepareAndRequestExtraction(tx,input));
 assert.deepEqual(await repo.writeTransaction(tx=>extraction.prepareAndRequestExtraction(tx,input)),result);
 await assert.rejects(repo.writeTransaction(tx=>extraction.prepareAndRequestExtraction(tx,{...input,sourceBindings:[]})),/不同整理任务/);
 await assert.rejects(repo.writeTransaction(tx=>extraction.prepareAndRequestExtraction(tx,{...input,requestId:'atomic-start-two'})),/已有整理任务/);
 await performExtraction({repository:repo,apiKey:'TEST_ONLY',fetchImpl:async()=>{throw Error('lost provider response');}});
 assert.deepEqual(await repo.writeTransaction(tx=>extraction.prepareAndRequestExtraction(tx,input)),result);
 const final=await repo.readTransaction(tx=>extraction.getExtraction(tx));
 assert.equal(final.task.state,'FAILED');assert.equal(final.task.taskId,result.taskId);
 assert.equal((await repo.readView()).releaseId,state.releaseId);
}));
async function fixture(run){const root=await mkdtemp(path.join(os.tmpdir(),'settings-split-')),profile=blankProfile({title:'分域隔离验收'}),repo=await createInstanceRepository({dbPath:path.join(root,'data/review.sqlite'),instanceId:profile.instanceId,profile});try{await repo.writeTransaction(tx=>tx.publishRelease({...blankSnapshot(profile),expectedReleaseId:null,sourceRevisionIds:[]}));await repo.writeTransaction(tx=>initializeConfiguration(tx));await run(repo,root);}finally{await repo.close();await rm(root,{recursive:true,force:true});}}
async function stage(repo,owner,changes){const state=await repo.readTransaction(tx=>work.getDomainWorkspace(tx,owner));return repo.writeTransaction(tx=>work.saveDomainWorkspace(tx,{owner,expectedReleaseId:state.releaseId,expectedDraftRevisionId:state.draftHeadRevisionId,changes}));}
async function publish(repo,owner,draftRevisionId,id='request-'+Math.random()){const preview=await repo.readTransaction(tx=>work.previewDomainWorkspace(tx,{owner,draftRevisionId})),input={owner,draftRevisionId,previewHash:preview.previewHash,requestId:id},result=await repo.writeTransaction(tx=>work.publishDomainWorkspace(tx,input));assert.deepEqual(await repo.writeTransaction(tx=>work.publishDomainWorkspace(tx,input)),result);return {preview,result};}
test('system rules unlock writing without any entity or material adoption; old whole-graph publication is disabled',()=>fixture(async(repo,root)=>{
 let view=await repo.readView();assert.equal((view.snapshot.productionModel.domainGraph?.entities||[]).length,0);
 const prepared=await prepareSourceImport({title:'显式来源',role:'PRIMARY',text:'门前的一次相遇。',expectedReleaseId:view.releaseId},root);await repo.writeTransaction(tx=>importSource(tx,prepared));const source=(await repo.readTransaction(tx=>extraction.getExtraction(tx))).sources[0];view=await repo.readView();
 const saved=await repo.writeTransaction(tx=>saveAuthoringRoot(tx,{expectedReleaseId:view.releaseId,expectedRevisionId:null,requestId:'author-without-settings',root:{kind:'STORY_OUTLINE',title:'提纲',body:'明确由作者写下的提纲',parentId:null,sceneIds:[],sourceBindings:[{sourceId:source.sourceId,revisionId:source.revisionId,sha256:source.sha256}]}}));assert.equal(saved.root.status,'DRAFT');
 await assert.rejects(repo.writeTransaction(tx=>old.publishInitialization(tx,{})),/已停用/);await assert.rejects(repo.writeTransaction(tx=>old.publishRelations(tx,{})),/已停用/);
 assert.equal((await repo.readView()).snapshot.productionModel.assetVersions.length,0);
}));
test('owner changes are isolated, stale drafts require explicit rebase, and identities cannot be hijacked',()=>fixture(async repo=>{
 const a=entity('person-a'),s=await stage(repo,'SETTINGS',[{collection:'entities',id:a.id,beforeHash:null,value:a}]);await publish(repo,'SETTINGS',s.revisionId);
 const material=await stage(repo,'MATERIAL',[{collection:'representations',id:'look-a',beforeHash:null,value:rep('look-a',a.id)}]);
 await assert.rejects(stage(repo,'MATERIAL',[{collection:'entities',id:a.id,beforeHash:domainHash(a),value:{...a,name:'越权改名'}}]),/只能修改本模块/);
 await assert.rejects(stage(repo,'MATERIAL',[{collection:'entities',id:'new-person',beforeHash:null,value:entity('new-person')}]),/不属于本模块/);
 const next=await stage(repo,'SETTINGS',[{collection:'entities',id:a.id,beforeHash:domainHash(a),value:{...a,description:'主人的稳定身份说明'}}]);await publish(repo,'SETTINGS',next.revisionId);
 assert.equal((await repo.readTransaction(tx=>work.getDomainWorkspace(tx,'MATERIAL'))).graph.representations.length,0);
 await assert.rejects(repo.readTransaction(tx=>work.previewDomainWorkspace(tx,{owner:'MATERIAL',draftRevisionId:material.revisionId})),/发布已变化/);
 const current=await repo.readView(),rebased=await repo.writeTransaction(tx=>work.rebaseDomainWorkspace(tx,{owner:'MATERIAL',expectedReleaseId:current.releaseId,draftRevisionId:material.revisionId}));await publish(repo,'MATERIAL',rebased.revisionId);
 const view=await repo.readView();assert.equal(view.snapshot.productionModel.domainGraph.representations.length,1);assert.equal(view.eventsByKind.review?.length||0,0);
 await assert.rejects(stage(repo,'MATERIAL',[{collection:'states',id:'state-wrong',beforeHash:null,value:{id:'state-wrong',entityId:a.id,label:'未知绑定',dimensions:{},scope:[{scopeType:'SCENE',scopeId:'S999',revisionId:'made-up'}],authority:'A',evidence:[]}}]),/精确修订/);
}));
test('old suggestions use original baseline and cannot replace another draft or newer published objects',()=>fixture(async repo=>{
 const a=entity('person-a'),b=entity('person-b'),saved=await stage(repo,'SETTINGS',[a,b].map(value=>({collection:'entities',id:value.id,beforeHash:null,value})));await publish(repo,'SETTINGS',saved.revisionId);
 let view=await repo.readView();const baseline=view.releaseId,legacy=structuredClone(view.snapshot.productionModel.domainGraph);legacy.entities[0].name='旧草稿改名';const record=await repo.writeTransaction(tx=>tx.putAux({namespace:'domain-drafts',key:'relations',bytes:Buffer.from(canonicalJson({baseReleaseId:baseline,graph:legacy})),expectedRevisionId:null,mediaType:'application/json'}));
 const draft=await stage(repo,'SETTINGS',[{collection:'entities',id:b.id,beforeHash:domainHash(b),value:{...b,name:'当前草稿'}}]);let state=await repo.readTransaction(tx=>work.getDomainWorkspace(tx,'SETTINGS'));
 await assert.rejects(repo.writeTransaction(tx=>work.transferLegacyDraft(tx,{owner:'SETTINGS',expectedReleaseId:state.releaseId,expectedDraftRevisionId:state.draftHeadRevisionId,kind:'RELATIONS',legacyRevisionId:record.revisionId})),/已有未确认草稿/);
 await publish(repo,'SETTINGS',draft.revisionId);state=await repo.readTransaction(tx=>work.getDomainWorkspace(tx,'SETTINGS'));
 const transferred=await repo.writeTransaction(tx=>work.transferLegacyDraft(tx,{owner:'SETTINGS',expectedReleaseId:state.releaseId,expectedDraftRevisionId:state.draftHeadRevisionId,kind:'RELATIONS',legacyRevisionId:record.revisionId}));await publish(repo,'SETTINGS',transferred.revisionId);
 view=await repo.readView();assert.equal(view.snapshot.productionModel.domainGraph.entities[1].name,'当前草稿','unchanged old rows never roll back later changes');
 const update=await stage(repo,'SETTINGS',[{collection:'entities',id:a.id,beforeHash:domainHash(legacy.entities[0]),value:{...a,name:'之后的新发布'}}]);await publish(repo,'SETTINGS',update.revisionId);
 state=await repo.readTransaction(tx=>work.getDomainWorkspace(tx,'SETTINGS'));await assert.rejects(repo.writeTransaction(tx=>work.transferLegacyDraft(tx,{owner:'SETTINGS',expectedReleaseId:state.releaseId,expectedDraftRevisionId:state.draftHeadRevisionId,kind:'RELATIONS',legacyRevisionId:record.revisionId})),/不能转交覆盖/);
}));
test('preview uses actual family context and ownership survives controlled projection',()=>fixture(async repo=>{
 let view=await repo.readView();const graph={schemaVersion:'1.0',entities:[entity('a'),entity('b')],states:[],representations:[{...rep('ra','a'),assetFamilyIds:['fa']},{...rep('rb','b'),assetFamilyIds:['fb']}],relations:[{id:'reference',type:'VISUAL_REFERENCE',from:{kind:'REPRESENTATION',id:'ra'},to:{kind:'REPRESENTATION',id:'rb'},label:'材质',purpose:'style',inherit:[],exclude:[],scope:[],authority:'A',evidence:[],status:'PROPOSED',referencePolicyId:'CLEAN_MASTER'}],requirements:[]};
 await repo.writeTransaction(async tx=>{const record=await tx.putAux({namespace:'domain-graph',key:'current',bytes:Buffer.from(canonicalJson(graph)),expectedRevisionId:null,mediaType:'application/json'}),snapshot=structuredClone(view.snapshot);snapshot.productionModel.assetFamilies=[{id:'fa'},{id:'fb'}];snapshot.productionModel.assetVersions=[{id:'va',familyId:'fa',sha256:'a'.repeat(64)},{id:'vb',familyId:'fb',sha256:'b'.repeat(64)}];const next=projectDomainGraph(snapshot,graph,{revisionId:record.revisionId,sha256:record.sha256});next.productionModel.domainOwnership=domainOwnership(graph);await tx.publishRelease({snapshot:next,recipes:view.recipes,expectedReleaseId:view.releaseId,sourceRevisionIds:view.sourceRevisionIds});});
 const staged=await stage(repo,'MATERIAL',[{collection:'relations',id:'reference',beforeHash:domainHash(graph.relations[0]),value:null}]);const {preview}=await publish(repo,'MATERIAL',staged.revisionId);assert.deepEqual(preview.impact.affectedFamilies.map(f=>f.familyId),['fa','fb']);assert.equal(preview.impact.invalidations.length,2);
 view=await repo.readView();const preserved=preserveDomainProjection({snapshot:view.snapshot,baseSnapshot:view.snapshot});assert.deepEqual(preserved.productionModel.domainOwnership,view.snapshot.productionModel.domainOwnership);
}));
test('AI freezes selected text, preserves configuration, returns independent suggestions and never retries unknown outcomes',()=>fixture(async(repo,root)=>{
 for(const [title,text]of [['选中原文','甲在门前。'],['未选资料','这段正文绝不能传给模型。']]){const v=await repo.readView(),prepared=await prepareSourceImport({title,role:'PRIMARY',text,expectedReleaseId:v.releaseId},root);await repo.writeTransaction(tx=>importSource(tx,prepared));}
 let state=await repo.readTransaction(tx=>extraction.getExtraction(tx)),binding=(({sourceId,revisionId,sha256})=>({sourceId,revisionId,sha256}))(state.sources.find(s=>s.title==='选中原文'));
 await assert.rejects(repo.writeTransaction(tx=>extraction.prepareExtraction(tx,{expectedReleaseId:state.releaseId,expectedInputRevisionId:null,sourceBindings:[binding,binding]})),/不重复/);
 const prepared=await repo.writeTransaction(tx=>extraction.prepareExtraction(tx,{expectedReleaseId:state.releaseId,expectedInputRevisionId:null,sourceBindings:[binding]}));
 const input={inputRevisionId:prepared.revisionId,requestId:'ai-once'},requested=await repo.writeTransaction(tx=>extraction.requestExtraction(tx,input));assert.deepEqual(await repo.writeTransaction(tx=>extraction.requestExtraction(tx,input)),requested);
 const before=(await repo.readView()).releaseId;let calls=0;
 const result=await performExtraction({repository:repo,apiKey:'TEST_ONLY',fetchImpl:async(url,options)=>{calls++;const payload=JSON.parse(JSON.parse(options.body).input);assert.equal(payload.sources.length,1);assert.equal(payload.sources[0].text,'甲在门前。');assert(!options.body.includes('绝不能传给模型'));return new Response(JSON.stringify({output_text:JSON.stringify({...payload.template,summary:'甲在门前的设定建议',graph:{...payload.template.graph,entities:[entity('ai-a','甲')]}})}),{headers:{'x-request-id':'mock'}});}});
 assert.equal(result.state,'COMPLETED');assert.equal(calls,1);assert.equal((await repo.readView()).releaseId,before);
 const setting=await repo.readTransaction(tx=>work.getDomainWorkspace(tx,'SETTINGS'));assert.equal(setting.graph.entities.length,0);assert.equal(setting.draft,null);
 await repo.writeTransaction(tx=>extraction.requestExtraction(tx,{inputRevisionId:prepared.revisionId,requestId:'ai-network'}));await performExtraction({repository:repo,apiKey:'TEST_ONLY',fetchImpl:async()=>{calls++;throw new Error('network UNKNOWN');}});assert.equal((await performExtraction({repository:repo,apiKey:'TEST_ONLY',fetchImpl:async()=>{throw new Error('must not retry');}})).state,'IDLE');assert.equal(calls,2);
 state=await repo.readTransaction(tx=>extraction.getExtraction(tx));assert.equal(state.results.length,1);
}));

async function directoryFixture(run){return fixture(async repo=>{
 const before=await repo.readView(),a=entity('directory-source-person'),target=entity('directory-target-person','原目录人物');
 const representation={...rep('directory-rep',a.id),requirementIds:['legacy-demand']};
 const graph={schemaVersion:'1.0',entities:[a],states:[],representations:[representation],relations:[],requirements:[]};
 const content={directoryBindings:[{requirementId:'legacy-demand',requirementHash:'legacy-exact-hash',representationId:representation.id,representationHash:domainHash(representation),entityId:target.id,stateId:'directory-state'}],newEntities:[target],newStates:[{id:'directory-state',entityId:target.id,label:'目录状态',dimensions:{},scope:[],authority:'A',evidence:[]}],newRelations:[],trialBindings:[],sourceBindings:[]};
 await repo.writeTransaction(async tx=>{
  const g=await tx.putAux({namespace:'domain-graph',key:'current',bytes:Buffer.from(canonicalJson(graph)),expectedRevisionId:null});
  const d=await tx.putAux({namespace:'material-directory',key:'current',bytes:Buffer.from(canonicalJson(content)),expectedRevisionId:null});
  const base=structuredClone(before.snapshot);base.productionModel.materialRequirements=[{id:'legacy-demand',title:'已有需求',requirementClass:'REQUIRED',requirementHash:'legacy-exact-hash',sourceKind:'LEGACY',mediaType:'IMAGE',acceptanceCriteria:['已有要求'],assetFamilyRefs:[]}];
  const snapshot=projectDomainGraph(base,graph,{revisionId:g.revisionId,sha256:g.sha256});snapshot.productionModel.domainOwnership=domainOwnership(graph);
  snapshot.productionModel.materialDirectory={...directoryProjection(snapshot.productionModel,content),revisionId:d.revisionId};
  await tx.publishRelease({snapshot,recipes:before.recipes,sourceRevisionIds:before.sourceRevisionIds,expectedReleaseId:before.releaseId});
 });
 await run(repo,{graph,content,target});
});}
test('domain preview/publication reprojects exact directory source in the same transaction, including promoted and new native rows',()=>directoryFixture(async(repo,{target})=>{
 const promoted={...target,description:'主图中刚确认的完整实体说明'};
 const draft=await stage(repo,'SETTINGS',[{collection:'entities',id:promoted.id,beforeHash:null,value:promoted}]);
 const {preview}=await publish(repo,'SETTINGS',draft.revisionId);
 let view=await repo.readView(),projected=view.snapshot.productionModel.materialDirectory;
 assert.equal(projected.graph.entities.find(e=>e.id===promoted.id).description,promoted.description);
 assert.equal(projected.graph.entities.find(e=>e.id===promoted.id).directoryOnly,undefined);
 assert.equal(projected.projectionBasis.domainGraphHash,domainHash(view.snapshot.productionModel.domainGraph));
 assert.equal(preview.impact.directory.graphHash,domainHash(projected.graph));
 assert.equal(preview.impact.directory.sourceSha256,projected.sourceSha256);
 assert.deepEqual((await repo.readTransaction(readMaterialDirectory)).graph,projected.graph);
 const state={id:'native-state',entityId:promoted.id,label:'新状态',dimensions:{},scope:[],authority:'A',evidence:[]};
 const representation={...rep('native-rep',promoted.id),stateId:state.id,requirementIds:['native-demand']};
 const demand={id:'native-demand',title:'独立新需求',representationId:representation.id,mediaType:'IMAGE',category:'人物',reuseScope:'PROJECT',scope:[],evidence:[],acceptanceCriteria:['角色身份可核对']};
 const material=await stage(repo,'MATERIAL',[['states',state],['representations',representation],['requirements',demand]].map(([collection,value])=>({collection,id:value.id,beforeHash:null,value})));
 await publish(repo,'MATERIAL',material.revisionId);
 view=await repo.readView();projected=view.snapshot.productionModel.materialDirectory;
 assert.ok(projected.graph.requirements.some(r=>r.id===demand.id));
 assert.ok(projected.graph.states.some(s=>s.id===state.id));
 assert.ok(projected.graph.representations.some(r=>r.id===representation.id));
 assert.equal(view.snapshot.productionModel.assetVersions.length,0);
 const compile=preserveDomainProjection({snapshot:view.snapshot,baseSnapshot:view.snapshot});
 assert.equal(compile.productionModel.materialDirectory.projectionBasis.domainGraphHash,domainHash(compile.productionModel.domainGraph));
 assert.ok(compile.productionModel.materialDirectory.graph.requirements.some(r=>r.id===demand.id));
}));
test('directory auxiliary change invalidates an earlier domain preview even without a release change',()=>directoryFixture(async(repo,{target,content})=>{
 const draft=await stage(repo,'SETTINGS',[{collection:'entities',id:target.id,beforeHash:null,value:target}]);
 const preview=await repo.readTransaction(tx=>work.previewDomainWorkspace(tx,{owner:'SETTINGS',draftRevisionId:draft.revisionId}));
 const before=await repo.readView();
 await repo.writeTransaction(async tx=>{const head=await tx.getAux('material-directory','current');await tx.putAux({namespace:'material-directory',key:'current',bytes:Buffer.from(canonicalJson({...content,reviewNote:'原目录定义已另行核对'})),expectedRevisionId:head.revisionId});});
 assert.equal((await repo.readView()).releaseId,before.releaseId);
 await assert.rejects(repo.writeTransaction(tx=>work.publishDomainWorkspace(tx,{owner:'SETTINGS',draftRevisionId:draft.revisionId,previewHash:preview.previewHash,requestId:'directory-preview-stale'})),/预览已变化/);
 assert.ok(!(await repo.readView()).snapshot.productionModel.domainGraph.entities.some(e=>e.id===target.id));
}));
test('directory source hash failure is rejected before a domain preview can approve stale data',()=>directoryFixture(async(repo,{target})=>{
 const draft=await stage(repo,'SETTINGS',[{collection:'entities',id:target.id,beforeHash:null,value:target}]);
 await assert.rejects(repo.readTransaction(async tx=>{
  const get=tx.getAux.bind(tx);tx.getAux=async(...args)=>{const row=await get(...args);return args[0]==='material-directory'&&row?{...row,sha256:'0'.repeat(64)}:row;};
  return work.previewDomainWorkspace(tx,{owner:'SETTINGS',draftRevisionId:draft.revisionId});
 }),/SHA不一致/);
}));
