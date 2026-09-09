import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {createServer} from 'vite';
import {apiFixture,pngs} from './material-native-revision-api.mjs';
import {changeDomain,imageRequirementId,imageRepresentationId} from '../material-production-fixture.mjs';
import {sha256} from '../../host/instance-runtime/bytes.mjs';
import {domainHash} from '../../host/instance-runtime/domain-model.mjs';
import {executionDefinitionHash} from '../../host/instance-runtime/execution-definition-hash.mjs';

// This fixture publishes a legacy imported adoption, producer source and actual
// PNG before changing DOMAIN. It never deletes a modern Review to fake legacy.
export async function legacyContextApiFixture(t){
 const f=await apiFixture(t),familyId='LEGACY-IMAGE-CONTEXT',versionId=familyId+'@V001',digest=sha256(pngs[0]),logical='media/legacy/context-image.png',physical='media/blobs/'+digest+'.png',sourceRef='production/legacy-context-producer.md',rawSourceBlock='Legacy image producer fixture: one neutral image, original imported adoption, no generated Run asserted.';
 await f.repo.writeTransaction(async tx=>{
  const view=await tx.readView(),snapshot=structuredClone(view.snapshot),recipes=structuredClone(view.recipes),model=snapshot.productionModel;
  const source=await tx.putDocument({documentId:'fixture:legacy-producer',aliases:[sourceRef],expectedRevisionId:null,bytes:'# Isolated import fixture\n\n'+rawSourceBlock+'\n',mediaType:'text/markdown',metadata:{sourceRole:'PROMPT_SOURCE'}});
  const definition={id:'LEGACY-CALL-CONTEXT',workItemRef:'LEGACY-WORK-CONTEXT',currentRevisionId:'LEGACY-PROMPT-CONTEXT',source:{path:sourceRef,blockSha256:sha256(rawSourceBlock)},rawSourceBlock,model:{branch:'historical-import-no-new-call'},prompt:{main:rawSourceBlock,negative:'None'},upload:{items:[]},output:{assetFamilyRef:familyId,assetVersionRef:versionId,path:logical,mediaType:'IMAGE'}};
  definition.definitionHash=executionDefinitionHash(definition);recipes.executionDefinitions.push(definition);
  model.assetFamilies.push({id:familyId,kind:'IMAGE',label:'Legacy current context fixture',scopeRole:'CURRENT',reviewOwner:'MATERIAL',ownerRef:definition.workItemRef,requirementRefs:[imageRequirementId],versionRefs:[],currentVersionId:null,currentExpectedOutputId:null,expectedOutputRefs:[],executionDefinitionRef:definition.id});
  model.materialWorkItems.push({id:definition.workItemRef,label:'Legacy producer work fixture',scopeRole:'CURRENT',activeInCurrentProduction:true,outputAssetRef:familyId,inputAssetRefs:[],requirementRef:imageRequirementId,executionDefinitionRef:definition.id,promptRef:definition.currentRevisionId});
  snapshot.snapshotId='snapshot_'+domainHash({previous:snapshot.snapshotId,fixtureSource:source.sha256}).slice(0,32);recipes.snapshotId=snapshot.snapshotId;
  await tx.publishRelease({snapshot,recipes,expectedReleaseId:view.releaseId,sourceRevisionIds:[...view.sourceRevisionIds,source.revisionId]});
 });
 const beforeBinding=await f.repo.readView(),rep=beforeBinding.snapshot.productionModel.domainGraph.representations.find(r=>r.id===imageRepresentationId);
 await changeDomain(f.repo,'MATERIAL',[{collection:'representations',id:rep.id,beforeHash:domainHash(rep),value:{...rep,assetFamilyIds:[familyId]}}]);
 await mkdir(path.dirname(path.join(f.root,physical)),{recursive:true});await writeFile(path.join(f.root,physical),pngs[0],{flag:'wx'});
 await f.repo.writeTransaction(async tx=>{
  const view=await tx.readView(),snapshot=structuredClone(view.snapshot),model=snapshot.productionModel,recipes=structuredClone(view.recipes),family=model.assetFamilies.find(x=>x.id===familyId);
  const released={reviewDecision:'RELEASED',lifecycleState:'RELEASED',canFlowDownstream:true,projectRightsGate:'CLEAR',publishState:'RELEASED',outputState:'PRESENT'};
  Object.assign(family,released,{versionRefs:[versionId],currentVersionId:versionId,latestVersionId:versionId});
  const requirement=model.materialRequirements.find(r=>r.id===imageRequirementId);
  model.assetVersions.push({id:versionId,familyId,path:logical,sha256:digest,byteSize:pngs[0].length,kind:'IMAGE',label:'Imported legacy V001',scopeRole:'CURRENT',executionDefinitionRef:family.executionDefinitionRef,materialRequirementBindings:[{requirementRef:requirement.id,requirementHash:requirement.requirementHash}],inputBindings:[],parentVersionId:null,legacyState:{approvalStatus:'APPROVED',qaStatus:'PASS',materializationState:'GENERATED'},...released});
  await tx.registerMedia({mediaId:familyId,versionId,relativePath:physical,aliases:[logical],sha256:digest,byteSize:pngs[0].length,metadata:{authorityDomain:'IMPORTED_EVIDENCE',visibility:'PUBLIC',sourceRole:'GENERATED',mediaType:'IMAGE'}});
  snapshot.snapshotId='snapshot_'+domainHash({previous:snapshot.snapshotId,legacyAdoption:versionId}).slice(0,32);recipes.snapshotId=snapshot.snapshotId;
  await tx.publishRelease({snapshot,recipes,expectedReleaseId:view.releaseId,sourceRevisionIds:view.sourceRevisionIds});
 });
 const adopted=await f.repo.readView();assert.equal((adopted.eventsByKind.review||[]).length,0);assert.equal((adopted.eventsByKind['asset-version']||[]).length,0);assert.equal((adopted.eventsByKind.run||[]).length,0);
 assert.equal((await f.store.operationalSnapshot()).stateProjection.assetVersionsById[versionId].canFlowDownstream,true);
 const entity=adopted.snapshot.productionModel.domainGraph.entities.find(r=>r.id==='character:letter-writer');
 await changeDomain(f.repo,'SETTINGS',[{collection:'entities',id:entity.id,beforeHash:domainHash(entity),value:{...entity,description:'New explicit use condition; the same imported original needs exact current-domain observation.'}}]);
 const changed=await f.repo.readView();assert(changed.snapshot.productionModel.domainInvalidations.some(r=>r.familyId===familyId&&r.versionIds.includes(versionId)));
 assert.equal((await f.store.operationalSnapshot()).stateProjection.assetVersionsById[versionId].canFlowDownstream,false);
 const server=await createServer({root:f.softwareRoot,configFile:false,logLevel:'error',cacheDir:path.join(f.root,'context-vite-cache'),server:{middlewareMode:true,hmr:false,ws:false},appType:'custom'}),store=await server.ssrLoadModule('/app/api/v8/_store.ts'),repo=await store.instanceRepository(),route=await server.ssrLoadModule('/app/api/instance/asset-context-revalidation/route.ts');
 t.after(async()=>{await repo.close();await server.close();});
 const target={familyId,versionId,sha256:digest},api={projectOperationalState:store.projectOperationalState,assetReviewContextHash:store.assetReviewContextHash,assetReviewTransitionProjection:store.assetReviewTransitionProjection,safeGeneratedPath:store.safeGeneratedPath,hashStableFile:store.hashStableFile};
 const workspace=async(extra={})=>{const res=await route.GET(new Request('http://localhost/api/instance/asset-context-revalidation?'+new URLSearchParams({...target,...extra})));return {status:res.status,body:await res.json()};};
 const post=(body,options)=>f.post(route,'instance/asset-context-revalidation',{...target,...body},options);
 const observation=w=>({purpose:'LEGACY_ADOPTION_DOMAIN_REVALIDATION',action:'CONFIRM_CURRENT_DOMAIN',observedVersionId:versionId,observedSha256:digest,criterionFindings:w.reviewSpec.criteria.map(c=>({criterionId:c.id,verdict:'PASS',note:'Synthetic PNG fixture validates the protocol only; no real image quality claim.'})),note:'Isolated imported-image current-domain revalidation; preserve all original adoption, source, media and rights records.'});
 const saveBody=w=>({action:'save',expectedReleaseId:w.releaseId,expectedBasisHash:w.basisHash,expectedDraftRevisionId:w.draftHeadRevisionId,content:observation(w)});
 return {...f,target,sourceRef,physical,changed,api,workspace,post,saveBody,observation,contextStore:store,basePost:f.post};
}

