import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {projectDomainGraph,relationProjection,preserveDomainProjection} from '../host/instance-runtime/domain-projection.mjs';
import {domainHash,defaultDomainConfiguration} from '../host/instance-runtime/domain-model.mjs';
import {applyDomainInvalidations} from '../host/instance-runtime/domain-invalidation.mjs';

const clone=structuredClone;
const entity=id=>({id,type:'CHARACTER',name:id,aliases:[],description:'stable identity',authority:'A',evidence:[]});
const rep=(id,entityId,familyId)=>({id,entityId,stateId:null,type:'VOICE_IDENTITY',label:id,dimensions:{age:'adult'},assetFamilyIds:[familyId],requirementIds:['demand:'+familyId],authority:'A',evidence:[]});
const story=(patch={})=>({id:'story:a-b',type:'SOCIAL',from:{kind:'ENTITY',id:'a'},to:{kind:'ENTITY',id:'b'},label:'companions',purpose:'story only',inherit:[],exclude:['identity transfer'],scope:[],authority:'A',status:'CONFIRMED',evidence:[],...patch});
function fixture(){
 const graph={schemaVersion:'1.0',entities:[entity('a'),entity('b'),entity('c')],states:[],representations:[rep('ra','a','fa'),rep('rb','b','fb'),rep('rc','c','fc')],relations:[],requirements:[]};
 const snapshot={snapshotId:'snapshot:fixture',creativeLineage:{scenes:[{id:'scene:a',audioAssetRefs:['fa']}]},productionModel:{
  systemConfiguration:{config:{domain:defaultDomainConfiguration()}},domainGraph:clone(graph),domainGraphRef:{revisionId:'graph:old',sha256:domainHash(graph)},
  assetFamilies:['fa','fb','fc'].map(id=>({id,currentVersionId:'v:'+id})),assetVersions:['fa','fb','fc'].map(id=>({id:'v:'+id,familyId:id,sha256:id[1].repeat(64),inputVersionBindings:[]})),
  materialRequirements:graph.representations.map(r=>({id:'demand:'+r.assetFamilyIds[0],requirementClass:'REQUIRED',requirementHash:domainHash(r),assetFamilyRefs:r.assetFamilyIds,entityRef:r.entityId,representationRef:r.id,acceptanceCriteria:['original criteria'],reviewSpec:{hash:'frozen-standard',criteria:[]}})),
  materialWorkItems:['fa','fb','fc'].map(id=>({id:'work:'+id,outputAssetRef:id})),workItems:[],
 }};
 const result=projectDomainGraph(snapshot,graph,snapshot.productionModel.domainGraphRef,{preserveReferencePolicies:true});
 return {graph,snapshot:result};
}
function project(snapshot,graph){return projectDomainGraph(snapshot,graph,{revisionId:'graph:next',sha256:domainHash(graph)},{preserveReferencePolicies:true});}
function withFrozenHash(snapshot,schema){
 const result=clone(snapshot);
 for(const family of result.productionModel.assetFamilies){
  family.domainContext.hash=domainHash({historicalProtocol:schema||'1.0',familyId:family.id});
  if(schema)family.domainContext.hashSchemaVersion=schema;else delete family.domainContext.hashSchemaVersion;
 }
 return result;
}
for(const schema of [undefined,'1.0','2.0']){
 test('pure story preserves frozen '+String(schema||'untagged V1')+' hashes and standards while keeping relations readable',()=>{
  const f=fixture(),before=withFrozenHash(f.snapshot,schema),bytes=JSON.stringify(before),next=clone(f.graph);next.relations.push(story());
  const after=project(before,next);
  assert.equal(JSON.stringify(before),bytes);assert.deepEqual(after.productionModel.domainInvalidations,[]);
  for(const family of after.productionModel.assetFamilies){const old=before.productionModel.assetFamilies.find(row=>row.id===family.id);assert.equal(family.domainContext.hash,old.domainContext.hash);assert.equal(family.domainContext.hashSchemaVersion,old.domainContext.hashSchemaVersion);}
  assert(after.productionModel.assetFamilies[0].domainContext.relationIds.includes('story:a-b'));
  assert.equal(relationProjection(after.productionModel.domainGraph,{familyId:'fa'}).relations.length,1);
  assert.deepEqual(after.productionModel.domainRepresentationPolicyBindings,before.productionModel.domainRepresentationPolicyBindings);
  assert.deepEqual(after.productionModel.materialRequirements.map(r=>r.reviewSpec),before.productionModel.materialRequirements.map(r=>r.reviewSpec));
  const noOp=preserveDomainProjection({snapshot:after,baseSnapshot:after});assert.deepEqual(noOp.productionModel.domainInvalidations,[]);
 });
}
test('entity description, state and representation changes remain exact production changes',()=>{
 for(const variant of ['description','representation','state']){
  const f=fixture(),next=clone(f.graph);
  if(variant==='description')next.entities[0].description='a changed identity condition';
  if(variant==='representation')next.representations[0].dimensions.age='different adult age';
  if(variant==='state'){next.states.push({id:'state:a',entityId:'a',label:'new state',dimensions:{emotion:'angry'},scope:[],authority:'A',evidence:[]});next.representations[0].stateId='state:a';}
  const after=project(f.snapshot,next);assert.deepEqual(after.productionModel.domainInvalidations.map(i=>i.familyId),['fa']);
 }
});
test('real reference, continuity and composition changes still invalidate actual versions and exact descendants',()=>{
 for(const type of ['VOICE_REFERENCE','STATE_TRANSITION','PART_OF']){
  const f=fixture(),next=clone(f.graph);
  next.relations.push({...story({id:'production',type}),from:{kind:'REPRESENTATION',id:'ra'},to:{kind:'REPRESENTATION',id:'rb'},...(type==='VOICE_REFERENCE'?{referencePolicyId:'VOICE_MASTER',purpose:'voice-identity'}:{})});
  const after=project(f.snapshot,next),invalidations=after.productionModel.domainInvalidations;
  assert.deepEqual(invalidations.map(row=>row.familyId),['fa','fb']);
  const versions=new Map(f.snapshot.productionModel.assetVersions.map(v=>[v.id,{...clone(v),lifecycleState:'RELEASED',canFlowDownstream:true}]));
  versions.set('derived',{id:'derived',familyId:'derived-family',sha256:'d'.repeat(64),lifecycleState:'RELEASED',canFlowDownstream:true,inputVersionBindings:[{versionId:'v:fa',sha256:'a'.repeat(64)}]});
  versions.set('unrelated',{id:'unrelated',familyId:'other',sha256:'e'.repeat(64),canFlowDownstream:true,inputVersionBindings:[{versionId:'v:fa',sha256:'wrong'}]});
  applyDomainInvalidations(invalidations,versions);assert.equal(versions.get('derived').canFlowDownstream,false);assert.equal(versions.get('v:fc').canFlowDownstream,true);assert.equal(versions.get('unrelated').canFlowDownstream,true);
 }
});
test('unknown story type/state, inheritance and reference-policy payloads are never filtered away',()=>{
 for(const patch of [{type:'UNREGISTERED'},{authority:'U'},{status:'UNKNOWN'},{referencePolicyId:'VOICE_MASTER'},{inherit:['voice']},{unknownProductionField:'condition'}]){
  const f=fixture(),next=clone(f.graph);next.relations.push(story(patch));
  assert.deepEqual(project(f.snapshot,next).productionModel.domainInvalidations.map(i=>i.familyId),['fa','fb']);
 }
});
test('kinship evidence consumed by a real resemblance reference remains a production dependency',()=>{
 const f=fixture(),graph=clone(f.graph);graph.representations.forEach(r=>r.type='IDENTITY');
 graph.relations=[story({id:'kinship',type:'KINSHIP'}),{...story({id:'kinship-ref',type:'FAMILY_RESEMBLANCE'}),from:{kind:'REPRESENTATION',id:'ra'},to:{kind:'REPRESENTATION',id:'rb'},purpose:'family-resemblance',referencePolicyId:'LIMITED_KINSHIP'}];
 const before=project(f.snapshot,graph);before.productionModel.domainInvalidations=[];
 const next=clone(graph);next.relations[0].evidence=[{sourceId:'evidence',revisionId:'revision:2',sha256:'e'.repeat(64)}];
 assert.deepEqual(project(before,next).productionModel.domainInvalidations.map(i=>i.familyId),['fa','fb']);
});
test('new defaults do not override frozen policies or masquerade as old input changes',()=>{
 const f=fixture(),before=clone(f.snapshot);before.productionModel.systemConfiguration.config.domain.referencePolicies.find(p=>p.id==='VOICE_MASTER').maxDerivedGenerations=1;
 const after=project(before,f.graph);assert.deepEqual(after.productionModel.domainRepresentationPolicyBindings,f.snapshot.productionModel.domainRepresentationPolicyBindings);
 assert.deepEqual(after.productionModel.domainInvalidations,[]);
});

