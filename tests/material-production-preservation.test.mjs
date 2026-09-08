import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {canonicalJson,sha256} from '../host/instance-runtime/bytes.mjs';
import {domainHash} from '../host/instance-runtime/domain-model.mjs';
import {projectDomainGraph,preserveDomainProjection} from '../host/instance-runtime/domain-projection.mjs';
import {refreshDirectoryProjection} from '../host/instance-runtime/directory-projection.mjs';
import {executionDefinitionHash,SHOT_PRODUCTION_DEFINITION_HASH_SCHEMA} from '../host/instance-runtime/execution-definition-hash.mjs';
import {preserveMaterialProductionProjection,preserveMaterialProductionRequirementProvenance} from '../host/instance-runtime/material-production-preservation.mjs';
import {materialProductionFixture,legacyObjects,imageRequirementId,audioRequirementId} from './material-production-fixture.mjs';
import {getMaterialProductionWorkspace,saveMaterialProductionDraft,previewMaterialProduction,enqueueMaterialProduction,applyMaterialProductionJob} from '../host/instance-runtime/material-production-service.mjs';

const copy=structuredClone;
const conflict={code:'MATERIAL_PRODUCTION_SOURCE_CONFLICT'};
function fixture(){
 const sceneId='scene-letter',sceneRevisionId='scene-script-r1';
 const graph={schemaVersion:'1.0',entities:[{id:'person-letter',type:'CHARACTER',name:'写信人',authority:'A'}],states:[],relations:[],representations:[],requirements:[]};
 for(const [suffix,mediaType,type] of [['identity','IMAGE','IDENTITY'],['voice','AUDIO','VOICE_IDENTITY']]){
  const id='rep-'+suffix,requirementId='req-'+suffix;
  graph.representations.push({id,entityId:'person-letter',stateId:null,type,label:suffix,dimensions:{},assetFamilyIds:[],requirementIds:[requirementId],authority:'A',evidence:[]});
  graph.requirements.push({id:requirementId,title:suffix,representationId:id,mediaType,category:suffix,reuseScope:'PROJECT',scope:[{scopeType:'SCENE',scopeId:sceneId,revisionId:sceneRevisionId}],acceptanceCriteria:['可核对身份与制作状态'],evidence:[]});
 }
 let snapshot=projectDomainGraph({productionModel:{assetFamilies:[],materialRequirements:[],assetVersions:[],expectedOutputs:[],workItems:[],materialWorkItems:[],reviewContexts:[],materialProductionPlans:[],sceneScriptRevisions:[{id:sceneRevisionId,sceneId}]}},graph,{revisionId:'graph-initial',sha256:domainHash(graph)});
 const model=snapshot.productionModel,recipes={executionDefinitions:[],promptRevisions:[]},documents=[];
 const legacy={id:'legacy-family',kind:'IMAGE',reviewOwner:'MATERIAL',versionRefs:[],domainContext:{hash:'legacy-frozen-hash',hashSchemaVersion:'1.0',representationIds:[],entityIds:[],relationIds:[]}};
 model.assetFamilies.push(legacy);model.materialRequirements.push({id:'legacy-req',sourceKind:'LEGACY',requirementClass:'REQUIRED',assetFamilyRefs:['legacy-family'],requirementHash:'legacy-frozen-requirement',sourceRef:'legacy/fixed.json'});
 model.workItems.push({id:'legacy-work',outputAssetRef:legacy.id,executionDefinitionRef:'legacy-definition'});recipes.executionDefinitions.push({id:'legacy-definition',workItemRef:'legacy-work',definitionHash:'legacy-frozen-definition'});
 for(const suffix of ['identity','voice']){
  const prior=snapshot.productionModel,id='MP-PLAN-'+suffix,familyId='MP-FAMILY-'+suffix,workItemId='MP-WORK-'+suffix,expectedOutputId='MP-EO-'+suffix,definitionId='MP-CALL-'+suffix,requirementId='req-'+suffix,representationId='rep-'+suffix;
  const sourcePath='story/material-production/plans/'+id+'.json',requirementBefore=copy(prior.materialRequirements.find(row=>row.id===requirementId)),beforeRepresentation=copy(prior.domainGraph.representations.find(row=>row.id===representationId));
  const afterGraph=copy(prior.domainGraph),afterRepresentation=afterGraph.representations.find(row=>row.id===representationId);afterRepresentation.assetFamilyIds=[familyId];
  const afterHash=domainHash(afterGraph),graphRevisionId='graph-'+suffix,mediaType=requirementBefore.mediaType;
  const family={id:familyId,kind:mediaType,label:suffix,sourceRef:sourcePath,reviewOwner:'MATERIAL',ownerRef:workItemId,requirementRefs:[requirementId],versionRefs:[],currentVersionId:null,expectedOutputRefs:[expectedOutputId],currentExpectedOutputId:expectedOutputId};
  const output={id:expectedOutputId,familyId,mediaType,expectationState:'PLANNED',realizedVersionId:null,targetPath:'media/formal/'+familyId+'/V001.'+(mediaType==='IMAGE'?'png':'wav')};
  prior.assetFamilies.push(family);prior.expectedOutputs.push(output);
  const beforeGraphRef=copy(prior.domainGraphRef);
  snapshot=projectDomainGraph(snapshot,afterGraph,{revisionId:graphRevisionId,sha256:afterHash},{preserveReferencePolicies:true});
  // The host preserves unrelated immutable source rows rather than changing
  // their sourceRef every time another representation receives its first family.
  for(const row of snapshot.productionModel.materialRequirements){const old=prior.materialRequirements.find(r=>r.id===row.id);if(old?.requirementHash===row.requirementHash)Object.assign(row,copy(old));}
  snapshot.productionModel.assetFamilies.find(row=>row.id===legacy.id).domainContext=copy(legacy.domainContext);
  const requirementAfter=snapshot.productionModel.materialRequirements.find(row=>row.id===requirementId);requirementAfter.sourceRef=sourcePath+'#requirement';requirementAfter.materialWorkItemRef=workItemId;requirementAfter.plannedAssetFamilyId=familyId;
  const workContext={id:'MP-CONTEXT-'+suffix,workItemRef:workItemId,purpose:'核对正式基础素材',requirementHash:requirementAfter.requirementHash};
  const work={id:workItemId,label:suffix,sourceRef:sourcePath,requirementRef:requirementId,outputAssetRef:familyId,reviewContextRef:workContext.id,inputAssetRefs:[],executionDefinitionRef:definitionId,promptRef:definitionId+':r1'};
  const definition={id:definitionId,currentRevisionId:work.promptRef,definitionHashSchemaVersion:SHOT_PRODUCTION_DEFINITION_HASH_SCHEMA,executorKind:'MODEL_CALL',workItemRef:workItemId,materialProductionPlanId:id,materialRequirementRef:requirementId,materialRequirementHash:requirementAfter.requirementHash,model:{branch:'fixture'},prompt:{main:'制作可验证的干净母版',negative:'无水印'},output:{assetFamilyRef:familyId,expectedOutputRef:expectedOutputId,path:output.targetPath}};
  definition.definitionHash=executionDefinitionHash(definition);
  const prompt={id:work.promptRef,executionDefinitionId:definitionId,definitionHash:definition.definitionHash,prompt:copy(definition.prompt)},basis={requirementId,requirementHash:requirementBefore.requirementHash,graphRef:beforeGraphRef},basisHash=domainHash(basis);
  const body={schemaVersion:'MATERIAL_PRODUCTION_PLAN_V1',id,requirementId,representationId,draftRevisionId:'draft-'+suffix,baseReleaseId:'release-before-'+suffix,basis,basisHash,graphBinding:{before:beforeGraphRef,after:{sha256:afterHash},representationId,beforeRepresentation,afterRepresentation:copy(afterRepresentation),requirement:copy(afterGraph.requirements.find(row=>row.id===requirementId))},requirementBefore,requirementAfter:copy(requirementAfter),assetFamily:copy(snapshot.productionModel.assetFamilies.find(row=>row.id===familyId)),expectedOutput:copy(output),materialWorkItem:work,workContext,executionDefinition:definition,promptRevision:prompt,configurationBinding:null,reviewSpecRef:null,authoringContent:{model:'fixture',prompt:definition.prompt.main,negativePrompt:definition.prompt.negative,parameters:{}},inputBindings:[]};
  const bytes=Buffer.from(canonicalJson(body)),doc={documentId:'doc-'+suffix,revisionId:'source-'+suffix,sha256:sha256(bytes),bytes,aliases:[sourcePath],metadata:{sourceRole:'MATERIAL_PRODUCTION_PLAN'}};
  documents.push(doc);
  const source={sourceRef:sourcePath,sourceRevisionId:doc.revisionId,sourceSha256:doc.sha256};
  recipes.executionDefinitions.push({...copy(definition),...source});recipes.promptRevisions.push({...copy(prompt),...source});
  snapshot.productionModel.materialProductionPlans.push({id,requirementId,representationId,familyId,workItemId,expectedOutputId,definitionId,requirementHash:requirementAfter.requirementHash,basisHash,graphRevisionId,graphSha256:afterHash,sourcePath,sourceRevisionId:doc.revisionId,sourceSha256:doc.sha256});
  snapshot.productionModel.materialWorkItems.push(copy(work));snapshot.productionModel.reviewContexts.push(copy(workContext));
 }
 return {baseSnapshot:snapshot,baseRecipes:recipes,documents};
}
function compilerOutput(f){
 const snapshot=copy(f.baseSnapshot),recipes=copy(f.baseRecipes),model=snapshot.productionModel,plans=model.materialProductionPlans,workIds=new Set(plans.map(row=>row.workItemId)),familyIds=new Set(plans.map(row=>row.familyId));
 for(const key of ['assetFamilies','assetVersions','expectedOutputs'])model[key]=model[key].filter(row=>!familyIds.has(row.familyId||row.id));
 for(const key of ['workItems','materialWorkItems'])model[key]=model[key].filter(row=>!workIds.has(row.id));
 model.reviewContexts=[];model.materialProductionPlans=[];model.domainGraph={schemaVersion:'1.0',entities:[],states:[],relations:[],representations:[],requirements:[]};model.domainGraphRef=null;
 model.materialRequirements=model.materialRequirements.filter(row=>row.sourceKind!=='DOMAIN_GRAPH');
 recipes.executionDefinitions=recipes.executionDefinitions.filter(row=>!workIds.has(row.workItemRef));recipes.promptRevisions=[];
 return {snapshot,recipes};
}
function preserve(f){
 const result=preserveMaterialProductionProjection({...f,...compilerOutput(f)});
 result.snapshot=preserveMaterialProductionRequirementProvenance({snapshot:preserveDomainProjection({snapshot:result.snapshot,baseSnapshot:f.baseSnapshot}),baseSnapshot:f.baseSnapshot});
 return result;
}
test('story or Prompt source compilation preserves IMAGE and AUDIO production closures, current graph and exact requirement provenance',()=>{
 const f=fixture(),before=canonicalJson(f),result=preserve(f),actual=result.snapshot.productionModel,expected=f.baseSnapshot.productionModel;
 for(const key of ['materialProductionPlans','assetFamilies','assetVersions','expectedOutputs','workItems','materialWorkItems','reviewContexts','materialRequirements','domainGraph','domainGraphRef'])assert.deepEqual(actual[key],expected[key],key);
 assert.deepEqual(result.recipes,f.baseRecipes);assert.equal(canonicalJson(f),before);
 for(const plan of actual.materialProductionPlans){const requirement=actual.materialRequirements.find(row=>row.id===plan.requirementId);assert.deepEqual(requirement.assetFamilyRefs,[plan.familyId]);assert.equal(requirement.requirementHash,plan.requirementHash);assert.equal(requirement.sourceRef,plan.sourcePath+'#requirement');}
 assert(!actual.domainRelationAudit.some(row=>actual.materialProductionPlans.some(plan=>plan.familyId===row.id)));
});
test('every plan requires its exact historical source revision, role, alias, SHA and original content',()=>{
 for(const mutate of [f=>f.documents.shift(),f=>f.documents[0].bytes=Buffer.concat([f.documents[0].bytes,Buffer.from(' ')]),f=>f.documents[0].aliases=[],f=>f.documents[0].metadata.sourceRole='TRIAL',f=>f.documents[0].deleted=true,f=>f.baseSnapshot.productionModel.materialProductionPlans[0].sourceRevisionId=f.documents[1].revisionId,f=>f.documents.push(copy(f.documents[0])),f=>f.baseSnapshot.productionModel.materialProductionPlans[0].basisHash=domainHash('wrong')]){
  const f=fixture();mutate(f);assert.throws(()=>preserve(f),conflict);
 }
});
test('same source bytes cannot be rebound to another requirement, representation, family or recipe',()=>{
 for(const field of ['requirementId','representationId','familyId','workItemId','expectedOutputId','definitionId','requirementHash','graphSha256']){
  const f=fixture();f.baseSnapshot.productionModel.materialProductionPlans[0][field]='wrong';assert.throws(()=>preserve(f),conflict,field);
 }
});
test('missing production members and changed ownership fail instead of preserving a partial family-only projection',()=>{
 for(const key of ['assetFamilies','expectedOutputs','materialWorkItems','reviewContexts']){const f=fixture();f.baseSnapshot.productionModel[key]=[];assert.throws(()=>preserve(f),conflict,key);}
 for(const mutate of [m=>m.materialWorkItems.find(row=>row.id==='MP-WORK-identity').requirementRef='other-demand',m=>m.materialWorkItems[0].reviewContextRef='other-context',m=>m.assetFamilies.find(row=>row.id==='MP-FAMILY-identity').reviewOwner='WORK_PRODUCT',m=>m.reviewContexts[0].purpose='changed']){const f=fixture();mutate(f.baseSnapshot.productionModel);assert.throws(()=>preserve(f),conflict);}
});
test('all registered versions and later ExpectedOutputs survive without resetting the first empty family',()=>{
 const f=fixture(),model=f.baseSnapshot.productionModel,plan=model.materialProductionPlans[0],family=model.assetFamilies.find(row=>row.id===plan.familyId);
 const output={...copy(model.expectedOutputs.find(row=>row.id===plan.expectedOutputId)),id:plan.expectedOutputId+'-next',expectationState:'REALIZED',realizedVersionId:'version-two'};
 model.expectedOutputs.push(output);family.expectedOutputRefs.push(output.id);family.currentExpectedOutputId=output.id;
 for(const n of ['one','two']){const version={id:'version-'+n,familyId:family.id,sha256:domainHash('registered-'+n),path:'media/formal/'+family.id+'/'+n+'.png'};family.versionRefs.push(version.id);model.assetVersions.push(version);}
 family.currentVersionId='version-two';
 assert.deepEqual(preserve(f).snapshot.productionModel.assetFamilies,model.assetFamilies);assert.deepEqual(preserve(f).snapshot.productionModel.assetVersions,model.assetVersions);
 for(const key of ['assetVersions','expectedOutputs']){const broken=copy(f);broken.baseSnapshot.productionModel[key].pop();assert.throws(()=>preserve(broken),conflict);}
});
test('current domain changes invalidate current bindings without rewriting or resurrecting original production history',()=>{
 const f=fixture(),prior=copy(f.baseSnapshot.productionModel),graph=copy(prior.domainGraph);graph.representations.find(row=>row.id==='rep-identity').assetFamilyIds=[];
 f.baseSnapshot=projectDomainGraph(f.baseSnapshot,graph,{revisionId:'explicit-unlink',sha256:domainHash(graph)},{preserveReferencePolicies:true});
 const result=preserve(f),model=result.snapshot.productionModel;
 assert.deepEqual(model.domainGraph,graph);assert.deepEqual(model.materialRequirements.find(row=>row.id==='req-identity').assetFamilyRefs,[]);
 assert.notEqual(model.materialRequirements.find(row=>row.id==='req-identity').requirementHash,prior.materialProductionPlans[0].requirementHash);
 assert.deepEqual(model.materialProductionPlans,prior.materialProductionPlans);assert.deepEqual(result.recipes,f.baseRecipes);
 assert(model.assetFamilies.some(row=>row.id==='MP-FAMILY-identity'));
 const stale=fixture();stale.baseSnapshot.productionModel.sceneScriptRevisions=[];const after=preserve(stale).snapshot.productionModel;
 assert(after.materialRequirements.filter(row=>row.sourceKind==='DOMAIN_GRAPH').every(row=>row.requirementClass==='EVIDENCE_ONLY'&&row.domainScopeStatus==='STALE_SCOPE_REQUIRES_EXPLICIT_REBIND'));
});
test('recipe, exact prompt and original source envelopes must remain intact',()=>{
 for(const mutate of [f=>f.baseRecipes.executionDefinitions=f.baseRecipes.executionDefinitions.filter(row=>row.id!=='MP-CALL-identity'),f=>f.baseRecipes.promptRevisions.shift(),f=>f.baseRecipes.promptRevisions[0].prompt.main='changed',f=>f.baseRecipes.executionDefinitions[1].sourceRevisionId='other-source',f=>f.baseRecipes.executionDefinitions[1].output.assetFamilyRef='legacy-family',f=>f.baseSnapshot.productionModel.materialWorkItems.find(row=>row.id==='MP-WORK-identity').executionDefinitionRef='legacy-definition']){
  const f=fixture();mutate(f);assert.throws(()=>preserve(f),conflict);
 }
});
test('compiler collisions cannot overwrite frozen material or recipe bytes',()=>{
 const f=fixture(),output=compilerOutput(f),family=copy(f.baseSnapshot.productionModel.assetFamilies.find(row=>row.id==='MP-FAMILY-identity'));family.label='compiler replacement';output.snapshot.productionModel.assetFamilies.push(family);
 assert.throws(()=>preserveMaterialProductionProjection({...f,...output}),conflict);
 const recipeOutput=compilerOutput(f);recipeOutput.recipes.executionDefinitions.push({...copy(f.baseRecipes.executionDefinitions[1]),title:'compiler replacement'});assert.throws(()=>preserveMaterialProductionProjection({...f,...recipeOutput}),conflict);
});
test('optional directory repair binds complete before/after content and never reassigns the target entity or state',()=>{
 const f=fixture(),plan=f.baseSnapshot.productionModel.materialProductionPlans[0],doc=f.documents[0],body=JSON.parse(doc.bytes);
 const beforeBinding={requirementId:plan.requirementId,requirementHash:body.requirementBefore.requirementHash,representationId:plan.representationId,representationHash:domainHash(body.graphBinding.beforeRepresentation),entityId:'person-letter',stateId:'directory-state'};
 const beforeContent={directoryBindings:[beforeBinding],newStates:[{id:'directory-state',entityId:'person-letter'}]},afterBinding={...beforeBinding,requirementHash:body.requirementAfter.requirementHash,representationHash:domainHash(body.graphBinding.afterRepresentation)},afterContent={...copy(beforeContent),directoryBindings:[afterBinding]};
 body.directoryBinding={requirementId:plan.requirementId,before:{revisionId:'directory-before',sha256:domainHash(beforeContent)},after:{sha256:domainHash(afterContent)},beforeBinding,afterBinding,beforeContent,afterContent};
 Object.assign(plan,{directoryRevisionId:'directory-after',directorySha256:domainHash(afterContent)});
 const repin=(f,body)=>{const doc=f.documents[0],plan=f.baseSnapshot.productionModel.materialProductionPlans[0];doc.bytes=Buffer.from(canonicalJson(body));doc.sha256=sha256(doc.bytes);plan.sourceSha256=doc.sha256;for(const key of ['executionDefinitions','promptRevisions'])for(const row of f.baseRecipes[key])if(row.sourceRevisionId===doc.revisionId)row.sourceSha256=doc.sha256;};
 repin(f,body);
 f.baseSnapshot.productionModel.materialDirectory=refreshDirectoryProjection(f.baseSnapshot.productionModel,{content:afterContent,revisionId:plan.directoryRevisionId,sha256:plan.directorySha256});
 const result=preserve(f).snapshot.productionModel.materialDirectory;assert.deepEqual(result.bindings,[afterBinding]);assert.deepEqual(result.staleIds,[]);assert.equal(result.sourceSha256,plan.directorySha256);
 for(const mutate of [body=>body.directoryBinding.afterBinding.entityId='other-person',body=>body.directoryBinding.afterContent.newStates[0].entityId='other-person',body=>body.directoryBinding.before.sha256=domainHash('other'),body=>body.directoryBinding.after.sha256=domainHash('other')]){const broken=copy(f),value=JSON.parse(Buffer.from(broken.documents[0].bytes).toString('utf8'));mutate(value);repin(broken,value);assert.throws(()=>preserve(broken),conflict);}
 const changed=copy(f);changed.baseSnapshot.productionModel.materialProductionPlans[0].directoryRevisionId=null;assert.throws(()=>preserve(changed),conflict);
});
test('shared source and extension compiler restores material closure before domain projection and provenance after it',()=>{
 const source=readFileSync(new URL('../host/instance-source-compiler.mjs',import.meta.url),'utf8');
 assert(source.includes("compilePinnedInstance(input, 'SOURCE_SYNC')"));assert(source.includes("compilePinnedInstance(input, 'EXTENSION_COMPATIBILITY')"));
 const closure=source.indexOf('const materialProduction=preserveMaterialProductionProjection('),domain=source.indexOf('const domain=preserveDomainProjection('),provenance=source.indexOf('snapshot:domain,baseSnapshot:publishedSnapshot');
 assert(closure>0&&domain>closure&&provenance>domain);
});

