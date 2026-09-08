import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createServer} from 'vite';
import {apiFixture,pngs} from './fixtures/material-native-revision-api.mjs';
import {changeDomain,imageRequirementId,imageRepresentationId} from './material-production-fixture.mjs';
import {domainHash} from '../host/instance-runtime/domain-model.mjs';
import {currentMaterialRequirementRows} from '../host/instance-runtime/material-requirement-disposition.mjs';

test('replacement current PostgreSQL pages count before pagination and retain exact old adopted detail', {skip:process.env.REVIEW_TEST_POSTGRES!=='1',timeout:180000}, async t=>{
  const f=await apiFixture(t);
  let view=await f.repo.readView(),graph=view.snapshot.productionModel.domainGraph;
  const originalDemand=graph.requirements.find(r=>r.id===imageRequirementId);
  await changeDomain(f.repo,'MATERIAL',[{collection:'requirements',id:originalDemand.id,beforeHash:domainHash(originalDemand),value:{...originalDemand,scope:[{scopeType:'PROJECT',scopeId:f.profile.projectId}]}}]);
  const production=await f.provision(await f.workspace(),'Synthetic PNG for replacement query protocol, no model.'),candidate=await f.register(production,await f.beginRun(production),pngs[0]);
  await f.review(production,candidate,'APPROVE_AND_RELEASE');
  view=await f.repo.readView();graph=view.snapshot.productionModel.domainGraph;
  const old=graph.requirements.find(r=>r.id===imageRequirementId),rep=graph.representations.find(r=>r.id===imageRepresentationId),oldRow=view.snapshot.productionModel.materialRequirements.find(r=>r.id===imageRequirementId);
  const ids=['demand:component-a','demand:component-b','demand:complete-all'],changes=[];
  ids.forEach((id,index)=>{
    const representation={...rep,id:'representation:replacement-'+index,assetFamilyIds:[],requirementIds:[id]},demand={...old,id,title:index===2?'Current complete aggregate':'Current atomic '+index,representationId:representation.id};
    if(index===2){demand.composition={schemaVersion:'1.0',mode:'ALL',requiredComponents:ids.slice(0,2).map((requirementId,i)=>({id:'part-'+i,requirementId}))};demand.replaces={requirementId:imageRequirementId,requirementHash:oldRow.requirementHash};}
    changes.push(...[['representations',representation],['requirements',demand]].map(([collection,value])=>({collection,id:value.id,beforeHash:null,value})));
  });
  await changeDomain(f.repo,'MATERIAL',changes);
  const after=await f.repo.readView();assert.deepEqual(after.snapshot.productionModel.domainGraph.requirements.find(r=>r.id===old.id),old);
  const expected=currentMaterialRequirementRows(after.snapshot.productionModel).map(r=>r.id).sort(),atomic=currentMaterialRequirementRows(after.snapshot.productionModel,{atomicOnly:true}).length;
  assert.ok(!expected.includes(imageRequirementId));assert.ok(expected.includes(ids[2]));
  const server=await createServer({root:f.softwareRoot,configFile:false,logLevel:'error',cacheDir:path.join(f.root,'replacement-query-cache'),server:{middlewareMode:true,hmr:false,ws:false},appType:'custom'});
  const route=await server.ssrLoadModule('/app/api/v8/ui/materials/route.ts'),search=await server.ssrLoadModule('/app/api/v8/ui/search/route.ts'),store=await server.ssrLoadModule('/app/api/v8/_store.ts'),repo=await store.instanceRepository();
  t.after(async()=>{await repo.close();await server.close();});
  const get=async(params)=>{const response=await route.GET(new Request('http://localhost/api/v8/ui/materials?'+new URLSearchParams(params))),body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body;};
  for(const detail of ['summary','full']){
    const seen=[];let cursor;
    do{const page=await get({limit:'1',detail,...(cursor?{cursor}:{})});assert.equal(page.total,expected.length);assert.equal(page.atomicTotal,atomic);assert.equal(page.aggregateTotal,1);assert.equal(page.count,1);seen.push(...page.page.materialRequirements.map(r=>r.id));cursor=page.nextCursor;}while(cursor);
    assert.deepEqual(seen,expected,'pagination neither counts nor skips around the historical predecessor');
    const history=await get({requirementId:imageRequirementId,detail}),row=history.page.materialRequirements[0];
    assert.equal(row.id,imageRequirementId);assert.equal(row.currentDisposition,'REPLACED');assert.equal(row.requirementReplacement.replacedByRequirementId,ids[2]);assert.equal(history.atomicTotal,0);
    assert.ok(history.page.assetVersions.some(r=>r.id===candidate.versionId&&r.sha256===candidate.sha256),'original media remain reachable at the original requirement');
    const aggregate=await get({requirementId:ids[2],detail});assert.equal(aggregate.page.materialRequirements[0].currentDisposition,'CURRENT_AGGREGATE');assert.deepEqual(aggregate.page.materialRequirements[0].assetFamilyRefs,[]);assert.equal(aggregate.atomicTotal,0);
  }
  const response=await search.GET(new Request('http://localhost/api/v8/ui/search?q='+encodeURIComponent(imageRequirementId))),body=await response.json();assert.equal(response.status,200,JSON.stringify(body));assert.ok(!body.data.some(r=>r.id===imageRequirementId),'current search excludes replaced predecessor');
  const state=(await store.operationalSnapshot()).stateProjection;assert.equal(state.assetVersionsById[candidate.versionId].canFlowDownstream,true,'catalog replacement never withdraws original ASSET');
  assert.equal(f.externalCalls(),0);
});
