import test from 'node:test';
import assert from 'node:assert/strict';
import {projectProductionMaterials,filterProductionMaterials,productionMaterialLocation} from '../host/instance-runtime/production-materials.mjs';
import {parseProductionMaterialQuery,queryProductionMaterialPage} from '../host/instance-runtime/production-material-query.mjs';
const sha='a'.repeat(64);
function fixture(){
 const model={workItems:[],workPackages:[],assetFamilies:[],assetVersions:[],expectedOutputs:[],shots:[{id:'shot-1',sceneId:'scene-1',episodeUid:'episode-1',shotPlanSetRevisionId:'plan-r1'}],scenes:[{id:'scene-1'}],episodes:[{id:'episode-1',episodeUid:'episode-1'}],reviewContexts:[],materialRequirements:[{id:'requirement-existing',requirementClass:'REQUIRED'}],domainGraph:{entities:[{id:'person-1'},{id:'person-2'}],representations:[]}};
 function add(id,deliverableKey,options={}){
   const scopeType=options.scopeType||'SHOT',scopeId=scopeType==='SCENE'?'scene-1':'shot-1';
   const item={id:'work-'+id,deliverableKey,scopeType,scopeId,episodeUid:'episode-1',sceneId:'scene-1',shotId:scopeType==='SHOT'?'shot-1':null,activeInCurrentProduction:true,scopeRole:'CURRENT',gateId:options.gateId||'KEYFRAMES',outputAssetRef:id,inputAssetRefs:[],...options.item};
   const parent={id:'package-'+id,scopeType,scopeId,workItemRefs:[item.id],shotIds:['shot-1'],activeInCurrentProduction:true,scopeRole:'CURRENT',...options.parent};
   const family={id,label:'同一构图 '+id,ownerRef:item.id,versionRefs:[],expectedOutputRefs:['expected-'+id],currentVersionId:null,currentExpectedOutputId:'expected-'+id,scopeRole:'CURRENT',...options.family};
   model.workItems.push(item);model.workPackages.push(parent);model.assetFamilies.push(family);model.expectedOutputs.push({id:'expected-'+id,familyId:id});
   return{item,parent,family};
 }
 return{model,add};
}
test('production catalogue shares asset identity without introducing entities or requirements',()=>{
 const {model,add}=fixture();const {family}=add('board','STORYBOARD');add('animatic','ANIMATIC',{scopeType:'SCENE'});const before=structuredClone(model);
 const result=projectProductionMaterials(model);assert.equal(result.rows.length,2);assert.deepEqual(model,before);assert.equal(result.rows.find(row=>row.id==='board').producerOwnerRef,'work-board');assert.equal(family.ownerRef,'work-board');
 assert.deepEqual(result.rows.find(row=>row.id==='animatic').scopeOwner,{type:'SCENE',id:'scene-1',revisionId:null});
 assert.deepEqual(result.rows.find(row=>row.id==='board').scopeOwner,{type:'SHOT',id:'shot-1',revisionId:'plan-r1'});
 assert.equal(model.materialRequirements.length,1);assert.equal(model.domainGraph.entities.length,2);
});
test('temporary dialogue, optional middle frames and genuine files remain separate facts',()=>{
 const {model,add}=fixture();add('temp','DIALOGUE_DRY',{item:{usageRole:'TEMPORARY'}});add('final','DIALOGUE_DRY');add('middle','MIDDLE_FRAME');
 const rows=projectProductionMaterials(model).rows;assert.equal(rows.find(row=>row.id==='temp').kind,'TEMP_DIALOGUE');assert.equal(rows.find(row=>row.id==='final').kind,'DIALOGUE');assert.equal(rows.find(row=>row.id==='middle').kind,'MIDDLE_FRAME');
 for(const row of rows){assert.equal(row.currentVersionId,null);assert.equal(row.outputState,'NOT_PRODUCED');assert.equal(row.presentVersionIds.length,0);}
});
test('historical work, planning skeletons and ambiguous producers never reenter the current denominator',()=>{
 for(const changes of [{activeInCurrentProduction:false},{scopeRole:'HISTORICAL'},{activityRole:'HISTORICAL_EVIDENCE'},{activityRole:'PLANNING_SKELETON'},{templateOnly:true}]){
  const {model,add}=fixture();add('old','STORYBOARD',{item:changes});assert.deepEqual(projectProductionMaterials(model).rows,[]);
 }
 const {model,add}=fixture();const {item}=add('shared','STORYBOARD');model.workItems.push({...item,id:'second-producer'});const result=projectProductionMaterials(model);assert.equal(result.rows.length,0);assert.equal(result.issues[0].code,'AMBIGUOUS_PRODUCER');
});
test('scope owner cannot overwrite producer ownership or accept a conflicting current version',()=>{
 for(const [family,code]of [[{ownerRef:'shot-1'},'PRODUCER_OWNER_CONFLICT'],[{currentVersionId:'other@V1',currentExpectedOutputId:null},'CURRENT_VERSION_BINDING_INVALID'],[{currentExpectedOutputId:'missing'},'EXPECTED_OUTPUT_BINDING_INVALID']]){
  const {model,add}=fixture();add('frame','START_FRAME',{family});assert.equal(projectProductionMaterials(model).issues[0].code,code);assert.equal(projectProductionMaterials(model).rows.length,0);
 }
});
test('actual candidate events become visible without inventing adoption; status changes are projected',()=>{
 const {model,add}=fixture();add('frame','START_FRAME');
 const candidate={id:'frame@V1',familyId:'frame',path:'media/frame.png',sha256:sha,lifecycleState:'REVIEW_PENDING'};
 const state={assetVersionsById:{'frame@V1':candidate},assetFamiliesById:{frame:{versionRefs:[candidate.id],currentExpectedOutputId:null}}};
 let row=projectProductionMaterials(model,state).rows[0];assert.equal(row.outputState,'CANDIDATES');assert.equal(row.currentVersionId,null);assert.equal(row.canFlowDownstream,false);
 state.assetFamiliesById.frame.currentVersionId=candidate.id;state.assetVersionsById[candidate.id]={...candidate,lifecycleState:'RELEASED',canFlowDownstream:true};
 row=projectProductionMaterials(model,state).rows[0];assert.equal(row.currentVersionId,candidate.id);assert.equal(row.lifecycleState,'RELEASED');assert.equal(row.canFlowDownstream,true);
 state.assetVersionsById[candidate.id]={...candidate,lifecycleState:'REVISION_REQUIRED',canFlowDownstream:false};row=projectProductionMaterials(model,state).rows[0];assert.equal(row.lifecycleState,'REVISION_REQUIRED');assert.equal(row.canFlowDownstream,false);
 assert.equal(model.assetFamilies[0].currentVersionId,null);
});
test('declared references are separate from actual version plus SHA references',()=>{
 const {model,add}=fixture();const {family}=add('frame','START_FRAME');family.versionRefs=['frame@V1'];model.assetVersions.push({id:'frame@V1',familyId:'frame',path:'frame.png',sha256:sha});
 const {item:consumer}=add('video','SHOT_VIDEO');consumer.inputAssetRefs=['frame'];
 model.assetVersions.push({id:'video@bad',familyId:'video',inputVersionBindings:[{versionId:'frame@V1',sha256:'b'.repeat(64)}]},{id:'video@good',familyId:'video',inputVersionBindings:[{versionId:'frame@V1',sha256:sha}]});
 const row=projectProductionMaterials(model).rows.find(row=>row.id==='frame');assert.deepEqual(row.declaredConsumerWorkItemIds,['work-video']);assert.deepEqual(row.actualConsumers.map(value=>value.versionId),['video@good']);
});
test('filters and precise deep links never substitute similarly named scenes or families',()=>{
 const {model,add}=fixture();add('frame-a','START_FRAME');add('frame-b','END_FRAME');const rows=projectProductionMaterials(model).rows;
 assert.deepEqual(filterProductionMaterials(rows,{search:'同一构图',kind:'END_FRAME',episodeUid:'episode-1'}).map(row=>row.id),['frame-b']);assert.deepEqual(filterProductionMaterials(rows,{sceneId:'S01'}),[]);
 const link=new URL(productionMaterialLocation(rows[0],'frame-a@V1'),'http://localhost');assert.equal(link.searchParams.get('productionMaterial'),'frame-a');assert.equal(link.searchParams.get('productionMaterialVersion'),'frame-a@V1');assert.equal(link.searchParams.has('material'),false);
});
test('query pages have stable ordering and cursors fail on filters or event-watermark changes',()=>{
 const {model,add}=fixture();add('frame-a','START_FRAME');add('frame-b','END_FRAME');add('frame-c','MIDDLE_FRAME');
 const basis={snapshotId:'snapshot',operationRevision:10},url=new URL('http://localhost/api/v8/ui/production-materials?limit=1');
 const first=queryProductionMaterialPage(model,{},parseProductionMaterialQuery(url,basis));assert.equal(first.total,3);assert.equal(first.entries[0].id,'frame-a');assert.equal(first.hasMore,true);
 url.searchParams.set('cursor',first.nextCursor);const second=queryProductionMaterialPage(model,{},parseProductionMaterialQuery(url,basis));assert.equal(second.entries[0].id,'frame-b');
 assert.throws(()=>parseProductionMaterialQuery(url,{...basis,operationRevision:11}),error=>error.status===409);
 url.searchParams.set('kind','END_FRAME');assert.throws(()=>parseProductionMaterialQuery(url,basis),error=>error.status===409);
});
test('detail carries the same work package, asset records and source identities; wrong versions fail closed',()=>{
 const {model,add}=fixture();const {family}=add('frame','START_FRAME');family.versionRefs=['frame@V1'];model.assetVersions.push({id:'frame@V1',familyId:'frame',path:'frame.png',sha256:sha});
 const url=new URL('http://localhost/api/v8/ui/production-materials?familyId=frame&versionId=frame@V1');const query=parseProductionMaterialQuery(url,'basis');const detail=queryProductionMaterialPage(model,{},query);
 assert.equal(detail.page.assetVersions[0].id,'frame@V1');assert.equal(detail.page.workItems[0].id,'work-frame');assert.equal(detail.page.workPackages[0].id,'package-frame');assert.equal(detail.page.shots[0].id,'shot-1');assert.equal(detail.page.materialRequirements,undefined);
 assert.throws(()=>queryProductionMaterialPage(model,{}, {...query,versionId:'other@V1'}),error=>error.status===404);
 assert.throws(()=>queryProductionMaterialPage(model,{}, {...query,filters:{familyId:'absent'}}),error=>error.status===404);
});