for(const includeAudioBinding of [true,false])test(`real host-published IMAGE/AUDIO closures retain directory ownership (${includeAudioBinding?'both targets bound':'audio has no directory override'})`,async t=>{
 const {repo}=await materialProductionFixture(t);
 const api={projectOperationalState(snapshot){const model=snapshot.productionModel;return {assetFamiliesById:Object.fromEntries(model.assetFamilies.map(row=>[row.id,row])),assetVersionsById:Object.fromEntries(model.assetVersions.map(row=>[row.id,row]))};},projectEpisodeNarrativeReleases(){return {};},projectedReviewIndexes(){return {bySubject:[]};},projectedStructureReviewIndexes(){return {bySubject:[]};},projectedScopeLocks(){return {};}};
 const old=legacyObjects(await repo.readView());
 await repo.writeTransaction(async tx=>{
  const view=await tx.readView(),model=view.snapshot.productionModel,ids=includeAudioBinding?[imageRequirementId,audioRequirementId]:[imageRequirementId];
  const bindings=ids.map(id=>{const requirement=model.materialRequirements.find(row=>row.id===id),representation=model.domainGraph.representations.find(row=>row.id===requirement.representationRef);return {requirementId:id,requirementHash:requirement.requirementHash,representationId:representation.id,representationHash:domainHash(representation),entityId:representation.entityId,stateId:'fixture-directory-state'};});
  const content={directoryBindings:bindings,newStates:[{id:'fixture-directory-state',entityId:'character:letter-writer'}],sourceBindings:[]};
  const record=await tx.putAux({namespace:'material-directory',key:'current',expectedRevisionId:null,bytes:canonicalJson(content),mediaType:'application/json'}),snapshot=copy(view.snapshot);
  snapshot.productionModel.materialDirectory=refreshDirectoryProjection(snapshot.productionModel,{content,revisionId:record.revisionId,sha256:record.sha256});
  await tx.publishRelease({snapshot,recipes:view.recipes,expectedReleaseId:view.releaseId,sourceRevisionIds:view.sourceRevisionIds});
 });
 for(const requirementId of [imageRequirementId,audioRequirementId]){
  const directoryBefore=await repo.getAux('material-directory','current'),beforeContent=JSON.parse(directoryBefore.bytes),target=beforeContent.directoryBindings.find(row=>row.requirementId===requirementId);
  const workspace=await repo.readTransaction(tx=>getMaterialProductionWorkspace(tx,{requirementId,api}));
  const content={model:'fixture-no-model-call',prompt:'建立本次主体的独立母版',negativePrompt:'不使用不明身份参考',parameters:{},inputBindings:[]};
  const draft=await repo.writeTransaction(tx=>saveMaterialProductionDraft(tx,{requirementId,expectedReleaseId:workspace.releaseId,expectedDraftRevisionId:workspace.draftHeadRevisionId,content},{api}));
  const preview=await repo.readTransaction(tx=>previewMaterialProduction(tx,{requirementId,draftRevisionId:draft.revisionId},{api}));
  const job=await repo.writeTransaction(tx=>enqueueMaterialProduction(tx,{requirementId,draftRevisionId:draft.revisionId,previewHash:preview.previewHash,requestId:'preservation:'+requirementId},{api}));
  const result=await repo.writeTransaction(tx=>applyMaterialProductionJob(tx,{jobId:job.jobId,api}));assert.equal(result.modelCalls,0);
  const directoryAfter=await repo.getAux('material-directory','current'),afterContent=JSON.parse(directoryAfter.bytes);
  if(target){
   assert.notEqual(directoryAfter.revisionId,directoryBefore.revisionId);const afterBinding=afterContent.directoryBindings.find(row=>row.requirementId===requirementId);
   assert.notEqual(afterBinding.requirementHash,target.requirementHash);assert.notEqual(afterBinding.representationHash,target.representationHash);assert.equal(afterBinding.entityId,target.entityId);assert.equal(afterBinding.stateId,target.stateId);
   assert.deepEqual(afterContent.directoryBindings.filter(row=>row.requirementId!==requirementId),beforeContent.directoryBindings.filter(row=>row.requirementId!==requirementId));
  }else{assert.equal(directoryAfter.revisionId,directoryBefore.revisionId);assert.deepEqual(directoryAfter.bytes,directoryBefore.bytes);}
 }
 const view=await repo.readView(),f={baseSnapshot:view.snapshot,baseRecipes:view.recipes,documents:await Promise.all(view.sourceRevisionIds.map(id=>repo.readDocumentRevision(id)))};
 const result=preserve(f),expected=view.snapshot.productionModel,actual=result.snapshot.productionModel;
 for(const key of ['assetFamilies','expectedOutputs','materialWorkItems','reviewContexts','materialProductionPlans','domainGraph','domainGraphRef'])assert.deepEqual(actual[key],expected[key],key);
 assert.deepEqual(Object.fromEntries(actual.materialRequirements.map(row=>[row.id,row])),Object.fromEntries(expected.materialRequirements.map(row=>[row.id,row])));
 assert.deepEqual(result.recipes,view.recipes);assert.deepEqual(legacyObjects({snapshot:result.snapshot,recipes:result.recipes}),old);
 assert(!actual.workItems.some(row=>actual.materialProductionPlans.some(plan=>plan.workItemId===row.id)));
 for(const plan of actual.materialProductionPlans){const req=actual.materialRequirements.find(row=>row.id===plan.requirementId);assert.equal(req.materialWorkItemRef,plan.workItemId);assert.equal(req.plannedAssetFamilyId,plan.familyId);}
 assert.equal(actual.assetVersions.length,0);assert.equal((await repo.listMedia()).length,0);
 assert.deepEqual(actual.materialDirectory.bindings,expected.materialDirectory.bindings);assert.deepEqual(actual.materialDirectory.staleIds,[]);assert.equal(actual.materialDirectory.sourceSha256,expected.materialDirectory.sourceSha256);
 const missing=copy(f);missing.documents.pop();assert.throws(()=>preserve(missing),conflict);
});
