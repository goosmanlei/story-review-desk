import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRequirementComposition,validateRequirementCompositions,applyRequirementCompositionCoverage} from '../host/instance-runtime/material-requirement-composition.mjs';
import {domainHash,emptyDomainGraph,validateDomainGraph} from '../host/instance-runtime/domain-model.mjs';
import {projectDomainGraph,preserveDomainProjection} from '../host/instance-runtime/domain-projection.mjs';
import {blankProfile,blankSnapshot} from '../host/instance-runtime/blank.mjs';
import {fixture} from './domain-new-production-fixture.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createInstanceRepository} from '../host/instance-runtime/index.mjs';
import {initializeConfiguration} from '../host/instance-runtime/configuration-service.mjs';
import {getDomainWorkspace,saveDomainWorkspace,previewDomainWorkspace,publishDomainWorkspace} from '../host/instance-runtime/domain-workspaces.mjs';
import {getMaterialProductionWorkspace} from '../host/instance-runtime/material-production-service.mjs';

const composition=(...ids)=>({schemaVersion:'1.0',mode:'ALL',requiredComponents:ids.map(id=>({id:'component:'+id,requirementId:id}))});
const leaf=(id,covered=true)=>({id,requirementHash:domainHash(id),requirementClass:'REQUIRED',assetFamilyRefs:['family:'+id],coverageSatisfied:covered,bindingStale:false,coverageReasons:[],coveredByFamilyRefs:covered?['family:'+id]:[],coveredByVersionRefs:covered?['family:'+id+'@V001']:[]});
const parent=(id,...ids)=>({...leaf(id),assetFamilyRefs:[],composition:composition(...ids)});
const byId=rows=>Object.fromEntries(applyRequirementCompositionCoverage(rows).map(r=>[r.id,r]));