export async function queueAssetContextFixture(f,{key='context-fixture:publish'}={}){
 const current=await f.workspace();assert.equal(current.status,200,JSON.stringify(current.body));assert.deepEqual(current.body.blockers,[]);
 const saved=await f.post(f.saveBody(current.body));assert.equal(saved.status,200,JSON.stringify(saved.body));
 const preview=await f.post({action:'preview',draftRevisionId:saved.body.revisionId});assert.equal(preview.status,200,JSON.stringify(preview.body));assert.equal(preview.body.formalAdoptionPerformed,false);assert.equal(preview.body.modelCalls,0);
 const body={action:'publish',draftRevisionId:saved.body.revisionId,previewHash:preview.body.previewHash},queued=await f.post(body,{key});assert.equal(queued.status,200,JSON.stringify(queued.body));assert.equal(queued.body.status,'QUEUED');assert.deepEqual(await f.post(body,{key}),queued);
 return {current:current.body,saved:saved.body,preview:preview.body,queued:queued.body};
}

export async function readAssetContextFixtureProof(f){
 return f.repo.readTransaction(async tx=>{
  const view=await tx.readView(),documents=await Promise.all(view.sourceRevisionIds.map(id=>tx.readDocumentRevision(id))),events=await tx.listEvents(),releases=new Map();
  for(const source of documents.filter(d=>d.metadata?.sourceRole==='ASSET_CONTEXT_REVALIDATION')){
   const body=JSON.parse(source.bytes),release=await tx.readRelease(body.baseReleaseId);
   releases.set(body.baseReleaseId,{release,snapshot:JSON.parse(release.snapshotBytes),recipes:JSON.parse(release.recipesBytes)});
  }
  return {snapshot:view.snapshot,recipes:view.recipes,documents,events,releaseContext:(_event,body)=>releases.get(body.baseReleaseId),releases};
 });
}
