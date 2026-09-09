import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createServer} from 'vite';
import {apiFixture} from './fixtures/material-native-revision-api.mjs';
import {imageRequirementId,legacyObjects} from './material-production-fixture.mjs';
import {prepareImageConfigurationFixture,pngImage} from './image-technical-fixture.mjs';
import {defaultImagePurposeProfiles} from '../host/instance-runtime/image-technical-spec.mjs';
import {getConfiguration,previewConfiguration} from '../host/instance-runtime/configuration-service.mjs';
import {validateArchive} from '../host/instance-runtime/postgres.mjs';

test('typed image configuration through real PostgreSQL/API preserves history, registers actual native PNG facts and approves only with existing formal gates',{skip:process.env.REVIEW_TEST_POSTGRES!=='1',timeout:180000},async t=>{
 const f=await prepareImageConfigurationFixture(await apiFixture(t));
 const server=await createServer({root:f.softwareRoot,configFile:false,logLevel:'error',cacheDir:path.join(f.root,'typed-config-vite'),server:{middlewareMode:true,hmr:false,ws:false},appType:'custom'});t.after(()=>server.close());
 const configRoute=await server.ssrLoadModule('/app/api/instance/configuration/route.ts'),previewRoute=await server.ssrLoadModule('/app/api/instance/configuration/preview/route.ts'),publishRoute=await server.ssrLoadModule('/app/api/instance/configuration/publish/route.ts');
 const cstore=await server.ssrLoadModule('/app/api/v8/_store.ts'),crepo=await cstore.instanceRepository();t.after(()=>crepo.close());
 const get=async()=>{const r=await configRoute.GET(new Request('http://localhost/api/instance/configuration'));assert.equal(r.status,200,await r.clone().text());return r.json();};
 const state=await get(),before=await f.repo.readView(),historical=await f.repo.readRelease();assert.equal(state.bindings.find(r=>r.key==='material:'+imageRequirementId).imageTechnicalUpgradeEligible,true);
 const configuration=structuredClone(state.configuration);configuration.schemaVersion='2.1';configuration.technical.imagePurposeProfiles=defaultImagePurposeProfiles();const type=configuration.taxonomy.categories.flatMap(c=>c.types).find(t=>t.id==='identity');type.reviewProfileId='material-instance-neutral';configuration.reviewProfiles.push({...structuredClone(configuration.reviewProfiles.find(p=>p.id==='material-image')),id:type.reviewProfileId,label:'自定义内容标准'});
 const body={configuration,expectedDraftRevision:null,expectedReleaseId:state.releaseId,expectedConfigurationRevisionId:state.revisionId,upgradeKeys:['material:'+imageRequirementId]};
 const put=async(headers={})=>{const op=await f.store.operationalSnapshot();const r=await configRoute.PUT(new Request('http://localhost/api/instance/configuration',{method:'PUT',headers:{'Content-Type':'application/json',Origin:'http://localhost','If-Match':op.mutationEtag,'Idempotency-Key':'typed-config-save',...headers},body:JSON.stringify(body)}));return {status:r.status,body:await r.json()};};
 const unchanged=await f.repo.exportState();assert.equal((await put({Origin:'http://external.invalid'})).status,403);assert.deepEqual(await f.repo.exportState(),unchanged);
 const saved=await put();assert.equal(saved.status,200,JSON.stringify(saved.body));const preview=await f.post(previewRoute,'instance/configuration/preview',{draftRevisionId:saved.body.revisionId});assert.equal(preview.status,200,JSON.stringify(preview.body));
 const published=await f.post(publishRoute,'instance/configuration/publish',{draftRevisionId:saved.body.revisionId,previewHash:preview.body.previewHash},{key:'typed-config-publish'});assert.equal(published.status,200,JSON.stringify(published.body));
 const current=await get(),row=current.bindings.find(r=>r.key==='material:'+imageRequirementId);assert.equal(row.technicalSpec.purpose,'BASE_REFERENCE');assert.equal(row.profileId,'material-instance-neutral');assert.equal(row.imageTechnicalUpgradeEligible,false);assert.deepEqual(current.configuration.technical.picture,state.configuration.technical.picture);
 const p=await f.provision(await f.workspace(),'Actual neutral PNG protocol fixture; no artistic or provider claim.');assert.equal(p.recipe.technicalSpecHash,row.technicalSpecHash);assert.equal(p.plan.expectedOutput.technicalSpecHash,row.technicalSpecHash);
 const run=await f.beginRun(p),unmodified=await f.repo.exportState();
 for(const field of ['imageTechnicalFacts','imageTechnicalSpecHash','technicalSpec','technicalSpecHash']){const forged=await f.post(f.versions,'v8/asset-versions',{...run,familyId:p.result.familyId,expectedOutputId:p.recipe.output.expectedOutputRef,path:p.recipe.output.path,[field]:{width:1920,height:1080}});assert.equal(forged.status,422,JSON.stringify(forged.body));assert.deepEqual(await f.repo.exportState(),unmodified);}
 const candidate=await f.register(p,run,pngImage(1672,941));
 const events=await f.repo.listEvents('asset-version'),event=events.find(e=>e.versionId===candidate.versionId);assert(event,'actual candidate event');assert.deepEqual(event.imageTechnicalFacts,{schemaVersion:'IMAGE_TECHNICAL_FACTS_V1',sha256:candidate.sha256,byteSize:pngImage(1672,941).length,format:'PNG',width:1672,height:941,frameCount:1});assert.equal(event.imageTechnicalSpecHash,row.technicalSpecHash);
 const projected=(await f.store.operationalSnapshot()).stateProjection.assetVersionsById[candidate.versionId];assert.deepEqual(projected.imageTechnicalFacts,event.imageTechnicalFacts);assert.equal(projected.imageTechnicalSpecHash,row.technicalSpecHash);
 await f.review(p,candidate,'APPROVE_AND_RELEASE');const successor=await f.provision(await f.workspace(),'A successor fixture keeps the same technical spec.',{expectedMode:'REVISION'});assert.equal(successor.recipe.technicalSpecHash,row.technicalSpecHash);assert.deepEqual(successor.recipe.technicalSpec,p.recipe.technicalSpec);assert.equal(successor.recipe.parentVersionId,candidate.versionId);assert.equal(successor.recipe.parentVersionSha256,candidate.sha256);const after=await f.repo.readView();assert.deepEqual(legacyObjects(after),legacyObjects(before));assert.deepEqual((await f.repo.readRelease(historical.releaseId)).snapshotBytes,historical.snapshotBytes);
 const freeze=await f.repo.exportState(),fresh=await f.repo.readTransaction(getConfiguration),changed=structuredClone(fresh.configuration);changed.reviewProfiles.find(p=>p.id==='material-image').criteria[0].question+=' changed';
 await assert.rejects(f.repo.readTransaction(tx=>previewConfiguration(tx,{configuration:changed,expectedReleaseId:fresh.releaseId,expectedConfigurationRevisionId:fresh.revisionId,upgradeKeys:['material:'+imageRequirementId]})),/放行、执行或源同步/);assert.deepEqual(await f.repo.exportState(),freeze);
 validateArchive(freeze,f.profile.instanceId);assert.equal(f.externalCalls(),0);
});