test('one adopted component never covers a four-state requirement; all explicit children are required',()=>{
 const rows=[parent('bucket','full','empty','bundle','stack'),leaf('full'),leaf('empty',false),leaf('bundle',false),leaf('stack',false)],before=JSON.stringify(rows);
 const result=byId(rows).bucket;
 assert.equal(result.coverageSatisfied,false);assert.equal(result.compositionCoverage.coveredCount,1);assert.equal(result.compositionCoverage.requiredCount,4);assert.equal(JSON.stringify(rows),before);
 const ready=byId([rows[0],...rows.slice(1).map(r=>leaf(r.id))]).bucket;
 assert.equal(ready.coverageSatisfied,true);assert.equal(ready.coveredByVersionRefs.length,4);
});
test('parent own approved media is not an implicit replacement for missing children',()=>{
 const p={...leaf('rig'),composition:composition('empty-hook','occlusion')};
 assert.equal(byId([p,leaf('empty-hook')]).rig.coverageSatisfied,false);
});
test('unmade empty-family required leaves are false; legacy nonempty and evidence-only keep their rules',()=>{
 const old=leaf('old'),empty={...leaf('new'),assetFamilyRefs:[]},evidence={...empty,id:'historical',requirementClass:'EVIDENCE_ONLY'};
 const out=byId([old,empty,evidence]);assert.deepEqual(out.old,old);assert.equal(out.new.coverageSatisfied,false);assert.deepEqual(out.historical,evidence);
});
for(const [label,change] of [
 ['missing',()=>null],['revision-required',row=>({...row,coverageSatisfied:false,coverageReasons:['REVISION_REQUIRED']})],
 ['hash-stale',row=>({...row,bindingStale:true})],['evidence-only',row=>({...row,requirementClass:'EVIDENCE_ONLY'})],
 ['inactive',row=>({...row,activeInCurrentProduction:false})],['historical-scope',row=>({...row,scopeRole:'EVIDENCE_ONLY'})],
])test('an aggregate fails closed for '+label+' child while unrelated aggregate remains ready',()=>{
 const changed=change(leaf('a')),rows=[parent('p','a'),parent('other','b'),leaf('b'),...(changed?[changed]:[])];
 const out=byId(rows);assert.equal(out.p.coverageSatisfied,false);assert.equal(out.other.coverageSatisfied,true);
});
test('nested ALL coverage is independent of traversal order and returns exact current version identities',()=>{
 const rows=[parent('root','nested','b'),parent('nested','a'),leaf('a'),leaf('b')];
 for(const ordered of [rows,[...rows].reverse()])assert.deepEqual(byId(ordered).root.coveredByVersionRefs,['family:a@V001','family:b@V001']);
 const next=structuredClone(rows);next[2].coveredByVersionRefs=['family:a@V002'];assert.deepEqual(byId(next).root.coveredByVersionRefs,['family:a@V002','family:b@V001']);
});
test('malformed, empty, duplicate, missing and cyclic contracts cannot be published',()=>{
 for(const value of [null,{},composition(),{...composition('a'),mode:'ANY'},{...composition('a'),extra:true},{...composition('a'),schemaVersion:'2.0'},{schemaVersion:'1.0',mode:'ALL',requiredComponents:[{id:'a',requirementId:'b',optional:true}]},composition('a','a')])assert.throws(()=>validateRequirementComposition(value),e=>e.code==='DOMAIN_INVALID');
 for(const rows of [[parent('a','a')],[parent('a','missing')],[parent('a','b'),parent('b','a')]])assert.throws(()=>validateRequirementCompositions(rows),e=>e.code==='DOMAIN_INVALID');
 validateRequirementCompositions([parent('a','legacy')],{knownRequirementIds:['legacy']});
});
test('invalid imported runtime contracts and cycles never become coverage or recurse forever',()=>{
 for(const rows of [[{...parent('a','b'),composition:null},leaf('b')],[parent('a','a')],[parent('a','b'),parent('b','a')],[parent('a','b'),leaf('b'),leaf('b')]])assert.equal(byId(rows).a.coverageSatisfied,false);
});
function graphFixture(){
 const g=emptyDomainGraph();g.entities=[{id:'prop',type:'PROP',name:'同一真实道具',aliases:[],description:'',authority:'A',evidence:[]}];
 for(const id of ['parent','first','second']){
  g.states.push({id:'state:'+id,entityId:'prop',label:id,dimensions:{},scope:[],authority:'A',evidence:[]});
  g.representations.push({id:'rep:'+id,entityId:'prop',stateId:'state:'+id,type:'PROP_STATE',label:id,dimensions:{},assetFamilyIds:[],requirementIds:[],authority:'A',evidence:[]});
  g.requirements.push({id,title:id,representationId:'rep:'+id,mediaType:'IMAGE',category:'道具',scope:[],evidence:[],acceptanceCriteria:['仅本明确状态'],reuseScope:'PROJECT'});
 }
 g.requirements[0].composition=composition('first','second');return g;
}
test('same-entity state/representation requirements preserve explicit composition in domain projection and source sync',()=>{
 const g=graphFixture();validateDomainGraph(g);
 const {snapshot}=blankSnapshot(blankProfile({title:'composition test'}));
 const projected=projectDomainGraph(snapshot,g,{revisionId:'revision:domain',sha256:domainHash(g)}),row=projected.productionModel.materialRequirements.find(r=>r.id==='parent');
 assert.deepEqual(row.composition,g.requirements[0].composition);assert.equal(row.requirementHash,domainHash({demand:g.requirements[0],representation:g.representations[0]}));
 const changed=structuredClone(g);changed.requirements[0].composition.requiredComponents.reverse();
 const updated=projectDomainGraph(projected,changed,{revisionId:'revision:next',sha256:domainHash(changed)});
 assert.notEqual(updated.productionModel.materialRequirements[0].requirementHash,row.requirementHash);
 const synced=preserveDomainProjection({snapshot:structuredClone(projected),baseSnapshot:projected,events:[]});assert.deepEqual(synced.productionModel.materialRequirements[0].composition,row.composition);
 assert.equal(projected.productionModel.domainGraph.entities.length,1);
});
test('real operational projection requires both adopted children, propagates revocation and never upgrades an empty requirement',()=>{
 const f=fixture(),a=f.addRoot('a'),b=f.addRoot('b',20),model=f.data.productionModel;
 for(const version of model.assetVersions){const requirement=model.materialRequirements.find(r=>r.assetFamilyRefs.includes(version.familyId));version.materialRequirementBindings=[{requirementRef:requirement.id,requirementHash:requirement.requirementHash}];}
 f.reviews=[];f.review(a,10);b.review=f.review(b,20);
 model.materialRequirements.push({...parent('aggregate','requirement:a','requirement:b'),requirementHash:domainHash('aggregate')},{...leaf('empty'),assetFamilyRefs:[]});
 let state=f.project();assert.equal(state.materialRequirementsById.aggregate.coverageSatisfied,true);assert.equal(state.materialRequirementsById.empty.coverageSatisfied,false);
 const prior=JSON.stringify(model.materialRequirements);b.review.action='REQUEST_REVISION';b.review.reviewDecision='REVISION_REQUIRED';b.review.lifecycleState='REVISION_REQUIRED';b.review.canFlowDownstream=false;b.review.adoptionIntent='DO_NOT_ADOPT';
 state=f.project();assert.equal(state.materialRequirementsById.aggregate.coverageSatisfied,false);assert.equal(state.materialRequirementsById['requirement:a'].coverageSatisfied,true);assert.equal(JSON.stringify(model.materialRequirements),prior);assert.equal(state.assetFamiliesById[a.familyId].currentVersionId,a.versionId);
});
test('controlled DOMAIN save/preview/publication preserves the contract and refuses dangling deletion without business generation',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'material-composition-')),profile=blankProfile({title:'composition isolated repository'}),repo=await createInstanceRepository({dbPath:path.join(dir,'review.sqlite'),instanceId:profile.instanceId,profile});
 try{
  await repo.writeTransaction(tx=>tx.publishRelease({...blankSnapshot(profile),expectedReleaseId:null,sourceRevisionIds:[]}));await repo.writeTransaction(tx=>initializeConfiguration(tx));
  const graph=graphFixture();
  const publish=async(owner,changes)=>{
   const w=await repo.readTransaction(tx=>getDomainWorkspace(tx,owner)),draft=await repo.writeTransaction(tx=>saveDomainWorkspace(tx,{owner,expectedReleaseId:w.releaseId,expectedDraftRevisionId:w.draftHeadRevisionId,changes}));
   const preview=await repo.readTransaction(tx=>previewDomainWorkspace(tx,{owner,draftRevisionId:draft.revisionId}));assert.equal(preview.formalAdoptionPerformed,false);
   const input={owner,draftRevisionId:draft.revisionId,previewHash:preview.previewHash,requestId:'publish:'+draft.revisionId};
   const result=await repo.writeTransaction(tx=>publishDomainWorkspace(tx,input));assert.deepEqual(await repo.writeTransaction(tx=>publishDomainWorkspace(tx,input)),result);return result;
  };
  await publish('SETTINGS',graph.entities.map(value=>({collection:'entities',id:value.id,beforeHash:null,value})));
  await publish('MATERIAL',['states','representations','requirements'].flatMap(collection=>graph[collection].map(value=>({collection,id:value.id,beforeHash:null,value}))));
  let view=await repo.readView();assert.deepEqual(view.snapshot.productionModel.materialRequirements.find(r=>r.id==='parent').composition,graph.requirements[0].composition);
  const workspace=await repo.readTransaction(tx=>getMaterialProductionWorkspace(tx,{requirementId:'parent',api:{projectOperationalState:()=>({assetFamiliesById:{},assetVersionsById:{}})}}));
  assert.ok(workspace.blockers.some(reason=>reason.includes('组合需求')));
  const w=await repo.readTransaction(tx=>getDomainWorkspace(tx,'MATERIAL')),before=await repo.exportState();
  await assert.rejects(repo.writeTransaction(tx=>saveDomainWorkspace(tx,{owner:'MATERIAL',expectedReleaseId:w.releaseId,expectedDraftRevisionId:w.draftHeadRevisionId,changes:[{collection:'requirements',id:'second',beforeHash:domainHash(graph.requirements[2]),value:null}]})),/不存在的子需求/);
  assert.deepEqual(await repo.exportState(),before);
  view=await repo.readView();assert.equal(view.snapshot.productionModel.assetFamilies.length,0);assert.equal(view.snapshot.productionModel.assetVersions.length,0);assert.equal(Object.values(view.eventsByKind).flat().length,0);
 }finally{await repo.close();await rm(dir,{recursive:true,force:true});}
});