// Read the exact production functions, not copies of their hash formulas.
function bindingFunctions(){
 const filename=new URL('../app/api/v8/_store.ts',import.meta.url),source=readFileSync(filename,'utf8'),names=['deriveCurrentAdoptedMaterialSet','deriveCurrentMaterialRequirementSet','assetReviewContextHash','legacyAssetReviewContextHash','reviewBindsCurrentGraph'],ast=ts.createSourceFile(filename.pathname,source,ts.ScriptTarget.ESNext,true);
 const declarations=ast.statements.filter(node=>ts.isFunctionDeclaration(node)&&names.includes(node.name?.text)).map(node=>node.getText(ast));
 assert.equal(declarations.length,names.length);
 const js=ts.transpileModule(declarations.join('\n'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const module={exports:{}};
 const binding=new Function('module','exports','stableObjectHash','HttpError','resolveFormalReviewSpec','assetReviewOwnership',js+'\nreturn {'+names.join(',')+'};');
 return binding(module,module.exports,domainHash,Error,()=>({hash:'frozen-review-standard',legacy:false}),()=>({reviewable:true}));
}
test('V1/V2 material-set hashes and modern asset-review validation survive story-only/schema migration',()=>{
 const functions=bindingFunctions(),f=fixture(),before=withFrozenHash(f.snapshot,'2.0'),graph=clone(f.graph);graph.relations.push(story());
 const content={beats:[{materialRequirementRefs:['demand:fa']}]};
 before.productionModel.sceneCoveragePlanRevisions=[{id:'coverage',scopeId:'scene:a',scopeRole:'CURRENT',revisionState:'CURRENT',isCurrent:true,episodeNarrativeReleaseId:'release:episode',content,contentHash:domainHash(content)}];
 const after=project(before,graph),state={assetFamiliesById:{fa:{currentVersionId:'v:fa'}},assetVersionsById:{'v:fa':{familyId:'fa',sha256:'a'.repeat(64),lifecycleState:'RELEASED',canFlowDownstream:true}}};
 assert.deepEqual(functions.deriveCurrentAdoptedMaterialSet(after,state,'scene:a'),functions.deriveCurrentAdoptedMaterialSet(before,state,'scene:a'));
 assert.deepEqual(functions.deriveCurrentMaterialRequirementSet(after,'scene:a'),functions.deriveCurrentMaterialRequirementSet(before,'scene:a'));
 const event={schemaVersion:'2.0',subjectType:'ASSET',subjectId:'fa',familyId:'fa',versionId:'v:fa',versionSha256:'a'.repeat(64),reviewSpecHash:'frozen-review-standard',contextHash:functions.assetReviewContextHash(before,'fa','v:fa','a'.repeat(64))},bytes=JSON.stringify(event);
 assert.equal(functions.reviewBindsCurrentGraph(before,event),true);assert.equal(functions.reviewBindsCurrentGraph(after,event),true);assert.equal(JSON.stringify(event),bytes);
 assert.equal(after.productionModel.assetFamilies[0].domainContext.hash,before.productionModel.assetFamilies[0].domainContext.hash);
});
